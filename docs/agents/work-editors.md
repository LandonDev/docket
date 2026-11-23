# Work editors: what the document, the sheet and the deck share

Three canvas kinds are editors he builds finished work in: the document
([work-docs.md](work-docs.md)), the sheet ([work-sheets.md](work-sheets.md)) and
the deck ([work-slides.md](work-slides.md)). Each is its own pillar. This file is
the account of what they share: who hears a key, the Print… and Export… rows,
the Preview contract, and the conversion runner's rules for a renderer that is
an app or a machine. The plan that set them is
`.temp-code/plans/editors/shared.md`.

## Who hears a key

In this order:

1. **The editor.** A kind marks its `Body`'s root `data-editor-keys`. While
   the caret is inside it, these keys are the editor's and never reach the
   app's map:

   | Mark | The editor owns |
   |---|---|
   | `data-editor-keys` (any value but `read`) | ⌘B and ⌘K (bold, link) |
   | any, `read` included | ⌘P once an editor on screen answers Print…, ⌘F once one answers find |
   | `data-editor-keys="document"` | also ⌥⌘0 to ⌥⌘3 (Normal text, Heading 1 to 3) |

   A body he can only read is marked `read`: ⌘B stays Sidebar and ⌘K Search
   there, since there is nothing to make bold.
2. **The menu**, as before, everywhere else. Go to File… keeps ⌘P and Find… ⌘F
   outside an editor, and inside one until an editor answers them.

Every other chord (⌘S, ⌘W, ⌘O, zoom, ⇧⌘F, the tab and pane chords) is the
app's inside an editor as outside it; a dialog over an editor still wins.

How it is built:

- **The page.** `createKeyResolver` (`src/renderer/src/lib/appCommands.ts`,
  guard 6) reads the mark with `editorKeys(target)`. For ⌘B and ⌘K it answers
  null, so App.tsx's capture listener neither prevents nor stops the key and
  the editor's own binding hears it. For ⌘P and ⌘F it answers the commands
  `print` and `find`. App.tsx also skips the code editor's find keys while the
  caret is in a Work editor.
