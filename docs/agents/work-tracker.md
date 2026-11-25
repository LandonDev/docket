# Work: the tracker

Seeing how five jobs are doing took five visits. **Projects** is one page above the workspaces, under the rail's
Work heading between Today and Review, that lists every job's open projects, one row a project, with what a person
deciding needs: the next step, who owes him and for how long, what its threads are doing, done of all, the target
date. A job's own Projects view draws the same rows for that job. Built 2026-11-25 (plan-ZJ20qeO56y5o, M7; the
picked prototype is `.temp-code/prototypes/work-threads-projects/b-tracker.html`, screen Tracker).

The tracker reads; it sends nothing and declares no act kind. A held act on a row's thread is still decided in the
Outbox's own detail.

## Files

| What | Where |
|---|---|
| The shapes and the rules (`TrackerProject`, `byTarget`, `byPressing`, `waitsOnHim`) | `src/shared/work/tracker.ts` |
| The host's part | `src/main/server/work/projects/overview.ts` (`work.projects.overview`) |
| The window's merge | `src/renderer/src/work/tracker/data.ts` (`useTracker`, `mergeOverviews`) |
| The page and its header | `src/renderer/src/work/tracker/TrackerPage.tsx` (`View`, `Head`, `TrackerBody`) |
| Where its presses go | `src/renderer/src/work/tracker/open.ts` |
| A page above the workspaces | the row in `src/renderer/src/lib/workPlaces.ts`, the place in `src/renderer/src/work/places/registry.ts` (docs/agents/work-today.md) |
| A project's threads in the window | `src/renderer/src/work/threads/roots.ts` (`projectRoots`, `useProjectRoots`, `leadOf`) |
| A thread's mark by its outcome | `src/renderer/src/work/threads/mark.tsx` (`OutcomeMark`) |
| The kit's thread slots | `src/renderer/src/work/projects/kit.tsx` (`useThreadFacts`, `useThreadLog`, `useThreadFiles`, `TaskThreads`) |

## The host method

`work.projects.overview {workspaceIds?}` (approve, read only) answers this host's Work jobs. For each Work workspace
with a sector, LifeOS is asked twice and at once, `projects:list` and `projects:facts`, for that sector alone. Each
open project (backlog, active, paused) gets its row: name, state, target, next task and when it is due, late and
due-today counts, the longest wait, done of all. The mirrors (TempCode projects with `lifeosProjectId`) and their
root Work threads are this host's own rows; a thread's outcome is the one its summary already carries
(`SessionMeta.workOutcome`, work/threads/record.ts), so nothing is read per project or per thread. A job LifeOS did
not answer for says why in `down` and lists nothing; the other jobs still answer. `down` is the host's raw text; the
window says it in plain words (`downWords`: `workErrorWords` with the host's name, else "The box could not read
Purdue Esports's projects from LifeOS.").

`work.projects.files {mirrorId}` (approve, read only) answers what a project mirror's root Work threads on this host
made or changed, for a project page's Files: `ThreadRecords.projectFiles` over the mirror's roots, archived ones too
(`mirrorRoots`, `mirrorFiles`: a file an archived thread made is still the project's, named by its root's title,
`rootTitle`, which a window may not hold), from the Results the keeper holds, with no LifeOS read. One row a thing at its newest write that stands, named by its
source (`sourceKeyOf`: a file by its place, a Google file by its id, a LifeOS item by its id, else its ref), so two
files of one name stay two; a `projects.link` Result carries the LifeOS item it made (`itemId` on its ref), which the
row passes on.

## The window

`useTracker()` asks every host with Work on (`askHosts`), once when the page shows, again on focus, each minute while
it stands, when a Work host's link opens or drops or a linked host's Work comes on, and on a down job's Retry
(`reload`). A link that drops says its line at once over the last answer, the other hosts' groups kept (`withClosed`),
so no all-clear stands on a host it cannot vouch for; only the newest read lands, never an older one that answers late. A host
whose link is not open is not asked: it answers its own line, "The box is connecting." or "The box is not connected."
(`closedWords`). The last answer is kept for the window's life, so a second visit draws it at once while the hosts
are asked again; bones show only on the first. `mergeOverviews` makes one job a sector: LifeOS's rows are the same
from every host of a sector, so a project's facts come from the first host that read them; its threads live on each
host, so the counts add up and the most pressing lead wins, with the host it lives on. A job one host failed to read
stands on the host that read it. A host that did not answer, or is not linked, is one quiet line over the groups; the
page still draws the rest, and says no all-clear ("No jobs yet", "Nothing waits on you") while any such line stands.

## The rules

- **Order.** Rows by target date, no target last, then by name (`byTarget`): a row never moves because its work did.
  Paused and backlog fold under each job behind one quiet line ("1 paused, 1 in backlog"), kept open or shut for the
  window's life.
- **The lead thread.** The most pressing root thread of the project's mirror (`byPressing`: a question, a failure,
  a held act, live work, a file made, an act done, then the newest).
- **Waiting on you** (`waitsOnHim`): a held act, a question or a failure among the threads, a late task, or one due
  today. Under the filter a job shows only those rows, with no fold; a job with none goes, a job that could not be
  read stays. With nothing left, and every host answered, the page says "Nothing waits on you". Held is drawn muted; the filter is where it
  reads as urgent. A row the filter keeps for a late or due waiting task, which LifeOS leaves out of Next, says the count
  where Next stands ("1 task late", `unsaidWait`), unless a pressing thread or Next's own date already says why.

## The page

