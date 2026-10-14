using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Threading;

namespace Mist.Terminal;

internal static class WindowBounds
{
    public static void Attach(Window window)
    {
        HwndSource? source = null;
        bool pending = false;
        void Refresh()
        {
            if (pending) return;
            pending = true;
            window.Dispatcher.BeginInvoke(DispatcherPriority.Loaded, () =>
            {
                pending = false;
                if (window.WindowState != WindowState.Maximized || source == null || source.IsDisposed) return;
                var info = GetMonitor(source.Handle);
                if (info == null) return;
                var work = info.Value.Work;
                // Native physical pixels: no primary-monitor assumption or extra DPI conversion.
                SetWindowPos(source.Handle, IntPtr.Zero, work.Left, work.Top,
                    work.Right - work.Left, work.Bottom - work.Top, 0x0004 | 0x0010);
            });
        }
        IntPtr Hook(IntPtr hwnd, int message, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            if (message == 0x0024 && GetMonitor(hwnd) is { } monitor) // WM_GETMINMAXINFO
            {
                var limits = Marshal.PtrToStructure<MinMaxInfo>(lParam);
                ApplyWorkArea(ref limits, monitor.Monitor, monitor.Work);
                double scale = GetDpiForWindow(hwnd) / 96.0;
                limits.MinTrackSize.X = Math.Max(limits.MinTrackSize.X, (int)Math.Ceiling(window.MinWidth * scale));
                limits.MinTrackSize.Y = Math.Max(limits.MinTrackSize.Y, (int)Math.Ceiling(window.MinHeight * scale));
                Marshal.StructureToPtr(limits, lParam, false);
                handled = true;
            }
            // Taskbar/work-area, display configuration and per-monitor DPI changes.
            if (message is 0x001A or 0x007E or 0x02E0) Refresh();
            return IntPtr.Zero;
        }
        window.SourceInitialized += (_, _) =>
        {
            source = HwndSource.FromHwnd(new WindowInteropHelper(window).Handle);
            source?.AddHook(Hook);
            Refresh();
        };
        window.StateChanged += (_, _) => Refresh();
        window.Closed += (_, _) => { source?.RemoveHook(Hook); source = null; };
    }

    internal static void ApplyWorkArea(ref MinMaxInfo limits, Rect monitor, Rect work)
    {
        limits.MaxPosition = new Point { X = work.Left - monitor.Left, Y = work.Top - monitor.Top };
        limits.MaxSize = new Point { X = work.Right - work.Left, Y = work.Bottom - work.Top };
    }
    internal static MonitorInfo? GetMonitor(IntPtr hwnd)
    {
        var info = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
        return GetMonitorInfo(MonitorFromWindow(hwnd, 2), ref info) ? info : null;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] internal struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] internal struct MinMaxInfo { public Point Reserved, MaxSize, MaxPosition, MinTrackSize, MaxTrackSize; }
    [StructLayout(LayoutKind.Sequential)] internal struct MonitorInfo { public int Size; public Rect Monitor, Work; public uint Flags; }
    [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Auto)] private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
}
