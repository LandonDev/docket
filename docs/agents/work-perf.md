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

The rows: `launch`, `return`, `switch-workspace`, `view-<View>` for each view and for Today, Projects (the tracker) and Review,
`mail-open`, `mail-composer`, `list-`, `back-` and `search-` in A, B1 and B2 (a 300-entry folder in the
workspace's folder, in a library on the window's machine, in one on a third machine), `open-<kind>-<shape>` for
a document, a Word file, a workbook, a deck, a PDF, a picture and a video, `tab-<kind>-A` (back to an open
file's tab), `saved-text-<shape>`, `ask-box`, `ask-first-content`, `reconnect`.

## The headless host bench

Build the isolated app in the measurement worktree, then run one scene through the box queue while anonymous memory in the agents slice is below 68 GiB. The one-minute load limit defaults to 40 and can be set with `--max-load <n>`.

```sh
.temp-code/bin/heavy bunx electron-vite build
.temp-code/bin/heavy bun run perf:host --scene connect
.temp-code/bin/heavy bun run perf:host --scene loop --browser
bun run perf:host --list
```

The bench pins itself, the headless Electron host, and its children to the last eight allowed CPUs. It makes its own scratch checkout, home, user data, ports, and empty VM folder. It gives the scratch host a cap of 40 and checks that all 40 dummy threads are running before it starts the scene. Remote sockets use keys minted by that host. The watchdog sends only hello to the live box. The bench stops if the watchdog trips, one-minute load passes the configured limit, anonymous memory reaches 68 GiB, or I/O pressure passes the plan's limit.

| Scene | What it records |
| --- | --- |
| `connect` (H01) | Connect and focus request times from a remote socket while delayed scratch git reads hold the bulk queue. |
| `loop` (H02) | One minute of delay measured on the host's main loop, with each block over 100 ms. `--browser` opens and reads a local dummy page through the box browser carrier. |
| `read` (H03) | Remote transcript tail, catch-up after a disconnect, and a history page while two peers reconnect. Checks each page against its expected sequence range. |
| `flush` (H04) | Event flushes the stall log records under four CPU burners. The log currently keeps flushes at 50 ms and above, so these times and the reported share cover only logged flushes. Slow disk needs root and is skipped. |
| `settle` (H05) | Blocks over 50 ms in the ten seconds after one signal ends all 40 streams. The result includes any timed causes the stall log names. |
| `watch` (H09) | File pushes to one remote subscriber, folder watches, and blocks over 50 ms while 40 writers make 1,000 changes in scratch worktrees. |
| `--boot` (H06) | Time to the first hello, the first and focused resumed threads, and all 40 resumed threads. The default seed is 48 threads and 6,000 rows. `--seed-size real` uses 2,000 threads and 1,000,000 rows, with 30,000 in the longest thread. |

`--boot --copy <userData>` measures only hello on a scrubbed copy. It needs the scrub tool's marker check and an empty resume ledger. Boot writes to the supplied scratch copy and uses its own HOME, disables the remote listener, and routes model calls to loopback. Each result and table includes the one-minute load and agents slice anonymous memory at the start and end. The bench writes results, including failures, under the main checkout's `.temp-code/plans/perf2/runs/host-<scene>-<stamp>.json`.

## The pass's numbers

Before (Nov 24, 7633505ea) and after (Nov 25, 49bedd5e8 with the kit's Host fix) sit side by side in
`.temp-code/plans/perf/BASELINE.md` ("before-slowed", "after-slowed"); `.temp-code/plans/landed/PERF-work.md` sets
each budget's before beside its after. Three far rows did not time after: the driver's close of a far Word tab
(`closeSelectedFile`, scripts/journeys/lib/files.ts) times out since the Files tabs changed on Nov 24.

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
- **Mail's composer and its day pickers load apart** (work-kit 0a924bd, `compose/later-composer.tsx`,
  `later-parts.tsx`): the mailbox's own code reaches no Tiptap, ProseMirror or react-day-picker, each part's code
  starts once the mailbox is drawn and the browser is idle, and a press before then draws the part's frame and
  bones. work-kit's `mail/later.test.ts` holds it (scripts/entry-graph.ts stops at a package). Mail's first open
  went from 3,084 kB past the first paint to 1,726 kB on the built chunks.
- **The raw-HTML parser stays in the first paint**: streamdown bundles rehype-raw into its own module, so it cannot
  leave without forking streamdown.

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

## What the window keeps over a long day (M12)

- Face pictures: the 120 drawn last, each dropped blob let go (`FACES_KEPT`, work/mail/face.tsx).
- Thumbnails: 600 pictures and 16 million characters at most, a picture on screen never dropped (`THUMBS_CHARS`,
  work/files/previews.ts).
- History: 20 compares no screen shows (`COMPARES_KEPT`, work/history/store.ts).
- What a canvas kind keeps of an item goes when the item closes (`forgetWithItems`, work/canvas/gone.ts): decks,
  dashboards, forms, slides, as PDFs and sheets already did.
- A live Office page hidden an hour with no show unloads through Word's own unload (`HIDDEN_UNLOAD_MS`,
  work/office/live/layer.ts), except the one he looked at last, which no timer lets go; `MOST_LOADED` still bounds
  the count.
