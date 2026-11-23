# The digest (Work pillar `digest`)

One way for Work to tell him anything, one rule that decides whether it
interrupts or waits, and one notice a day for all that waited. Plan:
`.temp-code/plan-xY0MUDj2t7Wh.md` (round 3, row 10). This file is the
account; it is filled in as each milestone lands.

## The seam: `ctx.tell`

`src/shared/work/tell.ts` holds the types (`Tell`, `TellRow`, `TellOpen`,
`TellKind`, `TELL_GROUPS`, `TELL_LEVELS`); a file the first paint loads
takes them with `import type`.

```ts
ctx.tell({
  kind: 'clashes.new',            // '<pillar>.<what>', listed once in the module's `tells: TellKind[]`
  workspaceId,                    // the job; null: no one job
  title: 'Budget review overlaps Thumbnail review',   // one plain line; no path, command or URL
  detail: '2:00 PM',              // optional muted line
  open: { view: 'agenda', workspaceId, at: eventId }, // {thread} | {view, workspaceId, at?} | {place, at?} | {held} | {settings}
  by: startsAt,                   // ms. ONLY when he alone can unblock it and it is too late after this
  key: `clash:${id}`              // the same key replaces the same row
})
ctx.tell.done(key)                // no longer true: the row goes, a notice of it is withdrawn
ctx.tell.quiet(sessionId)         // this thread started on its own: its done, failed and stuck wait for the digest
```

- A caller states a deadline, never a volume. There is no "loud" flag.
- `WorkModule.tells?: TellKind[]` lists each kind with its group (`held`,
  `ending`, `meetings`, `clashes`, `results`, `people`, `review`,
  `system`). A tell of a kind no module lists is logged once and kept
  under `system`.
- `ctx.tell` never throws and does nothing while Work is off. Its part
  (`work/digest/ctx.ts` `tellPart`) is total: a fault while it is made or
  called is logged once and the call returns, so a sibling may call it
  with no try. `done` and `quiet` only remove and mark, and work with the
  switch off.
- There is no wire for a window to tell: every source of news is on a host.

## The rule: `decide`

`work/digest/rule.ts`, one pure function, tested as a table
(`rule.test.ts`): `decide(t, level, nextDigestAt)`.

- `level` is the group's setting; every group starts at `clock`.
- `clock`: at once when the tell has a `by` before the next digest plus
  `KEEP_MS` (two hours: a thing due at 9:30 is not first heard of at
  8:00); else it waits. `now`: always at once. `digest`: always waits.
- A row already told at once is not told again when its key is replaced,
  unless its `by` moved earlier (`retold`).
- Each look (30 s, while Work is on) the host reads every row with a `by`
  still ahead that he was never told of at once, whatever digest it is in:
  one whose clock has come inside the window is told at once.
- A row is marked told only when a deliverer took it. With none, the row
  is kept as due, and the first look with a deliverer sends every due row
  whose `by` has not passed by more than a day (`LATE_MS`).

## The ledger

`work/digest/store.ts`, on each host, 30 days (`KEEP_DAYS`), pruned at each
digest:

| Table | Holds |
|---|---|
| `work_digest_tells` | one row a tell: `id`, `key` (unique when set), `kind`, `grp`, `workspace_id`, `sector`, `title`, `detail`, `open` (JSON), `by_at`, `at`, `due`, `day`, `told_at` |
| `work_digest_days` | one row a digest made: `day`, `made_at`, `seen_at`, `count` |
| `work_digest_settings` | `at` ("08:00"), `zone`, `levels` (only the groups he changed), `handled` (the last digest time looked at) |
| `work_digest_quiet` | threads that started on their own (`ctx.tell.quiet`) |

How a row stands is read from its columns: `told_at` set is `now`, else a
`day` is `digest`, else `waiting`.

## The day

`work/digest/make.ts` `makeDay`, called by `Digest.tick` (`ctx.ts`) at the
digest's time: every row no digest holds is stamped with the day, and the
day is counted by the rows that waited. A row he was told of at once is in
the day's list and not in its count. A day with nothing that waited makes
nothing and sends nothing. A time missed while the host was down or asleep
is made once at start, late; a day is never made twice
(`work_digest_days.day`). A change of the time or the zone misses nothing:
a digest time it puts in the past is not made late.

The time is a wall time in a zone (`clock.ts`, over the routines pillar's
`nextAt`). The zone is the last desktop's: a window sends
`work.digest.here {zone}` and the host keeps the newest. Until one has
said, the host's own zone.

## The wire

`src/shared/contract-work-digest.ts`:

| Method | Needs | Answers |
|---|---|---|
| `work.digest.list {day?, since?}` | read | `{days, rows, waiting, groups}` |
| `work.digest.get` | read | `{at, zone, levels, nextAt}` |
| `work.digest.set {at?, levels?}` | admin | the settings |
| `work.digest.here {zone}` | operate | null |
| `work.digest.seen {day}` | operate | null |

Push `{push: 'work.digest', day?, row?, gone?, settings?}` to sockets that
hold `read`. The relay carries every method.

## The swap for Today

`digestOpensPort` in `src/renderer/src/lib/workSwitch.ts` is the whole
seam: the day's notice opens what is registered there, else the digest's
own list.

## Built so far

D0: the seam, the rule, the ledger, the day, the wire. No notice is sent
yet and nothing he sees has changed: a tell the rule calls "now" is kept
as due until the notices land.
