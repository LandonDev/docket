# Work: the canvas pane and its items

The canvas is the pane beside a Work thread that shows what the thread is
working on: a mail, a document, a sheet, a PDF, slides, images and video, a
live browser, an item's history, a meeting, a form, a dashboard. This file
covers the frame every kind shares and how a kind plugs into it. The look
is docs/DESIGN.md "The canvas pane"; the plan's contracts are
`.temp-code/plans/work-architecture.md` §7.

**What is built:** the frame (tab row, the kind's bar, the fold, the one
review stepper, the selection bar with Ask, the composer's chip row, a
kind's own rows in More), the store with its methods, push, tools and move
hook, and both registries. All eleven kinds have their bodies, each
described in its pillar's file (work-mail.md, work-docs.md, work-sheets.md,
work-pdf.md, work-slides.md, work-media.md, work-browser.md,
work-history.md, work-meetings.md, work-forms.md, work-dashboards.md). The history
kind was seen in a running isolated instance (milestone 19's live run), and
the form and dashboard kinds in milestone 36's.

## The pane

A thread whose row says `scope: 'work'` has its view wrapped in `CanvasSeat`
(src/renderer/src/work/canvas/CanvasSeat.tsx), by `ThreadView`. The seat
reads the thread's open items (`useCanvas`, store.ts: `work.canvas.list`
once, then the `work.canvas` push) and seats them in `SplitShell`, the
frame a plan and a report already use:

- The seat is there before the thread has a message: a thread its host
  holds with no rows, or whose rows are still coming, is drawn by
  `SessionPane` as one muted line (or the skeleton) over the composer, and
  for a Work thread that word goes to `ThreadView` as `quiet`, in the
  chat's place inside the same seat, so an item opened before the first
  message (a file from the Files view) shows beside it at once, and the
  first rows replace the word without remounting the item. Before
  2026-11-23 such a thread skipped `ThreadView`, and a file opened from
  Files showed as a new chat with no viewer.
- With no item open the thread fills the pane as it always did. It sits in
  the same place in the tree with and without items, so an item arriving
  never remounts the transcript.
- With items, the shown item is at the left and the thread at the right.
  The item takes 70% (`ITEM_SPLIT`) and the thread never goes under 360px;
  the sash, its double-click reset and the conversation toggle are
  `SplitShell`'s. The tab row is the header's `lead`: tabs in the strip's
  chip shape (`CanvasTabs`), one item alone as a title with one muted fact,
  then the kind's `TabEnd`, More (the kind's own entries, Accept all,
  Reject all, Close, Close others) and the toggle. Tabs reorder by drag (`work.canvas.reorder`),
  close on a middle click, and the arrows move along the row.
- Under the row, `CanvasPane` draws the kind's bar (`KindBar`), the one
  state line, the kind's body and the selection bar. Only the shown item's
  body is mounted; a kind keeps what it needs across a tab switch with
  `state` and `setState`. A kind says its own failures on the state line
  with Retry; a body that throws, or whose code never arrives, is caught by
  its chunk's boundary and said the same way (`bodyFailed`,
  CanvasPane.tsx: "Couldn't open this document", then a thrown sentence as
  it is, "It could not be shown" for a fault in the code, or "Its viewer
  did not load", and Retry); what the body fed the frame (its state line,
  stepper, mode, More) goes with it. Never a blank pane or a bare chip.
- Which tab is shown and whether the thread is folded are this window's,
  kept per thread in localStorage (`work.canvas.view.v1`). The items are
  the host's, so they are there after a restart and on every client.

A subagent's `canvas_open` opens beside its root thread. A research or a
master thread of Work scope keeps its own board; its canvas sits to the
left of that view, which nobody has designed.

## The registries

`CANVAS` (work/canvas/registry.ts) holds one `CanvasKindDef` per kind, each
in the folder of the pillar that owns it (`work/<pillar>/canvas.ts`;
`CANVAS_PILLAR` in src/shared/work/canvas.ts maps kind to pillar). The
types are in work/canvas/kind.ts, which a pillar imports. A missing kind
fails typecheck, and registry.test.ts loads every kind's chunk and checks
its `Body`.

`kindFor(source, { mime?, name? })` picks the kind for a thing to open: the
kind that claims the source (a LifeOS row by its table, a Microsoft file by
its Office app, a browser session, a Frame.io file), else the one that
claims the mime type (a Google file's own, or the hint's), else the one
that claims the file extension; null when none does. A pillar corrects its
own `opens`.

