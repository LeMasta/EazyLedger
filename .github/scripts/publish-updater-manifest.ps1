param(
  [Parameter(Mandatory = $true)]
  [string]$Repository,

  [Parameter(Mandatory = $true)]
  [string]$Tag,

  [Parameter(Mandatory = $true)]
  [string]$Token,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = "Stop"
$headers = @{
  Authorization = "Bearer $Token"
  Accept = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
  "User-Agent" = "EazyLedger-release-workflow"
}

$release = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$Repository/releases/tags/$Tag"
$manifestAsset = $release.assets | Where-Object { $_.name -eq "latest.json" } | Select-Object -First 1
if (-not $manifestAsset) {
  throw "Release $Tag 中没有 latest.json"
}

$manifest = Invoke-RestMethod -Headers @{ "User-Agent" = "EazyLedger-release-workflow" } -Uri $manifestAsset.browser_download_url
$platforms = @($manifest.platforms.PSObject.Properties)
if ($platforms.Count -eq 0) {
  throw "latest.json 中没有 platforms"
}

foreach ($platform in $platforms) {
  $currentUrl = [Uri]$platform.Value.url

  # tauri-action may already emit the authenticated GitHub Asset API URL,
  # whose last path segment is a numeric asset ID rather than a file name.
  $installerAsset = $release.assets |
    Where-Object {
      $_.url -eq $currentUrl.AbsoluteUri -or
      $_.browser_download_url -eq $currentUrl.AbsoluteUri
    } |
    Select-Object -First 1

  if (-not $installerAsset) {
    $assetName = [Uri]::UnescapeDataString([IO.Path]::GetFileName($currentUrl.AbsolutePath))
    $installerAsset = $release.assets | Where-Object { $_.name -eq $assetName } | Select-Object -First 1
  }

  if (-not $installerAsset) {
    throw "Release $Tag 中找不到清单引用的安装包：$($platform.Value.url)"
  }

  # GitHub API asset URL works with Accept: application/octet-stream, which
  # Tauri Updater already sends for package downloads.
  $platform.Value.url = $installerAsset.url
}

$outputDirectory = Split-Path -Parent $OutputPath
if ($outputDirectory) {
  New-Item -ItemType Directory -Force $outputDirectory | Out-Null
}
$manifest | ConvertTo-Json -Depth 20 | Set-Content -Path $OutputPath -Encoding utf8NoBOM
Write-Host "稳定更新清单已生成：$OutputPath"
