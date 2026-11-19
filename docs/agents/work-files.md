# Work: Teams files

Microsoft Teams and SharePoint files, seen in TempCode and used by Work
threads, without Microsoft Graph (blocked on the owner's Purdue account) and
without an Entra app. The finding that chose this way is
`.temp-code/plans/landed/F-teams-files.md`. Part of the `office` pillar
([work-office.md](work-office.md)): it rides that pillar's route to the Mac,
its Office apps and its rule for a file others can open.

## The way in: the synced folder

The OneDrive app on a Mac syncs a channel's library (Teams → Files → Sync, or
Add shortcut to My files) under `~/Library/CloudStorage`:

- `OneDrive-<Tenant>/`: his own files (`kind: 'mine'`), with any shortcut in it;
- `OneDrive-SharedLibraries-<Tenant>/<Team or site> - <Library>/`: each synced
  library. A team's library is "Documents" (or "Shared Documents") and its top
  folders are the channels (`kind: 'channels'`); any other library is
  `kind: 'library'`. The last " - " parts the team from the library.

Other folders under CloudStorage (Dropbox, Google Drive, iCloud) are not
Teams files. His own edits to the list are rows of `work_office_files`
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
  order, a text or CSV file as it is, cut at 200,000 characters. A workbook is
  read through Excel (`office_range_read`), a PDF in the canvas.

## Where the files live (the Purdue rule)

University data may not be copied into an AI tool that is not cleared for it.
So the files **stay where OneDrive put them** and are read there, only when
asked: the Files view reads a folder when he opens it, a thread's read goes
to the Mac and back. Nothing is mirrored anywhere.

**Copy Teams files to <host>** (a Work workspace's page in Settings, kept in
`work_office_files` as `copy:<workspaceId>` on the workspace's own host) is
**off by default**. Off, a file on another host than the workspace's opens in
its app on that host and never in a thread's canvas here. On, opening such a
file copies it (48 MB at most) into the thread's own folder of this host's
attachments (`<userData>/attachments/teams-files/<sessionId>/`, a root a
remote key reaches) and opens the copy; a change to the real file still goes
through the Office tools on the host that has it.

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

The Office tools take the same rule for a peer: a workbook, document or deck
in this host's libraries is reachable from another host's thread
(`office/index.ts`), and counts as one others can open, so an agent's own
idea is a suggestion and only a change he asked for in so many words is
written, a folder he added himself included (`office/tools.ts` `judged`).

## The wire

`work.office.files*` (the verbs are one word, so `ctx.peer` can carry them):

| Method | Needs | What |
|---|---|---|
| `filesLibraries {}` | read | this host's libraries, his rows, the folders he turned off |
| `filesList {source}` | read | one folder: folders first, then files, each `TeamsEntry` (name, path, kind, size, modified, local, by) |
| `filesSearch {query, library?, kind?}` | read | names holding every word, newest first, 200 at most, `more` past 20,000 folders |
| `filesFetch {source}` | read | downloads a cloud-only file; answers it as it is now |
| `filesRead {source, as}` | read | `text`, or `bytes` (base64, for a copy he allowed) |
| `filesOpen {source}` | operate | opens it in its app here: the Office carrier for a workbook, document or deck, else the system's opener |
| `filesSetRoots {roots}` | local | his edits: only this computer's own window |
| `filesCopyGet`, `filesCopySet {workspaceId, on}` | read, admin | the copy switch |
| `filesCopy {sessionId, source}` | operate | the copy, on the workspace's host, pulled from the file's host over the link |

`teamsKindOf`, `teamsAppOf`, `teamsCanvasOf` and `teamsWebOf` in
`src/shared/contract-work-office.ts` are shared by both sides: a workbook
opens as a sheet with Excel behind it (`{at: 'microsoft', app: 'excel'}`), a
Word file as a document (imported first, as every Word file is), a deck as
slides, a PDF as a pdf, a picture or video as media; a CSV, text or other file
opens in its app.

## The tools

`office/files/tools.ts`, mounted with the office tools. A thread reaches the
libraries on its own host and on each host its workspace may use ("Computer
use on <Mac>"); a library's id is `<host>~<hash>`, so each call runs on that
host, here directly or through `ctx.peer`. A file is named by its library and
its place in it (`General/Budget.xlsx`), never by a path of the host.

- `teams_libraries`: each library's id, team, library, kind and channels;
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
  menu: Open, Open in Excel (or Word, PowerPoint, the app), Open on the web
  where the folder has its link;
- the header's search over every library, each hit with its place.

Opening a file (`openWay`): a cloud-only file shows Downloading… in its row
first, then Opening…. On the workspace's own host it opens in a new thread of
the workspace, titled for the file, in that thread's canvas (and an Office
file in its app, which stands behind the item); with the copy he allowed, from
the copy; otherwise in its app where it lies. A failure is one toast.

## Settings

Settings → Work, "Where it runs": **Teams files** for each Mac or Windows host
with Work on (`TeamsFilesRow`): each library found or added, by team, with its
folder; a found one has a switch, an added one Remove; Add web link… takes the
channel's Files → Copy link for Open on the web; Add folder… adds one it
missed. Only this computer's own window edits its list; another host's rows
are read only. A Work workspace's page has **Copy Teams files to <host>**
(`TeamsCopyRow`) once it may use a desktop other than its own host.

## Tests

`office/files/files.test.ts` builds a dummy CloudStorage (his OneDrive, a
team's Documents with two channels, a site's other library, a sparse file for a
cloud-only one, a link out, zips for the Office files) and proves the finder,
the list, search, the fence by caller, download, text, open, the canvas kinds,
the tools from a box thread through a stand-in peer, the copy only where
allowed, and the shared-file rule on a folder he added. The renderer:
`files.test.ts`, `FilesView.dom.test.tsx`, `TeamsFilesRow.dom.test.tsx`.

Not provable until he signs in to OneDrive on the Mac: real folder names, the
dataless flag on a real library's files, and who last saved a file there. The
steps are in the finding's last section.
