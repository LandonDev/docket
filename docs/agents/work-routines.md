# Work: routines, watches and triggers

Milestone 32 of the Work plan (architecture §11.1). Work the host runs on
its own: a routine runs a prompt as a new Work thread when its trigger
fires; a watch repeats a cheap read with no model and wakes a thread when
the answer changes. [work.md](work.md) says how a pillar mounts; this is the
routines pillar as built.

## Files

| What | Where |
|---|---|
| The wire, the RRULE subset and its words | `src/shared/contract-work-routines.ts` |
| The module: methods, tools, start | `src/main/server/work/routines/index.ts` |
| The scheduler and the four triggers | `routines/engine.ts` |
| The rows | `routines/store.ts` (`work_routines`, `work_routine_runs`) |
| Due times in a time zone | `routines/schedule.ts` |
| The host handles the context lacks | `routines/host.ts`, hooked once from `work/ctx.ts` (`routinesHostPart`) |
| The screens | `src/renderer/src/work/routines/` (`view.ts`, `RoutinesView.tsx`, `RoutineForm.tsx`, `model.ts`) |

## The rows

`work_routines` is architecture §3.1's table plus `proposed`, `ended`,
`made_in` and `last_words`. `kind` is `watch` when the routine has an end
(`until_at`, or `once`), else `routine`. `cursor` (JSON) holds a LifeOS
feed's `after`, or a read's or a file's last hash and when it was looked at.
`work_routine_runs(id, routine_id, session_id, fired_at, cause, folded,
state, summary)`: the outbox reads `routine_id` by run id (`routineOf`,
work/outbox/ctx.ts), so a routine's grant fits only its own runs.

Every change is written when it happens: a firing's run row and the
routine's next due time go in one savepoint before the thread is asked
for; a cursor moves as soon as a page is handled. So a kill at any point
loses no schedule and never fires twice. At boot (`recover`) a run still
`starting` reads failed ("the host stopped before its thread started")
unless its thread was made before the stop; a `running` run whose thread
settled while the host was down settles now. A thread left `stopped` stays
its run's: the boot resumer or the owner may finish it, and firings fold
into it until the next due time finds it still stopped, when it is closed
as failed and a fresh run starts.

