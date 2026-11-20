# Work: meetings and recordings

Milestone 35 of the Work plan built this pillar. A meeting is a canvas item
of kind `meeting`: a recording (audio or video) or a transcript file the
owner drops into a Work thread, played and read beside the thread. A
recording is transcribed on the host that holds it, with speaker turns, and
**no part of it ever leaves that host**. [work.md](work.md) says how the
pillar mounts; [work-canvas.md](work-canvas.md) how a kind plugs into the
pane; [work-formats.md](work-formats.md) the toolchain and jobs it runs on.

Files: the wire is `src/shared/contract-work-meetings.ts`; the server is
`src/main/server/work/meetings/`; the canvas is
`src/renderer/src/work/meetings/`; the tools manifest is
`scripts/work-tools/meetings.json`.

## A mail's recording

An audio attachment opened from a mail (`{at: 'mail'}`) is a meeting item whose recording is the copy the host fetched into the item's folder (work-canvas.md "Fetched sources"): `start` takes that path as it takes a file of his, and the canvas starts it once the copy has come. A video attachment is the media kind's, so it plays and is not transcribed.

## The pipeline

A recording becomes a `RawTranscript` (raw.ts) through one converter per
recording format (`MEDIA_EXTS`: wav, mp3, m4a, aac, flac, ogg, opus, wma,
aiff, amr, mp4, m4v, mov, mkv, webm, avi) to the format `tcmeeting`,
registered through the module's `convert` and run by `ctx.convert`
(pipeline.ts, `meetingConverters`). The job is asked with `here: true`.

1. **Probe.** ffprobe reads the streams and the length.
2. **Decode.** ffmpeg writes 16 kHz mono float32 for the models and, from
   the same decode, the player's copy: mono AAC, 24 kHz, 40 kbit/s, in an
   `.m4a` (3.6 MB for 12 minutes). The copy is renamed into place as soon
   as the decode ends, so it plays while the rest runs and after a failure.
3. **One Python child** (`TRANSCRIBER_PY`, run as `<meetings-venv python>
   -I <file> <config>`) says each step on stdout as one JSON line, in this
   order: `start`, `peaks` (400 values for the wave), `speakers` (progress),
   `turns` (who spoke when, and one voice per speaker), `words` (one event
   per stretch). Speakers come before words, so the canvas shows named
   turns as the words arrive.
   - Who speaks when: sherpa-onnx offline diarization, pyannote
     segmentation-3.0 and WeSpeaker ResNet34-LM, clustering threshold 1.0,
     `min_duration_on` 0.3 s, `min_duration_off` 0.5 s.
   - A voice per speaker: the mean of unit embeddings over its longest
     stretches that no one else overlaps, up to 60 s.
   - Words: Silero VAD stretches of at most 30 s, each decoded alone by
     Parakeet TDT 0.6B v2 (int8).
4. merge.ts turns words and turns into segments (`segmentsOf`): a new
   segment where the speaker changes, at a pause of 1.5 s, and at a
   sentence end once one passes 45 s. A speaker with under 10 s of speech in
   all is folded into the speaker whose voice is nearest (`foldStrays`).

**Threads:** `min(16, max(2, floor(cores / 2) - 1))` (`meetingThreads`): 15
on the box. The job runner's cap is half the cores; one is left free.

**Time limit:** 20 minutes plus half the recording's length, at most 6 hours
(`meetingTimeoutMs`). The child's process group is killed on the limit, on
cancel and when Work turns off.

**Progress** cannot come back through `convert`, which answers at the end:
the job carries a token (`options.progress`), and the meeting listens with
`onPipelineEvents` (events.ts).

### The network block

Every child of a transcription (ffprobe, ffmpeg, the Python child) runs with
no network (egress.ts, `noNetwork`):

- **Linux:** `unshare -r -n --`, a user and network namespace of its own
  whose only interface is a loopback that is down. It works on the box with
  `kernel.apparmor_restrict_unprivileged_userns` at 1. A connect fails with
  ECONNREFUSED; files the child writes are the real user's.
- **macOS:** `sandbox-exec -p '(version 1)(allow default)(deny network*)'`.
- **Anything else** (Windows) has no block, and a transcription there
  refuses: `This host cannot run a transcription with the network blocked: …`.
  There is no unblocked path and no switch.