`kindForFile(name, mime?)` (the same file, on the work-canvas chunk's
barrel) is the one lookup for a file from outside: a drop, Open file…, a
mail's attachment. It goes by the extension, and by the mime type only when
the name has none, since a desktop's or a mail's type is a guess from the
name (`main.ts` arrives as `video/mp2t`). The Docs view's list, which the
host builds, reads extensions from `kindOfFile` (src/shared/work/docFind.ts);
registry.test.ts holds the two to the same claims.

## Fetched sources

An item whose bytes live elsewhere comes to the host before its kind opens
it: today a mail's attachment (`{at: 'mail'}`, work-mail.md
"Attachments"). A pillar registers the fetcher for its `at`
(`registerCanvasFetcher`, src/main/server/work/canvas/fetch.ts; the mail
pillar's `start` registers `mail`), and `work.canvas.fetch {itemId}` runs it
once per item into `canvas/<owner>/<item>/file/<name>`, a part file renamed
into place only when whole, with `work.canvas.fetch` pushes
`{itemId, received, total}` at most every 150 ms. `work.canvas.read
{itemId, offset, length}` gives the bytes back by range (8 MB at most a
read). A kind's host side opens the copy as it opens a file of his:
`fetchedPath` in pdf/file.ts `sourcePath` (the PDF and the deck), sheets/held.ts
`heldOf` (.xlsx, .xlsm, .csv), media/prepare.ts (a copy in the version's
cache, which the media host serves), the meetings service's start (the
recording) and formats/importer.ts (a document read into `<name>.tcdoc`
beside the copy, which the docs pillar holds read only: `fetchedItemOfPath`
knows any file in an attachment's folder). `work.canvas.keep {itemId}`
copies the file into the item's workspace folder (`keepFetched`: Save to
workspace, and the first half of Keep as document). The window's list of those kinds is
`FETCHED_KINDS` (work/canvas/fetched.ts); a kind added there must read the
copy first.

In the pane (`CanvasPane`, `useItemFetch`) the kind's body and its own tools
wait for the copy: the document's bones meanwhile, the first line a 4px bar
and "2.1 of 8.4 MB" once the host says a size of a megabyte or more
(`FetchState.tsx`); a failed fetch is `Couldn't open this PDF` (sheet, deck,
file) with the host's sentence and Retry, never bones. Once it is there the
bar has Download, then Save to workspace in a pane with a workspace, before
History, each its glyph alone in the narrow bar.

**A mail's file is read only until it is kept.** For an item whose source is `{at: 'mail'}`, in every kind, the frame takes no `mode`, `review` or `written` from the kind (frame.ts `useFrame`) and draws no History: the bar is the kind's own reading tools (pages, zoom, find, play), Download, Save to workspace and the ⋯. What an agent proposes on the private copy stays marks in the body. The host is as it was.

## Panes that are not a thread

A workspace's Mail view owns items as a thread does, under
`mailPaneOf(workspaceId)`: `CanvasStore.open` and `reorder` take it for a
Work workspace of this host (`workWorkspace`), and `workspaceRemoved` drops
its rows and folders. `CanvasSeat` takes `onAsk` for such a pane (Ask goes
where the view says; Open from Google… is not offered) and `chatToggle`
for the word and glyph of the toggle that folds what sits beside the items.

`ACT_VIEWS` (work/acts/registry.ts) holds one `ActKindView` per held act
kind, in `work/<pillar>/act.ts` for the pillar `ACT_PILLAR` names.
`chunk: null` means the Outbox's generic view (the summary and the payload
as text); a pillar gives a kind its own by pointing `chunk` at a module
that exports `View`. The Outbox draws them (work/acts/ActView.tsx,
[work-outbox.md](work-outbox.md)).

## Registering a kind

The document kind, as its thread would write it. Nothing outside the
pillar's folder changes.

```ts
// src/renderer/src/work/docs/canvas.ts
import { defineChunk } from "../../lib/lazyChunk";
import { Doc } from "../icons";
import { defineCanvasKind } from "../canvas/kind";
import type { DocState } from "./DocumentCanvas";

export const documentCanvas = defineCanvasKind<DocState>({
  kind: "document",
  label: "Document",
  icon: Doc,
  opens: { sources: [{ at: "lifeos", table: "docs" }, { at: "microsoft", app: "word" }], ext: ["tcdoc", "docx"] },
  phone: "web",
  guestable: true,
  chunk: defineChunk("work-docs-canvas", () => import("./DocumentCanvas")),
});
```

