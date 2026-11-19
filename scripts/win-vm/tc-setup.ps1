# The rig's one-time setup, run by the answer file at the admin's first logon from the answer-file stick.
# It reads setup.json beside it (written by install.sh), logs to C:\tc\setup.log, and ends by restarting so the
# standard user's first logon builds its profile. install.sh then waits for that desktop and shuts the machine down.
# On a failure it powers the machine off a minute later instead, which install.sh reports.
param([string]$Root)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
New-Item -ItemType Directory -Force C:\tc | Out-Null
Start-Transcript -Path C:\tc\setup.log -Append | Out-Null
try {
  $cfg = Get-Content -Raw (Join-Path $Root 'setup.json') | ConvertFrom-Json

  # The screen stays on and unlocked: screenshots and UI Automation need a live desktop.
  powercfg /change monitor-timeout-ac 0
  powercfg /change standby-timeout-ac 0
  powercfg /hibernate off
  New-Item -Force 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization' | Out-Null
  Set-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization' NoLockScreen 1 -Type DWord

  # Local passwords would expire after 42 days and stop the automatic logon inside the 90-day evaluation.
  Set-LocalUser -Name $cfg.adminUser -PasswordNeverExpires $true
  Set-LocalUser -Name $cfg.standardUser -PasswordNeverExpires $true

  # OpenSSH Server, Windows' own optional feature (downloaded from Windows Update).
  for ($i = 1; $i -le 5; $i++) {
    try { Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' | Out-Null; break }
    catch { "OpenSSH attempt $i failed: $_"; if ($i -eq 5) { throw }; Start-Sleep 30 }
  }
  Set-Service sshd -StartupType Automatic
  Start-Service sshd
  Stop-Service sshd
  # Keys: the admin's in the standard administrators file, every other user's under ProgramData by name, so a
  # key works before the user's profile exists.
  $conf = 'C:\ProgramData\ssh\sshd_config'
  (Get-Content $conf) -replace '^#?AuthorizedKeysFile.*', 'AuthorizedKeysFile .ssh/authorized_keys __PROGRAMDATA__/ssh/users/%u' -replace '^#?PasswordAuthentication.*', 'PasswordAuthentication no' | Set-Content -Encoding ascii $conf
  $admins = 'C:\ProgramData\ssh\administrators_authorized_keys'
  Set-Content -Encoding ascii $admins $cfg.publicKey
  icacls $admins /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null
  New-Item -ItemType Directory -Force C:\ProgramData\ssh\users | Out-Null
  $userKeys = "C:\ProgramData\ssh\users\$($cfg.standardUser)"
  Set-Content -Encoding ascii $userKeys $cfg.publicKey
  icacls $userKeys /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' /grant "$($cfg.standardUser):R" | Out-Null
  # QEMU's user-mode network is an unidentified one, so Public: the feature's rule allows Private only.
  if (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue) {
    Set-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -Enabled True -Profile Any
  } else {
    New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' -Protocol TCP -LocalPort 22 -Action Allow -Direction Inbound -Profile Any | Out-Null
  }
  Start-Service sshd

  # 10.0.2.2 is the box's own loopback, where its gateway and dev servers trust their callers. The guest may not
  # reach it. One rule per protocol, since a rule takes ports only for TCP or UDP: a thread that needs one TCP port
  # narrows tc-block-host-tcp (docs/agents/windows-vm.md).
  foreach ($proto in 'TCP', 'UDP') {
    New-NetFirewallRule -Name "tc-block-host-$($proto.ToLower())" -DisplayName "TempCode rig: no box loopback ($proto)" -Direction Outbound -RemoteAddress 10.0.2.2 -Protocol $proto -Action Block -Profile Any | Out-Null
  }

  # Git for Windows, machine-wide, on PATH: Claude Code's Bash tool and TempCode's command strings run in Git Bash.
  $git = Start-Process -Wait -PassThru (Join-Path $Root $cfg.gitInstaller) -ArgumentList '/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/SUPPRESSMSGBOXES', '/o:PathOption=Cmd'
  if ($git.ExitCode -ne 0) { throw "Git for Windows installer exited $($git.ExitCode)" }

  # From now on the standard user is the one logged on at boot.
  $wl = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
  Set-ItemProperty $wl AutoAdminLogon '1'
  Set-ItemProperty $wl DefaultUserName $cfg.standardUser
  Set-ItemProperty $wl DefaultPassword $cfg.standardPassword
  Set-ItemProperty $wl DefaultDomainName '.'
  Remove-ItemProperty $wl AutoLogonCount -ErrorAction SilentlyContinue

  # Windows 11's out-of-box step replaces the answer file's name with its own (PSD- on 25H2); the restart below applies this.
  if ($env:COMPUTERNAME -ne 'TC-WIN11') { Rename-Computer -NewName 'TC-WIN11' -Force }

  Set-Content C:\tc\setup-done (Get-Date -Format o)
  'setup done'
  $next = '/r'
} catch {
  "SETUP FAILED: $_"
  Set-Content C:\tc\setup-failed "$_"
  $next = '/s'
} finally {
  Stop-Transcript | Out-Null
}
# On a failure, a minute before power-off lets install.sh read C:\tc\setup-failed over SSH if sshd is up.
shutdown $next /t $(if ($next -eq '/s') { 60 } else { 5 }) /c "tc-setup.ps1"
