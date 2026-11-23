# Work search

One field that finds a person, a mail, a message, a task, an event, a file,
a document, a project or a thread in any of his jobs. Pillar id `search`
(`PILLAR_MILESTONE` 62). The plan is `.temp-code/plan-3lajhR4Inx-d.md`; what
is proven is in `.temp-code/plans/landed/R3-search.md`.

Files: `src/shared/work/search.ts` (the names, pure),
`src/shared/contract-work-search.ts` (the wire's zod),
`src/main/server/work/search/` (the host), `src/renderer/src/work/search/`
(the picker), `src/renderer/src/lib/workSearchPort.ts` (its door, the only
part in the first paint). The look is docs/DESIGN.md "Work search".

## What he gets

One field, opened with ⌘⇧K (Ctrl+Shift+K on Windows and Linux) from
anywhere in the app while Work is on, from Go → Search Work…, or with a
click on the search mark beside the rail's **Work** heading. He types;
results stand under kind headings from every job, each row with its job.
Return opens the thing in its own view in its own job, moving the window
there first. ⌘↩ starts a thread about it. The key again narrows to the job
the window is in, and again widens. ⌘K is still the app's Search (threads,
code and notes of every place).

A screen that wants this field calls `openWorkSearch({ text?, workspaceId?,
kind? })` from `lib/workSearchPort.ts` (safe in the first paint: the port
is a listener set and nothing else, and it opens nothing while Work is off
because nothing listens). No screen draws a second everything-search.

## How a pillar registers

A pillar makes its things findable with one line on its module, beside
`mentions` and `health`:

```ts
// src/main/server/work/money/index.ts
import type { SearchSource } from '../search/source'

const receipts: SearchSource = {
  kind: 'receipt',            // any string; the kinds in SEARCH_ORDER have a place of their own
  label: 'Receipts',          // the group's heading, for a kind SEARCH_ORDER does not know
  tier: 'instant',            // instant: this host's memory or SQLite, never the network
  async search(ask, ctx) {    // ask: { text, reach, limit, by, signal }
    return rowsFor(ctx, ask.reach.workspaces, ask.text, ask.limit + 1).map((row) => ({
      key: `money:${row.id}`,                 // one thing, one key, whichever source or host found it
      kind: 'receipt',
      title: row.who,
      detail: row.amount,                     // the row's one muted fact
      at: row.date,
      workspaceId: row.workspaceId,           // the job; null: Work Chats
      open: { to: 'view', view: 'money', with: { row: row.id } }
    }))
  }
}

export const money: WorkModule = { id: 'money', ensure, search: [receipts] }
```

`search/source.ts` holds types only: importing it loads nothing of search.
A source answers best first, `ask.limit + 1` hits when it has more, and only
things inside `ask.reach` (the jobs in `reach.workspaces`, and Work Chats
when `reach.chats`). `open` says how the window opens the hit in place:

| `open` | What the window does |
|---|---|
| `{ to: 'view', view, with? }` | `openWorkView({ workspaceId, view, ...with })` |
| `{ to: 'thread', sessionId, seq? }` | opens the thread, at a row when `seq` is given |
| `{ to: 'file', ref, name }` | `work.files.open` with Files' own ref, then the Files view |
| `{ to: 'chip', chip }` | as the chip opens from a sent message (`openerOf`) |

Other fields a source may set: `lifeos: true` (read from LifeOS: not asked
while LifeOS is not connected, and asked of one host only), `unranked: true`
(its order is a list's, not a ranking, so a thing he opened before goes
first), `when: 'alone'` (asked only for "All … for q", never as he types: a
search that walks), `tier` as a function of the context (decided at each
ask: what a host holds in memory is instant, the same read from LifeOS is
not); on a hit, `snippet` (the matched words in their line, drawn in the
fact's place), `chip` (the thing as a thread's context, for ⌘↩) and
`cloud: true` (a file kept in the cloud alone).

**A pillar that has `mentions` and no `search` is found already.** The
mention bridge (`search/mentions.ts`) asks each mention source once a job in
reach, stamps every hit with that job and opens it as its chip. Five a kind
at most, as `@` gives.

**One provider a kind.** Where a module lists a source of a kind, this
pillar's own source of that kind and the mention bridge for it stand down
(`listSources`, search/run.ts). A pillar may list two sources of one kind
(titles at once, words over the network); both are asked, and the window
shows a thing once.

## The wire

Both methods are `approve`, as `work.canvas.mentions` is (an answer holds
what LifeOS holds), and relay only while the host is unlocked.

