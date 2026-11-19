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
hook, and both registries. The PDF, slides, images and video, meeting
and sheet kinds have their bodies (work-pdf.md, work-slides.md, work-media.md,
work-meetings.md, work-sheets.md); every other kind's body says "Not built yet" until its
pillar's milestone builds it. Nobody has seen the pane in the running app.

## The pane

A thread whose row says `scope: 'work'` has its view wrapped in `CanvasSeat`
(src/renderer/src/work/canvas/CanvasSeat.tsx), by `ThreadView`. The seat
reads the thread's open items (`useCanvas`, store.ts: `work.canvas.list`
once, then the `work.canvas` push) and seats them in `SplitShell`, the
frame a plan and a report already use:

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
  `state` and `setState`.
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

`ACT_VIEWS` (work/acts/registry.ts) holds one `ActKindView` per held act
kind, in `work/<pillar>/act.ts` for the pillar `ACT_PILLAR` names.
`chunk: null` means the Outbox's generic view (the summary and the payload
as text); a pillar gives a kind its own by pointing `chunk` at a module
that exports `View`. The Outbox that draws them is not built.

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
  browser runs). The calls: `openHistory()` opens a `history` item on the
  same source; `held(ref)` opens a held act where held acts are shown
  (`onOpenHeld` in work/canvas/held.ts, which the Outbox registers).
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
  `work.admitSession` and, once the LifeOS link is built, links in LifeOS.
- Ask's key is ⌘L (Ctrl+L off macOS), live while a kind feeds a selection.
  It is not listed in Settings yet.

The sent bubble shows the chip's line as text; a drawn chip in the bubble
is not built.

## The first paint

Nothing here is in the first paint (docs/agents/work.md "The first
paint"). `surfaces/chunks.ts` has one chunk, `workCanvasChunk`
(`work-canvas`), asked for by a Work thread's view and by a composer that
holds a chip; each kind's body is its own chunk behind that. The first
paint carries only the chip port (`lib/contextChips.ts`, a type from
`@shared/work` and no value), a few lines in the composer and the seat's
mount in `ThreadView`: 1.8 kB of the entry chunk in all.

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
- No method relays to another host (`CANVAS_RELAY` is empty). The path fence reads the file a `source` names, so a remote key cannot open `/etc/passwd` as `{ at: 'file' }`.

### The push

Every change sends `{ push: 'work.canvas', sessionId, items, opened? }` through `ctx.push` to every client socket: `items` is the thread's whole open list in tab order, and `opened` names the item an open just made or opened again, for the pane to select.

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
