# Work, made fast: the measuring kit, the budgets, the caches

How Work's speed is measured in the owner's shape, what each thing he does may cost, and the rules every kept
answer follows. The pass that built this is `.temp-code/plans/landed/PERF-work.md`; its baseline is
`.temp-code/plans/perf/BASELINE.md`.

## His shape

He works from the Mac's window and a Windows laptop's, each paired to the box by a remote key over the tunnel.
His six Work workspaces live on the box; his files sit in the box's Windows VM, on his Mac and on the laptop's
drive; LifeOS sits behind Mail, Tasks, Agenda, People and Messages; the box runs 20 to 40 threads. Every data
call from a window is a round trip of tens to hundreds of milliseconds. A thing that is fast on one host can
take seconds there, so nothing here is timed on one host.

Two marks are used everywhere: **T** is one round trip from the window to a host over the link, **C** one from
the window straight to LifeOS.

## The budgets

`scripts/perf/budgets.ts` is the table as data (B01 to B33): what he does, the budget in his words, and the perf
rows that time it. A budget the pair cannot time says why in `off` and names what times it instead (the Windows
rig, the Mac's simulator, the live stall log, Microsoft's own pages). `scripts/perf/perf.test.ts` (a guard test
of the commit gate) holds that every budget has a row that exists or a written reason, and every row a budget.

## The kit: `bun run perf`

```bash
.temp-code/bin/heavy bunx electron-vite build          # the pair runs the built tree
.temp-code/bin/heavy bun run perf --rows 'view-*' --label before
bun run perf --list                                     # the rows, nothing started
```

`scripts/perf/run.ts` stands his shape up on the journeys' own harness (`scripts/journeys/lib/shape.ts`): `win`,
a windowed isolated instance under xvfb driven over CDP, paired by a client key to `box`, a headless isolated
instance that holds the Work workspace, with `desk` as a third machine when a row needs one, and the LifeOS
sandbox when a row needs LifeOS. Each instance has its own data, its own empty `WINVM_DIR` and an environment
stripped to PATH and locale; the kit starts no process of its own but through that harness.

Three things make the pair his shape:

