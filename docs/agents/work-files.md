# Work: the Files place

The `files` pillar (id 54): one place in a Work workspace for every file he
works on, wherever it lives. The plan is
`.temp-code/plan-jjspQsZklEYR.md`; the design pages are under
`.temp-code/prototypes/work-files-final/`.

**What is built so far (F0, the ground).** Nothing is on screen yet. The Files
row still opens the office pillar's Teams view
([work-teams-files.md](work-teams-files.md)), over the old wire
(`work.office.files*`), which this pillar does not change. What exists:

- the grammar both sides share (`src/shared/work/files.ts`);
- the wire, `work.files.*` (`src/shared/contract-work-files.ts`): the reads,
  the tabs and the marks answer; every verb that changes a file passes the
  door and then says it is not built;
- the Files pane as an owner of canvas items (a file open in a tab with no
  thread);
- the one door for every change, safe writes and the operation journal, with
  no verb calling them yet;
- two places: the workspace's folder, and Teams and OneDrive over the office
  pillar's finding.

Each later milestone adds to this file what it makes true.

## The model

**A file has one home: a place.** A lens shows files from several places and
is never a home (`isHome`, `PLACE_KINDS`).

| Place | Kind | Its folders | Who else sees it |
|---|---|---|---|
| The workspace's folder (named for the workspace) | `folder` | real folders | only him and his threads |
| My OneDrive | `onedrive` | real folders | whoever he shared with |
| A channel of a team, a site's library, a folder he added | `teams` | real folders | everyone in that team |
| Recent, Starred | `recent`, `starred` (lenses) | none | as their homes |

LifeOS, Google Drive, From mail, Made by threads, Home, a project's lens,
Trash and search are named in the grammar and arrive with their milestones;
asked for today they answer "That place is not read by this build yet."

A team's Documents library is several places, one per channel
(`placesIn`, `files/places/teams.ts`), as the Teams view always drew it. A
place two computers hold has one `key` (`placeKey`: "RecWell-TeamRecWell" on
a Mac is "RecWell" and "Team RecWell" under Windows), so the window draws it
once.

**Names and keys** (`src/shared/work/files.ts`):

- `FileEntry` is one row: `ref` (a `CanvasSource`, for a file) or `folder` (a
  `FolderRef`, for a folder), its `name`, its `kind` (`ENTRY_KINDS`), and
  what the place knows: `size`, `changed`, `local` (false: its bytes are in
  the cloud), `shared`, one `state` at most, `starred`.
- `FolderRef` names a folder to list: `{ at: 'file', host, path }` (the tag
  the listener's fence reads wherever it sits, so no method has a param named
  `path`), `{ at: 'drive', … }`, `{ at: 'project', id }`, or
  `{ at: 'place', id }` for a place's top or a lens.
- `refKey(ref, lib?)` is the one stable key of a file: what a star, a recent
  and a tab hold. For a file in a library it is the place's key and the path
  inside it (`lib:esportsstaffgeneral:Budgets/2026.xlsx`), so a star is one
  star whichever computer answers.
- `kindOfEntry(name, mime?)` is the one table of file types: a name's kind
  and the canvas kind that opens it. The canvas registry (`kindForFile`), the
  Docs finder (`kindOfFile`) and the Teams view (`teamsCanvasOf`,
  `teamsKindOf`) all read it, and registry.test.ts holds every kind's
  `opens.ext` and `opens.mime` to it both ways. The name decides; a type a
  desktop or a mail gave is read only for a name with no extension. Until the
  `file` kind lands (F1b), `.md` and `.txt` open as a document where the file
  is his own, and in their own app in a library; sound opens in its app in a
  library until F3.
