# Work: clashes across jobs

Each job has its own calendar, so a Ref game in one town can sit on a Purdue
event in another and nothing says so. LifeOS finds a clash across all six
jobs: two events at once, or two he cannot drive between in time. TempCode's
`clashes` pillar watches them, tells the digest, answers the wire and gives a
thread its own job's clashes. The plan is `.temp-code/plan-7BzZxxMKA7yn.md`;
this file is its host side (CL3). The Agenda line and the Clash dialog (CL4)
and Start places (CL5) are the renderer's and are not built here.

## What lives where

- **LifeOS** finds the clashes, places events, measures and keeps drives
  (`clashes:range`, `legs:ask`, tables `legs` and `clashWaived`). Only LifeOS
  asks a map service; no pillar asks one itself.
- **The host** (`src/main/server/work/clashes/`, pillar 56): the watcher, the
  tell, the wire, the tool and `milesBetween`. Its one table is
  `work_clashes_told (key, stamp, told_at)`.
- **Shared** (`src/shared/work/clashes.ts`, no zod): the shapes (`Clash`,
  `ClashSide`, `Leave`, `ClashList`, `ClashWay`, `ClashStop`), `milesOf`, and
  the words: `clashLine` ("Overlaps Varsity Basketball (Ref), 6:00 PM", "15
  min short after Staff meeting (Purdue)", "About …" for a drive worked out
  without the map), `driveLine` ("38 min drive, 24 mi", "About 40 min, 25
  mi"), `clashTitle`, `tellWords`, `leaveLine` ("Leave 4:35 PM"). A job's
  name is its sector key with a capital unless the caller passes `label`.
  Times read in the zone the caller passes, with ordinary spaces.

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
  without approve. A LifeOS refusal comes back in its own words.
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
'Clashes'}]`. Until the digest puts `tell` on `WorkCtx`, this build has none:
the pillar tells nothing and records nothing, so every clash is told once the
digest lands. `clashes/tell.ts` holds the digest's shapes until then.

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
