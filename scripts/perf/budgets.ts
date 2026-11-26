/**
 * The budgets, as data: what he does, how long it may take from his press to a thing he can use, and the perf
 * rows that time it on the pair (scripts/perf/rows). A budget the pair cannot time says why in `off` and where
 * its number comes from instead. B01 to B33 are Work's (`.temp-code/plans/perf/BASELINE.md`); D (the window), H
 * (the host), G (send to first token), L (the links) and P (pictures) are the rest of Docket's
 * (`.temp-code/plans/perf2/BASELINE.md`, docs/agents/docket-perf.md). scripts/perf/perf.test.ts holds the table
 * and the rows in step: every budget has a row or a reason.
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
  { id: 'B33', what: 'Open Projects, the tracker across jobs', budget: '300 ms kept; 1.5 s cold', ms: 300, rows: ['view-Projects'] },

  // The window.
  { id: 'D01', what: 'Launch to a window painted, and to usable, on real-size data', budget: 'painted 1 s after spawn; usable 2.5 s', ms: 2500, rows: ['launch-code'], off: 'Real-size data and a process spawn: scripts/launch-timing-linux.ts on the scrubbed copy (`--copy`), under scripts/perf/guarded.ts. Row `launch-code` times the window\'s document on the seeded pair (a reload: the main process is up), its `first` the first contentful paint.' },
  { id: 'D02', what: 'The rail whole at launch with a slow host', budget: '50 ms', ms: 50, rows: [], off: 'scripts/e2e-launch-mirror.ts times it (`tc:rail-complete`): the rail paints from the mirror before any host answers.' },
  { id: 'D03', what: 'Asks a host gets at window open, before usable', budget: '15 at most, none twice', rows: ['launch-code'] },
  { id: 'D04', what: 'Open a box thread not yet seen: to rows he can read', budget: 'middle 600 ms, p95 1.2 s; 1 transcript ask, 1 MiB at most', ms: 600, rows: ['thread-open-far'] },
  { id: 'D05', what: 'After that open: no freeze', budget: 'no task over 100 ms in the 15 s after', rows: ['thread-open-far'] },
  { id: 'D06', what: 'The same open with one answer lost', budget: 'rows within 10 s', ms: 10_000, rows: ['thread-open-lost'] },
  { id: 'D07', what: 'The same open while the window catches up after a cut', budget: 'the shown ask starts within 50 ms of the click; p95 1.5 s', ms: 1500, rows: ['thread-open-catchup'] },
  { id: 'D08', what: 'Switch to a thread seen (a tab or a rail row)', budget: 'middle 80 ms, p95 150 ms; no asks but session.focus', ms: 80, rows: ['thread-switch'] },
  { id: 'D09', what: 'Switch workspace; switch project', budget: 'p95 100 ms; 80 ms', ms: 100, rows: ['project-switch'] },
  { id: 'D10', what: "Open a master's board of 30 children", budget: 'render 50 ms; answer 150 ms warm, 400 ms cold', ms: 150, rows: ['board-open'] },
  { id: 'D11', what: 'A stream into a long live turn (30,000 rows on screen, 40 threads running)', budget: 'no task over 50 ms; 4 ms of main thread a frame at p95', rows: [], off: "The renderer soak's `--scene long` times it (scripts/measure-renderer-soak.ts)." },
  { id: 'D12', what: 'Scroll a long transcript; to its top; jump to an old hit', budget: "90% of the display's rate, no frame over 32 ms; a page 16 ms of main thread; the hit lands within 2 s", rows: [], off: "The renderer soak's `--scene long` (top, jump) and `--scene scroll`." },
  { id: 'D13', what: 'Type in the composer', budget: 'p95 16 ms idle, 33 ms busy', rows: [], off: "The renderer soak's `--scene typing`, a gate row." },
  { id: 'D14', what: 'Send into a long thread: his row on screen', budget: 'p95 50 ms', ms: 50, rows: [], off: "The renderer soak's `--scene send`." },
  { id: 'D15', what: 'Open a picker (Search, Go to File, the model picker, / and @)', budget: 'first rows 100 ms; @ in 20,000 files 300 ms cold; no ask on an open within 30 s of the last', ms: 100, rows: ['picker-*'], off: 'The `/` menu is not timed: its list is the skills and commands the host reads (`commands.list`, 30 s kept), not a picker over the project.' },
  { id: 'D16', what: 'Type in a picker', budget: 'a key to its rows p95 50 ms; one host ask for 150 ms of typing at most', ms: 50, rows: ['picker-*'] },
  { id: 'D17', what: 'Idle with 40 threads running: focused, visible behind another app, hidden', budget: '5%, 3%, 1% of a core; running animations no more than working rows on screen', rows: [], off: "The renderer soak's `--scene idle` (CPU and animations a phase)." },
  { id: 'D18', what: 'The window over a long day, compressed: ten threads opened and left while 40 stream', budget: 'heap after GC no more than 6 MB up; loaded transcripts no more than mounted, 6 kept and those on screen; raw rows kept under a stated cap', rows: [], off: "The renderer soak's `--scene day` and M8's unit counts." },
  { id: 'D19', what: 'Bring the window forward', budget: '5 asks a host at most; 1 git.diffIndex a checkout, none within 5 s of the last; no long task', rows: ['window-forward'] },
  { id: 'D20', what: 'The rail and the chrome while 40 threads run: one meta push for a thread not on screen', budget: '2 ms a flush at p95; 3 components rendered at most; no pass over all threads', rows: [], off: "The renderer soak's `--scene idle` (ms a flush and renders a push)." },

  // The host.
  { id: 'H01', what: 'Each ask a window makes on connect and focus, 40 threads running, queues starved', budget: 'p95 200 ms, none over 500 ms', rows: [], off: 'scripts/perf/host.ts `--scene connect`: a headless pair, no window.' },
  { id: 'H02', what: 'The loop', budget: 'none of 1 s; under 10 of 400 ms an hour; with the box browser up, none over 100 ms', rows: [], off: 'scripts/perf/host.ts `--scene loop` (`--browser`), and the live stall log through scripts/perf/stall-report.ts.' },
  { id: 'H03', what: 'A transcript tail, a resume and a history page for a remote window, two peers reconnecting', budget: 'p95 300 ms, none over 500 ms; rows once, in order', rows: [], off: 'scripts/perf/host.ts `--scene read`.' },
  { id: 'H04', what: "An event flush's share of the loop under four builds or a slow disk", budget: 'p99 20 ms, worst 100 ms; with a 2 s disk the hello stays under 500 ms', rows: [], off: 'scripts/perf/host.ts `--scene flush`, and the flush lines of the live stall log.' },
  { id: 'H05', what: 'Book-keeping when 40 threads settle together', budget: 'no slice of the loop over 50 ms', rows: [], off: 'scripts/perf/host.ts `--scene settle`.' },
  { id: 'H06', what: 'Boot on real-size data: process to hello; to the first focused thread resumed; to all resumed', budget: '5 s; 8 s; 30 s for 40 under the cap', rows: [], off: 'scripts/perf/host.ts `--boot`: hello on the scrubbed copy, resume on a seeded database of stand-ins alone.' },
  { id: 'H07', what: 'A deploy', budget: 'a time by step first; then a target (for the owner)', rows: [], off: "Root's own log: box-update prints no step times the service account can read. M10 writes the change that would time it into ROOT.md." },
  { id: 'H08', what: 'A query on real-size data (list, search, review, the scans the code predicts)', budget: "no plan with a scan of sessions or events on an ask's path", rows: [], off: 'Query plans and the benches on the scrubbed copy (M9), never the live database.' },
  { id: 'H09', what: 'File watches and the guard with 40 threads writing in their worktrees', budget: 'watches one a folder, never into a worktree; 1,000 file changes cost one coalesced push a window and no slice of the loop over 50 ms', rows: [], off: 'scripts/perf/host.ts `--scene watch`.' },

  // Send to first token.
  { id: 'G01', what: 'Send in a thread: round trips before the host has the turn', budget: '1', rows: [], off: 'Rows `send-first-token` and `send-at-cap` are still to be written.' },
  { id: 'G02', what: 'Host has the turn to the harness has his words: live, warm, cold', budget: "100 ms; 500 ms; 1.5 s with the app's own servers", rows: [], off: "The send span's stamps in the isolated host's stalls.log, read by scripts/perf/stall-report.ts during the send rows." },
  { id: 'G03', what: 'The gateway: body in to request out; first byte in to first byte out', budget: '25 ms; 15 ms', rows: [], off: "The gateway's own stamps, on its hourly line and in doctor.get; read by scripts/perf/stall-report.ts." },
  { id: 'G04', what: "The provider's first byte to a token on screen, focused, 60 ms link", budget: '150 ms', rows: [], off: "The send span's first-byte stamp set beside the send rows' usable time." },
  { id: 'G05', what: 'All of it with a fake provider that answers in 100 ms', budget: 'our side 600 ms warm, 1.6 s cold', ms: 600, rows: [], off: 'Row `send-first-token` is still to be written.' },
  { id: 'G06', what: 'A send at the running cap, once a slot frees', budget: '400 ms to start', ms: 400, rows: [], off: 'Row `send-at-cap` is still to be written.' },

  // The links.
  { id: 'L01', what: "A saved host's link: ticket, socket, hello", budget: 'hello 750 ms p95 on the shaped link', ms: 750, rows: [], off: 'Row `link-open` is still to be written.' },
  { id: 'L02', what: 'Reconnect after a cut: the shown thread current', budget: '2 s after the socket', ms: 2000, rows: [], off: 'Row `reconnect-code` is still to be written.' },
  { id: 'L03', what: 'After the box restarts: the shown thread current', budget: '5 s after the box answers', ms: 5000, rows: [], off: 'Row `restart-box` is still to be written.' },
  { id: 'L04', what: 'A link that died without a close (sleep, Wi-Fi) is noticed', budget: '20 s when the window is visible', ms: 20_000, rows: [], off: 'Row `dead-link` is still to be written.' },
  { id: 'L05', what: 'Catch-up of 40 threads after a cut', budget: 'no task over 100 ms; 2 MiB unsent at most; every row once, in order; threads only in the rail fetch nothing', rows: [], off: "Row `catchup-40` is still to be written; the soak's `--scene reconnect` holds rows once and in order." },
  { id: 'L06', what: 'The focused stream while a big frame is in flight, under jitter', budget: "time between the focused thread's frames p95 250 ms", ms: 250, rows: [], off: 'Row `stream-under-bulk` is still to be written.' },
  { id: 'L07', what: 'A call through the box to a third host, small', budget: 'p95 the two legs plus 60 ms', rows: [], off: 'Row `peer-call` (scripts/perf/rows/links.ts) is still to be written.' },
  { id: 'L08', what: 'A peer link back after a drop: registered; first small call', budget: '1.5 s; 350 ms', ms: 1500, rows: [], off: 'Row `peer-relink` is still to be written.' },
  { id: 'L09', what: "A far file's first progress; a far folder of 300", budget: '1.5 s; 1.5 s', ms: 1500, rows: [], off: 'Rows `far-progress` and `far-folder` are still to be written; the mapped drive itself needs the Windows rig.' },
  { id: 'L10', what: 'A code-only offer: announced to staged', budget: "the link's own time for the bytes ×1.25, plus 5 s", rows: [], off: "Row `code-stage` is still to be written; the signed trial is the Mac's e2e-code-update." },
  { id: 'L11', what: 'Search across hosts with one slow host', budget: 'first rows 500 ms after the last key; the slow host never holds the rest past 2 s', ms: 500, rows: [], off: 'Row `search-hosts` is still to be written.' },
  { id: 'L12', what: 'The phone comes forward on a kept thread', budget: 'kept rows 250 ms; current 2 s; 1 ask for the shown thread', rows: [], off: "The asks are counted on the box's iOS test server (scripts/ios-client-test-server.ts); the two times need the simulator, on the Mac." },

  // Pictures.
  { id: 'P01', what: "A box page's picture: first frame, warm and cold", budget: '400 ms; 1.5 s', ms: 400, rows: [], off: 'scripts/e2e-box-video.ts times video.open to the first frame.' },
  { id: 'P02', what: 'Watching it move', budget: '100 fps and more, capture to relay p95 15 ms: holds', rows: [], off: 'scripts/e2e-box-video.ts and scripts/e2e-video-viewer.ts.' },
  { id: 'P03', what: 'He hides the window or leaves the page', budget: 'stream closed in 1.5 s, engine gone in 61 s, every viewer', rows: [], off: 'scripts/e2e-box-video.ts, and the hidden-document tests of each viewer.' },
  { id: 'P04', what: 'The box browser left alone', budget: 'nothing left 11 min after the last use', rows: [], off: "A fake clock test of the box browser's idle stop (M12); 11 minutes is past a bench's time." },
  { id: 'P05', what: 'The VM: wake, a door call, pointer and key delay, resize', budget: '15 s to a frame; 300 ms; 15 ms and 75 ms p95; 500 ms', rows: [], off: 'Needs a Windows VM and the master\'s yes: scripts/perf/vm-screen-bench.ts on a scratch machine, never the standing one.' }
]

/** Whether a row id times a budget: `view-*` names every row that starts `view-`. */
export const covers = (pattern: string, row: string): boolean =>
  pattern.endsWith('*') ? row.startsWith(pattern.slice(0, -1)) : pattern === row

/** The budgets a row times. */
export const budgetsOf = (row: string): Budget[] => BUDGETS.filter((b) => b.rows.some((pattern) => covers(pattern, row)))