- `nameProblem`, `freeName` ("Untitled document", then "Untitled document
  2"; a file put back beside one of its name is "Name (restored)").
- `compareEntries`, `sortEntries`, `groupEntries`: folders first, then the
  sort, then the name, in one fixed locale, so the host's pages and the
  window's order agree.

## What a place lets a hand do

`refusal(place, verb, entry, to)` is the table below as code, with each
refusal's one sentence and its one press; `canDo` is a refusal that is null;
`questionFor` is what his window asks before a change others will see. Both
sides read them, so a menu never offers what the host will refuse.
`files.test.ts` holds every row and every sentence.

| Act | His own places | A place others can open | Mail |
|---|---|---|---|
| Rename, move within the place | at once | at once (his own hand) | "A mail's file is read only. Keep it first." Keep |
| Copy in from elsewhere | at once | asked once: "Copy to Esports Staff? Everyone in that team can open it." | — |
| Copy out, or move out | at once (a move is a copy, a check, then the source to Trash) | "Teams files stay in Teams." Open it here | Keep copies it to the workspace's folder |
| Delete | to Trash | "Delete it in Teams." Open on the web, until the provider's bin is proven; then "Delete for everyone?" first | — |

More refusals: a LifeOS document moved out ("A LifeOS document lives in
LifeOS. Export a copy instead."), a LifeOS delete ("LifeOS cannot put a
document back yet. Delete it in LifeOS."), a Google file moved across ("A
Google file lives in Google Drive. Export a copy instead."), a file over 48
MB from another computer ("This file is over 48 MB, too big to copy from
MacBook."), a computer out of reach ("MacBook is out of reach." Retry), a
file a thread is writing in ("A thread is writing in this file. Try when it
is done."), a place in the Windows VM ("Files in the Windows VM cannot be
changed from here yet. Open it there."), a lens ("Trash only shows files.
Change one where it lives."), and the 33rd open file ("32 files are open.
Close one to open another.").

A place's `can` lists the verbs its adapter carries out. **Today every
place's `can` is empty** (`FOLDER_CAN`, `LIBRARY_CAN`): the verbs land with
F2, and the Windows VM's with F8.

## One door for every change

`files/policy.ts`, landed before any verb. `locate(ctx, by, workspaceId, ref,
method)` resolves a file or folder against the caller's own workspace, by its
real path: it must lie in that workspace's folder or in a library of this
host (a link out, or `..`, leaves both); a file in the Windows VM must lie in
a library OneDrive syncs there. `admitWrite(by, change)` then holds each
caller to its row. The grammar's own refusal comes first for every caller.

| Caller | His own place | A place others can open |
|---|---|---|
| this host's window | yes | yes, after the window's own question (`asked`) |
| a remote key (a phone, a far window) | with `operate` | only with `approve`, and asked the same question |
| a thread (`model`) | refused until F5 ("A thread cannot change files through Files yet."); then at once, with a results row and Undo | never: it becomes a held `file.act`, whatever it says he asked |
| another host of his (`peer`) | only with where the change began (`origin`): a window's press there, still asked its question, or a held act's id and the digest of exactly this change (`changeDigest`) | the same |

`sharedOf(ctx, source)` answers whether others can open what a source names,
for this pillar and for every other Work tool that writes a file by path: a
file in a Teams or OneDrive library (this host's or its VM's), a Microsoft
file by its address, a Google file, a file on another host, and a file in any
cloud folder of this computer that is no listed library (the host cannot
tell). A file anywhere else on this disk is his own. The sheets view, the
importer and the Teams copies ask it; a pane owner has no scope row to ask.

**What the door does not catch.** The shell and general computer use are
outside it, as they are outside the hold. The Work preamble's line on files
in shared places (F5) is a rule, not a fence.

## Writing safely

`files/write.ts`, proven against races in `write.test.ts`. No verb calls it
yet.

- A name is one path component on every computer a place may be on
  (`checkName`, over `nameProblem`).
- Both ends of a move or copy are admitted by their real path (`admitPath`),
  and every descendant of a folder (`admitTree`). A link is never followed
  and never copied.
- Nothing is ever replaced. A file is made with exclusive create; a rename or
  move lands by hard link then unlink, or a checked exclusive copy where the
  volume has no hard links; a folder is moved onto a folder made exclusively
  for it. A taken name answers "A file named "x" is already there."
- Across volumes a move is a copy, synced to disk and read back (size, and
  sha256 for a file of 64 MB or less), then the source removed; a folder over
  2 GB is refused. A copy that fails its check is removed and the source left
  as it was.
- A folder swapped for a link between the check and the write is caught: the
  real parent is resolved again just before and just after each write, and
  what landed outside is taken back.
- `withFileLocks(keys, fn)`: saves and verbs on one file run one at a time
  (by `refKey`, in this process); `fileLocked` is what "A thread is writing
  in this file" reads.
- `runOp(db, { id, workspaceId, verb, refs }, fn)` is the journal behind
  operation ids (`work_files_ops`): the same id again answers what the first
  did and does nothing twice; a failed run is kept and answers its sentence
  again. Rows left running by a dead process are marked failed at the
  module's start (`settleOps`), and rows past a week go (`pruneOps`).

Still open, and said here plainly: Node has no `openat`, so a folder swapped
and swapped back between a write and its check can go unseen; on Windows a
folder move removes its empty target before the rename, a small window in
which another writer can take the name; Windows has no `O_NOFOLLOW`, so a
source link is caught only by the walk's `lstat` before the copy.

## The wire

`work.files.*`, in `src/shared/contract-work-files.ts`: a schema, a
capability and a relay row for every method. Verbs are one word, so
`ctx.peer` carries them. `relay: screen` means carried to a far host only
while its screen is unlocked.

| Method | Needs | Relay | Today |
|---|---|---|---|
| `places {workspaceId}` | read | yes | this host's places and their state, `rev` (the tabs' revision) and `sources` (what stands between each source of Teams files and him). Never waits on a VM |
| `list {workspaceId, at, cursor?, sort?, foldersOnly?}` | read | yes | one folder or lens, 500 entries and 512 KB a page at most; a folder that changed between pages answers `stale`. The first page carries `place` and `trail` |
| `stat {workspaceId, refs}` | read | yes | the rows again with who last saved an Office file, 100 at most; null for one gone or out of reach |
| `threads {workspaceId, ref}` | read | yes | the workspace's threads whose open items show the file |
| `fetch {workspaceId, ref}` | read | screen | downloads a cloud-only file on its own host |
| `tabs`, `open`, `tabOpen`, `tabClose`, `tabMove`, `tabSet` | read; operate | yes | the tabs and their items (below) |
| `star {ref, name, on}`, `seen {ref, name}` | operate | yes | his marks |
| `make`, `rename`, `move`, `copy`, `trash`, `upload` | operate, and `approve` where others can open the place | screen | located and passed through the door, then "Files cannot … yet" |
| `restore`, `purge` | operate; approve | screen; never | the workspace's own rows; not built |
| `home`, `names`, `search`, `searches`, `saveSearch`, `dropSearch`, `read`, `preview`, `thumbs` | | | declared; not built |
| push `work.files {workspaceId, at?, tabs?, places?}` | | | a folder a tab shows changed (`at`: its key; sent with `{ path }`, so a key that could not name the folder never hears of it), or the tabs changed (`tabs`: their new revision; a client asks for the list again) |

Every change takes an operation id (`op`), and may carry `asked` and
`origin` (the door's table).

**A host a release behind** answers `work.files.*` as an unknown method. The
window probes each host once with `places` and reads one that cannot answer
through the old wire (F1a's adapter).

## A tab

The open tabs belong to the workspace and are kept on its host
(`work_files_tabs`, `files/tabs.ts`), so they are there after a restart, in
a second window and on every client. One ordered list holds page tabs (a
folder or a lens) and file tabs.

- It changes by one verb a change, each one transaction under a
  workspace-wide revision (`work_files_revs`), said once as a push.
- A file tab is a canvas item owned by the workspace's Files pane,
  `filespane_<workspaceId>` (`filesPaneOf`, beside the Mail view's
  `mailPaneOf`). Opening a file makes no thread. The item is opened and
  closed inside the tab's own transaction (`CanvasStore.inside` holds the
  canvas's pushes until it lands), so the two can never disagree; at the
  module's start `check` drops a tab whose item is gone and an item whose
  tab is gone.
- A pane item is **deleted** when its tab closes, with what every kind kept
  for it (`WorkModule.itemsRemoved`, below). Nothing is left behind for
  every file he ever opened.
- A file opens in a tab of its own beside the tab it came from (`opener`),
  and never twice: opening it again answers its tab (`tabOf`, by the file's
  key).
- 32 file seats at most (`CANVAS_OPEN_MAX`); the 33rd is refused in one
  sentence and nothing is written.
- The last tab closed becomes the workspace's folder.
- An item that takes another's place (`CanvasStore.replace`: a Word file
  opened as a document becomes the `.tcdoc` made of it) is followed by its
  tab (`TabStore.follow`); the tab's key stays the file he opened.
- **One file, one writer of its marks.** A PDF's marks, a deck's review
  state and a picture's notes are kept by item, so a file of those kinds
  that a thread already holds is not given a second seat: `open` answers
  `held: { sessionId, itemId }` and the window shows that thread's item.
  F3 keeps a PDF's and a picture's marks by the file and lifts this for them.
- The host picks the canvas kind by the file's name; `as` overrules it (Open
  as a document). A library's Office file opens with its app behind it
  (`teamsCanvasOf`). A file no canvas shows answers "x opens in its own
  app." A file in the Windows VM is no file of this disk: it opens as a copy
  or in its app there, by the window's open rules (F1a).

Which tab is selected, and each page's shape, sort and scroll, are each
window's own (F1a).

## What a pane owner changes for every kind

A pane owner is no session: `ctx.scopeOf(owner)` is null, and whoever acts
on its items is his own window.

- `CanvasStore.forWorkspace` leaves pane owners out in its query, before its
  limit, so a row of open tabs never pushes a thread's item out of the Docs
  finder or `threadsHolding`; a tab is never listed as a thread.
- `WorkModule.itemsRemoved(items, ctx)`: items were deleted outright (a
  Files tab closed, or a deleted workspace's panes went). Each pillar that
  keeps rows or files by item drops them: pdf, media, meetings, forms,
  dashboards, slides, frameio, and the office pillar's copies.
- Sheets ask `sharedOf` for a pane's item, and `createSheet` takes a pane
  owner's workspace for its sector.
- The importer takes a pane owner and swaps items through
  `ctx.canvas.replace`.
- A Teams file copied for a tab lands under
  `attachments/teams-files/filespane_<workspaceId>/`, and goes when its tab
  closes, when Copy Teams files is turned off and when the workspace goes.
- A remote key sees no name of a tab's file it could not list: the item's
  path, name and title are cut (`fencedItem`), and `tabs` leaves the tab out.

## What sits where, and what is backed up (the Purdue rule)

University data may not be copied into an AI tool that is not cleared for
it. So:

- Tabs, marks and (later) Trash rows on the workspace's host hold the
  **names and places** of files, Teams files among them, as
  `work_canvas_items` and the transcript already do. They ride the nightly
  backup with the database.
- **No bytes and no picture of a Teams file are kept anywhere by Files.** A
  list, a stat, a star and a recent never read a byte of a file its place
  keeps in the cloud (`reads.test.ts` watches every way this process opens a
  file).
- **An import never writes beside a shared file.** A Word, OpenDocument,
  RTF, markdown or text file that lies in a place others can open becomes
  its `.tcdoc` under `<userData>/work-files/imports/<hash>/`
  (`files/imports.ts`), never in the library, where OneDrive would sync it
  to the team. This holds for every opener, a thread's `canvas_open`
  included. That folder holds a copy of the file's words on this host; it is
  the same copy the import made beside the file before, now kept out of the
  library.
- A copy he allowed (Copy Teams files, on by default for a new workspace)
  lives under `attachments/teams-files/` and is deleted with its thread or
  its tab.

Tests of any Purdue path use dummy files. No build thread contacts a Purdue
system.

## Each place, behind one adapter

- **The workspace's folder** (`places/folder.ts`) and **a library on this
  disk** (`places/teams.ts`) are listed through `DiskLister`
  (`places/disk.ts`): a folder is read as a stream of names (`opendir`),
  kept 5 s, and cut into pages by a keyset cursor (the last row's sort key
  and name, bound to the folder, the order and the folder's version). Sorted
  by name or kind, only the page's rows are looked at closer (`lstat`);
  by time or size, every row is, in batches of 64. Hidden names, Office's
  lock files and every link are left out. A `.tcdoc` is one file, one row.
- A folder a tab shows is watched (`fs.watch`, 64 at most, dropped after 10
  idle minutes); a change drops what was kept and is pushed once per burst.
  Where a disk gives no watch, the window lists again when it comes back.
- **Teams and OneDrive** read the office pillar's own finding
  (`librariesOf`), kept for one burst of calls (2 s,
  `places/libraries.ts`), since a page, each row's fence and a `stat` all
  ask within a moment. Who last saved an Office file left the list for
  `stat`, which reads it only from a file whose bytes are already here.
- **The Windows VM**: `places` answers from what was kept and reads behind
  the answer; its state is `asleep` with the time it was read. A folder
  there is listed whole by the guest's helper (it wakes the VM, as it always
  has) and cut into pages here (`vmPage`).

## The fence, by caller

| Caller | Reaches |
|---|---|
| this host's window | every place of the workspace on this host; for a workspace that lives on another host, this host's libraries |
| a thread (`model`) | its own workspace's places (a Work Chat none); the VM only where its workspace turns it on; never the tabs, the marks or `open`; no change until F5 |
| another host of his (`peer`) | the libraries alone, under this host's bridge policy; no tab, no mark; a change only with its origin |
| a remote key | what the listener's fence lets it name (`ctx.reaches`, by the real path): the workspace's folder, and the VM's libraries by the guest-path rule. A Mac's own libraries stay out of a key's reach |

The listener passes a guest path (`C:\Users\…`) only to the verbs
`GUEST_METHODS` lists (`remote/fence.ts`): `list`, `stat`, `fetch`, `open`,
`threads`, `tabOpen`, `tabSet`, `star`, `seen`, one verb at a time and never
a verb that changes a file. Each path is judged alone: in one request a
guest path passes and a path of this host outside the roots still fails;
the handler then holds the guest path to a mount OneDrive names.

An answer to a remote key is cut to what it could name: a tab that stands
on, or holds, a file of this host out of its reach is left out; so is such a
mark. A tab that stands on another host's folder is kept whole: only its
address is held here, and that host fences it when it is listed.

## The seam with the editor builds

`.temp-code/plans/editors/FILES-SEAM.md` is the agreement. What a kind's own
pillar calls, all landed:

- `shell.saved({ state, at?, where?, pending?, detail?, actions? })` from
  its `Body` (work-canvas.md): kept in `feeds.saved`, drawn nowhere until
  F1b.
- `registerFileMaker`, `registerFilePreviewer`, `registerFileMoved`
  (`files/hooks.ts`): three registries of their own, which no module's
  start touches, so a registration made before or after the files module
  starts is kept.

One change was made in the slides build's folder beyond the three the seam
names: `slides/index.ts` and its store take `itemsRemoved`, so a deck's rows
go with its tab.

## Performance

`bun run script:bench-files` (scripts/bench-files.ts) makes a dummy library
(one folder of 5,000 files and 20,000 across 400 folders, every tenth one
sparse so it reads as cloud-only), and measures the real wire through the
module: the median of five runs, on two pinned cores. On the box, a local
disk, 2026-11-23:

| What | Budget | Measured |
|---|---|---|
| `places`, from what was kept, the VM asleep and its helper down | 50 ms | 0.2 ms |
| the first page of a 5,000-entry folder, cold | 400 ms | 15.5 ms |
| the same, warm | 150 ms | 0.8 ms |
| a page after it | 50 ms | 0.5 ms |
| the first page by time, cold (every row is looked at) | | 27 ms |
| a look at 100 rows again (`stat`) | | 11 ms |
| a folder of 400 folders, cold | | 2.5 ms |

Not measured yet: a real OneDrive folder on the Mac (a cold File Provider
folder is expected to be slower), a Mac's library listed from a window
through the box's link (budget 1 s), a search by name over 20,000 files
(budget 2 s; F4), and a scroll through 5,000 rows in the window (F1a).

## Tests

- `src/shared/work/files.test.ts`: the kind table, keys, names, order and
  groups, every row of the verbs table and every refusal sentence.
- `files/policy.test.ts`: where a ref lies for each caller, what is shared,
  each cell of the door's table.
- `files/fence.test.ts`: the fence by caller with raw requests through the
  module: a key naming another workspace's folder, a cut answer, a cursor
  from another caller, the guest-path rule verb by verb, and the door in
  front of every verb.
- `files/wire.test.ts`: places, list, stat, the tabs and their items, the
  boot check, marks, threads, fetch, a deleted workspace.
- `files/reads.test.ts`: no read of a cloud-only file.
- `files/places/disk.test.ts`, `places/teams.test.ts`: the listing and the
  places, the Windows VM through a stand-in helper.
- `files/write.test.ts`: names, the fence, nothing replaced, a swapped
  folder, a second writer, locks, the journal.
- `files/hooks.test.ts`, `files/module.test.ts`: the registries and the
  mount.
- `canvas/filesPane.test.ts`: the pane owner in the canvas store.

## Unproven

- Everything here ran against dummy folders on the box. Nothing has listed
  his real OneDrive through this wire yet; the Files row does not use it
  until F1a.
- What OneDrive does with a rename, a move or a delete made through its
  synced folder on his account. The verbs are not built, and a delete in a
  shared place stays off until a live proof on an account that is not
  Purdue's shows the provider's bin holds a file, a folder and a cloud-only
  file.
