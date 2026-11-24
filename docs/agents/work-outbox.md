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
| `addon_add` | a card for a person with an admin key; never allowed by Away, never by a model | `shared/away.ts`, `sessions.ts` |
| `addon_remove` | a card over a row a person wrote (none over a thread's own), never allowed by Away; it reaches only rows the thread can see. Nothing leaves by it | `addons/tools.ts` |
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

## The store

Three tables, made by the module's `ensure` (`work/outbox/store.ts`):

- `work_held_acts`: one row per act that waits or was decided. States:
  `held`, `live` (a computer act, tied to a live screen), `sending`, `sent`,
  `failed`, `discarded`, `stale`. `rowid` is the number the thread is told.
  No row is ever deleted: the table is the log.
- `work_grants`: standing grants, removed by a mark (`removed_at`).
- `work_outbox_tool_rules`: the rule he set per add-on tool.

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
  whole text, `base`). The carrier is told the count; the Mac's scripts read
  the file again in the same call and write nothing on another count (stale).
  The Windows helper and the add-in do not check it yet, so a match a
  co-author adds between the host's read and theirs is still replaced there.
  A short write is said in the result line and settles Sent, never offered
  again. Else stale
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
  document and history canvases send it): a branch an agent changed since
  is refused (`BRANCH_MOVED`, history/serviceRoutes.ts) rather than taken.
  A client that sends none (the phone, until its own build does) is not
  bound. The check runs in the same turn of the document as the take
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
  a held act's proposed name only to his press (files/waiting.ts).

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
- **Sent** means LifeOS took it: the host reports a mail sent only once
  LifeOS has the row queued, sending or sent (`NOT_QUEUED` otherwise, with
  words), so a draft an earlier send left behind is never called sent. If
  LifeOS's own lane then fails, the item comes back `failed`.
- **A press from Mail's composer** on a held draft has already waited out
  the undo time in the window (work-mail.md "Undo for a held draft"): that
  one call carries `waited`, and only then does the hold ask LifeOS to send
  at once (`immediate`, which LifeOS takes only with `cause: 'press'`). A
  press here on the Outbox page, a grant's send and the phone's keep
  LifeOS's own queue and its Undo.
- `calendar.op` goes through LifeOS's `calendarOps` the same way
  ([work-agenda.md](work-agenda.md)); a LifeOS deployment without them
  answers `not built … (milestone 24)`.

## The press, grants, and who may decide

| Method | Needs | |
|---|---|---|
| `work.outbox.list`, `get`, `grants`, `rules` | read | `get` adds a computer act's picture |
| `work.outbox.send`, `discard`, `edit` | approve | |
| `work.outbox.grant`, `ungrant`, `setRules`, `setForWork` | admin | |

The socket's gate checks the capability; the module checks again and
refuses a thread's own call (`kind: 'model'`) whatever it carries. No tool
of any thread reaches these methods. The push (`work.outbox`: how many
wait, how many tools are unreviewed, the item that changed) goes only to
keys with approve.

A sent act completes the thread's linked LifeOS task
(`ctx.links.completeFor`, the thread at the top of the tree), once, and
keeps owing it while LifeOS is out of reach. A call held only because its
add-on was never reviewed completes nothing. The thread hears how its act
ended as the app's own note: an add-on call and a computer act wake it with
what came back; the rest are told quietly ahead of its next turn.

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

**What this cannot catch**, in the same class as the shell: a click by
position on a control the screen reader gives no name (a canvas app, a
remote desktop, a picture of a button); a control named off the list; an
act split so that no single call reads as outward; a web address whose page
acts on being fetched. The editor rule needs a listed app or a readable
address on a listed host. It judges the page before the call, so a batch
that switches pages before an edit can escape the check. It checks the
listed key chords and input steps. A wrong match costs one press.

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
decided) and `work.outbox.grants`; the work-shell chunk imports it so the
rail's count follows the `work.outbox` push from boot. No screen reads
LifeOS's `outbox`; every press goes to the host that holds the item, and a
LifeOS item's Send carries `rev` = its `updatedAt` as shown.

- **The rail's Outbox row** (M8's) shows whenever a host has Work on, with
  the plain muted count; it opens the Outbox page (`shell.openOutbox`,
  `outboxViewOpen` in stores/shell.ts, a page like the Inbox).
- **The Outbox** (`OutboxView.tsx`) on the Inbox frame: Waiting and Sent
  tabs over the list; Waiting grouped by workspace (sector dot, name, and
  "Send N" when more than one can go), each row the act and what it is
  about, its kind's glyph giving way to a tick on hover; ticked rows send
  together. The detail is who, where and when, the act's name, then its
  payload exactly as it goes (`work/acts/ActView.tsx`: the kind's own view
  from `ACT_VIEWS`, else `GenericActView`, its fields and its body as
  plain text; where the payload has html the body is read from it, every
  link with its target and every image with its source (`htmlWords`), and
  an add-on call's arguments are shown whole), over one bar: Discard, Edit, and a split Send whose menu
  makes the grant ("Send and stop holding" › the grant's name;
  `grantFor` in model.ts: a mail fixes its account and every recipient, an
  add-on call its server and tool, a computer act takes none). Sent groups
  what left by day; its detail says who pressed and when ("Sent by you at
  9:31 AM", "by the grant …", "from another device") and offers the
  Result's way back, or says it cannot be taken back. Under the sent item
  whose press earned a grant (`OfferLine.tsx`), past a hairline: one muted
  line, the open lock, "Mail to dana.lee@purdue.edu from landon@purdue.edu: you sent the last 5 as written.",
  Dismiss and Stop holding; taken, "Grant made: Mail to dana.lee@purdue.edu …" with
  Undo (which removes the grant). The press that earned it says so in its
  toast, whose Review opens that item in Sent. Grants is a sheet:
  each standing grant by workspace with Remove, no confirm. Held is never
  amber; only a failed send takes the red mark.
- **Edit** (`EditDialog.tsx`) changes each field a person reads and the
  body; a mail's html is rebuilt from the edited text, so what goes is what
  was shown. The host keeps the account, the server and the thread.
- **Results** (`ResultsSection.tsx`) is a right-panel section of a Work
  root thread (`results` in lib/rightPanel.ts, the outbox glyph), listed
  only while it has a row: "Can undo" and "Can't undo", each row with its
  way back.
- **The held line** (`heldOf` and `HeldLine` in
  surfaces/transcript/ApprovalCard.tsx): under a call whose answer is "Held
  as item N: …", one muted line, the Outbox glyph, "Held" then the act; it
  opens the Outbox.
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

## Not built here

A view of its own for every act kind: mail, the calendar, a guest link and
a file act have one, every other kind shows in the generic view. The held line opens the Outbox
but does not select its item. A box thread's computer act
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
