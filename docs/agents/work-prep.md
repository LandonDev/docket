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
| People | the event's attendees (Google feeds only), then the page's added people, folded by address, 12 drawn and the rest counted. For each: their newest mail thread in the sector, whether they declined. `invited` is the address of everyone the calendar lists, drawn or not: the window's Add people offers none of them, and `people` keeps none of them, from his Add people or a thread's `prep_write` alike (`ownAdditions`: an invitee kept as an addition would follow the series to a day they are not invited) |
| Tasks | each person's open tasks (asked by them, waiting on them; four a person), then up to five open tasks whose title names the subject, less those already listed, and less any this page filed (they show under To do) or last time's page filed (under Last time) |
| Files | the event's links, last time's files, the brief's files, each once |
| Last time | `lastOf`'s page: what was decided, what was left open, and the tasks it filed that are still open (`tasks:get`, ten at most). A task LifeOS no longer holds is left out; one whose read fails is named in `problems` as `last`, beside what did load. Not answered when that page said nothing |
| The mail | `compose:byOrigin {threadId}` for every thread that wrote the outcome (`after.by`, oldest first, the newest six) and for the page's follow-up thread now, each draft once: the drafts still waiting, in this sector. A later follow-up that takes the page's thread, or rewrites the outcome, hides no mail an earlier one drafted: past six writers, the oldest that left no mail waiting are dropped first. One thread's read that fails keeps the others' mail and names `drafts` in `problems`, and `pageWords` then says whether a mail waits could not be read, never that none does. For display, and listed in `pageWords` so a thread knows a mail already waits |
| Notes' file | the meeting item or the document that holds the notes (`notesFile`) |

A part that fails is left out and named in `problems` (`people`, `tasks`, `last`, `drafts`). Only the event itself, and the fence on it, fail the whole read.

## The wire

`work.prep.*`, every method carried to the workspace's host (`PREP_RELAY` is empty), so the phone and a Mac window reach a page on the box.

| Method | Capability | Does |
|---|---|---|
| `page {workspaceId, eventId}` | read | the facts and what the page keeps; writes nothing |
| `upcoming {from, to}` | read | the timed events with someone else on them in this host's linked Work workspaces, soonest first, each with its state; 31 days a call at most. Someone else is not him: an attendee at one of his own addresses (`mail:accounts`, as Review reads them) does not count, and is not named in `with`. Two LifeOS reads (the events, his addresses), no query per person, and of the pages only the range's and 400 before it a workspace (`PrepStore.around`) |
| `people {…, people}` | operate | sets the added people, each once |
| `brief {…, restart?}` | operate | starts the brief thread, or answers the one still working; `restart` when the window knows that thread has stopped |
| `notes {…, text, dropFile?, itemId?}` | operate | keeps his notes; empty text takes them back, but a file that holds the notes stays, unless the window says it never arrived (`dropFile`). With `itemId`, one upload's cleanup: only that meeting goes, only while the page still names it, and the host keeps the words it holds |
| `followUp {…, restart?, recording?}` | operate | starts the follow-up thread, or answers the one still working |
| `notesDoc {…, today?}` | operate | makes the notes document, once (again only when he deleted it); `today` is the meeting's own day, which fills `{{Date}}` |
| `decide {…, taskIds, decision}` | approve | accept files each task in LifeOS, reject drops it; answers `{page, failed}` |
| `ahead {workspaceId, on?, tz?}` | read; a person with admin to set | the workspace's Prepare-ahead routine |

The push is `{ push: 'work.prep', workspaceId, eventId, rev }`: ids and a revision, never a word of a page. It fires on every write, so on every change of state a write makes. A screen reads the page again when `rev` is past what it holds.

**State** (`prepStateOf`): `after` once notes or an outcome stand; else `briefed` once a brief stands; else `working` while a brief thread was started less than 20 minutes ago and has not written; else `none`. `WorkCtx` has no read of a thread's status, so the host bounds `working` by time, and that one change (working back to none) comes with no push. So the page also says until when each thread still counts as at work (`briefUntil`, `followUntil`), and a reader that cannot see the thread holds that against its own clock: the bound runs out with no push. The window is exact where it can be: for a thread it holds, the status on its own session row wins.

## The threads

