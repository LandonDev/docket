# Microsoft Forms in Work (the `msforms` pillar)

Real Microsoft Forms, used from inside Work (plan `.temp-code/plan-0OohUT4FyDgY.md`, the trial
`.temp-code/plans/ms-forms/trial.md`). The form, its sign-in and its answers workbook stay Microsoft's and the
tenant's; everything around them is ours. Nothing here calls Graph, a Forms API or Forms' own `/formapi`: the page is
read through its accessibility tree, and the answers from the workbook Forms keeps in the form's folder.

Pillar 65 (`PILLAR_MILESTONE.msforms`), beside our own `forms`. Code: `src/main/server/work/msforms/`,
`src/renderer/src/work/msforms/`, `src/shared/contract-work-msforms.ts`, `src/shared/work/msforms.ts` (pure rules).
Wire `work.msforms.*`, push `work.msforms`, tools `msform_*`, act kinds `msform.make` and `msform.publish`, canvas and
chip kind `msform`, view `forms`.

## Where each part runs

- **The page he sees**: the real Forms builder in the Office-live guest (a fenced `<webview>`), on the tenant's
  Office-live session `persist:office-live-<tenant>`, so one sign-in serves Word, Excel and Forms. The window asks a
  Forms ticket with `{forms: {tenant, formId, page}}` and main builds the address itself (work-office-live.md "The
  fence"). The kind's body (`MsFormCanvas.tsx`) mounts `LiveBody`; a Files tab tells it whether the chat lies over the
  tab through `LiveCover` (office/live/cover.ts).
- **The agent's hands**: the box's own Chromium, driven only by the carrier (below).
- **The answers**: the workbook Forms makes in the form's folder, read through the same box browser into memory.
- Microsoft forms are offered only on a host with the box browser's carrier (`msCarrier()`) and a SharePoint library
  (`offeredHere`; `work.msforms.list` answers `offered`). Elsewhere New offers our own form alone.

## The row

`work_msforms` (msforms/store.ts), one a form, keyed by `(workspace_id, form_id)`: the tenant, the sector it was made
in, the title, its folder `{libraryId, path, siteUrl, label}`, its workbook once known, its state (`draft`,
`collecting`, `closed`), the mode (`suggests`, `writes`), the settings as last read, the questions, `rev`, the read
times, `count`, `last_id`, the check schedule, waiting suggestions, a held publish, who made it, the account the page
named, what the carrier last could not finish, when it closed. `work_msforms_versions` keeps the question list per
rev (Question history). The builder and response addresses are made from the id (`builderOf`, `respondOf`), never
stored. **No answer, respondent name or address is a column anywhere** (the data rule below).

## The one reach check

`formReach(ctx, by, ask)` (msforms/reach.ts), asked by every method, tool, search source, People read, dashboard and
Files seat before any lookup: a thread's job is its session's (`scopeOf`), never what it named; a thread with no job
(a Work Chat, a code thread) is refused before a form is looked up; the form must be the job's, made in the job's
current sector, in a library this host still reaches for that caller (`librariesFor`: the disk's, and the VM's only
where the caller may use the VM). A refusal to a thread names nothing: "refused: a Microsoft form's answers are read
only from a thread of the form's own job; nothing was read." `formsReached` lists only what `formReach` would pass.

## The carrier: the only hands on Forms

msforms/carrier/. `CARRIER_ONLY_HOSTS` (browser/box/service.ts, work-browser.md) closes Forms' hosts to every session
but the carrier's own (`carrierSession`, made by host code alone through `carrierComputer()`); a Mac's Work thread is
refused a step on a Forms page and a `computer_apps` open of one (computer-use.md). So no generic agent tool reaches
Forms: the `msform_*` tools are the only way, and branching, file upload, Ranking, Likert, themes and quizzes are his
to do in the page.

- **Operations, not steps** (ops.ts): `make`, `read`, `warm`, `write`, `settings`, `collect`, `audience`, `close`,
  `count`, `pull`, each a fixed program run one at a time (wire.ts's queue) on a carrier session ended after it, unless
  it kept the form's builder (below).
- **A kept builder** (wire.ts `exclusiveOn`, 2026-11-25): a `make`, `read`, `warm`, `write` or `settings` that ended
  well keeps its form's builder open, and the session waits parked with that page alone for the next operation on the
  form. At most two (`KEEP_MAX`), the oldest closed first; the session ends after three idle minutes (`KEEP_MS`). While
  parked it gives back the browser's hold (`park`, box/index.ts), so the idle and memory stops count it as idle, and it
  ends within five seconds of his taking the browser (`PARK_WATCH_MS`), which loses its lease as a read would; the
  next operation takes it only through `resume`, which refuses a lost lease, his driving now, or a browser service
  started again. A kept page is never driven as it stood: Forms tells an open builder nothing of a change made
  elsewhere (live: a kept page still read Accept responses off after he turned it on in another window), so the
  operation first loads it again at its own address (`carrierReload` in service.ts, a page that session owns) and
  drives it only once its title shows; one that will not load is closed and the form opened afresh. A held change
  `warm`s its form's builder under a read grant, so his Accept finds it open. With the reload, a kept page saves about
  the cost of an open (well under a second); what it mostly keeps is the browser and its sign-in warm while a thread
  works on the form.
- **Its pages are its own** (review 2; service.ts `CARRIER_TARGETS`): a carrier session's page is made blank and
  reserved before it loads anything, and every page opened from one (a popup, by Chromium's `openerId`, at any depth:
  `inheritCarrierTargets` on each page list) is that session's too, so Excel for the web's workbook tab and the
  SharePoint page are never listed, read, pictured, watched or acted on by a thread, by no session (`apps.list`), or by
  another carrier: to them a carrier's window is not there (`window_not_found`). Every exit ends the session, and the
  end closes all of its pages (`carrierRelease`); a closed page stays reserved until Chromium no longer lists it, and
  one that would not close stays reserved.
- **One lease an operation** (review 24; box/index.ts `carrierComputer`): taken with the session, lost for good the
  first time a read finds him driving the browser. After that no read runs, the page list, a page read, an act or an
  in-page request, even once he hands the browser back; only its own cleanup does. The in-page request
  (`carrierFetchExpression`) runs only while the page's live origin is the one the host checked, with
  `redirect: 'error'`, and a redirected answer or one from another origin reads as status 0 with none of its body.
- **Cleanup** (`carrierClear`) closes the carrier's own pages and answers a fixed word, `closed`, `kept` or `gone`,
  which a stop logs. It clears no origin's storage: in the shared profile `Storage.clearDataForOrigin` would clear it
  for his own SharePoint and Excel pages too, and no call limits it to the carrier's, so Excel's and SharePoint's
  stored data for those origins stays as his own opening of the file would leave it.
- A thread's `box_browser_open` of a Forms address is refused in Forms' own words, "refused: Microsoft Forms pages are
  reached only through the msform tools; nothing was opened.", before anything is asked of the service.
- **Each runs under an authorization** (types.ts `authorize`, `checkAuth`) bound to the host, workspace, form (or
  folder), operation, a digest of its payload and the form's `rev`, from a grantor allowed it (`OPS_BY`): his press
  (`owner`), a claimed held act's execute (`act`), the pillar under Agent writes on a draft, a closing end date and a
  close (`pillar`, never a reopen), the poller (`read`, `count`, `pull`).
- **The grant binds the call that runs** (review 15). The carrier checks it once before it waits and again in its turn
  in the queue, against what it reads there itself (`OpsDeps.rowOf`, wire.ts `rowFactsOf`): the job and `rev` of the
  form's row, one row a form id. Its payload is made again from the call (types.ts `readPayload`, `settingsPayload`,
  `pullPayload`, `makePayload`), so what runs is what was granted:
  - `read` has a read-only grant of its own (`{formId}`), pressing only Settings open and closed; a collect,
    audience or settings grant does not read.
  - `collect` and `audience` bind the settings they set; the held act makes each grant after its fresh read, for
    exactly the settings it runs.
  - `make` binds the folder (its library and path) and the folder's page it opens. The carrier makes that page again
    from the library this host reaches for that Work job (`OpsDeps.folderOf`, wire.ts `folderPagesOf`), refuses a call
    whose address differs, and opens only its own.
  - `pull` binds the form, the site, the folder the workbook must be in, and the workbook's own id and name; the
    carrier refuses a call whose folder or workbook is not the row's as it stands (`RowFacts.pull`).
  - `write`, `settings`, `close` and `count` bind their payloads as before; an agent's reopen is refused.
- **The guard** (guard.ts): per operation, the controls it may press by role, name and the names above them; `NEVER`
  (Send, Copy link, Shorten URL, the collaborate and duplicate links, Move to a group, Delete all responses, a summary
  link, Quick import, template cards, the creates other than Forms survey, Print, Delete); toggles that turn answers on
  or widen who can answer only where that is the act; keys Tab and Shift-Tab alone.
- **A step the service says failed was not taken** (wire.ts `act`), whatever the call answered: a press the page's
  hit test refused ("something else covers …") came back as no error and went unseen (live, 2026-11-25).
- **The trial's rules** (steps.ts): windows by id; a fresh read before each step, an index never reused across reads;
  Tab to commit, never Escape or Return; Required set on every new question; at most one retry after a fresh read.
- **The page it drives is the page its open made** (review 16):
  - wire.ts names each page by Chromium's own target id (`t:<target>`), never the window number the service gives
    it. Every read, act, close and fetch asks which number that target has now, and a page that is gone is driven no
    more.
  - A form's page (steps.ts `Page`, with its `formId`) must show that form's id in its address at every read: another
    form, or none, stops the operation before its next step.
  - The wire acts only on the read it checked: the screen an act is guarded against must be that page's last read, at
    the same window number. An act uses it up, and another read since refuses before anything runs.
  - A make takes its form only from a page the folder's page opened (Chromium's `openerId`, carried by
    `carrierPages()` in browser/box/service.ts), or from the folder's page itself. Another new Forms page is never
    taken, and two from the folder's page are refused.
