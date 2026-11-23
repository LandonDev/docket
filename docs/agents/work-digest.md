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
ctx.tell.only(prefix, keys)       // of the rows whose key starts with prefix, only these are still true: the rest are done
ctx.tell.quiet(sessionId)         // this thread started on its own: its done, failed and stuck wait for the digest
```

- A caller states a deadline, never a volume. There is no "loud" flag.
- A title is a whole sentence with its times written out ("Budget review
  starts at 2:00 PM", never "in 10 min"): the row is read hours later, in
  the list. A time is written in the digest's zone (`timeIn`, `dateIn` in
  clock.ts), never the host's: the box may run in UTC.
- A kind whose teller names no target is given one on the digest's side
  where it is known (`defaultOpen` in rule.ts: the weekly review's page on
  the week its key names), and a kind no sibling lists yet is given its
  group there too (`DIGEST_TELLS`); a sibling's own listing wins.
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
(`work_digest_days.day`), and its time is marked handled only once the day
is made, so a stop while its sources are read loses none. A tell whose
clock passed more than a day ago does not interrupt (`LATE_MS`). A change of the time or the zone misses nothing:
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
- **One banner a host for what cannot wait.** Every interrupt of a host
  shares the key `now` (`deliver.ts` `NOW_KEY`), collapsed on the phone as
  `work:<environment>:now` by the box's own sender, the same as the hub's
  own collapse id for a notice with no thread (`<host>:needs_you`): a Mac's
  interrupt never erases the box's. So while more than one
  interrupt is open (told within a day, its `by` not passed since; one
  whose clock had already passed when it was told, a failed send, stays
  open for the day), the body names them all:
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
  window of this machine's own app has a thread in front
  (`NotifierOptions.present`: a local socket's focus on a machine with a
  desktop of its own): the phone is skipped, the desktop shows it. A phone
  reading a thread, a browser at /ui and another host's window do not
  count, so a box's interrupt always reaches the phone. The digest always
  goes.
- **One thing told once across hosts.** `Notifier.toldWork` keeps the key
  and clock of each interrupt this host sent or carried for a host it
  relays, for an hour: a second one is dropped, whichever came first. A
  clock that moved is news.
- **One host sends the digest** (`WorkDeps.sendsDigest`, built in index.ts):
  a headless host always; a desktop only when it has no saved Linux host
  and its id sorts before every host it has saved. At its time it asks each
  host it can reach, whichever side dialed (`hostReadOf` in work/peer.ts:
  the transport Work's cross-host calls ride, under the far host's bridge
  policy as a read), for `work.digest.list` with a five second limit
  (`PEER_WAIT_MS`) and adds the rows that waited there, a key two hosts
  hold counted once. It asks even on a day it has nothing of its own, so a
  Mac's jobs are not left unsaid because the box has none. A Mac whose
  bridge is off for the box is not counted. A Mac that was asleep makes its
  day when it wakes and sends no phone digest.
- **The gate.** `Notifier.setGate(gate)`: asked before a thread's notice
  goes out; true keeps it back. With none set, or one that throws, every
  notice is today's (a test compares them field for field).
- A banner on a phone cannot be taken back: `done` withdraws the desktop's
  notice, and the next interrupt's body names only what is still open.

## Telling him on the desktop

`src/renderer/src/work/digest/` is one lazy chunk, `work-digest`
(`workDigestChunk` in surfaces/chunks.ts), mounted by `WorkRailHost`
(`DigestHost`) and by Settings → Work (`SettingsSection`). Nothing of it
is in the first paint (`scripts/entryGraph.test.ts`, `check:bundle`).

| File | Holds |
|---|---|
| `store.ts` | each Work host's ledger and settings, asked when its link opens and kept by the `work.digest` push; `mergeRows` (one row a key across hosts, the one told at once winning), `mergeDays` (hosts' days of one date are one, seen once any is); `markSeen`, `setDigest` (written to every Work host); `openDigestSheet`; sends `work.digest.here` |
| `notice.ts` | pure: `digestNotice` (the unseen days and their line), `openInterrupts` (told, a day old at most, not closed here), `nowToasts` (one a row, a fold past three), `systemNotices`, `listSections`, `rowWhen` |
| `open.ts` | pure: `routeOf` turns a `TellOpen` into a route (`thread`, `view` with `at` in that view's own field, `place`, `outbox` with the page's item key, `settings`), `go` runs it |
| `DigestHost.tsx` | the two toasts through `useToastSync`, their system notifications, the routes, the sheet's mount |
| `DigestSheet.tsx` | the list (`DigestList`) in a 480px `Sheet` |
| `SettingsSection.tsx` | Settings → Work → Digest |

- The digest's toast opens `digestOpensPort.get()` when one is registered
  (Today), else the sheet. Opening or closing it marks every unseen day
  seen on every host that holds it, so each window's toast goes with the
  push.
- An interrupt he closed or opened is kept in localStorage by the thing
  and when it was told (`tellingOf`; `work.digest.dismissed`, the newest
  200), so the same thing told again later shows again, and shared across windows by
  the storage event, so a reload does not bring it back.
- A view of a workspace the window is not in: the window moves there
  first (`onOpenWorkspace`), and the view opens once it has.
- A held item opens the Outbox on that item: `wantOutboxItem(key)` in
  work/outbox/store.ts, which the Outbox page takes once its list holds it.
- A `{place}` target opens through `shell.openWorkPlace` once Today's frame
  is on master; until then it opens the list.
- **The system notification.** `src/main/notice.ts`: `app:notice {key,
  title, body, silent?}` and `app:notice-close {key}`; main shows an
  Electron `Notification` only while no app window is focused, once per key
  across windows (`shouldNotify`); a click brings the asking window forward
  and sends `app:notice-open {key}`. The renderer reaches it through
  `systemNotice` in lib/native.ts; a browser at /ui raises none. macOS asks
  once to allow notifications. On Windows the app's AppUserModelID is set
  (src/main/index.ts); the notice there is not proven on the rig.
- The command `open_digest` (Go → Digest, no key) opens the sheet; it is
  greyed while no host has Work on (`MenuFacts.digest`).

## Sources

A source tells the news of a pillar that hands a read, not a tell
(`work/digest/sources/`, listed in `SOURCES` in `list.ts`). Each reads its
pillar only through that module's own `handle` as this host's reader
(`env.call`), or LifeOS on the owner session where the pillar itself reads
it that way and has no method for the fact. The frame (`sources/index.ts`
`Sources`) skips a source whose pillar is not loaded, reads one with
`every: 0` only before a day is made (`beforeDay`, ten seconds each), one
with a beat at the first look and then each `every`, logs one that throws
and reads the rest, and with `prefix` ends every row under it a read no
longer names (`ctx.tell.only`). A re-read with nothing changed says the
same words, so it is not news again.

- `lapses`: a sign-in or licence about to end, from `lapsesOf`, each 6 h;
  `lapse:<pillar>:<id>:<until>:<stage>`; 14 days before it waits, on the
  last day it carries `by` its end; one that has already ended tells
  nothing (Connections shows it).
- `waiting` (mail): each linked job's sent mails with no answer that are
  due, read from LifeOS's `mailWaits:list` for the sector as `mail_waiting`
  reads it, at digest time; `mail-waiting:<workspaceId>:<day>`, "3 sent
  mails have no answer", opens Mail. A new row each day it is true.
- `guests` (docs): each document whose last edit since the last digest (a
  day, before the first) was a guest's, from `work.docs.find`'s `lastBy`, at
  digest time; `guest-edit:<entry key>:<day>`, "A guest edited Pricing
  notes" (the list names no guest), opens Docs.
- `capture`: captures waiting in Life's "Unsorted", one row a day,
  `capture-unsorted:<day>`, "4 captures to sort", opening Tasks in the
  Life workspace, at digest time. The capture pillar files and reads
  nothing back, so the count is read where the captures are: the host's own
  LifeOS session lists Life's open tasks (`tasks:list {sector: 'life'}`)
  and counts those whose source channel is "Unsorted", the channel
  capture/file.ts files them under.
- `prep.starting` (prep, which tells nothing itself): each minute,
  `work.prep.upcoming` for the next ten minutes; a meeting that begins
  within them is "Budget review starts at 2:00 PM" with its start as `by`,
  so it interrupts; `prep:<eventId>:<startsAt>`, the same on every host
  that holds the job, opening the meeting's page. Once it has begun it
  leaves the read, and its row and toast go (`prefix: 'prep:'`).
- `prep.ready` (prep): at digest time, a brief that is ready for a meeting
  in the next day, "Prep is ready for Budget review";
  `prep-ready:<eventId>:<day>`. It waits.
- `winvm`: a failure only he can fix, from `work.winvm.state` each 5
  minutes, under `winvm:`. Only a setup that failed before it made the disk
  (`none` with an `error`) is told, `winvm:setup`, its reason the detail,
  opening Settings → Work; a later setup step, a restore point and a wake
  that fail leave the same bare `error`, which the state does not place.

## The gate

`work/digest/gate.ts` `makeGate`, handed to the notifier
(`Notifier.setGate`) at the first look that finds it (the notifier is built
late in boot) and taken away when Work goes off. For a root Work thread
that started on its own, `finished`, `failed` and `stuck` are not sent:
each becomes a tell (`routines.done`, `routines.failed`, `routines.stuck`,
key `thread:<id>`, `open: {thread}`, the title the thread's and the detail
the notice's body), group `results`.

- "On its own" is a thread with a `routineRunId` whose run he did not
  start with Run now, or one in `work_digest_quiet` (`ctx.tell.quiet`). The
  cause of a run is read through the routines module's own methods
  (`runPressed`: `work.routines.list` for the thread's workspace, then
  `work.routines.runs` a routine, each run asked once), so the gate
  answers a promise; `RUN_NOW_CAUSE` is the engine's own word and a test
  holds the two together.
- A thread he has typed in himself is his own from then on
  (`writtenByOwner`): its notices go as any thread's.
- `needs_you` passes: a question or an approval reaches him at once with
  Allow and Deny (`ROUTINE_ASKS_WAIT` in rule.ts flips that). A held act's
  notice is the Outbox's own tell and passes.
- A code thread, a subagent and a thread he started by hand are never
  touched. When a run's cause cannot be learned the notice goes through.
  With Work off, or no gate set, the notifier is as it was.

## What the Outbox tells

docs/agents/work-outbox.md "How he is told": `outbox.held` (waits unless
its kind has a clock, `ActKindDef.by`), `outbox.failed` (interrupts while
fresh), `outbox.offer` (waits), kept in step by `ctx.tell.only`.

## Tonight's builds

As found on master at 06:00 EST on 2026-11-23. Clashes (`clashes.new`,
`by` only for a clash today) and money (`money.confirm`) tell for
themselves, with their kinds listed. Review tells `review.ready` with no
target and lists no kind: the digest gives it both. Prep hands a read: the
two sources above. Messages was not on master; `messages.new` is given its
group for when it lands.

## The swap for Today

The day's notice opens Today once Today is there, else the digest's own
list (`digestOpens` in DigestHost.tsx): the page registered in
`digestOpensPort` (src/renderer/src/lib/workSwitch.ts), else Today itself
once its row is on the rail (`workPlaceRow('today')`), else the sheet.
Today reads each pillar itself and does not draw `work.digest.list`. What
no section of Today reads, the digest adds through Today's own seam:
`src/renderer/src/work/digest/today.ts` is a `TodaySource` with no section
of its own, listed in `TODAY_SOURCES`; its rows go in Today's `also`
section, from today's digest and what was told since, in the groups
`results`, `ending` and `system` and a guest's edit, less what Money shows
itself (`money.confirm`); each row's press is the tell's own target
(`openTell`). The sheet stays as the record of earlier days, opened from
Settings and Go → Digest. Today has no phone page, so the phone keeps its
own screen.

## Proofs

- `bun scripts/proof-bun.ts scripts/proof-digest.ts`: in process, a made-up
  Monday across two jobs through the real notifier, gate, deliverer,
  ledger, Outbox tells and lapses source: two held items wait, an invite
  for 9:30 the next morning interrupts on its thread, a routine's run that
  ends is kept from the phone while his own thread's Done goes, a sign-in
  on its last day interrupts as a notice with no thread, and at 8:00 one
  digest goes out for three things in two jobs; never twice.
- `env -u ELECTRON_RUN_AS_NODE bun scripts/e2e-work-digest.ts --out <dir>`
  (after `electron-vite build`): an isolated instance under xvfb, a fake
  add-on whose calls are held, the digest set a minute ahead: the day's
  toast, the list, a row's press landing on that item in the Outbox, a
  failed send interrupting, the Settings section; pictures in dark and
  light.
