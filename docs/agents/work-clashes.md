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
  asks a map service; no pillar asks one itself. It also decides each
  side's ways out (`canOf`): a Google invitation Decline and Propose new
  time…, an Outlook one in a job with one Outlook account Decline alone
  (the Outlook a desktop carries sends no proposal), his own event Move…,
  the later event with guests Running late….
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
- `work.clashes.waive {id, on, seen?}` (operate): `clashes:waive` or
  `clashes:unwaive`. A quiet clash stays quiet until either event's time or
  place changes. `seen` is the two events as the dialog showed them at his
  press (each id, start, end and calendar's place words); LifeOS refuses the
  waive in words when they are no longer so. A place's words go whole,
  with no cap: the list that showed the pair never capped them.
- `work.clashes.answer {eventId, way, comment?, start?, end?, seen?}` (approve): his
  own press, sent at once, as New event sends (agenda/NewEventDialog.tsx):
  `calendarOps:save` with no origin, then `calendarOps:send {id, cause:
  'press'}`. A decline carries his note; a proposal `proposedStart` and
  `proposedEnd`; a move is an `update` with `startsAt` and `endsAt` for an
  event from a calendar (`source` `gcal` or `ics`), and `events:update {id,
  patch: {startsAt, endsAt}}` with nothing sent for one that lives only in
  LifeOS. A time (a proposal, a move) carries `seen`, the pair as the step
  showed it when it offered the time: the host reads both events again
  (`events:get`) and refuses with "These events changed. Go back for a new
  time." when either's start, end or place moved (the offer's drive was
  worked out from both places), so an offer a calendar made
  stale before the window heard is never sent (the step keeps its form). One
  rule says whether a row read again is the event a side was built from
  (`sameEvent` in `shared/work/clashes.ts`): its start, its place words whole
  as LifeOS's own waive compares them, and its end as LifeOS's clash rule
  counts it (`clashEnd`, its `eventEnd`): an end taken away, or one
  before the start, is an hour on, so taking an end away is a change and an
  event that never had one is not refused for ever (all-day events never
  clash). Each side of `seen` also says whether the step told of its guests:
  a move of an event the step said tells no one, which has gained someone
  with an address since (`hasGuests`, the rule's own), is refused with "This
  event has guests now, and a move tells them. Go back to look again." The
  dialog sends each side's place as words ("" for none); a window a release
  behind sends none, and its place is not compared. Refused for a thread's call whatever its key holds, and for any key
  without approve. A LifeOS refusal comes back in its own words. It answers
  `{queued}` (`ClashAnswered`): true when the act was handed to LifeOS's
  sender for a calendar, which has not reached the calendar yet, false when
  the move was written in LifeOS itself. The toast words follow it
  (`doneWords`: "Declining…", "Moving…", and "Moved" only when written). A
  Send that left and got no answer (a timeout, a link that closed under
  it) may have been queued all the same: the step says "The host did not
  confirm the send. Check the calendar before trying again." and keeps
  Send off; Back gives the step afresh. A move of an event
  that lives only in LifeOS moves a leave-by he set by hand by as much, as
  LifeOS's own event sheet does, and its arrive-by too: the lead the offer
  left is kept, and LifeOS does not refuse the move for a leave-by after
  the new start (a calendar's own event is moved on its calendar, and its
  arrive-by and leave-by are LifeOS's sync's to keep).
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

Read only; 7 days from the start of his today by default, 14 at most, to his
midnight that many days on (a day the clocks change is 23 or 25 hours). It lists
the clashes where either event is the thread's job (`ctx.scope.sector`; a
Work Chat names one with `sector`, a workspace with no job is refused). A
thread names a job only once it is known to be a Work Chat: its row was read
and names neither a workspace nor a project. A thread with no Work home, whose
row names one that is not Work's, and a thread whose row cannot be read or is
missing, reach no job. The
other job's event is masked: its job's name and its times only, never its
title, people, place or event id. The drive and the minutes short are left
out unless both events are the thread's job ("not enough time to drive"),
since minutes and miles say where the other one is, and so do the minutes
short beside the two times. Plain text, one clash a line under the later
event's day, in his time zone: each start said beside that day and each end
beside its own start (`timeNear`: bare that day, a weekday within three
days, else the date; "second 1:30 AM" where the clocks go back). Its description tells the
thread that its way out is `draft_calendar_op` or a mail draft, held in the
Outbox.

## The watcher and the tell

`start` subscribes to `clashes:range` from the start of his today to his
midnight 14 days on,
and subscribes again when his day turns (checked on each answer and every five
minutes). His zone is LifeOS's `settings:get` → `timezone`, read at start and
on each answer, else this host's. Each answer that changed pushes
`work.clashes`.

