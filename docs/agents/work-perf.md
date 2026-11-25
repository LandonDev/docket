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

`scripts/perf/budgets.ts` is the table as data (B01 to B32): what he does, the budget in his words, and the perf
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
  10 Mbit/s. It also counts the wire's own bytes and round trips for each press.
- **The load** (`--load 24`): stand-in Work threads inside `box`, each a real thread streaming five deltas a
  second from the run's loopback provider (`scripts/perf/lib/load.ts`). It is load inside the isolated
  instance; the run records this machine's own load and the agents' slice beside every number.
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

The link is slowed; LifeOS is not. The sandbox LifeOS answers from loopback, where his real LifeOS is a round
trip across the internet, so a row's C count says more than its time does: each C is tens of milliseconds more
for him.

Nothing in the product is changed to be measured. A row never asserts a time: times are records, and tests
gate on counts.

Results land in `.temp-code/plans/perf/runs/<run>/results.json`. `bun scripts/perf/table.ts --into <file.md>
--section <name> <results.json…>` sets the middle press of each row beside its budget, between
`<!-- perf:<name> -->` marks, a later run of a row replacing an earlier one.

The rows: `launch`, `return`, `switch-workspace`, `view-<View>` for each view and for Today and Review,
`mail-open`, `mail-composer`, `list-`, `back-` and `search-` in A, B1 and B2 (a 300-entry folder in the
workspace's folder, in a library on the window's machine, in one on a third machine), `open-<kind>-<shape>` for
a document, a Word file, a workbook, a deck, a PDF, a picture and a video, `tab-<kind>-A` (back to an open
file's tab), `saved-text-<shape>`, `ask-box`, `ask-first-content`, `reconnect`.

## The live box, read only

`stalls.log` is his real use. `bun scripts/perf/stall-report.ts [--since <ISO>] [--until <ISO>] <stalls.log…>`
prints the baseline's section 3: the loop's stalls, the sections that held the loop, Work's slow calls (by
`place=` for Files, with the `wake=` waits on the VM's door), a new thread's first content by handle, and from
the hourly `work-calls` lines each `work.*` method's share that was slow. "Before" and "after" on the live box
is this command over the hours each side of a deploy. The log's words are in docs/box.md ("The stall log names
the next queue itself").

`scripts/bench-pc-drive.ts` (docs/agents/pc-setup.md "The drive bench") times the laptop's mapped drive in the
Windows rig; it and the rig run only while the agents' slice holds under its memory line.

## Code that loads only where it is used

- **A view whose code is in hand draws in its first commit.** The view frame (work/shell/WorkViewPage.tsx) takes
  the view from its loaded chunk, never a fresh `React.lazy`: a lazy suspends once even when loaded, and React
  holds content back 300 ms after a skeleton. Every switch to a view he had seen cost that (317 ms on the pair).
- **A job's other views are warmed behind the one shown**, one at a time in idle slots, in the column's order
  (`preloadInTurn`, lib/lazyChunk.tsx; `viewChunksAfter`, work/views/registry.ts), so a first press of a view
  finds its code and draws at once too. Never two chunks parsing together; a chunk already asked for is passed
  over.
- **Money's chart is a chunk of its own** (`monthBarsChunk`, work/money/monthBarData.ts): the ledger's first open
  carries no recharts (667 kB), and the year's section keeps the chart's box while it loads, so nothing moves.
  scripts/viewGraphs.test.ts holds it on the source.
- **The orchestration rules as plain values** (src/shared/rulesValues.ts): the window's two readers of them no
  longer reach the zod schemas in src/shared/rules.ts. The same for the computer step words the transcript draws:
  `computer/protocolValues.ts` (the action names, the no-input actions, the observation's text limits),
  `computer/confirmSchema.ts` (the confirmation's schema, apart from policy.ts) and `computer/waitedWords.ts` keep
  protocol.ts, descriptions.ts and their schemas out of the first paint; all four schema files are on
  `NEVER_IN_ENTRY` (scripts/check-bundle-size.ts), held on the source by scripts/entryGraph.test.ts. zod itself is still in the first paint by 17 other
  modules (listed in `.temp-code/plans/landed/PERF-work.md` "For the owner").

## Small asks no one needed (M15)

- **The host**: six of Work's queries are index searches (docs/box.md "Work's indexes"); the Work switch is kept in
  memory and dropped by any write of it; `work.health` runs each check once for asks that come together and answers
  from its report for 10 s (`{fresh: true}` is his Check again).
- **The catalog**: every scope's thread defaults in one `defaults.list` where the host names it (3 round trips a
  refresh, not 3 + W).
- **Review**: the first week is asked once, after the zone is known (it was asked in the window's zone and again in
  the host's), and a week is told seen once a run, not on every open.
- **People**: a person's page is asked of LifeOS once, with the guest links in hand, and the host's guest links are
  read once in `GUEST_LINKS_KEEP_MS` (30 s) a host, dropped with Work off.
- **Connections** opens on each host's last report, every row still checking, rather than bones for up to 25 s;
  the page's open may take the host's report of the last 10 s, his Check again, a row's Retry and a LifeOS change
  ask `{fresh: true}`. **Plays** opens on the workspace's plays as last read (16 workspaces at most). Both kept in
  the window's memory alone and dropped with Work off. Money's last answer is M10's (its read hook moves there).
- Not done: Tasks' links in one query (needs a LifeOS function, `workLinks:byEntities`); Forms' list asked twice
  (the Forms thread's file, in its note `.temp-code/plans/perf/FOR-msforms.md`).

