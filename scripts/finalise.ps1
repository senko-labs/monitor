<#
    Closes the video that is currently being accumulated, however short it is,
    and assembles it into an MP4 right away. The running recorder picks the
    request up within a second; recording continues into a new video.
#>
$root = Split-Path -Parent $PSScriptRoot
$lock = Join-Path $root 'logs\recorder.lock'

if (-not (Test-Path $lock)) {
    Write-Host 'The recorder is not running - start it first.'
    exit 1
}

New-Item -ItemType File -Path (Join-Path $root 'logs\finalise.request') -Force | Out-Null
Write-Host 'Requested. Watch progress with: npm run status'