Each clash is told through the digest's `ctx.tell` once at its stamp. The
stamp is the tell itself, every word and field (both titles, the minutes short
and whether measured, the date and time, the jobs, where it opens, its
deadline), so whatever it says that changes (a rename, a drive measured anew,
a move) updates its digest row under the same key, and nothing else tells it
again; the digest's own rule decides whether the update interrupts. It is
kept under `TELL_VERSION`: a build that tells another way raises it, and each
kept clash is told once more on its first read. A pair whose later event is
over is never told, and one told is taken back once it is, as the Agenda and
Today drop it (its deadline has passed, which the digest would take as at
once). The watcher does not wait on LifeOS for that: each told row keeps its
later event's end (`work_clashes_told.ends_at`), and `sweepEnded` takes back
every row whose end has passed, when the watcher starts (a host back from a
restart, with LifeOS quiet) and on a timer of its own set at the first end
kept, outside the queue of its LifeOS reads (a settings read that hangs holds
nothing up), so a digest made after a pair is over never says it:

- `kind: 'clashes.new'`, `key: 'clash:<id>'`, the same on every host, so the
  digest shows one row for one clash.
- `workspaceId` names this host's Work workspace for the earlier event's job.
  A host with no such workspace says nothing. `open` is the Agenda on the
  later event, whose week holds the clash (a block of weeks starts long
  before it), in the later job's workspace when this host has one (the
  Agenda finds the event through its own job's session); else the earlier
  event in the telling workspace.
- `title` and `detail` are `tellWords`; the detail always has the date
  ("Mon, Nov 30, 6:00 PM, Ref and Purdue"), since a clash is told up to two
  weeks ahead and read hours later. `by` is always the later event's start:
  the digest's rule (`decide`, and its 30-second look at rows whatever
  digest they are in) holds a later day's clash for the digest and
  interrupts once that start comes before the next digest plus two hours,
  so one early tomorrow found the evening before is heard that night, and
  one found days ahead is heard again on its day.
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
  Undo on its toast. Running late reads both events again (`events:get`,
  given ten seconds by `answered` in `clashes/wait.ts`: Convex's own call
  has no end, and the dialog is locked while it is out; a Start place Save
  is given the same; if the two change or stop clashing while it reads, or
  the later event ends or changes job (Mail would open under the old one),
  or either reply has its event at other times or another place than the
  screen (`sameEvent`), nothing is drafted and the press is his again on the
  pair as it is, with "These events changed. Look at them again" in the
  dialog's error line. Either event gone says "That event is no longer in
  LifeOS"; either no longer counting toward a clash by LifeOS's rule
  (`countsForClash`: timed, shown, not declined; a decline still in its
  calendar queue is not on the row) says "You declined Staff meeting, so
  this is no longer a clash", or "This is no longer a clash"). The subject names the later
  event by the title its reply has, which may be a rename the screen has yet
  to draw. The minutes short of a drive clash also rest on the later event's
  arrive-by, which a clash's side does not carry, so a change of that alone is
  seen only once the live read brings it.
  Then the window enters that job's workspace as a Today row's press does
  (`today/open.ts` `goTo`), opens its Mail, and hands the draft to Mail's
  door bound to that workspace (`writeMail(draft, workspaceId)`,
  `mail/mailto.ts`): only that workspace's mailbox takes it, and another
  job's mailbox that mounts first drops it, so another job's people never
  land in the Mail of the job he pressed from. It is offered only where
  this host has that workspace. The dialog reads the
  fortnight from the earlier event's day, and through the later event's
  own day and the earlier one's last when those lie past it, so a meeting
  that moves inside a block of weeks stays in the read. The end only grows:
  a block the live read shows longer widens the read to its new last day,
  and what the read last said for certain stays until the wider one
  answers (whole local days; not the pair's own day
  or two, so an event that moves to another day and still clashes stays in
  the read); an event that is over gets no way out; a clash that is gone says so in
  its title, and a read that failed with nothing handed over says why. It
  keeps the clash it showed while his own press is out and while it closes,
  and keeps an open step with what he typed when the calendar settles the
  clash meanwhile: the title says it is gone, the step's sentence turns to
  "Nothing was sent." and the step sends nothing (unless a Send of his got
  no answer: the act may be why the clash is gone, so the sentence stays
  and the alert says to check the calendar).
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
  event's words under Today's own day, drawn as a fault, with Resolve), and the leave-by as the
  row's live line until the drive would have him there. A clash drops from
  Today once its later event is over, by the Agenda's rule
  (`liveClashes` in `model.ts`, which both read). A side's workspace is one
  on the host whose session read the clash, where the dialog opens, as the
  dialog's own read names them: Running late is never offered for a job
  only another host holds.
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
  did not find it, or at once when the text is a link or a call, which no
  pass ever places (LifeOS's `isVenue`; a long link wraps inside the row);
  the typed address and ", using the town centre" while only its town's
  centre is known (`rough`, said at once: drives start at the town's
  centre, a typed start that has only that is asked of the map, and the
  row turns by itself if the map finds the place). The words are `placeWords` in `clashes/places.ts`.
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
