<#
    Checks every reason the viewer might be unreachable from another PC and
    prints what to fix. Read-only - changes nothing.

        powershell -ExecutionPolicy Bypass -File scripts\diagnose-viewer.ps1
#>
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$ok = '[ OK ]'; $bad = '[FAIL]'; $warn = '[warn]'

$cfg = Get-Content (Join-Path $root 'config.json') -Raw | ConvertFrom-Json
$port   = if ($cfg.viewerPort) { [int]$cfg.viewerPort } else { 8443 }
$scheme = if ($cfg.viewerHttps) { 'https' } else { 'http' }

Write-Host "=== Screen Activity Viewer diagnostics ===" -ForegroundColor Cyan
Write-Host ("config: {0}://<ip>:{1}, viewerBindAll={2}" -f $scheme, $port, $cfg.viewerBindAll)
Write-Host ""

# 1. config says bind to all interfaces
if ($cfg.viewerBindAll) {
    Write-Host "$ok  viewerBindAll is true"
} else {
    Write-Host "$bad viewerBindAll is FALSE - the viewer only listens on localhost."
    Write-Host "       Fix: set `"viewerBindAll`": true in config.json, then re-run install-viewer."
}

# 2. viewer process running
$proc = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*server.js*' }
if ($proc) {
    Write-Host "$ok  viewer process running (pid $($proc.ProcessId))"
} else {
    Write-Host "$bad viewer process is NOT running."
    Write-Host "       Fix: npm run install-viewer   (or check logs\monitor.log for an error)"
}

# 3. what address is it actually listening on
$listen = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listen) {
    $addrs = ($listen.LocalAddress | Sort-Object -Unique) -join ', '
    if ($listen.LocalAddress -contains '0.0.0.0' -or $listen.LocalAddress -contains '::') {
        Write-Host "$ok  listening on all interfaces ($addrs)"
    } else {
        Write-Host "$bad listening only on $addrs - not reachable from other PCs."
        Write-Host "       Fix: set viewerBindAll true and restart the viewer (npm run install-viewer)."
    }
} else {
    Write-Host "$bad nothing is listening on port $port."
}

# 4. firewall rule
$rule = Get-NetFirewallRule -DisplayName 'ScreenActivityViewer TCP*' -ErrorAction SilentlyContinue
if ($rule) {
    $profiles = ($rule | Get-NetFirewallRule | Select-Object -ExpandProperty Profile) -join ','
    Write-Host "$ok  firewall rule present (enabled=$($rule.Enabled), profile=$profiles)"
} else {
    Write-Host "$bad no firewall rule for the viewer - Windows will block other PCs."
    Write-Host "       Fix (elevated PowerShell):"
    Write-Host "       New-NetFirewallRule -DisplayName 'ScreenActivityViewer TCP $port' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -Profile Any"
}

# 5. active network profile (a Public network with no rule blocks inbound)
$profile = (Get-NetConnectionProfile | Select-Object -First 1).NetworkCategory
Write-Host "$warn active network profile: $profile"
if ($profile -eq 'Public') {
    Write-Host "       Public networks block inbound connections. The rule above uses -Profile Any,"
    Write-Host "       which covers Public; or change the connection to Private in Windows settings."
}

# 6. local loopback check (raw TCP, so it works on any PowerShell version and
# needs no certificate handling)
try {
    $client = New-Object System.Net.Sockets.TcpClient
    $iar = $client.BeginConnect('127.0.0.1', $port, $null, $null)
    if ($iar.AsyncWaitHandle.WaitOne(3000) -and $client.Connected) {
        Write-Host "$ok  accepts connections locally on port $port"
    } else {
        Write-Host "$bad nothing accepts connections on 127.0.0.1:$port"
    }
    $client.Close()
} catch {
    Write-Host "$bad local connection failed: $($_.Exception.Message)"
}

# 7. the addresses to use from another PC
Write-Host ""
Write-Host "Reach it from another PC on the same network at:"
Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '169.*' -and $_.IPAddress -ne '127.0.0.1' } |
    ForEach-Object { Write-Host "  $scheme`://$($_.IPAddress):$port" }
Write-Host ""
Write-Host "From the other PC, test raw connectivity with:"
Write-Host "  Test-NetConnection <this-pc-ip> -Port $port     (TcpTestSucceeded should be True)"
