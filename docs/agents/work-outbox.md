# Work: the hold, grants and results

The owner's rule is "the press is his": agents draft, and nothing an agent
does leaves the machine until he presses Send. This file is the server half
of that rule (milestone 10 of the Work plan), Results, and the screens over
it: the Outbox, a Work thread's Results and the return from Away
(milestone 14; "Results" and "The screens" below).
[work.md](work.md) says how the `outbox` pillar is mounted;
`.temp-code/plans/work-architecture.md` §6 is the design.

## What is held, and what is not

| A Work thread's… | What happens | Where |
|---|---|---|
| add-on call | runs only if he set that tool to Runs; set to Off it is refused; anything else is held, a tool nobody reviewed included | `work/outbox/catch.ts`, the gate of `AddonHost.call` |
| LifeOS add-on call | never held by the host: the key cannot send and LifeOS holds its own drafts. The host stamps where a draft came from | `catch.ts` `stamped` |
| mail or calendar draft in LifeOS | listed with the host's own held rows, sent only by his press through the host | `work/outbox/lifeosHeld.ts` |
| computer act the host reads as outward, or the model flagged | kept as a live hold: nothing of the call runs | `computer/run.ts`, `shared/computer/outward.ts` |
| act of a pillar's own kind (a Teams post, a guest link, …) | held through `ctx.held.create` | the pillar, against `work/outbox/outbox.ts` |
| change of its own idea to a file others can open (a Word document, a PowerPoint deck, a Google Doc or deck) | held as `office.edit` or `google.edit`; nothing of it reaches the file, its sync folder, its co-authors or Google before his press, which writes it as a plain edit. No grant covers it and Away releases none. Cells wait as suggestions in the grid. Below: "An agent's suggestion stays his" | `office/tools.ts`, `google/tools.ts` |
| change to a file others can open, through the `files_*` tools (make, rename, move, copy in a Teams or OneDrive place, here or on another host of his) | held as `file.act`: one sentence with every fact, bound to each file's key and version, the destination and the audience; the press checks them again on the file's own host and runs his window's verb there, or reads `stale` and does nothing. No edit, no grant, no earned offer | `work/files/tools.ts`, [work-files.md](work-files.md) "Agents" |
| Microsoft form made, collected, widened or reopened (`msform_create`, `msform_publish`, `msform_settings`, `msform_close`) | held as `msform.make` or `msform.publish`; no matcher, so no grant, no earned offer, and Away releases none. The press reads the form fresh and is stale when it moved; Collect responses reads the link and sends nothing. A change to a collecting form waits for his Accept in the form's own stepper. The carrier is the only hand on Forms | `work/msforms/`, [work-msforms.md](work-msforms.md) "The hold" |
| `addon_add` | a card for a person with an admin key; never allowed by Away, never by a model | `shared/away.ts`, `sessions.ts` |
| `addon_remove` | a card over a row a person wrote (none over a thread's own), never allowed by Away; it reaches only rows the thread can see. Nothing leaves by it | `addons/tools.ts` |
| `outbox_request` (asks him to press for held items he named) | performs nothing: stores one request and answers "Asked"; only his press on the card releases any item, each as he saw it. Below: "A thread asks for his press" | `work/outbox/requests.ts`, `shared/work/outboxAsk.ts` |
| shell | **not caught.** The owner accepted this; the Work preamble is the rule there | |

A code thread is outside all of it: its add-on calls, cards, Away and
computer use are what they were. The catch reads the thread's row
(`scope: 'work'`, or any thread above it), never the Work switch: with the
switch off a Work thread's call is still held, and only the `work.outbox.*`
methods are refused. On a host where Work's mount did not come up, a Work
thread's add-on call is refused (`WORK_CALL_UNGATED`) and its outward
computer act too (`HELD_UNAVAILABLE`): nothing runs on the strength of a
hold that is not there.

A held act never fails or stalls its turn. The tool answers `Held as item
12: <the act in his words>. It waits for the owner's press. …` as an
ordinary result, the turn goes on, and the row waits.

One wording for every pillar that holds (outbox/words.ts). The head above is
read by the desktop's ApprovalCard and the phone's `OutboxModel.heldOf`, so
it stays as it is. After it comes what has not happened, then one tail:
"This is a finished step, not a failure: tell the owner it waits in his
Outbox, do not look for another way to do it, and carry on."

- An act that sends, posts, shares or books (`heldReceipt`): "Nothing was
  sent." (`NOT_SENT`), or the pillar's own fact: "Nothing was posted."
  (`teams_reply`), "Nothing was shared." (`google_share`), "Nothing went to
  Frame.io.", "No link exists yet, and nothing was shared; …"
  (`guest_link`), "Nothing was published: there is no link to share yet, …"
  (`form_publish`). A grant he made that let it go at once is said instead.
- An agent's change to a file others can open, held here (`heldChange`):
  "Held as item N: a change to a file others can open. It waits for the
  owner's press. The file has not changed." with the pillar's fact ("Nothing
  went to Google.").
- An edit kept as suggestions in the file's own editor, not in the Outbox
  (`suggestedIn`): "Suggested in the document: changes to 2 sections. The
  file has not changed. Tell the owner it waits there for him to accept or
  reject." The sheet, deck, workbook and PDF say the same with their own
  word.

## The store

Three tables, made by the module's `ensure` (`work/outbox/store.ts`):

- `work_held_acts`: one row per act that waits or was decided. States:
  `held`, `live` (a computer act, tied to a live screen), `sending`, `sent`,
  `failed`, `discarded`, `stale`, `scheduled` (Send later). `rowid` is the number the thread is told.
  No row is ever deleted: the table is the log.
  A discard keeps his `reason` (500 characters at most) and every press
  where it was made (`via`: `outbox`, `today`, `phone`, `mail`,
  `scheduled`, or `request:<id>` for a thread's request he answered). A
  `stale` row waits on him until he puts it away (Discard, or Ask the
  thread again): then it stays `stale` with `dismissed_by`/`dismissed_at`
  and moves to Done. A database made before this has every stale row put
  away already, and a thread or workspace he removes puts its rows away
  with it (`dismissed_by = 'host'`).
- `work_grants`: standing grants, removed by a mark (`removed_at`).
- `work_outbox_tool_rules`: the rule he set per add-on tool.
- `work_held_edits`: the revision his own last edit left, by run key. An
  item whose words differ from what the thread first wrote
  (`work_held_first`, earned.ts) carries `changed: {at, by}`: `you` while
  his edit's revision stands, `thread` once anything moved it after;
  `work.outbox.get` adds `first`, the first words, for Show changes.

**One count.** What waits on him is one rule, `needsHim`
(src/shared/work/outboxCount.ts): held, live, failed, and stale until he
puts it away. A send under way and a mail he scheduled do not count. The
host's `waiting` (the rail's number and the push), Today's rows, the
digest's tells (`syncTells`) and the phone all read it, and one fixture
(`outboxCount.fixture.ts`) holds each to the same number; the phone's
`OutboxModel.needsHim` is held to the same ten items in Swift
(ios/TempCodeClient OutboxWaitingTests).

**What a press does.** Every item carries `effect`, one sentence of what
the fields drawn under it do not say: when it goes and who sees it ("Goes
as your mail after your undo time.", "Posts as you; everyone in the chat
sees it."), never the people or the place the fields already name; a
scheduled item's says "Goes at the time you set, as you.": a kind's own `ActKindDef.effect`, else
work/outbox/effects.ts, else "Carries this out as you." A change to a
file others can open says only "Changes a file others can open." to a
caller that cannot press, with no first words and no reason (`seenBy`).
A held LifeOS mail read by `get` also carries `replied` when its
conversation got a newer message from someone else after it was made.

**An act runs once.** A send claims its row with one `UPDATE` that names the
states it may leave (`held`, `live`, `failed`), so of any number of presses
(a double press, two clients, a press and a grant) one gets the row and the
others get the row as it stands and run nothing. The claim is written
before the act starts. A row that was `sending` when the host stopped is
never sent again by the host: at boot it reads `failed` with "may or may not
have gone" (`INTERRUPTED`) and waits on him. For a LifeOS mail the watcher
then asks LifeOS what became of it (queued or sent: `sent`; still a draft:
left `failed`). A `live` row at boot reads `stale`: its screen went with the
process.

`failed` waits on him as `held` does, and a new press is a new attempt,
unless nobody knows how the last send ended. A kind's `execute` that
throws `ActNotSent` (kinds.ts) says nothing went: a plain press may send it
again. Any other throw, and a send cut off by a stop, marks the row
`outcomeUnknown` (`outcome_unknown`): it may have gone, so `work.outbox.send`
refuses a plain press (`MAY_HAVE_GONE`) and takes it only with `again:
true`, which the Outbox offers as "Send again" beside "Check Sent first" in
place of Send. No group send or tick takes such a row. A LifeOS row is never
marked: LifeOS holds what became of it, and its kind reads that before it
sends again. On the phone the item's button already reads Send Again for any failed send; for one that may have gone the press carries `again: true` (`WorkHost.send`) and the line reads the desktop's words (`OutboxModel.checkFirst`, `failureLine`; milestone 47).

## An agent's suggestion stays his

The owner's ruling of 2026-11-23: "Make sure agent suggests mode doesn't
let any agent changes let anyone else on the team see them (synced edits)
until they are approved and the file is actually edited." An agent's own
idea on a file others can open is kept on his host and shown only to him.

- **Which files.** Every tool asks Files' `sharedOf` (files/policy.ts): a
  library, a cloud folder, another host, and by its spelling (`sharedKey`) a
  URL, a network share, a mounted disk, a folder named OneDrive on any host,
  each by its real path (a new file by its nearest folder). Office's
  `fileShared` adds a Teams folder he added and a name no open file answers
  to. A Google file is always shared. Files' own verbs hold a thread's change
  in a workspace kept in such a place, as in a library.
- **Where it waits.** A Word document's or a PowerPoint deck's words: a held
  `office.edit` (the file's key, the change, how many places held the words
  and a hash of the file's text then). A Google Doc's or deck's words: a held
  `google.edit` (the edits, a box's words before, the revision then). Cells
  in Excel or a Google Sheet: `work_sheets_suggestions`, as before. Word
  gets no tracked change, Google no suggestion and no copy, and no comment
  is made anywhere.
- **His press** makes it a plain edit through the tool that reaches the
  file: on the host that holds it, in a file still open there. It is written
  only while the words stand where they did: the same number of places, the
  same slides, and the same paragraphs or boxes holding them, each in the same
  place in the file (`placed`; a hold from before round 2 is judged by the
  words of those paragraphs alone, `spots`, and one from before that by the
  whole text, `base`). The carrier is handed what the press was shown
  (`WriteBound`, office/carrier.ts: the count and each holding paragraph or box
  by its place and its words, and for a deck the slide each is on, round 4),
  through every wrapper (`withAddin` included, as
  his Mac runs it). The Mac's scripts and the add-in read the file again in the
  same step that writes and write nothing on another count or another place
  (stale). The Windows helper receives the count and places and does not
  check them (native code, built in the guest): there the host's own fresh
  read just before the call is the last check. A short write is said in the
  result line and settles Sent, never offered again; the Mac counts a box as
  changed only once none of the words is left in it. Else stale
  with the reason ("the words stand in 2 places now, not the 1 this was
  suggested for"), nothing written. A Google write is bound to the revision
  just read.
- **No grant, no edit.** Neither kind has a matcher, so the Send menu offers
  no grant and `work.outbox.grant` refuses one; neither is in
  `EDITABLE_KINDS`. Send N on a workspace's group approves every one there;
  Discard refuses one, and nothing was ever in the file.
- **What still writes at once**: his words found in the thread (`because:
  "asked"` with the quote: the Office tools, `doc_write`, `doc_format`,
  `sheet_write` and `slides_edit` alike; a Google change always waits), and a
  file only he can open.
- **Where the other builds stand** (the audit is
  `.temp-code/plans/landed/F-private-suggestions.md`): an agent's `.tcdoc`
  branch is kept under this host's data (history/privateBranches.ts) and a
  `.tcsheet`'s suggestions in the service's side folder, never in the file;
  the slides kind holds a synced deck's agent edits as suggestions
  (slides/view.ts `sharedDeck`); a LifeOS bot's comment on a guest-shown
  document is refused (service/routes/internal.ts). Still open: a LifeOS
  document's agent branch and a LifeOS sheet's proposed cells are written to
  his own LifeOS deployment before his press
  (`.temp-code/plans/landed/COUNCIL-everything/held/r1-answers.md`).

### Who stands for his press on a shared file

One rule, `pressesFor` (files/policy.ts): his window on this host, or a key
he gave `approve`. A read or operate key, another host's call (a peer never
carries `approve`, work/peer.ts) and a thread do not. On a file others can
open, every way an agent's change is seen or taken asks it:

- History's `branches` and `decide` on a shared document (a guest-linked
  LifeOS document, a `.tcdoc` `madeFromShared` calls shared). A decide
  carries the branch's `editedAt` as the screen read it (the desktop's
  document and history canvases send it, and the phone): a branch an agent
  changed since is refused (`BRANCH_MOVED`, history/serviceRoutes.ts) rather
  than taken. On a shared document an Accept that sends none is refused
  (`NEEDS_REVISION`, round 3); a Reject needs none. A private branch's
  revision is later than its last at every update, two in one millisecond
  included (history/privateBranches.ts); a LifeOS document's is LifeOS's own
  (work-kit's ConvexVersionStore), which this host does not set. The check runs in the same turn of the document as the take
  (round 2): every write, format, restore, accept and reject on the service's
  history goes through one queue per document on the host
  (history/hostQueue.ts), so an agent's write asked before his Accept lands
  first and is seen.
- Docs: the token is view-only for a key that is not his press, and
  `work.docs.thread` and `work.docs.rename` are refused there.
- Google: `work.google.write`, the mirror sent to Google.
- Sheets: `work.sheets.review`, `edit` and the view's waiting suggestions
  (`approves`, `reviews`), another host's call included.
- Slides: `work.slides.review` and the proposed deck's picture
  (`which: 'proposed'`) on a shared deck.
- Office: `work.office.write`'s `asked` counts from a key only where it may
  approve; from an operate key the change is held here (no thread). Another
  host's `asked` is what its own thread's words said there, judged there.
- The Outbox: `work.outbox.list` and `get` give a caller that is not his
  press an `office.edit` or `google.edit` item as `a change to a file others
  can open`, with no payload, and a `file.act` the same with its payload less
  the name it would give; for all three the error is a plain line
  (`PRIVATE_ERROR`), since a stale reason can quote the words. Its notice (held
  or failed), and so its digest row and a webhook's line, says the same, with
  the item's link and no detail: no file name, no words
  (`PRIVATE_CHANGE_KINDS`, outbox/words.ts). Files Home's Waiting on you names
  a held act's proposed name only to his press (files/waiting.ts). A
  `file.act`'s card to such a caller carries its display alone (no refs,
  digest, operation id or versions).
- The thread (round 3): the tool that holds such a change answers its thread
  with the item's number and the plain line (`heldChange`), and the Outbox's
  lines to the thread when it ends (sent, failed, discarded, stale) name it
  the same way, with no reason that could quote its words: the thread's
  transcript is read by any key that may read the thread. The thread made
  the change and knows what it proposed. Still open, for the owner: the
  transcript also holds the thread's own tool call, its arguments with the
  proposed words, and the agent's prose, which every key with `read` on the
  thread is sent (wire.ts `projectRow`, one projection for every remote
  socket); hiding them from a key that may not approve is the shell's.

## Add-on tools: the rule he sets

A server's hints (`readOnlyHint` and the rest) are its own word. They are
kept beside the tool cache (`addon_tool_cache.hints`, `AddonStore.toolHints`)
and shown on the card; they decide nothing.

- Each tool has a rule: **Runs**, **Held** or **Off**. No rule is Held. So
  until he answers the card, every tool of an add-on is held, one its
  server calls read-only included.
- A rule is bound to the add-on's spec digest and to a digest of the tool
  as it was listed (description and input schema). Point the add-on at
  another server, or let the server redefine the tool, and the rule no
  longer stands (`rules.ts` `stands`); the card says `changed`. A tool that
  appears later starts Held. A tool the server stops listing keeps a Held or
  Off rule, never Runs: its calls are held, and a watch's refused.
- The card is data: `work.outbox.rules` answers each add-on a Work thread
  can reach with its tools, their hints, the class the hints suggest
  (`suggestedRule`: Runs only for read-only and neither destructive nor
  open-world) and the standing rule. `work.outbox.setRules` (admin) sets
  them; `work.outbox.setForWork` (admin) marks a global add-on for Work.
- A pillar's `outward(addon, tool, args)` may hold or refuse what he let
  run. It can never run what he holds.
- The host's own call with no thread behind it (a watch) runs a Work
  add-on's tool only when its rule is Runs. A call made for Work (`work:
  true`) on an add-on no Work thread reaches now (a global one no longer
  For Work) is refused: no rule of his stands outside Work.
- In a Work thread the bridge's `addon_call` asks its card only in `safe`
  and only for a call that will run: a held call asks no card first.

Both lanes pass the gate: Claude's exposed tools (`addons/exposure.ts`) and
the bridge's `addon_call` for Codex and Muse (`addons/tools.ts`) hand
`sessionId` and `work` to `AddonHost.call`. The one door past the gate
(`setGate(...).ungated`) is held by the outbox alone, for the call he
pressed Send on.

## The LifeOS add-on

The row the host makes for LifeOS (`role: 'lifeos'`) is never held: its key
is draft-only, so LifeOS refuses a send and holds drafts itself. It is
trusted only while it is both marked and pointed at LifeOS's MCP address
(`isLifeosRow`). Three guards keep it there:

- `AddonStore.set` refuses a write that would point a marked row at any
  other spec (`LIFEOS_ROW_REFUSAL`), whoever writes; the sync's `put` takes
  the home's row and drops the mark.
- `addon_add` and `addon_remove` refuse it before any card, for every
  thread.
- A marked row whose spec is not LifeOS's is held like any other add-on.

Every thread's call to it gets the host's own `origin` (`{app, threadId,
host, workspaceId?, routineRunId?}`, the thread at the top of the tree) on
the draft tools and on any tool whose input lists `origin`; an `origin` the
model supplied never survives.

## LifeOS-held mail and calendar acts

A draft lives in LifeOS's `outbox`, not here. `lifeosHeld.ts` owns what the
host does with it:

- **The watcher**: one owner subscription to `outboxHeld:held({host})` while
  Work is on. `work.outbox.list` merges those items with the host's rows;
  no client reads LifeOS for the Outbox.
- **The press**: `work.outbox.send({ref, rev})`. `rev` is the item's
  `updatedAt` as the screen read it and is required: an agent may rewrite
  its own draft, so a press on a stale view is refused (`CHANGED_SINCE`).
  The host then calls `compose:send` with the message it read (`cause:
  'press'` or `'grant'`), or `compose:retry` for a failed send. The item
  gets a row here when it is decided; that row's run key
  (`lifeos:outbox:<id>`) is unique, which makes the decision the only one.
- **What goes is the row he was shown, to the edit.** A held mail's payload
  carries LifeOS's `editedAt` as read with the item; the press refuses a row
  whose edit time has moved and names that time to `compose:send` and
  `compose:retry`, which compare it again inside the write.
- **Sent, and what LifeOS says of it.** The host stores the row `sent` once
  LifeOS took the act (mail's composer checks LifeOS has the row queued,
  sending or sent, `NOT_QUEUED` otherwise), as it always has: no state,
  claim or press changed. LifeOS then holds a mail for his undo time and a
  calendar act until the calendar takes it, so the screens say so.
  `confirmed.ts` reads LifeOS's own row (`compose:get`, `calendarOps:get`)
  and never calls a send, `execute`, a claim, a settle or a tell. It keeps
  what it read in `work_outbox_lifeos_reads`, per row and per attempt (the
  row's `attempts`, one more for each claim): a fact read for an earlier
  attempt is not shown and is written over, and an answer that comes back
  for an attempt that is no longer the row's is dropped. A pass asks rows
  stored `sent` within a day, since this host first asked (the table's
  `~since` row), and not confirmed for their attempt, leaving out any whose
  read is still out; those never read come first, newest first, then the
  least lately read. A pass asks at most 20, with at most 100 reads out at
  once; each read counts only inside its 10 s deadline, and every outcome
  (a word, an error, an unknown status, a timeout) marks the row read, so
  the order moves on. A row whose read never comes back is not asked again
  until it does. One pass runs at a time; a call during a pass asks for one
  more pass after it, no more. Passes run right after a row is stored sent,
  when the watch lists a sent row again, then every 5 s while one is under
  two minutes old and every 30 s after. Work going off makes any answer
  still out write nothing. The wire item carries `lifeos`: `confirmed`
  (LifeOS's row reads sent, a calendar act's done), `drafts`, `gone`, and
  `queued` for anything short of LifeOS's word (no answer yet, past the
  day's asking, a table that cannot be read). A row decided before this
  host first asked carries none and reads as it always did. If LifeOS's own
  lane fails it, the watch turns the row `failed` (`failSent`) as before:
  it waits in his Outbox with LifeOS's reason, and the thread hears nothing
  of it.
- **What the thread is told.** For `mail.send` and `calendar.op` the tell
  at the press is `queuedNote` (words.ts), fixed words and no promise:
  "The owner queued held item N (…) in LifeOS: it goes after his undo time
  unless he takes it back. It is his now; do not send, draft or schedule it
  again." (a calendar act: "it is made once the calendar takes it"; a
  grant's: "A standing grant of the owner's queued …"). The linked task
  completes at the same moment as before, with "Queued to send: …" in
  place of "Sent: …".
- **A press from Mail's composer** on a held draft has already waited out
  the undo time in the window (work-mail.md "Undo for a held draft"): that
  one call carries `waited`, and only then does the hold ask LifeOS to send
  at once (`immediate`, which LifeOS takes only with `cause: 'press'`). A
  press here on the Outbox page, a grant's send and the phone's keep
  LifeOS's own queue and its Undo.
- `calendar.op` goes through LifeOS's `calendarOps` the same way
  ([work-agenda.md](work-agenda.md)); a LifeOS deployment without them
  answers `not built … (milestone 24)`.
The act's own result, which a thread's Results list keeps, says the same: "Queued to send to Dana Lee: Budget" for a mail and "Queued in LifeOS: Add Walk the ballroom" for a calendar change (`mailSendKind.execute`, `calendarOpKind.execute`), never "Sent to" or "Added" at the press.

## A thread asks for his press

**The invariant.** A held item leaves only on a fresh press of his, unless a
grant he made or a schedule he set covers that exact act; a thread's
request supplies neither. "His press" is his window on this host (the local
socket) or a client key that holds `approve` (`mustBePerson`). The trust
boundary: a thread's shell runs as the same user as the server and can reach
the local socket, as it can for every held act (the "shell: not caught" row
above). Every other path is closed: no tool names `decide` or `decline`, Away
answers questions and permission cards and a request is neither, a far
parent's `thread.answer` answers cards and questions only, and the box
browser and computer use refuse TempCode's own pages.

**The tools** (the outbox module's own `tools`, in every Work thread, on the
one mount: Claude in-process, Codex and Muse through `app.workTools`; a mail
chat is refused both): `outbox_list({scope?})` lists the waiting items the
thread may name, each with a ref (`#N` for a host row, `mail:<id>` or
`calendar:<id>` for a LifeOS draft): its own tree's by default, the same
job's other threads' with `scope: 'workspace'` (a Work Chat sees its own
tree alone), never another job's; another thread's private change reads "a
change to a file others can open". `outbox_request({items: [{ref, do,
at?}], quote})` asks; it answers "Asked: request R lists N items (…). It
waits for the owner's press on the card; nothing has been sent." with
`structuredContent: {outboxRequest: {id, host}}` alone, and the card loads
the request from its host.

**When it is refused** (`judgeAsk`, shared/work/outboxAsk.ts, table-tested;
each refusal is words an agent can act on):
- **His words.** The quote must lie inside one sentence of one of his three
  newest messages in this thread (`ctx.threads.ownerRecent`: `user-text`
  rows whose author is his, `writtenByOwner`; no ancestor, no row without an
  author, no app or thread text), each at most a day old by the server's
  time. Every chip Ask put in a message is taken out first (`ownWords`, by
  every kind in `CHIP_NOUN`); a held chip counts only as the item it points
  at. A queued message whose words someone else rewrote (`queue.update`)
  is that caller's from then on.
- **A command.** Not a question (a polite "can you …?" is a command), not
  negated ("don't", "never", "not"), not inside quotation marks, no "if",
  "unless", "once", "after", "when" or "until". A clause under twelve
  characters tells only when it names its item ("send #12").
- **The verb.** Each action needs its verb in the sentence: send, approve,
  release, go ahead (any kind); post, reply, forward, accept, decline,
  invite, share, publish, submit, make (the kinds each can mean); discard,
  drop, delete, scrap, cancel for a discard; a later send also needs a day
  (today, tonight, tomorrow, a weekday) and a clock time with its half of
  the day, read in his zone (`hisZone`) from the message's time, and `at`
  must be that moment.
- **Names, groups and counts.** An item is named by `#N`, its ref, a held
  chip, or (its own tree's only) a full name, address, channel, file or
  title that matches exactly one item. "All", "every", "everything", "both",
  "them", "those", "these", "the rest" cover the asking tree's whole waiting
  set for that action as it stood at his message: the request must list all
  of it, and an item held after his words is out. A count in the sentence
  must equal the number listed; two counts are unclear. A number inside a
  name is no count.
- **Eligibility.** Each item waits on him (`needsHim`); a live act, a
  computer act and a LifeOS reply that quotes its mail go only from their
  own page; an item out of date may only be discarded; a later send only for
  a kind in `LATER`.
- **What he named, then.** An item held after his message is never his,
  however it is named; an "all" when some of the tree's items were decided
  since his words is no exact set; a time in his words makes the ask a later
  send, never a send now; "accept" and "decline" name only an invite whose
  own answer is that one; a quote that takes in a quotation mark is
  refused; one clock time, which must exist once in his zone (not skipped
  or repeated at a clock change). A chip's lines run to the blank line
  before his words, so a label that ran onto a second line is the chip's,
  and the composer writes every label on one line.
- **The act is the command he leads with**: "discard the draft titled Send
  #12" asks for a discard, never a send. A 24-hour clock is a time too; two
  days named are no day; "both" means exactly two; a fenced code block is
  never his words; "all" is refused when any of the tree's items changed
  after he wrote.
- **A command.** His sentence must begin with the command, after the words
  people put before one ("ok, please send …", "can you post …"): a sentence
  that only mentions a send tells nobody. Any time words at all (a day, a
  part of a day, a clock) make it a later send, never a send now, even when
  they read as no one moment. "One" is a count. A quoted block (`>`) is
  someone else's words, never his command. Noon beside another clock time
  is no time.
- **What a thread learns.** `outbox_list` shows only what waits on him
  (`needsHim`), from the job's whole set (never a cut list: past 1,000 the
  host refuses rather than judge part); another job's ref is refused in
  the same words as one that does not exist; the thread's note after his
  press names fixed reasons, never a provider's own error. A request whose
  thread was archived or moved to another job, or whose item moved, ends
  and sends nothing.
