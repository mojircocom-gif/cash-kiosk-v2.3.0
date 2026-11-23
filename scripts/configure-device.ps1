#Requires -RunAsAdministrator
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Server", "Client")]
  [string]$Role
)

$ErrorActionPreference = "Stop"
$dataDir = Join-Path $env:ProgramData "CashKiosk"
$tokenPath = Join-Path $dataDir "server-token"

New-Item -ItemType Directory -Path $dataDir -Force | Out-Null

if ($Role -eq "Server") {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $token = [BitConverter]::ToString($bytes).Replace("-", "").ToLowerInvariant()
  [System.IO.File]::WriteAllText($tokenPath, $token, [System.Text.Encoding]::ASCII)
} else {
  $secure = Read-Host "Enter the coordination token generated on the manager PC" -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
  if ([string]::IsNullOrWhiteSpace($token) -or $token.Length -lt 32) {
    throw "The coordination token must contain at least 32 characters."
  }
  [System.IO.File]::WriteAllText($tokenPath, $token, [System.Text.Encoding]::ASCII)
}

# Restrict the shared bearer secret to SYSTEM, local Administrators, and this operator account.
$currentAccount = "$env:USERDOMAIN\$env:USERNAME"
& icacls $dataDir /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)(F)" "*S-1-5-32-544:(OI)(CI)(F)" "${currentAccount}:(OI)(CI)(F)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not secure the CashKiosk data directory ACL." }
& icacls $tokenPath /inheritance:r /grant:r "*S-1-5-18:(F)" "*S-1-5-32-544:(F)" "${currentAccount}:(R)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Could not secure the coordination token ACL." }

[Environment]::SetEnvironmentVariable("CASH_KIOSK_ROLE", $Role.ToLowerInvariant(), "Machine")
[Environment]::SetEnvironmentVariable("CASH_KIOSK_SERVER_PORT", "5005", "Machine")

Write-Host ""
Write-Host "Cash Kiosk device role configured: $Role" -ForegroundColor Green
Write-Host "Token file: $tokenPath"
Write-Host "Sign out of Windows and sign in again before launching Cash Kiosk." -ForegroundColor Yellow

if ($Role -eq "Server") {
  Write-Host ""
  Write-Host "Copy this token directly to the operator PC using a secure local method." -ForegroundColor Yellow
  Write-Host "Do not send it in chat, email, or commit it to GitHub." -ForegroundColor Yellow
  Write-Host ""
  Write-Host $token -ForegroundColor Cyan
  Set-Clipboard -Value $token
  Write-Host "The token has also been copied to the clipboard."
} else {
  Write-Host "Client token stored and protected."
}
