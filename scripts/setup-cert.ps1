<#
    Generates a self-signed TLS certificate for the viewer and writes it to
    certs\ as a PFX (private key, loaded by the server) plus a .crt (public
    certificate, for importing as trusted on the PCs that will watch).

    Self-signed is the right tool here: the viewer runs on a LAN with no public
    DNS name, so no certificate authority can issue for it. Browsers show a
    one-time "not trusted" warning; import viewer.crt on the client to remove it
    (see INSTALL.md).

    Re-run any time to rotate the certificate. No administrator rights needed.
#>
param(
    [int]$Days = 3650,
    [string[]]$ExtraNames = @()
)

$ErrorActionPreference = 'Stop'

# npm (and some other launchers) overwrite PSModulePath, which stops PowerShell
# from finding the certificate provider and the PKI cmdlets. Restore the system
# default so the Cert:\ drive and New-SelfSignedCertificate are available
# however this script was started.
$env:PSModulePath = [Environment]::GetEnvironmentVariable('PSModulePath', 'Machine') + ';' +
                    [Environment]::GetEnvironmentVariable('PSModulePath', 'User')
Import-Module PKI -ErrorAction SilentlyContinue
if (-not (Get-PSDrive -Name Cert -ErrorAction SilentlyContinue)) {
    throw 'The Windows certificate provider is not available in this shell. Run: powershell.exe -ExecutionPolicy Bypass -File scripts\setup-cert.ps1'
}

$root  = Split-Path -Parent $PSScriptRoot
$certs = Join-Path $root 'certs'
New-Item -ItemType Directory -Path $certs -Force | Out-Null

$pfxPath  = Join-Path $certs 'viewer.pfx'
$passPath = Join-Path $certs 'viewer.pfx.pass'
$crtPath  = Join-Path $certs 'viewer.crt'

# Subject Alternative Names: every host name and IP a browser might use to
# reach this PC. IPs must go in IPAddress= entries, not DNS= - Chrome only
# matches an address you type in the URL against a real IP SAN entry.
$dnsNames = @('localhost', $env:COMPUTERNAME)
$ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '169.*' } |
    Select-Object -ExpandProperty IPAddress
$ips = @($ips) + '127.0.0.1'

foreach ($n in $ExtraNames) {
    if ($n) { if ([System.Net.IPAddress]::TryParse($n, [ref]$null)) { $ips += $n } else { $dnsNames += $n } }
}
$dnsNames = $dnsNames | Where-Object { $_ } | Select-Object -Unique
$ips = $ips | Where-Object { $_ } | Select-Object -Unique

$sanParts  = @($dnsNames | ForEach-Object { "DNS=$_" })
$sanParts += @($ips | ForEach-Object { "IPAddress=$_" })
$sanExt = '2.5.29.17={text}' + ($sanParts -join '&')

Write-Host "Creating a self-signed certificate for: $(($dnsNames + $ips) -join ', ')"

$cert = New-SelfSignedCertificate `
    -Subject "CN=$env:COMPUTERNAME (Screen Activity Viewer)" `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -KeyExportPolicy Exportable `
    -KeyAlgorithm RSA -KeyLength 2048 `
    -NotAfter (Get-Date).AddDays($Days) `
    -FriendlyName 'ScreenActivityViewer' `
    -TextExtension @($sanExt, '2.5.29.37={text}1.3.6.1.5.5.7.3.1')  # SAN + Server Authentication EKU

# Random passphrase for the PFX, kept beside it in the same user-protected folder.
$bytes = New-Object byte[] 24
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$pass = [Convert]::ToBase64String($bytes)
$secure = ConvertTo-SecureString $pass -AsPlainText -Force

Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $secure | Out-Null
Export-Certificate   -Cert $cert -FilePath $crtPath | Out-Null
$pass | Out-File -FilePath $passPath -Encoding ASCII -NoNewline

# The PFX holds the key now, so drop the copy from the certificate store.
Remove-Item ("Cert:\CurrentUser\My\" + $cert.Thumbprint) -ErrorAction SilentlyContinue

Write-Host ''
Write-Host "Wrote:"
Write-Host "  $pfxPath   (private key - keep it here, do not share)"
Write-Host "  $crtPath   (public cert - copy to viewer PCs to trust the site)"
Write-Host ''
$until = (Get-Date).AddDays($Days).ToString('yyyy-MM-dd')
Write-Host "Valid until $until. Set 'viewerHttps' to true in config.json, then restart the viewer."