- **One request a message.** One message of his gives one request per
  thread: the same ask again answers the one it made, and once he answered
  or chose Not now only new words of his give another. A newer request voids
  the thread's open one.

**The request** (`work_outbox_requests`, requests.ts): its thread and tree
root, job and sector, his quote, the source message's seq and the clause's
digest, the items with the revision each had when asked, the receipts
issued, a generation, its state (`open`, `answered`, `declined`, `void`),
and an end a day after his message. Methods, each behind the person gate
with `approve`: `work.outbox.requests`, `request.get` (each row's item now
and, for a row unchanged since the ask and still waiting, a receipt),
`request.view` (he opened a changed row: a fresh receipt at what he sees,
which he then ticks himself), `decide({request, receipts})` and `decline`.
The push `work.outbox.request` goes to approve keys alone.

**Where it stands** is checked when the request is stored (after any
fresh read), before the claim, and again inside each item's own lock just
before that item's claim (`decide`'s `admit`, on the row here and on
LifeOS's fresh copy alike): the thread still here,
unarchived and in the request's job, and each item's own thread too. What
became of each item is kept as it settles, so a press cut off keeps what
it reached, and an item it never reached reads "not started". At start the
host tells each open request again in the notice's words of now (from the
stored rows, judging nothing decided before LifeOS's list arrives), and
takes every closed request's notice out of the ledger, so no row from
before keeps a quote.

