# Work: Connections

Work leans on many sign-ins and helpers spread over the box and his Mac.
Connections is the one place that says which of them work: a Settings page
in the Work group, and a read-only tool a thread reads the same rows with.

## What he sees

**Settings → Connections** (src/renderer/src/work/connections/, its own lazy
chunk `work-connections`, last in the list's Work group, shown only while
Work is on for some computer).

- One section per kind of connection, in the order the rest leans on them:
  LifeOS, Mail and calendar, Google, Office, Files, Browser, Windows VM,
  Work service, Tools, Frame.io (`GROUP_ORDER`, model.ts). A group the page
  does not know follows, in the order it came.
- Each row: what it is, then its state as a `StatusMark` with this page's
  word (Ready: the muted check, since "Working" is a running thread; Needs you: amber; Broken: red) and one
  line after it, then when it lapses ("Ends Feb 17, 2027, 1:22 AM": US
  words, local time, "today" and "tomorrow" by the calendar) and the fix.
  A row that ends on a date is a `PageRow wide`: under 480px of page its
  date and fix take a line under the words, which keep their room.
  The window also words a sync or a lost connection's time from the row's
  instant, such as "Synced 2:14 PM".
- A row the pillar marks `shared` (a LifeOS source or a Google consent,
  which every signed-in host reads the same from LifeOS) is shown once when
  two hosts give it alike. A host's own row is never folded, nor one with a
  fix, whose press belongs to its host. A title two hosts both give is told
  apart by its host ("LifeOS on Mac"), and only then. A group whose one
  row has the group's own name (Frame.io, Windows VM) has no heading over
  it. The Work service and its hosted pages sit under **Hosting**, so
  neither repeats the heading.
- A row's state line wraps in a narrow window: the line after the word is
  the fix he needs, so none of it is cut.
- The Office add-in's row is the add-in's own control (`AddinRow`): Pair…
  and each paired add-in with Remove live here and nowhere else.
- A computer this window is not linked to now sits under **Computers** as Offline
  ("Checked when it is back"), never as broken, and is checked the moment
  its link opens. A host that refuses (Work off there, an older build)
  did answer: it is "Not checked" with its reason in his words
  (`workErrorWords`) and Retry; only one that ran out of time is "Did not
  answer", with no reason after the word, which would only say it again
  (`checkFailure`). That Retry has the LifeOS rows' weight (secondary); while
  its check runs the row stays as it was and its Retry spins, not Check
  again, and the answer's cause replaces the reason.
