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
   | any, `read` included | ⌘P once that editor answers Print…, ⌘F once it answers find |
   | `data-editor-keys="document"` | also ⌥⌘0 to ⌥⌘3 (Normal text, Heading 1 to 3) |

   "That editor" is the one holding the caret: its Body's root lists what it
   answers in `data-editor-answers` (`useWorkCommands` writes it,
   `editorAnswers` reads it). A sheet that answers Print… beside a document
   that does not leaves ⌘P as Go to File… while the caret is in the document.

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
  250 ms throttle; a focusout reads where the caret goes, so a move inside one
  editor sends nothing, and each event is compared with what was last sent,
  so an editor closed under the caret never leaves a stale answer). `resolveMenu` (`src/shared/menuTree.ts`) drops those rows'
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
it. Edit → Find… sends `find` the same way while the editor holding the caret
answers it (`editorAnswers`), and goes to the code editor's find otherwise.

A kind's `Body` answers with one hook, in its own chunk:

```tsx
// src/renderer/src/work/formats/command.ts
const root = useRef<HTMLDivElement | null>(null);
useWorkCommands(root, { export: () => setExporting(true), print: openPreviewOnPrint });
return <div ref={root} data-editor-keys="document">…</div>;
```

- While a Body that answers a command is mounted, the command is **offered**
  (`workCommands.has(id)`): its menu row is live, and ⇧⌘E is Export… wherever
  the caret is. With none mounted the row is greyed (the native menu through
  `MenuState.disabled`, the in-app bar of `/ui` by asking `workCommands`) and
  the key stays the app's. So a kind answers only what it has built: nothing
  half-built is reachable from the menu. ⌘P and ⌘F are narrower: they are an
  editor's only while the caret is in an editor that answers them itself.
- With several editors on screen the command goes to the one holding the
  caret, else the one that held it last, else the one mounted last; an editor
  that does not answer the command is passed over.
- First paint carries only the count of offers and the two ids
  (`scripts/entryGraph.test.ts`); nothing of Work is imported by the menu, the
  resolver or App.tsx.

Today the document and the sheet answer `export` by opening Preview on the
format he last used and `print` by opening it on Print ("Print" below); the
document answers `find` by opening the editor's own find bar (work-docs.md
"Find…"). A document of a Work workspace also answers `save_word`, File →
Save as Word to… (a Work-only row under Print…): the Files place's folder
picker, and a new .docx made in the folder he picks (work-files.md "Save as
Word to a folder"). The sheet's `find` and the deck's answers come with their
milestones.

## Preview: the contract

One surface shows "this is the file you will get" for all three kinds: a state
of the item, with the format's picture and what the format drops (its look is
docs/DESIGN.md "Work editors: Preview"). The frame is
`src/renderer/src/work/formats/PreviewFrame.tsx`; a kind hands it a `PreviewSource`
(`src/renderer/src/work/formats/preview.ts`):

```ts
interface PreviewSource {
  formats: PreviewFormat[]            // { id, label, ext?, paged, verb }
  setup?: PageSetupModel              // one arm per kind over CommonSetup
  office?(format?): Promise<{ app, state } | null> // null when this format has no Office draw
  draw(format, { by?, pages?, sheet?, signal }): Promise<{ picture, drops, notes? }>
  export(format): Promise<{ name }>
}
```

- A **picture** is `paged` (a PDF as `PreviewBytes`, its page count and who
  drew it: `tempcode`, `libreoffice`, `word`, `excel`, `powerpoint`), `text`,
  `html`, `table`, `files` or `video`. `pages` counts the PDF in hand; when
  that is only part of the whole, `shown` says which pages of the whole its
  first and last are and about how many the whole has.
- **`PreviewBytes`** is one finished render read by range: `rev` names it and
  every read is of that render. A kind keeps its renders by content hash on
  the host that holds the file and reads them from that host.
- **`drops`** are what the format cannot hold, one plain line each, counted
  from the item ("3 comments stay behind"), never a fixed list and never "not
  supported". Empty when nothing is lost.
