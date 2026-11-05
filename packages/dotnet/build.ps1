param([switch]$SkipTests)
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Push-Location $root
try {
    cargo build --release --manifest-path native/dotnet-engine/Cargo.toml
    if ($LASTEXITCODE -ne 0) { throw 'Native build failed.' }
    dotnet build packages/dotnet/SparrowStudio.Core/SparrowStudio.Core.csproj -c Release
    if ($LASTEXITCODE -ne 0) { throw 'Managed build failed.' }
    if (-not $SkipTests) {
        cargo test --manifest-path native/dotnet-engine/Cargo.toml --release
        if ($LASTEXITCODE -ne 0) { throw 'Native tests failed.' }
        dotnet run --project packages/dotnet/tests/SparrowStudio.Core.Tests.csproj -c Release
        if ($LASTEXITCODE -ne 0) { throw 'Managed integration checks failed.' }
    }
    dotnet pack packages/dotnet/SparrowStudio.Core/SparrowStudio.Core.csproj -c Release -o packages/dotnet/artifacts
    if ($LASTEXITCODE -ne 0) { throw 'NuGet packaging failed.' }
    if (-not $SkipTests) {
        dotnet run --project packages/dotnet/package-smoke/SparrowStudio.PackageSmoke.csproj -c Release
        if ($LASTEXITCODE -ne 0) { throw 'NuGet consumer check failed.' }
    }
}
finally { Pop-Location }
