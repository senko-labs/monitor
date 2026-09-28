<#
    Downloads a static ffmpeg build into tools\ffmpeg so the recorder works
    without a system-wide install. No administrator rights required.

    If ffmpeg is already on PATH the recorder uses that one and this script is
    unnecessary.
#>
$ErrorActionPreference = 'Stop'

$root    = Split-Path -Parent $PSScriptRoot
$toolsDir = Join-Path $root 'tools'
$target   = Join-Path $toolsDir 'ffmpeg'
$exe      = Join-Path $target 'bin\ffmpeg.exe'

if (Test-Path $exe) {
    Write-Host "ffmpeg is already installed at $exe"
    & $exe -version | Select-Object -First 1
    exit 0
}

$url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
$zip = Join-Path $env:TEMP 'ffmpeg-release-essentials.zip'

Write-Host "Downloading ffmpeg from $url ..."
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing

$staging = Join-Path $env:TEMP ("ffmpeg-extract-" + [Guid]::NewGuid().ToString('N'))
Write-Host 'Extracting ...'
Expand-Archive -Path $zip -DestinationPath $staging -Force

$extracted = Get-ChildItem -Path $staging -Directory | Select-Object -First 1
if (-not $extracted) { throw 'Unexpected archive layout: no top-level folder found.' }

New-Item -ItemType Directory -Path $toolsDir -Force | Out-Null
if (Test-Path $target) { Remove-Item -Recurse -Force $target }
Move-Item -Path $extracted.FullName -Destination $target

Remove-Item -Recurse -Force $staging -ErrorAction SilentlyContinue
Remove-Item -Force $zip -ErrorAction SilentlyContinue

if (-not (Test-Path $exe)) { throw "ffmpeg.exe not found at $exe after extraction." }

Write-Host "Installed: $exe"
& $exe -version | Select-Object -First 1