Run states: `starting`, `running`, then, once its thread has worked and
every thread under it is done, `quiet` (nothing held, nothing asked, no
failure: its thread is marked read), `held` (`Held N`: acts in
`work_held_acts` plus the LifeOS drafts still waiting whose origin names
the run, read from the Outbox's own list while it watches LifeOS, else
counted from the tree's transcripts; unread), `asked`
(unread), `failed` (unread), `fired` (a watch woke its thread), `skipped`
(unused yet).

## The scheduler

`RoutinesEngine.tick()` every 30 s (`TICK_MS`, unref'd), from the module's
`start`, so only while Work is on. One pass at a time.

- **schedule** (`{rrule, tz}`): weekly on some days at a time
  (`FREQ=WEEKLY;BYDAY=…;BYHOUR;BYMINUTE`, `DAILY` too) or every N minutes
  (`MINUTELY`/`HOURLY`, at least 5 minutes), 7:00 on the wall clock of
  `tz` across clock changes. Due times missed while the host was down fold
  into one run (`folded` = missed − 1; its message says how many it
  covers); the next due time is the first after now. A firing due while the
  routine's last run still works folds into that run, and what it heard (a
  mail, a read's answer) is told to that run's thread. A firing reads its
  routine afresh: one paused, changed or removed since the pass looked fires
  nothing (Run now fires a paused one). Nothing slow is awaited in a pass: a
  read (60 s at most, `READ_TIMEOUT_MS`) or a thread's start runs on its
  own, and a routine whose read has not answered is skipped. Resuming a paused
  routine starts its clock from now: the paused times are not owed.
- **lifeos** (`{kinds}`): one `lifeosEvents:since({sector, after})`
  subscription per workspace (its sector), from the oldest cursor among its
  routines; each page fires each routine once for the events it hears past
  its own cursor, moves every cursor to `next` and resubscribes from there.
  `filter` keys `table` and `id` match the event's row. With LifeOS down
  the row says "Waiting on LifeOS"; a workspace with no sector says so.
- **read** (`{addon, tool, args, fire, everySec}`): the host calls the
  add-on's tool itself (`AddonHost.call`, `sessionId: null`, `work:
  true`), which M10's gate runs only when the owner set the tool to Runs;
  the engine also asks first (`mayRead`) and, if he set it back, reads
  nothing and says "Waiting: its tool is not set to Runs". A tool its server
  no longer lists is not Runs either, whatever rule was set. The first read
  is a baseline; `changed` fires when the answer's hash differs,
  `non-empty` when it has something in it and differs.
- **file** (`{source, by: 'someone-else'}`): a file on this host is looked
  at every minute by size and time and hashed when those move; the first
  look is a baseline and a change whose bytes a pillar noted with
  `noteOwnWrite(path, data)` (engine.ts) fires nothing. A LifeOS document
  or sheet (`{at: 'lifeos', table, id}`) fires on its `doc.changed` or
  `sheet.changed` event through the workspace's feed. Any other place
  (Google, Microsoft, Frame.io) is armed through another pillar's
  `WorkModule.triggers` whose source has `on: 'file'` and the same `at`
  (Excel's says `at: 'microsoft'`, Google's `at: 'google'`); a source with
  no `at` is never asked. With none for that place the row says "Waiting:
  nothing watches files there yet".

A firing starts a root Work thread through `ctx.threads.start({workspaceId,
projectId, text, model, routineRunId})` (registry `startWith`: the queue
and the running cap apply; `startedBy` stays null). Its first message is
the prompt, then "Started by the routine “…”: <cause>." and what it heard.
A watch an agent set (`resume_session_id`) instead wakes that thread
(`ctx.threads.resume`, an agent report, never a user row) with the read's
answer, cut at 4,000 characters, and ends unless it has a day; a watch
whose thread is gone ends with a failed run.

## Who may make what

- `work.routines.save`, `remove`: `admin`; `pause`, `runNow`: `operate`.
  All four refuse a thread's own call (`Caller.kind === 'model'`). `list`,
  `runs`: `read`. The push `work.routines {workspaceId, id}` says a
  routine changed; a screen asks `list` again.
- `routine_propose` (tool): writes a proposed row (`proposed = 1`, not
  enabled, no due time). It runs nothing; the Routines view lists it first
  with Not now and Create…, which opens the form filled, and his Save makes
  it a routine.
- `watch_create` (tool): only a tool he set to Runs and its server calls
  read-only, in the thread's workspace or a global add-on allowed in Work;
  arguments fixed now; every 5 to 1440 minutes; ends on its day (at most 30
  days on) or at its first firing; at most 10 live per thread. It never
  starts a model run. The owner's own form may watch any tool he set to
  Runs.
- A routine's grant: `work.outbox.grant({routine: true})` from one of its
  own held acts (M10). Nothing is granted on the form.

A Mac-hosted workspace's routines run only while the Mac's app runs and the
Mac is awake; the detail's "Runs on" says so.

## The screens

A linked Work workspace's column gains **Routines** after Mail, Tasks,
Agenda and Docs (`WORK_VIEWS.routines`, the `work-routines-view` chunk).
The view (prototype routines.html, "List and detail"): the routines,
proposals first, on the left at 280px, each its name, a status mark only for
Working, Paused, Failed or Watching, and one muted line ("Weekdays at 7:00
AM, next Thu", "Every 10 minutes, once", "…, waiting on LifeOS"); on the
right the one picked: its name with Edit, Pause or Resume and Run now (a
proposal: Not now and Create…), what it does, Starts, Ends, Model, Runs on,
the thread it was made in or wakes, then every run as a 32px row (time,
mark, outcome) that opens its thread (`workOpenPort`, registered by App).
The header's New routine and Edit open the form ("A form"): Name, What to
do, Starts (Schedule, LifeOS, Read, File, each swapping its fields), Ends
(Never, On a day, After one run). Read offers only tools set to Runs. A
trigger he leaves untouched is saved as it was, so an agent's proposal the
form cannot show exactly (every 5 minutes, Mon and Fri) is created as
proposed. Delete asks first.

Not built here: the week grid and "By what starts it" (the prototype's other
two views), a scope menu across workspaces (the view is one workspace's),
the transcript's "Watching …" line beyond the tool's own answer, and a
proposal shown as a card in the thread.

## Proofs

- `routines/engine.test.ts` (fake clock and host): a weekday routine fires
  once per due time and never on a weekend; three missed runs fold into
  one; a kill mid-run and a kill before the thread existed lose no schedule
  and fire nothing twice; a firing during a run folds into it; quiet runs
  are marked read and held, asked or failed ones unread; a watch reads at
  its pace with no model, fires on a change, wakes its thread and closes;
  it reads nothing once its tool is no longer Runs; LifeOS feeds are one
  per workspace in its own sector and a Purdue mail starts the Purdue
  routine only; a LifeOS document's own event fires; a file fires on
  someone else's change and not on the host's own write; the schedule
  keeps the wall clock across a daylight-saving change.
- `routines/routines.rig.test.ts` (the outbox's rig: a real add-on host
  and gate): `watch_create` refuses a tool not set to Runs, then the host's
  own read reaches the server with the fixed arguments, and stops once he
  sets it back (the gate refuses the host's call too); a proposal runs
  nothing for a week of ticks and every method refuses a thread's own call;
  a routine's held act goes only on its own grant.
- `src/renderer/src/work/routines/model.test.ts`: the row's words and marks
  and the form both ways.
