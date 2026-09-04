$ErrorActionPreference = 'Stop'
# Run from the extracted, operator-provided GitHub Actions artifact. This
# installer never asks for a key and never launches a report.
$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
if ($architecture -eq 'x64') { $architecture = 'amd64' }
if ($architecture -notin @('amd64', 'arm64')) { throw 'Only Windows x64 and Arm64 are supported.' }
$name = "marketsignal-trigger-windows-$architecture.exe"
$source = Join-Path $PSScriptRoot $name
$manifest = Join-Path $PSScriptRoot 'SHA256SUMS'
$entry = Get-Content -LiteralPath $manifest | Where-Object { $_ -match "^[a-fA-F0-9]{64}\s+\*?$([regex]::Escape($name))$" }
if (@($entry).Count -ne 1) { throw 'Missing or duplicate binary checksum.' }
$expected = ($entry -split '\s+')[0].ToLowerInvariant()
$sha = [System.Security.Cryptography.SHA256]::Create()
$stream = [System.IO.File]::OpenRead($source)
try { $actual = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
finally { $stream.Dispose(); $sha.Dispose() }
if ($actual -ne $expected) { throw 'Binary checksum mismatch.' }
$directory = Join-Path $env:LOCALAPPDATA 'Programs\MarketSignalTrigger'
New-Item -ItemType Directory -Force -Path $directory | Out-Null
Copy-Item -LiteralPath $source -Destination (Join-Path $directory 'marketsignal-trigger.exe') -Force
$userPath = [string][Environment]::GetEnvironmentVariable('Path', 'User')
if ($directory -notin @($userPath -split ';')) {
  [Environment]::SetEnvironmentVariable('Path', (($userPath.TrimEnd(';') + ';' + $directory).TrimStart(';')), 'User')
}
if ($directory -notin @($env:Path -split ';')) { $env:Path += ";$directory" }
Write-Output 'Installed marketsignal-trigger. Next: marketsignal-trigger configure'
