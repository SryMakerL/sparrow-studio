param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
if (-not $SkipBuild) {
    & (Join-Path $PSScriptRoot 'build.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'Build and verification failed.' }
}
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$release = Join-Path $PSScriptRoot 'artifacts/SparrowStudio.Native.0.2.0-win-x64'
$null = New-Item -ItemType Directory -Force -Path $release
foreach ($entry in @(@('framework','framework/dist/Release'), @('net8','SparrowStudio.Core/bin/Release/net8.0'))) {
    $destination = Join-Path $release $entry[0]
    $null = New-Item -ItemType Directory -Force -Path $destination
    foreach ($name in @('SparrowStudio.Core.dll','sparrow_dotnet_native.dll')) {
        $source = Join-Path (Join-Path $PSScriptRoot $entry[1]) $name
        if (-not (Test-Path -LiteralPath $source)) { throw "Missing verified binary: $source" }
        Copy-Item -LiteralPath $source -Destination $destination -Force
    }
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'framework/dist/Release/Newtonsoft.Json.dll') -Destination (Join-Path $release 'framework') -Force
foreach ($source in @('README.md','include/sparrow_dotnet_native.h')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $source) -Destination $release -Force
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'framework/README.md') -Destination (Join-Path $release 'framework/README.md') -Force
Copy-Item -LiteralPath (Join-Path $root 'LICENSE') -Destination $release -Force
Copy-Item -LiteralPath (Join-Path $root 'web/public/THIRD_PARTY_NOTICES.txt') -Destination $release -Force
foreach ($name in @('SparrowStudio.Core.0.2.0.nupkg','SparrowStudio.Core.Framework.0.2.0.nupkg')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot ('artifacts/' + $name)) -Destination $release -Force
}
$manifest = Get-ChildItem -LiteralPath $release -File -Recurse | Where-Object { $_.Name -ne 'SHA256SUMS.txt' } | ForEach-Object {
    $relative = $_.FullName.Substring($release.Length + 1).Replace('\','/')
    (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + $relative
}
[IO.File]::WriteAllLines((Join-Path $release 'SHA256SUMS.txt'), $manifest, (New-Object Text.UTF8Encoding($false)))
$archive = $release + '.zip'
Compress-Archive -Path (Join-Path $release '*') -DestinationPath $archive -Force
Write-Output "Release directory: $release"
Write-Output "Release archive: $archive"
