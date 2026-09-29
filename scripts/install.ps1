<#
    One-command install on a fresh PC: checks Node.js, makes sure ffmpeg is
    available, registers the hidden logon task, and starts recording.

    Run it from the unzipped folder:
        powershell -ExecutionPolicy Bypass -File scripts\install.ps1
#>
param(
    [string]$TaskName = 'ScreenActivityRecorder',
    [string]$OutputDir,          # e.g. D:\ScreenRecordings
    [switch]$SkipNodeInstall
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Step($text) { Write-Host ''; Write-Host "==> $text" -ForegroundColor Cyan }

Step 'Checking Windows version'
$os = Get-CimInstance Win32_OperatingSystem
Write-Host "$($os.Caption) ($($os.Version))"
if ([Version]$os.Version -lt [Version]'10.0') {
    throw 'Windows 10 or newer is required.'
}

Step 'Checking Node.js'
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if ($node) {
    $nodeVersion = (& $node -v).TrimStart('v')
    Write-Host "Found Node $nodeVersion at $node"
    if ([Version]($nodeVersion -replace '-.*$') -lt [Version]'18.0.0') {
        throw "Node 18 or newer is required (found $nodeVersion)."
    }
} elseif ($SkipNodeInstall) {
    throw 'Node.js was not found and -SkipNodeInstall was given.'
} else {
    Write-Host 'Node.js was not found. Installing the LTS build with winget ...'
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw 'winget is unavailable. Install Node.js 18+ from https://nodejs.org and re-run this script.'
    }
    winget install --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
    # winget updates PATH for new processes only, so refresh this session.
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path', 'User')
    $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
    if (-not $node) {
        throw 'Node.js was installed but is not on PATH yet. Open a new terminal and re-run this script.'
    }
    Write-Host "Installed Node $(& $node -v)"
}

Step 'Checking ffmpeg'
$bundled = Join-Path $root 'tools\ffmpeg\bin\ffmpeg.exe'
if (Test-Path $bundled) {
    Write-Host "Using the bundled build: $bundled"
    & $bundled -version | Select-Object -First 1
} elseif (Get-Command ffmpeg -ErrorAction SilentlyContinue) {
    Write-Host 'Using the ffmpeg already on PATH:'
    ffmpeg -version | Select-Object -First 1
    if (-not (Get-Command ffprobe -ErrorAction SilentlyContinue)) {
        throw 'ffmpeg is on PATH but ffprobe is not; both are required.'
    }
} else {
    Write-Host 'Not found - downloading a static build ...'
    & (Join-Path $PSScriptRoot 'setup-ffmpeg.ps1')
}

if ($OutputDir) {
    Step "Setting the output folder to $OutputDir"
    $cfgPath = Join-Path $root 'config.json'
    $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
    $cfg.outputDir = $OutputDir
    $cfg | ConvertTo-Json | Set-Content $cfgPath -Encoding UTF8
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

Step 'Checking free disk space'
$cfg = Get-Content (Join-Path $root 'config.json') -Raw | ConvertFrom-Json
$outDir = if ([System.IO.Path]::IsPathRooted($cfg.outputDir)) { $cfg.outputDir } else { Join-Path $root $cfg.outputDir }
$drive = (Split-Path -Qualifier $outDir).TrimEnd(':')
$free = (Get-PSDrive $drive).Free / 1GB
Write-Host ("Drive {0}: has {1:N1} GB free. Sessions vary in size with how long the PC is used." -f $drive, $free)
if ($free -lt 10) { Write-Warning 'Less than 10 GB free - recording will suspend quickly.' }

Step 'Registering the hidden logon task (recorder)'
& (Join-Path $PSScriptRoot 'install-autostart.ps1') -TaskName $TaskName

Step 'Registering the recordings viewer (browser access)'
& (Join-Path $PSScriptRoot 'install-viewer.ps1')

Step 'Done'
Write-Host 'The recorder is running and will start automatically at every logon.'
Write-Host ''
$viewerPort = if ($cfg.viewerPort) { $cfg.viewerPort } else { 8088 }
Write-Host "  Recordings : $outDir"
Write-Host "  Viewer     : http://localhost:$viewerPort  (browse recordings in a browser)"
Write-Host "  Status     : npm run status"
Write-Host "  Stop       : npm run stop"
Write-Host "  Remove     : npm run uninstall-autostart  (and npm run uninstall-viewer)"
if (-not $cfg.viewerBindAll) {
    Write-Host ''
    Write-Host '  To view from another PC: set "viewerBindAll": true in config.json,'
    Write-Host '  then re-run: npm run install-viewer'
}