**Known gaps**, each listed by the hold's review and left by choice: the
host reads his words from the flattened message, so a plain line shaped
like a held chip can name an item (it never makes a command); LifeOS's
`compose:discard` takes an id alone, so its delete is not bound to
LifeOS's revision; a press cut off before its first result reads every
chosen row as not started; a Work Chat's reach is capped before its tree
is chosen; a host that stops between a thread's deletion and its cancel and
stays down past the mail's time cannot stop LifeOS's own timer (the drain
takes it back if the host is up first; it runs from boot, Work on or off,
and asks LifeOS again once Work is on: with Work off the host holds no
LifeOS session, so a removed thread's mail he scheduled can go at his time
while Work stays off, the schedule he set being what lets it go); a LifeOS draft
deleted in LifeOS itself after his words leaves no trace here, so "all"
cannot see it was once in the set; Mail's own scheduled controls
(work-kit's) name no revision, so Send now, Move and Cancel from an older
Mail window act on the schedule as it stands.

Each round of the hold's review also closed: a later send refused on a
LifeOS draft whose thread is gone; every unmarked LifeOS schedule checked
by the drain, with no cap; relative times ("in an hour", "soon") as later
sends; a 24-hour clock beside a 12-hour one, or a half-hour clock change,
as no time; a tilde fence as pasted text; an "all" refused when one of the
tree's LifeOS drafts changed after his words; a request never voided
before LifeOS's list arrived; and the digest never reading a request's
detail out of its ledger. Forms' Publish names the form revision its canvas
drew (`work.forms.publish {rev}`), refused when a thread changed it since.

**His Send.** One check of the whole press (open, not run out, the
generation, every receipt this request's and none twice, each the action
and time asked), then one `UPDATE` claims it as `answered` and keeps the
receipts; a second press, device or tab gets the request as it stands and
runs nothing. Each ticked item then runs through `decide` as an Outbox press
would: its own claim at the receipt's revision (a change after the card drew
it fails that row), its kind's checks, LifeOS's undo time, never `again`.
Nothing unlisted can be named, and he may untick, never widen. A request's
press is many: it earns no offered grant. `via` reads `request:<id>`.