Both are ordinary Work threads made by `ctx.threads.start`: in the rail, on the workspace's model, linked to the event (`about`), titled by the host ("Prepare: Staff sync", "Follow up: Staff sync") so no model names one from what may be Purdue mail. The host makes the row, so the prompt is never read as his words. Prep makes no hidden model call.

- **Brief** (`prompts.ts` `briefMessage`): the facts as words, then: read the newest mail with each person and the open tasks, look for what changed since last time, call `prep_write`, send nothing, add no task.
- **Follow up** (`followMessage`): the page as words and his notes, then: call `prep_follow_up`, never `add_task`, call `prep_read` once more just before any mail, and draft a follow-up mail with `draft_mail` only if that read lists none already waiting and could read it (one mail a meeting, however many follow-ups), never send. Two follow-ups close together can still each draft one when both reads come before either draft; both wait for his press.

A second press while that thread still works (started under 20 minutes ago, nothing written since) answers the same thread. When he changed his notes since that thread started (`notes.at` after `followAt`), the host tells it first (`ctx.threads.resume` with `followNotesMessage`: the page as it stands now, write the outcome again) and counts it as started from that press, so the same notes pressed again tell it nothing more. A thread that cannot be told is said in words and nothing changes.

A thread a later press put out of its place (another started for the same part, or the page let go of it) is remembered on the row (`superseded`, `brief:<id>` and `follow:<id>`). Its late `prep_write` or `prep_follow_up` is refused ("A newer … thread was started for this meeting…"), so it never replaces the newer thread's result or its suggestions. A thread the page never named, as Prepare ahead's routine thread, writes as before. The host cannot read a thread's status, so the window says when it knows better: it holds the thread's row, and a press on a thread it knows has stopped carries `restart`, which starts a new one whatever the clock says.

The page says when each thread was started (`briefStartedAt`, `followStartedAt`). A brief or an outcome written since is that run's, and from then the header no longer calls the thread at work, though it may still run (it drafts the mail and says its last words after it writes). A Prepare again starts later than the brief that stands, so the header says Preparing until its own lands.

One follow-up is not a new thread: notes that are a recording beside a follow-up thread that stopped. A meeting is read only from its own pane (`meetings.owns`), so a new thread could not read it; the host asks the same thread again (`ctx.threads.resume` with `followAgainMessage`) and counts it as at work from that press. A thread that cannot be woken is said in words ("The follow-up thread could not be started again (…). Open it from More.") and nothing changes: a new thread could not read the recording, so none starts. One case the host cannot see: a thread whose harness is down (it shows Resume in its own view) takes the notice and runs only once he resumes it there; `ctx.threads.resume` answers the same for it as for a thread that will run at once.

## The tools

For every Work thread of a linked workspace; none in a Work Chat or an unlinked workspace. The event is `event`, or the newest event the thread is linked to. An event of another sector is refused with the gatherer's own words.

