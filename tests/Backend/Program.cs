using Mist.Terminal;
using System.Text;
using System.Security.Cryptography;
var ready = new TaskCompletionSource(); var exited = new TaskCompletionSource();
var text = new StringBuilder();
// Match the GUI host: a WPF application has no attached parent console.
Native.FreeConsole();
using (var terminal = new ConPtySession("cmd", 80, 24, x => { lock(text) { text.Append(x); if(text.ToString().Contains("BACKEND_OK")) ready.TrySetResult(); } }, () => exited.TrySetResult()))
{
 terminal.Resize(120,35); terminal.Write("echo BACKEND_OK\r"); await ready.Task.WaitAsync(TimeSpan.FromSeconds(10)); terminal.Write("exit\r"); await exited.Task.WaitAsync(TimeSpan.FromSeconds(10));
}
Console.WriteLine("PASS ConPTY create, resize, read/write and process exit");
var sshReady = new TaskCompletionSource();
using(var remote = new SshSession("127.0.0.1", 22992, "mist-test", "test-only", "", "", _ => true))
{
 remote.Connect(80,24,x => { if(x.Contains("SSH_ECHO_OK")) sshReady.TrySetResult(); },()=>{});
 remote.Resize(120,40); remote.Write("SSH_ECHO_OK\n"); await sshReady.Task.WaitAsync(TimeSpan.FromSeconds(10));
 Console.WriteLine("PASS SSH password authentication, shell and resize");
 var client=remote.Files; client.Connect();
 var payload=RandomNumberGenerator.GetBytes(128*1024);
 client.CreateDirectory("/roundtrip");
 using(var stream=new MemoryStream(payload)) client.UploadFile(stream,"/roundtrip/original.bin",false);
 client.RenameFile("/roundtrip/original.bin","/roundtrip/renamed.bin");
 if(!client.ListDirectory("/roundtrip").Any(x=>x.Name=="renamed.bin")) throw new Exception("Listing missing file");
 using var downloaded=new MemoryStream(); client.DownloadFile("/roundtrip/renamed.bin",downloaded);
 if(!payload.SequenceEqual(downloaded.ToArray())) throw new Exception("SFTP bytes differ");
 await remote.FileLock.WaitAsync();
 try
 {
  var listing=Task.Run(()=>{var browser=remote.BrowserFiles;browser.Connect();return browser.ListDirectory("/roundtrip").Any(x=>x.Name=="renamed.bin");});
  if(!await listing.WaitAsync(TimeSpan.FromSeconds(5)))throw new Exception("Independent SFTP browser missing file");
  Console.WriteLine("PASS SFTP browsing remains available while transfer lock is held");
 }
 finally {remote.FileLock.Release();}
 client.Disconnect();remote.ResetFileClient(false);
 client=remote.Files;client.Connect();
 using(var resumed=new MemoryStream()){client.DownloadFile("/roundtrip/renamed.bin",resumed);if(!payload.SequenceEqual(resumed.ToArray()))throw new Exception("Fresh transfer connection bytes differ");}
 remote.ResetFileClient(true);remote.BrowserFiles.Connect();
 if(!remote.BrowserFiles.ListDirectory("/roundtrip").Any(x=>x.Name=="renamed.bin"))throw new Exception("Fresh browser connection failed");
 Console.WriteLine("PASS independent transfer/browser transport replacement after disconnect");
 client.DeleteFile("/roundtrip/renamed.bin");client.DeleteDirectory("/roundtrip");
 Console.WriteLine("PASS SFTP mkdir, upload, rename, list and byte-identical download (128 KiB)");
}
foreach (var command in new[]{"__TEST_DROP_TRANSPORT__", "__TEST_CLOSE_SHELL__"})
{
 var ended=new TaskCompletionSource();int exitCount=0;
 using var dropped=new SshSession("127.0.0.1",22992,"mist-test","test-only","","",_=>true);
 dropped.Connect(80,24,_=>{},()=>{Interlocked.Increment(ref exitCount);ended.TrySetResult();});
 dropped.Write(command+"\n");await ended.Task.WaitAsync(TimeSpan.FromSeconds(5));
 dropped.Write("after exit");dropped.Resize(100,30);
 await Task.Delay(100);
 if(exitCount!=1)throw new Exception("Disconnect emitted multiple exit events");
 Console.WriteLine("PASS immediate and single disconnect notification: "+command);
}
try { using var rejected=new SshSession("127.0.0.1",22992,"mist-test","test-only","","",_=>false);rejected.Connect(80,24,_=>{},()=>{});throw new Exception("Host verification bypassed"); }
catch(Renci.SshNet.Common.SshConnectionException){Console.WriteLine("PASS rejected host key prevents SSH connection");}
internal static class Native { [System.Runtime.InteropServices.DllImport("kernel32.dll")] internal static extern bool FreeConsole(); }
