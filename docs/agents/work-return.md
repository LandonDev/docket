# A Work workspace comes back where he left it

The owner's words (2026-11-24): "I want a work workspace to come back in its same state when I leave it and come back,
wherever I was last." Leaving means another workspace, a code workspace, the Work Chats, a page above the workspaces
(Today, Review), a reload after an update, or a quit and a launch. The evidence of what was lost before, view by view,
is `.temp-code/plans/landed/F-workspace-return.md`.

## The record

One record per Work workspace, this window's own. The first paint holds its read alone, `lib/workReturn.ts` (~1.6 kB,
on the entry graph's Work list in scripts/entryGraph.test.ts); the writer is Work's chunk, `work/shell/returnRecord.ts`.

- `returnOf(workspaceId)` answers `{ view, event, thread, places }`: the column's view (`null`: a thread), the meeting
  of a prep page, the thread on screen, and each view's own place under its key. It reads storage each call.
- `keepReturn(workspaceId, patch)` (returnRecord.ts) merges and writes through; a place set to `undefined` is dropped.
- It lives in localStorage under `work.return.v1`, keyed by a window id in sessionStorage (the same rule as Files'
  `work.files.view.v1`): a reload keeps the window's own record, a relaunch (a new sessionStorage) starts from the
  window that wrote last, twelve windows at most. Nothing goes to the host: which view and which thread is this
  window's, and what is already the host's (Files' tabs and each tab's folder and Beside seat, `work.files.*`) is not
  copied.
- A view reads its place with `keptPlace(workspaceId, key, shape)` (work/shell/place.ts): only the fields the shape
  names, of their type, so a record from another release reads as nothing. `keepPlace` writes it.

## Who reads and writes it

- **Entering from the rail** (App `onSelectProject`, also Today's and search's way into a job through
  `workEnterPort`): the record's thread is passed to `landingOf` as the shown thread, so it wins the landing rule while
  it is an unarchived root of the workspace (else the rule picks as before), and after the landing the record's view
  opens (`openWorkView`). Opening the landing's tab clears any view, so the view opens after it.
- **A launch or a reload** (`ReturnHost`, work/shell/ReturnHost.tsx, mounted by WorkRailHost while Work is on): once
  the workspace the window came back on is known, its record's view opens; the thread is the workspace snapshot's
  (lib/appLifecycle.ts) as before. If he moves before the catalog names it, nothing is opened.
- **As he moves**, `ReturnHost` writes the Work workspace on screen: the view open (none while the view open is
  another workspace's, the window on its way), a prep page's event, and the focused thread when it is the workspace's
  own (`threadOf`).
- **The views' places**, read when the view's store first meets the workspace and written on each change:
  - Mail (work/mail/page.ts, key `mail`): the account, the mailbox (one of work-kit's, else the inbox), the open mail
    and whether the chat beside it is open. A mail being written is not kept: LifeOS keeps his draft.
  - Messages (work/messages/page.ts, `messages`): the open conversation and the filter; a search is not kept.
  - People (`people`): the person whose page is open; a search is not kept.
  - Tasks (`tasks`): the task whose sheet is open.
  - Agenda (work/agenda/place.ts, `agenda`): List, Week or Month, and the day when that visit was today; a day left
    on another day opens on today. Restored once a visit by whichever mounts first, the header or the view.
  - Files keeps its own already: the tabs on the host, the tab shown and the docks in `work.files.view.v1`.
  - A thread's canvas tab and fold are kept per thread already (work/canvas/store.ts `work.canvas.view.v1`).
- **Today and Review** lie over the board: closing one shows what was under it, which never left.

## When the record names something gone

Each falls back to the view's start, never an error:

- a view no release has (`WorkViewSurface` clears it to the thread);
- a thread archived or gone (the landing rule picks);
- a mail deleted (`keptMailOf`: Mail reads the kept mail once and clears it when LifeOS answers none);
- a conversation gone (`keptChatOf`: the list, not the gone state);
- a person gone (`GoneToList` in PeopleView: the list, not "Not in People here");
- a task done or dropped (the sheet closes);
- a meeting deleted (the host's "no such event": PrepView goes to Agenda, for any way in).

Only a place the record gave is treated so: a mail or conversation he opens that turns out gone shows its own state.

## Not kept, and why

- Scroll positions: the lists are work-kit's and LifeOS's, and a list he returns to has moved on.
- A search or a filter's words in Mail, Messages and People: a stale search hides rows on return.
- Mail's composer, the docked chat's thread and words: LifeOS and the dock keep them already.
- A dialog (New event, a play, a template): it is an act, not a place.

## Tests and proof

`lib/workReturn.test.ts`, `work/shell/returnPlaces.test.ts`, `work/shell/ReturnHost.dom.test.tsx`, the Tasks cases in
`work/tasks/TasksView.dom.test.tsx`. `test/domSetup.ts` clears the record after each dom test. The window proof is
`scripts/e2e-work-return.ts` (two made-up jobs, dummy files, no LifeOS): switch, reload, quit and launch.
