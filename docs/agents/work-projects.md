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
- **The kit** (`kit.tsx`, `projectsKitFor(env, workspaceId)`, one a workspace for the window's life): TempCode's face, hint, toast and key caps; `Document`, `openItem`, `Bar`, `verbs`, `threads`, `menuLead`, `addItems`. What changes under the kit (the view's props, its dialogs) is read through `hostOf(workspaceId)` at a press, set by the view after each commit, so the kit never changes identity and nothing reads the view while the screens render.
- **The place** (`place.ts`): the kit has no router. `usePlace(workspaceId)` and `setPlace` keep where the screens stand (list or board, a project, its tab and layout, a task's peek or page, Display) one a workspace, in the window's storage (`work.projects.place.v1`), so the Projects row lands where he left. A stored value is read back part by part (`parsePlace`): one that is no place, and a half-typed New project, come back as the list, and a peek, a way back or a Display that is not what the screens read is left out, so a bad value cannot break the view on every visit.

**The header.** The kit hands its page bar to the host (`ProjectsKit.Bar`). `bar.tsx` draws it in the view's own 40px header through two slots the frame mounts: `Title` (a new seam of `WorkViewModule`, in place of the view's name: "Projects", or the way back from inside a project) and `Head` (the screen's controls: List or Board, New project, New thread, New task, Create). Portals, so the controls keep the screens' providers. The verbs are quiet 28px buttons (`verbs: { primary: "ghost", size: "sm" }`), as every Work view's header holds. The way back is TempCode's own, one shape on every screen, drawn from what the kit says Back does (`Bar`'s `back` and `here`; the kit's own `crumb` is not drawn): a 24px ghost arrow, the name of where it goes ("Projects", or the project a document was opened from), then what the screen adds beside it (a task's key, "New project"). The list has none. The app takes ⌘B for the sidebar before the screens hear a key, so the kit's tips name no chord the app owns (`hintKeys`): List and Board switch by the header's control.

**The scale.** `projects.css`, loaded with the chunk, sets work-kit's `--pk-*` measures to TempCode's: 32px rows of 13px words, the 18/26 title, radii 8, 6, 12 and 16, a card that is `background` on a `card` lane with a hairline and no shadow. The peek is measured on the view's pane (`.tc-projects` is a container): 44% of it, and the work makes room only on a pane of 1280px or more; the kit measures the window, which here holds the rail and the column too. It asks nowhere which theme is on: the three hues are index.css's `--stage-doing`, `--stage-waiting`, `--stage-done` (`muted-foreground`, `waiting` and `success`, each with a value a theme), and the meter's dotted rest is `--chart-neutral-stale`. `--waiting` is a new status colour beside `--warning`. All are in `lib/tokenContrast.test.ts`. Work in hand takes no hue (`--stage-doing` is `muted-foreground`), as a working thread takes none: amber stays the sign that he is needed.

**Threads.** A project's threads live in its mirror. New thread on a project's bar and Start a thread in a task's menu call `work.project.open` (the mirror is made at this first ask) and then the view's `startThread(chip, { cwd, projectId })` with the project (`kind: 'project'`) or the task (`kind: 'task'`, the same chip the Tasks view sends, so the host links the thread and Done names it). A refusal (a finished project, LifeOS out of reach) is a toast and nothing opens. A task a thread works on shows that thread's mark in its row (`workLinks:byEntity`, the newest open link, when this window holds the thread); a press opens the thread. "Open a code thread…" leads a task's menu (`menuLead`), with the Tasks view's own dialog.

**Documents.** The Documents section of a project's page lists its LifeOS documents and sheets, its notes, links and files, and its linked items. TempCode adds four rows before the kit's Add link (`addRows`):

| Row | What it does |
|---|---|
| New document | `work.docs.create {sector, projectId, title}` (the host refuses a project that is not one of that sector), then the document opens in place |
| New sheet | LifeOS `sheets:create {projectId, title}` on the view's session; it shows in Documents as the live read lands |
| Link a document or sheet… | `LinkPicker` over the workspace's catalog (`work.docs.find`): LifeOS's documents and sheets this project does not hold |
| Link a file or item… | the same picker over everything else the workspace lists (a file in its folder, a Google or Microsoft item); never an item only a thread can name |

A pick writes `work.projects.link`; a refusal stays in the picker as its one line. A press on a listed thing (`openItemIn`): a LifeOS document opens here in the shared editor, with the way back and the project's name in the header; a sheet, a legacy note and any other source start a thread in the project's mirror with the item as its chip, as the Docs view does (its opener holds documents only); a link and a file open in the browser.

**The description** is a LifeOS document (`projects.docId`), mounted by `Description.tsx` in the shared editor through the Docs view's own `useOpened` and `useDocument`, with no title of its own. While the Work service cannot be reached it is the stored lead, read-only, with the reason and Retry.

**Settings from the page.** A project's menu holds Project settings… (`kit.projectMenu`): the mirror is made at the ask if the project has none (`work.project.open {forSettings: true}`, which answers a finished project's mirror too, since the sheet is where he reopens it; a refusal is a toast) and the Work project's sheet opens on it (`ProjectSettingsDialog`, mounted by the view).

**Sharing.** A project is shown to one named person outside with a guest link ([work-guests.md](work-guests.md) "A project's link"): Share on the project's bar (`kit.share`, `ProjectShare`) and Sharing in its settings sheet list its links and make one; an agent asks with `guest_link {projectId}`, held. The link is view only. While it lives, LifeOS reads the project and every document and sheet it shows as shared, so an agent's document write there is a suggestion, and a thread may neither link a document or sheet into the project (`link.ts`) nor make a document in it (LifeOS's `add_doc` reaches the Work service's `/internal/doc/create`, which refuses a shared project): either would put its text before the guest with nobody's press.

**From elsewhere.** A column card's menu has Open project, and a sent `project` chip and `card` chip open the view too: `openWorkView({ workspaceId, view: "projects", project | task })`. The view takes the target once, stands on it and clears it. A card chip names the task alone, so the view asks LifeOS which project holds it (`tasks:get`) and the task page's Back goes there.

**The column's cards** are every project still under way, oldest first: the order the screens keep inside a state (`projectOrder` from `work-kit/projects/order`), with no grouping by state, so a card does not move when its state does, set in `columnProjects` (work/shell/WorkColumn.tsx) inside the Work shell's chunk.

## Mirrors, settings, the gate

These landed first and are told in [work.md](work.md): "Mirrors follow LifeOS" (`work/projects/mirrors.ts`: a mirror is made from LifeOS's own row, renamed with it, archived when the project is over and none of its threads works, brought back on reopen), "A Work project's settings" (`work/shell/ProjectSettings.tsx`) and the server's refusal of code settings for a Work project (`workProjectGate.ts`).

## The host's side

`src/main/server/work/projects/` and `src/shared/contract-work-projects.ts`. `projects` is a pillar of the frame (`PILLAR_IDS`, milestone 51 in "not built" words).

- **`work.projects.link {workspaceId, lifeosProjectId, source, title}`** (operate) links a thing to a project: the one project write that needs the host (`link.ts`). A LifeOS document or sheet joins the project by its own `projectId` (`docs:setProject`, `sheets:setProject`); a file on a host, a Google or Microsoft item or a Frame.io file becomes a linked item (`projectItems:add`). The write is the owner's, so the host makes the checks a fenced key would get from LifeOS: the project is one of the workspace's sector (a finished one still takes a document), a document is one of that sector too (linking moves it into the project's), and a remote key names only a file it could have named itself (`ctx.reaches`, beside the listener's own fence of the `CanvasSource`). Another LifeOS row, a browser window and an item a thread made are refused in words. Answers `ProjectLinked`. A thread's own call is sent to its tool.
- **`project_link_item {project, item | source, title?}`**, the pillar's one tool: the same link for a thread, from one of its own pane's canvas items (a subagent's are its root's) or a named source, inside the thread's sector. A Work Chat links nothing. It records a Result (`projects.link`).
- **Everything else an agent does to a project goes through LifeOS's own tools** (`get_project`, `add_tasks`, `move_tasks`, `add_comment`, `list_changes`, `link_project_item` for a web address; `landed/P3.md`), which a Work thread reaches through its sector key. The pillar's preamble says so: read a project before working in it, name a task by its key, move it to Doing when you start, comment when you stop.
- **`@`**: a project is found by name through LifeOS's kinds (`lifeos/mentions.ts`); a project's card by its key, here (`mentions.ts`, `cardMention`): `@PUR-41` in any case, read with `tasks:byKeys`, kept only inside the reach's sectors. A task in no project is not a card: it is found by its words in the Tasks group, so no task is offered twice.

## Tests

- Host: `work/projects/projects.test.ts` (the link's every check, the method, the tool, the card mention), `mirrors.test.ts`, `work/core.test.ts` (`work.project.open`), `workProjectGate.test.ts`.
- Renderer: `work/projects/ProjectsView.dom.test.tsx` (the header's slots, the place, New project, Open project, threads and the mark, Documents' rows and items, sent chips) on work-kit's fake client; `projects.test.ts` (the place's storage and what it keeps of a stored value, what a picker offers); `work/shell/ProjectSettings.dom.test.tsx`; `work/shell/shell.test.ts` (the cards' order, the rows).
- Look: `bun run ui:preview src/renderer/src/work/projects/ProjectsView.preview.tsx#ProjectsPreview --width 1460` (the list, the board, a project, its task board, the peek, a task's page, New project, on work-kit's fixtures) and `work/shell/ProjectSettings.preview.tsx#WorkProjectSheetPreview`.
