# Creates a self-signed code-signing certificate for Q-Print (run once, on your own PC).
#
# Output (in $OutDir, default your home folder):
#   qprint-codesign.pfx  PRIVATE. Signs the builds. Goes into the GitHub secrets. Never commit it or share it.
#   qprint-codesign.cer  PUBLIC. Copy it to every PC that should trust the app (see install-cert.ps1).
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\new-selfsigned-cert.ps1
param(
  [string]$Subject = "CN=KEEX",          # keep identical to bundle.publisher in tauri.windows.conf.json
  [int]$Years = 5,
  [string]$OutDir = $HOME
)

$ErrorActionPreference = "Stop"

$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject $Subject `
  -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
  -KeyExportPolicy Exportable `
  -CertStoreLocation Cert:\CurrentUser\My `
  -NotAfter (Get-Date).AddYears($Years)

$pfx = Join-Path $OutDir "qprint-codesign.pfx"
$cer = Join-Path $OutDir "qprint-codesign.cer"
$pw  = Read-Host -AsSecureString "Choose a password for the .pfx"

Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $pw | Out-Null
Export-Certificate    -Cert $cert -FilePath $cer | Out-Null

# Base64 of the .pfx, ready to paste into the WINDOWS_CERTIFICATE_BASE64 secret.
[Convert]::ToBase64String([IO.File]::ReadAllBytes($pfx)) | Set-Clipboard

Write-Host ""
Write-Host "Subject    : $($cert.Subject)"
Write-Host "Thumbprint : $($cert.Thumbprint)"
Write-Host "Expires    : $($cert.NotAfter)"
Write-Host "PFX        : $pfx   (private)"
Write-Host "CER        : $cer   (give this one to your group's PCs)"
Write-Host ""
Write-Host "The base64 text of the .pfx is now in your clipboard."
Write-Host "Next: GitHub > Settings > Secrets and variables > Actions, then add:"
Write-Host "  WINDOWS_CERTIFICATE_BASE64    = (paste)"
Write-Host "  WINDOWS_CERTIFICATE_PASSWORD  = the password you just typed"

# Remove the private key from this PC's store; the .pfx is the only copy you need to keep safe.
Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)" -DeleteKey -Force