- **`notes`** (optional) are what is true of the picture and is not a loss
  ("Prints on more than 50 pages", "Drawn on another computer: only the first
  20 pages could be sent"). The frame says them under the line over the
  first sheet, never under "In this format". A `shown` with no `of` is a
  whole nobody has counted: the bar reads "Page 3 of 50+" and the way to the
  rest is "Draw all", with no number.
- **`CommonSetup`** is paper (`PAPERS`, sizes in points in `PAPER_POINTS`),
  orientation, margins in points (`MARGIN_PRESETS` are Word's Normal, Narrow,
  Moderate and Wide) and the header and footer each on or off. The document,
  the sheet and the deck each add their own fields in their arm.
- **`office(format)`** says whether a press can get the real app's picture for the selected format:
  `ready` and `asleep` offer "Check in Word" (the press on an asleep machine
  is what wakes it), `not open` is an app he has shut, which nothing starts
  unseen, and `none` is no Office in reach of a press from this window.
- **`draw` with `by: 'office'`** is his press on "Check in Word" (or Excel, or
  PowerPoint). It answers that app's own picture or rejects with
  `NotInReach(app, why)`: never a picture when `office()` said `not open` or
  `none`, never a refusal when it said `ready` or `asleep`.
- A draw whose signal is already aborted answers no picture.

### Mounting the frame

The frame's file is `PreviewFrame.tsx`, not `Preview.tsx` as the plan named
it: `preview.ts` is the contract beside it, and two files whose names differ
only by case resolve to one on the Mac's disk, where the release is built.

```tsx
<Preview source={source} title={item.title} kind="sheet" onClose={close} pageRows={<MyRows />} />
```

- **`source` must be one object for as long as the file is the same.** The
  frame draws when the source, the format or a Retry changes: a source made
  anew on every render draws for ever. Memoise it on what names the file and
  read what moves (the editor, the counts) through refs, as
  `work/docs/DocumentCanvas.tsx` does.
- `kind` is one word per kind (`document`, `sheet`, `deck`): the format he
  last exported is remembered under it and is the one opened next. `initial`
  opens a named format instead (Print… opens on `print`).
- Mount it over your editor, not in place of it: keep the editor mounted,
  `inert` and unseen, so its caret, its scroll and its connection are kept
  (the document draws the frame through a portal into a slot of its Body).
- A format's `unit: 'slide'` makes the count read "Slide 1 of 12" and the
  loading shape 16:9.
- `export` may answer `where` when it saved the file somewhere itself; the
  frame then toasts "Saved <name> to <where>". Without it the system's own
  dialog was the answer. **`export` writes the file as it stands when he
  presses**: the primary button is live while a picture is still being drawn,
  and he may have edited since the last one, so never save bytes kept from an
  earlier draw unless the host confirms they are still the file. The one
  exception is the document's PDF and Print: they send the pages Preview
  shows, the pages he checked, and nothing when those are gone
  (work-docs.md "Preview").
- The Page section draws `setup.common` itself (Paper, Orientation, Margins,
  Headers and footers) and then `pageRows`, your own rows, built from
  `PageMenuRow` and `PageSwitchRow` (exported by `PreviewFrame.tsx`). After
  `setup.set(…)` resolves the frame draws the file again.
- A kind whose rows differ by format (the deck's) passes `rowsFor(format)`
  instead: `{ page, own }`, where `page` stands in for the Page section's rows
  (null: no Page section, as for a deck's .pptx, whose paper is its slides)
  and `own` are rows of the format's own after it, with no heading (the bar
  names the format), for a format with pages or without (a deck's Pictures
  and Video). A row there that changes the file
  hands the frame a new source, which draws again.
- Pages are drawn by `PagedView` (`work/formats/PagedView.tsx`) over the PDF
  kind's engine, by range reads of `PreviewBytes`. A `rev` the host no longer
  has must reject the read: the frame then shows its failure with Retry.
- The other pictures: `text` (a mono box), `html` (a sealed frame: no script,
  nothing fetched), `table` (rows of plain values, with `sheets` to pick
  from: the frame asks `draw(format, { sheet })`), `files` (a grid of
  `{ name, thumb }`), `video` (a poster; its bytes are read on Play).

### The check

`previewProblems(source, opts?)` (`previewContract.ts`) checks all of that and
answers each broken rule in words. Each build runs it on its own source in its
own tests: `expect(await previewProblems(source)).toEqual([])`. It exports only
when asked (`exports: true`), since an export writes a file.

### Print

Print is a format of Preview, not a dialog of its own: File → Print… and ⌘P
open Preview on the kind's `print` format, which shows the pages that will go
to paper, and the frame's one button reads Print…. A kind lists it as
`{ id: 'print', label: 'Print', paged: true, verb: 'Print…' }`, draws it as
its PDF, and in `export('print')` hands that PDF's bytes to one call:

```ts
// src/renderer/src/work/formats/printOut.ts
import { printPdf } from "../formats/printOut";
await printPdf(name, bytes); // says where it went; rejects with the reason
```

- **In the desktop app** the bytes go to main (`print:pdf`,
  `src/main/printOut.ts`), which answers only a window's own page, checks
  the bytes are a PDF, writes them to `<temp>/TempCode-print/<uuid>/<name>.pdf`
  (a file only he can read, named by `safeFileName` and short enough for any
  file system) and opens that file in this computer's own PDF viewer. The
  toast says "Opened in your PDF viewer to print"; he prints from there with
  the viewer's own Print. Copies older than a day go at the next print and at
  launch, and no more than twenty are kept. A folder that is not a real one
  of his own where the copies should be (a link, a file) is never written
  through or swept.
- **On Linux** main runs `xdg-open` itself (`xdgOpen`) and hears it for 3
  s: a failed exit, or no `xdg-open`, says "No app on this computer opens a
  PDF"; a good exit, or one still running (its generic mode waits for the
  viewer to close), is the viewer holding the file. Electron's
  `shell.openPath` never settled there: on the box (Electron 39, xvfb) an
  `xdg-open` that exited 0 at once was run, and the window's call waited
  until Electron dropped it, so he saw "Error invoking remote method
  'print:pdf': reply was never sent" (SLD7's live proof, fault 2).
- **In a browser** (`/ui`) the toast says "The PDF is ready to print" with
  one press, Open, which opens the PDF in a tab of its own, where the
  browser's viewer prints it. It waits for his press because a browser opens
  a tab only on one, and the press that asked for the print is long past by
  the time the pages are drawn and read; a tab opened without it is blocked
  and nothing says so. (A hidden frame that prints by itself was tried and
  dropped: the page's policy blocks a `blob:` frame, and a PDF in a frame is
  not printed dependably by every browser.)
- **Why the viewer and not Electron's print.** The plan tried four paths in
  order on his Mac (macOS 27.2, Electron 39.8.10, no printer set up).
  `webContents.print` failed before any dialog with "No printers available on
  the network" from a hidden window, from a shown one and from a window of
  page pictures; only the system's viewer printed, and saved as PDF, with or
  without a printer. If a later Electron prints with none set up, the change
  is in `src/main/printOut.ts` alone: `PrintAnswer.via` already names how it
  went, and `PRINT_WORDS` holds what is said for each.
- A print is not held: nothing leaves the computer. It is not remembered as
  the format to open next either, so Export… still opens on the last file he
  made.
- The frame is marked `data-editor-keys="read"`, so ⌘P pressed again inside
  Preview is the kind's Print… and not Go to File…. Each ask is a frame of its
  own (the kind keys it by a count of asks), so ⌘P opens on Print even when he
  moved to another format inside Preview.

## Fonts

A file's font is named as Office names it and drawn with a free twin of the
same metrics, the same file on every machine, so the editor, the PDF and
LibreOffice's pictures break lines on the same glyph widths:

| Named | Drawn with |
|---|---|
| Calibri | Carlito |
| Cambria | Caladea |
| Arial | Liberation Sans |
| Times New Roman | Liberation Serif |
| Courier New | Liberation Mono |

A font with no twin here (Aptos, a brand font) keeps its name and is drawn
with Carlito; where he picks fonts its row says "Drawn as Carlito"
(`drawnAs(name)`). A machine that has the real font uses it: the stack is the
name, then the twin, then the generic (`fontStack('Calibri')` is
`"Calibri", "Carlito", sans-serif`). An export writes the Office name.

The faces are work-kit's (`work-kit/fonts`, twenty woff2 files made from the
TrueType files LibreOffice 26.8.3 carries; its README has how they are made
and checked). **They ship whole.** The plan had a Latin subset for the hosted
page; a subset is a Modified Version under the Open Font License and may not
keep the name Carlito, so there are none, and anyone who subsets these files
must rename them (`work-kit/src/fonts/licences/NOTE.md`).

