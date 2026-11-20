# Live video

The owner watches the computer an agent drives as H.264 video, up to 120
frames a second, in place of the 4 fps JPEG picture. The plan is
`.temp-code/plan-WqCU4GKXKSM6.md`; this file says what is built.

**Built so far:** the wire, the contract, who may watch, the stream ticket,
the stream's own socket on both servers, the relay, the two settings, and the
box's browser as a source. No viewer asks for a stream yet: every client
still draws the JPEG picture, and the Mac and Windows have no source, so
`video.open` answers `unsupported` there.

**What the owner must do before the box plays video:** run the tools
installer on the box and update it (see "The box", "The tools"). Until then
the box's browser is headless and nothing changes there.

## The wire

`src/shared/video/nsl1.ts` is screen-relay's NSL1 wire (Apache-2.0, ported
from version 0.1.2 with its notice): binary WebSocket messages with a 20-byte
header. One WebSocket message holds one protocol message.

| Type | Direction | What it carries |
|---|---|---|
| 1 frame | source to viewer | width, height, the capture time in microseconds, one H.264 Annex B access unit; the header's flag marks a keyframe |
| 2 ack | viewer to source | the frame's generation and sequence, and how long the frame waited inside the viewer |
| 3 input | viewer to source | one 16-byte record: a key, the pointer, a button, the wheel, release-all, or a character |

`screen-relay@0.1.2` is a devDependency used by one test,
`nsl1.parity.test.ts`, which encodes and decodes with both. A bump that
changes the wire fails there. The pin is the published 0.1.2: it has no
`take=1` and no clipboard, which arrived in the repository after it.

## The contract

`src/shared/contract-video.ts`. The host the asking socket is connected to
serves these.

- `video.open { threadId, maxEdge, take?, drive? }` answers
  `{ ok: true, stream, ticket, width, height, fps }`, or
  `{ ok: false, reason }` with `off`, `no-tools`, `unsupported`, `busy`,
  `permission` or `refused`. `threadId` is the key `computer.preview.start`
  takes.
- `video.close { stream }` ends a stream the same socket opened.
- `video.paste { stream, text }` puts text into the page he drives. It needs
  a `drive` stream the same socket opened, while he is the driver.

All three need `approve` (`METHOD_CAPABILITY`).

The frames never ride the RPC socket. The viewer opens a socket of its own,
`/video/<stream>?ticket=…`, with the subprotocol `nsl1`. It closes with a code
that says why (`VIDEO_CLOSE`), and `VIDEO_CLOSE_SHOWS` says what a viewer shows
for each:

| Reason | Code | The viewer shows |
|---|---|---|
| `ended` | 4100 | "The preview stopped" |
| `moved` | 4101 | the 4 fps picture, no line, and never tries again |
| `busy` | 4102 | the 4 fps picture, no line |
| `held` | 4103 | the held act's kept picture |
| `revoked` | 4104 | "The preview stopped" |
| `error` | 4105 | "The preview stopped", with Retry |
| `permission` | 4106 | the Screen Recording line |
| `slow` | 4107 | opens again with a fresh ticket |

A drop that names no reason (a cut link) is opened again too, up to
`VIDEO_RETRIES` (5) times, then the viewer falls back to the picture.

## Who may watch

One rule, `mayWatch` (`src/shared/video/access.ts`), decides for video and
for the JPEG preview of the box's browser:

- A remote caller needs `approve` on a `client` key. An `mcp` key and a key
  without `approve` never get a picture.
- The local socket has no key. On a desktop it is the person's own app and
  may watch. On a host with no desktop (the box) it is refused: any process
  of the `agents` user reaches that socket as admin, the app bridge and a
  code thread's shell among them.

`computer.preview.*` moved from `local` to `approve` so the box's browser can
answer a key. `previewRefusal` (computer/preview.ts) keeps a person's own
windows on that machine's own socket: a Mac or a PC answers
`computer.preview.start` from any key with `local-only`, whatever the key
holds. A server takes `desktop` as an option; without it a host has a desktop
unless it runs headless.

## The ticket

`RemoteAuth.mintStreamTicket` and `consumeStreamTicket` (remote/auth.ts): 30
seconds, single use, for one stream and one scope (`watch`, `drive`, or
`publish` for a stream another host sends in), and it names who asked: a key,
or the desktop's own socket by its connection id. A ticket for another stream
is spent by the try. A key that was revoked, lost `approve` or is not a
client's by the time the ticket is used opens nothing. A desktop's own socket
has no key to check again; what holds its stream to it is that the stream
ends when that socket closes. The key itself never rides in a URL.

