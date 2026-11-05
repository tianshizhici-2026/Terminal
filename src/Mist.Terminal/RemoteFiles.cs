using System.IO;
using Renci.SshNet;

namespace Mist.Terminal;

internal static class RemoteFiles
{
    public static void CreateEmptyFile(SftpClient client, string path)
    {
        if (client.Exists(path)) throw new IOException("同名文件或文件夹已存在。");
        // Exclusive creation also protects a file created after the existence check.
        using var file = client.Open(path, FileMode.CreateNew, FileAccess.Write);
    }
}
