# The Windows rig on the box

One Windows 11 machine under QEMU/KVM on the box, for the threads that build and test TempCode's Windows port
(M12, M13, M41 to M44 of the Work plan). It runs as the `agents` user with no root, user-mode networking, every
forward bound to 127.0.0.1, capped at 8 cores and 16 GB. Everything of it lives under `/srv/agents/win-vm/`; the
scripts are `scripts/win-vm/` (`vm.ts` does the work, each `*.sh` is one of its commands).

## What it is

- **Windows:** Microsoft's own Windows 11 Enterprise **Evaluation**, downloaded from Microsoft by `fetch.sh`
  (today's ISO is the 25H2 release, file name build 26200.6584). No product key, never activated, no Office.
  The evaluation runs 90 days from the image's install; `ssh.sh winver` says how many are left.
- **Users:** `tcadmin` (Administrators) for setup, and `tcuser` (Users), a standard user that models a locked-down
  PC. `tcuser` is logged on at boot, so its desktop is live. Passwords are random, in `base/secrets.json` (0600);
  SSH takes only the rig's key (`keys/id_ed25519`), never a password.
- **In the image:** OpenSSH Server (Windows' own optional feature; default shell cmd.exe), Git for Windows 2.56.1
  on PATH (Git Bash at `C:\Program Files\Git\bin\bash.exe`), the screen never sleeping or locking, Windows Update
  off (no restarts mid-run; rebuild the image to update), no automatic device encryption. Defender and SmartScreen
  are on, as on a real PC. The computer is `TC-WIN11` (25H2's out-of-box step replaces the answer file's name
  with `PSD-`, a name the Task Scheduler refuses in a user ID, so `tc-setup.ps1` renames it).
- **The machine:** q35 with Secure Boot firmware (OVMF), a software TPM 2.0 (swtpm), an AHCI disk and an e1000e
  NIC (drivers built into Windows), a USB tablet, 1280×800 on the standard VGA, no display window.
- **Ports on 127.0.0.1:** 22220 is the guest's SSH; 9333 forwards to the guest's 9333, but a CDP port does
  not answer there: Chromium's debug port listens on the guest's own loopback, and QEMU's forward lands on
  its other address. Reach CDP through SSH instead (`ssh -L 9334:127.0.0.1:9333` as tcuser, as
  scripts/e2e-updater-win.ts does). Override with `WINVM_SSH_PORT`, `WINVM_CDP_PORT`.
- **The guest cannot reach the box.** Through QEMU's user-mode network, 10.0.2.2 is the box's own loopback,
  where the gateway and dev servers trust their callers, so an outbound firewall rule in the guest
  (`tc-block-host-tcp` and `tc-block-host-udp`, set by the admin, which tcuser cannot change) blocks it. The
  internet and DNS work. A thread that needs one box TCP port from the guest (M41's pairing with a box dev
  instance) narrows the TCP rule for its run, with the numbers filled in:
  `ssh.sh -a --ps "Set-NetFirewallRule -Name tc-block-host-tcp -RemotePort 1-PORT-1,PORT+1-65535"`, and reaches
  the port as `10.0.2.2:PORT`. A fresh `up.sh` starts blocked again.

## Using it from a build thread

```bash
scripts/win-vm/up.sh                      # a fresh overlay on the base image; returns when tcuser's desktop is up
scripts/win-vm/ssh.sh winver              # who answers and on what (add -a for the admin)
scripts/win-vm/ssh.sh 'git --version'     # any command, as tcuser, in cmd.exe
scripts/win-vm/ssh.sh --ps 'Get-ChildItem $env:LOCALAPPDATA'   # PowerShell, sent on stdin (no quoting trouble)
scripts/win-vm/scp.sh dist/TempCode-setup.exe guest:Downloads/  # copy in (guest: is tcuser's home; -a for the admin)
scripts/win-vm/scp.sh guest:AppData/Local/tc-run/x.log /tmp/    # copy out
scripts/win-vm/run-in-session.sh notepad.exe                    # start a program ON the desktop
scripts/win-vm/run-in-session.sh --wait --timeout 300 "%LOCALAPPDATA%\Programs\TempCode\TempCode.exe" --version
scripts/win-vm/shot.sh /tmp/desktop.png   # a screenshot over QMP (default: /srv/agents/win-vm/shots/<time>.png)
scripts/win-vm/down.sh                    # shut Windows down and stop the machine
```

- **Why `run-in-session.sh`:** a program started over SSH runs outside the interactive session (session 0): no
  window opens, UI Automation sees nothing, and a GUI program never returns. `run-in-session.sh` registers a
  scheduled task for tcuser with an Interactive logon (what `schtasks /IT` does) and starts it, so the program
  runs on the logged-on desktop (session 1). It talks to the Task Scheduler through its COM API: the
  ScheduledTasks cmdlets go through WMI, which Windows refuses a standard user over SSH. Without `--wait` it
  returns once the program is running (exit 126 if it ended at once with an error, such as a missing file).
  With `--wait` the task starts the program from a hidden PowerShell with the command line Windows reads back as
  exactly the arguments given (`%VARS%` in the program's path expanded), and the call prints its stdout, then
  its stderr, and exits with its exit code (124 on `--timeout`, 125 when no desktop session took it within
  20 s, 127 when the program is not found). `--cwd DIR` sets the working folder. Tasks are named `tc-run-*`; a
  `--wait` run removes its own, others go an hour after they were made.
- **PowerShell goes on stdin.** `--ps`, `winver` and `run-in-session.sh` send their script as base64 on stdin
  behind a short fixed command line, so a script of any length passes cmd.exe's 8191-character limit. Errors and
  warnings come back as plain lines on stderr. `--ps` exits with the script's own `exit` code, else the last
  native program's failing code, else 1 if an error was written. A plain `ssh.sh CMD` is one cmd.exe line, has
  that limit, and exits with cmd.exe's code.
- **Reading the screen:** `shot.sh` asks QEMU for the frame (`screendump`, PNG), so it works whatever the guest
  is doing. UI Automation inside the guest is M42's service (`native/tc-computer-win/`), started with
  `run-in-session.sh`.
- **A build in, a program run:** `scp.sh` the installer into `guest:Downloads/`, then
  `ssh.sh 'Downloads\temp-code-1.0.N-setup.exe /S'` installs per user with no UAC prompt, in session 0
  (proven by M12: exit 0 after about five minutes with Defender on; give it 20), then `run-in-session.sh`
  starts the app on the desktop and `shot.sh` shows it. Its CDP port is reached over SSH (above);
  docs/agents/windows-build.md has the whole recipe.
- **One machine at a time.** `up.sh` refuses while one runs, and `install`, `up`, `down`, `snapshot` and `fetch`
  hold a lock (`/srv/agents/win-vm/.lock`), so two threads cannot start or stop it at once. Threads take turns:
  `status.sh` says whether it runs and what it was started from. A thread that finds it running and not its own
  leaves it alone. Stop it when done: it holds 16 GB of the agents slice's memory while it runs (`WINVM_MEM=8G`
  is the light option) and runs at the starting thread's nice level.
- **It outlives the call that starts it, on purpose.** QEMU and swtpm start with a clean environment (`daemonEnv`
  in config.ts), so the host's process guard, which kills a call's leftovers by the marks in their environment,
  leaves them alone. `down.sh` is the way to stop it. On a failed `install` or `up` the scripts stop it
  themselves and keep the last screen as `shots/failed.png`; a failed `up.sh --keep` shuts the kept run down
  properly instead, so nothing of it is lost.

## Start, stop, snapshot, reset

- `up.sh` throws the last run away and starts a fresh overlay on the base image (the base never changes).
  `up.sh --keep` resumes the last run as it was left; `up.sh --from NAME` starts a fresh overlay on a snapshot;
  `up.sh --no-wait` returns once QEMU starts.
- `down.sh` shuts Windows down (`shutdown /s /f`, three minutes at most), then stops QEMU; `--force` stops QEMU at
  once, like pulling the plug.
- `snapshot.sh NAME` keeps the stopped run (disk overlay, firmware variables, TPM state) as a starting point;
  `snapshot.sh --list`, `snapshot.sh --rm NAME` (refused while a snapshot or the run is built on it).
- **Reset** is `down.sh` then `up.sh`.
- **After a box restart, or a restart of the `temp-code` service** (box-update restarts it), the machine is gone:
  QEMU runs inside the service's cgroup, since the box has no user systemd manager for `agents`. Start it again
  with `up.sh` (or `up.sh --keep`). The TPM's live state sits under `/tmp/win-vm-tpm-<uid>/` (swtpm's AppArmor
  profile allows only `/tmp` and home folders) and is copied into the run on a clean `down.sh`; after an
  unclean stop, `--keep` resumes with the TPM as of the last clean stop.

## Building and rebuilding the image

`fetch.sh` downloads the ISO from Microsoft (writing its link to `iso/SOURCE` and its sha256 beside it, as
fetched: Microsoft's page publishes no checksum we can read) and Git for Windows (checked against its pinned
sha256) into `iso/` and `payload/`.
`install.sh` (about 15 minutes; run it in the background) makes a blank 128 GB disk, boots the ISO with
`scripts/win-vm/autounattend.xml` and `tc-setup.ps1` on a read-only FAT stick that QEMU builds from a folder, and
Windows installs itself: the answer file wipes the disk, makes the two users and logs the admin on once;
`tc-setup.ps1` installs OpenSSH and Git, sets the keys, the firewall rules, the power and lock settings and the
standard user's automatic logon, renames the computer and restarts (on a failure it powers off a minute later,
and `install.sh` prints the reason it reads over SSH). `install.sh` waits
for tcuser's desktop, shuts the machine down, keeps the TPM state, makes the disk read-only and writes
`base/READY`. Progress screenshots go to `shots/install-latest.png`;
the guest's own log is `C:\tc\setup.log`.

