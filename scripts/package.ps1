$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$terminalVersion = (Get-Content package.json -Raw | ConvertFrom-Json).version
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed' }
$terminalArchives = @()
foreach ($edition in @(@{Name="Terminal-$terminalVersion-win-x64";Contained='true'},@{Name="Terminal-$terminalVersion-lite-win-x64";Contained='false'})) {
    $target = Join-Path 'dist' $edition.Name
    dotnet publish src/Mist.Terminal -c Release -r win-x64 --self-contained $edition.Contained -p:DebugType=None -p:DebugSymbols=false -o $target
    if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed' }
    Copy-Item README.md $target
    Copy-Item licenses $target -Recurse -Force
    Compress-Archive -Path "$target/*" -DestinationPath "dist/$($edition.Name).zip" -Force
    $terminalArchives += "dist/$($edition.Name).zip"
}
$terminalHashes = foreach ($archive in $terminalArchives) {
    $hash = Get-FileHash -LiteralPath $archive -Algorithm SHA256
    "$($hash.Hash.ToLowerInvariant())  $([IO.Path]::GetFileName($archive))"
}
$terminalHashes | Set-Content dist/SHA256SUMS.txt -Encoding ascii
$terminalHashes
