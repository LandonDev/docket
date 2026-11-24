# Work: Teams files

Microsoft Teams and SharePoint files, seen in TempCode and used by Work
threads, without Microsoft Graph (blocked on the owner's Purdue account) and
without an Entra app. The finding that chose this way is
`.temp-code/plans/landed/F-teams-files.md`. Part of the `office` pillar
([work-office.md](work-office.md)): it rides that pillar's route to the Mac,
its Office apps and its rule for a file others can open.

The Files place ([work-files.md](work-files.md), the `files` pillar) reads
what this finds as places of its own, over this pillar's code: its wire here
(`work.office.files*`), its tools and its Settings rows stay as they are.
Until that place has its screen (its milestone F1a), the Files row is the
view this file describes.

## The way in: the synced folder

The OneDrive app on a Mac syncs a channel's library (Teams → Files → Sync, or
Add shortcut to My files) under `~/Library/CloudStorage`, in one of two
layouts (`found` in `office/files/library.ts` reads both):

- **As observed on his Mac** (OneDrive 26.189, 2026-11-20): every folder sits
  at the top of CloudStorage. `OneDrive-<tenant>/` is his own files
  (`OneDrive-purdue.edu`, `kind: 'mine'`), and each library synced from Teams
  is `OneDrive-<tenant>-<name>/` beside it (`OneDrive-purdue.edu-RecWell-TeamRecWell`,
  `OneDrive-purdue.edu-RecWell-SportPrograms`). The tenant is known from the
  plain folder, so a top folder that starts with `OneDrive-<tenant>-` is a
  library of that tenant (`tenantOfSynced`; the longest tenant that fits). Its
  `<name>` probably reads `<site>-<library>` (both of his share `RecWell-`), but
  a dash also stands for a name's own dashes and its dropped spaces, so it is
  shown as OneDrive wrote it, one row by that name, with no team heading. No
  attribute, Spotlight field or hidden entry on the folder names the site, the
  library or its web address (looked at read only: the folder's only attribute
  is its File Provider domain id); the names live inside OneDrive's own
  databases, which TempCode does not read.
- **As Microsoft documents it**:
  `OneDrive-SharedLibraries-<Tenant>/<Team or site> - <Library>/`. A team's
  library is "Documents" (or "Shared Documents"). The last " - " parts the
  team from the library.

Channels or not: a library's top folders are read as a team's channels
(`kind: 'channels'`) when the library is a team's Documents in the documented
layout, or, in the observed one, when one of them is `General`, the channel
every team has; otherwise it is `kind: 'library'`, its folders plain folders.
His RecWell libraries have no `General` at the top (Business Office,
Engagement, Operations…), so they read as libraries. Whatever the kind, every
file in a library counts as one others can open (the Office tools' shared-file
rule) and stays on the Mac unless the workspace's copy switch is on: neither
rule asks the kind.

Other folders under CloudStorage (Dropbox, Google Drive, iCloud, a consumer
`OneDrive-Personal`) are not Teams files. His work OneDrive is, since the
shortcuts he adds to My files land there. Every library is named by its real
path, so a folder added through a link (an older OneDrive's `~/<Tenant>/`)
is the library it points to, listed once. His own edits to the list are rows of `work_office_files`
(`roots`: a folder added, `kind: 'folder'`; a found one turned off; a folder's
web address), so a library he keeps somewhere else (an older OneDrive's
`~/<Tenant>/`) counts too.

What the disk says, and how it is read (`office/files/library.ts`):

- **Downloaded or not.** OneDrive's files-on-demand leaves a file "dataless"
  until it is opened: its full size and no blocks (`isLocal`: `size === 0 ||
  blocks > 0`). Listing a folder or stat-ing a file downloads nothing. Reading
  a file's bytes downloads it; `fetchFile` reads one to its end (ten minutes
  at most), which is how a file is downloaded on demand. macOS has no command
  that downloads or evicts one (`fileproviderctl` and `brctl` cannot).
- **Who.** An Office file's own `docProps/core.xml` (`lastModifiedBy`, else
  `creator`), read through `office/files/zip.ts` from a file already on disk,
  never from a cloud-only one, and cached by path, time and size. Other files
  have no who: the synced folder does not carry SharePoint's "Modified by".
- **Text.** A Word file's paragraphs (`word/document.xml`), a deck's slides in
  order (256 MB at most, checked before it downloads), a text or CSV file's
  head (only the first 800 KB is read), cut at 200,000 characters. The zip
  reader inflates an entry no further than its limit, whatever size the file
  claims for it.
