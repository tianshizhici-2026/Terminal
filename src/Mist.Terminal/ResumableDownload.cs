using System.IO;
using System.Text.Json;
using Renci.SshNet;

namespace Mist.Terminal;

// Independent of WPF and the message bridge. Only this component owns partial files.
internal static class ResumableDownload
{
    private sealed record Checkpoint(int Version, string Server, string RemotePath, long Size, long ModifiedTicks);

    public static void Run(SftpClient client, string server, string remotePath, string destination,
        Action<long, long> progress, CancellationToken cancellation = default, bool overwrite = false, bool restart = false)
    {
        destination = Path.GetFullPath(destination);
        DownloadFiles.NoLinks(destination);
        if (Directory.Exists(destination)) throw new IOException("目标是文件夹，请选择其他保存位置。");
        if (File.Exists(destination) && !overwrite) throw new IOException("目标文件已存在，请确认覆盖后下载。");
        string partial = destination + ".terminal.part", metadata = partial + ".json", gate = partial + ".lock";
        foreach (var path in new[] { partial, metadata, gate })
            if (File.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("续传文件不能是链接，请选择其他保存位置。");

        // A second window/process must never write to the same checkpoint.
        using var ownership = new FileStream(gate, FileMode.OpenOrCreate, FileAccess.ReadWrite,
            FileShare.None, 1, FileOptions.DeleteOnClose);
        cancellation.ThrowIfCancellationRequested();
        var attributes = client.GetAttributes(remotePath);
        if (!attributes.IsRegularFile) throw new IOException("仅支持下载普通文件。");
        var expected = new Checkpoint(1, server, remotePath, attributes.Size, attributes.LastWriteTimeUtc.Ticks);
        if (restart) { File.Delete(partial); File.Delete(metadata); }
        bool exists = File.Exists(partial);
        if (exists || File.Exists(metadata))
        {
            Checkpoint? saved;
            try { saved = JsonSerializer.Deserialize<Checkpoint>(File.ReadAllText(metadata)); }
            catch (Exception ex) when (ex is IOException or JsonException)
            { throw new IOException("续传记录不完整，请选择覆盖重下。", ex); }
            if (!exists || saved != expected)
                throw new IOException("服务器或远程文件已变化，不能续传。请选择覆盖重下。");
        }

        using (var output = new FileStream(partial, exists ? FileMode.Open : FileMode.CreateNew,
            FileAccess.Write, FileShare.None, 128 * 1024))
        {
            if (!exists)
            {
                try
                {
                    using var info = new FileStream(metadata, FileMode.CreateNew, FileAccess.Write, FileShare.None);
                    JsonSerializer.Serialize(info, expected);
                    info.Flush(true);
                }
                catch { output.Dispose(); File.Delete(partial); throw; }
            }
            long done = output.Length;
            if (done > expected.Size) throw new IOException("续传文件长度异常，请选择覆盖重下。");
            output.Position = done;
            progress(done, expected.Size);
            cancellation.ThrowIfCancellationRequested();
            if (done < expected.Size)
            {
                using var input = client.OpenRead(remotePath);
                if (done > 0)
                {
                    if (!input.CanSeek) throw new IOException("此服务器不支持续传，请选择其他保存位置完整下载。");
                    input.Seek(done, SeekOrigin.Begin);
                }
                var buffer = new byte[128 * 1024];
                long last = 0;
                while (done < expected.Size)
                {
                    cancellation.ThrowIfCancellationRequested();
                    int read = input.ReadAsync(buffer.AsMemory(0, (int)Math.Min(buffer.Length, expected.Size - done)), cancellation).AsTask().GetAwaiter().GetResult();
                    if (read == 0) throw new IOException("远程文件提前结束；已保留下载进度。");
                    output.Write(buffer, 0, read);
                    done += read;
                    if (Environment.TickCount64 - last >= 120 || done == expected.Size)
                    { last = Environment.TickCount64; progress(done, expected.Size); }
                }
            }
            cancellation.ThrowIfCancellationRequested();
            var final = client.GetAttributes(remotePath);
            if (final.Size != expected.Size || final.LastWriteTimeUtc.Ticks != expected.ModifiedTicks)
                throw new IOException("下载期间远程文件发生变化，请选择覆盖重下。");
            output.Flush(true);
        }
        // The existing destination survives interruption. Replace it only after a complete download.
        cancellation.ThrowIfCancellationRequested();
        DownloadFiles.NoLinks(destination);
        File.Move(partial, destination, overwrite);
        File.Delete(metadata);
    }
}
