import { spawn } from 'node:child_process'
import { existsSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { ConvertJob, ConvertRun, Converter } from '../formats/jobs'
import { tailOf } from '../formats/tools'
import { networkBlock, noNetwork, refusalOf, type NetworkBlock } from './egress'
import { emitPipelineEvent } from './events'
import { MEDIA_EXTS, MEETING_FORMAT, PEAKS, type PipelineEvent, type RawTranscript } from './raw'

/**
 * The transcriber (docs/agents/work-meetings.md, "The pipeline"): a
 * recording in, a `RawTranscript` out, all on this host with the network
 * blocked (egress.ts). ffmpeg decodes the recording to 16 kHz mono float32
 * in the job's scratch folder (and, when asked, writes a small AAC copy for
 * playback); then one Python child, the program below, finds who speaks
 * when (pyannote segmentation-3.0 and WeSpeaker ResNet34-LM through
 * sherpa-onnx), one voice per speaker, and the words (Silero VAD stretches
 * of at most 30 s, Parakeet TDT 0.6B v2), saying each step on stdout as one
 * JSON line, in the order `PipelineEvent` names. Every event goes to the
 * job's `options.progress` listener (events.ts) as it comes.
 */

/** The tools a transcription runs on, in the order they are checked. */
export const MEETING_TOOLS = ['ffmpeg', 'sherpa-onnx', 'parakeet-tdt-v2', 'pyannote-segmentation', 'wespeaker-resnet34-lm', 'silero-vad'] as const

const MAX_THREADS = 16
const ENV = '/usr/bin/env'

/**
 * The demuxers a recording may be opened with, for every one of MEDIA_EXTS
 * (ffmpeg's `-format_whitelist`). Each reads its own file and nothing else:
 * concat, hls, dash and the other formats that name further files are left
 * out, so a crafted `.wav` cannot make ffmpeg read another file beside it.
 */
export const DEMUXERS = ['wav', 'w64', 'mp3', 'mov', 'aac', 'loas', 'flac', 'ogg', 'asf', 'aiff', 'amr', 'amrnb', 'amrwb', 'matroska', 'avi'] as const
const OPEN = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', DEMUXERS.join(',')]
const ENGINE_PARTS = { asr: 'parakeet-tdt-0.6b-v2', seg: 'pyannote-seg-3.0', emb: 'wespeaker-resnet34-lm' }

/** Threads one transcription asks for: half the cores less one, at least 2, at most 16 (32 ran slower than 16 on the box). */
export function meetingThreads(cores: number = cpus().length): number {
  return Math.min(MAX_THREADS, Math.max(2, Math.floor(cores / 2) - 1))
}

/** The default limit on one job: 20 minutes plus half the recording's length, at most 6 hours. */
export function meetingTimeoutMs(durationSec: number | null): number {
  const cap = 6 * 60 * 60_000
  return durationSec === null ? cap : Math.min(cap, 20 * 60_000 + Math.round(durationSec * 500))
}

/** The shape `JobRunner.serveForwarded` (formats/jobs.ts) names a job another host sent: `…/work-tools/jobs/in-<id>/input.<ext>`. */
const FORWARDED_INPUT = /[\\/]work-tools[\\/]jobs[\\/]in-[^\\/]+[\\/]input\.[a-z0-9]+$/i
export const isForwarded = (job: Pick<ConvertJob, 'input' | 'here'>): boolean => job.here === true && FORWARDED_INPUT.test(job.input)

export const NOT_CARRIED = 'A recording is transcribed on the host that holds it; it is not carried between hosts.'

/** What is missing, as one sentence naming each tool. */
export function missingSentence(missing: readonly string[]): string {
  const names = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}`
  return `${names} ${missing.length === 1 ? 'is' : 'are'} not installed on this host; run scripts/work-tools/install.ts.`
}

// ── the event stream ─────────────────────────────────────────────────

const EVENTS = new Set(['start', 'peaks', 'speakers', 'turns', 'words'])

/** Splits the child's stdout into lines and keeps what is an event; a `{"fail": …}` line is the child's last word. Anything else is ignored. */
export class EventLines {
  private rest = ''
  constructor(
    private readonly onEvent: (e: PipelineEvent) => void,
    private readonly onFail: (sentence: string) => void = () => {},
    private readonly onJunk: (line: string) => void = () => {}
  ) {}

  push(chunk: string): void {
    const text = this.rest + chunk
    const lines = text.split('\n')
    this.rest = lines.pop() ?? ''
    for (const line of lines) this.line(line)
  }

  end(): void {
    const last = this.rest
    this.rest = ''
    if (last.trim()) this.line(last)
  }

  private line(raw: string): void {
    const line = raw.trim()
    if (!line) return
    let o: unknown
    try {
      o = JSON.parse(line)
    } catch {
      return this.onJunk(line)
    }
    if (o && typeof o === 'object' && typeof (o as { fail?: unknown }).fail === 'string') return this.onFail((o as { fail: string }).fail)
    if (o && typeof o === 'object' && EVENTS.has((o as { event?: string }).event ?? '')) return this.onEvent(o as PipelineEvent)
    this.onJunk(line)
  }
}

// ── the child ────────────────────────────────────────────────────────

export interface ChildSpec {
  cmd: string
  args: string[]
  env: Record<string, string>
  cwd?: string
  signal: AbortSignal
  timeoutMs: number
  onEvent: (e: PipelineEvent) => void
}

/**
 * Run the transcriber child and read its events as they come. Its process
 * group is killed on the signal or the timeout; it resolves once the child
 * is gone, and rejects with a sentence a person can read.
 */
export function runTranscriber(spec: ChildSpec): Promise<void> {
  return new Promise((resolve, reject) => {
    if (spec.signal.aborted) return reject(new Error('cancelled'))
    const child = spawn(spec.cmd, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    let err = ''
    let failed: string | null = null
    let stopped: 'cancelled' | 'timeout' | null = null
    const lines = new EventLines(spec.onEvent, (s) => (failed = s))
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => lines.push(d))
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString()
      if (err.length > 64_000) err = err.slice(-32_000)
    })
    const kill = (): void => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        /* gone */
      }
    }
    const timer = setTimeout(() => {
      stopped = 'timeout'
      kill()
    }, spec.timeoutMs)
    const onAbort = (): void => {
      stopped ??= 'cancelled'
      kill()
    }
    spec.signal.addEventListener('abort', onAbort, { once: true })
    const finish = (e: Error | null): void => {
      clearTimeout(timer)
      spec.signal.removeEventListener('abort', onAbort)
      if (e) reject(e)
      else resolve()
    }
    child.on('error', (e) => finish(new Error(`The transcriber would not start: ${e.message}.`)))
    child.on('close', (code, sig) => {
      lines.end()
      if (stopped === 'cancelled') return finish(new Error('cancelled'))
      if (stopped === 'timeout') return finish(new Error(`The transcription took longer than ${Math.round(spec.timeoutMs / 60_000)} minutes and was stopped.`))
      if (code === 0) return finish(null)
      if (err.trim()) console.error(`[work] meetings: the transcriber exited ${code ?? sig}: ${tailOf(err)}`)
      if (failed) return finish(new Error(`The transcriber stopped: ${failed}.`))
      if (/MemoryError|std::bad_alloc|Killed/.test(err) || sig === 'SIGKILL') return finish(new Error('The host ran out of memory while transcribing.'))
      finish(new Error(`The transcriber stopped before it finished (exit ${code ?? sig}).`))
    })
  })
}

// ── the converter ────────────────────────────────────────────────────

export interface MeetingDeps {
  /** whether the block works here (egress.ts); a test hands one in */
  networkBlock?: () => Promise<NetworkBlock>
  /** threads to ask for instead of `meetingThreads()` */
  threads?: number
}

interface Probe {
  durationSec: number | null
  media: 'audio' | 'video'
  hasAudio: boolean
}

/** One converter per recording format, each to `tcmeeting`. */
export function meetingConverters(deps: MeetingDeps = {}): Converter[] {
  return MEDIA_EXTS.map((ext) => ({
    from: ext,
    to: MEETING_FORMAT,
    needs: 'sherpa-onnx',
    threads: deps.threads ?? meetingThreads(),
    run: (job, run) => transcribe(job, run, deps)
  }))
}

/** Where each tool is, or the sentence that names what is missing. */
function toolsFor(run: ConvertRun): { ffmpeg: string; ffprobe: string; python: string; parakeet: string; seg: string; emb: string; vad: string; sherpa: string } {
  const t = run.tools
  const at = {
    ffmpeg: t.bin('ffmpeg'),
    ffprobe: t.bin('ffmpeg', 'ffprobe'),
    python: t.bin('sherpa-onnx'),
    parakeet: t.dir('parakeet-tdt-v2'),
    seg: t.bin('pyannote-segmentation'),
    emb: t.bin('wespeaker-resnet34-lm'),
    vad: t.bin('silero-vad')
  }
  const missing = MEETING_TOOLS.filter((name) =>
    name === 'ffmpeg' ? !at.ffmpeg || !at.ffprobe : name === 'sherpa-onnx' ? !at.python : name === 'parakeet-tdt-v2' ? !at.parakeet : name === 'pyannote-segmentation' ? !at.seg : name === 'wespeaker-resnet34-lm' ? !at.emb : !at.vad
  )
  if (missing.length) throw new Error(missingSentence(missing))
  const sherpa = t.state().tools['sherpa-onnx']?.version ?? '?'
  return { ...(at as { [K in keyof typeof at]: string }), sherpa }
}

async function transcribe(job: ConvertJob & { output: string }, run: ConvertRun, deps: MeetingDeps): Promise<{ warnings?: string[] }> {
  if (isForwarded(job)) throw new Error(NOT_CARRIED)
  const block = await (deps.networkBlock ?? networkBlock)()
  if (!block.ok) throw new Error(refusalOf(block.why))
  const tools = toolsFor(run)
  const opts = job.options ?? {}
  const token = opts.progress
  const audioOut = typeof opts.audioOut === 'string' ? opts.audioOut : null
  if (audioOut !== null && !isAbsolute(audioOut)) throw new Error('The playback copy needs an absolute path.')
  const threads = Math.max(1, Math.min(MAX_THREADS, run.threads))
  // Every child starts from a bare environment (no token of the app's reaches it), inside the block.
  const blocked = (cmd: string, args: string[], vars: Record<string, string> = {}): { cmd: string; args: string[] } => {
    const bare = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: run.tmp, TMPDIR: run.tmp, ...vars }
    const w = noNetwork(ENV, ['-i', ...Object.entries(bare).map(([k, v]) => `${k}=${v}`), cmd, ...args])
    if (!w) throw new Error(refusalOf(`${process.platform} has no way here to run a child with the network blocked`))
    return w
  }
  const pcm = join(run.tmp, 'audio.f32')
  const script = join(run.tmp, 'transcribe.py')
  const config = join(run.tmp, 'config.json')
  const partial = audioOut ? `${audioOut}.partial-${Math.random().toString(36).slice(2, 10)}.m4a` : null
  const cancelled = (): boolean => run.signal.aborted
  try {
    // What is in it, read inside the block like everything else that opens the recording.
    const p = blocked(tools.ffprobe, ['-v', 'error', ...OPEN, '-show_entries', 'stream=codec_type:stream_disposition=attached_pic:format=duration', '-of', 'json', `file:${job.input}`])
    const probed = await run.run(p.cmd, p.args, { timeoutMs: 120_000 })
    if (cancelled()) throw new Error('cancelled')
    if (probed.code !== 0) throw new Error('ffmpeg could not read this file as a recording.')
    const info = probeOf(probed.out)
    if (!info.hasAudio) throw new Error('This file holds no sound to transcribe.')
    const timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : meetingTimeoutMs(info.durationSec)
    const deadline = Date.now() + timeoutMs
    const left = (): number => Math.max(1_000, deadline - Date.now())

    // 16 kHz mono float32 for the models, and the playback copy from the same decode.
    const t0 = Date.now()
    const decodeArgs = ['-nostdin', '-hide_banner', '-loglevel', 'error', ...OPEN, '-i', `file:${job.input}`, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-y', pcm]
    if (partial) decodeArgs.push('-map', '0:a:0', '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'aac', '-b:a', '40k', '-movflags', '+faststart', '-f', 'mp4', '-y', partial)
    const d = blocked(tools.ffmpeg, decodeArgs)
    const decoded = await run.run(d.cmd, d.args, { timeoutMs: left() })
    if (cancelled()) throw new Error('cancelled')
    if (decoded.code !== 0 || !existsSync(pcm)) throw new Error(`ffmpeg could not decode this recording${decoded.out.trim() ? `: ${tailOf(decoded.out)}` : '.'}`)
    if (statSync(pcm).size < 4 * 1600) throw new Error('This recording is too short to transcribe.')
    const decodeSec = (Date.now() - t0) / 1000
    // The player's copy is whole once the decode is: it plays while the rest runs, and after a failure.
    if (partial && audioOut && existsSync(partial)) renameSync(partial, audioOut)

    writeFileSync(script, TRANSCRIBER_PY)
    writeFileSync(config, JSON.stringify({ audio: pcm, media: info.media, peaks: PEAKS, threads, segmentation: tools.seg, embedding: tools.emb, parakeet: tools.parakeet, vad: tools.vad }))
    const n = String(threads)
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: run.tmp,
      TMPDIR: run.tmp,
      LANG: 'C.UTF-8',
      PYTHONUNBUFFERED: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      OMP_NUM_THREADS: n,
      OPENBLAS_NUM_THREADS: n,
      MKL_NUM_THREADS: n,
      NUMEXPR_NUM_THREADS: n,
      VECLIB_MAXIMUM_THREADS: n
    }
    const out: RawTranscript = { durationSec: 0, media: info.media, peaks: [], turns: [], voices: {}, words: [], engine: `${ENGINE_PARTS.asr}+sherpa-onnx ${tools.sherpa}+${ENGINE_PARTS.seg}+${ENGINE_PARTS.emb}`, timings: { decodeSec, speakersSec: 0, wordsSec: 0, threads } }
    let stage = 0 // 0 start, 1 peaks, 2 speakers, 3 turns, 4 words
    let tPeaks = 0
    let tTurns = 0
    const order = (e: PipelineEvent): number => ({ start: 0, peaks: 1, speakers: 2, turns: 3, words: 4 })[e.event]
    const onEvent = (e: PipelineEvent): void => {
      const at = order(e)
      if (at < stage || (at > stage + 1 && !(stage === 1 && at === 3))) throw new Error(`the transcriber said ${e.event} out of order`)
      stage = at
      if (e.event === 'start') out.durationSec = e.durationSec
      else if (e.event === 'peaks') {
        out.peaks = e.peaks
        tPeaks = Date.now()
      } else if (e.event === 'turns') {
        out.turns = e.turns
        out.voices = e.voices
        tTurns = Date.now()
        out.timings.speakersSec = (tTurns - tPeaks) / 1000
      } else if (e.event === 'words') out.words.push(...e.words)
      emitPipelineEvent(token, e)
    }
    const c = blocked(tools.python, ['-I', script, config], env)
    let outOfOrder: Error | null = null
    await runTranscriber({
      ...c,
      env,
      cwd: run.tmp,
      signal: run.signal,
      timeoutMs: left(),
      onEvent: (e) => {
        if (outOfOrder) return
        try {
          onEvent(e)
        } catch (err) {
          outOfOrder = err as Error
        }
      }
    })
    if (outOfOrder) throw new Error(`The transcriber stopped: ${(outOfOrder as Error).message}.`)
    if (stage < 3) throw new Error('The transcriber stopped before it found the speakers.')
    out.timings.wordsSec = (Date.now() - tTurns) / 1000
    writeFileSync(job.output, JSON.stringify(out))
    return {}
  } finally {
    for (const f of [pcm, script, config, ...(partial ? [partial] : [])]) rmSync(f, { force: true })
  }
}

/** What ffprobe's JSON says: the length, whether a real picture stream is there (album art is not video), whether there is sound. */
export function probeOf(out: string): Probe {
  const a = out.indexOf('{')
  const b = out.lastIndexOf('}')
  let j: { streams?: { codec_type?: string; disposition?: { attached_pic?: number } }[]; format?: { duration?: string } } = {}
  try {
    if (a >= 0 && b > a) j = JSON.parse(out.slice(a, b + 1))
  } catch {
    /* nothing readable */
  }
  const streams = j.streams ?? []
  const duration = Number(j.format?.duration)
  return {
    durationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
    media: streams.some((s) => s.codec_type === 'video' && !s.disposition?.attached_pic) ? 'video' : 'audio',
    hasAudio: streams.some((s) => s.codec_type === 'audio')
  }
}

// ── the program ──────────────────────────────────────────────────────

/**
 * The transcriber itself, run as `<meetings venv python> -I <file>` inside
 * the network block (the packaged app ships no loose scripts). It imports
 * json, sys, time, numpy and sherpa_onnx and nothing else; egress.test.ts
 * fails if a network module appears here. Its one argument is a JSON file:
 * `audio` (raw float32 at 16 kHz), `media`, `peaks`, `threads` and each
 * model's path.
 */
export const TRANSCRIBER_PY = String.raw`import json
import sys
import time

import numpy as np
import sherpa_onnx as so

SR = 16000
cfg = json.load(open(sys.argv[1]))
T = int(cfg["threads"])


def emit(o):
    sys.stdout.write(json.dumps(o, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def fail(sentence):
    emit({"fail": sentence})
    sys.exit(3)


audio = np.fromfile(cfg["audio"], dtype=np.float32)
dur = len(audio) / SR
emit({"event": "start", "durationSec": round(dur, 3), "media": cfg["media"]})

# The outline: the loudest sample of each bucket, the loudest bucket is 1.
P = int(cfg["peaks"])
edges = np.linspace(0, len(audio), P + 1).astype(np.int64)
mag = np.abs(audio)
peaks = np.array([mag[a:b].max() if b > a else 0.0 for a, b in zip(edges[:-1], edges[1:])], dtype=np.float64)
top = peaks.max() if len(peaks) else 0.0
if top > 0:
    peaks = peaks / top
del mag
emit({"event": "peaks", "peaks": [round(float(x), 3) for x in peaks]})

if dur < 0.5:
    emit({"event": "turns", "turns": [], "voices": {}})
    sys.exit(0)

# Who speaks when.
dc = so.OfflineSpeakerDiarizationConfig(
    segmentation=so.OfflineSpeakerSegmentationModelConfig(
        pyannote=so.OfflineSpeakerSegmentationPyannoteModelConfig(model=cfg["segmentation"]), num_threads=T),
    embedding=so.SpeakerEmbeddingExtractorConfig(model=cfg["embedding"], num_threads=T),
    clustering=so.FastClusteringConfig(num_clusters=-1, threshold=1.0),
    min_duration_on=0.3, min_duration_off=0.5)
if not dc.validate():
    fail("the speaker models did not load")
sd = so.OfflineSpeakerDiarization(dc)
last = [0.0]


def progress(done, total):
    now = time.monotonic()
    if done >= total or now - last[0] >= 0.5:
        last[0] = now
        emit({"event": "speakers", "done": int(done), "total": int(total)})
    return 0


segs = sd.process(audio, callback=progress).sort_by_start_time()
turns = [{"speaker": int(s.speaker), "start": round(float(s.start), 3), "end": round(float(s.end), 3)} for s in segs]
del sd

# One voice per speaker: the mean of unit embeddings over its longest stretches no other speaker overlaps.
ex = so.SpeakerEmbeddingExtractor(so.SpeakerEmbeddingExtractorConfig(model=cfg["embedding"], num_threads=T))
voices = {}
for spk in sorted({t["speaker"] for t in turns}):
    others = [(t["start"], t["end"]) for t in turns if t["speaker"] != spk]
    clear = []
    for t in turns:
        if t["speaker"] != spk:
            continue
        pieces = [(t["start"], t["end"])]
        for o0, o1 in others:
            nxt = []
            for s, e in pieces:
                if o1 <= s or o0 >= e:
                    nxt.append((s, e))
                    continue
                if o0 > s:
                    nxt.append((s, o0))
                if o1 < e:
                    nxt.append((o1, e))
            pieces = nxt
        clear += [(s, e) for s, e in pieces if e - s >= 1.5]
    clear.sort(key=lambda p: p[0] - p[1])
    vecs, held = [], 0.0
    for s, e in clear:
        if held >= 60.0:
            break
        e = min(e, s + 60.0 - held)
        if e - s < 1.5:
            break
        st = ex.create_stream()
        st.accept_waveform(SR, audio[int(s * SR):int(e * SR)])
        st.input_finished()
        v = np.array(ex.compute(st), dtype=np.float64)
        n = np.linalg.norm(v)
        if n > 0:
            vecs.append(v / n)
            held += e - s
    if vecs:
        m = np.mean(vecs, axis=0)
        n = np.linalg.norm(m)
        if n > 0:
            voices[str(spk)] = [round(float(x), 6) for x in m / n]
del ex
emit({"event": "turns", "turns": turns, "voices": voices})

# The words: Silero VAD stretches of at most 30 s, each decoded alone, one stream at a time.
rec = so.OfflineRecognizer.from_transducer(
    encoder=cfg["parakeet"] + "/encoder.int8.onnx", decoder=cfg["parakeet"] + "/decoder.int8.onnx",
    joiner=cfg["parakeet"] + "/joiner.int8.onnx", tokens=cfg["parakeet"] + "/tokens.txt",
    num_threads=T, model_type="nemo_transducer", decoding_method="greedy_search")
vc = so.VadModelConfig()
vc.silero_vad.model = cfg["vad"]
vc.silero_vad.min_silence_duration = 0.3
vc.silero_vad.min_speech_duration = 0.2
vc.silero_vad.max_speech_duration = 30.0
vc.sample_rate = SR
vc.num_threads = 1
vad = so.VoiceActivityDetector(vc, buffer_size_in_seconds=120)
W = vc.silero_vad.window_size


def words_of(off, samples):
    st = rec.create_stream()
    st.accept_waveform(SR, samples)
    rec.decode_stream(st)
    r = st.result
    out, cur = [], None
    for tok, t in zip(r.tokens, r.timestamps):
        at = off + t
        if tok.startswith("▁") or tok.startswith(" ") or cur is None:
            if cur:
                out.append(cur)
            cur = {"w": tok.lstrip("▁ "), "s": at, "e": at + 0.08}
        else:
            cur["w"] += tok
            cur["e"] = at + 0.08
    if cur:
        out.append(cur)
    end = off + len(samples) / SR
    for a, b in zip(out, out[1:] + [None]):
        a["e"] = max(a["e"], min(b["s"] if b else end, a["s"] + 1.0))
    return [{"w": w["w"], "s": round(w["s"], 3), "e": round(w["e"], 3)} for w in out if w["w"]], end


def drain():
    while not vad.empty():
        off = vad.front.start / SR
        samples = np.array(vad.front.samples, dtype=np.float32)
        vad.pop()
        words, end = words_of(off, samples)
        emit({"event": "words", "uptoSec": round(end, 3), "words": words})


for i in range(0, len(audio) - W, W):
    vad.accept_waveform(audio[i:i + W])
    drain()
vad.flush()
drain()
`
