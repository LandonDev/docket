# The iOS app: design

The phone is where you check on work, answer what needs you, and steer. It
is not where you write code. Everything the desktop has (hosts, workspaces,
projects, threads active and archived, the five thread types with their own
views, the transcript, the todo board, the fleet, the plan document, the
sources board, inbox, search) is here, re-shaped for a hand-held screen and
a radio link. Terminal, editor, Aliax pages and appshots stay on the desktop.

This document fixes the decisions. Threads L3 onward build to it and do not
re-decide what is written here; what is not written here is theirs.

## Baseline: what L2 shipped and why it changes

L2's app is a stock SwiftUI skeleton: a "Hosts" root, inset grouped lists,
no workspace, no thread type, no status, generic chevrons.

| Before (L2) | After | Why |
| --- | --- | --- |
| Root screen is Hosts | Root is Home: Chats and the workspaces, each row's mark saying where work needs you | A host is plumbing; the user picks the phone up to see work, not servers |
| Inset grouped lists (white cards on gray) | Plain lists, hairline separators, one gray step for section chrome | Cards within cards; the desktop's chrome is one gray step and hairlines |
| Thread row: title, "now", chevron | Status dot, type glyph tinted, title, project, elapsed or relative time, tasks `3/7`; no chevron | The row must say what the thread is and whether it needs you |
| No thread type anywhere | Type glyph and tint on every row and header; type decides the thread screen | Five thread types are the product |
| Transcript opens at the top, blank until scrolled | Opens at the latest row, paints from cache before the socket, "jump to latest" pill when scrolled up | Bottom is where the work is |
| User turn: 16 pt radius filled bubble, 14 pt padding | The desktop's bubble: trailing edge, chrome fill, 12 pt radius, 12 × 8 padding, at most 85 % of the column, no outline | The desktop's UserMessage, in step |
| Tool row: inline label only | One-line chip: glyph, verb, target in mono, duration right-aligned in tabular digits; tap expands in place | Desktop Tool Chips; the mobile line has no room for more and needs no more |
| `.secondary` for every quiet text | Two steps: `secondary` for meta, `tertiary` for timestamps and dim halves of a phrase | Hierarchy by weight and color, not size |
| Default SwiftUI push for everything | Push only between levels; sheets for add, pair, new thread; context menus and swipe for row actions | Spatial consistency; CRUD never inline |

## Information architecture

```
Home                      Work                      Inbox       Search
├ Chats (code threads     ├ places for every job
│  outside every           │  (the Outbox; Today, Mail,
│  workspace)              │  Tasks… as each ships)
└ Code workspace rows     ├ Jobs: a row a Work workspace
   └ Workspace (pushed):  │  └ the job's page (pushed)
      the desktop's       ├ Work Chats
      middle sidebar      └ Digest, Computers while driven
Project shell (the detail): the strip, then the thread its chip selects
   (one screen, five shapes by type; subagents push over it) or the draft
Thread, bare: a chat outside every workspace
Settings (hosts, notifications, appearance) from the Home header
```

Tab bar with four tabs: Home, Work, Inbox, Search. Home is code alone. Work is
absent while every host has Work off, and then the bar is the three it was.
Settings is a button in the Home navigation bar, as in Apple's own apps; the
Work list's bar has Work's own settings. No tab for hosts.

**The Work tab** is one more `ShellSplit` on its own `ShellNavigator`, the
engine Home uses, so a fold is a size change and nothing else. Its sidebar
root is the **Work list** (Work/Shell/WorkListView.swift on the client
package's `WorkList.sections`): the places for every job at once, then
**Jobs** (a row a Work workspace, led by its sector's dot, the rail's one
status mark, + in the header for a new one), then Work Chats, the Digest, and
Computers while something is driven. A place has a row only once the build
draws it (`WorkPlace.shipped`: the Outbox, the Digest and Computers today; the
order to come is Today, Outbox, Mail, Messages, Tasks, Agenda, Files, People,
then the jobs, Work Chats, Review, Digest, Computers, Connections). **A place
is a list**: its row pushes `Route.place(place, job:)` in the sidebar column
and what he picks opens in the detail, so on a phone it is list then thing and
on the open Duo two columns with a back chevron to the Work list. A job's row
pushes the job's page (`WorkspaceScreen`), whose title is a menu of the jobs.
The rules, all pure and tested in WorkTabTests:

- **Where it opens.** His own entry into the tab (a press on it, a launch on
  it, the first foreground of a day) opens the day's first place on the first
  entry of each local day and when nothing was ever saved for the tab, else
  where he was (`WorkTab.opensFirstPlace`; the first place is Today, and the
  Outbox until Today ships). A draft he left in the detail is never covered:
  a project's draft, or an open thread whose box holds words, a chip or a
  photo (`WorkTab.holdsDraft`, `UnsentThreads`). The first foreground means
  a return from the background, never the return from `.inactive` that the
  system's Face ID sheet or Control Center makes mid-press.
  What brings him there (a notice, a link, a new thread) stamps the day, so it
  is that day's first entry and stays on screen.
- **A second press on the tab** goes back to the Work list
  (`WorkTab.popsToList`).
- **Both landings are seen.** The day's first place and the Work list after a
  second press clear the detail, so on the open Duo, with his sidebar hidden,
  the split would show "Nothing Selected" alone. Each is a landing
  (`WorkTab.ListLanding`, `ShellNavigator.landOnList`): in a split pose the
  sidebar shows its list while that list stays on top, beside the row it
  picks or over the empty detail, without writing his toggle. It follows him
  within that column (a place tapped in the Work list, Back from Today), and is
  kept across a same-day relaunch; his own press on the sidebar button over an
  ordinary route, or a pick that closes an overlay, ends it, and his saved
  choice decides again. His press over a wide route (Mail) is that route's
  alone and keeps the landing (`ListLanding.afterPress`), so the list he goes
  back to still shows at his next pick. A notice that names a list (the day's
  Digest) lands the same way (`WorkTab.noticeLands`), never behind wide Mail or
  a hidden sidebar; one that names an item opens over its list.
- **A locked Mac.** Through the box with its screen locked, a Mac's job page,
  the places for every job and Today say "<Mac> is locked.", not that the key
  can't read LifeOS (`KeyMay.lifeosLocked`, `LifeReach.Host.locked`,
  `TodayDown.locked`). A key without approve says the key.
- **What opens where.** A route something outside a tab names opens in the
  tab `ShellPaths.tab(of:isWork:)` gives: Work's places and screens, a Work
  thread (its scope), a Work workspace and Work Chats in the Work tab, the
  rest on Home; a thread no host lists yet opens on Home, as before. New
  Thread in a Work workspace focuses its draft in the Work tab; a file's Ask
  opens its thread in the tab the file is in. With Work off everywhere such a
  route opens on Home.
- **A held notice** lands the Outbox, then the item, in that order
  (`ShellPaths.list(under:)`), so Back at compact width is the list, then the
  Work list.
- **Memory.** The place is kept per tab under `navigation.memory.v3` as
  before, and each tab keeps its own sidebar toggle
  (`ColumnMemory.sidebarShown`). A save from before the Work tab
  (`hasWorkTab` absent) keeps its shape until the hosts' cached lists are
  read, then `NavigationSnapshot.movingWork` moves what Home held of Work (the
  sidebar when its first list is Work's, the detail and its stack when its
  root is) to the Work tab, a place under its old route (`.outbox`, `.digest`,
  `.computers`) becoming `Route.place`, and the tab follows what he was looking
  at. A launch on the Work tab keeps the tab until the hosts are read
  (`WorkTab.shows`).

Home is the desktop's sidebar in two pushed levels of one
NavigationStack: Home is the far-left workspace column, a workspace is the
middle sidebar. A project is no list: it is the project's shell in the
detail column, the desktop's project home. Each level is a plain `List`
under a large title; the rules are the client package's `HomeSections`
(Shell/HomeSections.swift: `home`, `workspace`),
ported from the desktop's, so the phone and the desktop never disagree
about what is active or what a workspace's state is.

**Home: the workspaces.** One row per workspace across every paired host;
copies linked across hosts (one `linkId`) are one row. The row is the
workspace's mark at 28 pt (the repo icon in a continuous `size / 4`
corner with a hairline outline, else the git host's mark, else a folder),
the name in the title step at medium (a name two rows share gets one meta
line under it: the computer's name when the copies span computers, with
the shortest parent folders that differ before it only where two copies on
one computer still tie ("work on Mac"), and the folders alone when every copy
is on one computer, `HomeSections.nameHints`), and the
desktop column's one status,
loudest first (useProjectSignals.ts `workspaceRailStatuses`): paused (the
pause glyph in warning), needs you (a warning dot: waiting on an answer,
failed, or recoverable), working, unread (an info dot), else nothing. A
working workspace has no mark: the line under its name says what runs,
the spinner, the newest working thread's title and "+2" for the others.
Threads outside every workspace lead as one "Chats" row. The whole row
pushes; a long press offers New Thread. There is no Needs you or Running
section: the marks say where to look, one tap away.

**Hosts.** One host is the common case and must never cost a tap: its
menu (the fleet switches) sits in Home's navigation bar and its name
appears only in Settings and a status line. With two or more, each host
is one row at Home's foot, as the desktop's host rows sit above Settings:
its glyph, its name in the meta step with the relay line under it, its
connection dot, the deploy drift mark; a tap opens its menu. A row whose
every host is down sits at 50 % opacity. An unauthorized or offline host,
or one reconnecting for longer than the 1.5 s hold (`HomeSections.troubled`,
the status line's and the desktop's `DEGRADED_GRACE_MS`), shows one status
row at the top of Home with the action (Retry, but none while the link is
already connecting, `ConnectionFact.offersRetry`; Sign In Again), never a
blank screen; under the host's name its words leave the name out, the
desktop's `linkFact` ("Reconnecting…", "Offline", "No longer accepts this
key"; `ConnectionFact`), never the socket's raw error
(Diagnostics shows that); a host reached through the box folds under
the box's row while the box is in trouble (`HomeHostInput.via`), and one the
relay says is locked, asleep or unreachable gets no row: its foot row's line
already says so, in that one word (`HomeSections.troubled(relay:)`). A host's
one-off notes ("3 threads resumed after restart") are quiet lines at the
top. Adding a computer lives in Settings → Computers.

**Workspace: the project cards.** The title is the workspace's name, New
Thread (`square.and.pencil`) in the bar. Each project is one card, the
desktop's project card (`ProjectCardView` on sidebarRows.ts `cardLines`),
built by the client package's `ProjectCards.card` (Shell/ProjectCard.swift)
from `ThreadGroups`, every linked copy as one card: one container on the
group fill (`Surface.group`, `systemGray6`, one step from the background in
either mode; `.groupPressed` a step further while pressed, at once and never
animated; `.groupSelected` while its project holds the thread beside it in
the split), `Radius.row`, 12 × 8 in, 4 pt from the next card, no border or
shadow (`CardMetrics` in Tokens.swift). The name in 13/20 medium primary at
every state (an unread thread says so by its own line, never by the name),
its last-active time in 12 tabular after it, then the ellipsis; the branch
line 12/16 2 pt under it: the branch glyph and the branch (else "local
checkout"), then "worktree" or "local". Then lines in 12/16 on 24 pt, in
this order: needs you and failed roots (their mark, type glyph and title,
the cue or detail under the title in amber or red: `Tint.warningText` and
`Tint.destructiveText`, in light mode a step darker than the system's
increased-contrast orange and red (which measured 4.1:1 on the fill, under
the 4.5:1 this line is held to), 4.9:1 and 5.3:1 on the fill where the
system's plain ones read 2:1 and 3:1; dark mode keeps the system's), master blocks (the
master's line with the batch's done tally, its working subagents in the
fleet's words, its marked batch threads one step in with working as a still
dot, "N queued"; the master's line carries the block's one moving mark,
`MasterCardBlock.lead`, while anything in it works), working and watching
roots (the spinner or the watching dot, the type's tinted glyph, the title,
the host glyph with two or more hosts, the elapsed past 3 s; an
implementation's "3/7  task" under it), paused roots ("Paused" and the
frozen elapsed), unread roots (the title in medium, no mark; never the
thread on screen, `EnvironmentClient.visibleThread`, nor a thread housed in
a master). One page of 32 lines, then "N more". Last a quiet count line of
what has no line: "N dormant", "N archived", or "No threads" for a project
with none; needs you and failed are lines, so they are never counted, and a
pin earns no line. A tap on a line opens that thread in the project's shell
(a needs-you line on its card); a tap anywhere else opens the shell on its
landing; a long press and the
ellipsis open the project's menu (New Thread, settings, Project Plan, the
fleet switches per host copy). The card's accessible name says what needs
saying ("Alpha, 1 needs you, 2 working, 3 unread"). Then the workspace's
chats (no project), all of them, under a "Chats" header 16 pt under the
cards, each the one `ThreadRow`; then one dim "n archived projects" row per
host copy. Projects order by latest activity.

**The project's shell.** `Route.project(key:thread:seq:)` is a project's
place in the detail column (Shell/ProjectShell.swift): the strip on top,
then the thread its chip selects (`ThreadScreen`), or the project's draft
when none is open (an empty body and the draft composer at its foot, with
the project's name, plan chip and menu in the bar; "The project's draft"
under the composer). `key` is the strip scope's key: a project's `ProjectPairs.key`,
or `loose:…` for a workspace's loose chats, which get a shell of their own.
Every root of a project or of a workspace's loose chats opens in its shell;
a subagent opens its root's shell and pushes over it; a chat outside every
workspace opens bare (`ShellPaths.place`). A thread opened bare because its
host had not listed it yet (a notification's tap on a cold launch) moves
into its shell the moment the list lands, unless something was pushed over
it (`ShellPaths.relisted`, `ShellNavigator.placeListed`); once a complete
list from its host (`EnvironmentClient.completeLists`: a change-log answer
or a walk that reached its end; one cut short counts nothing) still leaves
it bare, it is looked at again only on that host's next complete list,
its workspaces or projects push (`catalogStamp`: a `workspace.list` that
failed at launch is made good by the next one) or a push that names the
thread or moves it (`ShellPaths.awaitsListing`, `BareSettle`). The shell
reads those as the client's stamps and its untracked index of each
thread's placing fields (`completeLists`, `catalogStamp`, `watchPlacing`
behind `placingStamp`), never the host's sessions, so a push that moves
none of them re-runs nothing and builds no lists. A card's tap lands the shell
(`ShellPaths.land`, the desktop's project home): the project's most recent
active thread (`ProjectLanding`, a batch thread's master in its place),
else the thread last on screen there, else the draft, and a project left on
its draft comes back on it. The last thread is kept per scope key
(`ShellLandingStore`, `shell.landing.v1`), so linked copies share it. A tap
while the shell is already open moves nothing. The shell is one screen
whichever thread it shows (`ShellPaths.identity`), so a chip's tap swaps
the thread under a strip that keeps its scroll.

**Rows.** Every thread row is the one `ThreadRow` (status dot or spinner,
type glyph, title with the "Master" tag, the model and the tasks or
activity, the time), with the host glyph when two or more hosts are paired
and `ThreadRowModel.depth` for the indent. A thread that waits, failed or
paused reads its cue as the second line ("Approve: run bun test",
"Question: which email?", "Paused") and a waiting one sits on the warning
tint at 8 %; tap opens the thread on that card. Swipe to pin and archive,
the context menu with rename, Start now and Resume, and the master pin
(Design/ThreadRowActions.swift) on every level. Empty states are one calm
sentence with one tinted action: "No threads here yet." with New thread
(over the empty list; in a Work workspace it is the list's last row, under
its view rows, where its chats would start: `emptyNoteIsRow`),
"No workspaces on <host> yet…" with Hosts (the system spinner until it
has listed), "Nothing paired yet" with Pair a host. Status and note rows
are the only rows with an entrance (`Motion.appear`), and nothing animates
in the first 300 ms after the cached paint. The archived lists share the
project rows' type and the thread rows.

**Unfolded: the split.** Home and Search are each one `NavigationSplitView`
in every pose (Shell/ShellSplit.swift), collapsed to the stacks above in
compact width and expanded beside the detail in regular width, so a fold
changes a size and nothing else. Each runs on a `ShellNavigator`
(Shell/ShellNavigator.swift): the sidebar's routes, the route at the
detail's root, and what the detail pushed over it. Every tap in a list goes
through `open(route)`, which places the route by its column
(`ShellPaths.column(of:)` in the client package) and a thread in its shell
(`ShellPaths.place`): a workspace and the archived lists push in the
sidebar; a project's shell, a bare thread, Settings and Hosts replace the
detail's root and clear its stack. A card's tap goes through
`openProject(key)`. The paths: a card or a line on Home opens the shell in
Home; a notification tap switches to Home and opens the shell there; a
search hit opens the same shell in Search's own detail, so Search keeps
its place. A second hit in a thread already open keeps its screen (the
shell keys it by thread) and lands on the new row
(`TranscriptLanding.onRetarget`; the transcript's landing is keyed by the
row it names). While the row is fetched a small spinner sits on glass at
the list's top; a row the host cannot find reads "Not in this thread" there
until the reader scrolls or 2 s pass, and the window grows and reflows as
before meanwhile (`SearchLanding`). Collapsed, the detail sits on top of
the sidebar's stack and Back from it clears it. The Inbox keeps its own
split over one typed path (`InboxScreen`, "iPhone Duo" below).

The pose is the client package's `ShellPose`, decided once at RootView from
the window's size classes and its own bounds and published as `\.shellPose`:
compact width is `.stack(short:)` (short when the height is compact too, the
folded landscape pose, where every list title is inline); regular width is
`.split(sidebar:)`, the sidebar tiled beside the detail in every regular
pose, upright too: iOS 27.1 lays the open Duo's split side by side at
669×951 (iw13 measured a 250 pt list beside the detail), and the split asks
the balanced style so the rule and the drawing stay one. The overlay mode is
kept for a split told otherwise; in it a pick hides the sidebar. In a window
taller than wide the list asks its widest, 320 pt, so its rows keep their words,
tabletop too, whose fold runs across. The plan's overlay there, with a 640 pt
reading width, is the owner's flip (council 18, Opus 2.1). A screen
reads `\.shellPose`, never `horizontalSizeClass`, for a shell decision; the
detail column's own size class is the system's and is not promised.
`columnVisibility` always carries the expanded preference (the remembered
toggle), so the sidebar arrives with the expansion. In the overlay pose a
pick hides the sidebar, as Mail's does. The sidebar asks for the
desktop's 260 pt workspace column, never past 320 (`SidebarColumn`), but
iOS 27.1 keeps the column at 320 in the unfolded Duo's window whatever it
is asked (a range and a fixed 260 both measure 320, `sidebar.width`), and
the tab rail at the right edge takes 84, so the detail is 547 pt at 951
and a two-segment thread there is the pager. While the hinge is half open
(`UIHingeInteraction`, iOS 27.1) the sidebar's ideal width is the window's
centre line, so the seam sits on the fold.

The workspace list is a step back in the sidebar (Back, and the title menu
below), never a third pane: the split has the sidebar and the detail only.
The sidebar is Home's two levels; at the workspace level the
title is a menu (`toolbarTitleMenu`) of every Home entry with the current
one checked, left out when there is one, and a pick swaps the sidebar's path
and leaves the detail alone. Its chevron shows on the inline title. A page
of the Work tab (Work Chats, a job's threads) has no title menu, as no
other Work place has one: Back returns to the Work list. In the
split the row whose thread is the detail's root sits on `Surface.fill`.
The detail reads "No Thread Selected" (Home) or "No Result Selected"
(Search) when nothing is open, a title alone. At the shell's top, in every
pose, the thread strip (Shell/ThreadStrip.swift over the client
package's `ThreadStrip`) is one 40 pt row of chips over the desktop's
strip rules (`ThreadStrip.model`, threadStripModel.ts and
threadHeaderModel.ts): the scope is the open thread's project with every
linked copy, else its workspace's loose chats on every copy, and a chat
outside every workspace has no strip; every unarchived root of the scope, a
batch thread left to its master's chip. Live is not idle or done, or live,
paused or recoverable work in its tree, or unread, or a plan ready to build
(`planCompletedAt` on a settled planner); pinned alone is not live. The live
row keeps a stable order saved per scope key (`ThreadStripStore`,
`strip.order.v1`: a project's `ProjectPairs.key`, so linked copies share it;
the first 64 ids, a scope not drawn for 30 days forgotten; new chips join
oldest first; a state change moves nothing), the settled roots sit on the
shelf freshest first, the thread on screen is selected on whichever row it
sits (a subagent selects its root), and a thread outside the scope (a batch
child, another scope's root) is a temporary chip at the live row's end,
never saved. A chip the person selects keeps its place on the live row
until another is selected, though opening its thread marked it seen or it
settled meanwhile: the touch stand-in for the desktop's hover hold, so a
tapped unread chip never jumps to the shelf as its thread opens (a chip
opened from the shelf stays there). A draft's first send whose create is
in flight is a live chip at the row's end (`DraftSending`, the desktop's
`draft` strip thread): the typed name or the message's first line, the
working mark in its glyph slot, no tap and no menu, never saved, selected
once its thread is on screen, gone the moment the thread's meta lands and
its own chip takes the place; while nothing is selected the row scrolls to
it (`StripModel.scrollTarget`). The row scrolls only a picked chip that is not wholly in view, never one he
tapped where he could see it, and brings a later chip to the leading margin whole. `ProjectLanding.active` is the first step of the desktop's `landingOf`: the
scope's most recent active root by its last event, a batch thread standing
in for its master, none when the thread on screen is already in the scope.
The strip (`StripMetrics` in Tokens.swift) is a 40 pt live row: the live
chips 2 pt apart in a horizontal scroll with 16 pt of fade at each edge,
then New Thread outside the scroll (its glyph, or the words "New Thread"
while the row holds no chip, when the empty scroll is left out and the
words lead the row where the first chip would sit, `leadsWithNewThread`). A live chip is 28 pt with 12 pt of padding on
`Radius.row`: one 14 pt glyph slot holding the type's tinted glyph at rest
and the status mark in its place while the thread has a state worth one
(`StripChip.look`, the desktop's `marksAtRest`: working, waiting, failed,
paused, queued, watching, stopped, plan ready), as a browser tab's favicon
turns into a spinner; the title in 13/20, secondary at rest, medium and
primary while unread (never on the selected chip), its medium width always
held by a hidden copy so a chip never widens; "Master" in tertiary after a
pinned master's title; the host glyph with two or more hosts; 224 pt at
most. The selected chip sits on `Surface.fill` with its title in primary.
At regular width the settled roots are a 32 pt shelf row under it (24 pt
chips, 8 pt of padding, a 12 pt type glyph, 12/16 titles to 160 pt, no
status mark), drawn only while it holds a chip and folding in and out on
the layout spring (a fade under Reduce Motion). At compact width they are a
Recent button (the clock) at the live row's end: a menu of the settled
roots freshest first, then "Archived Threads" per host copy that has any,
pushing the archived list over the shell; a settled thread on screen keeps
a chip at the live row's end there, never saved (`StripModel.compact`). A chip's tap selects its thread
in the shell at once, with no motion; its long press is the thread's menu.
The drawn order is saved (`ThreadStripStore.save`; the outside chip never
is). The thread screen keeps its tab bar in the split (hiding it
would hide the vertical rail for every tab) and hides it in compact as
before.

Memory is `navigation.memory.v3` (`NavigationSnapshot` in the client
package): per tab the sidebar's routes, the detail's root and its stack,
plus the overlay toggle; the Inbox's path has its own key. One snapshot
opens the same place folded or unfolded. A v2 snapshot gives back its tab
and toggle and opens every column at its root (`NavigationSnapshot.restore`):
mapping a v2 thread to its project needs the session cache, which the
restore runs before. The outer display allows portrait
and both landscapes; the inner display ignores the key.

**Furniture** (ios/TempCode/Sources/Shell/): HomeView.swift (level 1),
WorkspaceScreen.swift, ProjectCardView.swift (the project card),
ProjectShell.swift (the project's shell), ShellRows.swift (the rail mark, the working line, the
thread rows, the project menu, the
cue loader, `NewThreadPresenter`: New thread from any level focuses the
project's draft in its shell; the new-thread sheet, kept for a prefilled
brief, presents from the root), HomeRows.swift (the clients as
`HomeHostInput` values), HomeSlots.swift (what sibling features plug in),
ShellSplit.swift, ShellNavigator.swift, ShellPoseEnvironment.swift and
ThreadStrip.swift (the split, its navigator, the pose seam, the strip).
`Route` and `AppTab` live in the client package (Shell/Routes.swift) beside
`ShellPose`, `ShellPaths` and `ThreadStrip`; `Route.workspace(key:)` carries
the `ProjectPairs` fold key and `Route.project(key:thread:seq:)` the strip
scope's key with the chip id (`<environmentId>:<sessionId>`) of its thread.

**Project settings.** The project's menu opens the sheet
(`Shell/ProjectSettingsSheet.swift`, presented from the root through
`ProjectSettingsPresenter`, since a sheet on a menu item never shows) at the
large detent with the sheet radius: an inset grouped list, three sections,
one sentence of footer each, one Save top right that sends only the dirty
set (review before plans) and is disabled until something changed; a
failed save is one destructive line in the footer of the section that
failed. **Preamble** has two rows that push the editor
(`Shell/PreambleEditor.swift`): "Project rules" with its word count ("212
words", "Off", "80 words from workspace", "Off in workspace", "None") and "Workspace
default". The editor is its own screen: Edit and Preview segments in the
bar, the whole height for the text (the desktop's three placeholder lines
while empty), the preview rendered with `{{project}}`, `{{host}}` and
`{{worktree}}` substituted (the host's name, the project's name and its
slug), a panel on the chrome step at the bottom with the "Apply to new
threads" switch and the live word count rolling beside it, "Use workspace
default" when the project has text of its own, the variables in code, and
its own Save. **Reviews** and **Plans** (`Shell/ReviewSettings.swift`,
`Shell/PlanSettings.swift`) follow the global set until a field changes;
the footer's second sentence says which ("Following the global setting.",
"Built-in defaults.", "This project's own setting.") and "Use global
setting" appears only while overriding. The reviewer picker lists Codex and
Claude from the catalog filtered by the host's orchestration rules, the set's
own model kept first as "(not approved)" when the rules no longer approve
it; the time limit is a menu of presets with the current value folded in.
A key without admin sees every control disabled and one footnote at the top
("This key can read these settings but not change them"); the editor opens
read-only with the same line. The drafts and words are the client package's
`Client/ProjectSettings.swift`, under Swift Testing.

**Hosts on Home.** With one host there is no host header; its menu (the fleet
switches), when a slot fills it, is the More glyph in the navigation
bar (`GlassMetrics.moreSymbol`: the bare `ellipsis` on iOS 26, where the
toolbar's glass draws the circle, `ellipsis.circle` before) before Settings. With several, each host is one row at Home's foot
("Hosts" above): the connection dot, the name, the deploy drift mark and the
menu. A host's one-off lines (the boot-resume note) are quiet rows with the
event motion and no action.

**A host's name.** Every host shows once, under the name it gives itself
without the network's domain ("Mac", not "Mac.attlocal.net"), whole only
where two hosts would read the same, or under the name the person gave it in
Settings → Computers (`HostNames.labels`, applied by the registry to every
client's `environment.name`; the desktop's rule is src/shared/hostNames.ts).
Pairing asks for no name: the hello says what the host is.

**Hosts through the box.** A host the box relays (the Mac, when the phone is
away from the LAN and only the box has a tunnel) is a host like any other:
its own `EnvironmentClient` in the registry on a second `/ws` lane to the
box's origin (`?host=<macId>`, minted with the box's key), its own mark,
name, rows and cache on Home, in Search's fan-out, the Inbox's host name and
the subagent list's host mark, listed right after its carrier. A cold launch
paints its threads from the cache like any host's (`relayed.json` beside
`environments.json` keeps the row). It adds two lines and nothing else: a
presence line and a refusal line. The presence line is one dim line of text
in the meta step, no badge, no icon; the only colour stays on the status
dot. Its words per state (`RelayWords`): nothing when the Mac is up and
unlocked; "locked since 9:14" (the time the phone saw the lock, "locked"
alone before it has); "asleep"; "unreachable since 9:14" (the box's time of
the link's drop). On a row whose title is the host's name the line has no
subject ("through box, locked since 9:14" under the host header on Home and
on the Settings row); on the thread screen the subject is "the Mac" for a
darwin host and the host's name otherwise. Locked keeps Send: the relay
forwards every method the phone uses on a locked Mac, so the working strip's
idle slot says "The Mac is locked since 9:14" and the composer stays open.
Like every slot that takes room, the line has its own band: the dock's
backing is solid from the slot's top down (`ComposerSlot.backing`, `.solid`;
`BottomEdgeFade(solid:)`), so a board row scrolling beneath never shows
through the words. With no slot the composer floats on the soft edge alone.
The dock is its parts' height in every pose and at every size change: the
slot, the composer and the dock itself take their ideal height
(`fixedSize(vertical:)`), never what the bottom bar offers. The bar offers
the whole column, and on 2026-11-06 the empty slot reserved at regular width
(a flexible `Color.clear`) took it after a live unfold of an idle master: a
437 pt dock whose band blurred the whole transcript, which a launch straight
into unfolded never showed.
Asleep and unreachable block through the composer's own line, Send
disabled: "The Mac is asleep: reading only until it wakes", "The Mac is
unreachable since 9:14" (the lane is held by the box's word, the socket's
`setHostReachable`, with no attempt and no Retry; the box retries the
link). A refusal that still comes back from the host (a `screen` method on
a locked Mac, a race at a transition) is one line on the action that hit it,
the host's own words capitalised: "The Mac is asleep" (`RelayRefusal`). The
status line under the bar reads "Reconnecting to the Mac…" past its 1.5 s
hold and "The Mac is unreachable since 9:14" while held, with no Retry
button then. The presence line cross-fades in place on a change
(`Motion.crossFade`, blur; opacity alone under reduced motion), never on
first paint, and re-renders once a minute at most. Forgetting the box
forgets the Mac with it (the dialog names it: "Studio Mac goes with it."); a
relayed computer has no Sign In Again and no Forget of its own.

**Home's extension points** (`HomeSlots`, one value passed from `RootView`'s
`HomeView(path: $homePath, slots: …)`; every slot optional, a nil slot draws
nothing, so no menu is ever empty): `pairing` (paired projects), `hostNotes`
and `hostMenu` and `projectBatch` (the fleet switches and the boot-resume
note), `projectSettings` (the project settings entry in the project header's
menu, after New thread and before the batch entries), `hostTrailing` (the
deploy-drift mark on the status row and the host header), `hostSubline` (the
relayed host's "through box, locked since 9:14" under the header's name). Masters need no
slot: a master's row carries its word from `ThreadRow`, its batch children are
roots that Home lists through `HomeModel`, and whatever fills
`ThreadItem.children` nests under its root as subagents do.

**Thread rows** everywhere share one shape: 44 pt minimum, status dot or
spinner leading (desktop `StatusDot` colors: waiting warning, error
destructive, starting and watching info, running spinner, idle and done
none), the type glyph tinted, title in `subheadline` weight regular (semibold
while unseen), second line dim with the model and either `tasks done/total`
or the last activity, trailing relative time in `tertiary`, tabular. Subagent
rows indent one step under their root with the agent glyph. No chevrons:
every row pushes.

**Inbox** is the desktop's GitHub inbox over `github.inbox`, laid out the
way Mail lays a message out, on the kit by name. A row: the author's picture
(36 pt scaled with the title, on the fill step behind the kit's one-pixel
`hairlineBorder` at black or white 10 % so the edge reads the same on every
avatar, a letter until the picture lands, cross-faded in on `Motion.crossFade`),
the title in the title step (semibold while unread: weight is the whole
unread mark, no badge, no dot) with the time trailing as `AgoText` in the
stamp step, then a meta line: the kind glyph (`MetaGlyph`, its stroke the
title's weight), the author, the repository's name with the number dim, the
one word the item waits on in the color that means it (Changes requested
warning, Checks failing destructive, Approved success, Your review info,
Merged violet, Closed destructive for a pull request, Draft and an issue's
Closed plain); never the host, which cut the repository and itself on a
phone's width (the item's screen names it under the repository when there are
several); at accessibility
sizes two lines, who over what. Nothing else is colored. Rows sit on
`Layout.rowInsets` and the separator starts at the title. Rows sort newest
first across every host, as the desktop does, with no sections; one item two
computers both read is one row, the first computer's (`InboxModel.entries`). Swipe
trailing marks read or unread (info tint; full swipe), swipe leading opens on
GitHub, and the context menu has both plus Copy Link; a mark swaps the weight
with no animation. The rules are `InboxModel` in the client package
(`Rendering/Inbox.swift`, tested); seen marks and the last snapshot of every
host live in `InboxStore` (UserDefaults and a JSON per host under Application
Support), so the tab paints at once and never flashes; the first snapshot
ever seeds everything older than a day as seen. Opening the tab reads each
host's stored snapshot (`github.inbox`, SQLite only, again after a minute)
with animations disabled; a pull is the one refresh (`github.inboxRefresh`,
since the inbox is a poll, not a live push), shows the system indicator, and
is the only time the rows reorder under the default animation. A read-only
key is known from `operateBlock` before the pull and reads the stored
snapshot instead; it, a signed-out gh and a repository that failed each get
one meta line at the top. Empty: `ContentUnavailableView` "No Issues or Pull
Requests" with `tray` (see "Empty screens"), shown once every host has
answered or cannot; "Every computer is offline." when none could answer; the system `ProgressView` until then, never on a paint
from disk.

**The fleet switches** (ios/TempCode/Sources/Shell/FleetSwitches.swift over
the client package's ThreadBatch.swift, the desktop's threadBatch.ts ported
whole) are four rows beside Mark all read: Pause all, Resume all, Stop all,
Archive done, in the host's menu (the More glyph in Home's bar with
one host, on each host header with several) and in the project header's
menu, and again in a thread's menu for its project. A row with nothing to
act on is disabled, never hidden; a key that cannot act reads the reason as
the menu's first line. Pause, Stop and Archive done confirm in a sheet
as tall as what it says (a height detent measured from its content) whose title is the live count ("Pause 15 running threads on the
box?", the digits rolling as threads settle while it shows), with the
resources clause and its switch when Archive done would release worktrees
or simulators, and one full-width confirm at the foot (destructive tint for
Stop and Archive done). Resume all runs at once. The outcome is one status
card on glass floating above the tab bar, "Paused 14" in semibold and,
under it in the destructive tint, "1 failed: Search (harness not
responding)": a clean result leaves after four seconds, a
failure waits for a tap. A success never takes the place of a failure
still up (`ToastSlot.fate`): one that answers his own press ("Copied",
"Paused 14") waits behind it and shows once he taps the failure away, and
VoiceOver hears it at once; one that comes with no press of his (Mail's late
"Sent") is said where it belongs instead. A line that no longer holds goes
when its answer comes (Mail's "Checking whether it went" once the mail is
found). His own cancel of the owner's check ("Nothing was sent.") is a plain
line, not a failure.

**Queued, stopped, resources.** A queued root (created, waiting for its
`after` sibling) reads the host's reason ("Waiting for X", the host's
"Queued  waiting for X" with the word the queued dot already says left
off) through its `activity`, never counts as working on its workspace row, and offers Start now in its context
menu and in the working strip (`session.start`, past the `after`); a
stopped root (its harness gone after a restart) reads "Stopped", then "The
harness is gone" quieter, in the status line with Resume (`session.resume`, a fresh
harness on the transcript). A paused master's strip says ", and 2 batch
threads with it". A host that resumed threads after a restart shows "7
threads resumed after restart" once per boot as one quiet line at the top
of Home for fifteen seconds. Resources… in a thread's menu opens the
Resources sheet (ios/TempCode/Sources/Thread/ResourcesSheet.swift): one
group per host the rows live on, each row the label, its path or UDID in
mono, the state word, and Remove (a spinner while the removal is out,
"Waiting for box", the row's host by name, only while that host is away,
and then no "removing…" beside it); the row leaves when the host's push
says it is gone. Until the list answers the sheet shows the spinner; then
`ContentUnavailableView` "No Resources", or "Couldn't Load Resources" with
Retry when the ask failed. Archiving a thread that holds resources, from
a swipe, a context menu or the thread menu, asks first: "Archive <title>?"
with "and remove 2 resources on the Mac" switched on by default.

The detail paints its header from the row (picture, author, `repo #n` dim,
the title in `title3` semibold, the state word in its color or Open in
success, `head → base` in mono one step down, labels as plain capsules on the
fill step), then the body as markdown and the conversation (comments, reviews
and review threads in time order, 24 pt pictures, the review verdict in its
color, Resolved plain, `path:line` in mono, replies one step in). A host with
no checkout of the repository says "No checkout of <repo> on <host>." and
asks nothing. For a pull request the Changes section is a count line and a
`groupCard` of rows over `InboxPatch.changes`, 44 pt each with a hairline
between: "All files" first when there are several, then one per file (the
directory dim, the name primary, in mono one step down, head-truncated) with
its `+n −m` or Binary; a row pushes the diff thread's `DiffScreen` with a
`PatchDiffRoute` of that file's slice of the patch, so the phone has one diff
screen, not two. A file whose block the host did not send is inert, and a
truncated patch ends with "The rest of the patch is on GitHub." The body and
the diff load behind a `Shimmer` of the height they will take and cross-fade
in on `Motion.crossFade` (a plain swap under reduced motion); a failed load is
one meta line with Retry. What loaded once stays in the store so going back
and in paints from memory. Open on GitHub is the bar's one button. Nothing on
either screen animates except the press, the cross-fades above and `AgoText`'s
digits.


**Search** uses `session.search` and `search.project` over every paired
host: the system field (on iOS 26 the search tab's own field, `.automatic`;
on 18 to 25 the navigation drawer, always shown), with Threads and Files
scope buttons only when an open host has an unarchived project to grep. A
query waits 250 ms after the last keystroke (a scope change runs at once;
under two characters nothing is asked), then runs on every open host at
once off the main actor, one task-group child per host; the answer
replaces the list whole inside `Motion.withoutAnimation`, so the list never
flashes to empty and two queries' rows never mix. The rows are one flat
list the client package builds (`SearchRows.build` in
`Client/SearchRows.swift`: the row model, the match ranges, the debounce
rule and the foot line, unit-tested; its body is the slot the cross-host
merge, rank, fold and typed filters land in): per thread a head row with
the type glyph at the title's weight and the title in `.title` semibold
that opens the thread, then its hits indented to the title's edge (the
glyph column and its gap, 30 pt, scaled with Dynamic Type), each the
snippet in `footnote` at label strength with the query's words one weight
up (by weight, never color: `MatchEmphasis`) and `AgoText` trailing; a hit
opens the thread at its row, a hit in the thread's notes carries a
`note.text` glyph and opens the thread at its end. In the Files scope each
project is a `SectionHeader` band, then up to 40 lines, each a file glyph,
the path with its line number dim and tabular, and the line in mono with
the match in weight; a file row, or a project row (a project matched by
name, when the selector supplies one), is a fact, not a push. The host is
a dim `.stamp` word trailing a head only when several hosts are paired,
and then a foot line names what each host took ("Mac 320 ms, box 1.2 s",
"box offline", "box failed"); "More matches than shown" closes a cut
answer. Over the empty list (`SearchStatus`): the shared No Computers view
with Add a Computer when nothing is paired; a small spinner while a host is
still connecting or the first answer is out; one calm `.meta` line, "Every
computer is offline.", once none can answer; nothing before a query (the
field's prompt says what it searches); `ContentUnavailableView.search` for
no results (see "Empty screens"). Cancel clears the field. Nothing animates on a keystroke or a scope
tap; the press scale and the ticking time are the only motion. DEBUG
hooks: `TC_TEST_SEARCH` is the query, `TC_TEST_SEARCH_SCOPE=files` opens
the Files scope.
Every paired host is asked at once and rows land per host as it answers
(`CrossHostSearch.run` in `Client/CrossHostSearch.swift`, an `AsyncStream`
of answers the screen writes inside `Motion.withoutAnimation`; the previous
answer stays until the first batch lands, and stable row ids keep an
unchanged row in place while a second host's rows insert). The ranking is
by the hosts' bm25 rank and recency, never by host: thread groups by their
best hit, then the app's notes, then file groups by newest mtime, then
projects by name. A thread's working notes are hits under its head (the
`note.text` glyph, `seq` nil) and the app's notes (`notes.search`) are note
rows (`NoteRow`: the glyph, the title, the snippet with the match in weight,
the host trailing when several; a fact, not a button). The same file in two
copies of a paired project (`ProjectPairs` over every host's workspaces,
through `CrossHostSearch.pairLookup`) is one row on the newer copy, "Newer"
in the quiet step after its line number, the other hosts in the accessibility label. `host:` (a name,
an id, or `mac`), `type:` (thread, file, note, project; it wins over the
scope buttons) and `project:` are typed in the box; the foot names each host
with its time, "…" while it is still answering, offline or failed.

## The thread screen

The header has two forms. **In a project's shell** (every root of a project
or of a workspace's loose chats, `ThreadScreen(shellTitle:)` from
`ProjectShell`), the bar's title is the project's name (the workspace's for
its loose chats) and there is no line under it
(`ThreadHeaderLine.subtitle(inShell: true)` is nil): the strip's chip says
the thread and its state, the composer's row the model, the slot above the
composer the time, so nothing is said twice. **A subagent's screen and a
bare chat** (outside every workspace) keep the thread's own header, the way
Messages and Notes title a screen: back, the title inline, and under it one
quiet line read off `ThreadHeaderLine` (client package,
`Rendering/ThreadFrame.swift`): the status mark, the type label tinted (a
subagent's role instead; "Master" first on a master) and the account chip.
Never the model or a clock: the composer's row names the model and the slot
above the composer is the one clock, so the header says neither twice. The
host's name leads that line, in the tertiary step, only when more than one
host is paired; the line drops the host, then compacts to the type (or the
one word "Queued" / "Stopped", alone), before the title truncates. The line's
mark and words by status:

| status | mark | after the host |
| --- | --- | --- |
| running, starting | spinner | type, account (the turn's phase is the transcript's working line, never the header's) |
| watching | info dot | type, account |
| waiting | warning dot | type, account |
| error | destructive dot | type, account |
| paused | pause mark | type, account (the frozen time is the slot's) |
| queued | quiet dot | "Queued", then the host's reason ("Waiting for X") quieter |
| stopped | the still square | "Stopped", then "The harness is gone" quieter |
| idle, done | none (the line stays centered) | type, account |

An idle root whose subagents still work shows the spinner. Rename… in the menu (and, outside the shell, a
long press on the title) swaps the title for a field in place; Done or
losing focus commits a changed, non-empty title and anything else reverts;
the trailing toolbar group hides while the field is up so it gets the
width. A key that cannot operate never opens the field: it sees the reason
in the "Couldn't do that" alert. The title and the mark cross-fade when
they change; nothing animates on the first paint.

The toolbar's trailing group, left to right. In the shell: the project's
plan chip (`ProjectPlanChip`, when the project has a plan), the agents
button (shown when the thread has unarchived children and no Fleet segment
lists them already; it pushes the subagent list), Notes (roots), and the
ellipsis menu last. Outside the shell: Notes (roots), the agents button,
the menu. The agents button follows the desktop's cue (`AgentsCue`): while
any subagent at any depth works, waits or is queued (a master's batch is
left to its board), the loudest live state's glyph (waiting's amber dot,
else working's spinner, a still dot while the thread's own turn runs, else
the queued ring) and the live count, amber while one needs you; with
nothing live the agent glyph `person.2` alone. Its accessibility label is
the cue's line ("Agents: 1 needs you, 2 working"). The menu (`ThreadMenuItem.items`), in order: the reason a
lesser key cannot act (first, when there is one), Rename…, in the shell
Account… for a thread that spends from an account (the account chip's
sheet, "The account chip and menu" below), Pin, the master pin, the fleet
switches and Resources… (roots), a divider, Archive (roots, destructive). A
subagent's menu has the reason and Rename only.

Below the header, the type decides the body. The composer (L5) docks at the
bottom, the desktop's box, with the desktop's slot above it: the turn's
elapsed and Stop, or the held rows (paused with Stop and Continue, stopped,
queued). The header's elapsed and the slot's answer different questions
(the thread, still live; this turn's run) and neither carries a flavour word.

### The thread screen on the iPhone Duo

The screen reads its own size class and its own width, never the device,
its orientation or the idiom (the Duo is a `.phone` with regular size
classes inside, and the shell's split can hand the screen a column narrower
than the window). The rules are the client package's
`Rendering/ThreadPose.swift` (`ThreadPose`, `TwoPaneColumns`,
`ReadingMeasure`, `TranscriptReflow`; `ThreadPoseTests`); the 27.1 reads
(the division band, the vertical bar, the bar region) are
`Design/Duo.swift` behind a runtime `#available(iOS 27.1, *)`. The four poses:

| Pose | Window | The screen's own column | What it does |
| --- | --- | --- | --- |
| Folded portrait | 466×678, compact×regular | 466 | The phone's screen, unchanged |
| Folded landscape | 678×466, compact×compact | 678 | The pager; the header is one line; the segment bar leaves while the field has focus |
| Unfolded landscape | 951×669, regular×regular | 951 less the 84 pt tab rail, or 547 beside the sidebar (iOS keeps it at 320) | Hero and chat side by side from 680 pt, the chat at least 360; the pager beside the sidebar |
| Unfolded portrait | 669×951, regular×regular | 669, or what the 320 pt sidebar beside it leaves | The pager: 669 is under the 680 two panes need |
| Half open | 951×669, regular×regular, partly open | 867 with the sidebar hidden; shown, the sidebar fills the first panel to the fold (456) and the thread starts past the band (371) | Two panes on the fold's band with the sidebar hidden; the pager beside it |

**The sidebar keeps 320 on iOS 27.1, and the desktop's rule stays.** The
shell asks the split for 260 pt (`SidebarColumn`, 320 at most), but the
unfolded Duo's `NavigationSplitView` holds the sidebar at 320, which leaves
the thread 547 of the 867 the tab rail leaves. The chat's 360 and a hero's
320 do not fit in 547, so a board thread beside the sidebar reads on the
pager and becomes two panes once the sidebar is hidden. There is no UIKit
workaround to win back the 60 pt; the proof holds the sidebar's width to
[260, 320] and the thread's mode to what `ThreadPose` gives the column it
was actually handed.

**Two panes** when the column is regular width and at least 680 pt
(`ThreadPose.twoPaneMinWidth`: a 320 pt hero beside a 360 pt chat, the
desktop's chat floor beside a board), else the pager; size class first, so
a 678 pt folded-landscape column is never two-pane. The hero is left, the
chat right, on the desktop's split (`ThreadPose.columns`): the chat keeps
at least 360 and the hero yields first; an implementation board fits its
widest task (`ThreadPose.boardFit`, an estimate from the labels' lengths:
320 pt up to half the body, at most 672); other heroes start at half; a
vertical fold band still sets the gap when both sides keep 280; one vertical hairline
between them (`Hairline(axis: .vertical)`), no sash and no collapse; no
pane titles (the board, plan, fleet or sources read as themselves and the
composer names the chat). The composer and the working strip sit under the
chat column only, with the soft edge under them; the hero runs to the
screen's bottom like a desktop board and ignores the keyboard. Per type:
Board | Chat (implementation, master), Plan | Chat (planning, project
plan), Sources | Chat (research), Fleet | Log (orchestration); a chat, a
subagent and an unknown type are one transcript. The segment bar is gone
and the needs-you dot has nothing to mark (`SegmentRules.dot` answers nil;
everything that lands is seen on both). The remembered segment is kept
untouched through two-pane, so folding back lands the pager on it.

**The measure.** A lone transcript at regular width (a chat, a subagent, the
agent detail) reads at most 768 pt wide, the desktop's column, centred
(`ReadingMeasure.cap`); the composer's box, its row and the slot take the
same column and its 16 pt edges (`ReadingMeasure.columnFrame`), so the
box's edges are the text's; the scroll indicators stay at the screen's
edge. The plan page, the research report and Notes read at 640
(`ReadingMeasure.documentCap`; `ReadingMeasure.cap(for:)` is the rule by
segment); the board, fleet, sources and master lists are rows and
take the column. An agent page in the transcript is 640 wide in a lone
transcript and re-measures on a fold; its full screen takes the column. The
diff stays unified at every width.

**The fold keeps the reader's place.** A width change (a fold, an unfold,
the sidebar toggling, the pager becoming two panes) keeps the transcript's
end when the reader is there and the row at the top edge otherwise
(`TranscriptReflow.anchor`). On iOS 27.1 the transcript's `List` never
reports `scrollPosition(id:)` and its cells get no geometry while UIKit
scrolls them, so the top row is the earliest row on screen in list order
(`TranscriptReflow.topRow`), from the keys the rows' `onAppear` and
`onDisappear` keep, never moved while a reflow is open; nothing is read per
frame. The anchor is captured once, `atBottom` is
held while the geometry flickers, and the anchor is restored with no
animation at 0, 250 and 600 ms after each width step, each new step
restarting the run. A size change is not an open: `TranscriptLanding` is
untouched. A reader inside a long reply keeps their place inside it: at
the capture the view reads the top row's frame from the list's own
layout (the `UICollectionView` under the `List`, the row's item found by
`TranscriptReflow.item`, refused when the list holds another count than
the window says) and keeps `TranscriptReflow.Place`, how far the row's
top sits from the edge and the share of the row above it; each restore
scrolls the row to the top, then puts the same share of the re-wrapped
row above the edge. A page loading above (`extend`) keeps the same points
the same way. What else a fold keeps, and by what:

| State | Kept by |
| --- | --- |
| Transcript end or reader's row | the reflow above |
| Streaming reveal | `StreamingAssistantRow`'s `@State` pacer, same row identity |
| Live cards' decisions and refusal line | `@State` in the card actions, same identity |
| Composer draft, photos, focus, keyboard | the dock never moves in the tree (one `tcBottomBar` in every mode) |
| The working strip | the same |
| The pager's segment | the page re-asserted on a width change; the remembered choice untouched |
| The Notes sheet | the system keeps a presented sheet through a size change |
| The diff and page screens | pushed screens with their own geometry |

One view tree serves the pager and the two panes: the same horizontal scroll
view and the same `ForEach` with the same ids, the pages given explicit
widths from the pose and the scroll disabled in two-pane, so a fold changes
frames and never a view's place.

**Folded landscape** (678×466, compact×compact) is the pager with three
changes: the header is one line, the mark leading the title and no words
(`ThreadHeaderLine.compactHeight`); the segment bar leaves while the
composer has focus and returns on dismiss, out on `Motion.collapse` and
back the way a row appears (`Motion.appear(reduced:)`), so the newest rows
and the field are what the 150 pt body shows with the keyboard up; a swipe
still switches segments while the bar is away. At the accessibility text
sizes the bar leaves with focus in any pose, and the field scrolls past two
lines (`ComposerHeight.maxLines(accessibilityText:)`), so Steer and the add
button stay above the keyboard. Focus, not a keyboard frame,
is the signal: UIKit reports zero-height keyboards around a fold.

**The vertical bar** (the inner display in landscape, the outer display) is
accepted as the system draws it: every trailing item has a symbol, so none
is dropped; the agents button, a custom view the system never shows
vertically, draws its glyph alone under `\.tcVerticalBar` (the count stays
in its accessibility label and the fleet rows); the title stays.

**The bottom line.** The dock's bottom is the safe area, which already
holds a bar the system owns. When a bar floats inside the window's bar
region (`UIView.LayoutRegion.bar`, read by `BarRegionProbe`), the dock adds
the region's bottom less the safe area's less a 6 pt gutter
(`Duo.barInset`), so the capsule's bottom meets the bar's line; otherwise
nothing. Keyboard avoidance is the system's; nothing reads a keyboard
frame.

**The division region** is never under static chrome. While the device is
partly open the fold's band (`Duo.divisionBand`, the first active
`.division` region in the body's own coordinates) is the gap between the
panes when it is vertical and leaves 280 pt on each side: the hero ends at
its leading edge, the chat starts at its trailing edge, and no hairline is
drawn (the fold divides). A horizontal band changes no column: that pose is
the pager, whose chrome is at the top and the bottom. A hinge move bumps a
counter the geometry re-reads the band on.

**Proof shots** (`TC_PROOF_SET=duo`, the matrix in scripts/ios-sim-proof.sh
`duo_shots_shell`, `duo_shots_thread` and `duo_shots_sheets`; "The proof"
under "iPhone Duo" has the run). One seeded thread per type: chat "Why does
the gateway refuse http for Codex?", implementation "Add dark mode to the
settings screen", planning "Move the thread history onto the box", master
"Ship the stats pipeline", research "SQLite on the phone: bun:sqlite or
GRDB", orchestration "Ship the iOS thread screens". In `unfolded`,
`unfolded-portrait` and `half-open` each opens on its hero with the sidebar
shown (`TC_TEST_SIDEBAR=shown`) light and dark, and hidden light, dark, with
the keyboard up (on the chat, `draft:`) and at accessibility-large. Each
shot's `pose-<sessionId>.json` lands beside its layout report and
`pose_check` holds it to this section: the sidebar's state as asked and,
beside the thread, its width in [260, 320] (half open, up to the fold); the
thread's column starting at the sidebar's edge (half open, past the fold's
band, 48 pt at most) and ending where the window less its safe area does;
the mode `ThreadPose` gives that column and `TwoPaneColumns`' split; the
measure (768, 640 for a lone plan, or the column less 32); the composer's box
on the column's edges; the draft's length when one was typed. The fold run
is a streaming implementation thread with a draft and an undecided approval,
started at the bottom and then 700 pt up.

**Where the phone still differs from the desktop** (2026-11-05: the six
unfolded shots beside `ui:preview` of the desktop's ActionGroup and
FailureCard fixtures). The transcript's rows match: one group per stretch,
the lone row, the table's frame, hairlines and grid, the verb muted and the
object loud, the counts, the end row's "Worked for", the compaction row.
What does not:

- In the proof rig the phone pairs the same server several times (the test
  server's relayed loopback hosts), and the strip and the fleet list a
  thread once per pairing, so titles repeat; whether the fleet should fold
  them is open.

### The composer, the strip, the cards' actions, the sheets

The composer is the desktop's box (docs/LAYOUT.md "Composer") drawn on
Liquid Glass in every pose (`Thread/Composer.swift`,
`Thread/ComposerStyles.swift`). It floats over the transcript: ThreadScreen
hangs the dock with `.tcBottomBar` (Design/Glass.swift), `safeAreaBar` with
the soft scroll edge effect on iOS 26, so the content scrolls under it, a
soft edge (the thin material and the background step fading in from 24 pt
above the dock) keeps passing text from reading through the glass, and no
divider is drawn; before iOS 26 the same call is a `safeAreaInset` on the
bar material. The box and the slot above it share the transcript's column
and edges (`ReadingMeasure.edge` from the screen, the column's width at
most). The dock reads three fields of the thread's state and no more
(`DockState`: a send waiting for its echo, the click that opened the turn,
an open compaction), so a streamed word does not run the composer, its
glass or its row again.

The box is one glass shape at radius 12 in one `TCGlassContainer` (glass on
iOS 26, the thin material and a hairline before): `+` at the left, a bare
28 pt glyph with a 44 pt touch; the field in the prose type (15 on 22) with
3 pt above and below, so its first line centres on the controls' 28 pt line;
the button at the right, a 28 pt circle on prominent glass. At a larger
text size both grow with the prose type (`@ScaledMetric` on `subheadline`)
and stop at the 44 pt touch, their glyphs at accessibility 1
(`ComposerHeight.control(scaled:)`, `ComposerMetrics.glyphCap`), so at
the largest size neither spills over the field and the touch stays 44 pt
(`ComposerHeight.hitOutset(control:)`). The controls sit
6 pt from the box's sides and 8 pt from its top and bottom inside a 1 pt
ring, so the empty box is 46 pt (`ComposerHeight`, `ComposerMetrics`). Each
further line grows the box upward by 22 pt while `+` and the button stay on
the bottom line, up to six lines (156 pt, under the 160 pt cap), then the
field scrolls. A keystroke (Return included) and the clear after a send snap
the height; a paste of more than one line eases it over `base` (0.18 s). A
tap on the box's padding puts the caret in the field.

The button follows the desktop's `SendButton` (`ComposerRules`, the client
package's port of `decideComposerAction`): Send (the arrow) with no turn
open; steer (the corner glyph) mid-turn with text or a photo, which goes
into the live turn as the desktop's composer sends it (`queue.add { steer:
true }`; a photo the host queues goes in through `queue.steer`), so the
bubble's word reads Sent, then Received; Pause (`session.pause`, the pause glyph on the label color) mid-turn
with the box empty; a paused thread's text queues. A long press mid-turn
with text offers "Queue for the next turn" (`queue.add`, the desktop's
⌘-click): past the system's long press (0.5 s) the button shows the queue
glyph and one quiet line above the box names it, with a selection tick;
release queues, sliding away lets go. A queued message says "Queued for the
next turn" above the box until the next edit or the turn's end. The glyphs
trade on the icon swap; with nothing to do the button is plain glass with a
quiet glyph, and the accent fills it as text arrives. Mid-turn means the
host runs, starts or waits on the person, or a send of this device's is
out: from the click until the host's status moves (the turn starts, is
held, or a status row lands after the echo), so the echo arriving before
the host's `starting` never flashes Send between two Pauses, and the
click's clock is dropped once the turn it opened has closed; a watching master is not mid-turn, so its button is Send. Stop lives in
the slot. The field's placeholder is "Steer" for a root implementation or
orchestration thread or a master of any type, "Message the agent" for a
subagent, "Message" otherwise. `+` opens Photos. A model or effort picked
in the row under the box rides on the next send as `session.send`'s
`provider`, `model` and `reasoning` (`TurnModel.override` sends nothing
when the choice matches the thread). A read
key, a halted host or a dropped link (after the desktop's 1.5 s grace) puts
the reason in the field in place of the placeholder; the field is off and
`+` and the button leave. A light impact on send and on a queue, a selection
tick when the hold turns into a queue, never on typing; the field clears
without animation. The list behind it dismisses the keyboard interactively.

**The composer's `@` in a Work thread.** Typing `@` at the start of a word opens a
list over the box on the same glass as the box, its own shape: up to four and a half
rows show and the rest scroll. A row is the kind's glyph in the glyph column, the
thing's name in the title step (two lines at most), and its fact and time in the meta
step under it; the whole row is the 44 pt press. Loading… with a small spinner before
the first answer, No Matches when nothing does, and one quiet line for what could not
be searched. The list appears and leaves with no motion (a key opens and closes it),
and its rows never empty under the typing: the last answer stays, cut to what still
matches. A tap takes the `@words` out of the box and puts the chip over the field:
the chips sit in one row above the box, each its glyph and name on the fill at the
row radius with its Remove, arriving on `appear`; a chip alone sends. A file, held
act or person row dragged onto the box is the same chip. The sent bubble shows the
chips over his words, as the box showed them.

**The project's draft.** A project keeps one remembered draft, the
desktop's new-chat screen (lib/projectDrafts.ts), and a workspace's loose
chats keep one of their own (`loose:<workspace>`): the client's
`ProjectDraftStore` (Client/ProjectDrafts.swift) keeps, per link key, so a
linked project's copies share it, the text, the name, the type, the model and
effort, the permission mode, the Master pick of a chat and the host of a
linked project, 64 keys for 30 days in UserDefaults (`project.drafts.v1`);
its photos wait in memory for the run (a draft has no session to upload
into) and go up once the thread exists. The shell with no thread open
shows it (Shell/DraftComposer.swift): the strip, an empty body, and at the
foot on the transcript's column the composer's box (`ComposerBox`, the
one a thread's composer draws), the row under it with the draft's own
model, effort and mode, and 4 pt under that the draft row: the type chip
(its tinted glyph and its name, a menu of the types with their one-line
hints), "Master thread" after it for a chat (a quiet check for any key
that can send; a read key's box already says why it cannot), and at the trailing edge the host of a project linked across hosts
(every copy with a check on the one the send starts on, then "New copy on
<host>" for a connected host without one, through `project.ensureLinked`;
a host with no checkout says why in the line above the box). Nothing
reaches the host until the first send: `session.create { firstMessage }`
(`ThreadDraft.firstMessage`, `master`), or with photos the create, the
uploads into the new thread, then the send, and `session.archive` when the
send fails (`session.delete` is not the phone's; `DraftSend`). The send
opens the new thread in the shell. The box empties at the click, as the
desktop's composer does: the sent text, name and photos ride the strip's
chip (`ProjectDraftStore.take`), the field and `+` stay open while the
create runs, and what is written or picked meanwhile is the next draft; a
failed create gives the sent words and photos back ahead of it
(`ProjectDraftStore.restore`). Send waits for the host's catalog (`DraftSend.canSend`:
no send with an empty model, which would skip the host's thread defaults),
and switching the draft's host loads that host's catalog anew
(`CatalogLoad`). The load is keyed on the host and whether its link is open
(`CatalogLoad.Trigger`): a draft opened before its host connected, or moved
to a host that is reconnecting, asks again the moment the link comes up,
and meanwhile the row says why in the model's place, "Waiting for <host>"
in the row's detail type, tertiary (`CatalogLoad.waitLine`). An ask that
comes back with nothing while the link stays open (the host erred) is asked
once more after 2 s (`CatalogLoad.retryMs`); when that fails too the row
says "Couldn't load models" in the detail type, secondary, with Retry after
it in the accent (its touch 44 pt), on a draft and a thread's composer
alike (`CatalogLoad.failed`, `CatalogChoice.retry`); a failed Retry says so
again at once. The picker is
the one source of the model and effort the create carries
(`ProjectDrafts.threadDraft` takes what it shows): the draft's saved pick
only seeds it, so after a host switch the send carries the model that host
settled on, never the saved one. While the create runs the button's glyph is a spinner
(the icon swap, "Sending" to VoiceOver) and the strip draws the thread's
chip. A refusal puts the sent draft back with the reason above the box. The draft
row's name field, "Name this thread" in the row's detail type after the
type chip (the desktop's DraftTitleField: one line, at most 80 characters,
the placeholder quiet and the typed name primary, giving way before the
pickers, Return back to the message), is kept on the record as `title` and
sent as `session.create { title }`; left empty, the host names the thread
from the message, and a placeholder title never sticks (the host's
`isPlaceholderTitle`). The store keeps every change in memory at once and
writes the drafts after 500 ms of quiet (the desktop's debounce), and at
once when the draft leaves the screen or the app leaves the foreground
(`ProjectDraftStore.flush`). New thread (the strip's button, the card's
menu, the workspace's bar, Home's long press) opens the shell on its draft
and focuses it, setting the type when one is asked for and keeping the
text (`NewThreadPresenter.compose`, `ProjectDraftStore.focus`). The New
thread sheet stays only for a prefilled brief.

The row under the box (`Thread/ComposerRow.swift` over the client's
`ComposerRow`, the desktop's row under its box) is 24 pt, 4 pt under the box
and on its edges, always there, in every pose. At the left the model and its
effort (the provider's glyph, the model's name, the effort word): a menu of
the host's catalog (`catalog.get`, one section per provider with a check on
the current model) and then Effort with that model's ladder; the choice
follows the thread until a pick, which rides the next send. At the right
the context meter, a 14 pt ring (a quarter-strength track and the filled
arc) and the percent in tabular digits from `SessionMeta.context`, secondary
below 85 % and the warning tint from it, never red, a mini spinner in the
ring's place while the harness compacts, and nothing until the host reports
both the level and the window; then the permission mode (the lock, pencil
or open lock and the desktop's words: Supervised, Auto-accept edits, Full
access), a menu over `session.permission` with each mode's hint, shown at
once and put back if the host refuses. Every control is quiet: the detail
type (12 on 16) in secondary, its touch reaching 44 pt. A key that cannot
operate reads the model; one that cannot approve reads the mode. The row
never wraps; a narrow one gives way in the desktop's order
(`ComposerRow.fit`): the percent under 400 pt (the ring stays), the effort
under 368, the mode's label under 320 (its glyph stays), the model's name
under 144 (its glyph stays). At a large text size, where the words outgrow
those widths, it keeps giving way in the same order and only the last step
lets the model's name truncate (`ComposerRow.steps`, one `ViewThatFits`). An
iPhone in portrait (a 370 pt box) keeps everything but the percent. The sheets' permission rows read the same words
(`PermissionWords`).

Photos (`Thread/ComposerAttachments.swift`): `+`, for a key that
operates, opens the system photo picker, up to four per turn. Each photo
goes up to the thread's host the moment it is picked (`attachment.begin`,
one chunk at a time, `commit`; the client package's `upload`) and shows in a
strip above the box: a 56 pt thumbnail at the row radius with a 10 %
outline, a 2 pt bar in the accent along its foot while it travels (its width
rolls on the 150 ms numeric curve), gone once the host has it, and a remove
control at the top trailing corner (its touch the corner's 44 pt square). A
failed upload keeps its chip with the bar in the destructive tint, a line
under the strip ("A photo didn't upload"), and a tap on the chip (or its
menu's Retry) tries again; Send waits until every
photo is on the host or removed (Pause never waits). The turn names the
committed photos, and a refused send gives the text and the photos back.

The slot above the box (`Thread/WorkingStrip.swift` over the client's
`ComposerSlot`, the desktop's `composerSlotOf`) holds one 28 pt row in the
detail type on the column's edges, its actions small glass capsules at the
trailing edge (`.glassProminent` in a tint for the one thing to do). While a
turn works or waits: the turn's elapsed in secondary tabular digits that
step with the second and do not roll (from a second on), counted from the
click (`ThreadState.sentAt`, which the
optimistic send stamps when no turn is open; the host's later `busySince`
never steps it back), and Stop, which reads "Stopping…" while it is out.
Paused: the pause glyph in the warning tint, "Paused", on a master "and 3
batch threads with it", the frozen time last, then Stop and Continue
(warning). The actions follow the composer field's block: a read key sees
none, a dropped link leaves them disabled only past the field's 1.5 s grace,
and the row's words never dim. Stopped:
the stop square, "The harness is gone", the frozen time and Resume (accent).
Queued: the clock glyph, the host's reason ("Waiting for <sibling>", "120 of
120 running") and Start now. Nothing for watching, failed, idle or done (the
transcript's closing line and the failure card say those), and no flavour
words: what the thread does is the transcript's working line. While empty, a
locked relayed host's one line. At regular width the slot keeps its 28 pt
whatever it holds, so nothing moves when a turn starts or ends; at compact
width it rises in on the layout spring when it has something. When it
empties the outgoing row stays, inert, fading over `fast` (0.12 s), at once
under reduced motion; between states only opacity moves. A refused action
re-enables its control and says nothing more: the block is already in the
field.

The live cards' actions (`Thread/CardActions.swift`; the cards' rendering
stays in `Thread/TranscriptRows.swift`) are full-width 40 pt buttons at the
card's bottom, at the row radius (the recorded exception to outer = inner +
padding: the card's 12 less its 12 of padding leaves no room, so the next
step down is the row): Allow prominent in the accent with a white semibold
label, Deny quiet on the fill step; Answer prominent, at half opacity until
every question has a choice. A decision shows the moment it is tapped:
the heading reads Allowed or Denied before the host answers (the client
records it before the wire, `CardDecision`), it goes once (a second tap
while it is out, or after this device decided, sends nothing:
`ThreadState.deciding`), the buttons fade as the card settles in 200 ms
ease-out, and a refusal puts the buttons back with one quiet secondary
line ("Not allowed: …", kept on the thread as `ThreadState.refusals`, so
the buttons coming back still say it) that the next decision clears. A
computer step held for the Mac (the request's `choices: run-skip`, the
host's computer/schedule.ts) takes the same card in the desktop's words:
the heading says why it asks, "Waiting for the Mac to be free", the
buttons are Run now and Skip (Allow and Deny underneath: `session.approve
{ allow }`), the verdict Ran now, Skipped or Skipped automatically, a
refusal "Not run: …" or "Not skipped: …"; every word is `CardDecision`'s,
keyed by the request's `choices`, and anything else (absent, `allow-deny`,
a value this build does not know) keeps Allow and Deny. A computer tool's
card (`computer_session` and the computer tools by any prefix,
`ApprovalShape.titleOnly`) is its title alone, which already names the
app, the window and each action, never the input's fields under it. The
question card takes the desktop's proportions (components/ui/
question-card.tsx): the amber glyph beside the title (the question's
header, else "Question") in 15 medium, each prompt in the prose type, its
options as 28 pt rows with their description line under the label, the
picked one on the fill step; the desktop's key tiles stay on the desktop.
The failure card follows the desktop's recipe (surfaces/FailureCard.tsx):
a card at radius 8 with 12 in, the summary in the line type at medium
beside the red glyph, the cause muted 2 pt under it, everything under the
summary on its text edge, at most three actions, each sized to its label
and wrapping from that edge as the desktop's flex-wrap does (as many on a
line as fit, 8 pt apart, the next line 8 pt under it; `FlowLayout` over the
client package's `FlowRows`, so a large text size falls one per line): the first solid, the rest quiet (bordered in the label
colour), Retry last. The phone's set is the desktop's within its reach
(`FailureActions`): Route automatically, Continue on another model (the
composer's model menu; the pick continues the thread on it through
`session.continue`) and Retry; no line sends the person to the desktop. A key
that may not act sees nothing in the buttons' place: the composer says it once,
in the desktop's words ("Send from a computer that manages the box",
`ActionBlock.sendText`); an approval or question card, whose presses are the
thing missing, says "Answer from a computer that manages the box"
(`answerText`). A link down for a moment sees the buttons at half opacity with
the reason under them.

The sheets (`Shell/ThreadSheets.swift`) are the system sheet at medium and
large, 16 pt corners, the drag indicator shown, Cancel on the left and the
one confirming verb (Start, Create, Save) semibold on the right, off until
the form is valid. The type is a grouped inline list: the type's glyph
tinted at the label's weight, the label, the desktop's one-line hint, the
system check on the chosen one. Start a build offers Implementation and
Orchestration, one thread either way; New thread the six root types, and
opened prefilled from the Inbox (the item's repository, title and a
one-line reference as the first message) it adds a title row and a message
row and sends the message right after the create. The
model and reasoning rows read as menu pickers (value in secondary, the
up-down chevron in tertiary) and open the same catalog menus as the
composer's chips. Rename is one field with the title at medium, Save off
until it reads differently; the row menu opens it (the thread screen
renames inline in its header).

Where the desktop splits board and chat side by side, the phone uses a
segmented control under the header with two segments and a swipe between
them. The control is bound to the pager: its raised pill sits at the pager's
offset in pages (`SegmentRules.pillRect`), so it follows the finger during a
swipe and settles with the drawer curve on a tap; each label's primary copy
fades over its secondary one by the same offset (`SegmentRules.weight`),
never a swap of two states. It is drawn the way iOS 26 draws its own
segmented control: the track a glass capsule 36 pt tall (scaling with the
labels), the selection a capsule 3 pt inside it (two capsules are always
concentric), on the raised step with a soft offset shadow in light and the
step alone in dark, a solid surface inside the glass, never glass on glass.
The system control cannot follow a pager's offset, which is why this one is
drawn. The segment chosen is remembered per thread. A warning dot beside the
inactive segment's label marks a new needs-you card there: 6 pt, 4 pt off
the label's trailing edge, both scaling with the label; it grows from a
quarter of its size, fading and unblurring, on the expand spring, and leaves
by opacity; the label never moves. Under reduced motion a tap jumps and the
dot fades. The default segment is the one the desktop makes the hero
(`ThreadPhase.defaultSegment`); a planning thread stopped on a question
forces Chat.

A thread moved or deleted while open shows one quiet line where the body
was, keeps its last title in the header, and loses its composer, segments,
agents button and menu.

Slots, for the threads that fill them (each a named line in this thread's
files, never an empty view):

- (a) host chip: `ThreadHeaderLine.Part.host` rendered in
  `Frame/ThreadHeader.swift` `HeaderPartView` (thread 22).
- (b) account chip: a `Part.account` case after `.model` in
  `Rendering/ThreadFrame.swift`, rendered in `HeaderPartView` (thread 24).
- (c) Notes: the trailing group in `ThreadScreen.swift` `trailing(…)`,
  before the agents button (thread 18).
- (d) fleet switches and Resources…: `ThreadMenu` in
  `Frame/ThreadToolbar.swift`, between `pinItem` and the divider (thread 20).
- (e) master view: `ThreadSegment.segments(for: .master)` and the `.board`
  case of `ThreadScreen.body(for:)` (thread 16).
- (f) project plan view: the `.plan` case of `ThreadScreen.body(for:)`
  (thread 17).
- (g) the subtitle by status: the table above, in `ThreadHeaderLine.init`.

**Notes.** Every root thread's bar carries a `note.text` glyph with a 6 pt
neutral dot when the notes changed since this device last read them (a
per-thread mark in UserDefaults, never synced). It presents the Notes sheet
at the large detent with the 16 pt sheet radius: the menu (Copy as brief,
light haptic) leading, Edit ↔ Done trailing, no close button; swiping down
dismisses and saves. The document is the five sections (Goal, Decisions,
State, Pointers, Open questions) in order, each heading in `.headline` and
its body through the plan page's block stack (PlanType's type and spacing,
parsed through the plan pages' cache); an empty section is folded
to its heading in tertiary with the same spacing, so a thread that wrote only
Goal and State still shows the five-part outline; headings the thread
invented come after. Edit swaps the page for a plain `.body` text editor of
the whole file (autocorrection on, no mono), saved 800 ms after the last
keystroke, on Done and on dismiss; the one quiet line under it reads "Not
saved" after a failure, or "The thread updated the notes meanwhile" with a Load
theirs button when a push passed the text the edit began from. A push while the
sheet is open replaces sections in place by heading: the reader's section
stays anchored, a changed body cross-fades 150 ms, and nothing animates on
first paint. A read key shows its reason where Edit would be. On Home, a
waiting thread's needs-you row carries the first line of its State as its
second line; the cue's seq still routes the tap to the card.

### Chat

The transcript is the whole body, the desktop's `AgentTranscript` row by
row (`Sources/Thread/TranscriptView.swift`, `TranscriptRows.swift`,
`ActionGroup.swift`, `MarkdownView.swift`; the shared ingredients in
`TranscriptStyles.swift`). What the list shows is the client package's row
model (`Rendering/TranscriptRows.swift`, the desktop's `transcriptRows.ts`
and `transcriptActivity.ts`): an entry on its own, a group of the
agent's work between two paragraphs, or a turn's end row (its working
line while the turn runs, then its closing line), each under one key that never changes while
the row is on screen (`TranscriptRowID`, the desktop's `rowKey`): an item,
a group and the step it grew from share one key, the first step's
`ThreadEntry.key`, which the fold gives at birth and keeps (a call born
from a partial keeps its provisional key when its final row stamps the
seq; the host's echo of a sent message keeps the optimistic row's key;
`RowKeys` carries both across a refold); a group keeps its key when
history joins above it (`RowKeyMemory`), and only while that step is still
in it: a key that left the run (a page that settled into its own row)
stays with that row, so no two rows share a key; the turn's end row is
its first message's key with `end` set, one row from Send to the close. A
message that lands while its turn is open (a steer, a send mid-turn: the
turn's close stamps both at once, `TranscriptRows.joins`) is a bubble
inside that turn, never a turn of its own, so the end row stays one
element and closes under it; every row reports its reveal under that
turn's key (`TranscriptRows.turnKeys`, the end row's `userKey`), so the
reply to a steer holds the closing line until it has drained. A
`stopped` status (the harness gone) closes the turn as the desktop's fold
does, so a message sent after it opens a turn of its own; a Resume
instead (the host writes starting then running and no message) reopens
that turn, the desktop's `resumeTurnClock`: the working line comes back
under the same message and the closing line states the whole span less
the time it lay down (`UserTurn.downMs`), the span the strip counted. It
is the one time a closing line turns back into the working line
(`TurnEnd.resumed`, which the scenario runner's morph check admits). Every turn but
the last takes its rows from the last build while its entries, its place
and the row above it read the same (`RowKeyMemory`'s settled turns, a
copy of each turn's entries, never a slice of an old build's array; the
desktop's `settledRows`), so a delta builds the live turn's rows alone. Rows sit apart by the desktop's
`ROW_GAP` (`RowGap.above`, applied as each row's top inset): 16 above the
thread's first row, 32 above the person's bubble, 16 from the bubble to
its first reply, 4 between two lines, 12 around a block, 8 from a turn's
last row to its end row (inside the end row's fold, so a folded line
takes none) and 16 under the last row. The list, a
search landing and the scroll proof all speak rows. The DEBUG
`transcript-report.json` field `topRow` holds the stable row key (or -1),
which can differ from its persisted seq after a partial call or a local send. What the list does to
its own offset is `FollowRule`: it follows the newest row only while the
reader is at the bottom with no finger on the list, and never writes the
offset while they are up or dragging, however the rows change. `ScenarioRunner` (Rendering/TranscriptScenario.swift,
the desktop's "no jerk in any scenario" runner) plays the desktop's ten
scenarios as timed pushes through the fold and the rows on an injected
clock and asserts all three after every push, with the reveal, the fade
and the drain (`TranscriptScenarioReveal.swift`) and the phase hold, the
word morph and the closing line's wait for the drain
(`TranscriptScenarioLine.swift`: each end row's `TurnLineModel` sampled at
every reveal step and every hold's end, its words through a `MorphModel`;
`ScenarioReport.lineEvents` lists each morph and fold). The plain-words tool lines are
the package's `ToolPhrase`, `GroupPhrase` and `ActionRow` (tested). Row kinds and their mobile form:

- **User turn**: the desktop's bubble (transcript/UserMessage.tsx): at
  the column's trailing edge on the chrome fill, radius 12, padded 12 × 8,
  no outline, in the prose type, as wide as its text and never past 85 %
  of the column (`UserTurnLayout` in the client package, a `Layout` in
  TranscriptRows.swift); attachments above the text as thumbnails (images,
  decoded at display size, a 1 px outline at 10 %) or a wash chip with a
  glyph (documents, threads); six lines, then "Show more" on tap; Copy
  Message in the context menu. No stamp under it (the desktop's shows on
  hover only): the turn's closing line carries the time. The project rules
  the host put ahead of the first message fold 4 pt above the bubble
  (`PreambleRow`). A bubble sent from here rises 16 pt and fades in over
  `Motion.rise` (0.24 s on the drawer curve), once: the host's echo keeps
  the optimistic row's key and TranscriptView's `BornRows` has claimed it;
  any other row born after the transcript opened fades in over `fast`
  once; under reduced motion both fade over `fast`; nothing moves on the
  first paint or on scroll back (`BornMotion`). A steer (a message sent
  into a running turn) carries one word under the bubble at its trailing
  edge in the detail type (12 on 16, its row 16 pt) in secondary: Sent,
  Received, Queued for the next turn, or Not delivered in red; a change
  morphs (`MorphText`, the working line's morph); the time in the locale's clock ("2:02 PM", or "14:02"
  where the locale writes 24-hour: `TimeFormat.clock`, the desktop's
  `clockTime`) and how it went in ("Received at 2:02 PM, as its own
  turn") are its accessibility value (`SteerStamp` in the client package,
  folded by `ThreadFold`). The scenario runner's `.steer` check holds the
  word to moving only forward.
- **Assistant**: markdown as the page, `body` size, no container, a
  generous measure, selectable, Copy Message in the context menu. Code
  blocks: the desktop's bordered block (10 pt radius, the content wash, a
  hairline edge), the language as a small header when the fence names one,
  line numbers in the dim step, mono one step down, horizontal scroll,
  never wrapped, a fold past 40 lines, Copy in the context menu. Pipe
  tables are a bordered grid that scrolls sideways. Inline code is mono one
  step down on the fill step. A block with no words yet is no row. A streaming block mounts
  `StreamingAssistantRow` (`Thread/StreamingRow.swift`, the streaming
  thread's seam), whose markdown parses incrementally on the main actor:
  only the block that changed (normally the last) is parsed again
  (`MarkdownCache.streamingDocument`), so the earlier blocks keep their
  render and nothing flickers between plain and styled; a paragraph past
  8 KiB stays plain until the next block boundary, and once the row
  settles its stand-in is the whole parse, styled. The last block's open
  inline spans are closed before it is parsed (`MarkdownClose`, the
  desktop's remend: `**`, `*`, `_`, `~~`, a code span, a link's text or
  address, the closer before trailing whitespace, a mark with nothing after
  it left out until its word comes), so no raw mark shows and the
  paragraph's text only grows, which keeps its fade ledger. A settled reply
  parses off the main actor before its row mounts (the transcript asks for
  its window's, newest first: `MarkdownCache.prefetch`), so it draws styled
  from its first frame; one whose parse has not landed keeps its plain
  text's height, undrawn, never plain text first.
- **Thinking**: a thought is no row. While it streams the working line
  says its newest finished sentence in Thinking's place; once it ends it
  shows only in a group the person opened, as "Thought" in `secondary`,
  which opens the text. A run of thoughts alone draws nothing, and a
  lone call with a thought before it is a lone step.
- **The working line** (`Thread/WorkingLine.swift` `TurnLineRow`, over the
  client package's `TurnLineInput` and `TurnLineModel` in
  `Rendering/TurnLine.swift`, the desktop's TurnEnd.tsx and `TurnLine`):
  the turn's end row from Send to the turn's close, one row under its
  message's key that never remounts. One 28 pt line at the prose edge:
  `WorkingMark` in the 14 pt glyph slot, then 22 pt in the phase's words
  in `WorkingText`, the line type, each phase held 300 ms
  (`HeldPhase`) and changing through `MorphText`. The words are
  `LinePhase.of`: Sending until the host echoes the message; the host's
  words for a wait before the turn's own content (`LinePhase.hostWords`
  over the meta's detail, "Waiting for the provider, 25 s"); "Waiting on"
  an agent by title (several counted) while the turn's own open wait holds
  it, drawn like a call, "Waiting on" muted and the agent in the primary
  step (`WaitSteps.waitOn`, the desktop's `openWaitOf`: the turn's last
  `wait_for_agent` still running with nothing after it that speaks, runs
  or waits on an approval; read from the turn, never the meta); one running call by its verb, muted, and its object in the
  primary step, except a lone computer call while the host sends words
  for it, which says them ("Clicking button Save in TextEdit", "Waiting
  for the Mac to be free, 2nd in line", "Waiting for the clipboard", keyed
  to the first comma so a hold and its release morph; a box thread's
  bridged hold arrives the same way); several by the group's phrase; a streaming thought's
  newest sentence, said once as Thinking to VoiceOver; the mark alone while
  prose streams; else Thinking. A card that waits on the person (an
  approval undecided, a question unanswered) or a paused, stopped or
  queued thread folds the line closed with its words kept, its mark and
  shimmer standing still while folded; the resume opens it again. The
  line follows a hold `TurnLineModel.holdSettle` (0.23 s) late at both
  ends, so the card that holds it lands or folds first and two rows never
  change height in one update (together they made the `List` drop the
  heights of the rows above the reader for a frame, the offset falling by
  thousands of points until the next pin); a hold shorter than that never
  folds it. The person's Stop row draws nothing: the line morphs to
  Stopped. Once the turn is over and `RevealDrain` says no row of it still
  reveals (the line looks again each reveal step, the drain tells no one;
  believed for `TurnLineTracker.drainBound`, 2.1 s past the turn's end, the
  reveal's catch-up and its last fade, and no longer, so a row that never
  reported its drain off cannot hold the line or wake it forever),
  the mark leaves as an icon swap and the words morph into "Worked for 2m
  4s" ("Worked" until the time lands) and slide 22 pt to the prose edge.
  A turn's end ends every text still streaming (`ThreadFold`), so a block
  whose final row never came cannot hold the line open. A settled turn
  that mounts draws its closing line at once, still; Copy Answer is in its
  context menu. No clock time.
- **The Watching line**: under the thread's last closing line while the
  thread watches (`WatchWords.isWatching`: watching, or idle or done with
  subagents still working): the watching ring, Watching in medium, the
  subject (`watchSubject`: one task by its label, one subagent by its
  title, else counted) and the watch's age ticking each second, amber past
  30 minutes on its own tasks (`WatchWords.isStale`). It opens the agents
  list when it watches subagents. Once shown it stays mounted, folding
  closed when the watch ends; folded, its clock stops (`WatchTicks` in
  Thread/WorkingLine.swift: one redraw and no more).
- **Groups**: everything the agent did between two paragraphs, the
  desktop's `ActionGroup` (`Thread/ActionGroup.swift` with
  `ActionLine.swift`, over the client package's `ActivityGroup` and
  `GroupFold` in `Rendering/TranscriptRows.swift`). The run rule: thinking
  with words, every tool call (edits and todo updates among them) but a
  published page, and the host's steps (`FoldedStep`, the desktop's
  `isFoldedStep`: a report, a spawn, a finished task, a gate, a merged
  review, the pass, the plan's build hand-off, a batch merge, an away
  line) join; prose, a question, an approval, a compaction and every other
  host line (a held review, a failure, Stopped, Batch done, account-gone,
  the restart line) break it; a wait is no step while it is open (the
  working line says "Waiting on <title>") nor once it returned on nobody; a thought the next paragraph repeats word for word
  is dropped. One step is its own row at the prose's edge; more is one
  muted 28 pt line (the glyph of the work it did most, the phrase, the
  counts, the chevron) that opens onto a table: one hairline frame at
  radius 12 from the prose's edge across the column, no fill, a 32 pt row
  per step with its words 12 pt in and a hairline between two rows. A lone
  step and a group are one row under one key, so a second call landing
  remounts nothing. The phrase is the package's `GroupPhrase` (the
  desktop's groupPhrase.ts): reads by folder ("Read 3 files in src/lib"),
  edits by verb, commands and searches counted, agent calls by agent, at
  most three phrases then "and N more", each cut at 48 characters, agent
  titles at 24; failures are the line's red count, never words. Thoughts
  are steps but no rows: one shows only in a group a person opened, as
  "Thought" with no duration. While the turn is open a call the working
  line tells (`LinePhase.told`) is a step with no row (it counts in the
  phrase and in whether the group is lone) and lands as a past-tense row
  once it settles. The group the open turn works in (its last item, or
  only a card waiting on the person follows it) opens on its own at two
  steps and shows its newest five rows, the line still naming them all; a
  step landing fades and rises 4 pt over 0.18 s, the oldest of the five
  leaves upward over 0.18 s. It folds at least 0.6 s after the work moves
  on (`GroupFold.hold`, one wait per hold, cancelled when the work comes
  back), and only with the reader at the bottom: a reader scrolled up
  keeps the group open until they are back there (`GroupFold.release`),
  so a fold never moves what they read. A person's tap on the line or
  opening a row's body decides it from then on, kept by the group's key
  outside the row (`GroupHands`, `ThreadCaches.hands`: the newest 512
  choices per thread, 64 threads), so a remount, a fold of the phone or a
  window reset keeps it; a group opened by hand shows every row and its
  thoughts. Mounted
  working it is open, mounted settled closed, neither animated. A lone
  call becoming a table glides its row 12 pt to the inset on the layout
  spring while the frame fades in over 0.18 s; reduced motion fades the
  frame over 0.12 s and moves nothing. A search hit inside a group opens it
  by hand before the list scrolls to it. A tap that resizes its row in place
  (the group's line, a step's body, a thought, a gate's log, a long bubble's
  Show more) opens and folds on the layout spring as one glide, the
  desktop's height glide (`TranscriptFollow.resize`): the row's height and
  the rows under it move together and nothing above moves; a reader at the
  bottom is followed on the same spring (`FollowRule.Event.handResize`), so
  the rows under it hold and the rows above ride up or down; a reader up is
  left where they are. A `List` never animates its cells from a SwiftUI
  transaction (the cell took its new height in one frame and the rows under
  it jumped), so `ListGlide` (Thread/ListGlide.swift) makes the change with
  no SwiftUI animation and lays it out inside a UIKit spring of the same
  physics: the cells' frames, a row coming on screen (it starts where its
  neighbours were), a row leaving it (a still image of its cell, as it was
  last on screen, glides out) and the follow's offset move as one motion;
  each row clips to its cell while it runs, so an opening table never draws
  over the rows sliding down; the content fades on its transitions' own
  animations and the chevron turns on its own. While it glides
  (`HandGlide`: the spring's 0.37 s and a frame) no pin runs and the
  bottom's verdict holds, and its end asks for one pin. Reduced motion
  changes it at once.
- **Steps**: every row sits on one grid (`ActionLine`, the package's
  `ActionRow`, the desktop's actionModel.ts): the 14 pt glyph slot, 8 pt to
  the verb (secondary), the object (primary, truncating first; a path in
  the middle), counts 4 pt apart in tabular digits (+n success, −m
  destructive, a todo update's `3/7` muted, a failed count red), the
  chevron 8 pt after the last value turning 90° over 0.18 s. Stand-in
  objects fold into the verb ("Ran a command"); a connector's call reads
  as the connector's name with the tool in sentence case. A running step
  draws the still 6 pt dot (the working line is the transcript's one
  moving mark); a step whose turn is over (a Stop cut it) draws settled. A
  row's open body inside the table is its lower part under one hairline
  (12 pt in, 8 pt above and below); alone it is a card (radius 8, the
  chrome fill, 12 pt in). A command's body is the command in mono over its
  whole output in a box capped at 320 pt that scrolls inside itself (no
  "N more lines"; Copy in its menu); any other call's is its input as key
  and value lines over its output. An omitted body is fetched on open
  behind a shimmer; a fetch that comes back with nothing (offline, or the
  host lost it) ends the shimmer in one quiet line, "Couldn't load the
  output" with Retry. An edit keeps its counts on its line and its caret
  pushes the diff screen (unified, mono, line numbers dim; no side-by-side
  on a phone).
- **The shimmer** (`WorkingText`, the desktop's): the words muted, and
  over them a copy in the primary step seen through a band that rests off
  the words until 15 % of a 3 s period, crosses them on the sweep curve by
  85 % and rests again; the band is a layer cut to the words' shape that
  Core Animation moves by its offset alone (`ShimmerBandView`,
  `MotionValues.shimmerLoop`), so the render server draws each frame and
  none runs on the main thread. Still, muted words under reduced motion and
  while the scene is not active.
- **Edits**: the desktop's bordered card: the icon in a 20 pt box, the file
  name medium, the directory dim, a live verb while the call runs, `+n −m`
  in the success and destructive text tints, semibold and tabular; deleted and failed say
  so. Tap opens the diff full screen (unified, mono, line numbers dim; no
  side-by-side on a phone).
- **Agent pages** (`html_render`, the desktop's `HtmlRenderRow`;
  `Thread/HtmlRenderView.swift` over the client package's
  `Rendering/HtmlRender.swift`): a completed call that names a page is a
  row of its own, never a step in a phase. The page itself on the
  transcript, borderless, as wide as the reply, 4 pt above and below, in a
  WKWebView of its own (no shared storage, an origin no host answers) that
  takes no touches, so the list scrolls over it. Its height is the host's
  measurement at the row's width until the page reports its own
  (`HtmlRender.frameHeight`, the desktop's rule); a shimmer of that height
  holds the place and the page cross-fades in over 150 ms. It is themed
  from the phone's colours (system background, label, the system tints) as
  the desktop's variables, in the fragment the page's bootstrap reads
  before first paint and in a message when the appearance changes. The
  bytes come from the host's `/asset/page/<sid>/<pid>.html` with the key,
  one copy per launch for the row and the screen (`HtmlPages`). Tap (the
  pressed dim, no scale) pushes it full screen: the page scrolls under the
  title on the transcript's 16 pt text edges, links open in Safari, Share
  hands out `<title>.html`; a spinner while it loads, "Couldn't load the
  page" with Try Again when it fails; the row's failure is one quiet line
  naming the page.
- **Approval** and **question** cards: the only raised surfaces in the
  transcript, hairline border and warning tint at 8 % while undecided, the
  gray step once decided. An approval says what the agent wants in plain
  words with the command in a mono well (a file write shows the lines it
  adds), then the steering thread's Allow and Deny (`CardActions.swift`,
  full width); decided it reads Approved, Denied or Denied automatically. A question shows
  its header small and dim, the question, the options as rows (28 pt, a 44 pt
  hit; the picked one on the fill step), an Other field when the question takes
  free text, then the steering thread's Answer (`CardActions.swift`);
  answered, the chosen rows stay on and the rest fall away; resolved with no
  answer it reads Dismissed.
- **Notices** draw on one `NoticeLine` (Thread/AgentSteps.swift, the
  desktop's NoticeLine): 28 pt, the 14 pt glyph slot, 8 pt to the lead,
  the details 4 pt after it as one muted comma run that truncates once;
  the lead is medium when details follow; 32 pt and 12 pt in inside a
  table. Folded into a run as a step it reads verb then target, the lead
  muted and regular, the first detail in the primary step.
- **Compaction**: one row for its whole life in the line's words:
  "Compacting context" in the working text with its time (a still dot, no
  pulse), then "Context compacted" with "142k → 38k" and its span,
  "Compaction failed" with the error, or "Compaction stopped" with its
  span when its turn ended with neither; the glyph and words cross-fade in
  place.
- **Errors and system**: "Failed" at medium weight over the harness's words, in destructive with
  the alert glyph; the user's own Stop is a gray "Stopped"; everything else
  is one notice line.
- **A failed thread's row** (every list) reads the host's
  one-line verdict (`failure.summary`) on its second line; the error row's
  first line is the fallback for a host that sent none.
- **Agents in the run** (the desktop's agentSteps.ts and AgentSpawnRow):
  a spawn lands on its `spawn_agent` call's row (the fold stamps each
  child on the call), with the child's state as a still dot after the
  words; a batch spawn is one "Spawned <title>" row per child; a report
  and each agent a wait returned on is one step (a real wait's result
  carries each agent's reply and passes 2 KiB, so the host sends the phone
  its head alone: `WaitSteps.resolved` reads the agents the head names
  with their status, then each other agent the call named by its own
  session's status where that is a settled one, read once: the fold's
  `WaitOutcomeMemory` keeps the first settled status per wait and agent,
  so the agent running again never takes the step out of the history; a
  wait that returns on the first (`mode: "any"`, the host's default) marks
  an agent still at work at its first read as not returned on, so its
  settling later never adds a step, while an `all` wait over two or more
  agents (`WaitSteps.gathersAll`) returned on every one, so an agent that
  reads at work there (its idle meta landing after the wait's row) stays
  undecided until it settles; an agent no host knows yet waits for its
  first read; the
  transcript reads the statuses the waits still need through a small map
  kept outside its body (`WaitStatuses`, `WaitSteps.unsettledAgents`), so
  a meta push that moves no named agent re-runs nothing): the state's still glyph,
  then Finished, Failed, Needs you, Stopped or Paused and the title
  (`AgentTitle`: the store's title, the spawn's, the report's stamp, the
  task's first line, else "a subagent", cut at a word past 48); the
  batch's own report reads "Finished the batch" and opens nothing; a
  settled background task is "Task finished <label>". A row about an
  agent a paired host lists pushes its thread on that host: an encoded
  `<env>:<id>` on its host, a bare id on the parent's host first, then on
  any other paired host (`CrossHost.find`; `ThreadScreenRoute` carries the
  host). No step spins: the working
  line is the transcript's one moving mark.
- **Failure**: the host's verdict on a failed turn as a card: the summary,
  the cause, a note naming what only the desktop can do (sign in, pick an
  account or a model), and the actions this key can take, each sized to its
  label and wrapping from the text edge (see "The failure card" above), Retry
  last; needs-you tint while live, chrome once the thread
  moves on. An error without a verdict, and a Stop, stay one quiet line.
- **Review**: the merge review's outcome: lead and detail, held in
  destructive, merged in success, the rest secondary; blocking findings as
  rows (file:line in mono, the claim, tap expands the failure scenario on
  the row spring; at the accessibility text sizes the file:line and the
  fold's chevron sit above the claim, which takes the full width,
  `ReviewText.findingLayout`); minor findings folded; the reviewer thread one
  chip away; Merge anyway behind a confirm sheet for an approve key; for a
  key that may not merge its place stays empty (the composer says who can,
  once), and another block says its reason there.
- **Gate**: the run's outcome; failed in destructive with its last lines
  folded in mono; passed as a quiet line with a green check.
- **Batch, account-gone, other host rows**: one quiet line each, the host's
  words.
- **Plan handoff**: the build's row (status, glyph, title, model) when this
  host has it; tap pushes it.
- **Preamble**: "Project rules", then "212 words" quieter, folded inside the first user
  field above the brief; tap opens the text on a 150 ms cross-fade.
- **Turn end**: the working line becomes the turn's closing line, "Worked
  for 12s" or Stopped, in the same row (above).

Streaming: new text appends to the last assistant row without re-laying the
rows above (rows compare by value and keep their identity by the row
model's ids); the list stays pinned to the bottom while the user is at the
bottom and shows a "Jump to latest" pill (one, a glass capsule that answers the
touch, 36 pt with a 44 pt hit area, `fast` opacity and 4 pt of travel) once they scroll up. Turn completion turns the working
line into the closing line and adds nothing. Nothing animates on first paint from cache. Images reach
the phone through `fs.media` and the `/asset` GET; the host an image lives
on is `MediaImage.hostOf(_:)` (the media-host thread's seam).

### The account chip and menu

Inside a project's shell the thread has no subtitle, so the chip's sheet
opens from the thread's menu as "Account…". Elsewhere (a subagent's screen,
a bare chat) every Claude or Codex thread's subtitle ends with the account
it spends from: a 6 pt dot in the account's own colour (Aliax's `#rrggbb`; tertiary
when it has none) and the short name (nickname, else the email's local
part) in `caption` medium secondary, or "Auto" one step dimmer with no dot
when the host picks. A 44 pt hit area; press dims (`pressableStatic`), no
scale in the dense bar. Tap opens the system sheet (16 pt, medium and large
detents), titled "Account", with the source line under it ("From project
billing-page", "From workspace cosmic-web"; nothing for Auto, whose row says it).

Three scopes in a segmented row, only those the thread has: **This thread**
reads the route (the account checked is the one it spends from; a "Route
automatically" pill under the rows asks the host to re-pick, and "Already
on the best account" is the one word back when nothing moved); **Project**
and **Workspace** pin over `project.setAccounts` and `workspace.setAccounts`
(admin). Rows: "Automatic" first, with what it follows ("Best account for
the model", "Follows the workspace: work"), then the provider's accounts in
the snapshot's order, a check on the one that applies at that scope, and
one "gone from this host" row in tertiary when the pin or the route names
an account the snapshot no longer knows. A pin shows at once and reverts
with the reason on the reserved line under the segments when the host
refuses. A key below admin keeps the rows and says "This key can't change
pins" there; nothing hides.

Each account row carries a 3 pt capsule bar: the least room among the
usage windows the thread's model spends (5h, the weekly one, and the
Fable cap for a Fable model), success above a quarter, warning down
to a twentieth, destructive below, and destructive at zero while the
account is rate limited ("rate limited for 39m") or signed out ("sign in
again"); the stamp beside the name is the tightest window's reset ("in 2h
14m"), tabular. The sheet reads `accounts.list` once on open and the
`accounts` push after; stamps tick every 30 s.

A thread on one of Meta's models (a catalog row with `vendor: meta`, under
the claude or the codex harness) spends Meta Model API keys, so its chip and
rows are the host's Meta keys, never the harness's accounts
(`RoutedProvider(provider:model:catalog:)`; until the catalog lands a row
reads as its harness). The chip names the key. A key is pay as you go: its
row has no bar while it has room, only the stamp "pay as you go"; the bar
comes back, destructive at zero, while the key is rate limited or once Meta
refused it ("key revoked"). Pins at Project and Workspace carry `meta` beside
the harnesses' own. A snapshot from a host that predates Meta reads as no
keys.

### Implementation: the board is the hero

Segments: **Board** (default) and **Chat**.

The board is the desktop's `ImplementationView` in one column, Reminders
meets a build log: progress visible at a glance, the current task impossible
to miss, nothing shouting. Its pieces live in
`ios/TempCode/Sources/Thread/ImplementationBoardView.swift`,
`BoardStyles.swift` (the board's metrics on `Layout`, the pass wheel's
`PassTint`, the progress line, the status glyph) and `BoardOutcomes.swift`
(the landing rows); the pure selectors in the client package's
`Rendering/Board.swift` and `Rendering/BoardSections.swift`. Every length,
step, radius and motion value is the kit's (`Layout`, `TextStep`, `Radius`,
`Motion`); the board names none of its own.

1. **Goal line** from the plan file when seeded, `subheadline`, dim. Under
   it the **progress line**: a 3 pt capsule track (`quaternarySystemFill`),
   the done share in the success tint, the task under way reaching one step
   further at the same tint at 35 %, and `2 of 5` in the stamp step beside
   it (success once complete). Never a percentage. The fill moves with the
   row-expand spring; the count rolls with `numericText` on `Motion.numeric`.
   The line reads the newest pass that had tasks.
2. **Passes**: once two passes have earned a row, a header per pass on the
   chrome step: a `Layout.dotSize` dot in the desktop's pass colour (green,
   sky, violet, amber, rose, cyan, lime, fuchsia, by pass number; `PassTint`),
   `Pass n` meta semibold, the user's request for that round (first line,
   tertiary; the first pass leaves it to the goal line), and a settled
   pass's `done/total` trailing. The current pass leaves its count to the
   progress line. A single pass has no header.
3. **Todos**: a row per todo, `Layout.rowHeight` minimum, the status glyph in
   the `Layout.glyphWidth` column (`circle` tertiary pending, the spinner
   tinted success while the thread works on it, `circle.dotted` when in
   progress but not running, `checkmark.circle.fill` success when done; the
   stroke follows the text's weight, medium on the live row), the content,
   the duration in the stamp step once done (the live row's ticks each
   second). The **running row** is the bright one: `label`, medium, on a
   field in the success tint at 6 % (`Radius.field`, inset 8 from the edge
   with 8 of padding so the glyph column still starts at `Layout.textEdge`).
   Done rows step to `secondaryLabel`, pending to `tertiaryLabel`; the colour
   change rides `Motion.crossFade`, the weight change snaps. A glyph changing
   state swaps with the kit's icon swap (scale 0.25→1, opacity 0→1, blur
   4→0, `Motion.iconSwap`; a cross-fade under reduced motion). A row with a
   trace carries a `chevron.right` (caption2 semibold, tertiary) that turns
   90° on the expand spring. Tap a row to expand its trace: the tool chips
   (the transcript's `ActionStep` rows, as they are) and quiet notes that landed while
   it was in progress, mapped by the harness's todo state as on the desktop
   (`groupByTodo`), inset to the text column. Exactly one row expands at a
   time; the running row is open by default, and follows the harness when
   it moves to the next todo. Expand is `Motion.expand` with the content
   fading in on `Motion.expandContent`; collapse is `Motion.collapse`.
4. **Changes**: a `Changes` section header whose count rolls (`CountText`),
   then file rows as edits land, `+n −m`, grouped by todo (the group label
   meta at `Layout.textEdge`, setup first; no labels when the pass has one
   todo), tap opens the diff.
5. **Needs you** cards inline in order, each with the row-appear transition
   inside a container that animates the list on `Motion.rowAppear`.
6. **Closing report**: a `Report` section header, then the agent's final
   markdown once all todos are complete, or the answer when a follow-up
   produced no todos.
7. **Fleet**: when the thread spawned subagents, an `Agents` header (its
   word alone) and their rows under the plan, pushing to the agent's detail.
8. **Landing**: after Changes, the host's own lines in the order they landed
   (`OutcomeRows`; the fold keeps every notice's payload on
   `SystemLine.notice`, `Board.isOutcome` picks the ones with a gate or a
   review, `RoundData.outcomes` files them per pass). A **gate row**
   (`GateLine`, the desktop's `gateLine`): "Typecheck passed on <branch>"
   behind `checkmark.circle` in success; a failed one in the destructive
   tint with its error count or failed step, and the log's last 20 lines
   (mono caption2 on the chrome step, `Radius.row`) behind a tap on
   `Motion.expand`. A **review row** (`ReviewLine`, the desktop ReviewCard's
   lead and summary): "Reviewed by GPT-6.1 Sol" in the title step with "no
   blocking findings, 1 minor" under it, `AgoText` trailing. A held review
   sits on the needs-you field (`Radius.field`, padding 12) with the lead
   medium, its findings as plain rows under it (`file:line` mono, the
   summary meta, the failure scenario caption2 tertiary; minor ones a step
   dimmer, or folded into "and N minor" past five findings) and a Reviewer
   pill pushing to the reviewer thread. No Merge anyway on the phone: the
   override needs the approve capability and stays on the desktop.
9. **Plan line**: under the goal, "Planned in <plan title>" (`map` glyph,
   violet, meta; 30 pt in the header, a 44 pt hit area) when the host linked
   a planning thread (`planThreadId`); tap pushes it; absent when the thread
   is unknown here.
10. **Queued**: a build created behind a sibling (`after`) draws the goal
    line and one row, the queued dot with the host's reason ("Waiting for
    <sibling>"); nothing else is drawn, never "No tasks yet".

Chat is the mechanics transcript (thinking, reads, commands, prose), the same
Chat body as above.

### Planning: the document is the hero

Segments: **Plan** and **Chat**; Chat is default until the plan file has
content, then Plan. A project-plan thread (docs/PROJECT-PLAN.md) has the
same two segments; it has no Start (its milestones are planned one at a
time from the options card, see Project plan below). Plan
renders the markdown file (`file.read` of `planPath`, polled 1.5 s running
and 8 s idle while the screen shows) document-first, `body` size, generous
measure, streaming in as it is written. The page's header row (the state line and the action, in
`PlanView`'s two slots; `Thread/PlanFlow.swift` on the client package's
`PlanFlowState`) follows the plan flow of planFlow.ts and exists only once
the plan is complete: "Plan complete" while the planner still speaks;
"Waiting for you to start the build" with **Start**, which opens the Start
sheet (Implementation first, Orchestration second) whose confirm calls
`plan.implement`, so the host picks the title, the seed and the project's
plan settings and the build is pushed; "Build started" with a chip naming
the build, which pushes it (no chip when the build lives on another host).
A key that cannot operate keeps the Start pill and the tap says why. The
toolbar carries no Start or Build. A build shows "Planned in <title>" under
its board's goal, a row that pushes the planning thread; a thread row of a
complete plan with no build carries the tag "Plan ready". A thread stopped
on a question forces the Chat segment with the question card in view.

The page is a set document (`PlanView.swift`, type in `PlanStyles.swift`,
blocks from the client package's `PlanDocument`), the way Notes or iA
Writer set one:

- **Type.** Headings `title.bold`, `title2.semibold`, `title3.semibold`,
  then `headline`, the large ones tracked −0.02 em of their size (−0.5,
  −0.4, −0.3, 0); 16/14/10/6 pt more space above a heading than the 12 pt
  block gap and 4 pt less below it; the document's first block takes no
  space above. Prose is `body` with 4 pt of lead; the measure is the page
  width inset 20 pt, capped at 640 pt and centered beyond it. Code is the
  page's own `PlanCodeView`: mono one step down (`callout`), never wrapped,
  no language header and no line numbers, 10 pt inside `Surface.fill` at
  half opacity in `Radius.row`, folded past 40 lines ("Show all N lines" on
  `.pressable`, the fold with `Motion.expand` / `Motion.collapse`), Copy in
  the context menu. Tables are `subheadline` with tabular digits, header
  semibold over a hairline, hairlines at 60 % between rows, none under the
  last, no vertical rules, 16 pt between columns, the first column on the
  text edge, a cell over 40 characters wrapped at 280 pt, the grid scrolling
  sideways when wider than the page. A quote is body secondary behind a
  2 pt `tertiaryLabel` bar; a rule is a `Hairline` with 6 pt each side.
- **Lists** hang: the marker sits in a 26 pt column (scaled with the
  body), the text starts after it and wraps to its own edge, each depth
  moves one column in; ordinals count per depth in tabular digits; `• ◦ ▪`
  by depth. A `[ ]` / `[x]` item carries the board's task glyph (`circle`
  tertiary, `checkmark.circle.fill` `Tint.success`) at `subheadline` on the
  first text baseline, and a done item reads secondary.
- **Streaming.** Blocks are identified by index and only ever append, each
  carrying its own space above, so new content lands below the reader and
  nothing above it moves (`PlanDocumentTests` holds the parser to it: a
  longer text keeps every block but the last); the page keeps the document
  it has while a new version parses (never a drop to plain text), and
  nothing in the page animates (`transaction` with no animation) but the
  code fold and the slot row.
- **Position.** The first visible block is remembered per host and thread
  (`plan.position.<environmentId>/<sessionId>`) and restored without
  animation on the next open; nothing is saved while the restore is on
  its way.
- **Loading.** The last text of every plan is cached on disk
  (`Caches/plans/<safe key>.md`) by the client package's `PlanPages`,
  keyed `<environmentId>/<sessionId>` so two hosts never share a slot, and
  paints before the first read answers; a plan under 6 KiB parses on its
  first paint, a longer one shows its plain text at body size until the
  parse lands. No content yet is one quiet `subheadline` line at the text
  edge ("Writing the plan…" while running, "No plan yet" idle); never a
  spinner in the page.
- **Slots.** `PlanView(sessionId:document:running:status:action:)` draws
  one row above the first block, on the text edge: the status line at the
  meta step leading, the action (a `PillButton`, or the build chip, on
  `.pressable`) trailing, both on the first text baseline, 32 pt tall at
  least with 8 pt below. The row appears with `.rowAppearTransition()`;
  the plain init draws no row at all.
- **Composition.** `PlanPage(key:text:running:cache:content:)` owns the
  scroll view, the measure, the position memory, the cache write and the
  empty line; `PlanDocumentView(document:range:)` draws a run of blocks
  with the document's indices as ids; `PlanDocument.frontmatter` and
  `.sections(level:)` cut a file with a header and fixed sections. The
  project plan view composes these.

The research report opens on the same page (`ReportScreen`), until the
research thread's own screen replaces it.


### Project plan: the milestones are the hero

The same Plan and Chat segments as a planning thread, and the same page
(`ProjectPlanView.swift` composed on `PlanPage`, values in
`ProjectPlanStyles.swift`, the parse in the client package's `ProjectPlan`):
the fixed sections (the title, Goals, Current state, Risks, Open questions)
render as the document through `PlanDocumentView(range:)`, and `## Milestones`
keeps its heading and trades its body for native rows. Nothing animates while
the file streams in: a milestone appearing adds a row below the reader, a
field landing changes that row's own lines.

- **The progress line** under the heading: a 3 pt `Surface.fill` capsule
  filled `Tint.success` to done of total, "3 of 7 done" beside it in the
  stamp step with rolling digits; no percentage. The fill's width animates
  with `Motion.expand` (none under reduced motion).
- **A milestone row** (44 pt min, 8 pt vertical, a `Hairline` below at the
  text edge): the checkbox in the 26 pt marker column (`circle` tertiary /
  `checkmark.circle.fill` `Tint.success` at `body`, a 44 × 44 hit area,
  `.pressable`, a light impact on the tick), the ordinal in a second 26 pt
  column in the meta step, then the title at `body` (secondary once done, no
  strikethrough; the color crosses over `Motion.crossFade`) with the scope as
  one dim `footnote` line. Tapping the text expands the row with
  `Motion.expand` (`Motion.collapse` back, `Motion.crossFade` under reduced
  motion): the scope wraps, "Done when" semibold with its text, and the
  dependency chips ("Depends on" and a 20 pt `Surface.fill` capsule per
  number at `caption2`, scrolling sideways past the row). One row open at a
  time; a milestone with no fields has no expand. A tick is optimistic over
  `projectPlan.tick` (the glyph swaps with `Motion.iconSwap`, the row's
  glyph a small spinner meanwhile) and reconciles when the next poll shows
  the file; a build landing on the host ticks the file and the row follows
  on the 8 s idle poll.
- **The options card** after `status: complete` in the frontmatter (and only
  that): a `groupCard` with "The plan is complete" and the count in its
  header, then four `.pressable` rows (glyph in a 20 pt column, title in the
  title step, a one-line detail in the meta step, hairlines at the text edge):
  Plan the next milestone (`map` violet, the next milestone's number and
  title; "Every milestone is done" disables it), Start an orchestration
  thread for milestone N (`arrow.triangle.branch` warning), Revise the plan
  (`pencil`, a native alert with a text field; empty sends the desktop's
  default re-survey turn), Keep / Stop keeping as the project's plan (`pin`
  info / `pin.slash`). The two starts open a sheet in the Start-a-build
  shape (the milestone with its scope and done-when, the model and reasoning
  prefilled from the plan thread), create the thread with its brief, link it
  to the milestone over `projectPlan.link` and push it. The card appears with
  `.rowAppearTransition()`; a busy row's glyph is a small spinner; the footer
  reads a read key's reason or the last refusal.
- **A read key** disables the checkbox and the four rows and says why: one
  meta line under the progress line and in the card's footer, the same
  `ActionBlock.text`. Nothing is hidden.
- **The Home chip** sits in the project header before the plus
  (`ProjectPlanChip.swift`, the `projectTrailing` slot): `flag.checkered`
  violet at `caption2.semibold` and "Plan", or the count alone ("3/7") once kept, in a
  28 pt `Surface.fill` capsule inside a 44 pt hit area, the count rolling.
  It opens the plan thread; its context menu holds the four options (a read
  key's reason as the first, disabled line). The state (`projectPlan.get`)
  is cached per host and project, loaded on appear, refreshed after every
  action from the chip and when a project-plan, implementation or
  orchestration thread of the project goes idle, and asked again after a
  reconnect. Nothing shows for a project with no plan file and no plan
  thread.

### Orchestration: the fleet is the hero

Segments: **Fleet** (default once the first agent spawns) and **Log**.
Fleet (`Thread/FleetView.swift`): the goal in `body` text, then one status
line with its mark (the orchestrator's own state while it runs, waits,
fails, is paused, stopped or queued; else what it waits on: "Waiting on
its subagents", also while a child is only queued, "A subagent needs you",
"Done", "Done, one agent stopped"; the line never counts), then the
fleet in four groups under the design's section headers, each its word
alone as the desktop's board sections read: **Needs you**, **Working**,
**Queued**, **Done** (failed and stopped agents sit first in Done with their marks).
Empty groups are left out. Log is the orchestrator's own transcript.

The agent row (`Thread/FleetStyles.swift`, `AgentRow`), shared by the
Fleet segment, the subagent list, the implementation board's Agents
section and the master board: the kit's 14 pt mark column (spinner
running, warning dot waiting, destructive dot failed, info dot watching,
pause mark paused, a dashed ring queued, a still square once the harness is
gone, a green check settled; marks cross-fade 150 ms in a column that never
changes size), the title in `subheadline` medium (regular and `secondary`
once settled) with the figures on its line, a meta line in `footnote
secondary` of the provider's own mark drawn as a path in the text color
(`ProviderGlyph`), the role glyph, model and effort, the worktree name when
the agent works in one and the host's name when the agent lives on another
host than its root; the activity line on the kit's sizer (a hidden one-line
text fixes the height) swapping in place with the 150 ms cross-fade and
2 pt blur (a queued agent's line is the host's reason, "Waiting for …", a
stopped one's "the harness is gone", a waiting one's the question or the
approval when its transcript says which, else "Needs you" (never an assumed
approval; `Fleet.Line.beside`): the dot says the state); the stats line when there
is anything to say. Elapsed over cost on the right, `caption` tabular with
`numericText`: one step above the stamp on purpose, because `caption2
tertiary` fails the contrast floor on the needs-you tint. A live row's
figures tick on their own one-second clock and nothing else in the row
re-renders on the tick; a row whose host is away stands still. A waiting row sits on the needs-you tint in an 8 pt rounded
field inset 8 pt from the edge; the text stays at the 16 pt edge. Hairlines
between rows at 40 pt (`FleetLayout.textInset`), none after the last of a
group. A row that changes group moves with the kit's row motion; nothing
moves on the first non-empty paint, so a fleet arriving from the socket
after an empty cache lands still.

Subagents on another host: a box thread that spawned a child on the Mac
has that child in the Mac client's list under the box root's id, so the
fleet is gathered from every paired host (`Fleet.gather`, the root's host
first). The remote row ends its meta line with the host mark and name;
while that host is not open its activity line reads the host's transport
line ("Reconnecting in 12 s", "Offline") and its figures stand still; its
detail reads from that host. Agents spawned on a host this phone is not
paired with are counted once at the foot ("2 agents run on hosts this
phone is not paired with"), not tappable: pairing is in Settings.

**Subagent list** (`Thread/SubagentListScreen.swift`,
`SubagentListScreen(client:rootSessionId:)`): the desktop's right-side
subagent panel as a screen, pushed from a thread's toolbar button. Title
"Agents" over the thread's name, then the same grouped rows across
hosts, live, nothing to pull. Fleets of twelve read as four short lists.

**Agent detail** (`Thread/AgentDetailScreen.swift`), pushed from any
row through `AgentDetailRoute` (host, agent, the root's directory, the
host's name): the title over the role in the bar; an identity strip under
it with the mark, the meta line (with the worktree and the host), the
activity line, stats, elapsed and cost, closed by a hairline; then the
agent's own transcript (`TranscriptView`, so a waiting agent's approval or
question card sits at the end, where the screen opens, and decides from
there); then one line at the bottom, "Steer this agent…" while it runs and
"Send to this agent…" once idle, "Resume to send" off when stopped and
"Starts when its turn comes" off when queued, one filled send button,
through `client.send` on the agent's own host. A key that cannot act sees
the reason in the field. DEBUG hooks on the Fleet segment:
`TC_TEST_OPEN=agents` pushes the list, `agent-detail` the first agent; on
the detail `TC_TEST_ACTION=send:<text>|approve|deny|answer:<label>` runs
once on the agent. The test server's `TC_TEST_FLEET=large` seeds twelve
agents in all four groups.

The pieces the master board and any other fleet surface build from, all in
`FleetStyles.swift`: `FleetLayout.textInset`, `AgentStatusMark`,
`ProviderGlyph`, `AgentMetaLine`, `ActivityLine`, `AgentStatsLine`,
`AgentFigures`, `AgentRow`, `FleetSections`, `FleetRows`, `FleetLoading`,
`FleetEmpty`, `FleetUnpairedNote`, `FleetGather`, `AgentDetailRoute` and
`.fleetDestinations(registry:)`.

### Research: the sources are the hero

Segments: **Sources** and **Chat**; Chat default until research activity
lands (a boarded source, a spawned angle or report text), then Sources; the
app switches to Sources when the report completes. Sources reads like
Safari's reading list crossed with a research notebook
(`Sources/Thread/SourcesView.swift`), every value a kit name:

- **The report pin** on top is the board's only raised surface (`.raised` at
  `Radius.field`): the `doc.text` glyph in cyan at the title's semibold, the
  title step semibold in two lines, the state line (a `Layout.dotSize` dot,
  green "Complete" (the mini spinner while angles still run; the coverage
  line counts them); the mini spinner "In progress" while the thread runs; a
  tertiary dot and "Stopped" when stopped early (`ReportStateWord`);
  cross-fading on `Motion.crossFade`), the summary in two meta lines, a
  chevron. Tap opens the report as a document sheet (a page sheet unfolded).
- **The coverage line** under it in meta: "15 sources, 4 searches, 2 of 3
  angles done", digits rolling with `.numeric`; spawned angles count, the
  root's own research does not. Empty when nothing has happened.
- **One section per angle** as a `SectionHeader`: the child's title (else
  the boarded label, "Direct research" for the root's own, else "Angle n");
  trailing, a mini spinner and `SwapText` Starting / Searching / Reading
  while it runs, read off its newest boarded row, or `CountText` once settled.
- **Query rows** carry the magnifier in the glyph column; their sources
  follow as `Layout.rowHeight` rows: the site's icon at `Layout.glyphWidth`
  in a continuous `size / 4` corner with a 1 px outline at 10 % black (light)
  or white (dark), a letter tile on `Surface.fill` until one process-wide
  cache loads it (a miss is remembered); the title step in one line, the
  domain as a stamp, the claim in one meta line; `Hairline(inset:)` between
  sources at the text edge; `.pressable`. **Tap** opens the page in an
  in-app Safari view (full screen, Done, cyan controls, reader off); **hold**
  previews the whole title, claim and address with Copy Link first, then
  Open in Safari and Share.
- **Arrivals**: once the first page has painted and rested 400 ms, a source
  that lands enters on `Motion.appear`; history paints in place. **Empty**:
  the `binoculars` glyph, then "Searching" with a spinner while the thread
  runs, "Loading" while history loads, else "No sources yet".

The report (`Sources/Thread/ResearchReportScreen.swift`) is a document sheet
set as a document at a 640 pt measure: the title once, at `title` bold
with −0.5 tracking, the state line and "3 sources" behind a link glyph, the summary at
`callout` as the lede over a hairline; then the body through the transcript's
`MarkdownBlocksView` after a pure citation pass (`ReportCitations.decorate`
links every `[n]` or `[n, m]` by scheme, inline code left alone; the screen
styles the runs): a resolved number is a cyan semibold superscript that opens
its page in the Safari cover, an unlisted one dim and unlinked. Numbers
resolve to the report's own Sources / References list, else to the board's
distinct urls in arrival order; a matching list renders as numbered
reading-list rows (`ReportLayout.pieces`). The document keeps streaming
while open; Done dismisses.

### Master: the batch is the hero

A pinned master (`isMaster`, any type) opens on **Board**, Chat second,
from the first open: the board and its + Thread are the way in even before
the first child exists. `Sources/Thread/Master/` draws it from the client
package's `Rendering/Batch.swift` (`MasterBoard`, `BatchSteps`, `RulesEdit`,
`BoardActions`) and the batch state the client keeps (`Client/Batches.swift`).

- **The bar**, 44 pt on the chrome step under the segment control: **+
  Thread** (a pill menu: New thread…, Add existing thread…) on the left, the
  batch's **⋯** on the right (Pause all, Resume all, Archive done…, Archive
  all…). The navigation bar's ⋯ stays the thread's own. A switch with
  nothing to act on is disabled, never hidden; a key that cannot operate
  reads the reason as each menu's last line.
- **The rows**, one plain list in four groups under the kit's section
  headers with counts: Needs you (waiting, failed), Working (starting,
  running, watching, paused), Queued, Done. Each row: the fleet's status
  mark in the 14 pt column, the type glyph, the title in the title step with
  the type word muted after it and the task tally at the right (a chevron
  folds an implementation's tasks), then the activity line (the host's
  `activity`, the question, "Paused", "Stopped", "Landed 12:08") with the
  model mark at its right: provider glyph, short model name, effort and
  "1M" quieter. A plan and the build it started are one row under the
  plan's title. A queued child reads the host's reason, "Waiting for <sibling>". A
  child on another host names the host in its model mark and reads "Out of
  reach on <host>" in red while that host is away. Waiting rows sit on the
  needs-you tint; separators start at the title. Settled rows drop to the
  regular weight and secondary text. A row whose thread has live
  subagents lists them under the activity line, one 28 pt line each: the
  agent status mark, the role's glyph (`MetaGlyph`), the title in
  secondary, what it is doing in tertiary (waiting in warning, failed in
  destructive) and the host's glyph; the person's first, at most three,
  then one tertiary line "2 more, 3 done" (warning when one past the
  cap waits). Each line pushes the agent's thread screen (on its host for a
  far child). A far child's agents come from its own host's sessions; a
  thread whose agents all settled has no lines. The client package's
  `MasterBoard.rowAgentLines` builds every row's from one parent index per
  host each render.
- **The body** under a row: an implementation's tasks (check, spinner,
  open ring), open while it works or needs you, folded once it is done; a
  research or orchestration thread's one summary line (its notes' State,
  else its latest words, never a repeat of the activity line); chat and
  plan rows carry nothing more.
- **A tap** pushes the child's own thread screen with its type's segments;
  Back returns to the board where it was. A long press is the kit's menu
  with the batch's rows in its slot: Start now and Remove from queue on a
  queued child, Pause and Stop on a working one, Resume on a paused or
  stopped one. A far child has no menu here: its host acts on it.
- **The foot** is the list's last section, "When the threads are done"
  with Edit: one line for the rules, the master's own when it has one, else
  the rules as one sentence ("Branches land as they finish, then Gate and
  Smoke test. Then you are notified."), never both (`MasterBoard.footLine`), what
  blocks the end in red, then the steps in the master's order, each a row
  with its mark (check, spinner, red dot, dashed ring), name, a shell step's
  command in mono, its time. The console opens under the running step, or a
  failed one until Hide: the progress count and label, a 2 pt bar, then the
  newest lines in mono one step down, in a field that grows to 220 pt and
  then scrolls inside; it follows the tail until the person scrolls up, and
  a line arriving never animates. Stop sits on a running shell or publish
  step (`batch.stopStep`); a gate or release runs to its end.
- **The sheets**, all system sheets at `Radius.sheet`: Rules (large: how
  branches land, the steps renamed in place, reordered behind Edit, swiped
  away, a built-in kind or a shell command added, what happens after, the
  summary; the footer reads the sentence back and says what the contract
  refuses), Add a thread (large: the brief first, type, model and effort,
  1M where offered, After), Add existing threads (medium, one flat list of
  the project's free roots), Archive done or all (medium: what leaves, what
  stays, the clean-up switch when resources are known).
- **The pin**: "Make master thread" / "Not the master" in a root thread's
  menu (the thread screen's ⋯ after Pin, Home's row menus) for an admin key;
  any other key sees it disabled with the `noAdmin` line.
- **Data**: `batch.get` on appear, on every socket open and every 5 s while
  the board shows; the `batch` push between, which the client lands at most
  twice a second (the newest of a burst always lands). Nothing animates on
  the first paint.

## Settings

Settings is the one place the app is Apple's own: a pushed, inset grouped
list, as Settings → Wi-Fi is, because the user already knows how to read it
and nothing here is the product. Rows carry no glyphs (the desktop's
settings rows carry none). Every row that needs explaining gets one sentence
of footer, never a paragraph; the app's version is the Diagnostics row's
value, the last row and clear of the tab bar, so a screenshot answers
"which build" (the contract it speaks is on Diagnostics). The words are the Settings 2 glossary's, the desktop's
(src/renderer/src/lib/settings/map.ts): a computer, never a host; Sign In
Again, Forget, This phone may, Effort. Section
headers are the system inset grouped headers, not `GroupHeader`: that one
is for a hand-built card on a plain background, and the brief here is
"indistinguishable from Apple's Settings". Rows keep the system highlight;
nothing in a grouped list scales on press (Apple's Settings never does, and
a scale fights the swipe actions). The screens hold only SwiftUI; every
word they say (the connection word and sentence, the fix per state, the
build line, the push word, the key's rights) and the forget flow are the
client package's `Shell/HostPresentation.swift` and `Shell/SettingsWords.swift`,
where they have tests. A section whose first read is out holds its place in
its rows' shape (`SettingsPlaceholderRows`, redacted), never arriving late.

The root, in order: Computers, then Work and Away, Notifications,
Appearance, then Diagnostics with the version as its value.

- **Computers** pushes the list; the row's trailing half is the single
  computer's name, or the count, never dots beside it (each state is the
  list's to say, once) (stacked
  under the label at accessibility sizes).
- **Work** pushes Settings → Work once a computer has answered `work.get`;
  while none has and one is still connecting it is a placeholder row
  (`WorkRowState`).
- **Away** pushes a section per computer (named when there are several):
  Code threads, and Work threads while Work is on there, the host menu's own
  switches over `away.get` and `away.set`, one computer per flip. A
  computer's switches stand only once this link's read answered: a dropped
  link puts the read back to waiting, so an answer held from before is not
  shown as his setting (`AwayWords.section`, `WorkHost.awayRead`). While the
  read is out its section is the switches' bones; "Away needs a newer Docket
  on <computer>." only when it answered that it does not know Away;
  "<Computer> did not answer." with Retry on another failure, even over an
  answer held from before; the connection's sentence when it is out of
  reach. The row's value is On while any is away, bones while a read is out,
  Off once every computer answered Off, "Off, 4 not read" when some could not
  be read, and "Not read" when every read settled and none answered
  (`AwayWords.summary`); the last footer says what Away does.
- **Notifications** is one row: the switch, with the registrar's word beside
  it only when the switch's position cannot say it ("Registering…", "No
  relay", "Failed", "Not allowed"; never "On" or "Off",
  `NotificationWords.beside`). The
  switch moves at once and holds its position while the permission prompt
  and the hosts answer; the word cross-fades 150 ms. When the phone refused
  permission an "Allow in Settings" row opens the system Settings. The footer
  names what stands in the way.
- **Appearance** is the inline picker with checkmarks: System, Light, Dark.
- **Diagnostics** is a plain row with the app's version as its value
  ("1.0.401 (5)") that pushes `DiagnosticsScreen`.
  A theme flip snaps; nothing animates it.

**Computers.** One row per computer this phone is signed in to: the connection dot leading in the mark
column (`Layout.markWidth`; a host the box relays follows its relay state
over an open lane: locked in the warning tint, asleep in the quiet gray,
unreachable in destructive), the name, a second line in the meta step (its
state in a word or two: "Connected", "Connecting…", "Not answering",
"Reconnecting…", "Offline", "Another computer", "Needs an update", "Refuses
this key"), and the `+N` drift mark trailing when it runs behind. No
address and no id on the list: both are on the detail. The second line is destructive only when the state waits on the
person: Refuses this key, Another computer, Needs an update
(`HostFix.waitsOnUser`). Offline, Not answering, Connecting and
Reconnecting are the phone's to fix
and stay `secondary`. The second line swaps in place with
`.swapTransition()` (150 ms, opacity and 2 pt of blur; opacity alone under
reduced motion). Swipe and long press offer Sign In Again and Forget; every row
pushes the detail through the stack's `NavigationPath`, and the proof's
`TC_TEST_OPEN=host` hook appends the same `HostDetailRoute` to that path,
so the bar's title is the host's name on either path with no principal item.

**A computer's detail.** Five sections, in this order:

1. **Status**: the dot, the connection in the desktop's sentence
   (`ConnectionSentence`, the words of lib/connection/degraded.ts: "the box
   dropped; retrying in 5 s", "the box no longer accepts this key", "the box
   is offline"; never the host's raw error) with its countdown, a spinner
   while connecting; under it the one action that fixes the state (Retry Now
   when the computer is out of reach, Sign In Again when the key was refused
   or the address answers as another computer, nothing when it needs an
   update the phone cannot do); the footer says only what is his to do, never
   the state again.
2. **Activity**: `HostActivitySections(client:)` (`Shell/Hosts/`): Build,
   Mac bridge, Devices, Sync, in that order; "Host activity" below has
   their rules.
3. **This phone may** (the desktop's "It may", said of whom): its four levels, Look only, Run threads, Run
   threads and approve, Manage <computer>, each with one line of what it
   allows and a checkmark in the tint on the one the key holds
   (`KeyRights`), then Set up other computers and Set up from another
   computer only on a key that holds them (`Capability.extras`; admin never
   implies either, docs/agents/pc-setup.md); the footer says a new sign-in
   link is how to change it.
4. **Computer**: Name (editable in place; the footer says it is this phone's
   own name for it), Address, ID in mono (selectable), Version as
   `1.0.N (<sha7>)` from the hello's `build` (`HostBuildLine`; the version
   alone without a commit; no row for a computer that sent none), Contract
   from the last hello, Notifications for this computer, the sign-in date.
5. **Sign In Again** and the red **Forget This Computer**, with no footer.

**Relayed computers in Settings → Computers.** A host reached through another sits
under its carrier's row (`RelayedHostRow`): the lane's dot in the mark
column, the name, "through <carrier>, <presence>" in the meta step (the
presence line's words above, nothing after the carrier's name when the host
is up and unlocked); no id, no swipe and no menu,
since nothing waits on the person. Its detail (`RelayedHostDetailView`) has
two sections: Status (the dot, the lane's `ConnectionSentence`, the presence line
under it, a spinner while connecting; the footer names the carrier and that
it relays the host's threads while the host is awake and its link is up; no
Retry Now, `HostFix.fix(for:environment:)` answers nil for a relayed host)
and Computer (Name read-only, since it is the Mac's own hostname; Through;
ID in mono; Version from the presence row's build, else the
lane's hello; Contract). No Key section (a footer says whose key it uses),
no Sign In Again, no Forget: the footer says forgetting the carrier forgets
this computer with it.

Forgetting is a confirmation dialog naming the computer, its verb Forget. `forgetHost` first
sends `remote.push.unregister` on the host while the socket is open (best
effort, so a forgotten host stops sending notices whose tap would land on an
environment the phone no longer knows), then removes the key, stops the
socket and clears the cache. The message says what this phone drops and what
the computer keeps: its notifications stop, its threads stay there, and it
still lets this phone in until the key is removed there; a carrier's names
the relayed computers that go with it (`forgetCopy`).

**Host activity.** Four kinds of section, each absent when the host has
nothing of the kind, all in the same inset grouped grammar: system headers,
no glyphs on rows except the status column (`Layout.markWidth`: a dot, a
spinner, a check or a cross), footers of at most two lines.

- **Build** (no heading: its one row names it): an Updates row saying how
  the computer stands, once ("Up to
  date", "3 behind"), against the newest release, read by the phone itself
  from GitHub (`MasterReleaseWatcher`: every ten minutes while a drift mark
  or a detail shows, and on foreground after fifteen; a failure keeps the
  last value). For a box, Update…, behind a confirm (red Update) naming both
  versions ("v1.0.270 → v1.0.273, 3 releases. …"), and once a run exists the
  job row: spinner, check or cross, the title swapping in place, the note or
  ending under it, a chevron to the log sheet. The footer, only while it is
  behind, names both versions and the fix ("v1.0.270 → v1.0.273. Update from
  here.", "Publish from the Mac." on a Mac) or why it is out of reach (not
  connected, not installed, a key that may not manage it); nothing when up
  to date. The host's own version stays in
  the Host section; nothing says it twice. The `+N` mark (`DriftMark`)
  trails the Computers row and fills Home's `hostTrailing` slot
  (the status row and the host header), muted, tabular, never animated.
- **The deploy log** is a medium/large sheet (`Radius.sheet`): the card's
  title, its note under it ("Cannot be stopped mid-way; the box rolls back
  on failure", or "The box is restarting; the log continues when it is
  back" while the link is down), the last 40 lines in mono one step down,
  selectable, and the ending line. It follows the tail while the reader is
  at the bottom and holds still once they scroll up; appends never animate.
  A deploy is never stoppable, so there is no Stop.
- **Mac bridge** (a box's detail, from each paired Mac that serves it,
  headed "On <Mac>"): the box's calls past the prompt, running first, then
  held with their standing ("3rd in line for the Mac (load 12.3 of 8)",
  swapping in place), then paused on the box; the command in mono,
  the thread and its elapsed under it. Stop is a swipe (no destructive role:
  the row stays until the Mac answers) and a context-menu item, never on a
  paused row. Then Running and Threads against their caps and the Load row
  with "Holding new commands until under 24" while the guard holds. The
  footer says how many requests wait for a decision on the Mac; deciding
  stays there.
- **Devices** (one section per Mac this host can show: "Devices" on the Mac
  itself, "Devices on <Mac>" on a box): simulators then iPhones, a dot in
  success, warning or tertiary that cross-fades in place, the state line one
  phrase with commas ("Booted, 13% CPU, iOS 26.0", `DeviceState.spoken`) and
  a booted simulator's CPU rolling (`.numeric`), the holder in `secondary`,
  pushing its thread when that host is paired here. The holder trails on the
  row's line while the row fits whole; when it would be cut (a long thread
  title, large text) it goes under the state and wraps (`ViewThatFits`),
  never cut mid-word. A device nothing holds ends with nothing, no dash.
  Shut Down and Delete on a swipe and in the context menu (Delete confirmed
  by an alert naming the holder), Open in Xcode on a phone's; a spinner
  replaces the dot while one is out. The footer says only what the rows do
  not: a tool that did not answer, and why a key cannot act (no count of
  the rows, no load, no Xcode version).
- **Sync** (admin): per peer its name, the harness config and memory lines
  (cross-fading, up to three lines so "synced 2m ago" survives), and a Sync
  Now pill; the conflict copies behind a disclosure. The footer is the rule
  ("Skills, commands, hooks and settings go from the Mac to its hosts;
  memory crosses both ways, the newer copy wins.") or that sync is off.

A key that lacks a capability sees the section and its rows with the
control disabled and the reason in the footer: "Updating needs a key that
may manage it.", "Reading the sync state needs a key that may manage it."
(one quiet row instead of the lines), "Shutting down or deleting a
simulator needs a key that may run threads.", "Stopping a command needs a
key that may run threads on the Mac." An action the
host refuses lands as the destructive footnote line under the section's
rows (`RowErrorLine`), arriving like a needs-you row and leaving after four
seconds. Motion: the first report paints still; rows that come and go after
it use `.rowAppearTransition()`; the dot, the spinner and the check
cross-fade on `Motion.crossFade`; counts and CPU roll on `Motion.numeric`;
nothing else moves. Every loop runs in one `ActivityPollers` behind the
Master row, so a row changing never restarts the devices watch; leaving the
detail ends them all and sends the unwatch. The words are the client
package's `Client/HostExtrasText.swift`, ported from the desktop's; the
stores are `Client/HostExtras.swift`.

**Signing in** (Add a Computer, Sign In Again) is a form sheet (`tcSheet(.form)`: medium
with the large detent for the keyboard on the phone, centered unfolded; see
"iPhone Duo"): a segmented
Sign-In Link / Key, the field with a paste button at its trailing edge while
empty (a pasted link that reads cleanly is redeemed at once; a typed one is
recognised, the footer naming the computer it signs in to, and submitted with
Return or Add), and the refusal under the field inside the
same card, footnote in destructive with the `exclamationmark.circle` glyph
at the same weight, arriving with `.rowAppearTransition()` (200 ms, 8 pt of
travel) and leaving 150 ms when typing resumes. Never an alert. Add swaps
for a spinner with a 150 ms cross-fade; a success haptic and the sheet
dismisses with the computer already in the list; an error haptic on a refusal.
The first field takes the keyboard once the sheet has settled (350 ms), with
no animation.

Nothing here needs more than a `read` key: `remote.push.*` are `read`,
pairing is `POST /api/pair`, forgetting is local. The This phone may section is where
a person learns why a control elsewhere is disabled.

### The diff screen

One screen for every diff: an edit row in the transcript, a Changes row on
the board, and a pull request's files in the Inbox. Three ways in, one
screen (`DiffScreen`): `DiffRoute` (an edit's card, read from the thread's
own host with `session.rowBody`), `LinesDiffRoute` (lines already in hand
with the host's counts) and `PatchDiffRoute(title:patch:file:adds:dels:)`
(a unified patch; `file` keeps one file of a many-file patch, so the Inbox
opens a pull request per file and names the file in the title). Unified,
never side by side on a phone. The model and its parsers are the client
package's `Rendering/DiffDocument.swift` (`DiffLine`, `DiffHunk`,
`DiffDocument`, and `DiffLayout` for the column's geometry), with their
Swift Testing suite; `Thread/DiffStyles.swift` keeps the UIKit
measurements (`DiffMetrics`) and the palette.

- **Header**: the path on one line in two steps, the directory `tertiary`
  and the file name in the title's color, `subheadline` semibold, head
  truncated so the name always shows, a long press copies the path; `+n −m`
  trailing in success and destructive (the host's count when the route
  carries one, the parsed count otherwise).
- **Hunks**: a jump or a step back in the new-side numbering starts one, as
  the desktop's gap does, and every edit of a file starts one. Each hunk is
  a pinned section row on the one gray step: the line range ("Lines
  40–43", "Line 12 removed"), the file name first when the document spans
  files, the hunk's own `+n −m` trailing, a hairline under it.
- **Lines**: mono one step down from the rows (`footnote`, Dynamic Type
  honored, the gutter and row height measured from the same font), the
  number `tertiary` right-aligned in the gutter, the sign at medium in the
  line's color in the gutter and never in the text, the row tinted success
  or destructive at 10 %, no bar on the leading edge, context text in the
  label colour: the desktop's `FilePreview` values. No intra-line emphasis,
  as on the desktop. A diff that could not load reads "The diff is gone from
  Mac." while the host is open, and the link's own line ("Mac is offline")
  while it is away, each with Retry.
- **Sideways**: each hunk scrolls horizontally on its own, under the pinned
  gutter, by a sideways drag on any of its rows; the first change decides
  the axis for the gesture's life and a vertical start is the scroll
  view's. The finger's momentum carries it, both ends rubber-band (Apple's
  `d·c·w / (d·c + w)`, c = 0.55) and it settles with a bounce-0 spring
  whose duration follows the travel: 0.35 s plus 0.4 ms per point, never
  past 0.6 s. A hunk that fits never moves.
- **Virtualized**: a lazy column of fixed-height rows; a 3,600-line diff
  opens and scrolls at 120 Hz with nothing built off screen.
- **Toolbar**: a bottom bar with previous and next hunk and "n of m" in
  tabular digits between them, numeric transition; the position follows the
  scroll from the fixed row heights (`DiffLayout.hunkIndex`). Hidden for a
  single hunk. Navigation is `ScrollPosition.scrollTo(y:)` on the header's
  exact offset (`DiffLayout.hunkStarts`), 250 ms on the strong ease-out
  curve `(0.23, 1, 0.32, 1)`; jumps under reduced motion.
- **Context menu** on any line: Copy line, Copy hunk (unified, with signs).
- **Loading**: the shimmer of the height the lines will take, from the line
  count the host left with the omitted body; rows cross-fade in over it in
  150 ms; a route whose lines are in hand (a patch, lines, or an edit whose
  every preview carries its lines) parses before the first frame and never
  shows it. Previous and next hunk hold the counter on the target while the
  scroll animates; the finger catching a hunk mid-settle blends to it
  through an interactive spring. **Gone**: one line in destructive with Retry; part of an edit
  gone shows the rest under the same line. **Nothing to show**: one quiet
  line ("This edit left no lines to show."; for a patch, "No changes to
  show.", which covers a binary or truncated file).

## Two hosts

The phone pairs with more than one host (the Mac and the box) and, since the
desktop learned to share work between them, five things follow on the phone.
The models are pure and live in the client package (`ProjectPairs`,
`ProjectLinks`, `CrossHost`, `PathHost`, `MovedThread`); the views are
`Hosts/HostDot.swift` (`HostDot`, `HostGlyph`) and `Thread/HostChip.swift`.

**One project on two hosts.** The hosts link their copies themselves: the
Mac's linker stamps every copy of a workspace with one `linkId`, and every
copy of a project inside it with another (src/main/server/remote/
projectLinks.ts). The phone reads `linkId` off `workspace.list` and
`project.list` and folds by it alone: the same repo or folder name without a
shared link stays two rows, and a row without one is a pair of one. Within
one host the first row with a link keeps it, so a pair has at most one
member per host. A linked workspace is one row on Home (above); each linked
project in it is one project card, led by the first host in registry order
(its menu acts on that copy; the fleet switches in the menu come as one set
per host, each acting on that host's copy), with every copy's lines on it,
newest first in each kind, whichever host they run on, and every copy's
archived threads in its count line. The project screen lists every copy's
threads, pinned first, then newest first, and each copy's archived threads
keep their own "N archived" row, with its host's glyph.

**The host glyph.** With two or more hosts paired, every thread row on Home,
every fleet row (`AgentRow`) and the agent detail's meta line carry one
small glyph for the host the thread runs on (`HostGlyph`): `laptopcomputer`
for a Mac, `server.rack` for anything else, at the meta step in secondary,
monochrome (colour stays for the status dots). The platform is the host's
hello `build.platform`, remembered on the paired environment so a cold paint
from the cache draws the right glyph before any socket opens; a relayed
host's comes from its presence row; a host never heard from draws the rack.
VoiceOver reads "On box" as part of the row. The thread header's subtitle
names the host in words (`HostChip`), so a row never carries both. With one
host nothing names it.

**Project settings live on the box.** The project settings sheet reads and
saves the settings home's copy (`ProjectLinks.target`, the desktop's
older `settingsHomeOf`: the copy off `darwin`; two of one platform, the
environment id that sorts first; a host not yet heard from counts as a box;
the desktop now reads `build.headless` instead, and the phone does not yet),
whichever copy's menu opened it: the phone pairs with the box directly, and a
relayed Mac's copy goes through the box anyway. A linked project's last
footer says "Saved on box". While the home is out of reach the sheet says why
in one line ("Settings live on box. Offline") and loads when the link comes
back; once loaded, Save is disabled with the same line at the top. An
unlinked project saves where it is and says nothing about where.

**A thread's host.** The thread header's subtitle holds a chip
(`HostChip`): a 6 pt dot in the host's tone and the host's name in the meta
step on the fill step with row corners (8 pt continuous), 7 pt horizontal and
2 pt vertical padding, a 44 × 28 pt hit area, the press scale; shown only
with more than one host paired (the header's rule). The dot sits on the
text's cap-height centre, not the line box's. A tap opens a compact popover
anchored to the chip (`presentationCompactAdaptation(.popover)`, the system's
own scale from the trigger): the host's name, its state line (the same
`StatusText` as Home's host row, ticking while a retry is pending), and
Retry when it helps (reconnecting, offline, refused). The phone offers no
move: `session.move` is the Mac's own local RPC, which no remote key can call.

The host tone, one rule for every dot that means a host's link:

| Tone | When | Color |
| --- | --- | --- |
| fresh | open, re-listed | Success |
| stale | open, not yet re-listed | Success at 50 % |
| busy | connecting, reconnecting, suspended | Warning |
| away | offline | `tertiaryLabel` |
| refused | the key was refused | Destructive |

The dot cross-fades 150 ms between tones after the first paint and never on
it; its accessibility value is the state line's words, the static cue.

**A moved thread.** The `session-moved` push says a thread now runs on
another host; the client drops its rows and keeps a `MovedThread` record
(where, when, which subagents) in memory for this process. A screen open on
the thread shows one quiet line in its place, with the row appear motion:
"Moved to box" as a full-width 44 pt row with a trailing `chevron.right`,
whose tap opens the same thread on that host (same id, same seqs) through
the router; when that host is not paired, "Moved to a host this phone is
not paired with" as plain text. Only a client subscribed to the source host
sees the push: a phone in the background sees the thread leave one host and
appear on the other at the next list, with no line.

**A cross-host subagent.** A box thread's child spawned on the Mac is an
ordinary thread there with the box thread as its parent; the parent's log
holds an `agent-spawned` row naming the child's host, and the host's tools
name it `<env>:<session>`. `CrossHost` turns either form into a placement
(the host, the session, remote or not, paired or not): the fleet reads the
child from that host's client, its row carries the host's glyph, and a
child on a host this phone has not paired reads "on a host this phone is not
paired with" in place of its status and is not tappable. The note never
names the host: the wire carries the environment id alone, and no client key
can fetch a name for it.

**Files and media by host.** A path a thread names opens on the host the
desktop's rule picks (`PathHost`): a catalog root (a project cwd or a
workspace path) is a definite answer; outside every root the thread's host.
An `fs.media` URL carries `&host=<id>`, the host whose bytes they are; the
image loads from that host's client when it is paired, else from the
thread's. A missing file reads "No such file on <host>." (the host's name
only with more than one host paired); every other failure keeps the host's
words. A photo the phone sends has no home on any host, so every upload goes
to the thread's host, whose attachment folder the fence admits; a cross-host
subagent's composer uploads to the child's host, because its client is the
child's.

## Work on the phone

Work has its own tab since 2026-11-24 (the plan "All of Work on the iPhone",
its prototypes under `.temp-code/prototypes/work-ios/`; "Information
architecture" above has the tab's rules). The pages approved before it are
`.temp-code/prototypes/work-workspaces-2/phone-nav.html` (one Home with two
headings, which the tab replaced) and `phone-outbox.html` (the Outbox's list,
Away's end as one notice and one list). The owner's rule: the phone does
everything the desktop does. Its words follow the desktop's: a read that
failed offers "Try Again" on every Work screen, never "Retry"; a held item
put away "will not be sent"; a field's limit is said only near it. What
milestone 46 built, where it lives now:

- **The Work list.** The **Outbox** row leads the Work list: the `paperplane`
  glyph in the 28 pt mark slot, "Outbox", and the waiting count as a plain
  stamp (`WorkPlaceRow`). Held is not Needs you: the count is never amber
  and no Outbox surface takes the warning wash or an orange dot. The Work
  workspaces sit under a "Jobs" section header (its New Job + in
  the secondary label's own ink, never the hierarchical one a header dims),
  each led by its **sector's dot** (8 pt, growing with the text to 14 pt at
  accessibility sizes) in the mark slot, never a tile; **Work Chats** and the Digest
  follow. Home has no row of Work's, and with Work off on every host there is
  no Work tab.
- **Sector hues** (`Tint.sector`, Work/WorkStyles.swift): cosmic, hypixel,
  purdue, ref, unify, life, light and dark, from the prototype kit's oklch
  values. Used only for a Work workspace's dot, an Outbox band's dot and the
  held detail's place line.
- **The Outbox** is a place of the Work tab, a pushed list (the sidebar in
  the split poses) in Outbox 2's order (prototype A,
  `.temp-code/prototypes/work-outbox-2/phone.html`): first, each host whose
  read failed as the failed-read row ("Box: Not connected"; Try Again reads
  that host alone), its rows from before kept below; then
  **Asked in threads** (a thread's open request, one row each: a
  `checklist` glyph, its head "Send 10 mails to 10 people", the thread's
  title under it, the time; the row opens the request sheet), **Not sent**
  (failed, oldest first), **Starts soon** (an invite whose event starts by
  the end of tomorrow, soonest first, its start time the one trailing word
  in the meta step at semibold), then **one band per thread** (a routine's
  run is its own; an item no thread made is its job's band) by the job's
  rail order and then the band's oldest item, then **Scheduled** (the sends
  he timed, soonest first). Each section only when it has rows, on the one
  gray step: a thread band's sector dot, its title at semibold and its job
  after it in regular (the job gives way first), no count; the other
  sections' heads are their names alone. An item a request lists shows
  under its Asked row alone. Each row is the kind's glyph in the mark
  column, what it does, the subject or target as its meta line, and one
  trailing stamp: when it goes (Scheduled, "Wed 8:00 AM"), "Out of date",
  "Sending", "Changed" (the thread rewrote it), else when it was held. A
  failed send carries the destructive dot and its reason as the meta line.
  Swipe trailing and the context menu offer Send (Send Again) and Discard
  on what waits on a plain press, for a key that may press them. On the
  open Duo the first held item fills an empty detail, in the order the
  sections draw (a request is never picked). Empty: "Nothing Held". Every
  Outbox count on the phone (the Work list's Outbox row, Today's line) is
  one function, `OutboxModel.waitingCount`: the shared `needsHim` (held,
  live, failed, and out of date until put away; never sending or
  scheduled, held to the desktop's fixture in OutboxWaitingTests), less
  what a Send holds back right now; Today's `needsHim` calls it.
- **A sent item** says what LifeOS says of it while LifeOS has not said it
  went (`OutboxModel.lifeosLine`, the desktop's `lifeosWords`): "Queued in
  LifeOS for 3m", its age as of the draw with no clock of its own, "Back in
  drafts in LifeOS", "No longer in LifeOS"; "Sent 2:14 PM" once it went. An open detail follows the host's pushes of it
  after it leaves Waiting (`WorkHost.heard`).
- **The next item.** On the open Duo the detail keeps the item he opened,
  through its Send's five seconds (its bar steps away while the capsule
  offers Undo). When the item leaves the list (sent once its wait ends,
  discarded, scheduled), the detail takes the next row after it that waits
  on him and that he saw in the list, else the nearest before it, else it
  clears; a row that arrived since is never the next
  (`OutboxModel.pickOrder` into `ShellSelection.decide`). At compact width
  the detail returns to the list.
- **Select.** "Select" sits in the list's bar for a key that may send and
  decide, while a row takes a tick; the title reads "3 Selected" ("Select
  Items" before the first) and Done ends it. Each row that waits on a
  plain press shows a tick (`checkmark.circle.fill` in the tint, else the
  empty ring) in its mark column; a failed send, an out-of-date item, a
  live act, a computer act and one whose last send may have gone take none
  and step back (`OutboxModel.tickable`). A section's heading carries
  "Select All" (or "Deselect All") at its trailing edge, never broken; at
  accessibility sizes the heading wraps and the word sits under it. A
  press on many says an item the host could not confirm as "May have
  gone" in its row and in the sum, never "not sent". On a phone the
  foot is Clear and "Send 3…", each a glass capsule over the scroll edge (plain
  words there read over the row behind), "Send 3…" the prominent one, which opens the summary as a sheet
  (`tcSheet(.editor)`, Close at the top); on the open Duo the summary is
  the detail column itself.
- **The summary** says in one sentence what will go, in the kinds' own
  words ("Send 2 mails to 2 people and post 1 message", master's
  `summaryHead`), then a row per item with its tick and a chevron that
  opens the item to read (no bar there). A LifeOS reply that quotes its
  mail, read whole when ticked, says "Open to send" and stays out of Send.
  Its foot: Discard N as plain destructive text at the leading edge, Send
  N as the prominent capsule. Send asks the owner's check once for the
  group (bound to every item and the revision he saw of each), then waits
  the same five seconds with Undo as one press ("Sending 2 mails to 2
  people and posting 1 message"), then each host hears one
  `work.outbox.decide {items, via: 'phone', many: true}` (`GroupPress`);
  a group never carries a grant or `again`. Discard asks once, "Discard
  3?", with "Why, for the thread", then goes at once as one item's Discard
  does. The capsule then says the sum ("Sent 2, 1 not sent", "Discarded
  3"); an item that did not go stays in the list with the host's reason as
  its meta line, in the destructive ink, until his next press on it.
- **Kept rows.** Each answer of a host's list writes its waiting rows to
  the phone's Work cache (`WorkCache.waiting`: the act, what it is about,
  its place, its time; never the payload; `OutboxKeeping`). On a cold
  launch the list paints them, one band per place, and the count counts
  them, until that host answers on this link. A kept row opens a read view
  (its words and a spinner, or the read's error as the failed-read row) and has no
  swipe, menu or tick; the detail's bar waits for the item read fresh on
  this link (`work.outbox.get`).
- **Inks.** The Outbox's bands, held detail and stamps draw meta and stamps in
  `label` for the 4.5:1 floor, ordered by size and weight: the hierarchical
  secondary and tertiary measure 3.4:1 and 1.7:1 on white, less in a list's
  section header. This covers the band's name and count, the held detail's place,
  time, field labels, addresses and state line, the Work list row's count and each
  row's time. Every band title (`SectionHeader`) draws in `label` too, on every
  list of the phone: Today's, Money's, the Work list's Jobs, Files', Connections',
  Review's, the comment sheets' and Work search's, and Home's, general Search's and
  the thread boards' (fleet, sources, implementation board, master). Inside a list's
  section header the hierarchical step nests one level dimmer (about 1.9:1 on the
  band); outside one, on Home, it was the step's own secondary. A branch name beside
  a title stays tertiary. The rest of the phone, the rows' meta and stamps outside
  the Outbox, keeps the steps' own inks (docs/agents/appearance-phone.md).
- **The held detail** reads as the act, exactly as it will go: the place
  line (dot, workspace, "from <thread>" or "from a routine", time), the
  list row's act as the title (title3 semibold; one name, `OutboxModel.title`),
  a timed send's "Scheduled for Wed 8:00 AM" with the `clock` glyph as its
  one line (`OutboxModel.scheduledLine`; its From says as whom), else the
  host's one sentence of what the press does that its fields do not say
  (`effect`, subheadline in `label`; `effectLine` gives none for a timed
  send, so no sentence under its time can say the opposite), then the notes that apply, one
  line each in meta with a glyph in a 16 pt column: "Not sent. <why>" (the
  destructive dot, its words in the destructive ink: the only colour),
  "Out of date. <why>" (`clock.arrow.circlepath`), "The thread rewrote this
  at 9:20 AM." or "You changed this at …" (`pencil`), "Dana Lee wrote back
  at 8:12 AM, after this was made: “…”" (`arrowshape.turn.up.left`); then
  each field on its own line under a hairline (label in meta at a 64 pt
  column, the value in body, an address under a name; a mail's run From,
  To, Subject), then the body as
  plain text. Its own bottom bar, the fourth named bottom bar after the
  dock, the hunk bar and the Preamble panel: Discard as plain destructive
  text at the leading edge, Edit as a glass capsule, Send (the item's own
  verb) as the prominent glass capsule. A press and hold on Send opens its
  menu: **Send Later** (In an Hour, This Afternoon while the morning lasts,
  Tomorrow Morning, Pick a Time…, the last a form sheet with the graphical
  date picker and Send Later) for a kind the host marks `later`, above the
  grant. A timed send's bar is Cancel Send and "<Verb> Now"; an out-of-date
  item's is Discard and Ask the Thread Again. **Discard** asks once in an
  alert, "Discard this?" over what will not happen ("It will not be sent."), with one optional field, "Why, for the thread":
  the thread hears it was discarded, with his line when he wrote one. Edit
  is a form sheet: each field a person reads and the message. A whole read
  that fails over the list's copy is the failed-read row in red at the
  foot, since the bar waits for that read (`OutboxModel.wholeFailedLine`:
  "The mail did not load: …" for a mail; a computer act's picture says its
  own, "The picture did not load", in the picture's place).
- **After Send** the detail returns to the list (on the open Duo it stays
  until the item leaves; see The next item) and the item leaves it. An item
  opened from anywhere but the Outbox's list (Today's row, its pick on the
  open Duo, a notice) brings the Outbox's list up with its countdown, over
  where he was, so Back returns there; an
  **undo capsule** (glass, 44 pt, one line "Sending to …" and Undo) floats
  over the list's foot for five seconds, entering and leaving from the
  same edge (opacity alone with Reduce Motion). The host hears nothing
  until the five seconds end. Every phone Send waits so: Send Later's line
  names when it goes ("Sending to Dana Lee Wed 8:00 AM"), and Send Now's
  is the plain send's. A phone press says `via: 'phone'`.
- **A thread's request** (docs/agents/work-outbox.md "A thread asks for his
  press") is one sheet (`tcSheet(.editor)`, Close at the top) opened from
  the list's Asked row, from its notice (a tell keyed `request:<id>` opens
  the Outbox with the sheet over it) and from the thread's card. It loads
  the request from its host (`request.get`): the head (title3 semibold), one
  sentence of what the ticked rows send in the kinds' own words ("Send 2
  mails to 2 people", "Send mail with Purdue mail to 2 people", an add-on call that names its
  people by whom it reaches, else ", 2 times": the shared
  `summaryHead`, src/shared/work/outboxHead.ts), so it always agrees with
  Send N, and once answered what the press did ("Sent 2, 1 left out",
  "Queued 3 in LifeOS"), "You asked in <thread>: “<his
  words>”" in meta, then a row per item: a 22 pt tick in a 44 pt hit area
  (`checkmark.circle.fill` in the tint, else an empty circle), the act and
  under it what it is about, "Goes Wed 8:00 AM" for a later one, or
  "Changed since asked" for a row that changed since the ask, which starts
  unticked and can be ticked only once he opens it (the chevron pushes the
  item as it will go, and opening it asks the host for a fresh receipt,
  `request.view`; a read that fails says "Not opened" and why in red, in
  the failed-read row). A read again that fails over the request on screen
  (a push from another device) puts its reason and Try Again above the
  head until a read lands. A tick is the receipt the host issued for the row as
  drawn, never the item: a reload that moves a row's receipt or marks it
  changed clears its tick, and a row opened through `request.view` starts
  unticked until he ticks it. The foot is two wide glass capsules, Not Now
  and "Send N" ("Approve N" when the ticked actions mix). Send freezes
  exactly the ticked receipts and waits the phone's five seconds: the
  sheet's foot, outside its stack so a row opened during the wait never
  covers it (nor, after it, what became of the press: "Sending…", then the
  sum or the refusal, over the row's page until he is back on the list),
  becomes the undo capsule naming what goes ("Sending 2 mails to 2
  people", Undo), each ticked row keeps its own words (its act, and when a
  later one goes), and the rows left out dim. Closing the sheet never sends it early: the frozen press waits
  out its five seconds (`RequestPresses`) with its Undo at the tab's foot (or over another request's sheet that
  covers it), and a sheet opened again shows it waiting, then its answer; an answer that lands with the sheet closed
  is the toast, sticky when a row did not go or may have gone. Leaving
  the app or losing the link cancels it, as every phone Send, and the line under the head says so ("Not sent:
  TempCode left the screen"). A press whose answer was lost keeps Send busy and the line says "Checking…" until
  the request is read back; Send keeps its name for VoiceOver, its value "Sending" while the spinner shows, and draws "Sending…" (or "Checking…") beside it. Then each row's result lands in its line (a muted
  check, with "Queued in LifeOS", "Back in drafts in LifeOS", "No longer in LifeOS", "Posted", "Discarded" or
  "Scheduled" only where the word adds to the check (LifeOS's words only on the host's own verdict on the item,
  never because a mail's stored result reads sent), or the destructive dot and the reason),
  a row the press did not take reads "Left out" at full ink, and the foot
  is Done. VoiceOver names each row's mark by its result ("Sent", "May have gone", "Not sent", "Left out"), never by
  the ticks the settled sheet no longer holds. Not Now declines
  and closes. A key that may not answer it reads why and cannot press. Nothing
  here wears the warning colour: held is not Needs you.
- **The thread's card**: a Work thread's `outbox_request` call (its
  result's `{outboxRequest: {id, host}}`) is drawn as its card alone, in
  the call's place (no "Used …" line above it): one compact card in the
  transcript's hairline frame (the field radius, 12 pt in, no fill), the
  `checklist` glyph muted, the request's one name at subheadline medium
  (the host's head, as the list's Asked row and the notice say it), "You
  asked: “…”" in meta on two lines at most, and "Review" in the tint where
  a chevron would be; a tap opens the sheet.
  Answered, declined or run out, it is one muted line ("Sent 8, 1 not
  sent", "Not now. …"). A group holding an open request stays open, as one
  holding a held call does.
- **The check before an outward press.** Send, Send Later, Send Now, Send
  and stop holding, Discard (after its prompt), Cancel Send, a request's
  Send, Edit's Save, Undo of a result, a guest link's Create and New
  Address, and a held mail's Send ask Touch ID, Face ID or the passcode
  through the system's own sheet, once per attempt, before the five
  seconds start; a pass covers a minute while TempCode stays in front.
  Nothing of ours is drawn for it: no alert, no spinner of our own. A
  cancel says "Nothing was sent." in the press's own line.
- **The bar's lines.** Each refusal is one line where the press was, never
  an alert: the list's capsule, the held detail's
  state line, the line under a transcript's opened act, the request sheet's
  line under its head, the Edit sheet's and
  the guest link sheet's error line, the composer's own error. With no
  link, Send is still drawn (the key may press) and a press says "Not
  connected to <host>" at once, asking nothing. A press whose answer was
  lost reads "Checking…" in the row's meta line, in the detail's state line
  (no bottom bar until it is read back) and as the transcript line's lead
  word, then "Changed" or "No longer waits" after the read-back; "May have
  gone" keeps the item's Check Sent first and Send Again.
- **The digest** (docs/agents/work-digest.md "The phone") is a pushed list
  (the sidebar in the split poses), reached from a **Digest** row at the Work
  list's foot (the `newspaper` glyph, no count) and from the day's
  notice. Sections by day, newest first, under the Outbox's gray band step:
  "Since the digest", "Today, 8:00 AM", "Yesterday", then dates. A row is the
  job's sector dot in the mark column (a muted ring for a row about no one
  job), the title, the detail in meta under it (both whole, never cut: the list is the record), the time as a stamp; the dot
  and the time sit on the title's first line, the line under it at the row's full width, as the Inbox's rows do ("by
  2:00 PM" for a row whose clock was ahead when it was told and its words do
  not already say, a day that is not today named; else when it was told, its
  day named only when it is not the day of the row's heading). The dot is the only colour; no counts,
  no chips. A row the phone has no screen for is not a button. Loading draws
  the rows' shape; empty is one line, "Nothing Since Oct 24"; VoiceOver says a row's job before its title; a host that did not answer is
  one meta line at the foot with Try Again, which reads that host again (the failed-read row), each
  line by the computer's id, so two of one name stay two lines. A cold open with a host away draws the days the phone kept of it (its newest fourteen
  and the rows each drew), as they were: nothing is marked seen from them until the host answers. Settings → Work has its Digest section after the
  group with the Work switch and LifeOS, only while some host has Work on:
  Time, then Held items, Routine results, Messages and mail and Meetings, each
  a menu of three levels. The time's wheel keeps his latest pick: a slow
  host's answer to an earlier pick is not applied over it (`EditGate`).
- **A held notice** (the host's `needs_you` with `tc.held`) opens its item
  over the Outbox, and a request's notice opens its sheet over the Outbox.
  Its category is Open alone: nothing sends from the lock screen.
- **Away** is two check items in the host menu beside the fleet switches:
  **Away for Code** (`house`) and **Away for Work** (`briefcase`), each with
  the decisions its threads made this stretch as the item's second line
  ("3 decisions", none while there are none). A host one release behind
  keeps one item, "Away" (`moon`), for both. When the last kind ends: one note at the top of Home ("Away ended.
  7 held, 4 decided without you" and Review), and a notification "Away
  ended" when the end reaches the app while it is not in front (a
  suspended app hears nothing; the note is then the notice). Review is a document sheet "While
  You Were Away": the span, then Held (each with its verb), Failed,
  Decided without you (a thread and its count, which opens it), Written on
  your files (Undo where the write has a way back), each left out when
  empty, and one footer line: "Away never sends a held item."
- **Settings → Work** is a row under Computers while any computer has Work: per
  computer, the switch, LifeOS's state in words, Things threads may send on
  their own (each with Remove, no confirm, no press scale), and each add-on's
  tools with Runs, Held or Off. Guest links, the grants and the tools hold
  their place in their rows' shape while read; a computer that leaves its
  links to another is remembered for the launch, so its section never shows
  and goes. New Address… asks first, naming the address that stops opening.
  The Digest's footer says "One set for every computer with Work on"; its
  rows are Arrives at and the four groups (Things waiting for me for held
  items). The first computer's group also holds the phone's own switch,
  "Require Face ID to Send" (Touch ID, Optic ID or Passcode as the phone
  has) with "This phone" under it, on by default, right under Work; turning
  it off asks the check once. With no passcode set its
  footer says "Set a passcode on this iPhone to send from here."
- **A Work workspace's screen** is the workspace screen; a host that
  cannot reach LifeOS says so once above the threads ("Sign in to LifeOS
  on <host> …", or "Can’t reach LifeOS. Retrying…").

- **A grant** is made from a held item's Send: a press and hold on Send
  opens its menu, "Send and stop holding" › the grant's name (a mail's
  account and recipients, an add-on call's server and tool); the Send waits
  its five seconds with the grant riding it, and the grant is made only when
  they end, just before the send, so Undo takes back both. Only a key with
  admin sees the menu; Settings → Work lists the grant with Remove.
- **New Job** (a Work workspace): the "Jobs" band's + opens a form sheet titled "New Job" (Name,
  Sector with its dot, Host when several have Work); the workspace opens
  when it lands. **New Chat**: Work Chats' compose button opens a
  sheet with the first message and Start; the thread opens.
- **The held line in a thread**: under a Work thread's call the host held,
  one muted line, the Outbox glyph in the glyph column, "Held" and the act.
  A tap opens it in place: the act's fields and body in a hairline frame
  (the field radius, no fill: held is not Needs you) with Discard, Edit
  (the item's detail) and Send. Send waits its five seconds on the line
  itself ("Sending … Undo"). Once decided the line reads "Was held" and
  opens nothing.
- **Results**: a Work thread's menu has Results, a document sheet in two
  groups, Can undo (each with Undo or the pillar's own words) and Can't
  undo; an undone row stays, struck through, with "Undone".
- **Settings → Work**: a tool with no rule reads "Not set" until he picks.
  On the host that serves LifeOS's documents, **Guest links**: who and
  what, the role and when it ends ("open now" while the guest is on it),
  each with New Address (shown once, with Copy, in a sheet titled "New
  Address" whose footer leads with whose link it is, "Dana Lee’s link to
  Budget.", so a long name is never cut; shown
  on return if he went Back while it was made, one sheet for each address,
  each holding its own; a cancelled check says so on the link's row)
  and Revoke; ended ones
  muted.
- **House rules**: a Work workspace's screen leads with a "House Rules"
  row. The page lists what is proposed (the sentence, "From N edits"
  opening the edits as one paragraph each, what he took out struck through
  in red and what he put in underlined), with Add Rule… (the sentence in a
  sheet to adjust), Not Now and Dismiss; then the rules in order, each one
  line with its switch, reworded in a sheet, deleted by swipe, reordered
  with Edit; + adds one.

What milestone 47 added (approved pages `phone-life.html` and
`phone-canvas.html`):

- **A Work workspace's screen** leads with Mail, Tasks, Agenda,
  Projects and Routines on the Home row grid, then House Rules. While its
  host is signed out of LifeOS or cannot reach it, the four LifeOS rows sit
  at half strength under the one status line.
- **Mail, Tasks and Agenda are LifeOS's own screens** (work-kit's
  LifeKitUI), narrowed to the workspace's sector, so no sector dot shows.
  A job's page shows that job's rows alone, never another sector's.
- **Tasks and Agenda for every job** are places of the Work tab: the same
  LifeKitUI screen, in the detail, over every job's sector at once, each row
  with its sector's dot, and the job filter in the bar (All Jobs, then each
  job with its dot) narrowing it to one. The open Duo gives it the whole
  width, the sidebar put away, so LifeKitUI shows its two pages. Where no
  host signs the whole session the place shows one job at a time and the
  filter has no All Jobs; with nothing that can read LifeOS, one line says
  why ("No computer that holds a job is online."). Agenda's rows carry the
  host's marks: when to leave, and a clash in the warning ink under the place.
  They keep LifeOS's type ladder (body and subheadline), beside the app's
  15/13/11 list ladder, as the approved page draws them. Their sheets are
  LifeOS's. Send in their composer goes to the host (the hold, for a
  thread's draft); Start Thread leads the task, event and mail menus.
- **Projects** (the projects plan's milestone 8) is LifeOS's own list and
  project screen too (LifeKitUI's `ProjectsList` and `ProjectScreen`), for
  the workspace's sector: one group a state, Done and Dropped folded, each
  row its glyph, name, 4 pt meter and `done/all`; a project shows its name,
  state, meter, the description's lead (four lines), the tasks as a folding
  tree with their keys, "Done n", and Documents; a task opens LifeOS's
  task sheet, which now holds the task's sub-tasks and comments. No board,
  no drag, no editing of a project on the phone. Below the rows the
  project cards stay the places threads live; a Work project's card has no
  branch line.
- **A Work project's settings** hold Rules for its threads (the project's
  rules row, which pushes the rules editor) and nothing of code: no review
  before merge, no plan flow, no workspace default row. Its one button is
  Done, since the rules save in their own editor. Sharing (the project
  guest links, the projects plan's milestone 7) is the desktop's alone for
  now.
- **Start Thread** opens a form sheet, "New Thread": the item as a chip
  (28 pt, radius 8, the fill, the kind's glyph and its label) above his
  words, Cancel and Start. Nothing runs until Start; the thread opens.
- **Item | Chat**: a Work thread with an open item is two segments, the
  item's name (cut to fit) and Chat. Under the bar one row holds the
  item's More (Share… for a document or sheet, Close); with
  several items a glyph beside More opens the items by name, the shown
  one ticked, and under them Move Up and Move Down for the shown one (the
  thread's order, `work.canvas.reorder`; off at either end). One item's
  name shows once, in the segment.
- **The hosted editor**: a LifeOS document or sheet loads `/w/open` in a
  web view at full width with no inset, in the native frame (M3c): the
  address asks `chrome=none`, so the page draws no title or role bar and the
  app's bar is the only heading. The paper's shape and its determinate bar
  show at once; the web view, made warm beforehand (`HostedWebPool`), fades
  in over it on `Motion.base` when the page says it has drawn (a page from
  before the bridge is shown two seconds after it loads). It never raises
  the keyboard before his first touch, and takes no touch while hidden.
  While he types, a format row sits above the keyboard on the system's bar
  material: the line's style as a menu of the styles the page offers, then
  Bold and Italic, then the bulleted, numbered and check lists, each a 44 pt
  glyph on the selected fill while the caret's words have it. Undo and Redo
  lead More, only while there is something to undo or redo, set apart by a
  divider; Find… opens the system's find bar, whose count and steps the page
  answers. Its failure is the system's unavailable view, "This page cannot
  be reached right now", with Try Again. The edit menu over a selection
  leads with Ask, then Comment for a document.
- **Native kinds**: a PDF in the system's viewer with the page capsule
  ("6 of 14", glass) at its foot and Ask at its top corner; a deck's
  render with the filmstrip under it and, while changes wait, the review
  row (44 pt: how many, Reject, Accept as the one tinted button); a video
  over its comments by time, a comment field that pins to the frame
  shown (a long one from the host's HLS proxy, a short one from its proxy
or original; a key without admin sees "This file opens on the computer."
for a short one); a picture from its tiles, or whole at phone size; a meeting's transcript (who, when, the
  words); the browser: its page live where the kept picture goes, above
  the driver ("You are driving" or "The agent is driving") with Take Over
  or Hand Back, and an act it holds as the one prominent glass button,
  which opens the held detail; a form's responses
  (each answer under its question); a meeting's, a form's, a dashboard's
  and the browser's read again that fails keeps what shows under the
  failed-read row in red (`FailedRead`), and a pull's spinner lasts until
  that read answers (`RefreshFailure.reread`); a video still being prepared
  whose check fails shows that row in the spinner's place, its Try Again
  reading the item again; a dashboard's blocks (a figure's line
  under its number and a chart's values at the stamp size in the label
  ink); history as a version list, each opening a compare with now, headed
  by the counts above zero alone ("2 changed"; `HistoryRestore.counts`),
  what went struck through in red, what came underlined in green. A held mail shows as it will go;
  once sent, the rule his edits suggest is one muted line with Add Rule.
- **The live picture** (`Work/Items/LivePicture.swift`, docs/agents/live-video.md):
  the computer an agent drives as video, in the field corner with the
  hairline, at its own aspect on the one gray fill until the first frame.
  It plays while it is on screen and the app is active, and stops
  otherwise. On mobile data it does not start by itself: one Watch pill
  sits in its middle, and a tap starts it. Nothing says "live" and nothing
  counts frames. A stream that ends leaves its last frame; where there is
  no picture to show, one muted line under it says why in the desktop's
  words ("Shown on <machine> only", "The preview stopped" with Try Again, the
  Screen Recording line), and "Another page is on screen" when the box's
  display shows another page (`busy`). A tap opens it full screen on the same
  stream: black, Done (glass) at the top corner, the picture at its aspect,
  and one row of glass controls at the foot, centred, at the large size. It
  turns with the phone as every screen does, and a turn opens the stream
  again at the picture's new width.
- **The full screen's controls.** Watching: Stop (an icon button,
  `stop.fill`) where something runs, and Take Over where the computer takes
  input (the box's page, the Windows VM; never a person's own window).
  Driving: the keyboard (an icon button, its glyph the keyboard down while it
  is up), Paste (`doc.on.clipboard`) and Hand Back, the one prominent button.
  A key that may not operate sees none of them. A failure is one short line
  above the row. The full screen keeps the dark scheme in both appearances.
- **Driving** on the full screen: a tap clicks, a drag moves with the button
  down, two fingers scroll, a long press is a right click, a pinch zooms the
  picture on the phone alone (1× to 4×, about the fingers; one finger pans a
  zoomed picture while he watches; it settles inside the screen with a
  quarter-second ease, at once under Reduce Motion). Nothing marks the
  touch: the page's own pointer answers.
- **Computers** (`Work/ComputersScreen.swift`): while anything is driven on
  a connected host, Home carries a Computers row after the Outbox, shaped
  as it: the `macwindow` glyph in the 28 pt mark slot and "Computers", no
  count (the desktop's rail row carries none). It opens a pushed list (the
  sidebar in the split poses), one inset section per tile, the one that
  acted last first: the live picture, then the thread's title (title step,
  medium; it opens the thread) over one meta line, what it is doing (or
  "You are driving") then where it runs at medium weight, never joined with a dot. No buttons on a tile: Take Over,
  Hand Back and Stop are on its full screen. A connected host whose read
  failed heads the list with its failed-read row in the destructive ink
  ("Computers on the box did not load: …", Try Again), over what it said
  last, and the list never calls it idle; a key that may not read them has
  none. With nothing driven the list tells three states apart
  (`ComputersState`): a spinner while a connected host has not said; "Not
  Connected to the box" when no host is connected; else "No Computer in
  Use", its line naming any host away ("Not connected to Mac.").
- **Ask** from an item is a form sheet: the selection as its chip, his
  words, Send; then Chat shows.
- **The guest link sheet**: a form sheet at medium height, For, Can (View,
  Comment, Edit, one segmented control), Ends (a date), Cancel and
  Create; then the address once, with Copy and Share.
- **Routines**: two bands, Routines and Watches, headed (`SectionHeader`) only when both have rows; each row its name, its
  trigger in plain words under it, and when it next runs as the stamp only
  where that adds a fact: none for a run the words already name ("Fridays
  at 4:00 PM"), a date for one a week or more away ("Dec 4"), a time for a
  cadence that names none (a watch that ends on a day: "Until Tue, Nov 24"); a watch carries the
  watching dot, a paused one the pause glyph; swipe for Pause (warning) or
  Resume.
- **Write in My Voice** is the first row of the house rules page.

Capture (capture from anywhere, docs/agents/work-capture.md "The
phone"):

- **The way in** is the `plus` ("Capture") in the Work list's bar, before
  Work Settings, and in Today's bar, while some host's key may file a note,
  take a receipt or upload; and the "Capture" and "Voice Note" App Shortcuts
  and controls (the Action button, Control Center, the Lock Screen), which
  open the same sheet over whatever tab shows. It fills the height (the
  editor kind), "Capture": the words (a field he can edit, "Note", focused
  when "Capture" opened it, the keyboard down for "Voice Note"), then Sector
  (Unsorted with the quiet dot, or a sector with its dot) and Start Thread,
  then the reason a save failed as the section's footer in destructive
  text. Once he adds any, the photos and files stand in a section of their
  own (a 36 pt picture at the row radius or the `doc` glyph, the name
  cut in the middle, the size as a stamp; swipe to remove), with Job (a
  picker of the jobs a file can go to, each with its dot) when there is more
  than one, and the footer saying where they went ("2 files go to Purdue.")
  or what could not be read, a Files picker that failed too ("Could not read
  the files you picked."). A pick that would not copy in is told there and holds nothing back: Save queues the files
  still in the sheet, then files the note, and stops before the note only for a file that press could not queue.
  Picked again and copied, a file's failure is gone. Last, one section of plain rows: Scan Receipt
  (`doc.viewfinder`), Add Photos (`photo.on.rectangle`, the system's photo
  picker) and Add Files (`doc`, the system's file picker). Cancel keeps the
  draft; Save is the one confirm, a spinner while it goes, the success
  haptic when a note is filed or a file is queued.
- **The hold control** closes the form, in its flow under the last rows (never floating over them, so the Job row
  stays whole at a large text size): a 72 pt circle
  on the fill step with `mic.fill`, one line under it in meta ("Hold to
  Talk", the clock while it listens, a spinner while the last words land,
  or why it cannot listen). Held, it grows to 1.12 on the layout spring;
  listening, it is destructive red with the glyph in white and a light
  impact; the release returns on `fast`. Reduce Motion dims the press to
  `pressDim` and keeps the colour. No ring, no level meter, no glow.

The receipt (Money, docs/agents/work-money.md):

- **The way in** is `doc.viewfinder` ("Receipt") beside the microphone,
  under the same rule. A press opens VisionKit's document camera at once,
  full screen as the system draws it (the one full-screen view besides
  Safari and the live picture); it finds the page's edges and flattens it.
  A receipt that still waits (a Save that failed) opens its sheet instead of
  the camera. The simulator has no document camera: a DEBUG build takes a
  made-up scan in its place (`ReceiptFixture`).
- **The scan** is read on the phone (`OnDeviceText`: Vision's accurate
  recognizer, no language correction, never a server). One page goes as a
  JPEG, its long edge 2000 px, at the first quality that fits 2 MiB; several
  pages go as one PDF, each page fitted to the same Letter bound.
- **The sheet** fills the height (`tcSheet(.editor)`), "Receipt" ("Receipt 1
  of 2" while two wait): the scan as a 56 pt picture at the row radius with
  the 10 % outline (the photos pattern), the whole page fitted inside it on
  the fill step, beside Amount (a quiet "$" in the
  secondary tint before it, as the desktop draws every amount; the decimal
  pad; a word turns it destructive and holds Save off), then Date (a date picker,
  from January 1, 1990, never after today; Add Date until one is read or picked) and Seller; then
  Category (the job's own list, what was read chosen, and None) and Job (every
  job a host keeps, each with its sector's dot and its name, the host's name
  after it when two hosts keep a job of one name, the last sector used
  first; a spinner while the hosts answer; fixed once a part has gone to a
  host), the reason a Save failed, or "This receipt was discarded on the
  desktop.", as that section's footer in destructive text; last, Scan Another and Discard Receipt (one
  colour, the glyph destructive with its words; it asks first). The fields fill when a host's
  parser answers, with no spinner or mark in them; what he typed first
  stands. The parser is the held job's own host, asked for its workspace, so
  the category is what that job's ledger last gave the seller, and the
  picker lists that job's own words. Another job picked clears a category he
  did not choose at once and asks again: its answer fills it, and with no
  answer it stays empty, so Save never files one job under another's guess. Cancel keeps the draft; Save is the one confirm, a spinner while
  the parts go, then a light impact and the app's toast line saying where
  it went: "Filed in Unify", "Suggested in Unify's ledger" when the ledger is
  a sheet others can open and the row only waits there, or "Waiting in Money
  on the desktop".
- **Save** sends what he saw at the press: the fields, the job and whether
  a host's parser had answered are fixed then, so a parse that lands during
  the Save changes nothing sent. The job is a host's workspace: picked (or
  the first offered), its host and `workspaceId` are kept with the draft,
  and the scan goes there in parts of at most 2 MiB, under one key, with
  the sector beside the id; another job in the sector is never chosen for
  him, and with no job (no host answered) Save stays off. It goes with the lines and the fields, and `seen` when
  the parse had answered (then what he left empty stays empty on the
  desktop; `seen` only when that parse was for the job shown). With an amount and a date the host files it in the job's ledger
  at once; without, it waits in the desktop's To confirm list. Either answer
  removes the draft; while another waits, the sheet goes on to it. Discarded
  on the desktop (`dropped`), the draft stays with its key spent: Save is off
  and Discard Receipt removes it.
- **Nothing lost.** The scan is a file in Application Support and the rest
  is in the phone's defaults (`work.money.receipt`) from the moment the
  camera closes, so Cancel, a failed Save and a quit keep it. The receipt
  goes only to its job's host: a retry keeps the key and goes there and
  nowhere else, and while it does not answer the draft stays
  ("Unify's host did not answer. The receipt is kept on this phone."), since
  a second host keeps no record of the key and would file it again. A scan
  the phone cannot write is held in memory: the sheet shows only Try Again
  and Discard Scan, with the reason as their footer in destructive text (no
  other draft, no Scan Another, no Save), `Receipt` refuses a second scan
  while one is held, and Home's press opens that section again until the
  scan is kept or let go.

Files (the files pillar's F9, docs/agents/work-files.md "The phone"):

- **The way in** is Files on the Work list, a place for every job at once
  (`FilesPlaceScreen`, the sidebar column). A job's page has a Files row
  too, after Projects and before Routines (`folder`): the same place
  narrowed to that job.
- **Files** is a plain list, one band a job, its sector's dot then the job's
  name at the text edge (the Outbox's band) while more than one job shows; a
  name drops our own two endings (`.tcdoc`, `.tcsheet`) everywhere in Files, as
  the reader's bar does; a size reads one way on every screen
  (`FilesRules.size`, "15 KB"); the bar's job
  filter narrows it to one (All Jobs, then each job). A band holds Recent
  and Starred, the job's places, the folders of his other computers the
  job's host reaches for the phone (`desktopcomputer`, the computer's name
  as the stamp; one that did not answer is its name at half strength with
  "Not reachable", a press asks again), From Mail, then Trash, each only
  when the host lists it (a remote key is told only what it could name). A
  place two computers hold is one row. A row is the house row: the glyph
  in the 28 pt mark slot, the name, one fact as the stamp in the secondary
  label ink (a place's state while it does not answer, its team, a lens's
  count). A place that does not answer has its glyph and name at half
  strength; its state stays legible. The bar holds Go To
  (`arrow.forward.circle`, ⌘P), Saved Searches while the host has any, and
  New while one job shows. A job's places that fail to read, first or on a
  pull over places kept (`placesFailed`), are one failed-read row over the
  bands, Try Again reading them again.
- **A place, a folder, a lens** pushes a plain list in the sidebar column
  (`Route.folder`: a relaunch comes back on it; a file picked opens in the
  detail, `Route.filesFile`, and its row wears the selected fill on the open
  Duo). On a cold launch the list paints the names kept from its last read
  (`FolderKept`; a kept file row opens nothing until the folder answers,
  and a read that fails over rows shown, kept or read live, says so in the
  failed-read row above them, in the list or the grid, and above a search's
  empty result).
  The host's rows come in its order, a page at a time (the next page as the last row shows, a
  spinner row only while one is out; a next page that fails keeps the rows
  and ends the list with the failed-read row: the host's sentence and Try Again). Each row: the kind's glyph, the name (cut
  in the middle), one fact: what is happening to it ("Esports Staff is in
  it", "3 suggestions", "A thread is writing", "In the cloud"), else in a
  lens the place it lives in, else when it changed ("9:41 AM",
  "Yesterday", "Nov 3"). A file a thread made that he has not opened has
  its name in semibold. A folder pushes; a file opens. A sleeping
  machine's list leads with one muted line, "MacBook is asleep. As of 9:41
  AM."
- **States**: a spinner while the first read is out; "No Files" (or
  "Nothing Recent", "Nothing Starred") when empty; a place that is down
  says its state as the title, the host's sentence under it and Try Again;
  any other failed read says "Can’t Open <name>" with the reason and Try
  Again. The reason is the host's sentence alone, never the wire's code
  word ("internal: …", `FilesRules.sentence`). Pull to refresh.
- **Presses**: the context menu holds Star (Unstar), Add to Thread…,
  Rename…, Move…, Copy… and, under a divider, Delete; swipe leading stars,
  swipe trailing deletes (never a full swipe). Add to Thread… opens the
  job's open Work threads, pinned first then the newest; a tap puts the
  file's chip in that thread's box and opens it, nothing sent. A file row
  dragged onto a thread's box gives the same chip. A Trash row holds Put Back alone. Each is
  offered only where `FilesRules.offers` says the place does it for this
  key (a key without operate sees none; a shared place asks approve), and
  a refusal the host still gives shows in an alert as the host words it.
  A computer reached through the job's host is read here and changed on
  that computer: its rows hold none of these. Rename is the system alert
  with one field. Delete moves to Trash at once and puts the Outbox's undo
  capsule over the list's foot for five seconds ("Deleted Budget.xlsx",
  Undo puts it back); where others can open the place it asks first, the
  desktop's words ("Delete Budget.xlsx for everyone?" over who can open
  it; a drive with no bin "Delete Roster.xlsx for good?"), as a
  confirmation dialog with Delete in the destructive role.
- **Move… and Copy…** open a sheet at half height: the job's places, then
  their folders a level at a time, and the folder shown takes the bar's
  prominent glass button (Move Here, Copy Here). Where the change cannot go
  the button gives way to the grammar's sentence ("Teams files stay in
  Teams."). A move or copy into a place others can open asks its one
  question once the sheet goes ("Move to Esports Staff?" over "Everyone in
  that team can open it."); his yes goes with the change. A file row
  drags onto a folder row in the same job (the open Duo, a pointer): the
  same Move, asked the same way. A done change gives a light impact.
- **The grid**: where the host draws pictures (not a computer reached
  through it, not the Windows VM) the bar's overflow holds View as Icons:
  tiles of the host's small pictures (`work.files.thumbs`, asked forty at
  a time, once a run) with the kind's glyph until one comes or where none
  does, the name under it in two lines. It reads a page at a time as the
  list does, under the same failed-read row and over the same foot. The
  choice is kept.
- **A file of another computer** opens as the copy its job's host makes:
  its row and the page's loading bar follow the bytes (`work.files` push's
  `opening`), then the reader as for any file.
- **Go To** is a sheet with the search field focused: as he types, the
  names each job's host has seen (`work.files.names`, recents first with
  no words); Return takes the first. Rows stand only for the words they
  answered: typed past them, they go and a spinner waits for the new
  answer, so Return never opens an older match. Only the newest lookup,
  typed or Try Again's, sets the rows, the failed-read row and the
  spinner's end. A folder pushes, a file opens.
- **Search** is the system field on every list. On Files it filters the
  rows the phone already holds at once (every word, case and accents
  ignored), then takes each job's host's search as it answers, newest
  change first, each row led by its job's dot while several jobs show
  (`FilesFound`); the next keystroke cancels what is still out, and an
  answer for older words never lands. Only the newest search started,
  typed, saved, Try Again's or a pull's, sets the rows. A job whose host could not search is
  named in one line. A folder's field filters its own rows. A saved search
  (made on his computer) runs from Saved Searches into the same list, its
  name as the header with a clear button.
- **New** (+ in the bar, where the place makes or takes uploads) is a form
  sheet, "New": the kind as one segmented control (Document, Sheet,
  Folder), the name field with the kind's "Untitled …" as its placeholder,
  Cancel and Create; the host's refusal is the section's footer in
  destructive text. An Upload section holds From Photos and From Files.
  The sheet goes at the pick; the upload is a row at the head of the
  folder, in the list or the grid, with the name and a linear bar, or its
  reason in destructive text with Dismiss.
- **Open**: a LifeOS document or sheet, a PDF, a deck, a picture or a video
  is seated in the workspace's Files pane (`work.files.open`, or the thread
  that already shows it) and opens on the reader page ("A file on the
  phone"). So does a document or sheet kept as a file in a place of his
  own: the hosted editor takes it first, and where its host will not open
  it there Quick Look stands in its place under the reader's bar. Anything
  else, and every file for a key without operate, opens in Quick Look.
- **A save that failed** (Save to TempCode, a file the host would not take)
  leads the Files screen of its workspace under a "Not saved" header: the
  file's name, the words in the destructive text ink, Try Again (a spinner
  while it goes; Discard in its place where no retry can help) and a swipe to
  Discard, with `arrow.up.doc` in the
  rows' mark slot so the names line up. The section is absent when nothing
  failed.
- **Quick Look** is the host's preview pages in a paging view (the system
  page dots past one page) with the facts line under them: the kind in
  medium weight, then its size and when it changed as prose in regular
  weight ("Text" "52 bytes, 9:41 AM", `FilesRules.factDetail`; a text
  file's preview is a sketch of its lines, never its words); where the
  host makes no preview (F3) the file's facts stand in the middle: the
  glyph large, the name (title3 semibold), the same facts line ("PDF"
  "2.4 MB, Nov 3"), and who saved it. A page that does not come says
  "Can’t Show Page 2" with the host's reason and Try Again in its place,
  never a spinner that does not end. The foot holds one thing: Open the Original (a prominent wide
  button; Play for sound and video, which plays in AVKit in place) for a
  workspace-folder file of 50 MB or less; "Edit on your computer" above it
  for a document or sheet kept as a file; "Over 50 MB. Open it on your
  computer."; or, for a shared library's file, its facts only and "On
  MacBook", with Open in Word (Excel, PowerPoint; a prominent wide button,
  `arrow.up.forward.app`) under it for an Office file whose host knows its
  web address. It fades in when the host answers and is absent when it has
  none; it opens the Office app, else the address in Safari. The original opens in the system's Quick Look and its temp
  file goes when the preview closes.

Not on the phone, and why: LifeOS's project cards on a Work workspace's
screen (no wire lists them yet); the recording player of a meeting; a Word
or an Excel file in the hosted editor (the desktop's own editor saves those;
the phone says "Edit it on your computer" and still shows its comments and
changes); Files' Empty Trash, tabs, the columns view and making a saved
search (the desktop's alone for now); a change to a computer's files
reached through the job's host (made on that computer).

### Today

Today is the Work tab's first place (prototype `.temp-code/prototypes/work-ios/today.html`): the first row of
the Work list, with the day on its second line: the next meeting with its time ("Budget sync at 2:00 PM"), else
what is due ("Book the ballroom due at 3:00 PM", "3 due, 1 late"), else none, and never the Outbox's count, which its
own row says one row down (`TodayModel.workListLine`), and where the tab opens at the day's first entry. One list for every job, drawn on
`WorkPlaceScreen` (Work/Today/TodayScreen.swift):

- **Order and words** are the window's, by the Swift port (`Work/Today` in the client package): Waiting on you,
  Meetings, Due, Waiting on others, Messages, Owed, then Also (the review's cue and the digest's rows). A section
  that has not answered draws three redacted rows in its rows' shape; an empty one says so in one muted line;
  rows that are over sit muted and folded at the section's head ("2 earlier"); past the fold, "3 more". No count
  beside a heading: the rows and the Work list's line say it.
- **The row** is the house row: the lead in the mark slot (a task's tick, else the job's sector dot), the title
  and one line under it, the trailing fact with its live line under it ("2:00 PM" over "in 25 min", "Leave 5:10
  PM", "Now"). The lead and the time sit on the title's first line in every shape, as the Digest's rows
  (`FirstLineMark`), so a wrapped row and its neighbour put the dot at one height. Late is said in the warning ink, a failed or clashing line in the destructive ink. VoiceOver reads
  the job first.
- **A press** opens the row's thing (`row.route`); a row whose place the phone has not built is not a button.
  On the open Duo the list picks its first held row for the empty detail.
- **The verbs**, a row's own at most two, are its swipe actions; the context menu holds the tick and the same verbs
  (three at most, on a Due row with a project), so the swipe and the long press never disagree. Each is drawn only on
  a fresh row and for a key that may press it: the tick (`work.tasks.done`, Undo reopens it in LifeOS), Tomorrow (LifeKit's `tasks:snooze`,
  Undo `tasks:unsnooze`), Open project on a task of a LifeOS project (the project's page in the detail, `Route.lifeProject`, which
  makes the job's own LifeOS session and waits for it, with Try Again, and comes back on a relaunch; the project's name is the row's line under the title, and "Project names did not load" is
  the section's one quiet line when a job's names failed), Nudge (`work.mail.nudge`: a thread that drafts the
  follow-up opens; nothing goes until he sends) and Dismiss on a mail wait (LifeOS's `mailWaits:dismiss`, fenced by
  the send the row showed, Undo `mailWaits:putBack`). A LifeOS verb's check, its write and its Undo all name the one
  session that read the row, stamped on it when it was built (`suppliedBy`, `suppliedScope`; `TodaySources.sessionOf`):
  the verb shows when the key may ask that host for a token, whoever homes the job, and never goes through another
  host's session or a scope read later. If that session has gone, nothing is written and the line says so ("LifeOS on
  Box is not connected, so nothing changed"). None sends to anyone, so none asks for the owner's check. Each answer is the shared undo
  capsule, one at a time: an answer with an Undo keeps it for its own time, the next waiting its turn, and a line
  with nothing to take back gives way at once (`CapsuleQueue`); its Undo shows the row again only once LifeOS took it back, else it says "Couldn’t undo". A ticked row leaves on `Motion.rowLeave`; nothing animates on the first paint.
- **States.** A host whose whole LifeOS session is down gives way to the next host that can read the day, as the
  desktop passes a down reader over (`LifeReach.reach`'s `down`), and keeps that host while it can read: the one
  passed over takes the day back only once the host read in its place is down (`LifeReach.PassedOver`, the desktop's
  `tried`). The LifeOS sections give way to one line, set off from the rows above by a gap near the desktop's 24 pt (the list's
  header floor at zero, a gap of a row's vertical padding), when no
  host can read LifeOS ("Not signed in to LifeOS on Box"; Try Again only where LifeOS was silent), or
  when the host it reads through says LifeOS is connecting ("LifeOS is still connecting on Box", a spinner, no
  press); a host that did not answer is a line with Try Again (`PillButton`, 44 pt) in the section it feeds; the hosts
  that are offline, a Work host not yet linked this launch among them, are named once at the foot. Each such line (a job's
  session lost on another computer, a refused key, the offline foot) is set off by the same gap as the LifeOS line. All clear:
  "All Clear" over "Nothing needs you today." or what tomorrow starts with.
- **Large text.** At accessibility sizes a row's title and line wrap to three lines and its time goes under them;
  VoiceOver hears "late" and "over", which the ink alone tells the eye. At any size a title or a fault's reason that
  would be cut wraps instead, and the time goes under the words (`ViewThatFits`); any other line keeps one line.
- **Speed.** The first frame paints yesterday's rows from the disk (`WorkCacheStore`), each opening its thing to
  read until it is fresh; the fresh page lands as a diff that keeps every unchanged row as the value it was. The
  hosts' lists are read once and again on their pushes and at midnight; LifeOS's own queries live only while
  Today is on screen. The minute's words are said when Today comes on screen and on each return to the
  foreground, then once a minute, at the minute. A kept row carries no live line, and a meeting or due row kept
  on another day is not painted.

### Messages

Messages is a place of the Work tab, after Outbox in the Work list: every job's chat (Slack, Discord, iMessage,
Teams) as LifeOS holds it, the desktop's Messages view on the phone (docs/agents/work-messages.md "The phone").

- **The list** (Work/Messages/MessagesScreen.swift) sits in the sidebar column on `WorkPlaceScreen`, with the
  job filter in the bar. One row a conversation, unread first, then the newest: the job's dot in the mark slot
  (All Jobs only), the route's glyph in the glyph slot (`number` for Slack, `gamecontroller` Discord, `message`
  iMessage, `person.3` Teams; no brand marks), the name (semibold while unread), the last words under it ("You:"
  for his own, a group's writer by first name) and the time as the stamp, in the tint while unread. No count, no
  badge: unread is the weight and the stamp's ink. A leading swipe marks it read or unread (LifeOS's own mark).
  Empty: "No Messages". The foot reads the next page under a spinner; one that fails is "More conversations did not
  load" with Try Again, which asks each failed page again. The reads are LifeKit's live `chats:list`, one a sector, on the whole LifeOS session
  (`LifeReach`), else the picked job's; held only while the list is on screen.
- **A conversation** (`Route.chat`, Work/Messages/ChatScreen.swift) opens in the detail, over Messages' list (Back
  from a notice's conversation is the list). On the open Duo the list picks its first unread for an empty detail.
  The title is the conversation's name with its fact under it in the secondary ink ("Slack, CosmicGames"); More holds Mark Unread and
  Open in <app>. The messages run oldest to newest and open at the foot; a run (one writer, under five minutes'
  gap) shows its writer and time once. A Slack reply shows what it answers in one muted line. Opening it marks
  it read when someone wrote since he last saw it. A failed first read is "Can’t Read This Conversation", LifeOS
  out of reach "Can’t Reach LifeOS" with the host's words, each with Try Again. Scrolling up reads the older page
  under a spinner; one that fails heads the messages with "Older messages did not load" and Try Again, which asks
  that page again.
- **His reply** is the house's composer box at the foot (`ComposerBox`, no `+`). Send is the composer's own
  button; it goes through the host only by his press: no link says "Not connected to <host>" at once, the owner's
  check runs (`PressGates`), then the undo capsule waits five seconds ("Sending to Dana Lee", Undo) in which the
  host hears nothing; going to the background or losing the link puts the words back and says why. Then one
  `work.messages.send` with a fresh attempt key, written to `PressLedger` first. LifeOS's own row then shows
  under his words: "Sending" with Undo inside LifeOS's undo time, "Not sent." with its reason and Try Again (the
  owner's check again). A refusal puts his words back before what he typed since. A lost answer reads
  "Checking…" and is read back by the key on the next link (`work.messages.attempt`, which sends nothing): sent,
  never got (the words come back to send again by his press), refused, or "May have gone", whose words wait aside
  until Use Words.
- **Copy where nothing sends.** A Discord or Teams conversation, or one LifeOS says it cannot send to, puts
  LifeOS's reason over the box in one quiet line and makes the button Copy.
- **A thread's draft** shows over the box in one quiet line with its first words: a held reply ("A thread's draft
  waits in the Outbox") with Open, which opens its Outbox item, where it is sent; a copy-only draft ("Draft from
  <thread>") with Copy, which leaves the conversation once copied.
- **A file** under its message: its name in the tint when a reader kind shows it (PDF, document, sheet, deck,
  picture, video, recording); a press seats it in the job's Messages pane on the host and opens it on its own
  page (`Route.file`). "Coming from LifeOS" with a spinner until LifeOS has it; its failure in the destructive
  ink.
- **Today's** Messages rows open their conversation, and Mark read writes LifeOS's mark through LifeKit.

### People

People is a place of the Work tab, after Agenda in the Work list (docs/agents/work-people.md "The phone").

- **The list** (Work/People/PeopleScreen.swift) sits in the sidebar on `WorkPlaceScreen` with the job filter and
  search. One row a person, each once across jobs, newest contact first, then by name: the job's dot (All Jobs)
  in the mark column on the name's line, where Today and the Outbox draw it, the name, their first address under it. LifeOS's directory has no role, so the row says none. Search keeps the
  people every typed word is in, by name or address. Empty: "No People".
- **A person's page** (`Route.person`, PersonScreen.swift) in the detail: the name as the title, their addresses
  and numbers as one line, their notes, then a section only for what has something: Mail, Coming Up, Asked for by
  Them, Waiting on Them, Shared with Them, Past Meetings, Answered. A mail opens in the job's Mail on that thread,
  a meeting opens its page, a task its sheet, a form the job's forms. A shared item says what the link lets them
  do and until when; it opens nothing on the phone. Nothing open: one line. The page is asked at once, never
  waiting on the directory: LifeOS out of reach is "Can’t Reach LifeOS" with the host's words, a failed read
  "Can’t Read This Person", each with Try Again, and a person LifeOS does not hold "Can’t Find This Person", even
  over a page on screen (merged or deleted: no Write or New Thread left in the bar). A
  read that fails over a page on screen keeps the page under "This person did not refresh" with Try Again, gone
  once a fresh read lands.
  At accessibility sizes a row's name wraps; an address keeps one line, never hyphenated inside it, shrinking to fit
  whole (to half its size, then its middle gives way), in the list and on the page.
- **The bar** holds Write (LifeKitUI's own composer to their first address; its send is held like every send) and
  New Thread (the house's sheet with their person chip, in the job).

### A meeting's page

A meeting's page (`Route.prep`, Work/Prep/PrepScreen.swift) opens from Today's meeting rows and their prep mark,
from a person's meetings and from a prep notice, in the detail. LifeKitUI's Agenda cannot open it: its links name
no event.

- **The head**: the event's title, and one line under it ("Today, 2:00 to 2:45 PM, RecWell 204, leave 1:30 PM";
  a place that is only a link is left out; the leave time only while it is ahead). A failed part, or a refresh
  that failed, is one line with Try Again (`PillButton`); a Prepare, Follow Up or filing that failed keeps its reason
  in that line, with no Try Again that would only read the page.
- **The verb** in the bar is the one where the meeting stands (`PrepRules.verb`, the desktop's `headVerb`):
  Prepare, Preparing (a spinner, which opens the thread), Add Notes, Follow Up, Following Up, or none. More holds
  Open Thread, Prepare Again and Add Notes.
- **The body**: before the meeting the brief leads (its bones while its thread writes), then Agreed, Last time,
  People, Tasks, Files and Links. After it the outcome leads: the summary, Notes, Decided, To Do, Open Questions,
  Mail (the follow-up draft, which waits in the Outbox), then the brief under "Brief" and the rest.
- **Notes** are a field in their own section, kept as he types (500 ms of quiet, and at once when he leaves or the
  app goes to the background). Another window's newer words are never written over unseen: his stay, a line says
  so, and Keep Mine saves them.
- **To Do**: suggested tasks start unticked. Tick All, and "Add 3 Tasks" while any is ticked, sit at the section's
  foot. A task LifeOS did not take keeps why on its own row; Try Again files those again.

### A clash

A clash (`Route.clash`, Work/Clash/ClashScreen.swift) is a sheet on a phone (half height first) and the detail on
the open Duo. It opens from Today's Resolve and from a clash's tell or notice.

- **The title** says what is wrong: "Two things at once", "23 minutes short", "About 10 minutes short".
- **Each event** is a section headed by its job's dot and name: its title, its time, its place, then the ways out
  it allows while it is ahead: Decline and Propose New Time for an invitation. A move and Running late stay on the
  desktop. Then the drive between them ("38 min drive, 24 mi"; an overlap asks the host for the miles).
- **This Is Fine** quiets the clash until either event changes; the capsule offers Undo, which takes back the
  pair it was pressed for even once the host's push has reloaded the page without it, and reads the clash again.
- **States.** A first read that failed is "Can’t Read This Clash" with Try Again, never "No Longer a Clash", which
  is said only for a read that worked (the bar says "Clash"). A refresh that failed over a clash on screen is one
  red line at the top with Try Again.
- **Decline and Propose New Time** open a short form: what it does and who hears, a note, and for a proposal two
  date pickers filled with the first time the drive allows. Send goes to other people, so it is his press alone:
  the owner's check, then one `work.clashes.answer` through the press record, at once as the desktop sends. A
  reply that never came keeps Send off and says to check the calendar.

### Mail

Mail is the Work list's third place: LifeKitUI's own Mail, for every job at once as Tasks and Agenda are (each row
led by its job's dot, the job filter in the bar, the whole width and its two pages on the open Duo).

- **LifeOS down**: Mail, Tasks, Agenda, People and Messages say why in the one rule Today uses
  (`TodayDown.words`, the desktop's lifeosDown.ts), the computer named ("Not signed in to LifeOS on the box"). Try
  Again only for silence ("LifeOS did not answer the box", "The box did not answer"); a sign-in missing, refused
  or waiting offers "Open on <computer>" (Settings → Connections there) where this key may, else says "Sign in from
  a computer that manages the box"; a LifeOS still connecting is a spinner ("LifeOS is still connecting on the
  box").

- **Waiting on** is one bar item, the hourglass, filled while it shows: the place swaps to LifeKitUI's Waiting on
  list and back, with no motion, and a fold keeps which one shows. Its rows' Nudge opens the thread that drafts
  the follow-up; Dismiss has the shared undo capsule. Nudge shows only for a key that may start the thread.
- **Ask** sits in an open mail's bar (in More on the cover), only for a key that may make a mail chat. It opens
  the chat about that mail, else a sheet titled Ask with the mail as its chip and the field "Ask about this
  mail"; Ask stays off until he writes. The chat opens on its own page.
- **A mail he timed** in Mail: its Outbox item's bar holds Cancel Send at the leading edge, then Reschedule (a
  menu of the Send later times and Pick a Time…) and Send Now, the one prominent press. Only Send Now asks the
  owner's check and waits its five seconds; the state line keeps "Scheduled for …" with its clock glyph.
- **A mail's file** waits in the reader's own loading shape, its bar filling once LifeOS's store says the size,
  over "Coming from LifeOS"; a refusal is the host's words with Try Again. More adds Save to Workspace before
  Close; the capsule names the copy it made ("Saved to the workspace as Budget (1).xlsx").
- **Agenda** draws the host's leave time in the time column and each clash as a line under the place, in the
  desktop's words ("Overlaps Budget review, 2:30 PM", "23 min short after Staff meeting (Purdue)").

### Review

Review is a place of the Work tab, in the Work list's foot before the Digest: the week across every job, the
desktop's weekly review on the phone (docs/agents/work-review.md "The phone"). One list on `WorkPlaceScreen`
(Work/Review/ReviewScreen.swift); a row's thing opens in the detail.

- **The bar** holds the week as its one menu, named "This Week", "Last Week" or "Week of Nov 10": the two
  newest, then the weeks the hosts kept, then Previous Week and Next Week. The title stays Review.
- **The head** is one muted line of when it was made ("Made Friday at 4:00 PM"), a host that is off ("The Mac is
  off. …"), a list read in part, then the red lines (a host that did not answer, a source that feeds more than one
  section), the first with Try Again as the failed-read row in its red (`FailedRead`), as the desktop's head.
- **Hours**: one row a job, every job listed (the empty one is the news), its sector dot on the name's first line
  (`FirstLineMark`, as every Review row's, the separator at the name), the name, the total trailing ("about 11 h", "6 hr 30 min"; else "Nothing seen" muted; under the name at accessibility
  sizes), then under it the facts ("6 hr 30 min on the calendar, about 4 hr 30 min at the desk"; a row with one
  source says its figure once, "about 15 min at the desk", with no total beside it), "Threads ran 2 hr", the week before where
  it says something, and Money's line ("Money $2,400.00 in, $312.50 out"). The footer says once that calendar
  time is measured and desk time an estimate.
- **Shipped**: each job's rows (dot, the thing's own title, what it was: "Sent to Dana Lee"), five a job, then "3
  more". A row opens its task, mail or held item.
- **Slipped**: each job's open rows (dot, title, the detail the desktop says), tasks due before the week behind "12
  older", rows a kept week saw dealt with since behind their own fold, muted and with no presses. The three
  presses are the desktop's, named for the kind (Done, Nudge, Open, Follow up; Next week; Drop, Stop waiting,
  Discard, None needed): the leading swipe is the first, the trailing swipe the other two, all three in the
  context menu and as accessibility actions; never a full swipe. A row whose source did not answer stands as
  last known with no presses. A press makes the row leave on `Motion.rowLeave` with a light impact and the
  shared undo capsule; a nudge opens the thread that drafts it. None sends to anyone, so none asks the owner's
  check.
- **States**: the first read draws the rows' shape redacted; a first read that failed with no week to draw is the
  frame's failed-read row with Try Again, never "No Week Yet" (`ReviewDesk.firstFailure`); "Nothing slipped" only
  where every source answered, else "Not counted". Opening a week tells its hosts he has seen it, so Today's row and the digest's line go.

### Money

Money is a job's own page, a row on the job's page after Projects; it is never a place for every job. It opens
from that row, Today's Owed rows and a waiting receipt's tell (Work/Money/MoneyScreen.swift).

- **The bar** holds the span as one menu (Month or Year, Previous, Next); the span names the figures' section
  ("November 2026").
- **To Confirm** leads while anything waits: the receipt glyph, who it is from (else the file's name), its day,
  its amount; "Reading" with a spinner while the host reads it, with no press. A press opens the accept sheet
  (`tcSheet(.editor)`): the picture, then Amount, Date, In or Out, Who, For and Category as read, his to change;
  Accept stays off until an amount and a day are there. Discard is the trailing swipe and the context menu, with
  Undo in the capsule.
- **Owed to You** and **You Owe**: who (or what a cost to be paid back was for), the rest and how long it has been
  open under it, the amount trailing. Paid is the leading swipe, the context menu and an accessibility action; a
  row with money both ways has none (it is settled in the sheet on the desktop).
- **The span**: while a newly picked span is read, its section draws its bones, never the old span's sums under
  the new name. In, Out and Net as three figures in one row (stacked at accessibility sizes), then the eight newest entries (who, the day and
  category under it, "Unpaid", "Requested" or "To reimburse" after them while it is open, the amount trailing, money in
  in the success ink only once paid), then "4 more in the ledger".
- **States**: the span's state comes first (`MoneyPage.pageState`). A fault of the books is one red line at the top
  in the desktop's words; a job that never had money is one empty state, said only of a span that was read ("Can’t
  Read Money" for a first read, or a newly picked span, that failed); a read that failed keeps what showed with
  Try Again (`PillButton`). A host's error is said in Work's words (`WorkErrorWords.readFailure`), never its raw text. A receipt's picture that does not come drops its slot; the fields stand alone.

### A job's small places

A job's page holds the small places below the views (M5b): Plays and Routines after Files, then Forms. Each is one
plain list of house rows (the name at the title step, one meta line, one trailing stamp), its first read a spinner,
empty its `ContentUnavailableView`, a failed read with Try Again; pull reads again. Its presses are the system's
swipes, context menu and accessibility actions; a press answers with a light impact and one toast line. None is a
card. Connections and Computers sit in the Work list's foot.

- **Plays**: the name, then "Takes a line of text and a date" in meta. A play the phone can run opens the run sheet
  (`tcSheet(.form)`): the instructions muted at six lines, the Text field ("Paste or type what it works from") and the
  Date it takes, Cancel and Run in the bar, Run off until each is there; Run opens the thread it started. A play about
  a mail, a task, an event or a file opens nothing here.
- **Routines**: a tap unfolds the last five runs under the routine (the system's disclosure): a check, a spinner
  while it works, the destructive dot and the cause in its ink when it failed; the outcome and when it fired. A run
  that started a thread opens it; runs that did not load are the failed-read row with Try Again, which reads that
  routine's runs again, above the runs it last read. Run Now is the leading swipe and the context menu; Pause and Resume stay trailing.
- **Forms**: TempCode's forms, then Microsoft's, each section headed only when both are there ("TempCode",
  "Microsoft"). The stamp is how it stands ("Open", "Closed, 3 responses", "3 responses, 2 new"). Close is the
  trailing swipe on a form that takes answers; Reopen on a closed one, only for a key that may, after the owner's
  check. A Microsoft form that collected opens its **answers** in the detail: each answer under its question (meta
  over body), the stamp as the header, "Read at 2:10 PM" in the footer, Open in Forms and Close or Reopen in the
  bar's menu. A refresh that fails keeps the last read, none answered too, with the failed-read row above it.
- **Files' New** adds "From a Template" under the kinds where the place makes files: a row a template with its kind's
  glyph; it pushes its fields, one field a row, and Make writes it into the folder; the toast says what is left to
  fill.
- **A dashboard** reads every figure again on a pull; a pull that fails keeps the figures under the red failed-read row
  (`FailedRead`, its Try Again) until a read lands, with their time but not the host's older failure; a block whose sheet the phone has opens it on a tap (a LifeOS
  sheet in the hosted editor, a form's answers), with the press's scale and no other mark.
- **Connections**: a section a group, in the desktop's order, "Ending Soon" first when an end is within two weeks;
  the first group draws no band when its one row says the group's name ("LifeOS" over "LifeOS", `Section.headed`); a
  row's title, the host's line under it whole (its last words are often the fix), its word trailing ("Ready" muted, "Needs you" in the warning ink,
  "Broken" in the destructive ink, both semibold). A row that does not work offers "Open on <computer>" in its swipe
  and context menu. A Work host whose checks did not come back is named in the one line over the rows, never "Nothing
  to Check" (`Connections.missedLine`): not connected, did not answer (its kept rows "Showing what it said at 2:10
  PM."), or did not say what ends soon; the list reads again when a host's link opens or drops, a recent check
  standing only while the linked hosts are the ones it asked (`Connections.reuses`). That line wraps whole, with
  Try Again under it at accessibility sizes, as every Work place's failed read (`FailedRead`).
- **Computers** leads with the Windows VM where a host keeps it: "Windows VM", how it stands ("Asleep", the step while
  it wakes), its last fault in the destructive ink, and one bordered capsule, Wake or Sleep, a spinner while it moves.
  The live picture's foot has Copy beside Paste while he drives. Under live tiles, a Work computer away is named in one
  quiet footer ("Not connected to Mac.", `ComputersState.away`), so the list never reads as every computer's.
- **Settings → Work** lists each computer's jobs (sector dot, name); one pushes its settings as plain values (Model,
  Effort, Learn how I write from my sent mail, Windows VM, Computers its threads may use) and "Open on <computer>".

## A file on the phone

One open file gets one page (`Work/Reader/FileReaderPage.swift`,
docs/agents/work-phone-files.md), and the same kind's view sits in a Work
thread's Item segment. The file gets the room; the controls sit where iOS
puts them.

- **The bar** is the system's, inline: the file's own name, centred however
  many presses sit at its trailing end, cut in the middle so a long one keeps
  its extension (without `.tcdoc` or `.tcsheet`, our own two formats; a file
  is named by its path, so the page, Files and the thread's item agree).
  Trailing: Ask (the
  `bubble.left` item, for a key that may act), then More.
  No second header, no chip beside the name.
- **More** lists, in this order and only where each can act: Find… (a PDF, a
  deck: the system's find bar), Comments, Review Changes (only while
  something waits), Page Preview (a document) or Print… (a PDF, a deck: they
  already show the pages that print, so Print opens the system's print sheet
  and there is no second look at the same pages), Share… (a document or a
  sheet, LifeOS's or a `.tcdoc` or `.tcsheet` file), then Close under a
  divider. The hosted editor adds Undo and Redo at the top and its own
  Find…; a deck whose show runs on one of his computers adds Clicker first. While Print reads its pages a spinner stands in
  More's place. The thread's Item segment shows the same rows in its own
  More. A key that may only read has no Ask and no Close.
- **The review row** sits under the bar only while an agent's changes wait:
  44 pt, the deck's own row. Over a document or a sheet it is "3 changes"
  with a chevron, which opens Review Changes, and nothing else: the page draws
  none of the changes, so he decides them only where he can read them. A
  deck's row, under a slide that shows the change, keeps Reject, and Accept
  as the one tinted button. A key that may not act reads the count and has no
  buttons. The count is in the label ink, medium: it is a press.
- **The body** runs edge to edge: the hosted editor at full width, PDF
  pages, a deck one slide to a page, a picture, a video on its black matte.
  In a wide column a paper kind keeps the 640 pt reading measure, centred;
  the hosted editor keeps the whole width.
- **A deck**: the slide at the column's width in its own shape, the glass
  page stamp ("4 of 12") at the slide's foot, the slide's speaker notes under
  it (the meta step in the label colour, the 640 pt measure, scrolling on
  their own, starting at the slide's own left edge where a wide column
  leaves the slide narrower than itself; "No notes" in the secondary ink for
  a slide without any, in every deck whose host sends notes), then
  the filmstrip: every slide as a 48 pt high thumbnail in one scrolling row,
  the slide that shows ringed in the accent and kept in view, a slide hidden
  in a show marked with `eye.slash` at its lower corner; a short deck in a wide
  column sits centred under the slide. The slide never takes more than 62% of the height while
  notes show; where fewer than two lines of notes would fit (a phone on its
  side) the notes give way and the slide takes the room.
- **A tap** on a slide, a PDF page or a picture hides the navigation bar and
  the foot (stamp, notes, filmstrip); a tap brings them back. The bar and
  the foot fade together on `Motion.base`; the page keeps the bar's room
  above it and does not move. The hidden foot takes no touch and VoiceOver
  passes it. A file of one page has no stamp. A double tap still zooms, a tap on a link still follows it. The
  status bar stays.
- **Loading** is the paper's shape at once (a letter page, or a slide) with a
  120 pt determinate bar that follows the bytes read. Once the file's first
  page or slide is here it fills that shape, and the bar moves to the
  paper's foot, 12 pt in. A file opened again in
  the same run paints from memory at once. A failure is the system's
  unavailable view with the host's reason and Try Again.
- **The place he stopped** (the page, the slide) is kept per file and
  restored on open and through a fold.
- **A file the hosted editor cannot open** shows "Can’t Open Here" under the
  `desktopcomputer` glyph and its host's words under that (they say where it
  opens), with no Try Again: there is nothing to try. The bar already names
  the file. Opened from Files, Quick Look stands there instead.

**Ask** is one sheet wherever the file was opened: the file's chip, the
words picked under it, a field, Cancel and Send. From a thread the words go to
that thread. From Files they go to the thread that already holds the file, or
to a new one in the workspace with the file as its item; either way he lands
in the thread on its Chat, where his words are, with the file one swipe back.
Nothing is made until he sends.
Where the file will not open in the new thread the sheet stays with his words
and the host's reason, and Send again finishes the same thread.

**Comment** (the hosted editor's edit menu over a selection: Ask, then
Comment, for a document): a field sheet. The quote in quotation marks, up to
four lines, in the meta step; a field; Cancel and Post. The field is locked
while the post is on its way. A post the host refuses keeps his words and says
why under the field.

**Comments** (a document sheet): open threads first, then the resolved ones
under a "Resolved" section header. A thread is the words it was left on in
quotation marks (meta, three lines), then each comment: who (title step,
semibold) and when (`AgoText`) on one line, the words under it; replies are
set in by the 16 pt indent and nothing else. The bottom bar holds one field
("Add a comment", starting at the text edge with the quote and the comments;
a tap on a thread turns it to "Reply" with a "Replying to …" line and its
close) and the 28 pt send mark in a 44 pt target. Words in
the field keep their target: a tap on another thread, or the thread
resolving, moves only an empty field; his press on the close turns a reply
into a new comment. The field is locked while a post is on its way. Swipe:
Resolve, or Reopen. Empty: one quiet line, "No comments". A failed read is the
system's unavailable view with the host's words and Try Again; over threads
it kept, the failed-read row above them. A key that
cannot act reads the threads and has no field.

**Review Changes** (a document sheet titled with the count, "3 Changes"): one
row a change. A document's row is the block's old words struck through in
`Tint.destructiveText` and its new ones underlined in `Tint.successText`
(`ChangeText`, which the history compare draws with too); a sheet's row leads
with the cell ("C4", meta semibold, tabular; "'Q3 Plan'!C4" where the changes
reach two tabs) over the same two lines; a
format or a rule an agent proposed on a sheet is its words alone, drawn as a
document's added words ("Bold, yellow fill on B2:B9"). The
agent's reason heads the cells it changed together, once, as a group header;
the host's own "Suggestions" label is no reason and heads nothing. Swipe
trailing: Accept, a full swipe too; leading: Reject, never by a full swipe, as
a rejected change has no undo. The bottom bar holds Reject All (glass) and
Accept All (the prominent glass button), which decide the rows on screen when
he pressed and no other. One decision runs at a time: while it does, the
swipes and the bar are off and a spinner sits in the bar. The first row has no
hairline under the bar. A decided row leaves on the row transition with a
light impact, and the last one closes the sheet. A row the host refuses stays,
with the host's words under it in the destructive text ink. A sheet's cell
the host found changed since the agent saw it says so the same way from the
first read and has no Accept swipe; with only such rows left, Accept All is
off. A failed read is the system's unavailable view with the host's words and
Try Again; over rows on screen (a reread on a revision push) it is one line
above them, the host's words with Try Again, until a read lands.

**Highlights, notes and fields** (a PDF): his highlights are a neutral wash of
the paper's ink over each line, with the system's note glyph at the first
line's end when he left a note. Highlight heads the selection's menu. A tap
on a highlight opens a field sheet titled "Highlight": the words in quotation
marks (meta, four lines), "Add a note", Cancel and Save, and Remove Highlight
as the destructive row under them. A form's values sit in the file's own
fields, drawn read only; an agent's value that waits wears the added tint on
paper. A tap on a field opens a field sheet titled with its label: the field
(a text field, a switch for a checkbox, a picker for a choice), where the value
came from in the footer ("From Purdue profile: “Landon Hale”"), Cancel and
Save, and while an agent's value waits Reject and Accept in the bottom bar,
Accept the prominent one. A signature and its date say "Sign this on your
computer." While values wait the review row over the pages reads "3 values to
check" with Reject and Accept: the values are on the page.

**A meeting**: the recording's player first (audio: Play in a 44 pt target,
the system's slider, "1:23 / 45:10" in the stamp step, tabular; a video: the
system's player in its shape), a hairline, then one plain list: "Tasks" (those
that wait, an empty circle, then those added, a filled check in the success
tint; each its words with "Due …" under it in meta and its moment at the
trailing end, a press that plays from there), then "Transcript" (who in meta
semibold, when in the stamp step, the words under them; a tap plays from that
line). A task swipes Add (trailing, a full swipe too) and Drop (leading,
never full). The bottom bar's one prominent press is "Add 3 Tasks" while any
wait. A recording the phone cannot play says "This recording plays on your
computer." in its row.

**Restore** (a version's compare): Restore is the bar's one trailing press on
every version but the newest. On his own document the undo capsule says
"Restored" with Undo, and the compare reads again from its spinner, "No Changes", or
why not with Try Again, never the changes from before; on one others can
open it says "Waiting in Review Changes" and has no Undo, since nothing was
written.

**Two pages and the table** (the Duo): a document with comments, a deck with
notes, a video and a meeting's video take two pages on the open Duo upright,
split at the fold's band (each page at least 320 pt): the thing on the
leading page, its comments, notes or transcript on the trailing. The comments'
page has "Comments" as its header row (the title step, semibold) and the reply
field under it; the deck's notes keep the meta step. On a table the thing
stands above the band and the rest lies below it. Nothing sits within the
band; a fold keeps the page he is on, and the hosted document is never loaded
again.

**Page Preview** (a push titled "Page Preview", a document's): the document
as it will print, its Word file drawn on the host, in the system's viewer,
continuous, with the page stamp at its foot and Print (`printer`) as the one
bar item, which opens the system's print sheet over the pages shown. Loading
is the paper's shape with its bar and, once the host has said how many,
"Drawing 5 pages". A PDF and a deck have no Page Preview: More's Print… prints
a PDF as itself and a deck as its file's own render.

The Duo: the page lays out by its container's size class. Its route, its
page, an open sheet and typed words hold through a fold. Folded on its side
the deck shows no notes (the rule above).

Held in dark, and listed for the owner: the glass page stamp over white paper
reads at about 2:1 in the dark appearance (it did before this page). One line
flips it: the stamp taking the light scheme where it sits on paper.

## The clicker

A slideshow running on one of his computers, stepped from the phone
(`Work/Clicker/ClickerScreen.swift`, docs/agents/work-phone-files.md "The
clicker"). The phone is a remote in his hand: the slide stays on the big
screen, and the phone carries the notes and the two presses.

- **The bar** is the system's, inline: the deck's name. Trailing: More, with
  Larger Text and Smaller Text (the notes from 14 to 28 pt, kept across
  launches), Blank or Unblank, then End Show… under a divider, in red,
  which asks first ("End the show?", "The slideshow closes for everyone
  watching it.", End Show in red).
- **Upright**, top to bottom: the slide's speaker notes in the document type
  at the size he chose, the 640 pt measure, scrolling on their own and back at
  the top on each slide, stopping 8 pt above the count line, its last line
  fading out over one line's height where the notes run on (the fade follows
  the text size), with no text selection (a drag there steps the show); "No notes" in the meta step for a
  slide without any; the count line, "4 / 12" in the title step, semibold,
  and the time since the show began at its trailing end, both in tabular
  digits, with "Blank" beside the count while the screen shows black; Previous
  as a 64 pt band across the width; Next as the lower half of the screen, one
  surface with a chevron over the word. Both are the fill step with the label
  colour and the field radius: no gradient, no glow, no tint.
- **The notes** are only ever the slide's the count shows. A press moves the
  count at once; where the show carries every slide's notes the new slide's
  come with it, and otherwise the notes' place is empty until the host says
  them.
- **On its side, and on the Duo unfolded**, the notes take the leading pane
  and the controls the trailing one, half and half, or split on the fold's
  division band where it leaves each pane 240 pt (`ClickerPanes`).
- **A press** sends when his finger lifts, with the press's scale (0.96,
  160 ms) and a light impact, and the count moves under his finger; the
  screen never waits for the host. The presses go to the host in the order he
  made them, each once the one before it is answered. Swipes left and right
  step too. Next on the last slide and Previous on the first do nothing and
  give the rigid tick. A slide change rolls the count's digits and nothing
  else: he presses Next dozens of times in a talk. The timer's digits change
  in place each second and never roll.
- **Another device** stepping the show moves the count here too; a press
  the host refuses drops the presses made after it, puts the count back and
  says the host's words in one line in the destructive text ink above it,
  until a press lands.
- **The show ended** (stopped, or moved to another machine) is the system's
  unavailable view, "The Show Ended", with Done.
- The screen stays awake while it shows.
- Every press is a 44 pt target or more, Next and Previous read "Next
  slide" and "Previous slide" to VoiceOver, and the screen holds at the
  accessibility text sizes in both appearances.

- **The way in**: a "Showing on <computer>" row at the Work list's foot
  while a show runs on one of his computers (the `av.remote` glyph, the deck's
  name and "4 of 12" under it in the meta step), and Clicker at the head of a
  showing deck's More. Either opens the clicker as a full-screen cover on the
  host's show (`work.slides.show.state`, `press`, the `work.slides.show`
  push).

### Share

One sheet, the desktop's (`ShareLinkSheet`), from Share… in a document's or
sheet's More: a form sheet titled Share. On top: For, Can (segmented, only
where the item has more than one role) and Ends (a day, a week, thirty days,
ninety, named by their dates); Create in the bar. Under the form, Purdue's
line for a Purdue workspace's file, or the host's refusal in the destructive
text ink. Create shows the address once in its own section with Copy and
Share, and New Link in the bar's leading place. Under it, Links: each live
link's name, then one meta line ("Edit · made Nov 20 · opened Nov 22, 3:10
PM · until Dec 20"), and a 44 pt More with Replace Address… (asked first:
the current address stops opening), the role, and Revoke in red. Where no
link can be made, the host's one line stands in the form's place with Done.
Create waits until the host that keeps the item's links has answered. From
his Create or Replace Address to the host's answer the sheet stays open:
Cancel, Done and New Link are dimmed and the swipe does nothing, as Save to
TempCode's Cancel goes once Save is pressed, because the address shows once
and only here. One press on the sheet at a time: while one is out, Create
and every link's More wait. An address the host sent that no screen showed
(an answer after the fifteen seconds, a New Address left by Back) is kept in
memory by its attempt key, with the link's name and the item's title, and
shows named ("Dana Lee’s link to Budget. This address shows once.") at
once if Share is open on it, else the next time Share or Settings → Work
opens on it. A
press whose answer was lost says "Checking whether the link was made" under
the form, which waits; closing and opening the sheet again keeps the same
press, so no second link is made. A link the read-back finds made shows its
line ("The link was made. Its address showed once: Replace Address makes a
new one.") with New Link in the bar.

## Save to TempCode

The share extension's one sheet (`Work/Share/ShareSheetView.swift`,
docs/agents/work-phone-files.md "Save to TempCode"): a file or a photo from
any app into a Work workspace's own folder.

- **The bar**: "Save to TempCode", Cancel, and Save (semibold) as the one
  confirm. Once Save is pressed Cancel goes: the files are in the queue, and
  Done alone closes.
- **What is being saved** is the first group. One file: its picture or the
  glyph of what it is in a 44 pt mark with the row corner, its name as a
  field he may change, its size under it in the meta step. Several: "3
  photos" and their pictures in a row. A file that could not be read is said
  in the group's footer ("Could not read Photo.heic.", "Could not read 2 of 3
  files."); Save takes the rest.
- **Job**: his Work workspaces as rows, under the header "Job" as in
  Capture, each led by its sector's 8 pt
  dot, the name in the label ink, the last used checked with the tinted
  checkmark and first in the list; never used, the job open in the app is
  checked; with neither, none is, and Save waits for his pick (never the
  first in the list). With several hosts a row carries its
  host's name as a meta line. The list is what the app last wrote for the
  extension, so the sheet is whole in its first frame. The rows dim with
  the rest of the list while it saves.
- **Folder**: one row, the folder glyph in the secondary ink and the
  folder's name (the workspace's own at first, then the last one used
  there). It pushes a list of folders only, read from the host as he goes; a
  level on its way is one row with a spinner and "Reading <folder>"; a level
  that could not be read is the failed-read row, whose Try Again reads it
  again in place; Choose takes the folder shown.
- **Saving**: Save's place holds a 56 pt determinate bar that follows the
  bytes of every file together, each file weighed by its size; when the host has them the bar gives way to
  the tinted checkmark, with the success haptic, and the sheet closes itself.
- **The host cannot be reached**: one line under the workspaces, "<host>
  can’t be reached. TempCode will save this when it can.", and Save reads
  Done. **Refused** (too large: "<host> takes files up to 200 MB."; a folder
  gone: "Receipts is not there any more."): the words in the destructive text
  ink under the first group, and Done.
- **Not saved**: a file an earlier save left refused leads the sheet in a
  group of its own: its name, the words in the destructive text ink, Try
  Again (a spinner while it goes), and a swipe to Discard. Where no retry can
  help (too large, the file gone or changed on the phone, its host no longer
  on the phone: "That computer is no longer on this phone.") Discard stands
  in Try Again's place.
- **Nothing read**: the system's unavailable view, "Nothing to Save" with
  what could not be read, and Done alone.
- **No job**: the system's unavailable view, "No Jobs" and "Turn Work on in
  Docket and add a job.", with Cancel alone.
- It raises no notification, badge or sound.

## Visual system

Everything maps to the desktop's `DESIGN.md`: quiet chrome, one gray step,
hairlines, small dense type, color only for meaning. The kit that carries it
is `ios/TempCode/Sources/Design/` (the views) and the client package's
`Sources/TempCodeClient/Design/` (the pure logic: `TimeFormat`, `ModelName`,
`CompactNumber`, `ThreadRowModel`, unit-tested there with Swift Testing);
every screen names its helpers and never a raw color, radius, font step,
inset or duration. A sibling that needs a shared piece the kit lacks builds
it in its own area on these names.

| Token | Value | Use | Helper |
| --- | --- | --- | --- |
| Background | `systemBackground` | content | `Surface.background` |
| Chrome step | `secondarySystemBackground` | section headers, fields, the composer bar | `Surface.chrome` |
| Raised | `tertiarySystemBackground`; in light mode two soft shadows with an offset (black 6 % r 1 y 1, black 8 % r 12 y 4), in dark the ring only | sheets and cards that float | `Surface.raised`, `.raised(radius:)` |
| Fill | `tertiarySystemFill` | what a chip or pill sits on | `Surface.fill` |
| Hairline | `separator` at 1 px, inset to the text edge; vertical between two panes | rows, fields, chips, the two-pane seam | `Hairline(inset:)`, `Hairline(axis: .vertical)`, `.hairlineBorder(shape)`, `.separatorAtTextEdge()` |
| Text | `label`, `secondaryLabel`, `tertiaryLabel` | three steps and no more; a tint replaces the color alone | `.textStep(.title / .meta / .stamp, weight:, tint:)` |
| Info | `systemBlue` | chat type, starting and watching dots | `Tint.info` |
| Success | `systemGreen` | implementation type, `+n`, completed, a host link that is open (50 % until re-listed) | `Tint.success` |
| Warning | `systemOrange` | orchestration type, waiting, paused, needs-you tint at 8 %, a host link connecting or reconnecting | `Tint.warning`, `Surface.needsYou` |
| Destructive | `systemRed` | errors, `−m`, failed tools, a failure summary, a refused host key | `Tint.destructive` |
| Violet | `systemPurple` | planning and project-plan types | `Tint.violet` |
| Cyan | `systemCyan` | research type | `Tint.cyan` |
| Quiet | `systemGray2` | a state with no urgency: the queued dot, the stopped square | `Tint.quiet` |
| Radius | the ladder: four chosen steps, 4 pt an inline token, 8 pt chips and rows, 12 pt fields and cards, 16 pt sheets; derived: 10 pt a transcript block (row + 2), 6 pt a wash or icon box inside one (block − 4), a quarter of the side for an icon tile, half the one-line height for the chat bar; a real `Capsule` for anything round at both ends; on iOS 26 the full-width buttons at a sheet's foot are concentric with the sheet (`ConcentricRectangle`, never tighter than 12 pt) | outer = inner + padding, always; no literal radius outside Tokens.swift | `Radius.inline / .row / .field / .sheet / .block / .inner / .mark`, `Radius.tile(side)`, `Radius.capsuleEnds(height)`, `Radius.around(inner, padding:)`, `Radius.inside(outer, padding:)`, `.rowCorner / .fieldCorner / .sheetCorner / .blockCorner / .inlineCorner` (continuous), `.concentric(minimum:)` |
| Type | lists: `subheadline` rows, `footnote` meta, `caption2` timestamps. The transcript: the desktop's ladder on iOS text styles, prose 15 on 22 (`subheadline`), lines 13 on 20 (`footnote`: actions, the working and closing line, notices, a group's line and cells), details 12 on 16 (`caption`: the steer word, the slot, the composer's row, a card's lines), code 14 on 20 and a command or diff 12 on 20 in mono, headings 17/24 semibold −0.01em, 16/22 and 15/22 semibold, a document (report, notes; the plan page keeps its own ladder, "Planning") 16 on 24 (`callout`) with headings 20/26, 17/24 and 16/24 medium; each size scales relative to its style and its line box keeps its ratio, so a row height is a minimum and never a clip | Dynamic Type honored up to accessibility sizes; no view writes a font size (scripts/ios-literal-guard.test.ts counts what is left, and the count only shrinks) | `TextStep.title` (subheadline, label), `.meta` (footnote, secondary), `.stamp` (caption2, tertiary, tabular); `.transcriptType(TranscriptType.prose / .line / .detail / .code / .rowCode / .proseH1–3 / .document / .documentH1–3, weight:)`, `.transcriptFont(_:)` for a glyph beside the text; the numbers are the client package's `TranscriptScale` |
| Transcript lengths | a lone row 28 pt, a table row 32; the glyph slot 14, 8 to the words, 4 between words, 8 after a value, a table's words 12 in; radii 12 a table, 8 a body, 12 a bubble; gaps 16 first, 32 between turns, 16 bubble to reply, 12 between blocks, 4 between lines, 8 to the closing line, 16 under the last; a bubble at most 85 % of the column, 12 × 8 in; the column 768, a document 640; the slot 28, the composer's row 24, its controls 28 (44 hit), the empty box 46 | the desktop's numbers; a full-width row is its own hit area | `TranscriptMetrics` (`Gap.*`), over the client package's `TranscriptLengths` |
| Numbers | `monospacedDigit()` on every elapsed, count and cost | nothing jitters as it ticks | `.numeric(value)`, `CountText`, `ElapsedText`, `AgoText` |
| Lengths | 16 pt text edge, 44 pt rows with 6 pt vertical padding, 10 pt gaps, 14 pt mark, 7 pt dot, 20 pt glyph, 16 pt subagent indent, 6 pt before a title's tag | rows, headers and separators meet on the same edges | `Layout.textEdge / .rowHeight / .rowVertical / .rowGap / .markWidth / .dotSize / .glyphWidth / .indent / .tagGap / .rowTextEdge / .rowInsets` |

Thread type glyphs are the desktop's, in SF Symbols: chat `bubble.left`,
planning `map`, project plan `flag.checkered` (violet, like planning),
implementation `checklist`, orchestration `arrow.triangle.branch`, research
`binoculars`. Agent glyphs: orchestrator
`person.2`, implementer `wrench`, reviewer `checklist`, explorer
`magnifyingglass`. Icon stroke follows the text weight next to it (the
symbol weight is the stroke: `TypeGlyph(type:weight:)`, `AgentGlyph(type:weight:)`,
`MetaGlyph(_:weight:)`, `HostMark(host:weight:)` draws 1.5 beside regular and 2
beside semibold); outline default, fill marks the active state
(`TypeGlyph(active: true)` cross-fades to `ThreadType.filledSymbol`).

The status mark (`StatusDot(status:running:weight:)`) leads every row in a
14 pt column that scales with the title; the marks cross-fade and the column
never moves. Each is a static cue VoiceOver reads; an empty column is hidden
from it. The words are the desktop's `STATUS_WORD` (status.tsx), held once in
the client package's `StatusWord` and checked by
scripts/ios-status-parity.test.ts.

| Status | Mark | VoiceOver |
| --- | --- | --- |
| `running`, or a settled root whose subagents still work (`running: true`) | the mini spinner | Working |
| `starting`, `watching` | dot, `Tint.info` | Starting, Watching |
| `waiting` | dot, `Tint.warning` | Needs you |
| `error` | dot, `Tint.destructive` | Failed |
| `paused` | `pause.fill` at the title's weight, `Tint.warning` | Paused |
| `stopped` | a 6 pt continuous square, `Tint.quiet` | Stopped |
| `queued` | dot, `Tint.quiet` | Queued |
| `idle`, `done` | nothing | |

The row: `ThreadRow(row: ThreadRowModel)` is the one list row (44 pt,
`StatusDot`, the glyph at the title's weight, the title semibold while
unseen, `ThreadRowSecondLine`, `ThreadRowTime` trailing);
`.threadRowActions(client:meta:)` adds pin, archive and rename. The model
(`ThreadRowModel(session:unseen:)`, in the package) decides what the row
says: after the title, one muted word (`tag`, "Master" for a pinned master,
never truncated); the second line opens with `model` and then shows, in
order of precedence, the host's `failure.summary` in destructive, the tasks
("3/7 Writing tests"), the last activity (for a queued thread the host's
reason alone, "Waiting for X"), or nothing at the same height. Two slots keep siblings out of
the kit: `ThreadRow(row:) { accessory }` places a view between the second
line and the pin (an account mark: thread 24), and `.threadRowActions(client:
meta:) { menu }` places rows after Pin and before Archive (Start now, Resume:
thread 20). A sibling that composes the model fills `model`, `detail` or
`tag` and never parses them back. Section chrome: `SectionHeader` is the
band on the chrome step for long lists (Home, Search, the archive);
`GroupHeader` sits above an inset card (`.groupCard()`) on screens that are
a few short groups (Settings, sheets, a detail); inside a `List`, use
`.listStyle(.insetGrouped)` with `Section` instead. Small actions:
`PillButton(title, systemImage:, tint:)` in a row (a 28 pt capsule with a
44 pt hit area), `WideButton(title, prominent:)` at the foot of a sheet or
card.

No shadows except on floating layers (`.raised()` adds two in light mode,
both with an offset). No glows. No badges with text; dots only, and only when
they mean something. Nothing is shown twice.

The Live Activity compiles the same `Tokens.swift` and links
`TempCodeClient` for its transcript type and length values.

### Liquid Glass

The functional layer that floats over content is Liquid Glass on iOS 26 and
the thin material with a hairline before it, behind one availability check
in `Design/Glass.swift`; no screen writes `#available(iOS 26.0, *)` itself.
What is glass: the tab bar (the system `TabView`, glass on its own), the
navigation bar and its buttons (the system's on iOS 26: `.tcNavigationBar()`
stops forcing the opaque background there and keeps it before), the
composer's box (one shape at radius 12 in one `TCGlassContainer`, its button
a circle of tinted glass inside it, the one exception to glass on glass the
desktop's box asks for), the slot's buttons
(`.tcGlassButton(prominent:)`, the system's `.glass` and `.glassProminent`),
the segment switcher's track, the Jump to latest pill, a master board's
batch menu circle and the fleet switches' outcome card. Never glass on glass
(a selection or a filled button inside glass is a solid surface), never
glass on a row or a card inside the content. The helpers: `.tcGlass(in:
tint: interactive:)`, `.tcGlassButton(prominent:)`, `TCGlassContainer`,
`.tcGlassID(_:in:)`, `.tcBottomBar { }`, `.tcNavigationBar(visible:)`,
`GlassMetrics.moreSymbol`. The system glass follows Reduce Transparency and
Increase Contrast; the fallback goes opaque on the chrome step under Reduce
Transparency and draws its ring in the label color at half strength under
Increase Contrast.

### Text hierarchy, not dotted joins

Facts are never joined with " · ". A line that says two things draws two
texts told apart by their own weight and color (the title step, then
secondary, then tertiary), a glyph before a value (`MetaGlyph`), a labelled
value, a second line, or plain prose (a comma, "and", parentheses). The
client package's word builders return parts for this (`StripWords`,
`GateText.tail`, `BatchToast.headline` and `failureLine`, `DeviceState`'s
`status` and `platform`), and a view never splits a string on a dot. Where a
status mark already says the state (a queued dot, a stopped square), the
text says only the reason; where it does not (a watching row's dot), the
word leads in medium weight and its tone and the detail follows in regular
weight and a quieter colour ("Watching" "3 subagents", "Waiting for
approval" "Bash"). The detail is the host's `SessionMeta.statusDetail`,
taken as written (trimmed, a trailing full stop dropped, its case kept);
only for an older host that sends none is the legacy `activity` line read
past its lead ("Queued  waiting for memory", "Waiting on 3 subagents",
"Blocked: A errored" → "Blocked, A errored") and sentence-cased: the client
package's `StatusDetail.of`, which every row, strip and board reads. Where
one plain string is unavoidable (an accessibility label, a line built on
the phone) it is `StatusDetail.plain`: "Queued: Waiting for memory", or the
word alone. The Live Activity and the push paths keep reading the legacy
line on purpose. The one dotted form left is the milestone thread
title "M2 · Billing export", the desktop's `milestoneThreadTitle`, which the
host stores and every host shows; the phone's milestone list draws "M2" as a
quiet stamp beside the title instead. Empty screens use the system's
`ContentUnavailableView` with the symbol Apple would use (`tray` for the
Inbox, the search view for no results, `checklist` for a board with no
tasks, `bubble.left.and.bubble.right` for a thread with no messages).

## Motion

Values are the desktop's, exactly, held once in the client package's
`MotionValues` (Sources/TempCodeClient/Design/MotionValues.swift): the
durations of index.css (`swapOut` 0.09, `fast` 0.12, `base` 0.18, `slow`
0.24, `drawer` 0.30, `layout` 0.37), the curves and springs of lib/ease.ts
(ease-out `(0.16, 1, 0.3, 1)`, swap `(0.2, 0, 0, 1)`, drawer `(0.32, 0.72,
0, 1)`, exit, in-out, breathe; the layout spring 360/32/0.6 settling in
0.37 s, the glide 700/50/0.5), the stream's step 0.1 and fade 0.4, the word
hold 0.3, the fold hold 0.6, the Copy check 1.2 and the stale watch 30
minutes, and the loops (the shimmer's 3 s band, the working mark's 1.6 s
dots, the spinner's 0.9 s turn). scripts/ios-motion-parity.test.ts reads the
file and fails when one differs from the desktop's sources. The phone's own
are the touch press (scale 0.96 over 0.16 s, a dim to 60 % under reduced
motion) and the glyph swap's 0.3 s spring. `Motion` (Design/Motion.swift)
turns them into animations and each row below has a name there, so a screen
references the name, never the number: `Motion.fast`, `.base`, `.layout`,
`.glide`, `.swapOut`, `.swapIn`, `.rise`, and the older names on them
(`crossFade`, `numeric`, `jump` and `rowLeave` are `fast`; `rowAppear`,
`stepIn` and `collapse` are `base`; `expand` is `layout`; `drawer` is the
drawer curve over 0.30 s). SwiftUI's `.easeOut` is never used, and
scripts/ios-literal-guard.test.ts counts every literal duration or curve
left in a view.

| Interaction | Motion | Name |
| --- | --- | --- |
| Press on any row or button | scale `0.96`, 160 ms, ease-out, from pointer-down; no hover states on touch, the system's highlight under a pointer (`.hoverEffect(.highlight)`); reduced motion dims to 60 % instead | `.buttonStyle(.pressable)` (`Motion.press`, `Motion.pressScale`, `Motion.pressDim`); `.pressableStatic` dims without scaling where a scale would fight a swipe |
| Push and pop | the system navigation transition, untouched | |
| Sheets | the system sheet, 16 pt radius, detents and sizing by `SheetRules` ("iPhone Duo") | `Radius.sheet`, `tcSheet` |
| Segment swipe | interactive, follows the finger, settles with the drawer curve `cubic-bezier(0.32, 0.72, 0, 1)` | `Motion.drawer` |
| Row expand (todo trace, tool body) | the layout spring; content fades in over `fast` after the height starts; collapse `base` ease-out | `Motion.expand`, `Motion.expandContent`, `Motion.collapse` |
| Preamble fold | `fast` cross-fade, no height spring | `Motion.crossFade` |
| Needs-you row appearing | `base` ease-out, opacity and 4 pt translateY; removal `fast`, opacity only | `.rowAppearTransition()` (`Motion.appear(reduced:)`, `Motion.rowAppear`, `Motion.rowLeave`, `Motion.travel`) |
| Last-activity line changing | `fast` cross-fade with 2 pt blur; the row never changes height | `SwapText`, `.swapTransition()` (`Motion.swap(reduced:)`, `Motion.crossFade`, `Motion.crossFadeBlur`) |
| Counts and elapsed | `contentTransition(.numericText())` on `fast` | `.numeric(value)` (`Motion.numeric`), `CountText`, `ElapsedText`, `AgoText`; a clock draws again from `Tick` (a task that sleeps to the next whole period, `TickRule`), never a `TimelineView`; the slot's own clock steps without a roll |
| Streaming text | the desktop's jitter buffer (`SmoothText`, smoothText.ts as of 0b82ddad, in UTF-16 units): the base pace is the arrival rate over the last 1.5 s (a gap counted 1 s at most, a burst at 1,500/s over a step), clamped 25–1,500 units/s, 400 before the first gap; a lead held behind the live end, seeded 250 ms (every host is remote to the phone), never under twice the gaps' 90th percentile (100–800 ms), an underrun growing it 1.5 times or by the wait, its excess decaying on a 6 s time constant; each spurt holds until a lead and a step are in hand; the pace leans up to 1.5 times while more than the lead is buffered, and every character shows within 1.5 s of arriving; the stream's end drains at the same pace, only a rewrite of the shown prefix and a hidden row snap. Whole words every 100 ms (`revealCut`: a token past 24 units cut where the pace reaches, never inside a grapheme; a bare block marker, a table's header row and a row that is only its pipes held until they have content, none of those inside an open fence; inside one a code line shows whole once its newline comes, and one held open `revealLineHold` (0.6 s) steps by words from then on, the clock waking the row once the hold is over), on a timer between steps, no display frames. A row that joins the last turn after the transcript opened is born live and reveals from its first word even when it mounts settled; the opening seq waits for the loaded thread; SwiftUI may prepare a row more than once, so preparation reads its eligibility and appearance consumes it; history and a row scrolled back in show whole. A reply short enough to land whole in its first step stays on the streaming render until that step is drawn and faded (`StreamRowRule`), so it fades like a long one. Each step fades in as one run over `revealFade` (0.4 s, linear; the desktop's `.stream-step`): the streaming block's text is one `Text` interpolated from its runs, the settled prefix as one and each step younger than the fade as its own (at most four; older young steps join the prefix), each young run carrying `StreamFadeAttribute` with its arrival, drawn at its opacity by `StreamFadeRenderer`, a `TextRenderer` under a `TimelineView` on a finite schedule (`FadeSchedule` over `RevealSegment.fadeTicks`, 30 Hz) that ends with the youngest run's fade (`RevealSegment.fadeEnd`), whether or not anything redraws the row after it. A per-block ledger keyed by the block's first 32 characters without their marks (`StreamRevealLedger`) keeps old steps merged into the prefix; a block whose marks alone were rewritten (a link's text closed into literal brackets, a lone `*` read literally once the block is no longer the last) keeps what it showed where it now falls (`shownEnd`) and fades only the new text; a block reparsed into another text fades in whole; text a row held when it mounted shows without a fade; paragraphs, headings, quotes and list items fade, code, tables and rules never; no rise; under reduced motion the word steps stay and nothing fades. The row stays on the streaming render until the drain and its last fade are done, then swaps to the settled parse, the same document (`streamingDocument(settled:)` stands in until the settled parse lands), so nothing on screen changes; while it reveals it reports to the thread's `RevealDrain` under its turn, which the closing line waits on. A running step reads in the present tense on its row and settles into the past tense in place | `SmoothTextReveal`, `StreamingAssistantRow`, `StreamFadeText`, `StreamRevealLedger`, `RevealDrain`, `BornRows` |
| Working mark | three 3 pt dots in a 14 pt box gather into one and part every 1.6 s (the left and middle gather by 42 % and part at 58 %, the right by 50 % and 66 %, each leg on the breathing curve), offset and scale only; enters and leaves as a glyph trading state does | `WorkingMark` (`Motion.markDots`, `MotionValues.markLoop`, `Motion.markDot`), run by Core Animation (`Motion.repeating`); the three dots at rest under reduced motion |
| The shimmer | the band crosses the working words every 3 s, offset only | `WorkingText` (`MotionValues.shimmerLoop`), run by Core Animation; muted words under reduced motion |
| Word morph | the old words lift 3 pt and fade over `swapOut`, then the new rise 3 pt over `base` on the swap curve while the box glides its width over `base` from the old words' width to the new (the new words are measured behind the box and never size it, `MorphModel.boxWidth`), the arriving words clipped, never cut with an ellipsis; new words under one key drawn at once; nothing on mount | `MorphText` (`Motion.swapOut`, `Motion.swapIn`, `Motion.morphLift`); reduced motion fades out, then in, `fast` each, no lift and no glide |
| The working line settling | once every row of the turn has finished revealing: the mark leaves as a glyph trading state, the words morph into the closing words and slide 22 pt to the prose edge on `base` and the swap curve | `TurnLineRow` (`Motion.settleSlide`); the morph's fades and no slide under reduced motion |
| The working line held, the Watching line | folds closed and opens again on the layout spring, the words kept; never unmounted while on screen | `Motion.layout`; opacity on `fast` under reduced motion |
| Status dot to spinner | cross-fade over `fast` | `StatusDot` (`Motion.crossFade`) |
| A glyph trading state (Send ↔ Stop, outline ↔ fill, pin ↔ unpin) | scale 0.25 → 1, opacity 0 → 1, blur 4 → 0, spring `duration 0.3, bounce 0`; reduced motion: opacity on the swap curve over `fast` | `.iconSwapTransition()` with `.id(symbol)` in a `ZStack` (`Motion.iconSwap(reduced:)`, `Motion.iconSwap`, `Motion.iconSwapScale`, `Motion.iconSwapBlur`, `Motion.iconFade`); `TypeGlyph(active:)` uses the symbol replace effect instead, since Glyphs builds without Motion |
| Composer button | its tint and glyph color cross-fade 120 ms as it turns on or off; send ↔ steer ↔ queue ↔ pause is the glyph-trading row above, the circle never moves | `Motion.crossFade` on the tint; `.id(intent)` with `Motion.iconSwap(reduced:)` on the glyph |
| Composer height | a keystroke and the clear after a send snap; a paste of more than one line eases `base` | `ComposerHeight.eases`, `Motion.base`, `Motion.withoutAnimation` |
| The row under the box | nothing moves: it is always there; the meter's percent rolls its digits on `fast`, a mode or model pick shows at once | `Motion.numeric` |
| The slot above the composer | between states `fast` opacity only, the row never changes height; at compact width it rises in on the layout spring (opacity and 4 pt) and leaves inert on a `fast` fade, the box gliding down after it; regular width keeps its 28 pt; reduced motion: a fade in, gone at once | `Motion.fast`, `Motion.layout`, `Motion.travel` (BottomDock, WorkingStripView) |
| Attachment chip | appears 200 ms ease-out, opacity and 8 pt translateY; removal 150 ms opacity only | `Motion.appear(reduced:)` |
| Upload bar | width on the 150 ms numeric curve; hidden once the host has the file | `Motion.numeric` |
| Card decided | buttons fade, card settles 200 ms ease-out; a refusal's quiet line cross-fades in 150 ms | `Motion.collapse`, `Motion.crossFade` |
| Haptics | light impact on send and on a decision; nothing on keyboard input | `.sensoryFeedback(.impact(weight: .light), trigger:)` |
| Jump-to-latest pill | `fast` opacity and 4 pt translateY, both directions | `.jumpTransition()` (`Motion.jump(reduced:)`) |
| Diff hunk sideways | follows the finger through an interactive spring, momentum from the release velocity, rubber band at both ends, settles with spring `duration min(0.6, 0.35 + travel × 0.0004), bounce 0`; next and previous hunk scroll 250 ms on `timingCurve(0.23, 1, 0.32, 1)` to the header's exact offset | `DiffMotion.track`, `DiffMotion.settle(travel:)`, `DiffMotion.jump` (Thread/DiffStyles.swift); `DiffLayout.hunkStarts` for the offsets |
| Diff lines landing | 150 ms cross-fade over the shimmer; nothing when the lines were in hand | `Motion.crossFade`; the counter rolls with `.numeric(current)` |
| Fleet toast | 150 ms opacity, both directions; a clean result leaves after 4 s | `FleetToastLine` (`Motion.crossFade`) |
| Fleet confirm's count | `contentTransition(.numericText())` on the title, 150 ms | `FleetConfirmSheet` (`Motion.numeric`) |
| Resource row removed | 150 ms opacity, once the host's push says so | `ResourcesSheet` (`Motion.rowLeave`) |
| Headroom bar on a snapshot change | fill width 200 ms ease-out; never on the first paint; reduced motion snaps | `AccountMenu`'s `AccountMotion.bar` (for `Motion` to absorb) |
| A batch step changing status | its mark cross-fades 150 ms | `StepGlyph` (`Motion.crossFade`) |
| The step console opening and closing | spring `duration 0.35, bounce 0` in with opacity and a short drop from the step; 200 ms ease-out out; reduced motion: opacity | `Motion.expand`, `Motion.collapse` |
| A step's progress bar | width linear 200 ms | `.linear(duration: 0.2)`, the one linear curve |
| A console line arriving | none; the scroll to the tail runs without a transaction | `Motion.withoutAnimation` |
| A board row's tasks folding | the row expand above; the tally chevron turns 90° on 150 ms | `Motion.expand`, `Motion.collapse`, `Motion.crossFade` |
| Stop ↔ Hide on the console's step | the glyph-trading row above | `.iconSwapTransition()` |
| Reduced motion | cross-fades replace every translate and spring | every `Motion.*(reduced:)` and the four transition modifiers read it themselves |

Every transition carries its own timing, so an enclosing `withAnimation`
cannot stretch it. Nothing animates on first paint from cache
(`Motion.withoutAnimation {}` around the paint). Nothing animates on a
keyboard action. Every animated change has a static cue as well.

## Performance

- **Paint from disk.** The cache holds workspaces, projects, sessions, the
  newest 1,000 rows per thread and expanded bodies. Home and any thread the user
  has opened paint from the cache before the socket is open; the socket's
  catch-up applies as a diff, never a reload.
- **Rows are the unit.** Lists are `List` or `LazyVStack` with stable
  identities by `seq`; a streaming assistant row updates its own text only.
  Rows are the row model's rows: a group is one row however many calls it
  folds. Markdown is parsed off the main actor into `AttributedString` once
  per row version and cached by `seq` and text hash; a streaming row parses
  the changed block only, on the main actor.
- **Bodies on demand.** Omitted bodies (over 2 KiB) are fetched when a chip
  expands and cached; a diff is fetched when opened.
- **Budget.** A cold thread open folds the newest 300 wire rows; an older
  page is 200. A chat, a master and a subagent thread hold 2,000 rows and
  grow to 2,400 before they are cut back to 2,000 (one refold per 400 rows,
  never under the reader's window); a board thread (implementation,
  orchestration, planning, research) holds its whole history. The list
  shows a window of the row model's rows: 75 on a cold open, grown 150 at a
  time while the reader is within 25 rows of its top (`TranscriptWindow`).
  The row count, not turns, bounds every window.
- **Images** go through `/asset` with the system URL cache and a memory
  cost cap; thumbnails are decoded at display size.
- **Nothing on the main actor waits on the network.** Every RPC is an async
  call off a detached task; the UI reads the observable models only.
- **Background.** Leaving: the socket closes after a 10 s grace (iOS usually
  freezes the process first, so the grace rarely runs). Coming back: the
  screen the person left is still there, painted from what the app already
  held, and a thread's transcript is at its bottom, pinned there as if the
  person had never scrolled up (the user's rule: leaving a thread and coming
  back shows the newest rows). The transcript snaps there with no motion when
  the app goes to the background (`TranscriptLanding.snapsToBottom`, on the
  scene phase), before the system takes its snapshot, so neither the app
  switcher nor the return shows the old position or a scroll; the cached
  tail paints and the catch-up below fills it. Home, Search, the board, the
  plan page and the other lists keep their positions. Within the
  grace the live socket is probed and kept; past it the stale socket is
  replaced at once, never probed for five seconds. On the new session the
  thread on screen catches up first (`afterSeq` from its cursor), the other
  open threads next, while the shell catches up alongside: workspaces and
  projects in one round trip, and the session list reconciled with
  `session.changes` from the cursor the cache kept (the metas that changed
  and the ids that left, merged in place; the whole `session.list` walk
  only on `reset`, with no cursor, or on a host that predates the method).
  Every catch-up lands as a diff with no reload, no empty flash and no
  duplicate rows; a tail the host replaced whole (`reset`) is a fresh paint
  with no motion even on screen. A change that lands where nobody is
  looking (another thread, Home while a thread is up, the shell while the
  app re-lists) is published with animations off, so nothing that was
  already true moves; rows that arrived while away get the enter motion
  only on the list the person is looking at. A list that comes back as it
  was is not republished. The thread on screen stays seen through the
  catch-up: its seen mark follows its rows and again its fresh meta. Unread
  is the host's mark (`SessionMeta.readAt`, CLAUDE.md "Read and unread: the
  host's mark"): a thread read on the Mac or the box reads read here, and
  one read here is sent to its host (`session.markRead`, through the box for
  a relayed Mac) while the app is in the foreground with an operate key,
  coalesced to one request 1.5 s after the last mark (5 s at most), held
  while the socket is down (`Client/ReadMarks.swift`). A host older than
  the mark leaves the phone's own marks the answer. The
  status line (`StatusLine`) is one line of footnote text over the content,
  never in it: it exists only after the transport has been away 1.5 s,
  fades in and out on `Motion.fast`, and is gone the frame the socket opens; the
  background's own `suspended` state never shows. Its words are the desktop's
  `linkWords` (`ConnectionSentence`: "Reconnecting to Mac in 5 s", "Mac is
  offline", "Mac no longer accepts this key"), one sentence with Home's row,
  the host chip and the computer's page, and it offers Retry only where a
  retry can help (`HostFix.fix` is `.retry`). Elapsed timers run from
  the host's `busySince`, so they are right on the first frame back and
  after a kill. The tab, each tab's stack, the thread's segment, the
  new-thread and Start sheets (`SheetMemory`) survive a cold launch
  (`NavigationMemory`; the clients exist before the first frame, so the
  restored thread paints from the cache at once). The transcript keeps no
  scroll memory: a thread opens at its newest row, from Home, from a list or
  restored by a cold launch (a restored route that once named a row opens
  at the bottom: `LaunchRestore` marks the screens the launch rebuilt). Only
  a launch or a tap that names a row (a search hit, a notification, any
  `targetSeq`) lands on that row, and within a session the Jump to latest
  pill still shows once the person scrolls up. Once every
  host has caught up, the Live Activities and the badge (the needs-you
  count) are brought in line with what the app shows; a queued thread ends
  its activity like a finished one. A host that restarted mid-turn says so
  once per boot (`bootResume`, deduped by the boot's time in the cache).
- **Measure.** The `perf` proof set ("The perf proof" below) counts what
  each push and each key re-ran and times the main thread while a long
  thread scrolls, streams and is typed into; the phone's own numbers come
  from Settings → Diagnostics ("On the phone" below). The simulator proof's
  `scroll` and `stream` sets record frames from a display link too.
- **Streaming.** The thread screen names its thread to the host while it
  is on screen and the app is active (`session.focus { sessionId, shown }`,
  `FocusSignal`; operate, so a read key sends nothing; null when the app
  leaves the screen, again after a reconnect), so its rows leave the host's
  push coalescer as they land instead of in 33–250 ms batches. A streaming
  row's text is paced by `SmoothTextReveal` inside the row's own state, a
  step every 100 ms on a timer (no display link), so a step changes one
  row's body and nothing in the fold; the revealed prefix goes through the incremental markdown
  path (the last block only). Partial tool calls and live edits update one
  row in place by `callId` and by path; a batch of N rows is one write to
  the thread's state. The list anchors its bottom edge on size changes.
  Budget: no frame over 8 ms at 120 Hz on the 2,000-row chat while a turn
  streams.
- **The transcript proof** (`TC_PROOF_SET=transcript`, `stream` and
  `scroll` in scripts/ios-sim-proof.sh, run through
  `bun scripts/ios-sim-proof-local.ts`). `transcript` plays the no-jerk
  timeline (scripts/lib/soakScenarios.ts, the test server's `POST
  /scenario`) on "Streaming on the phone" four times, light, dark, reduce
  motion (the simulator's own `com.apple.Accessibility
  ReduceMotionEnabled`, read back from `UIAccessibility` in the report) and
  scrolled up (`TC_TEST_SCROLL_UP`: 700 pt up before the timeline), each
  run one launch that starts only once the app reports it landed at the
  bottom, recorded whole (`transcript/<run>.mov`) and shot 350 ms after the
  first step of each label (`index.json` keeps the planned and the actual
  times; a loaded Mac shoots late). It fails when a row on screen made its
  state twice: `LayoutProbe` counts each row's `@StateObject` inits,
  appearances and disappearances by row key (`RowInitLedger` in the client
  package, `rowInitProbe` on every row; `row-inits.json`, and `rowInits` in
  the layout report), and an init while the row's appearances outnumber its
  disappearances is a violation; a row that scrolled off may be made again.
  It also fails when the scrolled-up offset moved while rows arrived below
  (`scroll-hold.json`). `stream` records every frame with `FrameRecorder`'s
  `stream` driver while `POST /stream` plays with the reader pinned
  (`stream-report.json`); pass is no frame later than its expected interval
  plus 8 ms and the reader at the bottom on every frame. `TC_STREAM_DRAG=1`
  on the stream set stands a finger in for a slow drag 40 pt up 4 s in,
  held 3 s while the reply streams (`drag-hold.json`, `drag-hold.mov`):
  pass is no pin while the finger is down and the offset where the drag
  left it (2026-11-05: no pin and the offset held to the point while 498
  rows landed). `markup` plays `POST /stream { markup: true }` (an opening
  paragraph of bold, code, a link, a strike and italics) at 30 characters
  a second and shoots it mid-stream: a span open at the cut reads styled,
  never as raw marks. Rows that land under a held finger take the reader off the
  bottom, so once it lifts they stay where they are with Jump to latest:
  they took the list. `retarget` opens a second search hit in the open 2,000-row
  thread (`TC_TARGET_SEQ_NEXT`) and reads the row it landed on from the
  navigation report. The pure runner's follow check plays the reader as
  the view keeps them (`.reader(.bottom | .dragging | .up)` through
  `FollowRule.atBottom`): a pin while they drag or are up fails it, and so
  does a change that leaves a reader at the bottom behind; its fade check
  reads each block's plain text through the streaming markdown, as the row
  does, and fails when a block's text is rewritten mid-stream (its fade
  would start over). The test server's
  `TC_TEST_NO_HARNESS=1` keeps its seeded threads from booting CLIs (several
  GiB, past the host's per-call cap).
- **Baseline, 2026-11-05** (iPhone 17 Pro simulator on iOS 27.0, 60 Hz; the
  Mac's load average 50 to 700 from four agents, so frame times are an
  upper bound, never a budget). "Before A4" is the tree with keyed rows
  (A2) and the old reveal; "after A4" is master with the 100 ms reveal
  steps and the focused thread's pushes:

  | Proof | `List`, before A4 | `ScrollView` + `LazyVStack`, same ids, before A4 | `List`, after A4 |
  | --- | --- | --- | --- |
  | transcript, rows made twice on screen | 0 in all four runs (26 to 34 rows; up to 5 made again after scrolling off) | not run | 0 in all four runs (22 to 32 rows) |
  | transcript, scrolled-up offset | held exactly (no offset change while 12 rows arrived) | not run | held exactly (34 rows arrived) |
  | stream, late frames of ~1,370 | 22, worst 71 ms (most while the 420-line Edit grows, 7 to 11 s) | 25, worst 94 ms | 4, worst 63 ms |
  | stream, reader at the bottom | lost at 20 s (the turn's settle) and never back, 203 frames | held (3 frames at 2.8 s) | held on every frame |
  | scroll, 2,000 rows, late frames | 150 of 2,946, worst 2.0 s, mean 18.8 ms | no report: the main thread sat in text sizing inside the stack's layout for over 10 minutes once the window held every row | 43 of 3,269, worst 39 ms, mean 16.9 ms |

  The transcript stays a `List`. A `LazyVStack` kept the bottom where the
  old `List` lost it, but it could not lay out a long window, and the
  window grows a page of 75 at every reach of the top; `List` sizes cells
  as they come. The identity the counter checks holds under `List`, and
  after A4 the reader stays pinned through the stream's settle (the reveal
  drains instead of landing the rest of the text in one step past the
  64 pt "at the bottom" slack). The late frames left are the stream's
  growing Edit and one at its end; at 120 Hz on a quiet Mac they are the
  next thing the stream set measures.

- **The phrase fade, 2026-11-05** (A5; iPhone 17 Pro simulator, 60 Hz).
  The stream set with the fade, then the same run under reduce motion (the
  fade off), back to back twice at a one-minute load of 13 to 29: 79 and 69
  late frames of ~1,300 against 39 and 49, the worst frame 133 and 122 ms
  against 114 and 131; the reader at the bottom on every frame, 179 to 183
  draws carrying a young run with the fade and none without. The worst
  frame is the stream's own, not the fade's, so the fade stays at every
  width (the plan's fallback, no fade at compact width, was not taken); it
  adds about 30 late frames a run, which a 120 Hz device has to measure.
  The fade's timeline redraws at most 30 times a second (a 0.4 s linear
  fade in 12 steps): drawn at every display frame it cost half again as
  many. Text selection under the renderer is not verified by touch (no
  long-press driver on this Mac); the renderer draws only while a run is
  young, and a settled reply is plain `Text`.
- **Following the reader, 2026-11-05.** The transcript set caught the list
  leaving the bottom on its own mid-timeline and staying off it, with the
  pre-A5 views too. The trace (`TranscriptTrace`: every scroll the view
  makes is a numbered `write` event, a drop of the offset a `jumpUp`)
  showed no stray write: the last write was a plain pin, and 73 ms later
  "at the bottom" went false. The geometry alone cannot tell a reader who
  scrolled up from a row growing below a reader at the bottom by more than
  the 64 pt slack, and a `List` keeps no bottom on size changes, so the
  follow rule took growth for the reader leaving. `FollowRule.atBottom`
  decides it now: only the reader's own scroll (the scroll phase tracking,
  interacting or decelerating) or a scroll the view makes on purpose to a
  row away from the bottom (a landing, a page above, a reflow's row) takes
  a reader off the bottom; growth under a reader at the bottom keeps them
  there and pins. Nothing pins while the reader's finger is on the list
  or it still decelerates from one (`FollowRule.write(readerMoving:)`): a
  slow drag up stays inside the 64 pt slack for its first points, and each
  reveal step pulled it back to the bottom. Pins coalesce into one per
  main-queue turn (`PinQueue`: every ask of the turn, each reveal step,
  push and change in the row count, runs one pin, which asks the rule
  again) and run on the next turn, after the list has applied the update
  that asked for one: run mid-update, a scroll to the bottom row read the list's
  estimated heights and dropped the offset by thousands of points. A
  deliberate scroll away (`offBottomWrite`) ends once the reader is back
  at the bottom by any road, and a top sentinel that shows while the
  reader is at the bottom and not scrolling (the list threw the offset)
  pins and loads nothing (`SentinelReach`; only content too short to fill
  the screen loads its page there, keeping the reader at the bottom). It
  once loaded the page: in every reduced-motion and scrolled-up run of the
  transcript set the list threw its offset about 700 ms after the thread
  opened (the body growing 49 pt as the slot settled), the page of 75 rows
  joined above the reader, and the offset fell about 3,000 pt with the
  content height unchanged until the next pin, sometimes past two frames
  (the reduced-motion `jumpUp` of 2026-11-05, ~824 ms after landing). After these, no run
  of the transcript set leaves the bottom. What is left, and what the set
  still fails on: one or two visible drops a run (a `jumpUp` is a drop
  still there after two frames; shorter ones never reach the screen) at
  the steps where calls regroup (turn 1's first call growing into a
  group, turn 3's burst, turn 6's four calls at once), where the list's
  content height halves as it re-estimates the rows the diff touched
  (5,311 to 1,914 pt) and the next pin puts the offset back. That is the
  `List`'s self-sizing, not a write of ours; the next slice owns it.
  Writing the bottom edge from the scroll view's content size instead was
  tried and was worse: mid-update the list reports a stale size too.
  A revealing row asks the follow rule to pin at each shown step
  (`TranscriptFollow`), since the reveal grows a row with no row landing.

### What a push and a key may re-run

Two contracts shape the data path, and the `perf` set counts both.

| Push | May re-run |
| --- | --- |
| Rows for the thread on screen | That transcript's body, once per 16 ms window; the rows of the live turn whose model changed; the dock only when `DockState` changed |
| Rows for another thread | Nothing on this screen; a board row that shows that child, alone |
| A meta for the thread on screen | The readers of the fields that changed (header, slot, composer chrome); never the transcript, the shell or the strip's other chips |
| A meta for another session | Nothing on the thread screen; that thread's chip in the strip if its look changed; list screens at most 4 times a second while no list is on screen |
| Live edits | The one running edit row, once per window |
| Any push while the reader's finger is down or the list decelerates | Never an offset write |

A keystroke may re-run the field (its text and its height); the button,
only when "has content" flips; the dock's height, only on a wrap (the
transcript's bottom inset moves in one layout pass, and no row is measured
or drawn again). Nothing else: not `+`, not the model row, not the slot,
not `ThreadScreen`, not the transcript, not the client. A thread's composer
writes nothing to disk; the new-thread draft is encoded after 500 ms of quiet.

How the code holds them (the types are in ios/TempCodeClient/README.md):

- **One observable per thread and per session.** A held thread is a
  `ThreadModel`, written in place; its readers take `content`, `dock`,
  `flags`, `overlays` or `frame`, each assigned only when it changed. The
  thread screen reads `frame` (`FrameFacts`: has it a board, agents,
  sources, the newest row that waits on the person, the todo labels) and
  the flags, never the state, so a row landing does not run it; a small
  view of its own watches the newest seq. A hero (the board, the fleet,
  the sources) that is not in view, on the pager's other page, draws the
  thread as it last read it and reads nothing (`HeroGate`,
  `ThreadPose.pageInView`): building a board walks the whole thread, and
  it ran at every row beside a chat nobody could see it from. Sessions live
  in a `SessionStore` outside observation, a slot per id. The list screens
  read `listedSessions`, caught up at once while a list shows and four
  times a second otherwise. The shell and its strip read a `KeptScope`
  worked out off their bodies.
- **Rows built where the thread changed.** `ThreadFold` records each write
  to its items (`FoldChanges`); `TranscriptModel` keeps the rows between
  passes and rebuilds from the turn that holds the lowest item written. A
  DEBUG build checks one build in 16 against a whole build and fails the
  `transcript` set on a difference (`rowsMismatch`).
- **One write per window.** Pushes that change threads and the session list
  wait in `PushIngress`: the first after a quiet 16 ms lands at once, the
  rest of the window together when it closes, in order. Cache writes go
  through one serial `CacheWriter`; the push loop waits for none.
- **Scrolling back.** The window grows before the reader reaches its top;
  rows that join above a moving reader are held in place by the list's
  bounds when its content size lands, with no offset written; an older page
  folds off the main actor; markdown is parsed ahead of the window and a
  small miss parses in place, so a row mounts at its height.
- **The composer.** The typed text is a `ComposerDraft` the field alone
  reads; the bar reads `hasContent`. The dock takes a `ComposerChrome` (what
  it draws of the session, and no `SessionMeta`) and is `Equatable`.
- **Render work.** The pager's sides are cut by a clip, not a mask; a code
  block's lines are counted and numbered at the parse; no handler reads the
  transcript's offset per frame; the working line's two loops (the mark's
  dots, the shimmer's band) are Core Animation keyframes the render server
  runs (`MotionLoop`), where a closure ran on the main thread every frame.
- **Nothing on screen ticks the display link.** A `TimelineView`, while
  mounted, kept SwiftUI's display link updating the view graph and
  redrawing glyphs every frame with no body running: the slot's one-second
  clock and the streaming reply's fade each cost about 95 ms of CPU a
  second that way, for as long as a turn worked. Every clock is a `Tick`
  now (a task sleeps to the next whole period and writes one date), and
  the fade steps its renderer's clock from a task that ends with the
  youngest run's fade. The slot's clock steps with the second and does not
  roll: a numeric transition every second redrew its glyphs through half
  of each one. A new clock uses `Tick`; a new per-frame effect is a Core
  Animation layer.

The transcript stays a `List`. What a `List` cannot do is take a row's
height from us: it estimates rows it has not sized. The `perf` set's jump
count on the cold scroll back is the number that says whether that still
shows ("Measured" below).

### The perf proof

`TC_PROOF_SET=perf bun scripts/ios-sim-proof-local.ts` runs nine launches on the Measure
build (Release's optimizer with the launch hooks compiled in), headless: it
never opens Simulator.app and sends no input, so it needs no idle Mac. The
proof probes (`LayoutProbe`, the row-init probe, the transcript trace) stand
down in a perf run, so they are not what is timed. The test server makes
the fixtures under `TC_TEST_PERF_SEEDS=1`: an implementation thread of
12,000 wire rows, a chat of 2,600, a thread of 600, a master with eight
children, and twelve sessions outside the shown project for `POST /load`
(the host's other traffic: metas, rows into unopened threads, a sibling's
status). Each run writes `Documents/perf/<run>.json`:

| Run | What it does |
| --- | --- |
| `follow` | Pinned at the bottom of the 12,000-row thread: 5 s of load alone (the load-only window), then stream and load for 20 s |
| `scroll-idle`, `scroll-busy` | 30,000 pt up and back at 3,000 pt/s, cold then warm; `busy` streams and loads meanwhile |
| `type-idle`, `type-busy` | 140 keys into the composer of the 2,600-row chat; `busy` streams 1,000 rows past its cap |
| `rest` | A working turn on screen, no pushes, 10 s |
| `master` | The master's chat scrolled while its eight children stream |
| `scale-short`, `scale-build` | The same 200-frame stream into 600 rows and into 12,000 |

A report carries the frame intervals (p50, p95, p99, worst, late frames,
hitch time), the main thread's own CPU per interval and per second, the
turn cost of each applied batch and each key (that CPU from the event to
the end of the commit after it), the body counts by view, refolds, rows
built, publishes, the app's offset writes under a moving reader, the jump
tracker's jumps (a visible row that moved more than 2 pt beyond the
driver's step) and the Mac's load. `scripts/lib/ios_perf_check.py` judges
a pass against the gates in `scripts/lib/ios_perf_gates.json`; CPU gates
read the best of three passes, counts must hold in every pass, and the
frame gates compare with a baseline app run in turn in the same simulator
(`TC_PERF_APP`, `--baseline`). Wall-clock frames on a loaded Mac are noise;
CPU time and counts are what can fail a change.

The headless simulator shows no software keyboard, so the typing runs time
the field, the bar and the dock and not the keyboard's own cost, and it
draws at 60 Hz, one layout per 16.7 ms where the phone lays out twice. The
render server is not measured at all. Those are the phone's to show.

### The Work perf proof

`TC_PROOF_SET=work-perf bun scripts/ios-sim-proof-local.ts` runs on the perf
set's Measure build, headless, against the same test server. Its runs are
`TC_WORK_PERF_RUNS` (default `launch-today rest-today list-idle list-busy editor`). The app runs each itself (`TC_TEST_WORK_PERF`,
`TC_TEST_WORK_PERF_SPLIT`, `Sources/Perf/LaunchFrames.swift`) and adds each
launch's split to `Documents/work-perf/<run>.json` (`WorkPerfFile` in the
client package); `scripts/lib/ios_work_perf_check.py` judges it against
`scripts/lib/ios_work_perf_gates.json`.

`launch-today` is a cold launch onto Today, measured three ways: `empty` (the
caches dropped before they open, the threads' and Work's), `cached` (after a
launch that filled them) and `restored` (after a launch that left a workspace
open, so the saved screen comes back). Each fill launch opens Today (launch
route `today`), so the measured launch after it comes back onto Today; the
server has Work on with the work set's m1 seeds and no relayed hosts, and
Today's LifeOS part reads the fixtures. A measured launch waits up to 30
seconds for every host that can list (a relayed host only while its carrier
says it answers) and, on Today, for Today's fresh page (`WorkPerfWait`); a
split whose wait ran out carries a note naming what never came, and the
checker leaves it out. `locked` needs the cache behind the phone's
lock, which the simulator cannot make: the checker prints it "not run". Each
launch reports, in milliseconds from the process start (the kernel's, read
with `sysctl`):

- the first frame on screen: the first display tick after the root view
  appears;
- the first Today row on screen, and the first from the disk (a row whose
  source has not answered on this launch, `TodayStore.isFresh`);
- the cached row taking a touch: the first display tick on which the
  window's hit test at the row's middle lands in its list cell. This is a hit
  test, not a tap: it says nothing covers the row and the list takes
  touches, without XCUITest.

What gates are counts of what the app owns, held in every pass:

| Gate | Holds |
| --- | --- |
| `network-before-frame` | No request the socket began before the first frame, in every split: tickets, socket opens and calls, counted by `SocketRequests` (DEBUG and Measure builds; a Release build counts nothing, and a report from one fails this gate). Every build holds each socket's start until the first frame (`LaunchClock.holdSockets`, `FirstFrameGate`) |
| `rows-remade` | When the fresh page lands over the disk's, no Today row whose data did not change has its state made again (`LaunchRowLedger`: a row made again while on screen, its data, less its verbs, the same as at its last make). Rows that changed are reported apart |
| `rest-ticks` | `rest-today`: with Today on screen and nothing arriving for ten seconds, the repeating tasks alive (`TickLedger`) are no more than Today needs: one, the minute's words |
| `rest-queries` | `rest-today`: Today's own LifeOS live queries held are no more than it needs (mail waits, the session's cover, each sector's people) |
| `rest-polls` | `rest-today`: no host read in the ten seconds |
| `list-rows-built` | `list-idle`, `list-busy`: the fixture list built no more rows before the finger moved, and held no more alive at once in the measured pass, than its visible window and one page (twice the most rows it showed) |
| `list-rows-remade` | No row built in the still seconds after the scroll, and in `list-busy` at least one push for another place arrived in them, so the count judged something. Rows the scroll built again are reported (`madeAgain`), not judged: List drops a far row's state |
| `list-offset-writes` | No scroll the app made itself (`PlaceTop`'s return to a kept row) while the finger moved |

What is only reported, until it holds in three passes on the phone: the
three times against the 400 ms budget (`first-frame`, `cached-row`,
`row-hit`, the best pass), the process's CPU time, the rows made,
`rest-cpu` (the main thread's CPU in `rest-today`'s ten seconds against
10 ms a second), the list check's frames (late, p95, worst, hitch, the main
thread's p95; judged on the real Duo with its thermal state written down),
and `editor-memory`.

**The list check** (`WorkListCheck`, Sources/Perf/WorkListCheck.swift, in
every build): 1,000 sample files (`WorkListRow.fixture`, their words made
once off the main actor) in the Files place's own frame and row
(`WorkPlaceScreen`, `FilesRowLabel`), each row's state counted by a probe
(`ListCheckLedger`). After the first rows settle it scrolls down and up once
to warm, then again measured at 3,000 pt/s one display tick at a time, then
stands still for six seconds; `list-busy` has the server play other places'
traffic (`/load`, asked by the app at the control address the script hands
`list-busy` alone) from before the measured scroll to the end of the still
seconds, then stops it (`/quiet`); its offsets count only with a push in the
scroll (`scrollPushes`), its rebuilds only with one in the still seconds. In the proof the app shows it in a window of
its own over Home (`list` split); Settings → Diagnostics pushes it.

**The editor run** opens a seeded document (`Perf poster` in `Perf editor`,
scripts/lib/ios-work-perf-seeds.ts) over the reader route. Every run samples
the app's `phys_footprint` every half second (`WorkPerfMemory`, with the
hosted pages loaded in the run); the script samples the WebKit processes of
this simulator by pid once a second (`editor-webkit.json`, resident memory:
`ps` cannot read another process's footprint). The checker reports both
against 300 MB for the app and 700 MB with WebKit, and says when no hosted
page loaded: the test server serves no hosted editor yet, so in the
simulator the figures cover the reader's fallback. The plan's 2,000-row
thread under the document is not seeded; Instruments on the phone is the
figure that counts.

#### Clocks

A Work screen at rest runs only the repeating tasks this table names, each
registered by name in `TickLedger` while it lives (Sources/Perf/TickLedger.swift,
in every build; Settings → Diagnostics shows what is alive). `scripts/ios-tick-ledger.test.ts` holds
every unbounded loop in a Work view to a name here, each name to the file that
runs it, and `rest-today`'s allowance to Today's count. Bounded waits (a proof
hook's hundred tries, a sheet waiting for its socket) are not clocks.

| Clock | Screen | What it does |
| --- | --- | --- |
| `today.minute` | Today | Says the minute's words, once a minute at the minute (Today/TodayScreen.swift) |
| `messages.hold` | Messages, a chat, People, a person | Holds the screen's LifeOS live queries; it wakes once an hour and does nothing (Messages/MessagesReads.swift) |
| `mail.foot` | Mail for a job | Holds Mail's capsule as on screen while the place shows; it wakes once an hour and does nothing (Life/MailPresses.swift) |
| `mail.page` | A person's page | Holds the page as showing a mail's countdown, so its Undo is drawn there and not at the tab's foot; it wakes once an hour and does nothing (Life/MailPresses.swift) |
| `chat.shown` | A conversation | Holds the conversation as on screen, so a stopped reply is said there and not as a toast; it wakes once an hour and does nothing (Messages/MessagesPresses.swift) |
| `outbox.surface` | The Outbox, a held item | Holds the Undo capsule's own surface as on screen, so another tab shows it only when none is; it wakes once an hour and does nothing (OutboxPresses.swift) |
| `request.shown` | A thread's request | Holds the request's sheet as on screen, so its press's Undo is its own foot's and its outcome is said there; closed, both go to the tab's foot and the toast; it wakes once an hour and does nothing (OutboxRequestSheet.swift) |
| `media.preparing` | A video item the host is still cutting | Reads again every 2 s until the proxy is ready; the plan's `work.media` push replaces it; a failed check stops it under the failed-read row (Items/MediaItemView.swift) |

Every other Work screen runs none.

The signposts, subsystem `dev.landon.tempcode` (`Signposts` in the client
package): `launch.firstFrame` and `launch.cachedRow`; in `list`,
`today.cached` (Today's first rows from the disk on screen) and `today.fresh`
(every source answered). The categories `file` (`first`, `whole`) and
`press` (a press to its answer) exist and are unused. Settings → Diagnostics' Work
Checks shows the phone's own numbers: this launch's first frame and cached
row, Run List Check (rows built against the limit, any rebuilt while still, late frames,
hitch time), the repeating tasks alive (`TickLedger`), and the Work cache's
size on disk and protection class.

#### Access on Work's screens

`scripts/ios-work-access.test.ts` holds what a source can show: under
Reduce Motion a Work transition that moves fades instead
(`reduceMotion ? .opacity : …`) and a moving `Motion` name has its fade
beside it; glass comes only through `tcGlass` and the system's glass
buttons, which turn solid under Reduce Transparency; an ink at a fixed alpha
over a picture turns solid under Increase Contrast (`colorSchemeContrast`),
and outlines use `Surface.hairline`. On the open Duo a pointer gets the
system's highlight on every pressable row and button, and the desktop's keys
work where the phone has the command: ⌘N New in Files, ⌘↩ Send on a held
item, a chat's reply and Ask, ⌘Z Undo on the undo capsule. A searchable
list takes the system's own ⌘F. VoiceOver's order, the largest text and the
pointer's look are the Mac's shots.

### On the phone

What only the phone shows: the render server's cost (the glass, the blur),
real 120 Hz pacing under a finger, the system keyboard's own latency with
autocorrect, and heat or Low Power Mode, which holds the screen to 60 Hz.

Settings → hold the version line → Diagnostics. It runs on the thread last
opened, in the Release build:

1. Open a long agent thread, then Settings → Diagnostics. "Thread" names it.
2. **Run Scroll Check**: the list scrolls 30,000 pt up and back at 3,000
   pt/s. Smooth is under 1 % late frames (over 12.5 ms at 120 Hz), no frame
   over 34 ms, under 5 ms of hitch a second, and a main-thread p95 of 4 ms a
   frame. Run it idle and again while a turn streams.
3. **Run Typing Check**: 140 keys into the composer, wraps included. Smooth
   is 17 ms from key to screen for most keys and 34 ms for the slowest, not
   counting the keyboard's own delay.
4. **From iOS**: "Display" says what the panel offers and what the check
   saw (120 Hz reads as a median interval of 8.3 ms); "Scroll Hitches" is
   MetricKit's scroll hitch ratio over the app's real use, which iOS
   reports at most once a day. Under 5 ms a second is smooth.
5. **Share Report** sends the numbers as JSON.

A miss on the phone with the simulator's gates passing points at what the
simulator cannot see: render cost, or the `List`.

### Measured

Before: slice 0's Measure app, the measuring kit with nothing fixed (commit
`d6c75a8f9`, kept on the Mac at `/tmp/tc-ios-perf/baseline/TempCode.app`).
After: master at the end of the pass. Both ran in turn in one simulator
(iPhone 17 Pro, iOS 27.0, headless, 60 Hz) on 2026-11-11, three passes
each, the Mac's 1-minute load 5 to 65 on 16 cores from other work. CPU is
the best of three passes; counts are the range over them. The reports and
the samples are in `.temp-code/findings/ios-perf-pass/`.

| What | Run | Target | Before | After |
| --- | --- | --- | --- | --- |
| Turn cost of an applied batch, p95 | `follow` | 2 ms | 697 ms | **10.8 ms** (7 ms at the median) |
| | `scroll-busy` | | 417 ms | 12.6 ms |
| | `type-busy` | | 26 ms | 6.3 ms |
| | `master` | | 27 ms | 1.7 ms |
| The same cost on 12,000 rows against 600 | `scale-*` | ratio 1.5 | 9.1 | **1.23** |
| Batches applied in a 20 s stream on 12,000 rows | `follow` | all of them | 8 to 12 | 1,018 to 1,042 |
| Frames drawn in that run; late | `follow` | | 59 to 62; all late | 1,438 to 1,476; 14 to 41 |
| Bodies run in the load-only window | `follow` | 0 | shell 23 to 43, thread screen 36 to 55, transcript 11 to 13 | **0** |
| Transcript bodies against batches applied | `follow` | no more bodies than batches | 61 to 68 for 8 to 12 | 922 to 939 for 1,018 to 1,042 |
| Whole refolds while 1,000 rows stream past the cap | `type-busy` | 3 | 584 to 659 | **1** |
| Rows built per batch, p95, against the live turn's rows | `follow`, `scale-*` | the live turn's | 1,983 to 2,379 against 2 | **4 against 4, 3 against 3** |
| Bodies per keystroke outside the field | `type-idle` | 0, and one bar pass per flip | the bar, 140 for 140 keys | **0, bar 1** |
| Turn cost of a keystroke, p95 / worst | `type-idle` | 3 / 8 ms | 12.8 / 89.3 ms | 11.6 / 82.8 ms |
| | `type-busy` | | 79.2 / 97.6 ms | 10.3 / 37.7 ms |
| Main-thread CPU per interval while scrolling, p95 / p99 / worst | `scroll-idle` | 8 / 12 / 16 ms | 13.0 / 34.5 / 78.5 ms | 11.2 / 26.9 / 45.1 ms |
| | `scroll-busy` | | 684 / 870 / 1,152 ms | 17.7 / 34.6 / 66.0 ms |
| | `master` | | 49.4 / 67.5 / 92.0 ms | 10.6 / 31.6 / 110 ms |
| Main-thread CPU, a working turn at rest | `rest` | 10 ms a second | 128 ms a second | 11.6 ms a second (11.6 to 14.5 over three runs, loads 18 to 40) |
| The app's offset writes under a moving reader | every run | 0 | 2 a `scroll-idle`, 4 a `scroll-busy`, 2 a `master` | **0** |
| Jumps on the cold scroll back, per 62,000 pt, the largest | `scroll-idle` | 1 per 10,000 pt, none over 8 pt | 0 to 3, 182 pt | 0 to 2, 270 pt |
| | `scroll-busy` | | 3 to 6, 7,014 pt | 1 to 4, 34 pt |
| Jumps on the warm pass | `scroll-idle`; `scroll-busy` | 0 | 0; 0 | 0; 0 to 2 |
| `jumpUp` | every run | 0 | 1 in one `scroll-busy` | 1 in two of three `master` runs |
| Late frames, ours against the baseline's in the same passes | `scroll-busy`; `master`; `type-busy`; `follow` | half | | 414 / 1,331; 272 / 1,839; 9 / 717; 80 / 183 |
| | `scroll-idle` | half | | 285 / 338 |

The gates in `scripts/lib/ios_perf_gates.json` that hold in every pass are
on: `load-only`, `bodies-per-batch`, `refolds`, `rows-built`,
`keystroke-bodies`, `scale`. The rest are off, and their targets stand:

- **A batch costs 10.8 ms at p95, not 2.** With the thread screen and the
  board out of it, what is left is SwiftUI's update of the list, the
  layout and the commit of the live turn's rows (7 ms at the median, on
  600 rows as on 12,000). The app's own share is the rebuild of the live
  turn, a quarter of it.
- **A keystroke costs about 10 ms, not 3.** No body outside the field
  runs. The time is the vertical `TextField` itself: about 2.7 ms in
  TextKit for the key, 3.2 ms for SwiftUI to measure the field again, 3.4 ms
  for UIKit to lay the text view out and commit. A `UITextView` composer,
  which the pass ruled out, is what this number asks for. The worst key
  of a run costs 83 ms, as it did before (89).
- **Scrolling costs 11.2 ms an interval at p95, not 8.** The sample shows
  the main thread in Core Animation's commit (28%) and layout (24%, the
  collection view 17%) as rows come on screen; row bodies are under 0.2%
  each and nothing parses on the main thread. That is the `List` hosting
  SwiftUI rows, and at 120 Hz it has half the time.
- **At rest a working turn costs 11.6 ms a second, not 10.** It cost 128:
  the working line's loops were 28 of that, two `TimelineView`s 45, and
  the slot clock's roll 45. What is left is the clock's one redraw a
  second and the measuring kit's own display link.
- **Jumps.** On the cold scroll back, up to two rows in 62,000 pt still
  jump (270 pt at the worst), where the window grows above the reader:
  the list's bounds are corrected when the content size lands and the
  correction is not exact. Before the pass the app wrote the offset there,
  which stops a real fling dead; now nothing is written and the fling goes
  on. One `jumpUp` remains in two of three `master` runs.

**The `List` verdict.** The plan's test was: cold jumps over 1 per 10,000
pt, or any over 8 pt, or a `jumpUp`, with no offset write of ours beside
it, and the `List` has failed. Jumps over 8 pt remain and no offset is
written, but they sit at the app's own join (the bounds correction), so
they do not yet convict the `List`. What does point at it is the scroll
cost: with the app's own work gone from the sample, the commit and layout
of hosted rows is what misses the 8 ms target. The transcript stays a
`List`; a `UICollectionView` with measured heights is the next plan's
question, and the phone's Diagnostics numbers decide whether to ask it.

What only the phone can add: the software keyboard was never up in these
runs (the headless simulator shows none), the simulator draws at 60 Hz,
and the render server's cost is not in any number above.

## Push, the Live Activity and the Dynamic Island

The lock screen and the island show the desktop's running row, nothing
else; the host sends what that row needs and the clock ticks on the device.

| Surface | Shows |
| --- | --- |
| Content state | `phase` (working, paused, waiting, finished, failed, stopped), `since`, `ts`, `seq`, `title`, `task` (the in-progress task, else the activity line; a master's running batch step), `done`/`total` when the thread has a list, `unit` (tasks, or threads for a watching master's batch), `reason` (the needs-you line) while it waits. Pushed on every change of what the card shows; task-line-only changes coalesced to one push per 20 s. A queued thread has no activity: it is not live |
| Lock screen card, row 1 | glyph tinted by type (20 pt frame, semibold), title `subheadline` semibold one line, the timer `footnote` tertiary in tabular digits on the title's baseline |
| Lock screen card, row 2 | indented 28 pt to the title's edge, 18 pt tall whatever it says: the status mark (14 pt frame: the spinner while working, the pause mark, a 7 pt dot for waiting, done and failed, a 6 pt still square for stopped, the StatusDot's marks) and one line. Working: the task alone in `footnote` secondary (the spinner already says working; the desktop row never spells it). Paused and waiting: the word `footnote` medium in warning, then the task or the reason in secondary. Finished, failed and stopped: the word alone, Done success, Failed destructive, Stopped secondary |
| Lock screen card, row 3 | only with a list: a 3 pt tally capsule (quaternary track, filled in the type's tint while working or waiting, warning paused, success finished, destructive failed, secondary stopped) and `3/7` `caption2` tabular, secondary while live, success once finished with all done; the same for a master's threads. VoiceOver: "3 of 7 tasks done" / "3 of 7 threads done" |
| Island compact | leading the type glyph while working, paused or waiting, the final state's mark once settled; trailing `3/7` when there is a list, else the timer in a 60 pt slot that shrinks to 0.8 before `1:02:33` would clip, colored by the phase once the thread stops working |
| Island minimal | the status dot (8 pt): the type's tint while working, warning paused and waiting, success done, destructive failed; a 6 pt still square for stopped |
| Island expanded | glyph, title, timer on the top row; the status line and the tally below; keyline in the type's tint; every presentation deep-links to the thread and the row |
| Notification | title the thread's title, subtitle the project (else the workspace), body one line: "Run bun test?", "Which database?", "Plan ready to approve", "Needs you", "Done in 12m, 2 tasks left", "Ready to build", "Batch done: 3 landed, gate passed in 4m 12s", "Batch stopped: gate failed at vitest", "Failed: <the host's summary, else the first line>", "Stopped unexpectedly", "No output for 12m"; nothing for a thread the person is looking at on the Mac, a batch thread's finish or a plan whose build started. Grouped per thread; relevance needs-you 1, failed 0.8, stuck 0.6, finished 0.4; sound only for needs-you and failed; time-sensitive only for needs-you; Approve and Deny on an approval (Approve asks for the unlock; category `tc.approval`), Run now and Skip on a computer step held for the Mac (`tc.run-skip`, the same two actions, Run now asking for the unlock, a refusal "Not run: …"; the categories are the client package's `PushCategories`); a refusal answers one notice saying why. No emoji, no exclamation marks |
| A host's own notice | `host_down` and `host_up` name no thread: a tap opens Hosts, where the host's row says its state (`PushTarget.hostEvent`); a tap for a thread on a host forgotten since opens "Thread Not Here" in the detail, never a blank column |
| The host in the subtitle | the host does not know how many hosts a phone pairs with, so the phone decides: the alert is `mutable-content` with the host's name under `tc.host`, and the notification service extension appends it ("temp-code on box", under the name he gave the host when the directory holds one for the notice's `tc.environmentId`) only when two or more hosts are paired, from the App Group directory the app publishes (`HostDirectory.subtitle`) |
| In the foreground | nothing for the thread on screen; a thread whose Live Activity is live gets the list only, unless it needs you |
| In the background | an alert and the activity's end for the same settle both show: the alert is the persistent record, the activity leaves after two minutes, and the shared collapse id folds repeats |
| The clock | runs on the device from `since` while working; paused and every end freeze it at the state's time, so the final card reads the work time as it was. A waiting end shows the work time, not the time spent waiting: that count belongs to the app's Needs-you row |

### Several threads: one activity per host

A second thread the person follows on the same host joins the activity
already running instead of stacking a second one. From then on its content
state carries `threads` (a row per thread: `id`, `type`, `phase`, `since`,
`ts` where a non-working row's clock froze, `title`, `task`, `done`/`total`/
`unit`, `reason`) and `more`; the top-level fields name the lead thread, so a
build that predates groups still draws one card. With one row left (the
others settled and gone) the single card draws that row's thread.

Where the aggregation lives, and why: on the host, per activity token. The
phone registers the activity's one push token for every thread it covers
(`remote.push.activity`, unchanged), so the host sees a token on two or more
threads and `ActivityFeed` pushes that group's state
(remote/push.ts `activityGroupState`) whenever any of them moves, with the
same coalescing as one thread (rows, phase or reason at once at priority 10;
task lines alone once per 20 s at priority 5). Only the host can update the
card while the phone sleeps, and a host knows only its own threads, so the
activity is per host: the box's threads on one card, the Mac's on another
(the Mac relayed through the box gets no pushes of its own: the box answers
its `remote.push.activity` and the phone updates that card while its socket
is up). The phone applies the same rules to the metas it holds
(`ThreadActivityGroup` in ThreadActivityText.swift) while the socket is up.
No wire change beyond the two optional keys; the hub validates and passes
them.

| Rule | Value |
| --- | --- |
| Order | needs-you (waiting), working, paused, failed, stopped, finished; each kind oldest first |
| Settled rows | stay one minute (`ACTIVITY_SETTLE_MS`), then leave at priority 5 |
| Cap | six rows, the rest in `more`; rows give way before the state passes 3.5 KB of ActivityKit's 4 KB; a row's title cuts at 60, task 80, reason 100 |
| Live | while any thread works or is paused; once none does, the push is the `end` with the lead row's phase, and every thread's token row goes |
| Lock screen card | a row per thread: glyph, title `footnote` semibold, clock `caption2` tertiary; under it the single card's status line (mark, word, task or reason). Three rows fit 160 pt; past three, two rows and "and N more" `caption` secondary at the title's edge. Each row opens its thread, the card opens Home (`tempcode://home`) |
| Island compact | leading: the spinner and the count working (the pause mark and the count held when none works; the final mark once settled); trailing: the raised hand and the count waiting in the needs-you color whenever one waits, else the longest-running clock |
| Island minimal | the raised hand while one waits, else the count at work in the lead thread's tint; the final mark once settled |
| Island expanded | "3 threads" leading, the longest-running clock trailing; below, a line per thread (mark, title `footnote` semibold, then the task, the reason or the word) for three, "and N more" under them; each line opens its thread; keyline the needs-you color while one waits, else the lead thread's type |

Motion: WidgetKit animates a Live Activity's content changes itself and
ignores view-level `.animation`, so the widget carries none; the line
cross-fades with `contentTransition(.opacity)`, the tally rolls with
`numericText`, the bar's width rides the system's update transition.
Every change has a static cue (word, color, mark); nothing depends on
motion, and the first state is a plain render. Flavour words stay inside
the app's working strip.

## iPhone Duo

The iPhone Duo (iPhone19,4, iOS 27.1) is a `.phone` idiom device whose app
window changes size and size class as it folds. **Lay out by the size class
of the view's own container, never by idiom, orientation or screen**:
`UIScreen.main` keeps reporting 466 × 678 while the app sits on the inner
panel, `UIDevice.orientation` tracks the device and not the panel, and the
idiom is `.phone` in every pose.

### The poses

Window metrics for an app linked against the iOS 27.1 SDK, in points; the
proof asserts them on every shot (`DuoPose` in the client package is the
table as code; its aliases are the shot vocabulary).

| `TC_DUO_POSE` (alias) | hinge | device orientation | window (pt) | horizontal × vertical | lit panel (`--display`) | capture (px) |
| --- | --- | --- | --- | --- | --- | --- |
| `folded` (`fp`) | 0° | portrait | 466 × 678 | compact × regular | `LCD` (1) | 1398 × 2034 |
| `folded-landscape` (`fl`) | 0° | landscape-left | 678 × 466 | compact × compact | `LCD` (1) | 2034 × 1398 |
| `unfolded` (`ul`) | 180° | portrait | 951 × 669 | regular × regular | `LCD-1` (3) | 2853 × 2007 |
| `unfolded-portrait` (`up`) | 180° | landscape-left | 669 × 951 | regular × regular | `LCD-1` (3) | 2007 × 2853 |
| `half-open` (`ho`) | 130°, from 0° | portrait | 951 × 669 | regular × regular; `hinge.state` partiallyOpen | `LCD-1` (3) | 2853 × 2007 |
| `tabletop` (`tt`) | 130°, from 0° | landscape-left | 669 × 951 | regular × regular; `hinge.state` partiallyOpen | `LCD-1` (3) | 2007 × 2853 |

The inner panel's native orientation is a quarter turn from the outer's, so
a device held portrait shows a landscape window when open; "unfolded
portrait" is the device turned. An app linked against 27.0 loses an 80 pt
rail in every pose (386 × 678 closed, 871 × 669 open): the toolchain's 27.1
minimum is what keeps these numbers true. The outer display has a vertical
Dynamic Island on its side and so does the inner; Touch ID is in the side
button; there is no Face ID.

### The toolchain

Xcode 27.1 (27A9275) builds the simulator app, the device app and both
packages; its Developer Disk Image is compatible with an iOS 27.2 phone, so
the 27.2 RC is not needed. Every iOS script asks `scripts/ios-xcode.sh`
(`bun run ios:xcode`): `DEVELOPER_DIR` passes through, else `TC_XCODE`,
else the `/Applications/Xcode*.app` with the highest version (a tie to the
one without "beta"), refused below `TC_XCODE_MIN` (27.1 for the app; the
package runners pass 0). 27.1-only symbols (`DeviceHinge`, `onHingeChange`,
`toolbarVerticalBehavior`, …) live in the app target alone, always under a
runtime `if #available(iOS 27.1, *)`, never in the packages, whose tests run
on macOS; there is no compile-time SDK gate, because the picker's minimum is
the gate and a second one would let a 27.0 build pass with the 80 pt rail.
scripts/ios-project.test.ts pins project.yml's orientations (plan 1's,
below), the 18.0 target and the iPhone family. `bun run ios:duo:check` says what a Duo pass
needs on this Mac (the Xcode, the 27.1 runtime, the device type, the
"TempCode Duo" simulator with `--create`, `hinge`, `xcodegen`, and with
`--device` the connected Duo with a compatible DDI).

### The shell in every pose (plan 1)

**The shell by size class.** The phone chooses its shape from the window's
size classes and its own bounds, never from the idiom, the orientation or
`UIScreen.main`: compact width is the three stacks (the outer display; short
titles when the height is compact too, the folded landscape pose); regular
width is a split per tab, the sidebar tiled beside the detail in every
regular pose, upright too with a 320 pt list (the plan's overlay there, with
a 640 pt reading width, is the owner's flip). The rule is the
client package's `ShellPose`; the shell publishes it as `\.shellPose` and
every screen reads that, never `horizontalSizeClass`, for a shell decision.

**One split, both shapes.** Home and Search are each one
`NavigationSplitView` that collapses and expands on its own, so a fold is a
size change and nothing else: the paths, the open thread and everything it
holds (a typed draft, a rename, the segment) are the same values before and
after. `columnVisibility` always carries the expanded preference, so the
sidebar arrives with the expansion and never flickers in. The sidebar button
is the shell's own (`sidebar.leading`, Show Sidebar and Hide Sidebar, where
the system's toggle sat: at the trailing edge of the sidebar's bar while it
shows, else at the leading edge of the detail's; one button on screen, never
both), on every page of each
column, the root, each page the shell pushes over it and each page a screen
pushes itself (Page Preview, a thread's diff, report, HTML render, agents
list and subagent, a version compare, an agent's detail, Diagnostics:
`.sidebarButtonPage()`, which finds its column in the environment the split
sets on each column's stack) (`SidebarButtonItem`, which also removes the
system's toggle there), not the system's: its action is his toggle at once
(`ShellNavigator.pressSidebar`, `ShellPose.isHisToggle(.button, …)`), even in
the half second after a tab appears, while the split's own writes to the
binding are still sorted by their timing. The m0 part's
`work_sidebar_tap` opens the Outbox's list in the sidebar, checks the button
stands once in the bar of the column his toggle sits in
(`sidebar.buttons.<column>`), presses it right after Work appears in each
split pose, and checks his choice and the button's place after the settle. The sidebar is
Home's two levels; at the workspace level its title is a menu of the
workspaces. The detail holds a project's shell, a bare thread or Settings,
and reads "No Thread Selected" when nothing is open; collapsed, a card's
tap pushes the shell over the workspace.

**The thread strip.** At the shell's top in every pose, one row of chips
lists the project's live roots in their saved order (`ThreadStrip.model`,
above), then New Thread: the desktop's strip, which is the project's threads
and not a set of open tabs. Unfolded, the shelf row of settled roots sits
under it; folded, the Recent menu at the row's end holds them.

**Memory.** `navigation.memory.v3` keeps, per tab, the sidebar path, the
detail root and the detail stack, plus the overlay toggle; one snapshot
opens the same place folded or unfolded. The split writes its visibility as
it collapses (`.all`) and expands (`.detailOnly` then `.all`, inside 40 ms);
only a write in a split whose pose has held for half a second is the
person's toggle (`ShellPose.keepsVisibilityWrite`, `foldSettle`), so a
sidebar hidden before a fold is hidden after it.

**Orientation.** The outer display allows portrait and both landscapes; the
inner display ignores the key.

### The thread screen in every pose (plan 2)

"The thread screen on the iPhone Duo", under "The thread screen", is the
account: the pager or two panes by the screen's own size class and width,
the columns from the fold's division band, the 640 pt measure, the
transcript's reflow, the one-line header and the vertical bar in compact
height.

### Sheets, Settings, Inbox, Search and the bars (plan 3)

On the Duo the system lays a navigation stack's and the tab bar's bars out in a
vertical rail (on the outer display too), leaves a title-only item out of
it, and reports zero-height keyboards around a fold.

**Sheets.** Every sheet is shaped by one rule, `SheetRules.shape(kind, in:
window)` in the client package (`Shell/DuoLayout.swift`), applied by
`tcSheet(kind)` in Design/SheetShape.swift; no sheet writes a detent, a
radius or a sizing itself. The rule reads the window's size classes
(`\.windowClasses`, published once by the outermost modifier of RootView,
so the sheets the root presents read it too), never the sheet's own, because
a form sheet's own width is compact on every display. Folded portrait keeps
today's detents (medium and large for a form or a picker, medium for the
rename field, large for an editor or a document, a confirm as tall as its
content). Folded landscape takes the large detent for everything that is not
sized by its content: a medium sheet in 466 pt of height is under a Form's
third row. Unfolded, a form, a picker, a field or a confirm is a centered
form sheet (`.presentationSizing(.form)`, a confirm fitted to its content)
and a document (Notes, the research report, the deploy log) a page sheet;
nothing in the app is a full-screen cover on the inner display except
Safari and the live picture's full screen. One `PresentationSizing` adapter carries every case, so a fold never
gives the sheet a new identity: a sheet that is up stays up across a fold
and takes the new shape with its draft. Every sheet opts into horizontal
bars (`.toolbarVerticalBehavior(.disabled)` on its stack, iOS 27.1): Cancel,
Save and Done stay text at the top as Apple's own form sheets do, and the
confirm asks for `.visibilityPriority(.high)` (`highVisibility()` in
Design/BarItems.swift). `SheetMemory` is the same in every shape.

**Bars.** A toolbar item on a screen of a navigation stack carries an SF
Symbol (`Button("Title", systemImage:)` or an `Image`), since the vertical
rail leaves a title-only item out; the host detail's principal title is
`.axisBehavior(.horizontalOnly)`. Home's Settings, a workspace's and a
project's New Thread, the project menu and the Inbox item's Open on GitHub
ask for high visibility; the project plan chip is a `Label` in the bar (the
capsule stays in the row) and the first to overflow. Inside a sheet, text
items are allowed. Nothing hand-builds a bar; the confirm sheets' titles and
full-width buttons are content. Alerts, confirmation dialogs, swipe actions
and context menus are the system's and keep clear of the fold.

**Settings.** The pushed inset-grouped stack at every width, in whatever
column Home's pushes land; no settings split. Three top-level rows do not
earn one.

**Inbox.** At regular width the Inbox is Mail's shape inside its tab
(`InboxScreen`): the list in a 320 to 420 pt column, the item beside it, a
Changes row pushing the diff into the item's column. Both shapes read the
tab's one typed path (`[InboxRoute]`, `InboxColumns.split`): the first
element is the selection, the rest the detail column's pushes, so a fold
keeps the item and an unfold shows it beside the list. The launch memory
keeps the item alone, never a patch.

**Search.** The system field on the search-role tab, placed by the system in
every pose (unfolded it sits at the bar's trailing end); a fold keeps the
text and the rows. The **Work** scope (beside Threads and Files, shown as the
field opens while a Work host lets the key search) draws the desktop's rows:
a `SectionHeader` band a kind in the desktop's order (Recent first, before he
types), each row the kind's glyph in the 20 pt column, the title in `.title`,
its one fact under it in `.meta` with his words in weight, and the job (its
dot and name as a stamp) trailing only while rows of several jobs stand
together; "All mail for …" in the accent at meta weight narrows to the kind,
and the bar's filled filter (`line.3.horizontal.decrease.circle.fill`, "All
Kinds") widens again. A row with no place on the phone is drawn the same and
does not press. A file's row shows a small spinner in its trailing slot while
the host seats it. What could not be searched sits at the list's foot as
stamps; "Nothing for …" is the system's search empty view. Nothing animates
on a keystroke. Results at regular width sit in a 720 pt measure
(`Layout.listMeasure`). The decided fallback, if a pose ever moves the
field, is the navigation drawer always shown in every pose, the commented
line in `SearchField`; never a custom field.

**Pairing, the fleet confirm, the toast.** Pairing is a form sheet; the
first field takes the keyboard after 350 ms in every pose, and nothing reads
the keyboard's height. The fleet confirm, Archive with resources and Archive
batch are as tall as what they say in every pose (one measured height, the
same chrome allowance), centered fitted form sheets unfolded, each with
Cancel in its horizontal bar. The toast stays a bottom safe-area inset on
each tab's root (the Inbox's on `InboxScreen`), above the floating tab bar
wherever the system puts it, 440 pt wide at most (`ToastMeasure`), and
ignores the keyboard.

**Notifications and the Live Activity.** Unchanged: nothing in them reads
a display size, a size class or a cutout. The card's widths are flexible and
its row heights fixed; Apple documents a Dynamic Island on both of the Duo's
displays, so every presentation can show.

### Work in every pose

The Work tab is one more split on the shell's engine, so everything above holds for
it. What Work adds (the plan "All of Work on the iPhone", M0d):

- **The pick.** On the open Duo, upright too, a place's list in the sidebar fills
  an empty detail with its first row that needs him, so the right side is never
  blank on arrival. A pick still in the list stays; when the picked row leaves (sent,
  discarded) the next takes the detail, or the detail clears. Nothing is picked in a
  stack, in the overlay pose, by a list that is not the sidebar's top, or over
  something he opened from elsewhere. The rule is the client package's
  `ShellSelection.decide`; a list applies it from an `.onChange` of its rows and the
  pose, never from a body (`placePick`, Work/Shell/WorkPlaceScreen.swift). A pick
  opens the row through the navigator: it only reads. The Outbox is the first list
  that picks.
- **The selected row.** The row whose item the detail shows sits on
  `Surface.groupSelected`, in the split poses only (`placeSelected`).
- **Wide routes.** LifeOS's Mail, Tasks and Agenda (a job's or every job's), an open file, and a thread with a
  file beside its chat take the whole open Duo (`ShellPaths.wide`). The sidebar's
  state is derived: his toggle for the tab, hidden by a wide route without writing
  the toggle, and his press on the sidebar button over a wide route kept as that
  route's own choice until he leaves it (`SidebarVisibility`). A fold writes neither.
  A Work thread turns wide when its first item lands, after its route opened: the
  thread screen tells the navigator (`itemsMoved`), and the split asks again.
- **List positions.** Each list's top row lives in the navigator's memory by its
  route (`ShellNavigator.tops`), written once a scroll settles (`onScrollPhaseChange`
  to idle), never under a moving finger, and read when the list is built again, so a
  fold or a pose change that rebuilds a list comes back at its row. The list scrolls
  by `ScrollPosition` over its rows' ids (`placeTop`). The memory is not kept across
  launches. A list with no row to come back to goes to its top edge once its first rows
  land, so rows that arrive while the push still moves never leave it scrolled past its
  large title (Connections lost its title so, about four opens in five).
- **A place's frame.** `WorkPlaceScreen` is the one frame a place's list uses: the
  place's title, a job filter in the bar (All Jobs, then each job with its sector's
  dot), search when the place has it, the rows' shape redacted on the first load,
  `ContentUnavailableView` when empty, one line with Try Again over what showed when
  a read fails, pull to refresh, the pick and the kept top row. Today is its first
  full user.
- **A tab built in the upright poses.** Unfolded-portrait and tabletop draw the list beside the detail (iw13), his
  toggle as he left it; the Outbox and Today pick their first row there as the tiled Duo does. A tab first built or
  picked there makes its split write `.detailOnly` as it appears; that write is the
  split's own, never his toggle (`ShellPose.keepsVisibilityWrite`'s `sinceShown`), and since the split acts only on
  a change of the value it reads, its binding answers that `.detailOnly` for one turn, then the shell's `.all`
  (`SplitAnswer`, `ShellPose.echoTurn`), so the list comes back (iw12: Work's tab drew only "Nothing Selected").
- **On a table.** Half open and turned tall (669 × 951), the fold's band lies across
  the middle: the thing stands on the upper half, its controls lie on the lower, and
  nothing sits in the band (`TabletopHalves`, client package). The simulator holds the
  pose (four runs on the Mac): `TC_DUO_POSE=tabletop` (`tt`), `DuoPose.tabletop`, the
  sidebar beside the detail as in `unfolded-portrait`.
- **The fold cycle.** `TC_PROOF_SET=work TC_WORK_ONLY=fold` takes each Work screen
  folded, unfolded and folded again with the app running: the Outbox scrolled with an
  item open, a Files folder, a Work thread on its file with a typed draft and a chip in
  its box, and Mail with a thread open.
  scripts/lib/duo_work_fold_check.py holds, at every stop, the typed route
  (`work.route`), the picked row (`work.picked`), the list's top row (`work.top`), the
  draft's length (`draftChars`), the box's chips (`work.chips`; the thread step must
  have a draft and a chip, `typed`), an open sheet (`work.sheet`, never gone between
  stops), his chosen sidebar (`sidebar.chosen`, never written by a fold), the shown
  sidebar (`sidebar`) as the route and the pose allow it (an ordinary route
  `visible` or `overlay` as he chose, else `hidden`; a wide route `hidden` unless his
  press there; `stack` folded), no row made twice (`row-inits.json`), and the hosted
  web view the same object (`web.instance`) with its loads (`web.loads`) not grown. A
  hosted document and a typed mail reply join once a seed opens them.

### The proof

The simulator is "TempCode Duo" (iPhone Duo on the iOS 27.1 runtime),
posed by `scripts/ios-duo-pose.sh <udid> <pose>|lit|state` over `hinge`
(brew `artemnovichkov/tap/hinge`: the Device Hub's HID event for the angle
and the orientation, verified in the guest; `devicectl device motion` does
not exist in Xcode 27.1, so agent-device cannot verify there), the lit panel
read from `xcrun devicectl device info displays`, never inferred from the
angle (it is path-dependent around 100°, which is why half-open closes
first). `TC_DUO_POSE=<pose>` is an axis on every set of
scripts/ios-sim-proof.sh: the device defaults to the Duo, the check runs
first, the pose is set before the first shot, every shot captures the lit
panel (`--display=`; the default capture is the dark inner panel when
folded, a valid black PNG), shots land in `shots/<pose>/`, each shot's
`layout-report.json` in `layout/<pose>/<name>.json`, and `pose_check` holds
the report's window, size classes and `classified` and the PNG's size to the
pose's row. `fold <pose>` inside a set moves the device with the app
running; `duo_shot` is `shot` under the axis, the one helper the plans add
lines to (`duo_shots_shell`, `duo_shots_thread`, `duo_shots_sheets`, called
once per pose). `TC_PROOF_SET=duo bun scripts/ios-sim-proof-local.ts` is
every pose's seed shots, the thread matrix ("Proof shots" under "The thread
screen on the iPhone Duo") and the fold cycle, paired with the key that may
act; `TC_DUO_POSE=unfolded
TC_PROOF_SET=features …` is any existing set in a pose.

The layout report is `LayoutProbe` (ios/TempCode/Sources/Shell/LayoutProbe.swift,
DEBUG only, on RootView's root): `Documents/layout-report.json` 250 ms after
a change settles, with `window`, `screen`, `scale`, `fps`, `hSize`, `vSize`,
`idiom`, `orientation`, `hinge { state, angle }` (null before 27.1), `safeArea`,
`route { tab, depth, thread, segment }`, `transcriptAtBottom`, `notes`,
`classified` (the pose `DuoPose.classify` reads off the window) and `pose`
(the `TC_DUO_POSE` the app was launched with); `Documents/layout-events.json`
is the log of every change of `window`, `hSize`, `vSize`, `orientation`,
`hinge.state` and each notes key (`{ t, key, from, to }`, 500 at most,
cleared at launch). Any view says `LayoutProbe.note("sidebar", "visible")`;
a repeated value is not an event. Every call sits inside `#if DEBUG`, as does every
other DEBUG-only type's use: scripts/ios-debug-guard.test.ts refuses one
outside, and every proof set compiles the Release configuration before its
Debug build and stops on a break. The shell and the thread screen note
`sidebar.width`, `columns` (hero, gap, chat in two panes, else the mode),
`measure` (the text column), `composer.frame`, `slot.frame` ("none" while
the slot takes no room), `dock.backing`, `dock.frame`, `dock.fade.frame`
(the band behind it), `dock.bar.frame` (the dock and a floating system bar's
inset) and `chatInset`; `pose_check` holds every thread
shot to the dock's rule (the composer as wide as the column, a slot
that ends above the composer on a solid band, and the band of
scripts/lib/duo_band.py: the dock its parts' height, the slot no taller than
the composer, the band no taller than the dock, the bar at most 48 pt more) and, from its
`pose-<sessionId>.json`, to the pose rules (scripts/lib/duo_pose_check.py).

The fold cycle (`duo_fold_cycle`, the `duo` set's last step) runs twice,
the reader at the bottom and then 700 pt up (`TC_TEST_SCROLL_UP`): one launch
of "Add dark mode to the settings screen" on its chat, its seeded approval
undecided, the sidebar hidden and a draft typed (`draft:`), a turn streaming
into it from the test server (`POST /stream`, 120 characters a second for
90 s), then folded, unfolded (recorded to `cycle-<run>-unfold.mov`) and
folded again with the app running, four shots. scripts/lib/duo_fold_check.py
asserts from the reports, `layout-events.json` (merged every 400 ms by
scripts/lib/duo_fold_sampler.py, since the app keeps the newest 500; the
merge must reach back past the first stop), a sample of `revealedUnits` at
the same beat and `row-inits.json`: the route identical in all four; the draft
(`notes.draftChars`, the composer's UTF-16 length) the typed length in all
four; exactly one `hSize` flip, one `window` change and one `sidebar` change
(`hidden` ⇄ `stack`) per step; `revealedUnits` never decreasing, and growing
in the bottom run; at the bottom, `transcriptAtBottom` 1 and the reflow
anchored on the end after every fold; scrolled up, the same `topRow` at all
four stops with the reflow anchored on that row; no row on screen made its
state twice (`RowInitLedger`); and at every stop a solid `dock.backing` and
the dock band of duo_band.py. Before it, `duo_unfold_idle` opens each type at rest
folded, in dark, unfolds it with the app running and holds its band through
`pose_check`. The shell notes `sidebar` (`stack`,
`visible`, `overlay` or `hidden`), `sidebar.width` and `split.width` from
Home's split, the thread screen `body.frame`, and the composer `draftChars`.
scripts/ios-duo-checks.test.ts runs both checks on hand-made reports.

The glide set (`TC_PROOF_SET=glide`, `glide_set`) holds a tapped group's
glide: in each of `TC_GLIDE_POSES` (folded and unfolded) the app
(`TC_TEST_GROUP_GLIDE=bottom|up`, TranscriptView's `groupGlideProof`) taps
a multi-step group on screen of `TC_GLIDE_THREAD` (default the test
server's "Where does the gateway pick an account?", eight turns of prose
and four-read groups; the lowest group at the bottom, the highest up, so
the rows that move are on screen and not behind the dock) open and shut
three times through its own line, the reader at the bottom and then 700 pt
up, sampling every 8 ms the list's offset and content height and what is
drawn: each visible cell's presentation frame and the still images of rows
leaving (`group-glide.json`), each run recorded.
scripts/lib/group_glide_check.py (tested in scripts/ios-glide-check.test.ts)
judges the drawn frames, since the model values jump to the end of a UIKit
animation: the group's height and every row move one way in steps, none
over half its travel; for a reader up the rows above and the offset hold;
at the bottom the rows under the group hold; the group never draws over
the row under it; a row drawn before the tap stays drawn until it leaves
the list's bounds; the content height changes; no `jumpUp` once the taps
start (the reader-up run's own 700 pt scroll comes before its `glide-taps`
mark).
`TC_DUO_POSES`, `TC_DUO_KINDS`, `TC_DUO_HALF_OPEN=0` and `TC_FOLD_RUNS`
narrow a hand run. Rotation is the device's (`hinge orient`), never an
app-side hook: the app must follow the device as it does for a person.

### On the device

What the simulator cannot show, walked by hand on the Duo (`bun run
ios:device:duo` installs the Ad Hoc build; the phone pairs once with the box
through the Add host sheet, since the key is a ThisDeviceOnly Keychain item
and nothing carries over from another phone):

1. The real fold mid-thread, both ways, with a draft typed: the thread, the
   scroll end and the draft survive; no blank frame.
2. Fold with the keyboard up (folded landscape compact × compact, then open).
3. The outer display's shape: the vertical Dynamic Island column, bars on the
   side, the status bar's place; Touch ID on the side button for an approval
   tap's unlock (`tc.approval` → `session.approve`), open and closed.
4. The Live Activity in the vertical island on the outer and inner displays,
   on the outer Lock Screen and on Always On; the compact and minimal
   presentations under `isDynamicIslandLimitedInWidth`.
5. ProMotion on the inner display: the 2,000-row scroll at 120 Hz with no
   frame over 8 ms in `unfolded` and `unfolded-portrait`; `fps` in the layout
   report says what the panel offers.
6. A notification tap while folded lands on the card; the same while open.

## Threads from here

| Thread | Scope | After |
| --- | --- | --- |
| L3 shell | tokens, type glyphs, Home with Needs you, Running, Workspaces, archived rows, host grouping and status row, Inbox, Search, Settings with Hosts; thread rows; read-only | now |
| L4 thread screens | the header, segments, Chat transcript rules, Implementation board, Plan document, Fleet, Sources, diff screen; the cache paint, markdown cache and 120 Hz proof; read-only | now, in parallel with L3 |
| L5 actions | composer and working strip, send and stop, approve and answer, start a build from a plan, new thread sheet, send-to-agent, swipe archive and pin, rename, pairing | L3 and L4 |
| L6 push | APNs through the hub (the phone's token registered with every host, the host's `apns` subscription, the hub's token-auth delivery), Live Activity for a running thread (the running row on the lock screen and in the Dynamic Island, pushed by the host, ended when the thread settles), notification taps landing on the card, Approve and Deny on an approval notice, one Notifications row in Settings, the device build | landed 2026-10-20; the row's content state, the island and the notification format on 2026-10-21; the live pass needs the team id and the APNs key from the developer account |
| Duo 1 shell | the shell in every pose: the split layout, the sidebar, the thread strip, the fold transitions | landed 2026-10-24 |
| Duo 2 thread screen | the thread screen in every pose: the header, the hero views, the composer, the bars, compact × compact | landed 2026-10-24 |
| Duo 3 sheets and bars | every sheet by `SheetRules`, Settings, the Inbox split, Search, pairing, the fleet confirm, push, the bars audit | landed 2026-10-24 |
| Computer use cards | a held computer step's card in Run now and Skip with its verdicts, the `tc.run-skip` notification, a computer tool's card as its title alone, the working line in the host's words for a computer call, the Live Activity's reason for a held step; the `computer` proof set | landed 2026-11-10 |
| Computer steps, settled | a settled computer call's row in the desktop's `computerPhrase` ("Clicked button Save in TextEdit") in place of the generic MCP row ("Computer Act") | not built |
| Computer pictures | a picture the model asked for as its own transcript row, the desktop's `ComputerShotRow` | not built |
| Duo 4 toolchain and proof | Xcode 27.1 and the picker, the Duo simulator's poses under `hinge`, `TC_DUO_POSE` and the `duo` set, `LayoutProbe`, the device build, this section's frame | landed 2026-10-24 |

L3 owns `ios/TempCode/Sources/Design/` and `Sources/Shell/`; L4 owns
`Sources/Thread/` and the rendering models in `TempCodeClient`. L3 commits
`Design/` first so L4 can build on it; until then L4 works in the client
package.
