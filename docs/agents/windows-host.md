# The host core on Windows

What lets threads, terminals and the harness CLIs run on a Windows host (milestone 13 of the
Work plan): shells, process trees, links, paths. The install, updater, frame and keys are
[windows-build.md](windows-build.md); a Windows host linked to the box (milestone 41) is the section of
that name below. Every
Windows branch sits behind a platform check: macOS and Linux run the same calls as before, and
their suites pass unchanged.

## Shells

- **Command strings** (a build, a batch shell step, a dev run, the release scripts) go through
  one `ShellSpec` (`commandShell()` in src/main/server/loginShell.ts): the login shell's `-lc` off
  Windows; on Windows Git Bash's `-lc` when Git for Windows is installed (machine-wide, per user,
  or `CLAUDE_CODE_GIT_BASH_PATH`), else cmd.exe's `/d /s /c` with the line verbatim. Git Bash
  keeps the cwd and passes arguments whole (seen in the rig), so `withToolPath` and `exec git "$@"`
  read the same there; in cmd.exe a line runs as written (`shellLine`). Every spawn is hidden
  (`windowsHide`), or each command would flash a console.
- **PATH.** Windows has no login shell to ask: `loginPath()` is this process's PATH (Windows keeps
  one user environment) plus npm's global prefix, joined with `path.delimiter`. Windows spells the
  key `Path`; `withPath` replaces it rather than adding a second key, which a child would get both
  of. The interactive-shell exports (`-lic printenv`) are skipped: the process already has them.
- **Finding a binary.** `resolveBinary` tries each PATHEXT extension in its order (`claude.exe`,
  `codex.cmd`), and an npm `.cmd` shim resolves to the native program its package carries
  (`npmShimExe`: Codex's `vendor/<triple>/bin/codex.exe`), since Node will not start a `.cmd`
  without a shell. An add-on's stdio server named by a `.cmd` (`npx`) starts through cmd.exe with
  cross-spawn's quoting (`windowsCommand`), and gets Windows' own variables (`SystemRoot`,
  `USERPROFILE`, `APPDATA`, … in `ADDON_BASE_ENV_KEYS`). Probes use `where.exe`
  (`commandPathArgv`).
- **Terminals** run PowerShell 7 when `pwsh.exe` is on the PATH, else Windows PowerShell, under
  ConPTY (`defaultShell` in pty-core.ts). ConPTY has no tty, so a Windows tab is named by its shell.

## Process trees and Job Objects

src/main/server/procTree.ts. Off Windows a child the host stops with its tree leads a process
group (`detached: true`) and a stop signals the group, as the call sites always did. Windows has
no groups (a negative pid throws, `detached` opens a console) and a child outlives its parent, so:

- `treeSpawnOptions()` is `{ detached: false, windowsHide: true }` there, and `adoptTree(child)`
  puts the child in a **Job Object** of its own with KILL_ON_JOB_CLOSE: what it starts joins the
  job, and the job is ended when the child exits or is stopped. Every harness CLI (Claude through
  claudeWarm.ts, Codex's app-server, the ported harnesses), build, batch step, dev run, release
  run and add-on server is adopted.
- Job Objects have no Node API. The helper is a few lines of C# (`JOB_HELPER_CS`) compiled once
  with the `csc.exe` of .NET Framework 4, which every Windows 10 and 11 carries, into the temp dir
  (`tempcode-jobs-<hash>.exe`), and one helper holds every job. It reads `add <pid>` (answers
  `ok <pid>`; `JobHost.has` is true only then) and `end <pid>` on stdin; when the app goes its
  stdin closes, it exits, and Windows ends every job, so nothing outlives a crash either. It starts
  when procTree.ts is first imported (`warmJobHost`), so the first harness does not wait for csc or
  for Defender's first scan of the new exe; a pid that exited before the helper took it is skipped.
  A failed spawn or a lost compile race is tried again; a lost helper is logged with the number of
  trees it took. Without the helper a stop falls back to `taskkill /T /F`.
- **Git Bash's children leave the job.** msys starts its processes outside any job (seen in the
  rig: a build's `sleep &` and a plain `node` both outlived the job), but they keep the console of
  the root, and every child the app starts gets a hidden console of its own. So `end` first ends
  every process attached to the root's console (`AttachConsole`, `GetConsoleProcessList`), then the
  job. That needs the root alive: a stop does it; a root that already exited leaves only the job.
  Never `JOB_OBJECT_LIMIT_BREAKAWAY_OK`: msys asks to break away whenever a job allows it.
- `killTree(pid)` ends the pid's job and runs `taskkill /PID <pid> /T /F` (Windows has no gentle
  signal for a console program). Off Windows it is `process.kill(-pid, signal)`.
- Why a job and not taskkill alone: Node (libuv) already puts its own plain children in a
  kill-on-close job, but a harness's tools are not all started that way (a shell's background
  child, a detached server), and taskkill /T walks parent ids, which break when a parent is gone.
  procTree.win32.test.ts shows a detached grandchild outliving its parent without a job and dying
  with ours.
