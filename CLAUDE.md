# temp-code — instructions for AI sessions

This file is an index, loaded whole into every Claude thread's first request, and
it holds to 40,000 bytes (scripts/claudeMdBudget.test.ts): at 305 KB it was most
of a 200k window and every thread compacted on every request
(docs/agents/prompt-overhead.md). A new subject's long account goes in
`docs/agents/<slug>.md`; this file gets one entry for it.

## One line: prod runs the newest published GitHub release
- `/Applications/TempCode.app` runs the newest `v1.0.N` release on
  github.com/LandonDev/temp-code (public). It updates itself through
  electron-updater: at launch, every 5 minutes, and when a window comes
  forward after 15 idle minutes it reads the feed's latest-mac.yml, offers
  the release, downloads only when asked, and restarts on request. A
  release it is TOLD about skips the wait: the Publish button's script
  exiting green inside the app, or the box's `release-available` push over
  the peer link after its deploy, makes it fetch that second and offer
  "Restart to update" (src/main/update.ts `selfUpdate`, the rules in
  updateTrigger.ts: a version it already runs or holds is ignored, and
  nothing installs without the restart click). Its data
  lives in `~/Library/Application Support/TempCode/` (`dev:prod` still runs
  on the older `temp-code/` dir).
- Nothing reaches users until `bun run release:publish` runs (see below).
  Every green commit on master is still tagged locally, so commit only
  finished, verified slices: the next publish ships everything since.
- `stable` is a pointer the updater no longer reads; it is moved onto
  master at each cutover (`git branch -f stable master`) and otherwise
  left alone. The pre-MonoCode line (v96) lives on in the reflog only.

## The user lives in the installed app — never touch it
Do not launch anything against the prod userData (that means never
`bun run dev` without TEMP_CODE_USER_DATA, and never `bun run dev:prod`
from an AI session), do not send messages into the user's threads, and
do not kill or restart the installed app.

## Testing: spawn an isolated dev instance
```bash
env -u ELECTRON_RUN_AS_NODE \
  TEMP_CODE_USER_DATA="$HOME/Library/Application Support/temp-code-dev" \
  TEMP_CODE_DEBUG_PORT=9224 bun run dev
```
- Own database, own window; CDP on 9224 for driving and screenshots
  (`window.__app` exposes the store in dev builds). A fresh userData starts
  with an empty rail, wherever it was launched from: add the folder with
  Add workspace….
