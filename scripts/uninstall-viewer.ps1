<# Stops the viewer web server and removes its logon task and firewall rule. #>
param(
    [string]$TaskName = 'ScreenActivityViewer'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'."
} else {
    Write-Host "Scheduled task '$TaskName' is not registered."
}

# Stop the running server (node process serving src\server.js).
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like '*server.js*' } |
    ForEach-Object {
        Write-Host "Stopping viewer server (pid $($_.ProcessId)) ..."
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

Get-NetFirewallRule -DisplayName 'ScreenActivityViewer TCP *' -ErrorAction SilentlyContinue |
    ForEach-Object {
        Remove-NetFirewallRule -Name $_.Name -ErrorAction SilentlyContinue
        Write-Host "Removed firewall rule '$($_.DisplayName)'."
    }

$vbs = Join-Path $root 'launch-viewer-hidden.vbs'
if (Test-Path $vbs) { Remove-Item $vbs -Force }
Write-Host 'Done.'