- **The link** (`--link 60/10`, the default; `none` to tell our time from the link's): a relay between `win`
  and `box` with a delay and a rate each way (`startSlowLink`, scripts/lib/slowLink.ts): 60 ms there and back,
  10 Mbit/s. It also counts the wire's own bytes and round trips for each press. It presents the box's own address
  as each connection's Host, as his tunnel's front door does: the box refuses a page's socket whose Host is not its
  own (remote/listener.ts), and without it the window never links.
- **The load** (`--load 40`, the default): stand-in Work threads inside `box`, each a real thread streaming five deltas a
  second from the run's loopback provider (`scripts/perf/lib/load.ts`). It is load inside the isolated
  instance; the run records this machine's own load and the agents' slice beside every number. Only a stand-in's own
  turn streams long (`isLoadTurn`: the load's prompt with the harness's tools); the CLI's side asks about the same
  words get the short answer. The load is split over box's two dummy accounts (`startSplitLoad`): box's gateway keeps
  32 sockets an account to the HTTP/1 loopback provider, so 20 each leaves a row's own thread room.
- **The cores** (`--cores`, the last eight by default, never more): the run pins itself with `taskset`, and
  every process it starts inherits the pin.

A run takes one pair and many rows, and at most `--seconds` (60) of measured work, summed over the presses;
rows past that are written "not run" and the next run takes them (`--rows`, `--shape A,B1,B2`). While it
measures, `lib/guard.ts` asks the LIVE box for its hello every 5 s and stops the run with "the live box slowed"
when two answers in a row pass 800 ms. Never bench against the live service or his data: the guard is the only
thing that touches it, and it only opens a socket.

### What a row records

A row (`scripts/perf/rows/`) is one thing he does, pressed three times with the journeys' own actions. For each
press `lib/probe.ts` keeps:

- **pressed**: stamped in the page by a capture-phase listener on the press itself;
- **first sign**: the first DOM change in the row's region after it;
- **usable**: the row's own predicate, tried each animation frame (rows drawn and no bones; a caret; the first
  page's canvas); all three on the page's clock, so the driver's polling adds nothing;
- **the longest task** between the two (a `PerformanceObserver`);
- **T by method, C, and bytes both ways**, from CDP's Network domain, which sees every WebSocket frame of the
  window: a frame with a `method` on the link to `box` is a T, a frame the window sends LifeOS is a C. Counted
  up to usable, and again for the second after it (what goes on behind the paint).
  A socket is classed by its port (`socketKind`, lib/probe.ts): the link to `box` (the shaped hop's port), LifeOS
  (the front hop's, the backend's behind it, its site) or the window's own host. With `--lifeos` the window reaches
  LifeOS through the front hop, the address its host hands it. The hop's own count (`lifeos: {window, host}`) is of
  round trips, and runs above C: each Pong a socket sends to LifeOS's Ping is a round trip and no ask (20 s idle with
  Mail open: 8 on the hop, C 0).

With `--lifeos 0` the link is slowed and LifeOS is not. The sandbox LifeOS answers from loopback, where his real LifeOS is a round
trip across the internet, so a row's C count says more than its time does: each C is tens of milliseconds more
for him.

Nothing in the product is changed to be measured. A row never asserts a time: times are records, and tests
gate on counts.

Results land in `.temp-code/plans/perf/runs/<run>/results.json`. `bun scripts/perf/table.ts --into <file.md>
--section <name> <results.json…>` sets the middle press of each row beside its budget, between
`<!-- perf:<name> -->` marks, a later run of a row replacing an earlier one.

The rows: `launch`, `return`, `switch-workspace`, `view-<View>` for each view and for Today, Projects (the tracker) and Review
(a view past the column's four daily rows is pressed with the More fold opened first, `revealView`),
`mail-open`, `mail-composer`, `mail-send-later` (a reply's Tomorrow morning in the send menu to its scheduled line,
each press taken back with Undo, so nothing is left scheduled; the sandbox alone), `digest-open` (Settings → Work's
Open the digest to the sheet drawn: the native menu cannot be pressed over CDP), `work-thread-open` (a Work thread's
row in the column to its rows, the first press never seen), `work-search` (Ctrl+Shift+K to its field, then five keys,
each to its rows with every source answered: `keyMs`, `asksPerKey`), `list-`, `back-` and `search-` in A, B1 and B2 (a
300-entry folder in the workspace's folder, in a library on the window's machine, in one on a third machine),
`open-<kind>-<shape>` for a document, a Word file, a workbook, a deck, a PDF, a picture and a video, `stage-word-B2` (a
far Word file's press to its first header line), `tab-<kind>-A` (back to an open file's tab), `saved-text-<shape>`,
`save-as-A` (Save in the sheet, Just a copy ticked, to the sheet closed with the copy on disk: no tab of the new file
opens), `type-long-text-A` (20 keys into a 90,000-character text file, each key to the frame after the editor changed;
`usable` is the p95, `upPerSecond` the bytes sent to box; bytes to main go over IPC, which CDP does not see),
`ask-box`, `ask-first-content`, `reconnect`. The column while 40 threads stream is every `view-*` row: the load runs
under all of them.

In A the save line keeps "Saved" while a write is out and says Saving… only past 600 ms, so `saved-text-A` is the
first key to the answer of the `work.files.write` behind it (`watchAsks`, lib/probe.ts) with the line saying saved; a
copy's line (B1, B2) says "Saving to …" and the row waits for Saved again.

The journeys find a row by its name whole or before the comma that says what it is doing ("Perf 2zlLrP, working",
`Window.centre`). A double-click on a row that opened nothing in 8 s, or a press on the job's folder in the sidebar
that left Home shown, is pressed again, twice at most, and said on the log (`openRow`, `goPlace`): under the load the
first press on the job's folder after the Files view opens leaves Home shown (not yet traced to its cause).

The driver closes a file's tab as he would from the keyboard (`closeSelectedFile`, scripts/journeys/lib/files.ts):
focus on the tab, Ctrl+W, "Close Anyway" or "Discard" if the close asks, a wait on the tab's own id, and, when the tab
stays, what sits over its close button in the error. After every row the run dismisses popups and closes every file
tab (`closeFileTabs`), so one row's leftovers never stand in front of the next; a press that never became usable is
pictured at once, before anything tidies.

A port the kit reserves (`freePort`, scripts/e2e-work-lib.ts) comes from below the kernel's ephemeral range: one taken
by listening on 0 and let go was handed again to `box`'s gateway, which then held `box`'s Work port, and every Work
document read "Offline" (Nov 26).

The table (scripts/perf/table.ts) sets beside each row the longest task in the watch after usable, LifeOS's round
trips by who asked (window / host, where the sandbox sat behind its hop) and, in the Machine column, the link's late
chunks; its "Not timed on the pair" list names only the budgets of the families its runs stood the pair up for.

## The headless host bench

Build the isolated app in the measurement worktree, then run one scene through the box queue while anonymous memory in the agents slice is below 68 GiB. The one-minute load limit defaults to 40 and can be set with `--max-load <n>`.

```sh
.temp-code/bin/heavy bunx electron-vite build
.temp-code/bin/heavy bun run perf:host --scene connect
.temp-code/bin/heavy bun run perf:host --scene loop --browser
bun run perf:host --list
```

The bench pins itself, the headless Electron host, and its children to the last eight allowed CPUs. It makes its own scratch checkout, home, user data, ports, and empty VM folder. It reserves 40 slots and room for fixture harnesses on the scratch host, then checks that all 40 dummy threads are running before it starts the scene. Remote sockets use keys minted by that host. The watchdog sends only hello to the live box. The bench refuses to start above the configured load limit. During the scene it tracks peak load and stops if the watchdog trips, anonymous memory reaches 68 GiB, or I/O pressure passes the plan's limit.

| Scene | What it records |
| --- | --- |
| `connect` (H01) | Connect and focus request times from a remote socket while delayed scratch git reads hold the bulk queue. |
| `loop` (H02) | One minute of delay measured on the host's main loop, with each block over 100 ms. `--browser` opens and reads a local dummy page through the box browser carrier. |
| `read` (H03) | Remote transcript tail, catch-up after a disconnect, and a history page while two peers reconnect. Checks each page against its expected sequence range. |
| `flush` (H04) | Event flushes the stall log records under four CPU burners. The log currently keeps flushes at 50 ms and above, so these times and the reported share cover only logged flushes. Slow disk needs root and is skipped. |
| `settle` (H05) | Blocks over 50 ms in the ten seconds after one signal ends all 40 streams. The result includes any timed causes the stall log names. |
| `watch` (H09) | File pushes to one remote subscriber, folder watches, and blocks over 50 ms while 40 writers make 1,000 changes in scratch worktrees. |
| `--boot` (H06) | Time to the first hello, the first and focused resumed threads, and all 40 resumed threads. The default seed is 48 threads and 6,000 rows. `--seed-size real` uses 2,000 threads and 1,000,000 rows, with 30,000 in the longest thread. |

`--boot --copy <userData>` measures only hello on a scrubbed copy. It needs the scrub tool's marker check and an empty resume ledger. Boot writes to the supplied scratch copy and uses its own HOME, disables the remote listener, and routes model calls to loopback. Before startup it points the copy’s workspace, project and thread paths at missing scratch paths. It restores those paths after Electron stops. It lets the background index finish within the boot window so a second run can time a steady boot. Each result and table includes the one-minute load and agents slice anonymous memory at the start and end. The bench writes results, including failures, under the main checkout's `.temp-code/plans/perf2/runs/host-<scene>-<stamp>.json`.

### The code family (`--family code`)

`bun run perf --family code` stands the pair up for the rest of Docket: Work off, and `box` seeded before it starts by
scripts/perf/seed-box.ts (names in scripts/perf/lib/seedNames.ts): a workspace "Perf code" on a scratch repo of 20,000
files with one project, threads of 30,000 rows (`perf-long`), 2,000 rows and six short ones, and a pinned master with
a batch of 30 children of 100 to 300 rows. The seed's batch keeps the default "When done" steps; its gate step fails
at once on the scratch repo, on the isolated box alone. The 40 stand-ins stream in another workspace.

The rows (scripts/perf/rows/code.ts) press what he presses:

- A code project's threads open from the title bar's tabs (`[data-menu-id=<id>] [role=tab]`); the column's project
  card lists them as words, not rows. A rail row's label is its name then what it is doing ("Perf code, unread"), so
  rows are found by the name before a comma.
- `thread-open-far`, `thread-open-lost`, `thread-open-catchup`: each press starts from a reloaded document that shows a
  short thread, so the long one is never seen. `thread-open-lost` drops the answer to the first `session.events` ask
  for the thread in the page (`WIRE_TAP`, the socket kept open, every other frame passed): an answer lost on a live
  link, which the window's request deadline and the store's retry decide. The link carries the window's socket
  compressed, so the relay cannot drop one frame. `thread-open-catchup` cuts the link 3 s with seven threads kept and
  clicks as it reopens; `askAt` is the click to the thread's `session.events` leaving the page.
- `launch-code`: a reload, to `tc:rail-complete` and the shown long thread's rows drawn; `first` is the first
  contentful paint; `twice` names any ask sent twice with the same params.
- `board-open`: the master's tab to its board drawn (all 30 rows, or the board's screen filled); the first press cold.
- `picker-search`, `picker-file`, `picker-at`, `picker-model`: opened three times inside 30 s, then five keys
  typed, `keyMs` and `asksPerKey` on the last press. Go to File draws no rows before a key, and a fresh profile's model
  picker opens on an empty Favorites list: those opens are timed to the list in hand.
- `window-forward`: under xvfb the OS gives the window its focus and nothing takes it away (CDP's focus emulation
  and `Page.bringToFront` fire no event), so the row dispatches the window's own `blur`, waits 6 s, then `focus`,
  the event its refreshes listen for, and counts the asks of the 2 s after.
- `thread-open-lost` presses again only while its presses so far took under 30 s: today one press takes about 31 s,
  and a run measures 60 s at most.

### Send and the links (`--family code`)

The perf run's provider (`perfProvider`, scripts/perf/lib/load.ts) answers every prompt but a stand-in's turn with
`sendAnswer` (scripts/journeys/lib/fakeProvider.ts): nothing for exactly `FIRST_BYTE_MS` (100 ms), then the
headers and the first chunk together, then three more deltas 20 ms apart. The wait comes before the response: Bun
sends no headers for a stream whose first chunk comes from a timer, and box's gateway gave up on them after 60 s.
The words are the journeys' own reply, led by `Answer-<nonce>` when the prompt carries `PERF-SEND <nonce>`, so a
row can tell this answer from the thread's earlier ones. Our side of send to first token is a row's usable time
less those 100 ms (`ours`). Only a stand-in's own turn (the load's prompt, with tools: `isLoadTurn`) streams for
the run; the title the harness asks beside it answers short. `PERF_PROVIDER_LOG=<file>` writes a line for each
request the provider gets.