**What the thread hears.** One note, in place of the per-item notes for its
own tree's items (a kind that wakes its thread still does): "The owner
approved request R: sent 2, queued 1 in LifeOS (they go after his undo
time), 1 not sent (…), 1 left out. Do not send any of them another way."
Not now: "The owner chose Not now on request R. The items still wait in his
Outbox. Do not ask again unless he asks." Void (its day ran out, every item
was decided elsewhere): "Request R ran out; the items still wait in his
Outbox." A removed thread's requests end with it, unsaid.

**How he hears.** `ctx.tell` as `outbox.request` (group `held`), "Asked:
Post 3 messages", the window's own name for it (`summaryHead`,
shared/work/outboxHead.ts) in its generic form: counts and kinds, never a
tool's or an add-on's own words or his quote, since a digest read needs only
`read`. A later send is named as its own act ("… later", Schedule N), key `request:<id>`, opening the
thread where the card is; it interrupts (he asked for it and waits on it),
and is done when the request is answered, declined or void.

**Who cannot answer it**, each held by a test (requests.test.ts,
outbox.test.ts): a thread (no tool names `decide` or `decline`, and a
`model` caller is refused whatever it carries), a routine (it runs as a
thread), a guest or read key, a key made for an MCP client and another host
over the link (`mustBePerson`), a far parent (`thread.answer` answers cards
and questions only; a request is neither), Away by any kind and its flips
(a request never enters the card stream), and computer use or a browser an
agent drives (the fences: the box browser refuses TempCode's own origins at
network dispatch, and the computer tools refuse a browser on one).

**What this cannot catch.** A thread's shell runs as the same user as the
server and can reach the local socket, as it can for every held act; a
press there is a press. The word rules are a heuristic: they can refuse a
fair ask ("yes, do it") or let a thread list more than he meant, and both
are safe, since a refusal tells the thread to ask him in words and an
over-wide list is still only a card he reads and ticks. A browser the
computer service cannot recognize, or one at an address this host does not
know as its own (a new tunnel name before the host learns it), is outside
the fences.

## The press, grants, and who may decide

| Method | Needs | |
|---|---|---|
| `work.outbox.list`, `get`, `grants`, `rules` | read | `get` adds a computer act's picture |
| `work.outbox.send`, `discard` (with `rev`), `edit`, `askAgain`, `decide`, `cancelSend`, `sendNow`, `undoSend` | approve | `discard` takes his `reason`; `askAgain` puts an out-of-date item away and wakes its thread to draft it again |
| `work.outbox.grant`, `ungrant`, `setRules`, `setForWork` | admin | |

A window whose key may not make grants on that host (`linkMay`, docs/agents/work.md
"The switch") is offered none: no Send menu's grant, no offer under a sent
item, no Remove in Grants. Approve and Send stay.

The socket's gate checks the capability; the module checks again with one
gate, `mustBePerson` (work/outbox/person.ts), in front of every Outbox
press and Mail's held-draft verbs (send, reschedule, cancel, send now): his
window on this host, or a client key (`audience: 'client'`, carried
through Work dispatch as `Caller.audience`) that holds the capability.
Refused whatever it carries: a thread's own call (`kind: 'model'`),
another host of his over the link (`peer`), and a key made for an MCP
client. No tool of any thread reaches these methods.

**One press, many items.** `work.outbox.decide({items: [{ref, do, rev,
reason?, again?}], via?, many?})` is the one decision service (`many`: a
desktop press across hosts, so each host's part is many even with one
item): each item runs
through the same `send` or `discard` a single press does, four at a time,
and answers its own result (`{ref, ok, item?, error?}`) in the order
asked. The host decides whether the press is many (more than one item):
many earns no offered grant and breaks a run. An item out of date is
Discard or Ask again only ("This went out of date: discard it, or ask the
thread again."); a live screen's act, a computer act and a LifeOS reply
that quotes the mail it answers go only from their own page, alone ("Open
to send"). One item named twice in a press is refused the second time. A
desktop press across hosts sends one `decide` to each host. A LifeOS
reply's quote is read fresh at the press (the list's copy lacks it), and a
LifeOS discard claims the row here before LifeOS deletes its draft.

**A LifeOS mail read whole.** Its detail reads the item again
(`work.outbox.get`, with the quote) before Send may go. A read the host's
LifeOS session failed says that cause by the down rule with the item's host
named, in the detail's notes (`useMailUnread`, outbox/MailUnread.tsx): the
red note with Retry (the read again) for silence, else a muted note with Sign
in, Show the code or Open Settings where this window may, else who can; "The
mail did not load" with Retry for any other cause, the cause the host's live status's over the read's
(`useLiveDown`), so a sign-in begun elsewhere is Show the code at once. LifeOS still connecting keeps the quote's bone. A fresh status of
that host that says connected reads it again with no press.

**Send later.** Send's menu offers a time on an item whose kind may wait
(`OutboxItem.later`; the kinds in `LATER`, outbox.ts: a LifeOS mail,
`office.mail.send`, `teams.post`, `chat.reply`; only a kind that checks
itself again when it runs is there). `decide` with `do: 'later'` (a minute
to a year ahead) moves the row to `scheduled` (`schedule_at`,
`schedule_zone`, `schedule_by`, a `schedule_gen` each change moves on) at
the revision he saw; it lists in Waiting's Scheduled section and is not
counted. A scheduled send earns no offered grant.
- **The host's timer** (one `setTimeout` for the next time due, while Work
  is on) runs each due row on its own claim, `claimScheduled(id, gen)`, so a
  Cancel send or another time in between wins. At its time it checks again:
  the kind's deadline (`by`), the thread's workspace still there, then the
  kind's own fresh checks in `execute`. `via` reads `scheduled`.
- **Never late.** A time more than 15 minutes past when the host comes up
  (`recover`) or when the timer wakes goes back to held with "Missed its
  time while the host was off" (`MISSED`).
- **A LifeOS mail** has one timer, LifeOS's: the host stores the time on
  the row first, then calls `compose:send` with `sendAt`, `sendZone` and
  `cancelIfReply` as his press; a refusal puts the row back to held with
  why. The watcher reads what LifeOS's timer did (`settleScheduled`,
  lifeosHeld.ts): listed with its time, it waits; listed as a draft or a
  failed send, it is held again; gone from the list and queued, sending or
  sent in LifeOS, it went, and the thread hears and the linked task
  completes once.
- **Cancel send** (`work.outbox.cancelSend`) returns it to held; a LifeOS
  mail only after LifeOS's `compose:cancel` says it took it back
  ("It is already on its way" otherwise). **Send now**
  (`work.outbox.sendNow`) runs it at once on its own claim (a LifeOS mail:
  `compose:sendNow`). Both take the `rev` his screen drew, so a press from
  an older view never takes a time set again since. Mail's own cancel,
  move and Send now of a thread's draft go through the same row, under the
  item's own lock. Removing a thread or workspace settles its schedules: a
  host timer's at once; every LifeOS mail of theirs is marked
  `cancel_wanted` in one statement before LifeOS is asked anything
  (`markCancelFor`), each is taken back from LifeOS under its own lock and
  only then put away, and one LifeOS cannot reach stays scheduled and
  marked: the drain asks again every minute while Work is on
  (`drainCancels`), whatever LifeOS's watch says, least lately asked
  first. The drain also marks any scheduled LifeOS mail whose thread or
  workspace is gone but was never marked (a stop between the removal and
  its hook).
