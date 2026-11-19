# The host core on Windows

What lets threads, terminals and the harness CLIs run on a Windows host (milestone 13 of the
Work plan): shells, process trees, links, paths. The install, updater, frame and keys are
[windows-build.md](windows-build.md); a Windows host linked to the box is milestone 41's. Every
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
  (`tempcode-jobs-<hash>.exe`), and one helper holds every job. It reads `add <pid>` and
  `end <pid>` on stdin; when the app goes its stdin closes, it exits, and Windows ends every job,
  so nothing outlives a crash either. Without the helper a stop falls back to `taskkill /T /F`.
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

## Proof

Unit tests beside each module, with platform and paths injected, run on Linux; the same files run
in the rig on tcuser's desktop (`run-in-session.sh`), with the POSIX-only fixtures (symlinks, sh
scripts) skipped there. procTree.win32.test.ts runs only on Windows: Job Objects, taskkill /T,
CIM, netstat, Git Bash and a ConPTY PowerShell. The in-app proof (a Claude and a Codex thread
running a turn, a terminal, Stop ending a tree) is in .temp-code/plans/landed/M13.md.
