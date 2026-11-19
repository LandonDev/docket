# Work: images and video

Milestone 34 of the Work plan. The `media` canvas kind opens an image or a
video beside a Work thread, plays it frame-accurately, and keeps notes on
it keyed by frame. It works on files; Frame.io plugs in later (milestone
48) through a source adapter. [work.md](work.md) says how a pillar is
mounted, [work-canvas.md](work-canvas.md) how a kind sits in the pane, and
[work-formats.md](work-formats.md) how its ffmpeg jobs run. The look is
docs/DESIGN.md "The canvas pane", "Images and video".

## Files

| Part | Where |
|---|---|
| The wire, the frame maths, the shapes | `src/shared/contract-work-media.ts` |
| The module: methods, tools, converters, deleted threads | `src/main/server/work/media/index.ts`, `tools.ts` |
| The rows | `src/main/server/work/media/store.ts` |
| Probing, what plays, the ffmpeg command lines | `probe.ts`, `plan.ts`, `encode.ts` |
| Making what the viewer needs, the cache | `prepare.ts` |
| The view, pushes, the agent's writes | `view.ts` |
| Milestone 48's seam | `sources.ts` |
| The kind | `src/renderer/src/work/media/canvas.ts` |
| The body and the bar | `MediaCanvas.tsx`, `Player.tsx`, `Picture.tsx`, `Notes.tsx`, `parts.tsx` |
| Frame-accurate seeks, the HLS feeder, what this viewer decodes, the store | `seek.ts`, `segments.ts`, `plays.ts`, `store.ts` |

No tool is installed for it: the toolchain's ffmpeg and ffprobe 9.0.2
(`scripts/work-tools/base.json`, GPL, run only as separate processes) do
the probes, the proxies, HEIC and the tiles. There is no `media.json`.

## Frames, never seconds

A note on a video stores a **frame index** into its version's frame
table. The formats research measured why (reports/hIIKbJY4UKbv,
images-video-and-frame-io): a seek to a frame's start time showed the
wrong frame 5 to 12 times in 16; a seek to the **centre** of the frame's
interval showed the right one every time, on H.264, VP9 and AV1, in
Electron 39.

- `FrameTable` (contract) is `cfr` (start, rate as a ratio, count) or
  `vfr` (every frame's start time). ffprobe's packet times build it on
  the host (`frameTableOf`); a rate in the metadata alone is never trusted.
- `frameCentre(t, n)` is where a seek goes; `frameAt(t, s)` names the
  frame at a time, with a millisecond of slack, since decoders report a
  frame's start rounded down (WebM keeps milliseconds).
- `seekToFrame(video, table, n)` (seek.ts) pauses, seeks to the centre,
  waits for `seeked` and the next frame callback, and names the frame
  from its `mediaTime` (a quarter frame on: `frameOfMediaTime`). A newer
  seek takes over an older one. `stepFrame` adds frames to where the last
  seek was heading, so quick presses add up; never `currentTime += 1/fps`.
  `watchFrames` is the clock while playing.
- Timecodes: `frameTimecode(n, rate, start)` counts drop-frame at 29.97
  and 59.94 from the file's own start timecode (the `tmcd` track, read by
  ffprobe on the host, since Chromium does not expose it).

## What plays

A version keeps everything the host has for it side by side
(`MediaVersion.plays`: the original, and the proxy once some viewer needed
it), and each viewer takes the first it can decode (`playFor`, contract),
so a Mac that plays HEVC and a box desktop that does not never flip each
other's player. `work.media.view { itemId, plays }` names what the asking
viewer decodes (plays.ts asks its own `<video>`: `h264`, `h264-hi`, `hevc`,
`vp9`, `av1`, `prores`), and starts what it lacks; only a caller that may
operate (or this window) starts work, a read-only key sees what is there.
The host decides (plan.ts):

- **The original** where the viewer decodes it, served from where it
  lies. A picture or a video the media host would serve as it is, lying
  outside the folders it shows (the projects, the workspaces, the
  attachments), is refused with a sentence and never linked or copied in:
  the agent can name any path, and the media host serves other desktops.
  A video ffprobe reads that the media host would not serve as it is (MXF,
  AVI, MTS) is shown from a proxy.
- **An H.264 proxy** for a viewer that cannot decode it (ProRes, DNxHR,
  HEVC off the Mac, H.264 at 10 bits on a viewer that says no, anything
  interlaced): High 8-bit
  4:2:0, at most 1920 on the long side, CRF 23 capped at 10 Mb/s, a
  keyframe a second, AAC 192k, and `-fps_mode passthrough`. The host then
  probes the proxy and refuses it unless its frame count equals the
  original's, since every note is a frame index.
