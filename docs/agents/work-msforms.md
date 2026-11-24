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

- **Operations, not steps** (ops.ts): `make`, `write`, `settings`, `collect`, `audience`, `close`, `count`, `pull`,
  each a fixed program run one at a time (wire.ts's queue) on a fresh carrier session ended after it.
- **Each runs under an authorization** (types.ts `authorize`, `checkAuth`) bound to the host, workspace, form (or
  folder), operation, a digest of its payload and the form's `rev`, from a grantor allowed it (`OPS_BY`): his press
  (`owner`), a claimed held act's execute (`act`), the pillar under Agent writes on a draft, a closing end date and a
  close (`pillar`, never a reopen), the poller (`count`, `pull`).
- **The guard** (guard.ts): per operation, the controls it may press by role, name and the names above them; `NEVER`
  (Send, Copy link, Shorten URL, the collaborate and duplicate links, Move to a group, Delete all responses, a summary
  link, Quick import, template cards, the creates other than Forms survey, Print, Delete); toggles that turn answers on
  or widen who can answer only where that is the act; keys Tab and Shift-Tab alone.
- **The trial's rules** (steps.ts): windows by id; a fresh read before each step, an index never reused across reads;
  Tab to commit, never Escape or Return; Required set on every new question; at most one retry after a fresh read.
- **Reading a form** (read.ts `formOf`): the trial's names (a question at rest "N. Question title <title> <type>
  [Required to answer]", the Settings toggles, the Collect responses link, the Responses count). Tested on fixtures
  in the trial's words and on a fake Forms page (carrier/fakePage.ts) the real operations drive.
- **A stop says what was done** (`CarrierStop`): "Did 1 of 3 changes (added "Phone"); the next … did not take …". The
  row keeps the page as the stop read it and `stopped` shows on the form's state line.

## Making a form

His New → Form in a Teams or OneDrive folder of Files (Page.tsx; `formKindsFor` in work/msforms/newForm.ts) offers
"Microsoft Form" and "TempCode Form"; the Forms view's New asks for the place. `work.msforms.make` runs at once: the
carrier opens the folder's library page, Create or upload → Forms survey, follows the new window to its id, turns
**Accept responses off first** and reads it back, then names the form, adds what was asked and sets who can answer
(org only, record names, one answer each by default). If the first step fails the row keeps the form as a draft that
may take answers and says "The form was made but may take answers: no one has its link. Open it and turn off Accept
responses, or delete it." The new form opens in its Files tab (`registerRefSeat('msform')`, files/hooks.ts).
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

## The hold

- `msform.publish` (`collect`, `audience`, `reopen`) and `msform.make` have no matcher: no grant carries them, Away
  releases none, and an earned offer never forms. The press reads the form fresh and is stale when its rev moved or the
  page's questions or settings are not the held words; Collect responses reads the link and never sends it.
- Not held: his own close and reopen, an agent's close, a closing end date, his edits in the page, his New.
- An agent's change to a collecting form always waits for his Accept; on a draft the mode decides, and Agent writes
  runs only after a fresh read shows Accept responses off. Waiting changes are said in words on the bar's stepper.
- **The link goes out only on his press**: his Copy, the QR he shows, Mail the link (Mail's composer, his Send).
  `notGrantable` refuses a grant on any act whose words hold a form's link (`hasFormLink`, work-outbox.md).
- SharePoint's Forms survey and Create new form, Excel's New Form and Send Form, and Forms' Open results in Excel are
  outward on their pages (`PAGE_OUTWARD`, work-outbox.md), so a generic agent step there is held.

## Reading answers

msforms/answers/. A read is the Responses view's count first (cheap); when it moved, or the memory holds no rows, the
pull: Open results in Excel (and its first-use Continue; once the workbook exists, the view's button that names it
instead) kept open so Forms writes its rows. The workbook is the one that Excel for the web window opened: its
document id (`sourcedoc=` in the address) binds it, never a name. From a second window on the folder's site page,
SharePoint REST checks that id, the form's site and the place, before the first byte and again after the wait (a
move, another file or no Excel window stops the read and nothing is stored). The place is the form's folder, or, for
a form made in a Team library, that library's root: Forms makes a Team form's workbook there, named after the form,
where every member of the team can open it (P1). Then it waits for Modified to move and stand still (or 90 s with
none), and the bytes come into memory. The windows close and what the browser stored for those origins is cleared. `answersOf` (parse.ts) finds
`OfficeForms.Table` and reads it by header name: `Id`, `Start time`, `Completion time`, `Email`, `Name`, then each
question by title. Past 5,000 rows the newest are kept and the summary line says so. A timeout keeps the last rows,
marked stale ("as of").

The poller (`startAnswersPoller`) checks a collecting form by its schedule (every hour by default, every 15 minutes,
or only when he looks), skips while he drives the box browser, and never reads a draft.

**The data rule.** Answers live in memory alone (answers/cache.ts: one entry a form, dropped after 30 minutes unshown,
at the form's removal and at restart). Work's database, logs, tells, pushes, task titles and the computer journal hold
no answer, respondent name or address; only fixed sentences reach `stopped` and errors. What remains on the box is
what opening any Teams file leaves: the box browser's own HTTP cache. An answer a thread reads stays in that thread's
transcript, as anything a thread reads does. The answers workbook itself is never read to a thread through the generic
readers: `sheet_read` and the sheets tools, `office_range_read`, `office_files`' sheet sizes and the sheet maker refuse
it ("read them with msform_answers"; the read-only judge's `readRefused`, workbook.ts); his own window reads it as before.

## Around the form

- **Open the Workbook** (More, once the workbook exists; `work.msforms.workbook`): the workbook opens Live in Excel
  in a Files tab, his own Excel-for-the-web open also syncing it. Opened Edit here, the sheet editor shows it read
  only ("Microsoft Forms writes this workbook. Open it Live in Excel to change it.", msforms/workbook.ts through
  `registerReadOnlyFile`), no save goes back from its copy, and the sheet and Office tools refuse to write it.
- **Question History** (More; `work.msforms.history`): each change of the question list in words, newest first,
  with when and who (the agent, him, or seen in the page).
- **Files**: a library folder lists each form made in it as its own row (entry kind `form`, `registerFolderExtras`,
  work-files.md), just before its workbook, whose row reads "Answers to <form>" and whose menu holds Open the Form.
- **Connections**: one row a host with the carrier, "Microsoft Forms", signed in as the account the last pass read,
  or Needs you when a pass met Microsoft's sign-in; the Office-live tenant row reads "Office and Forms for the web".
- **The phone**: a Forms row lists the job's Microsoft forms (`work.msforms.list`) and opens each in Safari.

## Answers as data in Work

- **Responses half** of the kind: our forms' table (forms/responses.tsx), "as of" once when old, Refresh, ticked rows
  to Ask; Who hasn't answered (NotAnswered.tsx) against People of the sector or pasted addresses.
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
- The box browser's 2 GB cap (`MEMORY_CAP_MB`, chromium.ts, the sum of each process's VmRSS) stopped it with a Forms
  page, a SharePoint page and a third open (2,053 and 2,784 MB; the PSS was about half). The proof raised it for
  itself; on the host a make or a pull can be stopped part way.
- After each pull the box browser's Chromium quit (no stop logged; the cause was not found). The next carrier call
  met a fresh browser whose Forms page signs in again for several seconds, and failed once. Since this proof the
  service tells the host's sessions of the new browser (`apps/changed`), so the call after that works.
- A thread's refused Forms open reads "open refused an item; give documents, folders or web pages", not the
  service's own Forms sentence.

