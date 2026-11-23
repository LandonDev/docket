# Work: clashes across jobs

Each job has its own calendar, so a Ref game in one town can sit on a Purdue
event in another and nothing says so. LifeOS finds a clash across all six
jobs: two events at once, or two he cannot drive between in time. TempCode's
`clashes` pillar watches them, tells the digest, answers the wire and gives a
thread its own job's clashes. The plan is `.temp-code/plan-7BzZxxMKA7yn.md`;
the look of each surface is docs/DESIGN.md "Clashes".

## What lives where

- **LifeOS** finds the clashes, places events, measures and keeps drives
  (`clashes:range`, `legs:ask`, tables `legs` and `clashWaived`). Only LifeOS
  asks a map service; no pillar asks one itself.
- **The host** (`src/main/server/work/clashes/`, pillar 58): the watcher, the
  tell, the wire, the tool and `milesBetween`. Its one table is
  `work_clashes_told (key, stamp, told_at)`.
- **Shared** (`src/shared/work/clashes.ts`, no zod): the shapes (`Clash`,
  `ClashSide`, `Leave`, `ClashList`, `ClashWay`, `ClashStop`), `milesOf`, and
  the words: `clashLine` ("Overlaps Varsity Basketball (Ref), 6:00 PM", "15
  min short after Staff meeting (Purdue)", "About …" for a drive worked out
  without the map), `driveLine` ("38 min drive, 24 mi", "About 40 min, 25
  mi"), `clashTitle`, `tellWords`, `leaveLine` ("Leave 4:35 PM"). A job's
  name is its sector key with a capital unless the caller passes `label`.
  Times read in the zone the caller passes, with ordinary spaces. `clashLine`
  names the other event's job only when it is another job, and prefixes its
  time with its weekday (its date more than three days off; `timeNear`,
  which the dialog's time spans and the row menu's `clashTime` use too; the
  second time a clock shows, the night the clocks go back, is "second 1:30
  AM"; `clashLines` gives a row its lines and tells two drive lines that
  would read alike apart by the other event's start) when it
  starts on another day than the one the line
  is read under (the event's own start day, or `opts.on` when a list shows
  the row under another). A shortfall worked out without the map is said to
  five minutes, never under five, as its drive line is. A side carries
  `guests` when someone else on the event has an address.

## The wire (`src/shared/contract-work-clashes.ts`)

Every call runs on the owner session, so it reads every job.

- `work.clashes.list {from, to}` (read) → `{clashes, leaves}`: LifeOS's
  `clashes:range`, each side given this host's Work workspace for its job
  (`workspaceId`, when there is one) and miles from metres.
- `work.clashes.leave {eventId}` (read) → `{leaveAt, minutes?, miles?, from,
  fromTitle?, measured} | null`: `events:get` for its start, then
  `clashes:range` over the hour each side of it.
- `work.clashes.miles {workspaceId, from, to}` (read) → `{miles, minutes,
  measured} | null`: LifeOS's mutation `legs:ask` with the workspace's job. A
  stop is `{event}`, `{place}` or `{start: true}`. Refused in words for a
  workspace that is not a Work workspace with a job. `measured: false` is the
  straight-line floor; null is a stop with no point on the map.
- `work.clashes.waive {id, on}` (operate): `clashes:waive` or
  `clashes:unwaive`. A quiet clash stays quiet until either event's time or
  place changes.
- `work.clashes.answer {eventId, way, comment?, start?, end?}` (approve): his
  own press, sent at once, as New event sends (agenda/NewEventDialog.tsx):
  `calendarOps:save` with no origin, then `calendarOps:send {id, cause:
  'press'}`. A decline carries his note; a proposal `proposedStart` and
  `proposedEnd`; a move is an `update` with `startsAt` and `endsAt` for an
  event from a calendar (`source` `gcal` or `ics`), and `events:update {id,
  patch: {startsAt, endsAt}}` with nothing sent for one that lives only in
  LifeOS. Refused for a thread's call whatever its key holds, and for any key
  without approve. A LifeOS refusal comes back in its own words. A move of an event
  that lives only in LifeOS moves its arrive-by by as much, so the lead the
  offer left is kept (a calendar's own event is moved on its calendar, and
  its arrive-by is LifeOS's sync's to keep).
- The push `work.clashes {}`: the list changed; ask again.

With Work off every method refuses, LifeOS is not asked, and the watcher does
not run.

## No act kind

The pillar declares no act kind and holds nothing. Decline, propose and move
are LifeOS's own calendar acts: from a thread they carry its origin and wait in
the Outbox as `calendar.op`; from the dialog they are his press, which is why
`answer` is his alone. Running late is a mail draft in Mail's composer, which
holds its own send.

## The tool: `clashes_list {days?, sector?}`

Read only; 7 days from the start of his today by default, 14 at most. It lists
the clashes where either event is the thread's job (`ctx.scope.sector`; a
Work Chat names one with `sector`, a workspace with no job is refused). The
other job's event is masked: its job's name and its times only, never its
title, people, place or event id, and the drive is left out unless both
events are the thread's job, since minutes and miles say where the other one
is. Plain text, one clash a line, in his time zone. Its description tells the
thread that its way out is `draft_calendar_op` or a mail draft, held in the
Outbox.

## The watcher and the tell

`start` subscribes to `clashes:range` from the start of his today for 14 days,
and subscribes again when his day turns (checked on each answer and every five
minutes). His zone is LifeOS's `settings:get` → `timezone`, read at start and
on each answer, else this host's. Each answer that changed pushes
`work.clashes`.

Each clash is told through the digest's `ctx.tell` once at its stamp (both
events' starts, ends and place text, so a moved event tells again):

- `kind: 'clashes.new'`, `key: 'clash:<id>'`, the same on every host, so the
  digest shows one row for one clash.
- `workspaceId` and `open: {view: 'agenda', workspaceId, at: <earlier event>}`
  name this host's Work workspace for the earlier event's job. A host with no
  such workspace says nothing.
- `title` and `detail` are `tellWords`. `by` is the later event's start when
  that falls on his today (it cannot wait for the next digest), else absent.
- A told clash no longer in the answer (passed, moved apart, or fine by him)
  is taken back with `ctx.tell.done(key)` and its row dropped.

The module lists `tells: [{kind: 'clashes.new', group: 'clashes', name:
'Clashes'}]`. Clashes raises no toast and no notice of its own, and changes
no LifeOS alert.

## On screen (`src/renderer/src/work/clashes/`)

The pillar has no view of its own and no row in the column.

- `mark.tsx`: `useClashes(env, from, to)` reads `clashes:range` live on the
  owner session (`useLifeosSession(env, null)`), since a clash is across jobs
  and a view's own session reads one. It answers each event's clashes, its
  leave-by and the set of events that clash, each side with this host's Work
  workspace for its job, and why the read failed when it did. `ClashLines`
  draws an Agenda row's lines, one a clash, each opening its own dialog; the
  row's menu names each by the other event.
- `open.ts`: `openClash({id, environmentId?, clash?})`, a small file any
  screen may import. `ClashHost.tsx`, mounted by the Work shell beside
  `PlaysHost` (`work/shell/WorkRailHost.tsx`), loads the dialog's chunk
  `work-clash` on the first ask.
- `ClashDialog.tsx`: the two events and the drive, the ways out each allows,
  each way's one step. Decline, a proposed time and a move go through
  `work.clashes.answer`; "This is fine" through `work.clashes.waive`, with
  Undo on its toast. Running late reads the event's people (`events:get`,
  given ten seconds by `answered` in `clashes/wait.ts`: Convex's own call
  has no end, and the dialog is locked while it is out; a Start place Save
  is given the same; if the two change or stop clashing while it reads, or
  the later event ends, nothing is drafted and the press is his again on
  the pair as it is)
  and opens Mail's composer in that job's workspace (`mail/mailto.ts`), so it
  is offered only where this host has that workspace. The dialog reads the
  fortnight from the earlier event's day (whole local days; not the pair's
  own day or two, so an event that moves to another day and still clashes
  stays in the read); an event that is over gets no way out; a clash that is gone says so in
  its title, and a read that failed with nothing handed over says why. It
  keeps the clash it showed while his own press is out and while it closes,
  and keeps an open step with what he typed when the calendar settles the
  clash meanwhile: the title says it is gone, the step's sentence turns to
  "Nothing was sent." and the step sends nothing.
  What a read said for certain holds while a later read is out or fails, so
  a clash seen gone never returns from the opener's copy. A step's time
  field left as offered sends the instant offered, each field on its own
  (`whenOf`; `model.dst.test.ts` holds it across the clock changes). An
  offer under a day long stays under a day whatever he edits; one a day
  long or more keeps the days its end is past its Day (`endHint` names the
  end's day under To) and its To is read on that day alone. A shorter
  one's To is the first time after the start: the Day's own when there is
  one, else the next day's when it is earlier on the clock. Either way a
  To is looked for on the day it falls on, so only that day's skipped hour
  refuses it, in words and with its field marked invalid (`fieldOf`,
  `ClashStep.dst.dom.test.tsx`). A start already gone is
  refused. A step with times whose pair changed under it (`pairStamp`)
  holds Send and points back for a fresh offer, and one whose event ended
  while it was open says so and sends nothing. A step is its event's by
  id, and the dialog knows its pair under either order of the id, which
  flips when one of the two moves to start first. A move of an event with
  guests says they are told.
- `model.ts` holds the pure parts: the marks, the time a move or a proposal
  starts filled with (the earlier event: the latest quarter hour that ends a
  drive before the later one, while that is ahead and on its day; else the
  first quarter hour after the other event that the drive allows, and never
  a time already gone; a drive
  clash's shortfall tells how long before its start the later event asks
  him there, and the offer leaves that too), a To that runs past midnight,
  how late he is, the words.
- `today.ts` is the pillar's `TodaySource`, one line in `TODAY_SOURCES`: no
  row of its own, a mark on each event's `event:<id>` row (the clash in that
  event's words, drawn as a fault, with Resolve), and the leave-by as the
  row's live line until the drive would have him there.
- `Clash.preview.tsx` draws the dialog's states and a day of rows for
  `bun run ui:preview`.

## For another pillar: `milesBetween`

`milesBetween(ctx, workspaceId, from, to)` in `clashes/api.ts` is
`work.clashes.miles` for a pillar on the host (Money). Do not log a
`measured: false` answer as a mile driven: ask again later, since asking is
what gets a leg measured. A round trip is two calls.

## LifeOS functions it calls

`clashes:range {from, to}`, `events:get {id}`, `settings:get {}` (queries);
`legs:ask {from, to, sector}`, `clashes:waive {id}`, `clashes:unwaive {id}`,
`calendarOps:save {kind, eventId, payload}`, `calendarOps:send {id, cause}`,
`events:update {id, patch}` (mutations). Tests stub them
(`clashes/clashes.test.ts`, `src/shared/work/clashes.test.ts`).

## Start places (Settings → Work)

Where each job's drives begin. `StartPlacesSection`
(`src/renderer/src/work/clashes/StartPlaces.tsx`) is a section of Settings →
Work on the Work home host, after Where it runs. It reads LifeOS live on the
owner session and draws nothing while that session is not connected; bones
while it reads, the read's error in a red line if it fails.

- **Rows.** Seven: Home, then the six jobs in the order LifeOS gives them,
  each job with its sector dot and the name the LifeOS section uses
  (`sectors:list`). Under the title: the place as the map named it; "Home"
  where a job has no start of its own (it starts from home); "Not set" for
  Home with no address; a small spinner and "Looking up…" until LifeOS's
  worker has placed a new address (about twenty seconds; the query is live,
  so the row turns by itself); the address he typed with "Not found" in red under it when the map
  did not find it. The words are `placeWords` in `clashes/places.ts`.
- **The dialog.** The whole row opens it; its button is named for what the
  row says ("Change Purdue: Cedar Hall, 4 Elm Street", `rowLabel`). One
  Address field filled with the current address; for a job, the switch "Look
  up event places on Apple Maps" with the one line "When off, this job's
  event places never leave your machines." (the switch is described by it),
  and "Use home" at the footer's start while the field holds an address: it
  empties the field, and Save sends that with whatever else he changed, so a
  flipped switch is never dropped. Save stays off until something changed,
  spins while LifeOS answers, then closes; a refusal stays in the dialog in
  LifeOS's words, as an alert. No toast: the row changes. The form is what LifeOS holds now with his
  edits laid over it: a field he has not touched follows the reads, and
  Save is on whenever the form differs from what is stored now (addresses
  compared as LifeOS keeps them, `tidyAddress`). A Save that got no answer
  in ten seconds says so. A read that shows what a Save sent (`fieldsOf`,
  kept from the moment Save starts) is the Save done: while it is out the
  dialog closes on that read; after the wait ran out its words go and its
  edits are dropped. An edit set back to what is stored, by him or by a
  read, is no edit, and an address he changed by spaces alone gives way
  when another comes in. The dialog stands
  on what the reads last gave whole, so it and what he typed stay when a
  read fails, the session drops or a read is out; Save waits until the
  reads are current again, so he saves beside what LifeOS holds now. Why LifeOS
  cannot be read now shows in the alert before an earlier Save's refusal,
  and a read that is merely out, or a session still connecting
  (`sessionWaits`), says "Waiting for LifeOS…" as a status.
- **LifeOS.** Queries `settings:startPlaces {}` (the rows: `{home, jobs}`,
  each `{address?, label?, state: none | looking | found | failed}`, a job
  with `sector` and its `lookups`). The one write is `settings:update`:
  `homeAddress` (null clears it), or for a job `startFor {sector, address}`
  and `lookupsFor {sector, on}`, that job alone (`savePatch`). LifeOS lays
  each over the map it holds in the one write, so two windows that each
  change a job keep each other's change, and a press on one job never
  turns another job's lookups back on. An empty address clears the job's
  start: it starts from home.
- **Lookups are his alone.** Only this switch, pressed by him, changes
  `placeLookups`; no tool or thread does. A job with no entry takes LifeOS's
  default: every job on, Purdue off (ruling 1 of the plan). A start place he
  types is looked up on the map whatever the switch says (ruling 2).

Tests: `clashes/places.test.ts` (the words and the patches) and
`clashes/StartPlaces.dom.test.tsx` (the rows, the dialog, each patch, a
refusal, signed out, bones). Pictures: `StartPlaces.preview.tsx` through
`bun run ui:preview`.
