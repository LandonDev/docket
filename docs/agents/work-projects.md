# Work: projects

The project screens of a linked Work workspace, the mirrors that hold a project's threads, a Work project's settings, and what the host does for a project (plan `plan-3OjTu0_U7Ed6`, milestones 1 and 6). The store is LifeOS's (its `docs/BRIEF.md`, and `.temp-code/plans/landed/P2.md` for every function); the screens are work-kit's (`work-kit/src/projects/README.md`, `landed/P4.md`). This file is TempCode's side.

## Three things called a project

| | Where it lives | What it holds |
|---|---|---|
| A LifeOS project | LifeOS (`projects`) | the name, the state (Backlog, Active, Paused, Done, Dropped), the description document, its tasks, documents, sheets, linked items, comments and history |
| Its mirror | this host (`projects.lifeos_project_id`) | the TempCode threads about it, the rules those threads open with, their account pins |
| A code project | this host | a checkout, a branch, build and review settings; nothing of this file |

A task is a LifeOS task. In a project it has a parent, a place among its siblings and a key (`PUR-41`), set once. The UI says "task"; a chip that names one by key is a "card".

## The Projects view

`src/renderer/src/work/projects/`, registered by `view.ts` (`WORK_VIEWS.projects`, between Tasks and Agenda, no trailing fact) as the lazy chunk `work-projects-view`. `ProjectsView.tsx` mounts `Projects` from `work-kit/projects` under three providers:

