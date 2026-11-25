# Work: Today

One page above the Work workspaces that lists, for every job on every host,
what waits on his press in the Outbox, today's meetings, the tasks due, the
mail no one answered and (once Files' read lands) the files others changed.
Each row acts in place or opens its thing in its own view. The look is
docs/DESIGN.md "Today"; the plan was `.temp-code/plan-jv8ZMpWjma9R.md`.

Today is built in the window alone. It has no pillar id, no server folder,
no table, no wire, no push and no tool: it reads what the views already
read. The phone gets no host method either: it ports these rules to Swift
("The phone" below), and its page arrives with M1a's screen.

## Reaching it

- The first row under the rail's Work heading, while some host has Work on.
  It carries no count: Today is not a queue. Open, it wears the workspace
  cards' selected fill, and its hover shows the key, read from the Work
  keybindings by the row's label (`shortcutFor("Work", label)`).
- Go → Today, ⇧⌘T (Ctrl+Shift+T off macOS). The key toggles: pressed on
  Today it closes the page, and the menu's row reads "Close Today" while
  the page is open (a `toggle` row; the window names `open_today` in
  `MenuState.open`). The row is drawn in the menu only while Work is on
  (`workOnly` in src/shared/menuTree.ts; the window names it in
  `MenuState.hidden` otherwise, and main takes only `WORK_ONLY_IDS` from
  that list, src/main/menu.ts), and the key does nothing while Work is off.
  The key is listed in Settings → Keybindings under Work; that page lists
  keys and changes none.
- The day's digest notice (`digestOpensPort`, set in lib/workPlaces.ts).
- It does not open by itself. `localStorage["work.today.opensAtDayStart"] =
  "true"` makes it open at the first focus of each day
  (`placeForDayStart`, lib/workPlaces.ts); no switch is drawn for it.

Back (⌘[) leaves the page as it leaves any page. It does not return to
Today after a row took him elsewhere: the shell keeps no history of pages.
⇧⌘T does, and the page is as he left it (its rows, folds, scroll and the
row the arrows were on are kept for the life of the window).

## The place above the workspaces

Today is the first of the pages above the Work workspaces; the weekly
review is the second. Two lines add one:

- `src/renderer/src/lib/workPlaces.ts`: `WORK_PLACE_ROWS`, a row
  `{id, label, order, icon}`. It is first-paint code, so it is plain
  data and its icon is one of chrome/icons. Today is `order: 10`. A row
  whose label is a binding in the Work keybindings shows that key on hover.
- `src/renderer/src/work/places/registry.ts`: `WORK_PLACES[id] = {chunk}`.
  The chunk exports `View({onClose})` and may export `Head` (the header's
  end), `warm(why)` (`intent` on the row's hover or focus, which loads the
  chunk and asks nothing for Today; `idle` once after launch) and `ready` (a short promise the frame waits for with
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
| Waiting on others | `today/waiting.ts` | LifeOS `mailWaits:list {paginationOpts}`, one page of 100, ready after one answer; where LifeOS says there is more past it, the section never says it is empty (`away`) | LifeOS, once |
| Changed by others | `today/files.ts` | `work.files.changed {workspaceId}` per job | each host |
| Responses | `msforms/today.ts` | `work.msforms.list {workspaceId}` per job, live on the `work.msforms` push: one row a Microsoft form with unseen answers ("3 new responses"), section order 70, folded past five, drawn only while it has a row; a press opens the form in its Files tab (`openInFiles`, the `msform` source) | each host |

The Files source is written and tested against a fake wire and is **not**
in `TODAY_SOURCES`: Files has not built `work.files.changed`. Registering it
is one line in `today/sources.ts`; it then opens a file through Files' own
`openInFiles` (work/files/openFrom.ts), which is on master, and the job's
Files view (`openFile`).

What a row does:

- **Waiting on you.** The Outbox's waiting items, oldest first, words from
  `rowWords`, time from `heldWhen` (a time that names its day). A press opens `HeldSheet`: a sheet from
  the right, 520px, whose body is the Outbox's own `HeldDetail` (exported
  from work/outbox for this), with its Send, Edit, Discard and grant menu
  and its rule that Send waits until the whole item is on screen. After a
  press the sheet shows the next held item, and closes after the last. The
  next is picked from the order he saw (`nextHeld`), so a list the host
  refreshed while the press was out still hands the sheet on; the head
  counts the run by its own steps ("2 of 3": `heldDone` in today/store.ts,
  of those and the items that still wait, which leaves out what his press
  already took, so the count never waits for the host's reload); the item
  that takes the sheet fades in, takes the focus and takes no pointer until
  the fade is over; a press that does not go through is said in the item's
  own red line (`HeldDetail`'s `alone`: a sheet lies over the toasts); and
  a sheet that closes gives focus back to the list's own stop, or to the
  page's region once no row is left. The next item is picked among those
  that still wait, never one his press already took, and what it holds is
  inert until its fade is over. A held row names the place its item is in
  as the sheet does (`TodayRow.job`, `placeOf`: the workspace by host and
  id, or Work Chats) and says when it was held as a time that names its
  day (`heldWhen`, work/outbox/when.ts; the sheet's head says the same).
  **Today adds no way to send**, and no Send is ever drawn in a row.
- **Meetings.** Today's events, all-day first, then by start; the second
  line is the place and the job's people who are there. Events that ended
  fold into "N earlier". The one live line under a time is "Leave 5:10 PM"
  while that is ahead, then "in 25 min" within the hour, then "Now". The
  press opens the event in its job's Agenda; Prepare starts a thread about
  it there. Once every meeting has ended the "N earlier" line says so, and
  the section's one line under it says what comes next, where there is one:
  "Tomorrow starts at 9:00 AM with …". A meeting that ended is not left:
  with nothing else on the page it is "All clear" over that line.
- **Due.** The most overdue first, then today's by time, then the pinned
  with no date. The tick holds 350ms, then completes through the job's host
  (`work.tasks.done`), so a task a thread worked completes with that
  thread's link; its toast offers Undo (`tasks:reopen`). Tomorrow snoozes it
  to the next morning (`tasks:snooze`, Undo `tasks:unsnooze`). The press
  opens the task's sheet in its job's Tasks view, whose Start thread files a
  task of a LifeOS project under the project (work-tasks.md). A task of a
  LifeOS project names it on the row's second line and adds Open project,
  its page in the job's Projects view; the names come from one
  `projects:list` read on the same session, and no row waits for it. While
  a job's names are out, or when they fail, Open project still opens the
  project by the task's `projectId` (`projectOfTask`, by the read's
  per-sector `known`: another job's names having come says nothing of this
  one's); a failed read, the first or one job's own, says "Project names
  did not load" once, at the section's foot (`namesNote`, `namesFailed`).
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
  today/env.ts); the set is forgotten when the hosts change. While the host
  read is down, one passed over is read again once its LifeOS status, heard
  since it was passed over, says connected (`useBackAgain`, at most
  `PASSED_MOST` hosts heard), never under a Retry, which keeps the computer
  its line names until the ask is back.
- `work.lifeos.jwt {}` answers a JWT of the host's whole device session:
  the host trades its token with no sectors named
  (work/lifeos/lifeos.test.ts holds it), and LifeOS's `auth:token` then
  gives the session's own scope, which is every sector unless the session
  was made narrower. `auth:caller` says which. A job whose sector the
  session lacks is read through a session narrowed to that sector on
  another host that holds the job, and the rows are merged by id
  (`useLifeosRows`, `lackingOf`).
- A list is whole only once the session has said its cover and every such
  sector read has answered. Until then it is `pending`: the section shows
  the rows that came, or bones, and never its empty line, so "All clear" is
  never said on half an answer. A read LifeOS refused, or a sector read
  that failed, is one line in the section ("LifeOS could not read tasks")
  with Retry, which lets go of every read of that list and asks afresh
  (`answerOf`, today/lifeos.ts). A job whose sector the session lacks and
  no other open host holds cannot be read at all (`uncoveredOf`): its
  section says so by the job's name, with no Retry ("No signed-in host can
  read Ref's tasks"). A section that holds rows while such a read is out
  draws one bone under them (`ShownSection.partial`).
- A row is written through the session that read it (`Rows.sessionOf`):
  Tomorrow, Dismiss and every Undo of a sector read on another host go
  through that sector's own session, never the first one, which lacks it.
- A row's presses close over the session they write through and the job
  they open in. When either is another (the host changed, a workspace
  moved, a sector's session changed), every row is made again
  (`useStableRows(rows, ways)`), so no row on the page acts through one
  that is gone.
- While no host can read LifeOS, its sections give way to one line where the
  first stood, in the session's true state (`reachOf`, `shell/lifeosDown.ts`)
  and the view frame's words (`sessionFailure`, naming the host the session
  reads through): "LifeOS did not answer the box", or "The box did not
  answer" when the host's own status or session ask went unanswered
  (`unanswered`), with Retry, which asks the computer the line names and
  keeps the page on it while the ask is out (`env.ts`); "Not signed in to
  LifeOS on the box" or "LifeOS refused the box's sign-in" with Sign in, and
  "The LifeOS sign-in on the box waits for your approval" with Show the code
  (both open the sign-in dialog in place), where this window may sign the
  host in; "LifeOS is still connecting on the box" with a spinner and no
  press while that host says it is connecting (`connecting`, from
  `useHostLive`; a status not heard yet keeps the sections' bones); "Work is off on the box" with Open Settings where this window may
  turn Work on; else no press and who can ("Sign in from a computer that
  manages the box" for a sign-in, "Changed from a computer that manages the
  box" for the switch); a computer the host keeps LifeOS from ("This computer cannot read
  LifeOS through the box") with no press, since none can help. A job read
  through a narrowed session on another host that is down (`Lost.down`)
  is said once for the page, not in each section it feeds: one line a host
  and state (`lostLine` in model.ts, a `lost` block in the place of the
  first section it fed), that session's state by the same rule, then what
  every section left out ("Refereeing's meetings, tasks and mail left out",
  `TodayFailure.left`); its Retry asks that host for its own sessions alone,
  once each (`Rows.retryLost`), never another host; a computer kept from
  LifeOS there has no press, and the jobs that read stay. A section that lost
  a read to it says no empty line (`ShownSection.left`); one that held
  nothing else is left out whole, as is one whose only read was lost to an
  offline host the foot names (`bare` in model.ts), and the page is still
  never All clear over either. A job read through another host whose LifeOS
  says it is connecting (`Lost.waits`, from `useHostLive` on that slot's host)
  is said the same way, once for the page by host, "LifeOS is still connecting
  on Mac" over what it left out, with no press; once that host is back, its
  sections show their own loading until the rows land.
  A held calendar act's details use the same helper. A muted line with no
  press wraps across the job and time columns; one with Sign in wraps in
  the titles' column.
- A failed read's muted detail, cut on a narrow page, is a Tab stop with its
  whole words in a tip (the canvas's `CutDetail`).

## Adding to Today

One way: a `TodaySource`. Write `src/renderer/src/work/<slug>/today.ts`
that exports `source`, and add one line to `TODAY_SOURCES` in
`src/renderer/src/work/today/sources.ts`. The types are
`work/today/types.ts`.

Money's (`work/money/today.ts`, trimmed) is the pattern for rows that live
on hosts:

```ts
function useOwed(env: TodayEnv): TodayAnswer {
  const read = useEachWorkspace<MoneyOwed>(env, "work.money.owed", (w) => ({ workspaceId: w.workspaceId }), { push: "work.money" });
  return useMemo(() => ({ rows: owedRows(read.answers), loading: read.loading, failed: read.failed }), [read]);
}

// Each row names the workspace its host answered for (`job: workspace.name`) and opens it (`goTo`).
export const source: TodaySource = { id: "money", section: { id: "money", title: "Owed", order: 60, empty: "", fold: 5 }, use: useOwed };
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
  lifeos?, bones?}` (`bones`: `"lines"` where its rows have a second line,
  `"tick"` where a tick leads them, so its bones stand as tall as its
  rows). Today's are `held` 10, `meetings` 20, `due` 30, `waiting` 40,
  `files` 50. `also` (title "Also", order 90) is Today's own, drawn only
  while it has a row: a source adds rows to it and declares no section. A
  section whose `empty` is `""` is likewise drawn only while it has a row
  (or a host that did not answer): it never draws bones or a bare heading.
- `use` must be a real hook function assigned as `use: useMine`, so the
  React Compiler treats it as one. Answer the same object while nothing
  changed (`useMemo`), and keep each row the same object while it shows the
  same (`useStableRows(rows, ways)`, today/stable.ts; `ways` is whatever
  the rows' presses close over, or null): rows are memoised.
- A read that did not come back is a `failed` entry `{environmentId, error,
  said?, retry?}`: the page says "<host> did not answer" only for the wait
  running out (`TIMED_OUT`, today/read.ts); else the error as Work says it
  (`hostFailureWords`, through `workErrorWords`), its first sentence the
  line's word ("The connection to Mac dropped.") and the rest its muted
  detail, which gives way first ("Try again once it is back."), and
  "<host> could not read this" where it has no plain words, never the
  host's raw text;
  `said` is the whole line in its place, for a read no host is at fault
  for ("LifeOS could not read clashes"). A failure from a host whose link
  is not open is no section's line: `page` takes it out and names the host
  once at the foot (model.ts `apart`), since its link refused at once and
  Retry cannot mend it; the section it fed never says it is empty then
  (`away`), since what that host holds is not known. The same line from
  two sources is drawn once. A
  source that reads LifeOS says nothing of its own while the session is
  down (`sessionDown`): the page's one LifeOS line says it.
- `useEachWorkspace(env, method, paramsOf, {push})` (today/read.ts) is the
  read for rows that live on hosts: one call per Work workspace on every
  host with Work on, each on its own, six seconds at most, asked again on
  the named push and when a link opens. It answers what has come back so
  far; a host whose link is not open is skipped. It is `loading` until it
  is handed its jobs, and while a failed read is asked again by Retry, so
  neither is taken for a job with nothing. `again` names what the asks
  depend on beside the jobs: when it changes every job is asked again
  (Prep passes the day, so midnight asks for the new one). Each job's last
  value is kept for the life of the window, by method (`lastOf`), and
  forgotten when the job leaves: a read made afresh (a reopen) is primed
  with the jobs there are now (`prime`, from its first frame), so it shows
  their last values and never a job removed while Today was closed; a fast
  job's answer never drops a slow job's rows, and a job whose read fails
  keeps its own. While every job still out has such a value the read is
  `stale`: the page draws its rows, or its empty line, with no bones or cue
  that more may come, though it is not clear until they answer. A job
  whose host is offline is not asked, and the read says so (`away`): its
  section never says it is empty. A source passes all of this on in one
  spread, `readState(read)`, beside its rows. A source whose words turn
  with the day (Owed's "Today", Messages' "2:00 PM") takes `env.day` as an
  input of its memo.
- A row his own act takes off the page calls `leave(key)` (today/store.ts)
  and `comeBack(key)` if the act fails or he undoes it.
- A source still loading draws nothing and keeps the page from "All
  clear" (`pending` in today/store.ts). One that fails to load, or throws
  while it runs, is run no more and said on the page in one line: "Today
  could not show this" in its own section, or under Also with what is
  missing, from the registry's `what` ("Today could not show clashes"; a
  source whose chunk did not load never drew its section, so it is named
  there too: "Today could not show what is due").
  The page shows the rest and is never "All clear" over it. A read that
  failed in a source with no section is said under Also the same way.
  Prep drops its failures on purpose (a mark is only an extra, and a
  missing one makes no row look done). The review is `loading` until each
  linked host with a job has answered; a host that refuses
  `work.review.ready` (one from before the review) has no review to name.

Row keys Today makes: `held:<environmentId>:<ref.at>:<ref.id>`,
`event:<id>`, `task:<id>`, `mail:<id>`, `file:<FileEntry.key>`, and
Messages' `chat:<chatId>:<at>`, by the last message, so one he marked read
stays off and a newer one shows; where two hosts answer one chat at two
last messages, the newest makes its one row, and is the one Mark read
marks. A Mark read that went through keeps the time read up to for that
chat, for the window's life (`readTo`): a copy at or before it, as an
offline host keeps, makes no row, and a newer message still does. A key
his act took off is kept off only while some source still gives it.

## The page

`today/model.ts` is the page with no React: `merge` (one row per key, marks
laid on, sections by order, rows by `at`), `fold` (the past rows folded at
the head, "N more" at the foot), `page` (the states below, and `keys`: the
arrows' stops in page order, rows and fold lines) and `dayBounds`
(local midnight to the next, by the calendar, so a day of 23 or 25 hours is
one day). `TodayView.tsx` draws it; `TodayRow.tsx` is the one row grid.

| State | What the page shows |
|---|---|
| A section has never answered, or a read some job needs is still out | its heading and three bones in its rows' shape |
| A section is empty | its heading and one muted line |
| Every source answered, nothing left (ended meetings are not left, folded or open) | "All clear", over "Nothing needs you today." or what tomorrow starts with |
| A host with jobs is offline, or a read failed because a host's link is not open | one muted line at the foot for each ("Mac is offline."), on the titles' edge, and no failed line for it in any section |
| No host that holds a job is linked | the foot's lines; the LifeOS sections draw nothing (`offline` reach) |
| A host did not answer in time | a line in the section it feeds, on the rows' grid, with Retry |
| LifeOS refused one read | "LifeOS could not read tasks" in that section, with Retry |
| No host can reach LifeOS | one line in place of the LifeOS sections |
| No Work workspace has a sector | "No jobs yet", with Add workspace |
| Work is off on every host | no rail row, no menu row, the key does nothing |

Folds: Waiting on you 5, Due 7, Waiting on others 5, Changed by others 5.
An unfolded section stays open until the window closes.

Keys: every row and every fold line on the page is one list, one tab stop.
↑ ↓ Home End move; Enter opens the row or the fold; Space ticks a task. The
row the arrows are on shows its verbs, and takes Tab with its own controls.
A fold he opens hands its focus to the first row it showed. Focus lands on
the first row when the page opens, and where he left it when he comes back
(the first stop in sight, if he had scrolled that one away). Esc closes the
page.

Width: `TodayRow.tsx` holds the grid. In a column under 480px (the window
at its least beside the rail and the Chats column) the inset and the gaps
narrow, the job's column keeps its dot alone, its name leading the second
line in medium ("Purdue Esports" 4px before "November hosting"), and the
fact's column is 72px, so the title gets the room (`@container/today`).

Toasts: the titles' column at the page's foot is the toast anchor
(lib/toastAnchor.ts), so a toast covers neither a tick nor a verb, and the
list ends with a runway so its last row scrolls clear. In the narrow column
the page's own toasts (`act`, counted in the store's `toastsUp`) get a
strip under the list while one is up, a toast's place (5rem) for each of
them, up to the four the toaster shows, so the stack covers no row even
open under the pointer: until the toast says it left, or,
for a way out it did not say, until no toast is left in the document (one
held under the pointer, or a loading one, keeps it). While the held sheet
is open the anchor stands down.

## Speed

- **The first frame has rows.** The Outbox's store is live from boot, and
  the sources are loaded with the page's chunk (`ready`), so Waiting on you
  paints at once. Every source's last answer is kept in `today/store.ts`
  for the life of the window, and a source that is reading again with no
  rows at all (`loading` alone, as a LifeOS read before its session
  answers) keeps the rows it had, so a reopen paints them and the live read
  corrects them. A kept row of a sector no job holds now, or built for a
  workspace that is no longer a job (`TodayRow.workspace`), is left out
  (model.ts `jobsOnly`). A Due row's tick and press look up the job when
  pressed, through the route the page or its keeper keeps (store.ts
  `routeOf`), so a row acts on the job its column names. A host read answers its own rows from its first
  frame (`prime`), so nothing is kept for it.
- **Kept warm** (`today/warm.tsx`). The sources are hooks, so something must
  be mounted for them to run: the page runs them while it is open, and a
  root of their own, in no document, runs them for ten minutes after it
  closes. The chunk is loaded at idle while Work is on, and on the rail
  row's hover or focus, which asks nothing more. The sources start once at
  idle after launch if he opened Today today or on either of the two days
  before (`localStorage["work.today.opened.v1"]`: two dates, nothing else).
- **One read a method** (`today/read.ts` `useEachWorkspace`). The page and
  the keeper read the same slots, one shared read a method for the window,
  so opening or closing the page while the keeper runs asks nothing. With
  no reader the read stops asking: a push or a reopened link marks the job
  it names, and the next reader asks those, the failed ones, and any older
  than 30 s (`FRESH_MS`; a read kept by a push counts as current until its
  last reader left). `work.prep.upcoming` is asked once a host for all its
  jobs (`perHost`). The held source reads the Outbox store only where it is
  stale (`loadOutbox({ifStale: true})`, work-outbox.md "The screens").
  Tests: `today/shared.dom.test.tsx`.
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

## The phone

The phone has Today, built from the same reads, by a Swift port of this
folder's rules in `ios/TempCodeClient/Sources/TempCodeClient/Work/Today/`
(no SwiftUI, no socket, no LifeKit). The page is built: the Work tab opens
on it, `TodayStore` (`TodayReads.swift`) reads the hosts and takes LifeOS's
lists from the app's LifeKit reads, and `ios/TempCode/Sources/Work/Today/`
draws it (docs/IOS-DESIGN.md "Today", docs/agents/ios-client.md "Today"):

- `TodayTypes.swift`: the seam as values. A row's press is a `TodayTarget`
  (held, request, event, task, mail, chat, money, form, review, tell, prep) whose
  `route` is the phone's place for it, or nil while that place is not built,
  and then the row is not a button. A verb is a `TodayPress` (prepare, done,
  tomorrow, nudge, dismiss, markRead, resolve), a Retry a `TodayRetry`. Every
  value is `Sendable`, `Hashable` and, for the cache, `Codable`.
- `TodayModel.swift`: `model.ts` and `stable.ts` function for function
  (`dayBounds`, `dayAfter`, `jobsOf`, `workspaceFor`, `offlineHosts`, the
  LifeOS host choice and cover, `merge`, `fold`, `page` with `apart`,
  `jobsOnly` and the lost line with a wait's `waits`, the `connecting`
  reach, `keepRows`), the store's keeping rule
  (`kept`, `stillGiven`, `broken`), and the Work list's line (the next
  meeting, else what is due, never the Outbox's count: `workListLine`).
- `TodayWords.swift`: every time and count a row says, as the desktop words
  it. `TodaySources.swift`: each source's rows and marks from plain inputs
  that decode the JSON the desktop reads (Held with the threads' requests,
  `askedItemKeys`; Also's kinds `docs.guest`, `guests.edited`,
  `guests.opened`). `JobReads.answer` in `TodayReads.swift` is `read.ts`'s
  `snapshot()`.
- `Work/Cache/WorkCache.swift`: what the phone keeps on disk (Today's rows
  with no verbs, the Outbox's waiting rows from the summary alone, the
  Digest's newest fourteen days with the rows each drew (`WorkCache.digest`,
  Work/Digest/DigestKept.swift: no settings, no row of no day), a folder's
  last page of names) and `WorkCacheDrop`, which
  keys go on a replaced key, a lost capability, a sign-out, Work off or a
  removed host.

The fixtures hold the two to one answer.
`src/renderer/src/work/today/phoneFixtures.test.ts` runs this folder's model
and each source's pure function over a set of cases and checks
`ios/TempCodeClient/Tests/TempCodeClientTests/Fixtures/today/<case>.json`;
`TodayParityTests.swift` replays every file through the port field for
field. A change to Today here that a case reaches fails the vitest until the
files are written again, and the Swift test until the port says the same; a
new field of a source needs a case that carries it (the Due rows' project
went unseen until `due-projects`):

```bash
UPDATE_FIXTURES=1 NODE_ENV=test bunx vitest run src/renderer/src/work/today/phoneFixtures.test.ts
```

The cases include requests in Held, the guest kinds, a LifeOS that is
connecting, a read that waits on another host's LifeOS, and Due's projects
(a name, a project gone from a job whose names came, Open project by id
alone where a job's names failed, and the one quiet line). What the
fixtures do not reach is held by TodayStoreTests: `snapshot()`'s states,
a purge, a host not linked, the read-to map.

What the phone leaves out: the Files source (not registered here either),
the keys, the toasts' strip and the held sheet (the phone opens the
Outbox's own item), and `hostFailureWords`'s plain words for a host's
error: the port hands the error on, and the screen words it.
