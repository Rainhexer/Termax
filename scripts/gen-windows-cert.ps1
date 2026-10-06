<#
.SYNOPSIS
  Generate a self-signed Authenticode certificate for signing Termax's Windows
  installer, and print the values to store as GitHub Actions secrets.

.DESCRIPTION
  Run this once on a Windows machine (PowerShell 5.1+ / PowerShell 7, any user —
  no admin needed). It creates a 10-year code-signing certificate, exports it as
  a password-protected .pfx, and prints the base64 blob to paste into the
  WINDOWS_CERTIFICATE secret.

  What a self-signed certificate does and does not buy you is documented in
  docs/SIGNING.md — read that before assuming this removes the SmartScreen
  prompt. It does not. It gives the installer a stable, verifiable publisher
  identity and tamper detection; reputation requires a CA-issued certificate.

.EXAMPLE
  ./scripts/gen-windows-cert.ps1 -Subject "Ravn" -OutDir "$HOME\termax-signing"
#>
param(
  [string]$Subject = "Ravn",
  [string]$OutDir = "$HOME\termax-signing",
  [int]$YearsValid = 10
)

$ErrorActionPreference = "Stop"

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$pfxPath = Join-Path $OutDir "termax-codesign.pfx"
$cerPath = Join-Path $OutDir "termax-codesign.cer"

Write-Host "==> The .pfx is protected by a password. Store it as the"
Write-Host "    WINDOWS_CERTIFICATE_PASSWORD secret."
$password = Read-Host -AsSecureString "Password for the .pfx"
if ($password.Length -eq 0) { throw "Empty password rejected." }

Write-Host "==> Creating self-signed code-signing certificate for CN=$Subject"
$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject "CN=$Subject" `
  -KeyAlgorithm RSA `
  -KeyLength 4096 `
  -HashAlgorithm SHA256 `
  -KeyExportPolicy Exportable `
  -KeyUsage DigitalSignature `
  -NotAfter (Get-Date).AddYears($YearsValid) `
  -CertStoreLocation "Cert:\CurrentUser\My"

Write-Host "==> Exporting $pfxPath"
Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $password | Out-Null

Write-Host "==> Exporting public certificate to $cerPath"
# Users can import this into Trusted Publishers to make the signature trusted on
# their own machine; it is safe to commit or attach to a release.
Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null

$base64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($pfxPath))
$b64Path = Join-Path $OutDir "termax-codesign.pfx.base64"
Set-Content -Path $b64Path -Value $base64 -NoNewline

Write-Host ""
Write-Host "==================== GitHub Actions secrets ===================="
Write-Host ""
Write-Host "WINDOWS_CERTIFICATE          -> contents of $b64Path"
Write-Host "WINDOWS_CERTIFICATE_PASSWORD -> the password you just typed"
Write-Host ""
Write-Host "Thumbprint (SHA1): $($cert.Thumbprint)"
Write-Host ""
Write-Host "With the gh CLI:"
Write-Host ""
Write-Host "  gh secret set WINDOWS_CERTIFICATE < `"$b64Path`""
Write-Host "  gh secret set WINDOWS_CERTIFICATE_PASSWORD"
Write-Host ""
Write-Host "==============================================================="
Write-Host ""
Write-Host "Keep $pfxPath somewhere safe and offline. Anyone holding it plus the"
Write-Host "password can sign software as CN=$Subject."