```tsx
// src/renderer/src/work/docs/DocumentCanvas.tsx: the chunk. `Body` is required; `Bar` and `TabEnd` are optional.
import { useEffect } from "react";
import type { CanvasBodyProps, ReviewAdapter } from "../canvas/kind";

export interface DocState { scrollTop: number }

export function Body({ item, source, env, state, setState, shell }: CanvasBodyProps<DocState>) {
  const doc = useDocument(env, source);            // the pillar's own data
  const changes = doc.pending;                      // [{ id, group, … }]

  // Who else is in it, and what the agent does to it.
  useEffect(() => shell.presence(doc.people), [shell, doc.people]);
  useEffect(() => {
    shell.mode({ value: doc.shared ? "suggests" : "writes", set: doc.setMode, note: doc.shared ? "Others can edit this, so changes wait for you" : undefined });
    return () => shell.mode(null);
  }, [shell, doc.shared, doc.setMode]);

  // The pending changes: the pane draws Previous, 2/6, Next, Reject, Accept, and Accept all in More.
  useEffect(() => {
    const review: ReviewAdapter | null = changes.length === 0 ? null : {
      groups: doc.branches.map((b) => ({ id: b.id, label: b.label, by: b.by, count: b.count })),
      index: doc.caretChange,                       // -1 when the caret is in none
      count: changes.length,
      step: (to) => doc.goTo(changes[to]),          // scroll it into view and outline it
      accept: (which) => doc.accept(which),         // a number, { group }, or "all"
      reject: (which) => doc.reject(which),
    };
    shell.review(review);
    return () => shell.review(null);
  }, [shell, changes, doc]);

  // A source that did not answer: one line over the last copy, read only, with its one action.
  useEffect(() => shell.statusLine(doc.error ? { tone: "failed", word: "LifeOS did not answer", detail: `Read only, as of ${doc.asOf}`, action: { label: "Retry", run: doc.retry } } : null), [shell, doc]);

  // A selection: the pane floats Ask over it; Ask puts the chip in the thread's composer.
  const onSelect = (text: string, rect: DOMRect | null) =>
    shell.selection(rect ? { chip: { kind: "selection", label: `“${text.slice(0, 40)}”, ${item.title}`, ref: source, quote: text }, rect, tools: <CommentButton /> } : null);

  return <Editor doc={doc} scrollTop={state?.scrollTop ?? 0} onScroll={(scrollTop) => setState({ scrollTop })} onSelect={onSelect} />;
}

/** The kind's own tools in the bar, after the mode. */
export function Bar({ shell }: CanvasBodyProps<DocState>) {
  return <Button variant="ghost" size="xs" onClick={shell.openHistory}>History</Button>;
}
```

What a kind should know:

- `shell` is stable for an item, so an effect may depend on it. Each feed
  replaces what the kind said before; null takes it back. The pane forgets
  every feed when another tab is shown, and drops a call that comes late
  from a body that left.
- The feeds: `review`, `selection({ chip, rect, tools })`, `presence`,
  `mode({ value, set?, note? })` (null: the kind has no mode; no `set`: the
  mode shows and cannot be switched), `statusLine` (`failed`, or `needs`
  for the one amber case, a source that needs the person to sign in),
  `written({ text, undo? })` (what the agent last wrote directly, in the
  stepper's place), `detail` (one fact after a lone item's name: where a
  browser runs), `ready(open)` (whether the item has opened: History, which
  the pane draws for a `history: true` def, waits for the kind's chunk and
  is held back while the kind says false, so a loading or failed item is
  never a bar holding History alone; a kind that never says is drawn as
  opened. The document says it; a Word file being imported says false),
  `saved({ state, at?, where?, pending?, detail?, actions? })` (what saved
  means for the item now: `saved`, `saving`, `offline`, `conflict`,
  `readonly`, `copy`, `downloading` or `asleep`, kind.ts `SavedLine`. The
  frame keeps it in `feeds.saved` and draws it nowhere beside a thread; a
  file's header in the Files place reads it. Call it as `shell.saved?.(…)`:
  a kind saves as he works, says `conflict` with Reload and Keep mine as a
  copy when the file changed under it, and flushes when its body unmounts,
  since a tab can close under it from another window).
  The calls: `openHistory()` opens a `history` item on the
  same source; `ask(chip)` puts a chip in the thread's composer, unfolding
  the thread first, as the selection bar's Ask does; `held(ref)` opens a held act where held acts are shown
  (`onOpenHeld` in work/canvas/held.ts, which the Outbox registers).
