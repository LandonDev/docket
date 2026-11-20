# Work: plays

A play is work he repeats in one job, saved once and started with one
press: a name, the steps a thread follows, and what each start hands it.
Starting one makes an ordinary Work thread whose first message is the steps
with the things attached; from there it is a thread like any other, and
whatever it would send is held ([work-outbox.md](work-outbox.md)). Plays are
part of the routines pillar ([work-routines.md](work-routines.md)): a
routine is work the host starts on a trigger, a play is work he starts by
hand, and a routine may run a play.

## Why its own store, not a routine with no trigger

A routine row carries a trigger, a clock, a cursor and runs; a play has
none of them, and a routine with no trigger would have sat in the Routines
list beside the real ones. So plays are their own small table, and a
routine points at one (`work_routines.play_id`) to run it on a clock. There
is one scheduler, the routines engine, and each thing is in one list.

## Files

| What | Where |
|---|---|
| The wire, the takes, the first message, the starters | `src/shared/contract-work-routines.ts` (`PlaysRequestSchemas`, `PLAY_TAKES`, `playInputsProblem`, `playMessage`, `STARTER_PLAYS`) |
| The rows | `src/main/server/work/routines/plays.ts` (`work_routines_plays`) |
| The methods and the two tools | `routines/playMethods.ts`, routed from `routines/index.ts` |
| A routine running a play | `routines/engine.ts` `fire`, `routines/store.ts` (`play_id`) |
| A thread's words, for a draft | `routines/host.ts` `words` |
| The screens | `src/renderer/src/work/routines/plays/` (`view.ts`, `PlaysView.tsx`, `PlayDialog.tsx`, `RunDialog.tsx`, `PlaysHost.tsx`, `PlaysDialogs.tsx`, `runOn.ts`, `model.ts`, `data.ts`) |

## The rows

`work_routines_plays(id, workspace_id, name, instructions, takes, proposed,
made_in, starter, created_by, created_at, updated_at)`. `takes` is a JSON
list of `mail`, `task`, `event`, `file`, `date`, `text`, each at most once,
kept in that order. A name is used once in a workspace, letter case aside.
`starter` is the key of the starter it was added from. A workspace removed
takes its plays; a thread a play started stays when the play goes.

## Who may make what

