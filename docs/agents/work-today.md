# Work: Today

One page above the Work workspaces that lists, for every job on every host,
what waits on his press in the Outbox, today's meetings, the tasks due, the
mail no one answered and (once Files' read lands) the files others changed.
Each row acts in place or opens its thing in its own view. The look is
docs/DESIGN.md "Today"; the plan was `.temp-code/plan-jv8ZMpWjma9R.md`.

Today is built in the window alone. It has no pillar id, no server folder,
no table, no wire, no push and no tool: it reads what the views already
read. It has no phone page.

## Reaching it

- The first row under the rail's Work heading, while some host has Work on.
  It carries no count: the Outbox's is beside it.
- Go → Today, ⇧⌘T (Ctrl+Shift+T off macOS). The key toggles: pressed on
  Today it closes the page. The row is drawn in the menu only while Work is
  on (`workOnly` in src/shared/menuTree.ts; the window names it in
  `MenuState.hidden` otherwise), and the key does nothing while Work is off.
- The day's digest notice (`digestOpensPort`, set in lib/workPlaces.ts).
- It does not open by itself. `localStorage["work.today.opensAtDayStart"] =
  "true"` makes it open at the first focus of each day
  (`placeForDayStart`, lib/workPlaces.ts); no switch is drawn for it.

Back (⌘[) leaves the page as it leaves any page. It does not return to
Today after a row took him elsewhere: the shell keeps no history of pages.
⇧⌘T does, and the page is as he left it (its rows, folds and scroll are
kept for the life of the window).

## The place above the workspaces

Today is the first of the pages above the Work workspaces; the weekly
review is the second. Two lines add one:

- `src/renderer/src/lib/workPlaces.ts`: `WORK_PLACE_ROWS`, a row
  `{id, label, order, icon, key?}`. It is first-paint code, so it is plain
  data and its icon is one of chrome/icons. Today is `order: 10`.
- `src/renderer/src/work/places/registry.ts`: `WORK_PLACES[id] = {chunk}`.
  The chunk exports `View({onClose})` and may export `Head` (the header's
  end), `warm(why)` (read ahead on the row's hover or focus, and once at
  idle after launch) and `ready` (a short promise the frame waits for with
  the chunk). `places/registry.test.ts` holds every row to a place.

`shell.openWorkPlace(id | null)` opens or closes one and
`shell.toggleWorkPlace(id)` is a key's toggle (stores/shell.ts,
`workPlace`). A place is one of the shell's views: opening it closes the
others and they close it. `WorkPlacePage` (the `work-places` chunk) draws
the Outbox page's 40px header (the glyph, the label, the place's `Head`)
over the place's own chunk; Escape closes it. The window's title is the
place's label. With Work off the rail is what it was
(chrome/WorkRail.dom.test.tsx).

## Where each row comes from

| Section | Source | Reads | Lives on |
|---|---|---|---|
| Waiting on you | `today/held.ts` | the Outbox's own store (`work.outbox.list` per host, live on the `work.outbox` push) | each host |
| Meetings | `today/meetings.ts` | LifeOS `events:range {from, to}` over two local days; `people:directory {sector}` for each sector a job holds | LifeOS, once |
| Due | `today/due.ts` | LifeOS `tasks:list {}`, kept by work-kit's `isTodayTask` | LifeOS, once |
| Waiting on others | `today/waiting.ts` | LifeOS `mailWaits:list {paginationOpts}`, the first page of 20 | LifeOS, once |
| Changed by others | `today/files.ts` | `work.files.changed {workspaceId}` per job | each host |

The Files source is written and tested against a fake wire and is **not**
in `TODAY_SOURCES`: Files has not built `work.files.changed`. Registering it
is one line in `today/sources.ts`; it then opens a file with
`work.files.open` and the job's Files view (`openFile`), which Files' own
`openInFiles` may replace.

What a row does:

- **Waiting on you.** The Outbox's waiting items, oldest first, words from
  `rowWords`, time from `timeOf`. A press opens `HeldSheet`: a sheet from
  the right, 520px, whose body is the Outbox's own `HeldDetail` (exported
  from work/outbox for this), with its Send, Edit, Discard and grant menu
  and its rule that Send waits until the whole item is on screen. After a
  press the sheet shows the next held item, and closes after the last.
  **Today adds no way to send**, and no Send is ever drawn in a row.
- **Meetings.** Today's events, all-day first, then by start; the second
  line is the place and the job's people who are there. Events that ended
  fold into "N earlier". The one live line under a time is "Leave 5:10 PM"
  while that is ahead, then "in 25 min" within the hour, then "Now". The
  press opens the event in its job's Agenda; Prepare starts a thread about
  it there. Once every meeting has ended the section says "Nothing more
  today" and, where there is one, "Tomorrow starts at 9:00 AM with …".