- These are ENFORCED in code: a dev build without TEMP_CODE_USER_DATA
  exits immediately (it would open the installed app's database — a
  second SQLite writer there freezes the user's live threads), and each
  userData dir takes a single-instance lock. If several sessions test at
  once, each needs its OWN userData dir and debug port (temp-code-dev2 /
  9226, …).
- `env -u ELECTRON_RUN_AS_NODE` is required — the variable leaks into
  agent shells and breaks Electron.
- Renderer must be on port 5173; a different port means a stale dev
  server from another session is holding it. Kill it (`pkill -f
  electron-vite`) and relaunch — electron-vite never restarts the main
  process on its own, so main-process changes always need a relaunch.
  When another app's dev server holds 5173 (lifeos sits on `[::1]:5173`,
  and the window would load it in the renderer's place), set
  `TEMP_CODE_RENDERER_PORT=5177` (electron.vite.config.ts: that port,
  strict) and check `document.title` over CDP before trusting the window.
- Kill your dev instance when the pass is done.
- Updater end to end: `bun run script:e2e-updater` (scripts/e2e-updater.ts)
  builds two signed, un-notarized copies of the tree (1.0.N-1 and 1.0.N) with
  their own bundle id and product name, serves the newer one from a local
  feed, and drives the older copy under /private/tmp/tc-updater-e2e through
  check → download → restart over CDP (port 9230) until the bundle on disk
  is 1.0.N and the relaunched app answers. The hooks it uses:
  `TEMP_CODE_UPDATE_FEED=<url>` makes a packaged copy that also has
  `TEMP_CODE_USER_DATA` read a generic feed (latest-mac.yml + zip) at that
  URL, with its downloads under `~/Library/Caches/temp-code-harness-updater`;
  and a `tempcodeHarness` block in the bundled package.json (electron-builder
  extraMetadata) carries the same three TEMP_CODE_* keys into an app that
  Squirrel's ShipIt relaunches without our environment (src/main/harness.ts).
  Its Squirrel state lives in `~/Library/Caches/dev.landon.tempcode.e2e.ShipIt`.
  Nothing of this touches /Applications/TempCode.app or its caches. `--win` is
  the Windows pass, run on the box against the rig (docs/agents/windows-build.md).

## The user dogfoods master on the prod data
`bun run dev:prod` runs master against the prod userData (CDP on 9220).
It is the user's command, not ours. The single-instance lock keeps it and
the installed app from running at once: quit one before opening the
other. Master only adds to the database (new tables, defaulted columns),
so the two apps can take turns on it. Layout lives in localStorage, which
differs by origin, so it does not carry across; unread is the host's mark
("Read and unread: the host's mark" below) and does.

## The prod worktree is retired
~/IdeaProjects/temp-code-prod was the old local updater's build checkout.
The updater no longer reads it or the source repo at all; it can stay
detached as a scratch checkout or be removed. Never build into or swap
/Applications/TempCode.app yourself.

## Subjects: one entry each, the long account in docs/agents

Read the file a task touches before changing that subject; each keeps its
section's text as it was when CLAUDE.md was split (2026-11-11).

- **Releases** — `bun run gate` (scripts/gate.ts: `commit` and `publish`
  tiers, `TIER_PATHS`); a post-commit hook tags `release-N` on every green
  master commit (`bun scripts/release.ts`); `bun run release:publish`
  (scripts/release-publish.sh) ships HEAD's 1.0.N to the feed; both are
  buttons in Settings → Hosts, pressed by the user. No AI attribution
  trailers in commits. [docs/agents/releases.md](docs/agents/releases.md)
- **Project preambles** — the house rules as markdown on the project row
  (`projects.preamble`), added to a thread's first message on every start
  path by `decidePreamble` (src/main/server/projectPreamble.ts).
  [docs/agents/project-preambles.md](docs/agents/project-preambles.md)
- **UI standard** — docs/DESIGN.md wins every conflict; Kobra on Base UI under
  src/renderer/src/components/ui, mapped in components/README.md; the guard
  tests under src/renderer/src/lib/*Guard.test.ts; verify with typecheck, the
  tests you touched and `bun run ui:preview`; never run prettier on
  src/renderer. [docs/agents/ui-standard.md](docs/agents/ui-standard.md)
- **Appearance** — two themes, one per kind of place: Settings holds a theme
  for Code and one for Work (lib/appearance.ts), a window wears its place's
  (`placeKind`, `changeScheme` in lib/placeScheme.ts, the dissolve), and the
  next launch opens in it (`appearance:scheme`, windowFrame.ts, boot.js).
  `lib/tokenContrast.test.ts` holds every pair of tokens to the contrast
  contract and `lib/colourGuard.test.ts` refuses `dark:`, `.theme-light`,
  black or white by name and text as an opacity. **Dark is held**: no commit
  changes how dark looks (`lib/darkHeld.test.ts`, a frozen copy); a look
  light changes is a token with a value per theme (index.css "Held in
  dark"), and the file lists the edit that flips each when the owner asks. [docs/agents/appearance.md](docs/agents/appearance.md); the
  phone checked in light, one tint fixed and the rest listed:
  [appearance-phone.md](docs/agents/appearance-phone.md)
- **Launch-time code caches and the bundle split** — boot.js and the compile
  cache, the `tempcode-app://` scheme, lazy chunks (`defineChunk`,
  surfaces/chunks.ts) under the index chunk's budget (`bun run check:bundle`).
  [docs/agents/launch-code-caches.md](docs/agents/launch-code-caches.md)
- **Launch mirror** — the rail paints from session summaries kept in the app
  database (src/main/server/launchMirror.ts) and reconciles with
  `session.changes`. [docs/agents/launch-mirror.md](docs/agents/launch-mirror.md)
- **Provider traffic** — every Claude and Codex child goes through the loopback
  gateway (gateway.ts, gatewayCore.ts, its own utility process); routing by
  headroom, usage-reset recovery across hosts, Meta keys, failure kinds (`failureKind.ts`, `FailureCard`), the
  turn's wait words, warm harnesses, GPT-6.2 Sol and Astra in the shared
  Codex catalog (defaults unchanged), the request shape trace and the codex
  model-metadata wait. [docs/agents/provider-traffic.md](docs/agents/provider-traffic.md)
- **The app bridge** — scripts/app-mcp-bridge.mjs, Codex's and Muse's app
  tools; every `app.*` call carries the thread's own `appToken`, checked by
  `bridgeCallRefusal` (apptools.ts); undeclared arguments refused.
  [docs/agents/app-bridge.md](docs/agents/app-bridge.md)
- **Prompt overhead** — what a fresh thread's first request carries, measured
  per model by `bun run script:measure-first-request`; prompt byte budgets
  (src/shared/promptBudget.ts) and the thrash guard (`context_thrash`).
  [docs/agents/prompt-overhead.md](docs/agents/prompt-overhead.md)
- **Muse Code** — provider `muse`, one `muse serve` per thread over the Muse
  Session Protocol (src/main/server/drivers/muse.ts), config dirs per account
  and skills scope. [docs/agents/muse-code.md](docs/agents/muse-code.md)
- **Remote access** — the fixed-port listener behind the tunnel
  (src/main/server/remote/listener.ts), keys and capabilities, the path fence,
  pairing, `/ui`. [docs/agents/remote-access.md](docs/agents/remote-access.md)
- **The Linux agent host (the box)** — headless mode, `box-update`, deploy
  drift, harness and memory sync, the Mac bridge, dev servers, process guard,
  threads across hosts, the relay, devices, restart resume, backups.
  [docs/agents/linux-agent-host.md](docs/agents/linux-agent-host.md)
- **The Windows build** — an NSIS installer and a zip for x64, unsigned, per user with no admin
  (`%LOCALAPPDATA%\Programs\TempCode`, data in `%LOCALAPPDATA%\TempCode`); every Windows build
  passes `--config build/electron-builder.win.yml` and stages the win32 Claude CLI first
  (scripts/win-stage.ts); `release:publish --win`; the frame (src/main/windowFrame.ts), the
  updater's Windows path (only "Restart to update" installs there), one key map (`modKey`,
  `keyHint` in src/renderer/src/lib/keys.ts), the skills links as junctions on win32
  (src/main/server/skills/links.ts); `bun scripts/e2e-updater.ts --win` proves it in the rig.
  [docs/agents/windows-build.md](docs/agents/windows-build.md)
- **The Windows host core** — command strings in Git Bash (else cmd.exe) through one `ShellSpec`
  (loginShell.ts), PATH and PATHEXT, a Job Object per harness and job through a csc-compiled helper
  (`adoptTree`, `killTree` in src/main/server/procTree.ts), junctions and copies kept in step for
  the config dirs (skills/links.ts `syncCopy`), the fence's Windows rules, ConPTY terminals; a
  Windows PC as a Mac-bridge host of the box (`hostPath`, `WINDOWS_ALWAYS_ASK`, `shellCall`).
  [docs/agents/windows-host.md](docs/agents/windows-host.md)
- **The Windows rig** — one Windows 11 evaluation image on the box for the
  Windows port, run by `agents` under QEMU/KVM, files under /srv/agents/win-vm;
  `up.sh`, `ssh.sh`, `scp.sh`, `run-in-session.sh` (a program on the logged-on
  desktop), `shot.sh`, `down.sh` in scripts/win-vm/. Two machines on it: the rig
  (proofs) and `--instance standing` (Work's, a lasting disk, SSH 22230); their
  code is src/main/server/work/winvm/machine/.
  [docs/agents/windows-vm.md](docs/agents/windows-vm.md)
- **The Windows VM's keeper** — the `standing` rig instance as a computer for Work threads: the `winvm`
  pillar's states, `work.winvm.*`, setup with tcuser's policies, wake, hibernate on idle and at a stop of the
  box's service (stop signals blocked, a watcher), restore points taken asleep (disk snapshot, firmware, TPM);
  the `windows_*` Work tools on a third `ComputerService` through the guest's door (work/winvm/vm.ts), one
  thread at a time; a second door for the Office helper as tcuser (`tc-office.exe`, compiled in the guest from the
  box's source, winvm/helperDoor.ts), the door under `conhost --headless`; QEMU's GTK window on a display of the VM's own (`qemu-window` tool, winvm/window.ts), its
  `vm:windows` video source and idle row (winvm/picture.ts), QMP's 4 fps picture where the tools are missing; `windows_put`/`windows_get` (files.ts) and his clipboard in and out
  (clipboard.ts, §29.8); his Take over (winvm/drive.ts), Settings → Work's section, the whole job run by
  `e2e-winvm-work.ts`. [docs/agents/work-winvm.md](docs/agents/work-winvm.md)
- **Search across hosts** — one query fanned out to every host
  (lib/crossHostSearch.ts), an FTS5 index per host (turnIndex.ts).
  [docs/agents/search-across-hosts.md](docs/agents/search-across-hosts.md)
- **One project across hosts** — linked projects by `linkId`, settings homed on
  the box, one rail, host glyphs (remote/projectLinks.ts, lib/linkedRail.ts).
  [docs/agents/one-project-across-hosts.md](docs/agents/one-project-across-hosts.md)
- **Chats outside every workspace** — a thread with no project or workspace is
  the home's, whatever its cwd. [docs/agents/chats-outside-workspaces.md](docs/agents/chats-outside-workspaces.md)
- **Thread notes** — `notes.md` per thread, `update_notes`, the reminders, host
  lines that never start a turn (src/main/server/threadNotes.ts,
  notesPrompts.ts). [docs/agents/thread-notes.md](docs/agents/thread-notes.md)
- **Away from computer** — one state per host, questions answered and approvals
  allowed while away (src/main/server/away.ts).
  [docs/agents/away-from-computer.md](docs/agents/away-from-computer.md)
- **Add-ons** — MCP servers every harness reaches through the `app` server,
  one copy on the box, grants in aliax-core (src/main/server/addons/).
  [docs/agents/add-ons.md](docs/agents/add-ons.md)
- **Skills** — one store, materialized per host and provider
  (src/main/server/skills/); Codex and Muse get a pointer to a skill named in a
  message, never its body (slash.ts). [docs/agents/skills.md](docs/agents/skills.md)
- **Computer use** — the `tc-computer` Swift service (on Windows the Rust `tc-computer.exe`: UI Automation, posted messages and SendInput, PrintWindow capture; native/tc-computer-win, §29; the rig proofs `e2e-computer-win.ts` and `TC_WIN_RIG=1` winRig.hold.test.ts), the `computer_*` tools,
  confirmations, the session tier and the Mac bridge gate (src/main/server/computer/,
  docs/computer-protocol.md §17.8, §18; bridge timing, held calls and proof wrapper ordering);
  the journal of each call's steps and pictures (computer/history.ts, §17.9) behind the
  right panel's Computer section. Work holds edits in desktop Office and on listed
  co-authoring hosts (`coauthorRead`, src/shared/computer/outward.ts), with a fresh
  browser read and no grant. [docs/agents/computer-use.md](docs/agents/computer-use.md)
- **Live video** — the computer an agent drives as H.264 video on screen-relay's NSL1 wire
  (src/shared/video/nsl1.ts): `video.open`, `video.close`, `video.paste`, `video.copy`, a ticket per stream, the
  `/video/<stream>` socket and `VideoRelay` (src/main/server/video/), who may watch (`mayWatch`); the
  box's browser headed on a private display at twice the page's pixels (2560×1600, scale 2) under our own window manager, one `relay-engine` per
  viewer (src/main/server/work/browser/box/); the Mac's windows from tc-computer (`capture.video.*`
  on descriptor 3: Capture/VideoCapture.swift, ComputerService/Video.swift, the flow in
  ComputerServiceKit/FlowControl.swift); a PC's from tc-computer.exe on a named pipe: Windows.Graphics.Capture and
  Media Foundation's H.264 encoder, native/tc-computer-win/src/video and src/platform/video.rs, §30 "The Windows service"); the desktop's viewer in a worker
  (src/renderer/src/lib/video/), the Computers page (surfaces/ComputersView.tsx) and driving the box's page from the
  picture (`VideoInput`); the phone's viewer (ios/TempCodeClient Video/, `LivePicture`). [docs/agents/live-video.md](docs/agents/live-video.md)
- **Keep awake** — the Mac's display held awake while threads work (server/keepAwake.ts); a passwordless screen saver is not a lock (shared/screenState.ts). [docs/box.md](docs/box.md) "Keep awake"
- **Background work and watching** — background tasks on the session row, the
  Watching state, the Activity section (src/shared/watch.ts, lib/activity.ts).
  [docs/agents/background-work-and-watching.md](docs/agents/background-work-and-watching.md)
- **Review before merge** — the `merge_branch` tool's optional reviewer and
  gate (src/main/server/mergeReview.ts). [docs/agents/review-before-merge.md](docs/agents/review-before-merge.md)
- **The desktop transcript** — a viewport window (AgentTranscript.tsx,
  lib/transcriptWindow.ts), the streaming reveal, markdown in a worker.
  [docs/agents/desktop-transcript.md](docs/agents/desktop-transcript.md)
- **The interactive lane** — `session.focus`, request lanes and the push
  coalescer (src/main/server/lane.ts, focus.ts).
  [docs/agents/interactive-lane.md](docs/agents/interactive-lane.md)
- **The renderer over time** — React 19.3.1, the renderer soak and its gate
  rows, the rules that keep a push re-rendering only what it changed.
  [docs/agents/renderer-over-time.md](docs/agents/renderer-over-time.md)
- **The shape that scales** — profiling, checkpoints, the running cap and the
  stats worker. [docs/agents/shape-that-scales.md](docs/agents/shape-that-scales.md)
- **The iOS contract** — `ios/TempCodeContract` is generated from zod by
  `bun run gen:swift`; never edit Generated/. [docs/agents/ios-contract.md](docs/agents/ios-contract.md)
- **The iOS client** — ios/TempCodeClient and ios/TempCode, docs/IOS-DESIGN.md,
  the simulator proofs. [docs/agents/ios-client.md](docs/agents/ios-client.md)
- **Read and unread** — the host owns a thread's read mark
  (`sessions.read_at`, `SessionMeta.readAt`; `session.markRead` and
  `session.markUnread`), the desktop and the phone lay it over their own maps.
  [docs/agents/read-and-unread.md](docs/agents/read-and-unread.md)
- **Native chat source research** — what the T3 SwiftUI app and other native
  chat apps do that could carry over to the phone's transcript
  (docs/research/native-chat-rendering.md). [docs/agents/native-chat-source-research.md](docs/agents/native-chat-source-research.md)
- **The menu bar** — src/shared/menuTree.ts is the menu as data.
  [docs/agents/menu-bar.md](docs/agents/menu-bar.md)
- **The fleet switches** — Pause, Resume, Stop and Archive done over a scope
  (`session.batch`, lib/threadBatch.ts). [docs/agents/fleet-switches.md](docs/agents/fleet-switches.md)
- **Plans and the auto-start** — `plan_complete` and the build the host starts
  (src/main/server/planFlow.ts). [docs/agents/plans-auto-start.md](docs/agents/plans-auto-start.md)
- **One build per plan, the project plan** — the `project-plan` thread type
  (docs/PROJECT-PLAN.md). [docs/agents/plans-project-plan.md](docs/agents/plans-project-plan.md)
- **Master threads** — a pinned master's batch of root threads, the queue and
  running cap, the batch's steps engine, the board (docs/master-threads.md,
  src/main/server/batch.ts). [docs/agents/master-threads.md](docs/agents/master-threads.md)
- **Work editors** — what the document, sheet and deck kinds share: who hears a key (`data-editor-keys`,
  `MenuState.editing`), File → Print… and Export… as one `work:command` event a kind's Body answers
  (`useWorkCommands`), the Preview contract (`work/formats/preview.ts`, `previewProblems`), and the conversion
  runner's `+renderer` formats, `ready`, his press and the shared-file rule.
  [docs/agents/work-editors.md](docs/agents/work-editors.md)
- **Work: money** — receipts to a ledger by job (pillar 60, one of Work's pillars): the ledger is
  `Money/Ledger.tcsheet` in the workspace's own folder, made and written through the service's
  `/internal/sheet/*` and read by header name; `src/shared/work/money.ts` holds the rules, the sums and the
  one receipt parser; every way in waits in `work_money_inbox` and only his accept writes a row; a receipt is
  read by RapidOCR from the Docling tool folder, never a model; pay and miles from the calendar, a year's
  export, an invoice as a page the window prints; no act kind, every write refused for a thread;
  `bun run script:e2e-money`. [docs/agents/work-money.md](docs/agents/work-money.md)
- **work-kit** — the private package shared with LifeOS, pinned as a devDependency at
  `git+https://www.github.com/LandonDev/work-kit.git#<sha>` (bun cannot fetch a private
  `github:` spec), kept out of the app by electron-builder; scripts/workKitPin.test.ts.
  [docs/agents/work-kit.md](docs/agents/work-kit.md)
- **Work** — a job as a workspace (one per sector per host), behind one switch
  per host, off by default (`work.get`, `work.set`); code branches on the row
  (`workspaces.kind`, `sessions.scope`), never on the switch. All fifty
  milestones are built. The frame: `WORK_MODULES`, `WorkCtx`, one tool mount
  (`withWorkTools`, `app.workTools`); the composer's `@` for Work's things, a
  pillar's `mentions` within `mentionReachOf` (work-canvas.md "Mentions"); a pillar fills its own folder, edits no
  shared file and reaches the frame only through `WorkCtx`
  (`work/pillarReach.test.ts`); the screens are the rail's Work heading, Work
  Chats, the column's views (`WORK_VIEWS`), the canvas pane and Settings → Work
  ([docs/agents/work.md](docs/agents/work.md)). Scope and the fence: a Work
  thread is stamped once at create, follows its parent or starter on any host,
  and loads no MCP server but the app's own on Claude Code, Codex and Muse
  ([work-scope.md](docs/agents/work-scope.md)). The hold: every act that sends,
  posts, shares, books or submits is a held kind made through
  `ctx.held.create`, and so is an agent's own change to a file others can
  open (`office.edit`, `google.edit`: nothing reaches the file before his press) and runs only on his press in the Outbox or a narrow grant
  he made from a held item (or took when offered: five unedited presses in a row on one narrow matcher earn one offer, outbox/earned.ts); Away releases none; what it cannot catch (the
  shell, an unnamed control) is listed in the outbox's account below. The
  Work service is
  [work-service.md](docs/agents/work-service.md); whole jobs proven end to end,
  and what is still unproven, are [work-proofs.md](docs/agents/work-proofs.md);
  what we ship from others, and the tools run as separate processes, is
  `THIRD-PARTY-NOTICES.md`. Each pillar's account:
  [outbox](docs/agents/work-outbox.md), [canvas](docs/agents/work-canvas.md) (a file dropped from the desktop or picked with Open File… opens in the kind `kindForFile` names, kept in the workspace's folder), [lifeos](docs/agents/work-lifeos.md), [routines](docs/agents/work-routines.md) (a routine may run a pillar's host job, `WorkModule.jobs`, no thread), [rules](docs/agents/work-rules.md), [mail](docs/agents/work-mail.md) (work-kit's mail client on the host's LifeOS session: the list, the reader whose frames never touch the network, the composer, settings; a held draft's Send waits out its undo time in the window; an attachment opens in its canvas kind beside the mail, fetched by the host into the item's folder (`{at: 'mail'}`, `work.canvas.fetch`), the Mail view's own pane `mailPaneOf`, a document read only until Keep as document, Save to workspace `work.canvas.keep`; the look is docs/DESIGN.md "The Mail view"; Waiting on: sent mail no one answered, kept by LifeOS (`mailWaits`, `mail.waiting`), a nudge thread on his press, an opt-in routine, an unsent nudge dropped on a reply, `mail_waiting`), [tasks](docs/agents/work-tasks.md), [plays](docs/agents/work-plays.md) (a job's repeated work started with one press, in the routines pillar: `work_routines_plays`, the Plays view, Run a play… on a thing, Save as a play… on a thread; a routine may run one), [agenda](docs/agents/work-agenda.md), [people](docs/agents/work-people.md) (a page a person in the sector: the People view, `people:directory` and `people:page` in LifeOS, the ways in from Mail's `openPerson` and Agenda's attendees, the read-only `person_page` tool), [docs](docs/agents/work-docs.md), [history](docs/agents/work-history.md), [formats](docs/agents/work-formats.md), [sheets](docs/agents/work-sheets.md), [office](docs/agents/work-office.md), [Teams files](docs/agents/work-teams-files.md) (a Mac's OneDrive folders, and OneDrive in the box's Windows VM read through the guest's helper, `office/vm/`: a library there is the box's with `vm: true`, a place two machines hold shown once, `vmSignIn` walks his sign-in to his phone's number; Office tools go to the VM or the desktop by the file's key, `placesOf`) (his window opens a Mac's file into a box workspace: the box's fence passes another host's path only in the verbs `elsewherePath` lists, remote/fence.ts) (a place two machines hold is one row; an empty Files view names its true cause with its press; a file opens as its item with the thread folded, in the thread that already holds it (`filesThreads`); a new Work workspace starts with his desktops, the VM and the copy on), [google](docs/agents/work-google.md), [guests](docs/agents/work-guests.md), [pdf](docs/agents/work-pdf.md), [slides](docs/agents/work-slides.md) (a deck presented: the slideshow and the presenter's view, two windows the main window draws, `src/main/present.ts`, `work/slides/show/`), [media](docs/agents/work-media.md), [frameio](docs/agents/work-frameio.md), [meetings](docs/agents/work-meetings.md), [prep](docs/agents/work-prep.md) (a meeting's page, pillar 55: one page an event per workspace on its host, `work_prep_pages`; the facts read from LifeOS with no model by one gatherer that holds the sector fence, prep/gather.ts; `work.prep.*`, the push `work.prep`; a view with no column row, `WorkViewDef.inside`, opened by `openWorkView({view: 'prep', event})` from Agenda's Prepare and Follow up; a brief and a follow-up are Work threads the host starts on his press, writing through `prep_write` and `prep_follow_up`; suggested tasks filed on his tick, `work.prep.decide`; the follow-up mail is LifeOS's own held draft; Prepare ahead an opt-in routine, withheld for Purdue), [forms](docs/agents/work-forms.md), [dashboards](docs/agents/work-dashboards.md), [browser](docs/agents/work-browser.md), [projects](docs/agents/work-projects.md) (the project screens, mirrors and a Work project's settings; a later plan's pillar, 51); [Connections](docs/agents/work-connections.md) (Settings → Connections: every sign-in and helper per host as working, broken or needs you with its fix; a pillar's optional `health` on its module, `work.health`, `work.lapses`, the read-only `work_connections` tool, a toast before a known end), [capture](docs/agents/work-capture.md) (capture from anywhere, pillar 53: the global key and its own window in main, src/main/capture.ts and capture.html; a forwarded mail is LifeOS's own; the phone's voice note, transcribed on the phone, `VoiceNote` and `OnDeviceSpeech`; quick adds from "Capture" or "Unsorted"), [files](docs/agents/work-files.md) (the Files place, pillar 54, built to F0: the grammar `src/shared/work/files.ts` with `kindOfEntry`, the one table of file types; `work.files.*`; tabs kept on the workspace's host, a file tab a canvas item of `filesPaneOf`, deleted with its tab, `WorkModule.itemsRemoved`; one door for every change, files/policy.ts `locate`, `admitWrite`, `sharedOf`; files/write.ts; an import never writes beside a shared file; `bun run script:bench-files`; the Files row is still the Teams view), [search](docs/agents/work-search.md) (one search for everything in Work, pillar 62: a pillar lists `search: [source]` on its module, `SearchSource` in work/search/source.ts, and one with `mentions` alone is found through them; the frame `runSearch` holds every source to the wait, the fence checked twice, the cap and one quiet line a cause; `work.search.query` in two speeds and `work.search.opened`, both `approve`; Recent kept as titles and ids in `work_search_recent`), [clashes](docs/agents/work-clashes.md) (two events at once or too far apart to drive between, across jobs; LifeOS finds them, the host tells and masks), [templates](docs/agents/work-templates.md) (templates per job, pillar 59: a template is a file, his own in the workspace folder's `Templates`, the host's for all jobs, our starters by sector under `resources/work-templates`; a field is `{{Client}}` in the file's text, `src/shared/work/templates.ts`; Word and Excel filled as zips on a scratch copy, a deck by the slides pillar's edit; `work.templates.*`, `template_list`, `template_make`, `template_save`; `makeFromTemplate` in templates/api.ts for other pillars; `bun scripts/proof-bun.ts scripts/proof-templates.ts`), [digest](docs/agents/work-digest.md) (the one way Work tells him anything: `ctx.tell` with `done` and `quiet`, a deadline `by` and never a volume, `WorkModule.tells`; the rule `decide` in work/digest/rule.ts; the ledger `work_digest_*` and the day made once at his time; `work.digest.*`; a notice with no thread through `Notifier.work`, the `work` field on `Notice` and the relay)
