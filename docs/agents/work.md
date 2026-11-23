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
with its six views, linking a workspace to a sector, and Settings → Work
("The screens" below). Every pillar is built; each has its own account in
`docs/agents/work-<pillar>.md`.

## The switch

- One setting per host: `settings.work = {"enabled": false}`, read by
  `work.get` (any key) and set by `work.set` (admin). `WorkSettingsStore`
  (src/main/server/work/settings.ts) holds it. No sync engine carries it: a
  client that turns Work on writes `work.set` to every host it is linked to.
  A change pushes `{ push: 'work', settings }` to every client socket.
- **Code branches on a row, never on the switch**: `workspace.kind ===
  'work'`, `session.scope === 'work'`. The switch only decides whether Work
  things can be made, shown and started.
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
  workspace) and Settings → Work is the switch alone. The switch writes
  `work.set` to every host the window is linked to and its line names the
  hosts that differ.
- **The rail** (chrome/ProjectRail.tsx): `splitWorkRows` (lib/linkedRail.ts)
  keeps a Work workspace out of the code list, pinned or not, always; with
  Work on it sits under the **Work** heading, led by its sector's dot
  (`SectorDot`, chrome/WorkspaceGlyph.tsx, the `--sector-*` tokens in
  index.css), with no Pin. The heading's + opens the menu the chunk answers
  through `workRailPort` (work/shell/WorkRailHost.tsx): one row per sector
  no Work workspace has yet (one click makes it on `workHome()`: the host
  picked on the Work page, else the box, else this machine), Sign in to
  LifeOS… signed out, Retry when it is down, then Without a sector…, which
  asks for a name. A code workspace's row menu gains **LifeOS sector ›**
  (None and the six) while Work is on; `work.lifeos.link` writes it and
  the host's `workspaces` push tells every client. **Work Chats** sits
  after Chats, **Outbox** after Inbox whenever Work is on, with the waiting
  count from `setOutboxWaiting(n)` (the Outbox, milestone 14, owns its page).
- **Work Chats**: `WORK_CHATS` (`"~work"`, lib/tcserver/workspaces.ts) is
  their key as `"~"` is the code chats': `workspaceIdOf` and
  `workspacePathOfSession` answer it for a row with `scope: "work"` and no
  workspace, so the code home never lists a Work Chat; it is never a folder
  (`looksLikeProject`). A draft there carries `scope: "work"`, which
  `ensureCreated` sends on `session.create`.
- **The column** (chrome/Sidebar.tsx, WorkspaceSessions.tsx): a Work
  workspace offers no New project and no Orchestration; a linked one shows
  `WorkColumnHead` (work/shell/WorkColumn.tsx): Mail, Tasks, Projects
  (the project screens, [work-projects.md](work-projects.md)), Agenda,
  People ([work-people.md](work-people.md)), Docs and Files (Teams files, [work-teams-files.md](work-teams-files.md)) from
  `WORK_VIEWS`, then the project cards. Those are LifeOS's,
  live: the head keeps `projects:list {sector}` (backlog, active, paused)
  in `setLifeosProjects`, and `withLifeosCards` (lib/workspaceSessions.ts)
  adds a `lifeos:<id>` card for each one no project mirrors yet; its first
  pick or New thread calls `work.project.open`, which makes the project
  (`projects.lifeos_project_id`) in the card's place: its mirror ("Mirrors
  follow LifeOS" below). The cards are
  oldest first, the order the Projects view keeps inside a state
  (`projectOrder` from `work-kit/projects/order`), with no grouping by
  state, whatever is picked, made or worked in; a project of the workspace that mirrors none of them follows,
  newest first (`railOrder` in the same file). A view row opens `WorkViewSurface` over
  the thread panes under the strip; picking a thread or the row again
  closes it.
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
  (`work.lifeos.status` and the `work.lifeos` push) and
  `useLifeosSession(env, sector)`, a `ConvexReactClient` of the screen's
  own on the address `work.lifeos.jwt` answers (approve), fed narrowed
  JWTs; `useLifeosQuery(session, "module:fn", args)` is a live query.