- **The process guard** (processGuard.ts) scans nothing on Windows: it judges by marks in a
  process's environment, which Windows does not let one read cheaply. The jobs stand in for its
  call and orphan rules; its memory cap does not run there.
- **Readers.** The process table is CIM's (`scanWinProcesses`: one PowerShell, about half a
  second) and the listeners netstat's (`winListeners`); dev-server ports (threadPorts.ts) and
  admission's working-set samples read them. CIM refuses a standard user over SSH: in the rig run
  anything that reads it on the desktop (`run-in-session.sh`). The port sweep attributes nothing
  it cannot read on Windows (no cwd, environment or open files of another process), and a port
  row's log falls back to the call's named file or its output.
- `stopChildTree` in update.ts stays: the installer must not meet any process running out of the
  install folder, whoever started it.

## Links and config dirs

A standard Windows user may make a junction but no symlink, file or directory (skills/links.ts):

- Directory links are junctions (`linkDir`, `linkEntry`), read back through `readDirLink` or
  `linkTargetOf` (a junction reads back absolute, sometimes with `\\?\` before it and a separator
  after). A skills view swaps by junction and survives a gc pass (links.test.ts, in the rig).
- A **file** "link" is a copy kept in step both ways (`syncCopy`): copied in from the person's
  file; when the copy changed since the last pass (the CLI rewrote it, by rename) it is copied
  back, unless the person's changed later still; a person's file that is gone takes the copy with
  it once it was in step. `.tc-copies.json` beside the copies keeps each one's last in-step stamp.
  Never a hard link: the CLIs replace `settings.json`, `.credentials.json`, `.claude.json` and
  `auth.json` by rename, which parts a hard link from the person's file.
- Claude's owned roots (claudeRoots.ts, `copies`) and Muse's config dirs (museConfigDirs.ts) are
  built that way: the person's directories (`projects/`, `commands/`) by junction, their files by
  copy, the store's skills by junction. A pass runs at every spawn, so what one thread's CLI
  wrote reaches the person's file at the next start.
- Skill generations are copied, not hard-linked (materialize.ts): a file on Windows cannot be
  removed while any of its names is open. A skill folder written on Windows keeps the replaced
  row's exec bits (`keepExecBits`), as Windows reads none. Hot tmp-then-rename writes retry while
  Windows holds the file (`renameRetry`).

## Paths and the rest

- The path fence (remote/fence.ts) on a Windows host takes only a drive path, a relative one or
  `~`: it refuses UNC shares and device paths, alternate data streams, drive-relative `C:foo`, and
  a root with no drive (the box's `/srv/…`), and compares case-blind (`plainWindowsPath`).
- The boot log is the temp dir's `temp-code-boot.log`; the gateway's TLS pair is made with Git for
  Windows' openssl (`opensslPath`, `OPENSSL_CONF` pointed at the CA's config); the gate finds
  `bun.exe` and `node.exe`; Codex starts without `nice`; the profiles folder is as broad as
  `/Users` to the indexer; the postinstall `chmod` is skipped.

## A Windows host linked to the box

Milestone 41. A Windows PC links to the box the way the Mac does: it saves the box as an
environment, dials out (no inbound port), and registers on the box's peer link (`peer.register`)
with its home and `build.platform: 'win32'`. Nothing new crosses the wire: the Mac bridge
(remote/mac*.ts) is the desktop bridge, keyed by the host's environment id as it always was
(`macBridge.thread.<sessionId>` names the host), and the code that answers runs on whichever
desktop it is, with that platform's rules. The tool names stay `mac_*`.

- **What a thread is told.** `peer.register`'s home may be a drive path (`MacHomeSchema`); a
  drive-path home makes the tool text say "This host is a Windows PC, not a Mac", that paths are
  drive paths, what `~\Desktop` is, and that commands run in Git Bash (`macToolDescriptions`, and
  its copy in scripts/app-mcp-bridge.mjs).
- **Paths** (`hostPath` in remote/macBridgeRules.ts, used by reads, lists, fetches, writes, runs
  and jobs): `~`, `~/…` and `~\…` under home, else a drive path with either slash. A share or
  device path, a stream name, a drive-relative `C:foo` and a root with no drive (the box's `/srv/…`)
  are refused, as the fence refuses them (`plainWindowsPath`). Home and "above home" compare
  case-blind, and any drive's root counts as above home (`coversHome`), so it is never offered as a
  folder to remember or share. Full access still asks for Windows' credential stores
  (`AppData\Roaming\Microsoft\Credentials`, `Protect`, `Vault`) and the app's own data
  (`AppData\Local\TempCode`).
- **Commands and jobs** (macRunner.ts `shellCall`, macJobs.ts): through Git Bash's `-lc` like the
  Mac's login shell (`exec "$@"` for argv), else cmd.exe (argv with cross-spawn's quoting, a line as
  written). The environment keeps Windows' own variables (`SystemRoot`, `USERPROFILE`, `APPDATA`,
  `PATHEXT`, …) and the user's `Path`, and none of the app's. The child is adopted into a Job
  Object (procTree.ts `adoptTree`) and every stop goes through `killTree`: the job, Git Bash's
  console sweep and `taskkill /T /F`. Windows has no gentle signal: TERM and KILL both end the
  tree; INT to a terminal job is its ^C.
- **The always-ask floor** (`alwaysAsks`): on a Windows host `WINDOWS_ALWAYS_ASK` joins the Mac's
  list: `runas`, `reg`, `regedit`, `schtasks`, `sc`, `certutil`, `cmdkey`, `netsh`, `icacls`,
  `takeown`, `bcdedit`, `vssadmin`, `diskpart`, `format`, `wmic`; PowerShell's own ways to the same
  places (`Set-ExecutionPolicy`, `Set-`/`New-`/`Remove-ItemProperty`, `Register-ScheduledTask`,
  `New-`/`Set-Service`, `Set-Acl`, `Add-`/`Set-MpPreference`, `Invoke-Expression`/`iex`, and any
  `HKCU:`, `HKLM:` or `registry::` path); and the hosts that run script text a card cannot show
  (`mshta`, `rundll32`, `regsvr32`, `wscript`, `cscript`, `vaultcmd`). Names are read by any
  spelling (`C:\Windows\System32\schtasks.exe`, `CertUtil`), with cmd's `^` and PowerShell's
  backtick dropped, and the line handed to a shell (`cmd /c "…"`, `powershell -Command "…"`) is read
  once more. Also asking every time: PowerShell with an encoded command or an execution policy (any
  dash it takes, `-Flag:value` too); a command built from variables (`set p=re & call %p%g`); a
  recursive delete (`rm -r`, `rd /s` and `/S/Q`, `del /s`, `Remove-Item -Recurse` and `ri -r`) of a
  drive (`C:\`, Git Bash's `/c`), a top folder or the profile (`~`, `$USERPROFILE`, `%USERPROFILE%`,
  …); Windows' credential stores (`WINDOWS_CREDENTIAL_PATHS`) and the Mac's credential names, with
  either slash in any case; and an 8.3 short path name (`MICROS~1`), which the name lists would not
  know. A remembered program is named without `.exe`, case-blind, and Windows' shells and launchers
  (`cmd`, `powershell`, `start`, `wsl`, `wt`, …) are never one. The floor stops mistakes, not an
  adversary: a script file the card names runs whatever it holds, on the Mac as here. None of the
  Windows lists reaches a Mac: its floor, deny lists and program rules are as before (the tests hold
  that).
- **Spellings Windows reads as another name.** A path given to the bridge with an 8.3 short name
  (`APPDAT~1`) or a segment ending in a dot or a space is refused (`hostPath`), since Windows opens it
  as the long name the deny lists know. Full access on Windows asks for `WINDOWS_FULL_DENY_DIRS` in
  place of the Mac's `~/Library` entries; a write under `~\AppData` always asks.
- **Terminal jobs** (node-pty, the default for a job) are adopted into a Job Object too, ended when
  their shell exits.
- **Not ported, and why it is harmless:** the load watch reads `os.loadavg()`, which is always 0 on
  Windows, so only the caps hold calls there; dev-server forwarding and computer use through the
  bridge are off by default per host, and computer use on Windows is milestones 42 and 43.
- **What the person sees there.** The window calls its own host This PC, and a card reads "box wants
  to run on this PC" (`thisDesktopName` in renderer/lib/native.ts); the cards, prompts and settings
  are the Mac bridge's own.
- **What it is not.** A Windows host never offers to publish (`macPublishOffers`) and refuses
  `host.deployStatus` and `host.deploy` (`DEPLOY_NOT_ON_WINDOWS`), so its Deploy row never shows;
  its drift mark's kind is `pc` (shared/deployDrift.ts), which updates from the feed once the Mac
  publishes with `--win`. Its glyph is the desktop (`hostKind` 'pc', M12).
- **Sync.** Harness sync sends nothing from a Windows host unless told to
  (`harnessSyncDefault`); memory sync never runs there, and the box refuses a drive-path home
  (`MEMORY_NO_WINDOWS`): its path map is POSIX only. Moving a thread between a Windows host and the
  box maps no paths (sessionMove.ts and crossHostThreads.ts read POSIX roots), so a moved thread
  keeps its old paths in its text.
- **The harness CLIs.** Claude, Codex and Muse resolve with PATHEXT and npm shims as M13 built it.
  Every harness child gets `CLAUDE_CODE_GIT_BASH_PATH` when Git for Windows' bash.exe is found,
  per-user installs included (`withGitBash`, drivers/binaries.ts). `CODEX_CA_CERTIFICATE` alone is
  enough for Codex to trust the gateway's https port (M13's Codex turn ran on it; nothing is added
  to the user's certificate store). Muse ships a Windows exe in its release manifest
  (`x86_windows`), but its launcher refuses Windows: Muse is offered on a Windows host only when
  `muse.exe` is on the PATH or in `~\.local\bin`, and was not tried.
- **Accounts.** aliax-core's process probes (`procs.ts`: `ps`, `pgrep`, `lsof`) find nothing on
  Windows, so an account switch there does not find or restart the person's own terminal CLIs. The
  app's threads go through the gateway and are not affected.

## Proof

Unit tests beside each module, with platform and paths injected, run on Linux; the same files run
in the rig on tcuser's desktop (`run-in-session.sh`; CIM and taskkill refuse a standard user over
SSH), with the POSIX-only fixtures (symlinks, sh scripts) skipped there: 116 pass on Windows.
procTree.win32.test.ts runs only on Windows: a detached grandchild outliving its parent with no
job and dying with ours, Git Bash's background and foreground children ended with the job, taskkill
/T, CIM, netstat, Git Bash's cwd and PATH, and a ConPTY PowerShell.

In the app (a TempCodeE2E test build installed as the standard user, driven over its own socket and
CDP from the guest, 2026-11-19): a Codex thread ran a shell tool (PowerShell) and answered, through
the gateway's HTTPS port with the CA made by Git's openssl; a build ran in Git Bash in the project
folder and Cancel left no process and read `cancelled`; Stop on a Codex turn whose command had
started a detached grandchild left neither; killing the app-server alone took its command's tree
with it (the job); a terminal ran PowerShell under ConPTY in the project folder, and its kill left
no shell. A Claude thread's CLI started under the owned root (junctions and copies) and reached
Anthropic, which answered with the account's weekly limit: a full Claude turn is not proven.
Shots and the account in .temp-code/plans/landed/M13.md.

Two things a proof on a fresh profile needs: the Codex account captured into the app's account
store (Accounts, or `window.aliax.capture('codex')`; the gateway refuses an account it has not
saved), and a desktop session for anything that reads CIM.
