using System.IO;
using System.Runtime.InteropServices;

namespace Mist.Terminal;

internal static class OpenWith
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct OpenAsInfo
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string File;
        [MarshalAs(UnmanagedType.LPWStr)] public string? Class;
        public uint Flags;
    }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int SHOpenWithDialog(IntPtr owner, in OpenAsInfo info);

    public static void Show(IntPtr owner, string path)
    {
        DownloadFiles.NoLinks(path);
        if (!System.IO.File.Exists(path)) throw new IOException("本地编辑文件不存在。");
        // OAIF_EXEC opens this file with the selected app; Windows 11 leaves defaults unchanged.
        var info = new OpenAsInfo { File = path, Flags = 4 };
        int result = SHOpenWithDialog(owner, in info);
        if (result is unchecked((int)0x800704C7) or unchecked((int)0x80004004)) return;
        Marshal.ThrowExceptionForHR(result);
    }
}
