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
    private static void NoLinks(string path)
    {
        for (var p = new DirectoryInfo(Path.GetFullPath(path)); p != null; p = p.Parent)
            if (p.Exists && (p.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("下载位置不能包含目录链接。");
        if ((File.Exists(path) || Directory.Exists(path)) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("下载位置不能是链接。");
    }
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
        if (client.GetAttributes(root).IsSymbolicLink || !client.GetAttributes(root).IsDirectory) throw new IOException("远程路径不是文件夹。");
        Walk(root, "", 0); return entries.ToArray();
    }
    public static void Run(SftpClient client, string server, string remote, string destination, Action<long,long> progress, CancellationToken token = default)
    {
        destination = Path.GetFullPath(destination); NoLinks(destination);
        if (Directory.Exists(destination) || File.Exists(destination)) throw new IOException("目标已存在，请选择其他保存位置；不会合并或覆盖文件夹。");
        string stage = destination + ".terminal.folder.part", info = stage + ".json", gate = stage + ".lock";
        foreach (var p in new[] {stage, info, gate}) NoLinks(p);
        using var ownership = new FileStream(gate, FileMode.OpenOrCreate, FileAccess.Write, FileShare.None, 1, FileOptions.DeleteOnClose);
        var manifest = new Manifest(server, remote, Scan(client, remote, token));
        string serialized = JsonSerializer.Serialize(manifest);
        if (Directory.Exists(stage) || File.Exists(info))
        {
            if (!Directory.Exists(stage) || !File.Exists(info) || File.ReadAllText(info) != serialized)
                throw new IOException("目录或服务器已变化，不能续传；请选择其他保存位置。");
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
            string Hash() { using var f = File.OpenRead(blob); return Convert.ToHexString(SHA256.HashData(f)); }
            if (!File.Exists(blob) || !File.Exists(hashFile) || new FileInfo(blob).Length != entry.Size || Hash() != File.ReadAllText(hashFile))
            {
                ResumableDownload.Run(client, server, remote.TrimEnd('/') + "/" + entry.Path, blob, (n, _) => progress(done+n,total), token);
                File.WriteAllText(hashFile, Hash());
            }
            File.Copy(blob, target, true); done += entry.Size; progress(done,total);
        }
        token.ThrowIfCancellationRequested();
        if (!manifest.Entries.SequenceEqual(Scan(client, remote, token))) throw new IOException("下载期间远程目录已变化；未生成完成目录。");
        var expectedPaths = manifest.Entries.Select(x => x.Path.Replace('/', Path.DirectorySeparatorChar)).ToHashSet(StringComparer.OrdinalIgnoreCase);
        void VerifyTree(string directory)
        {
            foreach (var child in Directory.EnumerateFileSystemEntries(directory))
            {
                NoLinks(child);
                if (!expectedPaths.Contains(Path.GetRelativePath(tree, child))) throw new IOException("临时目录包含未知文件，请选择其他保存位置。");
                if (Directory.Exists(child)) VerifyTree(child);
            }
        }
        VerifyTree(tree);
        Directory.Move(tree, destination);
        // Delete only known checkpoint files, never recursively delete a supplied path.
        for (int i=0;i<manifest.Entries.Length;i++) if (!manifest.Entries[i].Directory) { File.Delete(Path.Combine(stage,i+".data")); File.Delete(Path.Combine(stage,i+".data.sha256")); }
        Directory.Delete(stage); File.Delete(info);
    }
}
