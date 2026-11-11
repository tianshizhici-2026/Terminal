using System.Security.Cryptography;
using System.Text.Json;
using Mist.Terminal;
using Renci.SshNet;

internal static class IncrementalFolders
{
    public static void Run(SftpClient source, string identity, string localRoot)
    {
        string remote = "/incremental-" + Guid.NewGuid().ToString("N"), local = Path.Combine(localRoot, "incremental");
        source.CreateDirectory(remote);
        byte[] unchanged = RandomNumberGenerator.GetBytes(256 * 1024), original = [1, 2, 3], changed = [4, 5, 6];
        void Put(string name, byte[] bytes) { using var input = new MemoryStream(bytes); source.UploadFile(input, remote + "/" + name); }
        string At(string name) => Path.Combine(local, name);
        void Download() => FolderDownload.Run(source, identity, remote, local, (_, _) => {}, overwrite: true);
        Dictionary<string, long> Reads() => JsonSerializer.Deserialize<Dictionary<string, long>>(source.ReadAllText("/__test_read_counts__.json"))!;
        long Read(Dictionary<string, long> reads, string name) => reads.GetValueOrDefault(remote + "/" + name);
        void Check(bool ok, string message) { if (!ok) throw new Exception(message); }
        void Reject(Action action, string label) { try { action(); } catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { Console.WriteLine("PASS " + label); return; } throw new Exception(label); }
        void RemoveRemote(string directory)
        {
            foreach (var item in source.ListDirectory(directory).Where(x => x.Name is not "." and not ".."))
                if (item.IsDirectory) RemoveRemote(item.FullName); else source.DeleteFile(item.FullName);
            source.DeleteDirectory(directory);
        }
        try
        {
            Put("a-unchanged.bin", unchanged); Put("b-changed.bin", original); Put("c-deleted.bin", original);
            FolderDownload.Run(source, identity, remote, local, (_, _) => {});
            var baseline = Reads();
            File.WriteAllText(At("local-only.txt"), "retain");
            var remoteStamp = source.GetLastWriteTimeUtc(remote + "/b-changed.bin");
            Put("b-changed.bin", changed); source.SetLastWriteTimeUtc(remote + "/b-changed.bin", remoteStamp.AddSeconds(2));
            source.DeleteFile(remote + "/c-deleted.bin"); Put("d-new.bin", original); source.CreateDirectory(remote + "/empty");
            Download(); var after = Reads();
            Check(Read(after, "a-unchanged.bin") == Read(baseline, "a-unchanged.bin"), "Unchanged file consumed remote data");
            Check(Read(after, "b-changed.bin") > Read(baseline, "b-changed.bin"), "Same-size changed file was skipped");
            Check(Read(after, "d-new.bin") == original.Length, "New file not transferred exactly once");
            Check(File.ReadAllBytes(At("b-changed.bin")).SequenceEqual(changed), "Changed file differs");
            Check(File.ReadAllBytes(At("c-deleted.bin")).SequenceEqual(original) && File.ReadAllText(At("local-only.txt")) == "retain", "Merge deleted retained files");
            Check(Directory.Exists(At("empty")), "New empty directory missing");
            Download(); var repeat = Reads();
            Check(after.OrderBy(x => x.Key).SequenceEqual(repeat.OrderBy(x => x.Key)), "Identical repeat downloaded bytes");
            Console.WriteLine("PASS incremental merge downloads only new/changed files, retains source-deleted/local-only files; identical repeat reads zero remote file bytes");

            var localStamp = File.GetLastWriteTimeUtc(At("a-unchanged.bin"));
            var damaged = unchanged.ToArray(); damaged[0] ^= 255;
            File.WriteAllBytes(At("a-unchanged.bin"), damaged); File.SetLastWriteTimeUtc(At("a-unchanged.bin"), localStamp);
            Download();
            Check(File.ReadAllBytes(At("a-unchanged.bin")).SequenceEqual(unchanged), "Local corruption with preserved timestamp was skipped");
            Check(Read(Reads(), "a-unchanged.bin") > Read(repeat, "a-unchanged.bin"), "Local corruption not retransferred");
            Console.WriteLine("PASS local SHA256 rejects same-size/same-time damaged files");

            byte[] large = RandomNumberGenerator.GetBytes(1024 * 1024);
            Put("e-large.bin", large); Put("b-changed.bin", [7, 8, 9, 10]);
            var beforePause = Reads();
            using (var cancel = new CancellationTokenSource())
            {
                try
                {
                    FolderDownload.Run(source, identity, remote, local, (_, _) =>
                    {
                        string stage = local + ".terminal.folder.part";
                        if (Directory.EnumerateFiles(stage, "*.terminal.part").Any(p => new FileInfo(p).Length > 0)) cancel.Cancel();
                    }, cancel.Token, overwrite: true);
                    throw new Exception("Pause ignored");
                }
                catch (OperationCanceledException) {}
            }
            Check(File.ReadAllBytes(At("b-changed.bin")).SequenceEqual(changed) && !File.Exists(At("e-large.bin")), "Partial download replaced destination");
            using (var connection = new SftpClient("127.0.0.1", 22992, "mist-test", "test-only"))
            { connection.Connect(); FolderDownload.Run(connection, identity, remote, local, (_, _) => {}, overwrite: true); }
            Check(File.ReadAllBytes(At("e-large.bin")).SequenceEqual(large), "Incremental resume bytes differ");
            Check(Read(Reads(), "a-unchanged.bin") == Read(beforePause, "a-unchanged.bin"), "Resume retransferred unchanged file");
            Console.WriteLine("PASS incremental pause/reconnect preserves originals and resumes new/changed files");

            Put("f-disconnected.bin", large);
            using (var broken = new SftpClient("127.0.0.1", 22992, "mist-test", "test-only"))
            {
                broken.Connect();
                try
                {
                    FolderDownload.Run(broken, identity, remote, local, (_, _) =>
                    {
                        if (Directory.EnumerateFiles(local + ".terminal.folder.part", "*.terminal.part").Any(p => new FileInfo(p).Length > 0)) broken.Disconnect();
                    }, overwrite:true);
                    throw new Exception("Transport drop ignored");
                }
                catch (Exception ex) when (ex is Renci.SshNet.Common.SshException or IOException or ObjectDisposedException) {}
            }
            Check(!File.Exists(At("f-disconnected.bin")), "Disconnected file was exposed as complete");
            Download();
            Check(File.ReadAllBytes(At("f-disconnected.bin")).SequenceEqual(large), "Transport reconnect merge differs");
            Console.WriteLine("PASS incremental transport disconnect resumes without damaging existing contents");

            Put("conflict", original); Directory.CreateDirectory(At("conflict")); File.WriteAllText(At("conflict/keep.txt"), "keep");
            Reject(Download, "file/directory collision rejected before replacing contents");
            Check(File.ReadAllText(At("conflict/keep.txt")) == "keep", "Collision lost local directory");
            source.DeleteFile(remote + "/conflict");
            source.CreateDirectory(remote + "/reverse-conflict"); File.WriteAllText(At("reverse-conflict"), "keep");
            Reject(Download, "directory/file collision rejected without deleting local file");
            source.DeleteDirectory(remote + "/reverse-conflict");

            Put("a-unchanged.bin", [11, 12]); Put("b-changed.bin", [13, 14]);
            using (var locked = new FileStream(At("b-changed.bin"), FileMode.Open, FileAccess.Read, FileShare.Read))
                Reject(Download, "locked destination interrupts commit without truncating old file");
            Check(File.ReadAllBytes(At("a-unchanged.bin")).SequenceEqual(new byte[] {11,12}), "First complete file was not promoted");
            Check(File.ReadAllBytes(At("b-changed.bin")).SequenceEqual(new byte[] {7,8,9,10}), "Failed promotion destroyed old file");
            var beforeRetry = Reads(); Download();
            Check(beforeRetry.OrderBy(x=>x.Key).SequenceEqual(Reads().OrderBy(x=>x.Key)), "Commit retry redownloaded staged/promoted files");
            Check(File.ReadAllBytes(At("b-changed.bin")).SequenceEqual(new byte[] {13,14}), "Commit recovery did not finish");
            Check(!Directory.Exists(local + ".terminal.folder.part"), "Successful merge left staging directory");
            Console.WriteLine("PASS partial commit resumes without retransmission and cleans checkpoints");

            bool edited = false;
            Reject(() => FolderDownload.Run(source, identity, remote, local, (done, total) =>
            {
                if (!edited && done == total) { edited = true; File.WriteAllBytes(At("a-unchanged.bin"), [99,98]); }
            }, overwrite:true), "local edit during download prevents stale skip/commit");
            Check(File.ReadAllBytes(At("a-unchanged.bin")).SequenceEqual(new byte[] {99,98}), "Concurrent local edit was lost");
            Download();
            var beforeOtherServer = Reads();
            FolderDownload.Run(source, identity + "-changed", remote, local, (_, _) => {}, overwrite:true);
            Check(Read(Reads(), "a-unchanged.bin") > Read(beforeOtherServer, "a-unchanged.bin"), "Different server reused sync record");
            Console.WriteLine("PASS server identity changes do not reuse old sync records");
        }
        finally { RemoveRemote(remote); }
    }
}
