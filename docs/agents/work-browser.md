# Work: the live browser, portals and Teams

Milestone 37 of the Work plan. The browser canvas shows computer use on the
owner's Mac at full size beside a Work thread: he watches, takes over and
hands back; a submit waits on its final screen for his press; the page's
values sit under it beside where each came from; and a Teams reply is held
until he presses Post. [work.md](work.md) says how a pillar registers;
[work-outbox.md](work-outbox.md) is the hold this builds on.

## What is whose

- **The picture** is computer use's own live stream, the one the right
  panel's Computer section draws (`useComputerSection`, `useLiveStream`,
  `computer.preview.*`; [computer-use.md](computer-use.md) "What the person
  sees"). Only a Mac's own desktop draws it; elsewhere the canvas shows the
  held page's picture (`work.outbox.get`) or one line.
- **A submit** is the computer hold's live item (`computer.act`, milestone
  10): the host reads the click on "Submit" as outward, whatever the model
  flagged, and keeps it with the window's picture and the fields' text. This
  pillar adds no hold and no flag of its own. The canvas finds the newest
  waiting `computer.act` of the pane's tree held in a browser
  (`BROWSER_BUNDLES`; a Send kept in Mail stays the Outbox's) and presses it with
  `work.outbox.send`; the press runs it once, only if the window still holds
  what he was shown. `portal.submit` stays in `ACT_KINDS` unregistered: the
  box's browser (milestone 38) did not need it, since its submits are
  `computer.act` items held the same way (below).
- **Who drives, a page's need, the sources**: this pillar's one table,
  `work_browser_drive`, one row per pane thread (src/main/server/work/browser/drive.ts).
  The rows are about a screen on this host, so they do not ride a thread to
  another host.
- **`teams.post`**: this pillar's act kind (browser/teams.ts).

## The wire (src/shared/contract-work-browser.ts)

| Method | Cap | Answers |
|---|---|---|
| `work.browser.state {sessionId}` | read | `BrowserState`: `driver` (`agent` or `owner`), `needs`, `site`, `sources`, `since` |
| `work.browser.drive {sessionId, driver}` | operate | `BrowserState`; a `model` caller is refused (`NOT_A_PERSON`). Taking over or handing back clears `needs`. Handing back (owner → agent) wakes, once, with `HANDED_BACK` through `ctx.threads.resume`, the thread of the tree that last used a browser tool (a subagent, say), else the pane thread. Only a Work thread (`NOT_WORK`). |

Push: `{ push: 'work.browser', state }` on every change.

## The tools

All four are Work tools, keyed by the pane thread (`ctx.canvas.paneOf`), so a
subagent's browser shows in its root's pane.

- `browser_open {url, name, title}`: opens one `browser` item in the pane
  (source `{at: 'browser', host, sessionId: pane}`; a second call shows the
  same item), records the site (its address without query or fragment, so a
  sign-in link's code reaches no client), clears `needs`, and keeps the sources only
  while the agent stays on the same site (host). While he drives it answers `OWNER_DRIVES`.
- `browser_needs_you {needs}`: a sign in, a password, a second factor, a
  captcha. The bar turns amber with his words and Take over. The agent never
  types a password: in a Work thread text into a password field asks a card
  that cannot be approved ahead, and under Away it is denied
  (`CONFIRM_KIND_INFO.password`, `awayVerdict`; tested in browser.test.ts).
- `browser_sources {values: [{field, source}]}`: where each value came
  from, by the field's label; a field named again takes the newer source.
- `teams_reply {chat, text}`: holds a `teams.post`. Refused (`TEAMS_UNAVAILABLE`)
  on a host with no Teams carrier, before anything is held: the box, and
  any host without computer use (below).

## Teams

`teams.post` (payload `{chat, text}`, verb Post) takes no grant: every reply
waits for its own press. On the press `execute` calls the carrier set with
`configureTeamsCarrier`; the carrier posts by computer use and answers a
picture of the posted message, which is kept at
`<dataDir>/work-browser/teams/<row id>.<ext>` (`postedPicturePath`). The
result's `ref` is `{ chat, picture: { mimeType, width, height } }`: the path
follows from the row and never leaves the host, a read key's list included.
Nothing serves the bytes to Sent yet. A
carrier that posted nothing throws `ActStale` (the item reads stale); any
other throw reads failed, "may or may not have gone". A host that lost its
carrier between the hold and the press reads stale.

**The carrier** (browser/teamsPost.ts) is set at boot by index.ts beside
the host's computer sessions, through a dynamic import (`wireTeamsCarrier`),
so a host with computer use (a Mac) posts and a host without it (the box)
refuses `teams_reply` before anything is held. On the press it runs on the
reply's thread's computer session, every acting step a `pressed` call (no
card, no second hold, and only if the window still holds what the step was
read against): bring Microsoft Teams forward; read it; click the one chat
named exactly as the reply says, counting a row and the text inside it as
one (none, or more than one: stale, nothing posted); read again; the one
message box, which must be empty (a draft of his: stale); type the reply
into it, a line break as Shift-Return (at most 9 lines), and Return; read
once more with a picture. A box that still holds the reply after the Return
reads failed. Proven on the fake computer service dressed as Teams
(teamsPost.test.ts), end to end from `teams_reply` through the press; not
against a live Teams.

## The canvas (src/renderer/src/work/browser)

The approved page is `.temp-code/prototypes/work-workspaces-2/browser.html`,
"Watch, and take over"; docs/DESIGN.md "Live browser" is the rule.

- **The tab row**: the page's title, then where it runs once (`shell.detail`:
  the Mac a box thread drives, else the thread's host by name).
- **The bar** (`barFaceOf` in portal.ts decides it): the site's host with a
  lock glyph, never a field; then one of: "The agent is driving" and Take
  over (secondary); the page's need in amber and Take over (primary); "You
  are driving" in foreground and Hand back (secondary); a held submit's
  Take over and Discard (ghost) and the one primary named for the act
  ("Submit in Concur"), never counting down; after it, "Submitted 2:14 PM".
  Take over first stops every live computer session of the tree on its
  host (`computer.stop`; drawable here or not, so the box desktop and the
  browser /ui stop it too), then sets him as driver. While he drives at a
  held submit the ghost beside the primary is Hand back, and his driving
  outranks the line after a press, so Hand back is never out of reach.
  While he drives, every computer call from the pane's tree (the thread and
  its subagents, on any turn: his own message, a decided act waking the
  thread) is refused with `OWNER_DRIVES` before it reaches the service, until
  he hands back. The gate is `configureOwnerDrives` in computer/run.ts, set
  by this module's `start`, and asked by `runComputerTool` here and by the
  box's `ComputerBridge` before a call goes to the Mac; the hold's own press
  is his and runs, and a gate that throws refuses nothing (F3).
- **The body**: the live window in its own shape, at most 720px wide, a
  skeleton until the first frame; at a held submit the values under it
  (label, value, source; the values are the host's read of the page's
  fields from the held row's `mark`, password fields never in it, and only
  the source is the agent's word).
- `bun run ui:preview src/renderer/src/work/browser/BrowserCanvas.preview.tsx#BrowserPreview --width 864`
  draws the six moments in both themes.

## The box's browser (milestone 38)

A real Chromium on the box, so a box thread can drive a website with no Mac
awake. The code is `src/main/server/work/browser/box/`; the protocol's
§28 is its wire.

- **One browser** (`chromium.ts`): headless, its own profile under
  `<userData>/work-browser/box/profile`, DevTools on 127.0.0.1 only, the
  sandbox on, never root. Started on first use; stopped after ten idle
  minutes, or when its whole process tree passes 2 GB (`/proc`, every 15 s),
  or when Work is turned off. It is not stopped for idleness while a held
  step waits on one of its pages (for a day at most), or while a page asks
  for him or he drives (two hours at most). A new start waits for the last
  browser to exit. The binary: `TEMP_CODE_BOX_CHROMIUM`, else `chromium` or
  `google-chrome` on PATH, else the newest Playwright download under
  `~/.cache/ms-playwright` (the box has `chromium-1248`).
- **The Linux service** (`service.ts`, `ax.ts`, `cdp.ts`): tc-computer's
  wire, answered for this browser over DevTools, run in the host's process
  behind a stdio pair (`inProcessSpawn`). One app, "Chromium"
  (`org.chromium.Chromium`), whose windows are its pages.
- **The tools** (`index.ts`): `box_browser_open`, `box_browser_observe`,
  `box_browser_act`, `box_browser_batch`: the four computer tools, renamed,
  run on computer sessions of the box's own (`wireBoxBrowser`, made by
  index.ts on a Linux host whose computer use is not local). Work threads
  get them only where the box has a Chromium. They refuse to act while he
  drives (`BOX_OWNER_DRIVES`, as the Mac's computer use refuses with
  `OWNER_DRIVES`, above).
- **What the service refuses**, so a step runs only as the hold read it
  (§28.4): a click on a control something else covers, a click into a
  frame not read yet or a plugin, a step by menu
  path, typing into something that takes no focus (never a click in its
  place), keys from the address bar into the page, and every page of his
  mailbox (`AGENT_CLOSED_HOSTS`: the imported sign-in serves every tab, and
  Outlook on the web acts on bare keys no hold reads). While he drives any
  page, no thread acts in the browser.
- **The hold** is run.ts's, unchanged: the host reads a Work thread's step
  on the screen (`readOutward`, with `org.chromium.Chromium` in
  `BROWSER_BUNDLES` so a mail or chat page's Return counts), keeps it as a
  live `computer.act` item, and carries it out on these sessions at his
  press. The canvas finds it as it finds a Mac browser's.
- **The canvas** opens for a box thread (`browser_open` is host-neutral)
  and draws the page live while the thread uses it: Chromium's screencast
  through the host's preview relay, built over the box's sessions by
  index.ts; the box's rows reach the desktop in the `computer` push, and
  Take over stops them (§28.5). A held submit shows its picture in the
  Outbox.
- **Frames** are read in place (§28.3): a portal that draws its form in a
  frame, of its own origin or another's, is read, filled, clicked and held
  like any page (`hold.test.ts`).

## Logins

The box never sees a password. Two ways in:

- **From his Mac** (`logins.ts`, `exportLogins.ts`): he runs
  `bun src/main/server/work/browser/box/exportLogins.ts > logins.json` on the
  Mac (`--sites a.com,b.com`; by default the hosts Outlook on the web needs,
  `OUTLOOK_SITES`). It reads Chrome's cookie store and asks his Keychain for
  "Chrome Safe Storage"; each value is decrypted and checked against its
  host's hash. He copies the file into
  `<userData>/work-browser/box/import/` on the box; the next use of the
  browser takes it in (`Storage.setCookies`) and deletes it, and a file that
  does not parse is deleted too.
- **When a site needs him**: the thread calls `browser_needs_you` and ends
  its turn. He signs in through the browser's DevTools: on the Mac,
  `ssh -L 9333:127.0.0.1:$(ssh box head -1 /srv/agents/temp-code-data/work-browser/box/profile/DevToolsActivePort) box`,
  then chrome://inspect, Configure, `localhost:9333`, and Inspect on the page:
  its screencast takes his clicks and typing. Then he hands back.

The profile and its folder are the box's `agents` user's alone (0700), but
DevTools on 127.0.0.1 has no key of its own: any process of that user, a
code thread's shell among them, could drive the browser while it runs. That
is the unfenced shell the owner accepted for Work threads, and it reaches
code threads too.

## Not built here

- Holding a box thread's act on the Mac (a Mac-side row the box presses
  over the peer link): a box thread's computer act on the Mac is refused,
  not held (milestone 10).
- The phone's `work.browser.drive` stops nothing: the stop is the desktop's.
  A computer call still running on the phone's Take over finishes; the gate
  below refuses the next one.
- The Mac locked: the canvas shows no "As it was at" line for a locked Mac.
- `teams.post`'s own Outbox view: it uses the generic one (`act.ts`,
  `chunk: null`); Sent draws no picture of the post.

