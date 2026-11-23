# Work: meeting prep and follow-up

Before a meeting, one page: who is coming, the last mail with each, the open tasks that touch them or the subject, the files in play, and what was agreed last time. After it, his notes (typed, a recording, a transcript, or a document) become tasks he ticks and a follow-up mail that waits for his press. The page is kept with the event, so next week's prep starts from this week's page.

It is Work pillar `prep` (55). Its host code is `src/main/server/work/prep/`, its screen `src/renderer/src/work/prep/`, its wire `src/shared/contract-work-prep.ts`. The plan is `.temp-code/plan-B6-Yq2vVy3SZ.md`; the landing note, with what is proven and what is not, is `.temp-code/plans/landed/R3-prep.md`.

Three things hold everywhere below:

- **Opening a page starts nothing.** The facts are read from LifeOS with no model. A thread starts only on his press (Brief me, Follow up) or from the routine he turned on.
- **Nothing here sends, books or shares.** Prep declares no act kind. A suggested task is prep's own row until he ticks it; the follow-up mail is LifeOS's own draft, which the Outbox already holds.
- **A thread never writes as him.** Every write method refuses a thread's own call (`mustBePerson`); a thread writes through the pillar's tools.

## The store

`store.ts`. One row per event per workspace, on the workspace's host:

`work_prep_pages(id, workspace_id, event_id, series, title, starts_at, ends_at, people_keys, doc, rev, suggestion_seq, brief_session_id, brief_at, follow_session_id, follow_at, created_at, updated_at)`, unique on `(workspace_id, event_id)`, indexed on `(workspace_id, series, starts_at)`.

- A row is made the first time something must be kept (people added, a brief, notes). **Reading a page writes nothing.**
- A page belongs to its event, not to a thread: it has no session column of its own. When a thread is deleted the page stays and only that thread's id is cleared (`sessionsRemoved`). `workspaceRemoved` drops the workspace's pages and its Prepare-ahead row.
- `doc` is `PrepDoc`: `people` (added beside the event's own attendees), `brief` (`matters`, `agreed`, `files`, `at`, `by`), `notes` (`text`, `at`, and `file` or `meetingItemId` when a file holds them), `after` (`summary`, `decisions`, `questions`, `tasks`, `at`). A row whose `doc` no longer parses reads as an empty one: a page never fails to open over its own row.
- `people_keys` is `personKey` of everyone on the meeting when the row was last written. It is how a meeting with no series finds its last time.
- `work_prep_ahead(workspace_id, routine_id)` keeps the routine a workspace's Prepare-ahead switch made.

Every change to a page runs one at a time for that page, across windows (`serial.ts`, `changeInOrder`), and ends in one push.

## Series and last time

`series.ts`, pure.

- LifeOS keeps one row per occurrence of a repeating event and stores no series. Its worker names an occurrence `<series>@<original start>`. `seriesOf` cuts the last `@<stamp>` only when the stamp has the worker's shape (`20261110T090000Z`, or `20261110` for an all-day one), so an iCal UID that holds an `@` of its own is never taken for a series.
- `lastOf`: the newest earlier page of the workspace with the same series. With no series, the newest earlier page with the same folded title that shares a person.
- A new page of a series starts with last time's added people, and last time's files are among its files.
- `subjectWords` drops the words every meeting's title has (meeting, sync, call, weekly, review, 1:1 and the like) and answers nothing for a title left empty, in which case no task search runs. `linksIn` finds the http and https links in an event's description and place; a call's link is named "Join".

## The facts

`gather.ts`. One gatherer serves the page, the tools and the first message of a thread, so the three never disagree.

**The fence is this file's job.** The host reads LifeOS as the owner, whose session holds every sector. So:

- the workspace must be a Work workspace linked to a sector (`workspaceSector`);
- the event must be in that sector, or the read is refused: "That event is not in Purdue's sector" (`eventOf`, the first thing every read and write does);
- every query that takes a sector gets the workspace's;
- `people:find` answers a person of any sector, so a person is used only when `people:page {id, sector}` answers them, which it does only for one of this sector's people. Anyone else is the event's own name and address, nothing of LifeOS's.

`gather.test.ts` proves a far sector's event, person, mail and task never reach a page.

What it reads, in one round trip:

| Part | From |
|---|---|
| The event | `events:get`: title, time, place. The leave time is the clashes pillar's (`work.clashes.leave`, asked through that module's `handle` only after the fence passed) when that pillar answers, else the event's own `leaveAt` |
| People | the event's attendees (Google feeds only), then the page's added people, folded by address, 12 drawn and the rest counted. For each: their newest mail thread in the sector, whether they declined |
| Tasks | each person's open tasks (asked by them, waiting on them; four a person), then up to five open tasks whose title names the subject, less those already listed |
| Files | the event's links, last time's files, the brief's files, each once |
| Last time | `lastOf`'s page: what was decided, what was left open, and the tasks it filed that are still open (`tasks:get`, ten at most). Not answered when that page said nothing |
| The mail | `compose:byOrigin {threadId: follow thread}`: the drafts still waiting, in this sector. For display only |
| Notes' file | the meeting item or the document that holds the notes (`notesFile`) |

