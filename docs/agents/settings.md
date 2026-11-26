# Settings

Settings gives every setting one home, and puts each home where its scope is plain. The plan that made it is
`.temp-code/plan-otbdp0UBLLuo.md` ("Settings 2"); the build's briefs, slice reports and council rounds are under
`.temp-code/plans/landed/SETTINGS-2/`.

## By place

The list is grouped by what a row in the group changes (`SETTINGS_GROUPS` and `SETTINGS_SECTIONS` in
`src/renderer/src/lib/settings.ts`, the headings by `settingsGroupLabel`; drawn by `chrome/SettingsRail.tsx` from
`lib/settings/list.ts`):

- **This Mac** ("This PC" on Windows, "This browser" at `/ui`): this app and this computer. Every rule about this
  Mac lives here, and nothing here changes another machine. General, Appearance, Editor, Shortcuts, Updates,
  Appshots, Computer use, Threads (`here`), Sharing, Publish.
- **Everywhere**: one set, kept on the box, read by every computer, the same heading in every window. New threads
  (`defaults`), Reviews, Subagents (`orchestration`), Away, Add-ons, Skills, Sync, AI accounts.
- **Other computers** ("Computers" at `/ui`): one page per machine (`computer:<environmentId>`), then the Windows VM
  where a computer can hold one, then "Add a computer…", a dialog. Every row on a machine's page changes that
  machine, but for its last section, "On this Mac", which is this Mac's own record of it.
- **Work**, then **Jobs**: Setup (the Work page, `work`, titled Work), Digest, Mail, Files, Connections; then each
  job (`ws:<id>`).
- **Code workspaces**: each code workspace (`ws:<id>`). **Archive** stands last, alone, under no heading.

At `/ui` This browser holds General, Appearance, Editor and Shortcuts, and Computers holds the one computer serving
the page; the pages marked `desktopOnly` are absent. A page id outlives its page's name: `defaults` is New threads,
`orchestration` Subagents, `keybindings` Shortcuts, `here` Threads on this Mac. An id a page once had (`remote`,
`environments`, `providers`) is still taken wherever a page is asked for and read as the page that holds its settings
now (`settingsPageOf`; `lib/settings.test.ts` holds every stored id, every inbound link and every page a computer can
send as `settings:<id>` to a page that exists). A page shown only where a fact holds (Publish where a release folder
holds a Docket checkout, the Windows VM where a computer can hold one) tells the list so with `tellSettingsList`
(`lib/settings/useListWindow.ts`).

## The rules every page keeps

