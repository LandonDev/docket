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
| Google | not here: milestone 30 implements `SheetSource` | — |

`held.ts` maps an item to its store (`heldOf`) and the key its
suggestions, mode and charts are kept under (`storeKey`: `file:<path>`,
`lifeos:<id>`, `tcsheet:<path>`). A new sheet (`work.sheets.create`, the
`sheet_create` tool) is a LifeOS sheet when the thread's workspace has a
sector and LifeOS is connected, else a `.tcsheet` under
`<userData>/sheets/made/<id>/`.

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
- **Revisions**: each saved edit is a row of `work_sheets_ops` (the
  mutations, who, when, a label) and a copy of the package under
  `<userData>/sheets/files/<hash of the path>/<rev>.xlsx`; the copy as first
  opened is kept for good and the newest 30 after it. A change on disk we did
  not make is a revision of its own (`by: 'file'`), and the grids reload.
  Restore puts a kept copy back byte for byte as a new revision.
- **What a package saves**: cell contents (the patch writer, fills
  included: the canvas sends each filled cell's formula text) and
  structural edits (below). Formatting, moved cells and rich text are not
  saved: the canvas keeps them out and says so once (`forPackage`,
  sync.ts); the host refuses them with a sentence (`NotSaved`).

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
  without it forwards the job. It loads the file read-only (a full
  1,048,576-row sheet loads no other way), applies the ops, recalculates and
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
frozen panes, hidden sheets; `fullCalcOnLoad` set), or one sheet as .csv
(RFC 4180, a formula's last value). A sheet read from a .csv saves back over
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
  snapshot in a second engine.

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
(cell values, number formats, row and column inserts and deletes). An edit
that missed a row or column insert is moved through it (`moveThrough`, the
rebase's code); a stale structural edit is refused and the client reloads.
Our own canvas does not use the socket: it calls the pillar's methods.

## Agents: the tools and the rule

`sheet_read`, `sheet_write`, `sheet_suggest`, `sheet_create` (tools.ts),
cells in A1 (`a1.ts`), at most 10,000 cells a read and 1,000 a write.
`sheet_write` says why (`because`):

- `asked` with `quote`, the owner's own words in the thread
  (`ctx.threads.ownerSaid`): written at once;
- `routine`, in a thread a routine started: written at once;
- `own`: on a sheet others share (`scope.shared`, or LifeOS's `shared`) it
  waits as suggestions; on his own sheet it follows the sheet's mode
  (`writes` by default: written, with the bar's written line and Undo).

A quote he never typed, or `routine` outside a routine, counts as `own` and
the answer says so. Suggestions over a package (and later Excel and
Google) are rows of `work_sheets_suggestions` with the mode and the written
line in `work_sheets_prefs`; a LifeOS sheet's are LifeOS rows; a
`.tcsheet`'s are in the file. An owner's edit over a pending cell makes it a
conflict. Accepting writes the proposed cells as his own edit.

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
  slicers, what-if tables), "TempCode | Excel" sits in the tab row; Excel
  opens the file in desktop Excel where it is installed (`work.sheets.switch`).
- Our own charts (`work.sheets.chart`, `work_sheets_charts`): plain neutral
  bars over a range, made from a selection through More.
- No formatting toolbar in the bar (the approved page has none).

## Not built

- Formatting saved into a package, and moving cells (drag a range, move
  rows or columns) in one.
- The model writer leaves out conditional formats, validations, defined
  names, notes and our charts.
- The full editor (M40), Excel behind the grid (M28), Google (M30), the
  guest page that uses the live route (M31), presence on the canvas.
- Keeping IronCalc's model in memory between saves: each save loads the
  package afresh, which on the 100,000-row file is tens of seconds.

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
- work-kit's `was` chip in the formula bar is not struck through on the
  delete tint as the prototype draws it; work-kit owns it.
