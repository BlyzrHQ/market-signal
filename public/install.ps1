[CmdletBinding()]
param(
  [string]$BaseUrl = "https://signal.blyzr.com/downloads",
  [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA "Programs\MarketSignal"),
  [switch]$SkipPathUpdate
)

& {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [Parameter(Mandatory = $true)][string]$InstallDirectory,
    [switch]$SkipPathUpdate
  )

  $ErrorActionPreference = "Stop"

  function Invoke-VerifiedDownloadWithRetry {
    param(
      [Parameter(Mandatory = $true)][string]$BaseUrl,
      [Parameter(Mandatory = $true)][string]$AssetName,
      [Parameter(Mandatory = $true)][string]$BinaryPath,
      [Parameter(Mandatory = $true)][string]$ChecksumsPath
    )

    $lastError = $null
    for ($attempt = 1; $attempt -le 3; $attempt++) {
      try {
        Remove-Item -LiteralPath $BinaryPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $ChecksumsPath -Force -ErrorAction SilentlyContinue

        Invoke-WebRequest -Uri "$BaseUrl/$AssetName" -OutFile $BinaryPath -UseBasicParsing -ErrorAction Stop
        if (-not (Test-Path -LiteralPath $BinaryPath)) {
          throw "The server did not return the CLI binary."
        }
        $binaryLength = (Get-Item -LiteralPath $BinaryPath -ErrorAction Stop).Length
        if ($binaryLength -le 0) { throw "The server returned an empty CLI binary." }
        if ($binaryLength -gt 50MB) { throw "The Market Signal CLI download is unexpectedly large." }

        Invoke-WebRequest -Uri "$BaseUrl/SHA256SUMS.txt" -OutFile $ChecksumsPath -UseBasicParsing -ErrorAction Stop
        if (-not (Test-Path -LiteralPath $ChecksumsPath)) {
          throw "The server did not return the checksum manifest."
        }
        $manifestLength = (Get-Item -LiteralPath $ChecksumsPath -ErrorAction Stop).Length
        if ($manifestLength -le 0) { throw "The server returned an empty checksum manifest." }
        if ($manifestLength -gt 64KB) { throw "The Market Signal checksum manifest is unexpectedly large." }

        $checksumLine = Get-Content -LiteralPath $ChecksumsPath -ErrorAction Stop |
          Where-Object { $_ -match ("^[0-9a-fA-F]{64}\s+" + [regex]::Escape($AssetName) + "$") } |
          Select-Object -First 1
        if (-not $checksumLine) {
          throw "The download checksum manifest does not contain $AssetName."
        }
        $expectedChecksum = ($checksumLine -split "\s+", 2)[0].ToUpperInvariant()

        $fileStream = $null
        $sha256 = $null
        try {
          $fileStream = [System.IO.File]::OpenRead($BinaryPath)
          $sha256 = [System.Security.Cryptography.SHA256]::Create()
          $hashBytes = $sha256.ComputeHash($fileStream)
          if (($null -eq $hashBytes) -or ($hashBytes.Length -ne 32)) {
            throw "Windows returned an invalid SHA-256 result."
          }
          $actualChecksum = ([System.BitConverter]::ToString($hashBytes)).Replace("-", "")
        } finally {
          if ($null -ne $fileStream) { $fileStream.Dispose() }
          if ($null -ne $sha256) { $sha256.Dispose() }
        }
        if ($actualChecksum -ne $expectedChecksum) {
          throw "The downloaded CLI binary did not match its SHA-256 checksum."
        }

        return
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
    Invoke-VerifiedDownloadWithRetry -BaseUrl $BaseUrl -AssetName $assetName -BinaryPath $temporaryBinary -ChecksumsPath $temporaryChecksums

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
} -BaseUrl $BaseUrl -InstallDirectory $InstallDirectory -SkipPathUpdate:$SkipPathUpdate
