# Work: the hold, grants and results

The owner's rule is "the press is his": agents draft, and nothing an agent
does leaves the machine until he presses Send. This file is the server half
of that rule (milestone 10 of the Work plan). The Outbox screens, Results
and the return from Away are milestone 14's and are not built.
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

`failed` waits on him as `held` does, and a new press is a new attempt.

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
  appears later starts Held.
- The card is data: `work.outbox.rules` answers each add-on a Work thread
  can reach with its tools, their hints, the class the hints suggest
  (`suggestedRule`: Runs only for read-only and neither destructive nor
  open-world) and the standing rule. `work.outbox.setRules` (admin) sets
  them; `work.outbox.setForWork` (admin) marks a global add-on for Work.
- A pillar's `outward(addon, tool, args)` may hold or refuse what he let
  run. It can never run what he holds.
- The host's own call with no thread behind it (a watch) runs a Work
  add-on's tool only when its rule is Runs.
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
- **Sent** means LifeOS took it. If LifeOS's own lane then fails, the item
  comes back `failed`.
- `calendar.op` is registered against the architecture's function names
  and answers `not built … (milestone 24)` until LifeOS has them.

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
starter, so a run's subagent is the run (`routineRunOf`). For an add-on call the host seals the server's digest into the
matcher, and a matcher that names arguments fixes the rest: a call that
carries an argument the grant neither names nor leaves `free` (a `bcc`, a
second channel) does not fit it. A matcher with no arguments fits any call
of the tool. For mail, every recipient (copied and blind-copied too) must be a
person or an exact domain the grant names. A computer act takes no grant.
Away makes none, and no agent can.

## Computer use

In a Work thread the host classes each call from the screen, whatever the
model flagged (`readOutward`, `shared/computer/outward.ts`; the list of
names is data there). Held: a click, press or pick on a control named for an
outward act, or inside one; a click by position that lands on one; a press
with no target where the pointer was left; a menu path naming one; Return or
a typed line break in a chat's message box, in a composer, in a field beside
a submit, or in a sheet whose default may send; Command or Control with
Return where that sends; Space or Return on such a control; and any call the
model flagged. The host reads the window afresh, with frames, when a step
lands by position, goes to the focus, or names an element its book lacks.
If that read fails the call is refused (`HELD_UNREAD`): nothing is judged
against an old book or an empty screen. A call is kept only when every
step's target can be placed on the read; else it is refused
(`HELD_UNPLACED`), so a press never runs a bare index or point on whatever
took its place.

A held call is a `live` row with the window's picture. On his press the
host reads the window again, finds each target by what it is (role, name
and the names above it), and runs the call only if every field's text and
every target are what he was shown; else the row reads `stale` and nothing
is sent. A restart, a deleted thread and a closed workspace make it stale.

**What this cannot catch**, in the same class as the shell: a click by
position on a control the screen reader gives no name (a canvas app, a
remote desktop, a picture of a button); a control named off the list; an
act split so that no single call reads as outward; a web address whose page
acts on being fetched. A wrong match costs one press.

A box thread's act on a Mac's screen is judged on the Mac but cannot be
held there: the Mac answers `HELD_UNAVAILABLE` and nothing runs. The box
sends a Work thread's act only to a Mac that offers `computer-hold`. A
Work thread's `osascript`, `security` and the rest of the bridge's
always-ask list stay a prompt on the Mac under full access and under Away,
and its text into a password field is denied on the Mac under Away as it
is here (`req.awayDenies` in `MacComputer.ask`, `AWAY_PASSWORD`).

## Away

`awayVerdict(ask, scope)` (`shared/away.ts`) replaces `awayAllowsKind`. A
code thread: as before. A Work thread: an outward or flagged computer act
is held; text into a password field is denied; `addon_add` and
`addon_remove` are denied; every other card is allowed. No verdict releases
a held act or makes a grant: neither is a card. The held notice
(`Notifier.held`) goes out whether or not he is away, with no approval a
lock screen could answer.

## A shared file: "asked" must be his words

`judgeWrite` (`shared/work/because.ts`): on an item other people can see, a
write marked `own` is a suggestion; `asked` writes only when the host finds
the quote in the owner's own messages (`ctx.threads.ownerSaid`); `routine`
only when a grant of that run's routine covers it. A pillar's write tool
calls it.

## Not built here

The Outbox screens and Results (milestone 14). A box thread's computer act
held on a Mac and pressed from the box. A held row moving with its thread
to another host: it stays on the host that held it. A card skipped for a
Claude thread's add-on call that will be held (in `safe` it asks, then
holds).

## Proofs

`work/outbox/{store,outbox,lifeosHeld}.test.ts` (the rig in `rig.ts` runs
the real add-on host with a real child and the fake MCP server, and reads
what reached the server off the wire); `shared/computer/outward.test.ts`;
`computer/run.hold.test.ts`; `sessions-away.test.ts`;
`addons/tools.test.ts`; `addonStore.test.ts`; `remote/macBridge.test.ts`;
`computer/bridge.test.ts`; `shared/away.test.ts`;
`shared/work/because.test.ts`.
