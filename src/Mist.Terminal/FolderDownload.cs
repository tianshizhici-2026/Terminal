using System.IO;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Renci.SshNet;

namespace Mist.Terminal;

internal static class FolderDownload
{
    private sealed record Entry(string Path, bool Directory, long Size, long Modified);
    private sealed record Manifest(string Server, string Remote, Entry[] Entries);
    public static string SafeName(string name)
    {
        if (string.IsNullOrWhiteSpace(name) || name is "." or ".." || name.EndsWith('.') || name.EndsWith(' ') ||
            name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || name.Contains('/') || name.Contains('\\') ||
            Regex.IsMatch(name.Split('.')[0].TrimEnd(' '), @"^(CON|CONIN\$|CONOUT\$|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])$", RegexOptions.IgnoreCase))
            throw new IOException("文件名不兼容 Windows：" + name);
        return name;
    }
    private static void NoLinks(string path) => DownloadFiles.NoLinks(path);
    private static Entry[] Scan(SftpClient client, string root, CancellationToken token)
    {
        var entries = new List<Entry>();
        void Walk(string remote, string relative, int depth)
        {
            if (depth > 128 || entries.Count > 100000) throw new IOException("目录过深或项目过多，请分批下载。");
            token.ThrowIfCancellationRequested();
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var item in client.ListDirectory(remote).Where(x => x.Name is not "." and not "..").OrderBy(x => x.Name, StringComparer.Ordinal))
            {
                token.ThrowIfCancellationRequested();
                SafeName(item.Name);
                if (!names.Add(item.Name)) throw new IOException("存在 Windows 无法区分的同名文件：" + item.Name);
                if (item.IsSymbolicLink || (!item.IsDirectory && !item.IsRegularFile)) throw new IOException("目录包含链接或特殊文件，请单独处理：" + item.FullName);
                string path = relative.Length == 0 ? item.Name : relative + "/" + item.Name;
                entries.Add(new Entry(path, item.IsDirectory, item.IsDirectory ? 0 : item.Length, item.IsDirectory ? 0 : item.LastWriteTimeUtc.Ticks));
                if (item.IsDirectory) Walk(remote.TrimEnd('/') + "/" + item.Name, path, depth + 1);
            }
        }
        var attributes = client.GetAttributes(root);
        if (attributes.IsSymbolicLink || !attributes.IsDirectory) throw new IOException("远程路径不是文件夹。");
        Walk(root, "", 0); return entries.ToArray();
    }
    public static string? Run(SftpClient client, string server, string remote, string destination, Action<long,long> progress, CancellationToken token = default, bool overwrite = false, bool restart = false)
    {
        destination = Path.GetFullPath(destination); NoLinks(destination);
        if (File.Exists(destination) || (Directory.Exists(destination) && !overwrite)) throw new IOException("目标已存在，请选择重新下载并覆盖，或其他保存位置。");
        string stage = destination + ".terminal.folder.part", info = stage + ".json", gate = stage + ".lock";
        foreach (var p in new[] {stage, info, gate}) NoLinks(p);
        using var ownership = new FileStream(gate, FileMode.OpenOrCreate, FileAccess.Write, FileShare.None, 1, FileOptions.DeleteOnClose);
        var manifest = new Manifest(server, remote, Scan(client, remote, token));
        string serialized = JsonSerializer.Serialize(manifest);
        if (restart) { DownloadFiles.DeleteStage(stage); File.Delete(info); }
        if (Directory.Exists(stage) || File.Exists(info))
        {
            if (!Directory.Exists(stage) || !File.Exists(info) || File.ReadAllText(info) != serialized)
                throw new IOException("目录或服务器已变化，不能续传；请选择覆盖重下。");
            foreach (var p in Directory.EnumerateFileSystemEntries(stage)) NoLinks(p);
        }
        else
        {
            using (var file = new FileStream(info, FileMode.CreateNew, FileAccess.Write)) { JsonSerializer.Serialize(file, manifest); file.Flush(true); }
            Directory.CreateDirectory(stage);
        }
        string tree = Path.Combine(stage, "tree"); NoLinks(tree); Directory.CreateDirectory(tree);
        long total = manifest.Entries.Sum(x => x.Size), done = 0;
        progress(done,total);
        for (int i = 0; i < manifest.Entries.Length; i++)
        {
            token.ThrowIfCancellationRequested(); var entry = manifest.Entries[i];
            string target = Path.Combine(tree, entry.Path.Replace('/', Path.DirectorySeparatorChar)); NoLinks(target);
            if (entry.Directory) { Directory.CreateDirectory(target); continue; }
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            string blob = Path.Combine(stage, i + ".data"), hashFile = blob + ".sha256";
            NoLinks(blob); NoLinks(hashFile);
            string Hash(string path)
            {
                using var f = File.OpenRead(path);
                using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                var buffer = new byte[128 * 1024]; int count;
                while ((count = f.Read(buffer)) > 0) { token.ThrowIfCancellationRequested(); hash.AppendData(buffer,0,count); }
                return Convert.ToHexString(hash.GetHashAndReset());
            }
            string? savedHash = File.Exists(hashFile) ? File.ReadAllText(hashFile) : null;
            if (File.Exists(target) && new FileInfo(target).Length == entry.Size && savedHash != null && Hash(target) == savedHash)
            {
                // Completed files are verified in place; never copy or download them again on resume.
                File.Delete(blob); done += entry.Size; progress(done,total); continue;
            }
            if (!File.Exists(blob) || new FileInfo(blob).Length != entry.Size || savedHash == null || Hash(blob) != savedHash)
            {
                ResumableDownload.Run(client, server, remote.TrimEnd('/') + "/" + entry.Path, blob, (n, _) => progress(done+n,total), token, overwrite:true);
                File.WriteAllText(hashFile, Hash(blob));
            }
            File.Move(blob, target, true); done += entry.Size; progress(done,total);
        }
        token.ThrowIfCancellationRequested();
        if (!manifest.Entries.SequenceEqual(Scan(client, remote, token))) throw new IOException("下载期间远程目录已变化；未生成完成目录。");
        var expectedPaths = manifest.Entries.Select(x => x.Path.Replace('/', Path.DirectorySeparatorChar)).ToHashSet(StringComparer.OrdinalIgnoreCase);
        void VerifyTree(string directory)
        {
            foreach (var child in Directory.EnumerateFileSystemEntries(directory))
            {
                token.ThrowIfCancellationRequested();
                NoLinks(child);
                if (!expectedPaths.Contains(Path.GetRelativePath(tree, child))) throw new IOException("临时目录包含未知文件，请选择其他保存位置。");
                if (Directory.Exists(child)) VerifyTree(child);
            }
        }
        VerifyTree(tree);
        token.ThrowIfCancellationRequested();
        string? backup = DownloadFiles.PromoteDirectory(tree, destination, overwrite);
        // Delete only known checkpoint files, never recursively delete a supplied path.
        for (int i=0;i<manifest.Entries.Length;i++) if (!manifest.Entries[i].Directory) { File.Delete(Path.Combine(stage,i+".data")); File.Delete(Path.Combine(stage,i+".data.sha256")); }
        Directory.Delete(stage); File.Delete(info);
        return backup;
    }
}
