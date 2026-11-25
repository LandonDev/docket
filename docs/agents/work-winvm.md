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
| `work.winvm.sleep` | operate | hibernates it and answers once QEMU has exited; a person's Sleep holds it asleep (`heldAsleep`) until his Wake |
| `work.winvm.restart` | operate | restarts Windows cleanly (`shutdown /r /t 0` as the admin, never `/f`), then opens the door again; the state says "Restarting Windows" meanwhile. Refused while a thread holds the machine (the lease) |
| `work.winvm.still` | read | `{ still }`: the picture it last went to sleep on ("The still"), to whoever may watch the VM (`mayWatch`: a client key with approve; never a thread or the box's own socket) |
| `work.winvm.setup` | admin | answers at once; the progress and the end come as pushes |
| `work.winvm.settings` | admin | `{ sleepAfter, screen, detail }`: `15m`, `30m` (the default), `2h` or `never`, in the host setting `work.winvm.sleepAfter`; the guest's screen, `fit` (the default), `1280x800`, `1920x1200` or `2560x1600`, in `work.winvm.screen` (on std VGA a size is used by a new Set up, "The picture"); `sharp` (the default) or `faster` in `work.winvm.detail`. A change pushes the state, whose `display` says it |
| `work.winvm.display.upgrade` | admin | Turn on live resize ("Live resize"): answers at once, the steps come as pushes. Refused while a thread holds the machine, while he drives and while a OneDrive write is owed |
| `work.winvm.display.downgrade` | admin | Turn off: a clean shutdown and a start on std VGA at 1280×800; refused as upgrade is |
| `work.winvm.points` | read | `{ points }`, newest first |
| `work.winvm.point.save` | operate | `{ name? }`: a point of the sleeping machine |
| `work.winvm.point.restore` | admin | `{ id }`: back to a point; the machine stays asleep |
| `work.winvm.point.delete` | admin | `{ id }` |

Settings → Work draws a press only where this window's key may make it (`linkMay`, docs/agents/work.md
"The switch"): a given computer's key wakes, sleeps and saves a point; Set up, Go back and Delete are not
drawn, Sleeps after stands as words and the screen size is not read. A read key gets no press.

