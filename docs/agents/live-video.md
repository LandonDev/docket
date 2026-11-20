# Live video

The owner watches the computer an agent drives as H.264 video, up to 120
frames a second, in place of the 4 fps JPEG picture. The plan is
`.temp-code/plan-WqCU4GKXKSM6.md`; this file says what is built.

**Built:** the wire, the contract, who may watch, the stream ticket, the
stream's own socket on both servers, the relay, the two settings; the box's
browser as a source, with his pointer and keys into the page he drives; a
Mac's window as a source (`tc-computer`, `capture.video.*`) and a PC's
(`tc-computer.exe`, the same calls; see "A Windows PC" below), and the
publish leg that carries one to his other devices; the desktop's viewer,
which every place that shows a live picture now asks first; the Computers
page; and the phone's viewer ("The phone"). Every part of the plan is
built. What no proof has shown yet is listed under "What is unproven".

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
when it is a Mac or a PC that is not headless (`personsDesktop`,
src/main/headless.ts). A Linux host never has one, whatever its environment
says: the box's service runs under `xvfb-run`, so it has a display, and the
refusal of its local socket must not rest on one variable in a file.

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

A rootless `Xorg` with the dummy driver: one mode, 2560×1600 at 120 Hz.
That is the page's 1280×800 at scale 2 (`DISPLAY_SCALE`), and the browser
draws at that scale (`--force-device-scale-factor=2`), so a page still lays
out at 1280×800 CSS pixels and is sharp on a 2× screen. Chromium reads the
refresh rate when it starts, so the display is 120 Hz for the browser's
whole life and lives exactly as long as the browser does.

- The driver refuses a pixel clock above 300 MHz unless told otherwise, and
  falls back to a mode of its own. 2560×1600 at 120 Hz is 504 MHz, so the
  config says `DacSpeed 1000`. The Xorg log in `display/Xorg.log` names
  the mode it took.
- `BoxXDisplay` takes any scale (`headedScale.test.ts` runs 2 and 1.5). The
  numbers behind 2 are in "The proofs".

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
- When the host process exits, the server is ended with it.

### The window manager and the stage (`xwm.ts`, `xclient.ts`, `stage.ts`)

The engine captures the whole display, and his keys reach it as real key
presses. So what is on top of the display is what he sees, and the window
that holds the keyboard is where he types. A browser left alone gives both
away: it raises a window that is clicked, even by an agent through DevTools,
and gives it the keyboard; it opens a new window over the others; it takes a
pixel off a window as large as the screen.

So the display has a window manager of ours, `BoxWindowManager`, started
before the browser. `xclient.ts` speaks the X protocol by hand for it. It is
the one client the display asks before a top-level window is mapped, moved,
sized or restacked (`SubstructureRedirect`), and it tells the browser that it
brings windows forward (`_NET_ACTIVE_WINDOW`), so the browser asks instead of
raising and focusing a window itself. A display that cannot be managed is
stopped and the browser starts headless.

Its rules:

- **A page's window is exactly the screen**, whatever size the browser asks
  for.
- **A black curtain covers the screen**, and every window comes onto the
  screen behind it. Nothing that is not named below is ever seen. When the
  watched page closes he sees the curtain, not the next page down.
- **In front of the curtain** are only the front window (the page he
  watches), the windows let above it (a popup that page opened) and their
  dialogs. Only they get the keyboard: the one that asked last.
- **Menus, tooltips and notices** are not asked about by the display, and
  nothing on them says which window they belong to. One goes behind the
  curtain as soon as it shows, and again if the browser raises it. The one
  exception: he drives and his input reached the display in the two seconds
  before (`HIS_MENU_MS`); then it is taken for his and stays.

`BoxStage` names the windows for it, over DevTools:

- **One window per page, full screen.** The frame is the page alone: no tab
  strip and no address bar, so no full address is in a watcher's frame. Every
  page the service or the Outlook carrier makes goes through `stage.open`.
