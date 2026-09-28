<# Stops the recorder and removes its logon task. Recorded files are kept. #>
param(
    [string]$TaskName = 'ScreenActivityRecorder'
)

$ErrorActionPreference = 'Stop'

$taskName = $TaskName
$root     = Split-Path -Parent $PSScriptRoot

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed scheduled task '$taskName'."
} else {
    Write-Host "Scheduled task '$taskName' is not registered."
}

& (Join-Path $PSScriptRoot 'stop.ps1')

$vbs = Join-Path $root 'launch-hidden.vbs'
if (Test-Path $vbs) { Remove-Item $vbs -Force }
