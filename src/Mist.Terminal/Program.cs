using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Velopack;

namespace Mist.Terminal;

internal static class Program
{
    [STAThread]
    public static void Main()
    {
        // Handle updater hooks before creating WPF. Never let the SDK update a running session.
        bool restarted = false;
        VelopackApp.Build().SetAutoApplyOnStartup(false).OnRestarted(_ => restarted = true).Run();
        var manager = AppUpdates.CreateManager();
        using var instance = new Mutex(false, "Local\\Terminal-" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(AppContext.BaseDirectory.ToUpperInvariant()))));
        bool owned = false;
        if (manager.IsInstalled)
        {
            // An updater already in progress will launch the new app itself. Do not open a
            // second window from the old files while its directory is being replaced.
            if (!restarted && UpdaterRunning()) return;
            try { owned = instance.WaitOne(0); }
            catch (AbandonedMutexException) { owned = true; }
            if (!owned) { FocusExisting(); return; }
            // Only at cold startup: no windows, shells, SSH sessions or transfers exist yet.
            if (!restarted && manager.UpdatePendingRestart is { } pending && !OtherInstanceExists())
            {
                try { manager.ApplyUpdatesAndRestart(pending); return; }
                catch { /* A failed updater launch must not prevent use of the current version. */ }
            }
        }
        try
        {
            var app = new App();
            app.InitializeComponent();
            app.Run();
        }
        finally { if (owned) instance.ReleaseMutex(); }
    }

    private static bool UpdaterRunning()
    {
        string updater = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "Update.exe"));
        foreach (var process in Process.GetProcessesByName("Update"))
        {
            using (process)
            {
                try { if (string.Equals(process.MainModule?.FileName, updater, StringComparison.OrdinalIgnoreCase)) return true; }
                catch { return true; }
            }
        }
        return false;
    }

    private static bool OtherInstanceExists()
    {
        foreach (var process in Process.GetProcessesByName("Terminal"))
        {
            using (process)
            {
                if (process.Id == Environment.ProcessId) continue;
                try { if (string.Equals(Path.GetDirectoryName(process.MainModule?.FileName), AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase)) return true; }
                catch { return true; } // Uninspectable processes defer updates instead of risking a session.
            }
        }
        return false;
    }
    private static void FocusExisting()
    {
        foreach (var process in Process.GetProcessesByName("Terminal"))
        {
            using (process)
            {
                try
                {
                    if (process.Id != Environment.ProcessId && string.Equals(Path.GetDirectoryName(process.MainModule?.FileName), AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
                    {
                        if (IsIconic(process.MainWindowHandle)) ShowWindow(process.MainWindowHandle, 9);
                        SetForegroundWindow(process.MainWindowHandle); return;
                    }
                }
                catch { }
            }
        }
    }
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
}