- **Which window is which.** The browser does not say which X window is a
  page's. A new page is made at a place of its own far to the right
  (`wm.expect`), and the manager sees which window shows up there. A window
  that already exists (the browser's first, a popup) is asked through
  DevTools to move to such a place; the manager sees which window asks and
  leaves it where it is. A place is in the page's units, as DevTools places
  a window; on a display at scale 2 the window shows up at twice it, and the
  manager reads the pixel back as the place (`placeAt`: the nearest place,
  so the browser's rounding at 1.5 does not matter).
- **The watched page is the front window.** `video.open` makes it so
  (`stage.watch`). A window it opens is let above it: a sign-in popup is part
  of what he watches. The browser says who opened a window even when the
  page asked for `noopener`.
- **Every other window stays behind the curtain**: a new page, a window
  another page opens, a window with no opener, the Outlook carrier's.
- **Nothing else brings a page forward.** In headed mode the service does
  not call `Page.bringToFront`, and the manager refuses the browser's own
  asks. A covered window keeps painting
  (`--disable-backgrounding-occluded-windows`), and focus emulation keeps it
  acting focused for keys sent through DevTools.
- **While he drives**, the page's window leaves full screen, so the
  browser's own toolbar shows inside the picture (87 of the page's 800 lines), with
  the page's address. A window that page opens for him is left as the
  browser made it. The page returns to full screen when he hands back.
- **The picture ends** when the watched page closes, and when it, a tab of
  its window or a window it opened goes to an address `closedToAgents`
  names (`stage.onEnd`).

A Chrome for Testing build draws a bar in every window that says so, full
screen too. `--test-type=gpu` is the one switch found to leave it out (a bare
`--test-type` does not in Chromium 156), so only such a build gets it.

The browser's "To exit full screen, press and hold Esc" notice is one of the
notices that go behind the curtain: it is never in the picture.

### The agent sees the page in its own units

The display has twice the page's pixels; the agent never sees that.

- A screenshot (`capture.screenshot`, an observation's picture) divides
  `Page.captureScreenshot`'s clip scale by the display's, so the picture
  is 1280×800 at most (under `maxEdge`, 1568 by default), and its width
  and height say so.
- `initialize` answers one display of 1280×800 points at scale 2.
- The 4 fps picture answers the size its frames really have: the page's
  device pixels, cut down to `maxEdge`.

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
- The engine's SPS carries the bitstream restriction with no frame
  reordered (`videoLive.test.ts` reads it with `spsReorder`). That matters:
  a hardware decoder holds its output for a stream that does not say so, a
  viewer that draws nothing acks nothing, and the stream dies. The Mac's
  encoder did not say it; its service rewrites the SPS (§30).
- The engine closes a stream after three seconds with no ack. The feed says
  `slow`, and the viewer opens another. An engine that exits says `error`.
  After a crash the next start waits, twice as long each time up to 30 s.

### `video.open` on the box (`video.ts`)

- **A stream belongs to a page, not to a session.** Take over stops the
  agent's computer session. The service says which page each session last
  used (`onPage`), and the box keeps it by thread and by pane, so a stream
  of that pane goes on after the session stopped.
- **The stream is the display's own pixels**: 2560×1600, whatever the
  viewer asks (the size its window manager reads off the display).
- **One page in video at a time.** A caller that asks with `take` gets the
  display; the page that lost it closes with `moved`. Without `take` the
  answer is `busy`. `busy` is also the answer when four engines have
  viewers. Opens are decided one at a time, and a page loses the display
  only once the taker has an engine in hand.
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
- **Driving.** `computer.drive` tells the box (`boxDriveChanged`, which resolves once the relay has the new driver): the
  page's window shows the toolbar when it is the page on the display, and
  the relay passes his input on a `drive` stream. At hand back the feed lets
  go of every key he holds, the page returns to full screen, and his stream
  is a watch stream.
- **Paste** (`video.paste`). The text goes to xclip on its stdin and is put
  on the display's clipboard, then Ctrl+V is pressed, unless he handed back
  meanwhile. The clipboard is emptied 1.5 seconds later, and at once when he
  hands back, so nothing he pasted is there for an agent to paste again. At
  hand back an empty xclip also takes the clipboard from the browser and is
  ended a moment after, so what he copied in the page is gone too.

## The viewer

`src/renderer/src/lib/video/`, loaded as a chunk of its own when a stream is
first wanted; nothing of it is in the first paint.

- **A worker** (`video.worker.ts` on `StreamPlayer`, player.ts) owns each
  stream's socket and a WebCodecs `VideoDecoder`, and draws each frame on
  every canvas the window handed over (`transferControlToOffscreen`), on
  the worker's own frame clock. React work in the window cannot make the
  video stutter. The decoder is configured from the first keyframe's SPS
  (`h264Codec`), for low latency.
- **Pacing** (pacing.ts, ported from screen-relay's viewer with its notice):
  frames are held up to 100 ms when they arrive unevenly, one frame at most
  is drawn per refresh, and a line that grows is caught up by passing
  frames over. A 60 Hz screen draws 60 and acks the rest as passed over.
- **Acks.** Every frame is acked in the order it came, drawn or passed
  over, with how long it waited in the viewer. Closing a stream acks what
  still waits.
- **What breaks a stream**: a gap in the sequence, a generation that does
  not start with a keyframe numbered 1, bytes that are no frame, a decoder
  error, no first frame within five seconds, a decoder that says nothing
  for five seconds.
- **One stream per host and thread in a window** (`VideoStreams`,
  streams.ts). The browser canvas, the Computer section, a Computers tile
  and the full view each put a canvas on the same stream; the host runs
  one encoder. A stream closes 1.5 seconds after its last place has gone.
  A place asks for the width it shows the picture at, less only what its
  measured element holds around it (`inset`: the right panel's section and
  the browser canvas have 12px a side, a tile and the stage none), in the
  device pixels of the window the picture is in (`pixelRatioOf`, so a
  pop-out on another screen asks in its own). It asks again half a second
  after it grows past a quarter larger or shrinks below six tenths
  (`nextEdge`). The stream takes the largest ask of its places: it is
  opened again, larger, as soon as one grows past a quarter, and smaller
  once every place has stayed below six tenths for five seconds
  (`SHRINK_QUIET_MS`), so a pop-out left alone does not hold a 4K stream
  open. Either only when the edge is what held the picture down (a Mac's
  window; the box's page is 2560 wide whatever is asked).
- **A closed stream** (`afterClose`, messages.ts). A drop that named no
  reason, `slow`, a decoder that failed or stalled: opened again with a
  fresh ticket after 0.5, 1, 2, 4 and 4 seconds, the last frame staying on
  the canvas, then the 4 fps picture. A frame drawn in between starts the
  count again. `moved`, `busy` and `held` give way to the picture at once
  and are never opened again by themselves; `ended`, `revoked`, `error` and
  `permission` read as the preview's own ends ("The preview stopped", with
  Retry for `error`; the Screen Recording line). A machine that cannot
  decode the stream asks for no video again in that window.
- **`useLiveStream`** (surfaces/threads/computer/Viewport.tsx) is video
  first (`useComputerVideo`, lib/computerVideo.ts) and the preview when
  video gives way: `video.open` refused or unknown to the host, no
  `VideoDecoder`, the retries spent, the display gone to another page. It
  speaks the preview's own states, so every place that shows a live
  picture shows video with nothing changed around it. The two have a
  canvas each, since one handed to the worker takes no other drawing. A
  place shown again asks for video again.
- **`take`.** The canvas, the Computer section and the full view are the
  thread on screen and ask with `take`. A Computers tile does not.
- **Sharp.** The canvas holds the stream's own pixels. Its box is as wide
  as its column and no wider than those pixels on this screen
  (`sharpWidth`); the Computers page's stage and the full window draw them
  as large as their room allows, never past two to one (`fitStage`). A
  narrower column scales the picture down, whole.
- **Counts.** The worker says how many frames it drew and at what rate
  four times a second; they go to the box's `data-frames` and `data-fps`
  by hand, for the proofs. Nothing on screen shows them.
- **The click ring.** A `computer-click` push whose `preview` is the
  stream's id rings the picture as a preview's does. No source sends one
  for a video stream yet (the box's browser never did for its picture).

### The pop-out

The pop-out (surfaces/threads/computer/PopOut.tsx) is a child window the
main window opens with `window.open('about:blank', 'tc-popout')`; main's
open handler lets that one frame name through as a frameless, floating
panel with none of the main window's preload or slot argument
(src/main/popOut.ts), shown without taking focus, on every Space, closed
with its main window, its place and size kept in the window state file,
its shape held to the picture's by `popout:shape` (`setAspectRatio` with
the 36px bar as extra). The page portals into it and hands its canvas to
the main window's own video worker: one stream for every place, as
everywhere. Input, the pixel ratio and the tips are bound to the child's
own window (`attachInput` listens for `blur` on the picture's window;
`pixelRatioOf`; `TooltipContainerProvider`).

Proven on the Mac on an isolated dev instance (2026-11-20, A6,
scripts/popout-proof.ts, a worker drawing on `requestAnimationFrame` as
the video worker does): the pop-out drew 143 frames a second with the main
window minimized and 144 with a Finder window over the main window; it did
not take focus when it opened; the child has no preload and no slot. The
main window's own frame clock stopping does not stop the pop-out's: the
worker draws on the frame clock of the canvas it was handed. Not run: the
main window on another Space (that display has one desktop), and a picture
of the pop-out drawn above a covering window (the window list put Finder
ahead of it; no screenshot was taken).

## A window on a Mac or a PC

`src/main/server/computer/videoFeed.ts` (`ComputerVideo`, a `VideoSource`;
`ServiceVideoFeed`). The service side is docs/computer-protocol.md §30.

- **Which window.** `video.open` names a thread; the stream is of the
  window that thread's session last read (`previewTarget`), as the 4 fps
  preview's is.
- **For this machine's own desktop** the service is asked in `quality` mode
  at the window's own pixels (up to 3840 on the long edge). A viewer
  elsewhere is refused here: `off` while the switch is off, else
  `unsupported`, since a person's windows leave the machine only by the
  publish leg below.
- **Refusals.** `unsupported` when the service has no `video` feature or no
  bytes pipe (an older build, or a Windows service whose named pipe did not
  join), `permission` when Screen Recording is off.
- **Before the viewer joins.** The service sends as soon as it is asked,
  which is before the viewer's socket has joined and may be before its own
  answer has named the stream. Those frames are kept (the service sends no
  more than its window of them) and passed on when the socket joins, the
  keyframe first.
- **Following the session.** When the thread reads another window the feed
  stops the service's stream and starts one for the new window under the
  same socket. The service numbers generations within each of its streams;
  a viewer takes them in rising order only, so the feed numbers them itself
  and writes its own number into each frame and the service's back into
  each ack. An ack of a window the stream has left is dropped.
- **Ends.** `ended` when the window closes or the session is gone,
  `permission` when Screen Recording goes off, `error` when the service
  fails or is restarted (the viewer opens again). The feed hears its
  stream end from the first ask on, so a viewer that joins after the end
  (the service ends a stream nobody acks within three seconds) is told at
  once.
- **One run of the service.** A feed starts, acks and stops on the
  connection its stream was started on, and ends when that process exits.
  Each run numbers its streams from 1, so a word sent to a later run would
  land on another viewer's stream.
- **The click ring.** A `capture/click` whose `stream` is the video
  stream's number goes to the asking socket as `computer-click` under the
  viewer's own stream id.

## From his other devices

A Mac's or a PC's windows are watched from elsewhere only through the host
that machine dials, and only while "Watch from my other devices"
(`computer.video.remote`) is on at that machine.

1. The viewer (the phone, another desktop) asks the box `video.open`.
2. The box asks the machine over the peer link: `video.publish { key,
   publish, ticket, maxEdge }` (`src/shared/contract-videopublish.ts`). The
   ticket is a stream ticket of scope `publish`, single use, 30 seconds.
3. The machine checks its switch and that it has saved the asking host,
   opens its own window source in `budget` mode at 1280 at most, and dials
   that host's `/video-publish/<publish>?ticket=…` (subprotocol `nsl1`). It
   sends frames up the socket and takes the viewer's acks down it
   (`video/publisher.ts`, `VideoPublisher`). It answers the box with the
   picture's size, or the refusal.
4. On the box the socket feeds a `PublishedFeed` (`video/published.ts`),
   which the relay treats as any feed. A machine that does not dial in
   within ten seconds leaves no stream waiting.

Which sessions the box asks a machine for:

- **A box thread that drives the Mac** (`VideoPublishing.open`): the
  machine is the thread's Mac (`macPeerOf`), the key
  `macComputerKey(box, thread)`. This source is asked after every other
  (`addSource(…, 'last')`), so a thread whose page the box shows itself is
  never asked of another host.
- **A phone relayed to the Mac** (`HostRelay`, `video` in its deps): the
  phone's socket is the box's, so `video.open` and `video.close` on a lane
  are answered by the box and never cross; the machine is the lane's host
  and the key the thread's own id. The stream's socket is the box's too.

What ends a published stream: the viewer's socket closing (the box closes
the publish socket, the machine stops its capture), the viewer's key being
revoked, the machine's own end (its close code carries the reason to the
viewer), and the switch turned off, which closes every stream the machine
is publishing at once (`closeAll`).

## Driving

Only the box's browser takes his input. He presses Take over
(`computer.drive {computer: 'browser:<pane>', driver: 'owner'}`), on the
desktop or on the phone's full screen ("The phone" below), and from then on:

- **The stream.** A place that drives asks `video.open` with `drive`. The
  host gives a `drive` stream only while he is the driver; a watch stream
  is never turned into one, so the window's streams ask for a new one at
  each take over (streams.ts). The Computer section and a Computers tile
  show the page he drives and take no input; the browser canvas, the full
  view and the phone's full screen do.
- **The picture is his keyboard and pointer** (`useDrivingInput`,
  Viewport.tsx): its box takes focus on a click and wears the focus ring
  for as long as it holds the keyboard (`focus-ring-held`); a click outside
  lets go, and so does the window losing focus. Nothing is sent before a
  frame is on screen.
- **What is sent** (`VideoInput`, videoInput.ts, with screen-relay's key
  table and its notice): the pointer as shares of the picture, the three
  buttons, the wheel in whole notches, and keys by their place on the
  keyboard (HID usage codes), each with the buttons and modifiers held.
  Letting go sends one release-all.
- **A Mac's Command key** never crosses. ⌘C, ⌘X, ⌘A and ⌘Z go to the page
  as the Ctrl chords; every other ⌘ chord stays the app's. The Control key
  is Ctrl there.
- **Paste** (⌘V, or Ctrl+V elsewhere) is his clipboard's text handed to
  `video.paste`, never typed and never the far clipboard's own.
- **Never sent**: Ctrl+W, Ctrl+Q, Ctrl+N, Ctrl+T and Ctrl+Shift+I, which
  would close, quit or leave the shared browser. They are swallowed in the
  viewer, and the box drops them again whoever sends them (`EngineFeed`
  follows Ctrl and Shift from the records themselves).
- **The app leaves the page's keys alone.** While the picture holds the
  keyboard the app's own key listener passes every key by (`pageOwnsKey`,
  lib/appCommands.ts): Escape and the arrows do not close or step the full
  view, Ctrl+S and its like run no command, a double Shift opens nothing,
  and Escape closes no page under it (lib/pageEscape.ts). Only a Mac's ⌘
  chords stay the app's.
