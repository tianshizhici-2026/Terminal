using System.Collections.Concurrent;
using System.IO;
using System.Text.Json;
using Renci.SshNet;

namespace Mist.Terminal;

// Owns local drafts and synchronization independently of windows, tabs and editors.
internal sealed class RemoteEditor : IDisposable
{
    internal sealed record Draft(string Id, string Server, string RemotePath, string Name, string BaseHash, string SavedHash);
    internal sealed record View(string Id, string Name, string RemotePath, string State, string? Error);
    private sealed class Entry(Draft draft)
    {
        public Draft Draft = draft;
        public readonly SemaphoreSlim Gate = new(1, 1);
        public string State = "offline", Error = "", Candidate = "", Conflict = "";
        public bool Stopped;
        public int ReadFailures;
    }
    private sealed record Connection(object Owner, Func<SftpClient> Create);
    private readonly string root;
    private readonly ConcurrentDictionary<string, Entry> entries = new();
    private readonly ConcurrentDictionary<string, Connection> connections = new();
    private readonly SemaphoreSlim openGate = new(1, 1);
    private readonly CancellationTokenSource stop = new();
    private readonly Task worker;
    public event Action? Changed;
    public RemoteEditor(string root)
    {
        this.root = root;
        Directory.CreateDirectory(root); DownloadFiles.NoLinks(root);
        foreach (var folder in Directory.EnumerateDirectories(root))
        {
            if (!Guid.TryParseExact(Path.GetFileName(folder), "N", out _)) continue;
            try
            {
                DownloadFiles.NoLinks(folder);
                var draft = JsonSerializer.Deserialize<Draft>(File.ReadAllText(Path.Combine(folder, "draft.json")));
                if (draft != null && draft.Id == Path.GetFileName(folder) && draft.Name == Path.GetFileName(draft.Name) && File.Exists(Path.Combine(folder, draft.Name)))
                    entries[draft.Id] = new(draft);
            }
            catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException) { }
        }
        worker = Task.Run(WatchAsync);
    }
    public View[] List() => entries.Values.Select(e => new View(e.Draft.Id, e.Draft.Name, e.Draft.RemotePath, e.State, e.Error)).ToArray();
    private string Local(Entry e) => Path.Combine(root, e.Draft.Id, e.Draft.Name);
    public string LocalPath(string id) => Local(Get(id));
    public string ConflictToken(string id) => Get(id).Conflict;
    private Entry Get(string id) => entries.TryGetValue(id, out var e) ? e : throw new IOException("编辑任务已结束。");
    private void Persist(Entry e)
    {
        string file = Path.Combine(root, e.Draft.Id, "draft.json");
        DownloadFiles.NoLinks(file);
        DownloadFiles.NoLinks(file + ".new");
        File.WriteAllText(file + ".new", JsonSerializer.Serialize(e.Draft)); File.Move(file + ".new", file, true);
    }
    private void Status(Entry e, string state, string error = "")
    {
        if (e.State == state && e.Error == error) return;
        e.State = state; e.Error = error; Changed?.Invoke();
    }
    public void Attach(string server, object owner, Func<SftpClient> create)
    {
        connections[server] = new(owner, create);
        foreach (var e in entries.Values.Where(e => e.Draft.Server == server && e.State is "offline" or "waiting")) Status(e, "pending");
    }
    public async Task DetachAsync(object owner)
    {
        foreach (var item in connections.Where(c => ReferenceEquals(c.Value.Owner, owner)).ToArray())
            ((ICollection<KeyValuePair<string, Connection>>)connections).Remove(item);
        foreach (var e in entries.Values)
        {
            await e.Gate.WaitAsync();
            try { if (!connections.ContainsKey(e.Draft.Server)) Status(e, "offline"); }
            finally { e.Gate.Release(); }
        }
    }
    public async Task<string> OpenAsync(string server, string path)
    {
        await openGate.WaitAsync(stop.Token);
        try
        {
            var existing = entries.Values.FirstOrDefault(e => e.Draft.Server == server && e.Draft.RemotePath == path);
            if (existing != null) return existing.Draft.Id;
            if (!connections.TryGetValue(server, out var connection)) throw new IOException("请先连接服务器。");
            return await Task.Run(() =>
            {
                using var client = connection.Create(); client.Connect();
                var snapshot = RemoteTextFile.Read(client, path, stop.Token); RemoteTextFile.Validate(snapshot.Bytes);
                string id = Guid.NewGuid().ToString("N");
                string name = "edit-" + new string(path.Split('/').Last().Take(120).Select(c => Path.GetInvalidFileNameChars().Contains(c) ? '_' : c).ToArray()).TrimEnd('.', ' ');
                var entry = new Entry(new(id, server, path, name, snapshot.Hash, snapshot.Hash)) { State = "saved" };
                Directory.CreateDirectory(Path.Combine(root, id));
                File.WriteAllBytes(Local(entry), snapshot.Bytes); Persist(entry); entries[id] = entry; Changed?.Invoke();
                return id;
            }, stop.Token);
        }
        finally { openGate.Release(); }
    }
    private byte[] ReadLocal(Entry e)
    {
        string path = Local(e); DownloadFiles.NoLinks(path);
        using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (file.Length > RemoteTextFile.MaxBytes) throw new InvalidDataException("本地文件超过 2 MB，尚未回传。");
        using var bytes = new MemoryStream(); file.CopyTo(bytes); var result = bytes.ToArray(); RemoteTextFile.Validate(result); return result;
    }
    public async Task SyncAsync(string id, bool overwrite = false, string? expectedConflict = null)
    {
        var e = Get(id);
        string? approvedHash = overwrite ? expectedConflict ?? e.Conflict : null;
        await e.Gate.WaitAsync(stop.Token);
        try
        {
            if (e.Stopped) return;
            await Task.Run(() => Sync(e, overwrite, approvedHash: approvedHash), stop.Token);
        }
        finally { e.Gate.Release(); }
    }
    private void Sync(Entry e, bool overwrite, bool stableOnly = false, string? approvedHash = null)
    {
        try
        {
            var bytes = ReadLocal(e); string hash = RemoteTextFile.Hash(bytes);
            if (stableOnly && hash != e.Candidate) { e.Candidate = hash; Status(e, "pending"); return; }
            e.Candidate = hash;
            if (hash == e.Draft.SavedHash) { Status(e, "saved"); return; }
            if (!connections.TryGetValue(e.Draft.Server, out var connection)) { Status(e, "waiting"); return; }
            Status(e, "saving");
            using var client = connection.Create(); client.Connect();
            string expected = overwrite && !string.IsNullOrEmpty(approvedHash) ? approvedHash : e.Draft.BaseHash;
            var conflict = RemoteTextFile.Save(client, e.Draft.RemotePath, bytes, expected, stop.Token);
            if (conflict != null) { e.Conflict = conflict; Status(e, "conflict"); return; }
            e.Draft = e.Draft with { BaseHash = hash, SavedHash = hash }; e.Conflict = "";
            Persist(e); Status(e, "saved");
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
        catch (Exception ex) { Status(e, "failed", ex.Message); }
    }
    private async Task WatchAsync()
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(750));
        try
        {
            while (await timer.WaitForNextTickAsync(stop.Token))
                foreach (var e in entries.Values)
                {
                    if (!await e.Gate.WaitAsync(0, stop.Token)) continue;
                    try
                    {
                        if (e.Stopped) continue;
                        var hash = RemoteTextFile.Hash(ReadLocal(e));
                        e.ReadFailures = 0;
                        if (hash == e.Draft.SavedHash) { e.Candidate = ""; Status(e, connections.ContainsKey(e.Draft.Server) ? "saved" : "offline"); continue; }
                        if (!connections.ContainsKey(e.Draft.Server)) { Status(e, "waiting"); continue; }
                        if ((e.State is "conflict" or "failed") && e.Candidate == hash) continue;
                        // Debounce both in-place writes and editor atomic-replace saves.
                        if (e.Candidate != hash) { e.Candidate = hash; Status(e, "pending"); continue; }
                        Sync(e, false, true);
                    }
                    catch (InvalidDataException ex) { Status(e, "failed", ex.Message); }
                    catch (IOException ex) { if (++e.ReadFailures >= 5) Status(e, "failed", ex.Message); }
                    catch (UnauthorizedAccessException ex) { Status(e, "failed", ex.Message); }
                    finally { e.Gate.Release(); }
                }
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
    }
    public async Task EndAsync(string id)
    {
        var e = Get(id); await e.Gate.WaitAsync();
        try
        {
            // Leave the local draft on disk even when the user stops synchronization.
            e.Stopped = true; File.Delete(Path.Combine(root, id, "draft.json")); entries.TryRemove(id, out _); Changed?.Invoke();
        }
        finally { e.Gate.Release(); }
    }
    public void Dispose() { stop.Cancel(); connections.Clear(); }
}
