# Work: the weekly review

With six jobs he cannot see which one is being starved. **Review** is one page
above the workspaces, under the rail's Work heading, that shows a week across
every job: where his hours went, what he shipped and what slipped. Each
slipped thing has three presses: do it now, move it to next week, or drop it.
A routine makes it every Friday at 4:00 PM; the page makes any week when he
opens it; made weeks are kept so he can look back. Built 2026-11-23
(plan-toGPPKaX6Q1P, landed/R3-review.md). Pillar `review`.

Nothing in it passes through a model: every number is a row some store
holds, and the estimate is a rule in one file. It sends nothing and declares
no act kind.

## Files

| What | Where |
|---|---|
| The rules: the week, the estimate, the comparison, what is kept, the merge, every word | `src/shared/work/review.ts` (pure: no zod, no node) |
| The wire | `src/shared/contract-work-review.ts` |
| The module, the tool, the kept weeks | `src/main/server/work/review/index.ts`, `store.ts`, `words.ts` |
| One file a source | `review/gather/{calendar,tasks,mail,held,threads,files}.ts`, `review/followup.ts`, put together by `review/make.ts` |
| The presses | `review/settle.ts` |
| Friday | `review/friday.ts` |
| The page | `src/renderer/src/work/review/` (`ReviewPage.tsx`, `Head.tsx`, `Hours.tsx`, `Shipped.tsx`, `Slipped.tsx`, `store.ts`, `shown.ts`, `go.ts`, `open.ts`, `today.ts`) |
| A page above the workspaces | Today's frame (`src/renderer/src/lib/workPlaces.ts`, `src/renderer/src/work/places/`, docs/agents/work-today.md), where Review is two lines; opening one at a moment is `src/renderer/src/lib/workPlaceAt.ts` |
| LifeOS | `packages/backend/convex/review.ts`, the `mailAnswers` table |

## A job, a week, a part

A job is a sector: Work workspaces are merged by `sector` across hosts, and
a workspace with no sector is a job under its own name (`jobKey`). A sector
with something to show and no workspace on a host that answered is still
listed, under the sector's name.

A week runs Monday to Sunday (`WEEK_STARTS`), cut at midnight on the wall
clock of one time zone, so a week with a clock change in it is 167 or 169
hours (`weekOf`, `stepWeek`). The zone is the home host's: LifeOS's own
(`settings:get`), else that machine's. `work.review.list` says it, and the
window asks for weeks in it, so the week the window asks for is the week the
Friday routine kept.

`ctx.peer` works only inside a thread's tool call, so no host can ask
another. Each host answers `work.review.week {from, to, tz}` with **its own
part** (`ReviewBody`) and the window merges the parts (`mergeReview`), as the
Outbox's store merges lists:

- `lifeos`: LifeOS's facts for every sector (events, mail he sent, tasks he
  finished, mails that were answered). They are the same from every host,
  so the window takes them once: from the Work home when it has them, else
  from the first host that does.
- `points`: each sign that he was at the desk on this host, `[at, job,
  kind]`: a message he wrote (`said`), a held item he decided (`pressed`), a
  document version he wrote into (`edited`). The mails he sent are points too
  (`sent`), made from `lifeos.sent` in the merge.
- `ran`: how long this host's threads worked, per job.
- `slipped`, `shipped`: below.
- `before`: the same span of the week before as bare facts (points, counted
  calendar spans, when mail went), enough for the comparison and nothing
  more. Facts, not sums: sittings cross hosts and jobs, so sums could not be
  merged.
- `left`: the sources that did not answer, in plain words (`LEFT`).

