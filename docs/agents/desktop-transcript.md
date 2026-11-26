# The desktop transcript: a viewport window, markdown in a worker

- Renderer retention rules live in docs/RENDERER_RETENTION.md. An unfinished
  history head keeps every persisted row and only the newest partial input
  per tool call, in that call's first replay slot. The shared attachment
  cache is a 64 MiB LRU (two bytes per data URL character); failed reads
  retry. Host-job text keeps the last 512 Ki code units plus one truncation
  line, using the host's shared cap. Dev-run logs leave with their runs or
  host. Resource and Mac approval installers attach each existing link
  once through `onLink`'s replay. `perfMark` keeps at most 200 `tc:` marks,
  clearing the oldest name as a group; listeners still hear every mark.
- `src/renderer/src/surfaces/AgentTranscript.tsx` mounts only the rows that
  meet the viewport plus a screen of overscan each way. The thread is a flat
  list of rows (`transcriptRows.ts`: one per turn item, one closing row per
  turn, a `more` row for the remote profile's "Load earlier messages"), laid
  out by `lib/transcriptWindow.ts` (`RowLayout`: estimates until a
  ResizeObserver measures, offsets as prefix sums, the window range, the
  reader's anchor row, `anchorShift`). A measurement writes the container
  height and the offsets below it to the DOM and moves the scroll offset by
  the growth above the anchor row; the tail row growing while streaming
  touches its own box and the container height only. Scroll memory is the
  anchor row (`TranscriptScrollMemory.anchor`); the message list
  (surfaces/TranscriptOutline.tsx: the person's messages down the left
  side, a zero-height sticky child of the scroller placed by
  `outlinePlacement`; folded beside the column it gives the width back, the
  column centred again and glided there on a transform, surfaces/columnGlide.ts)
  and search hits jump by block id through
  `scrollToRow`, which lands exactly once the row is measured (a keyboard
  jump with `instant`, no glide). Never put `content-visibility` or size containment on a row:
  the window measures natural heights.
- The streaming reveal (surfaces/smoothText.ts) holds a lead behind the live
  end (seeded 100 ms, 250 ms for another host's thread, grown by an
  underrun, decaying back), never runs slower than the stream, shows every
  character within 1.5 s of arriving, drains at the stream's end instead of
  snapping, and reveals a row born live (`RowBornContext`) from its first
  word (docs/TRANSCRIPT.md "The stream reveals a phrase at a time"). Inside
  an open fence a code line shows once its newline arrives (held
  `REVEAL.lineHoldMs`, then by words) and fades in as its own element
  (CodeBlock draws a `<span class="line">` per line, `splitColoured`; the
  row's reveal reaches it through `StreamRevealContext`, `lineTimes`); a
  list item, table row, heading, quote line or fence born mid-stream rises
  4px as it fades (`.stream-rise`); and a box that grows while it is read
  glides to its height (lib/heightGlide.ts `useHeightGlide`: the open tool
  table on the layout spring, a streaming code block's body on
  `--dur-base`), rows landing together staggered `--stagger-step` apart.
  `watchMotion` in the no-jerk runner and the soak's `--height-report`
  hold it.
- Settled markdown parses in `lib/markdown.worker.ts` (streamdown's own
  block split and plugin chain, shared through `lib/markdownPipeline.ts`);
  the answer fills the hast cache under each block's text and the row
  mounts the cached tree with no parse on the main thread
  (`lib/markdownParse.ts`, `useMarkdownReady`). Streaming rows keep the
  incremental main-thread path. With no `Worker` (tests, node), or one that
  fails, throws or never gives a first answer (8 s), every text is ready at
  once and the main thread parses as before; once the worker has answered,
  a request past 1.5 s parses that row alone on the main thread (the
  worker keeps serving the rest), a row that unmounts cancels its request,
  and the ready set is a 4,000-digest LRU tied to the hast cache. The renderer aliases
  `decode-named-character-reference` to its plain build (the DOM build has
  no document in a worker); keep that alias when touching the vite config.
- Opening a box thread is round trips (about 200 ms each from the Mac),
  not bytes: over a remote link a cold open is ONE request,
  `session.events { tail, subscribe: true }`, answered `subscribed: true`
  (an older host omits it and the client subscribes and folds the gap).
  That ask has a deadline matched to its size, COLD_OPEN_DEADLINE_MS (8 s,
  lib/connection/subscriptions.ts): past it a second ask goes at once
  without `subscribe`, the first kept, and whichever answers first is
  folded, the other dropped (`firstOfTwo`); a winning page that does not
  say `subscribed` subscribes after it and folds the gap, and
  `session.subscribe` is one subscription a socket and thread, so each
  push comes once. Before (M0, 2026-11-26): an answer lost on a live link
  painted at 31.3 s (the link's 30 s deadline, then the store's retry).
  Every ask of the subscription set for a thread on screen (the store's
  `onScreen`: the focused pane's, a view's, a press's) says `shown: true`,
  and the host serves it on its interactive lane
  (docs/agents/interactive-lane.md).
  The store keeps the last `KEEP_RECENT` (6) transcripts whose panes left
  loaded and subscribed, so a switch back sends nothing (a chat a Work dock
  shows counts as a mounted pane, `sessionStore.showApart`); the markdown
  worker parses one commit's texts newest first. docs/TRANSCRIPT.md
  "Opening a thread on another host" has the numbers. The local profile's
  `session.events` reads on the reader worker in 4 MiB pages
  (`registry.eventsAsync`), so the renderer's head walk ends on an empty
  page or at the tail's first row, never on a page shorter than it asked for.
- A reconnect to another host (its deploy, an app update, a blip, a wake)
  catches up in turns, never all at once (lib/tcserver/catchUp.ts
  `CatchUpLane`, one per remote host): each transcript resumes from the last
  seq it folded (`afterSeq`; the host answers the gap, or a fresh 1 MiB tail
  past RESUME_ROWS or RESUME_BYTES, and also when the row at `afterSeq` is
  gone or, where the reader names its time in `afterTs`, is another row: a
  host that died between a row's push and its write gave that seq again,
  wire.ts `eventsPageReads`); the thread the focused pane shows
  (`FocusSignal.shown`, `sessionStore.followShown`), and every thread a
  mounted view draws in front of him at any depth (`useSessionById`
  counts it on screen while mounted, `sessionStore.drawOnScreen`: a
  master's child, a subagent inside a child or a thread, the chat docked
  beside a file or a mail; a fleet row that only quotes a waiting agent's
  question passes `drawn: false` and waits its turn; focus,
  `session.focus` and the read mark stay the pane's), and a thread he
  presses to open, from the click until its pane mounts
  (`sessionStore.pressOnScreen` in App's onSelectHistorySession; it ends
  when the focused pane shows it, at his next press, or PRESS_HOLD_MS 5 s
  after a dropped open), go at once, jump
  the queue when what is on screen changes, and are the lane's first pick when a window
  opening names one a microtask after asking (the pick waits a few
  microtasks); no other starts while its fetch is out
  (so its page never queues behind another on the socket); the panes on
  the page, then the kept ones, go one at a time, each followed by a pause
  of its bytes at
  CATCH_UP_BYTES_PER_SEC (2 MiB/s) and at least one macrotask. A page folds
  in slices of FOLD_SLICE_MS (8 ms) with the window given back between
  them; pushes stay held until the last slice. A cold load at launch takes
  the same lane. No wait there is unbounded: background work waits for the
  shown thread's fetches at most FRONT_WAIT_MS (2 s) and on one fetch at
  most TURN_WAIT_MS (10 s); a transcript asked for again while it waits
  keeps its one place; Retry on a load still waiting its turn starts it
  (`retryLoad` → `promote`). Before (2026-11-24): a child opened in a
  master's view sat behind the master's fetches with "Waiting for the box"
  and a Retry that did nothing; a subagent opened inside that child, or
  inside any thread, and the docked chat still did until the rule moved to
  `useSessionById` (sessionById.dom.test.tsx). The supervisor's probe fails on 5 s of silence, not on a
  late answer: while frames still arrive it waits, up to PROBE_LIMIT_MS
  (30 s). Before (2026-11-23, 9:46 PM): six `session.events` at once, 8+ MiB
  unsent on the box's socket, long tasks of 1.2 to 2.6 s, and a probe
  behind the queue closing the socket so the next one asked for all six
  again; .temp-code/plans/landed/F-reconnect-catchup.md has the numbers.
- The scroll engine's frame loop rests once its glide, runway and follow
  spring have settled, running thread or not; new rows, the content
  growing, a resize and the reader's input start it again
  (docs/TRANSCRIPT.md "The follow loop rests when it has settled"). The
  editor's navigation past the end of a file waits at most 120 frames
  (surfaces/navigationRetry.ts).
- Measure with `bun run script:measure-transcript-seed` once, then
  `TEMP_CODE_PROFILE=1 electron-vite build` and
  `bun scripts/measure-transcript.ts --label <name>` (an isolated instance
  under /tmp/tc-transcript-measure on its own display; never the user's
  data). docs/TRANSCRIPT.md has the rules, the budget and the before/after
  table.
- In the field, each pane's first rows are timed from the press that opened
  the thread (lib/firstPaint.ts, the stamps in lib/openStamps.ts): an
  hourly `first-paint-hist` line counts every open, and an open past 500 ms
  writes `first-paint … why= queued= fetch= fold= text=` to stalls.log
  (the words in docs/box.md).
