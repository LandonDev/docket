# Launch: the rail paints from the launch mirror

- The desktop no longer waits for every host's `session.list` before the
  rail is whole. The main process keeps a launch mirror in the app database
  (src/main/server/launchMirror.ts: `launch_mirror_hosts`,
  `launch_mirror_sessions`): per host (`local` and every saved environment)
  the session SUMMARIES the renderer last saw (a SessionMeta minus
  `activity`/`activityKind`), the workspace and project lists, and the list
  cursor. Summaries only, never transcript rows; capped at
  `MIRROR_MAX_SESSIONS` (2,000) per host, newest kept, and archived threads
  older than 30 days leave the mirror (the host still has them).
- Boot (src/renderer/src/main.tsx → lib/tcserver/launchMirror.ts): the
  first statement of the index chunk asks for the mirror once
  (`askLaunchMirror`, preload `launch-mirror:read`, an `ipcRenderer.invoke`;
  never a synchronous IPC; the /ui page has none). The window exists before
  the server does (docs/agents/launch-code-caches.md "Boot order"), so while
  the server boots main answers the ask from its own read
  (src/main/bootMirror.ts: a read-only connection opened and closed before
  the server opens the database, which also says whether Work is on here);
  once the server is up it answers from the server's connection, as before,
  and the hosts no longer saved are forgotten then. With no mirror to read
  (a first launch) the ask waits for the server. When the answer lands,
  `hydrateFromLaunchMirror` registers the saved hosts in the registry so the
  rail has their sections, and seeds the session and workspace stores; only
  then is environment zero added (`initServerLink`) and the first render's
  workspace read started, so the order is the one the synchronous read had.
  The port ask (`server-port`) is one invoke that main answers once the
  server is up; the renderer asks once. A key route whose ticket mint
  needs the local link waits for it (`registry.primaryOpen`) instead of
  failing its first attempt into a backoff. Then the sockets open and each
  host reconciles: `session.changes { afterSeq, generation }` (contract.ts;
  capability read) answers the metas that changed and the ids that left
  since the cursor from the server's in-memory change log
  (src/main/server/listChanges.ts: one slot per id, a 5,000-entry window,
  a generation per server run), or `reset`, on which the store lists whole
  as before. A changed row is updated in place, a gone one dropped, an
  untouched one is the same object (nothing re-enters: the rail has no
  enter animation, and reconcile is a high-frequency event). The boot prune
  of the seen map (`stores/subscriptions.ts`) waits `BOOT_SETTLE_MS` (2 s)
  for the lists and then takes the mirror's rows for a host that has not
  answered; its rows show under that host's existing offline tint. A saved
  host with neither a list nor a mirror still holds the prune. The main
  process logs each read as `[boot] launch-mirror read <ms> hosts=<n>
  bytes=<b>` (` from=boot` while the server boots; the boot read itself is
  the `boot-mirror <ms>` mark), and the renderer measures the ask to the
  hydrate as `tc:launch-mirror` (performance marks around it).
- The open in two phases (lib/tcserver/openPhase.ts): what the first paint
  needs is asked the moment a host's socket opens (the session changes, the
  workspaces and projects, accounts, the Work switch, the model catalog, the
  shown thread and its focus, and on the local host the saved hosts); the
  rest waits for `afterOpen`: the inbox, dev servers, port forwards, host
  jobs, computer history, thread resources and the providers' doctor run in
  an idle slot once the window is usable (`markUsable` at `tc:ready`; a
  hidden window runs them at once), one at a time on a remote host, and only
  if no close came since that open. One `doctor.get` answers both the
  connect report and which CLIs are installed (`probeDoctor` shares the
  ask). lib/tcserver/openPhase.test.ts counts a host's asks on open by
  phase for the stores main.tsx connects and the parts App starts, with no
  thread shown: 7 before usable (at most 15), none twice, 6 after.
- The writer (`installLaunchMirrorWriter`) follows `onMetaChange` and the
  workspace catalog, diffs each LISTED host's rows against what it last
  wrote (object identity), and sends the difference over
  `launch-mirror:write` after a 750 ms quiet period or when the page hides,
  landed in batches of 200 rows on the host;
  the first write per host is `full`. A host still painted from the mirror
  is never written (it would be rewritten from itself). The cursor saved
  with the host is the `session.changes` head the next boot resumes from.
- Seam: `TEMP_CODE_PEER_DELAY_MS=<ms>` (src/main/server/peerDelay.ts) holds
  every request a REMOTE principal makes on that host before handling it;
  local sockets never wait. Proof: `bun run script:e2e-launch-mirror`
  (scripts/e2e-launch-mirror.ts): a headless slow box and a windowed
  desktop under xvfb, paired; a cold start with the host saved and no
  mirror, then one with the mirror after the box renamed, archived, deleted
  and added a thread while the desktop was down. Measured tc:ready → the
  rail's first full paint (`tc:rail-complete`, marked once every host has
  listed or was painted from the mirror), peer delay 3 s, 12 threads:
  before 6,026 ms, after 11 ms (docs/box.md "The launch
  mirror against a slow box").
