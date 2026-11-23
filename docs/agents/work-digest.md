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

## Telling the phone

`Notifier.work(n)` (src/main/server/remote/notifier.ts) emits a notice
with no thread. No new push event and no hub deploy: an interrupt goes out
as `needs_you` with kind `waiting` (time sensitive, sound; no client turns
it into buttons), the digest as `finished` (a banner, no sound). Each
carries `work` (`NoticeWork` in src/shared/work/tell.ts): `{key, digest}`
or `{key, tell, by?, open?}`.

- **Every sink names its fields, so each was changed by name.**
  `Notice.threadId` is optional and `work` is added; `RelayNoticeSchema`
  (contract-relay.ts) takes an absent `threadId` and carries `work`;
  `relayServe.ts` `onNotice` and the box's `deliverNotice` (index.ts)
  forward it, so a Mac's notice reaches the phone through the box; the hub
  sink and the local APNs sink pass `work`; the Live Activity sink and the
  webhook sinks skip a notice that is not a thread's (`isThreadNotice`);
  `apnsPayload.ts` writes `tc.work` and groups every Work notice under
  `thread-id` `tc.work`; `push.ts` collapses on `work:<key>`.
- **One banner for what cannot wait.** Every interrupt of a host shares the
  key `now` (`deliver.ts` `NOW_KEY`), the same as the hub's own collapse id
  for a notice with no thread (`<host>:needs_you`). So while more than one
  interrupt is open (told, its `by` not passed), the body names them all:
  "2 things need you: Budget review starts at 2:00 PM; Sign-in to Frame.io
  ends today". One open: the title is the job, the body the row, and
  `work.open` is the row's own target. More: the tap opens the list.
- **The hub is not changed.** It rebuilds a notice field by field, so `work`
  is lost there and a tap through the hub opens the app, not the target.
  The box's own APNs carries `tc.work`. The host's hub client already sends
  `work`, so a hub that learns the field needs no host change.
- **A held item a thread made** (`open: {held, thread}`) goes out through
  `Notifier.held` on that thread, as it always did: the phone app of today
  opens the Outbox item from it.
- **Present at a desktop.** An interrupt is stamped `onScreen` while a
  window of this host has a thread in front of a present person
  (`NotifierOptions.present`, the focus set): the phone is skipped, the
  desktop shows it. If the notifier cannot tell, it sends. The digest
  always goes.
- **One thing told once across hosts.** `Notifier.toldWork` keeps the key
  and clock of each interrupt this host sent or carried for a host it
  relays, for an hour: a second one is dropped, whichever came first. A
  clock that moved is news.
- **One host sends the digest** (`WorkDeps.sendsDigest`, built in index.ts):
  a headless host always, a desktop only when it has no saved Linux host.
  Before it sends, it asks each linked host `work.digest.list` over the
  host link with a five second limit (`PEER_WAIT_MS`) and adds the rows
  that waited there, a key two hosts hold counted once. A Mac that was
  asleep makes its day when it wakes and sends no phone digest.
- **The gate.** `Notifier.setGate(gate)`: asked before a thread's notice
  goes out; true keeps it back. With none set, or one that throws, every
  notice is today's (a test compares them field for field).
- A banner on a phone cannot be taken back: `done` withdraws the desktop's
  notice, and the next interrupt's body names only what is still open.

## The swap for Today

`digestOpensPort` in `src/renderer/src/lib/workSwitch.ts` is the whole
seam: the day's notice opens what is registered there, else the digest's
own list.

## Built so far

D0: the seam, the rule, the ledger, the day, the wire. D1: the notices to
the phone. Nothing calls `ctx.tell` but tests yet, so nothing he sees has
changed.
