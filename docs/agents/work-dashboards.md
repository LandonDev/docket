# Work: dashboards

A saved page of figures in a Work thread's canvas, read from sheets and
read again on the owner's press or by a routine. Milestone 36 built it; the
approved page is `.temp-code/prototypes/work-workspaces-2/dashboard.html`
(its pick, "A page of figures"), and docs/DESIGN.md "Dashboard" holds the
look.

## What a dashboard is

- **A row behind a canvas item** (`{ at: 'thread' }`) in `work_dashboards`
  (dashboards/dash.ts): the title, the blocks with what each last read,
  `asOf` (when the whole page was last read), each source sheet's rev at that
  read, and why the last read failed, if it did.
- **Blocks**: a heading, a line of text, figures (up to three a block; a run
  of figure blocks reads as one row of three), one chart of plain bars (one
  series; the last bar is the current one) and flat tables (the range's first
  row is the head; at most 50 rows and 8 columns).
- **Where a number comes from** (`DashFrom`): a sheet, a range in A1 (with
  the tab when it is not the first), and what it counts in words. A figure
  is one cell as it reads, or the range summed, counted, averaged, or its
  least or most (`aggregate`, dashboards/read.ts), formatted as a number,
  money, a share or text. A figure may instead come from a service the agent
  names (`{service, counts}`) with the value it sets.
- **Sheets it reads**: LifeOS sheets and `.tcsheet` files, through the Work
  service's sheet host (`/internal/sheet/open` for the rev, `/range` for the
  cells; [work-sheets.md](work-sheets.md)). A `.tcsheet` on another host is
  read there; an Excel file is not read yet.

## As of, and stale

- The page is read whole, every block at once (`refresh`), and `asOf` is
  when that finished: "as of" is said once, in the bar. A read that fails
  keeps what was there and says why in the one state line, with Retry.
- **Stale**: `work.dashboards.open` asks each source sheet for its rev; if
  one moved since the page was read (or cannot be asked), the view says
  `stale` and the canvas dims the figures and the current bar
  (`chart-neutral-stale`), and the bar says "Out of date" before "As of".
  The canvas asks again every 30 s while shown.
- A chart's axis takes three round steps (whole steps for counts); only a
  time series stresses its last bar as current. Each bar has a Tip with its
  label and value.
  Stale never changes a number: Refresh does.
- **Refreshed by a routine**: a routine's thread calls `dashboard_refresh`,
  which reads the page again (and takes new values for figures from a
  service). It needs nobody's press: it adds nothing.

## A new block waits for him

Every block an agent adds (`dashboard_add`) is a proposal (`proposed: {by,
reason, at}`) even on his own dashboard: tinted `add-bg`, stepped from the
bar, kept by Accept and dropped by Reject (`work.dashboards.review`). The
mode shows "Agent suggests" and cannot be switched.

## The canvas

`src/renderer/src/work/dashboards/`: the body is its own chunk
(`DashboardCanvas.tsx`); `canvas.ts` rides the canvas chunk.

- One column, 672px at most: figures as text on hairline rows of three (the
  title recipe, 16/24 semibold tabular, never bigger; a 12px muted label and
  line), then the chart and the tables, each under a 13px semibold heading.
  No tiles, cards, sparklines or colour per bar.
- A figure is a button: it opens its source (the sheet, the range, what it
  counts) with "Open in the sheet", which opens the sheet beside it
  (`work.canvas.open`). Selecting the range inside the sheet canvas is the
  sheet kind's to build.
- The bar ends in "As of 7:04 AM" and Refresh, or the stepper while blocks
  wait. More opens each sheet the page reads.
- An empty page says "Ask for a number".

## The tools

- `dashboard_create {title}`: an empty dashboard, opened in the pane.
- `dashboard_add {item, block, after?, reason?}`: proposes a block and reads
  the page again. A sheet is named by its canvas item id, `lifeos:<id>`, or a
  `.tcsheet` path.
- `dashboard_read {item}`: each block with its id and what it shows.
- `dashboard_refresh {item, values?}`: reads the page again; `values` sets
  figures from a service by their ids.

## Methods

`work.dashboards.{open, refresh, review, remove}` and the `work.dashboards`
push (`src/shared/contract-work-dashboards.ts`). All but `open` are the
owner's. A remote key sees a dashboard only when it could name every file
the page reads itself (`fenceDash`). Each is carried on a relayed lane
(`DASHBOARDS_RELAY` is empty: work.md "The relay").

## Known limits

- Excel files (`.xlsx` packages) and Google sheets are not read yet.
- Nothing pushes when a source sheet moves: the open canvas finds out within
  30 s.
- `work.dashboards.remove` has no control in the canvas yet; he asks the
  thread.
- The chart has no hover readout.
