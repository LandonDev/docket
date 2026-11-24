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
- A kind the digest tells for a pillar that hands a read, not a tell (its
  gate and its sources), is listed on the digest's own module
  (`DIGEST_TELLS` in rule.ts).
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
| `work.digest.get` | read | `{at, zone, levels, nextAt, setAt?}` (`setAt`: when each field, the time and a group each, was last set on this host; the phone's schema leaves it out) |
| `work.digest.set {at?, levels?, setAt?}` | admin | the settings. `setAt` names when each field in the write was set, for a write that brings a host to what another holds: the host stamps the field with that time and leaves alone one it holds a newer setting of |
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
  ends today". Each title is cut to 60 characters before they are joined
  and what still does not fit is counted ("; and 2 more"), so one long
  title never crowds another out (`nowLine`); the one that could not wait
  just now is named first. One open: the title is the
  job, the body the row's title with its detail on a line of its own (never
  joined by a colon: `rowLines` in words.ts, kept as two lines by
  `Notifier.work`), and `work.open` is the row's own target. More: the tap
  opens the list.
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
| `store.ts` | each Work host's ledger and settings, asked when its link opens and kept by the `work.digest` push; `mergeRows` (one row a key across hosts, the one told at once winning), `mergeDays` (hosts' days of one date are one, seen once any is); `markSeen`, `setDigest` (written to every Work host); the settings shown are each field's newest across the hosts (`newestSettings`), and after a host is read the fields it missed are written to it, each stamped with when it was set (`staleSettings`, `align`: never under a write of his own, never on a push, and a field no host says when it was set is left alone), so two changes that reached different hosts both stand, and an older stamp is repaired though the value already matches (going back to an earlier choice is a new edit); `hostsHold` ends a row's refusal line once each host that refused is known to hold what he asked for; `openDigestSheet`; sends `work.digest.here` |
| `notice.ts` | pure: `digestNotice` (the unseen days and their line: what waited when each day was made on the row's own host, a row whose clock came due later included; a thing done since is gone from it, as from the list), `onlyToday`, `openInterrupts` (told, a day old at most, not closed here), `nowToasts` (one a row, a fold past three), `systemNotices`, `listSections`, `rowWhen`, `emptyLine`, `unansweredLine`, `refusedLine` |
| `open.ts` | pure: `routeOf` turns a `TellOpen` into a route (`thread`, `view` with `at` in that view's own field, `place`, `outbox` with the page's item key, `settings`), `go` runs it |
| `DigestHost.tsx` | the two toasts through `useToastSync`, their system notifications, the routes, the sheet's mount |
| `DigestSheet.tsx` | the list (`DigestList`) in a 480px `Sheet` |
| `SettingsSection.tsx` | Settings → Work → Digest |

- The digest's toast opens `digestOpensPort.get()` when one is registered
  (Today) and the one unseen day is today (`onlyToday`: Today shows that
  day alone); with an older day unseen too it opens the sheet, which holds
  every day. Opening or closing it marks every unseen day seen on every
  host that holds it, so each window's toast goes with the push. A mark
  whose host did not answer (its link was down) is kept in localStorage
  (`work.digest.seen.pending`), read as seen meanwhile and said again when
  the link opens (`sendSeen`, `seenHere` in store.ts): a lost connection
  never brings back a notice he closed.
- A toast is drawn again only when its words change, so its Open and its
  close read what it stands for at the press (`live` in DigestHost.tsx):
  the same words may have come to mean another telling of a thing, or
  another host's row of the same day.
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
  across windows, and again when its words change (`noticeStep`); the body
  keeps two lines, a thing's title and its detail, and the fold's names
  every open one (`nowLine`, newest first). Whether it sounds is the
  window's to say: a notice sounds only when it holds a telling not heard
  before (`heard` in DigestHost.tsx, `systemNotices`), so a thing that
  joins the fold sounds, while a fold that loses a thing, or breaks up
  into things he heard one by one, is shown again quietly; a thing told
  more than a minute before the window opened is not news to the ear
  either. A key is the window's own name for a
  notice and comes back on the click: main keeps it whole, never cleaned
  or cut. Every window asks for the same keys, so main keeps
  who asks (`Claims`): a window that lets go or closes takes a notification
  back only once no other window still asks for it. A click brings a
  window that asks forward and sends `app:notice-open {key}`. The renderer reaches it through
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

## The phone

The phone reads every Work host's ledger and merges them by the desktop's
rules; nothing about the wire is the phone's own.

- **Contract.** `scripts/gen-swift-contract.ts` carries `work.digest.list`,
  `get`, `set` and `seen` and the `work.digest` push (`WorkDigestPush` in
  `ServerPush`), with `TellGroup`, `TellLevel`, `TellRow`, `DigestDay` and
  `DigestSettings` named. The zod for them is in `src/shared/wireSchemas.ts`
  (`TellRowPhoneSchema`, `DigestListPhoneSchema`, `WorkDigestPushSchema`, …).
  A tell's `open` is one flat `TellOpen` struct on the phone, every field
  optional, so `{held, thread}` is never read as a bare `{thread}`; its pin is
  `Reads`. The phone sends no `work.digest.here`: the zone is a desktop's.
- **Model.** `ios/TempCodeClient/Sources/TempCodeClient/Work/Digest/`:
  `DigestModel` is pure (the desktop's `mergeRows`, `mergeDays`,
  `listSections`, `rowWhen` and `emptyLine`; `seenCalls`; `route`, what a
  row opens; the Settings words); `WorkDigest` is one host's ledger on
  `WorkHost.digest`, read when the Digest first opens, kept by the push after
  that, read again when a day is made, cleared when Work goes off.
- **Screen.** `ios/TempCode/Sources/Work/Digest/DigestScreen.swift`,
  `Route.digest` (a sidebar list). Title "Digest"; "Since the digest",
  "Today, 8:00 AM", "Yesterday", then dates; a row is the job's dot (a muted
  ring for no one job), the title, the detail, the time: "by 2:00 PM" for a
  row whose clock was still ahead when it was told and its words do not
  already say (a failed send's clock is its failure: no "by"), else when it
  was told; a clock ahead names a day that is not today ("Nov 26, 2:00 PM"),
  a told time names its day only when it is not the day of the row's heading
  ("Sun 9:14 PM" under "Yesterday", "7:01 AM" for that morning;
  `DigestModel.Section.day`, `when(…, day:)`). A row is a button only where the phone has a route: a
  thread, a held item (over the Outbox) or a Work view it draws (mail, tasks,
  agenda, projects, routines). The rows' shape while reading; one line,
  "Nothing Since Oct 24", when empty; VoiceOver says a row's job before its
  title (`DigestModel.spoken`); "The Mac did not answer" at the foot for a host whose
  read failed. Opening it sends `work.digest.seen` for every day no host has
  seen, to every host that holds it. Home has a **Digest** row after the
  Outbox, with no count, while any host has Work on.
- **A tap on a notice.** `PushTarget` reads `tc.work` (Push/PushTarget.swift,
  `route`): `{key, digest}` opens the Digest; `{key, tell, open?}` opens a held
  item, then a Work view the phone draws, then a thread, each on the notice's
  host (`tc.environmentId`), and the Digest for anything else or no `open`.
  `NavigationRouter.open` takes `target.route`. In the foreground a Work notice
  is a banner, or the list alone while the Digest is on screen. Through the
  hub `tc.work` is lost and the notice has no thread: a tap opens the app.
- **Settings → Work.** A Digest section follows the group with the Work
  switch and LifeOS (the first host with Work on, once for every host), and
  shows only while some host has Work on: Time (a time picker of the "HH:mm"
  wall time, written once the wheel rests), Held items, Routine results,
  Messages and mail, Meetings (the desktop's `SETTING_GROUPS`), each "In the
  digest", "When it can’t wait" or "Right away". A change goes to every host with Work on as
  `work.digest.set` with only that group in `levels`; a host that refused is
  that row's red line.
- **Tests.** `DigestModelTests.swift`, `PushTargetTests.swift` and
  `ShellPathsTests.swift` in the client package. The simulator proof is
  `TC_PROOF_SET=digest bun scripts/ios-sim-proof-local.ts` on the Mac: the
  set runs scripts/lib/ios-digest-seed.ts between its shots (Work on and the
  empty Digest; the work set's seeds, a Cosmic job and tells written into the
  ledger by the test server's `POST /work-tells`; the digest's time set one
  minute ahead so the host's own look makes the day; two tells after it),
  then shoots Home, the Digest, Settings → Work and four notices, each the
  host's exact `tc.work` payload handed to the delegate by the
  `TC_TEST_ROUTE=payload` launch route (`TC_TEST_PAYLOAD`), light and dark.
  `xcrun simctl push` is not used: the simulator refuses it until someone
  allows the app's notifications by hand.

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

As found on master on 2026-11-23. Clashes (`clashes.new`, `by` only for a
clash today), money (`money.confirm`), review (`review.ready`, its page
and week as the target) and messages (`messages.new`, the conversation as
the target) tell for themselves, each with its kind listed on its own
module. Prep hands a read: the two sources above.

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
`results`, `ending` and `system` and a guest's edit, a receipt to confirm
(`money.confirm`) among them, since Money's section on Today lists only
what is owed; each row's press is the tell's own target
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
  toast, Today opened by its press (the swap), the list opened from
  Settings, a row's press landing on that item in the Outbox, a failed
  send interrupting, the Settings section; pictures in dark and light.
