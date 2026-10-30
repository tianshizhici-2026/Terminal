param(
    [string]$Version,
    [string]$OutputDirectory = 'dist',
    [ValidateSet('Both','Portable','Lite')][string]$Edition = 'Both'
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$terminalVersion = if ($Version) { $Version } else { (Get-Content package.json -Raw | ConvertFrom-Json).version }
if ($terminalVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Expected a stable three-part version' }
$terminalOutput = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $terminalOutput | Out-Null
dotnet tool restore
if ($LASTEXITCODE -ne 0) { throw 'Update packaging tool restore failed' }
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed' }
$terminalArchives = @()
$terminalEditions = @(
    @{Kind='Portable';Name="Terminal-$terminalVersion-win-x64";Contained='true';Id='Terminal';Channel='win-x64'},
    @{Kind='Lite';Name="Terminal-$terminalVersion-lite-win-x64";Contained='false';Id='TerminalLite';Channel='lite-win-x64'}
)
foreach ($item in $terminalEditions) {
    if ($Edition -ne 'Both' -and $Edition -ne $item.Kind) { continue }
    # Publish into a fresh build directory; never modify an extracted, running distribution.
    $target = Join-Path $terminalOutput ('.build/' + [Guid]::NewGuid().ToString('N'))
    dotnet publish src/Mist.Terminal -c Release -r win-x64 --self-contained $item.Contained "-p:Version=$terminalVersion" -p:DebugType=None -p:DebugSymbols=false -o $target
    if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed' }
    Copy-Item README.md $target
    Copy-Item licenses $target -Recurse -Force
    $feed = Join-Path $terminalOutput ('.packages/' + $terminalVersion + '/' + $item.Channel)
    dotnet vpk pack --packId $item.Id --packTitle Terminal --packVersion $terminalVersion --packDir $target --mainExe Terminal.exe --runtime win-x64 --channel $item.Channel --outputDir $feed --icon src/Mist.Terminal/Assets/terminal.ico --noInst --delta None
    if ($LASTEXITCODE -ne 0) { throw 'Portable update packaging failed' }
    $portable = @(Get-ChildItem -LiteralPath $feed -Filter '*Portable.zip')
    if ($portable.Count -ne 1) { throw 'Expected one portable ZIP' }
    $archive = Join-Path $terminalOutput ($item.Name + '.zip')
    Copy-Item -LiteralPath $portable[0].FullName -Destination $archive -Force
    $terminalArchives += $archive
    foreach ($asset in Get-ChildItem -LiteralPath $feed -File | Where-Object { $_.Name -like '*-full.nupkg' -or $_.Name -eq "releases.$($item.Channel).json" }) {
        $assetTarget = Join-Path $terminalOutput $asset.Name
        Copy-Item -LiteralPath $asset.FullName -Destination $assetTarget -Force
        $terminalArchives += $assetTarget
    }
}
$terminalHashes = foreach ($archive in $terminalArchives) {
    $hash = Get-FileHash -LiteralPath $archive -Algorithm SHA256
    "$($hash.Hash.ToLowerInvariant())  $([IO.Path]::GetFileName($archive))"
}
$terminalHashes | Set-Content (Join-Path $terminalOutput 'SHA256SUMS.txt') -Encoding ascii
$terminalHashes
