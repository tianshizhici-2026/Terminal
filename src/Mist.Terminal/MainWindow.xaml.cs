using System.Collections.Concurrent;
using System.IO;
using System.Text.Json;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;

namespace Mist.Terminal;

public partial class MainWindow : Window
{
    private readonly ConcurrentDictionary<string, ITerminalSession> sessions = new();
    private readonly HashSet<string> opening = [];
    private readonly HashSet<string> cancelled = [];
    private readonly Dictionary<string, CancellationTokenSource> downloads = new();
    private readonly Dictionary<(string Id, string Path), string> downloadDestinations = new();
    private readonly string dataDir = Environment.GetEnvironmentVariable("TERMINAL_DATA_DIR") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Terminal");
    private bool closing;
    private static readonly JsonSerializerOptions json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    public MainWindow()
    {
        InitializeComponent();
        WindowBounds.Attach(this);
        Loaded += async (_, _) =>
        {
            try
            {
                Directory.CreateDirectory(dataDir);
                string previous = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MistTerminal");
                foreach (var name in new[] { "settings.json", "known-hosts.json" })
                    if (Environment.GetEnvironmentVariable("TERMINAL_DATA_DIR") == null && !File.Exists(Path.Combine(dataDir, name)) && File.Exists(Path.Combine(previous, name))) File.Copy(Path.Combine(previous, name), Path.Combine(dataDir, name));
                var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(dataDir, "WebView"));
                await Web.EnsureCoreWebView2Async(environment);
                Web.CoreWebView2.SetVirtualHostNameToFolderMapping("terminal.local", Path.Combine(AppContext.BaseDirectory, "www"), CoreWebView2HostResourceAccessKind.DenyCors);
                Web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                Web.CoreWebView2.Settings.AreBrowserAcceleratorKeysEnabled = false;
                Web.CoreWebView2.Settings.IsZoomControlEnabled = false;
                Web.CoreWebView2.Settings.IsStatusBarEnabled = false;
                Web.CoreWebView2.NewWindowRequested += (_, e) => e.Handled = true;
                Web.CoreWebView2.NavigationStarting += (_, e) => { if (!e.Uri.StartsWith("https://terminal.local/", StringComparison.Ordinal)) e.Cancel = true; };
                Web.CoreWebView2.WebMessageReceived += OnMessage;
                Web.Source = new Uri("https://terminal.local/index.html");
            }
            catch (Exception ex) { ConfirmWindow.Ask(this, "无法启动界面", "请确保已安装 Microsoft Edge WebView2 Runtime。", "知道了", ex.Message, false); Close(); }
        };
        Closing += (_, e) =>
        {
            if ((sessions.Count > 0 || opening.Count > 0) && !ConfirmWindow.Ask(this, "退出 Terminal？", "所有终端连接及正在运行的任务将结束。", "退出")) { e.Cancel = true; return; }
            closing = true;
            foreach (var download in downloads.Values) download.Cancel();
            foreach (var session in sessions.Values) _ = Task.Run(session.Dispose);
            sessions.Clear(); Web.Dispose();
        };
    }
    private async void ToolbarClick(object sender, RoutedEventArgs e)
    {
        if (Web.CoreWebView2 == null) return;
        var action = (sender as System.Windows.Controls.Button)?.Tag?.ToString();
        await Web.ExecuteScriptAsync($"window.terminalAction?.({JsonSerializer.Serialize(action)})");
        Web.Focus();
    }
    private void MinimizeClick(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;
    private void MaximizeClick(object sender, RoutedEventArgs e) => WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
    private void CloseClick(object sender, RoutedEventArgs e) => Close();
    private void Send(object payload)
    {
        if (closing || Dispatcher.HasShutdownStarted) return;
        _ = Dispatcher.BeginInvoke(() => { if (!closing) Web.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(payload, json)); });
    }
    private static string S(JsonElement p, string key, string fallback = "") => p.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? fallback : fallback;
    private static int N(JsonElement p, string key, int fallback) => p.TryGetProperty(key, out var v) && v.TryGetInt32(out var n) ? n : fallback;
    private async void OnMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string request = "";
        try
        {
            if (!e.Source.StartsWith("https://terminal.local/", StringComparison.Ordinal)) return;
            using var document = JsonDocument.Parse(e.WebMessageAsJson);
            var p = document.RootElement.Clone();
            request = S(p, "request");
            var result = await Handle(S(p, "action"), p);
            if (request.Length > 0) Send(new { request, ok = true, result });
        }
        catch (Exception ex)
        {
            if (request.Length > 0) Send(new { request, ok = false, error = ex.Message });
            else Send(new { type = "error", error = ex.Message });
        }
    }
    private async Task<object?> Handle(string action, JsonElement p)
    {
        string id = S(p, "id");
        switch (action)
        {
            case "load": return new SettingsStore(Path.Combine(dataDir, "settings.json")).LoadForUi();
            case "password": return new SettingsStore(Path.Combine(dataDir, "settings.json")).GetPassword(id);
            case "save":
                new SettingsStore(Path.Combine(dataDir, "settings.json")).Save(p);
                return null;
            case "create":
                if (sessions.ContainsKey(id) || !opening.Add(id)) throw new InvalidOperationException("会话已存在");
                ITerminalSession? created = null;
                try
                {
                    int cols = Math.Clamp(N(p, "cols", 100), 2, 500), rows = Math.Clamp(N(p, "rows", 30), 2, 300);
                    Action<string> output = data => Send(new { type = "output", id, data });
                    Action exited = () => Send(new { type = "exit", id });
                    created = await Task.Run<ITerminalSession>(() =>
                    {
                        if (S(p, "kind") != "ssh") return new ConPtySession(S(p, "shell"), cols, rows, output, exited);
                        string host = S(p, "host").Trim(); int port = N(p, "port", 22);
                        var remote = new SshSession(host, port, S(p, "username"), S(p, "password"), S(p, "keyPath"), S(p, "passphrase"), fingerprint => VerifyHost(host, port, fingerprint));
                        try { remote.Connect(cols, rows, output, exited); return remote; }
                        catch { remote.Dispose(); throw; }
                    });
                    if (closing || cancelled.Remove(id)) { created.Dispose(); return null; }
                    sessions[id] = created; return new { connected = true };
                }
                finally { opening.Remove(id); cancelled.Remove(id); }
            case "input":
                if (sessions.TryGetValue(id, out var input)) input.Write(S(p, "data"));
                return null;
            case "resize":
                if (sessions.TryGetValue(id, out var resized)) resized.Resize(Math.Clamp(N(p, "cols", 80), 2, 500), Math.Clamp(N(p, "rows", 24), 2, 300));
                return null;
            case "close":
                if (downloads.TryGetValue(id, out var download)) download.Cancel();
                foreach (var key in downloadDestinations.Keys.Where(x => x.Id == id).ToArray()) downloadDestinations.Remove(key);
                if (opening.Contains(id)) cancelled.Add(id);
                if (sessions.TryRemove(id, out var removed)) await Task.Run(removed.Dispose);
                return null;
            case "copy": Clipboard.SetText(S(p, "text")); return null;
            case "paste": return Clipboard.ContainsText() ? Clipboard.GetText() : "";
            case "chooseKey":
                var keyDialog = new OpenFileDialog { Title = "选择 SSH 私钥", Filter = "所有文件|*.*" };
                return keyDialog.ShowDialog(this) == true ? keyDialog.FileName : null;
            case "pauseDownload":
                if (downloads.TryGetValue(id, out var running)) running.Cancel();
                return null;
            case "sftp": return await FileOperation(id, p);
            default: throw new InvalidOperationException("不支持的操作");
        }
    }
    private bool VerifyHost(string host, int port, string fingerprint) => Dispatcher.Invoke(() =>
    {
        if (closing) return false;
        string path = Path.Combine(dataDir, "known-hosts.json"), key = $"{host}:{port}";
        var hosts = File.Exists(path) ? JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(path))! : new Dictionary<string, string>();
        if (hosts.TryGetValue(key, out string? known))
        {
            if (known == fingerprint) return true;
            ConfirmWindow.Ask(this, "服务器身份已更改", $"{key} 的指纹与已保存记录不同，连接已阻止。\n请核实服务器身份后再更新记录。", "知道了", $"SHA256:{fingerprint}", false); return false;
        }
        if (!ConfirmWindow.Ask(this, "信任此服务器？", $"首次连接 {key}\n核对指纹后，信任并保存此服务器。", "信任并连接", $"SHA256:{fingerprint}")) return false;
        hosts[key] = fingerprint; File.WriteAllText(path, JsonSerializer.Serialize(hosts)); return true;
    });
    private async Task<object?> FileOperation(string id, JsonElement p)
    {
        if (!sessions.TryGetValue(id, out var session) || session is not SshSession remote) throw new InvalidOperationException("请先连接 SSH 会话");
        string op = S(p, "op"), path = S(p, "path", "."), local = "";
        if (op == "upload")
        {
            var dialog = new OpenFileDialog { Title = "选择上传文件" };
            if (dialog.ShowDialog(this) != true) return new { cancelled = true };
            local = dialog.FileName; path = path.TrimEnd('/') + "/" + Path.GetFileName(local);
        }
        if (op == "download")
        {
            if (downloads.ContainsKey(id)) throw new InvalidOperationException("当前会话已有下载任务。");
            if (S(p, "resume") == "yes" && downloadDestinations.TryGetValue((id, path), out var saved)) local = saved;
            else
            {
                var dialog = new SaveFileDialog { FileName = path.Split('/').Last(), Title = "下载 / 续传" };
                if (dialog.ShowDialog(this) != true) return new { cancelled = true };
                local = dialog.FileName;
            }
            downloadDestinations[(id, path)] = local;
        }
        using var cancellation = new CancellationTokenSource();
        if (op == "download") downloads.Add(id, cancellation);
        bool locked = false;
        try
        {
            await remote.FileLock.WaitAsync(cancellation.Token);
            locked = true;
            return await Task.Run<object?>(() =>
            {
                var client = remote.Files;
                if (!client.IsConnected) client.Connect();
                if (op == "list")
                {
                    client.ChangeDirectory(path);
                    return new { path = client.WorkingDirectory, entries = client.ListDirectory(".").Where(x => x.Name is not "." and not "..").OrderByDescending(x => x.IsDirectory).ThenBy(x => x.Name).Select(x => new { name = x.Name, path = x.FullName, directory = x.IsDirectory, size = x.Length, modified = x.LastWriteTimeUtc }).ToArray() };
                }
                if (op == "upload")
                {
                    if (client.Exists(path)) throw new IOException("远程文件已存在，请先重命名后再上传。");
                    using var stream = File.OpenRead(local);
                    ulong total = (ulong)stream.Length; long last = 0;
                    client.UploadFile(stream, path, false, done => { if (Environment.TickCount64 - last > 120 || done == total) { last = Environment.TickCount64; Send(new { type = "transfer", id, done, total }); } });
                }
                else if (op == "download")
                {
                    ResumableDownload.Run(client, remote.FileIdentity, path, local,
                        (done, total) => Send(new { type = "transfer", id, done, total }), cancellation.Token);
                }
                else if (op == "mkdir") client.CreateDirectory(path);
                else if (op == "rename") client.RenameFile(path, S(p, "destination"));
                else throw new InvalidOperationException("不支持的文件操作");
                return new { success = true };
            });
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { return new { paused = true }; }
        finally
        {
            if (op == "download") downloads.Remove(id);
            if (locked) remote.FileLock.Release();
        }
    }
}
