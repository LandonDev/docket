# Work: slides

Milestone 33 of the Work plan built this pillar. [work.md](work.md) says what
is mounted for the `slides` pillar and how it registers. The wire is
`src/shared/contract-work-slides.ts`; the server is
`src/main/server/work/slides/`.

## The server

### How it works

A deck is a .pptx file, and the file stays the truth. The host reads it with
python-pptx (its outline: slides by id, shapes, notes, sections, layouts) and
renders it to a PDF with LibreOffice, which the canvas draws. An agent's
revision is a list of edits by slide id (`SlideOp`: `text`, `cell`, `notes`,
`chart`, `add`, `remove`, `move`). The host keeps the edits as rows beside the
file and replays them onto a copy to draw the proposed deck. The owner steps
through the changes from the bar; accept writes a change into the file, reject
drops it. Agents suggest; the owner accepts.

- **The file.** `view.ts` `deckPath`: the item's source through `sourcePath`
  (pdf/file.ts), or `deck.pptx` in the item's own folder for a deck a thread
  made. A file that is not a zip is refused. A deck in PowerPoint on the web
  (a Microsoft source with a URL) and a Google file are refused with a
  sentence: milestones 28 and 30 open those.
- **Renders.** Each version of a deck is kept under
  `canvas/<thread>/<item>/render/<key>.{json,pdf}`: the outline and the PDF.
  The file's key is the sha256 of its bytes. The proposed deck's key is the
  sha256 of that hash and the JSON of the pending edits, and its copy is
  `<key>.pptx`. Both are salted with a hash of the deck script and the
  filter, so a new script makes them again. Every step reads a copy of the
  file taken first (in the item's `tmp/` folder), so a save meanwhile never
  lands under the old key. Each output is written beside its place and
  moved onto it, so a job cut short leaves nothing half written. So nothing is read or rendered twice. The newest four keys
  stay. The PDF keeps hidden slides
  (`impress_pdf_Export:{"ExportHiddenSlides":…}`), so page n is slide n. With
  no LibreOffice on this host or one it reaches, the view carries
  `renderError` and the outline alone.
- **One chain per item.** `serial(itemId, fn)` runs every step that reads or
  writes an item's files after the one before. Two opens at once render once,
  and a write never races a render. A step on the chain never waits on another
  step of the same chain.
- **The strip** (`stripOf`). `DeckView.slides` is the proposed order. A
  removed slide, and the place a moved slide leaves, are ghosts
  (`key: 'ghost:<id>'`, `number: null`, `tint: 'del'`, `from: 'file'`), each
  put after the nearest earlier slide of the file that stays where it was. A
  changed, added or moved slide has `tint: 'add'` and its `change`.
  `changed` holds the boxes of the shapes whose words or data differ between
  the two outlines.
- **Changes** (`changesOf`). One change per slide (`slide-<id>`), counted by
  `slideOfOp`: an edit's slide, or an add's own id. Its kind is `added`,
  `removed`, `changed` or `moved`, in that order of weight. `edits` is the
  words before and after per shape, per cell (`<name>, row r, column c`, from
  1), per chart (each series as `name: category value, …`) and for the notes
  (`Notes`).
- **A new edit is checked before it is stored.** The pending edits and the new
  ones go onto the copy the deck was hashed from, never the live file; if one of the new ones fails, nothing is kept and the
  agent gets the sentences, numbered as its own list. An older suggestion
  the file has outgrown does not block a new one; it waits for the owner to
  reject it.
- **Every write** (`writeInto`, Undo) works from a copy and replaces the
  file only while it is still what was read: a save the owner made
  meanwhile is never overwritten, and the write is refused with a sentence.
  The copy from before goes to `history/` first, so a write that fails
  leaves the file as it was. A link is followed, so its target is written,
  and the file's mode is kept.
- **Accept** (`accept`). Every waiting change at once replays the edits as
  they were made, which is how the proposed deck was drawn. Some of them: an
  `add` or `move` goes after the nearest slide before it in the proposed
  order that is in the file or lands in this accept, so it lands where the
  strip showed it, and what still waits is anchored again on that order, so
  the next accept lands there too. A trial run on the copy finds the
  changes whose edits no longer fit the file (he deleted a shape, or added
  a slide with the id a waiting add holds); those stay waiting, the rest go
  in, and the method answers with a `StaleChangesError` naming each by its
  title and its edit within the change ("“Four”: its edit 2 of 2: slide 259
  has no shape Body 2."), after pushing the view. The write goes onto a
  copy under strict, the old file goes to `history/<time>.pptx` (the newest
  ten stay), and the copy replaces the file whole (`copyWhole`). Their rows
  go. An edit left waiting that was anchored on a slide the accepted change
  removed takes the nearest earlier slide still there.
- **Reject** (`reject`). The rows go. Any other edit anchored on a rejected
  add takes that add's own `after`.
- **Direct writes.** In `writes` mode an edit goes into the file at once when
  its reason holds: `because: 'own'` on a deck that is not hosted, or
  `because: 'asked'` with a `quote` that `ctx.threads.ownerSaid` finds whole
  in one of the owner's own messages (milestone 6: at least 12 letters,
  case and spacing aside; an error reads as no). `own` on a hosted deck is
  always a suggestion. So is any edit made while suggestions wait: the agent
  reads the deck with them in, so its edit belongs with them. The mode is
  read on the item's queue, so an edit that waited behind a render follows
  a switch the owner made meanwhile. A direct write keeps the file before it in `history/` and
  records `written: { id, text, at, before, after }`; Undo puts the copy back
  only while the file's sha256 is still `after`.

### Tables

`store.ts`, made in `ensure` (no `BEGIN` or `COMMIT`: it runs inside the
host's savepoint), each with a `session_id`, each a move module
(`slides-items`, `slides-ops`):

- `work_slides_items`: `item_id`, `session_id`, `mode` (`suggests` or
  `writes`), `written` (the last direct write, JSON), `updated_at`.
- `work_slides_ops`: one pending edit a row: `id`, `item_id`, `session_id`,
  `seq`, `slide` (what the stepper counts it under), `op` (JSON), `by`,
  `at`. A row that no longer parses is left out.

`sessionsRemoved` deletes a removed thread's rows. The files go with the
thread's canvas folder.

### Methods

| Method | Capability | What it does |
|---|---|---|
| `work.slides.open` | read | → `DeckView`: reads and renders the deck and the proposed deck |
| `work.slides.read` | read | → `{ data, size, rev }`: bytes of the `file` or `proposed` render by range, at most 4 MB a call |
| `work.slides.review` | operate | accept or reject changes by id, or `all` → `DeckView` |
| `work.slides.mode` | operate | `suggests` or `writes` → `DeckView` |
| `work.slides.undo` | operate | puts the file back before the agent's direct write → `DeckView` |

A thread's own call (`kind: 'model'`) may not review or set the mode. Every
change pushes `work.slides` with the view. There is no method named `list`.

The listener's path fence reads only the paths a request names, and these
methods name an item id. So `handle` fences the item itself, once, before
any method runs: `fenceItem` (pdf/file.ts) refuses a remote key every one of
the five methods on a deck whose file is not under `remoteRoots` (every
project's checkout and every workspace's folder), with the fence's own
error. The key gets nothing of the view and changes nothing. A deck a
thread made sits in its own folder and passes; this host's own window
always passes. `remoteRoots` admits less than the listener's own list
(which also has the work root and the attachment folders), never more.

The `work.slides` push goes to every client socket that holds the
capability `PushTo.need` names. That is the only filter the push API has,
so a deck outside the remote roots is pushed with `need: 'admin'`
(`inRemoteFence`, as the pdf pillar does): the host's own window hears it,
a read or operate key does not. An admin key still does. Closing that needs
a push filter by path (`PushTo` naming the item's file, checked against
each remote socket's fence), which is the frame's.

### Tools

- `slides_read { item }`: the outline (each slide's number, id, layout,
  title, every shape's id, name and words, a table by rows, a chart's data,
  the notes, the sections, the layouts). The proposed deck when edits wait.
- `slides_image { item, slide }`: one slide as a PNG, through `pdf → png`
  (the pdf pillar's converter) on the render.
- `slides_edit { item, ops, because, quote?, summary? }`: the rules above. An
  `add` without an `id` gets one `HOST_ID_GAP` (10,000) above the deck's
  highest id and above every id given before it, the waiting adds' included
  (`allocateIds`), so two adds are never next to each other. PowerPoint
  gives a slide the owner adds the highest id plus one; after a partial
  accept lands one add, that is still no waiting add's id. Near 2^31 the
  next free id is used. The answer names the ids.
- `slides_new { title, slides, theme?, save? }`: a new deck on pptxgenjs
  (`newDeck.ts`). With `save`, an absolute path to a new .pptx (never an
  existing file), it is a file there; else it is the thread's own
  `deck.pptx`. It opens in the canvas and renders while the answer goes back.

### Converters

`deck.ts` registers two, both `needs: 'python-pptx'`, so a host without it
forwards them:

- `pptx → deckinfo`: writes `DeckInfo` as JSON (to a file, never to stdout:
  `runTool` keeps only the last half megabyte).
- `pptx → pptxedit`: applies `options.ops`; `strict` fails the whole list on
  any warning and keeps nothing. Options from another host's key that are not
  a list of edits are refused.

The Python is `DECK_PY` in `deckScript.ts`, a `String.raw` (no backtick, no
`${`), written into the job's scratch folder and run with `python -I`.
`pptx → pdf` is the toolchain's LibreOffice converter.

### A new deck

`writeNewDeck` (`newDeck.ts`) makes each of our layouts a real named layout
(`Title`, `Title and Content`, `Table`, `Chart`, `Section Header`), so
python-pptx can add a slide from it by name. Each has real title and body
placeholders. Sizes and colours are set on the text too, since a layout's
size does not reach the text in every reader. A chart is native, with its
workbook. `theme` gives a dark or light ground and an accent.

### The byte rule

python-pptx re-serialises every part and renames slide parts to deck order
on save, so a PowerPoint-saved file comes back changed everywhere. After it
saves, `finish()` writes the output zip itself and keeps the input's bytes
(and the entry's date) for every part whose content did not change:

- slides and their notes pair by `p:sldId/@id`, never by part name;
- XML compares by C14N 2.0, with blank text between tags dropped, as
  python-pptx reads it (pptxgenjs writes a newline in each empty element);
- `.rels` compare as sets of resolved targets, `[Content_Types].xml` as a
  set; anything else by bytes.

Entry order is the input's, `[Content_Types].xml` first. `finish` refuses
(a `Fail` with a sentence, nothing written) a zip in which a name repeats,
so no edit can write a corrupt deck over his file.

How it is proven (`deck.test.ts`, behind `TEMP_CODE_WORK_TOOLS_DATA`, a
userData whose toolchain has python-pptx; `/srv/agents/temp-code-data` on the
box): on `fixtures/04-groups.pptx`, saved by PowerPoint, one `text` edit
changes exactly one zip entry, `ppt/slides/slide1.xml`. Every other slide,
layout, master, theme and media part is byte-identical, the entry order holds,
and the run's look survives. A move, an add and a remove keep the untouched
slides' hashes; a cell and a chart edit on a pptxgenjs deck keep every other
slide's.

### Traps

- python-pptx renames slide parts only the first time `prs.slides` is read,
  and names a new slide by the count of slides. After a remove, a second add
  took a name a slide still held, and one overwrote the other in the zip. The
  script now renames the parts to deck order before each add.
- A removed slide that another slide links to (a jump link, any
  relationship to its part) stayed reachable, so python-pptx saved it under
  its old name, and the next rename gave that name to a second slide: two
  `slide3.xml` entries, a deck LibreOffice cannot open. `op_remove` now drops
  every relationship that points at the slide, with the link elements that
  name it (`a:hlinkClick`, `a:hlinkHover`), and takes the slide out of every
  `p:custShow`, which otherwise kept a dangling `r:id`. Each link it takes
  out comes back as a note, `note: edit N: slide 256 linked to slide 258;
  that link was taken out`: no failure under strict, and `slides_edit` tells
  the agent ("Note on edit 2: …"). Anything else that names the slide's
  relationship makes the remove fail with a sentence, and nothing changes.
- `ctx.convert` reads `WORK_MODULES`, not the list `startWork` got: a test
  puts its converters there.
- A deck with sections needs every slide in one; add, move and remove keep
  `p14:sectionLst` in step (tested on a pptxgenjs deck with two sections).
- `shape_type` raises on a `p:sp` with no geometry, which some exporters
  write; the script finds groups by their tag alone.
- PowerPoint needs a slide id below 2^31; the script refuses one above.
- A `notes` edit on a deck with no notes master adds a notes master and a
  theme: more than one part changes.

### Tests

- `deck.test.ts`: `allocateIds` and `slideOfOp`; behind the gate, every edit
  through a `JobRunner` on the converters, the byte rule, sections, the
  failure sentences, a removed slide another slide links to (no name twice,
  LibreOffice opens each result), a custom show, and `finish`'s refusal of
  a repeated name.
- `newDeck.test.ts`: the bytes through jszip; behind the gate, read back
  through `pptx → deckinfo`.
- `slides.test.ts`: the store, and the module end to end through a real
  in-memory database and `startWork` with a fake deck tool (a "pptx" that is
  `PK\3\4` and JSON). Behind the gate, a 12-slide pptxgenjs deck renders
  through LibreOffice, one page a slide, a suggestion shows on the proposed
  render, and `slides_image` returns a PNG.

## The canvas

All in `src/renderer/src/work/slides/`. The approved design is
`.temp-code/prototypes/work-workspaces-2/slides.html`, "Filmstrip and
stage".

| File | What it does |
|---|---|
| `canvas.ts` | The kind's def |
| `SlidesCanvas.tsx` | The chunk: `Body` (the strip and the stage), `Bar` (the line while PowerPoint shows the deck) and `TabEnd` (the TempCode and PowerPoint switch) |
| `deck.ts` | `DeckHost` (the methods and the push), the per-item store the three parts share (the view, the slide on the stage, which app shows it), and `useRender`, which opens one of the deck's renders in pdf.js |
| `testkit.ts`, `SlidesCanvas.dom.test.tsx`, `SlidesCanvas.preview.tsx` | A host that keeps one view, the tests, the preview |

How it works:

- **A slide is a page of the render.** The host renders the deck to a PDF
  with LibreOffice; the canvas draws its pages with the PDF kind's engine
  (`../pdf/engine.ts`), read by range through `work.slides.read`, so there
  are no thumbnails to make on the host. The deck as it is and the
  proposed deck are two renders; each `DeckSlide` says which one holds its
  picture and on which page.
- **The strip** is 140px on `sidebar`: each slide a 96px picture in a 3px
  frame at 6px radius that carries the tint (`--add-bg` for a slide a
  change rewords, adds or lands; `--del-bg` for the place a slide leaves,
  its picture at 45%), its number 12px tabular to its left, and a
  section's name over the slide that starts it. A thumbnail paints only
  near the view and after the stage, and lets pdf.js free its page when it
  leaves. Under 400px of canvas the
  strip becomes a row under the stage.
- **The stage** is at most 760px wide with a 16px inset, short enough that
  the notes start on screen. The changed shapes' boxes are tinted on the
  picture, in the theme the picture is in: `--add-bg-dark-pic` on a dark
  slide, `--add-bg-paper` on a light one, read from the drawn pixels
  (`toneOf`). A press on a shape with words selects it and feeds Ask
  ("“6,200 stream viewers”, slide 3").
- **What changed**, under the stage: each edit's place (a shape, a cell,
  the notes) at 12px muted, then the words before, struck, on `--del-bg`
  and the words after on `--add-bg`. Then Notes, 14/22 under a 12px medium
  muted "Notes", or "None yet".
- **The stepper** counts one change a slide (`SlideChange`), in the view's
  order; stepping moves the stage to the slide where the change lands, or
  to the place a removed slide leaves. Accept and Reject call
  `work.slides.review` with that change. A move shows twice: tinted where
  it lands and where it leaves.
- **The mode, the written line and the state line** come from the view:
  "Agent writes" shows the last direct write with Undo; a host with no
  LibreOffice in reach says "Can't draw the slides" once and the strip and
  stage show each slide's title on a blank.
- **PowerPoint.** For a deck that lives in PowerPoint (`hosted`), the tab
  row has the TempCode and PowerPoint switch, where the sheet's Excel
  switch goes. The PowerPoint side is milestones 28 and 29; until then it
  says "Not built yet", and the bar says how many suggestions wait in
  TempCode, with Review to go back to them.

Where it differs from the prototype: the prototype draws its slides in
HTML, so it tints the changed words in place and strikes the removed ones.
A real slide is a picture, so the changed shapes are tinted on it and the
words before and after are listed under the stage. The grid and the
outline (the prototype's other variations) and someone else's presence in
the deck (it needs real co-authoring, milestones 28 and 29) are not built.

Proven in a real browser: a 12-slide deck written by `writeNewDeck` and
drawn to PDF by LibreOffice 26.8.3 paints in the strip and on the stage
through the real pdf.js (`src/renderer/src/work/pdf/proof/run.ts` with
`M33_DECK_PDF`). The DOM tests (`SlidesCanvas.dom.test.tsx`) drive a
12-slide strip, a revision of five changes stepped and accepted from the
bar with a move tinted where it lands and where it leaves, a shape asked
about, the push, the PowerPoint switch, a deck with no picture and the
written line.
