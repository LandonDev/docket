# Work search

One field that finds a person, a mail, a message, a task, an event, a file,
a document, a project or a thread in any of his jobs. Pillar id `search`
(`PILLAR_MILESTONE` 62). The plan is `.temp-code/plan-3lajhR4Inx-d.md`; what
is proven is in `.temp-code/plans/landed/R3-search.md`.

Files: `src/shared/work/search.ts` (the names, pure),
`src/shared/contract-work-search.ts` (the wire's zod),
`src/main/server/work/search/` (the host), `src/renderer/src/work/search/`
(the picker).

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
first), `snippet` on a hit (the matched words in their line, drawn in the
fact's place), `chip` (the thing as a thread's context, for ⌘↩).

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
| `work.search.query` | `{ text ≤200, workspaceId?, tier?: 'instant', sources?: string[], kind?, own?: boolean }` | `SearchAnswer`: `{ groups: { source, kind, label, hits, more }[], pending: { source, kind }[], quiet: { cause, line }[] }` |
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
a hit's `open`, which the listener's fence reads.

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
a chip carried. Empty text answers the newest eight whose job still exists;
a deleted job takes its rows with it (`workspaceRemoved`).
`SEARCH_RECENTS = 0` turns the list off.

## What search keeps, and Purdue

Search keeps nothing but those recent rows. It registers no act kind: it
sends, posts, shares, books and submits nothing.
