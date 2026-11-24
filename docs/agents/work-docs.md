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

A close of the socket sends what still waits first: frames queued behind a
send in flight go up, then `work.docs.close` closes the host's socket behind
them. And a tab's close waits for the document to be on disk: the body
registers its item's flush (`registerFlush`, canvas/flush.ts), which sends
every frame the editor has handed the socket and then `work.docs.send` with
`stored: true`, answered once the service has applied what that socket sent
and stored the document (`/internal/docs/stored`). So whatever judges the
file after the close (a Word file's document he only looked at, files/word.ts
`wordsLeft`) reads its change time as he left it. The route stores that
document alone, in its save turn, and reads its store's own answer
(docs/storeBook.ts wraps the service's stores): a write that fails is a 503
with the reason, never an ok. In the window the flush asks for the store
only once the service has applied every update the socket sent: the relayed
socket counts each update it sends (Hocuspocus sync steps 2 and 3, read from
the frame's head, `frameHead`) and each SyncStatus the service answers once
it has applied one, and a new socket must first have sent its own state (its
step 2) before it counts as caught up. A socket still connecting is waited
for (`relayTiming.syncWaitMs`), and so is the provider's next socket after
the host dropped one (what he typed meanwhile waits in the window). An
update sent while the host stores sends the flush round again, so the
store it confirms covers the latest. The flush fails on a failed send, an
update the host refused, a socket that closes or never catches up in time,
and while frames lost since the last confirmed store wait (`storedAll`); the
document says "Couldn't save your last edits to Plan" and the flush's
failure reaches the close (what the close does then is Files'). The live revision (`/internal/docs/rev`, the
Word file's autosave and header) hashes the Yjs snapshot, the delete set with
the state vector, so a deletion alone moves it.

While a LifeOS document has a socket open here, main watches its threads
in LifeOS and pushes `work.docs {threads: true}` when they change, so a
comment made in LifeOS desktop shows at once.

## The schema gate

A document may now hold things an older editor cannot read: a run's font,
size, colour and highlight, a paragraph's own formatting, and the page map
(its named styles, theme and page set-up). An older editor would delete
what it cannot read, for everyone (y-prosemirror removes an attribute it has
no name for, and drops text whose marks it cannot make). So a document says
its **schema** (a number in its `page` map: 0 for every document before
2026-11-23, 1 once anything of the new kind is first put in, 2 once it holds
a table of contents), and the Work service holds one line, in work-kit's
collab server (`schemaGate: true`, `service/serve.ts`; work-kit
`src/collab-server/README.md` "The schema gate"):

- **A number per kind of thing, and a document is raised only as far as it
  needs.** 1 is styling (`STYLED_SCHEMA`); 2 is the table of contents block
  (`CONTENTS_SCHEMA`), a node an editor that knows 1 would delete. A styled
  document with no table of contents stays at 1 and still opens in a window
  that knows 1; inserting one asks for 2 first, and a window that knows 1 is
  then off the document before the block is written. A host says the highest
  it knows (`DOCUMENT_SCHEMA`, now 2), never the number of a document. A
  thing added to the editor after a release has shipped takes the next
  number: see work-kit `src/collab/document.ts`.
- **An older window, a newer host.** A client says the highest schema it
  knows in its socket's address (`?schema=n`; one that says nothing is
  refused every document: "A window that says no schema", below). The
  service refuses a document whose number is higher, before any of it is
  sent, and the editor shows its refused line: "Update TempCode to open this
  document." No editor is mounted on it. When a document's number
  rises, every client on it that knows less is closed first.
- **The number rises only by the service's hand**, on an editor's ask
  (`ensureSchema`), before that editor writes the new thing; a host-side
  writer calls `raiseSchema` on the collab server. A window that knows the
  schema and writes something newer without asking (a styled paste into a
  classic document) is not refused: the service does the rise by that write,
  before the write goes to anyone. A window that knows less is refused
  anything newer. Nothing lowers the number.
- **A paste.** The editor's own HTML carries a font and a paragraph's
  spacing, so a copy out of a styled document could write them into a classic
  one. On a host that keeps schema 1 it goes in whole and the document is
  raised as it arrives; on an older host it comes in as its words and their
  bold and italics alone (work-kit `classicPaste`).
- **A newer window, an older host** (the Mac updated before the box).
  `work.docs.open` answers `schema`: the highest the serving host reads and
  writes. A host from before the gate answers none, which is 0, and the
  window's editor then offers nothing of a newer schema: the format row's new
  controls are absent, with no line, and what he has is what that host can
  keep.
- The socket is relayed (above), so the window's number rides in
  `work.docs.connect {schema}` and the host's own socket says it for the
  window. A whole number and nothing else is ever written into that
  address.
- The hosted pages (a guest's link, the phone) are built with the service
  they are served by, so they know what it knows, and say so: the guest
  socket (`/g/ws/<link>`) carries the page's `?schema=` through to the
  document's own socket (`service/routes/guests.ts`), and the guest's editor
  is told the service's number (`hostSchema`).

**The first copy.** The editor is on the page, under the bones, before the
document's first copy has come over the socket. Until it comes the editor
writes nothing: its opening paragraph is the schema's own default, which
y-prosemirror never writes. work-kit v65 to v71 broke this (an unset `para`
was hidden after the editor's first document was made, so the opening
paragraph was no longer the default): the editor wrote its empty paragraph
first, the document's copy arrived as a second root beside it, and the editor
then kept the root that sorts first and deleted the other. Yjs sorts two
inserts at one place by client id, a fresh random number at every open, so
about one open in two emptied the document for everyone. **TempCode v1.0.361
(work-kit v64) is clean; v1.0.362 (v66) shipped the fault**; master carried
it from DOC3 until 39335bbec (work-kit v72, which hides the attribute before
the first document is made and holds it with `src/editor/first-copy.test.tsx`).
A guest's Edit link at a phone's width found it
(`scripts/proof-doc-guest-phone.ts`); two running instances, one of them
v1.0.362's build, showed that the release has it and that the gate let it in
(`scripts/proof-doc-gate.ts`, `.temp-code/plans/landed/DOC-gate/`). Anything
new that touches the editor's schema after `BlockNoteEditor.create` must pass
`first-copy.test.tsx`.

**A window that says no schema is let onto nothing.** The gate defends a
document by its number, and a classic document has none: a window from
before the gate says no schema, was taken as knowing 0, and was let onto
every classic document. v1.0.362 is such a window. So the service refuses a
client that says no schema at all, on every document (`refuseSilent`,
`service/serve.ts`; work-kit `src/collab-server/README.md`), before anything
is sent to it or taken from it. The reason is a schema refusal's own words,
because the editor in v1.0.362 already reads those: it shows "Update TempCode
to open this document." with no Retry and mounts no editor. A window of
v1.0.361 or older shows its own refused line. Every page this service itself
serves (a guest's link, the phone, the owner's hosted editor) is built with
it and says its schema; a window says it through `work.docs.connect
{schema}`. **A document emptied by a v1.0.362 window comes back from
History**: the newest row from before, then Restore (checked on the proof's
own emptied file: four blocks back, the empty state kept as
"before-restore"); a document has such a row if it was ever imported, left
idle after an edit, written by an agent or named.

## Styling: the format row

On a document he may edit, the body's first, unscrolled row is the format
row (work-kit `src/format`'s `FormatRow`, the same row the sheet and the deck
draw; its look is docs/DESIGN.md "Work editors"). The editor makes it
(work-kit `src/editor/format-row.tsx`, `DocumentEditor`'s `formatRow`) and
draws it into a place of the body's own (`[data-doc-row]`, `formatRowInto`),
above the scroller, so the text scrolls under it and Preview covers it. Its
layers are held inside the body. The slot is marked `data-editor-keys`, so
⌘B in the size field is bold and not the sidebar.

- **What it sets.** Undo and Redo; the paragraph's style (Normal text,
  Title, Subtitle, Heading 1 to 3, Quote, Caption, and a file's own); the
  font and its size in points; Bold, Italic, Underline; text colour and
  highlight (the theme's colours with their tints, ten standard ones,
  Automatic, a hex); alignment; line spacing and the space before and after;
  the three lists; indent less and more; Insert (Table, Picture, Link, Page
  break); Preview. When the row runs out of width its controls fold into ⋯ in
  the order every editor uses. The keys are shared.md's table
  (`work-kit/format/keys`): ⌘\ clears formatting, ⇧⌘. and ⇧⌘, step the size,
  ⌥⌘0 to ⌥⌘3 set Normal text and Heading 1 to 3, ⇧⌘7 to ⇧⌘9 the lists.
- **How it is stored** (work-kit `src/editor/README.md` "Styling"): a run's
  `fontFamily`, `fontSize`, `color` and `highlight` styles; a paragraph's
  formatting as one block prop, `para`; the document's named styles, theme
  and page set-up in its `page` map. A font is named as Office names it and
  drawn with its twin (work-editors.md "Fonts"): the editor asks the window
  for the faces through the kit's `fonts` (`DOC_FONTS`, `work/docs/fonts.ts`).
- **A classic document stays classic until he styles it.** A document made
  before the row has no page and is drawn as it always was (the house ladder,
  the system's font). The first thing of the new kind he sets (a font, a
  size, a colour, a named style, spacing) asks the service to raise the
  document (the schema gate, above); the document is then given its page (the
  built-in styles, the TempCode theme, Letter or A4 by his locale) and is
  drawn in its own styles from then on: Calibri 11 pt at 1.4 lines, in its
  twin. On a host that cannot keep the new things the row shows only what a
  classic document holds.
- **Read only.** No row and no format keys on a document he cannot edit; the
  text is still drawn in the document's own styles. The Docs view and a
  mail's attachment have no row.
- **Undo.** ⌘Z and the row's Undo take back what he did on a live document.
  They did not before this landed: the shared undo went deaf when the editor
  mounted (work-kit `src/editor/README.md`, rule 0).
- **On a guest's page** an Edit link gets the row in the page itself; Comment
  and View get none.

## The table of contents

Insert → Table of contents (the format row and the slash menu, on a host
that knows schema 2) puts in one block that lists the document's headings,
levels 1 to 3, each a row: the heading's words and, in Pages, its page number
after a dotted leader. It follows the text as he types; a press on a row
goes to its heading. It is read, never written: nothing of it is in the
document but the block and its `levels`. Out: Word gets a real TOC field
(Word's own gallery control, `TOC \o "1-3" \h \u \z`, a row a heading with
its page number, bookmarks on the headings), and a Word file's TOC comes in
as the block; a web page and a PDF get the rows as links to the headings;
Markdown gets a list of links. `doc_read` shows it as that list, and an
agent's write around it leaves it where it stands. The page numbers come
from the Pages layout through one seam (work-kit `ContentsPagesContext`);
with no layout the rows have none. A Word table keeps its header rows
through Word as he made them (one header row stays one: work-kit v74).


## Pages

A styled document is drawn as sheets of its own paper while it is edited
(the look is docs/DESIGN.md "Work editors: Document pages"). The layout is
the editor's (work-kit `src/editor/pages/`: the text is laid out once at the
paper's true size around floats that end each page, and zoom is a transform);
the pane holds the view, the zoom, the bar's fact and the print.

- **The view and the zoom are the item's.** `DocState` keeps `view` (`flow`
  or `pages`) and `zoom` (`width`, `page` or a percent) once he picks them,
  with the scroll place. Until then the canvas's width as the item opens
  decides (`openingView`, `openingZoom` in `DocumentCanvas.tsx`): Pages from
  640px (`PAGES_FROM`), Flow under it; 100% from 864px (`TRUE_SIZE_FROM`, a
  US Letter sheet inside the stage's sides), Fit width under it. A later
  resize changes nothing. The body passes `view`, `onView`, `zoom`, `onZoom`
  to `DocumentEditor`, which draws Pages only for a styled document. The
  editor hands the pane its editor once the document is read; a document
  that is classic then (`onOpened(false)`) is held in Flow for as long as it
  stays open, so styling it never moves the text onto sheets.
- **The pane makes room in CSS.** The scroller drops its padding and takes
  `--stage`, and the column drops its measure, gutter and title, wherever
  the editor's `.te-pages-stage` is inside them (`has-[.te-pages-stage]`,
  `IN_PAGES`). The editor knows the document is styled a frame before the
  pane is told, and a rule keyed on what is drawn has no frame in which the
  sheets stand in the column's padding. Only the comment margin is state
  (`threadMargin` is left out while sheets are drawn).
- **"Page 2 of 5"** comes from the editor's `onPages` as he scrolls and is
  kept by item id in a small store (`tellPage`), which the kind's `Bar`
  reads; it is cleared when the view is Flow, when the document is not
  styled, and when the document goes.
- **The tokens** are six in `index.css`, a value per theme: `--page`,
  `--page-edge`, `--page-ink`, `--page-ink-2`, `--page-rule`, `--page-dim`.
  work-kit's `pages.css` reads them by those names, with fallbacks that only
  matter to a host without them. `lib/tokenContrast.test.ts` holds the inks
  to 4.5 on the sheet and the edge and the rule to the edge floor;
  `lib/darkHeld.json` holds their dark values.
- **One print contract.** The editor hands the pane a `DocumentHandle` for a
  styled document, in either view (`onDocumentHandle`): `scrollToPage`,
  `openPageSetup`, `setSetup`, and `pagesHtml`, which in Pages writes the
  laid-out frame as a page of its own (every rule of the window's style
  sheets, `@page` at the paper's size with no margin, paper colours) and in
  Flow answers null. `previewSource.ts` `printPage` waits for the sheets to
  settle (`pagesSettled`: three frames with no new layout, a second at
  most), asks for that page with the document's faces inlined (`printFonts`,
  as `data:` URLs: the print window loads no file) and sends it to
  `work.formats.preview` as the PDF; Print… prints those bytes. So in Pages
  the PDF and the print are the sheets he sees. What he sees and the
  document does not hold must not print: under Preview the body hands the
  editor no review (`review` is null while Preview is up) and closes find,
  so the sheets carry no suggestion and no tint. In Flow, and for a classic
  document, the page written from the blocks goes as before
  (`htmlDocument`), and Chromium breaks it into pages itself: its page
  breaks can differ from Pages' by a line.
- **Preview's Page rows are the document's set-up.** For a styled document
  he may edit, the source's `setup` is read from the document's page each
  time Preview draws and written through the handle's `setSetup`
  (`documentSetup`): Paper (Letter, A4, Legal, A3, A5: Tabloid is not a
  document's, `CommonSetup.papers`), Orientation, Margins, Headers and
  footers. A change waits for the sheets, then Preview draws again. A reader
  and a classic document have no Page rows.
- **Where Pages and the PDF may differ.** Columns are kept, exported and
  drawn by Word and LibreOffice, and not drawn in Pages or its PDF (one
  line says so). Footnotes stand at the document's end in both. A table
  longer than a page breaks between rows with its header drawn again; the
  spike found rows of such a table on different pages in Chromium's print
  than on screen, and work-kit's own report says how far that is closed.
  The Word file LibreOffice draws is another engine's layout: its page
  count can differ from Pages' by a page.
- **Undo takes back a change of the page set-up, a header or a footer** as
  one step, apart from his typing (work-kit `PageFlow.undoable`). A named
  style's or the theme's change is not a step of Undo: an Undo never takes
  a document's styling away. He sets those back in the format row.
- **Not built here**: a reader's own switch and zoom (a document he can only
  read opens by the width rule and has no row to change it), and keeping the
  same words in view across a switch of view.

`scripts/proof-doc-window.ts` proves the pane in a running window: sheets on
the stage at true size, the stage edge to edge, the bar's fact and its
following the scroll, Flow and back, a double press on a margin opening Page
set-up, Narrow margins moving the breaks and Undo putting them back, find's
tints on the sheets, the PDF's page count against the sheets' and against
LibreOffice's drawing of the Word file, and Preview's Margins row setting
the document's own margins.

**The guest's page** (`src/hosted/guest/DocPage.tsx`, `opening.ts`) holds
the pane's two widths (`PAGES_FROM` 640, `TRUE_SIZE_FROM` 864; a test holds
them equal) against the page's own width as it opens. His pick of view and
zoom lives for the page's life (nothing is stored for a guest). A document
that was classic at open stays in Flow when styled. Under 640px the view is
Flow whatever was picked (`useWide(PAGES_FROM)`), and `guest.css` draws no
switch there. In Pages the column gives up its measure and padding in CSS
(`has-[.te-pages-stage]`), `main` wears `--stage`, and comments open at
their words.

## The canvas

The shared editor in a 672px measure with a 52px gutter for the block
handle, the title above it in the document ladder's title step (renamed in
place for a LifeOS document). What it tells the pane:

- **Presence**: the editor's carets, mapped onto `--presence-1..8` by
  colour (the two palettes are one, in order).
- **Mode**: "Agent writes" or "Agent suggests", switched in the bar on his
  own document (`work.docs.mode`, kept per document in `work_docs_mode`);
  on a shared document it suggests and cannot be switched. Shared is a
  LifeOS document a guest link marks, a `.tcdoc` others can open where
  it lies, or the document kept for a Word file of another computer
  (`othersOpen`, docs/target.ts: "Agent suggestions stay private").
  A mode change the host refuses puts back the mode before the press.
- **The state line**: the editor's own sentence when it is offline, waiting,
  read only or did not open.
- **The agent's last write**: "Wrote 1 section, 2:04 PM" with Undo, which
  is `work.docs.dismiss {undo: true, after}`: the host restores the version
  before the write only while the document is as the agent left it. The line
  carries the version cut just after the write (`DocWritten.after`); the
  press names it, and the host acts on, and clears, only the line of that
  write (a newer write's line stays, and an Undo naming none restores
  nothing). The service compares it with the live document and restores in
  one turn of the document (`/internal/docs/undo`, `history.inTurn`), so no
  other window's edit lands between the check and the restore. `after` is
  given only when both versions are the states on either side of the
  write: a direct rewrite takes the live state across the cut of its
  before-version and again, with its post-edit state, in the tick of the
  edit, and the version cut after it must still be that state (`undoable`);
  a change of his anywhere in between (a word, his margins) withholds it. A
  direct format's after-version must hold formatting alone over its
  before-version (`formattingAlone`): work-kit makes its edit and both cuts
  with no point at which the host can take the state, so a change of his
  that is formatting too, made in the same instant, is not told apart (the
  owner's trade, r4-answers.md). Else the line has no Undo. Changed since by
  anyone, nothing is restored (his words would go too): the line goes and a
  toast says "Not undone: the document has changed since. Restore an
  earlier version from History." (`undoWritten`). A line with no `after` (an
  older host, or a write whose after-version took in someone's edit) offers
  no Undo; a host a release behind that cannot undo says "Not undone here.
  Restore an earlier version from History." Kept in memory on the host: after a restart
  the line is gone and History still has the version.
- **Opened once per source**: the open keys on the source's value, so a
  canvas push, which hands every item afresh, never reopens the editor
  under his hands.
- **Suggestions**: each pending branch (`work.history.branches`) drawn in the
  text as the editor's review, one group a branch named for whose it is.
  A changed line is cut into pieces (work-kit's `inlinePieces`): "8:00
  becomes 7:30" is one change, taken alone with
  `work.history.decide {which: ['<block>#<n>']}`; a block put in, taken out
  or moved, a change of type or style, and a table's changed cells are one
  change each, the cells tinted in their cells. A change of style, size or
  spacing says what it does in one small line over its block ("Heading 1
  becomes Normal text", `changeWords` of the diff row, the review's
  `words`), as a compare does. Accept all and Reject all are the pane's
  own.
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
  open Preview on Print: the body answers `print` too.
- **Find…** in the Edit menu, and ⌘F while the caret is in the document,
  open the editor's own find (work-kit `find`, `onFind`): a small bar at the
  text's top right with the count ("3 of 17", "No results"), Match case,
  Whole word, the two arrows, and Replace and Replace all on a document he
  may edit. Every match is a tint drawn on the text, never written into it;
  a replace is one step of undo. The body answers `find` and opens the bar
  through the handle the editor hands it. Enter and ⇧Enter step, Escape
  closes it and leaves the match in hand chosen. A project's page and a
  mail's attachment mount the frame without `onFind`, so ⌘F stays the app's
  there.

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
| Word | the exported Word file (`work.formats.preview`) | LibreOffice, or Word on Check in Word |
| OpenDocument, Rich Text | the exported file itself, converted on the host (`work.formats.preview`) | LibreOffice |
| PDF | the document's print page, printed on the host: in Pages the sheets he sees (`pagesHtml`, with no mark of the editor's own: `withoutEditorMarks` draws comment washes, carets, their names and others' selections as plain text); else written here from the editor's blocks, a styled document's with its own styles, theme, paper and margins (`htmlDocument`'s `page`) and the faces it names, a classic one's in Calibri's twin (work-editors.md "Fonts") | TempCode |
| Print | the same PDF: the pages that go to paper | TempCode ("As it will print") |
| Markdown | the host's text (`work.formats.export`) | the file's own text |
| Web page | the page written here, in a frame where no script runs and nothing is fetched | the file's own page |

- **Export writes the document as it stands when he presses**, never a
  picture kept from an earlier look (he may have gone back to the words
  since). Word, OpenDocument, Rich Text and Markdown go through
  `work.formats.export`, which needs no renderer for Word, so Word still
  goes out on a host that cannot draw it. A PDF is the pages Preview shows,
  read from the render the host keeps, even when another window changed the
  text since: what he checked is what he saves. A new draw takes its place,
  and a press before it lands makes the print anew. The host keeps the
  render before a format's newest one too, for another window still showing
  it; when the shown pages are gone anyway, nothing goes out unseen: Print
  and Export say "These pages are no longer kept. Close Preview and open it
  again to check the current ones." until Preview draws again. The pages
  shown when he pressed decide: a draw that starts while their bytes are
  read never puts its pages in their place. The system's save
  dialog is the answer.
- **Check in Word** is offered on Word when the app is ready or this host's
  Windows VM can wake on his press. The Word picture has a rev of its own.
  If Word is out of reach after he presses, the LibreOffice picture stays.
  A file others can open (a library's, the cloud folder's) is never offered
  it: the Office renderer may be another computer than the file's own, and
  which one it is is the office pillar's to say.
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
  | Word, OpenDocument | "3 suggestions go as tracked changes" (a person's; comments go whole); an agent's "stay out until you accept them" |
  | Rich Text | the same suggestion lines, "Replies to 2 comments become separate comments", "Theme text colours become fixed colours" |
  | PDF, Print, Web page | "2 comments stay behind", "3 suggestions stay out until you accept them", "1 footnote moves to the end" (every colour, font, size and style is kept: the page writes them); on PDF and Print a styled document's set-up (`pageDrops`): "2 columns print as one; Word keeps them", and from Flow "The header and footer print only from Pages" |
  | Markdown | comments and suggestions as a PDF's, "Colours stay behind", "Underlines stay behind", and the styling lines below |

  **Styling a format cannot hold** is said once each, only of a document that
  has it (`blockFacts` counts runs that name a font or a size, paragraphs with
  spacing of their own, paragraphs that wear a named style): "Fonts and sizes
  stay behind", "Named styles stay behind", "Paragraph spacing stays behind".
  Only Markdown says them. The Word export is what LibreOffice converts.

  The live fixture in `formats/previewLosses.live.test.ts` measured the
  conversions back through Word. OpenDocument kept the reply linked to its
  comment and kept the theme colour linked. Rich Text kept both comment
  texts as separate comments and set the theme text colour to its RGB
  value. Both kept the person's tracked insertion, the footnote,
  font, size, highlight, underline, Title style, paragraph spacing, two
  columns, and the header and footer with their page fields.
- **Print…** hands the PDF to this computer's own PDF viewer, which prints
  it (`work/formats/printOut.ts`, work-editors.md "Print"): the render
  Preview shows, so what goes to paper is the pages he checked. In
  `/ui` the PDF opens in a tab on his press. Print's lines are a PDF's, the
  host's own among them.
- A styled document's Page section edits its own set-up. The PDF and Print
  write that page, and Word exports the page and its running bands. Columns
  are not drawn on PDF and Print, and the header and footer print only from
  Pages: Preview says both (above).

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

`doc_read`, `doc_write`, `doc_format`, `doc_suggest` and `doc_comment`, each taking
`item` (a document in the thread's canvas), `doc` (a LifeOS document id) or
`file` (a `.tcdoc` path). `doc_write` takes the whole new text as markdown;
blocks left as they were keep their ids and comments. `doc_read` ends with
the text's revision (docs/revision.ts `revisionOf`, a hash of the markdown),
which the service answers with the very text it read, styled reads too;
`doc_write` needs it and is refused when the text changed since ("read it
again"), so a rewrite drafted from an older read never erases what he typed
in between. The service checks it where it writes, in the document's turn:
a direct rewrite on the live text in the same tick it is made of it
(`collab.edit`'s copy), a suggestion just before its branch is made (a word
landing inside work-kit's own write then shows in the suggestion, never in
the text). `doc_suggest` takes it too, optional. `doc_read` with
`with: "styles"` adds the named styles, theme, page setup and the blocks
with formatting of their own after the text.

`doc_format` takes `on` with a quote, block ids, a named style or `all`,
plus the run or paragraph changes. Its `style`, `theme`, `setup`,
`header` and `footer` set the document's own formatting. Leave out
`on` when setting those alone. It follows the same rule as `doc_write`.
The page part of a suggestion is one step in the review. Taking it
keeps other page settings he has changed since the suggestion.

The rule (architecture §6.7, §8.4): `because: "asked"` writes at once only
when its `quote` is in one of the owner's own messages in the thread
(`ctx.threads.ownerSaid`), else it is the agent's own idea and the reply
says so. On a document others share, the message must also point at this
document by what identifies it alone, exactly as written (no case or
spacing folded): its path, its LifeOS id or the canvas item it was named
by, as the reference of a chip Ask put in (a file chip's JSON read as
JSON), or in the words he typed himself, whole and never inside a longer
path or id (`ownerSaid` with `about`, work/threads.ts `pointsAt`). A chip's
label and the words it quotes never count. A title does
not count (two documents may share one, and "Plan" stands inside "Travel
Plan"); his words about another document, or naming this one by its title
alone, wait as suggestions here; `"routine"` only in a routine's run, and on his own document; `"own"` on a shared document,
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
  library; the document kept in the workspace's own folder for a Word file
  of another computer, which a `work_files_word` record names (`keptForWord`,
  by real path): Save as Word and the autosave carry its live text to that
  Word file, so only his accept reaches it. On these an agent's own idea is
  always a branch, and `doc_comment` is refused.
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

## Proofs in a running window

Two scripts open a real page on a real Work service and read what is DRAWN.
Run both before a change to the editor's schema, the socket or the guest
page lands (the first-copy fault passed every unit test and failed both):

- `env -u ELECTRON_RUN_AS_NODE heavy bun scripts/proof-doc-window.ts` (after
  `electron-vite build`): an isolated instance under xvfb (`e2e-work-lib.ts`
  `Run`), a styled Word file imported into a Work Chat's canvas. It checks
  that the pane draws the words, the list and the table; that the stored
  document is whole after the window opened it; the fonts; the format row;
  find's count and tints; an agent's `doc_format` waiting as a suggestion
  that says "Heading 1 becomes Heading 2"; Preview's pages; no sideways
  scroll. Each state is shot in dark and in light (the window is told the
  theme as the app tells it, class and event, so a styled document's colours
  are that theme's).
- `heavy bun scripts/proof-bun.ts scripts/proof-doc-guest-phone.ts` (after
  the hosted build; its head names the environment it reads): the guests
  pillar's three links on one styled document, opened in WebKit and Chromium
  at 390 and 768px, light and dark: the text drawn, the server's bytes
  untouched by an Edit open, a Bold tap reaching the service, the row's fold,
  44px targets, no sideways scroll, a clean console; and a second,
  three-sheet Word file for Pages: each link in Flow under 640px with no
  switch in the row, as sheets from 640px fitted to the screen with a header
  and footer on each, no sideways scroll, a tap typing on a sheet and
  reaching the service, Flow and back by the row, an open writing nothing,
  and as many sheets as the app's own pane draws for the same file. That
  last number comes from the script's other half, run first on a built tree:
  `env -u ELECTRON_RUN_AS_NODE heavy bun scripts/proof-doc-guest-phone.ts
  --desktop --out <folder>` (it leaves the file and the count where
  `DOC8_DESKTOP` says). `DOC8_ONLY=<pattern>` runs only the pages whose name
  matches. 405 checks.

- `scripts/proof-doc-gate.ts`: two running instances, a host of this tree
  and a window of an older build from its own worktree (`GATE_OLD_TREE`),
  paired as his Mac's window is to the box. It found the fault of v1.0.362
  ("The first copy"). It was written against the gate before a silent
  window was refused every document: its head says which steps to turn
  before it is run against master.

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

## A Word file of a Teams library

A `.docx` opened from a library on another computer, or in the Windows VM, is read into a document kept in the
workspace's own folder, and the Word file is written back as our Word export: on his press, or by itself once he
chose that (or for a file New made here). The rules, the header's words and the first-time question are in
work-files.md "A Word file from another computer". That document counts as shared ("Agent suggestions stay private"):
a thread's own `doc_write` or `doc_format` there waits as a suggestion, the window opens it locked to suggest, and a
key that may not approve views it. A tab's close stores it first ("The socket"), so a quick close after a typo keeps it.