- **Settings**: a **Work** group after Threads holds the Work page, then
  (Work on) each Work workspace led by its dot; they leave the Workspaces
  group. The Work page (surfaces/settings/Work.tsx, then
  `WorkSettingsBody`): the switch; the sectors LifeOS has; Work threads'
  model (the code threads' default, opening Thread defaults); where new
  Work workspaces are made. **Connections** follows it in the group
  ([work-connections.md](work-connections.md)): each host's LifeOS
  sign-in (pairing, the code and its countdown, a device token, sign out),
  its tools and every other sign-in and helper Work leans on. A Work workspace's page
  (`WorkWorkspacePage`): its sector, its key's state, the host its threads
  run on, "Computer use on <desktop>" per Mac or Windows host
  (`work.workspace.set {mayUseDesktop}`), its thread defaults. **A new Work
  workspace starts with things on** (the owner's ruling, 2026-11-22): the
  host stores, when it makes one (`createWorkspace`, work/scope.ts), his
  desktops it knows in `mayUseDesktop` (itself when it is a Mac or a PC,
  each saved host whose hello named one, each host lending its desktop over
  the Mac bridge: `ownerDesktops`) and `windowsVm: true`, and each module's
  `workspaceCreated` hook stores its own defaults (the office module: the
  Teams copy on); the window then adds the desktops only it knows
  (`createWorkWorkspace` → `allowComputers`). Each is a stored choice, so
  one he turns off stays off; a workspace made before reads as it always
  did. Tests: work/newWorkspace.test.ts. A code
  workspace's page gains its LifeOS sector while Work is on. Keybindings
  lists the Work group (Ask about the selection, ⌘L) only while Work is on.
- **The host's side** (contract-work.ts core): `work.workspace.get` (read)
  and `work.workspace.set` (admin; a null model or reasoning goes back to
  the default), `work.project.open` (operate), and the `url` on
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
  what a Work project has and nothing of code:

  | Part | What it sets | Where it is kept |
  |---|---|---|
  | Name | the project's name | LifeOS, `projects:update` on the workspace's own session (the screen's narrowed JWT); the mirror follows |
  | State | Backlog, Active, Paused, Done, Dropped | LifeOS, the same call |
  | Rules for its threads | the rules sent with a new thread's first message; Edit opens the rules dialog (`PreambleDialog`, with no `{{worktree}}` word for a Work project) | `projects.preamble` on the host |
  | Accounts | which Claude, Codex or Meta account its threads use; drawn only when the host has an account to pick | `projects.account_pins` on the host |
  | Sharing | the project's guest links (who, until when; Revoke on hover) and New guest link…; drawn for a project that mirrors one in LifeOS | the guests pillar's rows on the host that serves LifeOS's documents ([work-guests.md](work-guests.md) "A project's link") |
  | Delete project | at the foot's start, asked first; its tasks stay as tasks with no project | LifeOS, `projects:remove`; the host archives the mirror |

  Save sends only what changed; a failed save keeps the sheet open with the
  reason beside Retry, and a Retry with nothing left to send (the write
  had landed, its answer lost) closes the sheet. While LifeOS cannot be
  reached (signed out, unreachable, refused) Name and State stand as plain
  words, never as disabled controls (State only if LifeOS told it
  earlier), Delete is not drawn, and one line under them says why: the
  sign-in named when signed out, Retry when LifeOS did not answer. The
  rules and accounts are the host's and stay editable, and Save sends
  them; but a name or state he changed and LifeOS cannot take holds Save,
  so nothing he typed is dropped behind a save of the rest. A project
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
| Tools | `withWorkTools(options, session)` beside `withMacTools` for Claude; `app.workTools`, `app.workCall` and `app.workCancel` on the bridge for Codex and Muse | `tools` of its module |
| Path fence | `workSourcePaths` in `fenceRequest` (remote/fence.ts) | none: it names files inside a `CanvasSource` |
| Moves between hosts | `registerMoveModule(db, module)` and `tableMoveModule` (src/main/server/sessionMove.ts), called from a part at boot | the part's own file (the canvas: work/canvas/move.ts) |
| Canvas kinds | `CANVAS` (src/renderer/src/work/canvas/registry.ts) | `src/renderer/src/work/<pillar>/canvas.ts` |
| Act views | `ACT_VIEWS` (src/renderer/src/work/acts/registry.ts) | `src/renderer/src/work/<pillar>/act.ts` |
| Build | `MAIN_INPUTS.workService` and `hostedPages()` (electron.vite.config.ts) | none |
| Phone wire | the Work rows of `SUBSET` (scripts/gen-swift-contract.ts) | none: the phone's Work methods and pushes are rows there |

Pillar ids, in mount order: `outbox, canvas, lifeos, routines, rules, mail,
tasks, agenda, docs, history, formats, sheets, office, google, guests, pdf,
slides, media, frameio, meetings, forms, dashboards, browser, projects,
winvm, capture, files, prep, money, search` (the Windows VM's keeper: [work-winvm.md](work-winvm.md); capture from anywhere,
[work-capture.md](work-capture.md); the Files place, [work-files.md](work-files.md); one search for everything,
[work-search.md](work-search.md)).
`PILLAR_MILESTONE` names the plan milestone that builds each. Canvas kinds
map to pillars once (`CANVAS_PILLAR`), act kinds too (`ACT_PILLAR`).

### Names

- A method is `work.<pillar>.<verb>`, with the capability a key needs, or
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
  params, and in `session.create`'s `about`. A remote key may name only a
  file under the app-managed roots, whatever host the source names.
- contract-work.test.ts, fence.test.ts and work/ctx.test.ts hold every
  pillar to these; a broken name fails a test, not a person.
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
`log`, `push`, `reaches` and `settings` are built.

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
  untouched, so its spawn is what it was.
- **Codex and Muse**: `bridgeMcpConfig` gives the bridge
  `TEMP_CODE_WORK_TOKEN` only for a thread that has Work tools at spawn. The
  bridge lists them once from `app.workTools` (a list that failed is asked
  again), runs one through `app.workCall` and passes the harness's cancel on
  as `app.workCancel`; each checks that the token is that thread's own.
  Without the token the bridge asks the app nothing new.
- `run(args, ctx)` gets a `ToolCtx`: the context, the thread's `scope`, its
  `sessionId` and a `signal` that aborts when the harness cancels the call,
  when its socket goes, or when Work is turned off: every call in flight,
  from any harness, is aborted before the modules stop. A tool that waits or
  loops must heed it. Arguments that do not fit the input come back as the
  tool's error.

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

## How a pillar registers

The mail pillar, as its thread would write it. Nothing outside these files
changes.

```ts
// src/shared/contract-work-mail.ts
import { z } from 'zod'
import { request, type CapsOf, type RelayOf } from './work/wire'

export const MailRequestSchemas = [
  /** → { unread: number } */
  request('work.mail.unread', z.object({ workspaceId: z.string() }))
] as const
export type MailPush = { push: 'work.mail'; workspaceId: string; unread: number }
export const MAIL_CAPS = { 'work.mail.unread': 'read' } satisfies CapsOf<typeof MailRequestSchemas>
export const MAIL_RELAY = {} satisfies RelayOf<typeof MailRequestSchemas>
```

```ts
// src/main/server/work/mail/index.ts
import { z } from 'zod'
import { handled, NOT_HANDLED, workText } from '@shared/work'
import type { WorkModule } from '../modules'

export const mail: WorkModule = {
  id: 'mail',
  ensure(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS work_mail_seen (workspace_id TEXT PRIMARY KEY, at INTEGER NOT NULL)`)
  },
  async handle(req, ctx, by) {
    if (req.method === 'work.mail.unread') return handled({ unread: await unread(ctx, req.params.workspaceId) })
    return NOT_HANDLED
  },
  tools: (scope) => [
    {
      name: 'mail_search',
      description: 'Search this workspace\'s mail.',
      input: z.object({ query: z.string() }),
      readOnly: true,
      run: async (args, ctx) => workText(await search(ctx, ctx.scope, (args as { query: string }).query))
    }
  ],
  start(ctx) {
    const off = ctx.lifeos.subscribe('mail.unread', {}, (n: number) => ctx.push({ push: 'work.mail', workspaceId: '…', unread: n }))
    return off
  },
  sessionsRemoved(ids, ctx) {
    // drop what this module kept for the deleted threads
  }
}
```

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