**Forty stand-ins on two dummy accounts.** Box's gateway keeps 32 sockets to one origin for one account
(src/main/server/upstream.ts `maxSockets`) and the pair's provider speaks HTTP/1.1, so each streaming stand-in
holds one for its hour, where his provider's HTTP/2 carries them all on one. So the pair seeds box with two dummy
accounts (`open`'s `twoAccounts`, `seedFakeAccount(dir, true)`) and `startSplitLoad` streams half the load in each of
two load workspaces, each pinned to one account (`workspace.setAccounts`), as scripts/perf/host.ts does: 20
sockets an account, room left for a row's send.

- `scripts/perf/rows/send.ts` (G01 to G06): `send-first-token` types a line in a seeded thread and presses Enter
  (three presses: the first harness cold, then live); `send-first-token-new` presses New Thread (Ctrl+N) first.
  A sample keeps his own row on screen (`first`), the answer's first word (`usable`), `ours`, the window's asks
  before the host had the turn (`beforeTurn`, up to the `session.send`), and the host's span for that send read
  from the isolated box's `logs/stalls.log` (`send`: queue, handle-wait, mcp, gateway-dispatch, first-byte,
  first-row and the phases; `handle`: live, warm or cold), and when `session.send` left the window (`sendLeft`).
  `send-at-cap` cannot park his own send (a focused thread's send is admitted over the cap, scheduler.ts) nor free
  a slot by an interrupt (the thread keeps its handle): it pins the cap to the running count, makes a background
  thread and sends its first message on box, then raises the cap by one and times that to the parked turn started
  (box's queued count back to 0), with first content from the host's span.
- `scripts/perf/rows/link.ts` (L01 to L06): `link-open` (a reload: navigation start to the ticket asked and back,
  the socket asked and open, the hello and the link open, from CDP's frames), `reconnect-code` (a 3 s cut while
  box adds a turn: from the socket's open to the thread current), `catchup-40` (six threads open, a 5 s cut while
  the load streams, then back with Retry pressed (`registry.retry`, so catch-up is timed without the redial's
backoff): the 20 s after, the wire's bytes, the transcript asks by mounted, tab, rail and stand-in),
  `stream-under-bulk` (two `fs.read`s of a 1.94 MiB file asked at once beside a streaming thread: the gaps
  between its frames before, and from the frame before the read to the frame after it), `restart-box` (box halted and started again: its hello to the thread
  current; `Pair.restart` takes box, reading its new server.json) and `dead-link` (the hop a black hole: until
  the registry leaves `open`, up to 100 s). The two that stop things run last.
- `scripts/perf/rows/links.ts` (L07 to L09, `needs: { desk: true }`): with Work off the call through box to desk
  is the Mac bridge's `mac.listDir`, from a box thread with the bridge on desk and a folder desk shares with box;
  its token comes from the pair's seed (`TEMP_CODE_MAC_TOKEN_SEED`, isolated instances alone). The box refuses
  it from a window (`mac.listDir is local-only`), so the driver asks box over loopback: one shaped leg, box to desk.
  `peer-call` (ten listings of a one-file folder a press), `far-folder` (one of 300), `peer-relink` (desk's hop
  cut 3 s: to registered again, then the first call). A sample says `legs: 1` when the box would not take the
  call from the window and the driver asked it over loopback. `search-hosts` (L11): the window saves desk as a
  second host by a key minted on desk, behind a shaped hop of its own (the desktop window reaches no host through
  the box, so desk's hop to box is not on its way); with Search open and "fold" typed, that hop is stalled 5 s and
  the last key pressed: the key to the first rows, and to the settled state (no host still searching).

`scripts/perf/lib/frames.ts` (`WireLog`) keeps every WebSocket event of the window with CDP's own times on the
epoch clock, for the rows that need more than the probe's counts. L10 is `off` in budgets.ts, with why.

## Costs a screen pays only when something moved (Nov 26, perf2 M11)

- **The tracker** (work/tracker/data.ts) reads `work.projects.overview` through `lib/quietPoll.ts`: once on show, a
  minute after its last read, never while the window is hidden, on a focus only when no read began in the last
  minute, at once on a roster change. Its due words move on the window's one minute clock (`useMinuteClock`).
- **The job column's archived row** (work/shell/WorkColumnRows.tsx `archivedWatch`) runs `archivedThreads` only when a
  change touches an archived thread (one archived now, or one in its last answer) or the catalog moves; its answer is
  compared by id.
- **A Work thread's head** asks `work.threads.record` at once on open, then joins every change inside 500 ms to one
  ask at the span's end (`HEAD_JOIN_MS`), `fresh` when LifeOS's task pulse moved among them (the host's 60 s cache stands).
- **The text journal** (work/files/fileSession.ts) copies the text to main at once after a quiet spell, then at most
  once every 250 ms for any size (`JOURNAL_MS`), the last edit written before a save or a close. The save line reads the
  host's write alone; a crash inside a span keeps the key before it.
- **Live Office's ask** (`useLiveOf`) retries after 2, 5, 15 and 30 s, then waits for a window focus or the link opening.
- **A parked Forms carrier** waits on `onOwnerTakes` (browser/drive.ts), not a database read every 5 s.
- **Kept by item, gone with it**: a picture's fit (media/MediaCanvas.tsx, `forgetWithItems`), a document's last store
  time once each of its items has closed (docs/host.ts), and on the host a Google deck's read times once its poll lets
  the deck go (google/deckMirror.ts, `onUnwatched`). `farLink`'s `made` is one entry a far desktop, replaced when its
  route moves: not by item, bounded by the hosts.

## The pass's numbers

Before (Nov 24, 7633505ea) and after (Nov 25, 49bedd5e8 with the kit's Host fix) sit side by side in
`.temp-code/plans/perf/BASELINE.md` ("before-slowed", "after-slowed"); `.temp-code/plans/landed/PERF-work.md` sets
each budget's before beside its after. The three far rows the Nov 25 pass could not time (`open-word-B1`,
`open-word-B2`, `open-deck-B2`) time again since the driver closes a tab with Ctrl+W; the Nov 26 pass is
`.temp-code/plans/perf2/BASELINE.md`.
