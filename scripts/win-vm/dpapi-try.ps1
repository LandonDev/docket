# Opens the app's safeStorage key (Local State os_crypt.encrypted_key, DPAPI for the current user) and reports only whether it opened.
param([string]$LocalState, [string]$Out)
Add-Type -AssemblyName System.Security
$r = [ordered]@{ user = [Environment]::UserName }
try {
  $j = Get-Content -Raw $LocalState | ConvertFrom-Json
  $b = [Convert]::FromBase64String($j.os_crypt.encrypted_key)
  $blob = $b[5..($b.Length - 1)]
  $k = [Security.Cryptography.ProtectedData]::Unprotect($blob, $null, 'CurrentUser')
  $r.opened = $true; $r.keyBytes = $k.Length
} catch { $r.opened = $false; $r.error = $_.Exception.Message }
$r | ConvertTo-Json -Compress | Set-Content -Encoding utf8 $Out