- **The keyboard's way out** is Ctrl+Alt pressed with nothing else and let
  go (⌃⌥ on a Mac; off a Mac only the left Alt, since the right one is
  AltGr): Tab and Escape are the page's while the picture holds the
  keyboard, so without it only a click would leave. Both keys still reach
  the page. The keyboard goes to the nearest Hand back (`data-hand-back`:
  the canvas bar's, the full view's), or just leaves the picture when
  that button is busy. A toast says the chord once a launch, the first
  time a picture becomes his to drive, and the box says it to a screen
  reader (`aria-description`).
- **Hand back** makes the stream a watch stream on the host, which lets go
  of every key he held; the picture is a picture again.
- **Take over keeps the picture.** The app makes one call,
  `computer.drive` (`takeOver`, lib/computers.ts; the full view and the
  canvas bar the same), and the host does the rest in order
  (computer/drive.ts): it reads which sessions drive the page, hands him
  the wheel, waits for the box's picture to have its new driver, and only
  then stops those sessions. The host lists a pane he drives (`ownerRows`,
  box/index.ts), and marks a session still live in it as his, so the page
  has a row at every moment; done the other way round it had none between
  the two steps, and every place that showed it dropped it. A watch stream
  is not ended by the drive change. Once the session is stopped the page's
  row is the pane's own thread's: the Computers page keeps it the same
  tile (`tileKey`), so its box and canvas stay, and a full view opened on
  the thread that drove it follows it (`findComputer`).