1. **One home.** A stored setting has one control in Settings. Another page that bears on it carries an open row
   that goes there, never a second control (`SettingRow shown` for a row that only shows another page's setting).
2. **Scope by place, then by one line.** A page whose rows are all one scope says it once, under the title. A page
   that mixes scopes gives each scope its own section with the scope in the heading ("The box on this Mac", "On
   this Mac"). No row carries a chip or badge for scope.
3. **A computer has one name** (`lib/settings/computerName.ts`): where computers stand side by side each is its own
   name, the same in every window, and this window's own carries "this Mac" after it, muted (`ComputerName`). Where
   only this computer is meant it is "this Mac".
4. **No write reaches a computer the row does not name.** A page about a computer asks that computer over its own
   link (`parts/hostRpc.ts`). A setting kept the same everywhere by design (Away, Digest, Sync) says so in its page
   line and names the computers.
5. **Feedback, one contract** (`parts/useSaved.ts`, `SaveMark`): a change that stays in this window shows in the
   control at once. A change that leaves it moves the control at once; past 150 ms a 12px spinner sits before the
   control; the answer holds a check and "Saved" for 1.4 s; a refusal puts the control back to the last value the
   computer confirmed and the row's red line says why (`refusalWords`). A field commits on Enter or blur and a
   refused value snaps back (`hosts/CommitField.tsx`). A section still reading is `PageRowsSkeleton`; a failed read
   is `PageError` with Retry; a failure never stands in as a value.
6. **Nothing is offered that cannot work from this window.** A control the key may not use is words, with one line
   saying who can (`ManagedLine`). A control the platform cannot run is absent. A page never fails whole because one
   read needs admin.
7. **A restart is said** in the row's description.
8. **Lists are kept short.** Past eight rows a list gets a find field (`parts/ListFilter.tsx`); past a screen it
   opens in a sheet. Create and edit open in a dialog or sheet.
9. **Dangerous acts are set apart and ask first**: last in their section, a ghost that ends in "…", a
   `ConfirmDialog` naming what is lost or granted. A button with no "…" acts at once and is safe to.
10. **Words.** Labels are nouns, buttons are verbs, a description is one line and only where the name cannot carry
    it. The retired words are `RETIRED_WORDS` in `lib/settings/words.ts`; `words.test.ts` refuses one in what any
    file in `WORDED_FILES` shows.
11. **Design law.** `docs/DESIGN.md` wins; pages are `Page`, `PageSection`, `PageRow`.

## The map

`src/renderer/src/lib/settings/map.ts` lists every row Settings draws: `{ id, page, section, title, was, scope,
store, kind }`. A row is a `SettingRow id="…"` (`surfaces/settings/parts/SettingRow.tsx`), whose title comes from
the map, so the page, the search and the landing note say one name. A name may hold `{mac}`, `{computer}`, `{n}`
and `{version}`, filled by `settingWords`. `SettingSection of="<row id>"` draws a section under that row's heading;
where the row's `kind` is `list` the section itself is the map's row and its children are plain rows named by what
they hold (a device, an add-on).

Three things hold it true:

- `lib/settingsMapGuard.dom.test.tsx` draws each page's fixtures (`GUARDED_PAGES` in
  `surfaces/settings/SettingsPages.preview.tsx`) and refuses a row the map lacks, a row drawn on a page the map
  does not put it on, and a map entry no fixture of its page draws.
- `lib/settings/map.test.ts`: one id a row, a page that exists, no two settings of one name in a section, an old
  home for every setting that moved.
- `bun scripts/settings-map.ts` prints "where each old setting went" from the map, for the landing note.

## Two-instance proof

On the box, run `.temp-code/bin/heavy bun run build` from the proof worktree, using the main checkout's
`heavy` script if it is outside the worktree. Then run `heavy bun run journeys --only J-computers`.
The journey opens the built app with two fresh profiles under Xvfb. It reads each instance directly
after changing the box's Threads fields and making a device sign-in link. It then swaps the desktop's
key to check the read-only page, restores admin, checks Away against the rail and the box, and confirms
that turning Work off affects only the desktop. The runner logs each result and checks that both
instances and their listeners stop before removing their profiles.

## Search

A 28px field over the list ("Search settings"; ⌘F while Settings is open). Typing replaces the page with results
(`lib/settings/search.ts`, `surfaces/settings/SearchResults.tsx`): a setting's name with "Group, Page, Section"
under it; a page's own name first; an old name answered with the new home and "Was “…”". An old page name ("Hosts")
finds the pages it became, not every row that once stood on it. A row that exists once per computer, job or
workspace is listed once for each, which shows its scope. ↑ and ↓ move the highlight, Enter opens the page
scrolled to the row, Escape clears the field and a second Escape closes Settings.

`requestSettings(page, row)` (`lib/monaco/debugTab.ts`) opens a page at a row from anywhere: the page scrolls to
`[data-setting=<row>]`, opens the `Fold` it sits in and holds a `muted` fill on it for 900 ms
(`lib/settings/reveal.ts`).

## The parts

Under `src/renderer/src/surfaces/settings/parts/`: `SettingRow` and `SettingSection`; `useSaved` and `SaveMark`;
`hostRpc` (`useHost`, `hostRequest`); `ComputerName`; `ManagedLine`; `Fold` (the one disclosure, "Advanced");
`ListFilter` and `useListFilter`; `Permissions` (the two macOS grants: Computer use lists both, another page shows
one only while it is missing). "Add a computer…" and a sign-in list's "Add…" are one dialog, asked for through
`openAddComputer` (`lib/settings/addComputer.ts`).

## The pages: This Mac

The pages about this app and this computer. Nothing on them changes another machine. A row kept in this window
(localStorage) moves at once and has no save mark; a row that asks this computer saves through `useSaved` and goes
back on a refusal, its reason under the row.

- **General** (`surfaces/settings/General.tsx`). Transcript: Keep my prompt at the top (`docket.transcriptAnchor`).
  Composer: Enter while a thread is working, Steer or Queue (`docket.midTurnDefault`); Model picker shows, an open row
  naming the agent apps shown, opening a dialog of a switch per installed app (`docket.hiddenPickerProviders`,
  `PickerRow` in PickerSettings.tsx; absent once the computer says it has none). Sounds and power: Sounds
  (`docket.sounds`); Keep this Mac awake ("this PC" on Windows; `power.status`, `power.settings.set`; absent where
  the computer says it cannot, and at /ui). Inbox: Linear, "Connected on this Mac" (the computer that keeps the key,
  by its one name), Connect… opening the key's dialog, Disconnect… asking first; Linear teams in the inbox, "1 of 2",
  opening a dialog of switches (`docket.linearHiddenTeams`). The version left for Updates.
- **Appearance** (`Appearance.tsx`). Theme: Code and Work, or one row Theme while Work is off everywhere. Size and
  motion: Text size, the app's zoom from 50 to 200% in tens (`docket.zoom`, lib/zoom.ts, the key the View menu's
  three items write; the row follows the menu while open by the resize a zoom makes, and another window by the
  storage event); Editor text size; Motion.
- **Editor** (`Editor.tsx`). Saving: Save as I type, Format Java and Kotlin on save, Format TypeScript and JavaScript
  on save. Suggestions: Inline suggestions. Other editors: Open files in (saved through main's editor setting, its
  line saying what Auto opens; desktop only). Java on this Mac: JDK and IntelliJ engine, each line ending with what
  its language server runs for and the memory it holds (`serverWords` over `lsp.status`, read every 5 s), a server's
  failure as the row's red line; Read the licence… opens the JetBrains licence, Check for update once accepted.
