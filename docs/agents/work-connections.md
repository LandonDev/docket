# Work: Connections

Work leans on many sign-ins and helpers spread over the box and his Mac.
Connections is the one place that says which of them work: a Settings page
in the Work group, and a read-only tool a thread reads the same rows with.

## What he sees

**Settings → Connections** (src/renderer/src/work/connections/, its own lazy
chunk `work-connections`, listed in the Work group after the Work page only
while Work is on for some host).

- One section per kind of connection, in the order the rest leans on them:
  LifeOS, Mail and calendar, Google, Office, Files, Browser, Windows VM,
  Work service, Tools, Frame.io (`GROUP_ORDER`, model.ts). A group the page
  does not know follows, in the order it came.
- Each row: what it is, then its state as a `StatusMark` with this page's
  word (Working: the muted check; Needs you: amber; Broken: red) and one
  line after it, then when it lapses ("Ends Feb 17, 2027, 1:22 AM": US
  words, local time, "today" and "tomorrow" by the calendar) and the fix.
  No line says more than one thing.
- A row the pillar marks `shared` (a LifeOS source or a Google consent,
  which every signed-in host reads the same from LifeOS) is shown once when
  two hosts give it alike. A host's own row is never folded, nor one with a
  fix, whose press belongs to its host. A title two hosts both give is told
  apart by its host ("LifeOS on Mac"), and only then.
- The Office add-in's row is the add-in's own control (`AddinRow`): Pair…
  and each paired add-in with Remove live here and nowhere else.
- A host this window is not linked to now sits under **Hosts** as Offline
  ("Checked when it is back"), never as broken, and is checked the moment
  its link opens. A host that refuses (Work off there, an older build) is
  "Did not answer" with its reason and Retry.
- **Check again** (the page's one ghost verb) runs every linked host's
  checks again. The checks run when the page opens and on that press; never
  on a timer. While a host checks again its rows stay where they are.
- The fix is the button at the row's end: raised on a row that needs a
  press, ghost on a row that works (Sign out). What he must do by hand is
  said in the line, with no button.

**What left Settings → Work.** "Where it runs" gave way to Connections: each
host's LifeOS sign-in, the conversion tools (ToolchainRow, removed) and the
Office add-in's pairings are on Connections now, so no fact is said on both
pages. The Work page keeps what he sets: the switch, the sectors LifeOS has
(shown while signed in), models, where new Work workspaces are made, which
folders count as Teams files, guest links and mail settings. With Work off,
a Connections page left open says "Work is off".

## The frame's side

One optional field on the module, two core reads and one frame tool
(src/main/server/work/health.ts, src/shared/work/health.ts):

- `WorkModule.health?: { check(ctx, signal): Promise<HealthRow[]>; lapses?(ctx): Lapse[] }`.
  `check` runs only when the page opens, on Check again, or when a thread
  reads `work_connections`. It must be cheap; it never signs in, sends,
  launches, starts, installs or changes anything; it starts no poller. A
  row for what this host does not have (Office on the box) is left out, not
  reported broken. A signed-out LifeOS gives one needs-you row, not a
  broken row for everything that depends on it.
- `HealthRow`: `id` (`<pillar>.<thing>[:<which>]`), `pillar`, `group`,
  `title`, `state` (`working`, `broken`, `needs-you`), `line?`, `fix?`,
  `until?` (epoch ms), `sector?`, `shared?` (every host answers alike),
  `personal?` (it names his accounts, tenants or folders and has no one
  sector). No row carries a password, a token or a cookie's value: it says
  signed in or not, and as whom; and the frame blanks whatever looks like
  one in any line (`redactLine`: a JWT, a bearer token, a LifeOS token, a
  token or code in a query), whichever pillar wrote it.
- `HealthFix`: `run`, `open` (an https page in his browser) or `page`, and
  only from short lists (`fixAllowed`): a `run` names one of
  `HEALTH_RUN_METHODS` (today only `work.lifeos.signOut`), a `page` one of
  `HEALTH_PAGES` (`lifeos-sign-in`, the LifeOS sign-in dialog for that
  host, or a Settings page). The host drops any other fix from a row
  (`cleanRow`) and the page never carries one out (`usableFix`): nothing
  that sends, grants or turns Work off is ever a fix.
- `work.health` (read) answers `HealthReport {host, at, rows}`: every
  pillar's check at once, each held to `HEALTH_CHECK_MS` (10 s); a check
  that throws or runs out of time is one broken row ("Did not answer: …"),
  and a pillar that did not load is one too. Each row is cut to one line
  and to its declared fields (`cleanRow`). Refused while Work is off.
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

A row with a known end shows the date. The window asks each linked Work
host `work.lapses` once its link opens and every six hours while Work is on
(`LapseNotices`, mounted by WorkRailHost; a local read, it costs nothing),
and raises a toast 14 days before an end and again the last day
(`LAPSE_NOTICE_DAYS`, `lapseStage`): "Windows evaluation: Ends Feb 17, 2027, 1:22 AM",
with Connections as its action. Each stage is said once per window
(localStorage `work.lapsesNoticed`, keyed by host, id, end and stage); a new
end date is a new lapse.

Known ends today: the Windows evaluation (2027-02-17, from the browser
pillar) and a Frame.io sign-in with no refresh token. LifeOS device
sessions have no end to read.

## Each pillar's rows

| Pillar | Rows | Where |
|---|---|---|
| lifeos | `lifeos.signin` (Sign out working; Show code… pairing; Sign in… signed out or refused; broken with no button while unreachable, since the session retries by itself), `lifeos.key:<workspace>` (a sector key that failed), `lifeos.answers` (`health:ping` failed), `lifeos.source:<id>` per enabled email, gcal or ics source (error, never synced, or no sync for 6 h is broken; group Mail and calendar; carries its sector) | lifeos/health.ts |
| google | `google.clientId` (the Picker's client id, Mac and Windows only), `google.consent:<account>` (Drive files allowed, else reconnect in LifeOS) | google/health.ts |
| guests | `guests.service` (the Work service answers on its port), and on the box `guests.hosted` and `guests.links`: one GET each through the tunnel to `/w/hosted/` and a guest page, working only on a 200 carrying the service's own headers | guests/health.ts |
| frameio | `frameio.signin` (as whom; ran out; never used here gives no row) | frameio/health.ts |
| office | on a Mac or Windows host: `office.app:excel`, `:word`, `:powerpoint`, `:outlook` for each installed app (Open or Closed; Outlook as whom, from the route's accounts; Automation refused says where to allow it; New Outlook is needs-you, since it cannot be scripted and so cannot send for a workspace), `office.addin` (paired or not; on the page it is `AddinRow` itself; whether it is sideloaded is not read, since that lives in each Office app's own container and reading another app's container raises macOS's "access data from other apps" prompt), group Files: `office.files.onedrive` (installed and running stands in for syncing) and `office.files.folder:<id>` for a folder he added that is gone | office/health.ts |
| browser | on the box: `browser.box` (its Chromium), `browser.video` (live video on, off, or needs the screen relay), `browser.site:outlook` (Outlook on the web signed in, judged by the names of Microsoft's session cookies alone, the store always opened immutable, which takes no lock), and group Windows VM: `browser.winvm.machine` (the standing machine's disk and its QEMU process) and `browser.winvm.evaluation` (its end: `base/READY`'s build time plus 90 days, 2027-02-17; also its `lapses`) | browser/health.ts |
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