- **Due.** The most overdue first, then today's by time, then the pinned
  with no date. The tick holds 350ms, then completes through the job's host
  (`work.tasks.done`), so a task a thread worked completes with that
  thread's link; its toast offers Undo (`tasks:reopen`). Tomorrow snoozes it
  to the next morning (`tasks:snooze`, Undo `tasks:unsnooze`). The press
  opens the task's sheet in its job's Tasks view.
- **Waiting on others.** The longest wait first. Nudge asks the job's host
  for a drafting thread (`work.mail.nudge`) and opens it; Dismiss is
  `mailWaits:dismiss` fenced by `since`, with Undo (`mailWaits:putBack`).
  The press opens the mail in its job's Mail view. Put off stays in Mail.

A LifeOS row whose sector has no Work workspace is left out. `goTo`
(today/open.ts) is the one way a row opens its thing: the window moves to
the job's workspace (`project.enterWorkspace`) and `openWorkView` takes the
target. Work workspaces are matched by sector, never by link: where two
hosts hold one for a sector, the row opens in the one on `workHome()`, else
the first whose link is open (`workspaceFor`, today/model.ts).

## One LifeOS session

LifeOS is one backend for every job, so its three sections are read once,
through one session for all sectors on one host, never once per host. That
keeps one fact from showing twice and lets a slow or absent host hold up
nothing.

- The host is the Work home when its link is open, else the first open host
  that holds a job (`lifeosHosts`, today/lifeos.ts). A host found signed
  out, refused or out of reach gives way to the next (`pickHost`,
  today/env.ts); the set is forgotten when the hosts change and on Retry.
- `work.lifeos.jwt {}` answers a JWT of the host's whole device session:
  the host trades its token with no sectors named
  (work/lifeos/lifeos.test.ts holds it), and LifeOS's `auth:token` then
  gives the session's own scope, which is every sector unless the session
  was made narrower. `auth:caller` says which. A job whose sector the
  session lacks is read through a session narrowed to that sector on
  another host that holds the job, and the rows are merged by id
  (`useLifeosRows`, `lackingOf`).
- While no host can read LifeOS, its sections give way to one line where the
  first stood: "LifeOS did not answer" with Retry, or "Not signed in to
  LifeOS" with Sign in (Settings → Connections).

## Adding to Today

One way: a `TodaySource`. Write `src/renderer/src/work/<slug>/today.ts`
that exports `source`, and add one line to `TODAY_SOURCES` in
`src/renderer/src/work/today/sources.ts`. The types are
`work/today/types.ts`.

```ts
// src/renderer/src/work/money/today.ts
import { useMemo } from "react";
import { openWorkView } from "../../lib/workSwitch";
import { useEachWorkspace } from "../today/read";
import type { TodayAnswer, TodayEnv, TodaySource } from "../today/types";

type Owed = { rows: { row: string; who: string; amount: string; since: number }[] };

function useOwed(env: TodayEnv): TodayAnswer {
  const read = useEachWorkspace<Owed>(env, "work.money.owed", (w) => ({ workspaceId: w.workspaceId }), { push: "work.money" });
  return useMemo(
    () => ({
      rows: read.answers.flatMap(({ workspace, value }) =>
        value.rows.map((r) => ({
          key: `owed:${r.row}`,
          section: "money",
          sector: workspace.sector,
          title: `${r.who} owes ${r.amount}`,
          at: r.since,
          open: () => openWorkView({ workspaceId: workspace.workspaceId, view: "money" }),
        })),
      ),
      loading: read.loading,
      failed: read.failed,
    }),
    [read],
  );
}

export const source: TodaySource = { id: "money", section: { id: "money", title: "Money", order: 60, empty: "No one owes you" }, use: useOwed };
```

- A **row** is a thing in a section: `key` (`<kind>:<stable id>`; the same
  key twice is one row, the first source in the registry's order wins),
  `section`, `sector`, `title`, and optionally `detail`, `at` (what the
  section orders by, ascending), `when` (the trailing fact), `whenLine` (one
  live line under it), `late`, `past`, `lead` (a tick or a glyph), `open`,
  and at most two `acts`.
- A **mark** says something about a row another source made, found by its
  key: its `note` takes the row's second line (a `late` note wins and is
  drawn in the failed tone), its `whenLine` takes the place of the row's own
  live line, `open` replaces the press and `act` leads the verbs. A mark
  with no row draws nothing. Prep and clashes show on a meeting this way,
  with no second row for it.
