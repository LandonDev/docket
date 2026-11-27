# Loading bones

The owner, 2026-11-27: "I want to replace all skeletons across tempcode to use
skullet the same way we made the tracker.cosmicadmin.com site work. It will
look really good in here and we need to make sure it has the full animation
and everything."

[Skullet](https://skullet.lochie.me) (`skullet`, a devDependency pinned to
0.0.3) lays a screen out unseen, measures it and draws one bone for each line
of text, glyph and block, so a skeleton is the shape of the screen it stands
for and cannot drift from it. One sweep crosses every bone in the window, and
when a read answers its content comes in over its bones.

- `src/renderer/src/components/bones.tsx` is what app code imports: `Region`,
  `Loaded`, `Bones`, `Arrive`, `Bone`, `useInBones`.
- `src/renderer/src/components/bonesEngine.tsx` is the one file that imports
  `skullet`. It rides a chunk of its own (81 kB), asked for as `bones.tsx`
  loads: the first paint's budget had 17 kB to spare.
- `src/renderer/src/components/bonesBridge.ts` is what happens to bones that
  are unmounted whole. `src/renderer/src/components/bones.css` is the theme
  and the layout. `BONES` in `src/renderer/src/lib/ease.ts` holds the times.
- `src/renderer/src/lib/bonesGuard.test.ts` (in the guards row) fails a file
  that imports `skullet`, imports `components/ui/skeleton`, or writes
  `bg-skeleton` on a box of its own, outside the folders its `HELD` list still
  names.

## The API

```tsx
import { Arrive, Bone, Bones, Loaded, Region, useInBones } from "@renderer/components/bones";

// One read, drawn by one function: bones from the sample, content from the answer.
<Loaded data={notes} sample={SAMPLE_NOTES} failed={error ? <PageError>{error}</PageError> : null} label="Loading notes">
  {(rows) => <NoteRows notes={rows} />}
</Loaded>

// A part with several reads, or whose content is not one function of one read.
<Region loading={!index} label="Loading changes" bones={() => <ChangeRows files={SAMPLE_FILES} actions={STILL} />}>
  {index ? <ChangeRows files={index.files} actions={actions} /> : null}
</Region>

// One value in a line of words (a branch's name, a count).
<Loaded inline data={count === null ? null : countWords(count)} sample="Its 12 threads are deleted." label="">
  {(words) => words}
</Loaded>

// Bones alone, where no content of yours follows them: a lazy surface's fallback.
<Bones label="Loading settings">{/* the screen, drawn from sample words */}</Bones>

// What has no words to measure: a picture, a chart, a frame on its way.
<Bone className="aspect-video w-full rounded-lg" />
```

`Region` takes `loading`, `bones` (a node, or a function called only while
loading), `children`, and:

| Prop | What it does |
| --- | --- |
| `label` | What a screen reader hears while the bones show ("Loading notes"). `""` where a box around the region already says it. |
| `hold` | How long the bones wait before they show: 150 ms. `0` for bones that follow a wait already made. |
| `fill` | Take the room its flex parent has (a list in its pane). Without it the region is as tall as what it holds. |
| `inline` | One value in a line of words: the region is a `span` in the line, on the words' baseline, and holds phrasing content. |
| `on` | `"stage"` or `"matte"`: the ground the bones lie on, where it is not the page (`skeleton-stage`, `skeleton-matte`). |
| `id` | Names the region, so its next bones are the shape it last showed and not the sample's. Say what the shape hangs on (`"notes:list"`). |
| `snap` | Land at the content's height with no ease, for content whose height the sample cannot know. |
| `className` | The region's own layout. A region is a column holding one box: put gaps and grids on that box, inside. |

`Loaded` is a `Region` whose bones are `children(sample)` and whose content is
`children(data)`; it waits while `data` is null or undefined, and `failed`
stands in the content's place. `Bones` is a `Region` that is always loading.

## The rules

