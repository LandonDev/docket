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
- **Kept by the deck, not the item** (`deckKey`, `view.ts`). A file on this
  host is one deck whichever canvas items show it: a thread's canvas and a
  Files tab on one file share one list of waiting edits, one last write and
  one queue. The key is `file:<real path>` for a file (a link and its
  target are one deck; a file that is not there yet is keyed by its
  folder's real path and its name) and the item's own id for a deck only
  that item can hold (one a thread made, a mail's attachment). Each item
  that shows a deck takes a seat on it (`seatOf`, `work_slides_seats`);
  rows kept under the item from before this rule move to the deck's key
  the first time it is opened, and two such items' waiting edits are both
  kept, in the order they are opened.
- **The mode is the seat's.** "Agent writes" is a leave he gives an agent
  in one tab. Kept by the file it would reach every thread that ever opens
  that file, so each seat has its own mode (`SlidesStore.mode(itemId)`), as
  each item had before, and a seat that goes takes its mode with it.
- **Shared is the deck's.** Whether others can open a deck is asked of the
  deck, not of one item (`sharedDeck`): it is shared when this item's
  source says so (`deckShared`) or any other seat's on the same file does.
  So two seats that name one file differently (a path in a library, the
  same path as a plain file) hold it to the stricter word: its
  suggestions stay on this host through every seat, every conversion
  carries `shared: true`, and what an earlier seat kept by the file is
  removed when a shared seat sits down.
- **Where a deck keeps its files** (`deckDir`). His own file keeps its
  versions by the file, under `<data>/work-slides/<sha256 of the key, 32
  characters>/history/`, and what can be made again (renders, pages,
  scratch copies) under `<data>/work-slides/.cache/<the same>/`, which the
  box's backup leaves out. So every seat shares them and its versions
  outlive a closed tab. A deck only the item holds, and a file others can
  open, keep them in the item's own folder (`canvas/<thread>/<item>/`) and
  they go with the item: nothing made from a shared file outlives its tab.
  On a shared file the Undo of an agent's direct write is offered only in
  the tab that made it (the copy from before is in that item's folder) and
  goes with that tab.
- **When a seat leaves.** A closed Files tab comes through `itemsRemoved`
  (`itemsGone`); a removed thread's items do not, so `sessionsRemoved`
  (`sessionsGone`) lets its seats go by the same rules. A deck only that
  item held goes with it. A file others can open drops its waiting edits
  and its last write with its last seat. His own file keeps its waiting
  edits and its versions for the next time it is opened; only its
  pictures, which can be drawn again, go with the last seat, on the deck's
  own queue so a render still running is not cut from under. A removed
  thread's own suggestions on a file go with it (`by` names the thread).
  An item that never took a seat (never opened since this rule) leaves the
  deck as its other seats hold it.
- **A file renamed or moved** (`fileMoved`, registered with
  `registerFileMoved`): the deck's rows and seats take the new path's key
  and its folders go with them, so the waiting edits, each seat's mode,
  Undo and the versions are still the deck's under its new name. A key
  with nothing kept under it moves nothing. **Nothing calls this yet**:
  the Files build's rename and move are not built (`work.files.rename`
  throws), and a rename in Finder leaves the rows under the old key, as
  before. It runs when Files calls its hooks.
- **Renders.** Each version of a deck is kept in the deck's `render/` folder
  as `<key>.{json,pdf}`: the outline and the PDF. The file's key is the
  sha256 of its bytes. The proposed deck's key is the sha256 of that hash and
  the JSON of the pending edits, and its copy is `<key>.pptx`. Both are
  salted with a hash of the deck script and the filter, so a new script
  makes them again. Every step reads a copy of the file taken first (in the
  deck's `tmp/` folder), so a save meanwhile never lands under the old key.
  Each output is written beside its place and moved onto it, so a job cut
  short leaves nothing half written. So nothing is read or rendered twice.
  The newest four keys stay. The PDF keeps hidden slides
  (`impress_pdf_Export:{"ExportHiddenSlides":…}`), so page n is slide n. With
  no LibreOffice on this host or one it reaches, the view carries
  `renderError` and the outline alone.
- **A picture that keeps up** (`pictures.ts`, `deckPicture`). The outline
  gives every slide `draws`: the sha256 of every part the slide is drawn
  from (the slide, its layout, master and theme, each picture, chart and
  media file it names; never its notes or another slide), of what it takes
  from the deck itself (`deck_draws`: the slide size, the number slides
  count from, the default text style, embedded fonts and table styles; not
  the list of slides), and of its number when it shows one. Each slide's
  one-page PDF is kept in the deck's `pages/` folder, named
  `pageName(salt, draws)`: the salt is the deck script, the filter and the
  toolchain as installed (its state file's time and size), so a new
  LibreOffice or font pack draws every slide again. A font put on the host
  by hand is not seen. To make a version's PDF: when every page
  is kept, they are put together (pdf-lib; 12 pages 61 ms, 48 pages 165 ms)
  and nothing is drawn; when up to four are missing (`ONE_AT_A_TIME`) and a
  LibreOffice is kept running (`setSlideRenderer`), those slides alone are
  drawn; otherwise the whole deck is exported once and its pages kept one by
  one. A slide drawn alone is refused when LibreOffice counts other slides
  than the outline does (page n would be another slide), and a kept page
  that will not read is dropped and drawn again. A deck past 400 slides (`RESIDENT_MOST`) is never handed to the kept
  LibreOffice: it opens the whole file for each job and a job has ten
  seconds. Any failure of the kept LibreOffice falls back to a LibreOffice
  started for the job, the way a deck was always drawn. A page split from a
  whole export and put back is the same picture, pixel for pixel
  (`pictures.test.ts`). The newest 1,200 pages a deck stay (`PAGES_KEPT`).
- **The LibreOffice kept running** (`resident.ts`, `residentScript.ts`).
  One per host, started at the first deck drawn while Work is on (the
  module's `start`), in `<data>/work-slides/.cache/resident/` with a profile
  of its own. One child: LibreOffice's bundled Python runs `RESIDENT_PY`,
  which starts soffice with the formats pillar's options and a UNO listener
  on a pipe, and drives it, one JSON line a job. Each job opens the deck
  hidden and read-only, with no link refreshed and no macro ever run,
  exports with `impress_pdf_Export` (hidden slides kept, `PageRange` for one
  slide), and closes it. One job at a time. A job with no answer in 10 s
  kills the tree; a crash, a failed start and a stop all reject with
  `ResidentUnavailable`, and the caller draws the old way. A job cancelled
  while it runs is answered at once, runs out and has its picture dropped:
  UNO cannot cancel it, and a kill would cost the next job a start. It
  stops after ten idle minutes, past 1.5 GiB of memory, and when Work is
  turned off; a start waits for the old one to end, so two never share the
  profile. If the app dies, the driver ends soffice whether it reads the
  end of its stdin or fails to write an answer.
  The pipe: LibreOffice puts a pipe only under `/tmp/OSL_PIPE_<uid>_<name>`,
  so the name is random and that path is a link the module makes (never
  followed if it exists) to a 0700 folder of its own, where the socket
  lives; its own dangling links are swept at the next start. No TCP port. Linux and macOS; Windows has none and draws the old
  way. Measured on the box under load: one slide of a 12-slide deck 0.13 to
  0.21 s, of 50 slides 0.37 to 0.47 s, of 200 slides 1.3 to 1.9 s (opening
  the file is nearly all of it). One slide drawn alone is the same picture
  as that page of a whole export, 0 pixels apart in 24 pairs
  (`resident.test.ts`, behind the gate).
- **One slide's own picture** (`slidePath`, `work.slides.slide`). A client
  that wants one slide reads that slide's one-page PDF by range, named by
  its id in the file or the proposed deck. `DeckSlide.pic` carries its `rev`
  (the first 16 characters of the page's name) and size, so a client keeps the
  picture of a slide an edit did not touch and reads only the one that
  changed. A page not kept yet is split from the deck's PDF.
- **A render never holds up a write** (`predraw`). Before a read takes its
  turn on the deck's queue, the pictures it will need are drawn beside the
  queue: on the queue only the outlines are read and the missing PDFs
  named; the drawing runs off it, once for a PDF however many ask. So his
  next edit goes into the file while the picture of the last is still
  being drawn. A picture that turns out stale is kept under its own key
  and harms nothing; one that fails beside the queue is drawn again on it,
  which then says why.
- **One chain per deck.** `serial(ctx, item, fn)` runs every step that reads
  or writes a deck's files after the one before, in the deck's own line
  (`seatOf`): two opens at once render once, a write never races a render,
  and two seats on one file wait in the same line. A step on the chain never
  waits on another step of the same chain.
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
  its reason holds: `because: 'own'` on a deck nobody else can open, or
  `because: 'asked'` with a `quote` that `ctx.threads.ownerSaid` finds whole
  in one of the owner's own messages (milestone 6: at least 12 letters,
  case and spacing aside; an error reads as no). `own` on a deck others can
  open is always a suggestion ("Suggestions stay private", below). So is any edit made while suggestions wait: the agent
  reads the deck with them in, so its edit belongs with them. The mode is
  read on the item's queue, so an edit that waited behind a render follows
  a switch the owner made meanwhile. A direct write keeps the file before it in `history/` and
  records `written: { id, text, at, before, after }`; Undo puts the copy back
  only while the file's sha256 is still `after`.

### Suggestions stay private

The owner's ruling (2026-11-23), for every kind of file: nothing an agent
suggests may be seen by anyone else on the team until he approves it and
the file is really edited. For a deck:

- **Which decks.** `deckShared(ctx, item)` (`view.ts`): a deck that lives in
  PowerPoint (`{at: 'microsoft'}`), and any file `sharedOf` (the files
  pillar's `policy.ts`) says others can open: a Teams or OneDrive library,
  any cloud folder of this computer, a file on another host.
- **A suggestion is rows and a copy on this host.** The edits are rows in
  `work_slides_ops`; the proposed deck (`render/<key>.pptx`), its outline
  and its picture are under the item's own folder in app data, never beside
  the file. The file is not opened for writing until he accepts: a waiting
  suggestion leaves it byte for byte as it was and writes nothing into its
  folder, so nothing syncs.
- **`own` never writes a shared deck**, whatever the mode says: in "Agent
  writes" an agent's own idea on such a deck is still a suggestion, and the
  agent is told so. What he asked for in so many words (`asked` with his
  quote) is written at once, as the ruling allows.
- **No copy leaves the host.** Every conversion of a shared deck's copy
  (the outline, the picture, a checked edit, `slides_image`'s PNG) is
  marked `shared: true`, so the runner runs it here or fails and never
  carries it to another host (work-formats.md "Jobs").
- **A new deck is not put where others can see it.** `slides_new` with a
  `save` path in such a place is refused in words; the deck is made in the
  thread and he moves it.
- **Who sees the review.** `work.slides.open`, `read` and the `work.slides`
  push reach only a caller who could name the file itself (`fenceItem`,
  `pushFor`): his own window and his own keys. A deck is not guestable, the
  PowerPoint side of the switch is not built, and this pillar uploads
  nothing anywhere.
- **Accept** writes the change into the file as an ordinary edit; from then
  on it syncs like any save.

Tests: `slides.test.ts`, "a deck in a place others can open".

### Edits by hand

Built by SLD4 (`hand.ts`, `handLine.ts`). He edits a deck himself: the edit
is his own, so it goes into the file at once, whatever the tab's mode and
whoever else can open the file. A thread cannot call any of this: an agent
edits through `slides_edit`, where the mode and the hold decide what reaches
the file.

- **Two edits for words and their look** (`SlideOpSchema`, `deckScript.ts`
  `op_runs`, `op_format`), which `slides_edit` takes too, under the rules
  that stand:
  - `runs`: a shape's (or one cell's) paragraphs as runs. A paragraph `from`
    an old paragraph keeps its spacing, level and list; a run `from` an old
    run (`[paragraph, run]`, counted as the outline lists them, line breaks
    and fields included) keeps that run's own properties, and what the run
    sets (`font`, `size`, `bold`, `italic`, `underline`, `color`) goes on
    top. A run from nowhere takes its paragraph's first look. A line break
    in a run's words is a break; a field he did not retype stays a field;
    an empty paragraph keeps the look his next words will take.
  - `format`: a look on a whole shape (every cell, for a table), on one
    cell, or on a `range` of characters (`[paragraph, character]`, a line
    break counting one), cutting runs in two where the range does. It sets
    the run look and `level`, `align` and `list`.
  - What is written is what PowerPoint writes: a run's properties in the
    schema's order (`RPR_ORDER`; PowerPoint 16 opened one out of order
    with no word, but a stricter reader may not), a font as `a:latin` and
    `a:cs`, a colour as `a:srgbClr` or the theme's own `a:schemeClr`, a
    size in hundredths of a point (divided by the shape's shrink, so the
    size he asks for is the size drawn), a list as PowerPoint's own bullet
    or `arabicPeriod` with its hanging indent, a paragraph taken out of a
    list with `a:buNone` and no indent.
- **One run of the tool for an edit.** `pptx → pptxstep` applies the edits
  under strict (an edit of his that does not go in whole writes nothing),
  makes the pack that reverses them and reads the new deck's outline, all
  in one Python process; the three come back as one file (`joinStep`,
  `splitStep`: the conversion runner carries one file each way). The
  outline is kept under the new file's key (`keepOutline`), so the view is
  not read again.
- **Undo and Redo walk packs.** A pack (`pack`, `unpack` in the script) is
  what turns one deck back into another, part for part: the first deck's
  order of parts, and the bytes of each part the second changed or lost.
  Applying it puts every part back byte for byte, so the byte rule holds
  both ways and an undone picture or chart leaves no part behind.
  `pptxstep → pptxstep` applies a pack and answers the pack that reverses
  that. The packs are files in the deck's `undo/` folder (under `.cache`
  for his own file, in the item's folder for a shared one); which comes
  next is kept in memory (`hands`), so his undo ends when the app does, as
  it does in PowerPoint. The last 100 edits can be taken back.
- **The line holds only while the file is what it left.** It is checked by
  the file's hash: an accepted suggestion, an agent's write, a restored
  version or a save from another program ends it, and `DeckView.hand` then
  says `{undo: false, redo: false}`. A suggestion that waits changes
  nothing in the file and leaves the line as it is; his edit lands under
  it and the proposed deck is drawn again on the new file.
- **A save he makes meanwhile is never overwritten**: the file is replaced
  only while it is still what was read (`replaceKeeping`), as every write
  is.
- **A rename carries the line** (`handMoved`, with `fileMoved`).

### Shapes, slides and the deck

Built by SLD5 (`deckScript.ts`). Each is an edit of `SlideOpSchema`: his own
through `work.slides.edit`, an agent's through `slides_edit` under the rules
that stand. Each was held, on a real deck through python-pptx, to **the
exact parts it may change** (`deck.test.ts` "his own edits: shapes, slides
and the deck"); every other part keeps its bytes.

| Edit | What it does | Parts it may change |
|---|---|---|
| `geometry` | a shape's box as it lies on the slide before any turn (`box`: left, top, width, height in EMU), its turn in degrees, its flips | the slide |
| `order` | `front`, `back`, `forward`, `backward`, within its own group | the slide |
| `insert` | a text box, a drawn shape by PowerPoint's name for its outline (`preset`), a table, in a `box` | the slide |
| `insert` a picture | the file it brings | the slide, its relationships, the new media part (and a content type, for the deck's first picture of a kind) |
| `insert` a chart | its data | the slide, its relationships, the content types; a chart part with its own workbook |
| `insert` a video | the file it brings | the slide (with its timing node), its relationships, the media and a poster picture |
| `delete` | a shape off its slide, with what only it used (its picture, chart or media) and the effects that played on it | the slide, its relationships; the parts only it used go |
| `fill`, `line` | a colour or none; the outline's weight in points and its dash | the slide |
| `grid` | a table's row or column put in before a place, or taken out; the table grows and shrinks by it | the slide |
| `hide` | a slide left out of the show | the slide |
| `duplicate` | a copy right after its slide, with its own copy of each chart and workbook; pictures and media are shared, as PowerPoint shares them | the new slide and what it holds for itself, the presentation, the content types |
| `section` | one started at a slide, one renamed, one taken away (its slides join the one before; the first one's, the next) | the presentation |
| `layout` | another of the deck's layouts for a slide | the slide's relationship to its layout |
| `theme` | twelve colours and two fonts, into the theme of every slide master | the theme parts |

- **A colour** is a hex, or one of the theme's by its slot with Office's
  tint (`{slot: 'accent1', tint: 0.4}`: `a:schemeClr` with `lumMod` and
  `lumOff`), so it stays the theme's when the theme changes. The same for
  a run's colour in `runs` and `format`.
- **Where a shape is** comes with the outline as `DeckShape.own`: its box
  on the slide before any turn, its own turn and its flips, which is what
  `geometry` takes. A shape in a plain group is placed in the group's own
  numbers and lands where the slide says. A shape in a group that is
  turned or flipped has no `own` and is moved in PowerPoint. A table, a
  chart or a diagram cannot be turned.
- **What is PowerPoint's.** A layout is offered only where each of the
  slide's placeholders has its match in the new one (same index and
  kind): any other change says "change this layout in PowerPoint". A
  table with merged cells keeps its rows and columns for PowerPoint. A
  table's and a chart's fill are set there.
- **Effects go with their shape.** A `delete` takes the shape's effects
  out of the slide's timing (the whole effect, and any group it leaves
  empty, up to the main sequence), so no timing names a shape that is
  gone, which PowerPoint would repair.
- **The outline** also says a shape's own `fill` and `line` where it says
  them itself, and the stepper says a change of this kind in words
  ("Moved or resized", "Added", "Removed", "fill #FF0000", "Hidden").
  An edit of the deck itself (its theme, a section renamed) is one change
  of its own, "The deck" (`DECK_ITSELF`).

### Files an edit brings

`attach.ts`. A picture or a video for an `insert` is a file the host keeps
in the deck's `attach/` folder under a name of its own (a token), and an
edit names it by that token and nothing else, never a path.

- **By hand**: `work.slides.attach` takes the file in pieces of at most
  4 MB; the first piece names it and is answered the token. A picture up
  to 50 MB, a video up to 500 MB. A thread is refused.
- **An agent** names an absolute path on the deck's host in `slides_edit`;
  the tool copies the file in at once and stores the token, so the
  suggestion still has its picture when the file it came from moves on.
- **When the edit runs** the files ride with the deck as one input
  (`pptxplus`: the deck, then each file, `joinStep`), so a job another
  host runs has them; the tool finds them as `files/f0.png` beside the
  edits.
- **They go** once his edit has put them in the file, and an hour after
  they came where no waiting edit names them (`sweepAttached`, after any
  change). His own file's are kept by the file with its versions (a
  waiting suggestion outlives a closed tab); a shared file's in the
  item's folder.

### The layouts' picture

The layout picker shows each layout as a picture. The deck tool makes a deck
of one slide per layout of the file (`layouts_deck`: every slide of the file
gone, each layout's title saying the layout's name and its text places
saying what they are), and it is drawn as any deck is, beside the deck's
queue when the deck opens. The PDF is kept in the deck's `render/` folder,
named by one hash of what the layouts are drawn from (`layoutsDraws`: the
masters, their layouts and themes and what those hold; no slide), so an
edit to a slide never draws it again, and the newest two stay. The view
names it (`DeckView.layoutsPic {rev, size}`), page n being the nth entry of
`DeckView.layouts`; `work.slides.read {which: 'layouts'}` reads it by range.
A file others can open keeps it in its tab's own folder and draws it on this
host alone.

### A new deck by hand

`blankDeck.ts` holds a blank .pptx (16:9, one Title Slide, PowerPoint's own
eleven layouts, the Office theme), and the module registers the deck kind's
maker with Files (`registerFileMaker`, form `pptx`): Files writes it where
it says, never over a file, and the deck kind then edits it in place.
`src/shared/work/deckThemes.ts` lists the themes a deck can be given
(`DECK_THEMES`: Office, TempCode, Office 2007 to 2010, Greyscale), each a
`theme` edit (`themeEdit`).

### Proven against real PowerPoint

Every edit of SLD4 and SLD5, and the older ones, on real decks, in
Microsoft 365's PowerPoint in the box's Windows VM (2026-11-23;
`.temp-code/plans/landed/SLD45-powerpoint-proof.md`, its decks, scripts and
read-backs in `landed/SLD45-proof/`): 29 decks, 340 checks, none failed.

- Each deck, and the copy PowerPoint saved of it, opened with no repair
  prompt, by automation's `Open` and the way a double-click opens it (the
  only way that showed PowerPoint's own "found a problem… Repair" on a
  deck broken on purpose).
- PowerPoint read back what each edit set: each run's words, font, size,
  bold, italic, underline and colour (a theme colour with its tint as the
  theme's); a shape's `Left`, `Top`, `Width`, `Height`, `Rotation` and
  flips to within 0.6 pt; its order, fill and line; a table's rows,
  columns and cells; a chart's series; a picture and a video; a hidden
  slide; the slides' order; the sections; `CustomLayout.Name`; the theme's
  fonts and colours; the notes.
- An edit taken back and put back (`pptxstep → pptxstep`) gives the base
  and the edited deck again, byte for byte on the box and in what
  PowerPoint reads.
- What makes PowerPoint repair is a dangling reference (a timing node
  naming a shape that is gone): `delete` takes a shape's effects with it
  and opened clean. Run properties out of the schema's order, and an
  unknown element, opened with no word.

### Versions

`history/` holds copies of the deck from before changes (`keepHistory`):

- An agent's direct write always keeps one: its Undo needs it. His own
  edits keep one a minute (`VERSION_EVERY_MS`).
- The newest thirty stay; the first ever, the deck as it was before
  TempCode changed it (`….first.pptx`), stays for good; the one an agent's
  Undo points at is never dropped.
- `work.slides.versions` lists them newest first; `work.slides.restore`
  puts one in the file's place, through the queue and `replaceKeeping`,
  keeping the deck as it is now first, so a restore can itself be taken
  back from the list. A version is named by its file's name and nothing
  else, never a path.
- His own file's versions live by the file and outlive a closed tab; a
  shared file's live in the item's folder and go with it.

### A slide for Files

`preview.ts` registers the deck kind's previewer (`registerFilePreviewer`):
slide `page` of a .pptx on this host as a PNG, with the deck's count of
slides so Files' preview pages through it. Where a tab is open on the
file its kept picture is used and nothing is drawn. Else the slide is drawn
once (by the LibreOffice kept running, else a whole export) into a scratch
folder under `.cache/preview/` that goes when the picture is read. A file
others can open is drawn on this host alone and keeps nothing.

### Tables

`store.ts`, made in `ensure` (no `BEGIN` or `COMMIT`: it runs inside the
host's savepoint). The first two are move modules (`slides-items`,
`slides-ops`). Their `item_id` column holds the deck's key (the name is from
before decks were kept by the file), and `session_id` is the thread for a
deck only an item holds and empty for a file's, whose rows belong to no
thread (`rowSession`):

- `work_slides_items`: `item_id` (the deck), `session_id`, `written` (the
  last direct write, JSON, with the item it was made from), `updated_at`.
  Its `mode` column is from before the mode was the seat's: read once,
  when an old item takes its seat.
- `work_slides_ops`: one pending edit a row: `id`, `item_id` (the deck),
  `session_id`, `seq`, `slide` (what the stepper counts it under), `op`
  (JSON), `by`, `at`. A row that no longer parses is left out.
- `work_slides_seats`: `item_id` (the canvas item), `deck`, `session_id`,
  `mode` (`suggests` or `writes`: what an agent may do from this tab),
  `shared` (this seat's source is one others can open). Every seat on a
  deck is pushed its view when the deck changes (`announce`), each as its
  own item, in its own mode.

`sessionsRemoved` and `itemsRemoved` are "When a seat leaves" above.

### Methods

| Method | Capability | What it does |
|---|---|---|
| `work.slides.open` | read | → `DeckView`: reads and renders the deck and the proposed deck |
| `work.slides.read` | read | → `{ data, size, rev }`: bytes of the `file` or `proposed` render by range, at most 4 MB a call |
| `work.slides.slide` | read | → `{ data, size, rev }`: bytes of one slide's own one-page PDF (`{itemId, which, slide, offset, length}`, the slide by its id in the `file` or the `proposed` deck), at most 4 MB a call; `rev` is the picture's, so it changes only when that slide's picture does |
| `work.slides.show` | read | → `ShowDeck`: the file's slides in the file's own order (`id`, `number`, `page`, `title`, `notes`, `hidden`), its render and its `rev`, for a show. A waiting suggestion is never in it: a show presents the deck as it is on disk. The render is read with `work.slides.read {which: 'file'}` |
| `work.slides.review` | operate | accept or reject changes by id, or `all` → `DeckView`; an optional `rev` (the proposed render's, as the view advertised it) binds the press to that preview: when the changes moved on since, nothing is accepted or rejected, every client is told the deck as it is, and the call fails with "The suggestions changed since this preview". The phone always sends it and reads the render's bytes only at that rev; the desktop's strip sends none and is not checked |
| `work.slides.mode` | operate | `suggests` or `writes` → `DeckView` |
| `work.slides.undo` | operate | puts the file back before the agent's direct write → `DeckView` |
| `work.slides.edit` | operate | his own edits (`{itemId, ops}`), written into the file at once, whole or not at all → `DeckView`; refused for a thread |
| `work.slides.step` | operate | `{itemId, dir: 'undo' \| 'redo'}`: takes his last edit back or puts back the one he took back → `DeckView`; refused for a thread |
| `work.slides.versions` | read | → `DeckVersion[]`, the kept copies newest first |
| `work.slides.restore` | operate | `{itemId, version}`: puts a kept copy in the file's place → `DeckView`; refused for a thread |
| `work.slides.attach` | operate | one piece of a picture or a video he is adding by hand → `{token}`; refused for a thread |

A thread's own call (`kind: 'model'`) may not review or set the mode. Every
change pushes `work.slides` with the view. There is no method named `list`.

The listener's path fence reads only the paths a request names, and these
methods name an item id. So `handle` fences the item itself, once, before
any method runs: `fenceItem` (pdf/file.ts) asks the listener's own fence
(`ctx.reaches`) and refuses a remote key every one of the twelve methods on a
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

### The outline

`DeckInfo` (`deck.ts`, written by `DECK_PY`) is what the host knows of a deck
without drawing it. Since SLD3 it carries what a hand editor needs:

- **Where each shape is, turned and flipped.** `walk` carries a 2 by 3
  transform through every group (a group's child space, its rotation and
  its flips), so a shape's `quad` is its four corners on the slide in
  points, in the shape's own order, with `rot` and `flip`; `bbox` is the box
  around them. Measured against LibreOffice's picture of each kind
  (`fixtures/kinds.pptx`, `boxes.test.ts`, at 1920 wide): a text box 0.8 px,
  a picture 0.8, a table 1.5, a chart 1.9, a video 0.9, an arrow 2.4, a
  triangle 1.6, a turned ellipse 0.2. A turned shape was up to 89 px out
  before. A connector is 5.5 px out: its line is routed by the app that
  draws it.
- **What kind a shape is** (`DeckShapeKind`): `text`, `table`, `chart`,
  `picture`, `media`, `connector`, `frame` (a diagram or an embedded
  object) or `other`; `shape` names its preset geometry, `media` its video
  or audio, `group` the group it is in.
- **Its words as they are set.** `paragraphs`: each paragraph's level,
  alignment and bullet and each run's words, font, size, weight, slant,
  underline and colour, resolved through the placeholder, layout, master
  and theme where the run names none (`style_chain`, `theme_of`); `frame`
  holds the text box's insets, anchor, wrap and autofit.
- **Each slide's** `draws` (above), `transition` (its kind, speed and
  whether it advances on a click or after a time) and layout; the deck's
  `layoutInfo` (each layout's name and placeholders) and `theme` (its
  colours and fonts).

A slide's timing tree (builds) is read by SLD6, with the show's builds.

### Converters

`deck.ts` registers these, all `needs: 'python-pptx'`, so a host without it
forwards them (the `pptxstep` pairs are "Edits by hand" above; a `pptxplus`
input is the deck with the files its edits bring):

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
  render, and `slides_image` returns a PNG. "A deck kept by its file, drawn
  slide by slide": two seats on one file share the waiting edits, each in
  its own mode, and are both told; a closed tab and a removed thread keep
  his own file's edits and versions and drop its pictures; an item that
  never sat changes nothing; a deck any seat calls shared is shared for
  all; a shared deck's Undo stays with the tab that wrote; one edited slide
  is the only one drawn; `work.slides.slide` by range. Behind the gate, an
  edit through the module draws one slide with the real LibreOffice kept
  running, which ends when Work is turned off.
- `slides.test.ts` "his own edits to a deck": an edit written at once and
  told to every seat, in one run of the tool; a thread refused; an edit
  that does not go in whole; Undo, Redo and what an edit after an undo
  drops; the 100 steps; what ends the line; an edit under a waiting
  suggestion; a save meanwhile; versions kept, listed, restored and
  pruned; a rename; a shared file; a write that does not wait for a
  render. "A slide as a picture for Files": drawn once and nothing kept,
  a tab's picture used, a shared file, what is not a deck.
- `deck.test.ts` "his own edits" (behind the gate, real python-pptx):
  `runs` and `format` on a PowerPoint-saved deck (one part changes, the
  look kept and set, the schema's order, a range that cuts runs, a
  table), and an edit taken back and put back part for part.
- `deck.test.ts` "his own edits: shapes, slides and the deck" (behind the
  gate): each edit of SLD5 by the parts it may change, what it refuses,
  and LibreOffice opening a deck that holds one of each.
- `slides.test.ts` "the files an edit brings": a picture by hand in
  pieces, under a token, as one input, gone once it is in the file; what
  is refused; an agent's by its path; the sweep.
- `blankDeck.test.ts`: the blank deck, the maker for Files, the themes.
- `view.test.ts`: a look-only change said in words; a shape added,
  removed, moved, recoloured and reordered; a change of the deck itself.
- `pictures.test.ts`: split and stitch (the same bytes each time), the
  three ways a version's PDF is made, the same picture twice drawn once,
  a new engine drawing every slide again, a slide count that does not
  match, a kept page that will not read, each failure's fallback, an
  abort, and the pages kept.
- `resident.test.ts`: the lifecycle against a fake process (one job at a
  time, the 10 s kill, a crash, a failed start, idle and memory stops, a
  cancelled job, a start that waits for the old one, the pipe's folder and
  link); behind the gate, one slide equal to its page of a whole export on
  12, 50 and 200 slides.
- `deck.test.ts` "the outline of the feature deck" and the box test (behind
  the gate): every kind's corners against LibreOffice's picture
  (`fixtures/kinds.pptx`, `kinds-pixels.json`), runs and their resolved
  fonts, transitions, layouts, the theme, and `draws`: an edit moves its
  own slide's alone, notes move none, the theme or the deck's settings
  move them all.
- The renderer: `geometry.test.ts` (hit testing through turned and grouped
  shapes, the selection's handles, reading order, the typing box's place
  through a turn and both flips, the ground's colour), `boxes.test.ts` (the
  measured corners within their bounds), the picking cases of
  `SlidesCanvas.dom.test.tsx`, `edit/model.test.ts` (the outline read in,
  a look on a range splitting runs, a caret's word and its waiting look,
  Return, a paste, what the row shows, the `runs` edit, nothing changed,
  `rebase`), `edit/dom.test.ts` (drawn and read back, words the browser
  puts in no run, two paragraphs joined, its own last break, places and
  selections) and `HandEditor.dom.test.tsx` (the box's whole life in the
  real pane: open by a second press, Return and F2, Escape, a look on a
  range, the commit's edit, nothing sent, the old picture kept until the
  new one paints, a refused edit, a conflict and Reload, Return, a line
  break, a paste and the box's own undo, Shift-Tab to the row and Escape
  back, the commit on close, a slide with a suggestion; the row present,
  absent and resting, the picked shape's look and its `format` edit, the
  box's selection, the keys; History and its loading and empty states;
  what saved means).

## A mail's attachment

A .pptx from a mail (`{at: 'mail'}`) opens through the PDF pillar's `sourcePath`, which answers the copy the host fetched into the item's own folder (work-canvas.md "Fetched sources").

## The canvas

All in `src/renderer/src/work/slides/`. The approved design is
`.temp-code/prototypes/work-workspaces-2/slides.html`, "Filmstrip and
stage".

| File | What it does |
|---|---|
| `canvas.ts` | The kind's def |
| `SlidesCanvas.tsx` | The chunk: `Body` (the format row, the strip and the stage), `Bar` (History, Present where the row is not drawn, the line while PowerPoint shows the deck) and `TabEnd` (the TempCode and PowerPoint switch) |
| `geometry.ts` | Hit testing, the selection's outline and handles, reading order, which kinds can be picked, where a shape's words are laid (`textFrameOf`) and the ground under them (`groundOf`) (pure) |
| `deck.ts` | `DeckHost` (the methods and the push), the per-item store the three parts share (the view, the slide on the stage, which app shows it), and `useRender`, which opens one of the deck's renders in pdf.js and keeps the one shown until the next has opened |
| `Present.tsx` | Present: the split button at the end of the deck's bar, the ways to present as menu rows (`usePresentMenu`, which the format row's way out shares), and the keys that start a show while the keyboard is in the deck |
| `edit/model.ts` | His words in a shape as runs (pure): the outline read in, a look laid on a range, typing, Return, a paste, what the row shows, the `runs` and `format` edits |
| `edit/dom.ts` | The typing box's words in the page: drawn from the model, read back run by run, places and selections both ways |
| `edit/session.ts` | `HandSession`: the shape picked, the typing box's life, the box's own undo, and his edits on their way to the host (one per item and host, shared by the body, the row and the bar) |
| `edit/TypingBox.tsx`, `edit/DeckRow.tsx`, `edit/History.tsx` | The box over a shape, the deck's format row (its glyphs are in `work/icons.tsx`), History in the bar |
| `show/` | The show, a chunk of its own loaded when the pointer first reaches Present: `state.ts` (the state and its keys), `timer.ts`, `Show.tsx` (a show running), `places.ts` (the documents it is drawn in), `Audience.tsx` (the slideshow), `Presenter.tsx` (the presenter's view), `pictures.tsx` (a slide painted at a window's size) |
| `testkit.ts`, `*.dom.test.tsx`, `SlidesCanvas.preview.tsx` | A host that keeps one view and answers his edits, the tests, the preview |

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
- **Picking a shape** (`geometry.ts`). A press on the stage picks the top
  shape under the pointer: `hit` tests the point against each shape's
  `quad` from the front back, so a turned shape is picked where it is
  drawn, and a shape with no area takes no press. The selection is drawn over the picture along
  the quad with eight 8px handles and a turn handle 22px above the top edge
  (`Selection`, an SVG that takes no pointer); the handles do nothing until
  SLD5. Each pickable shape is also a button, named for a screen reader by
  what it is on its slide and its words ("Title: Who comes"; the host's
  `DeckShape.label`, never PowerPoint's name for it), in a group named
  "Shapes on this slide". Tab walks the slide from the back to the front,
  the bare arrows move through it in reading order (`readingOrder`: rows
  top to bottom, then left to right), focus picks, Escape lets go, and a
  press by pointer takes the keyboard to the shape it picked. A press on the bare slide lets go
  too. A picked shape with words still feeds Ask.
- **Which kinds can be picked** (`PICKABLE`): text, a plain shape, a
  picture, a table, a chart and a video or audio clip. A connector and a
  frame cannot: a connector's drawn line is not where its box says, and a
  frame has nothing a hand can change here.
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

### Typing on a slide

His own hand on the deck (SLD4; the look is docs/DESIGN.md "The slide
editor"). It is offered where the view carries `hand`: a .pptx on this
host that he can write. The host writes each of his edits into the file at
once (`work.slides.edit`), whole or not at all.

- **The box.** A second press on a picked text shape (a shape the outline
  lists with `paragraphs`), Return or F2 on it, opens the typing box over
  it: the outline's runs as the model (`modelOf`: each run with the
  `[paragraph, run]` it came from and the look it is drawn in), drawn into a
  contenteditable one span a run (`edit/dom.ts`). He types into it as into
  any text; the browser's own words are read back after each keystroke
  (`readModel`), each piece into the run whose span holds it. A look, a
  Return, a line break, a paste and his undo go through the model and the
  box is drawn again (`act`), so the browser never makes its own `<b>` or
  history: `beforeinput` takes its bold, its paragraph and its undo.
- **A look on a range** splits the runs at its ends and sets the look on
  those between (`applyLook`); a caret in a word takes the word, as
  PowerPoint does, and a caret elsewhere keeps the look for the next words
  typed (`pending`, a run of their own).
- **The commit** is one `runs` edit (`runsOp`): every paragraph with the
  paragraph it came from (a paragraph made by Return keeps the one it was
  split from, so its level and list), every run with the run it came from
  and only what he set on it; words in a paragraph that had none carry the
  run the paragraph's cut continued, else nothing (the host gives them the
  paragraph's first look). Nothing is sent when the op equals the shape's
  own (`unchanged`). A press anywhere but the box, the row and the row's
  layers commits, as does ⌘↩, Tab out of it, the tab closing (the body's
  unmount) and a show started from it.
- **Until the picture lands** the box stays (`landing`), drawn and taking
  no pointer, and goes once the stage paints the slide from a render other
  than the one it was opened over (`painted`), or at once where there is no
  picture to wait for, or when the paint fails. `useRender` keeps the old
  render open (and every picture painted from it) until the new one has
  opened, and pdf.js replaces a picture only once the new one is whole, so
  neither the stage nor the strip blanks between two revisions. The box is
  filled with the colour most samples just inside the shape's edges share
  (`groundOf`, read from the stage's canvas); on a picture or a gradient
  ground that is one flat colour while he types, which hides the old words
  and flattens the ground under the box until the new picture lands.
- **A refused edit** puts the box back to typing with his words and says
  why on the pane's state line ("Couldn't save your words", the host's
  sentence, Retry). **A conflict**: the shape's words in the view are no
  longer the ones the box opened on (another program, an agent's direct
  write, an accept from another seat), or the host says the file moved
  while it was written. Nothing is sent; the box keeps his words; the state
  line says "The deck changed while you typed" with Reload, which reads the
  deck again and keeps his words over the shape as it is now, each `from`
  the new words still have kept (`rebase`), so the next commit sends them
  over what is there.
- **A slide an agent's suggestion changes** takes no box and no look from
  the row: its picture and shapes are the proposed deck's, and a hand edit
  built on them would write the suggestion's words as his. The press says
  "Accept or reject the suggestion on this slide first".
- **The floating bar.** Picking a shape feeds Ask (`shell.selection`) with
  a rect under the slide's bottom-left corner (`askAnchor`: 42px under the
  picture's bottom edge), not the shape's own: the frame lays its bar above
  the rect (canvas/SelectionBar.tsx, `side="top"`, 6px off, 28 to 32px
  tall), so it falls under the picture and never takes a press meant for
  the next shape. Measured in a browser on the preview: 8px under the
  slide on a 290px stage beside a thread and on a 544px one. It is taken
  back while the box is open and fed again, with the new words, when the
  box goes.
- **The row** (`edit/DeckRow.tsx`) acts on the box's selection while the
  box is open (sent with its commit), else on the picked text shape whole:
  one `format` edit with what he set, at once, the look shown over the
  shape until the deck comes back with it (`shapeLook`). Undo and Redo are
  the box's own while it is open, else `work.slides.step`, live by
  `view.hand`. A colour goes as the hex it resolves to in the deck's theme
  (the edit holds no theme colour yet); Automatic is the theme's `dk1` on a
  light slide and `lt1` on a dark one. Present is the row's way out and
  leaves the bar. The body's root is marked `data-editor-keys="slides"`
  (`read` without `hand`), so ⌘B and ⌘K are the editor's there; the row's
  keys come from work-kit's table (`formatKeyOf`, kind `slides`).
- **History** (`edit/History.tsx`) lists `work.slides.versions` on each
  opening and puts one back with `work.slides.restore`.
- **What saved means** (`shell.saved`, FILES-SEAM.md "Save state"):
  `saving` while one of his edits is on its way, `saved` with the time of
  the last one after, `conflict` with Reload as above; nothing without
  `hand`. The frame draws it nowhere beside a thread.
- **Fonts.** A run is set in `fontStack(name)` (work-kit/fonts): the font
  itself, then its free twin. The faces are registered by the documents
  build's `ensureFonts` (work/formats/fonts.ts) on master; this branch's
  base had no such file, so until it is called here the box draws with the
  machine's fonts where the twin is not loaded.

What it does not know yet, from the outline: a paragraph's indents and
spacing (the box hangs a list's mark a quarter inch in and sets lines at
1.2), and the look of an empty paragraph's next words (an empty
placeholder's box takes the deck's body font at 18pt until the picture
lands in the layout's own size).

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
