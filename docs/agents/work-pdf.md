# Work: PDFs

Milestone 33 of the Work plan. A PDF opens as a canvas item: the owner
reads it, an agent reads it and suggests values for its form, the owner
accepts them, highlights passages, signs with his drawn signature, and
sends a copy. [work.md](work.md) says how the pillar is mounted. This file
has the server, then the canvas.

## The rule: the file is never written

The PDF an item points at stays as it is. Everything of ours is rows in
this host's database: what an agent proposed, what the owner accepted or
typed, his highlights, where his signature goes. `work.pdf.export` writes
all of it into a copy. Two reasons: pdf-lib cannot save in place, so a
write would rewrite the whole file and break any signature in it; and the
plan says an opened PDF is the truth where it was opened from.

Agents suggest and the owner accepts. A value an agent fills is a
suggestion with its source until he takes it. Signing places his saved
drawn signature: no certificate, and no thread can call it.

## Files

All in `src/main/server/work/pdf/`.

| File | What it does |
|---|---|
| `index.ts` | The module: `ensure`, the twelve methods, the tools, the converters, the preamble, `sessionsRemoved` |
| `file.ts` | An item's file on this host: `itemOf`, `paneItem`, `sourcePath`, `itemDir`, `stampOf`, `hasMagic`, `readRange`, `copyWhole`, `ItemFileError`. Shared with slides |
| `view.ts` | The kept copy reads are served from (`snapshot`), the form per file version (`formOf`), the `PdfView`, the push, the export |
| `store.ts` | The four tables, the three move modules, `PdfStore` |
| `form.ts` | pdf-lib, in process: read the form, label it, fill, flatten, overlays, the signature, highlights |
| `extract.ts`, `extractScript.ts` | The extract job: `PDF_CONVERTERS`, `PdfExtract`, `parsePages`, `extractMarkdown`, and the Python it runs |
| `tools.ts` | `pdf_extract`, `pdf_page_image`, `pdf_fields`, `pdf_fill`, `pdf_export` |

The wire is `src/shared/contract-work-pdf.ts`: `Bbox`, `PdfField`,
`PdfProvenance`, `PdfMark`, `PdfSignature`, `PdfView`, the methods, the
`work.pdf` push, and the citation link (`pdfCiteHref`, `parsePdfCite`).

## Reading the file

- An item's source names a path (`{ at: 'file' }`, or a Microsoft file
  with a path ref). A thread-made item (`{ at: 'thread' }`) keeps its file
  as `file.pdf` in its own folder. A file the item places on another
  host, and that is not here, is refused, as is a Google or a Microsoft
  web file (their milestones are 28 and 30).
- Reads come from copies the host keeps per version of the file, at
  `canvas/<thread>/<item>/kept-<rev>.pdf`: the version shown and the one
  before it. Only `work.pdf.open` (and a thread's `pdf_extract` or
  `pdf_page_image`) looks at the file and takes a new copy when its size or
  time moved, off the event loop. Everything else serves the newest copy
  kept, so the pages still show when the file moves (`PdfView.missing`).
  "Newest" is when the copy was taken, never the file's own time: an open
  that finds its version already kept marks that copy newest, so a file
  put back to an earlier version (`cp -p`, a restore) is served as that
  version everywhere.
- `work.pdf.read` gives at most 4 MB a call (`PDF_READ_MAX`), as base64
  with the file's size and `rev`. It never copies. Given `rev` (the view's),
  it reads that version or refuses: "This file changed since it was
  opened: open it again." So one load reads one version from its first
  range to its last. pdf.js reads by range, so the first page of a long
  file shows before the rest arrives.
- A file that does not start with `%PDF-` in its first kilobyte is never
  served, a thread-made `file.pdf` included: "notes.pdf is not a PDF."