- **Reading a form** (read.ts `formOf`): the trial's names (a question at rest "N. Question title <title> <type>
  [Required to answer]", the Settings toggles, the Collect responses link, the Responses count). Tested on fixtures
  in the trial's words and on a fake Forms page (carrier/fakePage.ts) the real operations drive.
- **A stop says what was done** (`CarrierStop`): "Did 1 of 3 changes (added "Phone"); the next … did not take …". The
  row keeps the page as the stop read it and `stopped` shows on the form's state line.

## Making a form

His New → Form in a Teams or OneDrive folder of Files (Page.tsx; `formKindsFor` in work/msforms/newForm.ts) offers
"Microsoft Form" and "TempCode Form"; the Forms view's New asks for the place. `work.msforms.make` runs at once: the
carrier opens the folder's library page (a Team library's `Forms/AllItems.aspx`; on his OneDrive OneDrive's own
`_layouts/15/onedrive.aspx`, since a personal site's AllItems answers 404: `folderPageOf`, place.ts), Create or
upload → "xlsx Forms survey", follows the window that page opened to its id, turns
**Accept responses off first** and reads it back, then names the form, adds what was asked and sets who can answer
(org only, record names, one answer each by default). If the first step fails the row keeps the form as a draft that
may take answers and says "The form was made but may take answers until Accept responses is off. Open it and turn
that off, or delete it." Any failure once Forms has made the form (the box browser stopped, a sign-in, his driving)
keeps the row the same way (`keptStop`, ops.ts): after Accept responses is off it says what was done and that the
browser stopped. Before P5 a browser stopped at the title step answered a plain error and left a form in RecWell's
group forms that no row knew. Forms makes no workbook at create, in the folder or at the library's root (P5); the
first pull makes it. A make with no questions (New → Form) reads its result once the page has saved, with the
settings the panel read back, and does not open Settings a second time. The new form opens in its Files tab (`registerRefSeat('msform')`, files/hooks.ts).
While it runs, the page's state line says the stage the host pushes (`work.msforms.making`: opening, making,
setting, naming, asking; `MAKE_STAGE_WORDS` in useFormMaking.ts). Each press carries a key (`op`): the same key asked
again, by a window whose wait ran out, answers the make already under way or just done (kept 10 minutes), never a
second form.