`networkBlock()` tries the block once per process. Every child also starts
from a bare environment (`/usr/bin/env -i` inside the block: PATH, LANG, HOME
and TMPDIR in the job's folder, and the Python child's thread counts), so no
token of the app's reaches it.

What the Linux block does not cover: a Unix socket on the filesystem the
user can reach (`unshare -n` removes IP and abstract sockets only). The
children never open one (ffmpeg's protocol list has no `unix`, and the
Python imports no network module), so only code that took over ffmpeg
through a crafted file could; macOS's `deny network*` covers these too. ffmpeg opens the file only as `file:` with
`-protocol_whitelist file,pipe` and only through a demuxer that reads its own
file (`DEMUXERS`, `-format_whitelist`), so a crafted `.wav` that is really an
ffconcat list or a playlist is refused before anything is read.

**A recording is never carried to another host.** The converter refuses a
job that `JobRunner.serveForwarded` sent here (`isForwarded`), so a Mac
without the tools can never send audio to the box through the tunnel. A
host without the tools says so: `… is not installed on this host; run
scripts/work-tools/install.ts.`

### The tools

`scripts/work-tools/meetings.json`, installed by
`bun scripts/work-tools/install.ts --data <userData> --only meetings-venv,sherpa-onnx,parakeet-tdt-v2,pyannote-segmentation,wespeaker-resnet34-lm,silero-vad`
(a comma list; with spaces only the first name installs). Every file is a
pinned URL with its sha256 and size; no token is needed.

| Tool | Version | Licence | On disk |
|---|---|---|---|
| `meetings-venv` | a venv of the base CPython 3.12.16, its own so no other pillar's pins change its numpy | PSF-2.0 | 122 MB with the packages |
| `sherpa-onnx` | 2.0.1, with sherpa-onnx-core 2.0.1 and numpy 2.5.5 | Apache-2.0 (onnxruntime MIT, numpy BSD-3-Clause) | in the venv |
| `parakeet-tdt-v2` | Parakeet TDT 0.6B v2, int8 | CC-BY-4.0 | 631 MB |
| `pyannote-segmentation` | segmentation-3.0, sherpa-onnx's ONNX export | MIT | 5.8 MB |
| `wespeaker-resnet34-lm` | VoxCeleb ResNet34-LM | CC-BY-4.0 | 26 MB |
| `silero-vad` | v4, 16 kHz only | MIT | 0.6 MB |

About 0.8 GB. Offered on linux-x64, darwin-arm64 and darwin-x64, not on
win32 (no block there). Installed and probed on the box (linux-x64) and the
owner's Mac (darwin-arm64) on 2026-11-19. The installer records 0 bytes for
a pip tool, and measures a venv before pip fills it.

### What it costs