- **The menu.** A menu key can fire whether or not the page handled the key,
  so the window names the rows whose keys the editor holds in
  `MenuState.editing` (`editorHeld`, sent over `menu:state` by
  `lib/nativeMenuState.ts` at once on `focusin` and `focusout`, not after the
  250 ms throttle). `resolveMenu` (`src/shared/menuTree.ts`) drops those rows'
  accelerators, so nothing is registered for them on any platform, and gives
  Print… the ⌘P it takes from Go to File… as a `pageKey` (shown, left to the
  page; on macOS main drops the menu's own click when it came by ⌘ or Ctrl).
  Main takes only the four ids of `EDITOR_KEY_IDS` at a window's word.
- Before this (found at DOC0): ⌘B in a document toggled the sidebar and made
  nothing bold, because the resolver had no rule for a document and stopped
  the key before BlockNote heard it. `work/docs/editorKeys.dom.test.tsx` holds
  the fix with the real editor.

## Print… and Export…

File → Export… (⇧⌘E) and File → Print… (⌘P while the caret is in an editor)
are two rows of the menu tree and two commands, `export` and `print`. Neither
does anything itself: `workCommands.run(id)` (`lib/appCommands.ts`) sends one
window event, `work:command` with `{ id }`, and the editor on screen answers
it. Edit → Find… sends `find` the same way while the caret is in an editor
that answers it, and goes to the code editor's find otherwise.

A kind's `Body` answers with one hook, in its own chunk:

```tsx
// src/renderer/src/work/formats/command.ts
const root = useRef<HTMLDivElement | null>(null);
useWorkCommands(root, { export: () => setExporting(true), print: openPreviewOnPrint });
return <div ref={root} data-editor-keys="document">…</div>;
```

- While a Body that answers a command is mounted, the command is **offered**
  (`workCommands.has(id)`): its menu row is live and its key is the editor's.
  With none mounted the row is greyed (the native menu through
  `MenuState.disabled`, the in-app bar of `/ui` by asking `workCommands`) and
  the key stays the app's. So a kind answers only what it has built: nothing
  half-built is reachable from the menu.
- With several editors on screen the command goes to the one holding the
  caret, else the one that held it last, else the one mounted last; an editor
  that does not answer the command is passed over.
- First paint carries only the count of offers and the two ids
  (`scripts/entryGraph.test.ts`); nothing of Work is imported by the menu, the
  resolver or App.tsx.

Today the document answers `export` (its Export dialog). `print`, `find` and
the sheet's and the deck's answers come with their milestones.

## Preview: the contract

One surface shows "this is the file you will get" for all three kinds: a state
of the item, with the format's picture and what the format drops. The frame is
`src/renderer/src/work/formats/Preview.tsx` (built at DOC1.2); a kind hands it a
`PreviewSource` (`src/renderer/src/work/formats/preview.ts`):

```ts
interface PreviewSource {
  formats: PreviewFormat[]            // { id, label, ext?, paged, verb }
  setup?: PageSetupModel              // one arm per kind over CommonSetup
  office?(): Promise<{ app, state }>  // drives "Check in Word"; absent: never offered
  draw(format, { by?, pages?, sheet?, signal }): Promise<{ picture, drops }>
  export(format): Promise<{ name }>
}
```

- A **picture** is `paged` (a PDF as `PreviewBytes`, its page count and who
  drew it: `tempcode`, `libreoffice`, `word`, `excel`, `powerpoint`), `text`,
  `html`, `table`, `files` or `video`.
- **`PreviewBytes`** is one finished render read by range: `rev` names it and
  every read is of that render. A kind keeps its renders by content hash on
  the host that holds the file and reads them from that host.
- **`drops`** are what the format cannot hold, one plain line each, counted
  from the item ("3 comments stay behind"), never a fixed list and never "not
  supported". Empty when nothing is lost.
- **`CommonSetup`** is paper (`PAPERS`, sizes in points in `PAPER_POINTS`),
  orientation, margins in points (`MARGIN_PRESETS` are Word's Normal, Narrow,
  Moderate and Wide) and the header and footer each on or off. The document,
  the sheet and the deck each add their own fields in their arm.
- **`draw` with `by: 'office'`** is his press on "Check in Word" (or Excel, or
  PowerPoint). It answers that app's own picture or rejects with
  `NotInReach(app, why)`.
- A draw whose signal is already aborted answers no picture.

`previewProblems(source, opts?)` (`previewContract.ts`) checks all of that and
answers each broken rule in words. Each build runs it on its own source in its
own tests: `expect(await previewProblems(source)).toEqual([])`. It exports only
when asked (`exports: true`), since an export writes a file.

## The conversion runner: a renderer that is an app or a machine

`ctx.convert` (`src/main/server/work/formats/jobs.ts`,
[work-formats.md](work-formats.md) "Jobs") was built for tools on disk. Real
Word, Excel and PowerPoint draw through it as well, and for them:

- **A format's name may say who draws it** after a plus: `docx → pdf+word`,
  `xlsx → pdf+excel`, `pptx → pdf+powerpoint`, `pptx → png+powerpoint`,
  `pptx → mp4+powerpoint` (as `xlsx → xlsx+ops` already was). `FORMAT_NAME`
  (`src/shared/contract-work-formats.ts`) is the wire's rule; the file's
  extension is the part before the plus (`extOf`).
- **`ready(job)`** on a `Converter`: `ready`, `asleep` (the Windows VM is
  hibernated), `not open` (an app he has shut on his Mac: never started
  unseen) or `none`. It is asked when a job comes, and with null for
  `work.formats.tools`, whose `converts` rows carry a `state` when a pair is
  not simply ready. A converter that cannot say is treated as not there.
- **A job runs here** when the converter is ready, or when it is asleep and
  the job carries his press. Otherwise it goes to the first linked host that
  reports the pair ready. With no such host the job fails as `NotReadyError`
  (`asleep` or `not open`, naming the host) or `NoConverterError`.
- **His press.** `pressOf(by)` answers a `Press` only for a person's call at a
  window of this host: never a thread's (`kind: 'model'`), never another
  host's (`by.peer`), never a read-only key's. The runner remembers the
  objects it made, so a JSON `pressed: true`, a forwarded field or an option
  of that name is not a press. A converter reads it with `pressed(job)`.
  **Only a pressed job may wake the VM**, and a forwarded job carries none: a
  machine that sleeps is woken only from a window of the host it is on.
- **A shared library's file never leaves its host.** A job with
  `shared: true` (the caller asks `sharedOf(source)`) runs here or fails; no
  linked host is even asked what it converts.
- **64 MiB each way.** The far host refuses an output past the cap in words,
  and this host refuses one that came back past it before keeping any of it.

A pillar maps `NotReadyError` to `NotInReach` for the Preview frame, and keeps
LibreOffice's picture when Office is not in reach. The five Office converters
themselves are the slides build's (SLD2), in the office pillar.
