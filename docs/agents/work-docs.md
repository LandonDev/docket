# Work: documents

Milestone 20 of the Work plan. The document kind of canvas item, the agent's
document tools, and LifeOS desktop's notes on the same editor. The Docs view
it also built folded into the Files place at the Files plan's F6 ("Where the
Docs view went", below). Built on the shared block editor
(work-kit's `editor` and `collab`, M16), the Work service (M18,
[work-service.md](work-service.md)) and history and branches (M19,
[work-history.md](work-history.md)). [work.md](work.md) says how the `docs`
pillar is mounted.

## Where each part lives

| Part | Where |
|---|---|
| The wire | `src/shared/contract-work-docs.ts`: `work.docs.{open,token,connect,send,recv,close,threads,thread,mode,rename,dismiss,create,find,views,saveView,dropView}` and the `work.docs` push |
| Main's module | `src/main/server/work/docs/`: `index.ts` (the methods), `find.ts` (finding documents, saved views), `target.ts` (what a source names), `relay.ts` (the socket over the link), `threads.ts` (comment rows), `state.ts` (mode, the last write, the relay), `tools.ts` (the agent's tools) |
| The service's routes | `src/main/server/work/docs/serviceRoutes.ts`: `/internal/docs/{read,write,mark}` on the Unix socket, behind the secret, listed in `service/routes/index.ts` |
| The canvas | `src/renderer/src/work/docs/`: `canvas.ts`, `DocumentCanvas.tsx`, `host.ts` (the calls and `RelaySocket`), `threads.ts`, `review.ts` |
| LifeOS desktop | `apps/desktop/src/renderer/src/components/shared-doc.tsx` (lazy), `doc-editor.tsx` (`SharedDocEditor`), `project-sheets.tsx` (the note sheet's choice) |

## Sources

A document is a LifeOS document (`{at: 'lifeos', table: 'docs', id}`), a
LifeOS project note that is one (`table: 'projectDocs'`: `projectDocs.open`
makes a markdown note a document once LifeOS's `blockDocs` is on, and
answers null before; the item then says LifeOS keeps it as text), or a
`.tcdoc` on this host inside the caller's path fence. Every method names the
source, not a canvas item, so a Files tab and a project's page open a
document with no thread. The kind also claims Word (`.docx`, `.doc`), OpenDocument, RTF,
markdown and text files: its body makes such a file a `.tcdoc` beside it and
the item reopens on that
(work-formats.md "Import and export"). A Google Doc opens on a mirror
of its own, read from Google when it is opened ([work-google.md](work-google.md)
"Docs"); its ⋯ adds Write to Google, Read again from Google and Open in
Google, and the doc tools refuse it for the google tools.

A mail's attachment (`{at: 'mail'}`) of these types is read once into `<name>.tcdoc` beside the host's fetched copy and opens there read only: the role is `view` for every caller, an agent may `doc_read` it by its item and nothing may write or comment on it, until Keep as document makes a copy his (work-mail.md "Attachments").

A LifeOS document is served by the host that serves LifeOS's documents (the
box). Asked on another host, `work.docs.open` and `token` answer "served
elsewhere: <environment id>", and the canvas opens the document on that
host's link instead.

## The socket

The editor's provider makes its socket with `RelaySocket` (`host.ts`), a
WebSocket-shaped class whose socket lives on the host: `work.docs.connect`
opens a real socket from main to its own service on loopback
(`relay.ts`), `send` carries the editor's frames up in order, and `recv`,
long-polled (the host waits up to 20 s, the window allows 45 s), brings the
service's frames down. So a far window (the Mac's app on a box thread)
edits a box document with no route to the service's port, before and
after the owner applies the tunnel rule, and nothing of one window's
socket reaches another's link. A socket nobody asks after for a minute is
closed; one that stops reading past 16 MiB is closed with 4503; a host
holds at most 64 at once. A token is
asked with `work.docs.token` (edit for this host's window and an operate
key, view for a read key), always as the owner.

