param(
    [switch]$SkipInstall,
    [switch]$OpenOutput,
    [switch]$Fast,
    [switch]$Install
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Require-Command {
    param([string]$Name, [string]$InstallHint)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        Write-Host "Missing command: $Name. $InstallHint" -ForegroundColor Red
        exit 1
    }
}

if ($env:OS -ne "Windows_NT") {
    Write-Host "This script must be run on Windows 11." -ForegroundColor Red
    exit 1
}

Write-Host "Document Ledger - Windows Build" -ForegroundColor Cyan
Write-Host "Project directory: $PSScriptRoot"

Require-Command "node" "Install Node.js LTS from https://nodejs.org/"
Require-Command "npm" "Reinstall Node.js LTS from https://nodejs.org/"

if (-not (Get-Command "cargo" -ErrorAction SilentlyContinue)) {
    $cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
    if (Test-Path (Join-Path $cargoBin "cargo.exe")) {
        $env:Path = "$cargoBin;$env:Path"
    }
}
Require-Command "cargo" "Install Rust from https://rustup.rs/ and reopen the terminal."

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) {
    Write-Host "Microsoft C++ Build Tools were not detected." -ForegroundColor Yellow
    Write-Host "Install Visual Studio Build Tools and select 'Desktop development with C++'."
    Write-Host "Download: https://visualstudio.microsoft.com/visual-cpp-build-tools/"
    exit 1
}

$vsInstall = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsInstall) {
    Write-Host "The Visual Studio C++ desktop workload is missing." -ForegroundColor Red
    exit 1
}

Write-Host "Node: $(node --version)"
Write-Host "Rust: $(rustc --version)"

if (-not $SkipInstall -and -not (Test-Path "node_modules")) {
    Write-Host "Installing locked project dependencies..." -ForegroundColor Cyan
    npm ci
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} elseif (Test-Path "node_modules") {
    Write-Host "Reusing existing node_modules (use npm ci manually after dependency changes)." -ForegroundColor DarkGray
}

$env:CARGO_INCREMENTAL = "1"
if ($Fast) {
    Write-Host "Building a fast DEBUG installer..." -ForegroundColor Cyan
    npm run tauri build -- --debug
    $targetProfile = "debug"
} else {
    Write-Host "Building the optimized RELEASE installer. The first build may take several minutes..." -ForegroundColor Cyan
    npm run tauri build
    $targetProfile = "release"
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$installerPattern = "src-tauri\target\$targetProfile\bundle\nsis\*-setup.exe"
$installer = Get-ChildItem $installerPattern | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $installer) {
    Write-Host "The build finished, but no NSIS installer was found." -ForegroundColor Red
    exit 1
}

$releaseDir = Join-Path $PSScriptRoot "release"
New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
$outputName = if ($Fast) { "document-ledger-debug-setup.exe" } else { "document-ledger-setup.exe" }
$output = Join-Path $releaseDir $outputName
Copy-Item $installer.FullName $output -Force

Write-Host ""
Write-Host "Build succeeded: $output" -ForegroundColor Green
if ($OpenOutput) {
    $explorerArguments = '/select,"{0}"' -f $output
    Start-Process -FilePath "explorer.exe" -ArgumentList $explorerArguments
}
if ($Install) {
    Write-Host "Installing the update in place..." -ForegroundColor Cyan
    $installProcess = Start-Process -FilePath $output -ArgumentList "/S" -Wait -PassThru
    if ($installProcess.ExitCode -ne 0) {
        Write-Host "Installer exited with code $($installProcess.ExitCode)." -ForegroundColor Red
        exit $installProcess.ExitCode
    }
    Write-Host "In-place update installed successfully. Your vault data was preserved." -ForegroundColor Green
}
