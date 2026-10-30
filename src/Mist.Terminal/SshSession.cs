using Renci.SshNet;
using System.IO;
using System.Text;

namespace Mist.Terminal;

internal sealed class SshSession : ITerminalSession
{
    private readonly SshClient ssh;
    private SftpClient sftp;
    private SftpClient browser;
    private readonly Func<SftpClient> newFileClient;
    private readonly object lifetime = new();
    private ShellStream? shell;
    private readonly List<PrivateKeyFile> keys = [];
    private bool disposed;
    private Action? disconnected;
    private int exitReported;
    public readonly SemaphoreSlim FileLock = new(1, 1);
    public SftpClient Files => sftp;
    public SftpClient BrowserFiles => browser;
    public readonly SemaphoreSlim BrowseLock = new(1, 1);
    private string fingerprint = "";
    private readonly string endpoint;
    public string FileIdentity => endpoint + "|" + fingerprint;
    public SshSession(string host, int port, string username, string password, string keyPath, string passphrase, Func<string, bool> verify)
    {
        endpoint = System.Text.Json.JsonSerializer.Serialize(new { host = host.ToLowerInvariant(), port, username });
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
        newFileClient = () => {
            var client = new SftpClient(Info());
            client.HostKeyReceived += (_, e) => { e.CanTrust = verify(e.FingerPrintSHA256); if (e.CanTrust) fingerprint = e.FingerPrintSHA256; };
            client.OperationTimeout = TimeSpan.FromSeconds(30);
            client.KeepAliveInterval = TimeSpan.FromSeconds(30);
            return client;
        };
        ssh = new SshClient(Info()); sftp = newFileClient(); browser = newFileClient();
        ssh.HostKeyReceived += (_, e) => e.CanTrust = verify(e.FingerPrintSHA256);
        ssh.KeepAliveInterval = TimeSpan.FromSeconds(30);
    }
    public void Connect(int cols, int rows, Action<string> onData, Action onExit)
    {
        disconnected = onExit;
        ssh.ErrorOccurred += (_, _) => ReportExit();
        ssh.Connect();
        shell = ssh.CreateShellStream("xterm-256color", (uint)cols, (uint)rows, 0, 0, 65536);
        var stream = shell;
        stream.ErrorOccurred += (_, _) => ReportExit();
        stream.Closed += (_, _) => ReportExit();
        _ = Task.Run(() =>
        {
            try
            {
                using var reader = new StreamReader(stream, new UTF8Encoding(false), false, 8192, true);
                var buffer = new char[8192]; int count;
                while ((count = reader.Read(buffer, 0, buffer.Length)) > 0) onData(new string(buffer, 0, count));
            }
            catch (Exception ex) { if (!disposed) onData($"\r\n连接已断开：{ex.Message}\r\n"); }
            finally { ReportExit(); }
        });
    }
    private void ReportExit()
    {
        if (Interlocked.Exchange(ref exitReported, 1) == 0) disconnected?.Invoke();
    }
    public void Write(string data)
    {
        if (disposed || !ssh.IsConnected || shell == null) { ReportExit(); return; }
        try { shell.Write(data); shell.Flush(); }
        catch { ReportExit(); }
    }
    public void Resize(int cols, int rows)
    {
        if (disposed || !ssh.IsConnected || shell == null) { ReportExit(); return; }
        try { shell.ChangeWindowSize((uint)cols, (uint)rows, 0, 0); }
        catch { ReportExit(); }
    }
    public void Dispose()
    {
        lock (lifetime)
        {
            if (disposed) return; disposed = true;
            shell?.Dispose(); ssh.Dispose(); sftp.Dispose(); browser.Dispose();
            foreach (var key in keys) key.Dispose();
        }
    }
    // Called while holding the corresponding operation lock. Retry starts with a fresh transport.
    public void ResetFileClient(bool browsing)
    {
        lock (lifetime)
        {
            if (disposed) return;
            if (browsing) { browser.Dispose(); browser = newFileClient(); }
            else { sftp.Dispose(); sftp = newFileClient(); }
        }
    }
}
