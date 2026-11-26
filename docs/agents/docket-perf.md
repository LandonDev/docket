# Docket's speed: the window, the host and the links

How the whole app's speed is measured in the owner's shape, what each thing he does may cost, and the rules a
kept answer follows. Work's own rows, the kit's commands and the stall report are in
[work-perf.md](work-perf.md); this file is the rest. The pass that built it is
`.temp-code/plans/landed/PERF-docket.md` (the final table, before and after); its baseline is
`.temp-code/plans/perf2/BASELINE.md`.

## His shape

A Mac window and a Windows laptop's, each paired to the box by a remote key over the tunnel; 20 to 40 threads
running on the box; files on a third machine; the phone through the relay. From his Mac: 24 ms to the box in the
middle, one ping in eight at 100 to 147 ms. The kit's pair reproduces it: `--link 60/10/j8` (60 ms there and back,
10 Mbit/s, one chunk in eight 50 to 90 ms late, scripts/lib/slowLink.ts `HIS_JITTER`), `--lifeos 40`, 40 stand-in
threads (`--load 40`, split over two dummy accounts so the fake provider's sockets never queue), the last eight
cores, and the guard (scripts/perf/guarded.ts) that stops a run when the live box's hello passes 800 ms twice or
the disk's pressure passes 30.

## The budgets

`scripts/perf/budgets.ts` holds them as data beside Work's B01 to B33: **D** (the window: launch, opens, switches,
the long transcript, pickers, idle, the long day), **H** (the host's loop, reads, flushes, boot), **G** (send to
first token), **L** (the links: tickets, reconnects, a dead link, catch-up, bulk frames, peers, the phone) and
**P** (pictures). A budget the pair cannot time names what times it in `off` (the soak, the host bench, the Mac).

## What times each

- **The code family** (`bun run perf --family code`): rows in scripts/perf/rows/code.ts, send.ts, links.ts on a
  seeded box (scripts/perf/seed-box.ts: a 30,000-row agent thread, a 20,000-file repo, a master with 30
  children). `stall`, `blackhole` and a restart of the box are the link rows' faults.
- **The host bench** (`bun scripts/perf/host.ts --scene connect|loop|read|flush|settle|watch [--browser]`, and
  `--boot [--copy <scrubbed dir>]`): a headless instance under load, the loop's windows and the asks' times.
- **The renderer soak** (`bun scripts/measure-renderer-soak.ts --scene idle|long|day`): idle's CPU, running
  animations and renders for an off-screen push in three phases (focused, covered, hidden); long's open, stream,
  top and jump in the 30,000-row thread; day's heap, loaded transcripts and raw rows after ten threads opened and
  left. Publish rows `renderer-soak-idle` and `renderer-soak-long` judge what separates a fault (animations,
  renders, the open, a jump that never lands); CPU and the 4 ms frame are reported, since the box cannot meet
  them on any tree.
- **Launch on real-size data** (`bun scripts/launch-timing-linux.ts --copy <dir>`): only on a scratch copy that
  `scripts/perf/scrubCopy.ts` scrubbed (no resume ledger, no saved hosts or keys, every thread idle, Work off, a
  marker the kit checks before it boots). Never the live database.

## The stamps

The host writes to `stalls.log`: boot marks (`boot listening`, `boot hello-ready`, `boot resumed n= ms=`), a
send's parts (queue, handle-wait, each MCP server by name, gateway dispatch, first byte, first row), the
gateway's hourly window, a slow flush's serialize, write and commit, and a window ticket's legs (`ticket … wait=
peer= https= connect= answer= box= boxloop=`). The window adds `[renderer] first-paint … why= queued= fetch= fold=
text=` from the press, an hourly `first-paint-hist`, `longtask … cause=` (the push or answer it ran for) and
`board-paint … answer= render=`. `bun scripts/perf/stall-report.ts` reads them all.

## Rules a change keeps

- **Rows once, in order.** A transcript's rows fold by seq; pushes are held while a page folds; a held row belongs
  to the socket that delivered it; a resync's hold ends only when that thread's replay succeeds; a big answer in
  parts (`answer.parts`) holds back every push of its own thread and every push after a resync.
- **The work grows with the rows, never their square.** Pages fold through one builder (`FoldBuilder`); the live
  turn extends from its tail; "Load earlier" asks a run of pages and refolds once.
- **Nothing for a screen no one sees.** A spinner turns only where it can be seen; a meta push reaches only the
  readers of that thread; clocks tick only for lines on screen.
- **A kept answer** has an owner, a bound, a drop rule and a staleness test (the list is in PERF-docket.md);
  never a permission, never a resolved real path; a read out when its cache was dropped is never kept.
- **The first paint's bytes** stay under `scripts/check-bundle-size.ts`'s budget: a module only the parse worker
  or a later moment needs leaves the entry (`NEVER_IN_ENTRY`).
