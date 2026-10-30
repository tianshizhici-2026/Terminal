using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text.Json;
using Mist.Terminal;
using Velopack;
using Velopack.Locators;

static void Check(bool value, string message) { if (!value) throw new Exception(message); Console.WriteLine("PASS " + message); }
static UpdateManager Manager(string source, string packages, string version = "0.0.1", string channel = "lite-win-x64") => new(source,
    new UpdateOptions { ExplicitChannel = channel }, new TestVelopackLocator("TerminalLite", version, packages));

// Seed an extracted native test build using the same download/verification service as the app.
if (args.Length == 3 && args[0] == "--prepare")
{
    var packageDirectory = Path.GetFullPath(args[2]); Directory.CreateDirectory(packageDirectory);
    using var prepare = new AppUpdates(Path.Combine(packageDirectory,"test-preferences"), Manager(Path.GetFullPath(args[1]), packageDirectory));
    await prepare.CheckAsync(true);
    Check(prepare.Status.State == "ready", "native update prepared and hash verified"); return;
}

string root = Path.Combine(Path.GetTempPath(), "Terminal-updates-tests-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
try
{
    string feed = Path.Combine(root,"feed"); Directory.CreateDirectory(feed);
    string name = "TerminalLite-0.0.2-lite-win-x64-full.nupkg", package = Path.Combine(feed,name);
    using (var zip = ZipFile.Open(package,ZipArchiveMode.Create))
    {
        using (var writer = new StreamWriter(zip.CreateEntry("TerminalLite.nuspec").Open()))
            writer.Write("<package><metadata><id>TerminalLite</id><version>0.0.2</version><authors>Terminal</authors><description>Update test</description></metadata></package>");
        using var stream = zip.CreateEntry("lib/app/data.bin",CompressionLevel.NoCompression).Open();
        stream.Write(RandomNumberGenerator.GetBytes(1024*1024));
    }
    string hash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(package)));
    File.WriteAllText(Path.Combine(feed,"releases.lite-win-x64.json"),JsonSerializer.Serialize(new {Assets = new[]{new { PackageId="TerminalLite",Version="0.0.2",Type="Full",FileName=name,SHA256=hash,SHA1="",Size=new FileInfo(package).Length}}}));
    string Packages(string key) { var path=Path.Combine(root,key); Directory.CreateDirectory(path); return path; }

    using var updater = new AppUpdates(Path.Combine(root,"profile"),Manager(feed,Packages("download")));
    updater.SetAutomatic(false); await updater.CheckAsync();
    Check(updater.Status.State=="idle", "disabled automatic updates do not download");
    var states = new List<string>(); updater.Changed += s => states.Add(s.State);
    await updater.CheckAsync(true);
    Check(updater.Status.State=="ready" && states.Contains("downloading"), "manual check downloads and stages the newer matching edition");
    Check(Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(Path.Combine(root,"download",name))))==hash,"download is byte-identical");
    using var restored = new AppUpdates(Path.Combine(root,"profile"),Manager(feed,Path.Combine(root,"download")));
    Check(!restored.Status.Automatic && restored.Status.State=="ready", "preferences and pending update survive app restart");
    using var latest = new AppUpdates(Path.Combine(root,"latest-profile"),Manager(feed,Packages("latest"),"0.0.3"));
    await latest.CheckAsync(true); Check(latest.Status.State=="latest","never downgrade to an older release");
    using var wrongEdition = new AppUpdates(Path.Combine(root,"wrong-profile"),Manager(feed,Packages("wrong"),channel:"win-x64"));
    await wrongEdition.CheckAsync(true); Check(wrongEdition.Status.State!="ready","missing edition never installs another edition");

    // Corrupt an otherwise valid package without changing the feed hash.
    var bytes=File.ReadAllBytes(package); bytes[^1]^=0xff; File.WriteAllBytes(package,bytes);
    using var corrupt = new AppUpdates(Path.Combine(root,"corrupt-profile"),Manager(feed,Packages("corrupt")));
    await corrupt.CheckAsync(true);
    Check(corrupt.Status.State=="failed" && !File.Exists(Path.Combine(root,"corrupt",name)),"corrupt package is rejected before staging");
    bytes[^1]^=0xff; File.WriteAllBytes(package,bytes);

    // Exercise an interrupted HTTP response and retry against the real downloader.
    var socket=new TcpListener(IPAddress.Loopback,0); socket.Start(); int port=((IPEndPoint)socket.LocalEndpoint).Port; socket.Stop();
    using var listener=new HttpListener(); listener.Prefixes.Add($"http://127.0.0.1:{port}/");listener.Start();
    bool interrupt=true,missing=false,limited=false; int requests=0;
    var serve=Task.Run(async()=>{
        while(listener.IsListening)
        {
            HttpListenerContext context;
            try { context=await listener.GetContextAsync(); } catch { break; }
            string file=Path.GetFileName(context.Request.Url!.AbsolutePath);
            try
            {
                if(file.EndsWith(".json") && (missing || limited)){context.Response.StatusCode=missing?404:403;context.Response.Close();continue;}
                var body=File.ReadAllBytes(Path.Combine(feed,file));context.Response.ContentLength64=body.Length;
                bool isPackage=file.Equals(name,StringComparison.OrdinalIgnoreCase);
                if(isPackage) Interlocked.Increment(ref requests);
                if(isPackage && interrupt){await context.Response.OutputStream.WriteAsync(body.AsMemory(0,1024));context.Response.Abort();}
                else {await context.Response.OutputStream.WriteAsync(body);context.Response.Close();}
            }
            catch { context.Response.Abort(); }
        }
    });
    var httpManager=new UpdateManager(new ReleaseUpdateSource($"http://127.0.0.1:{port}/"),new UpdateOptions {ExplicitChannel="lite-win-x64"},new TestVelopackLocator("TerminalLite","0.0.1",Packages("network")));
    using var network=new AppUpdates(Path.Combine(root,"network-profile"),httpManager);
    int checks=0;network.Changed+=s=>{if(s.State=="checking")checks++;};
    await Task.WhenAll(network.CheckAsync(true),network.CheckAsync(true));
    Check(network.Status.State=="failed" && !File.Exists(Path.Combine(root,"network",name)),"interrupted download never becomes an installable update");
    Check(checks==1 && requests>0,"concurrent checks share one update operation");
    interrupt=false;await network.CheckAsync(true);
    Check(network.Status.State=="ready","network failure can be retried successfully");
    missing=true;
    var missingManager=new UpdateManager(new ReleaseUpdateSource($"http://127.0.0.1:{port}/"),new UpdateOptions {ExplicitChannel="lite-win-x64"},new TestVelopackLocator("TerminalLite","0.0.1",Packages("missing")));
    using var legacy=new AppUpdates(Path.Combine(root,"legacy-profile"),missingManager);await legacy.CheckAsync(true);
    Check(legacy.Status.State=="latest","legacy releases without update assets are handled without an error");
    missing=false;limited=true;await legacy.CheckAsync(true);
    Check(legacy.Status.State=="failed","HTTP failures are not misreported as up to date");
    listener.Stop();await serve;
}
finally
{
    // The test owns exactly this newly created temporary directory.
    if(Path.GetFileName(root).StartsWith("Terminal-updates-tests-",StringComparison.Ordinal))Directory.Delete(root,true);
}
