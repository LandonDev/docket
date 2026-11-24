# Work: sheets

The sheet kind of canvas item, built by milestone 27 of the Work plan
(architecture §9.1, §12.2; the sheet research `reports/nJLC5WoplSWf.md`).
It opens an Excel workbook from disk, a LifeOS sheet, or a new one, in
work-kit's grid (`work-kit/src/sheet/README.md`), and gives Work threads
tools to read, write and suggest cells. [work.md](work.md) says how the
`sheets` pillar is mounted; [work-canvas.md](work-canvas.md) how a kind
registers.

## Where a sheet lives

| The item's source | Held by | Saved how |
|---|---|---|
| a file `.xlsx` or `.xlsm` ("a package") | main, `src/main/server/work/sheets/packages.ts` | the package stays the truth: each edit is patched into it (the patch writer) as a revision |
| a LifeOS sheet (`{at: 'lifeos', table: 'sheets'}`) | the Work service, `sheets/host/` | a Univer snapshot and an op log in LifeOS (`sheets`, `sheetOps`, `sheetSnapshots`, `sheetSuggestionCells`; M17) |
| a file `.tcsheet` | the Work service, `sheets/host/` | the same, in one zip on this host's disk |
| a file `.csv` | the Work service, as a `.tcsheet` read from it once (`csvSheetPath`: `<userData>/sheets/csv/<hash>.tcsheet`) | its own op log; Save as CSV writes it back over the .csv, Export as Excel beside it. One others can open saves each edit through to the file ("A `.csv` others can open") |
| a file `.xls`, `.ods` or `.tsv` | main, as a package: the Excel copy made of it (`formatsIn.ts`, "Other formats in"; LibreOffice reads an .xls and an .ods, a .tsv is read here) | each edit is patched into the copy; the file itself changes by his press alone (Save back) |
| a workbook in Excel (`{at: 'microsoft', app: 'excel'}`) | Excel, through the office pillar's helper (`office/grid.ts`, [work-office.md](work-office.md) "Excel behind the grid") | written through Excel, cell contents only; the view says `store: 'package'` |
| a Google spreadsheet (`{at: 'google'}`) | Google, through the google pillar (`google/grid.ts`, [work-google.md](work-google.md) "Sheets") | each write compared, then one `values:batchUpdate`; the view says `store: 'package'`; the switch opens it in Google |

`held.ts` maps an item to its store (`heldOf`) and the key its
suggestions, mode and charts are kept under (`storeKey`: `file:<path>`,
`lifeos:<id>`, `tcsheet:<path>`; for a copy of another format the path is
the copy's). A new sheet (`work.sheets.create`, the
`sheet_create` tool) is a LifeOS sheet when the thread's workspace has a
sector and LifeOS is connected, else a `.tcsheet` under
`<userData>/sheets/made/<id>/`.

## A mail's attachment

A workbook from a mail (`{at: 'mail'}`: .xlsx, .xlsm or .csv) is held as the file the host fetched into the item's own folder (`heldOf`, work-canvas.md "Fetched sources"): a package, or a CSV's sheet of our own. Edits write that copy, never the mail or his folder; Download saves it. An .xls, .ods or .tsv from a mail opens as the Excel copy of the fetched file ("Other formats in"); its Save as Excel lands in the workspace's own folder.

## Packages