| Method | Params | Answer |
|---|---|---|
| `work.search.query` | `{ text ≤200, workspaceId?, tier?: 'instant', sources?: string[], kind?, own?: boolean }` | `SearchAnswer`: `{ groups: { source, kind, label, hits, more }[], pending: { source, kind }[], quiet: { cause, line }[], searched }` |
| `work.search.opened` | `{ hit }` | `{}`; writes one row of `work_search_recent` |

One method serves both speeds. The window's first call for a keystroke is
`{ text, tier: 'instant' }`: the host runs every instant source and answers
their groups, the network sources it would ask (`pending`) and what it
already knows it cannot reach (`quiet`). The window then asks each pending
source on its own (`sources: [id]`), so each lands when it is ready. Empty
text answers the Recent group and nothing else. `kind` narrows to one kind
with `SEARCH_ALL` (30) rows. `own: true` leaves out the LifeOS sources: the
window sends it to every host but the Work home, so LifeOS is asked once. A
source's id is `<pillar>.<kind>` (`<pillar>.<kind>/<tier>` when a pillar
lists two of a kind). No param is named for a path; a file is a ref inside
a hit's `open`, which the listener's fence reads. `searched` counts the
sources that searched and answered for this call, with or without rows: the
window says "Nothing for …" only when some source did, so mail alone with
LifeOS signed out says why and nothing else. A host that predates the
count is taken to have searched.

## The frame

`search/run.ts` `runSearch` is where the rules live, so no source can break
them:

- **The wait.** A source is asked for `SEARCH_WAIT_MS` (4 s) and no longer.
  One that throws or stalls is one quiet line ("Mail did not answer.") and
  the others still answer. Its signal aborts when the wait ends or the
  caller gives up.
- **The fence, twice.** A source searches only inside `ask.reach`; then the
  frame drops every hit whose `workspaceId` is not in the reach, and logs
  it. A careless source cannot show one job's thing in another.
- **The cap.** The frame cuts a group to its limit (four among the others,
  thirty alone) and sets `more` itself; it never trusts a source's count.
- **LifeOS.** While `ctx.lifeos.connected()` is false no LifeOS source is
  asked, and the answer carries one quiet line of cause `lifeos` in the
  session's own words, however many kinds it feeds.
- **A remote key and files.** A hit that names a file (in `open` or its
  chip) is shown to a remote key only when the key could have named the
  file itself (`ctx.reaches`).
- Groups stand in `SEARCH_ORDER` (`src/shared/work/search.ts`): People,
  Mail, Messages, Tasks, Agenda, Files, Documents, Projects, Threads, then
  items, the Outbox, routines, cards and any later kind in the order it
  came.

## The fence

`search/reach.ts`. His window reads every Work workspace of this host and
Work Chats, or the one workspace `workspaceId` names (an id that is no job
of this host reads nothing). A thread reads exactly what its `@` reads
(`ctx.mentionReach`): a Work workspace's thread its own job, a Work Chat
every job of the host. A code thread and a Work thread with no Work home
read nothing. A LifeOS row belongs to the job whose sector is the row's
(`workspaceOfSector`); a row of a sector with no Work workspace on the host
is not shown, since it has no view to open in.

## Recent

`work_search_recent (key, hit, opened_at)`, the newest 50 kept
(`search/recents.ts`). `work.search.opened` writes a row only for a thing
of a job this host has. A row keeps the kind, the title, the id, the job
and how to open the thing again: never its fact, its snippet, or the words
a chip carried. Empty text answers the newest eight whose job still exists,
each with `openedAt`, so the window makes one Recent list across hosts, the
newest first and a thing two hosts hold by its newest opening, before it
takes eight; a deleted job takes its rows with it
(`workspaceRemoved`).
`SEARCH_RECENTS = 0` turns the list off.

## The sources this pillar brings

`search/sources/`, each small, each on what exists. `OWN_SOURCES`
(search/index.ts) lists them.

