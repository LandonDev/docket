# Live Office in a Files tab

A shared Office file (.docx, .xlsx, .xlsm, .pptx in a Teams or OneDrive library) opens in its Files tab one of two
ways, his choice per file, remembered: **Edit here** (TempCode's own editor, as before) or **Word for the web**
("Excel for the web", "PowerPoint for the web"; "Office for the web" for all three, as Settings says): Office for the
web drawn in the tab, signed in as him, a real co-authoring client with Microsoft's own autosave. That is the mode's one
name everywhere (the control, its menu, Settings, asks, the Forms workbook's words), `liveLabel` in liveSwitch.ts. Plan: `.temp-code/plan-g6gWATXhCtN4.md`; trial: `.temp-code/plans/office-live/trial.md`; landing note:
`.temp-code/plans/landed/F-office-live.md`.

## Where it runs

- In his own window's process, never on the box. The window that shows the tab draws Office for the web in an
  Electron `<webview>` guest. The workspace's host only works out the file's web address and remembers the mode;
  nothing is streamed and nothing of his Microsoft session reaches the box. A live tab needs no copy and does not
  wake the Windows VM.
- The guests live in one layer on the page's body, outside React (`src/renderer/src/work/office/live/layer.ts`):
  Files draws only the tab on screen, and a `<webview>` moved in the DOM loads again (25 to 35 s for Word). Each is
  laid over its tab's body (`LiveBody.tsx` reports the rectangle), hidden when that body is not on screen or a chat
  or side file lies over it, never moved. A body can stay mounted where he cannot see it: the board parked under a
  full-screen page (`.board-parked`), a thread tab parked behind another (`.tab-parked`), both content-visibility:
  hidden with their old rectangles, or a thread's pane inert under a Work view. `seatShown` (its `checkVisibility()`
  and no `[inert]` above it) hides the guest then, once, and a MutationObserver on the classes, `inert`, `hidden` and
  styles above the body hears it at once; the guest comes back in place, still loaded, when the body shows again.
  At most three stay loaded per window; the one shown least recently goes. A guest hidden an hour with no show
  unloads through Word's own unload (`HIDDEN_UNLOAD_MS`), but never the one he looked at last: coming back to it after
  Mail or a lunch would cost Word 25 to 35 s and his place in the file. Its hour starts only once another is shown.
- A browser window (`/ui`) has no guest tag: Live there opens the address in a tab of its own.

## The fence (`src/main/officeLive.ts`)

- **Attach by ticket only.** The main window has `webviewTag: true`, and `will-attach-webview` refuses every attach
  without a ticket. The page's top frame asks `office-live:ticket` (`senderFrame` checked); a ticket names the exact
  `src` and partition, is good once and for 10 s. At attach every preload the page named goes and the guest is sandboxed, isolated,
  without Node or popups. A pop-out child window holds no ticket, so it attaches none; a guest cannot make a guest.
- **A session per tenant**: `persist:office-live-<tenant>` (`purdue0` from `purdue0-my.sharepoint.com`). Plain
  Chrome's agent, every permission refused but `clipboard-sanitized-write`, and `webRequest`
  cancels anything not https or wss, or naming this machine, a private, link-local or carrier-NAT network, a single
  label, `*.local`, or a `file:`/`tempcode-*` scheme. Downloads go through his save dialog.
- **No passkey.** Electron draws no passkey sheet, so a WebAuthn ask in a guest never settled and Microsoft's
  "passkey unlock" spun for good. A guest runs with Blink's `WebAuth` off (`LIVE_BLINK_OFF`, set at attach; the tag's
  `blinkfeatures` and `disableblinkfeatures` are dropped), so `PublicKeyCredential` is gone, and each live session
  has one session preload of ours, `out/preload/livePasskey.js` (src/preload/livePasskey.ts), that runs
  `refusePasskeys` (src/shared/work/livePasskey.ts) in the page's world before its scripts: `navigator.credentials`
  `get` and `create` with `publicKey` refuse at once with NotAllowedError, any other ask is the browser's. It
  exposes nothing and holds no IPC. Microsoft then offers Authenticator or the password. Only the live sessions get
  it; TempCode's own pages and every other webview keep WebAuthn as they were.
