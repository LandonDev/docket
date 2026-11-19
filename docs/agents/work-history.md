# Work: history, compare and branches

Milestone 19 of the Work plan. A block document's versions, the compare of
any two, restore, compaction, and the branches that hold suggestions on a
shared document; the history canvas kind that shows them. Built for LifeOS
documents and `.tcdoc` files. [work.md](work.md) says how the `history`
pillar is mounted; [work-service.md](work-service.md) is the service it
runs in; the engine's own account is work-kit's
`src/collab-server/README.md` ("History, compare and branches").

## Where each part lives

| Part | Where |
|---|---|
| The block diff | `work-kit/formats/diff`: `diffBlocks(base, target)` → `{stats, rows, lines}`, `diffWords`, `inlineSegments`, `applyRows`. Pure JSON, no Yjs or DOM: the service, main and the renderer all run it |
| Versions, compare, restore, branches, compaction | `work-kit/collab-server` `createHistory({collab, versionsFor, storeFor})` (history.ts), beside the collab server, reaching the live gc-off Y.Doc through a direct connection, `collab.edit` and a Hocuspocus extension of its own |
| Where versions are kept | `ConvexVersionStore` (LifeOS's `docVersions` and `docBranches`, M17), `FileVersionStore` (`versions/` and `branches/` inside the `.tcdoc`), `MemoryVersionStore` (tests) |
| The service's routes | `src/main/server/work/history/serviceRoutes.ts`: `/internal/history/{list,compare,cut,restore,branches,decide}` on the Unix socket, behind the secret, listed in `service/routes/index.ts`. `/internal/doc/write` (routes/internal.ts) chooses direct or branch through `ctx.history.write` |
| The wire | `src/shared/contract-work-history.ts`: `work.history.{versions,compare,cut,restore,branches,decide}` |
| Main's module | `src/main/server/work/history/index.ts`: checks the source and the caller, calls the service, names the principals |
| The canvas | `src/renderer/src/work/history/` (HistoryCanvas.tsx, Compare.tsx, store.ts, canvas.ts) |

## Versions

A version is a `Y.snapshot` of the live document (about 2 KB) and
`clients`: each Yjs client id that wrote since the version before, mapped
to its principal through the collab server's book. A key that is not a
number names a principal who only deleted (a delete makes no client id).
`VersionRow.by` on the wire is those principals.

Cut when:

| Cause | When |
|---|---|
| `agent-turn` | after each direct agent write (`/internal/doc/write`), and after an acceptance from an agent's branch. One per write, not per turn: the service does not see turns |
| `before-agent` | before an agent writes on a shared document, direct or into a new branch (the branch's base) |
| `idle` | ten minutes with no change after edits (`IDLE_MS`), and when the last connection leaves a changed document |
| `before-restore`, `restore` | around a restore; `restore` names `restoredFrom` |
| `named` | `work.history.cut` (the owner names one) |
| `import`, `guest-end` | not cut yet: M21 (import) and M31 (a guest's session) cut them |

Nothing changed since the last version, no new one (except a forced cut).
Any version rebuilds exactly with `Y.createDocFromSnapshot` (eleven proven
in a test).

## Compare

`compare(name, from, to)`, sides a version id or `live`. Both sides' blocks
go through `diffBlocks`:

- **rows**, one per change, in reading order: `added` and `removed` (a
  subtree is one row at its top), `moved` (another parent, or out of order
  among siblings that kept one parent), `changed` (type, props, words,
  styles; a table cell by cell). `inline` is a word diff that reads back
  both sides; a run of spaces between two changes joins them.
- **lines**, the merged reading order both views draw: both sides, or the
  side that has the block there; a moved block has two lines, one row.
- **by** on each row: the principals whose Yjs items in that block are
  newer than the older side (`blockWriters`). A removal leaves no item, so
  it goes to the one writer between the two sides when there is only one.
  A side kept as blocks (after a compaction) has no items: no `by`.

## Restore

A forward edit: the older blocks written over the live ones by
`writeBlocks` (ids kept; a block whose own content is unchanged keeps its
Yjs items and comment marks), between `before-restore` and `restore`
versions. Every older version stays readable. On a shared document a
restore is a branch instead (`Restore <ms>` its label, the owner its
author), shown as suggestions.

## Branches

An agent's own idea on a shared document (§8.4): `/internal/doc/write` with
`because: 'own'` on a row with `shared` goes into that agent's pending
branch, made on its first write from a `before-agent` version; later writes
rewrite the same branch. That route is the LifeOS worker's, and a bot key's
`asked` or `routine` counts as `own` there (only main can check either);
TempCode's own agents write through `/internal/docs/write`, which takes
main's verdict ([work-docs.md](work-docs.md) "The tools").

- A branch is a fork of the live state, with the same item ids, kept as a
  Yjs state (a Convex file, or `branches/<id>.yjs` in the `.tcdoc`).
- What it suggests is `diffBlocks(live, live ⊕ fork)`: the fork merged into
  a copy of the live document. Edits the live document took since the fork
  stay in the merge, so they never show as the branch undoing them.
- **Accept all** applies the fork's own update to the live document, each
  word credited to whoever wrote it in the fork (`collab.edit` as the
  branch's author). **Accept rows** writes those rows with `applyRows` (a
  changed block takes its content and keeps its children; an added one goes
  after the nearest block before it that the document has; a moved one goes
  where the branch has it), then forks the branch again from the new live
  state with the rows left, so the next merge never doubles words.
- **Pieces of a row** (milestone 20): a changed block's words are cut into
  the changes a reader takes one at a time (`inlinePieces`), named
  `<block id>#<n>`. Accepting a piece writes the block with only that piece
  (`withPieces`), and the block stays pending for the rest; rejecting one
  keeps the others as the branch's goal for that block.
  **Reject** drops rows the same way, or the whole branch.
- Several branches stay pending at once and do not touch each other: each
  merges into the live document on its own.
- A row is a whole block. Accepting one inline change inside a block is
  M20's first step.

## Compaction

`compact(name, {minBytes})`, by default past 2 MiB (`COMPACT_BYTES`), runs
only with no socket on the document. Every version still kept as a snapshot
is first kept as its blocks (`setVersionBlocks`, or
`versions/<id>.blocks.json`); then the gc-off state is loaded into a gc-on
document (`compactState`, item ids kept, deleted content gone), stored in
the place of the live state, and the document unloaded so the next load
reads it. A client offline with an older copy syncs into it with no lost or
doubled words (a test). Later versions carry the next `epoch`. Nothing calls
`compact` on a schedule yet.

## The wire and its checks

| Method | Capability | Answer |
|---|---|---|
| `work.history.versions {source}` | read | `{versions, shared, names}`, newest first |
| `work.history.compare {source, from, to}` | read | `{diff, names}` |
| `work.history.cut {source, label?}` | operate | the version |
| `work.history.restore {source, versionId}` | operate | `{mode: 'direct', versionId?}` or `{mode: 'branch', branchId, versionId}` |
| `work.history.branches {source}` | read | `{branches: [{…row, diff}], names}` |
| `work.history.decide {source, branchId, which, accept}` | operate | `{left}` (`which` is block ids, `<block id>#<n>` pieces, or `all`) |

A source is `{at: 'lifeos', table: 'docs', id}` or a `.tcdoc`
(`{at: 'file', host, path}`) on this host: a file whose host is another and
that is not on this disk is refused with words; a remote caller's path goes
through the listener's fence (`ctx.reaches`, `FenceError`). The service
holds a LifeOS document's sector against the body's `fence` again and takes
a `file` only from an unfenced caller. Main calls as the owner.

`names` maps each principal to what a screen shows: `You` (the owner and
his LifeOS apps), `LifeOS` (a bot key), a thread's title for an agent of
this host, `An agent` for another host's, `A guest`, an outside author's
own name.

No push: an open view asks again after its own acts. A LifeOS document
served by another host (the Mac when the box serves them) is refused with
the service's words; routing it to the serving host is the document
canvas's (M20).

## The canvas

The `history` kind (`opens: {}`: the pane opens it by name on a document's
source, `shell.openHistory`). Three views, kept in the item's state:

- **The list**: pending branches first ("Waiting for you"), then versions,
  newest first, each row who and why (the label, else the cause in words)
  with the time; on hover the time gives way to Compare (against now) and
  Restore (not on the newest). A checkbox picks two; Compare in the bar
  opens them. A restore of his own document is written at once and the bar
  says so with Undo; on a shared one it opens the restore's review.
- **The compare**: read only, no mode. One column by default, each change
  in its sentence as a suggestion is drawn (taken words struck on
  `del-bg`, new ones on `add-bg`, a whole block tinted when added or
  taken); side by side once the body has 840px (420px a side), the older
  left, a `diff-gap` blank where a side has nothing, each version named
  over its column. The bar: History (back to the list), the two pickers in
  one column, then who made the current change and Previous, `n/N`, Next.
  More holds the layout switch and "Restore the older version". The current
  change is the 1px foreground 40% outline on its own words.
- **The review** of a branch: the compare drawn the same way, the pane's
  one stepper with Reject and Accept, a line saying whose suggestions they
  are or which version a restore brings back.

The prototype's third view ("A list of changes") and people in the bar are
not built.

## Proven, and not

Proven by tests: `formats/diff/diff.test.ts`,
`collab-server/{history,versions}.test.ts` (work-kit);
`work/history/history.test.ts` (the service in process, a `.tcdoc` and a
fake LifeOS), `work/service/service.test.ts` (the write route's choice),
`work/history/HistoryCanvas.dom.test.tsx` (the pane). Seen running: an
isolated instance under xvfb, its own Work service on a `.tcdoc`, the canvas
opened through `work.canvas.open` (`.temp-code/plans/landed/M19/`).

Not proven: a LifeOS document's history against the real deployment (the
fake has M17's shapes); compaction on a live service (unit only);
attribution of rows in a document written before this milestone (its old
writers are in the book, its versions start now).
