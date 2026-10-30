using System.IO;
using System.Text.Json;
using Velopack;

namespace Mist.Terminal;

internal sealed record UpdateStatus(string Version, string State, bool Automatic, int Progress = 0, string? Target = null);

// The service owns update state; the window only displays snapshots and requests checks.
internal sealed class AppUpdates : IDisposable
{
    private readonly UpdateManager manager;
    private readonly string preferences;
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly CancellationTokenSource lifetime = new();
    private readonly object statusLock = new();
    private volatile bool automatic;
    public UpdateStatus Status { get; private set; }
    public event Action<UpdateStatus>? Changed;

    public static UpdateManager CreateManager() => new(new ReleaseUpdateSource());

    public AppUpdates(string dataDirectory, UpdateManager? backend = null)
    {
        manager = backend ?? CreateManager();
        preferences = Path.Combine(dataDirectory, "updates.json");
        automatic = ReadAutomatic(preferences);
        var pending = manager.IsInstalled ? manager.UpdatePendingRestart : null;
        Status = new(manager.CurrentVersion?.ToString() ?? typeof(AppUpdates).Assembly.GetName().Version?.ToString(3) ?? "",
            !manager.IsInstalled ? "development" : pending != null ? "ready" : "idle", automatic, Target: pending?.Version.ToString());
    }

    public static bool ReadAutomatic(string path)
    {
        try { return !File.Exists(path) || JsonSerializer.Deserialize<Preference>(File.ReadAllText(path))?.Automatic != false; }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException) { return true; }
    }
    private sealed record Preference(bool Automatic);

    public void SetAutomatic(bool value)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(preferences)!);
        string temporary = preferences + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllText(temporary, JsonSerializer.Serialize(new Preference(value)));
            File.Move(temporary, preferences, true);
        }
        finally { File.Delete(temporary); }
        automatic = value;
        Publish(s => s with { Automatic = value });
    }
    private void Publish(Func<UpdateStatus, UpdateStatus> change)
    {
        lock (statusLock) { Status = change(Status); Changed?.Invoke(Status); }
    }

    public async Task CheckAsync(bool manual = false)
    {
        if (!manager.IsInstalled || (!manual && !automatic) || !await gate.WaitAsync(0)) return;
        try
        {
            if (manager.UpdatePendingRestart is { } pending)
            {
                Publish(s => s with { State = "ready", Target = pending.Version.ToString() });
                return;
            }
            Publish(s => s with { State = "checking", Progress = 0 });
            var update = await manager.CheckForUpdatesAsync();
            lifetime.Token.ThrowIfCancellationRequested();
            if (update == null) { Publish(s => s with { State = "latest" }); return; }
            Publish(s => s with { State = "downloading", Target = update.TargetFullRelease.Version.ToString() });
            await manager.DownloadUpdatesAsync(update, n => Publish(s => s with { Progress = n }), lifetime.Token);
            Publish(s => s with { State = "ready", Progress = 100 });
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch { Publish(s => s with { State = "failed" }); }
        finally { gate.Release(); }
    }
    public void Dispose() => lifetime.Cancel();
}
