# Read and unread: the host's mark

- A thread's host owns its read mark: `sessions.read_at`, on the wire as
  `SessionMeta.readAt`, the thread's `updatedAt` as of the last time the
  person saw it on any client (0: unseen since it began, or marked unread).
  A thread is unread while `updatedAt > readAt`, the rule the desktop and
  the phone already ran on their own maps; the rules that are not about
  sync stay (only settled roots, nothing inside a master, `housedIds`; the
  thread on screen never). The mark is not an edit: it never moves
  `updatedAt` (src/main/server/db.ts `markSessionRead`, never back, never
  past the row). The column's add stamps every existing thread read, so
  the upgrade lights nothing; a thread made since starts unread.
- RPCs `session.markRead { items: [{ sessionId, at? }] }` (one call
  carries a client's coalesced marks; `at` absent = as the row stands) and
  `session.markUnread { sessionIds }`, both `operate` (a read key watches
  without moving them), relayed (`RELAY_METHODS`: a Mac thread read on the
  phone is marked on the Mac), in the phone's subset; the meta push carries
  the mark to every client, and the launch mirror keeps it with the rest of
  the meta. An older host sends no `readAt` and its clients keep their own
  maps.
- The desktop (src/renderer/src/lib/readMarks.ts, installed by
  stores/subscriptions.ts `installReadMarks`): the hosts' marks lie over the
  window's own seen map (lib/sessionSeen.ts `installHostMarks`), except the
  thread on screen, which stays the window's; the thread the person looks
  at (`FocusSignal.attended`: the focused pane, the window focused, the
  person present) is marked as its `updatedAt` moves, and every Mark all
  read path (`markSessionsSeen`, `markAllSeen`) sends too. Writes are per
  host, one request 1.5 s after the last mark and never more than 5 s after
  the first, held while the host's link is down and sent when it opens; a
  write not yet heard back covers its thread meanwhile. The phone
  (ios/TempCodeClient `Client/ReadMarks.swift` and `EnvironmentClient`'s
  `seen`): the same overlay and coalescing, written by `markSeen` while the
  app is in the foreground with an operate key. Tests:
  src/main/server/db-read.test.ts, lib/readMarks.test.ts,
  lib/sessionSeen.test.ts, the phone's ReadMarksTests and the two cases in
  EnvironmentClientTests.
- **Where unread shows.** A thread's own row says it by its title's
  weight. A row that gathers threads says it with one 6px dot
  (`UnreadMark`, components/ui/status.tsx): a workspace row, after its
  diff in the slot the hover actions take; the Chats and Work Chats rows,
  before their state; a project card's name line, before its time. A
  row's rule is `rowUnread` (lib/sidebarRows.ts): a root past its read
  mark, settled (idle or done) or a master watching its batch
  (`unreadCanShow`, lib/threadStripModel.ts), never a housed one. A
  workspace reads every project and linked copy under it (`workspaceMarks`
  through `aliasKeys`); Chats reads the home's. The rail's marks are one
  `useSyncExternalStore` snapshot, and `shareMarks` keeps each unchanged
  row's object, so one thread's flip re-renders the one row
  (chrome/WorkspaceRowMarks.push.dom.test.tsx).
- **A master's batch.** Nothing inside a master is unread (`housedIds`).
  The master is: when a child of its batch completes a turn (done, or idle
  with a turn behind it, not stopped by the person, no failure, no
  background agents still out), its host sets the master's `read_at` to 0
  (src/main/server/masterNews.ts `watchMasterNews`, through
  `registry.markUnread`). A child that errors or that the person stopped
  lights nothing here; its Failed reads on the master's row as before.
  Opening the master clears it like any thread, on every client. A child
  on another host is judged there by the same rule: its settle report,
  `crossHost.settled`, carries `completedTurn`, and the master's host marks
  the master from it (crossHostAgents.ts `settled`, masterNews.ts
  `markMasterNews`), whether or not a wait covers the settle. A report
  from a host older than the field marks nothing. In the window a far
  child is housed like a near one: ids are raw across hosts, so a Mac
  child whose `masterId` names the box's master shows no mark and no
  count of its own; while the master's row is not in the window (its host
  out of reach) the child reads as an ordinary root
  (masterNews.pair.test.ts, dockBadge.test.ts, sidebarRows.test.ts).
- **The Dock badge** (macOS): one number, the rows that want the person on
  every host: unread by `rowUnread`, or a thread waiting on him. Each counts
  once, as the row he would open: a subagent as its root, a batch thread
  as its master (lib/dockBadge.ts `badgeCount`). The window reports it
  once every host has painted (`settledEnvironments`), so a launch shows
  the mirror's number and no flash; main shows the largest window's report
  and bounces once when it rises with no window in front
  (src/main/windows.ts `applyBadge`). Windows and Linux show none.
