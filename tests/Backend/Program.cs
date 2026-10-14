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
 client.DeleteFile("/roundtrip/renamed.bin");client.DeleteDirectory("/roundtrip");
 Console.WriteLine("PASS SFTP mkdir, upload, rename, list and byte-identical download (128 KiB)");
}
try { using var rejected=new SshSession("127.0.0.1",22992,"mist-test","test-only","","",_=>false);rejected.Connect(80,24,_=>{},()=>{});throw new Exception("Host verification bypassed"); }
catch(Renci.SshNet.Common.SshConnectionException){Console.WriteLine("PASS rejected host key prevents SSH connection");}
internal static class Native { [System.Runtime.InteropServices.DllImport("kernel32.dll")] internal static extern bool FreeConsole(); }
