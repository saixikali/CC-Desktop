[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"

$minimumNodeVersion = [version]"22.18.0"
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeDownloadUrl = "https://nodejs.org/en/download"

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Fail {
    param([string]$Message)
    Write-Host ""
    Write-Host "ERROR: $Message" -ForegroundColor Red
    exit 1
}

if ($env:OS -ne "Windows_NT") {
    Fail "This installer supports Windows only."
}

if (-not [Environment]::Is64BitOperatingSystem) {
    Fail "CC Desktop currently supports Windows x64 only."
}

$nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
if (-not $nodeCommand) {
    Write-Host "Node.js $minimumNodeVersion or newer is required." -ForegroundColor Yellow
    Write-Host "Download: $nodeDownloadUrl"
    exit 1
}

$nodeVersionText = (& $nodeCommand.Source "--version").Trim().TrimStart("v")
try {
    $nodeVersion = [version]$nodeVersionText
} catch {
    Fail "Unable to read the Node.js version: $nodeVersionText"
}

if ($nodeVersion -lt $minimumNodeVersion) {
    Write-Host "Installed Node.js: $nodeVersion" -ForegroundColor Yellow
    Write-Host "Required Node.js: $minimumNodeVersion or newer" -ForegroundColor Yellow
    Write-Host "Download: $nodeDownloadUrl"
    exit 1
}

$npmCommand = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
if (-not $npmCommand) {
    Fail "npm.cmd was not found. Reinstall Node.js with npm enabled."
}

$packageJson = Join-Path $repoRoot "package.json"
$packageLock = Join-Path $repoRoot "package-lock.json"
if (-not (Test-Path -LiteralPath $packageJson) -or -not (Test-Path -LiteralPath $packageLock)) {
    Fail "Run this script from the extracted CC Desktop source directory."
}

Write-Host "CC Desktop local installer" -ForegroundColor Green
Write-Host "Source: $repoRoot"
Write-Host "Node.js: $nodeVersion"

if ($CheckOnly) {
    Write-Host ""
    Write-Host "Environment check passed." -ForegroundColor Green
    exit 0
}

Push-Location $repoRoot
try {
    Write-Step "Installing dependencies"
    & $npmCommand.Source ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
        throw "npm ci failed with exit code $LASTEXITCODE"
    }

    Write-Step "Building the Windows installer"
    & $npmCommand.Source run dist:win
    if ($LASTEXITCODE -ne 0) {
        throw "npm run dist:win failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

$distDirectory = Join-Path $repoRoot "dist"
$installer = Get-ChildItem -LiteralPath $distDirectory -Filter "CC-Desktop-*-x64-setup.exe" -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $installer) {
    Fail "The build completed, but no installer was found in $distDirectory."
}

$hash = Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256
Write-Host ""
Write-Host "Installer created:" -ForegroundColor Green
Write-Host $installer.FullName
Write-Host "SHA256: $($hash.Hash)"

if (-not $NoLaunch) {
    Write-Step "Starting the installer"
    Start-Process -FilePath $installer.FullName
}
