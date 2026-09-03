[CmdletBinding()]
param(
  [string]$BaseUrl = "https://signal.blyzr.com/downloads",
  [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA "Programs\MarketSignal"),
  [switch]$SkipPathUpdate
)

$ErrorActionPreference = "Stop"

function Invoke-DownloadWithRetry {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][string]$OutFile
  )

  $lastError = $null
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue
      Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing -ErrorAction Stop
      if ((Test-Path -LiteralPath $OutFile) -and ((Get-Item -LiteralPath $OutFile).Length -gt 0)) {
        return
      }
      throw "The server returned an empty download."
    } catch {
      $lastError = $_.Exception.Message
      if ($attempt -lt 3) {
        Start-Sleep -Milliseconds (250 * $attempt)
      }
    }
  }

  throw "The Market Signal CLI download failed after 3 attempts. $lastError"
}

function Get-Sha256WithRetry {
  param([Parameter(Mandatory = $true)][string]$Path)

  $lastError = $null
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      $hashResult = Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop
      if (($null -ne $hashResult) -and -not [string]::IsNullOrWhiteSpace([string]$hashResult.Hash)) {
        return ([string]$hashResult.Hash).ToUpperInvariant()
      }
      throw "Windows returned an empty SHA-256 result."
    } catch {
      $lastError = $_.Exception.Message
      if ($attempt -lt 3) {
        Start-Sleep -Milliseconds (250 * $attempt)
      }
    }
  }

  throw "The Market Signal CLI download could not be verified after 3 attempts. $lastError"
}

$binaryName = "marketsignal.exe"
$downloadBase = $null
if (-not [Uri]::TryCreate($BaseUrl.TrimEnd("/"), [UriKind]::Absolute, [ref]$downloadBase)) {
  throw "The Market Signal download URL is invalid."
}
if (($downloadBase.Scheme -ne "https") -and -not $downloadBase.IsLoopback) {
  throw "The Market Signal download URL must use HTTPS."
}
if ($downloadBase.UserInfo -or $downloadBase.Query -or $downloadBase.Fragment) {
  throw "The Market Signal download URL must not contain credentials, a query, or a fragment."
}
$BaseUrl = $downloadBase.AbsoluteUri.TrimEnd("/")

$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
switch ($architecture) {
  "X64" { $assetName = "marketsignal-windows-amd64.exe" }
  "Arm64" { $assetName = "marketsignal-windows-arm64.exe" }
  default { throw "Market Signal CLI supports Windows x64 and Arm64. Detected: $architecture" }
}

$temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("market-signal-cli-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null

try {
  $temporaryBinary = Join-Path $temporaryDirectory $assetName
  $temporaryChecksums = Join-Path $temporaryDirectory "SHA256SUMS.txt"
  Invoke-DownloadWithRetry -Uri "$BaseUrl/$assetName" -OutFile $temporaryBinary
  Invoke-DownloadWithRetry -Uri "$BaseUrl/SHA256SUMS.txt" -OutFile $temporaryChecksums
  if ((Get-Item -LiteralPath $temporaryBinary).Length -gt 50MB) { throw "The Market Signal CLI download is unexpectedly large." }
  if ((Get-Item -LiteralPath $temporaryChecksums).Length -gt 64KB) { throw "The Market Signal checksum manifest is unexpectedly large." }

  $checksumLine = Get-Content -LiteralPath $temporaryChecksums | Where-Object { $_ -match ("^[0-9a-fA-F]{64}\s+" + [regex]::Escape($assetName) + "$") } | Select-Object -First 1
  if (-not $checksumLine) { throw "The download checksum manifest does not contain $assetName." }
  $expectedChecksum = ($checksumLine -split "\s+", 2)[0].ToUpperInvariant()
  $actualChecksum = Get-Sha256WithRetry -Path $temporaryBinary
  if ($actualChecksum -ne $expectedChecksum) { throw "The Market Signal CLI download failed its SHA-256 integrity check." }

  New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
  $installedBinary = Join-Path $InstallDirectory $binaryName
  Move-Item -LiteralPath $temporaryBinary -Destination $installedBinary -Force

  if (-not $SkipPathUpdate) {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $pathEntries = @($userPath -split ";" | Where-Object { $_ })
    if (-not ($pathEntries | Where-Object { $_.TrimEnd("\") -ieq $InstallDirectory.TrimEnd("\") })) {
      $nextPath = (@($pathEntries) + $InstallDirectory) -join ";"
      [Environment]::SetEnvironmentVariable("Path", $nextPath, "User")
    }
    if (-not (($env:Path -split ";") | Where-Object { $_.TrimEnd("\") -ieq $InstallDirectory.TrimEnd("\") })) {
      $env:Path = "$env:Path;$InstallDirectory"
    }
  }

  Write-Host "Market Signal CLI installed successfully."
  & $installedBinary version
  Write-Host "Next: marketsignal login"
} finally {
  Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