- **Shortcuts** (`Keybindings.tsx`, page `keybindings`). Find a shortcut narrows every group. From any app: Open
  capture (`CaptureKeyRow`, work/capture/, on a desktop with Work on for this computer; `<userData>/capture.json`)
  and Appshot, the double ⌘ (a Mac's alone), "Turned on in Appshots". Then `KEYBINDING_GROUPS` (lib/settings.ts),
  with Find a setting under App and the old Hosts group named Computers.
- **Updates** (`Updates.tsx`, page `updates`, desktop only). Docket and its version with the updater's one button;
  Release notes; Quick updates from (`code.settings.*`, docs/agents/code-only-updates.md). Other computers: one open
  row per linked computer with its version and how far behind master (`useDeployDrift`), opening its page at
  `pc.version`; a computer that is behind ends its row in Update…, the same confirm as its page's
  (`useComputerUpdate`, computers/update.ts), in place of the chevron.
- **Appshots** (`surfaces/AppshotsSettings.tsx`, Mac desktop). Appshots, Add the window to, Shutter sound (`appshots.*`
  through lib/appshots.ts); a macOS grant only while it is missing (`Permissions missingOnly`).
- **Computer use** (`Computer.tsx`, Mac desktop; "Available on a Mac" in a window elsewhere). See docs/LAYOUT.md
  "Settings → Computer use".
- **Threads** (`here`, `computers/ThreadsPage.tsx`): the shared Threads rows ("The pages: computers"), Agent apps, and
  Simulators and phones (`Devices.tsx`) on a Mac that has them: each device's line its OS and state, "In use by “a
  thread”" opening that thread, and a simulator's Shut down and Delete… in a ⋯ menu always in view.
- **Sharing** (`sharing`, `computers/SharingPage.tsx`): Who can sign in to this Mac; "What other computers may do on
  this Mac", one open row per linked computer with what it may do (`mayHereWords`); Advanced, with Pause other
  computers' commands above load (`LoadRow`).
- **What <computer> may do on this Mac** is one sheet, its one home (`computers/MaySheet.tsx`), opened by
  `openMaySheet(id)` (`lib/settings/maySheet.ts`) from Sharing, from Computer use's "Who may use this Mac's apps" and
  from a computer's On this Mac; `MaySheetHost`, mounted by SettingsView, hears the ask. A search result for one of
  its rows opens it (`inMaySheet`, `SearchResult.computer`). In order: Files and commands, a `RadioGroup` of the four
  levels each with its line (lowering it asks first only when it ends something, naming what as the server ends it,
  `whatEnds`: Off and Read end its commands, Off its live app sessions too); Use this Mac's apps
  once above Off (on asks first; off asks while sessions are live); its dev sites, with each forwarded site and Open;
  its commands, threads and apps at once, the commands and apps counted from the list Running now draws (`nowWords`), so
  the two never disagree; the folders it reads without asking, Add folder… opening a dialog that names the computer;
  Running now with Stop; Allowed until Docket quits, in its shape while read and one line with Retry on a failure. The
  computer is said mid-sentence ("What the box may do on this Mac"). Every control is this Mac's own (`macBridge.*`,
  `ports.*`).
- **Publish** (`publish`, `computers/PublishPage.tsx`; `usePublishKnown`, mounted by SettingsView, tells the list):
  its own read (`host.publishStatus`) holds the two rows in their shape and says a failure once with Retry; New release
  with Publish… (its dialog is the confirm); while it runs the row says "Publishing 1.0.N…" and its press is Stop…,
  which asks first (the release is left half made); Release folder, drawn once read; the job's log (`JobLog.tsx`), with
  no Stop of its own.

## The pages: computers

One page per other computer and the Windows VM, under `surfaces/settings/computers/`; this Mac's Threads and
Sharing are drawn from the same sections. Each section asks the computer it is about over that computer's own link
(`useHost(environmentId)`, `useComputerRead` in `read.tsx`) and reads on its own, so one read a key may not make never
fails the page: a key that may only read sees the values it may read as words and one `ManagedLine`. Every change runs
through `useSaved`.

