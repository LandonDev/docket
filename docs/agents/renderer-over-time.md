# The renderer over time: React 19.3.1, the soak, a push re-renders only what it changed

- react and react-dom are 19.3.1: 19.2.8's development build wrote a
  `performance.measure` with a props diff for every component re-render
  with changed props and never cleared it, about 1.2 KB of native memory
  each, 51,000 a minute on the box: the 8 GB a dev window reached. 19.3.1
  clears each one at once (lib/reactDevMeasures.dom.test.tsx holds it).
- `bun scripts/measure-renderer-soak.ts` soaks a built tree's window
  (`--build prod|dev`, `--host synthetic|box`, `--view board|stream|split`,
  `--minutes`, `--every`, `--label`, `--tree`, `--gate`, `--scene
  board|chat|typing|switch|send|scroll|scenarios|reconnect|idle|long|day` (switch: the rail's two workspaces
  clicked in turn, each click timed to its column and strip and to its
  landing thread's rows, `--workspaces a,b`, `--clicks`, scripts/lib/soakSwitch.ts,
  a hand-run scene; docs/box.md "Switching workspaces"; send: messages sent
  from the master's composer into its 5,000-row history (`--history`,
  `--sends`, `--load-all` pages it all in, `--peer-delay <ms>` slows the
  synthetic host's answers), each timed to its row's first frame, to the
  composer emptying and to the host's answer, judged by `SEND_RULE`, a
  synthetic hand-run scene; docs/box.md "Sending into a long thread";
  scroll: the master's transcript, its board, the rail and the workspace
  column each turned by the wheel at 60 Hz for `--wheel` seconds and flung,
  every animation frame's interval kept, judged by `SCROLL_RULE`,
  `--surfaces`, `--host box` read-only, scripts/lib/soakScroll.ts;
  docs/box.md "Scrolling while threads work"; typing: the master's composer typed into
  beside its board in phases under the board's load, the master's churn and
  a 3,000-edit live-edit flood every 10 s, scripts/lib/soakTyping.ts, judged
  by `TYPING_RULE`; docs/box.md "Typing on a busy master"; scenarios: the no-jerk timeline of
  scripts/lib/soakScenarios.ts played once, with `--screencast <dir>`,
  `--reduced-motion`, `--scrolled-up`; never the gate; docs/TRANSCRIPT.md
  "No jerk in any scenario"), `--trace <s>` (scripts/lib/soakTrace.ts: main-thread frames
  by what they held, animation-frame and timer callbacks by function, busy
  time per renderer thread, each animation's compositing verdict),
  `--eval <js>` (an experiment run in the page); `--why` on a dev
  build tallies the props React's diff names as changed and who rendered
  them) on a fresh userData under /tmp/tc-soak, windowed (xvfb-run off
  macOS), and judges it (scripts/lib/soakJudge.ts). The synthetic host is
  scripts/soak-host.ts over scripts/lib/soakHost.ts (a real server in a
  child: bun with the electron stub on Linux, an esbuild bundle under node
  on macOS, whose bun has no node:sqlite; a pinned master,
  sixteen batch children, the fixed load of scripts/lib/soakLoad.ts; with
  `--scene chat` one plain chat thread with the focused child's load,
  CHAT_PROFILE, shown as a stream; with `--scene typing` TYPING_PROFILE,
  paused and resumed over the host's stdin;
  `bun run script:soak-host-check` proves the load reaches a socket, `--
  --scene typing` its live edits and the master's metas too); box
  mode pairs read-only and revokes at exit. The window opens through
  `window.__docket.open(sessionId, { split })` (every build; lib/docketOpen.ts)
  and runs inactive and unthrottled (`TEMP_CODE_SOAK_WINDOW=1`, honoured
  only with TEMP_CODE_USER_DATA; src/main/soakWindow.ts), with the fresh
  install's first screen marked as offered before the page loads
  (`skipFirstRun`: its backdrop took every wheel of the scroll scene in
  372 and 373). The gate rows
  `renderer-soak` (`--gate`: the board scene, split) and
  `renderer-soak-chat` (`--gate --scene chat`) each run a 50 s window
  inside 90 s (heap after GC ≤ +6 MB, RSS after GC ≤ +30 MB, no long task
  over 200 ms, ≤ 250 ms of long tasks a second, and CPU under the scene's
  bound, `GATE_CPU_PCT`: the scene's highest Mac figure plus a margin, board
  33% where it reads 29% on a quiet Mac and 20-22% on a busy one, chat 27%
  where it reads 23.5-24.4 (`MAC_CPU_SEEN`; the Nov 6 tree reads the same on
  the same Mac, so 22% was set below the cost, not the cost raised); each fails the publish;
  `--cpu-report-only` reads CPU without failing for a hand run; docs/box.md
  "The soak's two scenes" has why the board cannot reach 12% while the
  phrase fade and the spinners stay as designed), and
  `renderer-soak-typing` (`--gate --scene typing`, about 65 s inside the
  same 90 s: keystroke to frame p95 ≤ 16 ms idle and ≤ 33 ms busy and fast,
  no long task over 100 ms while typing, every phase's text exact; CPU
  reported, not judged), and `renderer-soak-scroll` (`--gate --scene
  scroll`, about 40 s: 4 s of wheel and a fling on each of the four
  surfaces, every one moving and no long task while it does; the frame rate
  and the longest frame reported against `SCROLL_RULE` until a run on the
  Mac sizes them). Each soak in
  release-publish waits for `$STAGE/build.done`
  (TEMP_CODE_SOAK_BUILD_DONE), elsewhere it reads out/bundle-map.json's
  `head` stamp and builds when out/ is not HEAD's clean build. docs/box.md
  "The renderer over time" has the numbers; docs/RENDERER_RETENTION.md the
  bounds on the renderer's caches and logs.
- `bun scripts/measure-renderer-soak.ts --scene reconnect` opens six remote
  transcripts in one saved split layout. The separate Node host pairs over
  a client key and serves the remote wire profile with compression. Each
  thread has over 20,000 saved rows and over 3 MiB of event JSON. Three
  turns stream throughout the run. Two grow beyond the 128-row resume
  limit in six seconds and one stays below it.
  - The host's stdin command `cut 6000` drops its WebSockets and refuses
    upgrades for six seconds. The saved link reconnects on its own. The
    first window lasts from the cut to 20 seconds after the first accepted
    socket. The second lasts 20 seconds from a page reload with the same
    layout and user data.
  - The final JSON line reports long-task counts, total and max duration,
    and the count over 100 ms. It splits the UTF-8 payload bytes into
    `session.events` answers, pushes and other frames. `socketBytes` counts
    bytes written to the TCP sockets, including WebSocket framing and
    compression. The report includes peak `ws.bufferedAmount`, accepted
    connections, refused upgrades, and event and queue answer counts.
    Gap answers include empty gaps. The store must contain each row
    appended during the cut or reload gap exactly once in seq order.
    A new assistant block in the focused busy turn proves it advanced
    after the new socket opened. The full report in
    `/tmp/tc-soak/<label>.json` keeps individual long tasks and per-thread
    row checks.
  - `--still` keeps the streams adding rows through the cut and the reload
    gap (the resets and gaps still happen) and pauses them once the socket
    is back, so the window's long tasks are the catch-up's alone; the six
    panes streaming at once make long tasks of their own on the box
    (layout, the height glide, live markdown), which a run without it
    counts too. No stream is owed in that mode.
  - Add `--gate` to fail if either window sees a long task over 100 ms,
    reaches 2 MiB unsent on a socket, opens zero or several connections,
    loses row order or coverage, fails to load all six panes, or stops
    folding the focused stream. The reconnect rule lives in
    `scripts/lib/soakJudge.ts`. The publish tier's row
    `renderer-soak-reconnect` runs `--gate --scene reconnect --still`.
  - `--link <KiB/s>` puts a relay between the window and the host
    (scripts/lib/slowLink.ts `slowLink`) that gives the window that many bytes a
    second, as the Mac's tunnel to the box; its backlog is reported as
    `linkHeldBytes` and judged like a socket's. The kit's form, `--link
    <ms there and back>/<Mbit a second>` (`60/10`), shapes the link of any
    scene on the synthetic host through `startSlowLink`, as `bun run perf`
    does (half the round trip each way, the host's own Host said to it); a
    part after the rate is looked up in `LINK_PARTS` (scripts/lib/soakLink.ts)
    and rides into `startSlowLink`'s options as it is. That form keeps no
    backlog, so the reconnect scene reports no `linkHeldBytes` under it. The
    box is never relayed. `--probe-every <ms>` brings
    the window forward that often (`registry.probeAll('foreground')`), as
    his clicks did. See
    [.temp-code/plans/landed/F-reconnect-catchup/before.md](../../.temp-code/plans/landed/F-reconnect-catchup/before.md)
    for the Linux baseline.
- `--scene idle`, `--scene long` and `--scene day` (on the synthetic host;
  budgets D17, D20, D04, D05, D11, D12 and D18 of scripts/perf/budgets.ts;
  idle and long are publish rows, `renderer-soak-idle` and
  `renderer-soak-long`, run as `--gate --scene idle|long` on each scene's own
  clock, `QUIET_GATE_BUDGET_MS` in soakJudge.ts; the day is a hand run): the window shows a settled chat while
  forty threads run behind it, their metas moving every 4 s each (ten a
  second in all, the most the host's coalescer flushes a window; soakLoad.ts
  IDLE_PROFILE). Each writes /tmp/tc-soak/<label>.json and .md and is judged
  by its own rule (scripts/lib/soakIdle.ts, soakLong.ts, soakDay.ts; the CDP
  side is scripts/lib/soakQuietRun.ts; scripts/soak-idle-long-day.test.ts).
  - idle: three phases of 20 s: focused (`Page.bringToFront`), visible but
    not focused (a second app window opened over it, `window.api.win.create`;
    xvfb has no window manager and Chromium tracks no occlusion on Linux, so
    the covered window stays visible, as on Windows; a Mac covered whole is
    hidden instead), and hidden (`window.api.win.hide`). The scene runs the
    window throttled as the app does (TEMP_CODE_SOAK_WINDOW off for it alone:
    the soak's unthrottled window never reads hidden). Each phase reads the
    renderer's CPU, the running animations (`document.getAnimations()`, by
    name, element and whether on screen) beside the working rows on screen
    (a spinner's row in the viewport), the store's flushes (its `bump` wrapped
    on the instance `window.__docket.sessionStore` holds: its own ms, and to
    the end of the React commits it caused), and, with the load held, five
    meta pushes one at a time of a running thread in a second workspace no
    screen shows (the host's stdin `meta`), each counted by the components
    its flushes rendered. The count comes from a stand-in for React DevTools'
    global hook installed before the page loads (`REACT_HOOK`): armed, it
    walks each commit's tree as DevTools does (a subtree whose child list did
    not change was not visited; a component fiber new or with PerformedWork
    rendered). `IDLE_RULE`: 5%, 3% and 1% of a core, running animations no
    more than the working rows on screen while seen, a flush at p95 within
    2 ms, a push 3 components at most. The gate's form reports the CPU
    against its bound and passes whatever it reads (`judgeIdle(..., {
    cpuReportOnly })`): on the box the fixed renderer reads 9.6, 10.2 and
    3.9 % (perf2 M8's report), and a run on the Mac sizes the gate's.
  - long: one agent-shaped thread of 30,000 rows in two turns, its last one
    live (`perfThread`, scripts/lib/ios-perf-seeds.ts, written straight to the
    event log), beside the forty. A cold open from its rail row (click to
    a row of it in the viewport and none on screen still unparsed), every
    long task in the 15 s after and a CPU profile of them
    (`<label>.open.cpuprofile`, for scripts/profile-summary.ts); 10 s of
    deltas into the live turn (the host's stdin `stream 10000`), traced into
    main-thread ms a frame (`frameMainMs`); a jump to seq 5,000, older than
    the loaded tail, through `window.__docket.open(id, { seq })` (the jump a
    search hit asks, lib/transcriptJump.ts): whether its row lands and when;
    then to the top by "Load earlier messages", each press timed to the
    store's next page, stopped after 180 s. `LONG_RULE`: readable within
    1.2 s, no task over 100 ms in the 15 s after the open, none over 50 ms
    and 4 ms of main thread a frame at p95 while streaming, the hit within
    2 s. Under `--gate` the scene climbs to no top and the jump (D12) is
    reported, not judged (`judgeLong(result, LONG_RULE, true)`).
  - day: every running thread streams with 400 rows of history; ten are
    opened one after another (`window.__docket.open`) and left inside one
    50 s window. Heap after GC at the start and the end, and the store's
    census (`STORE_CENSUS`): transcripts loaded against the panes mounted and
    the raw rows (`rows`, the remote profile's kept log) each loaded one
    keeps. `DAY_RULE`: heap no more than 6 MB up, loaded no more than mounted
    plus six.
- A push re-renders only what it changed, and these keep it so: an equal
  `session` push schedules no flush (store `mergeMeta` returns whether it
  changed anything); a thread row keeps its object while it reads the same
  (workspaceSessions `cachedRow`/`sameRow`), so do the rail's marks
  (`useWorkspaceMarks` computes outside React and shares mark by mark),
  the focused tree, the title bar's strip model and shelf
  (lib/keptValue.ts `useKept` with `sameSet`/`sameData`), a board row's
  meta while only the live context or an event's stamp changes
  (`sameShownMeta`), the board's agent summaries per changed child, and
  the approval toasts (`HiddenApprovalToasts` reads the store's
  pending-approval index, `usePendingApprovals`, ids, title, tool and label
  only, its builder installed by lib/approvalToast.ts so the store imports
  no transcript wording; chrome/toastSync.ts calls sonner only for added,
  changed or removed ids and dismisses an owner's toasts when it unmounts).
  A keystroke forces no layout and renders the field alone (the field sizes
  itself, lib/composerHeight.ts: only a paste, a restore, a quote or a
  replaced range eases its height, the inline height cleared after). A
  live-edit push costs one pass however many items it carries (store
  `applyLiveEdits`: one copy per session, one notify). A step's log line
  renders the board's foot alone: the batch state lives in a holder
  (useMasterModel.ts `BatchHolder`) the foot follows whole, the view reads a
  kept projection (`useBatchView`), each row is a memoized `BoardRow` and
  the master's chat is built only for new render functions; AgentTranscript
  is memoized. A scroll re-renders what scrolls: a virtualizer re-renders
  the component that holds it whenever its range or `isScrolling` moves, so
  it lives in a list component of its own (MasterView.tsx `BoardList`), and
  a scroller's children take no pointer while it scrolls
  (lib/scrollActivity.ts `QUIET_ATTR`, `SCROLL_QUIET_MS`; index.css), so rows
  sliding under a still pointer turn no hover. The rail card's clock reaches the time alone (`LineElapsed`,
  `CardAgo` on the shared tickers; `CardNowContext` fixes them for a
  fixture), and its master block, batch lines and agents lines are
  memoized. The composer keeps its session by `sameComposerChrome`
  (lib/session.ts `COMPOSER_FIELDS`, a proxy test fails on a read outside
  it) and reads its meta through `useSessionMetaValue`, one primitive at a
  time, so a busy master's activity renders no composer. With its `/` or `@`
  menu open it still renders for no push: the metas are read only in `@`
  mode, through `useMentionThreads` (lib/mentionThreads.ts), which keeps
  its thread rows until a push moves what a row draws; the file rows rank
  on the query alone, and the popover reads its list's height once for each
  new set of rows (`shapeOf` in chrome/CommandPopover.tsx;
  Composer.menuPush.dom.test.tsx counts both). The model picker's host
  catalog is kept 60 s a host (`CATALOG_TTL_MS`, lib/tcserver/catalog.ts;
  a new socket asks again). A parked
  transcript (its tab behind `content-visibility: hidden`) reads and writes
  nothing on a resize or a push and catches up when it shows; its
  `--transcript-viewport` is written only when it moves (a custom property
  restyles every row under it). Every `RowsContextMenu` mounts its body on
  the first right-click (`lazyMount`, lib/lazyMenuGuard.test.ts). A component that only needs the metas when a
  menu opens or a click lands reads `sessionStore.metas()` then, never
  `useSessionMetas()`: a hook subscribed to the metas renders its component
  on every push, whatever it returns. Keep the hot parents compilable by
  the React Compiler: no ref read or write during render (latest-callback
  refs are written in a layout effect), no prop mutation, no cast in a
  computed key, and a ref callback taken out of its hook's object before it
  reaches a `ref` prop (`useDragResize` gives `attachPane`). In the
  transcript a delta re-renders the row it changed and the closing row:
  `RowView` compares its row by what it draws (`sameRow` in
  transcriptRows.ts), since the live turn's rows are new objects at every
  flatten; a settled turn keeps its row objects and their height estimates
  while its blocks array, its index and the row above it stay
  (`settledRows`, `estimateRowHeight`), so a send builds and measures the
  last turn's rows alone, however long the thread; and only
  the live turn's closing row is handed the session (`rowTurnState`; a
  notice reads it from context). Chrome that reads a thread's status, host
  or model never subscribes to its streamed text: the composer and the
  working strip get the session `useThreadChat` keeps while only streamed
  text changed (`sameSessionChrome` in lib/session.ts, `ThreadComposer`
  memoized, its callbacks stable), and a hook outside the pane reads it
  through `useSessionChrome` (the store), never `useSession`.
- Nothing that moves asks for a frame it does not paint: every requested
  frame runs the page's style, prepaint and layerize on the main thread,
  144 a second on a 144 Hz screen. The spinner turns the HTML box around
  its arc as a Web Animation (components/ui/spinner.tsx, `SPINNER_TURN`):
  on macOS a turn on the svg, CSS or Web Animation, ran a main-thread frame
  at every display frame, and a board's 35 spinners took 37% of a core. The
  streaming reveal (surfaces/smoothText.ts) steps whole words every 100 ms
  (`REVEAL.stepMs`, `revealCut` holding a bare block marker and a table's
  header row until they have content) and waits on a timer between steps;
  each step fades in as one span, a CSS opacity animation the compositor
  runs (`.stream-step`, lib/streamReveal.ts, a rehype plugin per streaming
  row, named per row because streamdown caches processors by plugin name),
  and the settle waits for the last fade (docs/TRANSCRIPT.md "The stream
  reveals a phrase at a time"). The working line's words shimmer
  (`WorkingText`: a masked band and its `::before` copy of the words moved
  by transform alone, every 3 s) beside its three-dot mark (`WorkingMark`),
  both Web Animations on the document timeline that the compositor runs,
  unmounted or still in a hidden pane or document. A streaming code block colours on a 150 ms throttle.
  A spinner holds no running animation where no one can see it (perf2 M8):
  in a parked pane (`usePaneVisible`), while the document is hidden
  (`useDocumentVisible`), or off screen (one shared IntersectionObserver in
  spinner.tsx). It turns from its mount as before, the observer stops a box
  that is out of view, and a turn started again sits on the document
  timeline from 0, so it comes back in phase
  (components/ui/spinner.gate.dom.test.tsx).
- No work for a screen no one sees (perf2 M8). A meta push of one thread
  reaches only the readers of that thread. Chrome that draws a few threads
  of many reads them through lib/tcserver/metaSelect.ts, never
  `useSessionMetas()`: `useSessionMetasWhere(keep)` is the metas `keep`
  holds, filtered again only when a changed id was held or is now kept (the
  flush's `ids`, so a push elsewhere costs a look at its own id);
  `useSessionMetasDerived(derive, same)` keeps the value it drew while
  `same` says the new one reads alike; `useSessionTree(root)` walks a tree
  by parent and hears a flush only when `affected` names its root. The
  banners (`BANNER_HELD`), the column (`columnHolds`), the title bar
  (`stripHolds`) and the rail's Working rows (`sameWorkingRows`; an open
  tooltip reads the live meta) use them, and `useActivity` reads its tree
  so. `keep` must hold every meta its reader reads. A pane hears only its
  own session: `useSession`, `useSessionChrome`, `useSessionStatus` and
  `useSessionBusy` subscribe through `subscribeSession(id)`, told only when
  `get(id)` is another object; the open-session list keeps its array while
  every open session is the object it was; the right panel takes the
  session as `sameSessionChrome` keeps it (ThreadView.tsx `PaneRightPanel`).
  Off React: the Dock badge is counted on macOS alone and only when a
  counting fact of a changed meta moved (lib/dockBadge.ts `countingFacts`,
  `badgePasses`); the launch mirror writer visits the flush's changed ids
  and writes nothing for a push of transient fields (`sameSummary`); the
  draft writer and the pending-approval index read only sessions that are
  new objects (`approvalVisits`). Tests count it:
  lib/tcserver/metaPush.dom.test.tsx (no listener, no render for a push
  elsewhere), metaSelect.test.ts, dockBadge.install.test.ts,
  store.approvals.test.ts, launchMirror.test.ts and subscriptions.test.ts.
  A card line's second hand runs only while the line can be seen
  (`LineElapsed` with `seen`: lib/onScreen.ts `useOnScreen`, one observer a
  scroller with half a screen of margin, and the document shown); off
  screen it keeps its text on the half-minute hand
  (WorkspaceSessions.clock.dom.test.tsx). The video worker's count and
  reading intervals start with its first player and stop with its last
  (video.worker.ts `pace`). Over a long day: a running transcript outside
  the kept set unloads like a settled one (store `unload`; only a send still
  on its way keeps its rows), its meta telling the rail how it runs, fetched
  whole when shown again; the settled markdown trees, in the window and its
  worker, are bounded by an estimate of their bytes (renderCache.ts
  `treeBytes`, 48 MiB each); and the git index paces itself while agents
  write (lib/gitIndexStore.ts: a refresh waits at least the last load's own
  time after it ended, `nextDelay`; events under `.git/` and
  `.claude/worktrees/` ask nothing, `ignoredPath`; a focus within
  `FOCUS_QUIET_MS`, 5 s, of the last load reads that load; a local
  mutation's refresh still goes at once).
  Still visible on purpose, so not done: spinners turning in a visible but
  unfocused window, and the meta flush's rate while unfocused (the owner's
  call: both change what he sees).
- A switch costs what changed, nothing more (perf2 M3). The seen map is
  written once after a switch, not on its path, and its readers hear only
  a mark that flips a thread's unread state (read-and-unread.md). A
  project's `fs.watch` lingers 30 s after its last holder lets go
  (lib/projectWatch.ts `LINGER_MS`), so the rail's git hold moving A, B, A
  subscribes A once. The review strip (chrome/SessionReview.tsx) asks
  `checkpoint.status` on show only when something changed since its last
  answer: the host's `checkpoint-changed`, a turn's end, or a git change
  or focus while it holds files, each noted while parked; an unpark with
  nothing changed asks nothing, and the board reads on show alone
  (master-threads.md "When the board asks").
  The column's open thread reaches its rows through a store, not their
  props (chrome/WorkspaceSessions.tsx `ActiveRowContext`, `useActive`):
  each card, list and row asks what it reads of it (am I the one, is it
  one of mine), so a switch renders the row it leaves and the row it
  reaches, and the open thread's tree, read when a menu opens, is one set
  kept current after each commit. The Work column's rows still read
  `activeSessionId` off their actions (work/shell/WorkColumnRows.tsx).
  Tested by `tallyRender` counts (WorkspaceSessions.rail.dom.test.tsx).
  The column's row cache lives by scope outside the mount
  (lib/workspaceSessions.ts `rowCacheFor`): the column remounts on a
  workspace switch (Sidebar.tsx keys it by scope), and a switch back hands
  its memoized cards the rows and groups they had; `keepRowCaches` drops a
  scope's cache once its workspace is gone.
