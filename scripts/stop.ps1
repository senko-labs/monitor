<# Asks a running recorder to shut down cleanly so the current MP4 is finalised. #>
$ErrorActionPreference = 'SilentlyContinue'

$root = Split-Path -Parent $PSScriptRoot
$lock = Join-Path $root 'logs\recorder.lock'

if (-not (Test-Path $lock)) {
    Write-Host 'No running recorder found.'
    exit 0
}

$recorderPid = [int](Get-Content $lock -Raw).Trim()
$proc = Get-Process -Id $recorderPid -ErrorAction SilentlyContinue
if (-not $proc) {
    Write-Host "Stale lock file (pid $recorderPid); removing."
    Remove-Item $lock -Force
    exit 0
}

Write-Host "Stopping recorder (pid $recorderPid) ..."
# Ending the node process makes ffmpeg's stdin close, so it finalises the file.
Stop-Process -Id $recorderPid
Start-Sleep -Seconds 3

# ffmpeg is a child process; give any survivor a moment, then clean up.
Get-CimInstance Win32_Process -Filter "Name = 'ffmpeg.exe'" |
    Where-Object { $_.CommandLine -like '*gdigrab*' } |
    ForEach-Object {
        Write-Host "Stopping leftover ffmpeg (pid $($_.ProcessId)) ..."
        Stop-Process -Id $_.ProcessId -Force
    }

Remove-Item $lock -Force -ErrorAction SilentlyContinue
Write-Host 'Stopped.'
