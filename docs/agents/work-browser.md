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
  waiting `computer.act` of the pane's tree and presses it with
  `work.outbox.send`; the press runs it once, only if the window still holds
  what he was shown. `portal.submit` stays in `ACT_KINDS` unregistered: the
  box's browser (milestone 38), which the Mac's classifier does not read,
  may claim it.
- **Who drives, a page's need, the sources**: this pillar's one table,
  `work_browser_drive`, one row per pane thread (src/main/server/work/browser/drive.ts).
  The rows are about a screen on this host, so they do not ride a thread to
  another host.
- **`teams.post`**: this pillar's act kind (browser/teams.ts).

## The wire (src/shared/contract-work-browser.ts)

| Method | Cap | Answers |
|---|---|---|
| `work.browser.state {sessionId}` | read | `BrowserState`: `driver` (`agent` or `owner`), `needs`, `site`, `sources`, `since` |
| `work.browser.drive {sessionId, driver}` | operate | `BrowserState`; a `model` caller is refused (`NOT_A_PERSON`). Taking over or handing back clears `needs`. Handing back (owner → agent) wakes the pane thread with `HANDED_BACK` through `ctx.threads.resume`, once. |

Push: `{ push: 'work.browser', state }` on every change.

## The tools

All four are Work tools, keyed by the pane thread (`ctx.canvas.paneOf`), so a
subagent's browser shows in its root's pane.

- `browser_open {url, name, title}`: opens one `browser` item in the pane
  (source `{at: 'browser', host, sessionId: pane}`; a second call shows the
  same item), records the site, clears `needs`, and keeps the sources only
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
  any host until the carrier is wired (below).

## Teams

`teams.post` (payload `{chat, text}`, verb Post) takes no grant: every reply
waits for its own press. On the press `execute` calls the carrier set with
`configureTeamsCarrier`; the carrier posts by computer use and answers a
picture of the posted message, which is kept at
`<dataDir>/work-browser/teams/<row id>.<ext>` and returned as the result's
`ref: { chat, picture: { path, mimeType, width, height } }` for Sent. A
carrier that posted nothing throws `ActStale` (the item reads stale); any
other throw reads failed, "may or may not have gone". A host that lost its
carrier between the hold and the press reads stale.

**Not wired yet.** The carrier needs the thread's computer session, which
only index.ts holds (`ComputerSessions`), and index.ts is not this pillar's.
A foundation follow-up sets it beside `new ComputerSessions(…)`: bring Teams
forward (`computer_apps`), find the chat by name, type the text into the
message box and press Return as the owner's press (a `pressed` call, so the
hold does not keep it again), then take one picture of the window. Until
then `teams_reply` is refused on every host.

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
  Take over sets the owner as driver and stops the tree's computer use for
  the turn (`computer.stop`); the agent is told to wait by its next tool.
- **The body**: the live window in its own shape, at most 720px wide, a
  skeleton until the first frame; at a held submit the values under it
  (label, value, source; the values are the host's read of the page's
  fields from the held row's `mark`, password fields never in it, and only
  the source is the agent's word).
- `bun run ui:preview src/renderer/src/work/browser/BrowserCanvas.preview.tsx#BrowserPreview --width 864`
  draws the six moments in both themes.

## Not built here

- Holding a box thread's act on the Mac (a Mac-side row the box presses
  over the peer link): a box thread's computer act on the Mac is refused,
  not held (milestone 10). Yours, milestone 41.
- The Mac locked: the canvas shows no "As it was at" line for a locked Mac.
- `teams.post`'s own Outbox view: it uses the generic one (`act.ts`,
  `chunk: null`); Sent's picture is milestone 14's to draw.

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
- Not run: anything on the Mac (it was locked and its owner asleep); the
  live Teams post; a live portal submit.
