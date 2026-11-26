# Work: the frame every Work pillar fills

Work turns a job into a workspace: its mail, tasks, agenda, documents and
sheets beside its threads, with every outward act held for the owner's
press. The plan is `.temp-code/plans/project.md` and its contracts are
`.temp-code/plans/work-architecture.md`; section numbers (§) below point
there.

**This file is the frame, and what a Work thread is.** The switch,
the core columns, the shared types, the module list, the context the modules
share, one entry per pillar in every closed list, the tool mount and the two
build entries; and on that, Work workspaces, Work Chats and Work threads on
the server, with their fence and their preamble
([work-scope.md](work-scope.md)); the hold on what a Work thread does that
leaves the machine ([work-outbox.md](work-outbox.md)); and the screens that
make them visible: the rail's Work heading and Work Chats, the Work column
with its six views, linking a workspace to a sector, and Settings' Work pages
("The screens" below). Every pillar is built; each has its own account in
`docs/agents/work-<pillar>.md`.

## The switch

- One setting per host: `settings.work = {"enabled": false}`, read by
  `work.get` (any key) and set by `work.set` (admin). `WorkSettingsStore`
  (src/main/server/work/settings.ts) holds it. No sync engine carries it, and
  no press writes more than one computer: Settings → Work's "Work is on for"
  is one switch per computer this window reaches, each writing `work.set` to
  its own computer alone (surfaces/settings/Work.tsx, held by
  Work.dom.test.tsx), and turning one off asks first. A computer whose key
  here may not switch it (`linkMay`, src/renderer/src/lib/linkMay.ts: the
  host's own `capabilityRefusal` on the caps its hello named) shows its state
  in words and who can ("Changed from a computer that manages PURDUE-LT"),
  never a switch that would end in a refusal.
- **A control a key cannot use is not drawn.** Every Work control whose
  method this window's key may not call on its host asks `linkMay` first
  (`useLinkMay` and `useLinksMay` in the same file read the link's status, so
  a hello that lands later shows or hides it): it is not drawn, or where its
  absence would leave a section or a page with no way on, one muted line in
  its place says who can, `managedElsewhere(host)`: "Changed from a computer
  that manages the box", once on a page. Never a disabled control or a lock.
  The host's own check stays the judge. On a given computer's key that means:
  no grant made, taken, dismissed or removed in the Outbox (Approve and Send
  stay); no New, Edit, Delete or proposal's press in Routines and Plays, nor
  the thread menu's Save as a play… (Run now, Pause and a play's run stay); the
  Digest's time and levels as words when no host it is on may take them, and
  never written to one that may not; a workspace page's switches (Computer
  use, the VM, Copy Teams files, Voice, Waiting on, the model) replaced by
  the one line;
  the VM's Set up, Sleeps after, Screen size, Go back and Delete (Wake, Sleep
  and Save a point stay); LifeOS's Sign in and Sign out on Connections and on
  a view; Files' Allow said as who can, and no "Open copies here"; a new
  workspace skips the allowed-computers write it would be refused; a
  workspace's and a project's Accounts (admin) are not offered: the
  workspace page shows the pins as words under the one line, a project's
  sheet has no Accounts; a code workspace's LifeOS sector (`work.lifeos.link`,
  admin) shows the sector and the line in place of its select, and its rail
  row offers no sector menu (`sectorMenuShown`). The token
  field of the LifeOS sign-in asks the rule too, so /ui (a key's link) never
  shows it. A read key also loses Put Back, Delete for Good and Empty Trash,
  a play's run, and the clicker's presses (it keeps the show's state, with one
  line: "This device can only watch the show."). The table in
  src/renderer/src/lib/linkMay.test.ts holds each method's verdict for an
  owner's, a given computer's and a read key; a surface's DOM test swaps keys
  through src/renderer/src/lib/linkMay.testkit.ts.
  A change pushes `{ push: 'work', settings }` to every client socket.
- **Code branches on a row, never on the switch**: `workspace.kind ===
  'work'`, `session.scope === 'work'`. The switch only decides whether Work
  things can be made, shown and started.
- **No code parts on a Work thread or workspace** (the owner, 1.0.369: "still
  references of code repos and git"). The window asks one rule,
  src/renderer/src/lib/workRow.ts (`isWorkThread`, `isWorkWorkspace`,
  `isWorkSession`, which counts a draft in a Work workspace before the host
  stamps it, and its hooks `useWorkSession`, `useWorkSessionId`). By it: the right panel lists
  only `WORK_SECTIONS` (Agents, Activity, Computer, Results, Notes; never
  `CODE_SECTIONS`: Changes, Files, Build, Debug), even in a project with a
  folder or a folder inside a repo; the composer's draft row has no branch
  or project picker, the field's hint says no "build", and the checkpoint
  strip (Review changes, Undo, Keep) is not drawn: a file's earlier
  versions are its History; every type picker (the draft row, New thread,
  the thread menu's Type, a Work master's Add thread) offers Chat and
  Research alone (threadTypes.ts `WORK_THREAD_TYPES`, as the host's); the
  title bar has no terminal row or project plan chip; the thread menu no
  Dev server, and Resources… only when there is one; research options no
  Worktree isolation; the move confirm no branch line; the menu bar no
  Terminal rows and no Go to Symbol… or Type Hierarchy (`CODE_ONLY_IDS`,
  lib/nativeMenuState.ts; `lib/workControlsGuard.test.ts` holds every code
  control out of a Work thread); the rail asks git
  for no change counts (`railRowAsksGit`); the workspace menu draws no New
  project; a Work project card no branch line. What its agent is told is
  in [work-scope.md](work-scope.md) "No code words in a Work thread's
  instructions". The surfaces left as they are, and why, are in
  .temp-code/plans/landed/F-work-no-code.md. lib/workControlsGuard.test.ts
  holds it: the thread menu, the title bar, the panel's sections and the
  menu bar, asked for a stamped Work thread, a Work draft and a code
  thread, must offer exactly the ids its Work, shared and code lists say;
  a new id fails until it is put in one. Its `KNOWN` names the code rows
  that still reach a Work thread: the menu bar's Go to Symbol… and Type
  Hierarchy, which open the code symbol picker. Their keys do nothing with
  a Work thread in front: ⌘J, ⌃` and ⌃⇧` reach no terminal
  (`codeCommandRefused`, lib/nativeMenuState.ts, checked first in App's
  command map). The transcript speaks Work too: the boot reads "Starting"
  where a code thread reads "Starting the CLI" (`phaseLine(event, work)`,
  sessions.ts); an edit row leads with what happened to the file, "Changed
  Budget FY27.xlsx", "Made Seat map.xlsx", "Removed draft.txt" (`editVerb`,
  surfaces/EditRow.tsx), its line totals shown only once Show changes opens
  it and no Edit here; an action group's line names what each command did,
  never "Ran 3 commands" or "Ran 4 tools", and carries no line totals
  (`groupPhrase(…, work)`, `actionGroupOf({work})`); a file named in the
  transcript offers Open in Files first, a tab in the job's Files place
  (`workFilesHome`, surfaces/FileRefMenu.tsx; a Work Chat has no job and so
  no such row); a task chip in a sent message opens that task's sheet in
  Tasks (`openerOf`, work/canvas/SentChips.tsx).
- While it is off: no module's `start` or `onPush` runs, nothing a part of
  the context keeps running is up, no tool is listed to any thread, and
  every pillar method answers `Work is off on this host`. `work.get` and
  `work.set` answer, and a bridge that asks for its tools hears none. Tables
  are still made at boot, since an `ensure` only adds.
- With no Work rows, a host with the switch on is still today's app: a code
  thread's servers, allowed tools and bridge config are the same with Work
  mounted and on as with no Work at all (work/claude-driver.test.ts,
  work/harnesses.test.ts), and so are its stored row and its first message
  (work/registry.test.ts).
- A Work row made while the switch was on keeps its fence with it off: the
  row decides. Off only means nothing new of Work is made.

## Open on a computer

`work.reveal {target}` opens a saved destination in the host's own TempCode
window. The phone calls the destination host on the owner's press. The key
needs `approve`, access to the destination, and `admin` for administrative
Settings pages. The host checks the Work fence against the stored rows and
file sources. The request carries a thread ID, a workspace view and ID, a
Work place, a canvas item ID, a held ref, or a named Settings page. The
destination needs an unlocked screen and a ready local window.

Main brings the window forward and opens the destination. Automatic read
marks for threads, Mail, Messages, Review and Forms responses wait for a
local press after navigation. A refused reveal lifts its pause. A stalled
prepare or opener releases its hold after ten seconds.

On macOS, Handoff accepts `dev.landon.tempcode.open` with `userInfo: {target}`.
It runs as the local user and checks that the destination exists and can be
read. Handoff skips the remote `approve` and `admin` gates.

`work/reveal.test.ts` covers accepted destinations and refusals.
`revealWindow.test.ts`, `workHandoff.test.ts` and `lib/revealPort.test.ts`
cover the window, activity and navigation paths.

## The first paint

Nothing of Work is in the renderer's first paint, switch on or off: no
module under `src/renderer/src/work/`, none of `src/shared/work/`, no
`src/shared/contract-work*.ts`, nothing of `work-kit`. Two guards hold it,
from one list (`WORK_NEVER_IN_ENTRY`, scripts/check-bundle-size.ts):

- `bun run check:bundle` judges the built entry chunk (the release gate);
- `scripts/entryGraph.test.ts` walks the entry's static imports in the
  source (scripts/entry-graph.ts), so a thread that never builds still
  hears of it, with the import chain that let it in. `bun
  scripts/entry-graph.ts <part of a path>` prints a chain by hand.

What the first paint may keep of Work is its registry rows: the switch and
the ports a key or a menu row opens a pillar through (`lib/workSwitch.ts`,
`lib/workPlaces.ts`, `lib/workSearchPort.ts`, `chrome/useWorkMentions.ts`).
The same test names them and caps their source at 26 kB (21.8 kB on
2026-11-23, when fourteen builds that each passed `check:bundle` alone took
the closure 2.5 kB over together); a new row joins that list on purpose.

So a module the first paint loads (the rail, the transcript, the composer,
the thread header, and everything they import) takes Work's types with
`import type`, reads a row by its own field (`workspace.kind === 'work'`,
`session.scope === 'work'`) and reaches a Work screen through a lazy chunk
(surfaces/chunks.ts). The shared files are zod schemas; one value import of
`@shared/work` from the first paint would carry all of them. The contract
mount grows with every pillar, which is why the relay's method table
(`contract-relay.ts`, which spreads `WORK_RELAY`) must stay out too: a
host's presence schemas live in `src/shared/macPresence.ts` so the Mac
bridge's contract, which the first paint does read, does not import it.

A day in a Work dialog (Send later, New event, New task, Money's entry, trip
and invoice, a routine's Ends on, a play's Date, a clash's Day) is the shared
`DateField` (components/ui/date-field.tsx: work-kit's calendar, Mail's, in a
popover), never Chromium's `type="date"`, whose popup wears neither theme. Each
dialog imports it, so it rides that dialog's lazy chunk; a time stays
`<Input type="time">`. `work/dateField.dom.test.tsx` proves one in place and
that no Work file keeps a native date input.

## The screens: the rail, the column, Settings

Milestone 8 (the approved pages `rail.html`, `add.html`, `workspace.html`,
`settings.html` under `.temp-code/prototypes/work-workspaces-2/`). Each
first-paint file takes a few lines and a seam; everything else is the
`work-shell` chunk (`src/renderer/src/work/shell/`, `workShellChunk` in
surfaces/chunks.ts), asked for only once a host has Work on, or on
Settings → Work.

- **The switch in the window**: `lib/workSwitch.ts` asks each host
  `work.get` when its socket opens and keeps the `work` push; the rail,
  the column and Settings show Work things only while some host is on, and
  the hosts that were on are remembered so a launch paints the rail it had.
  With every host off the rail and the column are today's
  (chrome/WorkRail.dom.test.tsx compares the rows with and without a Work
  workspace) and Settings → Work is "Work is on for" alone: one switch per
  computer, each writing `work.set` to its own computer and no other, off
  asking first ("The Outbox, Work Chats and its jobs leave the list on every
  device; nothing is deleted"); the rest of Settings' Work pages are
  docs/agents/settings.md "The pages: Work". Environment zero carries this machine's
  platform (`localEnvironment`), so a PC's own window draws its workspace row
  "Computer use on This PC".
- **The rail** (chrome/ProjectRail.tsx): `splitWorkRows` (lib/linkedRail.ts)
  keeps a Work workspace out of the code list, pinned or not, always; with
  Work on it sits under the **Work** heading, led by its sector's dot
  (`SectorDot`, chrome/WorkspaceGlyph.tsx, the `--sector-*` tokens in
  index.css), with no Pin. Before the heading's + is a search mark that
  opens Work search (`openWorkSearch`, lib/workSearchPort.ts; ⌘⇧K;
  [work-search.md](work-search.md)), drawn whenever the heading is: Work
  Chats can be searched with no job yet.
  The heading's + opens the menu the chunk answers
  through `workRailPort` (work/shell/WorkRailHost.tsx): one row per sector
  no Work workspace has yet (one click makes it on `workHome()`: the host
  picked on the Work page, else the box, else this machine); while the home
  session is down, its state in the rule's words as the row's description
  with the rule's press as the row (Sign in…, Show the code…, both opening
  the sign-in dialog; Retry, which asks that host with the menu kept open,
  its row spinning until the answer's state replaces it, `MenuRow.keepOpen`
  and `busy`; Open Settings), "LifeOS is still connecting on the box" while
  it connects (`connectingWords`), or the state and who can as a
  note where this window may not, or the state alone for a computer the host
  keeps LifeOS from, which reads this window's own session once the host
  says connected (`addMenuState`); then Without a sector…, which asks for a
  name. A code workspace's row menu gains **LifeOS sector ›**
  (None and the six) while Work is on; `work.lifeos.link` writes it and
  the host's `workspaces` push tells every client. **Work Chats** sits
  under the Work heading after the pages above the workspaces (`workChatsRow`
  in ProjectRail.tsx; `railTopRows` no longer lists it), **Outbox** after
  Inbox whenever Work is on, with the waiting count from
  `setOutboxWaiting(n)` (the Outbox, milestone 14, owns its page).
- **The pages above the workspaces**: under the Work heading, before the
  workspaces, one row for each page that spans every job: Today
  ([work-today.md](work-today.md)), Projects (the tracker, every job's
  projects, [work-tracker.md](work-tracker.md)) and
  Review ([work-review.md](work-review.md), its own glyph, `CalendarCheck`),
  then Work Chats. A row is `WORK_PLACE_ROWS`
  (lib/workPlaces.ts, first paint, plain data); its page is `WORK_PLACES`
  (work/places/registry.ts), drawn by `WorkPlacePage` on the Outbox page's
  frame and opened with `shell.openWorkPlace(id)`. With Work off there is
  no such row.
- **Coming back**: a Work workspace reopens on the view, the thread and each view's place he left
  (lib/workReturn.ts, work/shell/ReturnHost.tsx; [work-return.md](work-return.md)).
- **Work Chats**: `WORK_CHATS` (`"~work"`, lib/tcserver/workspaces.ts) is
  their key as `"~"` is the code chats': `workspaceIdOf` and
  `workspacePathOfSession` answer it for a row with `scope: "work"` and no
  workspace, so the code home never lists a Work Chat; it is never a folder
  (`looksLikeProject`). A draft there carries `scope: "work"`, which
  `ensureCreated` sends on `session.create`. Its rows are the code column's
  (`ThreadRowView`), but a Work root leads with its provider where a code row
  has its type, says a type other than chat after its title, and keeps its
  state at the row's end (chrome/RowMarks.tsx; code rows pixel-diffed
  unchanged).
- **The column** (chrome/Sidebar.tsx, WorkspaceSessions.tsx; the look is
  docs/DESIGN.md "The column"): a Work workspace offers no New project and no
  Orchestration. A linked one shows `WorkColumnHead`
  (work/shell/WorkColumn.tsx): the four daily views, Mail, Tasks, Agenda and
  Messages (`DAILY_VIEWS`, `workColumnViews` in views/registry.ts), then a
  **More** fold (`MoreFold`) holding the rest of `WORK_VIEWS` in their
  `order`: People ([work-people.md](work-people.md)), Money, Files (the Files
  place, [work-files.md](work-files.md)), Forms, Templates (`TEMPLATES_ROW`,
  [work-templates.md](work-templates.md) "The row"), Plays and Routines. The
  More view he last opened stays as a row after Messages until he leaves the
  job (`foldRows`; the head is keyed by the workspace). Projects
  ([work-projects.md](work-projects.md)) has no view row: the Projects
  heading under the views opens it. A view may stand inside another and have
  no row of its own: `WorkViewDef.inside` names its parent (a meeting's page
  stands inside Agenda, [work-prep.md](work-prep.md)); the column draws no
  row for it (`workViewRows`), its parent's row reads as open while it shows
  (`rowOfView`), and that row then leads back to the parent rather than
  closing the view. A view row opens `WorkViewSurface` over the thread panes
  under the strip; picking a thread or the row again closes it.
  Under the head, a Work job's list (`sidebarItems(…, "job")`,
  lib/sidebarRows.ts; drawn by work/shell/WorkColumnRows.tsx, Work's chunk)
  is two sections in place of the code column's cards and folds. **Projects**
  (`workProjectRows`, work/shell/columnModel.ts): one row a project, LifeOS's live
  (the head keeps `projects:list {sector}`, backlog, active and paused, with
  each one's `status` and `targetDate`: the id and name in the first
  paint's `setLifeosProjects`, the rest in Work's chunk, `setColumnProjects`;
  `withLifeosCards` adds a `lifeos:<id>` row for each one no project mirrors
  yet, and its first thread calls `work.project.open`, which makes the mirror,
  "Mirrors follow LifeOS" below), then any other project of the workspace.
  The lead slot is the most pressing of its root threads' (`projectLead`:
  asks, failed, held, working), the end its target date, red once passed;
  rows sort by target, none last, so nothing moves for what threads do;
  paused and backlog with nothing live fold into one quiet row counted as
  the tracker counts them ("1 paused, 1 in backlog", `quietWords`). A row
  opens the project's page in the Projects view (`openWorkView {project}`)
  and is lit while that page shows; the heading is lit only on the list.
  **Threads** (`workThreadItems`): every root of the job, loose and in its
  projects, newest first, a page at a time, two lines each: `threadLead`
  (question, failure, held, the row's own mark), else the thread's provider
  (`ProviderLead`, chrome/RowMarks.tsx, from the `provider` and `scope`
  `threadRow` copies onto a Work root), title, a type other than chat after
  it (`TrailingType`) and time; then the
  project's name and the thread's `workOutcome.words` (the host's fold,
  "What a thread left him"), `threadLine`; a title or line the column cuts is
  said whole in a tip on hover and focus, as Today's rows. No row asks a host anything. A
  thread of the open job is never repeated in the rail's Working section
  (`withoutOpenWork`, below). **Archived**: the last row, "3 archived",
  opens `ThreadListPopover` with Restore over the job's archived threads,
  loose and in projects (`archivedThreads`); Work Chats ends its list with
  the same row (`sidebarItems(…, "chats")`). The window asks each host of
  the scope once, in an idle slot, for its archived Work threads alone
  (`sessionStore.ensureArchivedWork`, `session.list {archived: true, scope:
  "work"}`; an older host ignores `scope` and answers every archived
  thread), and the row renders again only when the scope's archived ids
  change; it reckons them again only when a change touches an archived
  thread, so a push for a live thread costs it nothing (`archivedWatch`). Work Chats' title bar New thread starts a Work Chat on the host a
  Work Chat goes to (`chooserPlace` in chrome/NewThreadChooser.tsx, `workHome`).
- **A view registers** in `src/renderer/src/work/views/registry.ts`: the
  milestone fills its own `work/<pillar>/view.ts` (mail, tasks, agenda,
  docs) and nothing else. The view's chunk exports `View` and, optionally,
  `Head` (the controls after its name in the 40px header) and `Title` (in
  place of its name there, for a view that stands somewhere inside itself:
  the way back from a project's page); `fact` is the
  row's one muted trailing fact. `WorkViewProps` hands it the workspace,
  its sector, `lifeos` (a session narrowed to that sector) and
  `startThread(chip)`, which opens a new thread's composer in the workspace
  with the chip in it (`addContextChip`, work/canvas/chips.ts). Plays
  ([work-plays.md](work-plays.md)) and then Routines
  ([work-routines.md](work-routines.md)) follow Files; a
  view opens a thread through `workOpenPort` (lib/workSwitch.ts, App
  registers it). Signed out,
  the frame draws the sign-in instead of the view; unreachable, one state
  line over it.
- **The LifeOS session** (work/shell/lifeos.ts): `useLifeosStatus(env)`
  (`work.lifeos.status` and the `work.lifeos` push; null while unknown, and
  `useLifeosUnanswered(env)` true when the ask timed out on an open link,
  so a screen says so with Retry, `refreshLifeos`, never bones for good) and
  `useLifeosSession(env, sector)`, a `ConvexReactClient` of the screen's
  own on the address `work.lifeos.jwt` answers (approve), fed narrowed
  JWTs; `useLifeosQuery(session, "module:fn", args)` is a live query, read
  in its first render and painted from the window's last read while the live
  answer comes back. Sessions stay open 15 idle minutes, 8 at most
  ([work-lifeos.md](work-lifeos.md) "Sessions kept", "Rows kept").
- **Settings**: the list's **Work** group (Setup, the Work page; Digest,
  Mail, Files, Connections) and, while Work is on, **Jobs**: each Work
  workspace led by its dot, out of Code workspaces (docs/agents/settings.md
  "The pages: Work"). The Work page (surfaces/settings/Work.tsx, then
  `work/shell/WorkPage.tsx`): Work is on for, a switch per computer ("The
  switch" above); Access for each job's new threads; Without asking you;
  Travel; On this Mac, where new jobs are made. A Work thread's model is
  his New threads set for the workspace, as a code thread's is
  (new-thread-access.md "The model"): a thread the host starts (a routine,
  Run now, a play, a meeting brief or follow-up, a Waiting on nudge, a
  capture) takes it too unless a routine names its own model.
  **Connections** ends the group ([work-connections.md](work-connections.md)):
  each computer's LifeOS sign-in (pairing, the code and its countdown, a
  device token, sign out), its tools and every other sign-in and helper Work
  leans on. A job's page
  (`WorkWorkspacePage`, work/shell/JobSettings.tsx; settings.md "The pages: jobs, workspaces, Archive"):
  Computers its threads may use, one row per Mac or Windows computer by its one name
  (`work.workspace.set {mayUseDesktop}`), the Windows VM and the Teams copy; New threads; its Rules;
  Writing and mail. **A new Work
  workspace starts with things on** (the owner's ruling, 2026-11-22): the
  host stores, when it makes one (`createWorkspace`, work/scope.ts), his
  desktops it knows in `mayUseDesktop` (itself when it is a Mac or a PC,
  each saved host whose hello named one, each host lending its desktop over
  the Mac bridge, by the `build.platform` its `peer.register` said:
  `desktopsOf`, `ownerDesktops`) and `windowsVm: true`, and each module's
  `workspaceCreated` hook stores its own defaults (the office module: the
  Teams copy on); the window then adds the desktops only it knows
  (`createWorkWorkspace` → `allowComputers`). Each is a stored choice, so
  one he turns off stays off; a workspace made before reads as it always
  did. A desktop that pairs later (a PC paired to the box by an ordinary
  link registers on its peer link) is not added to a workspace made
  before: the host lists it in `work.desktops` (`knownDesktops`, the same
  three sources, named), which a window reads beside its own environments
  (`hostDesktops`, `desktopRows` in work/shell/actions.ts)
  for the "Computer use on <desktop>" rows, so he switches it on from any
  window. The window's own row carries its platform (`localEnvironment`,
  preload's `process.platform`), so a PC's window lists This PC. Tests:
  work/newWorkspace.test.ts, lib/connection/registry.test.ts. A code
  workspace's page gains its LifeOS sector while Work is on. Keybindings
  lists the Work group (Ask about the selection, ⌘L) only while Work is on.
- **The host's side** (contract-work.ts core): `work.workspace.get` (read)
  and `work.workspace.set` (admin), `work.project.open` (operate), and the `url` on
  `work.lifeos.jwt`'s answer. Tests: work/core.test.ts.
- **A Work project's card menu** (chrome/WorkspaceSessions.tsx): New chat,
  Open project (its page in the Projects view; a card with no mirror yet
  has it too), Project settings, the fleet's rows over its threads and
  Archive dormant threads. No Rename, no Preamble, no Archive project, no Delete project:
  LifeOS names and ends the project, and its rules are in its sheet.
- **A Work project's settings** (work/shell/ProjectSettings.tsx,
  `WorkProjectSettings`, a surface of the `work-shell` chunk that
  `ProjectSettingsDialog` shows for a project whose workspace is
  `kind: 'work'`, by the row and never by the switch). The sheet holds
  what a Work project has and nothing of code, LifeOS's fields first, then
  Sharing as one row, then "Thread setup" folded (what only shapes its
  threads):

  | Part | What it sets | Where it is kept |
  |---|---|---|
  | Name | the project's name | LifeOS, `projects:update` on the workspace's own session (the screen's narrowed JWT); the mirror follows |
  | State | Backlog, Active, Paused, Done, Dropped | LifeOS, the same call |
  | Target | the day the project should be done (work-kit's `TargetField`, the calendar the project's page and New project use; No target date clears it); the tracker sorts by it | LifeOS, `projects:update {targetDate}`, the start of that day here (`targetMs`) |
  | Sharing | one row with no line of its own, whose Share opens the Share sheet (`ProjectShare`), where the links are listed and made; drawn for a project that mirrors one in LifeOS | the guests pillar's rows on the host that serves LifeOS's documents ([work-guests.md](work-guests.md) "A project's link") |
  | Thread setup › Rules | the rules sent with a new thread's first message, said as "86 words. New threads here read them first."; Edit opens the rules dialog (`PreambleDialog`, with no `{{worktree}}` word for a Work project) | `projects.preamble` on the host |
  | Thread setup › Accounts | "The accounts its threads run on": which Claude, Codex or Meta account; drawn only when the host has an account to pick | `projects.account_pins` on the host |
  | Delete project | at the foot's start in the destructive tone, asked first; its tasks stay as tasks with no project | LifeOS, `projects:remove`; the host archives the mirror |

  Save sends only what changed; a failed save keeps the sheet open with the
  reason beside Retry, and a Retry with nothing left to send (the write
  had landed, its answer lost) closes the sheet. When LifeOS took its part
  and the accounts then failed, the line says what landed and that Save
  tries the accounts again (`accountsFailedLine`: "Name saved. The accounts
  did not: …. Save tries them again."). The Target field is work-kit's
  `TargetField`, named by its row and read with its date ("Target, Mar 14"). While LifeOS cannot be
  reached (signed out, unreachable, refused) Name, State and Target stand as plain
  words, never as disabled controls (State and Target only if LifeOS told them
  earlier), Delete is not drawn, and one line under them says why: the
  sign-in named when signed out, Retry when LifeOS did not answer. A window
  whose key the host never hands its LifeOS session (a given computer's:
  `work.lifeos.jwt` is in `DEVICE_REFUSED`) reads neither: the session is
  `withheld` (work/shell/lifeos.ts asks `linkMay` first and reads a
  "forbidden" answer the same way), and the frame says "This computer cannot
  read LifeOS through the box" and where the view opens, with no Retry. The
  rules and accounts are the host's and stay editable. A name, state or
  target he changed that LifeOS cannot take is kept as he typed it: Save
  holds while that is all there is, and when the accounts changed too Save
  saves them, leaves the sheet open with his LifeOS words in it, and says
  so under the fields (`KEPT_LINE`: "Accounts saved. Your name, state and
  target changes wait here until LifeOS answers."); the next Save once
  LifeOS answers sends the rest. A project
  of a Work workspace that mirrors nothing has a name of its own
  (`project.rename`) and no State or Delete. No folder, mode, branch,
  completed turn, review, plans or build is drawn, and none of their reads
  is asked for.
- **The server refuses code settings for a Work project**
  (src/main/server/workProjectGate.ts, called once before the handlers in
  index.ts, by the workspace's kind): `project.setBranch`,
  `project.setStartOn`, `review.set`, `plans.set`, `build.set` and
  `turnpass.set` for a project of a Work workspace, a `project.settings.set`
  bundle whose review, plans, build, turn pass or start host is not null,
  a `build.set` or `turnpass.set` that names a Work workspace and no project
  (its projects would inherit it), and a client's `project.create` in a
  Work workspace. Each answers a
  sentence a screen can show ("A branch is not for a Work project").
  Clearing an override (null) passes, and so do the bundle's name, archived
  mark, rules and account pins, `project.rename`, `project.setAccounts`,
  `project.setPreamble` and `work.project.open`. Tests:
  workProjectGate.test.ts.

## Errors on screen

A host answers a refusal in its own words, and some were never written for
him: a wire method's name, a path on the host's disk, an errno, a wait in
seconds, a schema's complaint. Work words every error it shows through one
function, `workErrorWords(error, { host?, write? })`
(src/renderer/src/lib/workErrorWords.ts), in place of `refusalWords`:

- A known raw form has its sentence (the table in that file: the fence, a
  key that may not, a request the host could not read, Work off, no answer,
  a dropped link, a part of Work not running, a workspace or tab that is
  gone, the disk's errnos, a conversion with no output, the converter's
  refusals (no app for a format, a shared file drawn only where it lies, the
  Windows VM asleep, a file too big to send), a damaged PDF, LifeOS signed
  out, a guest link elsewhere, a VM file's bytes).
- A refusal that is already plain passes as the host wrote it.
- Anything else that still carries a path, a method, an id, a code or a
  stack answers "", so the caller's own line for that act shows ("Budget.xlsx
  did not open") and the raw text does not.
- `write: true` marks an act that changes something: a lost answer is then
  said as uncertain ("did not confirm the change. Check whether it went
  through"), never as failed.
- `host` is the computer's name as the rail gives it; without it the words
  say "that computer".

Preview's failure and its toasts, the sheet's save line and stop toasts, a
file dropped on a document, and Chromium's load codes in a live Office tab
("This Mac is offline.", "Microsoft did not answer.", office/live/layer.ts
`loadWords`) are worded the same way; a refused Play says its kind
(`playWords`, media/Player.tsx), never the browser's message.

A canvas pane words both its failures this way, naming the pane's computer
(`useFailedWords`, canvas/FetchState.tsx): the centred "Couldn't open this
…" and the detail of every kind's state line ("Couldn't save", "History did
not load"); a raw detail shows none, and the line's word stands alone.
A press that failed toasts through `sayError` (canvas/frame.ts): the act's
own line as the title, these words under it, and none under it when they
are empty or repeat the title (a refusal raised with its own sentence).

A site that branches on a host's raw text (a stale version, a conflict)
reads `err.message`, never these words. The test holds the raw lines found
on screen to what he reads now (lib/workErrorWords.test.ts).

**The asks table.** Every new wire ask from Work's renderer needs a row in
`src/shared/work/asks.ts`. The guard reads the renderer and checks a small
request against the wire schema, the caller's caps and the Linux host's path
fence. To refresh the table, add or update the request in `ASK_PARAMS` and run
`NODE_ENV=test bunx vitest run src/renderer/src/lib/workAsksGuard.test.ts`.
Copy the reported verdicts into the sorted table and check the control for
each refusal. The `/ui` column uses a read pairing. Check the browser shim
when a preload call changes.

**State lines.** A line that starts with a state word such as “Saved”,
“Sent” or “Signed in” needs an entry in `src/shared/work/stateLines.ts`
with the fact the code reads. The guard checks that each entry still has
a line in Work and that “Saved” and “Sent” have stronger facts than a queue
entry or a stored token. The save tests hold one write open while another
edit comes in and check the line for text files, sheets and decks, and,
in work/savedLine.test.ts, the Word line and the upload line a Files tab
lays over them: an older save's time or an older upload never stands for
the newest edit. A line that starts "In Teams" is no state word to the
scan; those tests hold it instead.

## Mirrors follow LifeOS

A mirror is the TempCode project that holds a Work workspace's threads
about one LifeOS project (`projects.lifeos_project_id`). LifeOS owns the
project; the mirror owns the threads, the rules and the account pins.
`src/main/server/work/projects/mirrors.ts`, a part of the context with no
member (as `routines/host.ts` is), running while Work is on:

- **Made from LifeOS's row.** `work.project.open {workspaceId,
  lifeosProjectId}` asks LifeOS as the owner for the workspace's own sector
  (`projects:list {sector}`) and makes the mirror with the name the project
  has there. A project of another sector, or one LifeOS does not have, is
  refused ("LifeOS has no such project in Purdue's sector") and nothing is
  made; so is a project that is done or dropped ("Fall LAN is done: reopen
  it to start a thread in it"), whose mirror would be archived the moment
  it was made; so is an ask while the host cannot reach LifeOS, in the
  session's own words. `name` on the request is not read: the desktop
  still sends it for a host a release behind, which requires it. A mirror
  on show is answered at once, with no ask; an archived one is asked about
  first, and answered only if its project is under way again. Asked for its settings (`forSettings`, the Projects view's Project settings…), a finished project's mirror is answered too: the sheet is where he reopens it, and no thread starts there.
- **Kept in step.** One live `projects:list` a linked Work workspace, on
  the host's own LifeOS session, which takes it up again after a reconnect.
  `mirrorMoves(rows, mirrors, busy)` is the whole rule: a mirror whose
  project was renamed is renamed; a mirror whose project is done, dropped,
  deleted or moved to another sector is archived, which only hides its card
  and stops no thread, and only once none of its threads works or waits to
  (`BUSY`: starting, running, queued, watching, waiting); a mirror whose
  project is under way again comes back. A thread coming to rest, a new
  mirror and a workspace linked or removed each settle again.
- **Old code settings are cleared** when Work starts (`clearCodeSettings`):
  a turn pass, build, review, plans or start host a Work project was given
  before the server refused them, which its sheet no longer draws. It
  writes only where one is held.
- **Nothing moves until a list has answered**: a host that is signed out
  or cannot reach LifeOS leaves its mirrors as they are, and a list that is
  not a list moves nothing.

Tests: work/projects/mirrors.test.ts (the rule, the follower on a host that
stands in, and on the real registry with a LifeOS in memory),
work/core.test.ts (`work.project.open`).

## Threads file into their projects

A thread about a task of a LifeOS project files under that project's
mirror, made the first time (`openMirror`, the one `work.project.open`
uses), wherever it starts, so it sits under the project in the column and
on the project's page:

- **In the window.** Every view's Start thread on a task goes through
  `startFiled` (src/renderer/src/work/tasks/startScope.ts): Tasks' row, lead,
  menu and sheet (which Today's Due rows open), and Mail's Start thread on a
  mail whose open task is in a project (`projectOfMail`, LifeOS's
  `mail:thread` answers the task). The composer opens in the mirror, as
  Projects' own Start a thread always did.
- **On the host.** `ctx.threads.start` with no `projectId` files a thread
  about a task (`about`), or one told its LifeOS project
  (`lifeosProjectId`), under the mirror (`fileUnder`, mirrors.ts): Run a
  play on a task, Capture, a nudge on a mail with a task in a project. A
  routine keeps its own saved project. A capture's task is new and has no
  project, so its thread stays loose.
- **Never blocked.** A project that is done or dropped, of another sector,
  or out of reach (five seconds on either side) starts the thread loose in
  the job, with one quiet line: a plain toast, "Not filed in Fall LAN: it
  is done". A play's answer carries the host's line as `loose`; a routine
  or a nudge only logs it.
- **A start never takes another start's words.** A start about a thing
  opens the scope's draft only when it holds nothing he wrote or is about
  that thing already; otherwise it opens a draft of its own under the
  scope's key and the thing's (`draftKeyForSource`,
  src/renderer/src/lib/sourceDraft.ts). The old draft stays as he left it,
  and New thread in that scope finds it again.
- **Named once on screen.** The rail's Working section leaves out the
  threads of the Work workspace open beside it, loose or in a project
  (`withoutOpenWork`, lib/railWorking.ts): its column lists them. A code
  workspace's threads stay in Working as before.

Tests: work/projects/filing.test.ts (the host's starts on a real registry
with a LifeOS in memory), routines/plays.rig.test.ts (`loose`),
work/tasks/startScope.test.ts, tasks/TasksView.dom.test.tsx,
lib/sourceDraft.test.ts, lib/railWorking.test.ts; journey J61.

## A Work draft

A Work draft and a Work thread (by the row, `isWorkSession`) keep the
composer's box and swap only the row under it for Work's
(`WorkComposerRow`, src/renderer/src/work/composer/, the `work-composer`
chunk; the look is docs/DESIGN.md "A Work draft"). A code composer never
loads the chunk and is pixel-identical.

- **What goes.** The type picker, Master thread, the name field, the draft's
  host picker, the context meter and the token count; the field's "How can I
  help you today?". The field asks "What should it do?" (a draft) or
  "Reply, or steer the work" (a thread). The `+` menu reads "Mention a task,
  mail, file or thread". The transcript draws no "Project rules N words" row
  for a Work thread (surfaces/transcript/UserMessage.tsx): the rules stay in
  the project's settings and still reach the first message.
- **Where it files.** The draft's filing control (`FilingControl`,
  work/composer/filing.ts `filingOf`) names the job and the project and lists
  the job's projects as the column does (`withLifeosCards` over the LifeOS
  rows the column publishes, `useLifeosProjects`), in the column's order
  (`byTarget` over the targets `setColumnProjects` keeps), No project and
  Another job. A LifeOS project with no mirror yet is opened first with
  `work.project.open` (`openLifeosProject`), as the column's card is; while it
  opens he can type but Send and Return wait (`onFiling`, the composer's
  `filing`), so the first send never files under the place he left. A mirror
  that fails says so in plain words (`workErrorWords`) and the control shows
  the old place again.
- **A move keeps the draft.** App's `onDraftFile` (the `SessionActions`
  row) moves the unsent draft in place: the composer writes the field into
  its record first, `projectDrafts.move` re-keys the record to the new
  scope (`movedDraftKey`: a start's own draft keeps its `#about:` tail; a
  key whose draft holds his words is never taken, the moved one gets
  `<scope>#draft:<id>`), and `filedDraft` sets the session's host,
  workspace, project and folder, with the new place's defaults for access
  and model he did not pick. The id never changes, so Work's chip store and
  this run's pasted bytes, both kept by id, go with it. Another job's
  folder becomes the window's. The host's fence judges the chips at the
  first send, as it judges any.
- **Settings.** One glyph opens Chat or Research (a draft), the model menu
  held to Work's providers (`WORK_PROVIDERS`, src/shared/work/providers.ts,
  which the host's `workProviderRefusal` reads too; ModelPicker's
  `providers`) and access in Work's words (work/composer/access.ts;
  docs/agents/new-thread-access.md "In a Work thread"). His New threads set
  stays the default. ⌘. and a failure card's "Continue on another model"
  open the popover, then the model menu in it.
- **The title bar.** An unsent Work draft's bar is its crumb alone (the
  job's dot and its project, `WorkCrumb last`), with no strip of chips;
  ThreadHeader reads the draft from the focused pane (`onScreenId`), since
  an unsent draft has no chip.

Tests: work/composer/WorkComposerRow.dom.test.tsx (draft, thread, code;
filing, a card opened first, Another job, a move keeping words, files and
chips; settings), lib/projectDrafts.move.test.ts, chrome/ModelPicker.dom.test.tsx
("in a Work thread"), chrome/Composer.work.dom.test.tsx,
chrome/ThreadHeader.work.dom.test.tsx, surfaces/transcript/UserMessage.work.dom.test.tsx.
Preview: work/composer/WorkComposer.preview.tsx.

## What a thread left him

One record answers it for every screen (the thread's head, the column's outcome line, a project's log, the tracker):
`src/main/server/work/threads/record.ts`, its shapes and words in `src/shared/work/threadRecord.ts`.

- **The record** (`threadRecord`, pure, from records that exist): `waits` (a question or approval the root asks; a
  turn's failure with its words and cause; each open `outbox_request` of the tree; each held item of the tree that
  `needsHim`, a failed send first, then oldest first), `works` (the root's LifeOS `workLinks`, an open task first, a
  task with its `status`, `due`, `projectId` and `waitingOn {name, since}` from `tasks:get`, at most five read), `made`
  (the tree's Results of a made kind, `isMadeKind`: `file.*`, `docs.*`, `sheets.*`, `google.*`, `windows.put`,
  `projects.link`; newest first, undone ones left out, each with `verb`, `name` and `open`), `outcome`, `workspaceId`
  and `worksDown` (LifeOS could not be read, in words; the rest still answers). A subagent's waits and writes are its
  root's (`canvas.paneOf`). `open` is where the window opens it: `{at: 'files', workspaceId, ref, name}` (a files
  Result's ref, which files/tools.ts now writes: `{at: 'files', workspaceId, files: [{ref, name}]}`), `{at: 'url'}`
  (a Google upload), `{at: 'project'}` (`projects.link`), else null.
- **The outcome line** (`outcomeOf`): the most pressing, in his words and a tone: `asks` "Asks you" (the root waits on
  him), `failed` (`failedWords`: "Couldn't sign in", "Out of usage", "Couldn't reach the model", "Stopped on an error";
  then "Couldn't send" for a held send that failed), `held` (`heldWords`: "1 mail to send", "2 file changes to approve",
  "3 items to approve" across kinds; with none of its own, the tree's open `outbox_request`s, `requestWords`: "1 request to
  approve"), `working` (the host's status detail, "Editing Budget FY27.xlsx", else "Working"),
  then the newest Result: `made` ("Made Seat map.xlsx") or `done` ("Mail sent", else its summary). Held outranks
  working: it needs his press, working does not.
- **Folded into the summary**: `SessionMeta.workOutcome` (`{words, tone}`, optional, null for none) on a Work root
  alone; a code thread and a subagent never carry it. sessions.ts `decorate` asks `registry.workOutcomeOf` with the
  decorated meta; the keeper (`ThreadRecords`) answers from memory: one Outbox read (`outbox.list` waiting, this host's
  and LifeOS's held items) grouped by root, and each root's Results, both kept until they change. While Work is on it
  hears `outbox.onChange`, `requests.onChange` (outbox/requests.ts; the open requests are one read, counted by root)
  and `Results.onChange` (outbox/results.ts), drops what moved and says the touched roots'
  metas again (`registry.refreshMeta`). No LifeOS call is in this path. The Swift contract carries it
  (`SessionMeta.WorkOutcome`).
- **`work.threads.record {sessionId, fresh?}`** (core, `approve`, read only; a subagent's id answers its root's; a code
  thread is refused): the whole record. Its waits, requests and made things are the keeper's own, dropped by the
  Outbox's and the Results' changes, not by each ask. Its LifeOS half (the links, the first five tasks) is the one
  the host last read for that root while it is under a minute old (`WORKS_KEEP_MS`, the newest hundred roots,
  dropped with Work off and when this host links or completes for the thread, `Links.onChange`); the head says
  `fresh` when the ask was moved by LifeOS itself (its task pulse), and the host reads again. No ask waits on LifeOS
  past 2.5 s (`WORKS_WAIT_MS`): it answers `worksDown`, the read goes on and is kept for the head's own retry. A head
  asks again at every change of its thread's state, and each ask used to be two LifeOS round trips from the host
  (863 ms in the middle on the live box, Nov 26).
- **The thread's head** (surfaces/transcript/WorkHead.tsx, its own chunk `work-head`; docs/DESIGN.md "A thread's
  head") reads it (`readThreadRecord`, work/threads/record.ts) over the thread's first message (`ThreadHeadSlot` in surfaces/transcriptSession.ts,
  inside that message's row so the transcript's row
  layout measures it), again whenever the folded outcome or the thread's status moves, one of its held items changes in
  the Outbox's list (sent, discarded, edited in place), one of its root's Results is made or undone (`resultsStamp`,
  outbox/results.ts, the stamp a project's Files reads by), or LifeOS changes one of its open tasks (`tasks:get` watched on
  the job's LifeOS session, which the column already holds); the first read goes at once, and the changes after it
  inside 500 ms make one read at the span's end (`HEAD_JOIN_MS`), `fresh` when the task pulse moved among them. A record read for another thread or host is never shown;
  a refresh that fails keeps the last facts with one quiet line, "Couldn't refresh. As of 10:02 AM". A record with
  `worksDown` keeps the last task facts under that line, and is read again once the job's LifeOS session connects
  after it was not, task ids or none, and after 5, 15 and 45 seconds while it stays connected, then left
  (`useTaskPulse`, `WORKS_RETRY_MS`). A task is late once its due time passes, as Tasks and Today say it, on their
  one minute clock (`useMinute`, work/tasks/minute.ts), so an idle head turns late within the minute; `WorkHeadView`
  keeps its fixed `now` for fixtures. "Asks you" takes him to the question's card and the red failure row to the transcript's failure card
  (`goTo`), from the keyboard with focus in it. A
  held row opens the Outbox's own `HeldDetail` in a sheet; the held call in the transcript is one quiet line.
- **The title bar** of a Work thread in front is its crumb (`WorkCrumb`, on the `work-head` chunk so the first paint holds none of it): the job's dot, its project (a press opens
  the project's page) or, loose, the job's name, then the title; no strip of chips. A code thread's bar is unchanged.
- **The right panel** lists Results but opens on them only when he asks (lib/rightPanel.ts): the head says it.
- **Done in Projects** goes through `work.tasks.done` (work/projects/kit.tsx `withHostDone`), so a task a thread
  worked completes with the thread's reason and link, as Tasks and Today do.
- Proof: `threads/record.test.ts`, `WorkHead.dom.test.tsx`, `WorkHeadSlot.dom.test.tsx`,
  `ThreadHeader.work.dom.test.tsx`, `projects/hostDone.dom.test.ts`; journey J62 (a thread holds a mail, its head
  shows it, Send from the head's sheet queues it and the head lets it go).

## The core columns

All defaulted, so the build before them still reads and writes the database
(db-work.test.ts runs that build's own statements against it). Only these
live in `db.ts` and `addonStore.ts`; nobody else appends to `db.ts`'s list.

| Column | Meaning | Reads and writes |
|---|---|---|
| `workspaces.kind` (`'code'` default) | `'work'`: a job | `insertWorkspace`; `WorkspaceMeta.kind` |
| `workspaces.sector` | the LifeOS sector it links to; a code workspace may carry one | `setWorkspaceSector`; `WorkspaceMeta.sector` |
| `workspaces.work_settings` | JSON `WorkspaceWorkSettings` | `getWorkspaceWorkSettings`, `setWorkspaceWorkSettings`; `ctx.settings` |
| `sessions.scope` (`'code'` default) | stamped once at create, kept across a move | `insertSession`; `SessionMeta.scope` |
| `sessions.routine_run_id` | the routine run that started the thread | `insertSession`; `SessionMeta.routineRunId` |
| `projects.lifeos_project_id` | the LifeOS project it mirrors | `insertProject`, `setProjectLifeosId`; `ProjectMeta.lifeosProjectId` |
| `addons.role` | `'lifeos'` on the row TempCode makes for LifeOS | `AddonStore.workMarks`, `setWorkMarks` |
| `addons.for_work` (0 default) | a global add-on allowed in Work threads | the same |

- The wire fields are optional and **ride only a row that has them**: a code
  workspace has no `kind`, a code thread no `scope`. So a code row's meta is
  what it was before the columns, and `workspaceKindOf` and `sessionScopeOf`
  (src/shared/work/ids.ts) read an absent value as code.
- An add-on's two marks are not part of the row that syncs or that a client
  lists. A row write keeps them (the store upserts; a replace would reset
  them). The build before this one still replaces, so an add-on row it edits
  loses its marks: whoever sets `role` must set it again when it is missing.
- Every Work table is made by the module that owns it, in its own
  `ensure(db)`, called from `ensureWorkTables` (work/schema.ts) at every
  boot. §3.1 has each table's shape. An `ensure` that throws never stops the
  host: the fault is logged, that pillar is left out of everything (its
  `start`, its tools, its `handle`), and its methods answer `work: <pillar>
  could not make its tables: …`.
- **Each `ensure` runs inside a savepoint the host owns** (`work_ensure`):
  all of it lands or none of it does, and a fault leaves no half-made table
  and no open transaction for the host's later writes to join. So an
  `ensure` never runs `BEGIN`, `COMMIT` or `ROLLBACK` of its own. SQLite
  refuses a `BEGIN` there, and a `COMMIT` or `ROLLBACK` that ends the host's
  transaction is counted that pillar's fault. A step that must be atomic on
  its own nests a `SAVEPOINT` (work/schema.test.ts has each case).

## The shared types

All in `src/shared/work/` (one import: `@shared/work`), wire-safe, with a
zod schema beside each type a request carries.

| File | Names |
|---|---|
| `because.ts` | `Because`, `WriteReason`, `judgeWrite`: whether a write to a shared item lands or becomes a suggestion |
| `ids.ts` | `HostId`, `SectorKey`, `PILLAR_IDS`, `PillarId`, `PILLAR_MILESTONE`, `Principal`, `WorkspaceKind`, `SessionScope`, `WORK_HOME` (`"~work"`), `LifeosOrigin`, `Handled`, `Verdict`, `NotBuilt`, `notBuilt` |
| `canvas.ts` | `CANVAS_KINDS`, `CanvasKind`, `CANVAS_PILLAR`, `CanvasSource`, `canvasSourcePath`, `CanvasItem`, `ContextChip` |
| `acts.ts` | `ACT_KINDS`, `ActKind`, `ACT_PILLAR`, `HeldRef`, `HeldItem`, `HELD_STATES`, `ActResult`, `UndoSpec`, `ActKindDefOf` |
| `triggers.ts` | `Trigger`, `TriggerSource` |
| `scope.ts` | `WorkScope`, `WorkspaceWorkSettings`, `WorkSettings` and their parsers |
| `tools.ts` | `WorkToolOf`, `WorkToolResult`, `WorkToolListing`, `workToolId`, `workToolNameProblem` |
| `wire.ts` | `request`, `MethodsOf`, `CapsOf`, `RelayOf`, `pillarOfMethod`, `pillarMethodProblem`, `isWorkMethod` |
| `tell.ts` (imported by its own path, not through the barrel) | `Tell`, `TellRow`, `TellOpen`, `TellKind`, `TELL_GROUPS`, `TellGroup`, `TELL_LEVELS`, `TellLevel`, `NoticeWork`: the one way a pillar tells him something ([work-digest.md](work-digest.md)) |
| `digest.ts` (no zod: the first paint may read it) | the digest's words: `GROUP_NAMES`, `LEVEL_NAMES`, `digestLine`, `nowLine`, `jobsLine` |

The server's own are in `src/main/server/work/modules.ts`, since they hold
the database: `WorkModule`, `WORK_MODULES`, `Caller`, `WorkCtx`, `ToolCtx`,
`ActCtx`, `PushTo`, and `WorkTool` and `ActKindDef`. A module writes those
two; they are the shared `WorkToolOf` and `ActKindDefOf` with the host's
context bound, so `run(args, ctx)` and `execute(p, ctx)` are typed.

- `Principal` here is who wrote something (`owner`, `agent:<host>:<thread>`,
  `guest:<link>`, `lifeos:<client>`, `external:<name>`). `capabilities.ts`
  has another `Principal`: who a socket belongs to.
- A type whose shape its builder decides lives in that builder's file and
  is imported from there: `LifeosClient` and `WorkLink` (work/lifeos/ctx.ts),
  `ConvertJob`, `ConvertResult` and `Converter` (work/formats/jobs.ts),
  `CollabClaims` (work/service/ctx.ts).
- `SheetSource` is not here. It belongs to work-kit's `/sheet`, published by
  the sheet engine milestone's first commit (§9.1).

## The mounts

Each closed list holds Work once. A pillar fills its own stub files and
edits none of these.

| Seam | The one mount | A pillar's own file |
|---|---|---|
| Contract | `...WorkRequestSchemas` in `ClientRequestSchema`, `WorkPush` in `ServerPush` (src/shared/contract.ts), both from `contract-work.ts` | `src/shared/contract-work-<pillar>.ts` |
| Capabilities | `...WORK_CAPS` in `METHOD_CAPABILITY` (src/shared/capabilities.ts) | the `<PILLAR>_CAPS` in the same contract file |
| The relay to another host | `...WORK_RELAY` in `RELAY_METHODS` and `...WORK_NOT_CARRIED` in `RELAY_NOT_CARRIED` (src/shared/contract-relay.ts) | the `<PILLAR>_RELAY` in the same contract file |
| Router | `work.handle(req, principal)` in the handler chain, `work.pushes.onPush(sendFrame, principal)` and its off, `startWork(deps)` (src/main/server/index.ts) | `handle`, `onPush`, `start` of its module |
| Deleted threads and workspaces | the registry's `onRemoved` and `onWorkspaceDeleted`, heard in `startWork` | `sessionsRemoved`, `workspaceRemoved` of its module |
| Deleted canvas items (a Files tab closed) | the canvas store's `remove` and `removePanes` (work/canvas/ctx.ts) | `itemsRemoved` of its module, for rows and files it keeps by item |
| Database | `ensureWorkTables(db)` | `ensure` of its module |
| Modules | `PILLAR_LOADERS` and `WORK_MODULES` (work/modules.ts) | `src/main/server/work/<pillar>/index.ts` |
| Search | `runSearch` (work/search/run.ts) reads every module's `search`, and its `mentions` where it has no `search` of a kind | `search: [source]` on its module ([work-search.md](work-search.md)) |
| Tools | `withWorkTools(options, session)` beside `withMacTools` for Claude; `app.workTools`, `app.workCall` and `app.workCancel` on the bridge for Codex and Muse | `tools` of its module |
| Path fence | `workSources` in `fenceRequest` (remote/fence.ts; [by the host a source names](remote-access.md#the-work-fence-by-the-host-a-source-names)) | none: it names files inside a `CanvasSource` |
| Moves between hosts | `registerMoveModule(db, module)` and `tableMoveModule` (src/main/server/sessionMove.ts), called from a part at boot | the part's own file (the canvas: work/canvas/move.ts) |
| Canvas kinds | `CANVAS` (src/renderer/src/work/canvas/registry.ts) | `src/renderer/src/work/<pillar>/canvas.ts` |
| Act views | `ACT_VIEWS` (src/renderer/src/work/acts/registry.ts) | `src/renderer/src/work/<pillar>/act.ts` |
| Build | `MAIN_INPUTS.workService` and `hostedPages()` (electron.vite.config.ts) | none |
| Phone wire | the Work rows of `SUBSET` (scripts/gen-swift-contract.ts) | none: the phone's Work methods and pushes are rows there |

Pillar ids, in mount order: `outbox, canvas, lifeos, routines, rules, mail,
messages, tasks, agenda, docs, history, formats, sheets, office, google, guests, pdf,
slides, media, frameio, meetings, forms, dashboards, browser, projects,
winvm, capture, files, prep, money, search, review, clashes, templates, digest` (the Windows VM's keeper: [work-winvm.md](work-winvm.md); capture from anywhere,
[work-capture.md](work-capture.md); the Files place, [work-files.md](work-files.md); meeting prep and follow-up,
[work-prep.md](work-prep.md); one search for everything,
[work-search.md](work-search.md); clashes across jobs,
[work-clashes.md](work-clashes.md); templates per job,
[work-templates.md](work-templates.md)).
Money, receipts to a ledger by job, has its own account: [work-money.md](work-money.md).
`PILLAR_MILESTONE` names the plan milestone that builds each. Canvas kinds
map to pillars once (`CANVAS_PILLAR`), act kinds too (`ACT_PILLAR`).

### Names

- A method is `work.<pillar>.<verb>` (or `work.<pillar>.<group>.<verb>`:
  `work.office.addin.*`, `work.office.live.*`, `work.mail.chat.*`,
  `work.slides.show.*`, `work.winvm.point.*`; Office's Teams files and
  Routines' plays are camel verbs instead, `work.office.filesOpen`,
  `work.routines.playStart`; the bridge and a workspace's or project's Work
  settings are core: `work.workspace.*`, `work.project.*`), with the capability a key needs, or
  `local` for one only this machine's own window may call (a sign-in that
  opens a browser here). A push is `work.<pillar>` or
  `work.<pillar>.<what>`. A table is `work_<pillar>_*`. A tool is lower
  snake case and at most 53 characters, so `mcp__work__<name>` fits
  Claude's 64.
- What a thread calls is a tool. A bridge method of a pillar's own
  (`app.work<Pillar><Verb>`, `local`) is for the rare call that is not one:
  it takes `sessionId` and `token`, the router checks the token is that
  thread's before the module hears of it, and the bridge script sends it
  only after a foundation follow-up.
- **The relay.** A Work method a key can hold is carried to the host a
  relayed lane names, so the phone reaches a workspace that lives on the
  Mac through the box. A row in the pillar's `<PILLAR>_RELAY` narrows that:
  `'screen'` carries it only while that host is unlocked, `'never'` keeps it
  on this host (rows that are this host's own, as guest links are the
  box's).
- No Work method has a param named `path`, `paths`, `cwd`, `parent`,
  `destParent`, `sourcePath` or `projectPath`. A file is named inside a
  `CanvasSource` (`{ at: 'file', path }`, or a Microsoft file's `ref:
  { kind: 'path', path }`), which the fence reads wherever it sits in the
  params, and in `session.create`'s `about`. Which roots judge it turns
  on the host the source names and the verb:
  [remote-access.md](remote-access.md#the-work-fence-by-the-host-a-source-names).
- contract-work.test.ts, fence.test.ts and work/ctx.test.ts hold every
  pillar to these; a broken name fails a test, not a person. A doc is held
  too: scripts/docsGuard.test.ts fails on a backticked `work.<pillar>.<verb>`
  in a docs/agents/work*.md file that is no request or push of the
  contract, unless its list says it is a key the code keeps or a name the
  doc itself calls gone or a sketch.
- The bulk lane's method list (src/main/server/lane.ts) is not mounted: a
  Work method runs in the normal lane. A pillar whose read is heavy enough
  to need the bulk lane asks for a follow-up.
- `CanvasSource` and `ContextChip` are in the phone's generated contract
  (a create carries them). Whoever changes either schema runs `bun run
  gen:swift` and commits the output; that is the one way those files
  change.

### What the router does with a Work request

`work.handle` answers the five core methods, then finds the pillar from the
method's name and calls that module's `handle` alone, with the context and a
`Caller`: `local` (this host's own window), `remote` (a key, with its
capabilities) or `model` (an `app.work*` call from a thread's bridge, with
the session id its token proved). A method its contract declares and no module answers throws
`not built: <method> (milestone N)`. Nothing hangs and nothing passes
silently. `handle` also gets a `signal` as its fourth argument, which aborts
when the caller's socket goes or Work is turned off: a handler that runs
long hands it on. It hears no cancel of one request on a socket that stays
open; a pillar that needs that declares its own cancel method. The capability gate and the path fence run before it, as for
every method.

### Loading: nothing of Work can stop the host

No host file imports a pillar, a part of the context or the mount when it
loads. `startServer` awaits `loadWork()` (work/load.ts) before anything of
the host exists, and that is the one door:

- **Each pillar is loaded on its own** by `loadWorkModules`
  (work/modules.ts), through its entry in `PILLAR_LOADERS`. One whose code,
  or whose dependency, throws while it loads (a native library this machine
  lacks) is left out and named in `WORK_LOAD_FAULTS`; its methods answer
  `work: <pillar> did not load: …` and the others run.
  Pillars load one after another, never at once: they import one another's
  files in cycles, and two loads of one cycle at the same time waited on each
  other forever under vitest (office and files, 2026-11-24, when
  files/handle.ts began to import saveAsWord.ts); main is CommonJS, so the
  order costs the app nothing.
- **`WORK_MODULES` is empty until that load has run** and is one array for
  the life of the process, so a reader that holds it sees it filled.
  `startWork(deps)` with no list throws before a load, since an empty
  registry would otherwise pass for a host with no pillars. A test that
  wants the whole registry awaits `loadWorkModules()` first; one that passes
  its own list (`startWork(deps, [canvas])`) needs nothing.
- **If the mount itself cannot load or start** (a part's file throws as it
  loads), the host gets an inert Work: the switch reads off and cannot be
  turned on, every other Work method answers why, no thread is listed a
  tool, and everything that is not Work runs as it always did.
- Host code reaches into `work/` only for types, `work/load.ts` and
  `work/toolInput.ts` (`inputShapeOf`, which imports nothing of Work).
  work/load.test.ts holds index.ts and apptools.ts to that. A pillar's own
  `index.ts` may import what it likes: it is loaded behind the guard.
- **The scope rule is the exception, and it is the host's own.**
  work/scope.ts and work/preamble.ts decide what a Work thread is and what
  it is told; the registry, the drivers and the cross-host handler load
  them at boot, since a Work row must be fenced whether or not Work came
  up. They import no pillar, not the registry and not the mount
  (work/scope.test.ts); apptools.ts reaches them through orchestration.ts.

## The context

`WorkCtx` is what one module may ask of the others. `startWork` builds it
once (work/ctx.ts `buildWorkCtx`). `db`, `host`, `dataDir`, `enabled`,
`log`, `push`, `reaches`, `settings` and `clock` are built.

- `hisZone(ctx)` (work/clock.ts) reads the last valid zone from LifeOS's live
  `settings:get` watch, then the last desktop to come to the front, then the
  host's zone. It reads memory alone. Changes from LifeOS take effect as they
  arrive and the host keeps the last answer through a lost connection. A
  sign-out or refusal clears it. The digest's saved desktop zone is read at
  boot. Use `dayOf` and `timeIn` with an explicit zone when the host must write
  a date or time, and name the zone for a thread. Send epoch ms when a window
  can word the time. `hostClockGuard.test.ts` checks for local clock reads.

- `dataDir` is `<userData>`; a module keeps its files in a folder of its
  own under it (the canvas: `canvas/`, media: `work-media/`), never in
  the job runner's or another pillar's.
- `push(p, to?)` reaches every client socket. `{ need: 'approve' }` sends
  it only to the sockets whose key holds that capability (this host's own
  window holds them all): what a read-only key should not see is pushed
  with a need. `{ path }` (one path, or a list) sends it only to the
  sockets whose caller could name that file, or every file listed
  (`reaches`), so a push about an item whose file is outside a remote
  key's roots never reaches that key, admin or not. A socket must pass
  both when both are given. `{ only: 'local' }` or `{ only: 'remote' }`
  sends it to this host's windows alone or to remote keys alone: one push
  in two shapes, as the canvas list is with the paths a key may not name
  cut to file names (work-canvas.md "The push"). The fence is asked once a push, and a fence
  that throws sends the push to this host's windows alone. **A pillar
  pushes what it says about one item's file with `{ path: <that file> }`**
  (a `{ at: 'thread' }` item needs none), and answers a remote key's read
  of that item by id only when `reaches` says yes: the two together keep
  the file's contents from a key that could not name it.
- `reaches(by, path)` is the listener's own path fence
  (remote/fence.ts `admitsPath`, over index.ts `managedRoots` and the
  folders it denies, handed in as `WorkDeps.remoteFence`), for a file a
  method reaches through an id rather than a path in its params: whether
  `by` could have named the file itself. This host's window and a thread's
  own call always could; a remote key only under the app-managed roots,
  by the real path, outside the denied folders. A module that serves an
  item's file to a remote key asks it first and throws `FenceError`
  (remote/fence.ts) when it says no; a file in the item's own folder
  (a `{ at: 'thread' }` source) names no path and needs no asking. In a
  test that hands in no `remoteFence`, a remote key reaches nothing.

Every other member comes from a file its milestone
owns (each is built now); its owner fills that file and edits nothing else:

| Member | File | Milestone |
|---|---|---|
| `scopeOf`, and the two admissions below | work/scope.ts (built: [work-scope.md](work-scope.md)) | 6 |
| `threads` | work/threads.ts (built) | 6 |
| `peer` | work/peer.ts (built) | 6 |
| `lifeos`, `links` | work/lifeos/ctx.ts (built: [work-lifeos.md](work-lifeos.md)) | 7 |
| `canvas` | work/canvas/ctx.ts (built: [work-canvas.md](work-canvas.md)) | 9 |
| `held` | work/outbox/ctx.ts (built: [work-outbox.md](work-outbox.md)) | 10 |
| `results` | work/outbox/results.ts (and `ensureResults`, which the outbox module's `ensure` calls) | 14 |
| `convert` | work/formats/jobs.ts (built: [work-formats.md](work-formats.md)) | 15 |
| `service` | work/service/ctx.ts (built: [work-service.md](work-service.md)) | 18 |
| `tell` (with `done`, `only`, `quiet`) | work/digest/ctx.ts (built: [work-digest.md](work-digest.md)) | round 3 |

**Telling him.** A pillar never raises a toast, a system notification, a
phone push, a badge or a sound for news that arrives by itself. It calls
`ctx.tell({kind, workspaceId, title, detail?, open?, by?, key?})` and lists
the kind on its module (`tells: TellKind[]`, each with one of the eight
groups). It states a deadline (`by`), never a volume: the digest's rule
decides whether the tell interrupts or waits for the day's one notice.
`ctx.tell.done(key)` takes it back, `ctx.tell.only(prefix, keys)` keeps a
set in step, and `ctx.tell.quiet(sessionId)` marks a thread the pillar
started on its own, so its done, failed and stuck wait for the digest too.
A toast that answers his own press is not news and stays where it is.

One part adds no member: `routines/host.ts` keeps the host handles the
routines engine needs and the context does not carry (the add-on host's own
call for a watch, the registry's settle and read marks), called once from
`buildWorkCtx` ([work-routines.md](work-routines.md)).

A part is a function `(ctx, deps) => members`. `deps` (`WorkDeps`) is what
index.ts hands over: the database, the store, the session registry, this
host's id and data dir, the peers and peer calls, the cross-host threads and
agents, the Mac bridge, the session mover, the add-on store with its RPC,
sync, host and grants, Away and the notifier. A part that needs to be called
from a file its milestone owns (a peer call, a move hook) hooks itself in
through one of these; a pillar's module never sees `deps`, only the context.
Making a part starts nothing, since it is made at boot with Work on or off:
a connection, a poller or a child process goes in `deps.whileOn(run)`, which
runs when Work turns on and whose return runs when it turns off or the host
closes. A part that
throws while it is made never stops the host either: its members answer
`work: <file> did not start: …` from then on.

**A thread that moves takes its Work rows with it.** A module that keeps
rows or files per thread registers a `MoveModule` with
`registerMoveModule(deps.db, …)` at boot, Work on or off. One whose whole
state is a table with a `session_id` column uses `tableMoveModule(id, table,
{ dir, claimed })`: its rows ride in the manifest's `modules[id]` and land
with the receiver's workspace id, the files under `dir(dataDir, sessionId)`
ride as `module` files, the source drops both once the move has finished,
and `claimed` runs on the receiver when the landing becomes the thread. A
host on this build without the module refuses the move by name. A host
from before the hooks cannot land the thread without those rows: the
digest the two hosts compare at the commit covers them, so the move fails
there and the thread stays where it was. History import (historyImport.ts) carries every `work_*` table
with a `session_id` column, and `canvas/<sessionId>/`, by name, with no
hook. The canvas is the first user (docs/agents/work-canvas.md).

**The two admissions.** `workspace.create { kind: 'work' }` goes to
`work.createWorkspace`, and a `session.create` that asks for Work (`scope:
'work'`, or an `about` chip) passes `work.admitSession` first; both are
answered by work/scope.ts. With the switch off each is refused (`Work is off
on this host`). With it on, the workspace is made (the app's own folder
under `<work root>/Work`), and the create is admitted: its scope is stamped
where the row is made (`stampScope`, called by `SessionRegistry.create`),
which also refuses what Work cannot honour. A create with an `about` chip
is admitted whether or not LifeOS answers, and the thread is linked to the
chip's row once it exists (`ctx.links.link`, [work-lifeos.md](work-lifeos.md)). A create that does not ask
passes untouched, though the registry still stamps a thread of a Work
workspace, or one a Work thread started, as a Work thread
([work-scope.md](work-scope.md)). The run that started a thread
(`routineRunId`) is never a client's to say: it is not a create param;
`ctx.threads.start` carries it host side.

## Connections

A pillar answers for its own sign-ins and helpers through the optional
`health` on its module (`check`, and `lapses` for what ends); the frame
gathers them in `work.health` and `work.lapses` and lists the read-only
`work_connections` tool to every Work thread (work/health.ts). The account
is [work-connections.md](work-connections.md).

## Tools

One tool set serves Claude, Codex and Muse. `work.tools.of(session)`
returns a thread's tools: none while Work is off, none unless the row says
`scope: 'work'`, then whatever each module's `tools(scope)` answers for the
scope `ctx.scopeOf` gives. A tool with a bad name, a name used twice or an
input that is not a `z.object` is left out and logged.

- **Claude**: `withWorkTools` adds an MCP server named `work` and allows
  `mcp__work__<name>`. A thread with no Work tools gets its options back
  untouched, so its spawn is what it was. It mounts the bridge's listing
  (`tools.listing`), so both harnesses read the same words, and the SDK is
  handed a loose object drawn as that JSON schema (`claudeInputOf`,
  work/toolInput.ts): it checks nothing, and the mount's words below answer
  a bad input.
- **Codex and Muse**: `bridgeMcpConfig` gives the bridge
  `TEMP_CODE_WORK_TOKEN` only for a thread that has Work tools at spawn. The
  bridge lists them once from `app.workTools` (a list that failed is asked
  again), runs one through `app.workCall` and passes the harness's cancel on
  as `app.workCancel`; each checks that the token is that thread's own.
  Without the token the bridge asks the app nothing new. With it, a name the
  bridge does not know goes to `app.workCall` too, so the mount answers it.
- `run(args, ctx)` gets a `ToolCtx`: the context, the thread's `scope`, its
  `sessionId` and a `signal` that aborts when the harness cancels the call,
  when its socket goes, or when Work is turned off: every call in flight,
  from any harness, is aborted before the modules stop. A tool that waits or
  loops must heed it. Arguments that do not fit the input come back as the
  tool's error in words (work/inputWords.ts `inputProblemWords`): each field
  that failed (three at most), what it must be, its `.describe()` help and
  one value that passes (the schema's example, default, first choice or a
  typed value), never zod's issue JSON: "Nothing ran: the input does not fit
  sheet_read. range is missing (One A1 range, such as 'Q1'!B4:D9). Fix the
  input and call sheet_read again." A Work thread's call of a tool it does
  not have says it is not in the thread's list, to read the list again, and
  names the nearest of its own tools (`unknownToolWords`); while Work is off
  it says so (`WORK_OFF_WORDS`).
- **Zones in the words.** A description or field help never names a city: it
  writes `HIS_ZONE` or `HOST_ZONE` (src/shared/work/tools.ts), and the
  listing fills them in as it lists ("Central today", from `hisZone`; the
  host's own zone for an input a pillar reads on the host's clock).
- **Field help.** Every id, time, measure and destination field (a name that
  is or ends in id, at, time, date, until, from, to, width, height, x, y,
  size, minutes, path or ref) has a `.describe()` saying what it is, its unit
  or form and where the agent gets it; a literal or a list of choices says
  itself. work/toolWords.test.ts walks every tool a workspace thread is
  listed and fails on a bare one.

### Narrowing a thread

A pillar may take powers from one thread (the mail chat is the first:
[work-mail.md](work-mail.md) "The chat beside the mail"). Two seams on
`WorkModule`, read through `work/narrowing.ts`:

- `callRefusal(ctx, {sessionId, via, server, tool})` answers words the
  model reads in place of the call's answer, or null. Both funnels every
  tool call passes ask every module: the add-on catch
  (`outbox/catch.ts` `makeAddonGate`, `via: 'addon'`, `server: 'lifeos'`
  for the app's LifeOS row, else the row's id), for every thread's call and
  before the LifeOS row's run; and the Work tool mount (`tools.call` in
  work/ctx.ts, `via: 'work'`), which serves Claude's `work` server and the
  bridge's `app.workCall`. The first module's words refuse it; a module
  that throws refuses it too (`REFUSED_UNCHECKED`). The host's own call
  with no thread is not asked.
- `harnessDenied(sessionId)` names the harness's own tools the thread must
  not have, read at its harness's start (`harnessDeniedOf`), Work on or
  off. Claude Code adds them to the thread's denied tools and its fence
  hook (`fenceWorkOptions`); a warm process spawned without them is never
  adopted, since its command line differs (warm.ts `warmKey`). Codex has no
  list to deny, so the thread starts in the read-only sandbox (no network)
  with `approvalPolicy: 'never'`, no shell tool when `Bash` is denied and
  `web_search = "disabled"` when the web is (`codexNarrowing`). Muse's
  session protocol has no way to deny a built-in, so its driver refuses a
  narrowed thread (`museNarrowRefusal`): start it on Claude.

`ctx.threads.fresh(sessionId)` says whether a thread is this host's and
has no message yet, for a pillar that marks a thread before its first turn.

## The build entries

- `out/main/workService.js`, from `src/main/workServiceProcess.ts`: the Work
  service's utility process, beside the gateway and the add-on host. Forked
  while Work is on ([work-service.md](work-service.md)).
- `out/hosted/`, from `src/hosted/`: the pages the Work service serves to a
  browser that is not the app. Their own Vite build (`hostedBuildConfig`),
  run when the renderer's bundle closes, with its own root, chunks and base
  (`/w/hosted/`), so nothing of the app's window reaches a guest's page and
  no hosted module enters the window's first paint. `HOSTED_PAGES` is the
  closed list: `index`, `item`, `guest`, `form`. The Work service serves
  them at `/w/hosted/`; `index` is its own plain page, `form` is a published
  form's page (milestone 36, [work-forms.md](work-forms.md), served at
  `/f/<publicId>`), `guest` is a guest's page and the owner's `/w/open`
  (milestone 31, [work-guests.md](work-guests.md)), and `item` is a plain
  page that loads nothing.
  `tsconfig.web.json` includes `src/hosted`.

## What each pillar answers

Three of a module's fields speak for the pillar outside its own screens:
`health`, the rows of Settings → Connections ([work-connections.md](work-connections.md)); `tells`,
the news it gives the digest through `ctx.tell` ([work-digest.md](work-digest.md)); and `search`
and `mentions`, what Work search and the composer's `@` find
([work-search.md](work-search.md), [work-canvas.md](work-canvas.md) "Mentions"). Many pillars have
none of their own because another pillar answers for them; the table says
which. Backticked names are the module's own, as `WORK_MODULES` holds them
(work/pillarTable.test.ts loads every module and fails when a row and its
module differ); the words after them name who answers for the rest.

Work search takes, for each kind, the first source that answers it: a
module's `search`, then the search pillar's own (`OWN_SOURCES`,
work/search/index.ts: `person`, `mail`, `task`, `event`, `doc`, `project`
from LifeOS in search/sources/lifeos.ts, `file` from search/sources/files.ts
and LifeOS's files, `thread` from search/sources/threads.ts), then a
module's `mentions` for a kind still untaken (`listSources`, search/run.ts).

| Pillar | Health | Tells | Search | `@` |
|---|---|---|---|---|
| outbox | — | `outbox.held`, `outbox.failed`, `outbox.offer`, `outbox.request` | — (its `@` kind is found through it) | `held` |
| canvas | — | — | — (its `@` kind) | `item` |
| lifeos | yes: LifeOS, Mail and calendar (for mail, agenda, tasks, people, prep) | — | — (the search pillar's LifeOS sources) | `task`, `mail`, `event`, `project`, `person`, `doc` |
| routines | — | — (the digest's: routine done, failed, stuck, asks) | — (its `@` kind) | `routine` |
| rules | — | — | — | — |
| mail | — (lifeos's Mail and calendar) | — (the digest's: waiting, missed) | — (the search pillar's `mail`) | — (lifeos's `mail`) |
| messages | yes: Chat | `messages.new` | `message`, `chat` | `chat` |
| tasks | — (lifeos) | — | — (the search pillar's `task`) | — (lifeos's `task`) |
| agenda | — (lifeos) | — | — (the search pillar's `event`) | — (lifeos's `event`) |
| docs | — (guests' Work service) | — (the guests pillar's: a guest's edit) | — (the search pillar's `doc` and `file`) | — (lifeos's `doc`, files' `file`) |
| history | — | — | — | — |
| formats | yes: Tools | — | — | — |
| sheets | — (guests' Work service) | — | — (the search pillar's `file`) | — (files' `file`) |
| office | yes: Office (the add-in, Office in the VM, Office for the web), Files (OneDrive, OneDrive in the VM) | — | — (Files' sources) | — |
| google | yes: Google | — | — | — |
| guests | yes: Work service | `guests.opened`, `guests.edited` | — | — |
| pdf | — | — | — | — |
| slides | — | — | — | — |
| media | — | — | — | — |
| frameio | yes: Frame.io, with lapses | — | — | — |
| meetings | — | — | — | — |
| forms | — | — | — | — |
| dashboards | — | — | — | — |
| browser | yes: Browser, Windows VM (the standing machine, the evaluation), with lapses | — | — | — |
| projects | — (lifeos) | — | — (the search pillar's `project`) | `card` |
| winvm | — (browser's Windows VM, office's VM rows) | — (the digest's: a failed VM job) | — | — |
| capture | — | — (the digest's: unsorted captures) | — | — |
| files | — (office's Files, google) | — (held file acts: outbox's) | — (the search pillar's `file`) | `file` |
| prep | — (lifeos) | — (the digest's: starting, ready) | — | — |
| money | — | `money.confirm` | `money` | — |
| search | — | — | its own sources, above | — |
| review | — | `review.ready` | — | — |
| clashes | — | `clashes.new` | — | — |
| templates | — | — | — | — |
| msforms | yes: Microsoft Forms, on the host whose box browser carries Forms | `msforms.responses` | `msform` | `msform` |
| digest | — | `routines.done`, `routines.failed`, `routines.stuck`, `routines.asks`, `connections.ending`, `mail.waiting`, `mail.missed`, `docs.guest`, `capture.unsorted`, `winvm.failed`, `prep.starting`, `prep.ready` (read from those pillars by digest/sources/) | — | — |

## How a pillar registers

Shown on the clashes pillar, one of the smallest: a wire of five methods, a
push, a tool, a tell and a table. Each part below is its real code, cut to
the lines that register it.

```ts
// src/shared/contract-work-clashes.ts: the wire, its capabilities, its relay rows
export const ClashesRequestSchemas = [
  /** → ClashList */
  request('work.clashes.list', z.object({ from: at, to: at })),
  request('work.clashes.leave', z.object({ eventId: id })),
  request('work.clashes.miles', z.object({ workspaceId: z.string().min(1), from: ClashStopSchema, to: ClashStopSchema })),
  request('work.clashes.waive', z.object({ id, on: z.boolean(), seen: seenSchema.optional() })),
  request('work.clashes.answer', z.object({ eventId: id, way: z.enum(['decline', 'propose', 'move']), /* … */ }))
] as const
export type ClashesPush = { push: 'work.clashes' }
export const CLASHES_CAPS = {
  'work.clashes.list': 'read',
  'work.clashes.leave': 'read',
  'work.clashes.miles': 'read',
  'work.clashes.waive': 'operate',
  'work.clashes.answer': 'approve'
} satisfies CapsOf<typeof ClashesRequestSchemas>
export const CLASHES_RELAY = {} satisfies RelayOf<typeof ClashesRequestSchemas>
```

```ts
// src/main/server/work/clashes/index.ts: the module
export const clashes: WorkModule = {
  id: 'clashes',
  tells: [{ kind: 'clashes.new', group: 'clashes', name: 'Clashes' }],
  ensure: ensureClashes, // CREATE TABLE IF NOT EXISTS work_clashes_*
  start: (ctx) => watchClashes(ctx), // reads LifeOS, pushes `work.clashes`, `ctx.tell`s each new clash
  tools: () => [clashesListTool], // clashes_list, read-only
  async handle(req, ctx, by) {
    switch (req.method) {
      case 'work.clashes.list':
        return handled(await listClashes(ctx, req.params.from, req.params.to))
      // … leave, miles, waive, answer
    }
    return NOT_HANDLED
  }
}
```

A new pillar also takes one line in each shared file that mounts every
pillar, a foundation change its landing note asks for (below): its id in
`PILLAR_IDS` and its milestone in `PILLAR_MILESTONE` (src/shared/work/ids.ts);
its schemas in `WorkRequestSchemas`, its push in `WorkPush`, its caps in
`WORK_CAPS` and its row in `WORK_PILLAR_CONTRACTS` (src/shared/contract-work.ts);
its loader in `PILLAR_LOADERS` (work/modules.ts); and a tell group in
`TELL_GROUPS` (src/shared/work/tell.ts) if none of those fits. The window's
side (a view, a canvas kind, an act view) registers in the renderer's own
tables ("A view registers" above, the seam table).

That gives the pillar a table at the next boot, a method behind the
capability its row names (and relayed to a Mac that hosts the workspace), a
push to every client, and a tool listed to Claude, Codex and Muse threads of
Work scope. work/mount.test.ts proves each of these with a fake module.

A pillar with work a routine should run with no model (making a week's
review, say) registers it as a host job, `jobs: [{ id: 'review.make', name:
'Makes the week\'s review', run: async (ctx, { workspaceId, firedAt }) =>
({ words, open }) }]`; the owner's routine names it (`work.routines.save`
with `job`). [work-routines.md](work-routines.md) "A routine that runs a job".

A pillar that needs a shared file changed does not edit it: it writes the
need in its landing note and a foundation follow-up makes the change.

## Proofs

- `src/shared/work/work.test.ts`, `src/shared/contract-work.test.ts`: the
  types, the names and the contract's mount.
- `src/main/server/work/`: `settings.test.ts`, `ctx.test.ts` (every stub
  that is still one says "not built" and its milestone), `mount.test.ts` (a fake module end to
  end), `harnesses.test.ts` (the real bridge script and Claude's server),
  `claude-driver.test.ts` (a code thread's tool surface, Work on and off),
  `server.test.ts` (a real server: the gate, the fence, the pushes, the
  refusals).
- `src/main/server/db-work.test.ts`, `addonStore.test.ts`: the columns.
- `src/main/workBuild.test.ts`: the two build entries; it builds the hosted
  pages.
- Scope, the fence and the preamble: the list in
  [work-scope.md](work-scope.md) "Proofs", `fence.proof.test.ts` (the real
  CLIs) first among them.