- **The shared sections**, by environment id and the map's prefix (`here` on this Mac's pages, `pc` on another
  computer's): `ThreadsRows` (Threads at once with "118 of 120 running, 7 waiting" and what the default is sized from on
  hover, `admission.*`; Tell me a thread is stuck after, `remote.status` and `remote.settings.set`, left out for a key
  that cannot read it; Largest attachment, `attachment.settings*`); `AgentApps` (`doctor.get`; the apps it has, Update
  only in the computer's own window, `providers.update`; the rest behind one row, "7 more you can install", whose sheet
  holds each command behind Copy); `SignIns` ("Who can sign in to <computer>":
  keys, browsers signed in and waiting sign-in links in one list, the links first, then by kind and name, a find field
  past eight; each device's line its kind, what it may do in the plan's words (`mayInLine` in `words.ts`) and when it was
  last used; Remove… asks first and says when it is the last device that can manage the computer; Cancel the link acts
  at once; Add… calls `openAddComputer({ way: "device", computer })`, offered only once the list was read; a key that
  may not read it sees the heading and "Listed on a computer that manages the box"); `Advanced` (a `Fold`: Let other
  devices reach <computer>, Port and Web address, which ask first where the page reaches the computer through that
  listener (`travelsThrough`: every page but this Mac's own Sharing); Computer ID behind Copy).
- **Another computer's page** (`computer:<environmentId>`, `ComputerPage.tsx` `OtherComputerPage`): the line under the
  title is `ComputerLine` (connected, where; offline, when last seen, with Try again on the title line; a key it no
  longer takes, Sign in again…; a key that may not change it adds "Its settings are changed from a computer that
  manages the box."). The page's first read (`admission.get`, any key) stands for the computer: while it is out the
  title line and the version are bones; failed, the page says "The box did not answer." once with Retry
  (`ReadFailure`), its title line claims no connection, and only On this Mac stays. Threads and Sharing are held the
  same way by `ComputerGate` (computers/read.tsx): one line for a silent computer, no section under it. Then
  Docket <version> and how far behind, Update… asking first (it restarts; its running threads pause about a minute)
  with the update's log; Threads on <computer>; Agent apps; Who can sign in; Work, under its heading, "Work on the box",
  On or Off, opening the Work page at its switch (`work.on`), the switch's one home; Set up from this Mac for a
  computer set up with a link (`SetUpHere.tsx`, its line "Stop and Remove are done from this Mac.": what it was given
  with Stop… or Start, then "This Mac's setup of it" with Remove…; its shape held while read, a failure said with
  Retry); Advanced; On this Mac: What <computer> may do on this Mac (the sheet, opened only once the policy is read),
  Name (a field, `remote.environments.update`) and Addresses this Mac tries (`RoutesDialog`), held in their shape and
  said once with Retry on a failure ("This Mac did not answer."), and "This Mac's link to the box" with Forget… (asks first; this Mac drops its link and the
  computer still lets it in until removed there). At /ui the one computer is the one serving the page: no version and
  no On this Mac.
- **Windows VM** (`winvm`, `Winvm.tsx`): the computer the list names (`useWinvmKnown`, mounted by SettingsView, asks
  each computer with Work on and tells the list `vmOn`, so the row sits under that computer). Windows with its one
  press; Sleeps after; Screen size (Fits my window, or a size; Fits my window where live resize is off asks first and
  turns it on); Picture quality; Restore points, a dialog where Go back… and Delete… ask first. While its state is read
  it stands in as many rows as will land. Its sign-ins and its
  edition's end are Connections' rows alone. The Work page no longer has it.

The preview (`SettingsPages.preview.tsx`) answers per computer: `<environment id>:<method>` answers first, a fixture
sets each computer's link (`statuses`: open with an admin hello, offline, or a key's caps), and the fixtures
`computer-box`, `computer-box-offline`, `computer-box-key`, `computer-pc`, `here`, `sharing`, `sharing-may`, `sync`,
`publish`, `publish-running` and `winvm` are the pictures.

## The pages: Everywhere

One set each, kept on the box and read by every computer (docs/box.md "Orchestration rules and thread defaults: one
copy, on the box"). The line under the title says where, from the `home` the page's own store answered
(`everyLine` in `lib/settingsHome.ts`): "Saved on the box, for every computer."; the box out of reach, "The box is
offline. These are as last saved." with every control held and every act that cannot work (Add…, New skill…, Add
rule…, a row's ⋯, Docket's defaults) not offered; no `home`, so this computer keeps its own copy, "Saved on this
Mac."; before the store answers, or when it could not, "For every computer.", so the line never comes or goes. The
box is named as this window names it (`useComputerNames`, matched by the name the store gave). A page tells the frame
its home with `usePublishHome` (`lib/settings/pageHome.ts`), and `HomeLine` (`parts/HomeLine.tsx`) draws it where
`SettingsView` puts a page's line, so nothing is read twice. A page's loading state stands every section under its
heading in its rows' shape, and a failed read is one red line with one Retry. Every control saves at once through `useSaved`; a set saved
whole (New threads, Builds from plans, Reviews) shows the change through `useDraft` (`parts/useDraft.ts`) and puts back
the set the computer last confirmed on a refusal.

- **New threads** (`ThreadDefaults.tsx`, page `defaults`; `chrome/ThreadDefaultsDialog.tsx`,
  `chrome/PlanSettingsFields.tsx`). Start with: Agent app, Model ("Default" is the app's own), Effort (only for a
  model with a ladder), Access with its level's line (`lib/settings/access.ts`; choosing Full access asks first),
  Linked projects start on (with two or more computers), "Different in N places", an open row listing the jobs and
  workspaces with a set of their own, opening a dialog with Use New threads beside each; last, while a set is stored,
  Docket's defaults with Use…, asking first. When both of the page's reads fail, one line (`ReadFailure`) says so, naming the
  computer, with no heading over it and nothing under it, and its Retry asks both. Use New threads (the dialog's footer
  and each row of "Different in N places") is offered only to a key that may write that place's set, and asks first
  when it would give the place Full access. Builds from plans: Start the build when a plan is done, Archive
  the plan's thread once the build starts, Build model (a searchable list, `ChoiceCombobox`), Build effort, Build
  context. A job's or a workspace's own set has one editor, `ThreadDefaultsDialog` (`workspace`, `onClose`): its rows
  save as they change, its footer has Use New threads while the place keeps a set, else "Same as New threads", and
  Done. The Work page's `JobThreadsDialog` draws a job's set with `ThreadDefaultsEditor workspaceId`.
  The dead "settings.json hooks" switch is gone, and `docket.claudeHooks` is one of the keys cleared at boot
  (`RETIRED_KEYS`, lib/appearance.ts).
- **Reviews** (`surfaces/ReviewSettings.tsx`, `chrome/ReviewFields.tsx`). Review before merge; while on: Review model
  (a searchable list grouped by agent app), Effort, Stop the merge for, Wait at most ("Past it the merge goes ahead
  unreviewed", a field that commits on Enter or blur), and "Different in N projects", asked of each code project's
  own computer (`review.get` per project), shown with Reviews off too, opening a dialog of them, each row opening its
  project sheet; a computer that did not answer leaves the count partial, said by its name with Retry. The project
  sheet draws the same fields (`compact`) under its own Save. The open row says which projects have reviews off ("settings-2
  has reviews off") and which keep their own review model; each of the dialog's rows says the same.
- **Subagents** (`Orchestration.tsx`, page `orchestration`; `chrome/OrchestrationRules.tsx`). The lead thread: Gives
  its agents (Everything, Everything but small tasks; a set saved as `free` keeps that value by its own name), May edit
  files itself, May run commands itself, Checks its agents' work, Retries with a stronger model, Gives each agent its
  own checkout. Limits, "For each thread." once under the heading: Agents at once, Agents in all ("No limit" for
  none). Models: Models agents may run on, "N of M allowed", opening a `Sheet` with a find field past eight, one table
  grouped by agent app (each app by its own name, "Claude Code"), Who may start it (Everyone, Lead threads only, Off)
  and the lowest and highest effort, each model's save under its name. Which model gets which work: the rules in order,
  each opening its dialog (When the task is, Agent app, Model, Effort, Use this rule; Delete… asks first; a refused
  save keeps the dialog open with the reason), Add rule… at the heading's end, and each row's ⋯ with Move up and Move
  down, since the first rule that fits decides (a lone rule's row ends in its chevron). Last on the page, while a set is
  stored, Docket's defaults with Use…, asking first (it deletes every rule). A code workspace's own set is the same
  editor whose last row is its own set with Use Subagents….
- **Away** (`Away.tsx`, page `away`). Code threads; Work threads while some computer has Work on; each on the one store
  the rail reads (`lib/away.ts`), so a flip on the page is what the rail shows, with one `away.set`. The page asks
  `away.get` itself, so it shows bones before an answer and the one line with Retry after a failure, never Off; a key
  that may not approve sees On or Off as words; the switches' line names the computers it holds for. A refusal puts the
  switch back with the store's own toast. Last time away, once a stretch away has ended: "Ended 6:40 PM, 3 decisions
  made for you", every computer's tally, opening Back from Away's list (`chrome/AwayReviewDialog.tsx`); a stretch with
  no decisions says so and opens nothing.
- **Add-ons** and **Skills** (`addons/AddonsPage.tsx`, `skills/SkillsPage.tsx`; docs/LAYOUT.md "Settings → Add-ons and
  Skills"). One list each, a find field past eight rows (`ListFilter`); the dialogs say the glossary's words (Connects
  by, Secret names, Request header names, Name for the sign-in token, Computers; Agent apps on a skill) and "Where"
  names the store ("Every workspace, on the box"); Sign out… and the key dialog's Clear all… ask first. A row says its
  state in the house's words ("Connected", "Not connected", "Needs a key", "Sign in needed"), "key saved" or "signed
  in", never a secret's or a header's name; a row for every workspace says no scope (a workspace's own row names it);
  Off is the switch's to say. A skill's description takes two lines before it is cut. A key that
  may not write (`addons.set`, `skills.set` need admin) sees the list with no switch, ⋯ or verb and one `ManagedLine`.
  Search finds an add-on or a skill by name (`addonNames`, `skillNames` in each page's store hook, `searchNames` in
  `parts/searchNames.ts`): the page sets them as it reads, and search asks once, inside Settings.
- **Sync** (`sync`, `computers/SyncPage.tsx`, desktop only, shown with two or more computers): the line under the
  title names the computers this Mac keeps the same (`SyncLine`, drawn by SettingsView, a bone in its place while it
  reads); Agent settings (turning it on asks first, naming each computer that receives them) and Agents' memory; Last
  synced, a row per computer, one sentence ("212 agent settings files and 48 memory files, synced 2m ago",
  `syncedWords`) with Sync now; Conflict copies, "1 note differs. Both copies are kept.", an open row to a dialog only
  while there are any. While the read is out the switches and Last synced stand in their shape.
- **AI accounts** (page `accounts`). The Accounts page (`@aliax/pages`, DOCKET's) in its own chunk, changed in nothing,
  and after it, in its column, one open row, "LifeOS, Office and Google sign-ins", to Connections
  (`AccountsFoot.tsx`), while some computer has Work on.

## The pages: Work

Work's own pages, shown while some computer has Work on; the Work page stays while Work is off everywhere. Each
loads from a chunk of Work's (`work-settings`, `work-digest`, `work-mail-settings`, `work-settings-files`,
`work-connections`); nothing of Work rides the entry chunk. Their fixtures are in `SettingsPages.preview.tsx`
(`work-off`, `work`, `work-given`, `work-grants`, `work-tools`, `work-confirm`, `digest`, `digest-given`, `mail`,
`mail-loading`, `mail-down`, `files`, `files-guests`, `connections`, `connections-loading`, `connections-refused`),
each page in `GUARDED_PAGES` and each file in `WORDED_FILES`.

- **Setup**, titled Work (`surfaces/settings/Work.tsx`; the rest in `work/shell/WorkPage.tsx`). Work is on for
  (`work.on`, the section another page's "Work" row lands on): one row per computer this window reaches, by its one
  name, with its own switch, which stands only once that computer has answered `work.get` on this page (a bone
  meanwhile; reads that failed are one line over the rows with one Retry). A press writes `work.set` to that computer and no other (Work.dom.test.tsx presses every
  control on the page and counts the computers each press wrote); off asks first (`workOffAsk`: "The Outbox, Work
  Chats and its jobs leave the list on every device. Nothing is deleted"). A computer the key may not switch shows On
  or Off in words and who can ("Changed from a computer that manages PURDUE-LT"); one not linked now says Offline.
  Then, while Work is on somewhere: Access for each job's new threads, one open row per job (its dot, its name, the
  access its new threads start with; the level most jobs share is said once with its line under the heading, a job on
  another level says its own, `lib/settings/access.ts`; the jobs' sets read together, a failed read one line with one
  Retry) opening the job's New threads in a dialog (`JobThreadsDialog` around `ThreadDefaultsEditor`). Without asking you: Things threads may send on their
  own, the standing grants in a sheet (`work/shell/WorkPageSends.tsx` `GrantsRow`: read from and removed through
  `work/outbox/store.ts`, each from the computer that holds it; a find field past eight; "Made from a held item in the
  Outbox, under More ways to send"); What each add-on's tools may do, a sheet of each computer's `work.outbox.rules`
  with Runs, Waits for you or Off per tool (a tool not chosen for shows Waits for you, which is what the host does
  with it, and says "Not chosen yet"), each written to its own computer by `work.outbox.setRules` (the phone had
  this alone); While you are away, an open row to Away at `away.work`. Travel: Start addresses, a dialog listing Home
  and each job (`work/clashes/StartPlaces.tsx`), each place opening its own. On this Mac: New jobs are made on, with
  two or more computers on (`work.home.v1`, this window's). The read-only Sectors list is gone.
- **Digest** (`work/digest/SettingsSection.tsx`). One set for every computer with Work on, by design, as the page's
  line says, and its first section's line names them ("Kept the same on the box and this Mac"): a change is written to
  each, and those that refused are named under the row. The day's digest: Arrives at, a select of quarter hours in
  12-hour words (`timeChoices`, `clock12`), with the zone it follows under it (`zoneWords`: "this Mac's" where it is
  this window's zone; the host keeps the zone of the desktop he used last, not which desktop). Tell me about: Things
  waiting for me, Routine results, Messages and mail, Meetings. Open the digest stands on the title line. A row moves
  at once and goes back when every computer refuses; a key that may set none sees the values in words and who can.
- **Mail** (`work/mail/MailSettingsSection.tsx`). Mail's settings drawn through `PageSection` and `PageRow` over
  work-kit's mail client (`useMailClient`'s settings hooks), on the LifeOS session of the computer new jobs are made
  on: Writing (New mail goes from, Replies go to, Undo send), Reading (Pictures from the web; Pictures always show
  from, a dialog of senders while pictures ask; List rows; Mark as read), Signatures (each opens a dialog with
  work-kit's `MailEditor`; Delete… asks first; New signature… on the heading), Accounts (each opens a dialog: Name,
  Job, the signature each address takes, Notify me; its row names signatures in quotes, `accountWords`). Without asking you: the same grants sheet the Work page opens.
  A down session is the page's one line (`LifeosLine`). work-kit's own settings screen stays LifeOS's; its pin is
  unchanged.
- **Files** (`work/shell/WorkPageFiles.tsx`, the sections in `work/office/TeamsFilesRow.tsx`). Folders on
  <computer>: a section per desktop computer with Work on, and Folders in the Windows VM for a computer that keeps
  one (`vm`: the guest's libraries). Only that computer's own window changes its list; another's rows are words with
  "Changed in Docket on <computer>". Every row's one control is its switch; the heading's line says what on means and
  where most libraries' Office files open, a library that differs saying its own; a library's row opens a dialog for
  where its files open and its web link; a folder he added leaves the list from its ⋯ menu (Stop listing); Add
  folder… on the heading; a find field past eight. Guests: Shared with guests, "3 links. The next ends Dec 2" (a
  failed read is its line with Retry on the row), the list in a sheet with a find field, each live link's ⋯ menu
  holding Replace address… and Revoke…, both asking first, an ended one saying Revoked or Ended
  (`work/guests/GuestLinksSection.tsx`). On this Mac: Word files save to
  Teams (`tc.work.wordSave`).
- **Connections** (`work/connections/`, docs/agents/work-connections.md). A page of states and fixes per computer; the
  heading over computers that could not be checked reads Computers, and the Windows VM's row stands under it. With
  two computers listed a LifeOS row names its computer in its title ("LifeOS on this Mac") and its line says the state
  alone ("Not signed in"). A date says whose end it is (`lapseWords`: Licence ends, Sign-in ends); a fix that opens a
  dialog or asks first ends in "…" (`fixLabel`). A sign-out asks first, naming what stops working
  until the next sign-in (`signOutAsk`); a paired Office add-in's Remove… asks first (`work/office/AddinRow.tsx`); a
  shell command a computer puts in a row's line rides Copy the fix (`commandOf`). A computer may send a fix to
  `settings:work`, `settings:remote`, `settings:connections`, `settings:files` and `settings:winvm` (`HEALTH_PAGES`,
  src/shared/work/health.ts); a Teams folder that is gone sends its Edit to Files.

## The pages: jobs, workspaces, Archive

A job and a code workspace each have a page (`ws:<id>`); its line says where it is, "Purdue, on the box" or
"~/work/temp-code, on the box" (`workspaceLine` in `surfaces/SettingsView.tsx`, the computer as it reads mid-line).
Every row on them changes that job or workspace alone, on its own computer.

- **A job** (`WorkWorkspacePage`, `work/shell/JobSettings.tsx`, in Work's chunk). Computers its threads may use:
  one row per Mac or Windows computer by its one name (`jobDesktopName` in `lib/settings/jobComputers.ts`, the same
  in a Mac window, a linked window and the box's web page), a switch each (`work.workspace.set {mayUseDesktop}`, host
  ids). Where the job allows a computer that itself refuses the job's computer (that computer's Files and commands
  for it are Off: this Mac's own from `macBridge.policy.get`, another linked computer's from its
  `macBridge.activity` where the key may read it; one this window has no link to says nothing), an amber line under
  the row names the machine, under "Allowed for this job" (the switch's own state): this Mac's ends in Open Sharing
  (Sharing with what the job's computer may do on this Mac open over it), another's says to change it on that
  computer. The page hangs on one read (`useJobRead`: the job's settings, the desktops its computer knows, this
  machine's host id), and on this computer having said its name (`useOwnComputerNamed`): until then every section
  stands as its heading and its rows' shape; refused, it is one `ReadFailure` naming the computer ("The box did not
  answer.") with one Retry, and nothing under it: no heading, no bones. Then Windows VM (where the job's computer has one) and Copy Teams files to
  <computer> (`TeamsCopyRow`; off asks first, it deletes the copies). New threads: Model and access, "Set for this
  job: …" or "Same as New threads: …" with Change… opening the start set's dialog (`StartSetRow`,
  `surfaces/settings/parts/StartSetRow.tsx`). Rules and Proposed (`work/rules/HouseRules.tsx`). Writing and mail:
  Learn how I write from my sent mail (`VoiceRow`), Count sent mail as unanswered after and Draft nudges by themselves
  (`WaitingRows`, `work/mail/WaitingSection.tsx`). Every switch and select saves through `useSaved`; a refusal is put
  in his words first (`inWords`, `lib/settings/workWords.ts`). A key that may not write the job's settings reads each
  computer as "Allowed" or "Not allowed" with one line saying who can, and sees no Writing and mail. A key LifeOS could
  not make for the job is one red line at the top. Tests: `JobComputers.dom.test.tsx` (the names, the amber line,
  Open Sharing, the write), `JobSettings.dom.test.tsx`, `lib/settings/computerName.test.ts`.
- **A code workspace** (`WorkspacePage`, `surfaces/settings/Workspace.tsx`). New threads: Model and access (the same
  `StartSetRow`, "Set for this workspace: …"); Rules read before the first message, "214 words, on" or "None", Edit…
  opening `PreambleDialog` (until now only in the rail's menu). After each turn: Run the checks, Make a fresh build,
  Commit (`TurnPassEditor`, `chrome/TurnPassFields.tsx`; a refusal puts back what the host last confirmed). Accounts,
  one row per agent app. Build: Command and What it makes (`BuildEditor`, `chrome/rail/buildSettings.tsx`), fields
  that commit on Enter or blur. Subagents: Rules for its agents, "Same as Subagents" or "Set for this workspace",
  Change… opening the Subagents editor in a `Sheet`, whose title line holds Use Subagents… (asks first: the
  workspace's own set is deleted). Its job (`CodeWorkspaceSector`, Work's chunk, passed in as `job` while Work is on
  for its computer): Job, the LifeOS job its threads may read. Projects, a find field past eight, each an open row to
  its sheet, ending in a chevron. An agent app with no account to pick reads "Auto, no other account to pick" and opens
  AI accounts. Accounts are their own read (`useAccountsRead`, `parts/useAccountsRead.ts`): bones until the computer
  answers, then the true value, never the store's empty snapshot standing in. The page hangs on one read, After each
  turn's (`useTurnPassRead`): until it answers every section stands in its shape; refused, it is one `ReadFailure` and
  nothing under it. A key that may not change the page's admin rows (`turnpass.set`, `build.set`, `workspace.setAccounts`,
  `workspace.setPreamble`, `rules.set`, `defaults.set`) reads their values as words, and one line under New threads
  says who can.
- **The project sheet** (code; `ProjectSettingsBody` in `chrome/ProjectDialogs.tsx`, opened from a workspace page's
  Projects and from the rail). Each group waits for its value: After each turn and Build hold their rows' shape until
  the host answers, and a failed read is a red line with Retry, never an empty value that a Save would write. Its
  choices are `FieldRow`s like the sheet's others (`TurnPassFieldRows`). A key that may not save a group (`turnpass.set`,
  `review.set`, `plans.set`, `project.setStartOn`, `build.set`, `project.setAccounts`, all admin) reads it as words, and
  one line under the name says who can (`managedElsewhere`); the name and branch stay its own. Save writes each
  changed group on its own: one refused leaves the rest saved, and the line over the footer says which did not and
  why, then which did ("After each turn did not save: Disk full. Name saved.", `partialSaveWords`). Cancel, Escape and
  the close button ask before dropping a changed draft. Save waits until every group has answered; a group that did
  not is said in its place by a `ReadFailure` (the sheet keeps its own `FailuresSaidOnce`, so groups one computer did
  not answer are one line), and the footer says "Only what loaded is saved". When every group fails, one line heads
  the sheet with one Retry that asks them all, and no group is drawn. Each group's bones are drawn as its `FieldRow`s
  (`FieldBones`: no hairline; Plans two switches and three selects); Accounts read their own state
  (`useAccountsRead`), and an agent app with no account to pick says its value as words.
  Use workspace setting and Use global setting sit at the end of their group's heading line. A project's account
  that follows the workspace reads "Same as the workspace (Auto)", the workspace page's word. A red line is in the house's words (`refusalWords`; DOCKET's
  `dialogErrorWords` once it lands). Tests: `chrome/ProjectDialogs.dom.test.tsx`.
- **Archive** (`surfaces/settings/Archive.tsx`). Projects (this window's archived folders, Restore and Remove…);
  Threads, asked of every computer by the page itself (`session.list {archived: true}`, each page of it), so "No
  archived threads" is said only once every computer answered none and the search covers them all; each row reads
  "<project>, <date>", and "<project>, on <computer>, <date>" only while the rows are on more than one computer. Restore
  and ⋯ stand on every row at rest; the search field stands while the lists are read and after a refusal; Retry asks
  only the computer it names again. A computer still answering holds the list's shape; one that did not answer is a
  red line naming it, with Retry, the others' threads still listed. A thread restored or deleted here leaves at once;
  one restored in another window leaves by the store's word. "Show more" past a hundred. The old "Archived in the
  sidebar" switch is gone (the sidebar's shelf keeps its own state in `docket.sessionSidebarFilters`).

## The phone

The phone's Settings (ios/TempCode/Sources/Shell/SettingsView.swift; docs/IOS-DESIGN.md wins there) keeps its pushed
inset-grouped list and takes the desktop's words, not its structure. Its root: Computers, then Work (a placeholder
row while a computer is still answering `work.get`, gone once none knows Work), Away, Notifications, Appearance, and a
plain Diagnostics row with the version under it. Away (`AwaySettingsScreen`) is a section per computer with Code
threads and, while Work is on there, Work threads: the host menu's own switches (`away.get`, `away.set`), one
computer a flip. Every settings screen says the glossary's words (Computers, Sign In Again, Forget This Computer, It
may with the key's one level checked, Effort, Stop the merge for, Learn how I write from my sent mail, Things waiting
for me, Agent settings and Agents' memory, Update…), from `SettingsWords.swift` and `HostPresentation.swift` in the
client package. Digest's footer says "One set for every computer with Work on."; the device check says "This phone".
A section still reading holds its rows' shape (`SettingsPlaceholderRows`); a computer's connection is one of the
desktop's sentences (`ConnectionSentence`), never the host's raw error; New Address… asks first.

## What Settings does not do

These wait for the owner: the settings the app keeps but shows nowhere (the plan's section 6); one Access for all
Work threads that jobs follow; a review that must finish before a merge; a desktop switch for "For Work" on a global
add-on (the host has the method, no client calls it); whether Publish belongs in Settings at all; whether the
read-only Sectors list should come back anywhere. Not built: Input Dissolve on key fields; a switch per computer for
sending agent settings (Sync has one for all); the digest's four unshown groups on Digest; "Add a job…" in the list;
a notice setting for code threads; the phone's End Show confirm; a press that turns the Windows VM's live resize off.
