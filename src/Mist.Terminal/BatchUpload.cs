using System.IO;
using Renci.SshNet;
using Renci.SshNet.Common;

namespace Mist.Terminal;

internal sealed record UploadFileResult(string Name, string State, string? Error = null);
internal sealed record UploadProgress(string Name, int Index, int Count, long Done, long Total);
internal sealed record BatchUploadResult(UploadFileResult[] Files)
{
    public int Uploaded => Files.Count(x => x.State == "uploaded");
    public int Skipped => Files.Count(x => x.State == "skipped");
    public int Failed => Files.Count(x => x.State == "failed");
    public int Pending => Files.Count(x => x.State == "pending");
    public bool Success => Failed == 0 && Pending == 0;
}

// Sequential uploads, independent of the window and renderer. Existing remote entries are never overwritten.
internal static class BatchUpload
{
    public static BatchUploadResult Run(SftpClient client, IReadOnlyList<string> files, string directory,
        Action<UploadProgress> progress, CancellationToken cancellation = default)
    {
        var results = new List<UploadFileResult>();
        for (int i = 0; i < files.Count; i++)
        {
            if (cancellation.IsCancellationRequested)
            {
                for (; i < files.Count; i++) results.Add(new(Path.GetFileName(files[i]), "pending", "上传已取消"));
                break;
            }
            string local = files[i], name = Path.GetFileName(local), target = directory.TrimEnd('/') + "/" + name;
            string temporary = directory.TrimEnd('/') + "/.terminal-upload-" + Guid.NewGuid().ToString("N");
            bool created = false;
            try
            {
                if (string.IsNullOrEmpty(name) || name.Contains('/') || name.Contains('\\')) throw new IOException("文件名无效。");
                if (client.Exists(target)) { results.Add(new(name, "skipped", "同名文件或文件夹已存在")); continue; }
                using var input = new FileStream(local, FileMode.Open, FileAccess.Read, FileShare.Read, 128 * 1024);
                long length = input.Length, done = 0, last = 0;
                var modified = File.GetLastWriteTimeUtc(local);
                progress(new(name, i + 1, files.Count, 0, length));
                cancellation.ThrowIfCancellationRequested();
                using (var output = client.Open(temporary, FileMode.CreateNew, FileAccess.Write))
                {
                    created = true;
                    byte[] buffer = new byte[128 * 1024]; int count;
                    while ((count = input.ReadAsync(buffer, cancellation).AsTask().GetAwaiter().GetResult()) > 0)
                    {
                        output.WriteAsync(buffer.AsMemory(0, count), cancellation).AsTask().GetAwaiter().GetResult();
                        done += count;
                        if (Environment.TickCount64 - last >= 120 || done == length)
                        { last = Environment.TickCount64; progress(new(name, i + 1, files.Count, done, length)); }
                    }
                    output.Flush();
                }
                cancellation.ThrowIfCancellationRequested();
                if (done != length || input.Length != length || File.GetLastWriteTimeUtc(local) != modified || client.GetAttributes(temporary).Size != length)
                    throw new IOException("文件在上传期间发生变化，请重新上传。");
                if (client.Exists(target)) { results.Add(new(name, "skipped", "同名文件或文件夹已存在")); continue; }
                // Standard SFTP rename refuses an existing destination; never use the replacing POSIX extension.
                client.RenameFile(temporary, target);
                created = false; results.Add(new(name, "uploaded"));
            }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
            {
                results.Add(new(name, "pending", "上传已取消"));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or SshException or ObjectDisposedException)
            {
                results.Add(new(name, "failed", ex.Message));
                if (!client.IsConnected || ex is SshConnectionException or SshOperationTimeoutException or ObjectDisposedException)
                {
                    for (i++; i < files.Count; i++) results.Add(new(Path.GetFileName(files[i]), "pending", "连接中断，尚未上传"));
                    break;
                }
            }
            finally
            {
                if (created && client.IsConnected) try { client.DeleteFile(temporary); } catch { /* Connection loss can leave the staging file for later cleanup. */ }
            }
        }
        return new(results.ToArray());
    }
}
