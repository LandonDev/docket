# Work: capture from anywhere

A thought, a link, a file or a mail reaches the right job in a few seconds,
from wherever he is, without opening a workspace first. Built 2026-11-20
(landed/F-capture.md). LifeOS stores it, LifeOS's own bot files what he left
unsorted, TempCode does the work; TempCode calls no model to sort a capture.

## What a capture is in LifeOS

A capture is his own quick add, written on the host's LifeOS session as the
owner (work-lifeos.md), never an agent's write:

- **In a sector he picked:** a task in that sector whose source is
  `{kind: 'manual', container: 'quick-add', channel: 'Capture', messageId:
  'capture:<key>'}`. LifeOS's guide (apps/worker/src/mcp/guide.ts, docs/BOT.md)
  lists "Capture" with "Typed", "Siri", "Shortcut" and "Link": his own words,
  not rewritten or moved.
- **Unsorted:** the same in Life with channel `Unsorted`. The guide tells the
  bot to move it to the sector it belongs to and give it the due date its
  words name. Life is where it waits because LifeOS has no sectorless task,
  and a dictated task already waits there the same way.

The first line of what he typed is the title (cut at 200 characters, the
whole line kept in the notes); the other lines are the notes; a line "Kept in
<workspace>: <names>" names the files. With no words, the first file's name
is the title. `QUICK_ADD_VIAS` in LifeOS's `@lifeos/shared` and the Swift
`QuickAddVia` list both channels.

## The host: the capture pillar

`src/main/server/work/capture/` (pillar 53, `PILLAR_IDS`), wire in
`src/shared/contract-work-capture.ts`. It lists no tool and adds nothing to a
thread's preamble.

- `work.capture.state {}` (read) → `{host, last, homes, connected}`: this
  host's id, the sector of his last capture here (null after an unsorted one),
  the sectors with a Work workspace on this host, and whether LifeOS answers.
- `work.capture.file {key, text, sector | null, files?, start?}` (operate) →
  `{taskId, kept, threadId?}`. Refused, before anything is written, with no
  words and no file, while LifeOS is not connected, for a file on another
  host, outside a remote key's fence, or not a file, and for a file whose
  sector (Life for an unsorted one) has no Work workspace here. Files are
  copied into that workspace's folder under kept names (`keptFileName`,
  `freeKeptName`: "Budget (1).xlsx"), so the Files place lists them. The task is
  `tasks:create` with the capture's own `key`; what a capture made is kept
  by its key for a week (`work_capture_filed`), so a repeat answers that
  again and copies and starts nothing twice. Files copied for a task LifeOS
  then refuses are removed. The last sector is kept in `work_capture_state`.
- `start: true` also starts a Work thread (`ctx.threads.start`) about the
  task (a `task` chip, so the host links them): in the sector's workspace, or
  in Work Chats for an unsorted capture or a sector with no workspace here.
  Its first message is his words and each kept file's path. He pressed for
  it, so it is his start; nothing else runs a model. A start that fails
  leaves the task filed and answers `threadError`.
- **Purdue:** a file stays on the machine it was dropped on. The window files
  through this computer's own host, so a Purdue file is copied only into this
  computer's Purdue workspace folder; LifeOS gets its name, never its bytes.

## The desktop: the key and the window

A frame change in the main process, kept small:

- `src/main/capture.ts`: the global key (`globalShortcut`), held only while
  Work is on here (`RunningServer.workSwitch`, from `work.settings`), and the
  window. Default: ⌘⇧Space on macOS, Alt+Shift+Space on Windows and Linux
  (`captureKeyDefault`; Spotlight, the input menu, Finder's search, Word's
  no-break space and the window menu all take the others). He sets it in
  Settings → Work → Capture key (`CaptureKeyRow`, work/capture/): press the
  button, then the keys; Escape keeps the key, Delete turns it off. A key
  another app holds is refused and the one before stays. Kept in
  `<userData>/capture.json` (`{key}`; `null` is off).
