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
| The wire | `src/shared/contract-work-docs.ts`: `work.docs.{open,token,connect,send,recv,close,threads,thread,mode,rename,dismiss,create}` and the `work.docs` push |
| Main's module | `src/main/server/work/docs/`: `index.ts` (the methods), `target.ts` (what a source names), `relay.ts` (the socket over the link), `threads.ts` (comment rows), `state.ts` (mode, the last write, the relay), `tools.ts` (the agent's tools) |
| The service's routes | `src/main/server/work/docs/serviceRoutes.ts`: `/internal/docs/{read,write,mark}` on the Unix socket, behind the secret, listed in `service/routes/index.ts` |
| The canvas and the view | `src/renderer/src/work/docs/`: `canvas.ts`, `DocumentCanvas.tsx`, `DocsView.tsx`, `view.ts`, `host.ts` (the calls and `RelaySocket`), `threads.ts`, `review.ts` |
| LifeOS desktop | `apps/desktop/src/renderer/src/components/shared-doc.tsx` (lazy), `doc-editor.tsx` (`SharedDocEditor`), `project-sheets.tsx` (the note sheet's choice) |

## Sources

A document is a LifeOS document (`{at: 'lifeos', table: 'docs', id}`), a
LifeOS project note that is one (`table: 'projectDocs'`: `projectDocs.open`
makes a markdown note a document once LifeOS's `blockDocs` is on, and
answers null before; the item then says LifeOS keeps it as text), or a
`.tcdoc` on this host inside the caller's path fence. Every method names the
source, not a canvas item, so the Docs view opens a document with no
thread. The kind also claims Word, OpenDocument and RTF files: its body
makes such a file a `.tcdoc` beside it and the item reopens on that
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
- **History** is the pane's (`history: true`). There is no Share yet: it
  would list nobody, and a guest link is M31's.

## The Docs view

The sector's LifeOS documents (`docs:list`, the first 25), one 32px line
each, grouped by project (`projects:list`) with loose ones under "Other",
newest first. A row opens the document right in the view, in the same
editor, with a Docs control to go back; the header's verb is New on the
list (a LifeOS document called "Untitled", opened at once) and Ask on a
document (a thread about it). Suggestions are stepped in a thread's canvas,
where the agent works: the view draws the text as it stands.

## The tools

`doc_read`, `doc_write`, `doc_suggest` and `doc_comment`, each taking
`item` (a document in the thread's canvas), `doc` (a LifeOS document id) or
`file` (a `.tcdoc` path). `doc_write` takes the whole new text as markdown;
blocks left as they were keep their ids and comments.

The rule (architecture §6.7, §8.4): `because: "asked"` writes at once only
when its `quote` is in one of the owner's own messages in the thread
(`ctx.threads.ownerSaid`), else it is the agent's own idea and the reply
says so; `"routine"` only in a routine's run; `"own"` on a shared document,
or one set to suggest, waits as a branch; on his own document it is
written as one version and the bar shows it with Undo. The verdict is
this host's: the service is told `asked`, `routine` or `own` after the
check, never the model's word. `doc_suggest` always waits. `doc_comment`
makes the thread, then marks the first place the words stand (a table's
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