- **An HLS proxy** for a file over ten minutes: the same encode cut into
  4 s fMP4 segments, written as they are made, so it plays before it is
  done. Electron 39 has no HLS of its own: `attachSegments` (segments.ts)
  feeds Media Source, keeping 30 s ahead of the playhead and dropping what
  is 30 s behind. `work.media.segment` answers a segment's bytes when the
  player asks for it (a URL each would crowd the media host's token
  table on a long proxy); the segments' times are on the fMP4's own
  timeline.
  **The HLS proxy has its own table**: its fMP4 starts two frames late (the
  encoder's B-frame delay, with no edit list), so the host probes the
  playlist for it, and while it is still being written uses the
  original's table moved to the first segment's start.
- **A picture** as it is (PNG, JPEG, GIF, WebP, AVIF). **HEIC**, HEIF,
  TIFF and PSD are converted to a JPEG on the host, the HEIC's tile grid
  and `irot` applied (ffmpeg 9 reads both; sharp's prebuilt binaries
  cannot). A tile grid takes no ffmpeg filter, so the agent's still of a
  HEIC and its tiles are cut from that JPEG.
- **Deep Zoom tiles** for a picture over 40 megapixels: one ffmpeg run
  decodes it once and cuts every level from the first with more than one
  512 px tile up to full size (`tileLevels`, `untile`), plus a 2048 px
  preview the canvas shows under them. `work.media.tile` answers one tile
  as base64; the canvas fetches only the tiles in view, at the level its
  zoom needs (`levelFor`).

Proxies, conversions and tiles are jobs through `ctx.convert`
(`MEDIA_CONVERTERS`: `video→proxy.mp4`, `video→proxy.m3u8`,
`heic|heif|tif|tiff|psd→jpg`, `image→dzi`), so they share the host's cap on
jobs and threads, run at nice 19, and die with Work. A proxy reports its
progress (`MediaVersion.progress`) from ffmpeg's `-progress` file; the
canvas shows it with a bar.

What a version made lives in `<userData>/attachments/work-media/<versionId>/`
(the probe, the frame tables, proxies, tiles, stills), under the one
userData root the media host already serves, so its URLs need no fence of
their own. A file that changed on disk (size or time) starts over, noticed
on every read of the item. A failure stays until the file changes or the
person presses Retry on the state line (`retry`); a viewer's reads never
start it again. Each version's jobs stop with Work, and when its thread is
deleted. ffprobe writes the packet times to a file (`-o`): a long video's
list is megabytes, past what a child's captured output keeps.

## The store

Three tables, each made by the module's `ensure`, each with `session_id`
so a moved thread takes them (`tableMoveModule` as `media-items`,
`media-versions`, `media-notes`):

| Table | Holds |
|---|---|
| `work_media_items` | per canvas item: `mode` (`writes` default, `suggests`), `shared`, `last_write` (the agent's last direct write, for Undo), `rev` |
| `work_media_versions` | `n` (v1, v2…), `name`, `source` (a `CanvasSource`), who added it and when, the probe |
| `work_media_notes` | `kind` (`comment`, `chapter`), `anchor` (`versionId`, `frame`, `durationFrames`, `region`, `pin`, `shapes` in picture space 0 to 1), `body`, `by` (a `Principal`), `state` (`kept`, `suggested`), `resolved`, `parent_id`, `external` (a review service's id and author), `write_id` |

The first version is the file the canvas item names, made on first sight.

## The wire

| Method | Capability | Does |
|---|---|---|
| `work.media.view {itemId, plays?, retry?}` | read | the `MediaView`; for a caller that may operate, starts what that viewer needs, and a failed version again with `retry` |
| `work.media.note {itemId, anchor, body, kind?, parentId?}` | operate | the person's note |
| `work.media.edit {noteId, body?, resolved?}` | operate | |
| `work.media.remove {noteId}` | operate | a note and its replies |
| `work.media.decide {itemId, which, accept}` | operate | a waiting note (or `all`): Accept makes it the person's, Reject drops it |
| `work.media.mode {itemId, mode}` | operate | what the agent does to the item |
| `work.media.undo {itemId, writeId}` | operate | takes back the agent's last direct write |
| `work.media.version {itemId, source}` | operate | another file as the next version |
| `work.media.segment {itemId, versionId, index}` | read | `{ data }`: one HLS segment, base64 |
| `work.media.tile {itemId, versionId, level, x, y}` | read | `{ data }`: one tile, base64 JPEG |

The push is `{ push: 'work.media', itemId, view }` to sockets holding
`read`, at most twice a second per item.

## The agent's tools

The tools wait only for the probe, never for a proxy being made, and stop
with the call's signal. A still is taken from the original: ffmpeg seeks
well before the frame (an MPEG-TS seek lands on the keyframe after its
point) and takes the first frame at or after half a frame before its
start, so the agent sees frame n itself, from a file whose timeline starts
late too.

`media_info` (facts, versions, every note with frame and time),
`media_frames` (up to 8 stills by frame or time, or spread over the clip;
an image item's picture), `media_note` (at a moment, over a stretch, on a
region), `media_chapters`, `media_version`. A moment is a frame number,
`0:41`, `1:02:05.5`, `12s` or a timecode (`00:00:41:12`, from the file's
start timecode). An agent's notes land by the item's mode: on the person's
own file they go straight on and the bar says so ("Added 7 chapters, 2:04
PM") with Undo; in Suggests, or on a shared item, they wait as
suggestions, each a tinted row and a green tick on the track, stepped by
the pane's one stepper. Accept makes a note the person's.

## The canvas

The body is the approved pick, the player over its comments: the frame
(radius 8, 12px inset), the scrubber (a 24px row, a 4px `track`, a 12px
head, a 2 by 6 tick per note, segments per chapter), the 32px transport
(play, the time, a comment at this frame, speed, sound, full screen), then
the notes by time on a 36/20/1fr grid. A click on a note goes back to its
frame and shows its region.

- **Selections for Ask**: Shift and drag along the track takes a stretch
  ("1:28 to 1:36, Skyblock trailer v3"); a drag on the picture takes a
  region ("Region at 0:41, …", or "Region of …" on an image). The chip's
  quote carries the exact frames, timecodes and region for the thread.
  The bar's own control after Ask is Comment, which opens the comment
  field at the selection.
- **Keys** on the player: Space or K plays; the arrows (or , and .) step
  a frame, Shift a second; Home and End. A focused button or menu keeps
  its own keys.
- **Versions**: the bar's History menu lists them; picking another plays
  it beside the shown one on one transport, kept on the same frame index,
  with two pickers and a close in the bar in place of the mode. A compare
  takes no region.
- **An image** fits the stage (`--stage`) inside a 24px inset; the bar
  holds its size, its bytes and zoom (Fit, 25% to 400%).
- **States**: bones while the host reads the file; a bar with the share
  done while a proxy or a conversion is made; the pane's state line, with
  Retry, when a version fails, over the empty stage.

## For Frame.io (milestone 48)

- Register a `MediaSourceAdapter` (`sources.ts`) for `at: 'frameio'` from
  the Frame.io module's `start`: `resolve` gives a version's rendition as
  a `MediaPlay` with its frame table (Frame.io serves its own renditions,
  so the host makes no proxy), `notes` gives the service's comments with
  `external` set. The kind already claims `{ at: 'frameio' }` sources.
- Set `work_media_items.shared` (`MediaStore.setShared`) for a Frame.io
  item: the agent's notes then wait for the person, and the mode shows
  "Agent suggests" with no switch. Posting one is a held `frameio.post` in
  the thread, never a canvas button.
- A note's `anchor` is Frame.io's shape already: `frame` (check whether
  V4 counts from 0 or 1), `durationFrames`, `shapes` in 0 to 1 from the top
  left (`width` is a share of the height; Frame.io's `size` is pixels),
  `pin`.

## Proofs

- `src/shared/contract-work-media.test.ts`: the frame maths and drop-frame
  timecodes.
- `src/main/server/work/media/media.test.ts`: the plan, the command lines,
  probing, the agent's moments; then the pillar end to end on the
  toolchain's real ffmpeg (found through `TEMP_CODE_WORK_TOOLS_DATA`, the
  box's userData or the Mac's): an H.264 original, a 4K ProRes proxy frame
  for frame beside the original for a viewer that plays it, an HLS proxy
  and its segments, notes at their frames, the agent's writes and
  suggestions, stills of frame n from MP4 and MPEG-TS, a 130,000-frame
  table, a file outside the shown folders refused, a failure kept until
  the file changes, versions, tiles, and an Apple
  HEIC (`fixtures/*.heic`, written by ImageIO on the Mac: a 512 px tile
  grid, one with `irot`).
- `src/main/server/work/media/frameAccuracy.test.ts`: the research's
  frame-accuracy test in Electron. It runs only with
  `TEMP_CODE_WORK_TOOLS_DATA` set and xvfb present (`TEMP_CODE_WORK_TOOLS_DATA=/srv/agents/temp-code-data NODE_ENV=test bun x vitest run src/main/server/work/media/frameAccuracy.test.ts`,
  about 20 s): barcoded clips in H.264, VP9 and AV1, a 4K ProRes clip the
  viewer cannot decode and its proxy, and an HLS proxy through
  `attachSegments`; 16 of 16 target frames right by their pixels on each.
- `src/renderer/src/work/media/*.test.ts(x)`: the seeks, the HLS feeder,
  and the body (a comment returns to its frame, the stepper, the mode and
  the written line, the chips, the picture's scale and tile level).
- `MediaCanvas.preview.tsx` for `bun run ui:preview`.

## Not yet

- A file on another host plays only from a thread on that host.
- Shapes drawn by hand: the canvas draws what a note carries and takes a
  region, but has no pen yet.
- WebCodecs stills (mediabunny), wipe and onion-skin compares, PSD
  layers: not built.