- **A headless box browser** (the tools not installed, or the setting off)
  has no video and takes no input from the picture. Take over still keeps
  the page listed with Hand back, and its 4 fps picture goes on: the
  preview is drawn from the window the stopped session last read, on a
  session of the box's service that only looks (`previews`, box/index.ts,
  `owner:<pane>`), closed at Hand back. 1.0.352 lost both: a pane he drove
  had a row only when the browser was headed, and the picture was the
  stopped session's. To drive from the picture, install the tools ("The
  box", "The tools").

`videoLive.test.ts` "a sign-in, whole" proves the host's side on the box
with the real browser and engine: the agent stops at a sign-in page, he
takes over, clicks the fields and types through a drive stream, the form
posts, only the page is in front of the display's curtain (no offer to keep
the password) and the profile's store of sign-ins is empty, he hands back,
and the agent reads the page the sign-in opened. The renderer's side is
proven over fakes (`videoInput.test.ts`, `ViewportVideo.dom.test.tsx`
"driving the page from the picture"); the two meeting in a real window are
first seen on the owner's Mac.

## The Mac (`tc-computer`)

The computer service streams one window as H.264 on its bytes pipe,
descriptor 3 (docs/computer-protocol.md §30, "The Mac service"): one
ScreenCaptureKit capture per window, one VideoToolbox encoder per stream,
screen-relay's flow controller ported to Swift with every case of its test.

Measured 2026-11-19 on the M4 Max (the 144 Hz display at 2×, load 5 to 7,
after more than an hour with no input) by `capture-proof` scene 20: an inert
borderless window of 1280×800 points that changes everywhere on every
refresh, 5 s per mode after a 1 s warm-up, a viewer on the same Mac that
acks each frame 2 ms after it is written.