- The React Compiler's refusals under work/ only go down: `scripts/react-compiler-ratchet.json` (321 on Nov 25; ui:preview pages are not counted),
  held by scripts/compilerRatchet.test.ts in the commit gate's guards (`bun scripts/react-compiler-tally.ts --only
  work --check`, about 13 s).

## Lists, renders and the minute over a long day (M12, first line)

- **Long lists.** People, Tasks (each group), Agenda (each day) and the Money ledger each draw their rows through one
  part, src/renderer/src/chrome/windowedRows.tsx: up to 80 rows (`PLAIN_MOST`, the Files list's line) drawn whole;
  past it only the rows near the screen are mounted inside the view's own scroller (`WindowedRows`, over the rail's
  `VirtualRows`), each row saying its place in the whole list (`aria-posinset` of `aria-setsize`), the list keeping
  its role and the arrow keys' order. The ledger stays a table: the rows near the screen between two spacer rows
  hidden from a screen reader, with `aria-rowcount` on the table and `aria-rowindex` on each row
  (`WindowedTableRows`). Rows are measured by the ResizeObserver alone, never by reading a rect.
- **A keyed keeper before each list** (`useKeptRows`, work/windowed.tsx): a push answers the whole list again with
  new objects; a row that holds what it held (its JSON) is handed its old object, so its memoised row does not draw.
  Rows are handed their words (a stamp, a due time), not the clock. Today keeps its rows the same way
  (today/stable.ts), and a conversation its blocks (`keepBlocks`, messages/Conversation.tsx).
- **One minute clock** (`useMinute`, work/tasks/minute.ts): one timer for the window however many readers (Tasks,
  Agenda, Today, Prep, the column's facts, Messages, the Digest), armed for the next minute's boundary while any reads
  it and stopped with the last; once the minute has turned the next read moves it, so a reader mounting then reads the
  new minute.
- **The browser canvas and the Computer section** read their thread's tree through a selector over the session store
  (`useTreeKey`, work/browser/BrowserCanvas.tsx; `useLiveTree`, lib/computerSection.ts): a push for a thread outside
  the tree draws neither.
- Tests (counts): people/peopleList, tasks/tasksList, money/ledgerList, messages/minute, tasks/minute,
  browser/BrowserCanvas and today/sources (`.dom.test.tsx`).

## What a window asks on reconnect and focus (perf M10)

- **One lane per host for Work's reopen asks** (work/reopenLane.ts, after lib/tcserver/catchUp.ts). When a link
  opens again the view on screen asks at once (the front: a pane's canvas list, the Files tabs and Home of the
  workspace shown, Money's period, a Review page open); every other Work ask (the Digest, the LifeOS status) waits
  for the front's answer, at most `REOPEN_FRONT_WAIT_MS` (2 s), then goes one at a time, each given at most
  `REOPEN_TURN_WAIT_MS` (10 s). Each ask still goes once per open. `work.get` (lib/workSwitch.ts) is first-paint
  code and asks at once, as before. The Outbox's reopen ask (work/outbox/store.ts) is not in the lane yet.
- **Money paints its last read on a return** (perf M15, money/api.ts): kept per host, workspace and period, 16 at
  most, dropped with Work off; busy until the live read lands.
- **A focus asks little.** Money re-reads its period when its link reopens, and on a focus only when its last read
  is a minute old (`FOCUS_AGAIN_MS`: the host pushes what waits to be confirmed, not a ledger edited elsewhere). The
  Digest tells a host its zone on a focus only when the zone changed or 15 minutes passed (`HERE_AGAIN_MS`).
- **A check waits out its pushes** (lib/quietPoll.ts): it runs only after a spell with no word heard, never while the
  window is hidden, and once as it shows again when one came due. The dashboard's 30 s check, Google's minute
  check (also asked when the link opens again) and a form's 10 s read of its answers use it.
- **A live Office tab's place** is read when something may have moved it (a ResizeObserver on the body, everything
  above it and what sits beside that; a scroll anywhere; the window's resize) and once a second otherwise
  (`watchPlace`, work/office/live/LiveBody.tsx); it was every 200 ms.

## Bytes on a path of their own (perf M9)

- **No file as one frame.** A file dropped on a document goes up in the upload's 2 MB chunks and is imported by its
  path (formats/Import.tsx `fromFile`); a copy sent back to another host goes in 4 MiB pieces, two in flight
  (files/pieces.ts), checked by count and SHA-256 there. Both were one frame of up to about 64 MB.
- **Reads overlap.** Another host's file for a copy was already read two pieces at once (`farBytes`); a fetched item's
  Download now reads three at once after its first piece (canvas/fetched.ts). A sheet's pieces come three at once
  since M7.
- **No deflate on bytes.** A frame with a base64 run of 256 KB or more goes with `compress: false`
  (wire.ts `carriesBytes`; the server's `sendFrame` and a peer link's request): zips deflate by about a quarter, for a
  pass through libuv's pool on both hosts.
- **An Excel file is read in a worker** (sheets/xlsxDecode.worker.ts), its buffer transferred both ways.
- **Not built: a ticketed byte route by range.** What it would remove beyond the above is the base64 of pieces of at
  most about 5.6 MB on the shared socket. The proof that would say whether that still holds a token back (B21 while
  a 20 MB file opens) has not been run.