A part that fails is left out and named in `problems` (`people`, `tasks`, `last`, `drafts`). Only the event itself, and the fence on it, fail the whole read.

## The wire

`work.prep.*`, every method carried to the workspace's host (`PREP_RELAY` is empty), so the phone and a Mac window reach a page on the box.

| Method | Capability | Does |
|---|---|---|
| `page {workspaceId, eventId}` | read | the facts and what the page keeps; writes nothing |
| `upcoming {from, to}` | read | the timed events with someone else on them in this host's linked Work workspaces, soonest first, each with its state; 31 days a call at most; one LifeOS read, no query per person |
| `people {…, people}` | operate | sets the added people, each once |
| `brief {…}` | operate | starts the brief thread, or answers the one still working |
| `notes {…, text}` | operate | keeps his notes; empty text takes them back, but a file that holds the notes stays |
| `followUp {…, recording?}` | operate | starts the follow-up thread, or answers the one still working |
| `notesDoc {…, today?}` | operate | makes the notes document, once |
| `decide {…, taskIds, decision}` | approve | accept files each task in LifeOS, reject drops it; answers `{page, failed}` |
| `ahead {workspaceId, on?, tz?}` | read; a person with admin to set | the workspace's Prepare-ahead routine |

The push is `{ push: 'work.prep', workspaceId, eventId, rev }`: ids and a revision, never a word of a page. It fires on every write, so on every change of state a write makes. A screen reads the page again when `rev` is past what it holds.

**State** (`prepStateOf`): `after` once notes or an outcome stand; else `briefed` once a brief stands; else `working` while a brief thread was started less than 20 minutes ago and has not written; else `none`. `WorkCtx` has no read of a thread's status, so the host bounds `working` by time, and that one change (working back to none) comes with no push: a reader works the state out again when it reads. The window is exact: it knows the thread's status from its own session row.

## The threads

Both are ordinary Work threads made by `ctx.threads.start`: in the rail, on the workspace's model, linked to the event (`about`), titled by the host ("Prepare: Staff sync", "Follow up: Staff sync") so no model names one from what may be Purdue mail. The host makes the row, so the prompt is never read as his words. Prep makes no hidden model call.

- **Brief** (`prompts.ts` `briefMessage`): the facts as words, then: read the newest mail with each person and the open tasks, look for what changed since last time, call `prep_write`, send nothing, add no task.
- **Follow up** (`followMessage`): the page as words and his notes, then: call `prep_follow_up`, never `add_task`, draft one follow-up mail with `draft_mail`, never send.

A second press while that thread still works (started under 20 minutes ago, nothing written since) answers the same thread.

## The tools

For every Work thread of a linked workspace; none in a Work Chat or an unlinked workspace. The event is `event`, or the newest event the thread is linked to. An event of another sector is refused with the gatherer's own words.

- `prep_read {event?}` (read-only): the page as words (`pageWords`): the facts, the brief, the notes, the outcome, last time.
- `prep_today {}` (read-only): the meetings of the thread's workspace that start in the next 16 hours, have someone else on them and no brief yet, eight at most, each with its facts.
- `prep_write {event?, matters, agreed?, files?, people?}`: one to five `matters`; replaces the brief whole; `people` are added to the page's, each once.
- `prep_follow_up {event?, summary?, decisions?, questions?, tasks?}`: writes the outcome. Each task is a suggestion. A rewrite keeps his word: a task whose folded title matches one already filed or rejected keeps that record, a filed task the rewrite leaves out stays, and a new suggestion gets an id never used on that page before (`suggestion_seq`), so a stale tick cannot act on changed words.