- **The client**: `createLifeosProjectsClient({ convex })` on the workspace's own LifeOS session (`lifeos.client`, a JWT narrowed to its sector), made once a session. Every read and write of a project, a task, a comment or a link is the screen's own, straight to LifeOS; the host is asked only for what is listed under "The host's side".
- **The kit** (`kit.tsx`, `projectsKitFor(env, workspaceId)`, one a workspace for the window's life): TempCode's face, hint, toast and key caps; `Document`, `openItem`, `Bar`, `verbs`, `threads`, `taskMark`, `menuLead`, `addItems`, `projectMenu` (Share…, Project settings…). The thread slots (work-kit's `src/projects/README.md` "The thread slots") are filled from what the window holds (docs/agents/work-tracker.md "The slots"): `taskMark` draws every open link's thread on a task, `log` the project's threads with their outcome, `files` what they made or changed (each thread's record), `threadFacts` each project's lead thread for the list's Threads column. What changes under the kit (the view's props, its dialogs) is read through `hostOf(workspaceId)` at a press, set by the view after each commit, so the kit never changes identity and nothing reads the view while the screens render.
- **The place** (`place.ts`): the kit has no router. `usePlace(workspaceId)` and `setPlace` keep where the screens stand (list or board, a project, its tab and layout, a task's peek or page, Display) one a workspace, in the window's storage (`work.projects.place.v1`), so the Projects row lands where he left. A stored value is read back part by part (`parsePlace`): one that is no place, and a half-typed New project, come back as the list, and a peek, a way back or a Display that is not what the screens read is left out, so a bad value cannot break the view on every visit.

**The screens** (work-kit's account is its `src/projects/README.md` "The screens"; the look is docs/DESIGN.md "Project screens"). The list is the tracker's rows for the job, drawn with work-kit's row parts (`ProjectFactsTable`, `ProjectFactsHeader`, `ProjectFactsRow`, `ProjectFactsFold`, `ProjectFactsBones`, which need no client, so the tracker across jobs, docs/agents/work-tracker.md, draws the same rows): Project, Next, Waiting on, Threads, Done ("2 of 7"), Target, by target date, paused and backlog under one quiet line, Done and Dropped under Show finished; the facts come from LifeOS's `projects:facts {sector}` on the workspace's session (a LifeOS without it draws the rows from the counts). A project's page is one reading column: name, facts line (job by its workspace's name, `jobName`; state; target), brief, Plan with the tree, Files, Log. New project is a dialog (Name, State, Target). The board is Board in the ⋯. A project's target is LifeOS's `projects.targetDate`, also set in its settings sheet.

**The header.** The kit hands its page bar to the host (`ProjectsKit.Bar`). `bar.tsx` draws it in the view's own 40px header through two slots the frame mounts: `Title` (a new seam of `WorkViewModule`, in place of the view's name: "Projects", or the way back from inside a project) and `Head` (the screen's controls: New project, New thread, New task, and the ⋯ with Board, Share…, Project settings… and Delete). Portals, so the controls keep the screens' providers. The verbs are quiet 28px buttons (`verbs: { primary: "ghost", size: "sm" }`), as every Work view's header holds. The way back is TempCode's own, one shape on every screen, drawn from what the kit says Back does (`Bar`'s `back` and `here`; the kit's own `crumb` is not drawn): a 24px ghost arrow, then the name of where it goes ("Projects", or the project a task or document was opened from). The list has none, and New project, a dialog over the list, none either. The app takes ⌘B for the sidebar before the screens hear a key, so the kit's tips name no chord the app owns (`hintKeys`): List and Board switch by the header's control.

**The scale.** `projects.css`, loaded with the chunk, sets work-kit's `--pk-*` measures to TempCode's: 32px rows of 13px words, the 18/26 title, radii 8, 6, 12 and 16, a card that is `background` on a `card` lane with a hairline and no shadow. The peek is measured on the view's pane (`.tc-projects` is a container): 44% of it. The work makes room only on a pane of 1280px or more, and under that the peek lies over the work, takes the focus and the work under it is inert: the kit's one rule, measured on the pane (`PEEK_ROOM_FROM`, `data-beside`), so the room and the focus never disagree. It asks nowhere which theme is on: the three hues are index.css's `--stage-doing`, `--stage-waiting`, `--stage-done` (`muted-foreground`, `waiting` and `success`, each with a value a theme), and the meter's dotted rest is `--chart-neutral-stale`. `--waiting` is a new status colour beside `--warning`. All are in `lib/tokenContrast.test.ts`. Work in hand takes no hue (`--stage-doing` is `muted-foreground`), as a working thread takes none: amber stays the sign that he is needed.

**Threads.** A project's threads live in its mirror. New thread on a project's bar and Start a thread in a task's menu call `work.project.open` (the mirror is made at this first ask) and then the view's `startThread(chip, { cwd, projectId })` with the project (`kind: 'project'`) or the task (`kind: 'task'`, the same chip the Tasks view sends, so the host links the thread and Done names it). A refusal (a finished project, LifeOS out of reach) is a toast and nothing opens. A task a thread works on shows that thread's mark in its row (the kit's `taskMark`: `workLinks:byEntity`, the newest open link, when this window holds the thread; M7 draws every open link's); a press opens the thread. Start thread is also on the row in hand. "Open a code thread…" leads a task's menu (`menuLead`), with the Tasks view's own dialog.

**Files.** The Files section of a project's page (once Documents) lists its LifeOS documents and sheets, its notes, links and files, and its linked items. TempCode adds four rows before the kit's Add link (`addRows`):

| Row | What it does |
|---|---|
| New document | `work.docs.create {sector, projectId, title}` (the host refuses a project that is not one of that sector), then the document opens in place |
| New sheet | LifeOS `sheets:create {projectId, title}` on the view's session; it shows in Files as the live read lands |
| Link a document or sheet… | `LinkPicker` over the workspace's catalog (`work.docs.find`): LifeOS's documents and sheets this project does not hold |
| Link a file or item… | the same picker over everything else the workspace lists (a file in its folder, a Google or Microsoft item); never an item only a thread can name |

A pick writes `work.projects.link`; a refusal stays in the picker as its one line. A press on a listed thing (`openItemIn`): a LifeOS document opens here in the shared editor, with the way back and the project's name in the header; a sheet, a legacy note and any other source start a thread in the project's mirror with the item as its chip; a link and a file open in the browser.

**The description** is a LifeOS document (`projects.docId`), mounted by `Description.tsx` in the shared editor through the document canvas's `useOpened` and `useDocument` (work/docs/DocumentCanvas.tsx), with no title of its own. While the Work service cannot be reached it is the stored lead, read-only, with the reason and Retry.

**Settings from the page.** A project's menu holds Project settings… (`kit.projectMenu`): the mirror is made at the ask if the project has none (`work.project.open {forSettings: true}`, which answers a finished project's mirror too, since the sheet is where he reopens it; a refusal is a toast) and the Work project's sheet opens on it (`ProjectSettingsDialog`, mounted by the frame beside the view's body, `Kept`, so a session that drops while it is open keeps the name he typed; the sheet says the session's line itself).

**Sharing.** A project is shown to one named person outside with a guest link ([work-guests.md](work-guests.md) "A project's link"): Share… in the project's ⋯ (a `projectMenu` row; the view opens the lazy `ShareSheet` on the LifeOS project) and the Sharing row of its settings sheet open the same sheet, which lists its links and makes one; an agent asks with `guest_link {projectId}`, held. The link is view only. While it lives, LifeOS reads the project and every document and sheet it shows as shared, so an agent's document write there is a suggestion, and a thread may neither link a document or sheet into the project (`link.ts`) nor make a document in it (LifeOS's `add_doc` reaches the Work service's `/internal/doc/create`, which refuses a shared project): either would put its text before the guest with nobody's press.

**From elsewhere.** A column card's menu has Open project, and a sent `project` chip and `card` chip open the view too: `openWorkView({ workspaceId, view: "projects", project | task })`. The view takes the target once, stands on it and clears it. A card chip names the task alone, so the view asks LifeOS which project holds it (`tasks:get`) and the task page's Back goes there.

**The column's cards** are every project still under way, oldest first: the order the screens keep inside a state (`projectOrder` from `work-kit/projects/order`), with no grouping by state, so a card does not move when its state does, set in `columnProjects` (work/shell/WorkColumn.tsx) inside the Work shell's chunk.

## Mirrors, settings, the gate

These landed first and are told in [work.md](work.md): "Mirrors follow LifeOS" (`work/projects/mirrors.ts`: a mirror is made from LifeOS's own row, renamed with it, archived when the project is over and none of its threads works, brought back on reopen), "A Work project's settings" (`work/shell/ProjectSettings.tsx`) and the server's refusal of code settings for a Work project (`workProjectGate.ts`).

## The phone

A project's LifeOS document or sheet opens in the hosted editor from LifeKitUI's project page (M5b:
`WorkLifeHost.offers(document:)`, `open(document:)` through `work.guests.ticket`); a note stays a plain row, and
the board stays on the computer.

## The host's side

`src/main/server/work/projects/` and `src/shared/contract-work-projects.ts`. `projects` is a pillar of the frame (`PILLAR_IDS`, milestone 51 in "not built" words).

- **`work.projects.link {workspaceId, lifeosProjectId, source, title}`** (operate) links a thing to a project: the one project write that needs the host (`link.ts`). A LifeOS document or sheet joins the project by its own `projectId` (`docs:setProject`, `sheets:setProject`); a file on a host, a Google or Microsoft item or a Frame.io file becomes a linked item (`projectItems:add`). The write is the owner's, so the host makes the checks a fenced key would get from LifeOS: the project is one of the workspace's sector (a finished one still takes a document), a document is one of that sector too (linking moves it into the project's), and a remote key names only a file it could have named itself (`ctx.reaches`, beside the listener's own fence of the `CanvasSource`). Another LifeOS row, a browser window and an item a thread made are refused in words. Answers `ProjectLinked`. A thread's own call is sent to its tool.
- **`project_link_item {project, item | source, title?}`**, the pillar's one tool: the same link for a thread, from one of its own pane's canvas items (a subagent's are its root's) or a named source, inside the thread's sector. A Work Chat links nothing. It records a Result (`projects.link`).
- **Everything else an agent does to a project goes through LifeOS's own tools** (`get_project`, `add_tasks`, `move_tasks`, `add_comment`, `list_changes`, `link_project_item` for a web address; `landed/P3.md`), which a Work thread reaches through its sector key. The pillar's preamble says so: read a project before working in it, name a task by its key, move it to Doing when you start, comment when you stop.
- **`@`**: a project is found by name through LifeOS's kinds (`lifeos/mentions.ts`); a project's card by its key, here (`mentions.ts`, `cardMention`): `@PUR-41` in any case, read with `tasks:byKeys`, kept only inside the reach's sectors. A task in no project is not a card: it is found by its words in the Tasks group, so no task is offered twice.

## Tests

- Host: `work/projects/projects.test.ts` (the link's every check, the method, the tool, the card mention), `mirrors.test.ts`, `work/core.test.ts` (`work.project.open`), `workProjectGate.test.ts`.
- Renderer: `work/projects/ProjectsView.dom.test.tsx` (the header's slots, the tracker's rows and their folds, the place, the New project dialog and its Cancel, Share… in the ⋯, Open project, threads and the mark, Files' rows and items, sent chips); `work/projects/kitSlots.dom.test.tsx` (the four thread slots) on work-kit's fake client; `projects.test.ts` (the place's storage and what it keeps of a stored value, what a picker offers); `work/shell/ProjectSettings.dom.test.tsx`; `work/shell/shell.test.ts` (the cards' order, the rows).
- Look: `bun run ui:preview src/renderer/src/work/projects/ProjectsView.preview.tsx#ProjectsPreview --width 1460` (the list with and without its Threads column, under 760px, its bones, the board, a project with and without its thread slots filled, its task board, the peek, a task's page, New project, on work-kit's fixtures; a static shot draws neither the bones, which wait 150ms, nor the dialog) and `work/shell/ProjectSettings.preview.tsx#WorkProjectSheetPreview`.
