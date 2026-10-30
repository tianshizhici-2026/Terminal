using System.IO;
using System.Net;
using System.Net.Http;
using Velopack;
using Velopack.Logging;
using Velopack.Sources;

namespace Mist.Terminal;

// Use public release assets directly; automatic checks never need a GitHub token or API quota.
internal sealed class ReleaseUpdateSource : SimpleWebSource
{
    private static readonly HttpClient client = CreateClient();
    public ReleaseUpdateSource(string url = "https://github.com/tianshizhici-2026/Terminal/releases/latest/download/") : base(url) { }
    private static HttpClient CreateClient()
    {
        var result = new HttpClient { Timeout = TimeSpan.FromSeconds(30), MaxResponseContentBufferSize = 2 * 1024 * 1024 };
        result.DefaultRequestHeaders.UserAgent.ParseAdd("Terminal-Updater/1.0");
        return result;
    }

    public override async Task<VelopackAssetFeed> GetReleaseFeed(IVelopackLogger logger, string? appId, string channel,
        Guid? stagingId = null, VelopackAsset? latestLocalRelease = null)
    {
        if (channel is not ("win-x64" or "lite-win-x64")) throw new InvalidDataException("未知更新版本。");
        using var response = await client.GetAsync(new Uri(BaseUri, $"releases.{channel}.json"));
        // Older releases predate the updater and have no update index yet.
        if (response.StatusCode == HttpStatusCode.NotFound) return new VelopackAssetFeed();
        response.EnsureSuccessStatusCode();
        var feed = VelopackAssetFeed.FromJson(await response.Content.ReadAsStringAsync());
        var assets = feed.Assets.Where(a => a.PackageId == appId).ToArray();
        foreach (var asset in assets)
        {
            if (string.IsNullOrEmpty(asset.FileName) || asset.FileName.IndexOfAny(['/', '\\', ':']) >= 0 ||
                !asset.FileName.EndsWith(".nupkg", StringComparison.OrdinalIgnoreCase) || asset.Size <= 0 ||
                asset.SHA256?.Length != 64 || !asset.SHA256.All(Uri.IsHexDigit))
                throw new InvalidDataException("更新索引无效。");
        }
        return new VelopackAssetFeed { Assets = assets };
    }
}
