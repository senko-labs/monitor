<#
    Run this on a PC that will WATCH the recordings, to trust the viewer's
    self-signed certificate so the browser stops warning.

    Copy certs\viewer.crt from the recording PC first, then run:
        powershell -ExecutionPolicy Bypass -File scripts\trust-cert.ps1 -CrtPath <path to viewer.crt>

    It imports the certificate for the current user only (no admin rights). To
    trust it for every user on this PC, run an elevated PowerShell and add
    -Machine.
#>
param(
    [Parameter(Mandatory = $true)][string]$CrtPath,
    [switch]$Machine
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $CrtPath)) { throw "Certificate not found: $CrtPath" }

$store = if ($Machine) { 'Cert:\LocalMachine\Root' } else { 'Cert:\CurrentUser\Root' }
Import-Certificate -FilePath $CrtPath -CertStoreLocation $store | Out-Null

$scope = if ($Machine) { 'all users on this PC' } else { 'the current user' }
Write-Host "Imported $CrtPath into Trusted Root for $scope."
Write-Host 'Restart the browser, then open the viewer with no certificate warning.'
