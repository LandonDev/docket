# Live Office in a Files tab

A shared Office file (.docx, .xlsx, .xlsm, .pptx in a Teams or OneDrive library) opens in its Files tab one of two
ways, his choice per file, remembered: **Edit here** (TempCode's own editor, as before) or **Live in Word** (Excel,
PowerPoint): Office for the web drawn in the tab, signed in as him, a real co-authoring client with Microsoft's own
autosave. Plan: `.temp-code/plan-g6gWATXhCtN4.md`; trial: `.temp-code/plans/office-live/trial.md`; landing note:
`.temp-code/plans/landed/F-office-live.md`.

## Where it runs

- In his own window's process, never on the box. The window that shows the tab draws Office for the web in an
  Electron `<webview>` guest. The workspace's host only works out the file's web address and remembers the mode;
  nothing is streamed and nothing of his Microsoft session reaches the box. A live tab needs no copy and does not
  wake the Windows VM.
- The guests live in one layer on the page's body, outside React (`src/renderer/src/work/office/live/layer.ts`):
  Files draws only the tab on screen, and a `<webview>` moved in the DOM loads again (25 to 35 s for Word). Each is
  laid over its tab's body (`LiveBody.tsx` reports the rectangle), hidden when that body is not on screen or a chat
  or side file lies over it, never moved. At most three stay loaded per window; the one shown least recently goes.
- A browser window (`/ui`) has no guest tag: Live there opens the address in a tab of its own.

## The fence (`src/main/officeLive.ts`)

- **Attach by ticket only.** The main window has `webviewTag: true`, and `will-attach-webview` refuses every attach
  without a ticket. The page's top frame asks `office-live:ticket` (`senderFrame` checked); a ticket names the exact
  `src` and partition, is good once and for 10 s. At attach every preload goes and the guest is sandboxed, isolated,
  without Node or popups. A pop-out child window holds no ticket, so it attaches none; a guest cannot make a guest.
- **A session per tenant**: `persist:office-live-<tenant>` (`purdue0` from `purdue0-my.sharepoint.com`). Plain
  Chrome's agent (passkeys show), every permission refused but `clipboard-sanitized-write`, and `webRequest`
  cancels anything not https or wss, or naming this machine, a private, link-local or carrier-NAT network, a single
  label, `*.local`, or a `file:`/`tempcode-*` scheme. Downloads go through his save dialog.
- **Navigation**: the first page must be a Microsoft file (`isMicrosoftUrl`); after that https anywhere (a school's
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
  one never attaches, no bridge or Node in it, no loopback by fetch or WebSocket, the server refuses another origin).

## The address of a file (`src/main/server/work/office/live/address.ts`)

`liveAddress(library, path, {libraries})`: OneDrive's own URL namespace for the mount (the VM's and a PC's from
`UrlNamespace`, the Mac's from OneDrive's settings, `office/files/macOneDrive.ts`), else the same place on another
machine (a twin), else a folder address he gave the library in Settings → Teams files (a sharing link or a view page
is refused). The path below the mount, each segment encoded once, then `?web=1`. `cloudKey(url)` gives one key for
every form of one file, so an add-in's `document.url`, Word's `FullName` and the tab's address meet.
`bun scripts/probe-mac-onedrive.ts` prints a Mac's mounts and namespaces.

## The control and the memory

- The header gains one control before ⋯ on a shared Office file (`LiveControl.tsx`): a menu button named by the
  mode. Its menu holds Edit here and Live in Word as ticked rows, then "Open in Word on MacBook" / "in the Windows VM"
  where they exist (`work.office.filesOpen`), which act at once and leave the mode as it is.
- The header's line in a live tab: "In Team RecWell"; "Opening in Word…" with a 4px bar along the header's foot while
  the guest comes up (stages: the file's page, Office's editor frame, ready); "Signing in at <site>" while the guest
  is on another site. It never says saved: Office does. A failure is the body's `Empty` with Retry.
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
  the switch (files/word.ts `wordsAllInFile`): the Work service's live revision against the one last written to or
  read from the Word file, else the document's file time; never what the autosave saw last, which missed words typed
  since its last look and let the switch delete the document (master only, 2026-11-24, never released).
- To Edit here: the window reads how much he typed (main counts keys on the guest), then unloads the guest; Word may
  hold the unload while saving (`will-prevent-unload`), so the layer waits up to 10 s, then asks "Close Anyway". The
  host waits up to 60 s for the file's version on its computer to move when he typed, then `reseat`s it fresh. Every
  save back is by version, so a later OneDrive change is "changed there", never a write over Word's edits.
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
  (Find, Go to File's ⌘P, Print, Save All, Export, Search, Sidebar) and turns Find, Print, Export and Save off, so
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
