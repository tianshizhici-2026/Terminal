using System.Security.Cryptography;
using System.Text;
using Mist.Terminal;
using Renci.SshNet;

string root = Path.Combine(Path.GetTempPath(), "terminal-upload-test-" + Guid.NewGuid().ToString("N"));
string remote = "/batch-upload-" + Guid.NewGuid().ToString("N");
Directory.CreateDirectory(root);
SftpClient Connect() { var c = new SftpClient("127.0.0.1", 22992, "mist-test", "test-only"); c.Connect(); return c; }
void Check(bool value, string label) { if (!value) throw new Exception(label); Console.WriteLine("PASS " + label); }
string Local(string name, byte[] content) { string path = Path.Combine(root, name); File.WriteAllBytes(path, content); return path; }
using var client = Connect();
client.CreateDirectory(remote);
try
{
    byte[] binary = RandomNumberGenerator.GetBytes(512 * 1024), chinese = Encoding.UTF8.GetBytes("批量上传\r\n内容完整");
    string text = Local("中文 文本.txt", chinese), empty = Local("empty.txt", []), data = Local("data.bin", binary);
    var starts = new List<string>();
    var result = BatchUpload.Run(client, [text, empty, data], remote, p =>
    {
        if (p.Done != 0) return;
        starts.Add(p.Name);
        if (p.Index == 2 && !client.Exists(remote + "/中文 文本.txt")) throw new Exception("Uploads were not sequential");
    });
    Check(result.Success && result.Uploaded == 3 && starts.SequenceEqual(new[] {"中文 文本.txt", "empty.txt", "data.bin"}), "multiple files upload sequentially including Chinese names and empty files");
    Check(client.ReadAllBytes(remote + "/中文 文本.txt").SequenceEqual(chinese) && client.ReadAllBytes(remote + "/data.bin").SequenceEqual(binary) && client.GetAttributes(remote + "/empty.txt").Size == 0, "uploaded bytes exactly match selected files");
    string next = Local("new.txt", [4,5,6]);
    result = BatchUpload.Run(client, [text, Path.Combine(root, "missing.txt"), next], remote, _ => {});
    Check(result.Uploaded == 1 && result.Skipped == 1 && result.Failed == 1 && result.Files[1].Name == "missing.txt", "existing names skip and local failure does not block remaining files");
    Check(client.ReadAllBytes(remote + "/中文 文本.txt").SequenceEqual(chinese), "same-name upload never overwrites remote content");
    client.CreateDirectory(remote + "/directory.txt");
    result = BatchUpload.Run(client, [Local("directory.txt", [1])], remote, _ => {});
    Check(result.Skipped == 1 && client.GetAttributes(remote + "/directory.txt").IsDirectory, "remote directory name collision is preserved");

    string cancelled = Local("cancelled.bin", binary), pending = Local("pending.txt", [9]);
    using (var cancel = new CancellationTokenSource())
    {
        result = BatchUpload.Run(client, [cancelled, pending], remote, p => { if(p.Done > 0)cancel.Cancel(); }, cancel.Token);
        Check(result.Pending == 2 && !client.Exists(remote + "/cancelled.bin") && !client.Exists(remote + "/pending.txt"), "cancellation stops the batch without exposing a partial final file");
    }
    Check(!client.ListDirectory(remote).Any(x=>x.Name.StartsWith(".terminal-upload-")), "cancelled staging file is cleaned while connection remains available");

    string racing = Local("racing.txt", binary);
    bool raced = false;
    using (var other = Connect())
    {
        result = BatchUpload.Run(client, [racing], remote, p =>
        {
            if (!raced && p.Done == p.Total) { raced = true; using var bytes = new MemoryStream(new byte[]{42}); other.UploadFile(bytes, remote + "/racing.txt", false); }
        });
    }
    Check(result.Skipped == 1 && client.ReadAllBytes(remote + "/racing.txt").SequenceEqual(new byte[]{42}), "file created remotely during upload is not replaced");

    string first = Local("first.txt", [7]), dropped = Local("dropped.bin", binary), last = Local("last.txt", [8]);
    using (var broken = Connect())
        result = BatchUpload.Run(broken, [first, dropped, last], remote, p => { if(p.Index == 2 && p.Done > 0)broken.Disconnect(); });
    Check(result.Uploaded == 1 && result.Failed == 1 && result.Pending == 1 && client.Exists(remote + "/first.txt") && !client.Exists(remote + "/dropped.bin") && !client.Exists(remote + "/last.txt"), "transport loss retains completed files and reports failed/unattempted files");
    using (var reconnected = Connect()) result = BatchUpload.Run(reconnected, [first, dropped, last], remote, _ => {});
    Check(result.Uploaded == 2 && result.Skipped == 1 && client.ReadAllBytes(remote + "/dropped.bin").SequenceEqual(binary), "reselecting batch after reconnect skips completed files and uploads remaining files");
}
finally
{
    foreach(var item in client.ListDirectory(remote).Where(x=>x.Name is not "." and not ".."))
        if(item.IsDirectory)client.DeleteDirectory(item.FullName);else client.DeleteFile(item.FullName);
    client.DeleteDirectory(remote);
    Directory.Delete(root, true); // Unique test-created directory only.
}