| Kind | Tier | Reads | Opens |
|---|---|---|---|
| person | instant from the mirror, else network | `people:list`, kept by a name or an address; a person is in a job when one of `sectors` is | `{ view: 'people', with: { person } }` |
| mail | network | `mail:search { text }`, each thread kept by the sector it sits in; a snippet only when the words are in neither its subject nor its sender | `{ view: 'mail', with: { mail } }` |
| task | open tasks instant from the mirror; network for all | a key he typed (`PUR-41`) through `tasks:byKeys` first, then `tasks:search { text, sector? }` | `{ view: 'tasks', with: { task } }` |
| event | instant from the mirror, else network | `events:range` from 30 days back to 120 days ahead (`EVENTS_BACK_DAYS`, `EVENTS_AHEAD_DAYS`), kept by title and place, what is coming first | `{ view: 'agenda', with: { event } }` |
| doc | network | a sector at a time: the newest page of `docs:list` by title, then `catalog:search { sector, text }` with its line (a title outside that page read with `docs:get`) | `{ to: 'file', ref: { at: 'lifeos', table: 'docs', id }, name }`: a Files tab (a hit kept from before, `{ view: 'docs' }`, opens there too) |
| project | network | `projects:list { sector? }` by name and description | `{ view: 'projects', with: { project } }` |
| thread | instant by title, network by its words | the host's rows for titles; `Store.searchEvents { query, scope: 'work' }` for words, with the index's own snippet (thread notes among them) | `{ to: 'thread', sessionId, seq? }` |
| file | instant; a second source `when: 'alone'` | `work.files.names { workspaceId, text }` a job in reach; for "All files", `work.files.search { workspaceId, query }` | `{ to: 'file', ref, name }` |
| message, chat | network | Messages' own sources (`messages/search.ts`, on its module's `search`): messages that hold the words, and conversations by name | `{ view: 'messages', with: { chat, message? } }` |
| money | instant | Money's own source (`money/borders.ts`): a ledger's rows | `{ view: 'money', with: { row } }` |
| item, held, routine, card, any later kind | as its mention source | every module's `mentions` with no `search` source of its kind | `{ to: 'chip', chip }` |

LifeOS is asked once for the whole reach where a function allows it
(`mail:search`, `people:list`, `tasks:search` and `events:range` with no
sector when the reach has more than one). The host reads LifeOS as the
owner, so the reach is the fence here: a row is kept only when a job in
reach has its sector, and that job is the hit's.

**The mirror** (`search/mirror.ts`): `people:list`, the open tasks
(`tasks:list`) and `events:range` for the window are held in this host's
memory by live LifeOS queries, started from the module's `start` (so never
while Work is off) and asked again each day as the window moves. Warm, a
search for a person, an open task or an event makes no call at all. What it
holds is dropped the moment LifeOS is not connected, and the sources ask
LifeOS as before until each list arrives again.

**Threads** come through a host part (`search/host.ts`, called once from
`buildWorkCtx` as `routines/host.ts` is, since a pillar never sees `deps`):
the registry's rows for titles and the FTS5 index every host keeps for
words. Both are held to rows stamped `scope: 'work'`, the words by the
query itself (`Store.searchEvents` takes `scope`), so a code thread is never
answered whatever it says. A thread in a project has no `workspace_id` on
its row; its job is its project's.

**Files** are Files' to find. `search/ask.ts` finds the pillar
that owns a method and calls its module's `handle` with the caller the
search was given, so that pillar's own fences answer. A method that is not
built, not known, or whose pillar did not load is absent: the source says
nothing. Search reads no file, walks no folder, downloads nothing and keeps
no file index. The Documents source stands down for a job once Files
answers `work.files.names` and lists a LifeOS place for it
(`filesHoldLifeos`), since a document is then a file there.

**Messages and Money** list their own sources on their modules, so this
pillar asks nothing of them by method: their hits come through the frame
like any other, fenced and capped by it. Any pillar that offers only a wire
method can be given a small source here on `ask.ts`, as Files is.

## The window

`src/renderer/src/work/search/`, one lazy chunk (`workSearchChunk`).

- `model.ts` (pure) is the list as data: generations, what is out, the rows
  in their order, the highlight. `controller.ts` runs the asks: every host
  at once for its instant tier on each change of his words, then each
  source a host named on its own, 120 ms after his last key and from two
  characters, so each lands when it is ready. A change of scope clears what
  the last scope found (a row of another job is never left to take), as a
  change of kind does; a change of his words keeps the rows on screen
  until the new ones land. A source that fails is one line by its kind
  ("Mail did not answer."); a host whose first answer fails is one line by
  its name. "Nothing for …" is said only of a search that ran (two
  characters or more, a source answering: `searched`). Within a kind the
  rows already standing keep their order and what lands later goes under
  them (`model.order`, afresh with new words), whichever host answered
  first; Recent alone is sorted by time.
- `hosts.ts`: every connected host with Work on is asked, the Work home for
  what LifeOS holds and the rest with `own: true`. A job is a sector's Work
  workspaces on every host (one a sector a host). A host with Work on that
  is not connected is one quiet line.
