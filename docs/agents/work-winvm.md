# The Windows VM: the keeper of the box's standing machine

The box keeps one Windows 11 machine for Work threads to drive: the `standing` instance of the Windows rig
(docs/agents/windows-vm.md), on the same read-only base image as the rig, with its own lasting disk. The plan is
`.temp-code/plan-m1X24rQ6nikm.md`, Track B. This file covers the keeper (B3): its states, its methods, setup,
sleep and wake, and the stop of the box's service; its restore points (B4); the service on the box with the
`windows_*` tools (B5); and its picture (B7, below and in live-video.md "The Windows VM"). The hold's rules for a
command line are B6's (work-outbox.md); his Take over (B8) is below.

The code is `src/main/server/work/winvm/`: `keeper.ts` (the states, over a machine and a guest that are
interfaces), `standing.ts` (the real machine, through `machine/`), `sshGuest.ts` (the real guest, over SSH),
`setup.ts` (the guest's admin script), `watcher.ts` (the stop watcher), `points.ts` (restore points),
`index.ts` (the Work module `winvm`), `window.ts` (QEMU's window and its display), `picture.ts` and `host.ts` (the VM's
row, its video and its 4 fps picture on the box's host).
The wire is `src/shared/contract-work-winvm.ts`.

## States

| State | What is true |
|---|---|
| `none` | no standing disk, or this host cannot have one (`cannot` says why: not the box, no base image) |
| `setting-up` | setup runs; `step` names the part ("Making the disk", "Setting Windows up", "Restarting Windows", …) |
| `asleep` | QEMU is not running: the guest is hibernated, or shut down |
| `waking` | QEMU starts or resumes, the service is checked and the door knocked; `step` is "Waking the Windows VM" |
| `awake` | QEMU runs and the keeper holds the SSH forward to the door |
| `going-to-sleep` | Windows was asked to hibernate; the keeper waits for QEMU to exit |

One change runs at a time, in the order asked: a wake asked while the machine goes to sleep waits for the
sleep, then wakes it; two wakes at once start it once. A failure leaves the state that is true (`awake` if
QEMU still runs, else `asleep` or `none`) with `error` in words. After a box restart the machine is `asleep`
until its next use. A keeper that starts beside a running QEMU (Work turned off and on) takes it as `awake`
and opens the door at the next call.

## Methods and the push

| Method | Capability | |
|---|---|---|
| `work.winvm.state` | read | the state |
| `work.winvm.wake` | operate | wakes it and answers once it is awake (about 13 s from hibernate, 20 to 26 s cold) |
| `work.winvm.sleep` | operate | hibernates it and answers once QEMU has exited |
| `work.winvm.setup` | admin | answers at once; the progress and the end come as pushes |
| `work.winvm.settings` | admin | `{ sleepAfter, screen }`: `15m`, `30m` (the default), `2h` or `never`, in the host setting `work.winvm.sleepAfter`; the guest's screen, `1280x800` (the default) or `1920x1200`, in `work.winvm.screen`, taken at the next wake (live-video.md "The Windows VM" has the numbers that offer it) |
| `work.winvm.points` | read | `{ points }`, newest first |
| `work.winvm.point.save` | operate | `{ name? }`: a point of the sleeping machine |
| `work.winvm.point.restore` | admin | `{ id }`: back to a point; the machine stays asleep |
| `work.winvm.point.delete` | admin | `{ id }` |

A model caller (a thread's `app.work*` call) may read and wake, never set up, sleep, change the settings or
touch a restore point. Every change of state pushes `{ push: 'work.winvm', state }` to every client socket,
and every change to the points `{ push: 'work.winvm.points', points }`. The methods answer
`Work is off on this host` while the switch is off, as every pillar's do.

`winvmKeeper()` is the keeper for the VM's service on the box (B5): `door()` wakes the machine and answers
the forward's unix socket and the token; `touch()` marks a call; `setViewers(n)` and `setDriving(on)` hold it
awake while anyone watches or he drives. `WAKING_WORDS` is what a waking call says.

## Setup

One press later (B10, Settings → Work); `work.winvm.setup` now. It needs the base image the rig has
(`install.sh`). In order:

1. The disk: an overlay on the base image under `/srv/agents/win-vm/standing/run/`, with its own firmware
   variables and run id. A machine that has a disk keeps it; setup then only runs the steps again.
2. Windows starts and the keeper waits for tcuser's desktop.
3. One admin script over SSH (`setupScript`), each step safe to run again:
   - the service's folder `C:\Program Files\TempCode\` (tcuser can run it, not replace it), and the door's
     token in `C:\ProgramData\TempCode\token` (admins write it, tcuser only reads it). The box keeps the
     token in `<userData>/winvm/token` (0600), made at the first setup;
   - the logon task `\TempCode\door`: at each logon of tcuser, on its desktop (an interactive token),
     `tc-computer.exe serve --listen 127.0.0.1:47800 --token-file C:\ProgramData\TempCode\token`;
   - hibernate on (full), never by Windows itself, no sign-in asked on resume (`CONSOLELOCK 0` and the
     policy);
   - Windows Update on (the rig's image turns it off);
   - tcuser's own policies: `DisableCMD=1`, `NoRun=1`, `DisallowRun=1` with the list in `DISALLOWED` (the
     consoles, the script hosts, regedit, rundll32, msiexec, schtasks, mmc, certutil, msbuild and the
     rest), and Windows Terminal as the default terminal (`Console\%%Startup`), so a console is always
     hosted by `WindowsTerminal.exe`;
   - no program runs from tcuser's Downloads, Documents, Desktop or `AppData\Local\Temp`: an NTFS deny of
     execute for tcuser, inherited by everything under them, with tcuser's rights there cut from Full Control
     to Modify and the folders owned by Administrators, so tcuser cannot lift it from the folder. A script
     or an installer there is read by its interpreter, not run: cmd is off (DisableCMD) and the others are in
     `DISALLOWED`. Windows' own policies were tried first on this image (Enterprise Evaluation 25H2): Software
     Restriction Policies are not enforced, and an AppLocker policy that `Test-AppLockerPolicy` reads as
     Denied leaves its EXE cache empty and the program runs.
   The script notes each step it reaches in `C:\Windows\Temp\tc-setup.log`. On a fresh guest it has now
   and then hung before its first step while Windows was busy after its first logon (two of six fresh setups
   on 2026-11-20, nothing done in the guest), so the keeper gives it 4 minutes and runs it once more; a last
   failure names the step it reached.
4. The box's service copied in (below), then a restart, since tcuser's policies are read at logon.
5. The door knocked: the service runs under the new policies. The state is then `awake`.

**These policies are the first line; the host's hold rules (B6) are the second.** A thread acts in the
guest as tcuser: no cmd, no Run box, none of the consoles, script hosts or admin tools from Explorer, Start
or a double-click, and no program it saved in those four folders. What the first line does not stop: tcuser
owns each file it makes, and an owner may turn off a file's inherited entries from its Security tab and then
run it (an inheritable OWNER RIGHTS limit is not inherited onto files here); a program saved anywhere else in
tcuser's profile runs; and Explorer's address bar still starts a program `DISALLOWED` does not name. The
owner in a Take over has the same limits as tcuser; he can lift them as the admin. After setup tcuser's own
SSH runs nothing (sshd's shell is cmd.exe), so every command of the keeper and of `ssh.sh --instance
standing` goes as the admin (`-a`), and a program on tcuser's desktop is started by the admin through a task
of tcuser's (`SshGuest.onDesktop`).

## Wake

At a thread's first call (B5) or his Wake press. The call waits with "Waking the Windows VM".

1. QEMU and swtpm start (`StandingMachine.start`), resuming the hibernated guest, through the rig's own code
   (`machine/`): the clean environment `daemonEnv` gives and `sg kvm`, so the process guard's orphan sweep
   leaves them alone. Both start with the stop signals blocked (below) and the watcher beside them. A TPM
   state newer than the machine's lasting copy (a crash, the guest's own stop) is kept, never rolled back.
2. The keeper waits for SSH and tcuser's desktop.
3. The service: the sha256 of the guest's `tc-computer.exe` against the box's own build (`tcComputerExe`,
   serviceBin.ts, which finds the build's `resources/native` under the app's root, the folder holding
   package.json (`appRoot`, server/appRoot.ts): the code lands in a lazy chunk, out/main/chunks, where two up
   from `__dirname` is out/; 1.0.356 said "no tc-computer.exe" for that reason, and
   scripts/e2e-winvm-work.ts now builds the exe into the tree's resources/native and goes through this lookup
   rather than naming the file in TEMP_CODE_WINVM_EXE). When they differ, the box's copy goes in over SCP as the admin, the running door is
   stopped and the file replaced by a copy (a moved file would keep the admin profile's rights, which
   tcuser may not run); the new one's `version` goes to the log. So the guest's service updates
   with the box. Then the logon task is run unless the door already runs.
4. One SSH connection as the admin holds the forward (and is the master the picture copies run over): a unix socket beside the machine's run files
   (`run/door.sock`, mode 0600) to the guest's 127.0.0.1:47800. The keeper knocks with the token and sends
   one request (an unknown method, which the service answers with an error before `initialize` too): only
   the answer counts, since the forward accepts a connection whether or not anything listens behind it.

A box build with no `tc-computer.exe` wakes the machine and says so in `error`.

## The picture

Where the `qemu-window` tool (scripts/work-tools/winvm.json) and `screen-relay` are both installed, a wake starts a
private X display of the VM's own at the guest's 1280×800 first (`VmScreen`, window.ts: the box browser's
`BoxXDisplay` given a size), and QEMU draws the guest's screen in its GTK window there. QEMU's window dies with its X
server, so the server starts with the stop signals blocked as QEMU does, and ends with SIGKILL: when QEMU has exited
(the keeper's sleep, `stopped` and `keepTpm`), and after a service stop by the watcher, which ends the server it was
started beside once QEMU has gone. A host started beside a running machine takes the display back from
`<userData>/winvm/picture/display/kept.json`. Before each start QEMU is asked whether it loads the modules (a module of
another QEMU build is refused); a tool missing, a refusal, a display that will not start, or QEMU failing with its
window all start the machine with no window, and `pictureOnly` on its row takes Take over away. The rest, the engines
and the numbers, is live-video.md "The Windows VM".

## Take over

`computer.drive { computer: 'vm:windows', driver }` reaches the `vm` hook (`vmWheel`, drive.ts), registered at the
host's wiring (host.ts `wireVmDrive`). It is refused while the machine is not awake ("Wake it first"), has no window,
or Work is off. Take over: the lease is his (`ownerDrives`: every thread's call refused, the turned-away threads
noted), the keeper holds the machine awake (`setDriving`), his streams take his input, then every thread's session
on the VM is stopped. Hand back: his keys let go, the guest's clipboard put back (B9), the keeper and the lease
freed, and the threads turned away woken with `VM_FREE_NOTICE`. The machine going to sleep under him hands back by
itself. The keys and the menu are live-video.md "Driving".

## Sleep

Sleep is hibernate (`shutdown /h` as the admin): QEMU exits once Windows has written its image, about 5 s;
the keeper then keeps the TPM's state. Apps and sign-ins are there at the next wake, and the guest's clock is
right after it. It happens:

- after the sleep-after setting with no thread's call, no viewer and him not driving (checked every minute);
- on `work.winvm.sleep`;
- at a stop of the box's service, by the watcher.

A machine that stopped by itself (he shut Windows down in a Take over) is noticed within a minute and reads
`asleep`.

## The stop

The service's unit has systemd's default `KillMode=control-group`: a stop sends SIGTERM to every process of
the cgroup at once, and on the box the main process can die at that moment (the D-Bus abort under
`dbus-run-session`). QEMU would die with it, the guest's power cut. So:

- QEMU and swtpm start with SIGTERM, SIGINT and SIGHUP blocked (`stopBlocked` in machine/daemons.ts: Perl's
  `sigprocmask`, then exec). A blocked signal stays blocked across exec, the daemons only install handlers,
  and every thread QEMU makes starts with all signals blocked. `sg` clears the mask, so the block sits inside
  it. The stop leaves both running.
- A watcher (`watcher.sh`, written beside the run files and started detached with the clean environment)
  takes the signal instead. It asks Windows to hibernate over a fresh SSH connection as the admin, waits up
  to 25 s for QEMU to exit, then copies the TPM's live state into the machine's lasting copy (`run/tpm`;
  the live state is under /tmp, which a reboot clears). systemd's SIGKILL comes at 30 s
  (`TimeoutStopSec=30`). The watcher exits by itself when QEMU exits for any other reason.
- A crash of the box, or a kill of QEMU itself, still cuts the power. Windows recovers; unsaved work in open
  apps does not.

The proof is `scripts/e2e-winvm-stop.ts` on the RIG instance (never the box's service): it signals a test
group (QEMU, swtpm, the watcher and a stand-in for the main process) with SIGTERM at once and SIGKILLs what
is left 30 s later, as systemd does; QEMU must exit before that, and the guest must come back with the same
Notepad process, its text and the same boot time. `scripts/e2e-winvm-keeper.ts` on the standing instance
runs setup, the policies' checks, sleep and wake.

## The service on the box

`wireVm` (vm.ts), wired by index.ts on a Linux host, is a third `ComputerService` on the box beside its own and
the box browser's (docs/computer-protocol.md §28.7). Its spawn is the door through the keeper's forward
(door.ts): it waits for `keeper.door()`, which wakes the machine, knocks with the token, and copies every
picture the guest's service names home over SFTP on the forward's own SSH connection. That connection is the
admin's: sshd starts the SFTP subsystem through cmd.exe, which tcuser's DisableCMD refuses, and the refusal's
words then break the SFTP stream ("Received message too long"). The door lets one host in at a time and frees
its place only once the last host's service has ended, so a spawn that hears "another host is connected" (the
keeper's own knock still ending) asks again for up to 10 s. Its `ComputerSessions` run with `vm: true` and `VM_TIER_GATE`, so a chord, a held key
and a paste run in the guest, the launch list is the VM's, a console's launch is refused, and the words are a
Windows PC's. Every act goes through run.ts with the hold as on any computer: a send or submit there is a held
`computer.act` with its picture in the Outbox. The machine going to sleep ends the service's connection (a clean
exit), and the next call wakes it again.

### The tools

`windows_apps`, `windows_observe`, `windows_act`, `windows_batch` and `windows_result`: the computer tools in
Windows' words (`computerToolSpecs` with `platform: 'windows'`), renamed, mounted as the `winvm` pillar's Work
tools (tools.ts), and run on the VM's sessions. Their head says what the machine is: a Windows 11 PC on this
host, his own, signed in as he left it; one thread uses it at a time; a send or submit is held for his press,
so drive up to it and stop; never type a password, say he must take over; no command line. What they answer
names `windows_*` where the shared words say `computer_*`.

- **Who gets them**: a Work thread of a workspace whose Work settings turn on `windowsVm` ("Computer use on
  the Windows VM", off by default; its switch is B10's), on the host whose VM is set up. A Work Chat never.
  The setting is read when the tools are listed and again at every call (`vmOffered`), so turning it off
  stops a running thread with "refused: computer use on the Windows VM is off for this workspace".
- **Waking**: a call on a sleeping machine wakes it first; while it wakes, its row's hold reads "Waking the
  Windows VM". A call held 20 s (a wake, a card) answers with an id, as a bridged computer call does
  (pending.ts), and `windows_result` reads it again or cancels it; nothing runs unread.
- **The preamble** gains one line where the tools are offered (`VM_PREAMBLE`).

### Files

`windows_put` copies a file of the thread's workspace into tcuser's Documents, Downloads or Desktop;
`windows_get` copies one from there into the workspace (files.ts). Both take the machine for the thread as
the computer tools do (the setting read again, the lease, the wake) and go over the keeper's own SSH connection
(SFTP, as the admin).

- **Fenced on the box**: the file, or the folder a get lands in, is the workspace's own: its real path
  inside the workspace's real folder (no `..`, no link out), and the host's fence (`ctx.reaches`) as for any
  file a thread names. A Work Chat has no workspace folder and is refused.
- **Fenced in the guest**: only those three folders of tcuser's; a plain file name (no `\` or `/`, no `..`,
  no `:` and so no stream, no `~` and so no short name, no device name such as `CON`, no trailing dot or
  space); and neither the folder nor the file a link elsewhere (a reparse point is refused), since the copy
  runs as the admin, who could read or write where tcuser cannot. A taken name gets "(1)", never an
  overwrite. Between the check and the copy is a short gap a racing change in the guest could use.
- **200 MB** at most either way.
- **A put refuses a file Windows runs**: policy.ts `VM_RUNNABLE` (programs, scripts, shortcuts, registry and
  setup files, `.dll`), by the workspace file's name and the name asked for. The guest's NTFS deny of execute
  in those folders is the first line.
- **A put is a Result** (`ctx.results.add`, kind `windows.put`) whose undo is `windows_put_undo { put }`: it
  removes the file it put (kept in `work_winvm_puts` with its sha256), only while it is as it was put, and only
  for the thread that put it; a changed file is left with a refusal, a file already gone is no failure. The undo
  runs as a tool of the pillar, so it is there while the workspace's setting is on and the VM is set up.

### The clipboard

His paste into the VM, his copy out of it, and the clipboard kept across his Take over, through the VM's own
service (`clipboard.read`, `clipboard.write`, docs/computer-protocol.md §29.8), text only, 1 MB at most
(clipboard.ts, `VmClipboard` on the VM's host). vm.ts exports the four calls the picture and Take over wire
up; each wakes the machine first:

- `vmPaste(text)`: his text on the guest's clipboard, then Ctrl+V to the app in front, at the session tier, on
  a service session of his own (`owner:vm`), never a thread's. For B7's `VideoSource.paste` of `vm:windows`.
- `vmCopied()`: the guest's clipboard text (cut at 1 MB, `truncated`) for the viewer to hand to his own.
- `saveClipboard()` at his Take over and `restoreClipboard()` at Hand back (B8): the guest's clipboard comes
  back as it was, so nothing he copied is left for an agent. A clipboard that held no text, or more than 1 MB,
  comes back empty; a Hand back with nothing saved empties it. Only text is kept: an image or files on the
  clipboard at Take over do not come back.

### One thread at a time

A thread holds the VM from its first `windows_*` call until two minutes after its turn ends (`VmLease`,
lease.ts); its subagents use it as it does. Another thread's call is answered "The Windows VM is in use by
'<title>'", and that thread is woken with a notice (`ctx.threads.resume`) once the machine is free. A holder
whose turn starts again inside the two minutes keeps it; a holder deleted frees it at once.
`lease.ownerDrives(on)` is the hook for his Take over (B8): while on, every thread's call is refused, and
handing back frees the machine.

## Restore points

A point is the standing disk's internal qcow2 snapshot (`qemu-img snapshot -c tc-point-<id>`: copy on write
inside the one file, so it costs only what changes after it), with the firmware variables and the TPM's state
copied beside it into `/srv/agents/win-vm/standing/points/<id>/` with its record (`point.json`: id, name,
time, `owner` or `keeper`). All three go back together: a disk without the TPM it was sealed with breaks
TPM-bound sign-ins, and a hibernated guest's memory image is on the disk.

- **Only while it sleeps.** Save, go back and delete each refuse while QEMU runs ("Put it to sleep first").
  A TPM state newer than the run's copy is kept before a point is taken or put back.
- **Three at most.** A fourth point drops the oldest first.
- **Going back** puts the disk, the firmware and the TPM as the point holds them; the state stays `asleep`
  and the next wake resumes the guest as it was at the point. What changed after the point is gone: the
  confirm that names this is the screen's (B10).
- **The keeper's own.** Setup on a machine that has a disk hibernates it if it is awake and keeps a point
  named "Before setup" (`by: 'keeper'`) before it changes anything in the guest. A first setup has nothing
  to keep.
- A new disk (`makeDisk`) drops the old points with it. The points are local to the box and not in its
  backups.

## Memory and the box

The standing machine has 6 cores and 8 GB (`WINVM_CPUS`, `WINVM_MEM`); QEMU holds the memory it is given
while it runs. QEMU starts from the server, so it runs in temp-code.service's cgroup and its memory is
charged to the box's service, inside `agents.slice`. Asleep, it holds none. With the rig up as well, the two
take 24 GB.

## What the owner does

In order, once the box runs a build with all of Track B:

1. **Re-apply stage 85 on the box once** (`scripts/box/apply.sh --from 85 --through 85` from the Mac). Not
   for the stop: the keeper's watcher hibernates the VM at a stop of the service by itself, proven on the rig
   (`e2e-winvm-stop.ts`), and the unit needs no `ExecStop`. It is for deploys: `box-update master` then builds
   `tc-computer.exe` into the build's `resources/native` (docs/box.md, "What box-update does with it"), and
   the keeper copies that service into the guest at each wake. A `box-update v1.0.N` release asset carries
   none, so deploy the box from master for the VM; with no service, setup and wake say the build has no
   `tc-computer.exe`.
2. **Set it up**: Settings → Work → Windows VM → Set up. About ten minutes: the disk from the base image,
   Windows' admin steps, one restart. The row says each step; it ends Awake.
3. **Turn it on per workspace**: a Work workspace's page → "Computer use on the Windows VM". Off by default;
   only those workspaces' threads get the `windows_*` tools.
4. **Choose its sleep and screen** if the defaults do not suit: Sleeps after (30 minutes) and Screen size
   (1280 × 800; 1920 × 1200 from the next wake).
5. **Sign in to what threads should use**, in a Take over from the Computers page: the VM keeps it across
   sleeps. A thread never types a password.
6. **Before the evaluation ends** (about 17 February 2027, Settings' Edition row; Connections warns 14 days
   ahead): buy and enter a real Windows key in a Take over, or rebuild the image (`install.sh --force` after
   the standing disk is gone; what is signed in is lost).
7. **Office, when he wants it** (B11): install Microsoft 365 Apps and classic Outlook in a Take over, sign in,
   and say so; until then Settings' Office row says "Not installed".

## The whole job, proven

`scripts/e2e-winvm-work.ts` (run from the repo root after `electron-vite build`, under
`flock -o -n /srv/agents/win-vm/standing/.lock`; it refuses a standing machine that runs or has a disk) runs
the job on an isolated windowed instance of the built tree under xvfb, with its own /tmp root, HOME, userData
and ports, the box's tools linked read-only and the box's Claude login copied into its own config. It builds
`tc-computer.exe` from the tree unless `TEMP_CODE_WINVM_EXE` names one (a build from before the door's
`serve --listen` exits 64 in the guest and setup ends "The service in the Windows VM did not answer"). It sets
the standing VM up through `work.winvm.setup`, turns Work and a workspace's "Computer use on the Windows VM"
on, narrows the guest's `tc-block-host-tcp` to one port where it serves a form, and starts ONE Work thread on
Claude Opus 5.5 at low effort: type a line in Notepad and save it with Ctrl+S, then fill and submit the form
in Edge. At the end the rule is put back, the instance killed and its root removed, and the standing folder
deleted, so his Set up starts clean.

Run 2026-11-20 (pictures and numbers in `.temp-code/plans/landed/computers-vm/b10/`, `results.md`):

| Check | Result |
|---|---|
| setup, from no disk to Awake | 81 s (45 to 81 s across seven runs) |
| the thread's turn | 38 s, 30 tool calls, $0.72; the one model process of the run |
| the submit | held as a `computer.act` with its picture 33 s in; nothing posted before the press; Send posted it once, 0.4 s after, with what the thread filled |
| a viewer of `vm:windows` through the relay | 328 frames in 56 s, every one acked; 43 in the busiest second; none while still |
| his Take over | `computer.drive` owner, a drive stream, his line typed into Notepad, Hand back |
| Notepad's save | FAILS: see below |

**Found by the run, and fixed since** (not yet run again end to end):
- Notepad's Save in its Save dialog was held as "Forward": the hold's reading of a navigation button
  (`navForward`, shared/computer/outward.ts) did not know Windows' own "Back to … (Alt + Left Arrow)" and
  "Forward to … (Alt + Right Arrow)". It does now, by the key in the name; a Forward with no key in its name (a
  mail's) is still held.
- A program the service started ran in `C:\Windows\System32`, so Notepad's Save dialog opened there. The logon
  task now starts the service in tcuser's Documents (`TCUSER_DOCUMENTS`, setup.ts), from the next Set up.
- `windows_apps` refused "Microsoft Edge" and "Edge": the name went to ShellExecute as it was. An allowed app's
  name now goes to the service as its file (`vmLaunchFile`, policy.ts).

**Still open, found by the run:** the held "Forward" press's replay filled the file name and said `sent`, yet
nothing was saved. With Save no longer held that path is gone for Notepad, but a held press in a Windows dialog
that answers `sent` without its effect has not been explained.
- On a headless host the box's own socket may not watch video (`mayWatch`), so the run watches and takes over
  with a client key on the listener, as his Mac or phone would.

## Proofs

- `keeper.test.ts`: every change of state over a fake machine and guest, the idle hibernate and what holds
  it off, the service copied only when its hash differs, the door's knock, setup's steps and script.
- `watcher.test.ts`: the watcher run under bash with a stand-in for QEMU and a stub ssh (the hibernate asked
  as the admin, the TPM kept, a second signal ignored, QEMU exiting by itself), and a process started
  through `stopBlocked` surviving SIGTERM, SIGINT and SIGHUP.
- `index.test.ts`: the methods through the Work router, the model refusal, the capability rows, the push,
  the stored setting, the point methods.
- `window.test.ts`, `picture.test.ts`: QEMU's window arguments and environment, the machine with no window and why,
  the VM's row, its video source and its 4 fps picture over fakes. `pictureLive.test.ts`: the box's QEMU drawing on
  the VM's display through a real engine and the relay, where the tools are installed.
- `points.test.ts`: points over a real qcow2 overlay on a backing image (qemu-img, qemu-io): the disk, the
  firmware variables and the TPM put back, newest first, a delete, no path for an id.
- `door.test.ts`: the spawn over a stand-in door (the knock first, `initialize` naming the guest's folder, a
  picture copied home and its path rewritten in order, a clean exit at sleep, never a path out of the folder).
- `files.test.ts`: the file tools over a fake guest and a real workspace folder: the copy each way, the free
  name, the fence at both ends (a step out, a link out, a Work Chat, a bad name, a guest folder that is a
  link), the cap, the refused types, the Result and its undo, a changed file left, another thread refused.
- `clipboard.test.ts`: the paste (text then Ctrl+V to the app in front, at the session tier), the cap, the
  copy out, the clipboard put back at Hand back, emptied when it cannot come back whole.
- `vm.test.ts`: over the fake computer service, the VM's gate admitting the session tier a headless box
  refuses, the tools offered and refused by the setting and never to a Work Chat, the setting read at each
  call, the wake first, a console's launch refused in Windows' words, the lease's words, its two minutes, his
  Take over, and the service ending with the machine.
- `standing.live.test.ts` (TC_WINVM_STANDING=1, the standing machine set up fresh): the five tools listed
  through the real Work mount, Notepad launched, read and typed in, Ctrl+S at the session tier opening the
  Save as dialog, a screenshot copied home, a console's launch refused. `computer/winRig.hold.test.ts`
  (TC_WIN_RIG=1, the rig) carries B6's live cases on the VM's sessions: a console's launch refused, a click in
  an open Windows Terminal held with `grantable: false`, typing in the Run box held.
- The rig runs: `scripts/e2e-winvm-stop.ts` (the rig), `scripts/e2e-winvm-keeper.ts` and then
  `scripts/e2e-winvm-points.ts` (the standing instance: save, change a file, go back, the file as it was), and
  `scripts/e2e-winvm-picture.ts` (a fresh standing disk with QEMU's window: frames a second through the relay, its
  disk deleted after).