Every kind draws through one file, `src/renderer/src/work/formats/fonts.ts`:

```ts
import { ensureFonts, fontStack, drawnAs, printFonts } from "../formats/fonts";
await ensureFonts(["Calibri", "Aptos"]);          // before text in them is laid out
element.style.fontFamily = fontStack("Calibri");  // what draws it
const fonts = await printFonts(names, "Calibri"); // for a page a print window loads
```

- `ensureFonts(names)` registers each family once per page, under its twin's
  name, in a `<style data-work-fonts>` of its own, and waits until the faces
  are read (`document.fonts.load`). It never rejects. Call it before you
  measure or lay out; `font-display` is `block`, so text is never drawn in a
  fallback face and then moved.
- Each face is a file of its own in the build, fetched only when text is
  drawn with it. Nothing of this is in first paint
  (`scripts/entryGraph.test.ts`), and a file that names no font loads nothing.
- The hosted pages get the same files from their own origin (`font-src
  'self'`; `src/main/workBuild.test.ts` holds that the hosted build emits all
  twenty and that no page links one).
- A print window loads no file, so its page carries its faces as `data:`
  URLs: `printFonts(names, body)` answers what `htmlDocument`'s `fonts`
  takes (the `@font-face` rules and the body's family list). A document's PDF
  is drawn in Calibri's twin this way.
- LibreOffice on a host carries the same five families, so no tool manifest
  ships them; if a host's ever lacks one, a `scripts/work-tools/fonts.json`
  is where it goes.
- A document loads the fonts its text names as it opens and as it comes to
  name more (`work/docs/fonts.ts`, `useDocFonts`), in the app and on the
  guest page.

The check that the claim holds is a live test,
`src/main/server/work/formats/fontWrap.live.test.ts` (run with
`TEMP_CODE_WORK_TOOLS_DATA` set): forty paragraphs in the five families, set
in the shipped woff2 in Chromium and by the real LibreOffice from a Word file
that names the Office fonts, compared line count by line count. Measured on
the box (LibreOffice 26.8.3, Chromium 1248, Letter with inch margins, 11 pt):
40 of 40 paragraphs take the same number of lines, which the test holds; in
39 of 40 every word is on the same line. Only the regular faces at one size
are measured, and WebKit, the Mac and Word itself are not.

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
  not simply ready. A converter that cannot say, or does not say within 5
  seconds (`READY_TIMEOUT_MS`), is treated as not there; the report asks them
  all at once, so one that hangs costs the report its own wait and no more.
- **A job runs here** when the converter is ready, or when it is asleep and
  the job carries his press. Otherwise it goes to the first linked host that
  reports the pair ready. With no such host the job fails as `NotReadyError`
  (`asleep` or `not open`, naming the host) or `NoConverterError`.
- **His press.** `pressOf(by)` answers a `Press` only for the owner's own
  call: at a window of this host, or from a paired device of his that could
  approve as it pressed (`approve` or `admin`, the rule `userTextByOf` keeps
  for "the owner typed this"). Never a thread's (`kind: 'model'`), never
  another host's on his behalf (`by.peer`), and never a key that cannot
  approve: an agent's key through the MCP door holds `read` and `operate` at
  most, so it can run a job and can wake nothing. The runner remembers the
  objects it made, so a JSON `pressed: true`, a forwarded field or an option
  of that name is not a press. A converter reads it with `pressed(job)`.
  **Only a pressed job may wake the VM**, and a forwarded job carries none: a
  machine that sleeps is woken only from a window of the host it is on.
- **A shared library's file never leaves its host.** A job with
  `shared: true` runs here or fails; no linked host is even asked what it
  converts. `ctx.convert` marks a job shared itself when its input's own path
  is a file others can open (`sharedOf`, work/files/policy.ts), so a pillar
  that converts the file in place needs to say nothing. A pillar that
  converts its own scratch copy of a shared source (an export of the live
  text) must pass `shared: sharedOf(ctx, source)`: the runner cannot tell
  from a scratch path.
- **64 MiB each way.** The far host refuses an output past the cap in words,
  and this host refuses one that came back past it before keeping any of it.

A pillar maps `NotReadyError` to `NotInReach` for the Preview frame, and keeps
LibreOffice's picture when Office is not in reach. The five Office converters
themselves are the slides build's (SLD2), in the office pillar.