- `Picker.tsx` draws the model's rows in `PickerDialog` and decides no
  order. The key pressed while it is open reaches it through the port by
  two roads at once (the field, the menu's accelerator): two bare asks
  within `SAME_PRESS_MS` (80) are one press. ⌥↓ opens the scope's menu.
  The spinner shows after `SPIN_AFTER_MS` (150) of waiting and stays
  `SPIN_FOR_MS` (300); the truth it steadies is `data-out` on the picker's
  status line, which the live proof waits on. `hold.ts` is the rule that keeps a row he moved to in its place:
  the scroller moves by what landed above it, and its box is no taller than
  the rows from there down.
- `open.ts`: Return. The window enters the hit's job when it is in another
  (`project.enterWorkspace`), the thing opens by its `open`, and the hit's
  host is told (`work.search.opened`). A file goes through
  `work.files.open`, then the Files view.

## For agents

`work_search { query, kinds?, limit? }` (read only; `search/tools.ts`) runs
both tiers over the thread's own reach and answers plain lines under kind
headings: a LifeOS row with `table:id` for the LifeOS tools, a thread by
its id, a file by its place. It ends with one line a source it could not
search. It has no argument that names a job, a workspace or a sector. One
line of the Work preamble names it.

## What a search costs

`bun run script:bench-work-search -- --db <a copy>` (scripts/bench-work-search.ts;
the copy is `sqlite3 'file:<live>?mode=ro' "VACUUM INTO '<copy>'"`, never a
`cp` of a live file). Measured 2026-11-23 on a copy of the box's database
(14,709 threads, 9 of them Work, 2.25 million events), two pinned cores,
the variants interleaved, the median of five runs with the worst in
brackets, load average 25 on 32 cores:

| Measure | Median (worst) |
|---|---|
| Thread titles, the Work rows | 1.2 ms (5.8) |
| Thread titles, every thread counted as Work (14,709 rows) | 4.8 ms (8.3) |
| Transcript words held to Work rows: "budget" | 9.9 ms (10.1) |
| the same, "the" (the commonest word there is) | 47.6 ms (50.8) |
| the same, two words | 9.9 ms (13.6) |
| Transcript words with no scope, as the app's Search asks: "budget", "the", two words | 25, 113, 20 ms |
| A LifeOS source's own work on the host (2,000 people, 600 events, 300 projects in a stand-in): person, mail, task, event, doc, project | 2.5, 0.07, 0.06, 0.45, 0.36, 0.16 ms |
| The mirror warm: person, open task, event | 2.3 (4.5), 0.27, 0.25 ms |
| The mirror's memory: 2,000 people, 400 open tasks, 600 events | about 0.9 MB of heap |

Through the wire on an isolated instance (the live proof, a LifeOS
stand-in): `work.search.query` for the instant tier answers in 2.3 ms at
the median, each source asked alone in 0.8 to 1.4 ms.

So the instant tier is a few milliseconds on a host with fifteen thousand
threads, and the mirror costs under a megabyte. The transcript query, the
heavy one, stays under 50 ms at the median even for the commonest word,
and in the app it runs on the reader worker, off the host's loop: no bulk
lane was asked for. **Not measured:** how long LifeOS itself takes to
answer `mail:search` and the rest. No run was made against the real
LifeOS; a stand-in answers at once.

## What search keeps, and Purdue

Search keeps nothing but the recent rows: a title, a kind, an id and a job.
It registers no act kind: it sends, posts, shares, books and submits
nothing. It asks Files for names and never opens, reads, converts or
downloads a file; the contents of a Teams library are searched by nobody
(`sources/filesReads.test.ts` watches every file read during a search over
a stand-in library and expects none). Nothing in LifeOS or work-kit changed
for it.

## What is not searched

- A LifeOS row of a sector with no Work workspace on the host that asks.
- People and events by anything but a name, an address, a title or a
  place: LifeOS has no text index for them. Events outside the window.
- A task's description (LifeOS's index is on titles).
- A file's contents, anywhere. Files in a place Files has not listed yet.
- Code threads, code files and notes: the app's Search on ⌘K.
- A subagent's thread by its title (by its words it is found).

## Proofs

- Unit: `search/*.test.ts` and `sources/*.test.ts` on the host (the frame
  with fake sources, each source against a LifeOS in memory, threads on a
  real database, Files against a stand-in module, Messages' and Money's own
  sources through the frame, the tool's
  fence with the real reach rule), `work/search/*.test.ts` in the window
  (the model, the controller with a clock the test moves, the opener, the
  picker in jsdom).
- Live: `env -u ELECTRON_RUN_AS_NODE bun scripts/e2e-work-search.ts` after
  a build: an isolated instance under xvfb with two jobs, made-up threads
  and a LifeOS stand-in of made-up rows (`TEMP_CODE_WORK_SEARCH_STANDIN`,
  `search/standIn.ts`; only an isolated instance takes it). It signs in to
  nothing and reads no row of his.
- The design page: `bun run ui:preview
  src/renderer/src/work/search/WorkSearch.preview.tsx#WorkSearchPreview
  --shot`, every state in both themes.