A library another computer holds (his Mac's OneDrive copy of RecWell) takes a Microsoft form through the box's own
copy of the same library (`twinOf`, `formFolderOf`): the window asks the make for the same folder in the box's (or its
VM's) copy, and the form lands in the same SharePoint folder. With no such copy on the box the row is there, off, and
says "Only a library the box also holds takes a Microsoft form."; nothing is asked of any host.

An agent's make (`msform_create`) is always held as `msform.make`: a form made in a Team shows to its members at
once. `from` makes the questions from our form, a document, a sheet's header row or a template (msforms/makers,
work-forms.md "Make this a Microsoft form"); `collect: true` also collects at the same press.

A form's row in a Files folder (the pillar's folder extra) opens in its Files tab like the Forms view's row, never in
an app on the folder's computer (`openWay`: a row whose ref is no file is a tab): asked of the VM's Office, such an
open answered "A Teams file is named by its path on its host.", which is what the owner met on his first form.
His Remove from List on a Forms view row (`work.msforms.forget`, his press alone) drops the row and its history from
Work; the form stays in Forms as it is.

## The hold

- `msform.publish` (`collect`, `audience`, `reopen`) and `msform.make` have no matcher: no grant carries them, Away
  releases none, and an earned offer never forms. The press reads the form fresh and is stale when its rev moved or the
  page's questions or settings are not the held words; Collect responses reads the link and never sends it.