- **What LifeOS's timer did** is read under the item's own lock, fresh,
  and every write names the generation read then: a Send later, a move or a
  Cancel send under way finishes first, a listing read before his Send
  later never puts the row back, an answer lost on the way leaves the row
  scheduled when LifeOS took the time, and the thread hears "went at the
  time the owner set" once LifeOS says `sent`.
- **Work off** ends the rest of a due batch: each wake belongs to one Work
  period, and an item is claimed only while that period lasts.
- **Undo** (`work.outbox.undoSend`, the press's toast): a LifeOS mail
  LifeOS still holds in its undo time goes back to a draft through
  `compose:cancel`, the row is held again, and the thread hears "The owner
  took back held item N … before it went." Once it went, Undo answers
  `{back: false}`. A kind with a way back keeps Results' undo; every other
  press has none.

**What he saw is what goes.** Every name is made canonical first: a host
ref to a row that records a LifeOS item is that item's LifeOS ref, so no
alias skips LifeOS's revision check. Presses on one item run one after
another (`serial`, one lock per run key), each from what the last left,
before any outside call; a press that waited finds the item as the first
left it and runs nothing. The revision he saw (`rev`, the item's
`updatedAt` as his screen read it) is part of the claim's own `UPDATE`
for a send and a discard, so a row that moved since is never taken on
that press (`CHANGED_SINCE`). The push (`work.outbox`: how many
wait, how many tools are unreviewed, the item that changed) goes only to
keys with approve.

A sent act completes the thread's linked LifeOS task
(`ctx.links.completeFor`, the thread at the top of the tree), once, and
keeps owing it while LifeOS is out of reach; a mail or calendar act's reason
reads "Queued to send: …", since LifeOS still holds it. A call held only because its
add-on was never reviewed completes nothing. The thread hears how its act
ended as the app's own note: an add-on call and a computer act wake it with
what came back; the rest are told quietly ahead of its next turn. A
discard says his reason when he gave one (never for a change to a file
others can open) and "from another device" for a press from a paired
device. Ask the thread again wakes the thread: "The owner asks you to redo
held item N (…): it went out of date because <why>. Draft it again from
what is true now."

**A grant** is made only from a held item (`work.outbox.grant({from,
matcher})`), and its matcher must fit that item. It fits later acts of the
same workspace and kind, made after it. A grant made from a routine's act
carries that routine and fits its runs alone; a routine's act fits no other
grant. A thread acts for the nearest routine run above it, by parent or
starter, so a run's subagent is the run (`routineRunOf`). A thread whose
line this host cannot follow to its end (a parent on another host, or more
than 32 links) acts for an unknown run (`ROUTINE_UNKNOWN`) and takes no
grant. For an add-on call the host seals the server's digest and the tool's
(its description and input as listed, `toolDigest`) into the call and the
matcher: a server that redefines the tool gets neither the grant nor the
press, and a matcher that names arguments fixes the rest: a call that
carries an argument the grant neither names nor leaves `free` (a `bcc`, a
second channel) does not fit it. A matcher with no arguments fits any call
of the tool. For mail, every recipient (copied and blind-copied too) must be a
person or an exact domain the grant names. A computer act takes no grant.
Away makes none, and no agent can.

**No grant sends a Microsoft form's link.** `notGrantable` (outbox.ts) also
answers true for any act whose payload's words hold a form's link people
answer at (`hasFormLink(payloadText(payload))`, src/shared/work/msforms.ts: a
Forms host's `ResponsePage.aspx?…id=` or a `forms.office.com/r/` short link,
in a mail's text or html, a chat reply, an add-on call's arguments, any
kind). So no standing grant on `mail.send`, `chat.reply` or any later kind
sends it, a grant asked for from one is refused
(`NO_GRANT_FROM_FORM_LINK`), and such a send earns no offer and breaks the
run it falls in: the link reaches people only on his press. The text is read as a
client would: HTML character references (named, decimal, hex) and percent-escapes
decoded, every address parsed and its host compared by `isFormsHost`; a payload
`payloadText` could not read whole (past 400 strings or 8 levels) counts as
holding one (`PAYLOAD_UNREAD`).

### Offered grants

He need not think of a grant: one he has earned is offered
(`work/outbox/earned.ts`). When his own press (`owner` or `owner:remote`,
never a grant's) has sent five held acts in a row (`EARN_AT`) that one
narrow matcher fits, each as the thread wrote it and all within 30 days
(`EARN_DAYS`), the host keeps one offer for that matcher, beside the item
whose press completed the run. The matcher is the one each act earns on its
own (`earnedOf`), so it is never wider than any of them:

| Kind | Earns | Earns nothing |
|---|---|---|
| `mail.send` | its account and its one recipient (named by address; the account, not one of its addresses, is what a mail grant binds) | two or more people (to, cc and bcc together); a domain is never offered |
| `calendar.op` | an answer (accept, decline, maybe) on one account and calendar; an invite of one person there | a change, a cancel, a proposal, a series, an uninvite, no account |
| `addon.call` | its server and tool (digests sealed as for any grant) with every argument fixed and none free | a call held without the digests, or held only because the add-on was never reviewed |

Every other kind (a computer act, a Teams post, a form, a guest link,
Office mail, a Google share, a file act) earns nothing. Why five in thirty days: one
press shows nothing; five unedited presses on the same narrow target is a
habit he has already decided on five times, and a month keeps an old habit
from counting.

- **As the thread wrote it.** The host keeps an act's words at first sight
  (`work_held_first`: a host row at `hold`, a LifeOS draft when the watcher
  first lists it), and a send counts only when what goes is those words:
  for mail the people, From, what it answers, its Gmail thread, subject,
  text, html (exactly), files; for a calendar act its event, route and
  fields (spacing aside in text); an add-on call's arguments exactly. A
  LifeOS draft with no edit time, edited more than 2 s after it was made by
  the time the host first saw it, or made more than 30 days before, never
  counts; nor does an agent's rewrite or one he took.
- **His press, alone.** A send of several by one press (a group's Send N,
  ticked rows: `send({many: true})`) is one gesture and counts for none.
- **What breaks a run.** Any decision aimed at the same target, by its words
  as sent or as first written (`targetOf`: an edit that moved a mail from
  Dana to Sam breaks both), that is not a clean press: an edited send, a
  discard, a send still going or failed (until a later press sends it), one
  of several. A grant's send is
  passed over. The history is the rows' own: their workspace and routine as
  held, so deleting or moving a thread changes nothing. A routine's acts
  count only toward that routine's offer, a run the host cannot place
  (`ROUTINE_UNKNOWN`) toward none, and a Work Chat's acts toward none.
- **Once.** An offer is kept per workspace, kind and matcher
  (`work_grant_offers`), whatever became of it: dismissed, taken, or closed
  by a grant he made by hand that fits its item. None is made while a
  standing grant already fits.
- **Only his press makes it.** `work.outbox.offers` (approve),
  `takeOffer` and `dismissOffer` (admin) refuse a thread's own call as the
  other methods do, and no tool names them. The screen never gets the
  matcher: `takeOffer({id})` runs the same `grant` from the offer's item
  with the matcher the host worked out, and every check of a grant made by
  hand applies. The thread is not told it earned anything, and Away presses
  nothing. An offer keeps its run, each send with the time of the press that
  sent it, and stands only while every one still reads sent from that press
  (one LifeOS failed later drops it, and a later retry does not bring it
  back; a fresh run makes a fresh offer in its place), its item is in the
  workspace it was held in and earned in, and no grant covers it. A grant
  like one that stands is that one (`grant` answers it), so taking an
  offer and asking by hand never make two; `takeOffer` makes the grant,
  then marks the offer.

## Computer use

In a Work thread the host classes each call from the screen, whatever the
model flagged (`readOutward`, `shared/computer/outward.ts`; the list of
names is data there). Held: a click, press or pick on a control named for an
outward act, or inside one; a click by position that lands on one; a press
with no target where the pointer was left; a menu path naming one; Return or
a typed line break in a chat's message box, in a composer, in a field beside
a submit, or in a sheet whose default may send; Command or Control with
Return where that sends; Space or Return on such a control; and any call the
model flagged. It also holds edits in a live co-authoring editor as
`Edit`, with the text or keys and the app or page host. The host reads
the window afresh, with frames, when a step lands by position, goes to the
focus, acts on an element by its number
(the number may name another control by now: a Next become a Send), clicks
where the pointer was left, clicks, types, pastes, sets a value, selects
text or presses a key by a name (the Mac finds the name on the live window),
or names an element its book lacks. A key or typed text by name is judged on every element the
name finds (a line break typed "into" a focusable Send is held), and one
whose name finds none, or several, is refused (`HELD_UNPLACED`).
If that read fails the call is refused (`HELD_UNREAD`): nothing is judged
against an old book or an empty screen. A call is kept only when every
step's target can be placed on the read (a click or key by name finds one element;
a click with no target has a known pointer); else it is refused
(`HELD_UNPLACED`), so a press never runs a bare index, point or name on
whatever took its place. A click with no target while the pointer is
unknown (no call put it anywhere, or a menu pick since) is refused so
before it is judged, held or not: the cursor may still sit on a Send.

A click by name is judged against every element the name may find, so an
icon inside a Send is held as the Send is. A held call is a `live` row with
the window's picture. On his press the host reads the window again, finds
each target by what it is (role, name and the names above it), and runs the
call only if every field's text, whole, who it goes to (every heading, and
the text beside each Send: a chat's header, a To line drawn as text), what
is ticked, switched or chosen (checkboxes, radios, switches, tabs, a pop-up's
option, the rows chosen in a listbox) and every target are what he was shown, and a click by name or with no target still finds, by
its name or under the pointer, the element it found then; else the row reads `stale` and nothing is sent.
A field the window's read prints cut (past 160 characters) is read again
whole by itself (`state.get` with `element`) at the hold and at the press,
and bound by its digest; a field that cannot be read whole refuses the hold
(`HELD_PARTIAL`) and makes the press stale. A restart, a deleted thread and a closed workspace make it stale.

**Edits other people can see live.** `coauthorRead` holds typing, paste,
setting a field's value, and keys or held keys that write, erase, format or
undo. These include printable keys, Return, Tab, Backspace, Delete, and
Command or Control with V, X, Z, Y, Enter, D, B, I or U, and a menu item
or button picked by path, name or element whose name starts Paste, Cut,
Undo, Redo, Delete, Clear or Replace (`picksEdit`). Looks, waits,
scrolls, pointer moves, clicks that place the caret or select, arrow keys,
Page Up and Page Down, Home and End, Copy, Find and Escape can run.
The host reads the browser's address afresh before an edit. The list
covers Google Docs, Sheets and Slides, SharePoint, OneDrive and the
Office web hosts (`COAUTHOR_HOSTS`), less the mail and chat pages that
share their domains (Outlook and Teams on the web: a draft there is no
shared file, and their sends are held above). Word, Excel and PowerPoint on Mac
and Windows all count, since the screen cannot tell which files other
people can open. Each edit waits for the owner's press, and no grant
covers it. For Office files, use the Office tools such as
`office_doc_edit`, which check sharing and hold shared changes.

**A page's own outward controls.** Some pages name an outward act with
words no verb carries. `PAGE_OUTWARD` (outward.ts) lists them by the page's
host and path, the control's role and name, and where it sits (inside a
menu or control by name, or with that one expanded on the screen; or in a
dialog by its words). Today it lists Microsoft Forms reached from pages that
stay open to agents: a SharePoint library's Create or upload → Forms
survey, the library's Forms → Create new form, Excel for the web's Insert →
Forms → New Form and Send Form, and Forms' results' Open results in Excel
with its dialog's Continue. A click on one (by element, position or name)
and Return or Space with the focus on it are held with the window's
picture, the read carrying its kind: `send` for Send Form, `access` for the
rest. Return or Space on one is read so before the co-author's edit rule,
since SharePoint and Excel are co-authoring pages. The verbs stay as they
were: Send Form on any other page is still a plain Send. Forms' own pages
are not driven at all: a Work thread's step there is refused
([computer-use.md](computer-use.md) "Microsoft Forms is not a page to drive").