- A kind's own pillar tells Files three more things on the host, through
  registries that are empty until something registers and are kept whenever
  it does (src/main/server/work/files/hooks.ts, which imports only types):
  `registerFileMaker(kind, { forms, blank(target) })` writes a blank file of
  a form its editor then edits in place (`FileForm`,
  src/shared/work/fileForms.ts), at a path Files hands it and moves into
  place itself; `registerFilePreviewer(kind, (source, { page, width }) =>
  PNG)` draws one page; `registerFileMoved((from, to, { db }) => …)` re-keys
  what the pillar keeps by a file's path, inside the rename's own savepoint.
- A kind's loading view uses `ItemBones` / `ItemSkeleton`
  (work/canvas/ItemBones.tsx), the pane's own fallback shape, so nothing
  moves when the chunk lands; a failed load shows its failure, never bones.
- The tab row scrolls when its tabs pass what fits, past their 36px floor
  (CanvasTabs: `OVERFLOW_FADE` and `useOverflowEdges`, the title strip's
  settled row), and brings the selected tab into view.
- The stepper prints "2/6" with a change in hand, and the count alone ("6")
  with none (`index` -1), never "0/6". Next then takes the first change,
  unless the adapter says `enter: false` (stepping from there shows nothing,
  as on a form's Responses), when it is not lit.
- While a kind's code loads, the bar holds a 12px bone in its tools slot
  (`data-bar-bone`), the document's own, so the body does not drop 32px
  when the code lands.
- The bar is drawn only while the kind has something in it. Its order is
  fixed: people, the mode, the kind's `Bar`, History (drawn by the pane for
  a def with `history: true`), then the stepper or the written line.
- A `Bar` that renders nothing (null, or an empty fragment) leaves no bar
  when nothing else is fed: the bar is then drawn only while its tools
  slot (`[data-canvas-tools]`) has something in it, by a CSS rule
  (`BAR_TOOLS_ONLY` in KindBar.tsx), and the `Bar` stays mounted so it can
  fill it later. A meeting with no recording yet has no bar.
- The kind's tools slot takes the bar's free room, so a tool given
  `ms-auto` sits at the slot's end, just before History and the stepper.
- The bar is a size container (`@container/bar`), and under `BAR_NARROW`
  (560px of canvas) it takes its narrow form by CSS alone, the same at run
  time and in a static render: the people go, the mode reads "Suggests" or
  "Writes" (the full words stay its name and its menu's rows), History is
  its glyph with a tip, and the stepper drops its group's name and trades
  Previous and Next for one Next that goes round from the last change to
  the first ("Step to the next change"), keeping "1/3", Reject and Accept,
  so every change is reachable before any is decided. While the adapter is
  `held` every step rests too, the count still drawn. The end group gives
  up room only through words (the group's name, a written line); History,
  the count and the verbs never shrink, and the bar clips rather than
  spill. The narrow form starts when the bar's content box (its width less
  its 20px of padding) is under 560px.
- A tool is whole or hidden, never cut mid-word by the slot's clip. A kind
  marks each tool that can go in the narrow form with `data-narrow-hide`
  (any element in its `Bar`; a switch, a long label, a second verb), and
  the tools slot hides it under `BAR_NARROW` (`TOOLS_NARROW` in
  KindBar.tsx), and above it too while the slot cannot hold its tools
  (the slot's `data-tight`, set by `useTight` from its scroll width, kept
  until the slot is as wide as the tools needed). An unmarked tool is
  clipped to the slot like any overflow, so what a narrow bar still needs
  stays unmarked and must fit beside the stepper; the kind can also use
  `NARROW_HIDE` on a part of a tool (its word beside a glyph).
- `more(entries)` puts the kind's own verbs in the pane's More, first,
  over the frame's own (Accept all and Reject all, then Close and Close
  others): `{ id, label, icon, disabled?, run }`, each a 14px glyph and a
  verb as every menu row is. A `run` that throws or rejects is said once
  in the thread's toast stack. Like every feed it is forgotten when
  another tab is shown; null takes the entries back. It is optional on
  `CanvasShell` only so a stand-in shell written before it still types;
  the pane always gives it.
- `state` is undefined until the kind keeps something; it is one value for
  `Body`, `Bar` and `TabEnd`, held in memory while the window lives.
- `ReviewAdapter.index` counts across all groups, from 0. With more than
  one group the stepper names the group the current change is in.
- A glyph only Work draws goes in work/icons.tsx, never chrome/icons.tsx,
  which is in the first paint.
- Tints for a change, a selection and the rest are tokens
  (docs/DESIGN.md "Canvas tints"): `bg-(--add-bg)`, `bg-(--del-bg)`,
  `bg-(--sel-bg)`. A pillar adds no token.
- A test can drive the frame with its own kinds: `<CanvasSeat kinds={…}>`
  and work/canvas/testkit.tsx (`fakeHost`, `drivenKinds`).