A host that is on and not linked to the window is one muted line ("The Mac
is off. Its threads and held items are not counted.") and the page stands.

## Hours: what is measured and what is a guess

`hoursOf` is the one place a number on the page is worked out; the window,
the tool and the tests all call it. Per job, three facts, never mixed:

| Fact | From | Said as |
|---|---|---|
| On the calendar | LifeOS `events:range`: the job's events he did not decline or hide, that are not all day and have an end (`countedSpan`), cut to the week and to now; read from a week before the span, so a timed event of a few days that began before Monday counts for its part (one longer than a week is not seen); overlaps inside a job counted once | a measure: "6 h 30 m" |
| At the desk | the points. Points less than 20 minutes apart (`SITTING_GAP_MS`), whatever their jobs, are one sitting; each gap goes to the job of its later point; 5 minutes (`LEAD_MS`) lead the first. Desk time under a counted event of any job is dropped, so no hour counts twice | an estimate: "about 4 h 30 m", to the quarter hour, always with "about" |
| Threads ran | the job's threads' `status` rows, running to settled, cut to the week | a measure of its own, never added to his hours |

A job's total is calendar plus desk (`totalWords`) and reads "about 11 h"
whenever any of it is the estimate. `hoursWords(ms, kind)` is the only way
to say a length of time, and the kind is its argument, so no caller can
drop the "about". A job with nothing reads "Nothing seen" (it names no
week: the page may show one long over): that row is the starved job, which
is why every job is always listed. The row says "nothing" only as far as
it was read (`nothingWords` over `MergedReview.known`): "No desk time seen"
while the calendar alone could not be read (no calendar fact is stated then),
"Nothing on the calendar" while a host is off or did not answer or what
desk time stands on went unread, "Not known" with neither. A job whose
threads ran with none of his own time opens to that fact alone.

**The week before** (`compareWeeks`) is said only where it says something:
a job whose hours moved by a quarter and by two hours ("down from about 9
h"), or one with two hours or more then and nothing now ("about 6 h the
week before"). A week still running is compared with the same span of the
week before, and says so ("by this point last week"); a week that is over
is compared with the whole of the week before (`makeWeek`'s `before`: the
two differ in length across a clock change). No comparison is
drawn on half the facts: with anything unread in either week (`left`;
`make.ts` keeps last week's calendar and sent mail only when both were
read), or with a host answering from before (`fresh`), a line would
describe the failure and not his week. A host that is off is out of both
weeks alike, so the comparison holds.

Work done outside TempCode (a game on a field, a video in an editor) shows
as calendar time only. The section's last line says what desk time stands
on.

## The scan

A host's own messages and its threads' run time come from the `events`
table (`gather/threads.ts`). That table holds millions of rows, its one
index is `(session_id, seq)`, and SQLite answers on the host's own loop,
so the read is bounded and handed back often:

1. only the Work threads touched in the span are opened (`updated_at >=
   from AND created_at < to`), an archived one from `cold.events`;
2. a thread's rows for the span are found by bisection on `ts` over its
   `seq` range;
3. rows are read a batch at a time, sized by bytes: the rows' lengths are
   read first (`length(payload)`, which SQLite answers from the row's header
   without loading it) and a batch ends at its budget, which halves after a
   slow batch and doubles after a quick one;
4. a row over 256 KB (`ROW_MOST`) is never loaded: a tool's output, a
   picture, or a paste too long to be a sign of typing;
5. one clock runs over the whole read (`pace`): the loop is handed back
   after every batch and after any run of probes or headers that held it 8
   ms.

A message counts only when he wrote it: `by` is the owner at this host, or a
key that could approve (`writtenByOwner`'s rule). A row from before rows
said who wrote them counts only at the top of a tree no model could have
written into, as `ownerMessages` reads them. A subagent's thread counts
under its top thread's job. A turn running when the week began is counted
from the week's start (the thread's last status in the 400 rows before),
and a span with no rows of its own counts whole for a turn open across it.
A turn still open at the span's end is closed by the first status in the 400
short rows after it that is not a working one (`starting` then `running`, as
a host's start writes them, is one open turn, as inside the span): one that
came after the cut runs to the cut (Sunday
11:40 PM to Monday 12:20 AM counts its 20 minutes in the old week). The
search goes on 400 rows at a time, paced, up to 20,000 (a turn past that says
threads were not read whole, never a silent zero); with none found, it runs to the end while the thread works now, else to its last row of any
kind, a tool's output too (a host that stopped mid-turn never wrote the
status that ends it).

`bun run script:bench-review -- --db <copy>` times it. It runs on a copy
(`VACUUM INTO`), never on a database an app has open, and refuses a file
whose write-ahead log moved in the last ten minutes.

Measured 2026-11-23 on a copy of the box's own database (`VACUUM INTO` of
the hot file: 14,761 threads, about 29 million event rows; the archived
threads' cold file was left out, so they had no rows), every thread read as
one job, pinned to two cores, five runs a week, the box at a load of about
19 on 32 cores:

| Week | Threads opened | Rows spanned | Loop handed back | Longest the loop was held (median, worst) | Whole read (median) |
|---|---|---|---|---|---|
| this week | 2,848 | 1,601,906 | 949 times | 11.2 ms, 15.3 ms | 3.8 s |
| last week | 5,682 | 948,207 | 525 times | 15.3 ms, 18.6 ms | 2.9 s |
| two weeks back | 4,968 | 159,322 | 95 times | 15.3 ms, 19.4 ms | 0.5 s |

The rule is that the loop is never held over 50 ms; the worst here was 19.4
ms. A real review reads only the Work threads touched in the week, a small
share of these. An earlier cut of the read, which sliced by rows and loaded
every row it met, held the loop up to 333 ms on the same data: that is why
a slice is sized by bytes and a long row is never loaded.

## What shipped and what slipped

| | Shipped (in the week) | Slipped (open now) | Now | Next week | Drop |
|---|---|---|---|---|---|
| Tasks | finished (`review:doneBetween`) | past due and open (`tasks:due`) | Done (`tasks:complete`) | due next Monday 9:00 (`tasks:update`) | Drop (`tasks:drop`) |
| Mail | sent (`review:sentBetween`); answered (`review:answeredBetween`) | waiting past its time (`mailWaits:list`) | Nudge (`work.mail.nudge`: a held draft in its own thread) | `mailWaits:putOff` | Stop waiting (`mailWaits:dismiss`) |
| Held items | sent on his press (`work.outbox.list {show: 'decided'}`) | held a day or more (`HELD_SLIPS_MS`) | Open: the Outbox, whose press it stays | a mark | Discard (`work.outbox.discard`) |
| Meetings | | ended, someone else on it, no mail to any of them since, no notes in Prep on any host | Follow up: the meeting's Prep page | a mark | None needed (a mark) |

- A held mail that was sent is listed once, as the mail.
- Tasks due before the week fold behind "12 older" per job (`splitOlder`).
- Answers are kept from the day LifeOS began keeping them
  (`answeredSince`): the `mailAnswers` table gets a row where an answer
  clears a wait. Before that day there are simply no Answered rows.
- The meeting rule is a rule of thumb, in one function (`followedUp`,
  `review/followup.ts`), and the row says what is true of it: "nothing sent
  after". It never says he forgot.
- A mark (`work_review_marks`) hides a held item or a meeting until next
  Monday, or a meeting for good. A task or a waiting mail needs none: its
  own date moves. A thread's tool reads the marks and deletes none
  (`hiddenKeys(…, prune = false)`).
- A waiting mail's key is its thread and when the wait began
  (`waitKey`, `mail:<thread>:<since>`): a newer wait on the same thread (he
  wrote again) is another row, so a kept row never looks open, or is
  pressed, on the strength of a newer one. A week kept before this matches
  its rows by their ref.
- A held item or a document is filed by its own sector (`jobIndex`,
  `rowJob`): a held item's workspace counts only while it is of the item's
  sector, a LifeOS document goes by LifeOS's sector for it (`docs:get`), and
  a `.tcdoc` by the Work workspace whose folder holds it; only a file outside
  every folder goes by the tab it was open in. So one job's thing never shows
  in another job's week, the thread tool's included.
- His own addresses (`mail:accounts`) unread leaves `LEFT.self` and judges
  no meeting (he would be "someone else" on every event); mail itself
  answered, so the waits and their presses stand. A carried meeting's mail
  unread leaves `LEFT.mail` and judges none of them; a carried meeting that
  could not be read by its id leaves `LEFT.carried` and stands as last known.
- Every host with LifeOS asks its own Prep over one span, the 31 days it
  answers ending at the cut (`PREP_UPCOMING_MAX_MS`), whatever its calendar
  or mail said, and carries the events Prep calls done on its part
  (`ReviewBody.prepped`). The window drops a meeting any part names (in a
  week that is over it reads as dealt with since): a meeting put off on the
  box and followed up in the Mac's Prep leaves Slipped, though only the box
  holds the mark. A Prep that fails leaves `LEFT.prep`, and so does a host
  with Prep and a job whose LifeOS is out (Prep reads LifeOS too); every
  meeting, on any part, then stands as last known with its presses waiting.
  A meeting put off from more than 31 days before the cut is not asked of
  Prep.

**The presses** go through `work.review.settle {row, how, tz, sector?}` on
the row's host: the host LifeOS's rows were read from (which keeps the
marks), a held item's own host, and for a nudge a host with a workspace of
the job. It needs a key that may approve and refuses a thread's own call
before anything is read. It calls the thing's own write and nothing else,
and answers an undo token where the write can be taken back (`tasks:reopen`,
the due date the press replaced, read then with `tasks:get`, never a kept
week's memory of it, and put back only while the task still has the date the
press wrote, else "It has changed since"; no token when that read failed;
`mailWaits:putBack`; the mark removed, or the mark that
stood before it put back whole, since a put-off meeting is in this week by
that older mark, and only while the mark this press wrote still stands: a
later press in another window is his newer decision, and an older token
says "It has changed since"), held in memory for
half an hour and good once (`work.review.undo`). A nudge is a draft, held
like every draft, and is started only while the thread's wait is the row's
own (`mailWaits:get`, its `since`). Next week or Stop waiting on a wait that
LifeOS no longer holds as the row's (it answers null) is said as "That
mail's wait has changed", never toasted as done. A held item's "now" and a meeting's "now" never reach the
host: the window opens the Outbox, or the meeting's Prep page. A call into
another pillar goes through that module's `handle` (`WORK_MODULES`), as the
mail pillar reaches routines.

## What is kept

`work_review_weeks`, one row a week a host (`mergeKept` holds the rules):

- A week that is not over is made again each time it is asked for, and its
  row is overwritten; the rows of a source that did not answer that time
  ride along as they last stood, so a failed read on Sunday leaves Monday
  something to look back on.
- Once the week is over, hours and what shipped are still read fresh (their
  facts carry times), but **what slipped stays as it stood at the last make
  inside the week** (`slipped.at`). Each kept row is checked against what is
  open now: one dealt with since reads `open: false` and sits under "2 dealt
  with since", with no presses. A row whose source did not answer this time
  (`left`) is not checked: it keeps what was last known of it, so a read
  that failed never makes a thing look dealt with. That covers the read of
  mail sent since the week ended, which a meeting's follow-up is judged by
  (it leaves `LEFT.mail`, and no meeting is judged without it). With LifeOS
  answering nobody, the window still lists a kept week's LifeOS rows, from
  the home's part (`mergeReview`'s `rowsFrom`).
- A kept week's meetings are asked for by id when it is looked back on
  (`MakeAsk.carry`): one put off into it ended in an earlier week, and its
  calendar no longer holds it. A lookup that fails leaves `LEFT.calendar`
  and the row as it stood.
- A week first asked for after it ended has no such make: it shows what is
  still open from it, read again each time, and says "Not made in its week.
  What slipped is as of today."
- **A read that failed or was cut never lowers or settles what was kept**
  (`keepFacts`). A list that comes back full at its cap says so: the waiting
  mail past three pages (`LEFT.mailPart`), the Outbox's waiting list at 500
  or its decided list at 500 whose oldest `updatedAt` (the list's own order)
  is not before the span's start (`LEFT.heldPart`), more than 200 documents
  or one whose history or sector did not answer beside others that did
  (`LEFT.filesPart`; a document LifeOS or the disk no longer has is skipped,
  no failure). What was read counts; a kept row past the cut stays as last
  known; no "nothing" and no comparison stand on it. The page says these
  three as muted notes beside a host that is off, with no Retry: asking again
  reads the same cut list. And a make over a kept week joins what was kept
  to what was read: desk points (matched by moment and kind, whatever job
  each was filed under, so a fresh read that files an edit under its own job
  replaces Friday's and never counts it twice; the job found again by
  workspace), run time (the larger), this host's shipped rows and LifeOS's
  sent and answered (by id). The calendar and finished tasks are replaced,
  by the fresh read where it answered (a meeting may be cancelled, a tick
  undone) and by the kept one where it did not; a kept calendar is cut to the
  moment it was read. Where a kept read stands in for one that failed, the
  line says so in place of "not counted" (`LEFT.calendarKept`: "The calendar
  did not answer, so the hours count what it said when last read.";
  `lifeosKept`, `tasksKept`, `mailKept`), and the calendar's fact and key show
  with it, so the words and the figure agree. A source neither read held is
  said as not read: a Friday whose calendar failed, looked back on with
  LifeOS down, says "LifeOS did not answer, so what it said when last read is
  shown." and "The calendar did not answer."

Two windows asking for one week at once share one read.

## Friday

The routines pillar runs host jobs (work-routines.md "A routine that runs a
job"): the review registers `review.make` on its module's `jobs` and seeds
one routine a host, once (`seedRoutine`, `work_review_setup.seeded_at`):
"Weekly review", `FREQ=WEEKLY;BYDAY=FR;BYHOUR=16;BYMINUTE=0`, in the Life
workspace or else the first linked one, in LifeOS's time zone or else the
zone of the first window that opened a review. It is an ordinary routine
from then on: he moves, pauses or removes it in Routines, and one he
removed is never made again. `work.review.routine` names it for the page's
menu ("Made Fridays at 4:00 PM…"), or answers null.

The job makes this week, keeps it as made by the routine (so
`work.review.ready` names it until `work.review.seen`), pushes `work.review
{from, madeAt, seen: false}`, and tells the digest once a week (`ctx.tell`,
kind `review.ready`, key `review:<from>`): a second run of a week the
routine already made (Run now) tells nobody, and a week he opened stays
seen (`routineMade`). Opening a week withdraws the tell of every older week
seen with it. The seed keeps its one shared try and lets it go in two
steps, so a try that found no linked workspace is not reused once he links
one. Its
run's row in Routines opens the page at that week (`open: {place: 'review',
at}`) and says how many things slipped on this host (its count is LifeOS's
things and its own held items; the page adds every host's), or, when a source did not answer,
"some of it could not be read" in place of a count.

## The window

`src/renderer/src/work/review/`, a chunk of its own (`work-place-review`)
under the `work-places` frame.

- **A page above the workspaces** is Today's frame (docs/agents/work-today.md
  "The place above the workspaces"): Review is one row in `WORK_PLACE_ROWS`
  (lib/workPlaces.ts: order 20, after Today) and one chunk in `WORK_PLACES`
  (work/places/registry.ts). The frame draws the 40px header, the page's
  `Head` at its end and its `View` under it; `shell.openWorkPlace('review')`
  opens it, Back and Escape leave it. The chunk's `warm` reads this week
  ahead on a hover or focus of the row, and nothing at idle: a week costs
  every host a scan. `lib/workPlaceAt.ts` is the review's own addition:
  `openWorkPlaceAt(id, at)` opens a page at a moment the page takes once
  (`useWorkPlaceAt`, `takeWorkPlaceAt`), so a routine's run or Today's row
  opens the week it names without loading the page first.
- **The store** (`store.ts`): asks every linked host with Work on, keeps
  each one's answer per week, merges, and reads a week again on the
  `work.review` push and when a host's link comes back (a week is on record
  as asked for before any host answers, so a host that links later fills it
  in, after the zone is asked again). `settleHost` picks the host of a
  press. Each part names the LifeOS lists it read whole and as of when
  (`ReviewBody.read`: the calendar, sent mail, answers, finished tasks, tasks
  and waits past due, the meetings judged; a kept read standing in carries
  its own moment; `readsOf` reads a body from before by its lines). The
  window takes each list only from a part that read it: one that read it
  this time before one kept from an earlier answer, its own read before a
  kept one standing in, then the home, then the newest (the calendar, which
  carries no marks, the newest before the home). So the box's sent
  mail and the Mac's answers both stand when each failed the other, each row
  keeps the host it was read on (its press goes there), and a LifeOS line
  stays while a list it speaks of went unread. The meetings are listed from
  the home whenever it answers: his marks and the meetings they carry live
  there, so another host's rows would bring back one he dismissed and lose
  one he put off; a home that could not judge them lists them as last known,
  and `LEFT.meetings` says so where no other line does. Once a week is over,
  its tasks and waits come from the newest list kept inside the week, whoever
  read now, before one that looks the week up for the first time and knows
  only what is open now; another part's whole read of the same list checks
  the kept rows that part could not (one that kept its own list says only of
  the rows in it), and a press on a row it found open goes to that part's
  host. While a host asked has not answered, every meeting stands as last
  known: it may hold the notes. "Nothing" on the calendar (`known.calendar`)
  stands only on a calendar read this time to the end of the span counted; a
  calendar counted for less (a kept read, or one a later host's answer moved
  the span past) still shows its fact and the bar's key
  (`known.calendarCounted`), and states its time, never its "Nothing". A
  list no part read is said as not read, never as empty. Every job the window knows of is listed (`knownJobs`), one
  whose only host is off too, in the rail's own order (`railWorkspaces`: the
  pinned rows first, then the rail's saved list, a job on two hosts at its
  first row's place; a drag or a pin while the page is open is followed:
  lib/recents.ts `subscribeRailOrder`, and the views kept while it is closed
  are dropped, so it reopens in the rail's order). A
  host that links again is from before until its new read lands: its part
  is `stale`, the page waits as for a host still answering, and its sums
  are dropped until the new ones come. A press's
  reload is a read that starts after the write (`loadWeek(week, true)`),
  never one already on its way. Each part is counted to the moment its own
  facts were read (`madeAt`), not to the window's clock: a part made while
  its week ran stops there even read back after the week ended and before
  the new answer lands, so the weekend's plans are never measured time and a
  re-merge adds nothing. The span runs to the newest read, so a peer that
  read later keeps its later desk points, and the calendar is cut to the read
  of the part it came from. The week before is compared only over the span
  every part covers: this week to the oldest read, the week before to the
  oldest cut, and while the week runs both to the same length of time (a
  week with a clock change in it is 167 or 169 hours long). A host names a week by its first moment in its own zone; the
  window finds it from that week's middle (`weekNamed`), in the page, Today's
  row and the header, so a Tokyo host's Monday is not a New York window's
  Sunday, and a host marks seen the week of its own that begins before the
  named week's middle. `week_review`'s `week` is a day read in the
  host's zone (`weekOfDay`). A row whose source did not answer, or
  whose host answered from before, is `unchecked` (`uncheckedIn`): it stands
  as last known and its presses wait. `hostError` says why a host did not
  answer in his words; `errors[].kept` says its last answer still counts.
  While a named week is on its way (`useWorkPlaceAt`), the page draws bones
  and neither reads nor marks seen the week it stood on. A host that is off is not counted, as its line says:
  what it answered before it went is kept for its return and not merged.
  `makeAgain` reads a week again with the page's first line saying
  "Making…". `MergedReview.known` says where an empty list is known to be
  empty (every source of it answered, and every host: the store tells the
  merge `fresh`, every linked host's newest ask answered, and `whole`, no
  host off besides); a section claims "nothing" only there. Money's sums
  count the same hosts. A row a press settled is kept away (`stillAway`)
  only until a read of its week no longer lists it as open, in the week it
  was pressed in; after that the week's own reads say what is there. A week
  named by a run's row or Today's is shown only once the zone weeks are cut
  in is known (`showWeekNamed`): the moment is a host's Monday midnight,
  still Sunday in a window to its west. A page left open hears the week turn (`useWeekTurn` in shown.ts: a
  timer set for the week's end, and the window coming back into view).
- **One Retry** asks every host again (`loadWeek`) and sits on the first
  red line on the page, whichever that is.
- **The page** is the look in docs/DESIGN.md "The weekly review".
- **In.** `openReview({week?})` (`open.ts`) is the one way in for another
  pillar; it loads nothing of the page.
- **Out.** A row opens its thing in its own view, in the job's workspace,
  which comes forward (`go.ts`): a task in Tasks, a mail in Mail, a meeting
  in Agenda; a held item opens the Outbox. A job with no workspace on a
  host this window reaches has rows of plain words.

## Who may read it

Every method but `ready` needs `approve`, and all but `ready` refuse a
thread's own call (`mustBePerson`): a review shows every job at once, which
no thread may read. `ready` answers a key that can read, and answers a
thread nothing.

A Work thread has the read-only tool `week_review {week?}`: the thread's
own job alone. The make is narrowed as it reads (`only`): every other
sector's rows are dropped where they are read, the jobs are the thread's
workspace alone, and nothing is kept, so a thread's read leaves no mark on
what he sees. A Work Chat is in no job and is told so.

## Borders

- **Today**: one row under "Also" while a review the routine made waits
  unopened (`src/renderer/src/work/review/today.ts`, a `TodaySource`, one
  line in `TODAY_SOURCES`): "This week's review is ready", or last week's,
  with the week under it; it asks `work.review.ready` on each linked host
  with a job, asks again on the `work.review` push, and opens the page at
  that week (`openReview`). Its key is `review:<from>`.
- **Digest**: the job tells `review.ready` through `ctx.tell` once a week
  (group `review`, no `by`, key `review:<from>`, `open: {place: 'review',
  at: '<from>'}`), listed on the module's `tells`; `work.review.seen` calls
  `ctx.tell.done`, so the digest's row goes when he opens the page.
- **Money**: Money owns every sum of money. The window reads
  `work.money.sums {from, to}` (local days, `localDay`) on each linked host
  and shows one line in a job's opened Hours row ("Money  $2,400.00 in,
  $312.50 out"); `week_review` adds the same for its own workspace. A host
  with no Money has no line. A job one of whose ledgers Money could not read
  whole (`problem` on its row) shows no sum, on the page and in the tool, and
  a read that fails drops the sums that host answered before. While a host's
  Money read failed (a timeout, or a host that has answered Money before),
  every job it holds shows no sum: the other hosts' share is not the job's.
- **Prep**: a meeting whose page in Prep holds notes or an outcome
  (`work.prep.upcoming`, state `after`) counts as followed up
  (`preppedAfter`, beside the mail rule in `followedUp`), on any host
  (`ReviewBody.prepped`). "Follow up" opens Prep's page for the event
  (`"prep" in WORK_VIEWS`, `go.ts`).
- **Clashes** owns clashes and drive time: the review counts an event's own
  length only.
- **Files and the editors**: only document history says who changed a file,
  so only document versions are counted (`gather/files.ts`, the documents
  this host's Work threads opened and touched since the span began, 200 at
  most). A sheet, a deck or a file on disk names no author.

## Not built

The page on the phone (the wire is ready for one). A count or a mark on the
rail's row. A timer. A week grid.

## Proofs

- `src/shared/work/review.test.ts`: a week's bounds across a clock change;
  one point is five minutes; 19 and 21 minutes apart; a gap goes to the
  later job; desk time under an event is dropped; overlapping events count
  once; a declined, hidden or all-day event counts nothing; an estimate
  always says "about" and a measure never does; a comparison shows only
  past both thresholds, and a running week says it compares the same span;
  the three rules of what is kept; the merge (two hosts, one off, LifeOS
  once, a held row a host); every row's words.
- `src/main/server/work/review/`: `gather/gather.test.ts` (each source
  against a stand-in), `gather/threads.test.ts` (whose messages count, the
  old rule, a subagent under its top thread, run time cut to the week, the
  cold file, bisection, a long row never loaded, the loop handed back),
  `review.test.ts` (a body, a source that throws, kept and frozen, who may
  ask, ready and seen, the tool's fence), `settle.test.ts` (each kind's
  presses reach the right call and nothing else, undo once, a held item
  never sent, a mark until its day), `friday.test.ts` (seeded once, never
  after he removed it, waits for a zone, the job tells the digest once a
  week and the tell is done once he has seen it).
- `src/main/server/work/routines/engine.test.ts`: a job routine.
- `src/renderer/src/work/review/`: `store.dom.test.ts` (the fan-out, the
  zone, a host off, a host failing, the host of each press),
  `ReviewPage.dom.test.tsx` (every state and every row's words),
  `today.dom.test.tsx` (Today's row, there until he has seen it),
  `lib/workPlaceAt.dom.test.tsx`, `chrome/WorkRail.dom.test.tsx` (the row
  under the Work heading, only with Work on).
- `bun run script:e2e-review`: the real review, outbox and routines modules
  on a real database with a made-up week across six jobs: make, keep, look
  back, settle, undo, Friday.
- `bun run ui:preview
  src/renderer/src/work/review/ReviewPage.preview.tsx#ReviewPreview --shot`:
  every state, light and dark.
- LifeOS: `packages/backend/test/behaviour/review.test.ts` and its fence and
  scoping suites; deployed 2026-11-23 (main `d1075c5`).

Not proven: the page on his real week, and the first real Friday run (they
need the box deployed with this build). The LifeOS reads were called live
only without a sign-in, which shows they are registered; no agent holds
his identity.
