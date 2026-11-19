# Live video

The owner watches the computer an agent drives as H.264 video, up to 120
frames a second, in place of the 4 fps JPEG picture. The plan is
`.temp-code/plan-WqCU4GKXKSM6.md`; this file says what is built.

**Built so far:** the wire, the contract, who may watch, the stream ticket,
the stream's own socket on both servers, the relay, and the two settings. No
source is wired yet, so `video.open` answers `unsupported` on every host and
every viewer draws the JPEG picture as before.

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
seconds, single use, bound to one stream, one scope (`watch`, `drive`, or
`publish` for a stream another host sends in) and to who asked: a key, or the
desktop's own socket by its connection id. A ticket for another stream is
spent by the try. A key that was revoked, lost `approve` or is not a client's
by the time the ticket is used opens nothing. The key itself never rides in a
URL.

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
  hands back, each drive stream sends release-all and is a watch stream from
  then on.
- A socket holding more than 8 MiB unsent is closed with `slow`.
- A stream ends when its viewer drops, when the RPC socket that asked for it
  closes, when its key is revoked (`revoked`), or when its source ends it.
- A stream nobody joined is let go after 35 seconds.

A feed (`VideoFeed`, video/feed.ts) is one viewer's stream at its source.
`VideoRpc` (video/rpc.ts) asks each `VideoSource` in turn; the first that
knows the thread answers. `FakeFeed` is the feed the tests drive by hand.

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
