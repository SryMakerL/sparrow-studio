param([switch]$SkipTests)
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Push-Location $root
try {
    cargo build --release --manifest-path native/dotnet-engine/Cargo.toml
    if ($LASTEXITCODE -ne 0) { throw 'Native build failed.' }
    node packages/dotnet/verify-native.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Native ABI verification failed.' }
    dotnet build packages/dotnet/SparrowStudio.Core/SparrowStudio.Core.csproj -c Release
    if ($LASTEXITCODE -ne 0) { throw 'Managed build failed.' }
    dotnet build packages/dotnet/framework/SparrowStudio.Core/SparrowStudio.Core.csproj -c Release
    if ($LASTEXITCODE -ne 0) { throw 'Framework build failed.' }
    if (-not $SkipTests) {
        cargo test --manifest-path native/dotnet-engine/Cargo.toml --release
        if ($LASTEXITCODE -ne 0) { throw 'Native tests failed.' }
        dotnet run --project packages/dotnet/tests/SparrowStudio.Core.Tests.csproj -c Release
        if ($LASTEXITCODE -ne 0) { throw 'Managed integration checks failed.' }
        dotnet build packages/dotnet/framework/tests/SparrowStudio.Core.Framework.Smoke.csproj -c Release
        if ($LASTEXITCODE -ne 0) { throw 'Framework smoke build failed.' }
        & ./packages/dotnet/framework/tests/bin/Release/net472/SparrowStudio.Core.Framework.Smoke.exe
        if ($LASTEXITCODE -ne 0) { throw 'Framework integration checks failed.' }
    }
    dotnet pack packages/dotnet/SparrowStudio.Core/SparrowStudio.Core.csproj -c Release -o packages/dotnet/artifacts
    if ($LASTEXITCODE -ne 0) { throw 'NuGet packaging failed.' }
    dotnet pack packages/dotnet/framework/SparrowStudio.Core/SparrowStudio.Core.csproj -c Release -o packages/dotnet/artifacts
    if ($LASTEXITCODE -ne 0) { throw 'Framework NuGet packaging failed.' }
    if (-not $SkipTests) {
        $consumerPackages = Join-Path $PSScriptRoot ('artifacts/consumer-cache-' + [Guid]::NewGuid().ToString('N'))
        dotnet restore packages/dotnet/package-smoke/SparrowStudio.PackageSmoke.csproj --packages $consumerPackages --force --no-cache
        if ($LASTEXITCODE -ne 0) { throw 'NuGet consumer restore failed.' }
        dotnet run --project packages/dotnet/package-smoke/SparrowStudio.PackageSmoke.csproj -c Release --no-restore
        if ($LASTEXITCODE -ne 0) { throw 'NuGet consumer check failed.' }
        dotnet restore packages/dotnet/framework/package-smoke/SparrowStudio.Framework.PackageSmoke.csproj --packages $consumerPackages --force --no-cache
        if ($LASTEXITCODE -ne 0) { throw 'Framework NuGet consumer restore failed.' }
        dotnet build packages/dotnet/framework/package-smoke/SparrowStudio.Framework.PackageSmoke.csproj -c Release --no-restore
        if ($LASTEXITCODE -ne 0) { throw 'Framework NuGet consumer build failed.' }
        & ./packages/dotnet/framework/package-smoke/bin/Release/net472/win-x64/SparrowStudio.Framework.PackageSmoke.exe
        if ($LASTEXITCODE -ne 0) { throw 'Framework NuGet consumer check failed.' }
    }
}
finally { Pop-Location }
