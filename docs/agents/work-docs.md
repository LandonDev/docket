# Work: documents

Milestone 20 of the Work plan. The document kind of canvas item, the Docs
view of a linked Work workspace, the agent's document tools, and LifeOS
desktop's notes on the same editor. Built on the shared block editor
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
| The canvas and the view | `src/renderer/src/work/docs/`: `canvas.ts`, `DocumentCanvas.tsx`, `DocsView.tsx`, `finder.ts` (the view's state), `view.ts`, `host.ts` (the calls and `RelaySocket`), `threads.ts`, `review.ts` |
| LifeOS desktop | `apps/desktop/src/renderer/src/components/shared-doc.tsx` (lazy), `doc-editor.tsx` (`SharedDocEditor`), `project-sheets.tsx` (the note sheet's choice) |

## Sources

A document is a LifeOS document (`{at: 'lifeos', table: 'docs', id}`), a
LifeOS project note that is one (`table: 'projectDocs'`: `projectDocs.open`
makes a markdown note a document once LifeOS's `blockDocs` is on, and
answers null before; the item then says LifeOS keeps it as text), or a
`.tcdoc` on this host inside the caller's path fence. Every method names the
source, not a canvas item, so the Docs view opens a document with no
thread. The kind also claims Word (`.docx`, `.doc`), OpenDocument, RTF,
markdown and text files: its body makes such a file a `.tcdoc` beside it and
the item reopens on that
(work-formats.md "Import and export"). A Google Doc opens on a mirror
of its own, read from Google when it is opened ([work-google.md](work-google.md)
"Docs"); its ⋯ adds Write to Google, Read again from Google and Open in
Google, and the doc tools refuse it for the google tools.

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
  on a shared document it suggests and cannot be switched.
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

## The Docs view

Everything the workspace holds, one line each (see "Finding documents"),
grouped by project by default with loose ones under "No project", newest
edit first. A LifeOS document, a `.tcdoc` or a Google Doc opens right in
the view, in the same editor, with a Docs control to go back; an item a
thread holds (a form, a dashboard, a Google or Microsoft file) opens that
thread; anything else starts a thread about it. The header carries the
search, Filter, View and New (a LifeOS document called "Untitled", opened
at once); on a document it carries Ask (a thread about it). Suggestions
are stepped in a thread's canvas, where the agent works: the view draws the
text as it stands.

## Finding documents

One list per Work workspace, built by the host (`work.docs.find
{workspaceId, query?}`, `src/main/server/work/docs/find.ts`) and judged by
pure rules both sides share (`src/shared/work/docFind.ts`: `FindEntry`,
`FindFilter`, `findIn`, `groupRows`). Each place is searched where its text
lives:

| Place | What is listed | What a search reads |
|---|---|---|
| LifeOS | the sector's documents and sheets, up to 300 of each, newest edit first (`catalog:list`, one table 50 rows a page so each call stays inside a query's read limits; a row whose project moved to another sector is held to its project's sector), each with who last changed it, its open comment threads and its waiting suggestions; kept on the host 30 s, read afresh on `refresh` | titles here; a document's text through Convex's full-text index over its plain projection (`catalog:search`, index `docs.search_plain`), as the Work service last stored it, keeping only documents that hold every word. A sheet's cells are not searched. |
| The folder | files under the workspace's folder whose kind a canvas opens, by extension (4 folders deep, 2,000 files or 20,000 entries looked at; hidden folders and `node_modules` skipped; the walk is kept 10 s and shared while on its way) | titles; a `.tcdoc`'s text through the Work service and a `.csv`'s from disk, the newest 200, kept in memory by path and change time, 32 MB at most across the host, least read dropped first |
| Threads | the workspace's canvas items that live elsewhere: Google, Microsoft, a file outside the folder (listed under Thread), and what a thread made (forms, dashboards) | titles only |

Live guest links mark their LifeOS items `guest`; a held act still waiting
(or failed) whose payload names an entry's id, path or Google file as a
whole value counts against it (`held`). A remote key is held to the path
fence file by file, so a folder the fence denies inside the workspace's
folder shows nothing. Titles match as he types, in the window;
the text matches come back once typing rests 150 ms, with the words around
the first match, which the row shows under its title. Title matches sort
first. The list is read afresh when the view opens, when the window comes back,
and when LifeOS's `catalog:stamp` (the sector's newest edited row, held
live as a cheap signal) moves; a reply older than one already shown is
dropped, and a row a search or filter hides leaves the pick.

**Filters**, all optional and combinable (`FindFilter`): kind (document,
sheet, PDF, deck, media, recording, form, dashboard), project (or none),
place (LifeOS, Folder, Google, Microsoft, Thread), who last edited (him, an
agent, a guest), edited within a span (past day to past year) or between
dates (the tool's), shared or guest-linked, needs review (open comments or
waiting suggestions), held. The Filter menu offers only the kinds, places
and projects the list holds. **View**: group by project, kind, date edited,
place or none; sort by date edited, date created or name; list or table
(the table drops the column the grouping already names). **Saved views**
keep the search, filters, grouping, order and layout under a name, with
the workspace (`work_docs_views`; `work.docs.views`, `saveView`,
`dropView`; at most 50), named in a dialog from the View menu.

**Keyboard**: `/` puts the caret in the search; ↓ or Return moves into the
list; ↑ ↓ move between rows, Return opens, Space or X picks a row (Shift for
a range), ⌘A picks all shown, Escape clears the pick, then the search.
**Picking**: the box on a row's hover, Shift-click for a range; the header
then shows the count, Ask (one new thread with each picked item as a chip,
up to the composer's eight: `startThread` takes several) and Clear.

The window keeps the spec, saved view and pick per workspace for its life
(`work/docs/finder.ts`). Another screen that wants a document by name (an
@ mention) calls `work.docs.find` and `findIn` the same way.

## The tools

`doc_find` is the Docs view's search for the agent ("the budget sheet from
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