## The socket

`VideoSockets` (src/main/server/video/sockets.ts) upgrades
`/video/<stream>?ticket=…` on the local server (beside `/lsp/` and `/dap/`)
and on the fixed-port listener (ahead of its `/ws` check), so it rides the
tunnel that already carries `/ws`. Binary frames, no deflate.

| Refused with | When |
|---|---|
| 400 | the request does not offer `nsl1` |
| 401 | no ticket, or one that is unknown, spent, expired, another stream's, or a key's that may no longer watch; on the listener it counts as a failed attempt for that address |
| 403 | a key's ticket on the local server, or a desktop's on the listener |
| 404 | no such stream, or a socket has already joined it |
| 429 | the address is locked out by failed attempts |

A joined socket is pinged every 30 seconds, since a still page sends nothing
and a proxy would cut an idle socket.

## The relay

`VideoRelay` (src/main/server/video/relay.ts) joins one viewer's socket to
one feed. It is a pipe and never a fan-out: each viewer has its own stream and
its own encoder, so each bitrate follows its own link. It reads a message's
type and nothing else.

- Feed to viewer: frames only, as they came.
- Viewer to feed: acks, as they came, so the encoder sees the true link.
  Input passes only on a `drive` stream while he is the driver. The relay
  learns who drives from `setDriver`, not by a read on each record. When he
  hands back, each drive stream's feed lets go of every key and button he
  holds (`release`; the feed makes the message, since a source numbers its
  connections) and is a watch stream from then on. A drive stream nobody
  joined yet is ended. Taking over opens a new drive stream; a watch stream is
  never made one in place.
- A feed that throws ends its own stream with `error`.
- A socket holding more than 8 MiB unsent is closed with `slow`.
- A stream ends when its viewer drops, when the RPC socket that asked for it
  closes, when its key is revoked (`revoked`), or when its source ends it. No
  stream is opened for a socket that closed while the source was asked.
- A stream nobody joined is let go after 35 seconds.

A feed (`VideoFeed`, video/feed.ts) is one viewer's stream at its source.
`VideoRpc` (video/rpc.ts) asks each `VideoSource` in turn; the first that
knows the thread answers. `FakeFeed` is the feed the tests drive by hand.

## The box

The box's browser is the first source: `src/main/server/work/browser/box/`.
screen-relay's engine runs beside our server as its own unmodified process
and captures the X display the box's Chromium draws on.

### The tools

