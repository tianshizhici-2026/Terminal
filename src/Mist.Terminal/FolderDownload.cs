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
    private sealed record CompletedFile(Entry Entry, string Hash);
    private sealed record SyncState(int Version, string Server, string Remote, CompletedFile[] Files);
    private sealed record LocalStamp(long Size, long Modified);
    private static LocalStamp? Stamp(string path) => File.Exists(path) ? new(new FileInfo(path).Length, File.GetLastWriteTimeUtc(path).Ticks) : null;
    private static string Hash(string path, CancellationToken token)
    {
        using var file = File.OpenRead(path);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[128 * 1024]; int count;
        while ((count = file.Read(buffer)) > 0) { token.ThrowIfCancellationRequested(); hash.AppendData(buffer, 0, count); }
        return Convert.ToHexString(hash.GetHashAndReset());
    }
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
        if (File.Exists(destination)) throw new IOException("目标是文件，请选择其他保存位置。");
        string stage = destination + ".terminal.folder.part", info = stage + ".json", gate = stage + ".lock", sync = destination + ".terminal.folder.sync.json";
        foreach (var p in new[] {stage, info, gate, sync}) NoLinks(p);
        if (Directory.Exists(sync)) throw new IOException("下载校验记录位置已被文件夹占用，请选择其他保存位置。");
        using var ownership = new FileStream(gate, FileMode.OpenOrCreate, FileAccess.Write, FileShare.None, 1, FileOptions.DeleteOnClose);
        var manifest = new Manifest(server, remote, Scan(client, remote, token));
        string serialized = JsonSerializer.Serialize(manifest), committing = Path.Combine(stage, "commit.json"); NoLinks(committing);
        bool resumingCommit = !restart && File.Exists(committing) && File.Exists(info) && File.ReadAllText(committing) == serialized && File.ReadAllText(info) == serialized;
        if (Directory.Exists(destination) && !overwrite && !resumingCommit) throw new IOException("目标已存在，请确认合并下载，或选择其他保存位置。");
        var previous = new Dictionary<string, CompletedFile>(StringComparer.OrdinalIgnoreCase);
        if (File.Exists(sync))
        {
            SyncState? state;
            try { state = JsonSerializer.Deserialize<SyncState>(File.ReadAllText(sync)); }
            catch (JsonException ex) { throw new IOException("下载校验记录损坏，请选择其他保存位置。", ex); }
            if (state?.Version != 1 || state.Files == null || state.Files.Any(x => x?.Entry == null || x.Hash == null))
                throw new IOException("下载校验记录无效，请选择其他保存位置。");
            if (state.Server == server && state.Remote == remote)
                foreach (var file in state.Files) previous[file.Entry.Path] = file;
        }
        // Check every destination before transferring or replacing anything. Local-only entries stay untouched.
        var localStamps = new Dictionary<string, LocalStamp?>();
        void CheckDestination(Entry entry)
        {
            string path = Path.Combine(destination, entry.Path.Replace('/', Path.DirectorySeparatorChar)); NoLinks(path);
            if (entry.Directory ? File.Exists(path) : Directory.Exists(path))
                throw new IOException("本地文件与文件夹类型冲突，请先重命名：" + entry.Path);
        }
        foreach (var entry in manifest.Entries)
        {
            token.ThrowIfCancellationRequested(); CheckDestination(entry);
            if (!entry.Directory) localStamps[entry.Path] = Stamp(Path.Combine(destination, entry.Path.Replace('/', Path.DirectorySeparatorChar)));
        }
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
        var completed = new List<CompletedFile>();
        var reused = new Dictionary<string, string>();
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
            string? savedHash = File.Exists(hashFile) ? File.ReadAllText(hashFile) : null;
            if (File.Exists(target) && new FileInfo(target).Length == entry.Size && savedHash != null && Hash(target, token) == savedHash)
            {
                // Completed files are verified in place; never copy or download them again on resume.
                completed.Add(new(entry, savedHash));
                File.Delete(blob); done += entry.Size; progress(done,total); continue;
            }
            string existing = Path.Combine(destination, entry.Path.Replace('/', Path.DirectorySeparatorChar)); NoLinks(existing);
            string? reusableHash = savedHash ?? (previous.TryGetValue(entry.Path, out var old) && old.Entry == entry ? old.Hash : null);
            if ((overwrite || resumingCommit) && reusableHash != null && File.Exists(existing) && new FileInfo(existing).Length == entry.Size && Hash(existing, token) == reusableHash)
            {
                File.Delete(target); // Discard a damaged staged copy; the verified destination is authoritative.
                reused.Add(entry.Path, reusableHash); completed.Add(new(entry, reusableHash));
                done += entry.Size; progress(done,total); continue;
            }
            if (!File.Exists(blob) || new FileInfo(blob).Length != entry.Size || savedHash == null || Hash(blob, token) != savedHash)
            {
                ResumableDownload.Run(client, server, remote.TrimEnd('/') + "/" + entry.Path, blob, (n, _) => progress(done+n,total), token, overwrite:true);
                savedHash = Hash(blob, token);
                File.WriteAllText(hashFile, savedHash);
                File.SetLastWriteTimeUtc(blob, new DateTime(entry.Modified, DateTimeKind.Utc));
            }
            File.Move(blob, target, true); completed.Add(new(entry, savedHash!)); done += entry.Size; progress(done,total);
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
        foreach (var entry in manifest.Entries)
        {
            token.ThrowIfCancellationRequested(); CheckDestination(entry);
            if (entry.Directory) continue;
            string existing = Path.Combine(destination, entry.Path.Replace('/', Path.DirectorySeparatorChar));
            if (Stamp(existing) != localStamps[entry.Path] || (reused.TryGetValue(entry.Path, out var hash) && Hash(existing, token) != hash))
                throw new IOException("下载期间本地文件已变化，请重试：" + entry.Path);
        }
        NoLinks(destination);
        if (Directory.Exists(destination) && !overwrite && !resumingCommit) throw new IOException("目标文件夹已存在，请确认合并后重试。");
        using (var file = new FileStream(committing, FileMode.Create, FileAccess.Write))
        { JsonSerializer.Serialize(file, manifest); file.Flush(true); }
        Directory.CreateDirectory(destination);
        // Only complete files are promoted. A failed/cancelled merge can resume using the staged hashes.
        foreach (var entry in manifest.Entries)
        {
            token.ThrowIfCancellationRequested(); CheckDestination(entry);
            string relative = entry.Path.Replace('/', Path.DirectorySeparatorChar);
            string final = Path.Combine(destination, relative);
            if (entry.Directory) Directory.CreateDirectory(final);
            else if (!reused.ContainsKey(entry.Path)) File.Move(Path.Combine(tree, relative), final, overwrite);
        }
        string nextSync = Path.Combine(stage, "sync.json"); NoLinks(nextSync); NoLinks(sync);
        using (var file = new FileStream(nextSync, FileMode.Create, FileAccess.Write))
        { JsonSerializer.Serialize(file, new SyncState(1, server, remote, completed.ToArray())); file.Flush(true); }
        File.Move(nextSync, sync, true);
        void RemoveEmptyTree(string directory)
        {
            NoLinks(directory);
            foreach (var child in Directory.EnumerateDirectories(directory)) RemoveEmptyTree(child);
            Directory.Delete(directory); // Never delete an unexpected file added during commit.
        }
        RemoveEmptyTree(tree);
        // Delete only known checkpoint files, never recursively delete a supplied path.
        for (int i=0;i<manifest.Entries.Length;i++) if (!manifest.Entries[i].Directory)
            foreach (var suffix in new[] {".data", ".data.sha256", ".data.terminal.part", ".data.terminal.part.json"}) File.Delete(Path.Combine(stage,i+suffix));
        File.Delete(committing);
        Directory.Delete(stage); File.Delete(info);
        return null;
    }
}
