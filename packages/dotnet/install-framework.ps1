param(
    [Parameter(Mandatory=$true)][string]$ProjectPath
)
$ErrorActionPreference = 'Stop'
$project = [System.IO.Path]::GetFullPath($ProjectPath)
$directory = Split-Path $project
$distribution = Join-Path $PSScriptRoot 'framework/dist/Release'
foreach ($name in @('SparrowStudio.Core.dll', 'sparrow_dotnet_native.dll')) {
    if (-not (Test-Path (Join-Path $distribution $name))) { throw "Missing distribution file: $name" }
}
$xml = New-Object System.Xml.XmlDocument
$xml.PreserveWhitespace = $true
$xml.Load($project)
$ns = $xml.DocumentElement.NamespaceURI
$manager = New-Object System.Xml.XmlNamespaceManager($xml.NameTable)
$manager.AddNamespace('m', $ns)
$framework = $xml.SelectSingleNode('//m:TargetFrameworkVersion', $manager)
if ($null -eq $framework -or $framework.InnerText -ne 'v4.7.2') { throw 'This installer targets old-style .NET Framework 4.7.2 projects only.' }
if ($null -ne $xml.SelectSingleNode('//m:Reference[starts-with(@Include,"SparrowStudio.Core")]', $manager)) { throw 'SparrowStudio.Core is already referenced. Inspect the existing reference before reinstalling.' }
$jsonReference = $xml.SelectSingleNode('//m:Reference[starts-with(@Include,"Newtonsoft.Json")]/m:HintPath', $manager)
if ($null -eq $jsonReference -or -not (Test-Path (Join-Path $directory $jsonReference.InnerText))) { throw 'Install Newtonsoft.Json 13.0.1 in the target project before using this direct-reference installer.' }
$backup = $project + '.before-sparrow.bak'
if (Test-Path $backup) { throw "Backup already exists: $backup" }
$destination = Join-Path $directory 'lib/SparrowStudio'
if (Test-Path $destination) { throw "Destination already exists: $destination" }
Copy-Item -LiteralPath $project -Destination $backup
New-Item -ItemType Directory -Path $destination | Out-Null
Copy-Item (Join-Path $distribution 'SparrowStudio.Core.dll') $destination
Copy-Item (Join-Path $distribution 'sparrow_dotnet_native.dll') $destination
foreach ($name in @('README.md','LICENSE','THIRD_PARTY_NOTICES.txt')) {
    if (Test-Path (Join-Path $distribution $name)) { Copy-Item (Join-Path $distribution $name) $destination }
}
$group = $xml.CreateElement('ItemGroup', $ns)
$reference = $xml.CreateElement('Reference', $ns)
$reference.SetAttribute('Include', 'SparrowStudio.Core')
$hint = $xml.CreateElement('HintPath', $ns)
$hint.InnerText = 'lib\SparrowStudio\SparrowStudio.Core.dll'
$reference.AppendChild($hint) | Out-Null
$private = $xml.CreateElement('Private', $ns)
$private.InnerText = 'True'
$reference.AppendChild($private) | Out-Null
$group.AppendChild($reference) | Out-Null
$content = $xml.CreateElement('Content', $ns)
$content.SetAttribute('Include','lib\SparrowStudio\sparrow_dotnet_native.dll')
foreach ($entry in @(@('Link','sparrow_dotnet_native.dll'), @('CopyToOutputDirectory','PreserveNewest'))) {
    $child = $xml.CreateElement($entry[0], $ns)
    $child.InnerText = $entry[1]
    $content.AppendChild($child) | Out-Null
}
$group.AppendChild($content) | Out-Null
$import = $xml.SelectSingleNode('/m:Project/m:Import[contains(@Project,"Microsoft.CSharp.targets")]', $manager)
if ($null -eq $import) { throw 'Microsoft.CSharp.targets import not found.' }
$xml.DocumentElement.InsertBefore($group, $import) | Out-Null
$settings = New-Object System.Xml.XmlWriterSettings
$settings.Indent = $true
$settings.Encoding = New-Object System.Text.UTF8Encoding($true)
$writer = [System.Xml.XmlWriter]::Create($project, $settings)
try { $xml.Save($writer) } finally { $writer.Dispose() }
Write-Output "Added net472 reference: $project"
Write-Output "Backup: $backup"
Write-Output 'Build and run with Platform=x64. Existing Newtonsoft.Json 13.0.1 must be available.'