**When the evaluation lapses** (90 days after `base/READY`'s date): `down.sh`, remove every snapshot
(`snapshot.sh --rm`; `install.sh` refuses while any is built on the base), then `install.sh --force`. For
Microsoft's current build, delete `iso/win11-enterprise-eval.iso` first and run `fetch.sh`; if the link in
config.ts (`ISO_URL`) stops answering, take the current Windows 11 Enterprise link from Microsoft's Evaluation
Center. No rearm, no key, no activation workaround. The users' passwords never expire, so the automatic logon
holds for the whole evaluation.

## What the box had to give it (once, as root)

`apt-get install --no-install-recommends qemu-system-x86 qemu-utils ovmf swtpm swtpm-tools` and
`usermod -aG kvm agents`, done 2026-11-19 by a Mac child over SSH (the owner allowed this install). Shells that
started before then lack the `kvm` group; `vm.ts` starts QEMU through `sg kvm` when `/dev/kvm` is not open to it.
The packages also enabled Ubuntu's `qemu-kvm.service` (a boot-time oneshot that loads the module and sets KSM
and hugepages) and made a `swtpm` system user.

## Tests

`scripts/win-vm/rig.test.ts`: the machine's arguments (caps, 127.0.0.1-only forwards, firmware, TPM, install
media), the daemons' clean environment, snapshot names, the answer file's fields and escaping, the passwords,
PowerShell on stdin and the Windows quoting, the in-session task scripts, and the QMP client against a fake
QEMU. The machine itself is proven by hand (`.temp-code/plans/landed/M11.md`).
