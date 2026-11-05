using Mist.Terminal;
using Renci.SshNet;
using System.Text;

const string server = "loopback|test-user|trusted-host-key";
string root = Path.Combine(Path.GetTempPath(), "terminal-edit-test-" + Guid.NewGuid().ToString("N"));
string remote = "/edit-" + Guid.NewGuid().ToString("N") + ".txt";
SftpClient Create() => new("127.0.0.1", 22992, "mist-test", "test-only") { OperationTimeout = TimeSpan.FromSeconds(3) };
using var client = Create();client.Connect();
void Write(string text) { using var stream = new MemoryStream(Encoding.UTF8.GetBytes(text));client.UploadFile(stream, remote); }
string Read() => Encoding.UTF8.GetString(RemoteTextFile.Read(client, remote).Bytes);
void Check(bool ok, string message) { if (!ok) throw new Exception(message); }
async Task Until(Func<bool> condition) { var end=DateTime.UtcNow.AddSeconds(12);while(!condition()){if(DateTime.UtcNow>end)throw new Exception("Timed out");await Task.Delay(100);} }
RemoteEditor? editor = null;
try
{
    Write("original 中文\n");
    editor=new(root);editor.Changed+=()=>{foreach(var item in editor.List().Where(x=>x.State=="failed"))Console.WriteLine("SYNC ERROR "+item.Error);};var owner=new object();editor.Attach(server,owner,Create);
    string id=await editor.OpenAsync(server,remote),local=editor.LocalPath(id);
    Check(File.ReadAllText(local)==Read(),"Initial bytes differ");
    Check(await editor.OpenAsync(server,remote)==id,"Reopening replaced an active draft");
    File.WriteAllText(local,"local saved 中文\r\n",new UTF8Encoding(true));
    await Until(()=>editor.List().Single().State=="saved" && RemoteTextFile.Read(client,remote).Hash==RemoteTextFile.Hash(File.ReadAllBytes(local)));
    Console.WriteLine("PASS text/BOM/line-ending bytes and automatic save, duplicate open reuses draft");

    var priorTime=client.GetLastWriteTimeUtc(remote);
    Write("changed remotely");client.SetLastWriteTimeUtc(remote,priorTime);
    File.WriteAllText(local,"my local changes");
    await Until(()=>editor.List().Single().State=="conflict");
    Check(Read()=="changed remotely","Conflict overwrote remote");
    Write("changed once more");
    await editor.SyncAsync(id,true);
    Check(editor.List().Single().State=="conflict" && Read()=="changed once more","Stale overwrite approval bypassed new remote change");
    await editor.SyncAsync(id,true);
    Check(Read()=="my local changes","Approved overwrite failed");
    Console.WriteLine("PASS hash conflict detection despite unchanged mtime; overwrite approval only covers observed remote content");

    using(var flag=new MemoryStream(new byte[]{1}))client.UploadFile(flag,"/__drop_next_edit__");
    File.WriteAllText(local,"after interrupted upload");
    await editor.SyncAsync(id);
    Check(editor.List().Single().State=="failed","Disconnected upload not marked failed");
    Check(Read()=="my local changes","Interrupted staged upload damaged original");
    Check(File.ReadAllText(local)=="after interrupted upload","Lost local draft on disconnect");
    await editor.SyncAsync(id);
    Check(Read()=="after interrupted upload","Retry failed");
    Console.WriteLine("PASS transport loss during upload preserves original and local draft; fresh connection retries");

    using(var flag=new MemoryStream(new byte[]{1}))client.UploadFile(flag,"/__drop_next_edit__");
    File.WriteAllText(local,"failed save");await editor.SyncAsync(id);
    Check(editor.List().Single().State=="failed","Expected failed save");
    File.WriteAllText(local,"save again after failure");
    await Until(()=>editor.List().Single().State=="saved" && Read()=="save again after failure");
    Console.WriteLine("PASS another editor save retries after a failed save without a transfer panel");

    await editor.DetachAsync(owner);File.WriteAllText(local,"offline draft");
    await Task.Delay(1800);Check(Read()=="save again after failure","Detached editor uploaded data");
    editor.Attach("different-host-key",new object(),Create);await Task.Delay(1800);
    Check(Read()=="save again after failure","Wrong server identity resumed draft");
    editor.Attach(server,owner,Create);await Until(()=>editor.List().Single().State=="saved" && Read()=="offline draft");
    Console.WriteLine("PASS disconnect pauses and matching verified identity reconnect resumes");

    await editor.DetachAsync(owner);File.WriteAllText(local,"restart draft");editor.Dispose();
    editor=new(root);editor.Changed+=()=>{foreach(var item in editor.List().Where(x=>x.State=="failed"))Console.WriteLine("RESTORED SYNC ERROR "+item.Error);};Check(editor.List().Single().State=="offline","Restored draft should wait for matching connection");
    editor.Attach(server,owner,Create);await Until(()=>editor.List().Single().State=="saved" && Read()=="restart draft");
    string replacement=local+".tmp";File.WriteAllText(replacement,"atomic editor save");File.Move(replacement,local,true);
    await Until(()=>editor.List().Single().State=="saved" && Read()=="atomic editor save");
    Console.WriteLine("PASS app restart retains unsent draft; atomic-replace editor saves are detected");

    File.WriteAllBytes(local,new byte[]{0,1,2});await Until(()=>editor.List().Single().State=="failed");
    Check(Read()=="atomic editor save","Binary local file uploaded");
    await editor.EndAsync(id);Check(File.Exists(local) && editor.List().Length==0,"Stopping removed local draft");
    Console.WriteLine("PASS binary protection and stop retains recoverable local copy");
}
finally
{
    editor?.Dispose();
    if(client.IsConnected && client.Exists(remote))client.DeleteFile(remote);
    // Test root intentionally retained for failure diagnostics.
}