The module's `preamble` adds two lines: a meeting's tasks go through `prep_follow_up` and wait for him; a follow-up mail is a draft.

**What the hold does not catch.** A thread can still call LifeOS's `add_task` directly, as any Work thread can: that write is not held (work-outbox.md). The preamble and both prompts forbid it for a meeting; nothing can stop it.

## Filing a task

`after.ts`, `filing.ts`. On his accept, one at a time: `tasks:create {sector, title, description, dueAt?, key}` as the owner, in the workspace's sector. `description` names the meeting and its day and quotes the line ("From “Staff sync”, Mon Nov 23."). `key` is `prep:<page id>:<suggestion id>`, so a retry files it once, and a filing LifeOS made but whose answer was lost is found again. Each filing is kept before the next is tried. One that fails stays proposed and comes back in `failed` with LifeOS's words. `ctx.results.add` records a filed task on the follow-up thread when that thread still exists.

## Notes from a file

The Notes dialog has two ways in beside typing.

**A recording or a transcript.** A file needs a thread to go up to (an upload is into a thread's workspace), so the order is:

1. `followUp {recording: {name}}`: the host starts the follow-up thread and opens an empty meeting (`{at: 'thread'}`) in that thread's own pane, keeps its item as `notes.meetingItemId`, and answers `{sessionId, itemId}`.
2. The window sends the file to that thread's host, into the workspace's folder (`uploadFile {into: 'workspace'}`), then calls the meetings pillar's own `work.meetings.start {itemId, source}`. A recording is transcribed on that host. Nothing of it goes anywhere else.
3. The thread's message says to call `prep_read`, which names the meeting, then `meeting_read` (which waits while it is transcribed), and to write tasks through `prep_follow_up` alone: no `meeting_notes` actions, or each task would be suggested twice.

A file over the host's limit starts nothing. A host that cannot transcribe says so in the dialog, in the meeting's own words, once the start has answered; by then the thread exists, and it reads the same failure.

**A document.** `notesDoc` makes the notes file from the job's Meeting notes template through the templates pillar's door for other pillars (`makeFromTemplate(ctx, {template: 'any/meeting-notes', …}, by)`, loaded on the press), in the workspace's own folder, and keeps it as `notes.file`. Made once: a second ask answers the same file. The window opens it beside a new thread, as a file dropped on a view opens (`openOutside({at: 'new'})`); nothing runs until he sends. Follow up then opens it beside the follow-up thread, whose message says to read it with `doc_read` and change nothing in it. A host with no such template says so in the dialog.

Words he types later sit beside either file.

## Prepare ahead

`ahead.ts`, on mail's Waiting on model. On his press the pillar saves one routine as the owner through the routines module's own `handle`: "Prepare today's meetings", 7:00 each day in the window's time zone, never ending. Its id is kept in `work_prep_ahead`; off pauses it, so its runs stay readable; on again resumes it. The prompt: call `prep_today`; write a brief for each meeting it lists with `prep_write`; with none, say so and stop. It makes no grant.

- Off until he turns it on, in every job.
- Setting it needs a person with `admin`.
- **Withheld for Purdue** (`AHEAD_WITHHELD`): a routine would read university mail into a model each morning with no press of his. `aheadOf` answers `offered: false` there and the setter refuses. Empty the list to flip it.

## The page

`PrepView.tsx`, the lazy chunk `work-prep-view`; its dialogs are a second chunk, `work-prep-dialogs`. The look is docs/DESIGN.md "A meeting's page".

**Where it lives.** A view of the workspace with no row in the column: `WorkViewDef.inside: 'agenda'` (work.md "The column"). It is opened by `openWorkView({ workspaceId, view: 'prep', event: <LifeOS event id> })`, and the event stays in the open view while the page shows. Agenda's row verb opens it: Prepare until the event ends, Follow up after (`prepEndOf`: its end, or an hour after its start), on the row and in its right-click.

**The header.** The way back (the arrow, "Agenda", the event's title muted), then one verb and More.

| Where the meeting stands | The verb (`headVerb`) |
|---|---|
| before the end, no brief | Brief me |
| its brief thread at work | a spinner with "Preparing", which opens the thread |
| a brief stands | none (More holds Prepare again) |
| over, no notes | Add notes |
| notes stand | Follow up |
| its follow-up thread at work | a spinner with "Following up" |
| an outcome stands | none |

More: Open thread, Prepare again, Add people…, Add notes… (Edit notes… once there are some; left out while the header holds it), Dismiss the rest, New thread about this, and the check row Prepare each morning (not drawn where it is withheld).

**The body** (`PrepPageBody`, which holds no query, so the preview and the tests draw what the app draws). The title and one comma line (`whenLine`: "Today, 2:00 to 2:45 PM, RecWell 204, leave 1:40"). Then, each only when it has something: the brief's lines; Last time; People; Tasks; Files. A row opens where its thing lives. After the meeting the outcome leads: the summary, Notes, Decided, To do, Open questions, Mail; then the brief (named "Brief" once it no longer leads) and the rest as before.

- **To do**: suggested tasks start unticked (`TICKED_AT_FIRST`). The section's foot holds Tick all and, while any is ticked, the page's one primary button ("Add 3 tasks"). A filed task takes LifeOS's mark and opens its sheet. A filing that failed is one state line with Retry.
- **Mail**: one row a waiting draft, which opens the Outbox on it. Send, Edit and Discard stay the Outbox's.
- **Notes**: the file that holds them, as one row (it is not listed again under Files), then what he typed, six lines and Show all.
- A part that did not load is one state line at the top of the view with Retry.

**The offer.** Under his first brief in a workspace, once: "Prepare each morning's meetings ahead", Turn on, and a dismiss. Kept per workspace in localStorage (`work.prep.aheadOffer`). Never drawn where Prepare ahead is withheld.

**Add people** searches the sector's directory (`people:directory` on the view's own session), leaves out whoever is on the event already, and takes a typed name for someone LifeOS does not know. A calendar that lists no attendees (Teams and ICS feeds, so most Purdue events) leaves a page with no one on it; this is how he says who is coming, and it is kept for the series.

**Notes** keeps what he typed however the dialog closes.

## The borders

- **The notice is the digest's.** Prep calls no `ctx.tell`, keeps no clock, and raises no toast, badge or sound. It gives the fact: `upcoming` and the `work.prep` push. A row has what a notice needs (`title`, `startsAt`, `with`, `state`); a press opens `openWorkView({workspaceId, view: 'prep', event})`.
- **Today**: `work/prep/today.ts` is one of Today's sources (`TODAY_SOURCES`). It adds a mark to a meeting's row (`event:<LifeOS event id>`), never a row of its own: a press opens the meeting's page in its job (`goTo`), and the row says "Prep is ready" only for `briefed` (`meetingMark` in `model.ts`). It reads `work.prep.upcoming` for the day on every host with Work on (`useEachWorkspace`) and again on the `work.prep` push; a host answers every job of its own, so a meeting is taken from its own job's answer alone. A host that does not answer adds no line to Today: a mark is only ever an extra.
- **Clashes** owns clashes and drive time. The page shows its leave time, nothing else of a clash.
- **Review**: its slipped meeting's Follow up opens the same target.
- **The phone** has no page of its own. A brief or a follow-up thread ends with the page's words as its last message, so the phone shows them in the thread. The wire is carried by the relay, so a native page can come later.

## Proofs

- `series.test.ts`, `gather.test.ts`, `prompts.test.ts`, `prep.rig.test.ts` (a real Work mount on the hold's rig) on the host; `model.test.ts`, `PrepView.dom.test.tsx`, `agenda/AgendaPrep.dom.test.tsx` and the frame's `inside` case in `shell/shell.test.ts` on the screen.
- `bun run ui:preview src/renderer/src/work/prep/PrepView.preview.tsx#PrepPreview --props '{"state":"briefed"}' --shot`, states `facts`, `nobody`, `preparing`, `briefed`, `after`, `filed`, `failed`, `recording`, `partial`, `loading`.
- `env -u ELECTRON_RUN_AS_NODE bun scripts/e2e-prep.ts` (through `heavy`, after a build): one whole job on an isolated instance against his real LifeOS with dummy data, by the house pattern of work-proofs.md.