1. **A loading state is the screen itself drawn from a sample.** Never draw a
   bone by hand: no `Skeleton`, no `bg-skeleton`, no `animate-pulse`, no grey
   box standing for a line of words. Write the words in the element and the
   type they land in, and Skullet draws the bar.
2. **One region for each read.** Each part of a screen with a read of its own
   is a region: a page's head, a list, a rail section, each card that asks
   its own host. Never gate a screen on its slowest read: no
   `if (a.loading || b.loading) return <Bones/>` round parts that could each
   stand alone. Reads that only make sense together wait together.
3. **What is known at once is drawn at once**: a page's title, its tabs and
   buttons, a section's heading. Keep them outside the region. Where a known
   word must sit inside a drawing (a lazy surface's fallback), mark it
   `skullet-own`: it is drawn as it is, with no bone.
4. **Draw the sample at rest, from the same piece as the content**, with
   nothing that shows only on hover: handlers that do nothing, no rights, a
   fixed clock.
5. **Nothing inside bones may subscribe, register keys, ask a host, publish
   or read by a sample id.** The drawing is unseen and inert, but its effects
   still run. A piece that does any of these asks `useInBones()` and skips it.
6. **The bones hold the room the content takes**, so nothing moves when it
   lands. A height that eases on landing is a fault in the sample: fix the
   sample, or give the region an `id` so it remembers its shape, or `snap`.
7. **An error and an empty state are content.** They go inside the region,
   with `loading` false. A failed read keeps the last good rows and says so
   in its red line with Retry (docs/DESIGN.md "Loading and empty states").
8. **A spinner is for a busy control or a wait with no shape** (`BusyLabel`,
   `LoadingLine`). Bones are for a load whose shape is known.
9. **Whoever owns a component owns its sample drawing.** Change a component's
   required props and the bones that draw it must still compile.

What the engine does for you, so no screen does it itself: the 150 ms hold
(a read that answers sooner shows no bones and costs the sample's layout and
nothing more: the drawing is measured only once it shows); bones that follow
bones (drawn ones: a tab parked behind the window keeps its bones in the
page, and they are no one's to follow) never hold again; content that lands
inside 400 ms of a key or a scroll, in a hidden window, or with motion
reduced lands at once; no leaving pane waits on a frame (it is dropped after
1.5 s whatever its fade says); bones that have stood 20 s go still.

## Samples

A sample is a fixed literal shaped like real work: no clock, no random, ids
that start `sample:`. Nobody reads the words. Their lengths, and which fields
are set, give the bones their shape, so a title is a title's length and a
row with no due date draws no date.

- A sample lives beside the piece it draws, in `samples.ts` of that folder
  (`work/mail/samples.ts`), or in the component's own file when one screen
  uses it. Export it `SAMPLE_<NOUN>`.
- A sample draws no part whose presence is unknown (a line for notes, an
  attachment, a badge most rows do not carry).
- A sample is as many rows as the screen shows, no more: three for a short
  list, eight for a page of them. Every bone is paint for as long as it
  shows ("Speed"), and rows past the region's room are clipped unseen.
- A clamped line must fit its clamp in the sample.
- A fixture may reuse the sample; the app's own data never does.

## How Skullet reads a drawing

- A line of text is one bar, from its cap height to its baseline. A wrapped
  paragraph is a bar a line.
- A glyph (`svg`), an image, a field (`input`, `select`, `textarea`) and a
  `Bone` are one block at their own box, with their own radius.
- A painted box (a background, a border all round, a shadow) with two or more
  labels keeps its own surface: a card, a group's band. With one label or
  none it becomes one block: a button, a chip, an avatar.
- A box with a border on one side only (a strip's hairline) is no surface: it
  is walked and its hairline stays. But an empty box is a leaf, hidden whole:
  mark a bare strip `skullet-own`.
- A clear border all round is paint to Skullet, and every `Item` row has one.
  The engine takes it away before Skullet measures (`markUnseen`: the top
  edge's width moves into the padding), so a row with one name is its glyph
  and its name, not one block. A row with a real fill or a drawn border and
  one label is still one block: give it its second label, or draw its parts.
- `skullet-ignore`: draw nothing for this element or anything in it.
  `skullet-block`: draw it as one block. `skullet-own`: leave it as it is.
- An empty element, and anything at `opacity: 0` or `invisible`, is left out
  for you (`markUnseen` in the engine).
- `?skullet-debug` on the window's address, or `localStorage["skullet:debug"]
  = "1"`, outlines every skeleton and says what it was drawn from.

## The recipe: a hand-drawn skeleton to a region

1. Find the read. The file has `loading ? <SomeSkeleton /> : <Content … />`,
   or an early `return <Skeleton … />`. The condition is the region's
   `loading`.
2. Find the piece that draws the content, and make it take its data as props
   if it reads a store itself. That piece draws both.
3. Write the sample (above) and wrap:
   `loading ? <X/> : <List rows={rows}/>` becomes
   `<Region loading={!rows} bones={() => <List rows={SAMPLE_ROWS} />}>{rows ? <List rows={rows} /> : null}</Region>`,
   or `Loaded` when one function draws both.
4. Move what is known at once (the heading, the toolbar) outside the region.
5. Carry the old wrapper's layout: `fill` where the skeleton had
   `min-h-0 flex-1`; `className` for the rest. Keep any `data-*` hook a test
   reads on the sample's own element.
6. One value in a sentence: `Loaded inline`, with the sample's words.
7. A picture, a chart, a frame: one `Bone` with the old box's classes, and
   `on="stage"` or `on="matte"` on its region where the old bone was
   `bg-skeleton-stage` or `bg-skeleton-matte`.
8. Delete the hand-drawn skeleton and the `Skeleton` import. When a folder
   draws no bone by hand any more, delete its line from `HELD`
   (`lib/bonesGuard.test.ts`); the test fails a line with nothing left to
   hold.

`SurfaceSkeleton` (the lazy surfaces' fallback, by kind) and
`PageRowsSkeleton` (a settings section's rows) are drawn in bones already and
stay legal to use. Where a screen can draw its real rows from a sample, that
is the better form, since those two only know a generic shape.

Converted examples to copy:

| For | Read |
| --- | --- |
| A list: the real rows from a sample, at rest | `chrome/rail/ChangesPanel.tsx` (`RowsBones`: `FileRow` with `SAMPLE_CHANGED_FILES`, `busy={READ_ONLY}`, the no-op `STILL` actions), `chrome/RemoteFolderDialog.tsx` (`FolderRows`), `chrome/ContextBreakdown.tsx` (`CategoryRows`) |
| A head whose words arrive (a `Region` round the head itself) | `chrome/rail/ChangesPanel.tsx` (`TopRowBones`) |
| A fold whose row count is unknown (`snap`) | `chrome/rail/ChangesPanel.tsx` (`HunkRows`) |
| One value in a line of words (`inline`) | `chrome/BranchPicker.tsx`, `chrome/RemoveProjectDialog.tsx`, `chrome/OrchestrationRules.tsx`, `chrome/rail/BuildPanel.tsx` |
| A control on its way: the real button, disabled, as the bones | `chrome/ThreadDefaultsDialog.tsx` (`UseNewThreadsPress`) |
| A piece that cannot be reused (its effects ask a host, its role takes keys): the row written out in its own box | `chrome/FileTree.tsx` (`SampleTreeRow`) |
| A lazy chunk's fallback (`Bones`, sample words, `skullet-own` for known words, `Bone` for blocks) | `surfaces/SurfaceSkeleton.tsx`, `chrome/Sidebar.tsx`, `chrome/WorkspaceSessions.tsx`, `chrome/ProjectRail.tsx` |
| A settings section's rows | `components/page.tsx` (`PageRowsSkeleton`), `chrome/ProjectDialogs.tsx` (`FieldBones`) |
| A fixture of the wait beside the loaded screen | `components/bones.fixtures.tsx` |

## Tests

jsdom measures nothing, so every reveal there is instant and content is in
the document in the commit its data is. The engine is in hand before a dom
test file's first test (`test/domSetup.ts`), so a region draws its bones in
the commit that mounts it.

- While loading, the sample's words sit in an `aria-hidden`, inert drawing
  (`[skullet-loading]`). Query by role, which skips it; a query by text finds
  the sample.
- A wait reads `[data-region][data-bones]`: `held` inside the hold, `shown`
  after it, `leaving` while the bones go out, absent once loaded.
- The hold is a timer: `vi.advanceTimersByTime(BONES.holdMs)` shows the
  bones. Fake `performance` too (`toFake: [..., "performance"]`): the hold and
  what counts as bones just left are read from it.
- When a read lands, its content is in the document in that commit and the
  leaving bones go a tick later: `await waitFor(...)` before asserting that
  `[skullet-loading]` is gone.
- A non-dom test that renders to a string has no engine: a region there is
  empty while it waits. Await `bonesReady()` first if the bones matter.

## Proving a conversion

1. `bun run typecheck`, the folder's tests, and
   `NODE_ENV=test bunx vitest run src/renderer/src/lib/bonesGuard.test.ts`.
2. `bun run ui:preview <file>#<Export> --shot --fresh`: a fixture that shows
   the wait beside one that shows the same screen loaded. A preview page
   measures its bones with Skullet's own script, so the shot shows real bars
   in dark and light. Each bone should stand where its words land; a bar
   across a whole card means a painted box with one label (give it its words,
   or `skullet-ignore`).
3. In a window: `bun scripts/journeys/bones-walk.ts` builds nothing and
   opens the built tree paired to a slow host (`TEMP_CODE_PEER_DELAY_MS`:
   every request the window makes of it waits 400 ms, one after another;
   `--delay`), so every read takes long enough to see. It films each wait frame by
   frame from the press that starts it until its content has landed, in dark
   and in light, and checks on the way that bones showed, that every bone
   was in the sweep, and that none was left once the read had answered; then
   the same bundle at `/ui` at a phone's size, and in a tab hidden while its
   read lands. Frames and `walk.log` go to `.temp-code/findings/skullet/walk`
   (`--out`). Add your screen as a scene there, or film it the same way.

## Speed

- The engine is a lazy chunk: the entry's static closure does not hold it
  (`bun run check:bundle`; `lib/bonesGuard.test.ts` keeps every static
  import of the engine out). The front that app code imports is 3 kB, kept
  out of the React Compiler's hands (`"use no memo"`: its props are new each
  render, so a memo of it never hits).
- Skullet's own stylesheet is in the page for good (`@import
  "skullet/styles.css"` in index.css). Left to itself Skullet adds it with
  the first bones and removes it with the last, a restyle of the whole window
  each way.
- A read that answers inside the hold costs the sample's layout once and no
  measuring: the drawing holds the room, and Skullet reads it only when the
  bones show.
- The sweep is a Web Animation of `background-position` on each bone: paint,
  on the main thread, for as long as bones show. It is the one loop in the
  app the compositor does not run (docs/DESIGN.md "Motion tokens"). So:
  bones that have stood 20 s go still (`BONES.sweepCapMs`), a sample is no
  longer than its screen, and `--skullet-animation: pulse` in
  `components/bones.css` swaps the sweep for an opacity loop if a machine
  cannot hold it.
- A hidden or minimised window draws no frames. There, content lands at once
  (`still`), the hold is a timer, and a leaving pane is dropped by a timer.
- While bones leave, one sweep a frame ends each bar that lies over text
  already in (`sweepBones`). It walks only what stands where the bars stand,
  and only for the half second a reveal lasts.

### Measured

On the box, 2026-11-27, the built tree under xvfb (software raster, so paint
is at its dearest; a Mac's GPU does this for less).

| What | Before | After |
| --- | --- | --- |
| The entry's static closure (`bun run check:bundle`, budget 5,136.0 kB) | 5,118.9 kB | 5,125.4 kB |
| The engine's chunk, loaded beside it | none | 81 kB (`skullet` 57, the engine 22, the bridge 5) |
| Launch, `tc:ready` after navigation, the median of five (`bun scripts/launch-timing-linux.ts`) | 884 ms | 817 ms: no difference beyond the runs' own spread (712 to 1,049 before, 743 to 942 after) |

The chat scene of the renderer soak (`bun scripts/measure-renderer-soak.ts
--gate --scene chat --cpu-report-only --trace 5`: one thread streaming), with
a panel of 280 bones drawn over the window's right side by `--eval`:

| Run | Renderer CPU, % of one core | Main-thread frames a second | With a paint | Long tasks |
| --- | --- | --- | --- | --- |
| No bones | 20 to 23 | 60 | 18 | 0 |
| 280 bones, the sweep | 56 to 81 | 60 | 60 | 0 |
| 280 bones, `pulse` | 32 | 60 | 19 | 0 |

The window holds 60 frames a second with no long task beside a stream, even
with more bones than any screen draws, so the sweep stays. It costs about
0.15% of a core a bone here: a screen of 40 bones is 6% for the second it
waits. `pulse` is a third of that and paints no more than an idle stream.

To take them again: build, `touch` a file and name it in
`TEMP_CODE_SOAK_BUILD_DONE` (a dirty tree is rebuilt otherwise), then run the
soak from inside the tree with `--label <name>` and, for bones,
`--eval "$(bun scripts/soak-bones-eval.ts shimmer 70)"` (`pulse` for the
other loop; 70 rows are 280 bones). Reports land in `/tmp/tc-soak/<name>.md`.
The experiment's line in the log reads 0 bars: Skullet draws them a frame
later, and the trace's paints show them.

## What is ours and what is Skullet's

The bones, their sweep, the memory of a shown shape and the reveal are
Skullet's (`Ghost`, `fadeIn`, `fadeOut`, `Memory` from `skullet/internal`).
Ours, and narrow: the two panes of a region (Skullet's `<Skeleton>` re-reads
a live list 250 ms after every change to it); a bone with no row landing on
it leaves by its own place in the window (`byPlace`); the content's own fills
settle under its pieces; the 150 ms hold of a region's first bones, and
measuring them only then; the bridge for bones unmounted whole; ending a
leaving bone once the text over it is half in (`sweepBones`); and every wait
capped by a timer.

Not ported from the tracker: its kept shapes (a list's last shape kept in
`localStorage` and a cookie for the server's first paint). Docket has no
server paint, and its rail paints from the launch mirror. A region with an
`id` keeps its last shape through Skullet's own memory (`localStorage`,
`skullet:shapes`: layout only, the text replaced with filler).

Moving the pin: `components/bones.css` lays the drawing out through Skullet's
attributes, the engine builds Skullet's three boxes itself and reads
`skullet/internal`, the bridge lifts bars out of a shadow root, and
`scripts/ui-preview.ts` runs Skullet's inline script. Check those four, then
move the pin in package.json and in `lib/bonesGuard.test.ts`.

## The held list

`HELD` in `src/renderer/src/lib/bonesGuard.test.ts`: the folders not yet
converted, one line a folder. On 2026-11-27 it names `hosted/guest`, `aliax`,
`surfaces` and 36 folders under `work/`. A thread that converts a folder
deletes its line. When the list is empty, delete
`components/ui/skeleton.tsx` and the cases that speak of it.

`surfaces` is one line for the whole folder, and `SurfaceSkeleton.tsx` in it
is converted already (`CONVERTED_IN_HELD`). `hosted/guest` is the guest
page's own bundle (`src/hosted/guest/GuestApp.tsx`): it imports the same
`components/bones.tsx`, but its build and its stylesheet are its own, so
whoever converts it checks that page in a browser.