**What this cannot catch**, in the same class as the shell: a click by
position on a control the screen reader gives no name (a canvas app, a
remote desktop, a picture of a button); a control named off the list; an
act split so that no single call reads as outward; a web address whose page
acts on being fetched. The editor rule needs a listed app or a readable
address on a listed host. It judges the page before the call, so a batch
that switches pages before an edit can escape the check. It checks the
listed key chords and input steps. A wrong match costs one press. On a
SharePoint or Excel page: an outward control named off `PAGE_OUTWARD` or
drawn with no name; a redesign that renames a listed control (the canary is
how we learn); and the shell, as everywhere.

**A command line in Windows** (the Windows VM, and a Work thread on any
Windows host). A Windows desktop has more ways to a command line than a
browser page. The first line is the VM's own image: setup turns on
DisableCMD, NoRun and a DisallowRun list for tcuser, refuses programs and
scripts in the user's folders by Software Restriction Policies, and pins
Windows Terminal as the console (docs/agents/work-winvm.md). The host's
rules here are the second line, on top of the rest:

- **Launch by name, from a short list.** In the VM (`RunHost.vm`, set by
  the VM's computer service) `computer_apps` launches only the apps Work
  needs, by a bare name or their file (`VM_LAUNCH_APPS`, policy.ts: Edge,
  Notepad, File Explorer, the Office apps, Teams, Calculator, Paint,
  Photos, the Snipping Tool, Acrobat); never a path, a link, a quote, an
  8.3 name or a trailing dot, since Windows opens whatever it is handed. A
  list of what may not be launched cannot be complete (MSBuild with a
  project file, ftp's `!`, a help file); the console list
  (`VM_REFUSED_LAUNCH_EXES`) still goes to the service as its own `refuse`.
  An item a launch opens may not be a file Windows runs (a script, a
  program, a shortcut, a help file, a registry file, an installer), by a
  path or a web address. The prompts' floor stands as everywhere.
- **The Windows key is his.** In the VM a key or a held key with it is
  refused (`refusedVmKey`): Win+R opens the Run box, Win+X the Terminal.
- **A console is always held.** Any step that writes or clicks in a
  console's window (`CONSOLE_EXES`, outward.ts `consoleRead`: Windows
  Terminal, OpenConsole, conhost, cmd, PowerShell, pwsh, the ISE, wsl,
  bash), one he opened or an app did, is held whatever it says, with what
  it would type on the card; a click counts, since a click in a classic
  console pastes the clipboard. The Run box (explorer.exe's window "Run")
  and Task Manager's "Create new task" are held the same way, told from
  the rest of their apps by the window's title in the read the call is
  judged on, always a fresh one for those two apps (an English image).
- **No grant from it.** Such a read says `grantable: false`; it rides in the
  held act's payload to the Outbox, which offers no grant on it and refuses
  one asked for (`notGrantable`, `NO_GRANT_FROM_CONSOLE`). Computer acts take
  no grant today in any case; this holds if that ever changes.

What these still cannot catch, and the image's policies must: a double
click on a script in Explorer or a file dialog; Explorer's address bar or
Start's search running what is typed there; a script inside an Office file
(a macro); a console hosted by conhost that reports as the program inside it
(Windows Terminal pinned as the console closes it); and a window title in
another language.

A box thread's act on a Mac's screen is judged on the Mac but cannot be
held there: the Mac answers `HELD_UNAVAILABLE` and nothing runs. The box
sends a Work thread's act only to a Mac that offers `computer-hold`. A
Work thread's `security`, `sudo` and the rest of the bridge's always-ask
list stay a prompt on the Mac under full access and under Away, and so does
its `osascript`, save one: Apple's (`/usr/bin/osascript` as argv[0]),
with `-e` text that names only apps in `WORK_LOCAL_SCRIPT_APPS` (Contacts,
TextEdit, Preview) as plain strings and nothing that reaches past them (a
shell, a URL, a network volume or a printer, a loaded script or framework,
raw events, the ObjC bridge, JXA's standard additions or `\u` spellings). That one runs as any full-access command
does (`workFloor`, `osaStaysLocal` in remote/macBridgeRules.ts). Mail,
Messages, Outlook, Calendar, the browsers, Finder and System Events are
not on the list, nor are Notes, Reminders, Photos, Pages, Numbers and
Keynote, whose plain edit reaches whoever shares the list, album or
document. It reads an honest script: the shell is not fenced
(work-scope.md "What the fence does not do").
Its text into a password field is denied on the Mac under Away as it
is here (`req.awayDenies` in `MacComputer.ask`, `AWAY_PASSWORD`).

## Away

`awayVerdict(ask, scope)` (`shared/away.ts`) replaces `awayAllowsKind`. A
code thread: as before. A Work thread: an outward or flagged computer act
is held; text into a password field is denied; `addon_add` and
`addon_remove` are denied; every other card is allowed. No verdict releases
a held act or makes a grant: neither is a card. The held notice
(`Notifier.held`) goes out whether or not he is away, with no approval a
lock screen could answer.

## Where a Work thread in full access still asks

A Work thread starts in full access on every path (`ctx.threads.start`
says `auto`; a composer start takes his defaults, `auto` on the box; a
subagent or a thread it starts takes its parent's mode). Files, the shell
and the box's own tools run without a card. A card, or a prompt on the Mac,
is the rule only for:

| What | Where | Under Away |
| --- | --- | --- |
| `security`, `sudo`, `su`, `doas`, `launchctl`, `defaults write` and kin, `rm -r` of `/` or home, a credential path, an `osascript` that is not local (`workFloor`) | the Mac bridge's prompt, for a box thread's `mac_run` and `mac_job_start` | still asks |
| a Mac read or write of keys and credentials (`macDenied`) | the Mac bridge's prompt | the Mac's Away allows it |
| text into a password field | the computer card | denied |
| `addon_add`, `addon_remove` | the card for an admin | denied |

What sends, posts, shares, books, submits or pays is not on this list: it
is held, which is no card (above). On 2026-11-20 the record of his Work
threads held five Mac prompts in two days, all a local `osascript` on
Contacts, and no card; that row is gone
(`.temp-code/plans/landed/F-work-asks.md`).

## A shared file: "asked" must be his words

`judgeWrite` (`shared/work/because.ts`): on an item other people can see, a
write marked `own` is a suggestion; `asked` writes only when the host finds
the quote in the owner's own messages (`ctx.threads.ownerSaid`); `routine`
only when a grant of that run's routine covers it. A pillar's write tool
calls it. No grant covers a write today, so a routine's run writes directly
only on what he alone sees, and suggests on a shared document or sheet. An
agent's comment on a shared document is refused: its other readers would
read it before he did. LifeOS's bot routes (`/internal/doc/*`,
`/internal/sheet/write`) take a bot's `asked` and `routine` as its own idea:
only main can check his words.

## Results

`ctx.results` (`work/outbox/results.ts`, the table `work_results`, made in
the outbox module's `ensure`) is what a Work thread changed that lasts,
with its way back. A pillar's write on his own files calls
`ctx.results.add({sessionId, kind, summary, account?, ref?, undo?})`, where
`undo` is `{pillar, verb, args, label?}`: a tool of that pillar (`verb` or
`<pillar>_<verb>`), run as the thread that wrote. A send that left makes a
row by itself (the outbox's `onDecided`), with its kind's `wayBack(result)`
as its undo and `ref: {held, open?}`; a mail has none ("Sent mail cannot be
taken back"). A row is listed under the root of its thread's tree
(`root_id`), so a subagent's writes are its root's.

| Method | Needs | |
|---|---|---|
| `work.outbox.results({sessionId?, since?, limit?})` | read | a thread's, or every one since a time (the return from Away), newest first |
| `work.outbox.undo({id})` | approve | runs the way back once: claimed by one `UPDATE` before the call; a call that fails gives the claim back; a thread is refused |

Both push `work.outbox.result` (to keys with read) when a row is made or
undone. The names sit under `work.outbox.*` because the router hands a
pillar only its own prefix.

## The screens

One lazy chunk, `work-outbox` (`src/renderer/src/work/outbox/`), nothing of
it in the first paint. `store.ts` keeps one list per host with Work on,
merged as the rail merges threads, from `work.outbox.list` (waiting and
done) and `work.outbox.grants`; the work-shell chunk imports it so the
rail's count follows the `work.outbox` push from boot. No screen reads
LifeOS's `outbox`; every press goes to the host that holds the item, and a
LifeOS item's Send carries `rev` = its `updatedAt` as shown.

- **The rail's Outbox row** (M8's) shows whenever a host has Work on, with
  the plain muted count; it opens the Outbox page (`shell.openOutbox`,
  `outboxViewOpen` in stores/shell.ts, a page like the Inbox).
- **The Outbox** (`OutboxView.tsx`, prototype A of plan XlwEfoGIGIKa) on
  the Inbox frame: Waiting and Done over the list, the item or the summary
  on the right. The order and the words are plain functions in
  `waiting.ts` (waiting.test.ts):
  - **Waiting's order** (`waitingSections`): Not sent (failed, oldest
    first), Starts soon (a calendar act whose event starts before the end
    of tomorrow, read as the host's `by` reads it: `startsAt`), then one
    group per thread (a routine's run is its own group) by the job's rail
    order and then the group's oldest item, then Scheduled (the sends he
    timed, soonest first, uncounted). A group's heading is the job's dot,
    the thread's title at 12px medium and the job's name muted (it gives
    way first); with no thread, the job's name alone. Select N shows on the
    heading's hover when more than one row may be ticked. A group over five
    rows shows four and "N more". An out-of-date item stays in its group.
  - **A row** is one 32px line (`Lists.tsx`): the kind's glyph (the red
    mark for a failed send, the working dot while sending), the act, what
    it is about muted (it gives way first, and hides under 640px), and one
    trailing word (`rowSide`): the event's start in the foreground (Starts
    soon), when it goes (Scheduled), "Out of date", "Sending", "Changed"
    (the thread rewrote it), else when it was held. Never amber.
  - **The detail** (`HeldDetail.tsx`, also Today's sheet): the facts line
    (the job's dot and name, "from <thread>" or "from the routine <name>"
    as a link that opens it, when it was held), the act as the title, the
    host's `effect` sentence at 14px, then the notes that apply, one line
    each with a 14px glyph (`ItemNotes`): "Not sent. <why>" (the red mark,
    a refused press the same way), "Out of date. <why>", "The thread
    rewrote this at 9:20 AM." with Show changes (`changed.first` from
    `get`; the fields that moved and the body's words out and in,
    `changesOf`), "<Name> wrote back at 8:12 AM, after this was made:
    "<line>"" (`replied`, from `get`), "Goes <time>" for a timed send, and
    a computer act's screen. Then the thing as it will arrive (the kind's
    view, "Kind views" below). Every item is read whole with `get`; only a
    LifeOS mail's Send waits on that read.
  - **The verb bar**: Discard at the start; Edit; the primary verb joined
    to a menu (`SendSplit`) with Send later (In an hour, This afternoon
    while the morning lasts, Tomorrow morning, Pick a time…; only when the
    item carries `later`) above the grant row ("Send and stop holding ›
    <grant>", only for a key that may make one). A failed item reads Send
    again; one that may have gone keeps "Check Sent first" and his own Send
    again. An out-of-date item's bar is Discard and Ask the thread again
    (`work.outbox.askAgain`). A scheduled item's is Cancel send and Send now
    (`cancelSend`, `sendNow`; a Mail-scheduled LifeOS mail from before the
    state takes `work.mail.cancel`).
  - **Edit** turns the fields and body into inputs where they stand, on the
    views' 72px label column; the bar reads Cancel and Save (⌘S). The host
    keeps the account, the server and the thread.
  - **Discard** opens a popover over its button with one optional field,
    "Why, for the thread" (≤ 500), and Discard; ⌘↩ in the field discards.
  - **After a press** the toast says what happened. A LifeOS mail LifeOS
    still holds carries Undo (`work.outbox.undoSend`: back in Waiting); a
    kind whose Result keeps a way back carries Undo (`resultOf`, Results'
    undo). Nothing else has one. The next row down takes the pick.
  - **Ticks** (click, X, Shift-click or Shift+X for a range, Select N)
    turn the detail into the summary list (`Ticked.tsx` over
    `SummaryList.tsx`): one head sentence of what goes (`summaryHead`:
    "Send 4 mails to 4 people, post 1 message and accept 1 invite"), a row
    per item with its tick, glyph, act, about and a chevron that opens it in
    place (sentence, notes and the thing, no border). A computer act, an
    act read from a live screen and a LifeOS reply that quotes its mail
    (read whole) say "Open to send" and stay out of Send N. The bar is
    Clear, Discard N (the same popover) and Send N joined to Send later
    (when every item may wait). The press is one `work.outbox.decide` per
    host (`decideMany`, `via: outbox`); each row shows the working mark,
    then a check and what happened ("Queued in LifeOS", "Posted"), or the
    red mark and the host's reason (a plain send's check alone); the head
    sums them as they are, "Sent 2, queued 3 in LifeOS, 1 not sent"
    (`resultsHead`), and Send N again takes the ones that failed and still
    stand at the revision their result showed (`Batch.revs`), with it; one
    whose words moved since, or that may have gone, opens in its own detail
    ("Open in the Outbox"), never a retry on the old result. M5's
    request card draws the same `SummaryList`.
  - **Done** (`DoneList`, `DoneDetail.tsx`): what went, what he discarded
    and what went out of date that he put away (`list({show: 'done'})`), by
    day, newest first; a row's trailing slot says "Discarded" or "Out of
    date" (at every width), its line "Queued in LifeOS for 12m" while LifeOS
    holds it. The head says who decided (`whoWords`): "by
    you", "from another device", "by the grant …", "from your approval in
    <thread>" (`via` `request:<id>`), "scheduled by you". A discard shows his
    words ("Discarded. You told the thread: "…""). The Result's way back,
    "Sent mail cannot be taken back", and the earned grant's line
    (`OfferLine.tsx`) as before; the toast that earned it opens the item
    in Done.
  - **Keys** (only while the page has focus, never in a field, menu,
    popover or dialog; through lib/keys.ts): ↑/↓ and J/K move the pick and
    the focus together (the focus alone while rows are ticked), X ticks,
    Shift+X ticks a range, E edits, D opens Discard, L opens Send later,
    ⌘↩ (Ctrl+Enter) presses the primary verb, Escape leaves an edit, then
    the ticks, then the page. The list is one tab stop (the row focused
    last, else the picked one). Key caps show only in tooltips (`Tip`).
    Nothing moves on a key.
  - **States**: the list's one-line bones and the detail's; "Nothing held"
    (no second line); "Not known yet" while a host did not answer, its row
    over the list with Retry; "No longer waiting" when another press
    decided the picked item; under 640px of page the list and the detail
    take turns, the detail's top row going back. Grants is a sheet, as
    before. A failure inside an answer is worded by `failWords.ts`.
- **Results** (`ResultsSection.tsx`) is a right-panel section of a Work
  root thread (`results` in lib/rightPanel.ts, the outbox glyph), listed
  only while it has a row: "Can undo" and "Can't undo", each row with its
  way back.
- **The held line** (`heldOf` and `HeldLine` in
  surfaces/transcript/ApprovalCard.tsx): under a call whose answer is "Held
  as item N: …", one muted line, the Outbox glyph, "Held" then the act; it
  opens the Outbox on that item (`wantOutbox({environmentId, n})` through
  lib/outboxWant.ts, the first paint's door, with the thread's host).
- **A thread's request** (`RequestCard.tsx`, `requests.ts`): the
  transcript draws an `outbox_request` call (`isOutboxRequestBlock`,
  surfaces/outboxRequestBlock.ts, the parse in the chunk) as the card from
  the Outbox's chunk, reading the request from the host its result names
  (`request.get`) and kept current by the `work.outbox.request` push. A row
  with a receipt starts ticked; a changed one starts unticked, "Changed
  since asked", and opening it asks `request.view` for a fresh receipt, then
  he ticks it. A tick is bound to the receipt it was given for (`absorbRows`):
  a copy that marks the row changed, or gives it another receipt or none,
  leaves it unticked; a row's first receipt, unchanged and open, starts
  ticked when it arrives, though the first copy drawn (a push, the list) had
  none, and the card asks `request.get` again while a copy lacks them. His
  press is `decide({request, receipts})` with the ticked rows' receipts alone
  (Send N, Discard N, Approve N when the actions mix); Not now is `decline`.
  Results land per row; then "by you at 9:41 AM" and, for rows that did not
  go: Send again (`decide` with `many` and the revision his press attempted,
  which the card keeps) for a Send; Pick a new time… (a dialog that says
  when it goes, then `decide` `later` with `many`) for a Later; and Open in
  the Outbox, never a retry here, for a row whose item stands at another
  revision than the press attempted (though its copies agree), whose press
  this card did not make, or that may have gone. Not now,
  void and a refused ask are one muted line. Never the warning colour
  (RequestCard.dom.test.tsx holds it). The Outbox lists open requests first,
  in **Asked in threads** (one row each, its items not again under their
  thread); its detail is the same body with the bar (Not now, the press,
  ⌘↩). An untouched page picks a request that comes to lead. A request has
  one name in his words on every surface (`requestName`: its rows by kind),
  the card's head included; the press counts what is ticked. A discard row
  leads with "Discard"; a changed row shows an empty, disabled tick. The
  card stands alone in the transcript (`standsAlone`), never under a "Used"
  line. While the Outbox is the page, held work's digest toasts step aside. Today's
  Waiting on you and the return from Away read `needsHim` and show an open
  request as one row that opens it in the Outbox (`wantOutboxItem('request:<host>:<id>')`),
  its items left out.
- **Back from Away** (`AwayList.tsx`, mounted by chrome/AwayReturn.tsx):
  while a host has Work on, Away turning off gathers each host's tally for
  three seconds, then reads each Work host's Outbox and its writes since
  that host's stretch began (`work.outbox.results {since}`, sends left
  out). One toast ("Held 7, decided 4 without you, 2 failed") that stays
  until pressed; Review opens one dialog in the order he must act: Held
  (by workspace, each with its verb, Send N per workspace), Failed (Send
  again), Decided without you (each thread and its count, Open), Written
  on your files (Undo). With Work off the return is what it was.

### How he is told (the digest)

The Outbox raises no notice of its own. What it has to say goes through
`ctx.tell` (work/outbox/tells.ts; docs/agents/work-digest.md), and the
digest's rule decides whether it interrupts:

- **A held item** is `outbox.held` (group `held`), "Held: Send to Dana Lee:
  Re: budget", key `held:<ref>`, opening the item. It waits for the day's
  digest unless its kind has a clock: `ActKindDef.by(payload)` answers the
  moment after which a press is too late, and only `calendar.op` and
  `office.calendar.op` answer (their event's start). An invite for an event
  that starts before the next digest interrupts; when a thread made the
  item, that notice goes out on the thread through `Notifier.held`, so the
  phone opens the Outbox item as it always did.
- **An item that went out of date** waits as a held one does: `outbox.held`,
  "Out of date: …", until he puts it away.
- **A send that failed** is `outbox.failed`, "Not sent: …" with the error
  as its second line, key `unsent:<ref>@<decidedAt>` (the press it
  failed on; a LifeOS item with no press here is `unsent:<ref>`), so a
  retry that fails again is a new failure he hears of; the earlier attempt's
  row goes before it is told, so the banner names the one item. Its clock is the
  press, or for a LifeOS item its last change, so it interrupts: he
  believes it went. One found a day old (a
  host that just came up) waits for the digest instead.
- **A grant he has earned** is `outbox.offer` (group `system`), "You could
  stop holding …", opening the sent item it sits beside. It waits.
- The ledger is kept in step 250 ms after any Outbox change (`syncTells`):
  every held item, failed send and offer is told as it stands (the ledger
  changes nothing for one it holds in the same words; a LifeOS draft first
  read at boot, or an invite edited to an earlier time, is told), and an
  item sent, discarded, stale or decided on another device is done
  (`ctx.tell.only`), so its row and its toast go. What LifeOS holds is
  pruned only once its watch has answered (`loadedTables`), and nothing is
  pruned from a read of 500, which may be cut short.

He can set held items louder or quieter in Settings → Work → Digest. The
Outbox count in the rail and the thread's own row say what they always did.

### On the phone (milestone 46)

The phone lists, opens, edits, sends and discards held items and reviews
the return from Away (docs/IOS-DESIGN.md "Work on the phone",
docs/agents/ios-client.md "Work on the phone"). It reads the same wire:
`work.outbox.list/get/send/discard/edit/grants/ungrant/rules/setRules/results/undo`,
the `work.outbox` and `work.outbox.result` pushes (both now in
`RemotePushSchema`). A relayed lane carries every Outbox method to the
host whose item it is on the link alone (an empty `OUTBOX_RELAY` means
"carried", which contract-relay.test.ts pins). A held act's notice carries
the item (`tc.held` in the APNs payload, `held` on `relay.notice`) and
keeps the Open category, through the hub as well once it is deployed
(infra/hub validates `held` as one of the two ref shapes). The phone's Send
waits five seconds with Undo before it reaches the host; nothing has gone
while it waits. The phone also makes a grant from a held item's Send menu
(`work.outbox.grant`, the desktop's `grantFor`), opens a thread's held call
in place, and shows a thread's Results with Undo.

Outbox 2 (M6) gave the phone the desktop's Waiting: the list in prototype
A's order (Asked in threads, Not sent, Starts soon, a band per thread by
job, Scheduled; `OutboxModel.waitingSections`, the port of waiting.ts),
the item's `effect` and notes, Discard with "Why, for the thread"
(`discard {reason, via: 'phone'}`), Send later for a kind marked `later`
(`decide {items: [{ref, do: 'later', at, zone, rev}], via: 'phone'}`),
Cancel send and Send now on a scheduled item, Ask the thread again on an
out-of-date one, and a thread's request as one sheet (`requests`,
`request.get`, `request.view`, `decide {request, receipts}`, `decline`, and
the `work.outbox.request` push into `WorkHost.requests`), opened from the
list, from its notice (the tell's key `request:<id>` in `tc.work.tell`,
`PushTarget.request`) and from the thread's card (the tool's
`{outboxRequest: {id, host}}`, `OutboxModel.requestOf`). Every phone Send,
Send later, Send now and a request's Send waits the phone's five seconds
with Undo before the host hears it. `undoSend` is in the phone's wire
(`WorkHost.undoSend`) but no screen offers it yet: the five seconds come
first.