## Where this differs from the architecture's §7.3

The types are the contract a kind builds to; where they differ from
`work-architecture.md` §7.3, this file is right.

- `shell.mode` is a feed, `mode({ value, set?, note? } | null)`, not a
  property with `setMode`: the kind knows whether an item is shared and its
  own tools must honour the mode, so the kind keeps it and tells the pane.
- `shell.selection` takes `{ chip, rect, tools? }`, not a bare
  `ContextChip`: the bar needs to know where the selection is and what the
  kind's own controls are.
- `shell.written`, `shell.detail`, the def's `history` and the chunk's
  `TabEnd` are added, each for a part of the approved design §7.3 has no
  home for (the line after a direct write, where a browser runs, History in
  the bar, the switch to real Excel in the tab row).
- `state` is `S | undefined`: the pane cannot know a kind's first state.
- `Bar` and `TabEnd` take the body's props; there is no `CanvasBarProps`.
- The types live in `kind.ts`, and `registry.ts` re-exports them.
- The push is `work.canvas` (the naming rule) and carries `opened`;
  `work.canvas.open` takes `itemId` to open a closed item again.

## Opening a file from outside

A file dragged from the desktop (Finder, Explorer, a Linux file manager)
opens in the viewer of its kind; so does one picked with Open file… in the
pane's More, or the File menu's Open File…, through the system's open dialog.

**Where a drop opens** (work/canvas/fileDrop.tsx, `dropPlaceOf`). One
listener on the document, mounted while Work is on (`FileDrops`, in
WorkRailHost), marks a file drop that means "open" in the capture phase
(`claimFileDrop`, lib/workSwitch.ts), so the composer, which takes a drop
anywhere else in its pane, lets it pass (`fileDropClaimed`); it acts in the
bubble phase, and only when no surface inside took the file first
(`defaultPrevented`):

| Where | Opens in |
|---|---|
| a Work thread's pane, anywhere but the composer's box | that thread's canvas; the wash covers the canvas when it has items, else the pane |
| a Work draft's pane (a Work workspace's or a Work Chat's draft), anywhere but its composer | the draft, made a thread first (`ensureCreated`) |
| a Work view (`[data-file-opens]` on its region: Docs, Tasks, Mail and the rest) | a new thread of the workspace |
| the composer's box | attached to the message, as before |
| a surface that takes files itself: a document (makes a document of a Word, markdown, HTML or PDF file), an empty meeting (its recording), Mail's composer (an attachment) | that surface, as before |

Nothing moves while a file is dragged. The wash goes when the drag leaves:
a drag from the desktop that leaves the window sends nothing more, so no
dragover for 350 ms ends it (`DRAG_QUIET_MS`). Code workspaces are out of it:
a code thread's or code draft's pane keeps the composer's drop. Open File…
in the File menu is greyed unless a Work thread, draft or view is in front
(`workFilePort`, which the router fills; lib/openFilePlace.ts `filePlaceOf`).

**Which kind.** `kindForFile` (above). Several files at once open one after
another, the first shown and the rest as its tabs. Files no kind shows are
one toast, "No viewer for <name>", whose action, Add to the thread as a
file, puts them in the thread's composer as attachments (`giveComposerFiles`,
lib/composerDrafts.ts); from a view, the thread is started only then.

