using System.IO;
using System.Security.Cryptography;
using Renci.SshNet;
using Renci.SshNet.Sftp;

namespace Mist.Terminal;

internal static class RemoteTextFile
{
    public const int MaxBytes = 2 * 1024 * 1024;
    internal sealed record Snapshot(byte[] Bytes, string Hash, SftpFileAttributes Attributes);
    public static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes));
    public static void Validate(byte[] bytes)
    {
        if (bytes.Length > MaxBytes) throw new InvalidDataException("本地编辑仅支持 2 MB 以内的文本文件。");
        bool unicode = bytes.Length >= 2 && (bytes[0] == 0xff && bytes[1] == 0xfe || bytes[0] == 0xfe && bytes[1] == 0xff);
        if (!unicode && bytes.Any(b => b == 0 || b < 9 || b is > 13 and < 32))
            throw new InvalidDataException("此文件不是可编辑的文本文件。");
    }
    public static Snapshot Read(SftpClient client, string path, CancellationToken cancellation = default)
    {
        var file = client.Get(path);
        if (!file.IsRegularFile || file.IsSymbolicLink) throw new IOException("本地编辑仅支持普通文本文件，不支持链接。");
        if (file.Length > MaxBytes) throw new IOException("本地编辑仅支持 2 MB 以内的文本文件。");
        using var stream = client.OpenRead(path);
        using var bytes = new MemoryStream();
        var chunk = new byte[32768];
        int n;
        while ((n = stream.ReadAsync(chunk, cancellation).AsTask().GetAwaiter().GetResult()) > 0)
        {
            if (bytes.Length + n > MaxBytes) throw new IOException("文件超过 2 MB。");
            bytes.Write(chunk, 0, n);
        }
        var after = client.Get(path);
        if (!after.IsRegularFile || after.IsSymbolicLink || file.Length != after.Length || file.LastWriteTimeUtc != after.LastWriteTimeUtc || bytes.Length != after.Length)
            throw new IOException("远端文件正在变化，请重试。");
        byte[] content = bytes.ToArray();
        return new(content, Hash(content), after.Attributes);
    }
    // Returns the conflicting remote hash, or null once the exact snapshot is committed.
    public static string? Save(SftpClient client, string path, byte[] bytes, string expectedHash, CancellationToken cancellation = default)
    {
        Validate(bytes);
        var current = Read(client, path, cancellation);
        string localHash = Hash(bytes);
        if (current.Hash == localHash) return null; // A previous commit may have succeeded before transport loss.
        if (current.Hash != expectedHash) return current.Hash;
        string temporary = path[..(path.LastIndexOf('/') + 1)] + ".terminal-edit-" + Guid.NewGuid().ToString("N");
        bool created = false;
        try
        {
            using (var output = client.Open(temporary, FileMode.CreateNew, FileAccess.Write))
            {
                created = true;
                output.WriteAsync(bytes, cancellation).AsTask().GetAwaiter().GetResult();
                output.Flush();
            }
            if (Read(client, temporary, cancellation).Hash != localHash) throw new IOException("回传校验失败，原文件已保留。");
            var latest = Read(client, path, cancellation);
            if (latest.Hash != expectedHash) return latest.Hash;
            var attrs = client.GetAttributes(temporary);
            attrs.UserId = latest.Attributes.UserId; attrs.GroupId = latest.Attributes.GroupId;
            var a = latest.Attributes;
            short mode = (short)((a.OwnerCanRead ? 256 : 0) | (a.OwnerCanWrite ? 128 : 0) | (a.OwnerCanExecute ? 64 : 0) |
                (a.GroupCanRead ? 32 : 0) | (a.GroupCanWrite ? 16 : 0) | (a.GroupCanExecute ? 8 : 0) |
                (a.OthersCanRead ? 4 : 0) | (a.OthersCanWrite ? 2 : 0) | (a.OthersCanExecute ? 1 : 0) |
                (a.IsUIDBitSet ? 2048 : 0) | (a.IsGroupIDBitSet ? 1024 : 0) | (a.IsStickyBitSet ? 512 : 0));
            attrs.SetPermissions(short.Parse(Convert.ToString(mode, 8)));
            client.SetAttributes(temporary, attrs);
            cancellation.ThrowIfCancellationRequested();
            // Requires posix-rename; never delete/truncate the original as a fallback.
            try { client.RenameFile(temporary, path, true); }
            catch (NotSupportedException ex) { throw new IOException("服务器不支持安全替换文件，原文件和本地副本已保留。", ex); }
            created = false;
            return null;
        }
        finally
        {
            if (created) try { client.DeleteFile(temporary); } catch { /* Retain an interrupted stage if disconnected. */ }
        }
    }
}