## Proofs

- src/main/server/work/browser/browser.test.ts: the item and the site,
  take over and hand back (the thread woken once), a model refused, a
  page's need, sources, removal, the password rule; a Teams reply refused
  with no carrier, held until the press, posted once (a double press from
  two clients), kept under Away, its picture kept, no grant, stale and
  failed.
- src/renderer/src/work/browser/portal.test.ts and BrowserCanvas.dom.test.tsx:
  the fields from the mark, the sources joined, the held item chosen from
  the tree, every bar face, the press sent once.
- src/main/server/work/browser/teamsPost.test.ts: the carrier on the real
  computer host over the fake service dressed as Teams: one chat posts with
  Return and a picture, nothing held again; no chat, two chats, a draft in
  the box and a reply with no thread post nothing; held, pressed twice,
  posted once, picture stored.
- Not run: anything on the Mac (it was locked and its owner asleep); the
  live Teams post; a live portal submit.
- src/main/server/work/browser/box/: `service.test.ts` is the Linux
  service's wire conformance test (every method against the real Chromium
  on a local test site, each frame through the wire's zod, each observation
  through the grammar's parser); `hold.test.ts` drives that site through the
  host's computer sessions (a Work thread's submit and a Return beside Send
  held, the press submits once, a code thread's click runs); `outbox.test.ts`
  holds the submit in the real Outbox, through Away, and presses it with
  `work.outbox.send`; `logins.test.ts` decrypts Chrome's values and imports
  into the profile; `chromium.test.ts` the launcher, the idle stop and the
  cap.
