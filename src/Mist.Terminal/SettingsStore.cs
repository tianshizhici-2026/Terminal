using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Mist.Terminal;

internal sealed class SettingsStore(string path)
{
    private JsonObject Read() => File.Exists(path) ? JsonNode.Parse(File.ReadAllText(path))!.AsObject() : new JsonObject { ["fontSize"] = 14, ["profiles"] = new JsonArray() };
    private static string Text(JsonNode? node, string key) => node?[key]?.GetValue<string>() ?? "";
    private static byte[] Binding(JsonNode profile) => Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new[] { "Terminal.password.v1", Text(profile,"id"), Text(profile,"host"), profile["port"]?.ToJsonString() ?? "22", Text(profile,"username") }));
    public JsonObject LoadForUi()
    {
        var settings = Read();
        foreach (var item in settings["profiles"]!.AsArray())
        {
            var profile = item!.AsObject();
            profile["rememberPassword"] = !string.IsNullOrEmpty(Text(profile, "passwordCipher"));
            profile.Remove("passwordCipher");
        }
        return settings;
    }
    public string GetPassword(string id)
    {
        var profile = Read()["profiles"]!.AsArray().FirstOrDefault(x => Text(x, "id") == id);
        string cipher = Text(profile, "passwordCipher");
        if (cipher.Length == 0) return "";
        byte[]? plain = null;
        try
        {
            plain = ProtectedData.Unprotect(Convert.FromBase64String(cipher), Binding(profile!), DataProtectionScope.CurrentUser);
            return Encoding.UTF8.GetString(plain);
        }
        catch (Exception ex) when (ex is CryptographicException or FormatException)
        { throw new InvalidOperationException("无法读取已保存密码，请重新输入并保存。"); }
        finally { if (plain != null) CryptographicOperations.ZeroMemory(plain); }
    }
    public void Save(JsonElement input)
    {
        var previous = Read()["profiles"]!.AsArray();
        var request = JsonNode.Parse(input.GetRawText())!;
        var credential = request["credential"];
        var profiles = new JsonArray();
        foreach (var item in request["profiles"]!.AsArray())
        {
            var profile = new JsonObject();
            foreach (var key in new[] { "id", "name", "host", "port", "username", "keyPath" }) profile[key] = item![key]?.DeepClone();
            var old = previous.FirstOrDefault(x => Text(x, "id") == Text(profile, "id"));
            string cipher = old != null && Binding(old).SequenceEqual(Binding(profile)) ? Text(old,"passwordCipher") : "";
            if (credential != null && Text(credential, "id") == Text(profile, "id"))
            {
                cipher = "";
                if (credential["rememberPassword"]?.GetValue<bool>() == true && Text(profile, "keyPath").Length == 0)
                {
                    byte[] plain = Encoding.UTF8.GetBytes(Text(credential, "password"));
                    try { cipher = Convert.ToBase64String(ProtectedData.Protect(plain, Binding(profile), DataProtectionScope.CurrentUser)); }
                    finally { CryptographicOperations.ZeroMemory(plain); }
                }
            }
            if (Text(profile, "keyPath").Length > 0) cipher = "";
            if (cipher.Length > 0) profile["passwordCipher"] = cipher;
            profiles.Add(profile);
        }
        var settings = new JsonObject { ["fontSize"] = Math.Clamp(request["fontSize"]?.GetValue<int>() ?? 14, 10, 28), ["defaultShell"] = Text(request,"defaultShell") == "cmd" ? "cmd" : "powershell", ["profiles"] = profiles, ["sftpWidth"] = Math.Clamp(request["sftpWidth"]?.GetValue<int>() ?? 440, 300, 1200) };
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path + ".tmp", settings.ToJsonString());
        File.Move(path + ".tmp", path, true);
    }
}