- **The sheet worker** (`worker.ts`, forked by `spawnWorker.ts` through
  electron-vite's `?modulePath` as the utility process "TempCode Sheets"):
  `jobs.ts` runs there: inspect a package (`importXlsx`: its sheets, the
  1904 flag, what our grid cannot reach), read an A1 range, save edits,
  compare two copies. IronCalc's native module is loaded only there: the
  installed app's runAsNode fuse is off, so no Node child can run, and a
  Rust panic ends only that process (main answers the call with an error and
  forks a fresh one). A test runs the same jobs in its own process
  (`localJobs`).
- **The patch writer** (`patch/`, from the research lab): replaces only the
  edited `<c>` elements, copies every other part's compressed bytes, and
  patches the cached values IronCalc computes for the edit's dependents.
  Where IronCalc cannot be trusted (it disagrees with a stored value, or
  returns an error it does not implement) it drops `calcChain.xml` and sets
  `fullCalcOnLoad`, so Excel recalculates on open. A part that unpacks past 512 MiB is refused
  in words before it is unpacked whole (`readEntry`, `ENTRY_MAX_BYTES`), so a
  small hostile workbook cannot take main down. A package whose
  `styles.xml` has no `<fonts>` is saved without IronCalc (0.9.1 panics on
  it). A 1904 file gets date-formatted numbers moved back by 1,462 days.
- **The format writer** (`patch/format.ts` and its parts, `patchFormat`):
  formatting as part-local edits. A cell's style is a new or reused record in
  `styles.xml` (font, fill, border, number format, alignment) and the cell's
  `s`, its value and type untouched; a column's width, a row's height he
  set, a merge made or parted are edits to the sheet part alone. A named
  cell style is named to the file by Excel's `builtinId` (`namedOnly`: the
  cell's `xfId`), with the look the grid drew written as the cell's own. A
  family or a size given back takes the workbook's default font's. A row
  told to fit what it holds loses its own height in the file, and Excel
  fits it on open. A style the grid names by its own id is sent by the
  canvas as the style itself (the file's ids are not the grid's).
  `formats.ts` turns the grid's mutations into these edits in the worker:
  each key of a style change is the one field that says the same thing, a
  theme colour its slot and tint, cells with the same change gathered into
  rectangles.
- **How a save is made** (`jobs.ts` `savePackage`; the report's `path`),
  the lightest way that is safe:
  - `format`: formatting alone reads no cell's value: the format writer, no
    workbook model, no engine. In a workbook that calls `CELL` anywhere (it
    reads a number format, an alignment, a column's width), any format edit
    asks Excel to calculate again on load.
  - `independent`: typed values no formula reads are patched in with no
    engine and no word to Excel to recalculate. `patch/depends.ts` shows it
    from the formulas' own text: every reference with its sheet, whole rows
    and columns, a shared formula's followers (its master's references
    grown by the shared range), defined names through the names they use,
    and a structured reference as its whole table. What the text cannot
    show answers a reason and the save takes the engine: a formula edit;
    INDIRECT, OFFSET, CELL, INFO, GETPIVOTDATA, RTD, PY and the CUBE
    functions anywhere in the workbook; SUMIF, AVERAGEIF and LOOKUP (they
    read past the range they are given); a call to anything that is not one
    of Excel's own functions (`patch/functions.ts`; a LAMBDA name is read
    through to the cells it names); a range built with `:` from anything
    but two plain references; a span of sheets; a what-if table; an edit
    anywhere in an array's range; a cleared cell on a sheet with a blocked
    spill; a name with a relative reference, or one the proof cannot find;
    a workbook with macros, a macro sheet or a dialog sheet.
  - `engine`: everything else, as before: IronCalc recalculates the
    dependents and the audit compares it with what the file stores.
    `plain` is the same on a host with no IronCalc.
- **Revisions**: each saved edit is a row of `work_sheets_ops` (the
  mutations, who, when, a label) and a copy of the package under
  `<userData>/sheets/files/<hash of the path>/<rev>.xlsx`; the copy as first
  opened is kept for good and the newest 30 after it. A change on disk we did
  not make (told by the file's size, time and inode, so a workbook of the
  same length renamed in with the same time counts; a copy written into the
  same inode that keeps the length and the time does not) is a revision of
  its own (`by: 'file'`), seen when something
  asks the host (an edit, a push, a reopen): an open grid shows the older
  workbook until then, and reloads when it asks. Restore puts a kept copy
  back byte for byte as a new revision.
- **A whole list made over another one is refused** (`listSince`): an edit
  carrying a tab's chart or picture list, a rule list or the names, made on a
  revision after which another edit replaced the same list, answers a
  conflict and writes nothing, so a second window's chart list never takes
  out the first's chart. Each row keeps which lists it replaced, by kind and
  tab alone (`work_sheets_ops.lists`), so a shared workbook, whose log keeps
  nothing typed, is judged the same.
- **A workbook others can open keeps nothing here past its tab or thread**
  (the editors plan, "University files"; `library.test.ts`, `private.test.ts`).
  For a file where `sharedOf` is true (a Teams library's, a shared OneDrive
  folder's): its kept copies and the scratch a save is made in lie under
  Files' own preview scratch (`held.ts` `sharedCopies`:
  `<userData>/work-files/preview-scratch/sheets/files/`), which both backups
  leave out and Files clears at each start; its edits are logged with their
  revision and label and without what was typed (`UNKEPT`: another grid of
  the file reads it again, an edit made before it still lands, and an
  agent's write there has no Undo on its line); and when its last holder
  goes, a tab closed for good or a thread that read it by path deleted
  (`work_sheets_shared`, `hold`, `release`), the copies go. What stays is
  a row with the path, a revision number and a stamp, so a suggestion still
  knows which revision it was made for; History offers the newest revision
  and those whose copy is still here. A save is made in the OS temp folder
  (removed as it ends), never in the scratch Files clears while tabs reopen;
  a release waits for a save in flight. Copies made among the app's own
  files before this rule move to the scratch the next time the workbook is
  touched, and the log written before it gives up what was typed. What
  still rides the database for such a workbook: an agent's suggestions and
  proposed formats while they wait (kept on this host by the owner's
  ruling; a decided one leaves with his press), the mode, and our own
  charts' ranges and titles. Whether waiting suggestions in the backed-up
  database are acceptable for university files is the owner's call.
  At each start every shared workbook this host knows is swept the same way
  (`sweep`), opened again or not. A shared workbook's save folder is made
  for this process and its owner alone.
  **A `.csv` others can open** is read into a cache in the same scratch
  (`sharedCsvDir`), and since that cache does not last no edit is left in
  it alone: every change to it (`apply`, `cells`, `review`, `restore`,
  whoever asks; not a suggestion, which changes no cell) runs through
  `formatsInCsv.ts` `throughCsv`, which reads the file the cache agrees
  with, makes the change and then writes the file through Files' door
  (`saveFile`: its lock, one whole replace, and only while the file is still
  the bytes read before the change, so a co-author's save during the
  service's wait refuses it, never patched over). The file is patched, not written again (`patchCsv`): a
  field nobody changed keeps its own bytes (`1.50`, a quoted name), each
  row its own line break and count of fields, and the byte-order mark, the
  blank lines at the end and the last line's break stay as they were, so
  one edit is one field in a co-author's diff. A change that leaves the
  cells as they were (a format) writes nothing. The cache is
  named for the file as it stood when read, so a co-author's newer file is
  read into a new one; a file that changed because this host saved an edit
  keeps its cache and its revisions (`sharedCsvCache`), so the grid goes on
  from where it was. An edit made against a file that changed meanwhile is
  refused before it is made, or answered as a conflict by the door, and
  the file keeps the other writer's bytes ("…changed in its folder, so this
  edit was not saved. Open it again to edit the newer file."). A file a
  save would damage opens to read, with the reason (`sharedCsvReadOnly`):
  bytes that are not UTF-8, a folder he can only read, more than 32 MB.
  A typed formula reaches the file as the value it gives. One exception
  keeps his work as it was: a shared `.csv` he had
  already edited here before this rule keeps its sheet among the app's
  files, editable as before (`csvEdited`; a sheet that cannot be read just
  now counts as edited, so only a read that says revision 0 lets one go),
  saved back through Files' door (a remote key needs `approve` for it,
  `exportSheet`) only over the file it last agreed with (the contents kept
  beside the sheet at each save back, `.base`, or else its first snapshot:
  `legacyCsvAgrees`), and that sheet follows the file when it
  is renamed or moved. An open tab is not told when a co-author changes the
  file: its next edit meets the newer file's sheet at an earlier revision
  (a conflict), so the grid reads the newer file, and the edit is not sent
  again: its cells named the older sheet (canvas, "A conflict that reads
  the file again"). **What he writes out of a
  sheet others can open** (a sheet as .csv, a .csv as .xlsx) is a copy he
  takes: it lands in his own workspace's folder (`ownFolderOf`), never
  beside the file, where a library would sync it to the team, and never
  among what the app keeps; with no folder of his own there it is refused
  in words.
- **What a package saves**: cell contents (the patch writer, fills
  included: the canvas sends each filled cell's formula text), formatting
  (the format writer: everything the format row sets, a column's width, a
  row's height he set, a merge) and structural edits (below). One edit may
  carry all three; it is one revision, labelled "Formatting" when no cell's
  contents changed. A cell that only takes a style keeps what it held, so a
  suggestion waiting on it still stands. A cell held as text (Univer's
  STRING or FORCE_STRING type), a rich cell's words and every string the app
  writes (`mutationsOf` types it text: an agent's, a suggestion taken, a cell
  put back) are written as they stand (`EditSpec.literal`): `007` stays
  `007`, `=x` is no formula; a value he typed with no type is read as Excel
  reads typing. A formula with a function that can spill (`SPILLING`,
  `spillingIn` in shared/work/sheets.ts) is refused at his press and at the
  host in the same words ("A formula with SEQUENCE is not saved in an Excel
  file yet. Make it in Excel"): the writer cannot make Excel's dynamic-array
  metadata, and a plain formula Excel would read another way. A workbook
  desktop Excel or Google holds takes a spill as its own.
- **Tables are saved a list at a time too** (`patch/tables.ts`,
  `patchTables`, `readTables`; proven in real Excel on 26 workbooks, no
  repair, 2,411 checks: `.temp-code/plans/landed/E-sheets/SHT4-excel-tables-proof.md`).
  A table's change in the grid (`sheet.mutation.{add-table,delete-table,
  set-sheet-table,set-table-filter,move-table}`) goes to the host as the
  sheet's whole table list (`RULES_SET` of kind `tables`), where the host
  lists the `table` control; `savePackage` hands it to the table writer
  (`jobs.ts` `tablesEditsOf`): a new part with its relationship and content
  type, stable ids, a header it had to name, a total row and a calculated
  column filled, a built-in style name with its four switches, a rename
  followed through every formula that names the table, a removal that
  leaves the cells. It refuses, before anything is written, a table over a
  merge, the sheet's filter, a pivot or another table, a protected sheet, a
  name Excel would not take, and a removal or a shrink that would leave a
  reference dangling. **A formula that names a table is written in the
  words Excel keeps in a file**, never as a person types it: `[@Qty]` as
  `Sales[[#This Row],[Qty]]`, a bare table name as `Sales[]`, a total as
  `SUBTOTAL(109,Sales[Units])` (Excel removes a table whose calculated
  column says `[@Qty]`, and reads the typed words in a cell as `#REF!` and
  `#NAME?`): the table writer does it for its own formulas
  (`tables-model.ts` `fileReferences`), the cell writer for a formula he
  types (`patch.ts` through `tables.ts` `cellReferences`), and the model
  writer for a held sheet's export (`writer.ts` `tableWords`). On a sheet
  the service holds, the engine replays the table mutations (the table
  plugin is mounted with the rules), a cold load has the table, a restore
  brings it back whole with the kit's `putTable` (`host/rules.ts`: its
  columns' own ids, its filters, its calculated columns, so a total row's
  functions keep their columns), and the export writes each
  sheet's tables as real table parts, saying "tables on <sheet>" in `left`
  where the file cannot hold them (`writer.ts` `tablesOf`, each table through
  the kit's `tableModel`: the grid keeps Excel's switches and each column's
  total under `meta.excel`, the writer reads them on the table). **In the
  window** (work-kit v81): `handle.tables` makes and changes a table, the
  row's `table` control is listed for a LifeOS sheet, a `.tcsheet` and an
  opened Excel file (`SHEET_ROW`), the canvas answers the list a save needs
  from `handle.tables.models` (`grid.ts`), and `tablesMatrix.test.ts` holds
  the whole way with the kit's own handle on a headless grid: made, styled,
  a total row, renamed, converted back, each read back from the file. A
  table's header has no filter button (the writer cannot keep a table's
  filter criteria). Not proven: any of it in a running window. A guest sends no
  table mutation. Until the grid's own table chrome lands (work-kit, the
  slice sheets-tables-ui) no store lists the `table` control, so a table is
  made here only by a file that already has one.
- **Rules are saved a list at a time** (`patch/rules.ts`, `patchRules`): a
  sheet's conditional formats with their `dxf` records, its validations, the
  workbook's names, a sheet's filter with the rows it hides. The file is
  written a list at a time, so the canvas sends, in place of a rule's own
  mutation, the whole list its change left (`RULES_SET`,
  `src/shared/work/sheets.ts`: `forPackage` reads it from the grid, once a
  kind and sheet a turn), and `savePackage` hands it to the rules writer: no
  workbook model, no engine. A rule the model does not change keeps its XML
  and its `dxf` byte for byte; Excel 2010's extension rules (`x14`) and
  their links stay as they are; a solid data bar is written as the pair
  Excel writes. A name or a filter can change what a formula answers, so
  either asks Excel to calculate again on load. A rule's revision is
  labelled by its list ("Conditional formatting", "Validation", "Names",
  "Filter"); its op keeps the list, which `since` answers as a reload for
  every other grid (a list is no mutation a grid applies), while an edit
  made before it still lands. What the writer refuses (a protected sheet,
  a filter over a table that has its own, a name Excel would not take, an
  icon set of custom icons) is said over the grid after the press, as any
  refusal only the host can know.
- **Rich text is saved as runs** (`patch/text.ts`, `patchText`): a cell whose text has more than one
  style becomes a string cell whose shared string item holds one run a change of style. A run is
  written as a whole font, in Excel's order, with what it does not set taken from the cell's own
  font, so Excel and LibreOffice draw it alike; an equal item already in the table is taken; a
  workbook with no shared strings part gains one. A cell sent back as it was read is not touched.
  A formula cell is refused, and a table's header may be restyled but not reworded. Where a cell's
  words change and a formula may read them, Excel is asked to calculate again on load.
  `readText` reads the rich cells back from the parts alone. The grid sends a rich cell as its
  `set-range-values` with `p` (the cell editor's commit has `v: null`, so mutations.ts tests `p`
  before `v` and never writes it empty). `editsOf` gives its flat words to the patch writer, so
  what reads them recalculates, and `formatsOf` its runs (work-kit's `runsOf`) as `SHEET_TEXT`
  beside the formats; `savePackage` drops the words where the file already holds them
  (`changedWords`), then calls `patchText` after `patchXlsx`. A style set over a rich cell
  changes its runs in the grid with no `p` in the mutation, so the canvas adds the cell's `p` as
  the grid now holds it (`forPackage`'s `doc`). A cell typed back to one font comes with `p: null`
  and a plain `v`, which `patchXlsx` writes as plain text. A workbook Excel or Google holds keeps
  no runs: rich text there is stopped as he makes it ("Style part of a cell's text in Excel").
  Proven end to end by `textNotesMatrix.test.ts`.
- **A note's words are saved in place** (`patch/notes.ts`, `patchNotes`): the text of a note that is
  already in the file is rewritten in the note's own font, its author's line kept as Excel wrote
  it; its box, its author and every other comment keep their bytes. The grid's `update-note`
  becomes `SHEET_NOTE` beside the formats (`notesOf`, mutations.ts), and `savePackage` calls
  `patchNotes` after the text. The view lists `notes: ['edit']` for an Excel file
  (`SHEET_NOTES`), so the pop-over offers no New note and no Delete note there; a removal that
  reaches the canvas is stopped ("Delete this note in Excel"), and a new note that reaches the
  host is refused by the writer ("Add a new note in Excel"), as is the note Excel leaves in a
  thread's place. A note moved beside a row or a column needs nothing of its own: LibreOffice
  moves it with the cells. `readNotes` gives each note with its author, the author's line out of
  the text. What either writer refuses (`TextRefused`, `NotesRefused`) is said over the grid
  after the press, as any writer's refusal is.
- **Charts and pictures are saved a tab's list at a time** (`patch/charts.ts`
  `patchCharts`, `patch/pictures.ts` `patchPictures`; proven in real Excel on
  41 workbooks, no repair, 2,696 checks:
  `.temp-code/plans/landed/E-sheets/sheets-charts-writer-report.md`). The
  canvas reads a file's charts and pictures with the workbook
  (`importXlsx(...).objects`, grid.ts `decode`) and keeps each picture's
  bytes from the bytes it loaded, by part (`readMedia`), so no wire carries
  them; it hands both to work-kit's grid (`SheetCanvas objects`, `media`),
  which draws, selects, makes and edits them (Insert → Chart and Picture, the
  chart's row: `chart`, `picture`, `objects` in `SHEET_ROW.package`). Each
  change the grid tells (`onObjects`) goes to the host as the tab's whole
  list (`RULES_SET` of kind `charts` or `pictures`, `subUnitId` the grid's
  sheet id; `sync.ts` `object`, `objects.ts` `objectListOf`), a newer list
  of the same tab replacing one that waits. A change that only follows rows
  and columns (`cause: 'cells'`) sends nothing: LibreOffice and the graft
  move the file's drawings with the cells. A picture made here rides with
  its bytes as base64 (`data`) until a save gives it a part; the op log
  keeps the list without them (`withoutBytes`). `savePackage` hands the lists
  to the writers after the cells and the tables, so a new chart's cache holds
  what the cells now hold (`jobs.ts` `chartsEditsOf`, `picturesEditsOf`, the
  last list of a tab in a batch). The save answers the ids the file now gives
  (`SaveAnswer.report.ids`, through `PackageStore.edit` and
  `work.sheets.edit` as `ids`, `ObjectIds`: a new chart becomes its part's
  name, pictures after one added or removed are numbered again, a new
  picture's part). The grid keeps its own ids, the ones its Undo and Redo
  name each object by; the canvas keeps the file's names beside them
  (objects.ts `FileIds`), sends every list under the file's names and lays a
  list from elsewhere under the grid's, so the next save names the same
  parts and Undo of an inserted chart after Saved takes it out of the file
  (the grid renamed it until 2026-11-24, and that Undo left the chart). A revision is labelled "Chart" or "Picture". The writers' refusals
  (`ObjectsRefused`: a protected sheet, a range in another workbook, a kind
  this editor cannot make, a chart in a group) are said once as a toast,
  and the canvas reads the file again, so the object is as it was. A
  chart sheet's chart is listed but not drawn (it has no tab in the grid),
  and still puts "charts" in `reach`. Keys: ⌃⌥5 takes the first chart or
  picture in hand, as in Excel; while one is, Tab and ⇧Tab walk them
  (SheetBody.tsx `useObjectKeys`). `objectsMatrix.test.ts` holds the whole
  way on a headless grid and a real file.
  **Our old charts** (`work_sheets_charts`, plain bars kept beside a file
  before it could hold a chart) are no longer drawn as bars on an opened
  Excel file: the view hands each as the bar chart it becomes
  (`legacyCharts`, `patch/charts-legacy.ts` `legacyChartSpec`), the canvas
  lays it on the grid unsent, and the next change to that tab's charts
  writes it into the file with the rest; a tab's list saved ends that tab's
  rows (index.ts `endOldCharts`), whether each was written or he took it
  out. Nothing is written into the file before his own change. A `.tcsheet`
  and a LifeOS sheet take their old rows the same way ("Sheets the service
  holds"). A workbook desktop Excel or Google holds keeps no objects: its
  old rows come as `legacyCharts` too (its snapshot names each sheet by its
  tab, as a row names its sheet) and are drawn on the kit's layer to see
  only, since its view lists no `chart`, `picture` or `objects` control and
  More offers no Chart there; a row whose tab the workbook no longer has is
  left out (SheetBody.tsx `useLegacyCharts`), and the rows stay in the
  table. The old bars, `work.sheets.chart` and `SheetChart` are gone.
- **What it cannot keep yet is stopped as he makes it** (`forPackage` and
  `stop`, sync.ts): a cell given only a type, a move where the host does
  not save moves, a note removed, and any change with no saved form (a
  hidden row, a frozen pane). What he does in
  one turn is taken together (the grid's commands counted, their mutations
  gathered): when a part of it cannot be kept, none of it is sent, the grid
  takes it back with its own undo, and a toast says why in a few words
  ("That change is not saved in an Excel file yet. Make it in Excel"). One command is one undo; a turn that ran several, or
  mutations that came with no command of their own, is undone and the book
  then read again from the file, so the grid is the file whatever the undo
  left. No line stands over the grid about it. The host refuses the same
  kinds in the same words (`UNSAVED`, mutations.ts), for a caller that is
  not the canvas. A workbook Excel or Google holds keeps cell contents
  only: a pasted cell's style is left out, and a width or a merge is
  stopped in that store's words.
- **What only the host can know is still said after the press**: a cell
  locked on a protected sheet, a merge over a table or part of an array, a
  row inserted where no host of his can run LibreOffice. The save is
  refused whole, the grid says "Couldn't save" with the host's sentence and
  Reload, and Reload makes the grid the file again. Nothing is lost
  silently, but he made the change before he was told.
- **A save goes through Files' door** (`PackageStore.save` and `.restore`,
  `put`): the new package is made among this host's own files
  (`sheets/files/work/`), never beside the workbook, and its bytes are
  handed to `saveFile` (files/save.ts), the one door that replaces a file
  where it lies. The door writes them under a hidden name of its own,
  syncs, and renames over the file, and only while the file is still the
  version the patch read: a file that changed since (Excel saved it, a
  co-author's save synced down) is a change from outside, which stands as
  its own revision while the edit answers a conflict; one moved or deleted
  meanwhile answers a conflict too, and nothing is made under its old
  name. One save of a file at a time, under the key Files itself locks the
  file by (`fileKey`, held.ts: a library's file by its place, as
  `doorPlace` and `libraryKey` make it; `library.test.ts` holds the two
  equal), so a save here and a change made in Files take turns. The kept
  copy of the new revision is written first, from the same bytes, and
  taken back if the door refuses, and the file's stamp is the door's own
  answer: once the file holds a save the store holds its revision. A
  folder that cannot be written and a full disk are said in plain words,
  and a fault in TempCode's own folder is said as that.
  No file of the sheets pillar's is ever written in the workbook's folder.
  The door is given the file's real path and that path's folder as its
  root, so its fence refuses nothing here: what a caller may reach is
  judged before, by the item's own fence (`fence`, held.ts, which checks
  the path the item names, not where a link points) and by `approves`; a
  workbook that is a link is saved through the link, as before. A `.tcsheet` is not saved this way: the Work service writes it,
  by a `.tcsave` temporary beside the file (`writeTcsheet`,
  host/backends.ts), since the service reaches none of main's Files.
- **An .xlsx anywhere is the sheet kind's** (`SHEET_MAKER`,
  `registerFileMaker('sheet', { forms: ['xlsx'] })` in the module's
  `start`): Files seats an .xlsx from a Teams or OneDrive library of this
  host in the sheet editor as the file it is, with no Excel behind it, and
  New in a library makes a blank one (one empty sheet in Calibri 11, by
  the model writer; not yet opened in real Excel). `library.test.ts` holds
  the seat, the blank and the saves on a dummy workbook in a dummy
  library. What that changes: a library's .xlsx no longer stands desktop
  Excel behind the canvas, so Excel's own co-authoring is not what he
  edits in: a co-author's save arrives as a change from outside and the
  grid reads the file again. The switch is offered where the file holds
  what our grid cannot reach or cannot be opened here (a password): it
  opens desktop Excel on a Mac or a PC, the full editor on a host that
  runs one, and nothing on a host with neither. An .xlsm, a file in the
  Windows VM, on another host or from his mail open as they did; New in a
  VM library now offers a sheet too (Files reads the maker), and a file
  made there opens on the box only as a copy. Who may: his own window edits it; a
  thread's own idea waits as a suggestion on this host (above); a remote
  key changes it only with `approve` and reads it only where the
  listener's fence lets it name the file (`private.test.ts`). Files' own
  `read` and `write` verbs give a library's bytes to his own window alone
  (`bytesFence`, files/handle.ts): the sheet kind's wire is wider than
  that for a key with `approve`, a difference named in SEAMS.md for the
  two builds to settle.
- **A renamed file** takes what is kept by its path with it (`moved.ts`,
  Files' `registerFileMoved`, inside the rename's own savepoint): the
  revision row and op log, the kept copies' folder, the suggestions, mode,
  written line and charts keyed `file:<path>` or `tcsheet:<path>`, a
  `.tcsheet`'s waiting suggestions in the service's folder, and the sheet a
  `.csv` opens as.
- **The saved line** (`shell.saved`, `savedLine` in model.ts) is said for
  every sheet: "saving" while his edits wait or are on their way, "saved"
  with the time of his last edit, a refusal in the host's words with its
  press (Reload on an opened Excel file, whose grid no longer matches it;
  Retry elsewhere, where the edits wait), and why a file cannot be changed
  here. Edits are sent as he makes them and flushed when the body goes. An
  opened Excel file's refused batch keeps its line after a later edit lands
  (the refused one is still not in the file) until Reload.

## Other formats in

`formatsIn.ts`, `formatsInBack.ts`, `src/shared/work/sheetFormats.ts`; tests `formatsIn.test.ts`
(a stand-in converter, Files' dummy team library), `formatsIn.wired.test.ts`
(through `work.sheets.*` and the tools), `formatsIn.seat.test.ts` (where
Files seats them) and `formatsIn.live.test.ts` (the real LibreOffice on the
corpus's `formats-in/ledger.xls`, `.ods` and `.tsv`).

An `.xls`, an `.ods` or a `.tsv` opens in the sheet editor as an Excel copy
made of it (`heldOf` → `importedHeld`: `{at: 'package', path: <the copy>,
from: {path, format}}`). LibreOffice reads an .xls and an .ods (the
runner's own `xls → xlsx` and `ods → xlsx`). A .tsv is plain text and
needs no converter: it is read here as a .csv is (tabs split it, a quoted
field is one field, numbers are numbers, `007` stays text) into one sheet
named for the file, written by the model writer; one that is not UTF-8, or
over 32 MB, is refused in words. (Preview's `tsv → xlsx` pair is not used
for this: it keeps a quoted field's quotes as text.) The copy is an
opened package like any other, so the grid, the format row, History, the
tools and Preview work on it with no second way; `SheetView.imported`
(`{format, name, stale?, noBack?}`) says it is one, and the view goes by
the file's own name.

- **Where the copy lies.** His own file's: `<userData>/sheets/imports/<hash
  of the path>/copy.xlsx`, kept, so closing the tab loses nothing. A file
  others can open (`sharedOf`): `<userData>/work-files/preview-scratch/
  sheets/imports/<item id>/copy.xlsx`, a folder of its tab's own, converted
  on this host alone (`shared: true` on the job), out of both backups, gone
  with the tab (`itemsRemoved` → `dropSharedImports`) and at each start;
  the package store treats that copy as a shared workbook (`sheetsOf`'s
  `is`), so its revision copies and log follow the same rule. Such a file
  named by its path alone, with no tab to hold a copy, is refused in words
  ("…open it in the canvas first"). Nothing is ever written beside the
  file. Beside the copy, `source.json` keeps the file's version as Files'
  door words it and how the copy stood when the two last agreed.
- **When it is made again** (`ensureImported`, asked on every request for
  the item; two stats when nothing changed): the first time; and when the
  file changed (Excel saved it, a sync replaced it) while the copy holds
  nothing of his, which the grids see as a change from outside. A file
  only touched, renamed or synced again with the same bytes is the same
  file. A copy he has edited is never made again under him: it is kept and
  the view says `stale`.
- **Save back** (`work.sheets.imported {act: 'back'}`): the copy is
  written as the format it was and put over the file through Files' door
  (`saveFile`), only while the file is still the version the copy was made
  from. An .xls and an .ods are made in the OS temp folder by the pairs
  `xlsx → xls+calc` and `xlsx → ods+calc` (`formatsInBack.ts`,
  `SHEET_BACK_CONVERTERS` in the module's `convert`): LibreOffice's own
  Python loads the copy with macros off, works every formula out again and
  then stores it. The plain `--convert-to` pairs are not used here, since
  LibreOffice keeps the results it finds in an .xlsx, and an edit saved
  without the calc engine leaves those as they were before it. A .tsv is
  patched with the first sheet's values (`patchCsv` with a tab): a field
  nobody changed keeps its bytes, and a formula goes back as its value. A
  formula with no value worked out (typed where no engine ran, or the copy
  asks Excel to calculate again on load) is refused (`packageCsv`: "The
  formula in B2 has no value worked out yet, so the sheet cannot be written
  as text. Save as Excel to keep your edits."), and the file keeps its bytes;
  Export → CSV of a package refuses the same. The copy's saves are held
  while it converts and is stamped (`PackageStore.holding`), so the stamp
  names the copy that went back, and the window sends his last edit first
  (sync.ts `written`).
  A file that changed since is not written; else it is refused ("…changed since this copy was
  made. Save as Excel to keep your edits."), and a file that is gone is not
  made again. The answer's `drops` says what the format left behind of
  this workbook, counted by Preview's `sheetDrops`. A file that holds
  macros (an .xls's VBA storage, an .ods's `Basic/` or `Scripts/`) is never
  written back, since the copy keeps none: the view says `noBack`.
- **Save as Excel** (`act: 'xlsx'`): the copy written out as `<name>.xlsx`
  through `makeFile`, never over anything ("Ledger 2.xlsx"): beside his own
  file; in the workspace's own folder for a file others can open or one
  that lies among the app's files (a mail's), refused in words where there
  is none. In a Files tab the tab becomes the .xlsx and the copy goes; in a
  thread the .xlsx opens beside it.
- **Read again** (`act: 'again'`): drops the copy's edits and converts the
  file as it is now; offered only when `stale`.
- **Who may press.** His own press alone: a thread's call and another
  host's are refused, and a remote key changes a file others can open only
  with `approve`. A thread reads and writes the copy through the sheet
  tools under the write rule, as any package; it cannot move the file.
- **Renamed or moved in Files** (`moved.ts` → `importMoved`): his own
  file's copy follows it with its edits and what the package store keeps
  by the copy's path. A shared file's copy is found by its tab.
- **Where Files seats them**: `kindOfEntry` gives all three to the sheet
  kind, and `openAs` seats a library's as the file it is (no Office app
  behind it); `teamsAppOf` gives a `.tsv` no app, as a `.csv` has none.
- **The window** (`ImportLine.tsx`, `imported.ts`): one quiet line over the
  grid says where his edits go and what saving back as the format drops,
  with Save back; where the copy cannot go back it says why and the press
  is Save as Excel. More names both ways out, and Discard edits and read
  again when the file moved on. A press answers in one toast.

## Structural edits

Rows and columns inserted or deleted, a sort, sheets added, removed or
renamed, and cells, rows and columns moved, saved into an opened package
(architecture §9.1; the sheet report §8 item 7):

- `planOf` (structural.ts) turns an edit's mutations into steps in the
  order they came: structural ops for LibreOffice, cell writes for the patch
  writer. Sheet names follow renames, additions and removals; a cell that
  carries only a style rides a structural edit (LibreOffice formats an
  inserted row like its neighbour, as the grid does).
- LibreOffice runs as a conversion job (`xlsx → xlsx+ops`, `xlsm →
  xlsm+ops`, `STRUCTURAL_CONVERTERS`), with its own Python and the UNO
  script in structuralScript.ts, where LibreOffice is installed; a host
  without it forwards the job. It loads the file (read-only only when it
  will not load otherwise: a full 1,048,576-row sheet, where a rename is then
  refused), applies the ops, recalculates and
  stores the same kind. A sort is applied as the grid made it: each target
  row takes its source row's cells, formats and formula text. A protected
  sheet, and an insert that would push cells off the sheet, are refused in
  words, as Excel refuses them.
- `graft` (graft.ts) then puts back what LibreOffice drops, measured on the
  corpus: the macro project byte for byte; workbook parts it does not know
  (dynamic-array and in-cell picture metadata, rich values) with the cells'
  `cm` and `vm` marks, each moved with its cell (`mapCell`); chartsheets
  (LibreOffice makes each a worksheet holding the chart) with the chart's
  ranges moved.
- The revision's op carries no mutations: LibreOffice numbers sheets again,
  so every grid loads the file again. Suggestions waiting over the file move
  with their cells, by sheet name, or are orphaned.
- What LibreOffice writes differently from Excel (formula text spelled
  another way, style records merged, a table's calculated column, a split
  pane's size, an external link's path) the harness reports as changed; it
  loses nothing the harness counts. After a structural save, cell edits go
  back to the patch writer on LibreOffice's package.

### Moved cells, rows and columns

A block dragged or cut and pasted (`sheet.mutation.move-range`, on its sheet
or onto another), and whole rows or columns dragged (`move-rows`,
`move-columns`), are saved through the same path as an insert:

- **The ops.** `moveRange` (the block, where its top left lands, and the
  sheet it lands on) is LibreOffice's `XCellRangeMovement.moveRange`.
  `moveRows` and `moveCols` (the lines, and the line they go before, counted
  as the sheet stood: Univer's own count) are what Excel's Shift-drag does,
  made in three steps, as LibreOffice has no such call: room inserted before
  the target, the lines moved into it with `moveRange`, the emptied lines
  removed; the moved lines then get back the heights or widths and the
  hidden state they had. Every formula, name and chart range that pointed at
  what moved follows it. A range a move takes only part of stays where it
  was: LibreOffice's rule and the grid's own, so the file holds what he sees.
  Excel moves a range's end with its corner cell, so the same drag made in
  Excel can leave another range.
- **One move, one step.** `planOf` makes each move a structural step of its
  own, so it is judged on the file as it stands. Only the move is sent: the
  grid's move also rewrites formulas, merges, rules and notes in the same
  turn, and the canvas sends the turn's move mutations alone
  (`SheetSync.attach`); LibreOffice makes those changes itself, and every
  grid then loads the file again.
- **Checked twice.** The host refuses a move before LibreOffice runs when it
  cannot show the file stays whole (`moveRefusal`, moves.ts, on the file's
  own XML; `refuseMove` in structural.ts is the one call, made by the store
  before it asks for the job, so the words do not wait behind another
  conversion, and again by the converter, whose ops may come from another
  host), and the script checks every `moveRange` it makes: the block's
  filled cells must be where it landed and none left behind. On the box,
  several LibreOffices opening one file made `moveRange` do nothing without a
  word (the second opened it read only behind the first's lock file), so the
  converter gives LibreOffice its own copy, and a move it did not make is
  refused, never saved.
- **What follows a move, read back from LibreOffice's file** (dummy files in
  `harness/corpus/moves`, made by `make_moves.py`; `structuralMoves.test.ts`):

  | Case | What LibreOffice did | Here |
  |---|---|---|
  | A formula at a moved cell, at the whole block, from another sheet | follows the block | saved |
  | A formula at a range partly moved | stays, and reads what is left, as the grid shows; Excel stretches a range after a moved corner cell | saved |
  | A formula inside the block pointing out, and pointing in | out: unchanged; in: follows | saved |
  | A name over the block, and over a cell of it | follows | saved |
  | A name over part of the block | stays | saved |
  | A chart reading the block (on the sheet; a chartsheet's chart through graft) | its ranges follow. Where a series' name was typed text, LibreOffice's move wrote a reference to a moved cell for it (an insert writes the text as a formula, `"Block"`); `graft` puts the typed name back after any structural save (`typedSeriesNames`) | saved |
  | A block onto cells something reads (a formula, a name, a chart) | LibreOffice keeps the reference and points it at what landed; Excel makes it #REF! | refused: "a formula or chart reads where it lands" |
  | A block onto cells nothing reads | what stood there is gone, as in Excel (Univer asks first) | saved |
  | The block's formats, conditional formats, validations, link and note | move with it; a rule over part of it splits in two. For a block several columns wide LibreOffice left a conditional format on some of the cells the block left (`C2:C10` where Excel leaves `C4:C10`), and `graft` takes it off them (`offVacated`) | saved |
  | A block onto cells that have rules of their own | those cells take the block's rules and lose their own | saved |
  | A conditional format moved whole (it shares no cell with another) | LibreOffice makes it again: after every other, or as one more range of a format that holds the very same rule | saved |
  | A conditional format that shares cells with another, moved whole | made again at another place in the order, Excel would try the two in another order on the cells they share; moved in part, a format keeps its place | refused: "its conditional formats overlap" |
  | A merge inside the block, or in moved rows | moves | saved |
  | A merge across the block's edge, or a column through one | LibreOffice moved the whole merge, or split it | refused: "it crosses a merged cell" |
  | A whole table, rows holding it, rows moved past it | the table moves or shifts whole; `Sales[Amount]` still reads it | saved |
  | Part of a table, a block onto one, rows taken out of one | the table kept holes, took the cell, or shrank | refused: "it crosses a table" |
  | A whole array formula, a whole spill, a shared formula group whole or in part, an array's input | moves; the spill keeps its `cm` mark | saved |
  | Part of an array formula, a spill's first cell alone, a row through either | LibreOffice did not move it | refused: "part of an array formula", "part of a spilled formula" |
  | Rows among the filter's own rows; the frozen pane | the filter and the pane stay | saved |
  | The filter's header row, a column of the filter, a block that meets it | the filter shrank, or lost its header | refused: "it crosses the sheet's filter" |
  | A block beside a pivot table and its source | as any block | saved |
  | A pivot table's cells or its source | not tried: LibreOffice lays a pivot out again | refused: "a pivot table's cells or source" |
  | A protected sheet | | refused: "the sheet is protected" |
  | A macro workbook | the project kept byte for byte | saved |

- **Where a refusal is said.** At the press, only a host that does not say
  it saves moves (`SheetView.moves`, set by held.ts for an opened Excel
  file): the canvas stops the move and says "Move this in Excel" (in Google's
  words for a Google sheet). Every other refusal needs the file, so the host
  says it, in the same words with the reason ("Move this in Excel: it crosses
  a table"; `MOVE_WHY`, src/shared/work/sheets.ts, and the host's own
  `HOST_WHY` in moves.ts), and the canvas takes the move back itself: the
  words are one toast, the book is read again from the file, and no "Couldn't
  save" line stands over the grid (DESIGN.md "What is absent").
- **A move goes alone.** The canvas sends a move as a batch of its own, after
  what he typed before it (`SheetSync.batch`), and the grid takes no edit
  from the drop until the host has answered (`reloading`): an edit made on a
  move the file then refuses would be lost with it, or written into another
  cell. The wait is LibreOffice's run, some seconds.
- **A close sends what waits first.** The canvas gathers his edits for
  `EDIT_WAIT` before it sends them; a tab's close awaits `SheetSync.flushed`
  (registered with canvas/flush.ts like the deck's and the text's), so the
  host has his last edit before the item goes. Before 2026-11-23 a cell
  typed and the tab closed by × at once was sent after the item was gone,
  refused, and never reached the file. A cell still open in the editor is
  ended first, keeping what he typed (`GridLink.commit`: Univer's
  `endEditingAsync(true)`). A body unmounted by another tab picked still
  sends only what was committed. The registered flush is
  `SheetSync.written`: an edit that did not save rejects it, so a switch
  that would replace the item (`flushedItem`, the live Office switch) stops.
  A close is refused (`CloseRefused`, Files says the tab did not close) only
  where the tab holds what would go with it: a cell the grid kept open (it
  refused the value), or edits that wait for Retry; an edit refused for good
  goes with the tab as before.
- **A save's receipt is not the grid's revision.** The grid stands at the
  revision a save answers only when nothing landed between; else (another
  window's op landed first) it catches up, passing its own, before what it
  sends next, so it shows theirs and a whole list it sends is made over
  theirs.
- **A reload holds the grid.** While catch-up reads the file again (a rule's
  list landed, a shared workbook's edit, a change from outside), the grid is
  `reloading` and takes no edit: a cell still open in the editor is ended
  first, against the book it was typed on (a locked workbook would refuse
  it), what he typed before it is sent first, and nothing is typed into a
  book about to be replaced. A cell the grid keeps open (it refused the
  value) is said once as the book goes.
- **A conflict that reads the file again** (the file changed outside
  TempCode, a restore, rows moved elsewhere, a list replaced) sends the
  refused batch no more, nor what waited behind it: its cells named the
  older sheet. It is said once as a toast, cell by cell with what he put
  there ("The file changed before this was saved: B4 1200, C5 Hotel and 2
  more. Make it again.", `notSavedWords`), and the grid shows the file.
- **What reads the file waits for his last edit.** Preview's draws and
  exports, Save back and Save as Excel await `SheetSync.written`, which
  ends the open cell, sends what waits and rejects in words ("An edit is not
  saved: …") when an edit of his did not save: one refused, one a conflict
  dropped on its way (`lost`), a cell the grid kept open.
- **Not proven.** None of this was opened in real Excel: the proof files
  (each case's file before and after, with the cells and values Excel
  should show, `manifest.json`) wait for a live proof; the first thing to
  compare there is a range a move takes only part of. Not tried: a move onto
  a sheet that holds another table, a move in a workbook with external
  links, rows through outline groups, a block wider than 20,000 landing
  cells (refused), how a moved block's hidden rows behave under a filter,
  and the order of more than two conditional formats that share cells and
  all move whole.

## Pages

A sheet's page set-up (paper, orientation, margins, scale or Fit to, print
areas, manual breaks, repeated titles, gridlines, headings, centring, page
order, header and footer, first page number) is work-kit's
`SheetPageSetup`, kept by its pages plugin in the snapshot resource
`TEMPCODE_SHEET_PAGES` and changed by one mutation,
`tempcode.sheet.mutation.set-page-setup` (`PAGE_SETUP`). The row's Page
menu holds Page set-up (the kit's dialog), the Page breaks view, the print
area and a break at the cell in hand; the four controls (`page`,
`pageBreaks`, `printArea`, `breakHere`) are listed for a LifeOS sheet, a
`.tcsheet` and an opened Excel file (`SHEET_ROW`), and the canvas gives the
grid `pages` only where `page` is listed (`SheetBody.tsx`).

- **A sheet the service holds** keeps the set-up in its snapshot: the
  host's engine mounts the plugin (`ENGINE.pages`, `host/host.ts`), so the
  mutation replays and a cold load has it. Its Excel export writes each
  sheet's set-up (`writer.ts` `pagesOf`), saying "page set-up on <sheet>"
  in `left` where the writer refuses one.
- **An opened Excel file** takes it as the sheet's whole set-up through the
  rules set (`RULES_SET` of kind `pages`, `forPackage`; the canvas answers
  it from `handle.pages.get`), saved by `patch/pages.ts` (`patchPages`,
  `readPages`) in `savePackage`, one revision labelled "Page set-up": the
  worksheet's part and, for a print area or titles, the workbook's change,
  and every other entry keeps its bytes; only the fields that changed are
  written; a set-up Excel's schema refuses is refused in words before a
  byte is written.
- Rows and columns put in, taken out or moved carry the breaks, the print
  area and the titles as one more mutation in the same command. Where the
  host keeps no page set-up (a workbook Excel or Google holds) that
  mutation is left out, never a reason to stop the insert.
- A guest's page is given no `pages`: it keeps and draws none.

Held by `pagesMatrix.test.ts` with the kit's own `handle.pages` on a
headless grid: orientation, margins, a manual break and a print area saved
into a real .xlsx and read back whole, a cold import equal to the grid's
set-up, no cell moved; the service's engine replaying the mutation, a cold
load, and the export.

Not proven: any of it in a running window; real Excel reading a file
`patchPages` wrote (openpyxl, LibreOffice and the schema accept it). The
page lines in the view are the kit's estimate (a 7px digit); Preview's PDF
is the exact page. The kit's view refuses a manual break under any Fit to;
real Excel ignores one only along a side fitted to a page count
(`harness/corpus/print/excel-truth.json`), so a break across the free side
of a fitted sheet cannot be set here yet.

## Writing a sheet out

`work.sheets.export {itemId, format, sheet?}` (writer.ts, the model
writer): a LifeOS sheet, a `.tcsheet` or a sheet read from a .csv as a new
.xlsx (values, formulas with their last values, fonts, fills, borders,
number formats, alignment and wrap, merges, column widths and row heights,
frozen panes, hidden sheets, the workbook's theme and default font, a theme
colour as its slot and tint; `fullCalcOnLoad` set), or one sheet as .csv
(RFC 4180, a formula's last value). The workbook's rules (each sheet's
conditional formats and validations, the names, a filter: the snapshot's
`resources`) are then laid into that .xlsx by the rules writer, the one an
opened Excel file is saved with, so both hold a rule the same way
(`writeXlsxWhole`, `rulesOf`). Text in more than one style is laid the
same way, as runs, by the text writer (`textOf`, `patchText`); notes are
not written yet, and `left` says "notes" for each sheet that has one. A list the file cannot hold is left out
rather than failing the export, and `left` names it. A sheet read from a .csv saves back over
it and exports beside it; a package gives a .csv of one sheet beside itself
(it is its own .xlsx); anything else lands in the item's own folder. The
canvas no longer offers these two in More (Preview, below, is the way out);
a sheet read from a .csv keeps Save as CSV there, back over its file.

## Preview and export

The sheet's side of the one Preview surface (SHT7; the frame and its
contract are [work-editors.md](work-editors.md) "Preview: the contract").
Server: `sheets/preview.ts` and `sheets/previewFacts.ts`; canvas:
`src/renderer/src/work/sheets/preview.ts`.

- **The wire.** `work.sheets.preview {itemId, format, pages?, sheet?, by?}`
  answers a picture: `paged` (a render's `rev`, `size`, `pages`, `shown`
  when the PDF holds only the first pages), `table` (one sheet's rows, at
  most 500, and the sheets to pick from) or `html`; each with its `drops`.
  `work.sheets.previewRead {itemId, rev, offset, length}` reads one kept
  render by range, 4 MiB a call; a `rev` no longer kept, or another
  sheet's, answers "That preview is gone: draw it again." and the frame
  draws once more. `work.sheets.previewExport {itemId, format, sheet?}`
  makes the file now and answers its `rev`, `size` and `name`, read the
  same way. `by: 'office'` is his press on "Check in Excel" (below). A
  sheet he can only read previews and exports like any other: none of
  these change the file.
- **What is drawn.** The workbook is the package as its revision stands
  (`packages.fileAt` at the store's newest rev), or for a sheet the
  service holds, the .xlsx the model writer makes of its snapshot
  (`writeXlsxWhole`). LibreOffice draws it to PDF (`calc_pdf_Export` with a
  `PageRange`) through `ctx.convert`, on the host that holds the file.

  | Format | Its picture | Its export |
  |---|---|---|
  | Excel | the workbook's PDF | an opened package: a copy of itself as it stands ("Save a copy", .xlsx or .xlsm); else the model writer's .xlsx |
  | PDF, Print | the same PDF | the whole PDF; Print hands it to `printPdf` |
  | OpenDocument | the PDF of the exported .ods itself | that .ods |
  | Excel 97-2003 | the PDF of the exported .xls itself | that .xls |
  | CSV, TSV | one sheet's shown values as a table (LibreOffice's text export, the sheet by its place, cells as shown, no formulas) | that file, of the sheet last drawn |
  | Web page | LibreOffice's HTML, in the frame's sealed page (over 4 MB it is not drawn; export still works) | that .html |

- **Fit to.** Where a sheet prints fitted (`pageSetUpPr fitToPage`) its
  manual breaks are taken out of a scratch copy before LibreOffice draws
  it (`withoutBreaksUnderFit`), along each side fitted to a page count and
  no other: row breaks where `fitToHeight` is a count, column breaks where
  `fitToWidth` is. Excel ignores a manual break there and LibreOffice does
  not. A side left automatic ("1 page wide" by as many tall as it takes)
  keeps its breaks, which Excel prints. This is Excel's own behaviour as
  measured (`harness/corpus/print/excel-truth.json`, below), not the
  plan's "no manual breaks under Fit to", which held only for a counted
  side. The file keeps its breaks. An OpenDocument or Excel 97-2003
  picture is LibreOffice's of that exported file as it is.
- **Long sheets.** The first draw asks LibreOffice for pages 1 to 51 and
  keeps 50: a 51st page says the whole goes on. The whole is not counted
  until it is drawn, so the answer says `uncounted` and the canvas hands
  the frame a `shown` with no `of`: the bar reads "Page 3 of 50+" and the
  way to the rest is "Draw all" with no number. "Prints on more than 50
  pages" (`moreThan`) and a draw cut to fit a link are `notes`, said over
  the first sheet and not among the losses. (For a window a release
  behind, `shown.of` is still what it holds and one more, and the note is
  still among `drops`.) No estimate is shown as a number. "Draw all" asks
  for every page with no range.
- **Kept by content hash.** A render's `rev` is the hash of what was drawn
  (the format, the input's bytes, the range), so the same workbook asked
  again is answered without LibreOffice. His own files' renders and
  exported files are kept under `<userData>/work-files/previews/sheets/`,
  beside Files' own pictures, which both backups leave out (Files' prune
  reads only the files at its folder's top, so it leaves this one alone):
  at most 64 and 1 GiB, the least used out first (`PreviewStore`). Each
  call works in a scratch folder of its own (`mkdtempSync`, 0700) removed
  when it ends; a crash's are swept at the module's start
  (`sweepPreviewScratch`). Each kept render names the sheet it was made
  from, and a read for another item's sheet is refused.
- **A file others can open** (`sharedOf`: a library's file, another host's,
  the cloud folder): its renders, exported files and scratch live in a
  folder its item's own under Files' preview scratch
  (`sharedPreviews(dataDir, itemId)`, held.ts:
  `<userData>/work-files/preview-scratch/sheets/previews/<item>/`, at most
  16 and 256 MiB), which both backups leave out. The module's
  `itemsRemoved` removes it with the item, and Files clears the whole
  scratch at each start. Each folder says whose it is (a `.thread` file,
  written at every draw), so a deleted thread's folders are found by
  `dropSharedPreviewsOf(dataDir, sessionIds)`, which the module's
  `sessionsRemoved` is to call (the frame tells a pillar a deleted thread,
  not its items). A draw that
  finds a file gone under it (`ENOENT`) is made once more from the start,
  and a read of a render that went answers "draw it again", which the
  frame does. Every job is `shared`, so the runner never carries it to
  another host; nothing is written beside the file. Export hands the
  file's bytes to the window's save dialog, as the document does: the copy
  goes where he saves it. `preview.test.ts` holds it with a spy on every
  write (`writeFileSync`, `renameSync`, `copyFileSync`, `mkdirSync`,
  `mkdtempSync`): each lies under the item's folder; every job is marked
  shared; `itemsRemoved` takes the folder and its renders with it.
- **A draw carried to another host.** Where this host has no LibreOffice
  the runner forwards the job, and a PDF past 64 MiB cannot come back: the
  draw is asked again with half the pages until it fits, and the column
  says "Drawn on another computer: only the first N pages could be sent".
  A shared file is never forwarded, so it is never cut.
- **"In this format"** (`sheetDrops`), counted from the workbook in hand:
  a package from its parts (`factsOfPackage`: formulas, styles and the
  last used cell from each sheet's XML, rules through `readRules`, tables,
  charts, pictures and notes from the zip), a held sheet from its snapshot
  (`factsOfWorkbook`). The lines follow what decision 8 measured: CSV and
  TSV, the other sheets ("Flights and Hotel stay behind", or "5 other
  sheets"), and the chosen sheet's own formulas ("149 formulas become
  their values"), formatting, rules, charts and pictures (a sheet's charts
  and pictures by its drawing's links: what the other sheets hold goes
  with them, said once); Excel 97-2003, colour scales, data bars and icon
  sets, tables ("2 tables become plain ranges"), formulas that call a
  function newer than Excel 2007 ("39 formulas use functions Excel 97-2003
  does not have": `_xlfn.` in the file, a shared formula's cells counted
  with it; a held sheet's formulas as the writer would write them), rows
  past 65,536 and columns past IV by sheet; OpenDocument, each chartsheet
  ("ChartSheet becomes a sheet holding its chart"); PDF and Print, only a
  chart of a newer kind (`chartEx`), which LibreOffice does not draw; a web
  page, formulas, conditional formats, validations, filters, charts and
  pictures. A held sheet's Excel adds the notes and what the model writer
  left out ("The names stay behind"), and every old chart row
  (`work_sheets_charts`) not yet kept with the sheet.
- **Pairs this pillar adds** (`SHEET_PREVIEW_CONVERTERS`, on the module's
  `convert`): `xlsm` to `pdf`, `ods`, `xls`, `csv` and `html`; `xlsx` to
  `html`; `xlsx` and `xlsm` to `tsv` (LibreOffice's text export with a tab,
  `options.sheet` its place); `tsv` to `xlsx` (read as the CSV it becomes).
- **Files' page picture** (`registerFilePreviewer('sheet', …)` in the
  module's start): the first page of an .xlsx's or .xlsm's print, drawn as
  Preview draws it (pages 1 to 1, the Fit-to rule above), made a PNG by
  the pdf pillar's `pdf → png` as Files' own previewers do; every job
  `here`. Only for a page-size picture: at or under Files' largest
  thumbnail (416 pixels) it answers null, so a folder of workbooks starts
  no LibreOffice and its tiles come from Files' cheaper sources. His own
  file's render is kept in the store above; a shared file's is made in a
  folder of its own under the preview scratch, removed before the answer,
  and Files holds the picture in memory alone. Other pages, and a
  `.tcsheet` or a .csv, answer null, so Files' own sources draw them.
- **The canvas.** `SheetBody.tsx` draws the frame over the grid, which
  stays mounted, unseen and `inert` under it; More's Preview…, File →
  Export… and ⇧⌘E open it on the format he last used, File → Print… and
  ⌘P on Print (`useWorkCommands`, offered once the grid is up). The source
  is made once per item, store and file name. It takes its read limit as
  a constant of its own (`READ_MAX`, held equal to the contract's by
  test), since the canvas takes no value from the contract.
- **The print fixtures, behind LibreOffice** (`preview.live.test.ts`,
  skipped where LibreOffice is absent; on the box, LibreOffice 26.8.3,
  2026-11-23): each of the ten cases' preview equals LibreOffice's own PDF
  of the same render input, page for page (count, size and what each page
  draws; LibreOffice tags a PDF made with no options and not one made with
  a page range, so the tags' marks are left out of the comparison). The
  previews hold 1, 2, 2, 1, 6, 5, 7, 2, 4 and 3 pages (chart-print,
  fit-width, landscape, links_dest, manual-breaks, pivot, protect_print,
  scale-70, titles, wide-columns). The same run drew `formulas.xlsx` as
  OpenDocument (11 pages) and Excel 97-2003 (12 pages) from the exported
  files, its second sheet as CSV and TSV (the sheet asked for, not the
  first), the web page, a macro workbook's PDF, and a TSV read in.
- **Excel's truth** (`harness/corpus/print/excel-truth.json`; made
  2026-11-23 in the box's Windows VM, Excel 16.0.20625 of Microsoft 365
  Apps, each fixture opened read-only in a hidden Excel and the workbook
  exported with `ExportAsFixedFormat`; a record, not a gate). Excel opened
  nine of the ten: it refuses `pivot.xlsx` at a normal load and at a
  repair load, so the tenth has no truth. What it showed:
  - **Counts.** The preview holds as many pages as Excel on all nine (1,
    2, 2, 1, 6, 7, 2, 4, 3).
  - **Manual breaks** fall on the same rows and columns in both, on every
    fixture and probe.
  - **Automatic breaks** differ: Excel fits one or two more rows on a page
    than LibreOffice (landscape 36 rows to 35, scale-70 69 to 67, titles
    48 to 47, protect_print 33 to 31), so the row a page ends on is not
    Excel's on those four. Page for page, four of the nine agree in full
    (chart-print, fit-width, manual-breaks, wide-columns).
  - **Paper.** Excel printed both A4 sheets (links_dest, protect_print's
    Report) on Letter; the preview draws them on A4, as the file says.
  - **Fit to.** Six probes (fit-width.xlsx fitted 1 by 1, 1 by 2, 1 by
    any, 2 by any, any by 1 and any by 2, each with a manual break after
    row 19 and after a column) gave the rule above. Excel's `HPageBreaks`
    and `VPageBreaks` list a manual break even where its print ignores it.
    The live test draws the same six and holds their page counts to
    Excel's (1, 2, 2, 6, 2, 4).
  The proof's scripts, logs and Excel's PDFs are kept with the landing
  notes (`.temp-code/plans/landed/E-sheets/sheets-preview-excel-truth/`).
- **Unproven.** Excel's truth is one Excel, on Windows, of ten fixtures
  and six probes: nothing here says a picture matches Excel beyond them,
  and nothing was compared by eye or by pixel. OpenDocument, Excel 97-2003,
  CSV, TSV and the web page were not opened in any other program. The
  capped forward is tested with a stand-in runner, not over a real link.
  Preview's column has no Page section for a sheet yet (the source offers
  no `setup`): a sheet's page set-up is changed from the row's Page menu
  ("Pages"), and Preview draws the file as it then stands.

### Check in Excel

Excel's own PDF of the workbook, beside LibreOffice's (SHT9;
`sheets/checkExcel.ts`, the canvas's `office()` in `preview.ts`). It is
the office pillar's render, `xlsx → pdf+excel`
([work-office.md](work-office.md) "Office as a renderer"), asked through
the conversion runner, so that pillar's rules are the rules: a carrier
offers the pair only once its own live proof passed (`RENDER_PROVEN`: the
box's Windows VM, no Mac and no PC yet), Excel draws a copy in the job's
own folder, and a sleeping VM is woken only by a job that carries his
press.

- **The wire.** `work.sheets.previewOffice {itemId}` answers
  `{ app: 'excel', state }` with `ready`, `asleep`, `not open` or `none`;
  it wakes nothing and starts nothing, and tells a caller whose press
  would not be his own `none`. `work.sheets.preview` with
  `by: 'office'` answers Excel's pages (`drawnBy: 'excel'`, the whole
  workbook, read by range like any render) or `{ notInReach }` when Excel
  went out of reach since the look. The press asks the state afresh before
  the workbook is read, so an Excel shut since is said and never answered
  from a kept picture.
- **Whose press.** His own, made on this host (`pressOf`): a thread,
  another host of his on his behalf, and a remote key that cannot approve
  are refused with "Check in Excel needs your own press." before anything
  is read.
- **Which workbooks.** Never one others can open (`madeFromShared`): the
  renderer may be another computer than the file's own, as the document's
  Check in Word rules. Never a macro workbook: the pair takes an .xlsx,
  and Excel refuses macros under that name. Never one Excel or Google
  holds. Each answers `none`, and the frame offers no Check in Excel.
- **What goes and what is kept.** The workbook as it stands: an opened
  Excel file's bytes, a sheet of ours as the .xlsx the model writer makes.
  The drops are the Excel format's. Excel's PDF is kept by the workbook's
  content hash beside Preview's renders, so a second press on the same
  workbook asks Excel nothing; the scratch copy goes when the call ends.
- **The frame.** "Check in Excel" stands on the Excel format alone, at the
  end of the line over the first page; "Waking Windows" or "Drawing in
  Excel" while it runs; "As Excel draws it" after. Where Excel is shut or
  not in reach the frame offers nothing, and a press that loses it says
  "Excel is not in reach" once and LibreOffice's picture stays.
- **Proven with stand-ins, not live.** `checkExcel.test.ts` runs the real
  runner and the office pillar's real converters over that pillar's fake
  Office; `previewOffice.test.ts` holds the canvas's source to the Preview
  contract in every state. No real Excel drew a workbook through this
  path in SHT9: the pair's own live proof in the VM is the office
  pillar's (SLD2), and Excel's PDFs of the print fixtures above were made
  there by script, not through `checkInExcel`. Excel draws the whole
  workbook, so a sheet of thousands of pages takes Excel as long as it
  takes and comes back as one PDF.

### Save to Google Sheets

More → Save to Google Sheets puts a copy of the workbook in his Drive as a
Google spreadsheet (SHT9; `sheets/toGoogle.ts`, `toGoogleOffer.ts`, the
canvas's `toGoogle.tsx`). The act is the google pillar's
([work-google.md](work-google.md) "Save to Google"): `work.google.upload`
is his press at his own window, never a thread's and never another host's
on his behalf, behind the item's file fence, and it refuses a file from a
shared library before any byte is read. It is not a held act: the copy
lands in his own Drive, shared with nobody. Threads have no upload tool.

- The sheets pillar registers the bytes (`registerUploadBytes('sheet',
  sheetUploadBytes)`, in the module's `start`): the workbook as Preview's
  Excel format draws it, an opened Excel file as it stands on disk (an
  .xlsm as one, with its own MIME type), a sheet of ours as the .xlsx the
  model writer makes. What that format's line in Preview says it leaves
  out, the Google copy lacks too; what Drive's own conversion changes is
  Google's.
- The row is offered on the host's word (`SheetView.canUpload`,
  `offersGoogle`): a workbook this host holds that is his own. Not one
  Excel or Google holds, not one in a library, a cloud folder or on
  another host, not a Teams snapshot; and not while the file opens to
  read only or has moved.
- The dialog is the google pillar's (`UploadGoogleDialog`): an account of
  his that allows Drive files, Save, then a toast with Open in Google.
- `toGoogle.test.ts` runs the google pillar's own wire over its fake
  Google and this pillar's real provider over real workbooks in dummy
  folders. No Google was reached and nothing was written to a real Drive.

## Sheets the service holds

`sheets/host/host.ts` (`SheetHost`) keeps one headless Univer
(`work-kit/sheet/engine`) per open sheet, at the store's newest op:

- every write goes to the store first, compare-and-set on its revision
  (`sheets:appendOps` answers `stale-rev`), then into the engine;
- after every op that lands, each open suggestion is rebased with
  work-kit's `rebase`: moved with inserted or deleted rows and columns,
  `conflict` when its cell no longer holds what the agent saw, `orphaned`
  when its cell is gone;
- a snapshot (Univer's JSON, gzipped) is cut every 500 ops;
- a `.tcsheet` (`TcsheetBackend`) is bound to the real file it was read
  from: every write goes there, and only while its path still names that
  file, so a folder link along the path that came to point at another folder
  is refused ("… names another file than the one this sheet was opened
  from") rather than writing the held workbook over another one; so is the
  same path holding other bytes than it last read or wrote (its inode, size
  and time: a newer workbook OneDrive put there). The proposals' side file is
  keyed by the workbook's real path, so a link that names another workbook
  after a restart finds none of them, and names the archive they were made
  over (its stamp, written again at each write here): read cold over another
  archive at that path (put there while the host was down) they turn
  `orphaned`, to be dropped, never accepted into it. (A guest
  pass bound to the resolved file is the guests pillar's, guests/links.ts.)
- history lists the ops; compare and restore replay from the nearest
  snapshot in a second engine;
- every engine it makes mounts the grid's data plugins (`headlessSheet(…,
  { rules: true })`: conditional formatting, validation, filter, table,
  sort), so a rule made in the grid applies, stays in the snapshot's
  `resources` and survives a cold load; a restore writes back the cells'
  diff, each cell whose text runs differ whole with its runs (or none over a
  cell that has them, `richWrites`), and, through `host/rules.ts` `ruleMutations`, the conditional
  formats, validations, filters and defined names of the revision (not
  tables). The mutation ids and payloads are in the editors plan's SHT3
  report, held by `host/rules.test.ts` and work-kit's
  `src/sheet/engine/rules.test.ts`;
- the engines mount Univer's note plugin too (`ENGINE = { rules: true,
  notes: true }`), so the grid's `update-note`, `remove-note` and
  `update-note-position` apply, a note and its author stay in the
  snapshot's `SHEET_NOTE_PLUGIN` resource (a thread in
  `TEMPCODE_SHEET_COMMENTS`), and a restore puts each note back by its id
  (`noteMutations`); history labels a note's op "A note" or "Removed a
  note". A rich cell is the cell's own document (`p`) and needs nothing
  more. The view lists `notes: ['edit', 'add', 'remove']` for a `.tcsheet`
  and a LifeOS sheet. Held by `host/notes.test.ts`;
- the host keeps each sheet's charts and pictures beside its engine
  (`host/objects.ts`): Univer holds no resource of ours, so a tab's chart or
  picture list (`RULES_SET` of kind `charts` or `pictures`, the same op an
  opened Excel file takes, `subUnitId` the sheet's id) is laid there and
  never run on Univer; rows, columns and a sheet's name moving under them
  carry them (work-kit's `objectsOpOf`, `moveObjects`, names as they were
  before the mutation); every snapshot the host serves or cuts carries them
  as the kit's `TEMPCODE_SHEET_OBJECTS` (`withObjects`), and a cold load
  reads them back (`readObjectsResource`); a restore lays the revision's
  lists for each tab that differs (`objectMutations`). A picture made on
  the grid comes with its bytes once, as base64 on its entry (`data`, part
  `media:<id>`); the host keeps them by part and lays the ones still drawn
  into the snapshot as `TEMPCODE_SHEET_MEDIA` (`MEDIA_RESOURCE`), so they
  live in the sheet's own store (the `.tcsheet` zip, LifeOS's ops and
  snapshots), reach a guest in the snapshot he loads, and nothing of them
  stays on the host. A picture that is no PNG, JPEG, GIF or BMP, one over
  5 MB, or more than 25 MB a sheet, and a part the grid does not give, are
  refused in words (`listMisfit`). History labels the op "Chart" or
  "Picture". The canvas sends a turn's lists after its other mutations
  (sync.ts `pendingObjects`): rows he put in move the objects on the host,
  and the list his grid then holds is laid over as the truth (an Undo of
  rows taken out lays back what the pure move cannot). It builds each list
  as it is sent (`fresh`), so a retry after a catch-up goes as the grid now
  holds it, and sends a made picture's bytes until the host has them
  (`sentMedia`). Lists from elsewhere are laid on the grid's objects, never
  on its cells (`applyFrom`), and what the grid moves under ops from
  elsewhere is not sent back (`applying`). A guest's route takes no list
  (`GUEST_OPS`); his page draws the objects from the snapshot and lays
  lists that arrive on them (`src/hosted/guest/SheetPage.tsx`). The Excel
  export writes them through `patchCharts` and `patchPictures`, a made
  picture from the snapshot's bytes, and says in `left` what a writer
  refused or whose image is not kept (`writer.ts`). Held by
  `host/objects.test.ts`.

Main reaches it through `ctx.service.internal('/internal/sheet/<op>')` with
the bodies of `host/wire.ts`. The LifeOS worker's tools reach
`/internal/sheet/read` and `/write` (M17's bodies), with the caller's fence
held again against the sheet's sector. A LifeOS sheet is served only by
the host that serves LifeOS's documents (M18's rule).

## Live editing

`wss …/w/sheet/<sheetId>` (`service/routes/sheet.ts`): a LifeOS sheet for
every client on it, not through Yjs. The client says hello with a collab
token naming the sheet (`ctx.service.token({item: {sheet}})`), checked then
and once a second (4401 run out, 4403 a revoked guest link); the service
sends the workbook, orders ops through the sheet host and sends everyone the
ops that land. A view link writes nothing; a guest's ops pass `GUEST_OPS`
(cell values and their styles, number formats, row and column inserts and
deletes, and what the format row sends beside a cell's style: a merge made or
parted, a column's width, a row's height). A guest's merge, size change or
number format is checked for its shape as well: at most 1,000 ranges, each on
the grid, and a size from 0 to 2,000. The host then holds the whole batch to
the sheet as it stands (`host/guest.ts` `guestMisfit`, which only the engine
can do): no cell, format, size or merge past the sheet's own rows and
columns; no merge over a merged cell; at most 1,000 rows or columns inserted
in one send and never past what a sheet holds (1,048,576 by 16,384); at most
10,000 rows or columns sized and 200,000 cells formatted or merged by one
op. Each op is read against the sheet as the ops before it in the batch leave
it, merges as Univer's own insert and delete leave them (`host/guest.test.ts`
holds the walk against the real engine, and the grid's own insert and delete
commands against it). A guest's cells are named by a row and a column that are
indexes (a key such as `-1` or `1.5` would be stored where no grid draws it),
hold at most 32,767 characters, a formula of at most 8,192 (nobody's formula
is longer: the engine overflows on forty thousand), a style cut to the grid's
own shape (short keys, numbers, flags, strings of at most 255 characters), and
a formula in plain names: the prefixes an Excel file gives newer functions
(`_xlfn.`, `_xlpm.`) are dropped, since Univer's engine throws on a lambda
written with them. An inserted row or column carries its size and nothing
else (not hidden). One send of a guest's is at most 2 MiB. The guest's own
page sends none of what this refuses (a paste heavier than that aside, which
it is told); a filled formula is sent with each cell's own text, since the
service keeps no shared formula's id (`plainCells`). It keeps an op made by hand from
writing millions of rows into the owner's sheet. A guest sends no rule, no
name, no filter, no sort and no sheet added or removed.

A calculation that throws does not take a sheet or the service down: the
headless engine catches it (work-kit `headlessSheet`, `failures()`), the
sheet still answers and the next calculation runs; the cells of that
calculation keep what they had. What is not bounded: how many sends a guest
makes over time (each is kept in the store's op log), the styles a workbook
gathers as cells are restyled (nothing prunes one no cell uses), and a guest
may delete every row and write to a hidden sheet (it is sent the whole
workbook). An Edit link's page draws the format row with
exactly the controls those cover (`GUEST_ROW`, `src/shared/work/sheets.ts`;
`rowMatrix.test.ts` runs every press of every control through the route's
guest check and into the host). Every
mutation names its sheet but a defined name's (`WORKBOOK_MUTATIONS`), which
an editor may send and a guest may not. An editor here is the owner's own
page of the full editor: it may also add or remove a sheet and part a merge,
with no cap, as his canvas may. An edit that missed a row or column
insert is moved through it (`moveThrough`, the rebase's code); a rule named
only by its id passes as it is (`MOVES_AS_IS`); a stale structural edit, or
a rule with a range or a formula, is refused and the client reloads.
Our own canvas does not use the socket: it calls the pillar's methods.

## Agents: the tools and the rule

**His press on what waits.** The window names the ids it shows for Accept all
and for a group (`reviewWhich`, renderer sheets/model.ts), never `all` or a
change set the host would pick from what waits now, so a suggestion that came
after he looked is not taken; past 5,000 ids (the wire's limit) it sends them
in batches of that many (`reviewBatches`), never all. One review of a sheet runs at a time (`oneReview`, sheets/index.ts):
each picks what waits only once the last settled, so an Accept waiting on
Google or Excel never writes what a Reject in another window dropped, and two
Accepts never write the same rows. Over an opened Excel file the cells are
checked and written in one turn of the file's saves (`PackageStore.edit`'s
`under`, index.ts `reviewPackage`): the check reads the file the save then
writes over, and a save from Excel or a co-author after that read refuses the
write ("The file changed while accepting: try again."), never written over. A Google Sheet suggestion keeps its own
change set id (the millisecond and four random bytes, so two never share one)
and where its cell stood (`target`, google/grid.ts `targetOf`: the tab's
numeric id, the other cells of its row and its column's header), so a row
inserted above, a column before it or a tab made again under its title leaves
it a conflict, not a write into another cell; an edit elsewhere in its column
changes nothing. A suggestion made before round 2 has no `target` and is
compared by its value alone. Google takes no compare-and-write, so a change
landing between the host's read and its write is not caught.

`sheet_read`, `sheet_write`, `sheet_suggest`, `sheet_format`, `sheet_rule`,
`sheet_table`, `sheet_page`, `sheet_note`, `sheet_chart`, `sheet_create` (tools.ts), cells in A1 (`a1.ts`), at most 10,000 cells a
read and 1,000 a write. A read of an opened Excel file ends with one line
when the file holds what only Excel changes ("This workbook also holds 2
pivot tables: only Excel changes those…", `waitsNote`), so a thread does
not claim a change it could not make. `sheet_read` gives a cell's note's words beside its
value (`note`, read from the import's note resource for a package and from
the engine's resources for a sheet the service holds; a thread's stand-in is
no note). `sheet_write`, `sheet_format` and `sheet_rule` say
why (`because`), and so do `sheet_table` and the tools after it, under one rule (`ruled`):

- `asked` with `quote`, the owner's own words in the thread
  (`ctx.threads.ownerSaid`): written at once;
- `routine`, in a thread a routine started: written at once on his own
  sheet; on a shared one it waits as suggestions (no grant covers a write);
- `own`: on a sheet others can open it waits as suggestions; on his own
  sheet it follows the sheet's mode (`writes` by default: written, with the
  bar's written line and Undo).

A sheet others can open is one test for the tools and the grid's view:
where the file lies (`sharedOf`, files/policy.ts: a Teams or OneDrive
library, a cloud folder, another host, a Microsoft or Google file), what the
scope says of the source (`scope.shared`), or LifeOS's `shared`, which the
service's `open` reads afresh from LifeOS on every call, so a guest link made
since the sheet was loaded counts.

A quote he never typed, or `routine` outside a routine, counts as `own` and
the answer says so. An owner's edit over a pending cell makes it a conflict.
Accepting writes the proposed cells as his own edit.

**A format and a rule** (`asks.ts`). `sheet_format {range, format}` sets
what the row sets on a range (bold, italic, underline, strike, the two
colours, the face and size, alignment, wrap, a border preset, a number
format, a named cell style, clear) and the widths of its columns and
heights of its rows, on at most 20,000 cells. It does not merge (a merge
can empty cells) and does not step decimals (the pattern is given whole).
`sheet_rule {rule}` adds one rule: a `highlight` (every comparison, text,
duplicates, top and bottom, average, a formula), a colour `scale`, a data
`bar`, a `list` (typed items or a range), a `check` (a whole number, a
number, a date, a text's length), a `custom` validation, a `name` (a
workbook's, or one tab's) and the `filter` (a range, or null to take it
off, with `sheet` for the tab). A validation made here refuses a bad value, as Excel's own dialog
sets a new one (`showErrorMessage`). An agent adds rules; changing or
removing one is his, in the side sheet.

**A table** (`sheet_table`, `acts.ts`). `make` one of a range (a name, a
built-in style by its short name, "Medium 2", the header said or guessed,
the total row and the four style switches), `change` one (rename, restyle,
a new range on its sheet, the switches), set a column's `total` (sum,
average, count, min, max, none; a total row is added where there is none),
or `convert` it back to a range. The sheet worker loads the sheet as it
stands (an opened Excel file by its path, a sheet the service holds from
its snapshot at the revision the tool read) into a headless engine and
runs the kit's own table handle on it (`createTables`, the Table menu's),
with its own refusals ("A table is already there", "The row below is in
use", a name Excel would not take); for an Excel file what the grid emitted
goes through `forPackage`, as a press does. A sheet the service holds is sent the grid's own mutations,
each cell's style laid whole. The words: "Table Budget on Data!A1:C22,
Medium 4, total row", "Table Costs: renamed Spend, no banded rows".

**A page set-up** (`sheet_page`, `acts.ts`). One tab's orientation, paper
by Excel's name ("A4", "Legal"), margins (a preset or sides in inches), a
scale of 10 to 400% or a fit to pages (not both), the print area, one
manual break under a row or right of a column, and title rows or columns,
through the kit's own page handle (`createPages`, the Page Setup dialog's
and the Page breaks view's), the same way as a table. A break that stands
already, or one under Fit to (Excel leaves those out), is refused as it is
asked. The words: "Data's page: landscape, A4, narrow margins, fit to 1 page
wide, rows 1 on every page, print area A1:C21".

**A note** (`sheet_note`, `acts.ts`). The words of the note on one cell,
or `text: null` to remove it, by what the store keeps of notes
(`SHEET_NOTES`): an opened Excel file takes new words for a note it has
and nothing else ("Add a new note in Excel", "Delete this note in Excel");
a `.tcsheet` and a LifeOS sheet make, reword and remove. A thread's
stand-in is refused ("The comment at B2 is a thread. Reply to it in
Excel."), and so are words the note already says. The grid's own note
mutations are applied to the engine in the worker, as `handle.comments`
makes them; a new note has no author. The words: "The note on A9 reworded:
“Checked on Monday.”", "A note on B2: “Ask Sam”".

**A chart** (`sheet_chart`, `acts.ts`), on every store that keeps charts:
an opened Excel file, a `.tcsheet` and a LifeOS sheet. `make` a column, bar, line or pie chart of a range, with a title
and the cell its corner sits on (right of the data when left out); `change`
a chart's kind, range or title (null takes it away), the chart named by
its name ("Chart 1") or its title; `remove` it. A range is read as the
grid's "chart from a block" reads one: the row of text over the first
numbers names the series, a first column with no number names the
categories, every other column with a number is a series; a pie takes the
first. The tab's whole chart list as the store holds it (an Excel file's
chart parts, `readObjects`; the objects a service-held sheet's snapshot
carries, `readObjectsResource`), with this one made, changed or taken out,
goes as the canvas sends a list (`RULES_SET` of kind `charts`), which
`host/objects.ts` keeps for a sheet the service holds. That host keeps any
well-shaped list, so the tool holds each chart to the chart writer's model
first (`checkedPlan`), the one its Excel export writes with. A combo and a kind only Excel draws
(`other`) are refused. Not offered: colours, axes, a legend's place, a
second axis, data labels, stacked or percent groupings, a picture.

The store's own save is the last check for each: for an Excel file the
mutations go through `planOf` and `savePackage` in memory, the bytes thrown
away (`triedOn`), so what any writer refuses is said as it is asked.

Each ask becomes the grid's own data: a format, the mutations the row's own
code makes (`compose.ts` runs work-kit's `applyFormat` in the sheet worker
on a blank workbook with the real one's sheets, since a format reads no
cell); a rule, Univer's own model (plain data; main loads no Univer). On a
sheet the service holds they are applied as any edit (`host apply`); on an
opened Excel file a format is saved by the format writer, and a rule goes as
the whole list it leaves (`RULES_SET`: the file's own list, read from its
rule parts alone by `readRules`, with the new rule added).

Where the rule says wait, a format or a rule is kept as a **change**
(`changes.ts`, `work_sheets_changes`): the ask itself and the words he
reads for it ("Bold, yellow fill on B2:B9", "Red text where B2:B9 is
greater than 100"), in this host's own database for every kind of sheet, a
LifeOS sheet and a `.tcsheet` included. The view carries the words, the
range and the reason (`SheetView.changes`), never the ask. Taking one
(`work.sheets.review`, the same call and the same `which` as a cell
suggestion) lays it as his own edit made on the revision the agent saw:
the store moves it through what landed since, and where rows, columns or
sheets changed in between it turns `orphaned` and can only be dropped. So
does every waiting change when he restores a revision (either kind of
sheet) or an Excel file changes outside; a LifeOS sheet changed from LifeOS
orphans nothing: a change that no longer fits turns `orphaned` as he takes it.
One the sheet has no place for now (its tab renamed, its name taken since)
turns `orphaned` too (`Unplaced`), and an accept of many goes on past it.

An agent adds; it replaces nothing. A name already there in its scope, a
filter where one is laid (or none where one is to go), a validation over
cells that have one, a rank outside 1 to 1,000, a name Excel keeps for
itself (`TRUE`, `Print_Area`, any `_xlnm.` name: the writer's own list,
`patch/names.ts`), a width or height past what Excel keeps: each is refused as it is
asked, in words that say where he changes it (`ruleClash`, `nameProblem`,
`FormatSchema`), and the change is made once and thrown away before it is
kept, so little waits that the save would refuse. What still fails only as
he takes it, on an Excel file: a filter over a table that has its own, and
a validation over one Excel 2010 keeps in its extension list (`readRules`
does not list those). The sheet's rules are read for the check from the file
(`readRules`) or from the service's engine (`open` answers `rules`). A
failure that is not about the sheet (the sheet worker, a read of the file)
leaves the change waiting. A format or a rule written at once on the
agent's own idea is said in the bar's written line with no Undo on it
(`SheetWritten.undo: false`): History takes it back.

**A suggestion stays his until he approves it** (the owner's ruling,
2026-11-23; `private.test.ts`, and the guest's page in
`service/routes/sheet.test.ts`). Where each store keeps what an agent
proposes:

| The sheet | Kept in | Reaches the file, its folder, a guest or another service |
|---|---|---|
| an opened .xlsx or .xlsm | `work_sheets_suggestions` under `file:<path>`, the mode and written line in `work_sheets_prefs` | no: the file and its folder stay byte for byte |
| a workbook held by Excel, a Google sheet | `work_sheets_suggestions` under `excel:<key>`, `google:<fileId>` | no: nothing is sent to Excel or Google before his accept |
| a `.tcsheet`, and the sheet a .csv opens as | one JSON file per path in the Work service's own folder, `<userData>/work-service/sheets/suggestions/`, on the host that serves it (`TcsheetBackend`'s `side`) | no: `suggestions.json` in the file is always empty, and one a file from before the rule carries is taken out the first time it is read |
| a LifeOS sheet | LifeOS's `sheetSuggestionCells` rows | not the live sheet: a suggestion is no op, so the live socket sends a guest nothing and the workbook a guest loads has none of it. The rows are in his LifeOS, the store that holds the sheet itself |
| a format or a rule, on any of them | `work_sheets_changes` in this host's database, under the sheet's key | no: not the file, its folder, the Work service's folder, LifeOS or the live route, until he takes it |

`work.sheets.review` and `work.sheets.mode` are his press: a thread's call
(`by.kind === 'model'`) is refused. A remote key changes a sheet others can
open only with `approve`, as Files' door asks of any change in such a
place: `work.sheets.edit`, `.restore`, `.undo` and `.review` (an accept and
a reject alike) answer "Others can open this sheet: this key may not change
it" without it. His own window and another host of his are not held to it,
and his own sheet takes `operate` as before.

**Who is answered what waits** (`viewFor`, held.ts): on a sheet others can
open, the suggested cells, their reasons and the proposed formats and rules
go only to him: his own window, another host of his, or a key with
`approve`. Any other key that can see the item, and a thread's call on the
wire, gets the sheet as it stands with no suggestions and no changes, from
every method that answers a view. A push goes to every key, so for such a
sheet it carries no view and says `stale`; each canvas reads its own with
`work.sheets.open` (sync.ts `pushed`). His own sheet sends its view with the
push as before. Held by private.test.ts ("what waits on a workbook others
can open is his alone to see").

Not closed: Files' count of what waits in a workbook (`registerFileWaiting`)
is a number with no cell in it and is Files' to answer; a LifeOS sheet's
suggestions are LifeOS rows, in his own store, not on this host.

## The canvas

`src/renderer/src/work/sheets/`: `canvas.ts` (the kind, `history: true`),
`SheetBody.tsx` (Body, Bar, TabEnd), `sync.ts` (one item's sync: load by
range at the view's rev, edits batched from the rev the grid stands on, a
conflict caught up with `since`, pushes), `grid.ts` (work-kit's
`SheetCanvas`, its worker as a `?worker` chunk), `model.ts`, `host.ts`.

- **Only the workbook's own mutations are his edit** (`ofUnit`, sync.ts).
  The grid also reports the cell editor's own document, which each key he
  types changes (`doc.mutation.rich-text-editing` on
  `__INTERNAL_EDITOR__DOCS_NORMAL`); what he commits arrives as the
  workbook's mutation and is what is sent. Taken for an edit, those keys
  were stopped on an opened Excel file ("That change is not saved in an
  Excel file yet") and refused by the service's host ("not registered"),
  so a typed value did not save anywhere (757a7d7e7 to 40d0615fb; the
  report `.temp-code/plans/landed/E-sheets/sheets-files-save-report.md`).
  `SheetBody.dom.test.tsx` ("a value typed into a cell of an Excel file is
  sent") and `sync.test.ts` hold it; `filesPane.test.ts` saves a typed value
  and a bold into an .xlsx a Files tab holds, in the workspace's folder and
  in a library; `scripts/e2e-sheet-files-save.ts` does it by hand in a real
  window.
- An agent's pending values are laid into their cells with
  `handle.apply` (never sent as edits), so totals compute with them; the
  formula bar's `was` says what the cell held; the stepper walks change
  runs (`changeRuns`), a conflict alone, orphaned cells last.
- The switch: when `view.reach` is set (macros, pivot tables, charts, Power
  Query, data connections, links to other workbooks, form controls,
  slicers, what-if tables), "TempCode | Excel" or "TempCode | Full editor"
  sits in the tab row (`reach.to`). For an opened Excel file the parts are
  counted from the importer's report (`excelWaits.ts` `waitsOf`: a
  workbook's pivot tables and charts summed across its sheets, one as "a
  pivot table", macros and Power Query named without a count), and the
  kind's bar says them in one muted line at the end of its tools, under
  the switch, "2 pivot tables and macros open in Excel"
  (`excelWaits.tsx`): cut at the bar's room, whole in a tip while it is
  cut. A workbook Excel or Google holds has the switch and no
  line. Excel opens the file in desktop Excel
  where it is installed; Full editor opens it in ONLYOFFICE on the box (next
  section), and its side spins until the host answers the page, which opens
  in the browser (`work.sheets.switch` answers `{ opened, url? }`).
- Charts and pictures are drawn and edited by work-kit's grid on every
  sheet whose store keeps them (an opened Excel file, a `.tcsheet`, a LifeOS
  sheet: "Packages" and "Sheets the service holds"); More → Chart makes one
  from the selection's block there, as Insert → Chart does, and is not
  offered elsewhere.
- The format row (docs/DESIGN.md "Work editors: The format row"; work-kit's
  `SheetToolbar` on `src/format`) is the Body's first row, above the formula
  bar, on a LifeOS sheet, a `.tcsheet` and an opened Excel file. A
  control ships only where its change survives, and the host says which:
  `SheetView.row` is `SHEET_ROW[store]` (contract-work-sheets.ts), every
  control for `lifeos`, `tcsheet` and an opened Excel file (`package`), none
  for `csv` nor for a workbook Excel or Google holds, and the Body draws
  exactly that list (no row when it is empty or the sheet is read only). The controls: undo and redo, cell style (with Clear
  formatting), font, size, bold, italic, underline, text colour, fill,
  align with wrap and merge, borders, and the number format with the
  decimals steps and a format code of his own.
  `rowMatrix.test.ts` holds the rule: for everything each control can press
  (each named style kind, Clear, strikethrough, a theme colour and a plain
  hex, each border preset, merge and unmerge, the decimals steps, a code of
  his own) the mutation the grid emits goes through a real `SheetHost`, a
  cold host loads it back, and `writeXlsx` then `importXlsx` still carries
  it. The `.tcsheet` leg is the real backend on a real file; the LifeOS leg
  is a stand-in store that keeps a snapshot and ops as LifeOS does. On an
  opened Excel file the same presses go through the package store and the
  format writer into a real .xlsx, and the file read again must look as the
  grid drew it, wear the same named style and hold every value it held.
- Every press is one grid command per selected range (`handle.format`,
  work-kit `sheet/grid/format.ts`): the grid emits
  `sheet.mutation.set-range-values` with a partial style (a merge, a column
  width and a row height have their own mutations) and the sync sends it as
  any other edit. One press on a plain selection is one undo step; a merge
  over cells already merged parts them first, a step of its own.
- A merge that would empty cells asks first (the app's confirm: "Merge
  these cells?"). A border preset that would write more than 200,000 edge
  cells has its menu row off. "Custom format…" opens a small dialog that
  takes a format code and refuses one that does not parse as a number
  format (`patternProblem`: an unclosed quote or bracket, too many
  sections, over 255 characters), so a code Excel would repair never
  reaches a file.
- A named cell style is Excel's built-in and sets what Excel's sets:
  Currency, Percent and Comma the number format alone, a heading the font
  and the border, Good, Bad and Neutral the font and the fill. The rest of
  the cell's look stays. In the file it is that formatting: the model writer
  writes no `cellStyles` record for it.
- Colours keep the file's theme: the importer puts the workbook's
  `OfficeTheme` and default font in the snapshot's `custom`
  (`custom.theme`, `custom.defaults`), a theme colour is its resolved hex
  with the slot and tint packed into the colour's `th` (work-kit
  `sheet/colour.ts`, `themeTag`), and the model writer writes it back as
  `theme="n" tint="t"` beside `xl/theme/theme1.xml`. Tints are Excel's own
  integer maths (`tintExcel`).
- Keys. The Body's root is marked `data-editor-keys`: `sheet` where the
  row is drawn, `read` where it is not (a locked sheet, and a store that
  keeps no formatting), so ⌘B is the grid's only where bold is kept
  (docs/agents/work-editors.md). Bold, italic, underline and strikethrough
  are Univer's own keys; the canvas is told `styleKeys={false}` where there
  is no row and they then do nothing. Clear formatting (⌘\) and the size
  steps (⇧⌘. and ⇧⌘,) are the row's: it hears them on the window, for a
  press in the grid or the Body, since Univer keeps a key pressed in its
  grid from any handler on the Body itself; Univer's own binding for the
  size steps stands down while the row is drawn, so a press is one step. A
  text field (the formula bar, a dialog) keeps its keys.
- Fonts. An opened file's plain cells are drawn in the file's default font
  (the importer's `custom.defaults`, which the canvas makes the default
  style of a sheet that names none, set at the foot of the row as Excel
  sets it), and the row names it. A sheet made here is in the app's own
  face, which is no font a file could name: the row reads "Default" there
  and offers no such font, at the size the grid draws (9.75 points, 13px);
  its Excel export gives such cells Calibri at the same 9.75 points. Univer
  draws a cell on a canvas in the family its style names, by that name
  alone, so each Office font a workbook names is registered under its own
  name, drawn with its metric twin's files where the machine lacks it
  (`sheets/fonts.ts` on `formats/fonts.ts`: Calibri as Carlito). The
  workbook's fonts are read before the grid first draws (at most 2.5 s),
  and a font picked in the row before it is laid: a canvas does not draw
  again when a face arrives late.
- Data. The row's Data menu (work-kit's, in the row's data group) lists
  what the host's `view.row` names of `sort`, `filter`, `validation`,
  `conditional` and `names`; with none of them there is no menu. Sort is
  the grid's own (A to Z, Z to A, a dialog of up to three keys) and saves
  as any reorder does; Filter lays or lifts the sheet's filter; the other
  three open the rules' side sheet.
- The rules' side sheet (work-kit's `RulesSheet`, docked by `SheetBody`:
  320px at the grid's right, under the grid at 344px where the canvas is
  under 560px wide). It lists the kinds the host names, in the sheet's
  order, and edits one rule at a time through `handle.rules` (work-kit's
  `createRules`: every change is one of Univer's own commands, so one step
  of Undo and the mutations any change makes). Univer's own panels for
  conditional formats, validations, the filter and a list's drop-down do
  not open: the filter's menu, a list's menu and a refused value's notice
  are work-kit's own, drawn over the grid.
- Where a rule goes. On a sheet the service holds the rule's own mutation
  is sent as any edit (the host's engine mounts the same plugins and
  replays it). On an opened Excel file the canvas sends the whole list the
  change left (`forPackage`, `RULES_SET`; `grid.rules` reads it from the
  grid), one list a kind and sheet a turn, and a kind the host does not
  name is stopped at the press as any change the file cannot keep.
  `rulesMatrix.test.ts` runs the real plugins' commands through that
  mapping and the package store into a real .xlsx and reads each back.
- A format or a rule an agent proposed (`view.changes`) steps with the
  cell suggestions in the bar's stepper (`sheetChanges`, model.ts), after
  the cells, in the order they were made. Its range is marked as a waiting
  change is, and while the stepper is on it the formula bar says it
  (`saidLine`: "Suggested: Bold, yellow fill on B2:B9", with the agent's
  reason); a name, which sits in no cell, is said the same way. Accept and
  Reject call `work.sheets.review` with its id.
- What an Excel export could not hold is said in Preview's "In this
  format" ("The names stay behind"), before he exports.

## The full editor

Milestone 40. ONLYOFFICE Docs Community 10.0.0, run on the box as the
switch for an opened `.xlsx` or `.xlsm` our grid cannot fully edit: the
owner's alone, unmodified, a separate server (architecture §12.1). Code in
`src/main/server/work/sheets/fullEditor/`, the route in
`work/service/routes/fullEditor.ts`.

- **Installed** by its own manifest, `scripts/work-tools/onlyoffice.json`
  (linux-x64 only; AGPL-3.0, the licence and how it may run in its
  `licenceNote`): the vendor's .deb is fetched by hash and kept raw, and the
  probe unpacks it with `dpkg-deb -x` and runs the vendor's own postinst
  steps (fonts, themes, the JS cache, `api.js` copied from its template),
  then converts a CSV with `x2t`. 2.1 GB under
  `<userData>/work-tools/onlyoffice/10.0.0/`. Nothing of it is in the app,
  work-kit or the guest page.
- **Offered** where `fullEditorHere(dataDir)` says so: a Linux host (the box)
  with the tool installed. There `reach.to` is `'full'` for a package; on
  the Mac and Windows it stays `'excel'`. LifeOS sheets and `.tcsheet`
  files carry no `reach`, so the switch is not offered for them (the model
  writer could write one out for it, but leaves out conditional formats,
  validations and names, so that is not wired).
- **Started** on the first press while Work is on (`openFull`): never for a
  thread (`by.kind === 'model'`) or a remote key short of admin. The
  `docservice` runs as this user from the toolchain's tree with a config we
  write under `<userData>/full-editor/conf` (the vendor's files with paths
  moved, and a `local.json` with fresh secrets: one for the browser's config
  and sessions, one the docservice signs its callbacks with and only main
  checks, one for its cache links). It may fetch from no private address
  but 127.0.0.2, where the storage server listens (`allowIPAddressList`), so
  the editor's own URL fetches reach none of the box's other services. Its "port" is a Unix socket in a 0700 folder
  (`full-editor/run/ds.sock`): it has no TCP listener at all. It has no
  database and no queue server (in-memory editor data); its cache under
  `full-editor/data` is wiped at each start. Its log is
  `full-editor/docservice.log`; `TEMP_CODE_FULL_EDITOR_LOG=info` makes it say
  what each request did.
- **Each open** copies the file as it is (the docservice fetches that copy
  from a storage server main runs on 127.0.0.2) and mints a token of 32
  random bytes in hex. Opens and stops run one at a time, so a second
  press on the same file (by its real path) answers the same token, and a
  stop never closes what an open is starting. The canvas allows the press
  two minutes (`LONG_WRITES`), since a cold start can be slow. The document key is hex too: the converter takes a key starting
  with `-` for a flag, and the docservice escapes `_` in the links it writes.
- **Its theme** is the asking window's when that is light. A light window
  sends `scheme: 'light'` with the press (`work.sheets.switch`, from
  `work/sheets/host.ts`), and the signed config names it as ONLYOFFICE's
  `uiTheme`: `theme-light` (`uiThemeOf`, `fullEditor/editor.ts`; it writes
  `theme-dark` for a dark scheme too). A press with no theme gets
  `theme-system`, the browser's own: the phone sends none, and neither does a
  dark window yet, where the editor opens as it always did (dark is held,
  docs/agents/appearance.md). The editor reads its
  theme when its page loads and never after: a later press from a window in
  another theme changes what the next load wears, not the open page.
- **The route** `…/w/full/<token>/` asks main what the token opens, over the
  Unix socket beside the service's own (`work-service.sock.full`, 0600;
  cached two seconds), and answers 404 for anything else. `/` is our page
  (a nonce CSP, `frame-ancestors 'none'`), which loads ONLYOFFICE's `api.js`
  with the config main signed. Everything under it goes to the docservice's
  socket, its editor paths only (`EDITOR_PATHS`: no info, admin, command,
  converter or builder endpoints), WebSocket upgrades included, with
  `X-Forwarded-Host: <host>/w/full/<token>` so the editor's own links come
  back through the route, the caller's cookies and credentials dropped,
  `X-Frame-Options: SAMEORIGIN` so its frames load here only, and
  `Cache-Control: no-store` on all but the vendor's static files (a saved
  workbook kept at the tunnel's edge would outlive its token). The route
  asks the lookup socket only when this user owns it.
- **Its address.** A window on the box opens
  `http://127.0.0.1:<service port>/w/full/<token>/`. Another computer's
  window (his Mac's, by an admin key) never opens it on the remote UI's
  origin (`tempcode.landonhale.com`), where ONLYOFFICE's code could use the
  owner's session. Its desktop app carries it instead (src/main/fullEditorCarry.ts):
  the press sends `carry: true`, the box answers `{carry: <public
  origin>/w/full/<token>/}` (`openFull`, the guests' `publicOrigin`, over the
  tunnel's existing `^/(g|w|f)/` rule to the Work port), and the app's main
  process serves that one page on a loopback port of its own,
  `http://127.0.0.1:<port>/w/full/<token>/`, an origin of its own, and shows
  it in a window of its own (src/main/fullEditorWindow.ts), not the system
  browser, where ONLYOFFICE's code would share the 127.0.0.1 cookie jar with
  every loopback server of his: an in-memory session that goes with the
  window, sandboxed, no preload, no permission but writing the clipboard, and
  nothing it loads, frames, opens or links to leaves its loopback origin (the
  session cancels every other request; a link elsewhere does nothing). The carrier passes only the paths under that token,
  WebSocket upgrades included, and names its loopback origin in
  `x-tempcode-carry` on each; the route then gives the docservice that origin
  as `X-Forwarded-Host`, so the editor's own links come back through the
  carrier (the docservice's `Host` too). Without that header the route
  answers only a request addressed to this host's loopback listener and not
  through the tunnel (`reachesEditor`: closed by default, so a request on the
  remote UI's hostname is refused with or without Cloudflare's headers), and
  the page never runs on the remote UI's origin. A browser cannot set the
  header on a page it navigates to, and another origin's script cannot send
  it without a preflight the route never answers. The route drops every
  forwarded-protocol header the caller sent (`Forwarded`, `X-Forwarded-*`,
  `*-Forwarded-Proto`). The carrier serves only requests named for its own
  `127.0.0.1:<port>` (no other name that resolves there), refuses dot
  segments, escaped slashes and backslashes in a path, takes a socket or a
  write only from its own origin (a socket must name it), passes a socket's
  answer only once it is a 101 (within 15 seconds) and drops its cookies, sends the box no
  cookie or credential
  (a cookie of 127.0.0.1 is any loopback server's), keeps a redirect to the
  box on its own origin and drops one anywhere else, and passes on no
  `Set-Cookie` or `Service-Worker-Allowed`. It closes after 30 minutes with
  nothing through it and no socket open. Reviewed by GPT-6.2 Sol before it
  landed (`F-close-and-full-editor/full-editor/review.md`). Before 2026-11-24 the page needed a hostname of its own
  (`TEMP_CODE_FULL_EDITOR_ORIGIN`, `work.fullEditor.origin`) that was never
  set, so from his Mac the switch was offered and always refused; both are
  gone.
- **Offered where it opens.** The view's `reach` says `carried: true` where
  the box's pages reach beyond it (`servesPublic`: the box behind its tunnel,
  or a proof's `TEMP_CODE_WORK_PUBLIC_ORIGIN`). The window draws the switch,
  and its "opens in the full editor" line, only in the desktop app, and from
  another computer only with `carried` and an admin key
  (work/sheets/fullHere.ts `reachHere`); a browser, the phone and a key short
  of admin are never offered it. What a caller can still reach is one plain
  sentence: a thread ("a thread cannot open it"), a key short of admin, a
  host whose pages stay on it ("The full editor opens only in a window on
  the box."), an older desktop that sends no `carry` ("Update TempCode on
  this computer to open the full editor from here."). Documents and decks
  have no full editor: their switch is Word's or PowerPoint's.
- **Saves** come to the storage server's callback, signed by the
  docservice (checked HS256, the document's key matched). The status-6
  save made with Save and the status-2 save made after everyone leaves are
  fetched from the docservice's own socket and put in the file as one
  change from outside (a temp file renamed over it, its mode kept): the
  package store makes it a revision of its own (`by: 'file'`), suggestions
  over the file are orphaned, and the canvas reloads. If the file changed
  outside the editor since it was opened (looked at again just before the
  rename), or the editor saved another format, the save goes beside it
  (`<name> (full editor <date time>).xlsx`, a second in the same second
  numbered); a file moved or removed meanwhile has its save kept in
  `full-editor/rescued/`. Each of these is said over the grid where a failed
  save is ("Couldn't save", with where the save went). A save the editor
  cannot make (status 3 or 7) or that could not be fetched is said there
  too, and the file is left as it was.
- **Stopped** when Work turns off (the module's `start` return), when
  nothing has been open for ten minutes, or when its process group holds
  more than its cap (2 GiB, `TEMP_CODE_FULL_EDITOR_MEMORY_MB`): a watchdog
  adds up the RSS of every process in the group every ten seconds, since
  the box gives this user no cgroup of its own. An open nobody loaded in
  fifteen minutes is let go, and one nobody is in after a day. Stopping
  under someone still in the editor says over the grid that changes since
  its last save are lost. Stopping kills the whole group, and so does the
  docservice exiting by itself (its converters with it); a docservice an earlier run left (the app was killed) is
  stopped before the next starts.
- **The live proof**, `fullEditor/live.test.ts`, runs only with
  `FULL_EDITOR_LIVE=1` and `FULL_EDITOR_PLAYWRIGHT` naming a playwright-core
  whose Chromium is installed: a workbook with pivot tables and a chart
  (`fixtures/pivot-chart.xlsx`, made by ONLYOFFICE's docbuilder from
  `pivot-chart.docbuilder.js`) opens from the switch, a cell typed there
  comes back as revision 1 with the pivot parts byte for byte and the chart
  kept, and the corpus's LibreOffice-written `pivot.xlsx` shows its failed
  save over the grid.

## What a save costs, and the fixtures

`scripts/bench-sheet-save.ts` times one cell saved into an opened package
(run it pinned: `taskset -c 2,3 bun scripts/bench-sheet-save.ts`; `--json`
keeps the runs). It makes four workbooks of 100 to 500,000 rows (two number
columns, a formula every tenth row) and times four things, interleaved, five
runs each, the median with the load beside it: `worker` (the save job the
sheet worker runs, here in the bench's own process, the workbook's import
kept between runs), `commit`
(`PackageStore.edit`, his edit to the committed revision: the plan, the job,
the rename, the kept copy, the rows; the import is fresh each time, as in
the app), and two floors, what a save costs with the engine left out:
`floor-skip` (the patch writer with no engine, on a cell nothing reads) and
`floor-style` (a font appended and one cell pointed at it). The dense corpus
file (800,002 formulas) gets the first two, three runs. On the box, 2026-11-23, cores 2 and 3, load 3 to 6:

| Rows | `worker` | `commit` | `floor-skip` | `floor-style` |
|---|---|---|---|---|
| 100 | 1.3 ms | 12.6 ms | 0.6 ms | 0.3 ms |
| 10,000 | 68 ms | 118 ms | 12.7 ms | 9.8 ms |
| 100,000 | 556 ms | 785 ms | 112 ms | 96 ms |
| 500,000 | 3,176 ms | 4,213 ms | 592 ms | 492 ms |
| the dense file (100,000 rows) | 13,515 ms | 14,073 ms | | |

The 10,000-row figures spread past a quarter of their median: read them as
about that much. The dense file ran at a load near 7 (the plan's lab
measured 9,954 ms for its `worker`, one run, on a quieter box).

Since SHT2 a save takes the lightest path that is safe ("How a save is
made"), and the bench times two more things, both his press to the
committed revision: `bold` (formatting alone) and `lone` (a value typed
where no formula reads it; the row's name says which path the proof chose).
On the box, 2026-11-23 07:20, cores 2 and 3, while twelve other builds ran
(load 26: every figure is about twice what a quiet box gives, as the two
floors show against the table above):

| Rows | `commit` (the engine) | `bold` | `lone` | `floor-skip` | `floor-style` |
|---|---|---|---|---|---|
| 100,000 | 1,325 ms | 439 ms | 375 ms | 204 ms | 173 ms |
| 500,000 | 6,732 ms | 1,811 ms | 1,543 ms | 1,035 ms | 818 ms |
| the dense file (100,000 rows, 800,002 formulas) | 22,369 ms | 2,604 ms | 6,486 ms | | |

So a bold cell in a 100,000-row file commits in under half a second even on
a loaded box, a third of what the engine path costs; on the dense file it is
a ninth. The dense file's two light figures spread past a quarter of their
median (three runs under load): read them as about that much. Proving that
nothing reads a cell there means reading 800,002 formulas' text, about four
seconds of the 6.5: still under a third of the engine's time, with no model
kept between saves. No model is kept: the plan asked for one only if the
numbers earned it, and the proof costs less than a model's memory and its
rules for dropping it would.

The harness corpus also keeps the workbooks the editors plan measured with
(`harness/fixtures.test.ts` runs everywhere, with no LibreOffice):

- `corpus/patch/`: a base workbook and nine part-local patches of it (a
  cell's style; a width, a height and a merge; a conditional format; a
  validation; a defined name; a filter; page set-up with Fit to and at
  100%; all together), each with the XML parts that changed
  (`<name>.parts.json`) and what was read back (`expect.json`). The test
  feeds the parts to the zip writer and holds that it changes 1 to 3 of the
  11 entries and keeps every other entry byte for byte.
- `corpus/print/`: seven print workbooks (with three of the corpus's own,
  ten cases) and `expect.json`: the pages LibreOffice printed of each, and
  the pages arithmetic gives by Excel's rules and by LibreOffice's. Excel's
  rules matched LibreOffice on 25 of 33 pages, LibreOffice's own on 32 of
  34. No Excel made any of these.
- `harness/make_fixtures.py` and `make_patches.py` make them again
  (XlsxWriter, lxml, openpyxl).

## Not built

- For a copy of another format ("Other formats in"): the line does not say
  whether the copy holds edits not yet saved back; Files shows no count of
  suggestions waiting on such a file (they are kept by the copy's path);
  what a trip through LibreOffice changes in an .xls or .ods beyond what
  `sheetDrops` counts is not listed; real Excel has not opened a file
  saved back.
- A new note or a removed note in an opened Excel file: a new note needs
  Excel's comments and drawing parts, which no writer here makes. Moves are
  saved where the file allows ("Structural edits").
- The model writer leaves out notes (`left` says so); it writes charts and
  pictures as real parts, and says one it could not (`left`).
- No tool changes a cell's runs (text in more than one style).
- An agent adds rules and formats (`sheet_rule`, `sheet_format`) and has
  `sheet_table`, `sheet_page`, `sheet_note` and `sheet_chart` (tools.ts),
  under the same hold; it does not change or remove a rule, merge cells or
  sort, and has no tool for Preview, Check in Excel or Save to Google
  Sheets.
- Check in Excel on his Mac or a Windows PC: the office pillar offers the
  pair on no carrier but the box's VM until its own proof passes there.
  Check in Excel for a macro workbook, and for a workbook others can open.
- Excel's own picture of a page range: Check in Excel draws the whole
  workbook.
- Presence on the canvas.
- Keeping IronCalc's model in memory between saves: a save that needs the
  engine loads the package afresh (1.3 s on the 100,000-row file, 22 s on
  the dense one); formatting, rules and a value nothing reads need no
  engine.

## Known limits

- The `/internal/sheet/<op>` routes main calls sit behind the same secret
  the LifeOS worker holds, and take `by` and the sheet on trust: the
  worker is the owner's own process on the box, as M18 already allows it
  every internal route. A second secret only main holds would close it.
- `/internal/sheet/write` takes the worker's `because: 'asked'` on trust,
  as the document route does (M17, M18).
- An agent's `reason` shows beside its suggestions on a package and a
  `.tcsheet`; LifeOS has no field for it, so on a LifeOS sheet it is
  dropped.
- The round-trip harness runs only with `SHEET_HARNESS=1` on a host with
  the lab's Python (lxml) and LibreOffice: no gate row runs it.
- A `.tcsheet` is rewritten whole on every op.
- A `.tcsheet`'s waiting suggestions are kept by its path on the host that
  serves it: a file moved or renamed outside TempCode, or opened from
  another host, comes without them.
- work-kit's `was` chip in the formula bar is not struck through on the
  delete tint as the prototype draws it; work-kit owns it.
- ONLYOFFICE 10.0 cannot save an edit to the corpus's `pivot.xlsx` (its
  pivot written by LibreOffice): the converter fails ("Cannot read property
  'Tm' of undefined") with the vendor's own setup too. The grid says so and
  the file keeps what it had, but the edits made there are lost. A pivot
  ONLYOFFICE wrote saves; one Excel wrote is untried (no Excel on the box).
- ONLYOFFICE rewrites a chart's XML when it saves (the chart is kept).
- The memory cap is a watchdog, not a kernel limit: a burst inside ten
  seconds can pass it. Stopping (over the cap, Work off, a crash) loses
  edits not yet saved there; the grid says so, but no forcesave is asked
  for first.
- A window on the box itself opens the editor on 127.0.0.1, whose cookies
  are shared across ports with the remote listener's; the box has no
  window in use, so this is left.
- A route error's log line in serve.ts names the request path, token
  included.
- On a phone the page loads the desktop editor, cramped: Community's mobile
  editor is view-only, so the config asks for the desktop one.
  Milestone 47 ran the grid in real WebKit (macOS WKWebView and the iOS 27
  simulator; .temp-code/plans/landed/M47/webkit/): it paints, takes edits
  and recalculates as in Chromium, so a sheet on the phone is editable.
  Univer focuses its hidden input on load, which raises the keyboard; the
  phone's web view blurs any focus before his first touch.