- `prep_read {event?}` (read-only): the page as words (`pageWords`): the facts, the brief, the notes, the outcome, the mail that already waits, last time. Called by the follow-up thread of a recording whose file has not arrived yet, it waits in that one call (`awaitRecording`, a look a second for up to eight minutes, ended by the turn's own stop): until the meetings pillar has the file; or the page has let go of it, and then it tells the thread to stop and write nothing; or the time is up, and then it says to call again.
- `prep_today {}` (read-only): the meetings of the thread's workspace that start in the next 16 hours, have someone else on them and no brief yet, eight at most, each with its facts.
- `prep_write {event?, matters, agreed?, files?, people?}`: one to five `matters`; replaces the brief whole; `people` are added to the page's, each once, less anyone the calendar lists (`ownAdditions`).
- `prep_follow_up {event?, summary?, decisions?, questions?, tasks?}`: writes the outcome. Each task is a suggestion. A rewrite keeps his word: a task whose folded title matches one already filed or rejected keeps that record, a filed task the rewrite leaves out stays, a dismissed one it leaves out is remembered by its folded title (`after.dismissed`, 100 at most) and stays dismissed when a later rewrite suggests it again, a waiting suggestion that comes back unchanged (title, who, due and quote) keeps its id, so a filing LifeOS took but never answered keeps its key on Retry, and any other suggestion gets an id never used on that page before (`suggestion_seq`), so a stale tick cannot act on changed words.

The module's `preamble` adds two lines: a meeting's tasks go through `prep_follow_up` and wait for him; a follow-up mail is a draft.

**What the hold does not catch.** A thread can still call LifeOS's `add_task` directly, as any Work thread can: that write is not held (work-outbox.md). The preamble and both prompts forbid it for a meeting; nothing can stop it.

## Filing a task

`after.ts`, `filing.ts`. On his accept, one at a time: `tasks:create {sector, title, description, dueAt?, key}` as the owner, in the workspace's sector. `description` names the meeting and its day and quotes the line ("From “Staff sync”, Mon Nov 23."). `key` is `prep:<page id>:<suggestion id>`, so a retry files it once, and a filing LifeOS made but whose answer was lost is found again. LifeOS takes a key only as a quick add's own, so the task carries `source: {kind: 'manual', container: 'quick-add', channel: 'Meeting', messageId: key}`, as capture's filing does (the whole job found this: a keyed create with no such source is refused). Each filing is kept before the next is tried. One that fails stays proposed and comes back in `failed` with LifeOS's own words, the server's wrapping cut (`lifeosWords`). A task the page filed is one row, under To do: the facts leave it out of Tasks. `ctx.results.add` records a filed task on the follow-up thread when that thread still exists.

## Notes from a file

The Notes dialog has two ways in beside typing.

**A recording or a transcript.** A file needs a thread to go up to (an upload is into a thread's workspace), so the order is:

1. `followUp {recording: {name}}`: the host starts the follow-up thread and opens an empty meeting (`{at: 'thread'}`) in that thread's own pane, keeps its item as `notes.meetingItemId`, and answers `{sessionId, itemId}`.
2. The window sends the file to that thread's host, into the workspace's folder (`uploadFile {into: 'workspace'}`), then calls the meetings pillar's own `work.meetings.start {itemId, source}`. A recording is transcribed on that host. Nothing of it goes anywhere else.
3. The thread's message says to call `prep_read` first, which waits until the file has arrived and names the meeting, then `meeting_read` (which waits while it is transcribed), to stop with no outcome and no mail if the file could not be read, and to write tasks through `prep_follow_up` alone: no `meeting_notes` actions, or each task would be suggested twice. The thread starts before the file is up, and `meeting_read` on a meeting with no file answers at once, so without that wait the thread would spend a model turn a look for as long as the upload runs.

A file over the host's limit starts nothing. A host that cannot transcribe says so in the dialog, in the meeting's own words, once the start has answered; by then the thread exists, and it reads the same failure. A recording that never arrived, or that the host could not read at once, is no notes: the window tells the host to forget it (`notes {dropFile}`). What he typed stays, a notes document the recording stood beside stays, and the page lets go of the thread that was started for it (it waits on a file that will never come), so the header stops saying Following up and the next Follow up, typed or from another file, starts fresh. A later Follow up from typed words that still finds an empty meeting (the meetings pillar's own `get`; the window never said), or one this host could not read, leaves it behind and starts a fresh thread from his words; no thread is sent to read a failed recording again. A transcription that fails later, after the dialog has gone, is said on the page: the window reads the page again on the `work.meetings` push that names its meeting, the Notes row carries the meeting's own words (`notesFile.error`), and the thread reads the same failure. Notes that are only such a recording are no notes to follow up from: the header asks for notes again. With a notes document kept beside it, the document is the notes a follow-up reads: `notesFile` names the document, with what became of the recording as its line, and the header says Follow up.

A second file picked while a follow-up thread is at work goes to that thread's meeting only while it is still empty (the first never arrived) and no window's upload to it still runs: the host holds each meeting it handed to an upload (in memory, for the working bound) until that upload says its file never came, so two windows never send two files to one meeting. A meeting that holds a file, or one an upload still goes to, gets no second: the host answers no item and the dialog says a follow-up is already at work. A window whose upload fails names its own meeting (`notes {dropFile, itemId}`): a cleanup that comes late, after the page moved on to another meeting, changes nothing, and none takes the words another window kept. A meeting this host could not read is not waited on at all: a new file starts a thread and a meeting of its own whatever the clock says, and that thread's message does not call the old meeting its own.

If the window's word that a file never came does not reach the host (the link was down), the page still names the empty meeting as its notes. A Follow up with nothing typed then refuses ("Add notes first."), and the host stops calling that meeting notes and lets go of its thread in the same step, so the header asks for notes.

**A document.** `notesDoc` makes the notes file from the job's Meeting notes template through the templates pillar's door for other pillars (`makeFromTemplate(ctx, {template: 'Meeting notes', …}, by)`, loaded on the press), in the workspace's own folder, and keeps it as `notes.file` beside anything the notes already hold (a recording stays). It asks by the name, so his own template saved as Meeting notes wins and our starter `any/meeting-notes` is found when he has none. Made once: a second ask answers the same file, and makes a new one only when he deleted it. A rename or move in Files is followed (`notesDocMoved` on Files' `registerFileMoved`, with a new revision). The window opens it in a Files tab of the meeting's own workspace, through Files' way in from another screen (`openInFiles`), never in whichever job is in front; when he went somewhere else while the host made it (the press's own `choose` number), nothing opens and the page's Notes row holds it. No thread runs. Follow up then opens it beside the follow-up thread, whose message says to read it with `doc_read` and change nothing in it. A host with no such template says so in the dialog.

Words he types later sit beside either file.

## Prepare ahead

`ahead.ts`, on mail's Waiting on model. On his press the pillar saves one routine as the owner through the routines module's own `handle`: "Prepare today's meetings", 7:00 each day in the window's time zone, never ending. Its id is kept in `work_prep_ahead`; off pauses it, so its runs stay readable; on again resumes it. The prompt: call `prep_today`; write a brief for each meeting it lists with `prep_write`; with none, say so and stop. It makes no grant.

- Off until he turns it on, in every job.
- Setting it needs a person with `admin`.
- **Withheld for Purdue** (`AHEAD_WITHHELD`): a routine would read university mail into a model each morning with no press of his. `aheadOf` answers `offered: false` there and the setter refuses. Empty the list to flip it.

## The page

`PrepView.tsx`, the lazy chunk `work-prep-view`; its dialogs are a second chunk, `work-prep-dialogs`. The look is docs/DESIGN.md "A meeting's page".

**Where it lives.** A view of the workspace with no row in the column: `WorkViewDef.inside: 'agenda'` (work.md "The column"). It is opened by `openWorkView({ workspaceId, view: 'prep', event: <LifeOS event id> })`, and the event stays in the open view while the page shows. Agenda's row verb opens it: Prepare until the event ends, Follow up after, on the row and in its right-click. The row and the page's header read one rule, `prepEndOf`: its end; with none, an hour after its start, or the next midnight for one that lasts the day. Agenda keeps the day and the view he was on through a visit to the page (`agenda/place.ts`); leaving the page for anywhere else ends the visit.

**The header.** The way back (the arrow, "Agenda", the event's title muted), then one verb and More.

| Where the meeting stands | The verb (`headVerb`) |
|---|---|
| before the end, no brief | Brief me |
| its brief thread at work, its brief not yet written | a spinner with "Preparing", which opens the thread |
| a brief stands | none (More holds Prepare again) |
| over, no notes (or only a recording the host could not read, or a meeting item that is gone) | Add notes |
| notes stand (`notesToFollow`: words he typed, his notes document, or a meeting this host still has and could read) | Follow up |
| its follow-up thread at work, its outcome not yet written, its recording not failed | a spinner with "Following up" |
| an outcome stands | none |

More: Open thread, Brief me (before the end while the header does not hold it: notes kept early take the header, never the brief; Prepare again once a brief stands; not while a brief is being written), Add people…, Add notes… (Edit notes… once there are some; left out while the header holds it), Dismiss the rest, New thread about this, and the check row Prepare meetings each morning (`AHEAD_LABEL`; not drawn where it is withheld).

**The body** (`PrepPageBody`, which holds no query, so the preview and the tests draw what the app draws). The title and one comma line (`whenLine`: "Today, 2:00 to 2:45 PM, RecWell 204, leave 1:40"; a place that is only a link is left out, since Files offers it as Join the call). Then, each only when it has something: the brief's lines; Last time; People; Tasks; Files. A row opens where its thing lives. After the meeting the outcome leads: the summary, Notes, Decided, To do, Open questions, Mail; then the brief (named "Brief" once it no longer leads) and the rest as before.

- **To do**: suggested tasks start unticked (`TICKED_AT_FIRST`). The section's foot holds Tick all and, while any is ticked, the page's one primary button ("Add 3 tasks"). A filed task takes LifeOS's mark and opens its sheet. A filing that failed is one state line ("A task was not added" and, for one task, its name; "2 tasks were not added" for more) with Retry, and why is on each task's own row as a muted line that wraps, so it is whole at any width and each task keeps its own cause. Retry owns that task until it is filed: it cannot be ticked, Tick all leaves it out, and the line stays until the next answer is in. One filing runs at a time, whichever control asked: a Retry pressed while Add files runs once that answer is in, and no tick moves meanwhile. When the control he pressed goes with its answer, the caret lands on the first task that was filed, or on Retry when LifeOS took none.
- **Mail**: one row a waiting draft, which opens the Outbox on it. Send, Edit and Discard stay the Outbox's. The draft comes with no write of the page, so the page also reads again on the `work.outbox` push while it has a follow-up thread.
- **Decided**, **Open questions** and Last time's lines wrap whole, though a line with a reference opens its source: the source may never say what the line says.
- **Notes**: the file that holds them, as one row by its name (it is not listed again under Files; why a recording could not be read is its second line, which wraps), then what he typed: six lines while they lead the page, two once the outcome stands over what they say, then Show all, offered only when the words run past that as drawn.
- While the follow-up thread works and has written nothing, three bones hold the outcome's place, as a brief's is held.
- One state line at the top of the view, with Retry: a filing that failed, else a read that failed behind a page still on screen ("This page did not refresh"), else what did not load (the one part by its own words; more than one as "Parts of this page did not load"). With no page to show, a retry draws the bones while it reads. A Retry that works takes its own button away: the caret then lands on the view's heading (where the frame puts a lost caret), or on Retry again when the whole page failed once more.

**The offer.** Under his first brief in a workspace, once: the switch by its one name, Turn on, and a dismiss. It is answered, per workspace in localStorage (`work.prep.aheadOffer`), once the host has taken the switch or he dismisses it; a refusal leaves it there. Never drawn where Prepare ahead is withheld.

**Add people** searches the sector's directory (`people:directory` on the view's own session), leaves out whoever is on the event already, and takes a typed name for someone LifeOS does not know: the name stays in the list, ticked. Someone the calendar lists is not offered by name either, typed as their address or as the name the page draws (`namesInvitee`), and the host keeps no such addition; nor is one of the list's own people typed whole, by name or by address, whose row is the one to tick. Return in the search never saves: it adds the typed name when the list shows no one for it, ticks the one person it shows, and does nothing for several. A person is known by address, else by name folded for case and Latin accents, the marks of other scripts kept (`prepFold` in the contract: one rule for the host's `personKey` and the window's `addedKey`). Save is off until the ticks differ from what the page keeps, and while it is on its way the list holds still: no tick, no typed name, the search read only. While the directory is read its bones stand under whoever is already added. A calendar that lists no attendees (Teams and ICS feeds, so most Purdue events) leaves a page with no one on it; this is how he says who is coming, and it is kept for the series.

**Notes** keeps what he typed however the dialog closes. Cancel saves first and closes once the host has it; a save the host refuses keeps the dialog open on his words, with why. Escape, the backdrop and the corner's close leave at once and send the save then; if it is refused, his words are held for that meeting and the dialog opens again on them, on that meeting's page alone and never over another dialog. After any way out it opens again from the header or More. A follow-up started from the dialog carries `restart` as the header's does. A dialog is its own meeting's: it never follows him to another meeting's page. When the page goes from under it (he opens another view), what he typed is sent as a close sends it, and if the host does not take it the dialog opens on his words when he is back on that meeting's page. Follow up in the dialog takes the header's rule (`notesToFollow`): with his notes document or a readable recording on the page, it needs no typed words. While Write in a document makes the document, a spinner stands beside that verb (not inside it, so the resting verb keeps no room for one), and Follow up never spins for it. Notes past the host's 60,000 characters are said in the dialog's own words before anything is sent ("These notes are too long to keep…"), and the dialog stays open on them: a transcript that long belongs in the file route. While a file goes up the dialog shows the app's bar with the per cent, and a spinner until the size is known.

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
