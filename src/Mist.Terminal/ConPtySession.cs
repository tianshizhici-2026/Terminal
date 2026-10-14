using Microsoft.Win32.SafeHandles;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace Mist.Terminal;

internal interface ITerminalSession : IDisposable
{
    void Write(string data);
    void Resize(int cols, int rows);
}

internal sealed class ConPtySession : ITerminalSession
{
    private IntPtr console;
    private FileStream? input;
    private FileStream? output;
    private Process? process;
    private int disposed;
    public ConPtySession(string shell, int cols, int rows, Action<string> onData, Action onExit)
    {
        IntPtr readIn = IntPtr.Zero, writeIn = IntPtr.Zero, readOut = IntPtr.Zero, writeOut = IntPtr.Zero;
        IntPtr attributes = IntPtr.Zero;
        bool initialized = false;
        try
        {
            if (!CreatePipe(out readIn, out writeIn, IntPtr.Zero, 0) || !CreatePipe(out readOut, out writeOut, IntPtr.Zero, 0)) throw new Win32Exception();
            Marshal.ThrowExceptionForHR(CreatePseudoConsole(new Coord((short)cols, (short)rows), readIn, writeOut, 0, out console));
            var size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            attributes = Marshal.AllocHGlobal(size);
            if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref size)) throw new Win32Exception();
            initialized = true;
            if (!UpdateProcThreadAttribute(attributes, 0, (IntPtr)0x00020016, console, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
            var startup = new StartupInfoEx { StartupInfo = new StartupInfo { cb = Marshal.SizeOf<StartupInfoEx>(), flags = 0x100 }, AttributeList = attributes };
            string executable = shell == "cmd" ? Path.Combine(Environment.SystemDirectory, "cmd.exe") : Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
            string args = shell == "cmd" ? " /Q" : " -NoLogo";
            if (!CreateProcess(null, new StringBuilder('"' + executable + '"' + args), IntPtr.Zero, IntPtr.Zero, false, 0x00080000 | 0x00000400, IntPtr.Zero, Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ref startup, out var info)) throw new Win32Exception();
            try { process = Process.GetProcessById(info.ProcessId); }
            finally { CloseHandle(info.Process); CloseHandle(info.Thread); }
            input = new FileStream(new SafeFileHandle(writeIn, true), FileAccess.Write, 4096, false); writeIn = IntPtr.Zero;
            output = new FileStream(new SafeFileHandle(readOut, true), FileAccess.Read, 4096, false); readOut = IntPtr.Zero;
            var readerStream = output;
            _ = Task.Run(() =>
            {
                try
                {
                    using var reader = new StreamReader(readerStream, new UTF8Encoding(false), false, 4096);
                    var buffer = new char[8192]; int count;
                    while ((count = reader.Read(buffer, 0, buffer.Length)) > 0) onData(new string(buffer, 0, count));
                }
                catch (Exception ex) when (ex is IOException or ObjectDisposedException) { }
                finally { onExit(); }
            });
            var child = process;
            _ = Task.Run(async () =>
            {
                try { await child.WaitForExitAsync(); Dispose(); }
                catch (Exception ex) when (ex is InvalidOperationException or ObjectDisposedException) { }
            });
        }
        catch { Dispose(); throw; }
        finally
        {
            if (initialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            foreach (var handle in new[] { readIn, writeIn, readOut, writeOut }) if (handle != IntPtr.Zero) CloseHandle(handle);
        }
    }
    public void Write(string data)
    {
        if (disposed != 0 || input == null) return;
        var bytes = Encoding.UTF8.GetBytes(data);
        lock (input) { input.Write(bytes); input.Flush(); }
    }
    public void Resize(int cols, int rows) { if (disposed == 0) Marshal.ThrowExceptionForHR(ResizePseudoConsole(console, new Coord((short)cols, (short)rows))); }
    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        try { if (process is { HasExited: false }) process.Kill(true); } catch { }
        input?.Dispose();
        var handle = console; console = IntPtr.Zero;
        // Drain output while ClosePseudoConsole waits for its console host.
        if (handle != IntPtr.Zero) _ = Task.Run(() => { ClosePseudoConsole(handle); output?.Dispose(); });
        else output?.Dispose();
        process?.Dispose();
    }
    [StructLayout(LayoutKind.Sequential)] private readonly struct Coord(short x, short y) { public readonly short X = x, Y = y; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct StartupInfo
    {
        public int cb; public IntPtr reserved, desktop, title;
        public int x, y, xSize, ySize, xCount, yCount, fill, flags;
        public short show, reserved2; public IntPtr reservedPointer, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)] private struct StartupInfoEx { public StartupInfo StartupInfo; public IntPtr AttributeList; }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInfo { public IntPtr Process, Thread; public int ProcessId, ThreadId; }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CreatePipe(out IntPtr read, out IntPtr write, IntPtr attributes, int size);
    [DllImport("kernel32.dll")] private static extern int CreatePseudoConsole(Coord size, IntPtr input, IntPtr output, uint flags, out IntPtr console);
    [DllImport("kernel32.dll")] private static extern int ResizePseudoConsole(IntPtr console, Coord size);
    [DllImport("kernel32.dll")] private static extern void ClosePseudoConsole(IntPtr console);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcess(string? app, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInfo info);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
}
