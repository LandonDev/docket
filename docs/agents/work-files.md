# Work: the Files place

The `files` pillar (id 54): one place in a Work workspace for every file he
works on, wherever it lives. The plan is
`.temp-code/plan-jjspQsZklEYR.md`; the design pages are under
`.temp-code/prototypes/work-files-final/`.

**What is built: every milestone of the plan, F0 to F9.** The Files row
opens this place, in the Teams files view's and the Docs view's stead. The
office pillar's Teams view ([work-teams-files.md](work-teams-files.md)) and
the docs pillar's view ([work-docs.md](work-docs.md)) are gone; their wires
(`work.office.files*`, `work.docs.*`), tools and Settings rows stay. What
exists, each under its heading below:

- the grammar both sides share (`src/shared/work/files.ts`, and
  `filePlaces.ts` for a library's places);
- the wire, `work.files.*` (`src/shared/contract-work-files.ts`);
- the Files pane as an owner of canvas items: a file open in a tab with no
  thread, a second file at a tab's side, a window's Beside seat ("A tab",
  "The screen");
- the one door for every change, safe writes and the operation journal;
- New, rename, move, copy, Trash and uploads in the workspace's folder and
  in a library on this host's own disk, carrying what hangs on a file;
- the same verbs in a library of the Windows VM, through its helper ("The
  Windows VM's verbs"); a delete there is built and off;
- LifeOS as a place with its projects as folders, From mail, each project's
  lens, Add to a project ("LifeOS, From mail and Projects");
- a Google Drive per Google account of the workspace, the narrow form
  ("Google Drive");
- search across places, Go to, Home and saved searches, which are the Docs
  view's saved views ("Search and Go to");
- previews and thumbnails made on the file's own host, a zip's listing,
  and PDF marks and media notes kept by the file ("Previews", "An
  archive's listing", "Marks kept by the file");
- the screen (`src/renderer/src/work/files/`): the sidebar, the tabs, a
  folder in five shapes, Quick Look, a file open as itself, its docked chat
  ("The screen");
- the agents' side: the `files_*` tools, the held `file.act`, the made-by
  marks, the older doors, the `file` chip and `@`, waiting counts
  ("Agents");
- the phone's Files page ("The phone").

What is not proven, and why, is the last section ("Unproven").

## The model

**A file has one home: a place.** A lens shows files from several places and
is never a home (`isHome`, `PLACE_KINDS`).

| Place | Kind | Its folders | Who else sees it |
|---|---|---|---|
| The workspace's folder (named for the workspace) | `folder` | real folders | only him and his threads |
| My OneDrive | `onedrive` | real folders | whoever he shared with |
| A channel of a team, a site's library, a folder he added | `teams` | real folders | everyone in that team |
| Recent, Starred | `recent`, `starred` (lenses) | none | as their homes |
| A Google Drive (one per Google account of the workspace) | `drive` | Drive folders | by each file's own sharing |
| Trash | `trash` (a lens) | none | him |

Made by threads (`made`, a lens) lists what threads made ("Agents"). LifeOS
(`lifeos`, a place), From mail (`mail`, a lens) and each active project's
lens (`project`) are read now ("LifeOS, From mail and Projects", below), and
so is a Google Drive (`drive`, a place per account, "Google Drive").

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
  docs pillar's finder (`kindOfFile`) and the Teams view (`teamsCanvasOf`,
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

A place's `can` lists the verbs its adapter carries out. The workspace's
folder (`FOLDER_CAN`) carries out `make`, `upload`, `rename`, `move`, `copy`,
`edit`, `trash`, `restore` and `purge`. A library on this host's disk
(`LIBRARY_CAN`) carries out `make`, `rename`, `move`, `copy` and `edit`: a
delete there is refused "Delete it in Teams." and an upload "Nothing can be
uploaded in General from here." A library in the Windows VM carries out
what its helper says it has (`vmCanOf`, "The Windows VM's verbs" below):
`make`, `rename`, `move` and `edit`; `trash` waits behind `VM_TRASH`, off until
a real OneDrive's own bin is proven to hold what is deleted, so a delete there
is refused "Delete it in Teams."; a helper
built before F8 lists nothing, so its places' `can` is empty and every change
there is refused "Files in the Windows VM cannot be changed from here yet.
Open it there." A Google Drive (`DRIVE_CAN`) carries out `make`, `rename`,
`move`, `trash` and `restore` (Drive's own bin); a copy and an upload there
are refused in the grammar's sentence ("Nothing can be copied in <account>
from here."). The
Trash lens's own `can` is `restore` and `purge`.

## The screen

`src/renderer/src/work/files/`; the look is docs/DESIGN.md "The Files
place". The view's chunk is `work-files-view`, lazy, and nothing of it is in
the first paint.

- `model.ts` holds the window's own rules, tested alone (`model.test.ts`):
  one sidebar from every host's places (`sidebarOf`: a place two computers
  hold is one row, read from the workspace's own host first while it
  answers; a team with several channels is one row whose page lists its
  channels from what was already read, no host asked), where a file opens
  (`openWay`), the one line said when Teams files are missing (`teamsNote`,
  the Teams view's own table) or a place is not simply there (`placeNote`),
  and what a host a release behind still answers.
- `store.ts` reads the hosts (`useReach`: the workspace's own, then each
  desktop it may use, each painting as it answers, 4 s before one is said
  not to answer), keeps the tabs as the host says them (`useTabs`: the list
  again on each `work.files` push that names a new revision), lists folders
  a page at a time (`useListing`: more as the list nears its end, again from
  the top when the host says a name changed or answers `stale`), and keeps
  what only this window knows in `localStorage` `work.files.view.v1`, under
  a window id kept in `sessionStorage`: the tab shown, the sidebar's fold,
  each page's order and row size. A window with nothing kept starts from
  what the last window wrote.
- `FilesView.tsx` is the frame and the sidebar; `TabRow.tsx` the tabs;
  `Page.tsx` a page's bar, its list (`VirtualRows` past 80 rows), its
  selection, its menus and its states; `Shapes.tsx` Grid and Columns;
  `Looks.tsx` Gallery, Beside and the details pane; `Preview.tsx` a file
  drawn read only and `QuickLook.tsx` the layer that shows it, over
  `previews.ts` (the pictures asked of a host); `rowParts.tsx` what every
  shape shares for a row (a press, a name typed in place, the one state, a
  drag); `acts.ts` the verbs, each asked of the file's own host;
  `MoveDialog.tsx`; `GoTo.tsx` and `Home.tsx`; `FileTabView.tsx` a file's
  header over the kind's own `CanvasPane`, its second file (`SideFile.tsx`)
  and its docked chat (`Dock.tsx`, `dockThread.ts`); `KindGlyph.tsx` a
  kind's glyph in its tint; `chords.ts` and `bindings.ts` the keys.
- An empty place gets its first tab from `tabOpen {first: true}`: the host
  makes it only while there is none, so two windows that open the place
  together make one tab between them.

**Opening a file** (`open.ts` `openEntry`):

| The file | Opens |
|---|---|
| on the workspace's host, a kind a canvas shows | in a tab (`work.files.open`); a cloud-only file is fetched first, its row saying "Downloading…"; a library's Office file is opened in its app first, which then stands behind the item |
| on another computer of his, or in the Windows VM | in a tab, as a copy the host makes in the pane's own folder (`openCopy`), where Copy Teams files is on. The tab's header says "A copy from MacBook. Changes stay here", with Open on MacBook. The copy goes when its tab closes |
| the same, with Copy Teams files off | refused in one toast, "Teams files open on MacBook for this workspace.", whose press Open copies here turns the switch on and opens it, and whose other press opens it on that computer |
| a kind no canvas shows, in a library | in its own app on its computer (`work.office.filesOpen`) |
| a kind no editor shows (a text or code file, a sound, a zip, anything else) | in a tab, as the `file` kind: text in an editor that saves as he types, a sound with Play, a zip as the list of what it holds, the rest as its facts with Download |
| a deck a thread already holds, or a PDF or picture whose tab would be a copy of another computer's file | in that thread, folded (`held`): its marks are kept by item |
| a PDF or picture on this computer a thread already holds | in a tab: the tab and the thread share its marks, kept by the file ("Marks kept by the file") |
| anything, where the workspace's host keeps no tabs | as before tabs: in a new thread's canvas, the thread folded away |

**A folder's shapes** (`PAGE_SHAPES` in model.ts; the window keeps each
folder's own, `PageLook`). List; Grid (tiles at 96, 144 or 208px); Columns
(a column a folder from the place's top down, asked of the host a folder
each); Gallery (one large read-only preview over a strip of the folder,
the strip mounting only the cells near what it shows); Beside (the list in
two-line rows, the selected file at its right). View options is one menu:
rows, tile size, the order (name, when changed, size, kind: the host
sorts), headings by kind, date or place (`groupEntries`, the list alone
draws them, and the arrows walk the rows in the grouped order), and Show
Details (the selected file's picture and facts in a pane beside a list or
a grid, `DetailsPane`). Walking any shape with the arrow keys asks a host
for pictures and nothing else: it opens nothing, mounts no editor and
writes nothing (`FilesLooks.dom.test.tsx` holds each walk to that).

**Pictures in the window** (`previews.ts`). A tile asks for its thumbnail
when it is drawn, so a long folder asks only for what is on screen; tiles
drawn together go in one `work.files.thumbs` call (40 names at most, after
40 ms), at 192, 288 or 416px for a small, medium or large tile. Nothing is
asked for a folder, a file kept in the cloud, a file in the Windows VM, a
sound, an archive or a host on the old wire (`mayPicture`). What comes
back is kept while the window is open (600 pictures at most, the oldest
out first, in memory only); a host that did not answer is asked again the
next time the tile is drawn. A page of a preview is asked at one of four
widths (640, 1,024, 1,600, 2,048: `pageWidth`), a step up from what the
pane needs, so a small resize asks nothing new; an older answer never
replaces a newer one. The ask goes to the file's own host, the copy of the
place the row was listed from.

**Quick Look** (`QuickLook.tsx`, `Preview.tsx`): Space on the row the
arrows rest on. The layer is drawn over the page and takes no focus: the
list under it keeps the keyboard, so the arrows walk and the layer follows.
Space, Escape or a press outside closes it; Open opens the file as the
list would. `FilePreviewPane` draws the file read only: its pages down the
pane (the first two at once, two more as he nears the end, 20 at most), a
picture fitted, a video's frame with Play under it, a sound's Play, a zip's
listing (`work.files.archive`), else its facts and the host's one sentence.
Play reads the file's bytes into the window (`work.files.read`, by the
version the first part named, 200 MB at most) and hands them to the
system's own player; nothing is read before the press. A file kept in the
cloud shows its facts and Download and Look (`work.files.fetch` on its own
host): nothing downloads without that press. Gallery, Beside, the last
column and the details pane draw through the same pane and the same store.

**The Beside seat.** In Beside the right half is a preview that follows
the arrows after 120 ms. A click or Tab into it opens the file there as
itself, editable: `work.files.open {beside: <window id>}` on the
workspace's host, which keeps one seat a window as a row of
`work_files_tabs` of kind `seat` (id `seat:<window>`, `besideSeatId`). The
seat is no tab: it is in no list, holds no position, and `tabMove` and
`tabSet` refuse it. Opening another file in it re-points it and the file
it showed goes with its item. Never twice: a file a tab holds is answered
as that tab's item (and no seat is kept), two windows on one file share one
item until the last seat lets go, and `openFile` for a seated file gives it
its tab with the item the seat has. `tabClose {tabId: "seat:<window>"}`
lets the seat go (the window does it when the folder leaves Beside, only
if it ever took the seat). A workspace keeps eight seats at most, the
oldest out first; a file that goes to Trash leaves its seat; and no seat
outlives a start of the host (`check`). A file on another computer or in
the Windows VM is refused there: "A file on another computer opens in a
tab of its own."

**Two files in one tab** (`SideFile.tsx`). Open to the Side, in a file
row's menu, puts the file at the side of the file tab he was last in; a
file tab's own menu has the same row, which moves that tab's file to the
side of the one shown; and a file tab dragged down onto the right half of
the file shown goes to the side of the tab he was in before he pressed it.
On the host it is `work.files.open {side: <tabId>}`: the tab's row keeps
`side: {itemId, key, name}` in its page, and `FileTab.side` says it. Never
twice: a file a tab of its own holds moves there with its item (that tab's
row goes, the item stays), one at another tab's side or in a Beside seat
moves too, a tab's own file is not put beside itself, and opening a file
that is at a tab's side answers that tab. The side has a 32px head of its
own (its name, where saving stands, its close) and the kind's bar and body
under it; `tabClose {tabId, side: true}` closes it alone, and closing the
tab closes both. The side follows a rename, lets go of a file that went to
Trash or whose item was closed another way, is kept through the boot
check, and a remote key is told of no side it could not name. Each half
keeps at least 320px (`sideWidth`); where the body has no room for two the
side lies over the tab's own file. A file on another computer is refused
at the side as in the seat.

**Drag out.** Rows that are all files lying on this computer (the window's
own machine, never the Windows VM; a file others can open only where the
workspace lives on this computer too, which is Download's own rule) go
with the system's drag instead of the window's: the row's `dragstart` is
given up and `dragFilesOut` (preload) asks main, which checks each path is
an absolute path to a regular file (`src/main/dragOut.ts`: no folder, no
link, a hundred at most, one bad path refuses the whole drag) and calls
`webContents.startDrag`. A drop on the desktop copies the files there. A
drop back in the Files place is still a move or a copy of those rows: the
window keeps what is being dragged (`dragging()`), and every drop target
reads a drag of `Files` as those rows while it is set, never as an upload.
Rows that cannot go out (a folder among them, a file kept in the cloud,
another computer's) keep the window's own drag.

**Ask: a chat docked beside the file** (`Dock.tsx`, `dockThread.ts`). The
owner's rule: a file opens chat only when he asks for it; by default it is
the file alone, and a chat is kept only once he sends in it. So opening a
file makes no thread, and neither does Ask. Ask (the header's button, a
toggle) docks a chat at the tab's right; Ask again, or the dock's close
control, takes it away.

- **Which thread**: the one this tab's dock showed before this run, while
  it is a live thread; else the newest unarchived thread of the workspace
  that holds the file (`heldBy` over `work.files.threads`); else a
  **draft**. App fills `workDockPort` (lib/workSwitch.ts): `draft(workspace,
  id?)` answers a Session seeded as New thread seeds one, in the Work
  workspace, placed in no tab and recorded in no project draft; the dock
  puts it in the session store's open set. A draft has no meta, so no rail
  lists it, and nothing is on any host. Its composer starts with one chip,
  the file (a `file` chip, the file's own source as its ref: "Agents"),
  which he may take off; the composer draws no draft row (folder, host, branch, type,
  Master thread, name: `draftRow: false`), since the dock decides them.
- **The first send** goes the composer's normal way (App's `onSubmit`,
  `commands.send`). In it, in this order: `session.create` (the chip rides
  it as `about`, and its line leads the message), then the step the dock
  set with `afterCreate.set(draftId, …)` (lib/tcserver/commands.ts, run once
  inside `ensureCreated`, after the create and the Mac bridge), which opens
  the file as the new thread's own canvas item (`work.canvas.open` with the
  tab item's kind, source and title; for a copy of a file on another
  computer, `work.office.filesCopy {sessionId, source}` first, since the
  tab's copy goes with the tab), then `session.send`. So the first turn
  already holds the file. A failed step says so in a toast and the message
  still goes. The thread's canvas is not folded: in the dock the thread is
  drawn without its canvas seat (`ThreadView seat={false}`), and opened in
  its own tab it shows the file beside the chat as any Work thread does.
- **Closed with nothing sent** (`leaveDock`): the draft leaves the open
  set and its step is cleared; nothing was made on the host, no item, no
  rail row. Its id is kept for the tab this run, so opening the dock again
  shows the same draft with what he typed (the composer keeps a draft's
  words by id) and its chips. A draft whose send is under way is left to it.
- **After a send** the thread is an ordinary thread in the rail; the dock
  keeps showing it by its title, with Open in its own tab (`workOpenPort`).
- **A selection's Ask** (and a kind's own Ask) opens the dock and puts the
  selection's chip in the docked composer, once the thread is known. The
  dock's `chip` takes one chip or a list.
- **Rows dragged onto the dock**: a drag of Files' own rows (`ROWS_MIME`,
  the rows `dragging()` holds) shows the document surface's wash 12px inside
  the dock, "Drop to add to the message", and a drop puts a `file` chip each
  in the composer (`addRowChips`, over `chipsOf` with the place the rows
  came from). Eight chips at most in all: past that none is added and one
  toast says "A message can hold 8 files at most."; folders are left out,
  and folders alone say "Only files go in a message, not folders." A
  desktop's files are the composer's own (attach).
- **The window's**: which file tabs have the dock open and its width live
  in `work.files.view.v1` beside the rest of the window's look (`useDock`,
  `useDockWidth` in store.ts); a tab that goes, closed here or in another
  window, takes its dock with it (`dropDocks` on every tab list).
- **Its shapes** (model.ts): 360px to start, 360 to 720, never leaving the
  file under 560px (`clampDock`, `dockMost`); a tab body under 920px gets
  the dock over the whole body instead, with its close control at its head
  (`dockShape`); the sidebar folds itself under 900px of view while the
  shown tab's dock is open, and comes back when it closes (`sidebarFolds`).
- No key opens it yet: ⌘L is the selection bar's Ask, and taking it in the
  Files map would need a new app command and an App case.
- The old wire (a workspace whose host keeps no tabs) still opens a file in
  a thread as before (`openInThread`); that is not Ask.

**Keys.** The view's root carries `data-files-view` and fills `filesPort`
(`lib/filesKeys.ts`) while it is mounted, giving it its keys (`FILES_KEYS`
in `chords.ts`: the reader of its chords and the menu rows they answer).
While focus is inside it, the app's resolver (`createKeyResolver`, guard 7)
sends the mod key with T (a new tab), with W (close the tab; the last
becomes the workspace's folder), with Shift and T (the tab last closed),
with [ and ] (Back and Forward in the tab), with P (Go to) and F (Search),
and Ctrl+Tab and Ctrl+Shift+Tab (the next and previous tab) to Files, as
one app command, `files_command`, that carries the Files command
(`close-tab`); the menu's rows for the same commands go the same way
(`filesOverlay`). In
a folder the arrows walk, Return opens, Space is Quick Look, F2 renames,
Delete deletes, the mod key with A selects all and with Up goes to the
parent folder, `/` is Search, Escape lets go of the selection. Settings →
Keybindings lists them under "Files (Work)". Only the port is in the first
paint: the rule for whose focus it is, the chords, the menu map and the key table
(`bindings.ts`, which lists itself when the view or the Keybindings page
loads, `addKeybindingGroup`) ride lazy chunks.

**A host a release behind** answers `work.files.places` as an unknown
method. The window then reads it through `work.office.filesLibraries` and
builds the same places (`placesFromOld`), lists its folders whole through
`work.office.filesList` and orders them itself. Where that host is the
workspace's own, the tabs are this window's alone and one line says
"Update the box to keep tabs here"; where it is a desktop, "Update MacBook
to open its files in tabs". The adapter is kept for two releases.

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
| a thread (`model`) | at once, through the `files_*` tools alone, with a Result and Undo (the module's start turns `setThreadsMayWrite` on; before it, "A thread cannot change files through Files yet.") | never: it becomes a held `file.act`, whatever it says he asked |
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
in shared places (`filesPreamble`, "Agents") is a rule, not a fence.

## Writing safely

`files/write.ts`, proven against races in `write.test.ts`. New, rename,
move and copy go through it (`files/verbs.ts`), and so do Trash, Put back
and Upload.

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

## New, rename, move and copy

`files/verbs.ts`, for the workspace's folder and a library on this host's
own disk. Each passes the door (`admitChange`, handle.ts), runs under its
operation id (`runOp`: the same id again answers what the first did, read
before the file is looked up, since a rename leaves the old name gone),
holds the file's lock by its key at both ends, and writes through
`write.ts` with the workspace's folder and the library as its only roots.
It answers `FileDone`: the things as they are now, built as a listing
builds its rows, and `refused`, one row with its sentence for each thing
that could not be done; the rest is done. Each folder that changed is
dropped from what `DiskLister` kept and pushed as `work.files {at}` to
whoever could name it.

**New** (`make`, the rules in `files/make.ts`). The thing is made at once
in the folder; a lens means the workspace's folder. The form follows the
place:

| Made in | Document | Sheet | Deck | Text file | Folder |
|---|---|---|---|---|---|
| The workspace's folder | `.tcdoc` | `.tcsheet` | `.pptx` | `.md` | a folder |
| A Teams library, OneDrive | `.docx` | `.xlsx` | `.pptx` | `.txt` | a folder |
| Google Drive | Google Doc | Google Sheet | Google Slides | not offered | a Drive folder |

New offers only what opens ready to edit there (`offersIn`): the
workspace's folder every kind; a library a folder and a text file always, a
sheet where a maker writes `.xlsx` or this host has Excel (a Mac with
`/Applications/Microsoft Excel.app`), a document or a deck only once a
maker writes `.docx` or `.pptx`; a library in the Windows VM the same, less
this host's Excel (it stands behind no file there), and nothing where its
helper makes nothing. Asked for
another, the host says so in one sentence ("A document cannot be made in
Esports Staff yet. Make it in Word, or in your workspace's folder.").

The name is his (its form's extension added when it is missing) or the
kind's ("Untitled document"), made free against the folder's names read
case-blind ("Untitled document 2"). The bytes come from, in order: a
template (`from`, any file he may read of a form the kind opens there; one
from another place is a copy of it, so Teams files stay in Teams and one
into a shared place is asked first; the made file keeps the template's
extension), the kind's registered maker (`registerFileMaker`: it writes in
a private folder under `<userData>/work-files/staging/`, which goes once
the file is put in place), or Files' own blank. A text file starts empty.

The blanks are `resources/work-files/blank/blank.{docx,xlsx,pptx,tcdoc,tcsheet}`,
written once by `bun scripts/gen-work-files-blanks.ts` and checked in: the
Office files are the least each format needs (the deck by pptxgenjs, one
blank wide slide), the `.tcdoc` is an empty document as the documents
service stores one, the `.tcsheet` an empty sheet as the sheets pillar
makes one (its title is "Untitled sheet" whatever the file is named). They
ship as the app's own files (asar is off, nothing excludes them) and are
found from `appRoot()`, in a dev tree and the packaged app alike.

**Rename** keeps the folder, takes his whole new name (`checkName`), and
never lands on anything: a taken name is "A file named "x" is already
there."; a change of case alone is a rename. A place's top is not renamed
or moved, and a file a save holds is refused ("A thread is writing in this
file. Try when it is done.").

**Move** inside one place is one rename per thing into the folder; a taken
name is that thing's refused row, and the rest still move. Across places,
which today means the workspace's folder into a library, it is a copy,
checked whole, what hangs on the file carried to the copy, then the source
to Trash through `trashAfterMove` (`setTrashHook`, Trash's build). A Trash
that fails carries everything back and takes the copy away. Out of a
library is refused by the grammar ("Teams files stay in Teams.").

**Copy** never means to replace: a taken name gets the next free one
("notes 2.txt"). Into a library it is asked first; out of one it is
refused.

**What a rename or a move carries** (`files/moved.ts` `fileMoved`). The
file moves on disk first; then one savepoint carries, for the file or each
file under a moved folder:

- every pillar's `registerFileMoved` hook, once per file;
- the documents pillar's rows by a `.tcdoc`'s path (`fileDocName`):
  `work_docs_threads` and `work_docs_mode`, read here by name and skipped
  when the table is not there;
- the `source` of every canvas item that names the file or lies under a
  moved folder (`{at:'file'}` and a Microsoft file by its path, whose shown
  name follows), with its title when it was the file's name, and its `rev`;
- the `source` of a media version (`work_media_versions`) and of a
  meeting's recording (`work_meetings`): rows kept by item, but those
  pillars play the file from that path;
- the `file_key` of the PDF's and the media pillar's rows (their own
  hooks, `moveFileKeys`), so a tab and a thread on the renamed file still
  share them;
- his marks (`work_files_marks`, by key: a star and a recent follow), and
  the tabs (`work_files_tabs`: a file tab's key and name, a page tab that
  stands in a moved folder), under a new revision.

A fault anywhere rolls the savepoint back and the file is moved back. Once
it lands, each owner's canvas list is said again (`ctx.canvas.announce`)
and the tabs' revision is pushed. A rename made outside TempCode carries
none of this. What the documents and sheets builds keep by path beyond the
two tables above (a document's history journal, a sheet's suggestions,
mode and charts by `file:<path>`) is theirs to carry through
`registerFileMoved`.

**Callers.** His window and a remote key (with `approve` where others can
open the place) change files now; another host of his only with where the
change began; a thread changes files through the `files_*` tools alone
("Agents"): the wire refuses its change outright (`THREADS_BY_TOOLS`).
## Trash

`files/trash.ts`. Trash is for the workspace's own folder; a library's
delete is the provider's (below).

- **A delete** (`trash`) is journalled in `work_files_trash`. For each file
  or folder, under its lock: the row is written first, `moving`, holding the
  file's ref, its name, the place and the folder it lay in (`was_at`); then
  the bytes move to `<userData>/work-files/trash/<workspaceId>/<id>/<name>`
  (folders made 0700), outside the folder so no listing and no thread's walk
  finds them; then the row is `held`. The move is `moveNoReplace` with a
  fence of the workspace's folder and the Trash folder: a rename on one disk,
  else a copy synced and read back, then the source removed; a folder over
  2 GB across disks is refused in its sentence. A file a thread is writing
  in is refused ("A thread is writing in this file. Try when it is done.").
  A Files tab on the file, or on anything in the folder, is closed first,
  its item with it. The answer's `trashed` holds the row ids: Undo is a
  `restore` of them. The same `op` again answers the same and moves nothing.
- **The Trash lens** (`list {at: {at:'place', id:'trash'}}`) lists the
  workspace's `held` rows, newest first, 500 at most: `key: 'trash:<id>'`,
  `ref` and `folder` null, `changed` the time of the delete, `where` the
  place and the folders it was in. A remote key sees no row whose file it
  could not have named. `places` gives Trash after Starred to the
  workspace's own callers, never to a thread or another host.
- **Put back** (`restore`) claims each row by `UPDATE … SET state =
  'restoring' WHERE id = ? AND workspace_id = ? AND state = 'held'`: only
  the caller whose UPDATE changed the row goes on. Another workspace's row,
  one not held, or one a key could not name is that id's `refused` entry,
  "That is not in Trash any more." The bytes go back to the folder they were
  in, or to the folder's top when that folder is gone, under a name nobody
  has there ("notes (restored).txt", then "notes (restored) 2.txt"); each
  entry's `where` says where it went. Then the row and its Trash folder go.
  A move that fails returns the row to `held`.
- **Empty Trash** (`purge`, `approve`, never relayed) claims rows `held` →
  `purging` the same way, removes their bytes, then the rows; with no `ids`,
  every held row of the workspace. A restore and a purge racing for one row
  never both win and never both lose.
- **The boot check** (`settleTrash`, at the module's start) puts right what
  a dead process left: a `moving` row whose bytes are in Trash becomes
  `held`; one whose bytes are still in place is dropped with whatever part
  reached Trash; a folder copied to another disk whose source was half
  removed is held and what is left of the source stays, so nothing is lost.
  A `restoring` row is dropped when its bytes left Trash, else held again. A
  `purging` row is purged.
- **30 days.** Rows held longer go, bytes and all, at the start and once a
  day (`purgeOld`, on the journal's daily timer).
- A deleted workspace's rows go with its other rows, and its Trash folder
  with them.
- `trashAfterMove(ctx, workspace, path, op)` is the last step of a move
  across places: the checked copy's source, a file of the workspace's
  folder, goes to Trash under an id of its own within `op`, and its row id
  is answered.
- **A library's delete waits.** A library's `can` has no `trash`, so the
  grammar refuses first. `trashInLibrary` is written and tested but not
  reachable: it would send the file to the system's own bin (`systemBin`:
  the Finder on a Mac, the Recycle Bin on Windows, `gio trash` on Linux),
  where OneDrive takes the delete to the library's recycle bin, and keep a
  row with `provider: 'onedrive'` and no bytes; Put back of such a row says
  "Put it back from the recycle bin." It is turned on only after a live
  proof, on an account that is not his university's, shows the provider's
  bin holds a file, a folder and a cloud-only file.

## The Windows VM's verbs

`files/vmVerbs.ts` (F8), for a library OneDrive syncs in the box's Windows VM.
The wire is the same `make`, `rename`, `move`, `trash` and an editor's `read`
and `write`; each passes `locate` (the guest path held to a mount by name,
`vmLibraryOf`) and the door (`admitWrite`) exactly as the same verb on this
host's disk, runs under its operation id (`runOp`) and the file's lock by its
key, and answers `FileDone` built from what the guest answered, so nothing is
listed again to answer. The guest's helper does the change
([work-teams-files.md](work-teams-files.md) "The Windows VM": its change
verbs and their journal) and holds both ends to OneDrive's mounts again.

- **What `can` says.** `guest.status` answers the helper's change verbs
  (`verbs`), kept with the rest of what the VM was last read as (`vm:status`,
  `vmVerbs`); `placesIn(library, state, verbs)` gives a VM place
  `vmCanOf(verbs)`: `make` with `files.mkdir` and `files.write`, `rename`,
  `move`, `edit` with `files.write`, `trash` with `files.recycle` while
  `VM_TRASH` is on, and nothing at all without `files.outcome`. An older
  helper answers no `verbs`: nothing is offered, nothing is asked of it.
- **New**: a folder (`files.mkdir`), a text file (`files.write {dir, name}`
  with no bytes), an Office file only where `offersIn` offers it (a maker's
  blank written here and sent as the new file's bytes). The free name is read
  from the folder's listing, case-blind. A template is refused ("A file in
  the Windows VM is made blank. …").
- **Rename and move** keep to one place: a move to another place, VM or not,
  is the grammar's "Teams files stay in Teams."; a copy there is "Nothing can
  be copied in General from here.". Each thing of a move is one
  `files.move`, a taken name its own refused row. What hangs on the file
  (items, star, recent, tab) follows it (`fileMoved` with `guest`, by the
  path's prefix: no hook or document row is kept by a file there).
- **Edit**: `work.files.read` of a VM file, for his own window only, answers
  its bytes and the version the helper reads (`size:mtime:sha256`, as
  `versionWord`); a file kept in the cloud is never read ("Download it
  first"). `work.files.write` sends `files.write {path, data, expect}`: a
  stale version is the save's conflict, a gone file `{ gone: true }`, his
  copy beside it "Name (mine).ext" through `files.write {dir, name}`.
- **Delete** (`trash`): asked first ("Delete for everyone?"), then
  `files.recycle`, the Windows Recycle Bin, never a delete for good; a
  `work_files_trash` row with `provider: 'onedrive'` and no bytes here,
  listed in Trash under its place's name and folders, whose Put back says
  "Put it back from the recycle bin." It is built and off (`VM_TRASH` is
  false): the rig proved, on a dummy mount, that the bin holds a deleted file
  and a deleted folder whole, and that with the bin turned off a delete is
  refused and the file left. Not proven, and the plan's condition for
  offering it: that OneDrive then puts a deleted file, folder and cloud-only
  file in the library's own recycle bin (no real OneDrive is signed in on the
  rig, and no build thread may try it on Purdue's). One line turns it on. A row a dead process left
  `moving` is dropped at boot (this disk cannot tell where the file is; it is
  in its folder or the bin).
- **A lost answer.** Each thing is asked under the guest operation id
  `tc-files:<op>:<n>` (`guestOp`). An answer lost on the way back is asked
  once more with the same id, which the guest's journal answers without doing
  it twice; lost again, the change throws `OpLost`, which `runOp` keeps no
  row for, so the caller's same `op` asks the guest again and gets what the
  first did.
- **Who.** His window; a remote key with `approve` (every VM place is one
  others can open), and the listener passes the guest path for `make`,
  `rename`, `move` and `trash` (`GUEST_METHODS`); a thread is refused until
  F5, then held; another host of his only with its `origin`. An editor's
  `read` and `write` there are his own window's alone.
- **Pushes.** A changed folder in the VM is pushed as `work.files {at}` with
  no `path` (a guest path is no path of this disk; any key that may read
  names the VM's libraries by the guest-path rule), and its kept listing is
  dropped (`forgetVmList`).

Not yet: a template, a copy, an upload, a move across places in the VM, and
an Office file where no maker writes its form.

## Google Drive

`files/places/drive.ts` (the place and its listing), `files/driveVerbs.ts`
(the verbs and their door), over `google/drive.ts` (the Drive calls, through
the google pillar's own `drive.file` tokens; work-google.md "Drive in
Files"). This is the narrow form of the plan's question 1: TempCode may see
only the Drive files it made or he picked, and no wider Google scope is ever
asked for.

- **One place per Google account of the workspace**: the accounts LifeOS
  holds (`calendarOps:accounts`) that allowed Drive files and that LifeOS
  files under the workspace's sector. An account with no sector belongs to no
  workspace. The place's id is `drive:<account>`, its kind `drive`, its name
  the account, `shared: false` (the place itself is his own), `makes`
  Document, Sheet, Deck and Folder, and its top `{ at: 'drive', account,
  folderId: 'root' }`. The accounts are read at most once a minute
  (`driveAccounts`); `places` waits 1.5 s at most for a first read. With no
  such account, or LifeOS signed out or away, the place is absent, never a
  fault. `locate` checks every Drive folder and Google file against the
  accounts as last read (`accountsHeld`, refused "That Google account is not
  one of this workspace's."), and the handler reads them before it locates
  one.
- **What it lists**: only what `drive.file` lets TempCode see, the files
  LifeOS's Google client made and the ones he picked. The top is My Drive's
  top and every item whose folder TempCode cannot see, so a file he picked
  from a folder of his shows there. A folder lists its children out of the
  bin. Drive is read a thousand at a time, 10,000 at most (`more` past
  that), kept 5 s, put in the host's order here (folders first) and cut into
  pages of 500 by the disk's own keyset cursor (`cutPage`); a folder that
  changed between pages answers `stale`. A Google type's kind is read from
  its type (a Doc named "Plan v1.2" has no extension), anything else from its
  name. `by` is Drive's last modifier. The trail is the place, then the
  folders above (eight at most) that TempCode can see. `stat` asks Drive
  again; what it may not see, or what is in the bin, is null.
- **Who else can open a thing** (`othersCan`, `itemShared`): Drive says it
  was shared, it lies in a shared drive, someone else owns it, or Drive's
  facts do not say; and anything in a folder others can open. A move or New
  into such a folder counts as a change others will see.
- **Add from Drive** is the pillar's Picker, `work.google.pick {account}`
  (capability `local`: the machine's own window; work-google.md "Picking a
  file"). What he picks joins what the client may see, and the pick drops
  what was kept of that account's listings, so the place shows it at once.
- **The verbs**, each one Drive call after the one door (`admitDrive`: each
  thing's sharing read from Drive now, then `admitWrite`):

| Verb | Drive's call |
|---|---|
| New | `files.create {name, mimeType, parents}`: an empty Google Doc, Sheet, Slides deck or folder, "Untitled document" then "Untitled document 2" against the names TempCode sees there. A text file and a template are refused |
| Rename | `files.update {name}`. The id stays, so a tab, a star and a recent follow with nothing to carry |
| Move | `files.update ?addParents=…&removeParents=…`, one call, within one account's Drive. Out of it, or into it, is the grammar's "A Google file lives in Google Drive. Export a copy instead." |
| Delete | `files.update {trashed: true}`: Drive's own bin, which keeps it 30 days. A Trash row with `provider: 'drive'` and no bytes here; his window asks first when others can open it ("Delete for everyone?") |
| Put back | `files.update {trashed: false}`: back in the folder it was in |
| Copy, upload, edit | not offered |

  Each runs under its operation id with the thing's lock by its key, and
  pushes `work.files {at}` for each folder that changed and the place's top
  (`driveChanged`). A rename and a move keep what each thing was before (its
  name and folders, `before`) in the journal's row, for an Undo. Empty Trash
  drops the row only: nothing here deletes a Drive file for good, Drive
  empties its own bin. A tab on a file that goes to the bin closes. A row a
  dead process left `moving` is dropped at boot (the file is in its folder
  or in Drive's bin); one left `restoring` is held again (a second Put back
  does no harm).
- **Who.** His window: every verb, a shared thing's delete after its
  question. A remote key: only one that may name the workspace's own folder
  (`ctx.reaches`), and `approve` for a change to a shared thing. A thread:
  through the `files_*` tools, naming a thing by its path of names in the
  place (`Events/Brief`), each step found by name (`driveRefIn`; two things
  of one name are refused, since Drive lets names repeat). Its change to an
  unshared thing runs at once with a Result and an Undo (a rename back, a
  move back to the folder it came from or, for a folder TempCode cannot see,
  to the place's top, a made thing to the bin, a delete put back); to a
  shared thing, or into a shared folder, it is a held `file.act`, which runs
  on his press as his window's change once the press finds each thing's key
  and version (`size:changed:`) as they were; a delete there is refused.
  Another host of his: never ("Another host reaches only this host's
  libraries.").
- **A Google file in a tab.** `work.files.open {ref: {at: 'google', …}}`
  seats the google kind's item on the Files pane (a Doc as `document`, a
  Sheet as `sheet`, a deck as `slides`), with no thread and never twice;
  `work.google.open {sessionId: filesPaneOf(workspaceId), account, fileId}`
  goes the same way and answers its item and tab. The google pillar keeps its
  row and polls the file's version while it is open (`googleSeated`). A deck
  a thread already shows opens in that thread. Anything else Drive holds says
  "Scan.pdf opens in Google Drive". A thread's `files_open` opens a Google
  file beside the thread.

Not yet: Drive in search and Go to (a Drive listing does not feed the names
table), a copy, an upload, and a tab's title after a rename (its key
follows; the title shows the old name until the tab opens again).

## Upload

`files/upload.ts`, over the host's chunked uploads (`attachmentUploads.ts`).

- `upload {workspaceId, at, name, size, sha256, op}` locates the folder for
  the caller and passes the door (verb `upload`: into a place others can
  open a key needs `approve`), checks the name (`checkName`), and begins an
  upload with a target of its own (`AttachmentUploads.beginInto`), held to
  the host's attachment limit. It answers `{ uploadId }`; the same `op`
  again answers the same id.
- The caller sends the bytes as `attachment.chunk` and `attachment.commit`
  (or `attachment.abort`) on that id, from the same socket: an upload
  belongs to its owner, this host's window or the key that began it
  (`Caller.keyId`), and any other answers "unknown upload".
- The bytes are staged under `<userData>/work-files/staging/<uploadId>/`,
  never in the place. An abort, an upload idle ten minutes, a failed check
  and the host's close each remove that folder.
- At commit the size and sha256 are checked as for every upload; then the
  door is passed again for the same caller, the folder located again and
  the name checked again, and the file is made with `makeFile` under a free
  name ("Name 2.ext"), never over anything. A folder swapped for a link
  since the begin, or in the moment of the write, is refused and nothing
  lands outside. The folder's listing is dropped and pushed, and the commit
  answers the attachment with the made row as `entry`.
- A thread is refused (the wire takes no thread's change); another host of his has no
  origin to give, so it is refused too. A library takes no upload yet (its
  `can`); the window asks no question before an upload (`questionFor` has
  no row for it) until the library verbs land.

## Agents

`files/tools.ts`, F5's agents' side. The owner's ruling (2026-11-23): an
agent's change to a file anyone else can open is kept on his host and shown
only to him; nothing of it reaches the shared file, its sync folder, a
co-authoring session or a guest's page until he presses, and then it is
written as an ordinary edit.

**The tools.** A Work thread of a workspace names a file by its place (an
id, or a name, as `files_places` answers) and its path inside that place in
words (`Events/Poster.png`), never by a host path; `..` and `.` are refused
before anything is looked at. A Work Chat has no places ("A Work Chat has no
files place."), and a thread of another workspace reaches only its own.

| Tool | Does |
|---|---|
| `files_places` | the places on this host and on each desktop the workspace may use (`mayUseDesktop`, over `ctx.peer`), each with who else can open it (`audienceOf(place, true)`) |
| `files_list {place, path?, cursor?}` | one folder, 500 a page, each row by its path in the place |
| `files_search {query, place?}` | names holding every word of the query, 50 at most: a walk of this host's places (300 folders at most; the VM and other hosts only when named). A stand-in until F4's `work.files.search`: swap `searchByName` for that call |
| `files_open {place, path}` or `{name}` | opens the file beside the thread in its canvas, as `canvas_open` does, in the kind `openAs` picks; by name it searches first and lists the matches when there are several. A file on another computer answers "open it with teams_open" |
| `files_make {place, path?, kind, name?}` | New, in the place's form |
| `files_move {place, paths, to?, name?}` | a move into a folder, or a rename of one thing (`name`, no `to`) |
| `files_copy {place, paths, to}` | a copy, the next free name where one is taken |
| `files_trash {place, paths}` | to Trash, in the workspace's folder |
| `files_undo {op}` | the inverse of a change a tool ran in his own place |

Each change asks the one door first (`admitChange`, over `admitWrite`), so
the grammar's own refusal ("Delete it in Teams.", "Teams files stay in
Teams.") comes before anything else. Then:

- **In his own place** it runs at once, as the thread, through the same
  verbs as his window (`makeVerb`, `renameVerb`, `moveVerb`, `copyVerb`,
  `trashFiles`), under an operation id `tool:<uuid>`. It adds a Result
  (`ctx.results.add`, kind `file.<verb>`) whose Undo is `files_undo {op}`,
  and its answer names that Undo. The inverse reads the change from the
  journal (`work_files_ops`): a move goes back to the folder each thing came
  from, a rename back, a made file or a copy to Trash, a file put in Trash
  back. Each thing the change left must still be that thing (its key, and
  its size and change time); one that is not is refused, "notes.txt changed
  since, so it was left as it is.", and left as it is. Only a tool's own
  operation ids are undone.
- **In a place others can open** nothing is written: it is held as a
  `file.act` (below), and the answer is "Held as item N. It waits for the
  owner's press: <the sentence>". A delete there is refused, not held: the
  grammar has no delete in a library yet.
- **On another computer of his** every change is held: a peer reaches only
  that computer's libraries, all of which others can open. The grammar's
  refusals are asked here from its `places` answer.

The wire takes no thread's change: `work.files.make`, `rename`, `move`,
`copy`, `trash`, `upload`, `write`, `restore` and `purge` answer a `model`
caller "A thread changes files with the files_* tools." (`THREADS_BY_TOOLS`,
after the fence's own sentence), and `read` says the same as its `locked`.
So every run has its Result and every shared change its hold. The module's
start turns `setThreadsMayWrite` on.

**The held act, `file.act`** (`fileActKind`; payload `FileActSchema` in
contract-work-files.ts; pillar `files`). Verbs `make`, `rename`, `move`,
`copy`.

- **One sentence the host writes** (`fileActWords`) carries every fact, so a
  phone or an older window that draws only the summary still shows them
  before a press: "Move Spring budget.xlsx to Esports Staff, Events.
  Everyone in Esports Staff can open it.", "Rename Plan.docx to Plan
  v2.docx in Esports Staff, General. …", "Make Agenda.txt in …". The verb
  word is Make, Rename, Move or Copy.
- **The payload binds** the workspace, the file's own host, the operation
  id (`act:<uuid>`), the request exactly as the verb will be sent and its
  digest (`changeDigest`), each thing's key and version (`size:changed:`,
  from its place's listing: no byte of a shared file is read for it; for
  `make`, the folder), where they are now and where they go in words, the
  destination folder's key, and the audience.
- **The press** (`execute`): the item's workspace must be the payload's,
  and the thread must still be in it (a history import or a thread moved
  to another workspace leaves the act stale); the digest must match the
  request. Then on the file's own host, as the thread (its fence again),
  each thing is listed again: gone, or not the same key, is stale ("… is no
  longer where it was"); another version is stale ("… changed since this
  was held"); a destination folder gone or not the same key is stale ("The
  folder … is gone or moved"). Stale does nothing. Then the window's own
  verb runs: here through `filesHandle` as his window, with `asked`; on
  another host through `ctx.peer` with the thread's scope, where the peer's
  door runs it only for `origin: { from: 'act', id, digest }` whose digest
  is exactly this change's (`PEER_WRONG_ACT` otherwise). Under the act's
  own operation id, so a retry does nothing twice. A file a held `make`
  made is marked as the thread's.
- **No edit** (it is not in `EDITABLE_KINDS`), **no grant** (no matcher:
  "file.act is always held"), **no earned offer** (`earnedOf` has no case),
  and Away presses nothing: no verdict releases a held act.
- **The Outbox view** (`src/renderer/src/work/files/act.ts`, chunk
  `work-files-act`, `FileActView.tsx`): under the sentence, which heads the
  detail, each file with its kind's glyph, where it is now, and where it
  goes or the name it takes. The phone draws it by its summary and the
  document glyph.

**Made-by marks.** A file made through `files_make`, or by his press on a
thread's held make, is marked in `work_files_marks` (`MarkStore.madeBy`:
the thread's title from `sessions`, the time, `seen_at` cleared): its row
leads with the thread's name under Last change by (`FileEntry.madeBy`) and
its name is bold until he opens it (`fresh`, cleared by `seen`). The lens
`made` (`PLACE.made`, "Made by threads") is listed for his window and keys
beside Trash, never to a thread, and `list` answers its rows from the marks
(`MarkStore.made`, newest first). A file a thread writes with the shell is
not marked. Other pillars that put a new file in a place (`slides_new
{save}`) do not mark it yet.

**The older doors**, each tool that writes a file by path:

| Door | Before | Now |
|---|---|---|
| `slides_new {save}` | on this branch, wrote the deck wherever `save` named | closed on master by the slides build (cda8e33f5): a place `sharedOf` calls shared is refused in words and the deck is made in the thread; tested there ("an agent never puts a new deck in such a place") |
| a sheet's export to a path (`work.sheets.export`) | a library's workbook gets its `.csv` beside it; a sheet read from a `.csv` writes back over it | no agent route: no sheet tool exports, and the method is his window's or key's. Left to the sheets build (below) |
| a PDF's export (`pdf_export`) | writes the copy under the item's own folder in app data | closed by design: never beside the file |
| the importer, a thread's `canvas_open` of a Word file | wrote the `.tcdoc` beside the file | closed in F0: a shared file's document goes under `<userData>/work-files/imports/`; `formats/importPlace.test.ts`, and `files/doors.test.ts` for a thread |
| Google's revise-copy (`google_slides_revise`) | Drive's copy landed in the deck's own folders, seen by everyone they are shared with | closed on master by the private-suggestions build: a held `google.edit`, nothing sent to Google before his press |
| the generic `fs.*Path` verbs for a remote key | passed wherever the listener's roots let them (a Work workspace kept in a OneDrive folder) | `fsPathRefusal` (policy.ts), asked by the listener after its fence for every `fs.*` method from a remote key: `fs.writeText`, `createPath`, `renamePath`, `deletePath`, `copyPath` and `movePath` naming a path in a place `sharedOf` calls shared, by its real spelling (a link is followed, a path not made yet is judged by its nearest folder), are refused: "That is in a place others can open (Teams, OneDrive): change it in Files, where the change is asked first." |

Left for the sheets build: `exportSheet` (sheets/index.ts) should ask
`sharedOf` for `held.path` and `held.csv` and write a shared workbook's
`.csv`, or a shared `.csv`'s `.xlsx`, under the item's own folder (`own()`)
instead of beside it, and never back over a shared `.csv`.

`files/doors.test.ts` tries every agent route into a shared folder (the
tools, the wire, the importer) and finds each held or refused with the team's
folder as it was, and holds the `fs.*` refusal verb by verb.

**The `file` chip and `@` a file.** `file` is a chip kind (`CHIP_KINDS`,
noun "file", the File glyph, the `@` list's group Files). A chip holds the
file's name, its source as its ref (what `canvas_open` takes) and, where
known, `where`: its place's id and name, its path inside the place in words
(what `files_open` takes) and `shared` when others can open it
(`fileChipOf`, src/shared/work/files.ts). The message carries it as
"About this file: Plan.docx ({"at":"file",…})", the source as JSON with its
brackets written `\u0028` and `\u0029` so a name with brackets still reads
back as one chip, and under it "> In General (place box~…) at
Budgets/Plan.docx. Others can open it." (`chipRefWords`, `chipUnder` in
src/shared/work/canvas.ts). A file chip quotes no word from inside its
file, whatever it holds: the thread reads it with its tools when asked. A
sent file chip opens the file in a Files tab of the thread's workspace
(`openerOf`, `openInFiles`).

The composer's `@` asks the module's mention source (`fileMentions`,
files/mention.ts): `namesAnswer` for the typed words, so his open tabs and
recents lead, then the names table, never a walk and never the VM; five
files at most, each a `file` chip with its place as the row's fact. Only a
Work workspace's own thread is offered its files (a Work Chat and a code
thread none); `work.canvas.mentions` passes its caller to every source
(`MentionSource.search`'s `by`), and every row is checked for it, so a
remote key hears only of files it could name itself. A caller the router
did not name, and another host of his, hear of none. Work search keeps its
own `file` source, so this one is not bridged there.

**Waiting on you and the amber count** (files/waiting.ts). A pillar that
keeps an agent's suggestions by file registers `registerFileWaiting`
(hooks.ts): `count(sources)` for the rows on screen, `files(host, most)` for
Home. Sheets registers at start (sheets/waiting.ts): an opened .xlsx or
.xlsm keeps its suggestions in `work_sheets_suggestions` under
`file:<path>`, so a count is one indexed query of the open ones (pending,
conflict, orphaned). A `list` answer (and Home's Starred and Recent) gives
each file of this host among its first 100 rows that shows no other state
`state: { is: 'suggestions', count }`, the row's amber count. No byte of a
file is read for it.

A LifeOS document's or sheet's count is LifeOS's own, from its catalog (F4,
"LifeOS, From mail and Projects"). Not counted: a `.tcdoc`'s suggestions
live in the Work service's live document and a `.tcsheet`'s inside the
file, so neither can be counted without reading it; a workbook open in
Excel or Google keeps its own.

`home`'s `waiting`, 12 rows at most: first each file a held `file.act` of
the workspace names while it waits for his press (`held`, `live` or
`failed`), newest first, as the file is now where this host can still
stat it (its place in `where`, and no "last saved by", which would read
the file), else as the act named it; a held make is a row of the name it
will take, with no ref. Each carries `held: { id, verb }` (`FileEntry`):
pressing the row opens that Outbox item. Then this host's files of the
workspace with suggestions waiting, each with its count, then LifeOS's rows
and mail's files not kept ("LifeOS, From mail and Projects"), a row once.
A key hears only of files it could name.

**The preamble.** A workspace thread's first message carries one line from
the module (`filesPreamble`, `WorkModule.preamble`): change the workspace's
files with the `files_*` tools; a change to a file others can open is held
for his press, never written at once; do not reach such a file another way.
A Work Chat gets none. It is a rule, not a fence: the shell is outside it.
## Previews

`files/preview.ts`. `work.files.preview {ref, page?, width}` answers one page
of a file as a PNG, `{ png, pages, width, height }` (`png` is base64);
`work.files.thumbs {refs, size}` answers a small picture of each file,
base64 PNG or null, in the order asked. Both are made on the file's own
host. Where there is no picture, `preview` answers `{ none }`, one sentence
for the tile (`NO_PREVIEW`), and `thumbs` null.

**Who gets one.** The file is located for the caller (`locate`) before a
render and again before the answer: a file that moved out of reach while it
was drawn answers "It is out of reach." and is kept nowhere.

| The file | His window | A remote key, the phone | Another host (`peer`) | A thread |
|---|---|---|---|---|
| in the workspace's folder | yes | yes, where the listener's fence lets it name the file | no | never |
| in a shared library on this host | yes, in memory | "A shared file is previewed only on its own computer." | the same | never |
| kept in the cloud (`bytesHere` false) | "It is kept in the cloud.", not one byte read | the same | | |
| on another computer | "It is on another computer.": ask that computer | | | |
| in the Windows VM | "It is in the Windows VM." | | | |

A file counts as shared when it lies in a library or `sharedOf` says others
can open it. A thread gets nothing from `preview` or `thumbs`, its own
workspace's files included ("Threads get no previews.").

**Where a picture comes from.** A kind's registered previewer
(`registerFilePreviewer`) is asked first; it may answer a PNG or
`{ png, pages }`. Then Files' sources, cheapest first (`PREVIEW_SOURCES`):

1. a picture scaled: a PNG or JPEG by Electron's decoder in this process,
   any other by ffmpeg (`image→scaled.png`);
2. an Office or OpenDocument file's own small picture from its zip
   (`docProps/thumbnail.jpeg`, `Thumbnails/thumbnail.png`);
3. the system's thumbnailer on a Mac (`qlmanage -t`);
4. a PDF's page, by the pdf pillar's pypdfium2 (`pdf→png`; `pdf→extract`
   counts its pages for a preview);
5. an Office or OpenDocument file through LibreOffice to PDF, then its page;
6. a video's frame a second in (its first where it is shorter), by ffmpeg
   (`video→frame.png`);
7. a text file's head, a `.tcdoc`'s first lines (its `preview.md`) and a
   `.tcsheet`'s first cells (its last snapshot), drawn here as grey word bars
   on a page (`files/sketch.ts`, no tool, no font), until the editor builds
   register their true page renders.

`thumbs` takes the first that draws. `preview` asks the sources that draw
any page first (1, 4, 5, 6, 7), and a file's own small picture or the Mac's
thumbnailer only for page 1 when none of those could: Quick Look should not
show a 256-pixel thumbnail at 1,200. An archive and a sound have no picture.

**Sizes.** A thumbnail is `size` wide (192, 288 or 416, `THUMB_SIZES`): a
page at that width, a picture or a frame within a square of that side. A
preview is `width` wide (64 to 2,048) for a page, within a square of that
side for a picture or a frame, never enlarged; a drawn page is 1,024 wide
at most. 20 pages at most (`pages` says no more than 20); a page past the
end answers "It has no page N."; a picture over 2 MB answers "Its preview is
too large."

**Conversions stay here.** Every job goes to this host's runner with `here:
true` (and `shared: true` for a shared file), so it is never forwarded to
another host. A host without the tool answers a plain tile: "This computer
has no tool to draw it." The two ffmpeg jobs are Files' own converters
(`PREVIEW_CONVERTERS`, the module's `convert`), each a separate process.

**Two at a time.** Renders run two at a time per host (`RenderQueue`). Each
caller (his window, one key, one host) has 40 asks waiting at most; a 41st
drops that caller's oldest waiting ask, which answers "Too many previews are
waiting." (null in `thumbs`), and never another caller's. An ask whose
request is cancelled leaves the queue. Two asks for one picture share one
render. A listing never waits on a picture: `list` and `stat` draw none.

**What is kept.**

- His own places: on disk under `<userData>/work-files/previews/`, one file a
  picture named by the sha256 of the file's key, its version (size, change
  time, inode), the size asked and whether a previewer is registered, so a
  changed file, or a kind that registers its own previewer, draws again. An
  Office file's PDF is kept there too, so its next page is one draw. A use
  sets the file's time; the prune drops what was not used in 30 days, then
  the least used until 2 GB at most, at the module's start, once a day, and
  when a write passes the cap (`prunePreviews`).
- A shared library: in memory only, 256 MB at most, least used first out,
  and never for a remote key, the phone, another host or a thread. A
  library he turns off takes its pictures with it at the next ask
  (`dropLibraryPreviews`).
- Every render has a scratch folder under `<userData>/work-files/preview-scratch/`,
  removed when the render ends; a dead process's are removed at the module's
  start.

## An archive's listing

`work.files.archive {workspaceId, ref}` (needs `read`) answers `{ entries:
{ name, size, dir }[], more }`: a `.zip`'s entries as its central directory
names them, 2,000 at most (`ARCHIVE_ENTRIES_MAX`), `more` when it holds more.
`files/zipdir.ts` reads the end record (ZIP64's too) and the directory alone:
nothing is extracted and no entry's bytes are read, so a zip whose entry data
is damaged still lists. Another archive type answers `{ entries: [], more:
false }` and is not opened. It reaches as `read` does (`bytesFence`): a file of
the workspace's folder for every caller that may read, his threads among
them; a shared library's for his own window alone; the VM's never. A zip kept
in the cloud is refused ("This file is kept in the cloud. Download it
first.") and not read.

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
| `tabs`, `open {ref, name?, as?, opener?, key?}`, `tabOpen {page, after?, first?}`, `tabClose`, `tabMove`, `tabSet` | read; operate | yes | the tabs and their items (below). `open` of a file on another host of his, or in the VM, makes its copy here |
| `star {ref, name, on}`, `seen {ref, name}` | operate | yes | his marks |
| `make {at, kind, name?, from?}`, `rename {ref, name}`, `move {refs, to}`, `copy {refs, to}` | operate, and `approve` where others can open the place | screen | `FileDone`: the things as they are now, and a `refused` row with its sentence for each one that could not be done ("New, rename, move and copy") |
| `trash`, `upload` | operate, and `approve` where others can open the place | screen | located and passed through the door, then "Files cannot … yet" |
| `restore`, `purge` | operate; approve | screen; never | the workspace's own rows; not built |
| `make`, `rename`, `move`, `copy` | operate, and `approve` where others can open the place | screen | located and passed through the door, then "Files cannot … yet" |
| `trash {refs, op}` | operate, and `approve` where others can open the place | screen | each ref through the door first (one refused refuses all), then to Trash ("Trash"); answers `FileDone` with `trashed`, the row ids Undo passes to `restore` |
| `restore {ids, op}`, `purge {ids?}` | operate; approve | screen; never | the workspace's own rows ("Trash"): `FileDone` with what came back and where; `{ purged }` |
| `upload {at, name, size, sha256, op}` | operate, and `approve` where others can open the place | screen | `{ uploadId }`; the bytes then go as `attachment.chunk` and `attachment.commit` ("Upload") |
| `home`, `names`, `search`, `searches`, `saveSearch`, `dropSearch`, `read`, `preview`, `thumbs` | | | declared; not built |
| `home {workspaceId}` | read | yes | Waiting on you (held file acts and this host's files with suggestions waiting: "Agents"; then LifeOS rows with suggestions waiting and mail's files not kept, and a key without `approve` gets no mail's), Starred and Recent, 12 each. Not a thread's or a peer's |
| `names {workspaceId, text}` | read | yes | Go to's list, 20 rows at most, from the database alone ("Search and Go to") |
| `search {workspaceId, query, filter?, cursor?}` | read | yes | a page of 100 results, newest first, each with `where`; `more` where a source stopped early, `asleep` for the places of a sleeping VM |
| `searches`, `saveSearch {id?, name, query, filter?}`, `dropSearch {id}` | read; operate | yes | saved searches, the Docs view's saved views (`work_docs_views`). Not a thread's or a peer's |
| `project {ref, projectId, on}` | operate, and `approve` where others can open the file | screen | Add to a project… and Take out of this project: `{ projects: { id, name }[] }`, the file's projects after the change ("LifeOS, From mail and Projects") |
| `read`, `preview`, `thumbs` | | | declared; not built |
| `read {ref, offset, length, version?, itemId?}` | read | screen | bytes of a file whose bytes are here, by version |
| `preview {ref, page?, width}`, `thumbs {refs, size}` | read | screen | a PNG made on the file's own host, or a plain tile ("Previews") |
| `archive {ref}` | read | yes | a zip's entries from its directory ("An archive's listing") |
| `home`, `names`, `search`, `searches`, `saveSearch`, `dropSearch` | | | declared; not built |
| any of the above with a Drive folder (`{at: 'drive'}`), a Google file (`{at: 'google'}`) or a Drive place's id | | | the same answers, from Drive ("Google Drive"); `copy`, `upload`, `write`, `read`, `preview`, `thumbs` and `archive` refuse it in a sentence |
| push `work.files {workspaceId, at?, tabs?, places?}` | | | a folder a tab shows changed (`at`: its key; sent with `{ path }`, so a key that could not name the folder never hears of it), or the tabs changed (`tabs`: their new revision; a client asks for the list again) |

Every change takes an operation id (`op`), and may carry `asked` and
`origin` (the door's table).


## LifeOS, From mail and Projects

`files/places/lifeos.ts` (F4), over the LifeOS functions listed in
[work-lifeos.md](work-lifeos.md) "What Files asks of LifeOS". Nothing here
keeps a byte of a document: rows come from LifeOS through the host's own
session, kept 30 seconds (`keptRead`; the catalog is the docs pillar's
reader, `lifeosCatalog`, which `doc_find` reads too), and every change is a LifeOS mutation that passes
the one door first.

**The places.** A workspace linked to a sector gets, after its own places:

| Place | Id | Kind | Holds |
|---|---|---|---|
| LifeOS | `lifeos` | `lifeos` | the sector's active projects as folders (`{ at: 'project', id }`), then the documents and sheets in no active project (a row of a finished project is at the top, with its `project`) |
| a project | `project:<id>` | `project` (a lens) | the projects the Projects column lists (backlog, active, paused), oldest first by its own `projectOrder`; it lists the project's LifeOS rows and the files linked to it (`projectItems`, read with `projects:page`) |
| From mail | `mail` | `mail` (a lens) | the files of the sector's mail of the last 30 days he has not kept, newest first; `count` is how many |

`places` answers from what was kept and waits 1.5 s at most for a first read;
a read behind it that changes the answer is pushed as `work.files {places:
true}`. With no LifeOS session on the host the LifeOS place and From mail are
listed with `{ state: 'signed-out', detail: 'LifeOS is not signed in on this
host.' }` (the window greys them and says it when one is opened) and no
project lens; Files itself stays up. A thread and another host of his are
given none of them; a remote key without `approve` gets no From mail.

**A row.** A LifeOS document or sheet is `ref: { at: 'lifeos', table, id }`,
keyed `lifeos:<table>:<id>`, named by its title, with `changed` (its last
edit), `shared` (LifeOS says so, or a live guest link shows it),
`state: { is: 'suggestions', count }` where the catalog counts suggestions
waiting, and `project`. A row of the workspace's folder or a library that a
project links carries `project` too (`withProjects`, from the links kept for
the sector). A mail's file is the Mail view's `{ at: 'mail', threadId,
messageId, partId, name, contentType?, size? }`, keyed `mail:<message>:<part>`,
with `by` its sender and `where.trail` the mail's subject.

**The door for a LifeOS ref** (`locateLifeos`, policy.ts, then
`lifeosRow`). A thread names only its own workspace; another host of his
reaches nothing of LifeOS; the workspace must live here and have a sector;
a remote key reads From mail and opens a mail's file only with `approve`, as
reading his mail needs. Then every caller's id is read from LifeOS and held to
the workspace's sector ("That is not in this workspace's part of LifeOS.";
one LifeOS no longer has: "That is not in LifeOS any more."). `locate` keeps
its paths; a LifeOS ref never reaches it.

**What a hand may do** (the LifeOS place's `can`: `make`, `rename`, `move`,
`edit`, and `trash` and `restore` once `catalog:trash` answers):

| Verb | Does |
|---|---|
| New | a LifeOS document (`docs:create`) or sheet (the sheets service's `create` into LifeOS), at the top or in a project; a folder is refused "A project is made in Projects.", a deck or a text file "LifeOS holds documents and sheets. Make anything else in your workspace's folder." |
| Rename | `docs:rename`, `sheets:rename`: the title, whole |
| Move | between projects, or to the top (`docs:setProject`, `sheets:setProject`); out of LifeOS the grammar's "A LifeOS document lives in LifeOS. Export a copy instead."; a file of a disk into LifeOS "Only a LifeOS document lives in LifeOS. Make one there instead." |
| Delete | into LifeOS's own trash (`docs:remove`, `sheets:remove`), and the row's live guest links end here at once (`guestRuntime(ctx).revoke`); before LifeOS's trash is live, "LifeOS cannot put a document back yet. Delete it in LifeOS." |
| Put back | the Trash lens lists LifeOS's trash (`catalog:trash`) beside the folder's, keyed `trash:lifeos:<table>:<id>`; `restore` sends each id to its own place, and a LifeOS id only when it is in this sector's trash. Empty Trash empties the folder's rows; LifeOS's go after its 30 days |

Each passes `admitWrite` with the row's `shared`: a row with a live guest
link counts as shared, so a key needs `approve`, his window asks "Delete for
everyone?" before a delete, and a thread's change would be held (the wire
takes no thread's change; the `files_*` tools name files by path, so a
thread changes LifeOS rows with LifeOS's own tools). Each runs under its
operation id (`runOp`).

**Opening.** A LifeOS document or sheet opens in a Files tab in its kind
with its own `{ at: 'lifeos' }` source; a mail's file as the Mail view's
`{ at: 'mail' }` item, in the kinds a mail's file opens in beside a mail
(PDF, sheet, media, slides, a document read only, meeting); anything else
"This file has no viewer here. Keep it first, then open it."

**Keep** is `copy {refs: [a mail's file], to: a folder of the workspace}`:
the door is asked as a copy from From mail into the folder (the grammar's
one copy out of mail); the part is fetched as an item of the Files pane
(the mail pillar's fetcher holds it to the workspace's sector), copied under
a free name with `makeFile`, and marked kept (`work_files_kept`), so From
mail, its count and Waiting on you leave it out. A copy into a library is
refused. Save to workspace in the Mail view keeps no such mark.

**Projects** (`work.files.project {ref, projectId, on}`, `operate`; through
the door as an edit of the file's place). A LifeOS row moves into the
project, or out of it to LifeOS's top; any other file is linked
(`projectItems:add`, titled by its name) or its link taken away
(`projectItems:bySource`, then `projectItems:remove`); a mail's file is
refused "A mail's file is read only. Keep it first." The project must be
one of the sector's. A file Files renames or moves on a disk takes its
links with it: the module's start registers a `registerFileMoved` hook that
calls `projectItems:repoint` after the move lands, only for a file a project
links (`repointLinks`).

**Home** (`home`): `waiting` is the held file acts and this host's files
with suggestions waiting ("Agents"), then the LifeOS rows with suggestions
waiting, newest first, then the mail files not kept, 12 in all.

**Search**: "Search and Go to" above.

Not yet: the window's screens for these (the renderer's build), a thread's
`files_*` tools in LifeOS, the phone's contract rows for
`work.files.project`, and suggestions counted on a file of a disk.

## Search and Go to

`files/search.ts`, `files/names.ts`, and the shared rules in
`src/shared/work/fileSearch.ts` (`matchesName`, `rankName`, `parseGoTo`,
`searchOfView`, `viewOfSearch`).

**The names table** (`work_files_names`) holds every file and folder this
host listed or found for a workspace: its key, where it is (`ref`, the same
`{ file } | { folder }` a mark holds), its name, its place's id, its kind,
when it changed. No byte of a file. It is written after an answer is sent
(`setImmediate`, one prepared statement, one savepoint a page): every page a
`list` answers (not a lens), and every search's results.

A row leaves when:
- its file is gone, or its library is no longer listed (turned off, removed,
  signed out), as found by any Go to or search that meets it (`checkRow`);
- a `places` answer to his window no longer lists its place
  (`forgetGonePlaces`, one DISTINCT query after the answer). A thread's or a
  key's answer lists fewer places and never drops a row;
- a verb renames, moves or deletes it: `renameName` and `dropName` (the rows
  under a folder go, and come back when it is listed), for the verbs to call;
- the workspace is deleted.

**Go to** (`names {text}`) answers 20 rows at once from the database, never a
walk and never a call to the Windows VM: the open tabs and recents that hold
every word first (not for a thread: they are his own), then names from the
table, ranked by `rankName` (a word that starts the name, then one that
starts a word in it, then one inside a word; then the newest). No words: the
recents alone. Every row is checked for the caller before it is answered: a
file of this host is located for the caller (`locate`; what throws is
dropped), and its library must still be listed. `parseGoTo` reads "new sheet
called travel" (also doc, document, deck, slides, note, text file, folder;
"called" and "named" optional) for the window's "New sheet called …" row.

**A search** (`search {query, filter?, cursor?}`) looks for every word of
the query in a name, case-blind, in four sources at once, each with its own
deadline (20 s) and each giving the event loop a turn as it goes:

| Source | What it reads | Caps |
|---|---|---|
| the names table | rows of the workspace, each checked as Go to checks it | 2,000 rows |
| the workspace's folder | names, streamed folder by folder (`opendir`); hidden names and links left out as a listing leaves them, a link never followed | 20,000 folders, 2,000 hits, 10 s |
| the libraries on this disk | the office pillar's walk (`searchLibraries`), names only | its own: 20,000 folders, 1,000 names, 15 s, the newest 200 |
| the libraries in the Windows VM | the guest's own walk (`vmSearch`) | its own, the same |

A hit is one row whichever source found it (by its key; a walk's facts win
over the table's). Results come newest change first, 100 a page; the cursor
is the last row's change and key. A search is kept 30 s per caller, query
and filter (eight at most, the least used first), so the next page runs
nothing again; a cursor of another search answers `stale`. `more` says a
source stopped before its end. The signal is honoured everywhere: the next
keystroke cancels a walk between folders.

**Words inside a file** are read only where it is cheap and his own: a
`.md`, `.markdown`, `.txt` or `.csv` of 512 KB or less in the workspace's
folder whose bytes are on this disk, the newest 200, each text kept by path
and change time. Never a file in a library, never a file kept in the cloud,
never one over the cap (`search.test.ts` watches every read). A `.tcdoc`'s
text is not searched here: it is read through the Work service, which only
`doc_find` asks (`docs/find.ts`).

**The Windows VM** is searched while it is awake, or for a caller with no
window to keep painting (a thread its workspace lets use the VM, another
host of his). A search from his window or a remote key never wakes it: the
answer says `more` and names the VM's places in `asleep`, for the window's
line and its Wake press.

**The filter**: `kinds` (entry kinds), `places` (place ids; a library's id
takes all its channels), `within` (changed in a span before now: `day`,
`week`, `month`, `quarter`, `year`, the Docs view's spans, kept as the word
so a saved search stays current), `after` and `before` (fixed change times),
`shared` (true: only what others can open; false: only his own), `who`
(`agent`: a thread made it, or LifeOS says an agent last changed it; `me`:
who last saved it is his Work name, or LifeOS says he did; else a name in
who last saved it; a row that cannot say is left out; who saved an Office
file is read only when `who` is asked, and only from a file whose bytes are
here, and a LifeOS row says it only then too, as his Work name, or "You",
"An agent", "A guest": `LIFEOS_BY`). `review`: suggestions wait in it
(LifeOS's rows say so); `project`: it is in that project (a LifeOS row's
own, or a file of a disk linked to it). No words with a filter is a search
too ("every PDF changed this week").

**The bar** under a page of results (`SearchFilters`, Home.tsx): Kind, When
it changed (Any time, Past day, Past 7 days, Past 30 days, Past 3 months,
Past year; an older saved search's fixed times read as their dates), Others
can open, and More: Place, Project and Changed by as submenus, Needs review,
and Clear. More offers the places the search's host answers for and the
sector's projects (`filterChoices`), and any part a saved search holds that
is no longer listed, so every part set can be seen and cleared (`moreRows`,
`pickMore`).

**The fence** is the list's. His window: every place of the workspace on
this host. A thread: its own workspace's folder and libraries, the VM only
where its workspace turns it on; a thread of another workspace, none. Another
host of his: the libraries alone, no names table. A remote key: only what it
could name; its rows are cut by the real path on every page (`ctx.reaches`),
so a library hit outside its roots never leaves the host.

**LifeOS** is the fifth source (`lifeosSource`): the catalog's titles that
hold every word and the documents whose words do (`catalog:search`), for his
window and his keys, never a thread or another host. Its rows are read from
LifeOS each time and never fed to the names table, so Go to lists a LifeOS
row only from his recents and tabs.

**A later place** (Google Drive) is one function more: a
`PlaceSource` (`(scope) => Promise<{ hits, more?, asleep? }>`, each hit a
`FileEntry` with its place's id) added to `SOURCES` in `files/search.ts`. It
honours `scope.signal`, holds to its own deadline, reads only names (and
text where the place has an index), and checks its rows for `scope.rowsBy`.
LifeOS then answers `review` and `project`.

**Saved searches** are the Docs view's saved views: the same rows of
`work_docs_views`, read and written through the docs pillar's own store
(`listViews`, `saveView`, `dropView`), so a window a release behind that
still has the Docs view and Files never disagree. One pure mapping turns one shape into the other:

| Files | Docs view | Where they differ |
|---|---|---|
| `query` | `query` | |
| `kinds` (entry kinds) | `kinds` (canvas kinds) | a deck is `slides`, a picture or video `media`, sound `meeting`; a form and a dashboard are no file kind; a folder, text, an archive are no Docs kind |
| `places` | `where` | `lifeos` and `folder` are the same; a library is Docs' `microsoft`; Google's and a thread's are no Files place |
| `project` | `projects` | one project both ways; more is Docs' alone |
| `who` | `by` | `me` is `owner`, `agent` is `agent`; a name is Files' alone |
| `within`, `after`, `before`, `shared`, `review` | the same | Docs reads `shared: false` as no filter |
| | `held`, `group`, `sort`, `layout` | Docs' alone |

What Docs cannot say exactly is kept beside its spec in the same row
(`files: { kinds, places, who }`); Docs' own wire drops that key when Docs
saves the view again. A search carries its view's whole spec (`docs`), and
saving it from Files changes only what the search changed, so a Docs view's
grouping, order, layout and its own filters are never lost.

A view saved before F6 opens as a search that finds the same rows, part by
part (`search.test.ts` holds each mapped part to the Docs view's own
`passes`). **What a saved view says that Files does not**, kept in its row
and read by no search:

| Docs | Why it is left |
|---|---|
| `held` (a held act names it) | the Outbox lists each held act by what it names; no file row carries a count of them |
| more than one project, or No project | Files' `project` is one project; the LifeOS place lists projects as folders and the rows in none at its top |
| `where` Google, Microsoft, Thread | Google is no place yet; a library is a place by its own id, which a Docs view never named; what a thread made is Made by threads |
| `by` a guest | LifeOS says a guest changed it with no name to match; such a row says "A guest" when Who is asked |
| kinds form and dashboard | no file: each opens from its thread |
| group by project, sort by date created, the table layout | Files groups by kind, date and place, sorts by name, change, size and kind, and lays out as a list, grid, columns, gallery or beside |

## Opening a file from another screen

A screen with a file to show calls `openInFiles(workspace, target)`
(`work/files/openFrom.ts`): the file opens in a Files tab of the workspace
on its host (`work.files.open`; a file open already is shown in its tab),
or a new tab stands on a page (`{ page }`), then the Files place shows. A
refusal is thrown in the host's words for the caller's one toast; the
screen he is on stays. `openDocInFiles(workspaceId, doc)` is the same for a
LifeOS document from a screen that holds only the workspace's id (a
meeting's page, a person's page), with its toast. A Work search hit of a
LifeOS document is `{ to: 'file' }`, through the same door.

A way in that still names the Docs view (`{ view: 'docs', doc? }`: a window
from a release behind, a search hit or a notice a host a release behind
sent, a kept Recent) is taken by the view frame (work/shell/WorkViewPage.tsx)
and opened as `filesOfDocs` says: the document in a tab, or with none named
the LifeOS place (`LIFEOS_PAGE`). A refusal still shows Files, with the toast.

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
- **One file, one writer of its marks.** A deck's review state is kept by
  item, so a deck a thread already holds is not given a second seat: `open`
  answers `held: { sessionId, itemId }` and the window shows that thread's
  item. A PDF's marks and a picture's or video's notes are kept by the file
  (below), so those open in a tab while a thread holds them, and the two
  share one set. A copy of another computer's file (`openCopy`) is a file of
  its own, so for a copy all three kinds still go to the thread.
- **Marks kept by the file** (canvas/fileKey.ts). The pdf and media
  pillars add `file_key` to each of their tables: the item's workspace and
  its file's `refKey`. Two items of one workspace on one file read and write
  one set of rows, kept under one of them (`keptOf`); an item with no file
  (a thread's own file, a mail's part, a Frame.io stack) or no workspace
  keeps its rows by its own id as before. Every read still comes through an
  item the caller may open (`fenceItem`), and the key holds the workspace,
  so an item of another workspace on the same file finds none of them.
  Closing one item passes its rows to another item on the file; only the
  last takes them away (`dropKept`, from `itemsRemoved` and
  `sessionsRemoved`). A thread that moves to another host takes a copy of
  what it shares, with new ids, and the rows stay here for the tab
  (`fileKeyedMoveModule`). Each start fills the key for rows an older build
  wrote; where two items already kept rows for one file, the newest keeps
  the file's and the other keeps its own. The column is only added: an older
  build reads and writes the tables as before. Both canvases already listen
  by item, so each change is pushed once per item on the file.
- The host picks the canvas kind by the file's name; `as` overrules it (Open
  as a document). A library's Office file opens with its app behind it
  (`teamsCanvasOf`). A file no canvas shows answers "x opens in its own
  app." A file on another host of his, or in the Windows VM, is no file of
  this disk: `open` copies it into the pane's own folder (`openCopy`, over
  the office pillar's `copyIn`, which asks the far host through `ctx.peer`
  with the pane as its caller) and its tab carries `copyOf: { host, path,
  vm? }`.

Which tab is selected, and each page's order and row size, are each
window's own ("The screen").

## What a pane owner changes for every kind

A pane owner is no session: `ctx.scopeOf(owner)` is null, and whoever acts
on its items is his own window.

- `CanvasStore.forWorkspace` leaves pane owners out in its query, before its
  limit, so a row of open tabs never pushes a thread's item out of
  `doc_find` or `threadsHolding`; a tab is never listed as a thread.
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

- Tabs, marks and Trash rows on the workspace's host hold the
  **names and places** of files, Teams files among them, as
  `work_canvas_items` and the transcript already do. They ride the nightly
  backup with the database.
- **Trash holds bytes of the workspace's own folder only**, under
  `<userData>/work-files/trash/`, his own data, in the data folder the
  Mac's backup takes. A delete in a library holds no bytes here.
- **Previews of his own places are kept, and never backed up.** Pictures of
  files in the workspace's folder (and an Office file's PDF made for them)
  live under `<userData>/work-files/previews/`, 30 days and 2 GB at most;
  each render's scratch under `<userData>/work-files/preview-scratch/`. Both
  are left out of the Mac's backup (`scripts/mac/backup.sh`) and the box's
  (`/etc/restic/excludes`, written by `scripts/box/70-backups.sh` and added
  to an existing box by `75-backup-maintenance.sh`).
- **A picture of a Teams file lives in memory only**, on the computer that
  holds the file, only once that computer has its bytes, and only for his
  window there: never on disk, never to the phone, another host or a thread.
  Its conversion runs on that computer, in a scratch folder removed when the
  render ends, and is never forwarded. Turning a library off drops its
  pictures.
- **No bytes and no picture of a Teams file are kept anywhere by Files.** A
  list, a stat, a star and a recent never read a byte of a file its place
  keeps in the cloud (`reads.test.ts` watches every way this process opens a
  file). The names table holds the names and places of what was listed or
  found, as the marks do. A search reads the words of no file in a library
  and of no file kept in the cloud (`search.test.ts`).
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
- **A Google Drive** (`places/drive.ts`): read from Drive, kept 5 s, cut
  into pages here ("Google Drive").
- **The Windows VM**: `places` answers from what was kept and reads behind
  the answer; its state is `asleep` with the time it was read. A folder
  there is listed whole by the guest's helper (it wakes the VM, as it always
  has) and cut into pages here (`vmPage`).

## The fence, by caller

| Caller | Reaches |
|---|---|
| this host's window | every place of the workspace on this host; for a workspace that lives on another host, this host's libraries |
| a thread (`model`) | its own workspace's places (a Work Chat none); the VM only where its workspace turns it on; never the tabs, the marks or `open`; a change only through the `files_*` tools |
| a thread (`model`) | its own workspace's places (a Work Chat none); the VM only where its workspace turns it on; never the tabs, the marks, `open`, `preview` or `thumbs`; no change until F5 |
| another host of his (`peer`) | the libraries alone, under this host's bridge policy; no tab, no mark, no Google Drive; a change only with its origin |
| a remote key | what the listener's fence lets it name (`ctx.reaches`, by the real path): the workspace's folder, and the VM's libraries by the guest-path rule. A Mac's own libraries stay out of a key's reach. A Google Drive of the workspace only for a key that may name the workspace's folder |

The listener passes a guest path (`C:\Users\…`) only to the verbs
`GUEST_METHODS` lists (`remote/fence.ts`): `list`, `stat`, `fetch`, `open`,
`threads`, `tabOpen`, `tabSet`, `star`, `seen`, and the four that change a
file there, `make`, `rename`, `move` and `trash` (F8), one verb at a time;
never an editor's `read` or `write`, a `copy` or an `upload`. Each path is
judged alone: in one request a guest path passes and a path of this host
outside the roots still fails; the handler then holds the guest path to a
mount OneDrive names, and a change to the door.

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
- `registerFileMaker`, `registerFilePreviewer`, `registerFileMoved`,
  `registerFileWaiting` (`files/hooks.ts`): four registries of their own, which no module's
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
| a search by name over the 25,000 files, cold (the names table empty) | 2 s | 62.5 ms |
| the same, the names table warm | 2 s | 74.9 ms |
| a page after it, from the kept search | 50 ms | 0.1 ms |
| Go to with 25,000 names in the table | 50 ms | 14.3 ms |

The search rows ran on 2026-11-23 too, on the box, after the list's page had
started feeding the names table (a page after it measured 1.1 ms then). The
search's 400 hits each pass the library walk's closer look; the VM is asleep,
so a window's search leaves it out.

Not measured yet: a real OneDrive folder on the Mac (a cold File Provider
folder is expected to be slower), a Mac's library listed from a window
through the box's link (budget 1 s), a search over a real OneDrive folder,
and a scroll through 5,000 rows in the window (F1a).

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
- `files/names.test.ts`: the names table fed by a list after its answer, Go
  to's order, a library that leaves, a rename and a drop, each caller's fence.
- `files/search.test.ts`: names in the folder and a library merged once with
  `where`, each filter, pages by cursor, words inside his small files and no
  read of a library's, a cloud-only or a big file, the caps, a cancelled
  walk, each caller's fence, a sleeping VM left asleep, Home, saved searches
  and a Docs view through them, and a view saved before F6 finding the same
  rows as the search it becomes, part by part (`within` among them).
- `src/shared/work/fileSearch.test.ts`: matching and ranking names, Go to's
  words, the mapping between a saved search and a Docs view both ways.
- `files/places/disk.test.ts`, `places/teams.test.ts`: the listing and the
  places, the Windows VM through a stand-in helper.
- `files/write.test.ts`: names, the fence, nothing replaced, a swapped
  folder, a second writer, locks, the journal.
- `files/verbs.test.ts`: New, rename, move and copy in the folder and a
  library, for each caller and each refusal's sentence, free names, forms,
  templates, a maker, a retry, a bulk move, the move into a library through
  a stand-in Trash; `files/make.test.ts`: what New offers and makes, the
  blank files; `files/moved.test.ts`: what a rename carries, table by
  table, and a fault that leaves the database and the disk as they were.
- `files/trash.test.ts`: a delete of a file and a folder, the Trash lens,
  Put back (where it was, a "(restored)" name, the folder's top), one op
  twice, a remote key, another workspace's rows, a restore racing a purge
  fifty times, each half-done row the boot check meets, the 30-day purge, an
  open tab closed first, a deleted workspace, `trashAfterMove`, and
  `trashInLibrary` through a stand-in bin.
- `files/drive.test.ts`: a Google Drive against the fake Google: one place
  per account of the workspace and none without one, who may list it, the
  top and a folder with each entry's sharing, Drive's pages and ours, `stat`,
  another workspace's account refused, each verb's Drive call, a key without
  `approve`, Drive's bin with Put back and Empty Trash, a thread's change run
  with its Undo or held and pressed, a held act gone stale, a Google file in
  a Files tab through `work.google.open` and `work.files.open`, and Add from
  Drive.
- `files/vmVerbs.test.ts`: the Windows VM through a stand-in helper: what
  its verbs give `can` (an older helper nothing), each verb's call and
  `FileDone`, a free name, a stale and a gone save, a move to another place,
  a lost answer asked again (once, and twice with the same `op`), the boot
  check's VM row, the door's cells, a guest path outside the mounts never
  reaching the helper, and the listener's fence verb by verb.
- `files/upload.test.ts`: a free name, staging until the commit, a wrong hash
  or size, a folder swapped for a link before and during the commit, a
  library by key with and without `approve`, a thread, abort and expiry; the
  seam itself in `attachmentUploads.test.ts`.
- `files/hooks.test.ts`, `files/module.test.ts`: the registries and the
  mount, the tools, the act and the preamble mounted, and the start that
  lets threads write.
- `files/places/lifeos.test.ts`: against a LifeOS in memory: the places and
  their states (down, the trash not live, by caller), the top and a project
  listed and paged, a folder row's project, a guest link as shared, each
  caller's row of the door, New, rename, a move between projects and out, a
  delete refused before the trash is live and done after, the Trash lens and
  Put back by place, a guest link ended, opening, From mail with `approve`,
  Keep, the two project verbs and a link that follows a rename, search with
  `where`, `review`, `project`, `who` and `within`, `doc_find` finding the
  same rows as a search for the same words, and Home's Waiting on you.
- `files/tools.test.ts`: the tools by place and caller (his own place with
  Undo and a stale Undo refused; a shared place held, every verb; a delete
  there refused; a Work Chat and another workspace refused), the held act on
  the real hold (its sentence and bindings, his press once, the made-by mark
  of a held make, a press gone stale four ways, no edit, no grant, no earned
  offer, Away), and a held act carried to the file's own host with the
  origin that host needs, which refuses any other digest or none;
  `files/doors.test.ts`: the older doors (above).
- `src/renderer/src/work/files/FileActView.dom.test.tsx`: the Outbox view.
  mount.
- `files/preview.test.ts`: each source in its order with the cheaper one
  winning, a registered previewer first, the disk cache (a hit, a changed
  file, the prune by age and size, a hit counted as a use), a shared library
  in memory only and dropped when the library is turned off, no read of a
  cloud-only file (every open watched), nothing for a thread, a remote key, the
  phone or another host on a shared library, no forwarded job and a host
  without LibreOffice, two renders at a time, the 40-ask bound and a cancel,
  the second look at a file moved during its render, the ffmpeg converters,
  the drawn pages; the archive listing over a zip whose data is garbage, its
  cap, another archive type, a cloud-only zip and the reach rules.
- `files/preview.proof.test.ts`: the same through the real tools (LibreOffice,
  pypdfium2, ffmpeg) and the real job runner, where `TC_PREVIEW_TOOLS` names a
  toolchain folder; run it through `.temp-code/bin/heavy`.
- `src/renderer/src/work/files/model.test.ts`: the sidebar, a team's page,
  where a file opens, a host a release behind, every note, the search bar's
  When words and its More (`filterChoices`, `moreRows`, `pickMore`).
- `src/renderer/src/work/files/openFrom.test.ts`: a file or a page opened
  from another screen, a refusal, and every way into the Docs view
  (`filesOfDocs`, `openDocInFiles`); `work/shell/WorkViewPage.dom.test.tsx`
  takes a kept `view: 'docs'` to Files.
- `src/renderer/src/work/files/FilesView.dom.test.tsx`: the window against
  stand-in hosts: the first tab, a folder in the same tab with its trail and
  Back, the arrows and Return, sorting, a file in a tab of its own and never
  twice, a close in another window, the app's tab chords, the sidebar's
  fold, each state, and a host that answers only the old wire.
- `lib/filesKeys.test.ts`, `lib/appCommands.test.ts`: the chords and the
  guard; `lib/kindTint.test.ts`: the tints.
- `scripts/e2e-work-files.ts`: the live proof on the box (below).
- `canvas/filesPane.test.ts`: the pane owner in the canvas store.
- `scripts/e2e-work-files.ts`: the wire live, on one headless instance of the
  built tree (`bunx electron-vite build`, then `env -u ELECTRON_RUN_AS_NODE
  NODE_ENV=production bun scripts/e2e-work-files.ts`; about 5 s on the box):
  places, a 5,000-file folder paged both ways with its cloud-only rows, four
  kinds opened in tabs with no thread, a second connection told of a closed
  tab, the tabs and Recent after a restart, a read+operate key fenced by the
  listener and refused a rename, and the old `work.office.filesLibraries`.

## The phone

F9 (docs/IOS-DESIGN.md "Files", docs/agents/ios-client.md "The Files
place"): the iPhone app's Files place over this wire, through the generated
contract (`SUBSET` rows in scripts/gen-swift-contract.ts, the outputs in
src/shared/wireSchemas.ts). A Files row on a Work workspace's screen opens
Recent, Starred, the places and From mail as the host lists them; a place,
folder or lens is a native list a page at a time; Star, Rename and Delete
(with Put back as Undo) are offered where `refusal` lets the place do them
and the key may ask (operate; approve where others can open the place), and
a refusal shows the host's sentence. New makes a document, sheet or folder
in the folder shown; Upload sends a photo or a picked file through
`work.files.upload` and `attachment.chunk`/`commit`.

A file opens by its kind: a LifeOS document or sheet, a PDF, deck, picture
or video is seated in the workspace's Files pane (`work.files.open`; a
thread that already shows it gives its own item) and drawn by the phone's
view of that kind; everything else, and everything for a key without
operate, opens in Quick Look: the host's preview pages, else the file's
facts, and Open the original for a workspace-folder file of 50 MB or less,
read through `work.files.read` by version into a temp file that goes with
the preview. A shared library's file shows facts only ("On MacBook"):
`read` gives a library's bytes to his own window alone. A document or
sheet kept as a file opens read only ("Edit on your computer"), since the
hosted editor takes only LifeOS rows.

Until F3 and F4 land here the phone degrades: search filters the rows it
already holds until `work.files.search` answers, and Quick Look shows the
facts until `work.files.preview` does. Not on the phone yet: Move, Copy,
the Trash lens, Empty Trash, tabs, thumbnails.

## Unproven

Each of these is built and tested against stand-ins, and waits on something
no build thread may or can do.

- **His real OneDrive and Teams libraries.** Everything ran against dummy
  folders on the box. What OneDrive does with a rename, a move or a new file
  made through its synced folder on his account is proven only on dummy
  folders. A delete in a shared library stays off (`Delete it in Teams.`;
  in the Windows VM `VM_TRASH` is false) until a live proof on an account
  that is not Purdue's shows the provider's bin holds a file, a folder and a
  cloud-only file.
- **A real Google Drive.** It ran only against the fake Google
  (google/fake.ts). Not seen on a real Drive: that Drive marks a file shared
  when it lies in a shared folder (the host reads the folder's sharing too,
  where it can see the folder), that `drive.file` lets a move take a file
  out of a folder TempCode cannot see, and that a Google file drawn from a
  Files pane's item behaves as one in a thread does.
- **LifeOS's trash on his rows.** The soft delete, restore, `mail:attachments`
  and the project-link functions are live on his backend and answer; none
  was run on a row of his. Tests cover them.
- **The phone (F9).** Its store and rules ran on the box against a stand-in
  connection and its Swift parses; its screens have not run on a simulator
  or a phone. The proof steps are in the F9 report and run on the Mac under
  its load gate.
- **On a Mac.** A drag out to the desktop (`webContents.startDrag`), the
  Mac's `qlmanage` thumbnails and Electron's decoder for a picture have not
  run through this code on a Mac; the box's proofs drew previews with
  pypdfium2, LibreOffice and ffmpeg.
- **In the window, live.** The screens are proven by DOM tests against
  stand-in hosts and by preview pages in both themes; the host by the
  instance proofs (`scripts/e2e-work-files.ts`,
  `scripts/e2e-files-open-remote.ts`), and the agents' side by
  `scripts/e2e-work-files-thread.ts`, which drives a Work thread's
  `files_*` tools through its bridge in a real instance (a change at once
  in his folder with its Undo, a rename in a dummy Teams library held, his
  press, an act gone stale). No model turn runs in it, as in every Work
  proof.
- **Office and the blank files.** Each blank `.docx`, `.xlsx` and `.pptx`
  is a whole zip whose parts parse; none has been opened in Office.
- **The VM's helper on his desktop.** The rig proved the verbs over SSH on
  a dummy mount; the helper has not run them as the `serve` door on his
  signed-in desktop.
