using Mist.Terminal;
using Renci.SshNet;
using System.Security.Cryptography;

string folder = Path.Combine(Path.GetTempPath(), "terminal-transfer-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(folder);
string remotePath = "/resume-" + Guid.NewGuid().ToString("N") + ".bin";
byte[] payload = RandomNumberGenerator.GetBytes(4 * 1024 * 1024);
const string identity = "fixture-host|22992|mist-test|trusted-fingerprint";
SftpClient Connect() { var c = new SftpClient("127.0.0.1", 22992, "mist-test", "test-only"); c.Connect(); return c; }
void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
void Reject(Action action, string message) { try { action(); } catch (IOException) { Console.WriteLine("PASS " + message); return; } throw new Exception(message); }
void Pause(SftpClient client, string target)
{
    using var cancel = new CancellationTokenSource();
    try { ResumableDownload.Run(client, identity, remotePath, target, (done, _) => { if (done > 0) cancel.Cancel(); }, cancel.Token, overwrite:true); }
    catch (OperationCanceledException) { return; }
    throw new Exception("Pause was ignored");
}
using var source = Connect();
try
{
    using (var upload = new MemoryStream(payload)) source.UploadFile(upload, remotePath);
    string target = Path.Combine(folder, "result.bin");
    File.WriteAllText(target, "original destination");
    Pause(source, target);
    long offset = new FileInfo(target + ".terminal.part").Length;
    Check(offset > 0 && offset < payload.Length, "Partial length invalid");
    Check(File.ReadAllText(target) == "original destination", "Pause overwrote destination");
    Check(File.Exists(target + ".terminal.part.json"), "Checkpoint missing");
    Console.WriteLine("PASS pause preserves checkpoint and existing destination");

    Reject(() => ResumableDownload.Run(source, "another-server", remotePath, target, (_, _) => {}, overwrite:true), "reject a different server identity");
    using (var gate = new FileStream(target + ".terminal.part.lock", FileMode.OpenOrCreate, FileAccess.Write, FileShare.None))
        Reject(() => ResumableDownload.Run(source, identity, remotePath, target, (_, _) => {}, overwrite:true), "reject concurrent destination writers");
    using (var reconnected = Connect())
    {
        long resumed = -1;
        ResumableDownload.Run(reconnected, identity, remotePath, target, (done, _) => { if (resumed < 0) resumed = done; }, overwrite:true);
        Check(resumed == offset, "Did not resume at the saved offset");
    }
    Check(payload.SequenceEqual(File.ReadAllBytes(target)), "Resumed bytes differ");
    Check(!File.Exists(target + ".terminal.part") && !File.Exists(target + ".terminal.part.json"), "Completed checkpoint not cleaned");
    Console.WriteLine("PASS new SFTP connection resumes exact offset and produces byte-identical 4 MiB file");

    string dropped = Path.Combine(folder, "dropped.bin");
    using (var broken = Connect())
    {
        try { ResumableDownload.Run(broken, identity, remotePath, dropped, (done, _) => { if (done > 0) broken.Disconnect(); }); }
        catch (Exception ex) when (ex is Renci.SshNet.Common.SshException or IOException or ObjectDisposedException) { }
    }
    Check(File.Exists(dropped + ".terminal.part"), "Disconnect lost progress");
    using (var reconnected = Connect()) ResumableDownload.Run(reconnected, identity, remotePath, dropped, (_, _) => {});
    Check(payload.SequenceEqual(File.ReadAllBytes(dropped)), "Reconnect bytes differ");
    Console.WriteLine("PASS disconnected transfer resumes after reconnect");

    string changed = Path.Combine(folder, "changed.bin");
    Pause(source, changed);
    using (var replacement = new MemoryStream(new byte[] {1,2,3})) source.UploadFile(replacement, remotePath);
    Reject(() => ResumableDownload.Run(source, identity, remotePath, changed, (_, _) => {}), "reject changed remote file without replacing destination");
    Check(!File.Exists(changed), "Changed source was promoted to final file");

    ResumableDownload.Run(source, identity, remotePath, changed, (_, _) => {}, overwrite:true, restart:true);
    Check(File.ReadAllBytes(changed).SequenceEqual(new byte[]{1,2,3}), "Explicit restart did not replace changed source checkpoint");
    File.WriteAllText(changed, "keep until complete");
    Reject(()=>ResumableDownload.Run(source,identity,remotePath,changed,(_,_)=>{}),"existing file requires overwrite approval");
    using(var cancel=new CancellationTokenSource())
    {
        try{ResumableDownload.Run(source,identity,remotePath,changed,(n,_)=>{if(n>0)cancel.Cancel();},cancel.Token,overwrite:true,restart:true);}catch(OperationCanceledException){}
    }
    Check(File.ReadAllText(changed)=="keep until complete","Cancelled overwrite destroyed old file");
    ResumableDownload.Run(source,identity,remotePath,changed,(_,_)=>{},overwrite:true);
    Check(File.ReadAllBytes(changed).SequenceEqual(new byte[]{1,2,3}),"Overwrite retry was not byte identical");
    Console.WriteLine("PASS explicit restart, approved replacement, interrupted overwrite preserves original");

    string orphan = Path.Combine(folder, "orphan.bin");
    File.WriteAllText(orphan + ".terminal.part", "unrelated data");
    Reject(() => ResumableDownload.Run(source, identity, remotePath, orphan, (_, _) => {}), "reject unrecognized partial file");

    using (var empty = new MemoryStream()) source.UploadFile(empty, remotePath);
    string emptyTarget = Path.Combine(folder, "empty.bin");
    ResumableDownload.Run(source, identity, remotePath, emptyTarget, (_, _) => {});
    Check(new FileInfo(emptyTarget).Length == 0, "Empty file failed");
    Console.WriteLine("PASS empty file completion");
    string remoteFolder = "/folder-" + Guid.NewGuid().ToString("N");
    source.CreateDirectory(remoteFolder); source.CreateDirectory(remoteFolder+"/nested"); source.CreateDirectory(remoteFolder+"/empty");
    using(var stream=new MemoryStream(payload))source.UploadFile(stream,remoteFolder+"/nested/data.bin");
    using(var stream=new MemoryStream(Array.Empty<byte>()))source.UploadFile(stream,remoteFolder+"/zero");
    string folderTarget=Path.Combine(folder,"downloaded");
    try
    {
        using(var cancel=new CancellationTokenSource())
        {
            try{FolderDownload.Run(source,identity,remoteFolder,folderTarget,(n,_)=>{if(n>0)cancel.Cancel();},cancel.Token);throw new Exception("Folder pause ignored");}
            catch(OperationCanceledException){}
        }
        Check(!Directory.Exists(folderTarget),"Incomplete folder exposed as complete");
        Reject(()=>FolderDownload.Run(source,"other",remoteFolder,folderTarget,(_,_)=>{}),"folder rejects another server");
        using(var reconnected=Connect())FolderDownload.Run(reconnected,identity,remoteFolder,folderTarget,(_,_)=>{});
        Check(Directory.Exists(Path.Combine(folderTarget,"empty")),"Empty directory missing");
        Check(payload.SequenceEqual(File.ReadAllBytes(Path.Combine(folderTarget,"nested","data.bin"))),"Folder bytes differ");
        Check(new FileInfo(Path.Combine(folderTarget,"zero")).Length==0,"Empty file missing");
        Reject(()=>FolderDownload.Run(source,identity,remoteFolder,folderTarget,(_,_)=>{}),"folder never overwrites existing destination");
        Console.WriteLine("PASS nested folder, empty entries and pause/reconnect byte integrity");
        string changedFolder=Path.Combine(folder,"changed-folder");
        using(var broken=Connect())
        {
            try{FolderDownload.Run(broken,identity,remoteFolder,changedFolder,(n,_)=>{if(n>0)broken.Disconnect();});}
            catch(Exception ex) when(ex is Renci.SshNet.Common.SshException or IOException or ObjectDisposedException){}
        }
        using(var reconnected=Connect())FolderDownload.Run(reconnected,identity,remoteFolder,changedFolder,(_,_)=>{});
        Check(payload.SequenceEqual(File.ReadAllBytes(Path.Combine(changedFolder,"nested","data.bin"))),"Disconnected folder bytes differ");
        Console.WriteLine("PASS folder disconnect and resume");
        string modified=Path.Combine(folder,"modified-folder");
        using(var cancel=new CancellationTokenSource())
        {
            try{FolderDownload.Run(source,identity,remoteFolder,modified,(n,_)=>{if(n>0)cancel.Cancel();},cancel.Token);}catch(OperationCanceledException){}
        }
        using(var stream=new MemoryStream(new byte[]{1,2,3}))source.UploadFile(stream,remoteFolder+"/nested/data.bin");
        Reject(()=>FolderDownload.Run(source,identity,remoteFolder,modified,(_,_)=>{}),"changed folder rejects resume");
        FolderDownload.Run(source,identity,remoteFolder,modified,(_,_)=>{},restart:true);
        Check(File.ReadAllBytes(Path.Combine(modified,"nested","data.bin")).SequenceEqual(new byte[]{1,2,3}),"Folder explicit restart failed");
        File.WriteAllText(Path.Combine(folderTarget,"old-only.txt"),"original");
        Reject(()=>DownloadFiles.PromoteDirectory(Path.Combine(folder,"missing-stage"),folderTarget,true),"failed folder promotion rolls back original");
        Check(File.ReadAllText(Path.Combine(folderTarget,"old-only.txt"))=="original","Rollback lost old folder");
        using(var cancel=new CancellationTokenSource())
        {
            try{FolderDownload.Run(source,identity,remoteFolder,folderTarget,(n,_)=>{if(n>0)cancel.Cancel();},cancel.Token,overwrite:true,restart:true);}catch(OperationCanceledException){}
        }
        Check(File.Exists(Path.Combine(folderTarget,"old-only.txt")),"Partial folder overwrite destroyed original");
        FolderDownload.Run(source,identity,remoteFolder,folderTarget,(_,_)=>{},overwrite:true);
        Check(!File.Exists(Path.Combine(folderTarget,"old-only.txt")),"Folder overwrite merged old contents");
        Check(File.ReadAllBytes(Path.Combine(folderTarget,"nested","data.bin")).SequenceEqual(new byte[]{1,2,3}),"Folder replacement bytes differ");
        Console.WriteLine("PASS folder restart and staged overwrite preserve original until completion");

        using(var stream=new MemoryStream(payload))source.UploadFile(stream,remoteFolder+"/nested/data.bin");
        using(var stream=new MemoryStream(payload.AsSpan(0,256*1024).ToArray()))source.UploadFile(stream,remoteFolder+"/a-first.bin");
        try
        {
            string efficient=Path.Combine(folder,"efficient");
            using(var cancel=new CancellationTokenSource())
            {
                try{FolderDownload.Run(source,identity,remoteFolder,efficient,(n,_)=>{if(n>256*1024)cancel.Cancel();},cancel.Token);}catch(OperationCanceledException){}
            }
            string first=Path.Combine(efficient+".terminal.folder.part","tree","a-first.bin");
            Check(File.Exists(first),"Completed file was not staged in place");
            var stamp=new DateTime(2020,1,1,0,0,0,DateTimeKind.Utc);File.SetLastWriteTimeUtc(first,stamp);
            var watch=System.Diagnostics.Stopwatch.StartNew();
            FolderDownload.Run(source,identity,remoteFolder,efficient,(_,_)=>{});
            Check(File.GetLastWriteTimeUtc(Path.Combine(efficient,"a-first.bin"))==stamp,"Resume recopied a completed file");
            Check(payload.SequenceEqual(File.ReadAllBytes(Path.Combine(efficient,"nested","data.bin"))),"Optimized folder bytes differ");
            Console.WriteLine($"PASS completed file verified in place without re-copy; resumed folder in {watch.ElapsedMilliseconds} ms (loopback)");
        }
        finally{source.DeleteFile(remoteFolder+"/a-first.bin");}
        foreach(var name in new[]{"..","CON","a/b","a\\b","file.","NUL.txt"})Reject(()=>FolderDownload.SafeName(name),"invalid Windows name: "+name);
    }
    finally{source.DeleteFile(remoteFolder+"/nested/data.bin");source.DeleteFile(remoteFolder+"/zero");source.DeleteDirectory(remoteFolder+"/nested");source.DeleteDirectory(remoteFolder+"/empty");source.DeleteDirectory(remoteFolder);}

}
finally
{
    if (source.IsConnected && source.Exists(remotePath)) source.DeleteFile(remotePath);
    // This directory is uniquely created by this test and never contains user files.
    Directory.Delete(folder, true);
}