- **A form's ticket**, kept apart from a file's. The page asks `office-live:ticket` with
  `{forms: {tenant, formId, page: 'design' | 'respond'}}` (`FormsLiveAsk`, src/shared/work/officeLive.ts; the
  preload's `tcLive.ticket` takes it as well as a file's address). Main makes the address itself, the builder's
  (`builderOf`) or the response page's (`respondOf`, src/shared/work/msforms.ts), and issues the ticket for that
  exact `src` on `persist:office-live-<tenant>`, the tenant's Word and Excel session, so one sign-in serves both
  (`formsTicketOf`). The ask must carry those three keys and no other; the id must pass `isFormId`, the tenant
  `isFormTenant`, the page be one of the two, and the made address carry only its own query keys. So a create route
  (`Action=Create`), any other key, an address the window wrote, or a file beside the form is refused ("Only a
  Microsoft form by its id opens here."). A file's ticket takes no Forms address. Once, 10 s, the frame check and
  everything at attach are a file's. In the layer a form's guest is `show(key, {forms: …}, …)`, and its bar is ready
  when the guest stops loading with a Forms page on top (`stopped(state, top)`): Forms has no editor frame.
- **Navigation**: the first page must be a Microsoft file (`isMicrosoftUrl`) or the form main made; after that https anywhere (a school's
  sign-in). Popups stay on so every new window reaches the handler, which denies it: Microsoft's loads in the guest,
  another web page opens in his browser (one every 2 s at most). WebRTC takes no UDP but through a proxy
  (`disable_non_proxied_udp`), so it reaches no local address around the request block. A name that resolves to a
  private address passes the block; the local server's Origin rule and TLS stand behind it.
- **The local server** refuses a WebSocket whose browser Origin is not the app's (`server/originAllowed.ts`: no
  Origin, `tempcode-app://renderer`, or the dev renderer's own origin).
- Nothing in TempCode types into the guest or runs script in it; computer use refuses TempCode's windows.
- **What TempCode keeps**: a live session keeps its HTTP cache in memory alone (`fromPartition(…, {cache: false})`,
  `liveSessionOf`); at every start everything else it stored (IndexedDB, local storage, cache storage, service
  workers, file system) is cleared, and no ticket is issued until that is done. Only cookies stay, where Entra keeps
  his sign-in. `Partitions/office-live-*` is left out of the Mac
  backup (`scripts/mac/backup.sh`).
- Proof: `heavy bun scripts/proof-office-live-fence.ts` (real Chromium on the box: the ticketed guest loads, the bare
  one never attaches, no bridge or Node in it, no loopback by fetch or WebSocket, the server refuses another origin,
  no `PublicKeyCredential` and a passkey ask refused within a second, and a made-up address,
  `tc-proof@purdue.edu`, answered rather than spinning; `--shot <png>` keeps that picture).

## The address of a file (`src/main/server/work/office/live/address.ts`)

`liveAddress(library, path, {libraries})`: OneDrive's own URL namespace for the mount (the VM's and a PC's from
`UrlNamespace`, the Mac's from OneDrive's settings, `office/files/macOneDrive.ts`), else the same place on another
machine (a twin), else a folder address he gave the library in Settings → Teams files (a sharing link or a view page
is refused). The path below the mount, each segment encoded once, then `?web=1`. `cloudKey(url)` gives one key for
every form of one file, so an add-in's `document.url`, Word's `FullName` and the tab's address meet.
`bun scripts/probe-mac-onedrive.ts` prints a Mac's mounts and namespaces.

## The control and the memory