- Not held: his own close and reopen, an agent's close, a closing end date, his edits in the page, his New.
- An agent's change to a collecting form always waits for his Accept (`work.msforms.review`, approve under
  `mustBePerson`: never a thread, another host or an MCP key); on a draft the mode decides, and Agent writes
  runs only after a fresh read shows Accept responses off. Waiting changes are said in words on the bar's stepper.
  The mode is read at each change, so his switch counts from the thread's next one. Agent writes is one visit: the
  write's first step opens Settings and reads Accept responses by the panel's own name ("Options for responses Accept
  responses"; one not shown reads as on), and a form taking answers stops there before any change
  (`CarrierTakesAnswers`), which the tool holds with its reason. (Before 2026-11-25 a separate read passed the form
  and the write's own check, looking for "Accept responses" alone, refused it: the change was dropped with an error
  and nothing waited.) Agent writes holds a change, and
  says why on the stepper and to the thread (`WRITES_HELD`, msforms/tools.ts), where the `office.edit` rule for a file
  others can open applies: a form that takes answers, or is collecting; and a Purdue form for a thread a routine
  started (`answersWithheld`'s line). A form his Team can see but that takes no answers is his own draft here.
- **The link goes out only on his press**: his Copy, the QR he shows, Mail the link (Mail's composer, his Send).
  `notGrantable` refuses a grant on any act whose words hold a form's link (`hasFormLink`, work-outbox.md).
- SharePoint's Forms survey and Create new form, Excel's New Form and Send Form, and Forms' Open results in Excel are
  outward on their pages (`PAGE_OUTWARD`, work-outbox.md), so a generic agent step there is held.

## Applying changes

His Accept (`work.msforms.review`) runs every chosen change in one visit of `write`, in order; Accept all is one visit
too. Each window showing the form hears where it stands (`work.msforms.applying`: `opening`, `checking` for an agent's
write, `changing` n of m, `reading`, then null), and the form's tab says it on the line above the page, in the making
line's shape, where the waiting change's words give way to it (`applyStageWords`, MsFormCanvas.tsx; docs/DESIGN.md
"Microsoft form"). A stop part way keeps the changes it did not reach waiting
(`CarrierStop.done`), so his next Accept takes up where it stopped.

How an add is driven on the real page (live, 2026-11-25), each a cause of a failure seen:
- A new question is left through Settings, opened and closed (ops.ts `rest`): that commits it and leaves "Add new
  question" at the form's foot. Leaving by the form's title, as before, left its header in edit, which hides "Add new
  question", so the second add of a visit stopped.
- The form scrolls in a box of its own that runs past the window's foot. Once a question was added, "Add new
  question" sits just inside that foot, a press does not bring it to the middle, and its picker of types opens below
  the window, under a strip, where every press on a type misses. Before an add the box is wheeled up on the last
  question at rest (in the same batch as Settings' Close after an add), so the press on "Add new question" brings it
  to the middle with room below.
- The read back after a write whose Settings were read in that visit, with nothing in edit since, does not open
  Settings again (`finalRead`).

Timed on a dummy from a copy of the box browser's profile (`scripts/proof-msforms.ts`, `TC_CARRIER_DEBUG=1`), a warm
browser:

| | before | after |
|---|---|---|
| his Accept of one change | 13.2 s (3-question form) | 11.3 s (27 questions; 9.9 s with the kept page not loaded again, which was unsafe) |
| his Accept all of three | stopped at the second add (three single Accepts, about 40 s) | 26.3 s, one visit |
| a thread's change under Agent writes, Accept responses off | refused, change dropped | written, 12.3 to 12.9 s |
| the same with Accept responses on | held, 3.8 s (after a read visit) | held, 4.6 s |

What a change still costs is the pages' own settling: every press waits about 0.8 to 1 s for the page to go quiet
(`COMPUTER_WAIT.action`, the computer tools' wait every thread shares), and an add is six presses (wheel, Add new
question, its type, the title with Tab, Settings, Close).

## Reading answers

msforms/answers/. A read is the Responses view's count first (cheap); when it moved, or the memory holds no rows, the
pull: Open results in Excel (and its first-use Continue; once the workbook exists, the view's button that names it
instead) kept open so Forms writes its rows. The workbook is the one that Excel for the web window opened: its
document id (`sourcedoc=` in the address) binds it, never a name. From a second window on the folder's site page,
SharePoint REST checks that id, the form's site and the place, before the first byte and again after the wait (a
move, another file or no Excel window stops the read and nothing is stored). The place is the form's folder, or, for
a form made in a Team library, that library's root: Forms makes a Team form's workbook there, named after the form,
where every member of the team can open it (P1). Then it waits for Modified to move and stand still (or 90 s with
none), and the bytes come into memory. The windows close, and so does every other page the carrier opened (above). `answersOf` (parse.ts) finds
`OfficeForms.Table` and reads it by header name: `Id`, `Start time`, `Completion time`, `Email`, `Name`, then each
question by title. Past 5,000 rows the newest are kept and the summary line says so. A timeout keeps the last rows,
marked stale ("as of").

The poller (`startAnswersPoller`) checks a collecting form by its schedule (every hour by default, every 15 minutes,
or only when he looks), skips while he drives the box browser, and never reads a draft.

**The data rule.** Answers live in memory alone (answers/cache.ts: one entry a form, dropped after 30 minutes unshown,
at the form's removal and at restart). Work's database, logs, tells, pushes, task titles and the computer journal hold
no answer, respondent name or address; only fixed sentences reach `stopped` and errors. What remains on the box is
what opening any Teams file leaves: the box browser's own HTTP cache, and what Excel and SharePoint store for their
origins in the profile, which is shared with his pages and not cleared (above). An answer a thread reads stays in that thread's
transcript, as anything a thread reads does. The answers workbook itself is never read to a thread through the generic
readers: `sheet_read` and the sheets tools, `office_range_read`, `office_files`' sheet sizes and the sheet maker refuse
it ("read them with msform_answers"; the read-only judge's `readRefused`, workbook.ts); his own window reads it as before.

## Around the form

- **Open the Workbook** (More, once the workbook exists; `work.msforms.workbook`): the workbook opens in Excel for the web
  in a Files tab, his own Excel-for-the-web open also syncing it. Opened Edit here, the sheet editor shows it read
  only ("Microsoft Forms writes this workbook. Open it in Excel for the web to change it.", msforms/workbook.ts through
  `registerReadOnlyFile`), no save goes back from its copy, and the sheet and Office tools refuse to write it.
- **Question History** (More; `work.msforms.history`): each change of the question list in words, newest first,
  with when and who (the agent, him, or seen in the page).
- **Files**: a library folder lists each form made in it as its own row (entry kind `form`, `registerFolderExtras`,
  work-files.md), just before its workbook, whose row reads "Answers to <form>" and whose menu holds Open the Form.
- **Connections**: one row a host with the carrier, "Microsoft Forms", signed in as the account the last pass read,
  or Needs you when a pass met Microsoft's sign-in; the Office-live tenant row reads "Office and Forms for the web".
- **The phone**: a Forms row lists the job's Microsoft forms (`work.msforms.list`) after TempCode's own; one that
  collected opens its answers in the app (`get`, `responses`, then `seen`), a draft in Safari. Close is operate;
  Reopen (`work.msforms.close {open: true}`) asks approve on the key itself past the door (`mustBePerson`), so
  an operate key, a thread, another host and an MCP key cannot restart collecting (M5b).

## Answers as data in Work

- **Responses half** of the kind: our forms' table (forms/responses.tsx), "as of" once when old, Refresh, ticked rows
  to Ask; Who hasn't answered (NotAnswered.tsx) against People of the sector or pasted addresses; with the job's LifeOS session down it says `DownLine` in the people's place and keeps what he ticked and pasted, and Check, which needs no LifeOS, still works.
- **Forms view** (`forms`): ours and Microsoft's, newest first; a row opens its form.
- **Digest**: "3 new responses to <form>" (`msforms.responses`, key `msforms:<formId>`), done when he opens Responses.
- **Today**: the Responses section, one row per form with unseen answers.
- **Routines**: a trigger "When someone answers <form>" and the job `msforms.tasks`, one LifeOS task per new answer,
  titled with no name (work-routines.md). The trigger's words, each firing, the job and a save take the form only while
  it passes `formAdmitted` (reach.ts: its sector, its library still reached); the engine arms no trigger on another
  workspace's form.
- **People**: an Answered section and `person_page`'s line (`work.msforms.byPerson`), matched by lower-cased address,
  never across sectors.
- **Dashboards**: `msform:<form id>` with `count`, `option:<question>`, `day` (work-dashboards.md).
- **Search and `@`**: forms by title, answers by a word or a name from memory only (a Work Chat gets titles alone);
  the `msform` chip opens the form by its source. A form `formReach` would refuse now (its library gone, another
  sector) gives no title, no cached answer and no chip.

## Purdue

`MSFORM_UNATTENDED_WITHHELD = ['purdue']` (src/shared/work/msforms.ts): a thread a routine started, or one it
delegated to (its scope's `routineRun`, the run up its line by parent or starter: work/provenance.ts, one walk with
the Outbox's grants; a line this host cannot follow, or no scope, is withheld too) is refused every answer read of a Purdue form, whatever trigger or Run now started it: "refused: a
routine's thread does not read Purdue answers: they go to no AI tool without the owner's press. Nothing was read."
Saving a Purdue routine on a form's answers that would start a thread is refused, offering the job instead. His own
asks are not withheld. Purdue's policy VII.A.5 is why; empty the list to lift it.

## The agent's tools

`msform_list`, `msform_read`, `msform_answers`, `msform_find` (reads), `msform_create` (held), `msform_edit`,
`msform_settings`, `msform_publish` (held), `msform_close` (close runs, reopen held). msforms/tools.ts.

## What it will not do

No API, no `/formapi`, no form page of ours, no proxy, no re-hosted answers, no answer in Work's own stores. A redesign
of Microsoft's page breaks the agent's steps until fixed; `scripts/proof-msforms-canary.ts` (by hand) names the first
step that broke.

## What it cannot catch

Said plainly, from the built-code review (`.temp-code/plans/ms-forms/review-built.md`; what was fixed and what was
declined, with why, is `review-built-answer.md` beside it):

- A page the box browser shows that follows a link or a redirect to a Forms address on its own reaches Forms before
  the fence's next check; only the steps after it are refused. A Forms page framed inside another site is not fenced.
- A batch of computer steps is read for outward controls on its first screen; a control a later step mounts (a menu's
  Forms survey) is read only by the page's own `PAGE_OUTWARD` names when that step runs.
- On a Mac, a Work thread can still look at a Forms page already open in his browser; it cannot act on it or open one.
- The window asks a Forms ticket with a tenant and an id; main checks their shape, not that the host made the form.
  The renderer is our own code and a guest cannot ask for tickets.
- A copy of a Forms workbook made from another computer's OneDrive, or kept under a name it had before a move, is not
  known as a Forms workbook on a host without the form's row.
- An answer he or a thread put in a thread's words stays in that thread's transcript, which other threads of the job
  may read as they read any thread.
- The shell, as everywhere (work-browser.md: a thread's shell could reach the box browser's DevTools port).
- A redesign of Microsoft's page that renames a listed control; the canary is how we learn.

## Proofs

**The canary**, by hand, never scheduled: `bun --preload ./scripts/lib/electron-stub.ts scripts/proof-msforms-canary.ts` through `.temp-code/bin/heavy`, on a copy of the box browser's profile (refused while the live Work browser runs). It makes "TempCode proof canary <time>" in his OneDrive, adds and renames a question, reads it back, counts and deletes it (only our item from the Forms recycle bin), and prints `CANARY OK` with each step's time or `CANARY BROKE AT <step>: …`; the dummy is deleted on every way out (the rig is `scripts/lib/msformsRig.ts`, shared with `scripts/proof-msforms.ts`).

**P5 job 2, from a window paired to the deployed box (release 381), 2026-11-24.** A New → Folder in Team RecWell
(the VM, 35 s, woke it) worked. New → Form stopped with "Forms showed another form than the one asked", and so did
every carrier read after it. The check that each read shows the asked form (review 16, steps.ts) took the id from the
observation's address bar, whose value is cut at 160 characters (`cutValue`). A builder's address for an id of 88
characters is 160 exactly, so the Responses view (`&analysis=true`) and a new form's window came back ending
"…(+14 chars)", and their ids were no ids. The carrier's read now puts the page's whole address, as Chromium lists
the target, in the bar (`withAddress`, wire.ts). The make's form had been made, and its row kept it with Accept
responses on. A draft's Accept responses can be turned off only in Forms itself: `work.msforms.close` refuses a draft.

**P5 job 1, live, 2026-11-24** (`scripts/proof-msforms.ts` with `TC_PROOF_HOST` the box's id, `TC_CARRIER_DEBUG=1`
timing each call to the page, `/mem` reading the browser's VmRSS and Pss sums; `TC_PROOF_COUNT=rss` caps as the
deployed host did before the Pss fix). Dummies in a "TempCode proof" folder of RecWell's library and of his OneDrive,
all deleted. The owner's first make stopped at Settings because the cap counted summed VmRSS: the same make on a cold
browser read 2,099 MB and was stopped 15 s in, where its Pss was about 1,070 MB. A make, in seconds: the browser
starts in about 0.5; the folder's page loads and shows Create or upload in 1.1; Create or upload 1.3; Forms survey
1.5 to 1.9 and the new window found at once; the form's first read 0.9 to 1.1; Settings 1.8 to 2.1; Accept
responses off 1.3 to 1.8; who can answer 3.5 to 3.8; the title 2.3 to 3.9; the wait for "Saved" and the read 2.4 to
4.7. In all, 20.8 s before the fixes and 18.3 s after in RecWell; 20.2 s from a cold browser in OneDrive. Each step's
press costs 0.8 to 1.5 s of the page settling, the most of a make.

**P1 and P2, live, 2026-11-24** (`scripts/proof-msforms.ts`; notes and pictures in `.temp-code/plans/ms-forms/P1/`
and `P2/`). The box browser on a copy of the box's Work browser profile, the outbox and msforms pillars on their own
database with the VM's RecWell library record, the real carrier; his presses as owner calls. Dummies only, in a
folder made for the proof in RecWell's library; all deleted at the end.

| Step | Time |
|---|---|
| New → Microsoft form in a RecWell folder: made, Accept responses off first, who can answer set, titled | 14 s |
| Collect responses, held, then his press: collecting, the link read from Forms' dialog | 14 s |
| The first pull: Open results in Excel, Continue, the workbook made, bound by its id, read | 1 min 43 s (90 s of it the wait for a save that did not come) |
| An answer, then the quarter-hour check (one poller tick) | the tick's read failed on a browser that had just quit; his Refresh then showed it 124 s after its submit |
| An answer, then his Refresh | 60 s for the Refresh itself |
| A question renamed through the carrier's `write` | 9 s; the next read matched the workbook's column to the new title |

Also proven: the form made from a Team library folder is a group form, listed at once in Forms' My groups → RecWell
for the whole team; Forms makes it with Accept responses on (the carrier's first step turns it off); a thread's
`box_browser_open` of a Forms address and a thread's `work.msforms.make` are refused; the tell is one row a form,
counted in place ("3 new responses to …"), with no name; the routine's job filed one task per new answer, none twice
(LifeOS stood in: no test session of his LifeOS on the box); `isFormsWorkbook` names the workbook.

Not proven: the Files tab's guest (typing in the real builder and its reload on the agent's change) and Open the
workbook Live, which need the Electron window; no windowed instance was run. There is no prefilled link: the proof's
prefill (`Get Pre-filled URL`) reached the form's fields, but Forms never showed the link it makes, so the share
menu, the wire and the carrier no longer offer one (2026-11-24).

Open, found by the proofs:
- The box browser's 2 GB cap (`MEMORY_CAP_MB`, chromium.ts) stopped it with a Forms page, a SharePoint page and a
  third open (2,053 and 2,784 MB of summed VmRSS; the PSS was about half), so a make or a pull could stop part way.
  The cap now counts each process's Pss (`treeRssMb` reads smaps_rollup), where shared pages count once. P5 showed
  it was the owner's first make: under the summed-VmRSS count a dummy make on a cold browser read 2,099 MB at its
  title step and was stopped (his stopped at Settings), where its Pss was about 1,070 MB. A make holds about 1.0 to
  1.3 GB of Pss alone; with other pages open it can still pass 2 GB (2,103 MB in P5, with five pages of the proof's
  own), so while an operation holds the browser (`useBoxBrowser`, `holding` in chromium.ts) the memory stop waits
  for it to end, up to 1.5 times the cap.
- After each pull the box browser's Chromium quit (no stop logged; the cause was not found). The next carrier call
  met a fresh browser whose Forms page signs in again for several seconds, and failed once. Since this proof the
  service tells the host's sessions of the new browser (`apps/changed`), so the call after that works.
- A thread's refused Forms open reads "open refused an item; give documents, folders or web pages", not the
  service's own Forms sentence.

## When a read or link fails

Forms shows one Retry when all the sources it can use fail. When one fails, Forms keeps the rows that came back and names the missing source. A known lost link gets a named line and holds New form until the link opens.