- **Search** reads names only and yields between folders (async), stopping at
  20,000 folders, 1,000 names or 15 seconds (`more`); only the 200 shown are
  looked at closer, so a walk over a library OneDrive has not listed yet never
  holds the host. A workbook is
  read through Excel (`office_range_read`), a PDF in the canvas.

## The Windows VM

The box has no OneDrive of its own, and a plain Linux client needs Microsoft
Graph, which Purdue blocks. So the box's Teams files come from Microsoft's own
OneDrive in the Windows VM it keeps ([work-winvm.md](work-winvm.md)), signed
in as him, files on demand. The code is `office/vm/` (`link.ts`, `files.ts`,
`signin.ts`) and the helper's door, `winvm/helperDoor.ts`.

- **A library there is a library of the keeping host** with `vm: true`: its
  `host` is the box, its `path` the guest's own (`C:\Users\tcuser\…`), its
  id `<host>~<hash>`. Every `work.office.files*` verb takes it like a folder
  of the host's disk and routes by the library (`admitted`, handle.ts). The
  renderer and the tools need no second wire.
- **Read as tcuser, through a helper.** `tc-office.exe` (the Office helper,
  native/tc-office-win/TcOffice.cs) runs as tcuser on its desktop and serves
  a loopback door behind the VM's own token (`serve --listen 127.0.0.1:47801`);
  the keeper's SSH connection carries a second forward to it
  (`run/office.sock`). It is the one caller OneDrive's Files On-Demand surely
  downloads for: the admin's SSH session is another user in session 0. Its
  folder verbs (`Guest`): `guest.status` (OneDrive installed, running, the
  account; the mounts from OneDrive's own registry rows,
  `HKCU\Software\SyncEngines\Providers\OneDrive` and the accounts'
  `Tenants`, each with the web address it stands for; Office as installed
  and signed in), `files.list`, `files.stat`, `files.search` (the guest walks
  its own disk: names only), `files.read` (pieces of 4 MB), `files.fetch`,
  `files.free`, `files.open`, `onedrive.signin`, `onedrive.sync`, and the
  change verbs below. A connection per call (`vmCall`), so a long download
  never holds a list.
- **Fenced twice.** On the box a guest path must lie in a library OneDrive
  syncs there, by name alone (`vmLibraryOf`: a drive and backslashes, no `.`
  or `..`, no other separator, no trailing dot or space, no stream `:`, no
  wildcard or control character, no device name such as `CON`,
  case-blind). In the guest the helper holds every path to OneDrive's mounts
  again by the same rules (`MountOf`) and refuses a link on the way down
  (`Admit`). The listener's path fence has nothing to
  say of a guest path, which is no file of the host: only the files verbs
  that name one file may carry one (`guestPath`, remote/fence.ts), and a
  Windows host's own paths stay fenced. So a remote key of his (the Mac's
  window, the phone) reads the VM's libraries by its capability; the bytes
  go to no caller (`filesRead {as: 'bytes'}` is refused: a copy is made on
  the box by `filesCopy`).
- **Who may.** His own windows always. A thread only where its workspace has
  "Computer use on the Windows VM" on (`vmAllowed`, read at every call); a
  Work Chat never. The file verbs do not take the VM's lease: a thread reads
  Teams files while another drives the VM.
- **Waking.** What OneDrive syncs is read while the machine is awake and
  kept (`vm:status` in `work_office_files`, with each library's top
  folders), so `filesLibraries` answers a sleeping VM from that and never
  wakes it, save once when it has never been read. A folder, a search, a
  read, a copy or an open wakes it (about 20 s). While it is awake the
  pillar reads it again each minute until nothing is missing (signed in,
  the wanted libraries there, Office licensed), then every ten: his
  approval shows with no screen open (`watchVm`, office/index.ts).
- **A list never waits on the VM.** `filesLibraries` answers at once from
  what was kept and reads the guest behind its answer (`readVmBehind`,
  vm/files.ts): an awake machine whose status is over 15 s old or whose last
  read failed, and a machine never read (woken for it). One read at a time
  per host: a second ask while one runs joins it. A read that changes what
  was kept, or the failure it says, pushes `work.office.files` (`OfficePush`,
  `need: 'read'`) and a Files view on screen asks that host again; `watchVm`
  reads the same way, so its finds are pushed too. Measured 2026-11-23 before
  this: with the helper down the box took 30.0 s to answer the list and the
  view sat in its bones. A thread, or another host asking for one
  (`by.peer`), has no screen to repaint, so it alone waits, and only for a
  first read. Why the last read failed is kept in memory per host
  (`lastReadFailure`), cleared by the next read that works.