Five groups, one a job in the order the first host lists them: its sector's dot hanging in the gutter and its name
(13px muted, on the rows' left edge), then its rows. One header row names the columns for the whole page. A row is
work-kit's `ProjectFactsRow` in `ProjectFactsTable` with the Threads column on: Project, Next (late in red with how
late, due today in the foreground), Waiting on (a name and an age), Threads (the lead's `OutcomeMark` and its outcome
words, its tip the thread's title and those words, `threadTip`, for a cell cut short; empty when the lead has
nothing to say), Done ("2 of 7"), Target. Under 760px the kit's table turns each row
into two lines. Loading is `ProjectFactsBones` under the header.

- **Presses.** The row opens the project's page in its job (`openProjectPage`: the window enters the job as a press
  on its rail row would, then `openWorkView({workspaceId, view: "projects", project})`). The Threads cell opens the
  lead thread (`workOpenPort`), not the row. Both close the page first.
- **New project.** A job's head shows a + on hover or focus (`reveal`); an empty job shows its name and a quiet New
  project alone. Either opens the job's Projects view with the kit's New project dialog over its list
  (`openNewProject` sets the job's place to `new`): the dialog needs the job's own LifeOS session, which the view
  holds, and Create lands on the new project's page there. Cancel, Escape or a press outside bring him back to the
  tracker (`whenNewDismissed` in projects/place.ts, once, the job's list behind it).
- **A job LifeOS could not be read for.** Where the window's own session for the job is down, `DownLine` says it in
  the shared words with its press (Retry, Sign in, Open Settings). Where that session reads and the host's read
  failed alone, the host's words with a Retry that asks the hosts again.
- **The header** holds one control: Waiting on you, a quiet outline `Toggle` (its hairline at rest says it is a
  press), kept for the window's life. Nothing sits beside
  the page's name.
- **The chunk.** The page is the place's own lazy chunk (`work-place-projects`, `WORK_PLACES`); the first paint holds
  only its rail row (scripts/entryGraph.test.ts).

## The slots

work-kit's project screens leave four thread slots to the host (work-kit `src/projects/README.md` "The thread
slots"). TempCode fills them in kit.tsx from what the window already holds: a project's threads are the root Work
threads of its mirrors in every Work workspace of the sector, on any host, not archived (`projectRoots`). Each slot
that is a hook is the same function for the kit's life.

- **`taskMark`**: every open `workLinks` thread of a task, newest first (`useLinkedThreads`, work/tasks/links.ts), each
  a 20px mark (its `OutcomeMark`, else its state at rest, else a thread glyph) with its title and outcome in the tip,
  each opening its own thread.
- **`log`**: the project's threads, newest first, each with its mark, its title and its outcome words (but a made
  outcome, which Files says thing by thing), opening the thread. The kit puts them among his notes and LifeOS's changes.
- **`files`**: what the project's threads made or changed, archived threads' too: one `work.projects.files` ask a
  mirror the catalog lists for the project (`useProjectMirrors` in work/threads/roots.ts, `useMadeFiles`, `mirrorsOf`),
  whether or not a live thread sits in it, asked again only when that host's Results move (the `work.outbox.result`
  push and a link back, as `resultsHostStamp` in work/outbox/results.ts counts them), each host's rows landing as it
  answers and its last answer kept for the window's life. It answers the kit's `ProjectFiles`: `pending` until every
  mirror's first read has answered, so "No files yet" waits; a host that refuses keeps the rows it last gave and sets
  `failed`, which the kit draws as one muted "Some files did not load." with a Retry button, never a file row. The
  tracker and the thread marks keep to live roots (`useProjectRoots`). A batch's files are a row each
  (`madeThingsOf`); a project link from before links named their item draws no row, since the project's own LifeOS row
  lists it. Newest first, one row a thing (`fileRows`: the host's `key`, a LifeOS item once across
  hosts, with its `itemId` so the kit merges it with the item's own row); an undone write is left out. "Made by Seat map for 64" and the time; Open goes to a Files tab of the job (`openInFiles`), a page on
  the web for a Google file, else the thread.
- **`threadFacts(sector)`**: each project's lead thread, its mark and outcome words, opening it, for the job's
  Projects list's Threads column. A project whose lead says nothing has no entry. The map keeps its identity while the
  roots are the same, so the kit's memoised rows keep their cells.

## Proof

- `src/renderer/src/work/tracker/TrackerPage.dom.test.tsx` (groups, order by target, the fold, Waiting on you, a
  held thread's "1 mail to send" and its press, a row opening the project, an empty job's New project, a down job,
  a silent host, the bones), `data.test.ts` (the merge), `src/main/server/work/projects/overview.test.ts`.
- `src/renderer/src/work/projects/kitSlots.dom.test.tsx` (taskMark with two links, log, files, threadFacts),
  `src/renderer/src/work/threads/roots.test.ts`, `src/renderer/src/work/projects/ProjectsView.dom.test.tsx` (the
  list's Threads cell).
- Look: `bun run ui:preview src/renderer/src/work/tracker/TrackerPage.preview.tsx#TrackerPreview --props
  '{"state":"all"}'` (`all`, `waiting`, `loading`, `silent`). A static shot draws no bones (they wait 150ms).
- Journey J63 (`scripts/journeys/J63-tracker.ts`, S, tier 2): two jobs on the sandbox, the tracker lists both, a held
  thread reads "1 mail to send", the row opens the project's page.
- Perf: row `view-Projects` (scripts/perf/rows/views.ts), budget B33 (300 ms kept; 1.5 s cold).
