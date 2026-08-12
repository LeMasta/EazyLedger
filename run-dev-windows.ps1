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

if (-not (Test-Path "node_modules")) {
    npm ci
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

npm run tauri dev
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

