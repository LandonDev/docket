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
| a file `.csv` | the Work service, as a `.tcsheet` read from it once (`csvSheetPath`: `<userData>/sheets/csv/<hash>.tcsheet`) | its own op log; Save as CSV writes it back over the .csv, Export as Excel beside it |
| a workbook in Excel (`{at: 'microsoft', app: 'excel'}`) | Excel, through the office pillar's helper (`office/grid.ts`, [work-office.md](work-office.md) "Excel behind the grid") | written through Excel, cell contents only; the view says `store: 'package'` |
| a Google spreadsheet (`{at: 'google'}`) | Google, through the google pillar (`google/grid.ts`, [work-google.md](work-google.md) "Sheets") | each write compared, then one `values:batchUpdate`; the view says `store: 'package'`; the switch opens it in Google |

`held.ts` maps an item to its store (`heldOf`) and the key its
suggestions, mode and charts are kept under (`storeKey`: `file:<path>`,
`lifeos:<id>`, `tcsheet:<path>`). A new sheet (`work.sheets.create`, the
`sheet_create` tool) is a LifeOS sheet when the thread's workspace has a
sector and LifeOS is connected, else a `.tcsheet` under
`<userData>/sheets/made/<id>/`.

## A mail's attachment

A workbook from a mail (`{at: 'mail'}`: .xlsx, .xlsm or .csv) is held as the file the host fetched into the item's own folder (`heldOf`, work-canvas.md "Fetched sources"): a package, or a CSV's sheet of our own. Edits write that copy, never the mail or his folder; Download saves it. A .xls or .ods is not a kind `kindForFile` gives the sheet, so it is saved.

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
  `fullCalcOnLoad`, so Excel recalculates on open. A package whose
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
  not make is a revision of its own (`by: 'file'`), and the grids reload.
  Restore puts a kept copy back byte for byte as a new revision.
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
  (`sharedCsvDir`), named for the file as it stands so a co-author's newer
  file is read again, and opens to read ("…it opens here to read. Save a
  copy to edit it."): an edit would live only in a cache that does not
  last, so none is taken (`host` refuses `apply`, `cells`, `review` and
  `restore` for it). One exception keeps his work: a shared `.csv` he had
  already edited here before this rule keeps its sheet among the app's
  files, editable as before (`csvEdited`; a sheet that cannot be read just
  now counts as edited, so only a read that says revision 0 lets one go),
  saved back through Files' door, and that sheet follows the file when it
  is renamed or moved. A read-only tab already open is not told when the
  file changes: it shows the newer file when it is opened again. **What he writes out of a
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
  suggestion waiting on it still stands.
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
- **What it cannot keep yet is stopped as he makes it** (`forPackage` and
  `stop`, sync.ts): moved cells (a drag of a range, a row or a column),
  text with more than one style in a cell, a cell given only a type, and any
  change with no saved form (a hidden row, a frozen pane). What he does in
  one turn is taken together (the grid's commands counted, their mutations
  gathered): when a part of it cannot be kept, none of it is sent, the grid
  takes it back with its own undo, and a toast says why in a few words
  ("Moving cells is not saved in an Excel file yet. Cut and paste them
  instead"). One command is one undo; a turn that ran several, or
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
  here. Edits are sent as he makes them and flushed when the body goes.

## Structural edits

Rows and columns inserted or deleted, a sort, sheets added, removed or
renamed, saved into an opened package (architecture §9.1; the sheet report
§8 item 7):

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
(`writeXlsxWhole`, `rulesOf`). A list the file cannot hold is left out
rather than failing the export, and `left` names it. A sheet read from a .csv saves back over
it and exports beside it; a package gives a .csv of one sheet beside itself
(it is its own .xlsx); anything else lands in the item's own folder. The
canvas puts these in More.

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
- history lists the ops; compare and restore replay from the nearest
  snapshot in a second engine;
- every engine it makes mounts the grid's data plugins (`headlessSheet(…,
  { rules: true })`: conditional formatting, validation, filter, table,
  sort), so a rule made in the grid applies, stays in the snapshot's
  `resources` and survives a cold load; a restore writes back the cells'
  diff and, through `host/rules.ts` `ruleMutations`, the conditional
  formats, validations, filters and defined names of the revision (not
  tables). The mutation ids and payloads are in the editors plan's SHT3
  report, held by `host/rules.test.ts` and work-kit's
  `src/sheet/engine/rules.test.ts`.

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

`sheet_read`, `sheet_write`, `sheet_suggest`, `sheet_format`, `sheet_rule`,
`sheet_create` (tools.ts), cells in A1 (`a1.ts`), at most 10,000 cells a
read and 1,000 a write. `sheet_write`, `sheet_format` and `sheet_rule` say
why (`because`), under one rule (`ruled`):

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
place: `work.sheets.edit`, `.restore`, `.undo` and an accept in `.review`
answer "Others can open this sheet: this key may not change it" without it
(a reject writes nothing and passes). His own window and another host of
his are not held to it, and his own sheet takes `operate` as before.

Not closed: a read key of his own still reads a waiting suggestion's cells
and reason through `work.sheets.open` and the push (his own devices); a
LifeOS sheet's suggestions are LifeOS rows, in his own store, not on this
host.

## The canvas

`src/renderer/src/work/sheets/`: `canvas.ts` (the kind, `history: true`),
`SheetBody.tsx` (Body, Bar, TabEnd), `sync.ts` (one item's sync: load by
range at the view's rev, edits batched from the rev the grid stands on, a
conflict caught up with `since`, pushes), `grid.ts` (work-kit's
`SheetCanvas`, its worker as a `?worker` chunk), `model.ts`, `host.ts`.

- An agent's pending values are laid into their cells with
  `handle.apply` (never sent as edits), so totals compute with them; the
  formula bar's `was` says what the cell held; the stepper walks change
  runs (`changeRuns`), a conflict alone, orphaned cells last.
- The switch: when `view.reach` is set (macros, pivot tables, charts, Power
  Query, data connections, links to other workbooks, form controls,
  slicers, what-if tables), "TempCode | Excel" or "TempCode | Full editor"
  sits in the tab row (`reach.to`). Excel opens the file in desktop Excel
  where it is installed; Full editor opens it in ONLYOFFICE on the box (next
  section), and its side spins until the host answers the page, which opens
  in the browser (`work.sheets.switch` answers `{ opened, url? }`).
- Our own charts (`work.sheets.chart`, `work_sheets_charts`): plain neutral
  bars over a range, made from a selection through More.
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
- An export that could not hold a list of rules says so with the save
  ("Saved Budget.xlsx without the names").

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
  `http://127.0.0.1:<service port>/w/full/<token>/`. The owner's other
  devices open it on an origin of its own, never the remote UI's
  (`tempcode.landonhale.com`): ONLYOFFICE's code there could use the
  owner's session on that origin. The origin is `TEMP_CODE_FULL_EDITOR_ORIGIN`
  or the `work.fullEditor.origin` setting; one equal to the remote UI's host
  is refused, and with none the press says the editor opens only in a window
  on the box. It needs a hostname of its own in the tunnel (the owner's
  step): an ingress rule for, say, `full.tempcode.landonhale.com` with
  `path: ^/w/full/` to the installed host's Work port (7695).
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

- Moving cells (drag a range, move rows or columns) and rich text in an
  opened Excel file: stopped as he tries, until they are saved.
- The model writer leaves out notes and our charts.
- An agent adds rules and formats (`sheet_rule`, `sheet_format`); it does
  not change or remove a rule, merge cells or sort.
- A table made in the grid on an opened Excel file, a chart, page set-up:
  later milestones.
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