| Mode | Picture | Encoded fps (capture) | Encode p50 / p95 | Bitrate |
|---|---|---|---|---|
| `quality` | 2560×1600 | 119.0 (153.6) | 8.6 / 14.5 ms | 65.0 Mbit/s |
| `budget`, starting at 8 Mbit/s | 1280×800 | 32.2 (153.4) | 4.2 / 5.6 ms | 7.9 Mbit/s |

Encode is the capture callback to the access unit's bytes. The capture runs
past the display's rate (about 153 a second on a 144 Hz display): a window
capture follows the window's own drawing. The first frame of each run was a
keyframe with its SPS and PPS, the sequences ran 1, 2, 3 … with no gap, and
every frame had the size the start answered. Stopped, the window sent its
last drawn frames, four repeats 150 ms later, and nothing in its last second
of rest.

The DataRateLimits trial (scene 21, the same window, 2560×1600, 8 s per run
after 2 s, the rate held fixed), two runs on 2026-11-19:

| Rate control | Encoded fps of captured | Bitrate | Encode p50 / p95 |
|---|---|---|---|
| `quality`: default, 20 Mbit/s | 119.1 of 161.0; 119.0 of 159.9 | 65.0; 65.1 Mbit/s | 8.8 / 13.4; 9.0 / 15.6 ms |
| `quality`: DataRateLimits 20 Mbit/s | 118.5 of 161.8; 112.1 of 160.0 | 37.6; 35.6 Mbit/s | 7.4 / 26.6; 25.2 / 42.0 ms |
| `budget`: low-latency, 8 Mbit/s | 15.0 of 162.0; 15.0 of 160.9 | 8.2; 8.2 Mbit/s | 9.1 / 10.2; 9.2 / 10.0 ms |
| `budget`: DataRateLimits, no low latency, 8 Mbit/s | 119.2 of 161.1; 110.2 of 160.5 | 30.6; 28.4 Mbit/s | 7.2 / 7.9; 30.8 / 41.7 ms |

DataRateLimits does not hold `quality` near 20 Mbit/s (1.8 to 1.9 times it;
one run dropped frames and its encode p95 reached 42 ms), and it does not
hold `budget` within 1.5 times 8 Mbit/s (3.5 to 3.8 times). So `quality` keeps
the default rate control and `budget` keeps low-latency rate control
(`VideoTuning.qualityDataRateLimits` and `budgetDataRateLimits` are false).

In `budget` the flow at first never raised the bitrate, though every ack came
at once: low-latency rate control drops most frames of a busy window, and
screen-relay's flow takes a gap of more than three frame intervals between
sent frames as idle and starts its sample again, so it never saw the steady
demand it needs before it probes. The stream now applies the flow's own probe
beside it (§30 "The stream", `probeAtTheEdge` in ComputerService/Video.swift);
the host's proof then ran `budget` at 60 to 86 fps and 12 to 16 Mbit/s.

## A Windows PC (`tc-computer.exe`)

The Windows service streams one window the same way (docs/computer-protocol.md
§30, "The Windows service"): the host's named pipe dialed before
`initialize` is answered, one Windows.Graphics.Capture capture per window
(PrintWindow on a timer where that is refused), one Media Foundation H.264
encoder per stream (a hardware one when the PC has one, else Microsoft's
software encoder), and screen-relay's flow controller ported to Rust with
every case of its test. The host side was already the Mac's: `ComputerVideo`
asks any service that names `video`. Measured in the rig: "The proofs".
Not proven: a hardware encoder (the rig has no GPU) and a PC's own desktop
viewer on a real Windows host; the rig's proof reads the frames on the box.

## The phone

The iPhone plays a stream as the desktop's viewer does, natively
(docs/IOS-DESIGN.md "Work on the phone"):

- **The contract.** `video.open` (its answer flat on the wire to the phone,
  `VideoOpenWireSchema`: the desktop's union is tagged by a boolean, which the
  Swift generator cannot take), `video.close`, `video.paste`,
  `computer.sessions`, `computer.stop`, `computer.drive` and the `computer`
  push are in the phone's subset. The push already reached a key's socket; it
  only joined `RemotePushSchema`. On a relayed lane `computer.sessions` and
  `computer.stop` go to the lane's host (`RELAY_METHODS`), so Stop reaches a
  Mac's row; `video.open`, `video.close` and `video.paste` are the box's to
  answer, and `computer.drive` names only the box's own page or VM, so none of
  them crosses (`RELAY_NOT_CARRIED`).