- The header gains one control before ⋯ on a shared Office file (`LiveControl.tsx`): a menu button named by the
  mode. Its menu holds Edit here and Word for the web as ticked rows, then "Open in Word on MacBook" / "in the Windows
  VM" where they exist (`work.office.filesOpen`), which act at once and leave the mode as it is. Under 480px of header
  (the `file-head` container) it reads "Here" or "Live"; its `aria-label` keeps the whole name. Until
  `work.office.live.of` answers, the control's place is kept by an unseen, disabled copy for the app the file's name
  implies (`appOfName`), so a late answer moves nothing. A missed answer keeps the last one and is asked again
  (`useLiveOf`: after `LIVE_OF_RETRY_MS`, 2, 5, 15, then every 30 s, and at once when the link opens again).
- The header's line in a live tab (`liveLine`): "In Team RecWell"; "Opening in Word…" with a 4px bar along the
  header's foot while the guest comes up (stages: the file's page, Office's editor frame, ready); "Signing in to
  Microsoft…" while the guest is on another site, never the site's address. It never says saved: Office does. A
  failure is the body's `Empty` with Retry. A guest whose ticket was refused never attached: its Retry drops it and
  makes it again where it was, asking a fresh ticket (`LiveLayer.retry`), so the press ends in the file or the reason.
- `work.office.live.of {workspaceId, tabId}` answers `{mode, address, why?, app, tenant, desktops}`. The mode is kept
  per file in `work_office_live (workspace_id, ref_key, mode, at)` by the tab's stable key, with a library default in
  `work_office_files` as `live:<libraryId>` (Settings → Teams files, "Opens in", `work.office.live.setLibraryDefault`).
- Opening: Files asks the live module first (`registerSeatChooser`, files/hooks.ts). A file remembered as Live is
  seated as `{at: 'microsoft', app, host, name, ref: {kind: 'url', url}}` (`isLiveSource`, shared/work/officeLive.ts):
  no copy, no VM wake. A live tab of another host's file keeps `copyOf` for Edit here and is not drawn as a copy.

## Switching (`office/live/switch.ts`, `live/liveSwitch.ts`)

`work.office.live.set {workspaceId, tabId, mode, typed?, choice?}` swaps the tab's item in place; the tab and its key
stay. It answers `{is: 'done'}` or `{is: 'ask', why, words}`.
- To Live: the window flushes the kind; the host waits up to 30 s for a copy still sending; a copy whose file
  changed, went, did not answer or refused asks Keep Both or Cancel; a Word document whose edits are not in the Word
  file asks Save to Teams as Word… or Cancel. Nothing is dropped quietly. Whether the document holds edits is asked at
  the switch (files/word.ts `wordsAllInFile`): what a window sent the Work service is stored first, then its live
  revision is held against the one last written to or read from the Word file, as a close asks (`wordsLeft`); never
  what the autosave saw last, which missed words typed since its last look and let the switch delete the document
  (master only, 2026-11-24, never released). A service that does not answer proves nothing: the document is kept and
  the switch asks. Only a document an older build made, with no revision, is judged by its file time. The document
  goes only if, asked again after that wait, its record and file are as they were.
- To Live, after a copy's send: the host waits up to 30 s for OneDrive on the file's computer to say it uploaded the
  bytes our send wrote (files/uploads.ts `uploadOwed`), so the web never shows the file without them. Still owed
  then, the switch is refused ("Your changes to Roster.xlsx are still uploading to OneDrive. Try Live again in a
  moment.") and the tab stays as it is. A file no send of ours wrote, or one on a computer that cannot say, waits for
  nothing.
- The host keeps the file's version as its tab goes live (`keepBase`, in `work_office_files` beside the library
  defaults, so it pins no mode): its sha256 where this host can hash it, else size and time (another computer, the
  VM; the VM asleep is never woken for it, and gives none).