- A LifeOS row that names a down state (`HealthRow.lifeos`) is worded by
  the window in the rule's words, its computer named (`lifeosLine`): "Not
  signed in to LifeOS on the box", "The LifeOS sign-in on the box waits for
  your approval", "LifeOS refused the box's sign-in", "LifeOS is still
  connecting on the box", "LifeOS did not answer the box. Still trying since
  2:02 PM" on the sign-in row, "LifeOS did not answer Mac" on LifeOS answers.
  Once the page lists more than one host every LifeOS row names its
  computer once: in that line, else in its title ("LifeOS on Mac", "Agents'
  LifeOS keys on Mac"). A host a build behind names no state: its own line
  stands. LifeOS answers' row has Retry, which checks that host again alone,
  spinning while the check it began runs (off, not spinning, while Check
  again or a check the page runs by itself asks that host: `HostView.by`
  names the press, and only that button spins); the sign-in row keeps Sign out, with that Retry before it when the host says LifeOS is
  unreachable. While a host does not answer its check (and while it is asked again after that), its rows of
  LifeOS's silence are not drawn as they were: LifeOS answers goes, and the sign-in row keeps its Sign out with no
  line or Retry; the Hosts row says the silence with the one Retry (`PlacedRow.hushed`).
- **Check again** (the page's one ghost verb) runs every linked host's
  checks again. The checks run when the page opens and on that press, and a
  host's checks run again when its LifeOS state changes (its `work.lifeos`
  push: a sign-in approved, LifeOS back), so a LifeOS row is true again with
  no press; never on a timer. While a host checks again its rows stay where they are.
  With no host linked it is off, and each host's row says Offline.
- The first check draws a section in bones: its heading over six rows
  from a sample, each a title and its state line, with no press, so the
  first section lands where they stood; the page's chunk draws the same
  bones while it loads (`FirstCheckBones`, which also holds the rows'
  `STATE_LINE`).
- The Office add-in's row is drawn unpaired at rest while its list is
  read; its pairing dialog holds the code's 24px line with a sample code in
  bones while the code is asked for. Its failures, and the Teams copy
  switch's, are said through `hostFailure`, never the link's text.
- The fix is the button at the row's end: raised on a row that needs a
  press, ghost on a row that works (Sign out). What he must do by hand is
  said in the line, with no button. A fix this window's key may not run on
  that host (`fixMethod` and `linkMay`: LifeOS's Sign in and Sign out on a
  given computer) is not drawn; on a row that needs him, a line under its
  state says who can, by the act ("Sign in from a computer that manages the
  box", `signInElsewhere`; else `managedElsewhere`).

**What left the Work page.** "Where it runs" gave way to Connections: each
host's LifeOS sign-in, the conversion tools (ToolchainRow, removed) and the
Office add-in's pairings are on Connections now, so no fact is said on both
pages. So are the Windows VM's Office and OneDrive sign-ins and its edition's
end: the Windows VM's own page under Other computers holds none of them. A
sign-out asks first, naming what stops working until the next sign-in
(`signOutAsk`), as does a paired add-in's Remove…. What he sets lives on the
other Work pages (docs/agents/settings.md "The pages: Work"). With Work off,
a Connections page left open says "Work is off".

## The frame's side

One optional field on the module, two core reads and one frame tool
(src/main/server/work/health.ts, src/shared/work/health.ts):

- `WorkModule.health?: { check(ctx, signal): Promise<HealthRow[]>; lapses?(ctx): Lapse[] }`.
  `check` runs only when the page opens, on Check again, when the host's
  LifeOS state changes while the page is open, or when a thread reads
  `work_connections`. It must be cheap; it never signs in, sends,
  launches, starts, installs or changes anything; it starts no poller. A
  row for what this host does not have (Office on the box) is left out, not
  reported broken. A signed-out LifeOS gives one needs-you row, not a
  broken row for everything that depends on it.
- `HealthRow`: `id` (`<pillar>.<thing>[:<which>]`), `pillar`, `group`,
  `title`, `state` (`working`, `broken`, `needs-you`), `line?`, `fix?`,
  `at?` (epoch ms to append to the line), `until?` (epoch ms), `sector?`,
  `shared?` (every host answers alike),
  `personal?` (it names his accounts, tenants or folders and has no one
  sector). No row carries a password, a token or a cookie's value: it says
  signed in or not, and as whom; and the frame blanks whatever looks like
  one in any line (`redactLine`: a JWT, a bearer token, a LifeOS token, a
  token or code in a query), whichever pillar wrote it.
- `HealthFix`: `run`, `open` (an https page in his browser) or `page`, and
  only from short lists (`fixAllowed`): a `run` names one of
  `HEALTH_RUN_METHODS` (`work.lifeos.signOut`, `work.office.live.signOut`)
  and keeps a few short words as its params (`fixParams`: Office's Sign out
  names its tenant; nothing nested or long rides a fix), and one in
  `HEALTH_OWN_COMPUTER` is offered only in a window on the row's own
  computer, where alone the host runs it (`usableFix(fix, own)`); a `page` one of
  `HEALTH_PAGES` (`lifeos-sign-in`, the LifeOS sign-in dialog for that
  host; `windows-vm-sign-in`, OneDrive's sign-in brought up on the Windows
  VM that host keeps, `work.office.vmSignIn`, then the Computers page on
  `vm:windows`, where he finishes it in a Take over; or a Settings page).
  A row whose fix is that sign-in carries
  `{kind: 'page', label: 'Sign in…', page: 'windows-vm-sign-in'}`. The host drops any other fix from a row
  (`cleanRow`) and the page never carries one out (`usableFix`): nothing
  that sends, grants or turns Work off is ever a fix.
- `work.health` (read) answers `HealthReport {host, at, rows}`: every
  pillar's check at once, each held to `HEALTH_CHECK_MS` (10 s); a check
  that throws or runs out of time is one broken row ("Did not answer: …"),
  and a pillar that did not load is one too. Each row is cut to one line
  and to its declared fields (`cleanRow`). Refused while Work is off.
  Asks that come together run each check once, and a report answers the
  next ask for `HEALTH_KEEP_MS` (10 s) with no check run again (two
  windows' Connections pages, a toast's look and a thread's tool each ran
  every check before: 9.7 s once on the live box). `{fresh: true}` is his
  own Check again and runs them anew; Work turned off drops the report.
- `work.lapses` (read) answers `Lapse[]`, soonest first, from each
  pillar's `lapses`, which is synchronous and reads only what the host
  holds (no network, no child process).
- `work_connections` (read-only, every Work thread, Claude, Codex and Muse
  alike): this host's rows, then each linked host's over the host link
  (`deps.peers`, `work.health` on that host); a host whose link is down is
  "offline (not checked; offline is not broken)"; a cancel stops the wait.
  A thread of one sector reads no other sector's rows, and a `personal` row
  of no sector only as its group and state (`rowsForSector`), so no Purdue
  address reaches a Cosmic thread; a Work Chat reads every sector, as its
  key does. Rows come worst first, with the fix he can press.

## Things that lapse

A window words `at` and `until` in its own zone. The `work_connections`
tool uses `hisZone(ctx)` and names the zone when it gives a time of day.

A row with a known end shows the date. The host tells him before it ends,
through the digest (docs/agents/work-digest.md, the `lapses` source in
work/digest/sources/lapses.ts): each six hours and at start it reads
`lapsesOf(ctx, WORK_MODULES)`, and by the stages in `LAPSE_NOTICE_DAYS`
(`lapseStage`) tells "Windows evaluation ends Feb 17" fourteen days before,
which waits for the day's digest, and "Windows evaluation ends Feb 17 at
1:22 AM" on the last day, which carries its end as its clock and so
interrupts, on the desktop and on the phone. A press opens Connections, on the phone too (M5b: a place of the
Work list's foot while a row does not work or an end is near; each row that does not work offers "Open on
<computer>", `work.reveal`, since every fix works in that computer's own window). A
new end date is a new lapse; one renewed or gone takes its rows with it.
The window's own toast (`LapseNotices`) is gone: `work.lapses` is still
answered for a client that wants the list.

Known ends today: the Windows evaluation (2027-02-17, from the browser
pillar) and a Frame.io sign-in with no refresh token. LifeOS device
sessions have no end to read.

## Each pillar's rows

| Pillar | Rows | Where |
|---|---|---|
| lifeos | `lifeos.signin` (Sign out working; Show the code pairing; Sign in signed out or refused, the names every reader gives them; Sign out while connecting or unreachable, since the session retries by itself, and the window's Retry beside it when unreachable), `lifeos.key:<workspace>` (a sector key that failed), `lifeos.answers` (`health:ping` failed, or gave no answer in `LIFEOS_ANSWER_MS`, 6 s, under the frame's 10 s: "LifeOS did not answer", the sign-in row kept; its Retry asks that host again). Both carry the session's state by name (`HealthRow.lifeos`); their lines name no computer ("Not signed in to LifeOS"), since a thread reads them under its host's name and the window names it, `lifeos.source:<id>` per enabled email, gcal or ics source, titled by its name and what it is ("Cosmic mail", "landon@cosmic.games calendar"; group Mail and calendar; carries its sector). An error is broken; idle with a reason (disconnected) needs him. Silence is judged as LifeOS's own health rule judges it (`SOURCE_SILENT_MINUTES`), by when it last checked in and only for a kind that checks in on every poll: mail after 10 minutes, an ICS feed after a day and an hour (`SOURCE_SILENT_MS`). A Google calendar reports only when its state changes, so its times say when LifeOS's worker last started: it is judged by its status and error alone | lifeos/health.ts |
| google | `google.clientId` (the Picker's client id, Mac and Windows only), `google.consent:<account>` (Drive files allowed, else reconnect in LifeOS) | google/health.ts |
| guests | `guests.service` (the Work service answers on its port), and on the box `guests.hosted` and `guests.links`: one GET each through the tunnel to `/w/hosted/` and a guest page, working only on a 200 carrying the service's own headers | guests/health.ts |
| frameio | `frameio.signin` (as whom; ran out; never used here gives no row; no fix, since no page signs Frame.io in yet and Connections is where the row stands) | frameio/health.ts |
| office | on a Mac or Windows host: `office.app:excel`, `:word`, `:powerpoint`, `:outlook` for each installed app (Open or Closed; Outlook as whom, from the route's accounts; Automation refused says where to allow it; New Outlook is needs-you, since it cannot be scripted and so cannot send for a workspace), `office.addin` (paired or not; on the page it is `AddinRow` itself; whether it is sideloaded is not read, since that lives in each Office app's own container and reading another app's container raises macOS's "access data from other apps" prompt), group Files: `office.files.onedrive` (installed and running stands in for syncing) and `office.files.folder:<id>` for a folder he added that is gone; on the host that keeps the Windows VM, once it has been read: `office.vm.onedrive` (group Files: signed in as whom and how many Teams libraries, or Signed out with Sign in…, the page `windows-vm-sign-in`) and `office.vm.office` (group Office: the apps and who is signed in, or "Sign in to finish" with the same press), from what was last read while it was awake, never waking it | office/health.ts |
| browser | on the box: `browser.box` (its Chromium), `browser.video` (live video on, off, or needs the screen relay), `browser.site:outlook` (Outlook on the web signed in, judged by the names of Microsoft's session cookies alone, the store always opened immutable, which takes no lock), and group Windows VM: `browser.winvm.machine` (the standing machine's disk and its QEMU process) and `browser.winvm.evaluation` (its end: `base/READY`'s build time plus 90 days, 2027-02-17; also its `lapses`) | browser/health.ts |
| msforms | on the host whose box browser carries Forms (`msCarrier()`), group Browser: `msforms.signIn` "Microsoft Forms", signed in as whom the most recent read of a form saw (`signed_in_as`, newest `read_at`), "No form read yet" before one, or needs-you with the box browser's own line (`BOX_SIGN_IN`) once a read met Microsoft's sign-in (answers/read.ts `signInNeeded`); none on a host with no carrier. A Microsoft form opened in a Files tab shares its tenant's live session with Word and Excel, so the office row `office.live:<tenant>` is titled "Office and Forms for the web, <tenant>" | msforms/health.ts, office/live/health.ts |
| formats | `formats.toolchain` (what ToolchainRow said: the base tools by name, the pillars' tools counted) and `formats.tool:<name>` for each that did not install or lost its files, naming `bun scripts/work-tools/install.ts --only <name>` | formats/health.ts |

Nothing of these launches an app, starts the browser or the VM, or runs the
installer: the line says the step, since no Work method does it. On Windows
the Office rows read the disk and one `tasklist`, never the Office helper
(which would start, and first compile, its own process).

## Proofs

- `src/main/server/work/health.test.ts`: the gather (one line, a throw,
  a timeout, a pillar that did not load), lapses, the tool's text and its
  sector fence, and the mount (`work.health`, `work.lapses`, the tool
  reading a linked host and an offline one).
- each pillar's `health.test.ts`.
- `src/renderer/src/work/connections/model.test.ts` (sections, the twin
  rows, the host in a title, fixes the page refuses, the notices' stages)
  and `ConnectionsPage.dom.test.tsx` (checks on open, Offline, a fix's
  press and the re-check, a host that refuses).
- `bun run ui:preview src/renderer/src/work/connections/ConnectionsPage.preview.tsx#ConnectionsPreview`.

## Not proven

No check has run against the live LifeOS, the live tunnel, a real Mac's
Office or the box's browser: every test uses fakes. landed/F-connections.md
lists what the owner should look at first.