- **The stream** (`ios/TempCodeClient/Sources/TempCodeClient/Video/`):
  `NSL1.swift` reads frames and writes acks byte for byte as nsl1.ts;
  `AccessUnit.swift` turns an Annex B access unit into a `CMSampleBuffer` (the
  format from the keyframe's SPS and PPS, made again when they change);
  `VideoInput.swift` writes input records byte for byte as `encodeInput` and
  maps his touches and keys to them (`PhoneDriving`);
  `VideoRules.swift` holds the player's rules (a generation starts with
  keyframe 1, no gap, a layer that fails or a first frame that never comes
  ends it; each frame acked once it is enqueued, with its wait), `afterClose`
  and `streamUrl`; `LiveVideo.swift` runs one stream: `video.open`, the socket
  beside the RPC socket (a relayed host's is the carrier's, as its RPC is,
  `Connection/VideoStreamSocket.swift`), acks in order through one sender,
  and the retry rule. One `LiveVideo` serves a picture and its full screen:
  `want` opens it again only when the open it has cannot give what the full
  screen needs (`reopens`): a turn of the phone (the picture's new width),
  the display taken (`take`, after a `busy` refusal or a `moved`/`busy`
  close), a stream he drives (Take Over), or the pane's thread the page's
  row moved to. Hand Back opens nothing: the host made it a watch stream.
  His input goes down the stream's socket through the acks' one ordered
  sender, numbered with the last frame's generation.
- **The screens.** `LivePicture` (an `AVSampleBufferDisplayLayer`) in the
  browser item above who drives and in each Computers tile; it plays while on
  screen and the app is active, waits for a tap on mobile data, and opens full
  screen on the same stream: its one layer moves into the full screen and back
  (`LiveLayer`). The full screen asks with `take` and has Take Over (where the
  computer takes input: the box's page, a `vm:` row), Hand Back and Stop
  (docs/IOS-DESIGN.md "Work on the phone"). A `busy` refusal says "Another
  page is on screen", and a tap on that picture opens the full screen, which
  takes the display.
- **Driving from the phone** (`PhoneDriving`, VideoInput.swift): a tap is a
  left click, a drag moves with the left button down, two fingers scroll in
  whole notches (24 pt a notch, fingers up scroll the page down), a long
  press is a right click, and a pinch zooms the picture on the phone alone.
  The keyboard button raises the system keyboard with nothing changed on the
  way (no autocorrection, capitals, smart quotes or dashes): what a US
  keyboard has goes as key records by its HID usage (`HID_KEYS`), Shift held
  for a capital or a shifted sign; any other character goes, a run at a time,
  to `video.paste`, the source's own typing. Paste sends his clipboard's text
  to `video.paste`. Closing the full screen or Hand Back sends release-all
  when a button is held. Home's Computers row and list follow `computerTiles`, ported as
  `ComputerTiles.swift` (a bridged session's twin dropped while the box it
  names is one of the phone's hosts).
- **The proof** (`TC_PROOF_SET=video`, docs/agents/ios-client.md): the test
  server plays the box engine's own 180 recorded frames
  (`scripts/fixtures/ios-test-server/box-stream.nsl1`, `LoopFeed`) for a
  seeded Work thread and lists it as driven. Run 2026-11-19 on an iPhone 17
  Pro simulator (iOS 27.0), light and dark: the browser item showed 1,452
  frames, then 1,753 three seconds later; full screen and the Computers
  list played; no stream closed; the server sent 10,530 frames and took
  10,523 acks. The rate is a simulator's. A9 added the list's full screen
  watching and driving to the set (`TC_TEST_OPEN=live-drive` takes over, taps
  the middle and types "Hi"); the test server's page answers `computer.drive`
  and counts the input that reaches its feed (`GET /video` `inputs`).

## Settings

`src/shared/video/settings.ts`.

- `work.browser.video`, on unless turned off: the box's browser runs headed
  on a private display so its picture is video. `work.browser.video { on? }`
  (admin) reads and sets it and says whether the tools are installed. It
  holds from the browser's next start.
- `computer.video.remote`, off unless turned on: this Mac's or PC's windows
  may be watched from his other devices. It is `videoRemote` in the computer
  settings and is set through `computer.settings.set`, which is `local`: no
  key can turn it on. Settings → Computer use shows it as "Watch from my
  other devices". Off closes what is being published.

## The proofs

`bun run script:e2e-box-video` (scripts/e2e-box-video.ts) measures the box
through our relay and the stream's own socket: the real Chromium headed on
its display, the real engine, and a viewer that acks each frame as it
arrives. Scenes run five times each, turn about, pinned to cores of their
own; the medians are judged and the load average is printed beside them. It
needs the tools installed (`--data <userData>`) and touches nothing of the
box's live service.

Measured 2026-11-19 on the box (16 cores, no GPU), cores 24 to 31, load
average 11 to 15 from other threads. Medians of five runs of 15 s:

| Scene | Rule | Measured |
|---|---|---|
| A page of text scrolling every frame, 1280×800, loopback | 110 fps | 119.1 fps at 5.3 Mbit/s (runs 115.1, 119.7, 119.1, 117.9, 119.1) |
| The same: capture to relay | p95 under 15 ms | p50 1.8 ms, p95 6.9 ms (to the viewer 1.9 and 7.0) |
| The same: the engine's CPU | under 1.2 cores | 0.53 of a core |
| The same through 5 Mbit/s with 30 ms each way | 100 fps | 116.3 fps at 4.2 Mbit/s; to the viewer p50 41 ms, p95 76 ms |
| A link cut for 4 s | the stream closes | closed with `slow` (4107) after 180 frames |
| The next open after the cut | it plays | 181 frames in 1.5 s |

`--scale 2` (or 1.5) runs the display at that many pixels for each of the
page's. The rule to ship such a display: the scrolling page holds 100 fps
with the engine under 3 cores. Measured 2026-11-20 on the box (32 cores, no
GPU), cores 24 to 31, the three sizes taking turns (1, 2, 1.5) for five
rounds of one 15 s run each, load average 2.6 to 8.8 from other threads.
Medians:

| Display (scale) | Scroll fps (runs) | Engine | Bitrate | Capture to relay p50 / p95 | Thin link fps |
|---|---|---|---|---|---|
| 1280×800 (1) | 120.0 (120.1, 120.0, 119.5, 120.0, 119.8) | 0.47 cores | 4.4 Mbit/s | 1.1 / 1.7 ms | 120.7 |
| 2560×1600 (2) | 119.6 (119.7, 119.7, 119.6, 115.0, 119.3) | 1.63 cores | 12.4 Mbit/s | 5.0 / 7.2 ms | 118.9 |
| 1920×1200 (1.5) | 119.6 (120.0, 119.6, 119.9, 119.2, 118.7) | 1.13 cores | 16.6 Mbit/s | 3.3 / 5.9 ms | 119.7 |

Load average beside the scroll runs: 4.7, 4.0, 4.4, 4.5, 8.8 at scale 1;
4.2, 2.6, 3.8, 8.1, 6.1 at 2; 3.9, 4.5, 5.2, 6.5, 6.5 at 1.5. Each of the
15 runs also passed the cut and the reopen. Both larger sizes pass, so the
display ships at 2, the sharper. Its cost beside 1: the engine takes 3.5
times the CPU, and the browser takes about 0.08 of a core more while it
scrolls and about 120 MB more memory (1440 MB for the whole tree, under its
2048 MB cap). The thin link holds its 5 Mbit/s at every size: the engine's
rate control spends what the link has on the larger picture.

The capture time is the engine's, on the kernel's monotonic clock; the
script reads the same clock. The thin link is a proxy in the script between
the viewer and the relay, so the engine sees it only through the acks, as it
will through the tunnel.

The Windows service, `bun scripts/e2e-computer-win.ts --legs video`, in the
rig on 2026-11-19 (8 cores, no GPU, Windows 11 at 1280×800): a WinForms window
that draws a moving bar and a counter on a 10 ms timer, the box's own
`ComputerConnection` reading the records through a relay of the named pipe
over a second SSH tunnel (since replaced by the door's bytes connection,
docs/computer-protocol.md §29.1) and acking each one, 10 s per mode.

| Mode | Picture | Frames a second (the window drew) | Bitrate | Encode p50 / p95 | Capture | Encoder |
|---|---|---|---|---|---|---|
| `quality`, 20 Mbit/s asked | 962×632 | 34.6 (62.7) | 0.52 Mbit/s | 3.05 / 4.16 ms | Windows.Graphics.Capture on the Microsoft Basic Render Driver | software (Microsoft H264 Encoder MFT) |
| `budget`, from 8 Mbit/s | 962×632 | 35.8 (62.5) | 0.24 Mbit/s | 3.00 / 3.91 ms | the same | the same |

Checked in the same run: video named at `initialize` with the pipe joined;
one frame and no more before the first ack (the flow's window is one frame
until an ack comes back, then grows with the round trip); the first frame a
keyframe whose Annex B holds an SPS and a PPS; sequences 1, 2, 3 … with no
gap; every frame the size the start answered; nothing after a stop once the
frames in flight had landed; and `window-closed` when the window closed.
The capture is the limit: Windows.Graphics.Capture on the rig's Basic Render
Driver gave about 37 pictures a second of the 63 the window drew, none of
them dropped on the service's side; 120 a second was not seen.

Not proven: the stream through the real Cloudflare tunnel (it is first seen
after the owner installs the tools and updates the box), and the box's
browser stream through the desktop's viewer (the viewer below ran on a Mac
window's stream only).

### The desktop's viewer, on the Mac

`bun run script:e2e-video-viewer` (scripts/e2e-video-viewer.ts): the
viewer's own worker (`video.worker.ts`, bundled with `bun build`) in an inert
Electron window of the checkout (an accessory app, never focusable, shown
without being made key), on a stream of TC Probe `--busy` from the real
tc-computer through the in-process host of §30 "Measured". The page hands
the worker a canvas and posts `surface`, `open` and `bind` as streams.ts
does; `count` and `closed` come back through its console; the viewer's
waits are read at the host from the acks. `TC_VIEWER_PROBE=1` puts a shim in
front of the worker that counts its frame clock, decoder and socket.

2026-11-19, M4 Max, the window on the 144 Hz display, load 5.6, a 2560×1664
`quality` stream (`avc1.640034`), 10 s after 2 s each:

| | Rule | Measured |
|---|---|---|
| Frames drawn a second | 110 | 117.0, pass |
| The same, the page's main thread burning 8 ms of every 16 (62.5 times a second) | holds | 117.4, pass |
| The viewer's wait, arrival to draw, p50 / p95 | | calm 2.2 / 5.8 ms; busy 2.1 / 4.3 ms |
| `closed` | never | never, pass |
| `VideoDecoder.isConfigSupported` | | yes; with `prefer-hardware` yes |

The first runs drew nothing: the worker took the keyframe and the decoder
gave no frame back, so no ack went and the service ended the stream after
three seconds. Chromium's hardware decoder held every frame of a 2560×1664
stream whose SPS says nothing of reordering (0 out of 6 until `flush()`, at
1280×832 and in software each came back at once); with the SPS rewritten
(§30 "The encoder") each came back at once. A viewer that joins more than
three seconds after `video.open` is ended the same way, with `error`: the
app's viewer opens its socket as soon as `video.open` answers.

## What is unproven

Each layer has its own proof above. These joints have none yet, and each
is first seen in the owner's own use:

- **The whole desktop app on a real stream.** The host and its sockets are
  proven with real servers, the Mac's service and host path on the Mac, the
  viewer's own worker in Electron, and the renderer's wiring over fakes. No
  run has had the installed app's Computer section, browser canvas or
  Computers page play a real stream.
- **The box's stream in the desktop's viewer.** The viewer's proof ran on a
  Mac window's stream; the box's ran against a script's viewer. The box
  engine's SPS is checked to carry what the Mac's decoder needed
  (`videoLive.test.ts`).
- **The box through the real tunnel.** The thin link in the box's proof is a
  proxy in the script.
- **Driving from a real window.** The host's side is proven on the box with
  the real browser and engine, the renderer's over fakes.
- **A Mac's window watched from another device.** The publish leg is proven
  between two hosts on one machine with a recorded stream, not from a real
  Mac through the real box to a real viewer.
- **The Mac's encode time.** The rule is a p95 under 12 ms at 2560×1664; it
  measured 9.0 ms in one quiet run and 12.38 ms in another.
- **Windows.** No hardware encoder (the rig has no GPU), no PrintWindow
  fallback (Windows.Graphics.Capture worked), no viewer on a real PC, and
  37 frames a second, the rig's capture limit, not 120.
- **The phone.** A simulator only: no real iPhone, no mobile data (the
  simulator has no metered link, so the tap to start was not shown), no
  Mac reached through the box. The failed re-read line in the browser item
  was built after the proof's shots and is covered by its model's test
  alone.
- **Screen Recording turned off while a stream plays.** A stream that
  starts with the grant off is refused with `permission`. Whether macOS
  stops a running capture with the code the service reads as `permission`
  was not tried; it may end with "The preview stopped" instead.

## What this cannot stop

- A process of the `agents` user on the box that reads an engine's token
  file can reach that engine, as it can reach DevTools today.
- A desktop's own local socket has no key. Any process of that user on that
  machine can ask for what the desktop's own app can. That is the app's
  existing rule for the local socket, not a new one. The only source that
  takes input is the box's, and the box's local socket gets no stream.

- A held submit ends the pane's video and the canvas shows the kept
  picture, but the Computer section, the full view and a Computers tile can
  still show that page live (as the 4 fps picture, or as video opened
  later). No act runs from there; the primary still waits on the kept
  picture.
- Nothing caps how many streams one of his keys may open, beyond the box's
  four engines. Each costs a capture and an encoder on the machine that
  serves it.
- The refused apps are the host's short list (TempCode itself). A thread
  that read a password manager's window streams it, as the 4 fps preview
  shows it today.
- A menu or a notice of a page behind the curtain can be in one frame: the
  display shows it before the manager hears of it and puts it behind.
- While he drives, a menu another thread's agent opens within two seconds of
  his own input is taken for his and shows over his page. Nothing on the
  display says whose a menu is.
- A headless start after a headed one takes back the preferences the headed
  start wrote. What he changed in the browser's own settings while he drove
  stays.

## Tests

- The Mac's service, `sh scripts/computer-test.sh` on the Mac:
  `FlowControlTests` (every case of screen-relay's flow test),
  `VideoWireTests`, `VideoPipeTests` (a real socket pair), `FramePacerTests`
  and `StillWindowTests` in ComputerServiceKitTests; `AnnexBTests`,
  `VideoGeometryTests`, `SamePixelsTests` and `VideoEncoderTests` (the real
  VideoToolbox encoder on pictures made in the test) in CaptureTests;
  `VideoServiceTests` (the handlers over fakes and a socket pair) in
  ComputerServiceTests. The live proof is `bash
  scripts/mac/proof-computer-capture.sh --scenes 20,21`, which shows a
  window and so runs only after five minutes with no input.

- The Windows service, `cargo test` in `native/tc-computer-win` on the box:
  `flow.rs` (every case of screen-relay's flow test), `video/wire.rs`,
  `video/pacing.rs`, `video/annexb.rs`, `video/picture.rs`, and
  `tests/video.rs` (the handlers over a fake desktop and an in-memory pipe).
  The live proof is `bun scripts/e2e-computer-win.ts --legs video` in the
  rig.
- The phone, `swift test` in ios/TempCodeClient: `VideoTests` (the wire, the
  player's rules, the access units), `LiveVideoTests` (a stream over a
  scripted socket; `reopens`; input on a drive stream with the frame's
  generation, and `video.paste`), `VideoInputTests` (the input records byte
  for byte as `encodeInput`; a tap, a drag, two-finger scroll, a long press,
  the key records and the paste runs) and `ComputerTilesTests` (the tiles,
  which take over, by what name, and `find`)
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
- `src/main/server/computer/videoFeed.test.ts`: a window as video over the
  fake service (frames, acks, the window of eight, refusals, ends, a change
  of window, the click)
- `src/main/server/video/publish.test.ts`: the publish leg between two
  hosts in one process, with real sockets on both legs and the fake
  service as the encoder: frames arrive, acks reach the encoder, the switch
  off refuses and closes, a revoked key closes, the publish upgrade's
  refusals; `src/main/server/remote/relay.test.ts` "video.open … on the box"
- `src/renderer/src/lib/video/`: `pacing.test.ts`, `player.test.ts` (the
  stream's rules over a fake socket and decoder), `streams.test.ts` (the
  registry and the retry rule)
- `src/renderer/src/surfaces/threads/computer/ViewportVideo.dom.test.tsx`
  (live, ended, gave way, shown again), `FullWindow.dom.test.tsx` (its
  size, its caption's fade, its controls, Escape),
  `src/renderer/src/surfaces/ComputersView.dom.test.tsx`,
  `src/renderer/src/lib/computers.test.ts`
- `src/main/server/work/browser/box/`: `display.test.ts`, `chromium.test.ts`,
  `engine.test.ts` and `video.test.ts` with fakes
- The same folder, live where the tools are installed
  (`TEMP_CODE_TEST_VIDEO_TOOLS=<userData>`, else skipped): `headed.test.ts`
  (the window manager and the stage against the real Xorg, Chromium and
  engine at scale 1: the page alone at 1280×800, what stays behind the curtain, the
  keyboard, menus, the closed page), `headedService.test.ts` (the service's
  acts on covered pages), `videoLive.test.ts` (frames, input, paste, take
  and hand back through the relay), `headedScale.test.ts` (the display at
  scale 2 and 1.5: the dummy driver's mode, the page at 1280×800, the window
  manager finding the stage's windows, the agent's pictures in page units).
  `TC_BOX_HEADED=1` runs the box browser's older tests headed.

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
