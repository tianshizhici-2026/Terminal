using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace Mist.Terminal;

internal static class ClipboardAccess
{
    private static readonly SemaphoreSlim Gate = new(1, 1);
    private const uint UnicodeText = 13;
    public static Task WriteAsync(IntPtr owner, string text) => Access(owner, () =>
    {
        var bytes = Encoding.Unicode.GetBytes(text + '\0');
        IntPtr memory = GlobalAlloc(0x42, (UIntPtr)bytes.Length);
        if (memory == IntPtr.Zero) throw new Win32Exception();
        try
        {
            IntPtr pointer = GlobalLock(memory);
            if (pointer == IntPtr.Zero) throw new Win32Exception();
            try { Marshal.Copy(bytes, 0, pointer, bytes.Length); }
            finally { GlobalUnlock(memory); }
            if (!EmptyClipboard() || SetClipboardData(UnicodeText, memory) == IntPtr.Zero) throw new Win32Exception();
            memory = IntPtr.Zero; // Windows owns the allocation after SetClipboardData.
            return true;
        }
        finally { if (memory != IntPtr.Zero) GlobalFree(memory); }
    });
    public static Task<string> ReadAsync(IntPtr owner) => Access(owner, () =>
    {
        if (!IsClipboardFormatAvailable(UnicodeText)) return "";
        IntPtr memory = GetClipboardData(UnicodeText);
        if (memory == IntPtr.Zero) throw new Win32Exception();
        IntPtr pointer = GlobalLock(memory);
        if (pointer == IntPtr.Zero) throw new Win32Exception();
        try { return Marshal.PtrToStringUni(pointer) ?? ""; }
        finally { GlobalUnlock(memory); }
    });
    private static async Task<T> Access<T>(IntPtr owner, Func<T> action)
    {
        await Gate.WaitAsync();
        try
        {
            // Yield the UI thread while another application owns the clipboard.
            for (int attempt = 0; attempt < 12; attempt++)
            {
                if (OpenClipboard(owner))
                {
                    try { return action(); }
                    finally { CloseClipboard(); }
                }
                await Task.Delay(25);
            }
            throw new InvalidOperationException("剪贴板暂时被其他应用占用，请稍后重试。");
        }
        finally { Gate.Release(); }
    }
    [DllImport("user32.dll", SetLastError = true)] private static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll")] private static extern bool CloseClipboard();
    [DllImport("user32.dll", SetLastError = true)] private static extern bool EmptyClipboard();
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetClipboardData(uint format, IntPtr data);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr GetClipboardData(uint format);
    [DllImport("user32.dll")] private static extern bool IsClipboardFormatAvailable(uint format);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GlobalLock(IntPtr memory);
    [DllImport("kernel32.dll")] private static extern bool GlobalUnlock(IntPtr memory);
    [DllImport("kernel32.dll")] private static extern IntPtr GlobalFree(IntPtr memory);
}
