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
| Microsoft or Google | not here: milestones 28 and 30 implement `SheetSource` | — |

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
- **What a package saves**: cell contents only. A format, a row or column
  insert or delete, a fill and rich text are refused with a sentence the
  canvas shows once (`NotSaved`, mutations.ts). Structural edits saved
  through LibreOffice (architecture §9.1) are not built.

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

- Structural edits saved into a package through LibreOffice; formats saved
  into a package.
- `work.sheets.export` (the model writer that writes a LifeOS sheet or a
  `.tcsheet` out as .xlsx): answers "not built".
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