- **The VM's place while it is read or down.** Never read and its first read
  under way: `reading`. Never read and that read failed: `error` with the
  failure's words. Read before, awake, and its last read failed (the helper
  down, a time-out): `error` with those words and the account kept, over the
  libraries kept; asleep, it says what was kept. Connections answers the
  same way (`officeProbe`'s `vm`: what was kept, an awake machine read
  behind, which Check again shows); an `error` place is a broken OneDrive
  row in the failure's words.
- **Never a full download.** Machine policies set at setup and at each
  helper start (`ONEDRIVE_POLICY`, winvm/setup.ts): `FilesOnDemandEnabled`,
  no folder backup offered, no tutorial, and Storage Sense sends a
  downloaded file back to the cloud after a day unopened. A file a text
  read downloaded only for that read is sent back at once (`files.free`:
  Explorer's "Free up space"; one he pinned is left). A copy is 48 MB at
  most, checked before anything downloads.
- **Which libraries.** `work.office.vmSync {libraries}` (admin, a person's)
  keeps the libraries OneDrive there should sync (`vm:wanted`: site, web and
  list ids, the site's address, the two titles); whenever OneDrive is signed
  in and lacks one, the helper opens that library's own Sync link
  (`odopen://sync/?siteId=…`), at most once in ten minutes each. Set
  2026-11-22 to the RecWell site's Documents (ids read from OneDrive's
  settings on his Mac, where he syncs three of its folders one by one: the
  VM syncs the whole library, names only).
- **The same place on two machines.** `twinOf` (files/tools.ts) maps a file
  between a Mac's folder-library and the VM's whole library by
  `teamsPlaceKey`. `teams_libraries` lists a place once (the VM's copy: it is
  on the thread's own host and needs no Mac); a call whose machine cannot be
  asked (its failure starts "The Windows VM is unreachable:", or the Mac is
  offline) runs on the twin at the same place, and only then fails.
- **Places.** `filesLibraries` answers `places`: `folders` where the host has
  a CloudStorage folder, `vm` where it keeps the VM, each with its state
  (`TeamsPlace`): what the Files view and Connections say when nothing is
  listed.

### Changing files there

The helper's change verbs (F8; the box's side is work-files.md "The Windows
VM's verbs"). `guest.status` lists them as `verbs`, and the box offers a
change only where they are listed, so a helper built before them is asked
none.

- `files.mkdir {dir, name, op}` and `files.write {dir, name, data, op}`
  make a folder or a new file, never over anything: the bytes are written to
  a hidden `.name.<random>.tmp` beside it, through to the disk, then moved
  onto the name without replacing; a taken name (case-blind) answers "A file
  named "x" is already there.".
- `files.rename {path, name, op}` keeps the folder; `files.move {path, dir,
  op}` keeps the mount (a move to another mount is refused: that would be one
  library's file leaving it). The mount's own top is never renamed, moved or
  deleted.
- `files.write {path, data, expect, op}` replaces a file's bytes only while
  it is still the version `expect` names (`size:mtime:sha256` as the box's
  `versionWord`, the hash for 64 MB or less; `files.read {version: true}`
  answers the same word). Else it answers the conflict (`{conflict:
  {version, changed}}`, or `{conflict: {gone: true}}`), as the box's save
  does. The new bytes are staged beside it, the version looked at once more,
  then `ReplaceFile` puts them over it, which keeps the file's identity, so
  OneDrive keeps one file with a new version. 16 MB at most a write.
- `files.recycle {path, op}` sends a file or folder to the Windows Recycle
  Bin through the shell's own file operation (`IFileOperation` with
  `FOF_ALLOWUNDO` and `FOFX_RECYCLEONDELETE`, the class `RecycleBin`), never
  a delete for good: its progress sink sees each delete first and cancels
  one Windows would not recycle (no bin on that drive, the bin turned off,
  too big for it), so nothing is lost, and the answer says where it lies in
  the bin (`bin`). OneDrive then takes the delete to the library's own
  recycle bin.
- `files.restore {bin, to, op}` puts a thing `files.recycle` sent to the bin
  back: the `$R` item at `bin` moves to `to`, or beside a thing of that name
  as "Name (restored)" (then "(restored) 2"), never over anything and never
  across drives (`MoveFileEx` without replace or copy), and only when the
  bin's own `$I` record beside it names `to` ("The Recycle Bin holds
  something else there, so nothing was put back."); then the record goes,
  as Explorer's Restore does. A path outside the bin, or a thing no longer
  in it, is refused; the folder it was in must still be there, in a mount.
- **Both ends held.** Every path passes `Admit` (in a mount by name, no link
  on the way down, the thing itself no link); a name passes `NameProblem`
  (NTFS: no `<>:"/\|?*` or control character, no trailing dot or space, no
  device name; OneDrive: no `desktop.ini`, nothing with `_vti_`). While a
  change runs, the folder it changes is held open as itself (`Held`: no link
  followed, and without delete sharing, so it cannot be renamed or deleted
  meanwhile) and its real
  path, read from that handle (`GetFinalPathNameByHandle`), must lie in the
  mount's real path, before the change and again after it. A folder
  something else holds for its own delete is opened shared instead and
  checked the same way.
- **The journal.** Every change runs under its `op`, one change at a time,
  through `Journalled`: a small file per id under
  `%LOCALAPPDATA%\tc-office\ops` (named by the id's sha256), written
  `running` before the change and `done` with its answer, or `failed` with
  its words, after it. The same id with the same change answers what was
  kept and does nothing; with another change it is refused ("That operation
  id was used for another change."); a `running` one a stopped helper left is
  said so, never run again blind. `files.outcome {op}` reads it without doing
  anything (`done` with the answer, `failed`, `running` or `unknown`).
  Files go after a week.

Proven in the rig on a dummy mount, 2026-11-23 (`bun scripts/proof-files-vm.ts`
after `native/tc-office-win/build-in-rig.sh f8`, the helper spoken to as tcuser
over SSH): a registry row under `HKCU\Software\SyncEngines\Providers\OneDrive`
names a plain folder as a mount, as OneDrive itself would. A folder and a text
file made, renamed, moved; a stale write answered as a conflict and the right
one replacing the bytes, nothing staged left; ten paths out of the mount (by
name, `..`, a junction, a stream, a device name, the other separator, the mount
itself) refused by the helper; a lost answer asked again by its id and answered
as the first; a file and a folder found whole in the Recycle Bin; with the bin
turned off for the user, a delete refused and the file left. Not proven there:
OneDrive itself (none is signed in on the rig), so neither its own recycle bin
nor a cloud-only file, nor the helper on his desktop rather than over SSH.

### Signing in

Only he signs in, and nothing types a password or a code.
`work.office.vmSignIn` (operate; refused to a model caller) wakes the VM and
walks OneDrive's own sign-in to the one step that is his (`walkSignIn`): the
helper opens OneDrive's first screen with his address in its link (the
address Outlook on the web is signed in as on the box), presses Sign in,
Purdue's page asks for a passkey and Windows shows its security-key prompt,
which takes no click from a program of tcuser's and is sent away with Escape
from the machine's own keyboard (the keeper's `key`, QEMU's), then the walk
presses "Sign in another way" and "Approve a request on my Microsoft
Authenticator app" by the words on them (UI Automation, the helper's `ui.seen`
and `ui.press`, compiled only into the guest's build). A number is then on the
VM's screen for his phone, and the helper reads it off Microsoft's page
(`ui.number`: an element of the account broker's whose name is two or three
digits): the answer carries it (`number`) and its line says it, "Enter 42 in
Microsoft Authenticator on your phone.", so the row needs no Take over. The
answer names the computer (`vm:windows`) and says where the walk stopped; the
window opens the Computers page there. Once OneDrive is signed in, a second
press opens Word for Office's own sign-in (`walkOfficeSignIn`): its "Your
privacy option" page is closed, then whichever shows is pressed, the title
bar's Sign in, or for an account Word holds with an error File, Account,
"Fix me" (seen 2026-11-23); Microsoft's window then goes the way OneDrive's
does (the security-key prompt sent away, "Sign in another way", the
Authenticator choice, the number).

While he answers on his phone the host follows the sign-in for six minutes
(`followSignIn`), so that his one approval is enough: Microsoft's "Sign in
to all apps and websites on this device?" is answered "No, this app only"
within a second (Yes would register the VM as a device with Purdue, which
is his alone to choose; the price is a second number for Office); "Request
wasn't sent" (Microsoft sends no new request while an older one waits
unanswered on his phone, about four minutes) has its Next pressed every ten
seconds, and the walk then says `pending`, "deny it on your phone"; and Next
in OneDrive's own setup pages. A request that timed out unanswered is not
sent again by itself. OneDrive's watch goes on past its account: its tutorial
gets "Not now" ("Get the mobile app") and Next, and at its end "Open my
OneDrive folder"; then (or a minute after the account showed) the wanted
libraries are asked again at once (`resetSyncAsks`, then a read): OneDrive
ignored the sync link it was sent while the tutorial was open (2026-11-23:
RecWell arrived only when it was sent by hand seven minutes later). Office's
watch ends on Office's own state, licensed, not on OneDrive's account, which
is there from the start.

Found live 2026-11-22: the walk reaches the number in about ten seconds; he
approved one; the device question then waited about two minutes for an
answer, and the sign-in ended "AADSTS70008: The provided authorization code
or refresh token has expired due to inactivity" and "The credential is
invalid" (signin-expired-code.png in landed/F-vm-files), which is why the
follower exists. Purdue did not refuse the VM up to that point. Unproven: a
sign-in carried to its end, OneDrive's pages after it, and Office's
(F-vm-files.md).

## Where the files live (the Purdue rule)

University data may not be copied into an AI tool that is not cleared for it.
So the files **stay where OneDrive put them** and are read there, only when
asked: the Files view reads a folder when he opens it, a thread's read goes
to the Mac and back. Nothing is mirrored anywhere.

**Copy Teams files to <host>** (a Work workspace's page in Settings, kept in
`work_office_files` as `copy:<workspaceId>` on the workspace's own host) is
**on for a new Work workspace** (the owner's ruling, 2026-11-22: things work
by default, he turns them off): the office module's `workspaceCreated` hook
stores it when the workspace is made, so one he turns off stays off, and a
workspace made before reads as it was (nothing stored is off). Off, a file on another host than the workspace's opens in
its app on that host and never in a thread's canvas here. On, opening such a
file copies it (48 MB at most, checked before it downloads) into the thread's
own folder of this host's attachments
(`<userData>/attachments/teams-files/<sessionId>/<hash of its source>/`, a
root a remote key reaches) and opens the copy, a snapshot: a change to the
real file still goes through the Office tools on the host that has it. A
thread's copies are deleted with the thread (the module's `sessionsRemoved`),
and all of a workspace's when he turns the switch off.

The switch is the workspace host's; the file's host gives a file's bytes
(`filesRead {as: 'bytes'}`) only to another host of his over the host link,
never to a window or a remote key. Reading a file's **text** into a thread
(`teams_read`, `office_range_read`) is a read on request, not a copy: that
text is in the thread's transcript on the thread's host, whatever the switch
says.

## The fence

Every method that names a file takes it as a `{at: 'file'}` source on this
host, and every one passes `admitted` (`office/files/handle.ts`): the file's
real path lies in a library this host lists (`libraryOf`), so a link out of a
library or `..` is refused. Then by caller:

- this host's window and a thread here: the libraries alone;
- another host of his over the host link (`Caller.peer`, set by
  `servePeerWork`): the libraries alone, under this host's bridge policy for
  that host (Settings → Hosts);
- a remote key: also the listener's fence (`ctx.reaches`), as for any path, so
  a phone's key reaches a Teams file only under the app-managed roots; its
  search runs over the libraries it could name.

### Another host's file, from a remote key

His Mac's window reaches the box as a remote key. When a box workspace opens
a file his Mac holds (its copy switch on), the window sends
`work.office.filesThreads` and `work.office.filesCopy` to the box with the
Mac's own path (`~/Library/CloudStorage/OneDrive-…`). Until 2026-11-23 the
box's listener judged that path by the box's roots and refused it: "forbidden:
work.office.filesCopy is outside app-managed roots". `filesThreads` was
refused the same way, but the view swallows that error and reads it as "no
thread holds it". A place the box's Windows VM also holds opened from the VM's
copy, whose guest path the fence let by (`guestPath`). That is the likely
reason the first open worked and the next ones failed, the same file too: the
view opens a place from its first copy, and `placeGroups` ranks the VM's copy
below the Mac's while the VM's place is not `ok`.

The rule now (`elsewherePath`, remote/fence.ts): a path in a source whose
`host` is another host's id is that host's to fence, in the verbs
`ELSEWHERE_METHODS` lists, one at a time: `work.office.filesCopy` (the box
asks the named host for the bytes over the host link, `copyIn`, only a host the
workspace may use; that host holds the path to a library it syncs,
`admitted`), and `work.office.filesThreads`, `work.files.threads`, `tabOpen`,
`tabSet`, `star`, `seen` (each matches or keeps the source as words and
reads nothing). The listener passes its own id (`fenceRequest`'s `self`, the
id Work calls `ctx.host`), and a claimed host must be spelled as a host's id
is (`ENVIRONMENT_ID`, `env_` and 22 characters): no other word and no `:`, so a
mark kept as `<host>:<path>` never meets one of this host's. A copy lands
through no link: the owner's folder and the source's must be folders and the
file opens without following one (`writeCopy`). Every other path stays fenced: one with this host's
id, one with no host, one with no `self` given, and one in any other verb
(`work.canvas.*`, `filesList`, `filesRead`, `filesFetch`, `filesOpen`,
`work.files.list`, `stat`, `fetch`, `open`, every change), whatever host it
claims. Each path is judged alone, so a request that also names a path of
this host outside the roots is refused whole. Proven by fence.test.ts, the
"his window on the box" tests in files.test.ts, and live by
`scripts/e2e-files-open-remote.ts` (two instances under xvfb, a deck, a PDF
and a picture, then the deck again).

The Office tools take the same rule for a peer: a workbook, document or deck
in this host's libraries is reachable from another host's thread
(`office/index.ts`), and counts as one others can open, so an agent's own
idea is a suggestion and only a change he asked for in so many words is
written, a folder he added himself included (`office/tools.ts` `judged`).

## The wire

`work.office.files*` (the verbs are one word, so `ctx.peer` can carry them):

| Method | Needs | What |
|---|---|---|
| `filesLibraries {cached?}` | read | this host's libraries, his rows, the folders he turned off. With `cached: true`, uses the VM's last mounts without refreshing them |
| `filesList {source}` | read | one folder: folders first, then files, each `TeamsEntry` (name, path, kind, size, modified, local, by) |
| `filesSearch {query, library?, kind?}` | read | names holding every word, newest first, 200 at most, `more` past 20,000 folders |
| `filesFetch {source}` | read | downloads a cloud-only file; answers it as it is now |
| `filesRead {source, as}` | read | `text`, or `bytes` (base64, for a copy he allowed) |
| `filesOpen {source}` | operate | opens it in its app here: the Office carrier for a workbook, document or deck, else the system's opener |
| `filesSetRoots {roots}` | local | his edits: only this computer's own window |
| `filesCopyGet`, `filesCopySet {workspaceId, on}` | read, admin | the copy switch |
| `filesCopy {sessionId, source}` | operate | the copy, on the workspace's host, pulled from the file's host over the link, or out of this host's VM |
| `filesThreads {workspaceId, source}` | read | `{threads: {sessionId, itemId}[]}`: the threads of a Work workspace here whose open items show that file, newest first (`threadsHolding`) |
| `vmStatus {}` | read | Office and OneDrive in the VM as last read (`VmOfficeStatus`); never wakes it |
| `vmSignIn {account?}` | operate | his sign-in walked to his phone's number ("Signing in"); a person's |
| `vmSync {libraries}` | admin | the libraries OneDrive in the VM should sync; a person's |

`teamsKindOf`, `teamsAppOf` and `teamsCanvasOf` in
`src/shared/contract-work-office.ts` are shared by both sides: a workbook
opens as a sheet with Excel behind it (`{at: 'microsoft', app: 'excel'}`), a
Word file as a document (imported first, as every Word file is), a deck as
slides, a PDF as a pdf, a picture or video as media; a CSV, text or other file
opens in its app.

### Live Office addresses and memory

The host supports Word (.docx), Excel (.xlsx and .xlsm), and PowerPoint (.pptx) in shared Files tabs.
`office/live/address.ts` builds a file's web address from its OneDrive mount namespace, the synced namespace
of the same Files place on another machine, or the folder address saved in Settings, in that order.
It encodes each file path segment and adds `?web=1`. A sharing link or a library view page cannot serve as
a folder address. `cloudKey` matches direct paths with SharePoint's `/:w:/r`, `/:x:/r` and `/:p:/r` paths.
A `Doc.aspx?sourcedoc=…` redirect carries a GUID in place of the file path.

| Method | Needs | What |
|---|---|---|
| `work.office.live.of {workspaceId, tabId}` | operate | `{mode, address, why?, app, tenant, desktops}` for the tab's original file. Each desktop gives a source to pass to `filesOpen` and carries `vm: true` for a VM. |
| `work.office.live.libraryDefault {libraryId}` | operate | `{mode}` from the host that holds the library. The workspace's host can read it over the bridge for a copied file. |
| `work.office.live.setLibraryDefault {libraryId, mode}` | operate | Writes and returns `{mode}` on the host that holds the library. |

The workspace's host stores each file's choice in `work_office_live` by workspace and stable Files key.
That choice wins over the library's `live:<libraryId>` row in `work_office_files`. Libraries start in
`here` mode. Desktop choices use the Office apps reported on each machine, including the VM's last
status. The live address and mode are metadata for the Files control. This milestone leaves opening
and switching to the Files tab integration.

## Host ids

A workspace's desktops (`mayUseDesktop`) are host ids, as `ctx.peer` and the
tools read them. The window names its own machine `local`, so it translates
both ways (`hostIdOfLink`, `linkIdOfHost` in work/shell/actions.ts, over
`localHostId()`, the local host's `remote.status`): the Computer use switch
writes the host id (before this, a Mac's window wrote `local` for itself), and
the Files view reaches each desktop through its link. Each library the view
holds carries both: `host` (the host's id) and `env` (the link it came from).

The renderer's deadlines (lib/connection/transport.ts `LONG_WRITES`):
`filesFetch` 11 minutes, `filesCopy` and `filesSearch` 2 minutes. A thread's
call to another host is held to the link's 120 seconds, so `teams_open`
downloads nothing for a file it only opens in its app there.

## The tools

`office/files/tools.ts`, mounted with the office tools. A thread reaches the
libraries on its own host and on each host its workspace may use ("Computer
use on <Mac>"); a library's id is `<host>~<hash>`, so each call runs on that
host, here directly or through `ctx.peer`. A file is named by its library and
its place in it (`General/Budget.xlsx`), never by a path of the host.

- `teams_libraries`: each library's id, team, library, kind and channels, a
  place two machines hold listed once (`in: 'the Windows VM'` on the VM's);
- `teams_list {library, folder?}`, `teams_search {query, library?, kind?}`;
- `teams_read {library, file}`: the text above;
- `teams_open {library, file}`: on the thread's own host (or from a copy he
  allowed) the canvas beside the thread, and an Office file in its app too;
  elsewhere its app there. Answers the key the `office_*` tools take: writes
  go through them.

## The Files view

`src/renderer/src/work/office/` (`view.ts`, `FilesView.tsx`, the rules in
`files.ts`): the Files row after Docs in a Work workspace's column. It asks the
workspace's host and each desktop it may use (`filesLibraries`) and shows:

- the libraries as teams with their channels, his own files and added folders
  last (`libraryGroups`);
- a folder with crumbs (Files, the team, each folder), one 32px row per entry:
  its kind's glyph, name, a cloud mark while it is not downloaded, who last
  saved it (once the column is 560px wide), when it changed; on hover its
  menu: Open and Open in Excel (or Word, PowerPoint, the file's app);
- the header's search over every library, each hit with its place.

**One place, once.** A row is a place (a team's channel, a library, his own
files, a folder he added), and the same place on two machines is one row:
`teamsPlaceKey(team, label)` in the contract ("RecWell-TeamRecWell", a
folder of the RecWell site's Documents a Mac syncs by itself, is "RecWell" +
"Team RecWell" in the VM's whole library; his own files on two machines are
`mine`; a folder he added is never merged). A merged row is drawn under the
team of a copy that names team and folder apart (the VM's library), so a
Mac's one-word folders read as that team's channels; a Mac-only layout looks
as before. Its copies (`{library, folder}`, the folder that is the place's
top on that machine) are read in order: the workspace's own host first while
its place answers (a VM library there needs no Mac), then a desktop's. A
folder is carried across copies as its parts below the row's top (split on
either separator, joined with the copy's own: `pathIn`). A read that fails
because the machine is out of reach (`unreachable`: the link is down, a
time-out, "could not wake") goes to the next copy at the same place; a
refusal about the folder itself is shown at once. One listing is always one
copy's. A search asks each host once and keeps each place's hits from its
first copy whose host answered, so no file is listed twice. A library in the
VM (`vm`) is listed only while the workspace's `windowsVm` is on.

**When nothing is listed** (`filesNote`, files.ts), the view says the one
most useful thing, checked in this order, with its press:

| Cause | It says | Press |
|---|---|---|
| the workspace's host refused, nothing else answered | "Files did not load", the refusal's words | Retry |
| it may use no desktop and no VM, and one could help | "This workspace can't use your computers yet" / "Allow <MacBook> and the Windows VM to list your Teams files." | Allow: his desktops this window knows (`allowComputers`, work/shell/actions.ts) and the VM where the host has one, then lists |
| a machine it may use did not answer | "<MacBook> did not answer", on the state line | Retry |
| OneDrive in the VM is signed out | "OneDrive on the Windows VM is signed out" | Sign in to OneDrive: `work.office.vmSignIn`, then the Computers page on `vm:windows` (work/winvm/signIn.ts) |
| the VM is the only place and is not set up | "The Windows VM is not set up" | Open Settings (Settings → Work) |
| a place answers with no Teams library | "No Teams files on <MacBook>" / "Sync a channel from Teams with OneDrive there." ("OneDrive is not signed in on <MacBook>" where it has none; for the VM, Open the Windows VM) | — |
| a place could not be read | "Teams files on <machine> did not load", its detail | Retry |
| an older host that says nothing of its places | "No Teams files" | — |

With rows listed, a machine that did not answer is the state line over them,
unless the VM holds copies (then it goes unsaid); OneDrive signed out in the
VM is one quiet line under the rows with Sign in to OneDrive; and a VM whose
helper did not answer its last read is the state line, "The Windows VM did
not answer" with the failure's words, over the libraries it kept.

**Each host paints as it answers** (`useReach`). Every host is asked at once,
each with its own deadline (`HOST_DEADLINE_MS`, 4 s, `byDeadline` in
files.ts); one past it is a machine that did not answer (the state line, with
the view's Retry). While nothing is listed and a host is still to answer, or
the VM's first read is under way (`vmReading`), the view holds its bones, so
the empty state never shows first; with rows listed, two bones under them
stand for what is still coming. A host's `work.office.files` push asks that
host again, its last answer kept on screen until the new one lands; while its
VM is `reading` it is also asked again every 5 s, in case the push is missed.
The search asks every host at once too and shows each one's hits as they
come, with bones under them for the rest, under a 20 s deadline
(`SEARCH_DEADLINE_MS`: the VM walks its disk for up to 15 s); it fails only
when no host answered.

Opening a file (`openWay`): a cloud-only file shows Downloading… in its row
first, then Opening…. **The file takes the pane**: it opens through the
canvas store's `openItem`, shown and selected at once, with the thread
folded away beside it (`setFolded`), its conversation toggle one press away;
never a new chat's empty composer first (`showFile`, FilesView.tsx). **One
file, one thread**: the workspace's host first answers
`work.office.filesThreads {workspaceId, source}` (`threadsHolding`,
files/handle.ts), the threads whose open items show that file, newest first:
the file in place, its Office app's file, the copy he allowed (by its
folder, the hash of the source), or the `.tcdoc` a Word, OpenDocument,
RTF, markdown or text file became beside it (`Name.tcdoc`, `Name 2.tcdoc`,
the importer's spelling, the folder read through its links), and only one
whose sidecar records that file as its source (`source.name`, written by the
importer): a document of his that merely shares the name is another file, and
its thread is never picked for Ask. Only open items
count, however many closed ones changed since. A file in the Windows VM is
named by the guest's path, so the method is one of the listener fence's
Teams files verbs (`GUEST_METHODS`, remote/fence.ts). Reusing a thread whose
item is Excel's, Word's or PowerPoint's brings that app forward again. The first of them this window knows and that is not archived is
shown again with that item, and nothing is copied or made; a host from
before the method answers none. Otherwise, on the workspace's own host it opens in a new thread of
the workspace, titled for the file, in that thread's canvas (and an Office
file in its app, which stands behind the item), the thread made only once
everything else worked; with the copy he allowed, from the copy, and a thread
whose copy failed is deleted again; otherwise in its app where it lies, which
downloads it itself. A file in the Windows VM never opens in the canvas on its
own host: as a copy he allowed, else in its app in the VM (seen on the
Computers page); a read of one may wake the VM, so its reads wait up to two
minutes. A failure is one toast.

## Settings

Settings → Work, "Where it runs": **Teams files** for each Mac or Windows host
with Work on (`TeamsFilesRow`): each library found or added, by team, with its
folder; a found one has a switch, an added one Remove. Add web link… stores
the address. Live Office uses a direct web folder address. Add folder… adds
a folder it missed. Only this computer's own window edits its list; another host's rows
are read only. A Work workspace's page has **Copy Teams files to <host>**
(`TeamsCopyRow`) once it may use a desktop other than its own host.

## Tests

`office/files/files.test.ts` builds a dummy CloudStorage (his OneDrive, a
team's Documents with two channels, a site's other library, a sparse file for a
cloud-only one, a link out, zips for the Office files) and proves the finder,
the list, search, the fence by caller, download, text, open, the canvas kinds,
the tools from a box thread through a stand-in peer, the copy only where
allowed, and the shared-file rule on a folder he added. `office/vm/vm.test.ts`
proves the list answers at once while the helper never answers, one read
behind it at a time, the failure as the place, the push only on a change, and
a thread waiting for the first read; `office/health.test.ts` the same for
Connections. The renderer:
`files.test.ts`, `FilesView.dom.test.tsx`, `TeamsFilesRow.dom.test.tsx`.

Not provable until he signs in to OneDrive on the Mac: real folder names, the
dataless flag on a real library's files, and who last saved a file there. The
steps are in the finding's last section.
