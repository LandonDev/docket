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
  sentence: a Google deck opens in Google, and the google tools read it and
  revise a copy ([work-google.md](work-google.md)); opening one from
  PowerPoint on the web is not built.
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
| `work.slides.show` | read | → `ShowDeck`: the file's slides in the file's own order (`id`, `number`, `page`, `title`, `notes`, `hidden`), its render and its `rev`, for a show. A waiting suggestion is never in it: a show presents the deck as it is on disk. The render is read with `work.slides.read {which: 'file'}` |
| `work.slides.review` | operate | accept or reject changes by id, or `all` → `DeckView`; an optional `rev` (the proposed render's, as the view advertised it) binds the press to that preview: when the changes moved on since, nothing is accepted or rejected, every client is told the deck as it is, and the call fails with "The suggestions changed since this preview". The phone always sends it and reads the render's bytes only at that rev; the desktop's strip sends none and is not checked |
| `work.slides.mode` | operate | `suggests` or `writes` → `DeckView` |
| `work.slides.undo` | operate | puts the file back before the agent's direct write → `DeckView` |

A thread's own call (`kind: 'model'`) may not review or set the mode. Every
change pushes `work.slides` with the view. There is no method named `list`.

The listener's path fence reads only the paths a request names, and these
methods name an item id. So `handle` fences the item itself, once, before
any method runs: `fenceItem` (pdf/file.ts) asks the listener's own fence
(`ctx.reaches`) and refuses a remote key every one of the six methods on a
deck whose file it could not name itself, with the fence's own error. The
key gets nothing of the view and changes nothing. A deck a thread made sits
in its own folder and passes; this host's own window always passes.

The `work.slides` push names the deck's file (`pushFor`, `PushTo.path`), so
it reaches only the sockets whose caller could name that file: the host's
own window, and a key whose roots hold it, admin or not.

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

## A mail's attachment

A .pptx from a mail (`{at: 'mail'}`) opens through the PDF pillar's `sourcePath`, which answers the copy the host fetched into the item's own folder (work-canvas.md "Fetched sources").

## The canvas

All in `src/renderer/src/work/slides/`. The approved design is
`.temp-code/prototypes/work-workspaces-2/slides.html`, "Filmstrip and
stage".

| File | What it does |
|---|---|
| `canvas.ts` | The kind's def |
| `SlidesCanvas.tsx` | The chunk: `Body` (the strip and the stage), `Bar` (the line while PowerPoint shows the deck) and `TabEnd` (the TempCode and PowerPoint switch) |
| `deck.ts` | `DeckHost` (the methods and the push), the per-item store the three parts share (the view, the slide on the stage, which app shows it), and `useRender`, which opens one of the deck's renders in pdf.js |
| `Present.tsx` | Present, the split button at the end of the deck's bar, its menu, and the keys that start a show while the keyboard is in the deck |
| `show/` | The show, a chunk of its own loaded when the pointer first reaches Present: `state.ts` (the state and its keys), `timer.ts`, `Show.tsx` (a show running), `places.ts` (the documents it is drawn in), `Audience.tsx` (the slideshow), `Presenter.tsx` (the presenter's view), `pictures.tsx` (a slide painted at a window's size) |
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
  switch goes. The PowerPoint side of the switch is not built (the
  Office milestones, 28 and 29, put Excel behind the grid only): it says "Not built yet", and the bar says
  how many suggestions wait in TempCode, with Review to go back to them.

Where it differs from the prototype: the prototype draws its slides in
HTML, so it tints the changed words in place and strikes the removed ones.
A real slide is a picture, so the changed shapes are tinted on it and the
words before and after are listed under the stage. The grid and the
outline (the prototype's other variations) and someone else's presence in
the deck (it needs real co-authoring) are not built.

Proven in a real browser: a 12-slide deck written by `writeNewDeck` and
drawn to PDF by LibreOffice 26.8.3 paints in the strip and on the stage
through the real pdf.js (`src/renderer/src/work/pdf/proof/run.ts` with
`M33_DECK_PDF`). The DOM tests (`SlidesCanvas.dom.test.tsx`) drive a
12-slide strip, a revision of five changes stepped and accepted from the
bar with a move tinted where it lands and where it leaves, a shape asked
about, the push, the PowerPoint switch, a deck with no picture and the
written line.

## The show

Built by SLD1 of the editors plan (`.temp-code/plans/editors/slides.md`;
the look and every key are docs/DESIGN.md "The show"). He presses Present on
a deck and gives a talk from it: the slideshow full screen or in a window,
a presenter's view with the notes, the next press and a timer, and every
key a clicker sends.

- **What is shown.** The file as it is, read with `work.slides.show`: its
  slides in its own order and the file's render. An agent's suggestion that
  still waits is never presented. When the file changes under a show (an
  edit lands, a change is accepted) the deck's push names a new `rev`; the
  show reads the deck again and keeps its place by the slide's id, and the
  picture on screen stays until the new render has painted that slide
  (`SlidePicture`), so a save mid-talk never blanks the room's screen. A
  read that fails is asked again by itself (after 2 s, then twice as long
  each time, to 30 s): with no deck up yet both windows say why meanwhile;
  with one up it stays up and the presenter's view says "Reconnecting to
  the deck…". A read the file moved on from is read again at once.
- **One state.** `show/state.ts` is a pure reducer: the slide, the build
  (`Slide.builds`: none yet, the host does not read a deck's timing until
  SLD6, so every slide is one press), blank, the end, the number being
  typed, the picker. Hidden slides are passed by Next and Previous; a jump
  by number or from the strip shows one. `keyAct` maps the keys.
- **Its windows are drawn by the main window**, as the pop-out is, not
  pages of their own: the page asks main for a show (`window.tcShow`, the
  preload's `show:begin`), main answers a frame name for each window, made
  for that one show (`tc-show-<id>`, so nothing else in the page can ask
  for a show's window by a name it knows), the page opens each under its
  name (`showWindowOptions` in `src/main/present.ts`, asked first by the
  open handler in `windows.ts`, lets it through once), mirrors its
  stylesheets and theme into it (`mirrorLook`) and fills it through a
  portal from a React root of its own. The names both sides share are in
  `src/shared/slidesShow.ts`, which has no zod. So the two
  windows cannot fall out of step, a show reaches the deck's host as the
  page does (no second sign-in), and it goes on whatever the main window
  shows meanwhile. The slideshow's document never takes the light theme's
  class. A child window has none of the main window's preload.
- **Main owns what a page cannot** (`createShows`): where each window goes
  (`planShow`), full screen (taken once the window is shown, never while it
  is hidden; on a Mac the window is laid over its display with no Space of
  its own, `setSimpleFullScreen`, since a Space of its own blanks the other
  displays where they share Spaces), the display kept awake for the show's life (a
  `prevent-display-sleep` power assertion of its own, let go at the end),
  the page kept drawing (below), and a display that leaves. Where a show
  goes:

  | He asks | One display | Two or more |
  |---|---|---|
  | Present, From the start, From this slide (`full`) | the slideshow, full screen | the slideshow full screen on the other display (or the one he picked), the presenter's view filling his own display's work area |
  | Presenter view (`presenter`) | the presenter's view alone, in a window: a rehearsal | as above |
  | In a window (`windowed`) | the slideshow at 640 by 360 and the presenter's view at 744 by 582 beside it, centred, shrunk together on a smaller screen | the same, on his own display |

  A display removed mid-show: main tells the page (`show:display-gone`),
  which closes the slideshow's window and keeps the presenter's view with a
  line saying so; main closes the window itself a second later if the page
  did not. The page going (a reload, its window closing, its process
  dying) ends its show in main.
- **The page must keep drawing behind its own slideshow.** The main
  window's page is the show: it paints every slide (pdf.js schedules its
  drawing on that window's animation frames) and keeps the timer. A
  full-screen slideshow over the main window makes that page hidden, and a
  hidden page gets no frames at all (the first live run showed a black
  slideshow for exactly this) and, after five minutes, one timer tick a
  minute. So for a show's life main turns the asking page's background
  throttling off (`keepLive`: `setBackgroundThrottling(false)`, which also
  keeps the page visible to itself) and puts it back at the end.
- **A show's document waits for its stylesheets** (`held` in `places.ts`):
  the mirrored `<link>` sheets load a moment after the window opens, and
  until they have (or 1.5 s pass) its body is unseen, so the room never
  sees a frame of bare, unstyled words.
- **In a browser** (`/ui`) there are no child windows: the surface is a
  frame over the page (`openFramePlace`), and the slideshow takes the
  page's own full screen, asked for in the press that started the show.
  Leaving full screen ends the show. In a window is not offered there, and
  Presenter view is the presenter's view filling the page.
- **A show ends** on Escape, End, a press past "End of show", either window
  closed by hand, or a new show. Ending tells main at once and closes its
  windows; a new show asks for its windows only after the one before it has
  ended in main, and a second press while a show is starting is that same
  start.
- **Whose key it is.** Every key of the table moves the show from either
  window. Return and Space on a control he tabbed to press that control
  (End show, Pause, the target's menu); after a press made with the
  pointer the keyboard goes back to the view, so Space is the next slide
  and never a second press of the button he last used.
- **Not built yet** (each is a later milestone of the same plan): builds,
  transitions and "advance after" (a change of slide is a cut), video and
  audio on a slide, the phone as a clicker, presenting a PDF, and "In
  PowerPoint". A menu in a child window cannot use the app's popover or
  menu components, which mount in the main window's page: the slideshow's
  picker and the presenter's target menu are panels of their own.

Tests: `show/state.test.ts` (the state, every key, the timer),
`show/Show.dom.test.tsx` (both surfaces, and a whole show on places that
stand in for its windows: one state in two places, the file changing under
it, a window closed, the display leaving, a browser's frame),
`Present.dom.test.tsx`, `SlidesCanvas.dom.test.tsx` (Present in the bar and
the keys), `src/main/present.test.ts` (the plan for one, two and three
displays, the frames, the power assertion, a display removed).