On the box (32 cores, 15 threads, under other threads' load), a 12-minute
four-speaker recording (AMI EN2002a): 58.6 s through the CLI and 60.7 s
through the app's own job path, about 5 minutes per audio hour; 1,945
words; peak memory of the child 1.4 GiB. The first `speakers` event comes
about 18 s in (segmentation says nothing), so the canvas says "Finding who
speaks" until the words begin. Never run two test transcriptions at once on
the box: 15 threads took its load from 4.6 to 15.

On the owner's Mac (M4 Max, 16 cores, 7 threads, macOS 27.2) the same 12
minutes took 46.5 s, with 1,960 words, the same 7 speakers before folding
and the first 40 words the box's word for word; the child's peak was
2.38 GiB (macOS counts resident memory differently). The fixture took 3.1 s.
The player's `.m4a` played in Electron's Chromium there. The meetings venv
is 85 MB on the Mac (122 MB on the box).

### Proving it

- `src/main/server/work/meetings/egress.test.ts` always checks the block (a
  child inside cannot reach a listener on 127.0.0.1; outside it can), the
  refusal without a block and that the Python imports no network module.
  With `TEMP_CODE_WORK_TOOLS_DATA=<userData>` it also runs a real
  transcription of the fixture through `JobRunner`, watching every process
  the job starts (Linux `/proc`, every 50 ms) and failing if one shares the
  test's network namespace; runs the whole CLI under an outer `unshare -r -n`;
  and refuses an ffconcat list named `.wav`. Add
  `TEMP_CODE_MEETING_AUDIO=<file>` to transcribe that file instead of the
  fixture.
- `cli.ts` runs the pipeline outside the app:
  `bun src/main/server/work/meetings/cli.ts --data <userData> [--threads n] [--audio-out f.m4a] [--out t.json] <recording>`,
  and `--egress-check`. It bundles with `bun build … --target=bun` for a
  host with no checkout.
- `fixtures/two-speakers.ogg` is 35 s of AMI EN2002a (CC BY 4.0); its
  README says where it came from.

## What is kept

`work_meetings` (store.ts), one row per canvas item of kind `meeting`, keyed
by the item's id: the status (`empty`, `transcribing`, `ready`, `failed`),
the file it was made from (a `{ at: 'file' }` source on this host), what it
was made from (`recording` or `transcript`), the length, the progress, the
error, the engine, the 400 peaks, the player's copy's file name, `rev`, and
one JSON document (`doc`) with the speakers, the segments (each with its
words' times, kept here only) and the notes, with the notes before the last
write for Undo.

- The player's copy is a file in the thread's attachment folder
  (`attachmentDir`), `<stem>.<item id's first 8>.meeting.m4a`. The path fence
  admits it for `attachment.readRange`, a thread's delete sweeps it, and a
  move carries it.
- **What leaves the host, outside the pipeline.** The pipeline sends
  nothing anywhere. Like every attachment, though, a meeting's files move
  between the owner's own hosts: a thread's move carries the player's copy,
  playing a meeting held on another host reads the copy over that host's
  link, and Choose a file uploads the recording to the thread's host. The
  daily restic backups of both hosts (encrypted, to R2) hold the app
  database, voices included, and the attachment folders. These are the
  owner's to rule on; nothing here changes them.
- The table has `session_id`, so a thread's move (`tableMoveModule
  ('meetings', 'work_meetings')`, registered in `ensure`) and a history
  import carry its meetings.
- A meeting still transcribing when its host stops says so at the next start
  of Work: "It stopped when <host> restarted. The recording is fine." with
  Try again (`recover`).
- No file of the meeting is written apart from the player's copy: there is no
  export of the transcript yet.

## Transcript files

parse.ts reads a transcript the owner drops in place of a recording: Teams
`.vtt` (the `<v Name>` tag) and `.docx`, Zoom `.vtt` and `.txt` ("Name:
words"), and `.srt`. Each becomes segments with the file's speaker names;
nothing is transcribed and there is no player. A file over 32 MB is not a
transcript. The Zoom `.txt` and Teams `.docx` layouts were written from
memory and samples made here; no real export of either has been tried.

## Notes

The agent writes a meeting's notes with `meeting_notes`: `summary`,
`decisions`, `questions` (left open) and `actions` (tasks). notes.ts checks
every line against the record (`checkNotes`):

- A line must give `refs` (segment ids) or a `quote`, or both. An unknown ref
  is dropped and named; a quote not found in the transcript at 90% token
  agreement is left off and named (quotes.ts, `matchQuote`); a line left with
  neither is dropped.
- A kept quote is replaced by the transcript's own words, and the line's
  moment (`at`) is its first word's time. So every quote the notes show is in
  the transcript.
- An action the writer says LifeOS already holds (`lifeosTaskId`) shows as
  filed only if LifeOS confirms it (`taskExists`, the query
  `LIFEOS_GET_TASK`); otherwise the id is dropped, named, and the task waits
  for the owner like any other. Until milestone 7 nothing can be confirmed.
- Notes are a direct write with Undo (the design's rule for an agent writing
  on his own recording). A rewrite keeps his word: a filed task stays filed,
  a rejected one stays rejected (matched by its words), and Undo never loses
  a task LifeOS holds.

## Tasks

A task the meeting yields waits as a suggestion at the turn it was said in,
until the owner accepts it. `work.meetings.decide` (capability `approve`)
takes his word: accept files each task in LifeOS, reject drops it. Two
accepts of one task file it once, even when a rewrite renumbered it between
them (the guard is the task's words). A task filed while an Undo took the
notes away stays on the record, and a new transcription of the meeting keeps
every filed task (with no turn and no minute).

Filing (filing.ts, `fileTask`) goes through the host's own LifeOS session,
never a thread's tool: `ctx.lifeos.owner().mutation('tasks:create', { sector,
title, description, dueAt? })`, the sector being the thread's workspace's
(`ctx.scopeOf(sessionId).sector`). The description says where it was said
("From “Staff sync” at 11:20.") and quotes it. A bare due date means 9:00 on
the host's clock. A task that cannot be filed stays waiting, and the canvas
says why on the pane's state line with Try again: no sector ("This thread's
workspace is not linked to a LifeOS sector …"), LifeOS not connected, or
LifeOS's own refusal.

meetings.test.ts proves the filing against fakes of `ctx.scopeOf` and
`ctx.lifeos`. `LIFEOS_CREATE_TASK` is the one place that names LifeOS's
function.

## Voices

A voice is biometric data, and some recordings are Purdue's: voices stay on
the host and only ever suggest a name (voices.ts).

- Three tables with no `session_id`: a meeting's speakers' voices, the voices
  kept under a name, and which speakers went into each. No move, no history
  import, no method and no tool carries an embedding.
- A speaker is named once the meeting is ready (while it transcribes, the
  speakers are still being found and their ids may change).
- Naming a speaker (`work.meetings.speaker`) keeps that speaker's voice under
  the name (the mean of every speaker given it).
- In a later meeting an unnamed speaker whose voice is at cosine 0.6 or
  closer to a kept one is offered that name, the nearest only and each name
  to one speaker at most (`suggested` on the wire). Nothing applies it but
  his press. The research measured 0.84 to 0.91 for the same person and 0.29
  at most for another.
- `work.meetings.forgetVoice` forgets the voice kept under a name; the names
  on meetings stay, since they are his words.

## Methods and push

| Method | Capability | Does |
|---|---|---|
| `work.meetings.get {itemId}` | read | `{ meeting }`, null when the item has none yet |
| `work.meetings.start {itemId, source?}` | operate | makes the meeting from the item's file or `source`: a transcript is read now, a recording starts transcribing and this answers at once. A meeting that is ready or running is left alone unless a new file is named. Starts of one meeting run one after another, so a running job is always the one cancel reaches |
| `work.meetings.cancel {itemId}` | operate | stops a transcription and waits until it has gone |
| `work.meetings.speaker {itemId, speakerId, name}` | operate | names a speaker, or takes the name back with null |
| `work.meetings.decide {itemId, actionIds, decision}` | approve | `{ meeting, failed }` |
| `work.meetings.undoNotes {itemId}` | operate | puts back the notes before the last write |
| `work.meetings.voices` | read | the names with a kept voice, never the voice |
| `work.meetings.forgetVoice {name}` | operate | |
| `work.meetings.recording {itemId, offset, length}` | read | `{ name, size, dataBase64 }`: the original recording, read in ranges of at most 2 MB for Download recording. A remote key reads it only where the path fence lets it name the file (`ctx.reaches`, else `FenceError`); a transcript says "This meeting has no recording.", a file gone "<name> is not on <host> any more." |

Every method runs on the host that holds the thread (`MEETINGS_RELAY` is
empty). The path fence reads the file a `source` names. The push
`{ push: 'work.meetings', itemId, sessionId, rev, status }` carries no
transcript; the canvas fetches again when `rev` moves, at most every two
seconds while it transcribes.

## Tools

Every Work thread gets four (tools.ts), and its preamble says that a
recording never goes to any other tool, service or host and that it never
files meeting tasks itself:

- `meeting_open { file, title? }` opens a file on this host as a meeting
  beside the root thread and waits up to nine minutes for the transcript.
- `meeting_read { meeting, from? }` answers lines as `s12 [11:20] Name:
  words`, 24,000 characters a call, with where to go on.
- `meeting_find { meeting, query }` answers the turns that hold every word.
- `meeting_notes { meeting, summary?, decisions?, questions?, actions? }`
  writes the notes and says what was dropped and why.

## The canvas

The approved prototype is `.temp-code/prototypes/work-workspaces-2/meeting.html`,
its pick "the transcript, with the player over it"; docs/DESIGN.md "The
canvas pane" has the measures. `canvas.ts` claims sound files by mime type
and extension; a video stays the media kind's, and a transcript file is
claimed by no kind, unless either is opened as a meeting (`meeting_open`).

- **Files:** `MeetingCanvas.tsx` (the chunk: `Body` and `Bar`, and the
  pane's feeds), `MeetingView.tsx` (the parts, drawn from props), `Speaker.tsx`
  (naming a speaker), `data.ts` (one copy of each meeting, fetched again when
  the push's `rev` moves), `player.ts`, `model.ts` (the pure parts),
  `sample.ts` (the prototype's meeting, for the preview and the tests). The
  chunk is `work-meetings-canvas`; nothing is in the first paint.
- **The player** is a 40px row: play, `15:02 / 42:10`, a 100-bar wave from
  the 400 peaks that scrubs by pointer and by arrows (Shift for 30 s), and
  the speed (1×, 1.25×, 1.5×, 2×). On the first play it reads the copy in
  2 MB ranges with `attachment.readRange` into one Blob. A seek before that
  (a click on a turn, a decision's minute) lands where the play starts.
- **Turns:** the name (a link that opens the naming popover) and the minute
  over the words; a click seeks, unless it ended a selection; the turn
  playing sits on `muted`. A speaker with an offered name says "Sounds like
  Dana Lee" at its first turn; the popover offers Use, and Forget this voice
  once a voice is kept under the name.
- **Tasks** sit under their turn on `--add-bg` with the add-task glyph
  (`TaskAdd`) until accepted, then show LifeOS's mark (`Lifeos`) untinted. The pane's stepper steps through those waiting (the
  player and the list move to each), Accept files the current one, and the
  pane's More holds Accept all and Reject all. A filing that failed is the
  state line, with Try again.
- **Notes:** once there are notes, a Notes and Transcript switch in the bar
  (Transcript first). The notes are a short document on the document scale:
  any summary lines, then Decided, To do and Open questions, each line ending
  in its minute, an accent link that plays that moment. "Wrote notes, Mon
  10:52 AM" with Undo takes the stepper's place when no task waits.
- **Find** at the bar's end (the kind's tools slot takes the free room, so
  `ms-auto` puts it there): hits on `--find-hit`, the current one on `--sel-bg`
  with an accent line, Enter and Shift+Enter to step, Escape to close.
- **A stretch:** a selection across turns tints them as one block and its
  span on the wave; the selection bar offers Ask ("15:02 to 15:41, Staff
  sync, Nov 16") and Copy.
- **Transcribing:** the turns heard so far, the spinner with "Finding who
  speaks" or "Transcribing, 14 of 42 minutes", then two turns still to come.
  **Nothing yet:** one Empty, "Drop a recording", and Choose a file (or a
  drop), which uploads the file to the thread's host and starts it. **Could
  not transcribe:** an error Alert with the reason and Try again; the player
  stays.
- **Mode:** "Agent writes", fixed: the agent's notes are a direct write, its
  tasks always suggestions.
- **More** holds Export transcript first once there is a transcript
  (`shell.more`): the title, then each turn's time and speaker over its
  words, saved as `<title>.txt` (`transcriptText`, model.ts). Then, for a
  meeting made from a recording, whatever its state, Download recording:
  the original as it was dropped, under its own name, read in ranges from
  the host that holds it (`downloadRecording`, player.ts). In the desktop
  app he picks where it goes and each range is written there as it comes,
  so a long video is never held whole; elsewhere the ranges are saved as one
  file. While it comes the row reads "Downloading… 40%" and takes no press;
  leaving the meeting ends it without a word.
- **No bar** while the meeting has nothing in it (Drop a recording): its
  `Bar` renders nothing, so the pane draws none.

Preview: `bun run ui:preview src/renderer/src/work/meetings/MeetingCanvas.preview.tsx#MeetingPreview --width 864`
(eight moments, both themes). Tests: `model.test.ts`,
`MeetingCanvas.dom.test.tsx` (the kind in the real pane: a click on a
decision's minute seeks the player, the stepper files a task, Find, the
states).

### Where it differs from the prototype

- The Notes and Transcript switch is drawn once notes exist. The pick has no
  notes in the canvas, but a decision must be a click away from its moment,
  and the design report offers the notes as the transcript's own tab.
- "Agent writes" is a fixed word, not a menu: there is no suggest mode for
  notes on his own recording.
- Not built: Make task in the selection bar (it should open LifeOS's task
  sheet, milestone 25),
  topics, and aligning a transcript file with a recording dropped beside it.