- `work.routines.plays {workspaceId}` (`read`): proposals first, then by name.
- `work.routines.playSave` (`admin`): makes one, changes one, or his Add on a
  proposal or a starter. `work.routines.playRemove` (`admin`): Delete, or Not
  now on a proposal; refused while a routine runs it ("the routine “Mondays”
  runs it; change or delete that routine first").
- `work.routines.playStart {id, inputs}` (`operate`) → `{sessionId}`.
- `work.routines.playDraft {sessionId}` (`operate`) → `{name, instructions,
  takes}`.
- All four writes and the draft refuse a thread's own call (`Caller.kind ===
  'model'`). The push `work.routines.plays {workspaceId}` says a workspace's
  plays changed.
- `play_list` (read-only tool): the workspace's plays, proposals marked.
- `play_propose {name, instructions, takes}` (tool): a proposed row; it
  starts nothing. At most five waiting per thread; a name in use is refused.
  A Work Chat has neither tool (plays belong to a workspace).

## A start

`playStart` checks the inputs against what the play takes
(`playInputsProblem`): one chip for each thing it takes (a mail chip for
`mail`, a task's for `task`, an event's for `event`, a `doc` or `item` chip
for `file`), its date, its line of text, and nothing it does not take. Then
it calls `ctx.threads.start({workspaceId, text, title, about})`, the host's own
start that a routine uses: the thread runs on the workspace's model, the
first LifeOS chip links it to that row, its name is the play's and the
thing's (`playTitle`), so no model is asked to title it from what may be a
Purdue mail, and the message is the chips'
lines (as the composer writes them), the date, his text, the steps, then
"Started from the play “…”". Because the host makes the row, the steps are
never read as words he typed (`ctx.threads.ownerSaid`, which lets a write
to a shared document land): a play an agent proposed and he added could
otherwise speak for him. A play carries no grant and makes none.

A routine that runs a play (`playId` on its save, a play of the same
workspace, not a proposal, that takes nothing) reads the play at each
firing, so his last edit is what runs; its own words, if any, follow the
steps. While a routine that has not ended runs a play, the play cannot be
deleted or made to take something; a run whose play was changed anyway (by
another build on the same database) fails ("its play now takes date"), as
does one whose play is gone.

An older build on the same database ignores `play_id`: a routine that runs a
play with no words of its own would start a thread whose message is only the
"Started by the routine" line. That lasts until the next publish.

## Draft from the thread

Save as a play… on a Work thread opens the dialog empty. Draft from the
thread is the dialog's one model call, made only on that press, and it
fills only the fields he left empty: the thread's messages, each marked
owner, app or agent by who wrote it, newest kept up to 16,000 characters
(`draftPrompt`), go to a one-shot Claude call (`generateText`,
drivers/title.ts) that answers JSON (`parseDraft`); he edits before Add.
**A Purdue thread is never drafted** (Purdue data may not go to a tool the
university has not cleared): the host refuses it and the dialog draws no
button.

## The starters

`STARTER_PLAYS` holds one or two per sector, offered under Starters in the
Plays view until he adds them (or has a play of that name), never added by
themselves. Each asks only for what the app does today: tasks and mail
drafts in LifeOS, calendar events drafted for his approval, a sheet line,
the code thread he opens from a task himself. Frame.io has no signed-in
account yet, so the Hypixel brief keeps a Frame.io link in a task and opens
no review round.

| Sector | Starter | Takes |
|---|---|---|
| ref | Game assignment: an event, a drive before it, a pay line | mail |
| ref | Month’s pay: totals and mismatches, changing nothing | date |
| hypixel | Video brief: tasks back from the deadline, a reply draft | mail |
| hypixel | Review notes to tasks | text |
| cosmic | Bug report to a task, a reply draft | mail |
| purdue | Event request: a checklist of tasks, a reply draft | mail |
| unify | Client request: a task, a reply draft | mail |
| life | Bill to pay: a task | mail |

## The screens

- **Plays** in a linked Work workspace's column, after Files and before
  Routines (`WORK_VIEWS.plays`, the `work-plays-view` chunk; it reads the
  host alone, so no LifeOS sign-in stands over it). His plays, each its
  name over "Takes a mail and a date" or "Takes nothing"; then Proposed;
  then Starters. A play that takes nothing starts on its row's press (the row
  says Starting… and the thread opens); one that takes something opens the
  run dialog. Edit (a pencil on hover) and a proposal's or a starter's press
  open the play dialog. The header's New play opens it empty. With no plays
  and no starters, one line: No plays yet, with New play.
- **The play dialog** (`PlayDialog`): Name, Instructions, Takes (a toggle
  for each of the six). Save; Delete (asks first) at the foot for his play,
  Not now (asks nothing) for a proposal, Add for a proposal or a starter;
  Draft from the thread at the foot when saving from a thread.
- **The run dialog** (`RunDialog`): from a thing, the plays of the
  workspace that take it ("No play takes a mail yet." when none), each with
  what it still takes ("Also takes a date") or nothing; a play the thing
  fills starts on the press; otherwise the thing stands chosen at
  the top and each remaining take is a field: a search of that kind through
  `work.canvas.mentions` (the composer's `@`, in the workspace's reach), a
  date (today to start), or text. Start makes the thread and opens it.
- **Run a play…** on a task's right-click (Tasks), a mail's row menu and the
  reader's menus (the mail kit's `reference.MenuItem`), an agenda event's
  right-click (a new menu on the list's rows: Prepare, Run a play…), and a
  Teams file's row menu when the file lies on the workspace's own host. Each
  reads the open view's workspace (`playRunner`, runOn.ts) and draws nothing
  when no Work view is open.
- **Save as a play…** in a Work thread's menu (a root thread of a workspace,
  not a draft), while Work is on.
- **The frame's seams** (the landing note names them): `WorkPlayPort` and
  `workPlayPort` in lib/workSwitch.ts (first paint, types loose so nothing
  of Work enters it), filled by `PlaysHost`, which Work's shell mounts in
  `WorkRailHost`; the `play` fact and `save-play` row in lib/threadMenu.ts
  and chrome/useThreadMenu.tsx; the `plays` entry in
  work/views/registry.ts. The dialogs it opens are the `work-plays` chunk.
- A routine's form gains **Runs** (a select of his plays that take nothing)
  when there is one; with a play picked, "What to do" becomes "Also" and may
  be empty. The routine's detail says Runs and the play's name.

## Not built

There is no command palette in the app (⌘K is search), so a play is not
started from one. Plays are not `@`-mentionable and are not on the phone.
Starting a play from a draft's composer, a play's own model, and per-play
counts of runs are on the owner's list (.temp-code/plans/landed/F-plays.md).

## Proofs

- `work/threads.test.ts`: a start through `ctx.threads.start` with no run
  behind it, as a play's is, keeps its title and is never his words.
- `routines/plays.rig.test.ts` (the hold's rig, a real Work mount): a
  proposal starts nothing and every write refuses a thread's own call; the
  start's message, `about` and input checks; a play that takes nothing starts
  with no inputs; starters only once and only in their sector; a routine runs
  only a play of its workspace that he added and that takes nothing, reads it
  afresh, keeps it from being deleted or given takes, fails when it was
  changed anyway, and lets an ended routine's play go; five proposals a
  thread; a date that is no day; `play_id` added to an older table; a draft reads the thread's words and never a Purdue thread's; a
  workspace removed takes its plays.
- `src/shared/contract-work-routines.test.ts`: the inputs rule, the takes'
  order, the starters' keys and words.
- `src/renderer/src/work/routines/plays/model.test.ts` and
  `PlaysView.dom.test.tsx`: the words, the lists' order, one press for a play
  that takes nothing, the run dialog from a mail, Draft only on its press.
- `bun run ui:preview src/renderer/src/work/routines/plays/PlaysView.preview.tsx#PlaysPreview --props '{"state":"list"}'`
  (`list`, `plays`, `starters`).