- A remote key reaches an item only when it could name the item's file
  itself: every method that takes an `itemId` (open, read, review,
  setField, mark, unmark, mode, undo, sign, export) refuses it otherwise,
  before anything is read or written, with the listener's own error
  ("forbidden: work.pdf.read is outside app-managed roots"). The
  `work.pdf` push of such an item goes only to sockets that hold every
  capability (this host's window, an admin key): the push can filter by
  capability alone, so an admin key on another device still hears it. A
  push filter by principal (`to: { admit(principal) }`) is what the frame
  would need to fence that too. A module cannot see the host's list of roots, so `fenceItem`
  (file.ts) reads the ones it can (every project's checkout and every
  workspace's folder) and admits less than the listener, never more. A
  thread-made item's file is in its own folder and passes. The frame would
  need to hand a module the caller's fence (a `Caller.fence(path)`, or
  `ctx.remoteRoots()`) for this to match the listener exactly.
- An encrypted file still opens, with `formError` saying why its form
  cannot be read.

## The store

Four tables, made in `ensure` (no `BEGIN` or `COMMIT` there: the host
owns the savepoint).

| Table | Rows |
|---|---|
| `work_pdf_items` | one per item: its mode, when he signed and over what (`signed_rev`, `signed_hash`), the last direct write (for Undo), the labels read off the page by file version |
| `work_pdf_fields` | one per field that has something of ours: a value, a suggestion, or a box placed on a page (`origin: 'overlay'`) |
| `work_pdf_marks` | his highlights: page, one box per line, the words, a note |
| `work_pdf_signature` | one row for the host: his drawn signature as strokes |

The first three carry `session_id`. `ensure` registers a move module for
each (`pdf-items`, `pdf-fields`, `pdf-marks`), so a thread that moves to
another host takes them with it, and history import carries them by name.
The signature is the host's, not a thread's, and never moves.

What a field shows (`PdfStore.fields`) is the file's own field with our
row laid over it, then our boxes. Its `state`:

- `empty`: nothing in it;
- `proposed`: an agent's value waits, in `proposed`, with its source first
  in `provenance`;
- `accepted`: he took the value or typed it (`kind: 'manual'`);
- `needs-owner`: a signature or its date, which only his press fills.

A field with no label of its own (the IRS's forms have none) takes one
read off the page beside it, else the last part of its name (`f1_01`).

## Suggest or write

An item's mode is `suggests` (the default) or `writes`. In `suggests`
each value an agent fills waits for the owner. In `writes` the values land
accepted as one write, shown in the bar's line with Undo
(`work.pdf.undo`), which puts each field back as it was before that write.
A field changed since the write (his own correction, a review, a later
suggestion) is his: Undo leaves it as it is and takes back the rest.
A value the field cannot take is refused by name and the rest still land:
a key the form lacks, a read-only field, text in a checkbox, a choice that
is not one of its options, a value longer than a comb field takes.

## Signing

`work.pdf.setSignature` saves his drawn strokes; `work.pdf.sign` puts the
signature on the item's signature boxes, today's date ("November 19,
2026") on its date boxes, and treats the file's own `/Sig` fields as
places for the drawing too. Both need the `approve` capability. What
keeps a thread out is that no tool calls them; the methods also refuse a
caller of kind `model`, which only a bridge (`app.*`) call can be, so that
check is a backstop, not the fence. No tool signs. An
agent places a `signature` box and a `date` box with `pdf_fill` and no
value; his press fills them.

A signature is bound to what he signed. `sign` keeps the file's `rev` and
a hash of what the copy carries: each form field's value of ours (as
`ownValues` reads it), each placed box's value and where it sits
(`PdfStore.valuesHash`). A suggestion waiting over a value is not in it,
so a thread's suggestion never takes his signature off; accepting it does. When either changes (a new version of the
file opened, a direct write, a review, his own edit, a box placed after),
the signature comes off as if he had unsigned: the view says
`signed: false`, the boxes wait for him again, and the export carries no
ink (`PdfStore.signedOver`, read by the view and the export).

Placed boxes hold to the same rule. `place` takes only `box:` keys, never
a key the form owns. Placing a key again moves its box but never changes
its type, so a value never rides into a box of another kind. A signature
or date box he has filled cannot be moved at all: the call is refused,
rather than cleared back, so his ink is never put where he did not sign
and never taken off by a thread.

## The methods

| Method | Capability | Answers |
|---|---|---|
| `work.pdf.open` | read | `PdfView` |
| `work.pdf.read` | read | bytes by range, of the file (the version `rev` names) or (`which: 'export'`) of the last copy |
| `work.pdf.review` | operate | `PdfView`: accept or reject suggestions, by key or all |
| `work.pdf.setField` | operate | `PdfView`: his own value; null gives the file's back |
| `work.pdf.mark`, `work.pdf.unmark` | operate | `PdfView` |
| `work.pdf.mode` | operate | `PdfView` |
| `work.pdf.undo` | operate | `PdfView` |
| `work.pdf.signature` | approve | his saved strokes, or null; a lower key learns only `PdfView.hasSignature` |
| `work.pdf.setSignature` | approve | null |
| `work.pdf.sign` | approve | `PdfView` |
| `work.pdf.export` | operate | the copy's name, size, `rev` and warnings |

Every change pushes `{ push: 'work.pdf', sessionId, view }` (to full-capability
sockets only, for an item outside the remote roots; see "Reading the file"). There is no
`work.pdf.list` (work/ctx.test.ts holds every pillar's `list` to "not
built").

## The copy that leaves

`work.pdf.export` (and the `pdf_export` tool) writes
`canvas/<thread>/<item>/export/<time>-<id>/<the document's name>.pdf`.
Each copy has a folder of its own, so a draft that kept an earlier copy's
path still attaches those bytes; the newest five are kept, and
`work.pdf.read` with `which: 'export'` reads the newest. It writes the
version the canvas shows (the newest kept copy), and carries the values he accepted or typed, his highlights as real
`/Highlight` annotations named `tc:<threadId>:<markId>`, and his
signature drawn in as ink when he signed. A value that still waits is
never in it; `pdf_export` says how many wait. `flatten` (the default)
paints the fields into the page so nothing can be edited.

The font is Noto Sans from the toolchain (`pdf-font`), embedded as a
subset. Without it Helvetica writes what WinAnsi can say, and every other
value is refused by name in the warnings, never dropped in silence. A
character the font lacks (Noto Sans has no CJK) is refused the same way.

form.ts holds the traps the research measured: save with
`updateFieldAppearances: false` after drawing each field's appearance
ourselves (pdf-lib's own redraw is Helvetica and stops at the first field
it cannot draw); flatten with pdf-lib's `flatten()`, never by dropping
widgets; drop the XFA part of a hybrid form and keep its AcroForm values;
a form that is XFA only takes no values and says so.

## The extract job

`extract.ts` registers two converters, both needing `pdf-tools`
(pdfplumber and pypdfium2 in the toolchain's shared venv,
`scripts/work-tools/pdf.json`). Every other part reaches them through
`ctx.convert`, so the queue's caps, the caller's signal and forwarding to
a host that has the tools come free. A Mac without the venv sends the job
to the box.

- `pdf→extract` writes `PdfExtract` JSON: the page count, each page's size
  in points, text blocks in reading order, tables as rows of cells, and
  warnings. Options: `pages` ("1-3,7"), `tables` (default true),
  `maxPages` (at most 40, the default). A call past 40 pages reads the
  first 40 and says so in the warnings.
- `pdf→png` draws one page (`page`, from 1) at `width` pixels (64 to 2400,
  default 1280), or a region of it (`crop`, a `Bbox`). It calls
  `init_forms()` first: without it a filled form draws blank.

Every box is a share of the page, origin top left, to four places. The
options are checked against a strict schema before anything runs, since
another host's key may send them. The Python ships as a string
(`EXTRACT_PY`, written into the job's scratch folder and run with
`python -I`), because the app is bundled. It writes its output to a file,
never to stdout, which the runner keeps only the tail of. A refusal is one
line, `tc-error: <sentence>`, which the converter passes on as it is.

How the job reads a page:

- It counts the pages first (`count` mode, pypdfium2) so `parsePages` can
  refuse a page past the end with a sentence.
- Tables come from pdfplumber's `find_tables`; a ruled box with one cell
  is a frame, not a table. Text inside a table is kept out of the blocks.
- Words are cut into blocks by a recursive XY cut: paragraphs split at
  empty rows, columns at empty bands that run down the whole group. A
  wide space in one justified line is not a column.
- Text outside the page box (printer's marks) is left out, and so is
  turned text when the page has upright text.
- A page with images and no text says "page N has no text layer: it is a
  scan". Look at it with `pdf_page_image`.

`extractMarkdown(x, cite?)` renders the same JSON, never a second
reading: `## Page N`, each block a paragraph, each table a markdown table
where it sits among them. With `cite`, each passage and each table is
followed by its citation code.

**The seam for milestone 21.** That milestone owns "PDF to edit" and its
quality path (Docling for scans, columns and hard tables). It should not
register `pdf→extract` or `pdf→png`. Its Docling job writes this same
`PdfExtract`, and `pdf_extract` gains a `mode` to pick it. PyMuPDF and
pymupdf4llm are AGPL and are never imported here.

## The tools

A tool that takes `item` acts only on the thread's own pane (a subagent's
pane is its root's). `file` is an absolute path on this host.

- `pdf_extract { item | file, pages?, format? }`: markdown with a
  citation code after each passage of a canvas item, or the JSON. The
  preamble tells a thread to cite as `[p. 6, clause 7.2](#pdf:…)`.
- `pdf_page_image { item | file, page, region? }`: a PNG.
- `pdf_fields { item }`: each field's name, kind, label, page, box and
  value. Labels for a form with no tooltips are read off the page once
  per file version (an extract with `tables: false`, since a form's ruled
  boxes read as tables) and kept.
- `pdf_fill { item, fields }`: values by `key`, or boxes placed with
  `place` (`box:` keys only). Each value needs a `source`; a signature or
  date box takes no value. A refused box takes no value either.
- `pdf_export { item, flatten? }`: the copy's path, to attach to a draft.

## Citations

An agent cites a place as a markdown link:
`[p. 6, clause 7.2](#pdf:<itemId>:6:118,300,882,341)`. The four numbers
are the box in thousandths of the page; a page alone leaves them out.
`parsePdfCite` reads one back and takes a box with no area as the page.

## The canvas

All in `src/renderer/src/work/pdf/`. The approved design is
`.temp-code/prototypes/work-workspaces-2/pdf.html`, "The page, and ask":
the file as written in one column, the owner's marks on it, and nothing of
the agent's reading on the page. The agent's reading stays in the thread
and cites its page.

| File | What it does |
|---|---|
| `canvas.ts` | The kind's def (rides the canvas chunk), and the listener for citation clicks |
| `PdfCanvas.tsx` | The chunk: `Body` and `Bar`. Feeds the pane the mode, the stepper over the agent's values, the line after a direct write, and the state line for a moved file or an XFA form. The bar's pager, zoom, Find and Save a copy |
| `Column.tsx` | The page column: windowed pages, the text layer, highlights, find matches, the cited box, the field layer, the region drag on a scan, the thumbnail rail |
| `Fields.tsx` | The form's values on the page, the field popover, signing, the signature pad |
| `engine.ts` | pdf.js behind `PdfEngine`, loaded only with this chunk: bytes by range from the host (`work.pdf.read`), pictures, the text layer, a page's words as boxes |
| `item.ts` | `PdfHost` (the methods and the push) and `usePdfItem` |
| `nav.ts` | The page, the zoom and the find, shared by the body and the bar, one per item |
| `layout.ts`, `find.ts`, `cite.ts` | Where pages sit, finding words across runs, the citation link |
| `testkit.ts`, `*.test.ts(x)`, `PdfCanvas.preview.tsx` | A file of words in place of pdf.js, a host that keeps one view, the tests, the preview |

How it works:

- **pdf.js through its core API**, not its `PDFViewer`: the DOM is ours,
  so the paper tints, the fields and the cited box are plain React, and a
  DOM test drives it with a fake engine. The cost is our own windowing
  (only the pages within a screen of the view are mounted) and our own
  find. pdf.js and its worker load with the PDF chunk (`import()` in
  `engine.ts`); nothing of it is in the first paint. A zoom repaints a
  page once the column settles, and the old picture stays until the new
  one is whole.
- **Bytes by range.** The engine opens the file with pdf.js's
  `PDFDataRangeTransport` fed by `work.pdf.read`, so a long file over the
  tunnel shows its first page before the rest has come (a 34 MB, 300-page
  file painted page 1 after 1.2 MB). A file whose page dictionaries are
  spread through it (a classic xref, no object streams) is the exception:
  pdf.js reads every page dictionary before it opens, so most of the file
  comes first (34 MB in 4.3 s at 20 MB/s). pdf.js asks in 256 KB ranges,
  a quarter of the round trips of its 64 KB default; each
  request is answered once and whole (`readRange`: slices of 1 MB, joined),
  since pdf.js closes a request's reader on its first answer. One pdf.js
  worker serves every document in the window. A page that leaves the
  window is released (`page.cleanup()`), so a long scan does not hold
  every page's images.
- **Paper.** The page is `--paper` with `--paper-ink` in both themes, on
  `--stage`, 12px between sheets, a 24px side inset (12px under 640px),
  fit-width zoom up to 1.25 (under 0.5 only where the column is that
  narrow, so the page never runs past its edge), and 100, 125 and 150% in
  the menu. A
  file over 20 pages gets the 76px thumbnail rail (60px narrow). Tints on
  paper take the light theme's values: `--add-bg-paper` on an agent's
  value, `--sel-bg-paper` on a cited box and a selection,
  `--find-bg-paper` and `--find-bg-paper-current` on matches. A highlight
  is a neutral wash of the paper's ink.
- **The bar** is the pager ("6 / 14", following the scroll), the zoom,
  Find (also ⌘F or Ctrl+F while the PDF has the focus or the pointer; Enter
  and Shift+Enter step, Escape closes) and Save a copy (`work.pdf.export`,
  flattened, saved where he chooses). What does not fit gives way in the
  prototype's order (`barFits`): zoom and Save first, then, while the
  stepper is there, Find and the pager's arrows.
- **The form.** pdf.js draws the file's own empty widgets; the field layer
  draws the values over them at each field's box. An agent's value wears
  the added tint until he takes it; the stepper walks them page by page,
  top to bottom, and outlines the current one. A press on a field opens
  its source ("From Purdue profile: “…”") over a field for his own value
  (`work.pdf.setField`). The signature box is the dashed Sign: the first
  time, a pad dialog draws and saves his signature (`work.pdf.setSignature`),
  then `work.pdf.sign` places it and the date; after that one press signs.
- **Selection.** Words selected on a page feed the pane's floating bar:
  Ask (the chip names the page and carries the words and a citation code),
  Highlight (`work.pdf.mark`) and Copy. A press on a highlight offers Ask
  and Remove highlight. A page with no words is a scan: a drag draws a
  region, and Ask chips "Region of p. 12, <name>" with its code, which
  `pdf_page_image` can crop.
- **Citations.** `canvas.ts` installs one click listener on the document
  in the capture phase when the canvas chunk loads, that is when the first
  Work thread is shown. A click on a `#pdf:` link finds its thread from the
  pane around it (`data-session-drop`), shows the item (selecting its tab,
  or opening it again through `work.canvas.open`), and hands the body the
  page and box, which it scrolls to a few lines below the top and marks
  with `--sel-bg-paper` until the next citation. The transcript's markdown
  keeps a `#pdf:` href as a link (pdf.test.ts checks it through the real
  pipeline).
- **States.** Loading is a page-shaped skeleton. An encrypted file is one
  field and Open; a wrong password says so. A moved file is the state line
  ("Ballroom contract.pdf moved", "Read only, as of …") over the copy the
  host kept, with no mode. A file that will not open is one Empty.

Not built here, and why: History in the bar (the `history` kind is
milestone 19's, so the def does not ask the pane for it); Locate on a
moved file (a path picker on a remote host is its own work); links inside a
PDF are not clickable (the text layer is ours, not pdf.js's annotation
layer).

pdf.js's own files ship as assets of the PDF canvas (F2,
src/renderer/src/work/pdf/pdfjsData.ts): every CMap (168 `.bcmap`, for
text in a CJK font the file does not embed), the two standard fonts it
never takes from the system (FoxitSymbol and FoxitDingbats, BSD-3), and the
JPEG 2000 and JBIG2 decoders (`openjpeg.wasm` BSD-2, `jbig2.wasm`
Apache-2.0). Each is its own hashed asset, never inlined, fetched only
when a page asks for it through the `BinaryDataFactory` engine.ts hands
`getDocument`; the module that names them loads with pdf.js, never in the
first paint or the canvas chunk. They add about 1.5 MB to the app on disk
(1,536 kB of files, their six licence notices and a 32 kB map) and nothing to what a window loads
until a file needs one. Not shipped: the Liberation fonts (GPL with a
font exception; pdf.js uses the system's fonts for Helvetica, Times and
Courier anyway), the other Foxit fonts (read only with system fonts off),
the ICC profile and qcms (pdf.js fetches those only from its worker by a
base URL, which hashed assets cannot give; CMYK falls back to pdf.js's own
conversion) and quickjs (form scripts, which the canvas never runs).

## What is proven

On the box, with `TEMP_CODE_WORK_TOOLS_DATA=/srv/agents/temp-code-data`:

- The IRS W-9 (`fixtures/fw9.pdf`) fills, flattens, and our extract job
  gives the typed values back: name, business, address, city and the
  split SSN digits. The unflattened file's text has none of them: a fill
  is checked by flatten and extract, never by `/V` alone.
- A filled form's page picture differs from the blank one where the
  values go: pdfium draws the fields once forms are up.
- The wage-base table of IRS Publication 15 comes back cell by cell
  ($176,100, $168,600, $160,200, 12.4%, 2.9%), its text is not in the
  blocks, and the page's two columns read as columns.
- The W-9's fields take labels from the words beside them ("1 Name of
  entity/individual…").
- The tools run through the module: citation codes after every passage,
  labels read off the page, a region drawn as a PNG.

Everywhere: the form traps (form.test.ts), the store (store.test.ts), the
file helpers (file.test.ts), and every method through `startWork` on a
real database (pdf.test.ts), including the export with values, a
highlight and a signature.

In a real browser (headless Chrome, the real pdf.js 6.5, the real
canvas code; `src/renderer/src/work/pdf/browser.proof.test.ts` runs
`proof/run.ts` when asked with `TEMP_CODE_PDF_PROOF=1`, never in a commit's
gate): a 300-page, 34 MB
file read by range at 20 MB/s opens in about 0.2 s and paints page 1
after 1.2 MB, mounts two pages and a windowed rail, and a find counts
exactly the three pages with the phrase and steps to page 287 with its
match marked; a real click on a `#pdf:` link in a thread's pane scrolls
to page 212 and marks the clause over 92% of pdf.js's own box for its
words. The canvas's DOM tests (`PdfCanvas.dom.test.tsx`) drive the pane,
the stepper, fields, signing, find, citations, the moved and locked
states and page release with a file of words in place of pdf.js.

Not proven: the job on the Mac (the darwin-arm64 lines of the manifest
never ran); forwarding a PDF job to the box over a real link (the formats
pillar proves forwarding with LibreOffice); a 300-page file through the
extract job; a page with `/Rotate` in `pdf→png` with a crop.
