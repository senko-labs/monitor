<#
    Builds a self-contained ZIP for deploying to other PCs.

    By default the ffmpeg build in tools\ffmpeg is bundled, so the target
    machine needs no download and no ffmpeg install. Pass -NoFfmpeg for a
    small archive that fetches ffmpeg during installation instead.
#>
param(
    [string]$OutDir,
    [switch]$NoFfmpeg
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $root 'dist' }

$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$name    = "screen-activity-recorder-$version"
$staging = Join-Path $env:TEMP ("pkg-" + [Guid]::NewGuid().ToString('N'))
$zip     = Join-Path $OutDir "$name.zip"

New-Item -ItemType Directory -Path $staging -Force | Out-Null
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

# Application files only - never recordings, logs, or the generated launcher
# (it hard-codes this machine's paths).
foreach ($item in 'src', 'scripts', 'config.json', 'package.json', 'README.md', 'INSTALL.md') {
    $path = Join-Path $root $item
    if (Test-Path $path) { Copy-Item $path -Destination $staging -Recurse -Force }
}

$ffmpegSrc = Join-Path $root 'tools\ffmpeg'
if (-not $NoFfmpeg -and (Test-Path (Join-Path $ffmpegSrc 'bin\ffmpeg.exe'))) {
    Write-Host 'Bundling ffmpeg ...'
    $toolsDst = Join-Path $staging 'tools\ffmpeg\bin'
    New-Item -ItemType Directory -Path $toolsDst -Force | Out-Null
    # Only the two binaries are needed; the rest of the build is documentation
    # and unused executables.
    foreach ($exe in 'ffmpeg.exe', 'ffprobe.exe') {
        Copy-Item (Join-Path $ffmpegSrc "bin\$exe") -Destination $toolsDst -Force
    }
} elseif (-not $NoFfmpeg) {
    Write-Warning 'tools\ffmpeg not found - the package will download ffmpeg during installation.'
}

if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip -CompressionLevel Optimal
Remove-Item -Recurse -Force $staging

$sizeMB = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host ''
Write-Host "Package: $zip  ($sizeMB MB)"
Write-Host 'Copy it to the target PC, unzip it, and run: powershell -ExecutionPolicy Bypass -File scripts\install.ps1'