While a LifeOS document has a socket open here, main watches its threads
in LifeOS and pushes `work.docs {threads: true}` when they change, so a
comment made in LifeOS desktop shows at once.

## The canvas

The shared editor in a 672px measure with a 52px gutter for the block
handle, the title above it in the document ladder's title step (renamed in
place for a LifeOS document). What it tells the pane:

- **Presence**: the editor's carets, mapped onto `--presence-1..8` by
  colour (the two palettes are one, in order).
- **Mode**: "Agent writes" or "Agent suggests", switched in the bar on his
  own document (`work.docs.mode`, kept per document in `work_docs_mode`);
  on a shared document it suggests and cannot be switched. Shared is a
  LifeOS document a guest link marks, or a `.tcdoc` others can open where
  it lies (`othersOpen`, docs/target.ts: "Agent suggestions stay private").
- **The state line**: the editor's own sentence when it is offline, waiting,
  read only or did not open.
- **The agent's last write**: "Wrote 1 section, 2:04 PM" with Undo, which
  restores the version the write answered (`work.history.restore`) and
  clears the line (`work.docs.dismiss`). Kept in memory on the host: after
  a restart the line is gone and History still has the version.
- **Suggestions**: each pending branch (`work.history.branches`) drawn in the
  text as the editor's review, one group a branch named for whose it is.
  A changed line is cut into pieces (work-kit's `inlinePieces`): "8:00
  becomes 7:30" is one change, taken alone with
  `work.history.decide {which: ['<block>#<n>']}`; a block put in, taken out
  or moved, a change of type or style, and a table's changed cells are one
  change each, the cells tinted in their cells. Accept all and Reject all
  are the pane's own.
- **Comments** float at their words and sit in the margin (24px + 272px)
  once the canvas has 1104px, which is the thread folded on most windows.
  A `.tcdoc`'s threads are kept here in `work_docs_threads`; a LifeOS
  document's in LifeOS.
- **Ask** (the editor's selection bar and ⌘L) puts the selection in the
  thread's composer as a chip.
- **History** is the pane's (`history: true`). **Share** on the bar is the
  guests pillar's (`ShareButton`, [work-guests.md](work-guests.md)).
- **Its keys** are its own while the caret is in it: the text column's
  frame (`DocumentFrame`) is marked `data-editor-keys`, `document` when he
  may edit and `read` when he may not, so ⌘B is bold and ⌘K a link there
  and not Sidebar and Search ([work-editors.md](work-editors.md) "Who hears
  a key"). A project's page draws the same frame, so the rule holds there too.
- **Export…** in the pane's More, File → Export… and ⇧⌘E open Preview on
  the format he last used: the body answers the `export` command
  (`useWorkCommands`).
- **Print…** in the File menu, and ⌘P while the caret is in the document,
  open Preview on Print: the body answers `print` too. It answers no `find`
  yet, so ⌘F stays the app's.

## Preview

Preview is a state of the document (the frame is the formats pillar's,
`work/formats/PreviewFrame.tsx`; its look is docs/DESIGN.md "Work editors:
Preview", its contract work-editors.md). The body draws it through a portal
into a slot over the editor, which stays mounted, unseen and `inert`, so the
caret, the scroll and the collab connection are kept; Edit puts him back in
the words.

`work/docs/previewSource.ts` is the document's `PreviewSource`, one object
for as long as the document is the same one:

| Format | Drawn | By |
|---|---|---|
| Word, OpenDocument, Rich Text | the exported file itself, converted on the host (`work.formats.preview`) | LibreOffice |
| PDF | the document's print page, written here from the editor's blocks and printed on the host, in Calibri's twin (the page carries its faces: work-editors.md "Fonts") | TempCode |
| Print | the same PDF: the pages that go to paper | TempCode ("As it will print") |
| Markdown | the host's text (`work.formats.export`) | the file's own text |
| Web page | the page written here, in a frame where no script runs and nothing is fetched | the file's own page |

- **Export writes the document as it stands when he presses**, never a
  picture kept from an earlier look (he may have gone back to the words
  since). Word, OpenDocument, Rich Text and Markdown go through
  `work.formats.export`, which needs no renderer for Word, so Word still
  goes out on a host that cannot draw it. A PDF is the same print the
  preview makes, read from the render the host keeps: an unchanged document
  saves the bytes he saw. The system's save dialog is the answer.
- A LifeOS document another host serves is drawn, read and exported on that
  host (`servedBy`), as it is opened there; that host is told the source and
  never this host's item, and keeps the render with no item (swept after a
  day).
- **In this format** (`docDrops`) is counted from the document: comment
  threads and waiting suggestions as the canvas counts them, and footnotes,
  colours and underlines from the editor's blocks (`blockFacts`), then what
  the host's own writer said it dropped. Only what is true of today's writers
  is said:

  | Format | Lines |
  |---|---|
  | Word, OpenDocument | "3 suggestions go as tracked changes" for people's, "2 suggestions stay out until you accept them" for an agent's (the host's `heldSuggestions`); comments go whole |
  | Rich Text | the same, and "2 comments lose their replies" (counted from the threads someone answered) |
  | PDF, Web page | "2 comments stay behind", "3 suggestions stay out until you accept them", "1 footnote moves to the end" (every colour is kept: the page writes it inline) |
  | Markdown | comments and suggestions as a PDF's, "Colours stay behind", "Underlines stay behind" |

- **Print…** hands the PDF to this computer's own PDF viewer, which prints
  it (`work/formats/printOut.ts`, work-editors.md "Print"): the same render a
  PDF export saves, so an unchanged document prints the pages he saw. In
  `/ui` the PDF opens in a tab on his press. Print's lines are a PDF's, the
  host's own among them.
- **Not yet.** The document has no page set-up, so Preview's Page section is absent and a
  PDF is printed on the locale's paper with the print page's own margins;
  the editor still draws in the system's font, since no text can name one
  until the format row lands; "Check in Word" is not offered (no
  Office renderer is registered); headers, footers and columns a Word file
  carried are not counted in the lines.

## Where the Docs view went

The Docs row is gone from the column (F6 of the Files plan,
[work-files.md](work-files.md)). What it did is done in the Files place:

| The Docs view | Now |
|---|---|
| the list of LifeOS documents and sheets | the LifeOS place, its projects as folders |
| the search, titles and words inside | Files' search (`/` or ⌘F, Return), LifeOS among its sources |
| Filter: kind, edited within, shared | the search's bar: Kind, When it changed (a span kept as its word), Others can open |
| Filter: place, project, last edited by, needs review | the bar's More: Place, Project, Changed by, Needs review |
| saved views | saved searches, the same `work_docs_views` rows (work-files.md "Search and Go to") |
| group, sort, list or table | the page's view options and view switch |
| a document opened in place | a Files tab of its own |
| New | New in the LifeOS place |
| Space or X to pick, ⌘A, Escape | Files' selection; Space is Quick Look |
| Ask on the picked rows, a chip each, eight at most | the selection bar's Ask, the same |

What it did that Files does not, and why, is in work-files.md "Search and
Go to" ("What a saved view says that Files does not"). A way in that still
names the view (`openWorkView({view: 'docs', doc})`, a search hit or a
window from a release behind) opens the document in a Files tab, or the
LifeOS place when it names none (work/shell/WorkViewPage.tsx,
`filesOfDocs` in work/files/openFrom.ts).

## Finding documents

One list per Work workspace, built by the host
(`src/main/server/work/docs/find.ts`) for `doc_find`, and for a project's
link picker through `work.docs.find {workspaceId, query?}` (which a window a
release behind also reads), judged by pure rules both sides share
(`src/shared/work/docFind.ts`: `FindEntry`, `FindFilter`, `findIn`). Each
place is searched where its text lives:

| Place | What is listed | What a search reads |
|---|---|---|
| LifeOS | the sector's documents and sheets, up to 300 of each, newest edit first (`catalog:list`, one table 50 rows a page so each call stays inside a query's read limits; a row whose project moved to another sector is held to its project's sector), each with who last changed it, its open comment threads and its waiting suggestions; kept on the host 30 s, read afresh on `refresh` | titles here; a document's text through Convex's full-text index over its plain projection (`catalog:search`, index `docs.search_plain`), as the Work service last stored it, keeping only documents that hold every word. A sheet's cells are not searched. |
| The folder | files under the workspace's folder whose kind a canvas opens, by extension, found by Files' own walk (`walkNames`, files/search.ts: its caps, hidden names and links left out as a listing leaves them; the walk is kept 10 s and shared while on its way) | titles; a `.tcdoc`'s text through the Work service and a `.csv`'s from disk, the newest 200, kept in memory by path and change time, 32 MB at most across the host, least read dropped first |
| Threads | the workspace's canvas items that live elsewhere: Google, Microsoft, a file outside the folder (listed under Thread), and what a thread made (forms, dashboards) | titles only |

Live guest links mark their LifeOS items `guest`; a held act still waiting
(or failed) whose payload names an entry's id, path or Google file as a
whole value counts against it (`held`). A remote key is held to the path
fence file by file, so a folder the fence denies inside the workspace's
folder shows nothing. With a query, the text matches come back with the
words around the first match; title matches sort first.

**Filters**, all optional and combinable (`FindFilter`): kind (document,
sheet, PDF, deck, media, recording, form, dashboard), project (or none),
place (LifeOS, Folder, Google, Microsoft, Thread), who last edited (him, an
agent, a guest), edited within a span (past day to past year) or between
dates, shared or guest-linked, needs review (open comments or waiting
suggestions), held. **Saved views** keep a search, its filters and the
grouping, order and layout the Docs view drew under a name, with the
workspace (`work_docs_views`, at most 50). Files reads and writes them as
its saved searches; `work.docs.views`, `saveView` and `dropView` stay for a
window a release behind.

**The same rows as Files' search.** For the same words `doc_find` and
`work.files.search` find the same LifeOS rows (the same catalog read,
`lifeosCatalog`, and the same `catalog:search`) and the same files of the
workspace's folder (the same walk); `places/lifeos.test.ts` holds them to
it. `doc_find` keeps what a thread reads beyond that: a `.tcdoc`'s and a
`.csv`'s text, comments, held acts, and the items threads hold.

## The tools

`doc_find` is the agent's search of the workspace ("the budget sheet from
last month" is `{query: "budget", kinds: ["sheet"], edited_after:
"2026-10-01"}`): the same filters, a project by name or id, a sort and a
limit, each line ending with the source `canvas_open` takes. A workspace's
thread searches its own workspace, and so its own sector; a Work Chat
searches every Work workspace on the host; a thread with no Work home
(work-scope.md) is refused. The same rule holds the other doc tools: a
thread with no Work home, or of a workspace with no sector, reaches no
LifeOS document.

`doc_read`, `doc_write`, `doc_suggest` and `doc_comment`, each taking
`item` (a document in the thread's canvas), `doc` (a LifeOS document id) or
`file` (a `.tcdoc` path). `doc_write` takes the whole new text as markdown;
blocks left as they were keep their ids and comments.

The rule (architecture §6.7, §8.4): `because: "asked"` writes at once only
when its `quote` is in one of the owner's own messages in the thread
(`ctx.threads.ownerSaid`), else it is the agent's own idea and the reply
says so; `"routine"` only in a routine's run, and on his own document; `"own"` on a shared document,
or one set to suggest, waits as a branch; on his own document it is
written as one version and the bar shows it with Undo. The verdict is
this host's: the service is told `asked`, `routine` or `own` after the
check, never the model's word. `doc_suggest` always waits. `doc_comment`
is refused on a shared document (others would read it before he did); on
his own it makes the thread, then marks the first place the words stand (a table's
cell included); words that are not there make no thread.

The LifeOS worker's own write route (`/internal/doc/write`, M17's
`update_project_doc`) cannot see the thread's words, so any `asked` or
`routine` it carries counts as its caller's own idea there: on a shared
document it waits as suggestions.

Two more holds. A thread reaches only its workspace's sector: a LifeOS
document of another sector answers "LifeOS has no such document", and the
service is told the thread's sectors, not "all" (a Work Chat reaches every
sector). And the words Ask quotes into a message (a chip's head and its
`> ` lines) are not the owner's words: `ownerSaid` reads only what he typed
(`typedWords`, work/threads.ts).

## Agent suggestions stay private

The owner's ruling (2026-11-23): an agent's pending suggestion on a
document anyone else can open is kept on his host and shown only to him.
Nothing of it enters the live document others sync, a guest's page, the
file, its sync folder or an exported file until he accepts it; then it is
written as an ordinary edit. A change he asked for in so many words is
still written at once; a routine's is written at once only where nobody
else reads.

- **Who else can open it** (`othersOpen`, `madeFromShared` in
  docs/target.ts, asked by the tools and by `work.docs.open`): a LifeOS
  document whose row is shared (a guest link, or a project link that lists
  it); a `.tcdoc` `sharedOf` says lies where others reach it (a Teams or
  OneDrive library, the cloud folder, another host, the Windows VM); the
  `.tcdoc` the importer wrote under `work-files/imports` for a file in a
  library. On these an agent's own idea is always a branch.
- **Where a pending agent branch lives**: a LifeOS document's in LifeOS's
  `docBranches`, read with the owner's key only; never in the live room, so
  a guest's socket, `/g/<id>/item`, `/g/<id>/threads` and another window
  sync none of it (guests/private.test.ts). A `.tcdoc`'s, for every
  `.tcdoc`, under this host's data
  (`<userData>/work-service/private-branches/<sha256 of the path>/`, 0700),
  never in the zip (history/privateBranches.ts): a path's sharing can change
  with no write. An older file's agent branches move out at the first touch;
  a decided one is removed. A Word author's and his own restore's stay in
  the file. Keyed by path: a moved `.tcdoc` leaves them behind.
- **Exports leave every agent suggestion out**, on any document, shared or
  not: Word, OpenDocument, Rich Text, Markdown and Preview's render. The
  answer counts them (`heldSuggestions`) and Preview says "3 suggestions
  stay out until you accept them"; a person's still go as tracked changes
  (`EXPORT_HOLDS_AGENT_SUGGESTIONS`, formats/serviceRoutes.ts).
- A Google Doc's mirror holds only Google's own suggestions; an agent's go
  to Google through the google pillar (work-google.md).

## LifeOS desktop

A project note opens in LifeOS desktop's markdown editor exactly as before
while `blockDocs` is off. With it on, the note sheet asks
`projectDocs.open`; a note that is a document opens in the shared editor
(`SharedDocEditor`, loaded on first use), at
`wss://tempcode.landonhale.com/w/doc/<id>` (`VITE_WORK_SERVICE_URL` changes
it) with a token from LifeOS's own `docs.collabToken`, its threads read
and written through `docs.*`. Two things must happen before that socket
opens on the real box: the owner applies the tunnel rule
(scripts/box/ingress.yml), and TempCode's setting `work.lifeos.jwks` holds
LifeOS's public keys so the service trusts LifeOS's tokens (nothing
publishes them yet). `blockDocs` is to go on only then.