## Kind views

Each kind's view is its own lazy chunk in its pillar's folder, named in that
pillar's `act.ts`, and draws the thing as it will arrive. Its words come from
`kindRows` (acts/kindRows.ts), so every rule there holds: words exactly as
they go, words that read alike quoted with their escapes, no ids, paths or raw
JSON. A payload a view cannot read takes the generic view, so nothing that
goes is hidden. The shared parts are in acts/ActParts.tsx and acts/ChangeView.tsx.

- `teams.post` (browser/TeamsPostActView.tsx): the post under a 12px line
  that names its chat, his name over its words.
- `chat.reply` (messages/ChatReplyAct.tsx): the same shape; the place line
  is the service and the conversation, and the message it answers is quoted
  over his name.
- `office.edit`, `google.edit` (office/EditActView.tsx,
  google/EditActView.tsx): the app and account, then one block per change,
  parted by hairlines: where, the words taken out muted and struck, the words
  that take their place.
- `share.google`, `form.publish`, `frameio.post` (google/ShareActView.tsx,
  forms/PublishActView.tsx, frameio/PostActView.tsx): their rows on the 72px
  label column, then any body under a hairline.
- `msform.make`, `msform.publish` (msforms/FormActView.tsx): the form in
  words as the host wrote it from what the press checks.

