/**
 * Work's budgets, as data: what he does, how long it may take from his press to a thing he can use, and the perf
 * rows that time it on the pair (scripts/perf/rows). A budget the pair cannot time says why in `off` and where
 * its number comes from instead. `.temp-code/plans/perf/BASELINE.md` section 2 is this table with today's
 * numbers; scripts/perf/perf.test.ts holds the two in step: every budget has a row or a reason.
 */
export interface Budget {
  id: string
  what: string
  /** the budget in his words */
  budget: string
  /** pressed to usable, in ms, where one number says it (the first of a pair: kept rows, the local place) */
  ms?: number
  /** the perf rows that time it; a `*` stands for each shape or view the row runs in */
  rows: string[]
  /** why the pair cannot time it, and what does */
  off?: string
}

export const BUDGETS: Budget[] = [
  { id: 'B01', what: 'Launch to a Work window he can use', budget: '2.5 s', ms: 2500, rows: ['launch'] },
  { id: 'B02', what: 'Return to a workspace on its view, thread and places', budget: '300 ms', ms: 300, rows: ['return'] },
  { id: 'B03', what: 'Switch workspace', budget: '300 ms to rows he has seen; 1 s never seen', ms: 300, rows: ['switch-workspace'] },
  { id: 'B04', what: 'Switch view', budget: '150 ms to kept rows; 800 ms first time', ms: 150, rows: ['view-*'] },
  { id: 'B05a', what: "List a folder in the workspace's own folder", budget: '300 ms', ms: 300, rows: ['list-A'] },
  { id: 'B05b', what: 'List a folder in a VM library', budget: '800 ms awake; asleep, rows or the true state within 300 ms', ms: 800, rows: [], off: 'The pair has no Windows VM (each instance gets an empty WINVM_DIR). The rig\'s standing stand-in on dummies under the memory line, and the live stall log\'s `place=vm` lines (stall-report).' },
  { id: 'B05c', what: "List a folder in a library on another computer", budget: '1 s', ms: 1000, rows: ['list-B1', 'list-B2'] },
  { id: 'B05d', what: "List a folder on the laptop's drive (300 entries)", budget: '1.5 s', ms: 1500, rows: [], off: 'A mapped drive needs the Windows rig: scripts/bench-pc-drive.ts, under the memory line.' },
  { id: 'B06', what: 'Back to a folder seen', budget: '100 ms, and no far call behind it', ms: 100, rows: ['back-A', 'back-B1', 'back-B2'] },
  { id: 'B07', what: 'Open a document', budget: '1 s', ms: 1000, rows: ['open-document-*', 'tab-document-A'] },
  { id: 'B08', what: 'Open a Word file', budget: '2.5 s; far: a stage line within 300 ms, usable within the link\'s time plus 2 s', ms: 2500, rows: ['open-word-*'] },
  { id: 'B09', what: 'Open a workbook; return to its tab', budget: '2 s; 200 ms', ms: 2000, rows: ['open-workbook-*', 'tab-workbook-A'] },
  { id: 'B10', what: 'Open a deck: first slide', budget: '2 s', ms: 2000, rows: ['open-deck-*', 'tab-deck-A'] },
  { id: 'B11', what: 'Open a PDF: first page', budget: '1.5 s', ms: 1500, rows: ['open-pdf-*', 'tab-pdf-A'] },
  { id: 'B12', what: "Open an image; a video's first frame", budget: '0.7 s; 1.5 s', ms: 700, rows: ['open-image-*', 'open-video-*'] },
  { id: 'B13', what: 'Stop typing to "saved"', budget: 'document 1.5 s; sheet 1 s; deck 3 s; Word in Teams 5 s', ms: 1500, rows: ['saved-text-*'] },
  { id: 'B14', what: 'Save As', budget: '2 s', ms: 2000, rows: [], off: 'Not timed on the pair in this pass: Save As is a dialog of several presses, and its far half is M8\'s count tests. Listed as unproven.' },
  { id: 'B15', what: 'Search and Go to', budget: 'first results 300 ms, all 2 s; Go to 150 ms a key', ms: 300, rows: ['search-A', 'search-B1', 'search-B2'] },
  { id: 'B16', what: 'Open Mail', budget: '300 ms kept; 1 s fresh', ms: 300, rows: ['view-Mail'] },
  { id: 'B17', what: 'Open a mail', budget: '300 ms', ms: 300, rows: ['mail-open'] },
  { id: 'B18', what: 'Open the composer', budget: '200 ms', ms: 200, rows: ['mail-composer'] },
  { id: 'B19', what: 'Send later: pressed to its line', budget: '500 ms', ms: 500, rows: [], off: 'Send later ends in a held send on LifeOS\'s own timer; the journeys prove it (J34) and no perf row presses a send.' },
  { id: 'B20', what: 'Ask beside a file: to a box he can type in', budget: '100 ms', ms: 100, rows: ['ask-box'] },
  { id: 'B21', what: 'Send to first token', budget: '2.5 s', ms: 2500, rows: ['ask-first-content'] },
  { id: 'B22', what: 'Streaming', budget: 'no task over 50 ms; 55 frames a second', rows: [], off: 'The renderer soak times it (scripts/measure-renderer-soak.ts); every perf row also records its longest task.' },
  { id: 'B23', what: 'Open Today', budget: '300 ms kept; 1.5 s cold', ms: 300, rows: ['view-Today'] },
  { id: 'B24', what: 'Open the Digest', budget: '300 ms', ms: 300, rows: [], off: 'The Digest opens from its toast or the menu; its store paints first (CODE). Not timed on the pair in this pass.' },
  { id: 'B25', what: 'Open a held item; press Send', budget: '300 ms; the row answers within 100 ms', ms: 300, rows: ['view-Outbox'], off: 'The Outbox is timed; a held item\'s Send is never pressed by a bench.' },
  { id: 'B26', what: 'Make a Microsoft form', budget: '10 s, with a stage line within 300 ms', rows: [], off: "Microsoft's own pages, driven by the box's browser: the Forms thread's proof with counters, and `work.msforms.make` in the live stall log." },
  { id: 'B27', what: 'Open a form in a tab', budget: '3 s', rows: [], off: "Microsoft's own pages: as B26." },
  { id: 'B28', what: "Read a form's answers", budget: '15 s changed; 3 s unchanged', rows: [], off: "Microsoft's own pages: as B26." },
  { id: 'B29', what: 'The phone: list a folder; first page of a file', budget: '1 s; 2 s', rows: [], off: 'The phone runs on the Mac\'s simulator: scripts/e2e-phone-hosted.ts through a Mac child.' },
  { id: 'B30', what: 'What a window asks on connect and focus, under load', budget: '500 ms each', rows: ['reconnect'], off: 'The live box\'s own answers are read with tc-local (the kit\'s guard times `--hello` every 5 s).' },
  { id: 'B31', what: 'Reconnect: the shown view current', budget: '2 s after the socket; 5 s after a restarted box answers', ms: 2000, rows: ['reconnect'] },
  { id: 'B32', what: "The server's loop", budget: 'no stall of 1 s; under 10 of 400 ms an hour at 30 threads', rows: [], off: 'The live stall log: scripts/perf/stall-report.ts.' },
  { id: 'B33', what: 'Open Projects, the tracker across jobs', budget: '300 ms kept; 1.5 s cold', ms: 300, rows: ['view-Projects'] }
]

/** Whether a row id times a budget: `view-*` names every row that starts `view-`. */
export const covers = (pattern: string, row: string): boolean =>
  pattern.endsWith('*') ? row.startsWith(pattern.slice(0, -1)) : pattern === row

/** The budgets a row times. */
export const budgetsOf = (row: string): Budget[] => BUDGETS.filter((b) => b.rows.some((pattern) => covers(pattern, row)))