- A **section** of a source's own: `{id, title, order, empty, fold?,
  lifeos?}`. Today's are `held` 10, `meetings` 20, `due` 30, `waiting` 40,
  `files` 50. `also` (title "Also", order 90) is Today's own, drawn only
  while it has a row: a source adds rows to it and declares no section. A
  section whose `empty` is `""` is likewise drawn only while it has a row
  (or a host that did not answer): it never draws bones or a bare heading.
- `use` must be a real hook function assigned as `use: useMine`, so the
  React Compiler treats it as one. Answer the same object while nothing
  changed (`useMemo`), and keep each row the same object while it shows the
  same (`useStableRows`, today/stable.ts): rows are memoised.
- `useEachWorkspace(env, method, paramsOf, {push})` (today/read.ts) is the
  read for rows that live on hosts: one call per Work workspace on every
  host with Work on, each on its own, six seconds at most, asked again on
  the named push and when a link opens. It answers what has come back so
  far; a host whose link is not open is skipped.
- A row his own act takes off the page calls `leave(key)` (today/store.ts)
  and `comeBack(key)` if the act fails or he undoes it.
- A source that fails to load, or throws while it runs, is left out and
  logged; the page shows the rest.

Row keys Today makes: `held:<environmentId>:<ref.at>:<ref.id>`,
`event:<id>`, `task:<id>`, `mail:<id>`, `file:<FileEntry.key>`.

## The page

`today/model.ts` is the page with no React: `merge` (one row per key, marks
laid on, sections by order, rows by `at`), `fold` (the past rows folded at
the head, "N more" at the foot), `page` (the states below) and `dayBounds`
(local midnight to the next, by the calendar, so a day of 23 or 25 hours is
one day). `TodayView.tsx` draws it; `TodayRow.tsx` is the one row grid.

| State | What the page shows |
|---|---|
| A section has never answered | its heading and three bones |
| A section is empty | its heading and one muted line |
| Everything answered, nothing anywhere | "All clear", "Nothing needs you today." |
| A host with jobs is offline | one muted line at the foot for each |
| A host did not answer in time | a line in the section it feeds, with Retry |
| No host can reach LifeOS | one line in place of the LifeOS sections |
| No Work workspace has a sector | "No jobs yet", with Add workspace |
| Work is off on every host | no rail row, no menu row, the key does nothing |

Folds: Waiting on you 5, Due 7, Waiting on others 5, Changed by others 5.
An unfolded section stays open until the window closes.

Keys: every row on the page is one list, one tab stop. ↑ ↓ Home End move;
Enter opens the row; Space ticks a task. The row the arrows are on shows
its verbs, and takes Tab with its own controls. Focus lands on the first
row when the page opens. Esc closes the page.

## Speed

- **The first frame has rows.** The Outbox's store is live from boot, and
  the sources are loaded with the page's chunk (`ready`), so Waiting on you
  paints at once. Every source's last answer is kept in `today/store.ts`
  for the life of the window, and a source that is reading again keeps the
  rows it had, so a reopen paints them and the live read corrects them.
- **Kept warm** (`today/warm.tsx`). The sources are hooks, so something must
  be mounted for them to run: the page runs them while it is open, and a
  root of their own, in no document, runs them for ten minutes after it
  closes. The chunk is loaded at idle while Work is on. The sources start on
  the rail row's hover or focus, and once at idle after launch if he opened
  Today today or on either of the two days before
  (`localStorage["work.today.opened.v1"]`: two dates, nothing else).
- **No whole-page wait** and no motion on open or close.
- **Rows redraw alone**: a minute's tick moves only the meeting's live line.
- The first paint pays for `lib/workPlaces.ts`, one icon and a few lines in
  the rail, the shell store and App.

## Proofs

- `today/model.test.ts`, `read.test.ts`, `lifeos.test.ts`, `store.test.ts`,
  `sources.test.ts`: the model, the host read, the host choice, the store
  and the three sources' rows, pure.
- `today/lifeos.dom.test.tsx`, `sources.dom.test.tsx`, `files.dom.test.tsx`:
  the sources against a LifeOS in memory (`today/fakeLifeos.ts`) and hosts
  that answer from memory: what each reads and each act's method and params.
- `today/TodayView.dom.test.tsx`: the page, the sheet and its Send rule, the
  keys, the leaving and landing row. `today/warm.dom.test.tsx`: the keeper
  and the habit.
- `places/registry.test.ts`, `lib/workPlaces.dom.test.ts`,
  `stores/shell.test.ts`, `chrome/WorkRail.dom.test.tsx`,
  `shared/menuTree.test.ts`, `lib/appCommands.test.ts`,
  `lib/nativeMenuState.dom.test.ts`: the place, the rail, the menu and the key.
- `bun run ui:preview src/renderer/src/work/today/TodayView.preview.tsx#TodayPreview --shot`:
  every state in light and dark, with made-up rows.
- The live run and the timings: `.temp-code/plans/landed/R3-today.md`.