- The window is made hidden eight seconds after the key is first held (clear
  of the launch's own windows), or at the first press, so the key shows a
  page already painted: no open or close motion (docs/DESIGN.md "The capture
  window"). A panel on macOS (`type: 'panel'`), on top, on every Space and
  over full-screen apps, 680px wide, centred a fifth of the way down the
  display under the pointer, as tall as its page (`capture:size`). It hides on
  Escape, on Return, and on the key again, not on blur, so a file can be
  dragged in from another app. The dock click, `showAllWindows` and the
  window registry pass it by (`isCaptureWindow`); on Windows it is destroyed
  when the last app window closes, so the app still quits then.
- Its own preload (`src/preload/capture.ts`, sandboxed: the port, hide, size,
  a pasted picture kept under `<userData>/capture-pictures/` until the host
  copies it, a dropped file's path through `webUtils`) and its own renderer
  entry (`src/renderer/capture.html` → `work/capture/page.tsx`), built beside
  index.html, so nothing of it is in the main window's first paint.
- The page (`CapturePage`, `CaptureView`) opens a socket to the local host
  (`client.ts`, the renderer's `Transport` on the loopback port) when shown
  and closes it a minute after it hides. Return files, mod+Return files and
  starts a thread, Shift+Return is a new line, Tab and Shift+Tab step the
  sector, mod+1 to mod+7 pick one (Unsorted first), Escape hides and keeps
  the draft. The window hides and the draft clears the moment he presses
  (the press, so the next capture starts empty while this one is on its way;
  each press is its own capture with its own key. A failure brings the window
  back (`showInactive`, so the keyboard stays where he is) with the draft,
  ahead of anything typed since, and the reason. A composition (an IME, a
  dead key) owns every key until it ends; a dragged link or words land in the
  field as typed, only files are the window's. The last state
  the host gave is kept in localStorage, so the window is whole the instant
  it shows. It wears Work's theme.

## The phone: a voice note

The iOS client's way in (built 2026-11-20). Home's toolbar carries a
microphone (`mic`, "Voice Note") while any host has Work on; it opens a sheet
that fills the height (`tcSheet(.editor)`: at the medium detent the hold
control covered Start Thread and Home showed through the glass), "Voice
Note":

- **Hold to talk.** The 72 pt control at the sheet's foot (in `tcBottomBar`)
  listens while held: the press grows it at once on the layout spring (a
  dim instead under Reduce Motion), the microphone opening turns it red with
  a light tap and the clock under it, the release snaps back on `fast` and
  the last words land. A press that lets go before the microphone opens is a
  tap and records nothing. VoiceOver activates it once to start and again to
  stop. Each take's words follow what the field already holds, and he can
  edit them before saving.
- **On the phone, always** (the owner's rule): `OnDeviceSpeech`
  (ios/TempCode/Sources/Work/Capture/) is `SFSpeechRecognizer` in the phone's
  language with `requiresOnDeviceRecognition = true`. A phone that cannot
  transcribe its language on the device is refused ("This iPhone can't
  transcribe speech on its own."); nothing falls back to Apple's servers.
  Microphone or speech recognition refused: one line with Open Settings.
  `NSMicrophoneUsageDescription` and `NSSpeechRecognitionUsageDescription`
  are in ios/TempCode/project.yml and Info.plist (scripts/ios-project.test.ts).
- **Sector, Start Thread, Save.** Sector is Unsorted (`null`) or one of the
  six, the default the filing host's `last` until he picks; Start Thread
  passes `start: true`; Save files `{key, text, sector, start}` with no files.
- **Which host.** `VoiceNote.find` asks `work.capture.state` of every host
  with Work on at once and takes the first that answers `connected: true` (a
  host asleep behind the relay never holds up one that answered); a started
  thread opens there. With none connected Save says "No host can reach
  LifeOS right now." and keeps the words.
- **Nothing lost.** The draft is kept in the phone's defaults
  (`work.capture.draft`) as it changes, so Cancel, a failed Save and a quit
  all keep it; only a Save the host answered clears it. A Save keeps its key
  while the request (words, sector, Start Thread) is unchanged, so a retry
  after a lost answer files nothing twice; a changed request gets a new key.
  The retry goes back to the host that took the first try while it answers,
  since another host keeps no record of the key and would file it (and
  start its thread) again. Words cannot be added while a Save is on its
  way: the field and the hold wait for its answer, which clears them.
  A thread that did not start (`threadError`) is said in the sheet; the task
  is filed.
- **Code.** Client package `Work/Capture/`: `VoiceNote` (the draft, the host,
  the key; `CaptureHost`, which `WorkHost` is) and `Dictation` (hold, prepare,
  listen, finish, refused, failed; `SpeechSource`, which `OnDeviceSpeech`
  is). `WorkHost.captureState()` and `capture(text:sector:start:key:)` are
  the wire, `Methods.WorkCaptureState` and `Methods.WorkCaptureFile` in the
  generated contract (`CaptureState`, `CaptureFiled`). Tests:
  `VoiceNoteTests.swift` (both suites) and `WorkHostTests`'s capture case.
  The sheet opens for a shot with `TC_TEST_SHEET=voice-note` (debug builds);
  the work proof set ends with it light and dark (w60, w61), and
  `TC_WORK_ONLY=capture` shoots it alone.

The receipt glyph (`doc.viewfinder`, "Receipt") sits beside the microphone
under the same rule, but it is Money's, not capture's: it scans a receipt
and sends it to the job's ledger on its host, and nothing of it goes to
LifeOS (docs/agents/work-money.md; the sheet is docs/IOS-DESIGN.md "The
receipt").


LifeOS takes in his mail itself, so a forwarded mail needs nothing of
TempCode: a mail **he sent** to an address of one of his mailboxes with
`+task` before the `@` (`landon+task@…`), or with a subject that starts
"Task:" (after any "Fwd:" or "Re:"), becomes his task from "Capture", linked
to the mail thread, in that mailbox's sector (LifeOS
`convex/lib/mailCapture.ts`, called from `writeMessages`). He sent it: the
provider marked it sent from that mailbox, or it came from another of his
addresses and passed DMARC. Keyed by the message, so a poll that brings it
again files nothing twice; a thread with an open task keeps that task. Both
markers, since Purdue's forwarded Outlook mail may lose a plus address.

A mail already in the app needs no forwarding: Mail's row menu and the
reading pane's More have Make task (work-kit's mail client, filed by
`actions.makeTask` in MailView). The draft canvas's reading pane shows it too
but does nothing there yet (MailCanvas passes no `onTask`): the mail
pillar's to fix.

## Proofs

`work/capture/capture.test.ts` (the pillar on a stand-in LifeOS), 
`src/main/capture.test.ts` (key, file, placement, options, backing equal to
index.css), the phone's `VoiceNoteTests.swift` and `WorkHostTests.swift`, `lib/keys.test.ts` (accelerators), `work/capture/capture.dom.test.tsx`
(the page's keys, drop, paste, failure, offline, the socket, the key row),
LifeOS `test/behaviour/mailCapture.test.ts`. The preview:
`bun run ui:preview src/renderer/src/work/capture/CaptureView.tsx#CaptureView --shot`.