A model caller (a thread's `app.work*` call) may read and wake, never set up, sleep, restart, change the settings,
read the still or touch a restore point. The state also says `wakeMs`, the median of the last five wakes from
sleep (the Computers page's "6 s of about 13"), and `heldAsleep`. Every change of state pushes `{ push: 'work.winvm', state }` to every client socket,
and every change to the points `{ push: 'work.winvm.points', points }`. Once set up the state also carries `display
{ device, width, height, scale, fit, detail, canResize }`: the device machine.json names, the size and scale
Windows has (screen.json), his choice, and whether Windows takes a new size while it runs (virtio alone). The methods answer
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
   - OneDrive's machine policies (`ONEDRIVE_POLICY`): files on demand always, no folder backup offered, no
     tutorial, and Storage Sense sending a downloaded file back to the cloud after a day unopened.
   - Office's viewer mode (`OFFICE_POLICY`): its first-run licensing dialog does not draw on this image, and
     the policy skips it (work-office.md "The Windows VM").
   The script notes each step it reaches in `C:\Windows\Temp\tc-setup.log`. On a fresh guest it has now
   and then hung before its first step while Windows was busy after its first logon (two of six fresh setups
   on 2026-11-20, nothing done in the guest), so the keeper gives it 4 minutes and runs it once more; a last
   failure names the step it reached.
4. The box's service copied in (below), then a restart, since tcuser's policies are read at logon.
5. The door knocked: the service runs under the new policies. The state is then `awake`.

**A new disk comes up on virtio-vga by itself.** After `makeDisk` the keeper gets the display driver ("Live
resize", step 1) and writes `run/machine.json` = `virtio` before the disk's first start, a cold boot of the base
image, so no hibernated Windows meets new hardware. Windows draws on the device with its Basic Display Driver
until the driver is staged with `pnputil /add-driver … /install` after the setup script; setup's restart takes
it, and the hardware pointer is turned on once Windows is back. A box that cannot have the driver sets the disk up
on std VGA and says why in the log. **A Set up on a disk that exists keeps its device**: machine.json is not
written and no driver goes in.

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

## The helper

A second door in the guest, for what is not computer use: `tc-office.exe`, the
Office helper (native/tc-office-win/TcOffice.cs), as tcuser on its desktop,
`serve --listen 127.0.0.1:47801 --token-file C:\ProgramData\TempCode\token`
(helperDoor.ts). It reads OneDrive's folders for the Teams files
([work-teams-files.md](work-teams-files.md) "The Windows VM") and drives Office by COM
([work-office.md](work-office.md) "The Windows VM").

- **No program ships for it.** The box carries the helper's C# source
  (`TC_OFFICE_CS`). At each new awake spell the door runs a small check as the
  admin (`helperCheckScript`, a few KB, 15 s and one more run, then an error
  that names the step): the machine policies; `stale` when the guest's copy
  differs from this build's by a sha256 kept beside it; else the logon task
  `\TempCode\office` registered with these arguments and the helper started
  unless it runs. Only on `stale` does the source cross, as a file over scp
  into the admin's profile (`upload`, on the forward's connection), and
  `helperCompileScript` builds it with the guest's own `csc.exe`
  (`/target:winexe`, so no console; `/define:UIA` for the sign-in walk) into
  `C:\Program Files\TempCode\tc-office.exe`, which tcuser runs and cannot
  replace; the check runs again after it. A wake with a current helper takes
  about half a second (measured 2026-11-23); a compile about 3.5 s.
- **Nothing large on stdin.** Until 2026-11-23 the source rode inside the
  script, 111 KB fed on ssh's stdin, and this guest's sshd now and then lost
  that feed's end-of-file: the read to the end never returned and the door
  waited two minutes twice. Every byte arrives; only the end is lost, above
  about 64 KB (a reader to the end hung at 100 KB three of three, never at
  64 KB; a reader that stops at a length answered at 150 KB three of three).
  So `psStdin` sends the base64 behind its length and the boot reads to that
  length, and it refuses a script over 64 KB (`PS_STDIN_MAX`;
  stdinBound.test.ts holds every script the host sends to half of it).
- **Its sockets are its own.** .NET Framework makes sockets inheritable, and
  the programs the helper starts (OneDrive, Word, a file's app) kept its
  listening socket, so a helper put in its place exited with 3 ("port taken")
  until they closed (2026-11-23). The helper now marks its sockets not
  inheritable and starts programs through the shell; the check, finding no
  helper and the port held, names the programs that hold it ("Close them in
  the VM").
- **The forward** is a second `-L` on the door's own SSH connection
  (`KeeperDeps.forwards`, `run/office.sock`), so it opens and closes with the
  door. `HelperDoor.open()` wakes the machine (the keeper's `door()`), makes
  the helper ready once per wake (a knock, and the script only when the knock
  gets no `ready`), and answers the socket and the token; `openIfAwake()`
  never wakes it. A connection that dies before `ready` has the door made
  ready again once (`doubt`).
- **Many connections.** Each brings the token as its first line, then speaks
  the helper's frames. Office's verbs run one at a time on the helper's STA
  thread; the folder verbs run on their connection's own thread. A helper
  that stops answering an Office call (a dialog open in the app) is ended as
  the admin and started again at the next call.
- **No lease.** These calls do not take the VM for a thread: a thread reads
  Teams files or a workbook while another drives the desktop. `open` (the
  switch) does show a window there.

`Keeper.key(...qcodes)` presses keys on the machine's own keyboard (QMP
`send-key`) while it is awake: Windows' security prompts take them where they
take no click from a program in the guest (the sign-in walk's Escape).

**No console window.** The door is a console program: started by itself it
sat in a Windows Terminal window on tcuser's desktop, over everything he and
a thread looked at (seen 2026-11-22). Its logon task now runs it under
`conhost.exe --headless` (`doorTask`, setup.ts), and each wake registers a
task from before that again and ends its door (`startDoorScript`). The
keeper's own desktop scripts (`onDesktop` with `wait`) run the same way.

## The picture

**Its size is the guest's own.** Windows' basic display driver takes the firmware's mode at a cold boot and keeps
it through every hibernate. On 2026-11-22 the box's VM had Screen size set to 1920×1200 while it slept at
1280×800: it resumed with QEMU told the larger mode and read the guest's frame buffer at the wrong stride, so the
picture (and QMP's screenshot, `shot.sh`) was a scramble. Now, after every wake, the host asks the guest its mode
(`GUEST_SCREEN_SCRIPT`, guestScreen.ts) and keeps it in `run/screen.json`; the next start sizes QEMU's VGA and the
display to it (`StandingMachine.start`, `VmScreen.up(guest)`), and a mismatch found on a machine nobody holds or
drives is put right at once with one sleep and wake. A new disk has no file and starts at the setting, so **the
Screen size setting is taken by a new Set up**, not by the next wake; a Windows restart inside a run keeps the run's
size.

**On virtio-gpu the guest follows his picture** (plan stage 1; the device is `run/machine.json`'s, which every
start reads, and no machine is moved to it yet: that is the Turn on of a later slice). A wake there reads the
guest's mode the same way and sets the display to it live (`VmDisplay.follow`), with no sleep and wake; the
mismatch rule above is std VGA's alone. His size ask (`video.size`, live-video.md "The size ask") reaches
`VmPicture.size`, which maps it by `askedMode` (Fit by `guestSizeFor` with the host's caps; a fixed size at the
largest scale that keeps 1024×640 points, or 100% for Faster) and answers `unsupported` on std VGA, asleep or with
no window. `VmDisplay` (display.ts) then makes the change, one at a time:

1. The X screen grows by RandR where the new size is larger (`VmScreen.resize`, box/randr.ts).
2. `display.set { width, height, scale }` through the door (`guestDisplay`, door.ts; docs/computer-protocol.md
   §29.9). As soon as it answers, `run/screen.json` says the size Windows reads back, so a stop of the service
   from here leaves it true. An answer with `taken: false` (the driver refused the size, or Windows the scale) is
   step 2 failing: the box follows the mode the answer says is true, and the ask fails naming both ("Windows did
   not take 3456×2234 at 200%: it is 1280×800 at 100%"). A refused size leaves the box as it was (a grown screen
   shrinks back, no stream ends); a size that took at another scale goes on through steps 3 to 5 first. A
   refusal is never kept as the mode the guest has, so the same ask is asked again.
3. QEMU's window is waited for at that size, 5 s at most (`VmScreen.windowSize`: the display's largest window).
4. The VM's streams end `resized` (4108) and every VM engine stops, the warm ones too: an engine fixes its size
   at its start. No lease is given until step 5 is done (`VmDisplay.lease`; a lease that was starting as the
   change began gives its engine back and asks again). A stop made on purpose never counts as an engine crash.
5. The X screen shrinks where the new size is smaller, and leases open again.

A failure leaves the size that is true and says why: before step 2 nothing changed (a grown screen shrinks back);
after it the guest's size is the file's, the engines restart at it, and the error names the step that failed.
`askedMode` always asks inside `display.set`'s bounds (`GUEST_DISPLAY`, a `DISPLAY_SCALE_STEPS` step).
`scripts/e2e-winvm-resize.ts` proves the whole change on a scratch machine; until the guest it boots carries a
tc-computer.exe with the verb, it stands in with `viogpures.exe` and asks Faster (it sets no scale). That proof is
written and not yet run.

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

**Key codes.** The engine presses his keys on the display by their evdev codes, and QEMU's window turns the
display's key codes into the guest's keys by the set the display names when QEMU starts. The bundled Xorg names
the old "xfree86" set, where letters sit alike and the navigation keys do not (Page Up reached the guest as "/",
Left and End as other keys: found from a Mac's Take over, 2026-11-22). So each start runs `setxkbmap -rules evdev`
on the display before QEMU (`evdevKeys`, window.ts; the box's own setxkbmap), and logs it when that fails.

### The device, and live resize

`run/machine.json` names the display device the guest last ran on (guestScreen.ts): `vga`, QEMU's std VGA under
Windows' Basic Display Driver, one size until a cold boot; or `virtio`, virtio-vga under Red Hat's viogpudo
(virtio-win 0.1.302), whose size Windows changes while it runs. It is written before QEMU starts on a device,
never after, and every start reads it; **no file is `vga`**, so a disk from before live resize wakes exactly as it
did. The keeper's state says it (`display`), and only virtio has `canResize`.

**Turn on** (Settings → Work → Windows VM → Live resize → Turn on…, `work.winvm.display.upgrade`). The confirm:
"Windows restarts once. Save your work in it first. Sign-ins stay. A restore point is saved first, in place of
your oldest if you have three." Refused while a thread holds the machine, while he drives, and while a OneDrive
write is still owed (`owed()`, as the idle sleep waits for it). The keeper runs six steps, each its words in the
state (`LIVE_RESIZE_WORDS`) and on the row:

1. "Getting the display driver": the `virtio-win` tool (scripts/work-tools/winvm.json: the 0.1.302 image pinned
   by sha256, 877 MB, its `viogpudo\w11\amd64` folder taken out by iso-folder.py with no mount and no root, the
   image deleted after) installed by the toolchain's own installer when it is missing (driver.ts), its lines in
   the log.
2. "Adding the display driver to Windows": awake (a sleeping machine is woken), `viogpudo.inf`, `.cat` and `.sys`
   copied into `C:\ProgramData\TempCode\viogpu` and staged with `pnputil /add-driver` (the device is not there
   yet: it binds nothing), and tcuser's I-beam set to the box's colour one (`HKCU\Control Panel\Cursors\IBeam` =
   `C:\ProgramData\TempCode\tc-ibeam.cur`, from resources/winvm/tc-ibeam.cur, the M0 spike's file): Windows' own
   monochrome I-beam is drawn into the picture beside the last hardware shape, an alpha one is a hardware pointer
   too (liveResize.ts `stageScript`).
3. "Restarting Windows": `shutdown /s /full /t 0`, a clean shutdown, never a hibernate and never forced. QEMU
   has 3 minutes to exit; past them the move is called off, nothing new is started, Windows stays on std VGA as
   it is, and the row says "An app in Windows kept it from restarting. Save your work and try again."
4. "Saving a restore point": `keepTpm()`, then a point of the stopped machine, "Before live resize" (by the
   keeper; past three the oldest goes). It records std VGA.
5. "Starting Windows with live resize": machine.json = `virtio`, and only then the start, at the size it had
   (`-vga none -device virtio-vga,edid=on,xres,yres`). Checked: Windows names "Red Hat VirtIO GPU DOD controller"
   over SSH, and QMP's screendump has a picture (`StandingMachine.shows`). A failed check goes back to the point
   by itself ("Going back to the restore point"): a clean shutdown (the plug pulled only when that does not stop
   it), the disk, firmware, TPM and std VGA put back, the machine asleep, and the row says Live resize did not
   start and that Windows is back as it was.
6. "Turning on the pointer": `HWCursor=1` in viogpudo's driver key and `pnputil /restart-device` (nothing
   restarted when it is 1 already). A failure leaves Windows on virtio with the pointer in the picture; a keeper
   tries it again at its first wake on virtio, which also finishes a Turn on whose service stopped before step 6.

machine.json changes once, just before the one start on virtio: at a failure or a stop of the service before it,
the guest last ran on std VGA and the file says so; between the write and the start Windows is cleanly shut down,
so it boots afresh on either; after it both say virtio (keeper.test.ts holds each step to this).

**Each step's undo.** After 2: nothing (the staged driver binds nothing; `pnputil /delete-driver` removes it).
After 3: a plain start (it is still `vga`). After 5 or 6: **Turn off…** (`work.winvm.display.downgrade`, "Windows
restarts once, at 1280 × 800. Save your work in it first. Sign-ins stay."): a sleeping machine woken on the
device it slept on, the same clean shutdown and 3-minute call-off, machine.json `vga` and screen.json 1280×800,
and a start on `-vga std`; Windows goes back to its Basic Display Driver by itself (viogpudo binds only the
virtio device). The I-beam stays: it is a plain cursor on std VGA. A machine that will not boot or has lost a
sign-in goes back to "Before live resize" (Restore points), which puts `vga` back with it.

**Before any rollback of the box to code from before live resize: Turn off… first, then roll back.** Older code
starts every machine on `-vga std` and would resume a virtio hibernate on changed hardware. box-update warns
when machine.json says `virtio` and the build it deploys does not read it (box-update-lib.sh
`vm_device_warning`, docs/box.md "Live resize and a rollback").

**The settings.** Screen size: Fit to window (the default), 1280 × 800, 1920 × 1200 or 2560 × 1600; on std VGA it
says "Used when the VM is set up again". Detail (Sharp, Faster) shows once live resize is on. The Computers bar's
Size and Detail set the same host settings, and are off with "Turn on live resize in Settings → Work" on std VGA.
Applying a size to a running Windows is the VM display's own work (`VmDisplay`, live-video.md "The Windows VM").

## Take over

`computer.drive { computer: 'vm:windows', driver }` reaches the `vm` hook (`vmWheel`, drive.ts), registered at the
host's wiring (host.ts `wireVmDrive`). A machine asleep, going to sleep or waking is woken first, so Take over is one
press whatever its state (until 2026-11-22 it was refused with "Wake it first"); it is refused with no window, not
set up, or Work off. Take over: the lease is his (`ownerDrives`: every thread's call refused, the turned-away threads
noted, and the thread that held the machine noted with them, since its session is about to be stopped), the keeper
holds the machine awake (`setDriving`), his streams take his input, then every thread's session on the VM is
stopped. Hand back: his keys let go, the guest's clipboard put back (B9), the keeper and the lease freed, and the
threads turned away, the holder he took it from among them, woken with `VM_FREE_NOTICE`. A drive stream that ends
under him (his link cut, the window gone) lets go of every key and button first (`EngineFeed.close`). The machine
going to sleep under him hands back by itself. The keys and the menu are live-video.md "Driving".

## Sleep

Sleep is hibernate (`shutdown /h` as the admin): QEMU exits once Windows has written its image, about 5 s;
the keeper then keeps the TPM's state. Apps and sign-ins are there at the next wake, and the guest's clock is
right after it. It happens:

- after the sleep-after setting with no thread's call, no viewer and him not driving (checked every minute);
- on `work.winvm.sleep`;
- at a stop of the box's service, by the watcher.

A machine that stopped by itself (he shut Windows down in a Take over) is noticed within a minute and reads
`asleep`.

### The still

Just before it hibernates the keeper takes QMP's screenshot of the guest (`beforeSleep`, at most 3 s; a
failure never holds the sleep) and keeps it as one JPEG, at most 1920 on its long edge, in
`<userData>/winvm/picture/still.json`, written whole in place of the last (still.ts, wired by host.ts). The
Computers page draws it washed back under the VM's plate while it sleeps, wakes and connects
(docs/DESIGN.md "Computers", "The faces").

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

The guest's service answers `display.get` and, on viogpudo, `display.set`
through the same door. The answer is the mode Windows reads back, including its DPI
scale in percent. See [computer-protocol.md](../computer-protocol.md) §29.9.

### The tools

At 3456×2234 and 200% Windows scale, a thread's screenshot of a window that
fills those pixels is 1280×827 at the default `maxEdge`, or 1920×1241 at
`maxEdge: 1920`. A smaller window uses its own bounds. As on any PC, the
service fits the window's physical pixels to `maxEdge` and the shot's pixel
cap (§6). The service runs per-monitor DPI aware v2 (`main.rs`). It maps the
thread's screenshot coordinates back to the window's physical pixels for
a click, without applying the Windows scale a second time.

`windows_apps`, `windows_observe`, `windows_act`, `windows_batch` and `windows_result`: the computer tools in
Windows' words (`computerToolSpecs` with `platform: 'windows'`), renamed, mounted as the `winvm` pillar's Work
tools (tools.ts), and run on the VM's sessions. Their head says what the machine is: a Windows 11 PC on this
host, his own, signed in as he left it; one thread uses it at a time; a send or submit is held for his press,
so drive up to it and stop; never type a password, say he must take over; no command line. What they answer
names `windows_*` where the shared words say `computer_*`.

- **Who gets them**: a Work thread of a workspace whose Work settings turn on `windowsVm` ("Computer use on
  the Windows VM", on for a Work workspace made since 2026-11-22; its switch is B10's), on the host whose VM is set up. A Work Chat never.
  The setting is read when the tools are listed and again at every call (`vmOffered`), so turning it off
  stops a running thread with "refused: computer use on the Windows VM is off for this workspace".
- **Waking**: a call on a sleeping machine wakes it first; while it wakes, its row's hold reads "Waking the
  Windows VM". A call held 20 s (a wake, a card) answers with an id, as a bridged computer call does
  (pending.ts), and `windows_result` reads it again or cancels it; nothing runs unread.
- **The preamble** gains one line where the tools are offered (`VM_PREAMBLE`).
- **Real input only** (gate.ts `vmTiers`): with nobody at the guest, the session tier replaces the posted ones
  (`process`, `front`) whenever it is allowed, so a click, a key or typing is `SendInput`. A Work thread's run on
  2026-11-22 typed a name into Notepad's Save as dialog by UI Automation and by posted keys: the box showed the new
  name, the step said `changed`, and the dialog saved under the name it had. That is also the likeliest account of
  B10's held press that answered `sent` without its effect (a replay at a posted tier).
- **The service knows nobody sits there** (`TC_COMPUTER_NO_PERSON=1`, set by the door for its `serve` child,
  `Service::without_person`): `set_value` on a text field (`input`, `text area`, `document`) is typed with real keys
  when the session tier is allowed (Ctrl+A, the value or Delete, then read back), and a launch leaves the app it
  brought forward in front rather than putting the window that was in front back over it. A value read back is
  compared with its line breaks made alike (`same_text`): Notepad keeps a lone CR for CRLF, and a right two-line
  `set_value` failed as `value_not_taken`.
- **Typing is exact** (2026-11-22, round three): the service's session-tier typing was the cause of B2's "Shift
  lost on the first typed key" and of a thread's "VM proof \rline onevm proof line two"; docs/computer-protocol.md
  §29.4.2 "Typing at the session tier" says how it types now. Proven on the standing VM with that build run as a
  second door beside the live one: three lines with capitals, punctuation, quotes and a blank line read back
  exactly, and Alt+F4 closed Notepad.
- **A step that closed its window says so** (`WINDOW_CLOSED`, computer/result.ts): the step's line ends "the window
  closed" and the body names computer_apps, where it said "can't tell" and "observation failed".
- **A menu path is refused** (`NO_MENU_PATH`): `menu: "File > Exit"` is the Mac's menu bar route; the words say to
  expand the menu item by its index and click the item by name.
- **`save_as` is refused** before the call goes (`NO_SAVE_AS`): the Windows service has no save panel step, and the
  call used to fail as "needs the session tier". The tools' head says how to save instead: Ctrl+S, `set_value` the
  dialog's File name box, Return.

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
- `vmCopied()`: the guest's clipboard text (cut at 1 MB, `truncated`) for the viewer to hand to his own: `video.copy`
  on his drive stream (`VmPicture.copy`, wired by the pillar's start through `configureVmCopy`), asked by the viewer
  300 ms after a copy or cut chord goes to the VM. Nothing called it before 2026-11-22.
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
- **A point carries its device.** Its record holds `device` and `screen`, the run's machine.json and screen.json
  at the save, and going back writes both back with the disk, firmware and TPM: a Windows that slept on std VGA
  wakes on std VGA whatever the machine runs on now, and a virtio point taken before a Turn off wakes on virtio.
  A point from before live resize has neither and is std VGA at 1280×800.

## Disk mode

With QEMU's default (`cache=writeback`) each guest flush is a flush of the
box's disk: on 2026-11-24 one scratch rig instance booting on a fresh overlay
kept the NVMe 84% busy at 1.6 MB/s and the server's loop stopped for 82 s. A
throwaway rig takes `WINVM_DISK_CACHE=unsafe` (guest flushes dropped; refused
unless the root, TPM folder and port are scratch, `diskCacheOf` in
machine/config.ts). The standing machine keeps the default: it holds his
sign-ins. Its wakes still cost the box 1 to 2 s hitches for a quarter hour;
the recommended `cache=none,aio=native`, with a restore point before its first
start, is written in .temp-code/plans/landed/F-box-slow/root-change-disk.md and
not made.

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
3. **Per workspace**: a Work workspace's page → "Computer use on the Windows VM". On for a workspace made since
   2026-11-22 (an older one keeps what it had); only those workspaces' threads get the `windows_*` tools.
   Settings → Work → Windows VM then says Office and OneDrive in it as last read (`work.office.vmStatus`,
   which never wakes it): which Office apps and who they are signed in as, who OneDrive is signed in as and how
   many Teams libraries it syncs, or Sign in where it needs him (`work.office.vmSignIn`, then the Computers
   page on the VM).
4. **Choose its sleep and screen** if the defaults do not suit: Sleeps after (30 minutes) and Screen size
   (on std VGA a size is used by a new Set up: Windows keeps the size it was set up at through every sleep).
   **Live resize is his press**: a deploy changes nothing in his VM (it has no machine.json, so it wakes on std
   VGA as before). Settings → Work → Windows VM → Live resize → Turn on…, with nothing unsaved in Windows and no
   thread on it: about two minutes and one restart the first time (plus the 877 MB driver download), a restore
   point first. Then Screen size (Fit to window) and Detail. Turn off… goes back. Before any rollback of the box
   past this code, Turn off… first.
5. **Sign in to what else threads should use**, in a Take over from the Computers page: the VM keeps it across
   sleeps. A thread never types a password.
6. **Before the evaluation ends** (about 17 February 2027, Settings' Edition row; Connections warns 14 days
   ahead): buy and enter a real Windows key in a Take over, or rebuild the image (`install.sh --force` after
   the standing disk is gone; what is signed in is lost).
7. **Sign in to OneDrive and Office** (once each; Microsoft 365 Apps is installed since 2026-11-22): Settings →
   Connections → "OneDrive on the Windows VM" → Sign in… walks OneDrive's sign-in to a number for his phone
   and opens the Computers page on the VM; the same press on "Office on the Windows VM" opens Word, where he
   presses Sign in in its title bar. Settings' Office and OneDrive rows say who is signed in.

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

**Explained since** (2026-11-22, a real Work thread on the box, below): the held "Forward" press's replay filled
the file name and said `sent`, yet nothing was saved. The same dialog ignores a name put in by UI Automation or by
posted keys; only real input reaches it. The VM now gets real input only ("The tools" above).

**A real Work thread on the box, 2026-11-22** (Life workspace, Claude Opus 5.5 at low effort, 113 s, $0.84): open
Notepad, type two lines, Ctrl+S into Documents as `vm-proof-1122.txt`, `windows_get` it home. Calls and answers:
`.temp-code/plans/landed/F-vm-files/p1-run1-calls.txt`. What failed: the two lines by `set_value` answered
`value_not_taken` though Notepad held them (CR for CRLF); the Save as dialog saved under Notepad's suggested name
three times while its File name box showed the one typed (by `set_value` at `ax`, by posted keys); `save_as`
answered "needs the session tier"; Alt+F4 answered "no change seen" and a click on the window's X at the `process`
tier "changed" with no effect; every launch put the door's console window back in front ("Windows Terminal Host was
put back"). The file came home under the wrong name and the thread renamed its copy. Each is fixed above, on the
host and in the service; none of it runs on the box until its next deploy from master.
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
- `guestScreen.test.ts`: the guest's own size read after a wake and kept, a mismatch put right with one sleep and
  wake when nobody uses the machine and only recorded when someone does.
- `gate.test.ts`, `vm.test.ts`: the session tier in place of the posted ones; `save_as` refused before the machine is
  taken. The service's own Rust suite (`cargo test` in native/tc-computer-win, `tests/input.rs`): `set_value` typed
  with real keys where nobody sits, the launch leaving its app in front, and the read back blind to line breaks.
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