- The line says each wait from his press (`switchTo`): to Live "Opening in Word…" (a copy's send first: "Sending your
  changes first…", then "Opening in Word…"); to Edit here "Leaving Word…" while the guest unloads, then "Opening it
  here…" while the host reseats. No bar while a switch waits.
- To Edit here: the window reads how much he typed (main counts keys on the guest), then unloads the guest; Word may
  hold the unload while saving (`will-prevent-unload`), so the layer waits up to 10 s, then asks "Switch Anyway"
  (`leaveForSwitch`; a close asks "Close Anyway"). Switch Anyway counts as typing (`typed` at least 1): nothing
  proves the file holds what Word had not saved, so the host must see the file move or the tab stays live and the
  guest comes back; the seat is kept. When he typed, the host waits up to 60 s for the file to differ from that kept version (by its bytes, so a restamp or a
  sync touching its time is no change), then `reseat`s it fresh. Nothing moved by then, nothing proves the file holds
  his typing: the switch is refused ("What you typed in Plan.docx has not come down from OneDrive yet, so it stays
  live."), the tab stays live and the layer puts the guest back where it was (`liveLayer.back`). A tab live from
  before its version was kept falls back to the file's time after the live view opened, on this host's own clock
  (never the VM's). Every save back is by version, so a later OneDrive change is "changed there", never a write over
  Word's edits.
- Closing a live tab follows the same unload rule (FilesView `closeOne`), and so does a guest let go past three: one
  Word still holds stays loaded. A switch to Live stops when the kind could not send what it held (`flushedItem`).
- A live item names no file, so the fence asks the office module for the one behind it (`registerItemFile`,
  `liveItemFile`): a remote key that could not name the file sees neither its tab nor its address.
- `cloudKey` gives no key for a page that names its file in the query (`_layouts`, any `.aspx`), so two files there
  never meet as one.

## Keys and menus

- Main's `before-input-event` on the guest (`forwardedKey`) stops TempCode's chords there and plays them to the
  window's page as a keydown on the tab's body: ⌘W, ⌃Tab, ⌃⇧Tab, ⌘1 to ⌘9, ⌘⇧K, ⌘, and Escape while the tab is in Full
  Window. Everything else is Office's: ⌘S, ⌘F, ⌘P, ⌘Z, ⌘B, ⌘K, the arrows.
- While a live guest has the focus the window sends `MenuState.live`: the menu drops the keys of `LIVE_KEY_IDS`
  (Find, Go to File's ⌘P, Print, Save, Export, Search, Sidebar) and turns Find, Print, Export and Save off, so
  Office's own find, print and save answer.

## Signing in (Settings → Connections)

His first Live on a computer shows Microsoft's own sign-in in the tab. `office/live/health.ts` gives one row per
tenant session on the window's computer: signed in while Entra's persistent cookie is there and in date (its end is
the row's `until`), needs him once it lapses; Sign out runs `work.office.live.signOut` (in `HEALTH_RUN_METHODS`),
which clears that session alone and is refused to every remote key, other host and thread.

## Agents in a live file

An agent changes a live file only through Office: the add-in in his live view, or Word in the VM by COM, and every
change of its own idea is the held `office.edit` that runs on his press (unchanged). `office/live/agents.ts` matches
a tool's file by `cloudKey` to the add-in session (the very key first) or the VM's open document; with no add-in, a
box workspace opens the file by address in the VM's Word, only for an address inside a library the thread may reach
(`mayOpenAddress`), and reads it there, live; otherwise the thread reads
OneDrive's synced copy and says it may be behind. A thread asked from a live tab gets an item on the same live
source (`holdFile`). Selection Ask does not exist in a live tab.

## The phone

A library Office file's facts page offers Open in Word (`ms-word:ofe|u|<address>`, `ms-excel:`, `ms-powerpoint:`),
the address from `work.office.live.address`; with no Office app it opens the address in Safari.
