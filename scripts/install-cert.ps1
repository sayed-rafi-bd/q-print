# Makes this PC trust Q-Print builds signed with the self-signed certificate.
# Run once per PC, as Administrator. After that, installers show "Verified publisher: KEEX".
#
# Usage (admin PowerShell):
#   powershell -ExecutionPolicy Bypass -File install-cert.ps1 -CerPath .\qprint-codesign.cer
param(
  [Parameter(Mandatory = $true)][string]$CerPath
)

$ErrorActionPreference = "Stop"

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw "Run this script from an elevated (Administrator) PowerShell." }

$cer = Get-PfxCertificate -FilePath $CerPath
Write-Host "Trusting: $($cer.Subject)  ($($cer.Thumbprint))"

Import-Certificate -FilePath $CerPath -CertStoreLocation Cert:\LocalMachine\Root             | Out-Null
Import-Certificate -FilePath $CerPath -CertStoreLocation Cert:\LocalMachine\TrustedPublisher | Out-Null

Write-Host "Done. Q-Print installers signed by this certificate are now trusted on this PC."
