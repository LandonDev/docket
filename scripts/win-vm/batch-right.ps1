$sid = (Get-LocalUser tcuser2).SID.Value
$inf = "$env:TEMP\sec.inf"; $db = "$env:TEMP\sec.sdb"
secedit /export /cfg $inf /areas USER_RIGHTS | Out-Null
$lines = Get-Content $inf
$i = ($lines | Select-String '^SeBatchLogonRight').LineNumber
if ($i) { if ($lines[$i - 1] -notmatch $sid) { $lines[$i - 1] = $lines[$i - 1] + ",*$sid" } } else { $lines += "SeBatchLogonRight = *$sid" }
$lines | Set-Content $inf
secedit /configure /db $db /cfg $inf /areas USER_RIGHTS | Out-Null
"batch right: " + ((Get-Content $inf | Select-String '^SeBatchLogonRight') -match $sid)