No held kind carries a sheet's cells yet; when one does, its view is a
Cell, Now, After table.

## Not built here

A view of its own for a portal's submit, an Outlook mail, a computer act and
an add-on call: they show in the generic view. A box thread's computer act
held on a Mac and pressed from the box. A held row moving with its thread
to another host: it stays on the host that held it. A card skipped for a
Claude thread's add-on call that will be held (in `safe` it asks, then
holds).

## Proofs

Offered grants: `work/outbox/earned.test.ts` (the reading, the count, and
the offer on the real hold: each way it must not appear or be taken).
Look: `bun run ui:preview src/renderer/src/work/outbox/Outbox.preview.tsx#OutboxPreview --props '{"state":"offer"}'` (also `plain`).

The screens: `work/outbox/{model.test.ts, OutboxView.dom.test.tsx,
screens.dom.test.tsx}`, `surfaces/transcript/ApprovalCard.dom.test.tsx`
("the held line"), `chrome/AwayReturn.dom.test.tsx`, `lib/rightPanel.test.ts`.
Results on the host: `work/outbox/results.test.ts`.

The hold:

`work/outbox/{store,outbox,lifeosHeld}.test.ts` (the rig in `rig.ts` runs
the real add-on host with a real child and the fake MCP server, and reads
what reached the server off the wire); `shared/computer/outward.test.ts`;
`computer/run.hold.test.ts`; `sessions-away.test.ts`;
`addons/tools.test.ts`; `addonStore.test.ts`; `remote/macBridge.test.ts`;
`computer/bridge.test.ts`; `shared/away.test.ts`;
`shared/work/because.test.ts`.