`scripts/work-tools/browser.json` names one tool, `screen-relay`, for
`linux-x64` only. The installer's `build` kind
([work-formats.md](work-formats.md)) unpacks 43 Ubuntu 24.04 packages, each
pinned by sha256 from snapshot.ubuntu.com, beside the published 0.1.2 npm
package (pinned by npm's integrity), and compiles `relay-engine` there with
the host's own `g++` and `make`. No root, nothing installed on the system.

```bash
bun scripts/work-tools/install.ts --data <userData> --only screen-relay
```

| What | Where under `<userData>/work-tools/screen-relay/0.1.2/` |
|---|---|
| the engine | `pkg/relay-engine`, with a library path that follows the folder |
| x264, libwebsockets, the X client libraries | `sys/usr/lib/x86_64-linux-gnu/` |
| the X.Org server and its dummy driver | `sys/usr/lib/xorg/` |
| xclip | `sys/usr/bin/xclip` |

x264 and xclip are GPL. They, the engine and the X server run only as
separate, unmodified processes; none is linked into our code or shipped in
the app (`THIRD-PARTY-NOTICES.md`). The X server also needs what the box
already has for Xvfb (`xkbcomp`, the keyboard data, pixman and the like). A
host without them fails the probe and stays headless.

`videoToolsAt` (`box/videoSetting.ts`) reads the installer's `state.json`.
The browser is headed only when the tools are there and `work.browser.video`
is not off; both are read each time the browser starts.

### The display (`display.ts`)

A rootless `Xorg` with the dummy driver: one mode, 1280×800 at 120 Hz.
Chromium reads the refresh rate when it starts, so the display is 120 Hz for
the browser's whole life and lives exactly as long as the browser does.

- It picks its own free display number (`-displayfd`).
- It takes no TCP, and a client needs the cookie: a new one for every
  server, in `<userData>/work-browser/box/display/Xauthority`, mode 0600.
- The box's own server runs under a display of its own (`xvfb-run`).
  `displayEnv` hands the browser, the engine and xclip this display's pair
  and nothing of that one.
- A server left behind by a host that was killed is ended before the next
  starts (a pid file beside the config).
- A display that will not start is not an error: the browser starts
  headless and says so in the log.

### The stage (`stage.ts`, `xclient.ts`)

The engine captures the whole display, so what is on the display is what he
sees. No window manager runs. `BoxStage` places the windows over DevTools,
and `xclient.ts` makes the few X requests a window manager would.

- **One window per page, full screen.** The frame is the page alone: no tab
  strip and no address bar, so no full address is in any frame. Every page
  the service or the Outlook carrier makes goes through `stage.open`.
- **Exactly the screen's size.** Chromium takes one pixel off any window as
  large as the screen, and nothing answers its ask to be full screen. So
  `fitWindows` sets each page window to 1280×800 through X, after the
  browser says the window's state has changed.
- **A new page never covers the watched one.** It is made off the screen
  (x = 2000) and put on it under the others (`landWindows`).
- **The watched page is on top.** `video.open` raises it
  (`Target.activateTarget`). A window another page opens is put back under
  it, unless the watched page opened it (a sign-in popup is part of what he
  watches) or he is driving (a window he opens stays).
- **Nothing else raises a page.** In headed mode the service no longer calls
  `Page.bringToFront` before a picture or an act. A covered window keeps
  painting (`--disable-backgrounding-occluded-windows`), and focus emulation
  keeps it acting focused for keys sent through DevTools.
- **The Outlook carrier's window lives off the screen** (x = 6000) and is
  never raised.
- **While he drives**, the page's window leaves full screen, so the
  browser's own toolbar shows inside the picture (87 of the 800 lines). It
  returns to full screen when he hands back.
- **A closed address ends the picture.** When the watched page, a tab of its
  window or a window it opened goes to an address `closedToAgents` names,
  the stream ends.

A Chrome for Testing build draws a bar in every window that says so, full
screen too. `--test-type=gpu` is the one switch found to leave it out (a bare
`--test-type` does not in Chromium 156), so only such a build gets it.

When the browser enters full screen it shows "To exit full screen, press and
hold Esc" for about four seconds. That notice is in the picture when a page
opens and when he hands back.

### The headed profile (`chromium.ts` `headedPrefs`)

Written into the profile before a headed start. A headless browser shows
none of this, so it is left as it was.

- No password is offered to be saved and none is filled, so one he types
  while he drives is never kept for the agent to submit. No address or card
  is saved or filled.
- Every permission a page can ask for is refused without a prompt
  (`HEADED_BLOCKED`).
- A file chooser is handed to DevTools and never drawn
  (`Page.setInterceptFileChooserDialog`).
- A download lands in `<userData>/work-browser/box/downloads` with no
  dialog. Headless, downloads go where they went before.
- No sign-in to the browser itself, no translate bubble, and no offer to
  restore pages after a kill.

### The engine (`engine.ts`, `engineFeed.ts`)

The published 0.1.2 engine takes one WebSocket client. So `BoxEngines` runs
one engine for each viewer, four at most. Each has its own encoder, whose
bitrate follows that viewer's own link, and the relay stays a pipe.

- An engine starts when a viewer needs one and none is free. It stops 60
  seconds after its viewer left; a viewer who comes in that time takes it
  warm. A still page costs an engine nothing: it captures by damage.
- Flags: `--backend x11 --bind 127.0.0.1 --port <free> --fps 120
  --bitrate-min 1M --bitrate-start 8M --bitrate-max 20M --token-file <file>
  --behind-tls-proxy --viewer-dir <folder>`. The token is 64 hex characters
  in a 0600 file under `<userData>/work-browser/box/engine/`, never on a
  command line.
- A watcher's feed is the engine's `/stream?view=1`, which owns no input. A
  driver's is the plain `/stream`, on an engine of its own. The token is
  offered as the `bearer.` subprotocol, never in the address.
- The engine drops a connection that sends it anything it does not expect.
  The feed passes only an ack of 20 or 24 bytes and an input of 36, each
  with the connection's own number.
- The engine closes a stream after three seconds with no ack. The feed says
  `slow`, and the viewer opens another. An engine that exits says `error`.
  After a crash the next start waits, twice as long each time up to 30 s.

### `video.open` on the box (`video.ts`)

- **A stream belongs to a page, not to a session.** Take over stops the
  agent's computer session. The service says which page each session last
  used (`onPage`), and the box keeps it by thread and by pane, so a stream
  of that pane goes on after the session stopped.
- **One page in video at a time.** A caller that asks with `take` gets the
  display; the page that lost it closes with `moved`. Without `take` the
  answer is `busy`. `busy` is also the answer when four engines have
  viewers.
- **Refusals:** `off` when the setting is off, `no-tools` when the tools are
  not installed, `unsupported` when the display or the engine did not
  start, `refused` for a page at a closed address.
- **A held act ends the live picture** of its pane with `held`, since what
  he judges is the kept picture. A page he drives himself is still shown.
- **A viewer counts as use** of the browser for the idle stop, for two
  hours at most, as driving does.
- **A row is kept for a pane he drives** (`driver: 'owner'` on
  `ComputerSessionRow`), since its session is stopped. Stop does nothing on
  it; Hand back ends it.
- **Driving.** `work.browser.drive` tells the box (`boxDriveChanged`): the
  page's window shows the toolbar, and the relay passes his input on a
  `drive` stream. At hand back the feed lets go of every key he holds, the
  page returns to full screen, and his stream is a watch stream.
- **Paste** (`video.paste`). The text goes to xclip on its stdin and is put
  on the display's clipboard, then Ctrl+V is pressed. The clipboard is
  emptied 1.5 seconds later, and at once when he hands back, so nothing he
  pasted is there for an agent to paste again.

## Settings

`src/shared/video/settings.ts`.

- `work.browser.video`, on unless turned off: the box's browser runs headed
  on a private display so its picture is video. `work.browser.video { on? }`
  (admin) reads and sets it and says whether the tools are installed. It
  holds from the browser's next start.
- `computer.video.remote`, off unless turned on: this Mac's or PC's windows
  may be watched from his other devices. It is `videoRemote` in the computer
  settings and is set through `computer.settings.set`, which is `local`: no
  key can turn it on.

## What this cannot stop

- A process of the `agents` user on the box that reads an engine's token
  file can reach that engine, as it can reach DevTools today.
- A desktop's own local socket has no key. Any process of that user on that
  machine can ask for what the desktop's own app can. That is the app's
  existing rule for the local socket, not a new one. The only source that
  takes input is the box's, and the box's local socket gets no stream.

## Tests

- `src/shared/video/nsl1.parity.test.ts`, `src/shared/video/access.test.ts`
- `src/main/server/remote/auth.test.ts` "stream tickets"
- `src/main/server/video/relay.test.ts`: the relay and the RPC, with fakes
- `src/main/server/video/video.server.test.ts`: two real servers, one with no
  desktop reached over keys and one with a desktop on its own socket; the
  upgrade's refusals, revoke, the preview's gate, and that no key sets
  `computer.video.remote`
- `src/main/server/computer/preview.test.ts`: a key never gets a person's
  windows; the box's browser goes to a key that may watch
- `scripts/work-tools/installer.test.ts`: the `build` kind, and the
  manifest's pins
- `src/main/server/work/browser/box/`: `display.test.ts`, `chromium.test.ts`,
  `engine.test.ts` and `video.test.ts` with fakes

The live tests need the tools installed and skip without them. Point them at
an install with `TEMP_CODE_TEST_VIDEO_TOOLS=<userData>`:

- `headed.test.ts`: the real display, Chromium and engine. The viewport
  reads 1280×800, the engine's picture equals DevTools' own picture of the
  page, a new page lands under the watched one, the carrier stays off the
  screen, the toolbar shows while he drives, the preferences are read back
  from the running browser.
- `headedService.test.ts`: two threads through the box's own sessions; all
  one does to its page leaves the other's on top.
- `videoLive.test.ts`: the host's own wiring end to end. H.264 frames
  arrive, a still page falls silent, `take` and `moved`, the owner's row,
  his clicks, keys and paste land in the page, hand back.
- `TC_BOX_HEADED=1` runs the browser's existing tests headed too (the
  service, the hold, the outbox, the preview, the Outlook carrier).
