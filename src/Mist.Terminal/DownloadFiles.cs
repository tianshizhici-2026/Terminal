using System.IO;

namespace Mist.Terminal;

internal static class DownloadFiles
{
    public static void NoLinks(string path)
    {
        for (var p = new DirectoryInfo(Path.GetFullPath(path)); p != null; p = p.Parent)
            if ((File.Exists(p.FullName) || Directory.Exists(p.FullName)) &&
                (File.GetAttributes(p.FullName) & FileAttributes.ReparsePoint) != 0)
                throw new IOException("下载位置和临时文件不能包含链接。");
    }

    public static void CheckTree(string path)
    {
        NoLinks(path);
        if (!Directory.Exists(path)) return;
        foreach (var child in Directory.EnumerateFileSystemEntries(path)) CheckTree(child);
    }

    public static void DeleteStage(string path)
    {
        CheckTree(path);
        if (Directory.Exists(path)) Directory.Delete(path, true);
        else if (File.Exists(path)) File.Delete(path);
    }

    public static string? PromoteDirectory(string tree, string destination, bool overwrite)
    {
        NoLinks(destination);
        if (!Directory.Exists(destination)) { Directory.Move(tree, destination); return null; }
        if (!overwrite) throw new IOException("目标文件夹已存在，请选择重新下载并覆盖。");
        CheckTree(destination);
        string backup = destination + ".terminal.backup-" + Guid.NewGuid().ToString("N");
        Directory.Move(destination, backup);
        try { Directory.Move(tree, destination); }
        catch { Directory.Move(backup, destination); throw; }
        // Replacement is complete. If a file is in use, retain the old folder and report its location.
        try { DeleteStage(backup); return null; }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return backup; }
    }
}
