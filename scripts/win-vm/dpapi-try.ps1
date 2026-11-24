# Opens the app's safeStorage key (Local State os_crypt.encrypted_key, DPAPI for the current user) and reports only
# whether it opened. `ownWorks` is the control: this user can seal and open data of its own, so a key that does not
# open belongs to someone else.
param([string]$LocalState, [string]$Out)
Add-Type -AssemblyName System.Security
$r = [ordered]@{ user = [Environment]::UserName }
try {
  $own = [Security.Cryptography.ProtectedData]::Protect([byte[]](1, 2, 3), $null, 'CurrentUser')
  $r.ownWorks = ([Security.Cryptography.ProtectedData]::Unprotect($own, $null, 'CurrentUser')).Length -eq 3
} catch { $r.ownWorks = $false; $r.ownError = $_.Exception.Message }
try {
  $j = Get-Content -Raw $LocalState | ConvertFrom-Json
  $b = [Convert]::FromBase64String($j.os_crypt.encrypted_key)
  $blob = $b[5..($b.Length - 1)]
  $k = [Security.Cryptography.ProtectedData]::Unprotect($blob, $null, 'CurrentUser')
  $r.opened = $true; $r.keyBytes = $k.Length
} catch { $r.opened = $false; $r.error = $_.Exception.Message }
$r | ConvertTo-Json -Compress | Set-Content -Encoding utf8 $Out
