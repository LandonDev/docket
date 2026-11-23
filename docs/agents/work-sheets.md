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

**A suggestion stays his until he approves it** (the owner's ruling,
2026-11-23; `private.test.ts`, and the guest's page in
`service/routes/sheet.test.ts`). Where each store keeps what an agent
proposes:

| The sheet | Kept in | Reaches the file, its folder, a guest or another service |
|---|---|---|
| an opened .xlsx or .xlsm | `work_sheets_suggestions` under `file:<path>`, the mode and written line in `work_sheets_prefs` | no: the file and its folder stay byte for byte |
| a workbook held by Excel, a Google sheet | `work_sheets_suggestions` under `excel:<key>`, `google:<fileId>` | no: nothing is sent to Excel or Google before his accept |
| a `.tcsheet`, and the sheet a .csv opens as | one JSON file per path under `<dataDir>/sheets/suggestions/` on the host that serves it (`TcsheetBackend`'s `side`) | no: `suggestions.json` in the file is always empty, and one a file from before the rule carries is taken out the first time it is read |
| a LifeOS sheet | LifeOS's `sheetSuggestionCells` rows | not the live sheet: a suggestion is no op, so the live socket sends a guest nothing and the workbook a guest loads has none of it. The rows are in his LifeOS, the store that holds the sheet itself |

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
  bar, on a sheet the service holds: a LifeOS sheet and a `.tcsheet`. A
  control ships only where its change survives, and the host says which:
  `SheetView.row` is `SHEET_ROW[store]` (contract-work-sheets.ts), every
  control for `lifeos` and `tcsheet`, none for `package` and `csv`, and the
  Body draws exactly that list (no row when it is empty or the sheet is
  read only). The controls: undo and redo, cell style (with Clear
  formatting), font, size, bold, italic, underline, text colour, fill,
  align with wrap and merge, borders, and the number format with the
  decimals steps and a format code of his own.
  `rowMatrix.test.ts` holds the rule: for everything each control can press
  (each named style kind, Clear, strikethrough, a theme colour and a plain
  hex, each border preset, merge and unmerge, the decimals steps, a code of
  his own) the mutation the grid emits goes through a real `SheetHost`, a
  cold host loads it back, and `writeXlsx` then `importXlsx` still carries
  it. The `.tcsheet` leg is the real backend on a real file; the LifeOS leg
  is a stand-in store that keeps a snapshot and ops as LifeOS does.
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
- A cell with no family of its own reads "Default" in the row: it is in the
  sheet's default face, the app's own on a sheet made here, which is no
  font a file could name and is not offered in the list. The size it shows
  is the one the grid draws (9.75 points, 13px). The Excel export gives
  such cells the workbook's default font: the file's own where the snapshot
  names one, else Calibri at the same 9.75 points, so the text is the size
  the screen showed, in Excel's face.

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
measured 9,954 ms for its `worker`, one run, on a quieter box). Today every save takes the `worker`
path; nothing yet saves at a floor.

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

- Formatting saved into a package (so an opened Excel file has no format
  row yet), and moving cells (drag a range, move rows or columns) in one.
- The model writer leaves out conditional formats, validations, defined
  names, notes and our charts.
- Presence on the canvas.
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