**Where the bytes go** (work/canvas/fileOpen.ts, `openFiles`). A file a kind
shows is uploaded to the thread's host with `attachment.begin {into:
'workspace'}`: it lands in the workspace's own folder under its real name
(`keptFileName`, `Name (1).ext` on a collision), or the thread's attachment
dir for a Work Chat (which goes with the thread: deleted with it, or 30 days
after it is archived), and opens as `{ at: 'file', host, path }` like any file item,
which the Docs view then lists as the folder's. A file already inside the
workspace's folder on the thread's own host opens in place, with no copy. A
file with a path is read on its own host in ranges (`hostSource`), so a big
one never sits whole in the window; the host's `attachment.maxBytes` holds
(200 MB by default); a file with no path (dragged from another app's
memory) is read whole in the window first. While it goes up, the pane says so
(`setOpening`, one entry per open so two at once keep their own lines;
CanvasSeat's `OpeningState`: the name, a bar from 4 MB, and Cancel); Cancel
stops before the next chunk, or before the open once the last chunk is in, and
the host drops the partial file, so nothing is written. A host that dies mid
upload leaves its hidden `.upload-<id>.part` behind. An agent sees the item as any other
(`work.canvas.list`, `canvas_open`'s list).

## The composer's chips

What a message is about (a task, a mail, an event, a selection) is a
`ContextChip` held per thread in src/renderer/src/work/canvas/chips.ts
until the composer sends:

- `addContextChip(sessionId, chip)` puts one in a thread's or a draft's
  composer. A view that starts a thread from a task calls it on the draft
  (it is also on the work-canvas chunk's barrel); Ask in a canvas calls it
  on the thread beside the item, unfolds the thread and gives the composer
  the caret.
- The composer is in the first paint and the store is not, so the composer
  asks through a port (`chipPort`, src/renderer/src/lib/contextChips.ts)
  that the store fills as it loads: how many chips a thread holds, the
  message with the chips' lines in it when it sends, and what a create is
  about. With no Work
  code loaded there are no chips and the composer is as it was.
- The composer draws the row over its field (`ComposerChips`, mounted only
  while it holds a chip), lets a chip alone be sent, and writes each chip
  into the message as a line the model reads (`chipLine`: `About this
  task: Book the ballroom (LifeOS tasks k1)`; a selection's words quoted
  under it). The lines go above his words, or after them when the message
  opens with a slash command, which a harness reads only at the start.
- A draft's first chip also rides `session.create` as `about` (`aboutFor`,
  read by `ensureCreated`, kept until the thread exists so a create tried
  again still says it), which the host answers through
  `work.admitSession` and links in LifeOS (`ctx.links.link`, work-lifeos.md).
- Ask's key is ⌘L (Ctrl+L off macOS), live while a kind feeds a selection.
  Settings → Keybindings lists it in the Work group while Work is on.

The sent bubble draws the chips back from their lines (`sentChipsOf`,
work/canvas/sentChipsOf.ts, which takes a line only when its brackets hold a
reference `refWords` writes; `SentChips`, work/canvas/SentChips.tsx) over his words,
the lines and their quoted words gone from the text and Copy still copying
the message whole. Only a message that may hold chip lines (it opens with
"About this ", or has one after a blank line) asks for the work-canvas
chunk; until it lands the words show as they went. A chip opens what it names when this window can
show it: a LifeOS document or a canvas item in the thread's pane, a held act
in the Outbox, a task, mail, event or routine in its workspace's view (the
view, not the row in it). A person, a project, a selection's file and
anything in a Work Chat that needs a workspace's view are labels.

## Mentions

The composer's `@` offers Work's things beside files, threads and notes:
LifeOS's tasks, mail threads, events, projects, people and documents, the
thread's own canvas items, the held acts waiting in the Outbox and the
workspace's routines. A pick becomes a chip, and the message carries its
line with a short excerpt quoted under it (`chipLine`), so the model gets a
reference it can open with its tools and a few words of what it says.

**Where it is offered.** A Work thread, a Work Chat (its draft included),
and a code thread of a workspace linked to a sector, on a host with Work
on. The host decides what each may read, from the row, or for a draft from
where it will be made (`mentionReachOf`, work/scope.ts, `ctx.mentionReach`):

| Thread | Offered |
|---|---|
| a Work workspace's | its sector's LifeOS things; its own pane's items; the workspace's held acts and routines |
| a Work Chat | every sector's LifeOS things; its own pane's items; the held acts outside every workspace |
| a code thread of a linked workspace | that sector's LifeOS things, nothing of Work's own |
| an unlinked code thread, a loose chat, a Work thread with no Work home | nothing |

The host reads LifeOS as the owner, so the sector is the fence on the
host: a LifeOS row is kept only when its sector is in reach, whatever
LifeOS answered, and a workspace with no sector reads none. Items are the
pane's alone (open and closed): another thread's item cannot be opened by
id from this one, by the window or by `canvas_open`.

**The wire.** `work.canvas.mentions {sessionId, draft?, text, kinds?}` →
`MentionAnswer {hits, failed}` (src/shared/work/mentions.ts). It needs
`approve`, as `work.lifeos.jwt` does (it reads his mail), and is carried to
a far host only while its screen is unlocked. Each kind answers at most
five hits (`MENTION_PER_KIND`), best or newest first; the answer is in kind
order (`MENTION_ORDER`). A kind that throws or takes over 4 s is named in
`failed` and the rest answer; the LifeOS kinds are named there while
LifeOS is not connected.

**Registering a kind.** A pillar lists its own on its module:
`mentions: MentionSource[]` (modules.ts), each `{kind, lifeos?, search(text,
reach, ctx)}`. `lifeos: true` marks a kind read from LifeOS, the only kinds
a code thread is offered. The router (canvas/mentions.ts `searchMentions`)
asks every module's list; nothing else changes. The kind's name is one of
`CHIP_KINDS` (src/shared/work/canvas.ts), which the phone's generated
contract reads; `card` is there already for a project's cards, so the
projects suite adds its source in its own folder and edits no shared file.
A kind not in `CHIP_KINDS` adds its word there, its glyph to `CHIP_GLYPH`
(ComposerChips.tsx), its group to `GROUP` (canvas/mentions.ts) and its noun
to `CHIP_NOUN`; until then it draws with the item glyph and noun. The ref is
one of the chip's (`{at: 'lifeos', table}`, a `CanvasSource`, `{at:
'item', id}`, `{at: 'work', pillar, id}`); a sent chip opens only what
`openerOf` (SentChips.tsx) knows.

**The list** (chrome/useWorkMentions.ts, chrome/CommandPopover.tsx): on a
host with Work on, the text is asked a beat (120 ms) after the last key,
the first ask at once, through the work-canvas chunk (`askWorkMentions`),
which loads the first time and decides whether the thread may mention
Work's things at all (`mentionPlace`). The last answer
stays on screen until the next lands, so the list never empties under the
typing; until the first, one muted row says Loading…, and a kind that could
not be searched says so in one muted row ("Couldn't reach LifeOS"). Each
kind is a group under its name with its glyph, a muted fact (a sender, a
place, the canvas kind) and a time; in a Work thread they lead the list,
in a code thread they follow the files, threads and notes. Enter or a click
takes the typed `@words` out and adds the chip.

## The first paint

Nothing here is in the first paint (docs/agents/work.md "The first
paint"). `surfaces/chunks.ts` has one chunk, `workCanvasChunk`
(`work-canvas`), asked for by a Work thread's view, by a composer that
holds a chip or asks `@` for Work's things, and by a bubble that went with
chips; each kind's body is its own chunk behind that. The first paint
carries only the chip port (`lib/contextChips.ts`, a type from
`@shared/work` and no value), a few lines in the composer, the `@` hook
(chrome/useWorkMentions.ts: the timing and nothing else), a few lines in
the bubble (UserMessage.tsx `useSentChips`) and the seat's mount in
`ThreadView`. Who may mention, the rows, the stale-row filter, the
sent-chip parser and the chips themselves are the chunk's. Measured in
the build that moved them there (with the question card's own chunk,
surfaces/chunks.ts `questionChunk`), the entry is in the commit that says so.

## The store

The server keeps a thread's canvas items in one table and pushes the open list on every change. The files are all under src/main/server/work/canvas/: `store.ts` (the table, `CanvasStore`, the folders), `ctx.ts` (the part that makes the store and `ctx.canvas`), `index.ts` (the module: methods, tools, deleted threads), `tools.ts` (the two tools) and `move.ts` (the move hook). The wire is src/shared/contract-work-canvas.ts.

### The table

`work_canvas_items`, made by the module's `ensure` at every boot, Work on or off, with an index on `(session_id, state, position)`:

| Column | Meaning |
|---|---|
| `id` | a `randomUUID()` |
| `session_id`, `workspace_id` | the thread, and its workspace when the item was made (a move rewrites it) |
| `kind`, `title` | one of `CANVAS_KINDS`; the tab's label |
| `source` | JSON `CanvasSource`: where the item's truth lives |
| `state` | `open` (in the tab row) or `closed` (out of it, row and files kept) |
| `position` | the tab order among the open items |
| `rev` | goes up by one on every change to the row |
| `created_at`, `updated_at` | ms |

A row whose `kind` or `source` no longer parses is left out of every list and logged once; nothing throws.

### The methods

| Method | Capability | Does |
|---|---|---|
| `work.canvas.list {sessionId}` | read | `{ items }`: the open items, in tab order |
| `work.canvas.open {sessionId, itemId?, kind?, source?, title?}` | operate | opens an item last in the tab row and answers it; one that is already open keeps its place and is only shown. With `itemId`, that item of the thread again. Without, `kind`, `source` and `title` are all needed, and an item of the thread with the same kind and source (open or closed) opens again instead of a second one. Each open of `{ at: 'thread' }` makes a new item. |
| `work.canvas.close {itemId}` | operate | the item leaves the tab row; its row and its folder stay |
| `work.canvas.reorder {sessionId, order}` | operate | `{ items }`: the ids in `order` first, then the open items it left out, in their old order; ids that are not open items of the thread are ignored |

- Only a Work thread has items: an open for a code thread throws `not a Work thread: <id>`, and one for a thread that does not exist `unknown thread: <id>`. A close, reorder or reopen of an item or thread that does not exist throws a plain sentence too.
- A thread holds at most 32 open items (`CANVAS_OPEN_MAX`); the 33rd open throws. Opening an item that is already open is no new tab.
- An item whose source is `{ at: 'thread' }` owns `<userData>/canvas/<sessionId>/<itemId>/` (`canvasItemDir`), made with mode 0700 when it opens and kept when it closes. `canvasDirOf` is the thread's whole folder. Both refuse an id outside `[A-Za-z0-9_-]`.
- Every method is carried on a relayed lane to the host the lane names (`CANVAS_RELAY` is empty: work.md "The relay"). The path fence reads the file a `source` names, so a remote key cannot open `/etc/passwd` as `{ at: 'file' }`.

### The push

Every change sends `{ push: 'work.canvas', sessionId, items, opened? }` through `ctx.push` to every client socket: `items` is the thread's whole open list in tab order, and `opened` names the item an open just made or opened again, for the pane to select.

A remote key sees only the paths it could name itself. A source's path (`{ at: 'file' }`, and a Microsoft workbook opened by path) that the listener's fence does not admit (`ctx.reaches`) reaches a remote key cut to the file's name (`fencedItem`, store.ts): in `work.canvas.list`, `open` and `reorder` answers by the caller, and in the push, which then goes twice, whole to this host's windows (`{ only: 'local' }`) and cut to remote keys (`{ only: 'remote' }`). While every path is one a key may name, one push goes to all (F3).

### How the module and the part share one store

A module's `handle` gets the context and nothing else, but the store needs the session registry and the data dir, which only a part gets. So the part (`canvasPart` in ctx.ts) makes the database's one `CanvasStore` from `deps` at boot and leaves it in a `WeakMap` keyed by the database (`setCanvasStore`). The module and the tools find it with `canvasStoreOf(ctx.db)`. `ctx.canvas.open`, `close` and `forSession` are the same store's methods, so they push the same push. `ctx.canvas.get(itemId)` reads any item, open or closed (null when there is none), and `ctx.canvas.paneOf(sessionId)` is the thread whose pane a thread's items show in (its root thread). A pillar reads items through these two and never imports `canvasStoreOf` from canvas/store.

### The tools

Both act on the calling thread's pane, which for a subagent is its root thread's (`CanvasStore.paneOf`): a subagent has no pane the person looks at, so what it opens shows beside the thread he reads.

- `canvas_open {kind?, title?, source?, item?}`: opens a new item (all of `kind`, `title` and `source`) or one of the thread's items again (`item`). It answers one line naming the item and its id, then the open items as `id  kind  title` lines, with `structuredContent: { item, items }`.
- `canvas_close {item}`: closes one of the thread's own items.

A bad set of arguments, another thread's item or a refusal from the store comes back as `isError: true` with a sentence, never a throw.

### Deleted threads and workspaces

`sessionsRemoved` deletes the threads' rows and their `canvas/<sessionId>/` folders. `workspaceRemoved` does nothing: a deleted workspace's threads are removed too, through `sessionsRemoved`.

### What a move carries

The part registers the canvas as a move module at boot, Work on or off (`tableMoveModule('canvas', 'work_canvas_items', …)` in move.ts, through `registerMoveModule` in src/main/server/sessionMove.ts). When a thread moves to another host:

- every row of the thread and its subagents, open and closed, rides in the manifest's `modules.canvas` and lands with the workspace the thread lands in there;
- the files under `canvas/<sessionId>/` ride as `module` file entries (`rel` is `canvas/<path inside the folder>`);
- the source drops both once the move finishes, and a dropped landing leaves neither on the receiver;
- once the landing is the thread, the receiver pushes each landed thread's open list and tells LifeOS the thread's new host, so what the thread stamped there (`LifeosOrigin.host`) follows it: `workLinks:moved` with `{ threadId, host }` (`lifeosMoved` in move.ts is the one place that names it; the LifeOS milestones confirm the name and arguments). A move LifeOS could not be told of, because it is not built, not paired or down, is written in `work_canvas_moved` and told again when Work turns on and every five minutes while Work is on, each thread on its own, until LifeOS answers.

A host on this build without the canvas module refuses such a move at its start, by name. A host from before the move modules cannot land the thread without its items either: the digest the two hosts compare at the commit covers the modules' rows, an older host's does not, so the move fails there and the thread stays where it was, whole. Sources are not rewritten by a move: a file or a browser session names its host, and stays on it. History import (src/main/server/historyImport.ts) carries the rows and the `canvas/<sessionId>/` folders too, as it carries every `work_*` table with a `session_id` column.
