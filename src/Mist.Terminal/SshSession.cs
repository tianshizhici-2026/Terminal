using Renci.SshNet;
using System.IO;
using System.Text;

namespace Mist.Terminal;

internal sealed class SshSession : ITerminalSession
{
    private readonly SshClient ssh;
    private readonly SftpClient sftp;
    private ShellStream? shell;
    private readonly List<PrivateKeyFile> keys = [];
    private bool disposed;
    public readonly SemaphoreSlim FileLock = new(1, 1);
    public SftpClient Files => sftp;
    public SshSession(string host, int port, string username, string password, string keyPath, string passphrase, Func<string, bool> verify)
    {
        ConnectionInfo Info()
        {
            AuthenticationMethod method;
            if (!string.IsNullOrWhiteSpace(keyPath))
            {
                var key = string.IsNullOrEmpty(passphrase) ? new PrivateKeyFile(keyPath) : new PrivateKeyFile(keyPath, passphrase);
                keys.Add(key); method = new PrivateKeyAuthenticationMethod(username, key);
            }
            else method = new PasswordAuthenticationMethod(username, password);
            return new ConnectionInfo(host, port, username, method) { Timeout = TimeSpan.FromSeconds(20) };
        }
        ssh = new SshClient(Info()); sftp = new SftpClient(Info());
        ssh.HostKeyReceived += (_, e) => e.CanTrust = verify(e.FingerPrintSHA256);
        sftp.HostKeyReceived += (_, e) => e.CanTrust = verify(e.FingerPrintSHA256);
        ssh.KeepAliveInterval = TimeSpan.FromSeconds(30);
        sftp.OperationTimeout = TimeSpan.FromSeconds(30);
    }
    public void Connect(int cols, int rows, Action<string> onData, Action onExit)
    {
        ssh.Connect();
        shell = ssh.CreateShellStream("xterm-256color", (uint)cols, (uint)rows, 0, 0, 65536);
        var stream = shell;
        _ = Task.Run(() =>
        {
            try
            {
                using var reader = new StreamReader(stream, new UTF8Encoding(false), false, 8192, true);
                var buffer = new char[8192]; int count;
                while ((count = reader.Read(buffer, 0, buffer.Length)) > 0) onData(new string(buffer, 0, count));
            }
            catch (Exception ex) { if (!disposed) onData($"\r\n连接已断开：{ex.Message}\r\n"); }
            finally { onExit(); }
        });
    }
    public void Write(string data) { if (!disposed) { shell?.Write(data); shell?.Flush(); } }
    public void Resize(int cols, int rows) { if (!disposed) shell?.ChangeWindowSize((uint)cols, (uint)rows, 0, 0); }
    public void Dispose()
    {
        if (disposed) return; disposed = true;
        shell?.Dispose(); ssh.Dispose(); sftp.Dispose();
        foreach (var key in keys) key.Dispose();
    }
}
