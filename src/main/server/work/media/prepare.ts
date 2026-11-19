import { closeSync, existsSync, realpathSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { frameStart, FrameTableSchema, VIEWER_DEFAULT_PLAYS, type FrameTable, type MediaPlay, type MediaProbe, type MediaVersion } from '@shared/contract-work-media'
import { errorText, type HostId } from '@shared/work'
import { classifyMedia, fsMedia, insideRealRoots, MEDIA_SCRATCH_DIR, mediaServes, mediaUrl, workMediaRoot } from '../../media'
import type { ConvertJob, ConvertResult, Converter } from '../formats/jobs'
import { runTool, tailOf } from '../formats/tools'
import { frameArgs, proxyArgs, stillArgs, tileLevels, tilesArgs, TILE } from './encode'
import { planImage, planVideo } from './plan'
import { parsePacketTimes, probeFile, type Probed } from './probe'
import { mediaSourceFor } from './sources'
import { mediaCacheDir, versionWire, type VersionRow } from './store'
import type { WorkCtx } from '../modules'

/**
 * Turns a version's file into what the canvas shows
 * (docs/agents/work-media.md, "What plays"): probe it, serve the original
 * where it lies in the folders this host shows, and make what a viewer
 * asks for and cannot have (a proxy, an HLS proxy, a HEIC's JPEG, Deep
 * Zoom tiles) through `ctx.convert`, under the host's cap on jobs and
 * threads. A version keeps its original and its proxy side by side, and
 * each viewer takes what it decodes (`playFor`). What it makes is kept
 * under the version's cache folder and reused after a restart; a file that
 * changed on disk starts over, noticed on every read.
 */

/** What preparing needs of the host: the context, where userData is, and how to find ffmpeg. */
export interface PrepHost {
  ctx: WorkCtx
  dataDir: string
  ffprobe(): string | null
  ffmpeg(): string | null
  /** the version's view changed: push it */
  changed(itemId: string): void
  /** aborts when Work turns off: every job the pillar started ends */
  signal: AbortSignal
}

type Proxy = { via: 'proxy'; file: string; table: FrameTable; why: string } | { via: 'hls'; dir: string; table: FrameTable; why: string }

interface Prep {
  /** the file's size and time when it was read */
  sig?: string
  error?: string
  progress?: number
  probe?: MediaProbe
  /** the original's frame table: every note's frames are counted in it */
  table?: FrameTable
  original?: { file: string; mime: string }
  /** a viewer that cannot decode the original asked: make the proxy */
  wantProxy?: string
  /** what each viewer that asked before the probe was done decodes */
  asked: Array<readonly string[]>
  /** the proxy could not be made; the version itself stands */
  proxyError?: string
  proxy?: Proxy
  image?: { file: string; width: number; height: number; converted?: string }
  tiles?: { preview: string; width: number; height: number; levels: number; minLevel: number }
  adapter?: MediaPlay
  /** this version's own stop */
  abort: AbortController
  /** its stop or Work's: what every job of the version runs under */
  signal: AbortSignal
  /** settles once the probe is done (or failed) */
  probed: Promise<void>
  running: Promise<void> | null
}

const sigOf = (path: string): string | null => {
  try {
    const st = statSync(path)
    return `${st.size}:${Math.floor(st.mtimeMs)}`
  } catch {
    return null
  }
}
const readJson = <T>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}
const extOf = (path: string): string => extname(path).slice(1).toLowerCase()
const headOf = (path: string): Buffer => {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(64)
    return buf.subarray(0, readSync(fd, buf, 0, 64, 0))
  } finally {
    closeSync(fd)
  }
}
/** A table moved to start where another file's first frame starts. */
const shifted = (t: FrameTable, start: number): FrameTable =>
  t.kind === 'cfr' ? { ...t, start } : { kind: 'vfr', times: t.times.map((x) => x - t.times[0] + start), end: t.end - t.times[0] + start }

/** The earliest presentation time among a file's first packets: where its timeline starts (a B-frame delay moves it off zero). */
async function firstPts(ffprobe: string, path: string, signal: AbortSignal): Promise<number | null> {
  const r = await runTool(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+#16', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', path], { timeoutMs: 30_000, signal })
  const times = r.code === 0 ? parsePacketTimes(r.out) : []
  return times.length ? Math.min(...times) : null
}

/** Waits for `p`, or throws when the signal aborts first. */
function until<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p
  if (signal.aborted) return Promise.reject(new Error('cancelled'))
  return new Promise<T>((resolve, reject) => {
    const off = (): void => reject(new Error('cancelled'))
    signal.addEventListener('abort', off, { once: true })
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', off))
  })
}

/** One HLS playlist's segments and whether it is finished. */
export function parsePlaylist(text: string): { segments: Array<{ start: number; duration: number; name: string }>; ended: boolean } {
  const segments: Array<{ start: number; duration: number; name: string }> = []
  let start = 0
  let pending: number | null = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const inf = /^#EXTINF:([\d.]+)/.exec(line)
    if (inf) pending = Number(inf[1])
    else if (line && !line.startsWith('#') && pending !== null) {
      segments.push({ start, duration: pending, name: line })
      start += pending
      pending = null
    }
  }
  return { segments, ended: /#EXT-X-ENDLIST/.test(text) }
}

const OUTSIDE = 'It is outside the folders this host shows: open it from the workspace\'s folder'

export class Preparer {
  private preps = new Map<string, Prep>()

  constructor(private readonly host: PrepHost) {}

  /**
   * The version as the wire shows it now. With `start`, also begins what
   * this viewer needs: the probe on first sight, a proxy when it cannot
   * decode the original, the version again after a failure when `retry`.
   */
  view(v: VersionRow, o: { plays?: readonly string[]; start?: boolean; retry?: boolean } = {}): MediaVersion {
    const plays = o.start ? (o.plays ?? VIEWER_DEFAULT_PLAYS) : undefined
    let prep = this.fresh(v)
    // A version nobody who may operate has opened is only described: a read-only key starts nothing.
    if (!prep && !o.start) return versionWire(v, { state: 'probing', plays: [] })
    if (!prep || (o.retry && prep.error)) prep = this.begin(v, plays)
    else if (plays && !prep.probe) prep.asked.push(plays)
    else if (plays && prep.probe?.kind === 'video' && !prep.error && !prep.proxy) {
      if (o.retry) prep.proxyError = undefined
      const plan = planVideo(prep.probe, plays)
      if (plan.via !== 'original') prep.wantProxy ??= plan.why
      if (prep.wantProxy && !prep.proxyError && !prep.running) this.run(v, prep)
    }
    return this.wire(v, prep)
  }

  /** Waits for the version's probe (and, for a picture, its conversion), or the signal. */
  async ready(v: VersionRow, signal?: AbortSignal): Promise<Prep> {
    const prep = this.fresh(v) ?? this.begin(v)
    await until(prep.probed, signal)
    if (prep.error) throw new Error(prep.error)
    if (prep.probe?.kind === 'image' && prep.running) await until(prep.running, signal)
    if (prep.error) throw new Error(prep.error)
    return prep
  }

  /** Waits for everything the version has under way (tests). */
  async settled(versionId: string): Promise<void> {
    await this.preps.get(versionId)?.running
  }

  /** The original's frame table: notes, timecodes and the agent's moments count in it. */
  table(versionId: string): FrameTable | undefined {
    return this.preps.get(versionId)?.table
  }

  /** Threads were deleted: stop their jobs and drop what was made. */
  forget(versionIds: readonly string[]): void {
    for (const id of versionIds) {
      this.preps.get(id)?.abort.abort()
      this.preps.delete(id)
      rmSync(mediaCacheDir(this.host.dataDir, id), { recursive: true, force: true })
    }
  }

  /** A still of one frame (or the picture) as JPEG bytes, at most `maxSide` px: what the agent looks at. Needs only the probe. */
  async still(v: VersionRow, frame: number | null, signal?: AbortSignal, maxSide = 1280): Promise<Buffer> {
    const ffmpeg = this.host.ffmpeg()
    if (!ffmpeg) throw new Error('ffmpeg is not installed on this host (Settings, Work, Conversion tools)')
    const prep = await this.ready(v, signal)
    // A picture's still comes from what the canvas shows: a HEIC's grid takes no ffmpeg filter, so it is cut from the host's JPEG.
    const shown = prep.image?.file ?? prep.tiles?.preview ?? prep.original?.file
    const input = frame === null && shown ? shown : this.inputOf(v)
    const dir = join(mediaCacheDir(this.host.dataDir, v.id), 'stills')
    mkdirSync(dir, { recursive: true })
    const out = join(dir, `${frame ?? 'still'}-${maxSide}.jpg`)
    if (!existsSync(out)) {
      const t = prep.table
      // Half a frame before frame n's start, counted from the file's own start, which is where ffmpeg counts from: the video may begin after it (audio first, a B-frame delay, a transport stream's clock).
      const at = frame !== null && t ? Math.max(0, frameStart(t, frame) - (prep.probe?.startS ?? frameStart(t, 0)) - (frameStart(t, frame + 1) - frameStart(t, frame)) / 2) : 0
      const args = frame === null ? stillArgs({ input, output: out, threads: 2, maxSide }) : frameArgs({ input, output: out, at, maxSide })
      const r = await runTool(ffmpeg, args, { timeoutMs: 120_000, gentle: true, signal: signal ? AbortSignal.any([prep.signal, signal]) : prep.signal })
      if (r.code !== 0 || !existsSync(out)) throw new Error(`ffmpeg could not take the frame: ${tailOf(r.out)}`)
    }
    return readFileSync(out)
  }

  /** One Deep Zoom tile's bytes, or null past the picture's edge. */
  tile(versionId: string, level: number, x: number, y: number): Buffer | null {
    if (!this.preps.get(versionId)?.tiles) return null
    const file = join(mediaCacheDir(this.host.dataDir, versionId), 'tiles', String(level), `${x}_${y}.jpg`)
    return existsSync(file) ? readFileSync(file) : null
  }

  /** One HLS segment's bytes, read when the player wants it (a token each would crowd the media host's table on a long proxy). */
  segment(versionId: string, index: number | 'init'): Buffer | null {
    const proxy = this.preps.get(versionId)?.proxy
    if (proxy?.via !== 'hls') return null
    const name = index === 'init' ? 'init.mp4' : parsePlaylist(this.readPlaylist(proxy.dir)).segments[index]?.name
    if (!name || !/^[\w.-]+$/.test(name)) return null
    const file = join(proxy.dir, name)
    return existsSync(file) ? readFileSync(file) : null
  }

  // ── the work ───────────────────────────────────────────────────────

  /** The version's prep, unless its file changed since it was read: then its jobs stop and it starts over. */
  private fresh(v: VersionRow): Prep | null {
    const prep = this.preps.get(v.id)
    if (!prep) return null
    // A file that changed is a new picture; one that was missing and is back is read at last.
    const now = v.source.at === 'file' ? sigOf(v.source.path) : null
    if (v.source.at === 'file' && !prep.running && (prep.sig ? now !== prep.sig : !!prep.error && now !== null)) {
      prep.abort.abort()
      this.preps.delete(v.id)
      return null
    }
    return prep
  }

  private begin(v: VersionRow, plays?: readonly string[]): Prep {
    this.preps.get(v.id)?.abort.abort()
    const abort = new AbortController()
    let probedDone!: () => void
    const prep: Prep = { abort, signal: AbortSignal.any([this.host.signal, abort.signal]), probed: new Promise<void>((r) => (probedDone = r)), running: null, asked: plays ? [plays] : [] }
    this.preps.set(v.id, prep)
    this.run(v, prep, probedDone)
    return prep
  }

  private run(v: VersionRow, prep: Prep, probedDone?: () => void): void {
    prep.running = this.work(v, prep, probedDone)
      .catch((err) => {
        prep.error = errorText(err)
        this.host.ctx.log(`media: ${v.name}: ${prep.error}`)
      })
      .finally(() => {
        probedDone?.()
        prep.running = null
        prep.progress = undefined
        if (this.preps.get(v.id) === prep) this.host.changed(v.itemId)
      })
  }

  private async work(v: VersionRow, prep: Prep, probedDone?: () => void): Promise<void> {
    if (v.source.at !== 'file') {
      const adapter = mediaSourceFor(v.source.at)
      if (!adapter) throw new Error(`a ${v.source.at} file cannot be shown here yet`)
      const got = await adapter.resolve(v.source, this.host.ctx, prep.signal)
      if (got.probe) prep.probe = got.probe
      if ('table' in got.play) prep.table = got.play.table
      prep.adapter = got.play
      return
    }
    if (v.source.host !== this.host.ctx.host) throw new Error(`the file is on ${v.source.host}; open it from a thread there`)
    const path = v.source.path
    const sig = sigOf(path)
    if (!sig) throw new Error(`there is no file at ${path}`)
    prep.sig ??= sig
    const dir = mediaCacheDir(this.host.dataDir, v.id)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    // A file rewritten since it was read is a new picture: what was made from the old one goes.
    if (readJson<{ sig: string }>(join(dir, 'sig.json'))?.sig !== prep.sig) {
      for (const name of readdirSync(dir)) rmSync(join(dir, name), { recursive: true, force: true })
      writeFileSync(join(dir, 'sig.json'), JSON.stringify({ sig: prep.sig }))
    }
    if (!prep.probe) {
      const probed = await this.probe(path, dir, prep.signal)
      prep.probe = probed.probe
      prep.table = probed.table
      // Shown only from the folders this host shows, converted or not: the agent may name any path, and what is made from it is served to other desktops.
      if (!this.shown(path)) throw new Error(OUTSIDE)
      const direct = await fsMedia(path)
      if (direct) prep.original = { file: path, mime: direct.mime }
    }
    probedDone?.()
    this.host.changed(v.itemId)
    if (prep.probe.kind === 'video') {
      // A video ffprobe reads but the media host would not serve (MXF, AVI, MTS) has no original to show: only a proxy.
      if (!prep.original) prep.wantProxy ??= `${extOf(path).toUpperCase()} is shown from a proxy`
      for (const plays of prep.asked) {
        const plan = planVideo(prep.probe, plays)
        if (plan.via !== 'original') prep.wantProxy ??= plan.why
      }
      if (prep.wantProxy && !prep.proxy) {
        // A proxy that fails leaves the version standing: its original and its frame table still serve the viewers that decode it, and the agent.
        try {
          await this.makeProxy(v, prep, path, dir, prep.wantProxy)
        } catch (err) {
          if (prep.signal.aborted) throw err
          prep.proxyError = errorText(err)
          if (!prep.original) throw err
          this.host.ctx.log(`media: ${v.name}: no proxy: ${prep.proxyError}`)
        }
      }
    } else await this.image(prep, path, dir)
  }

  private async probe(path: string, dir: string, signal: AbortSignal): Promise<Probed> {
    const cached = readJson<Probed>(join(dir, 'probe.json'))
    if (cached?.probe && (!cached.table || FrameTableSchema.safeParse(cached.table).success)) return cached
    const ffprobe = this.host.ffprobe()
    if (!ffprobe) throw new Error('ffprobe is not installed on this host (Settings, Work, Conversion tools)')
    const probed = await probeFile(ffprobe, path, signal)
    writeFileSync(join(dir, 'probe.json'), JSON.stringify(probed))
    return probed
  }

  /**
   * A file the media host serves (server/media.ts `mediaServes`: under its
   * roots, outside its denied folders, by the real path), and not one of the
   * host's own makings: the media host serves this pillar's cache and the
   * diff view's scratch copies too, but a file there is never a source (a
   * version whose source sat in its own cache folder would empty it).
   */
  private shown(path: string): boolean {
    let real: string
    try {
      real = realpathSync(path)
    } catch {
      return false
    }
    return mediaServes(real) && !insideRealRoots(real, [workMediaRoot(this.host.dataDir), MEDIA_SCRATCH_DIR])
  }

  private inputOf(v: VersionRow): string {
    if (v.source.at === 'file') return v.source.path
    throw new Error('this version has no file on this host')
  }

  private async makeProxy(v: VersionRow, prep: Prep, path: string, dir: string, why: string): Promise<void> {
    const probe = prep.probe!
    const hls = planVideo(probe, []).via === 'hls'
    const done = join(dir, hls ? 'hls.done' : 'proxy.done')
    const out = hls ? join(dir, 'hls', 'index.m3u8') : join(dir, 'proxy.mp4')
    if (!existsSync(done)) {
      rmSync(hls ? join(dir, 'hls') : out, { recursive: true, force: true })
      if (hls) mkdirSync(join(dir, 'hls'), { recursive: true })
      const progress = join(dir, 'progress.txt')
      const total = probe.frames ?? 0
      const ffprobe = this.host.ffprobe()!
      let shifting = false
      const timer = setInterval(() => {
        const m = /frame=(\d+)\s*$/m.exec(existsSync(progress) ? (readFileSync(progress, 'utf8').split('progress=').slice(-2, -1)[0] ?? '') : '')
        if (m && total) {
          prep.progress = Math.min(0.99, Number(m[1]) / total)
          this.host.changed(v.itemId)
        }
        // An HLS proxy plays while it is written, once its first segment says where its timeline starts.
        if (hls && !prep.proxy && !shifting && existsSync(join(dir, 'hls', 'seg00001.m4s'))) {
          shifting = true
          void firstPts(ffprobe, out, prep.signal).then((start) => {
            if (start !== null && !prep.proxy) prep.proxy = { via: 'hls', dir: join(dir, 'hls'), table: shifted(prep.table!, start), why }
            else shifting = false
          })
        }
      }, 2000)
      try {
        await this.convert({ from: 'video', to: hls ? 'proxy.m3u8' : 'proxy.mp4', input: path, output: out, options: { probe, progress }, signal: prep.signal })
      } catch (err) {
        prep.proxy = undefined
        throw err
      } finally {
        clearInterval(timer)
        rmSync(progress, { force: true })
      }
      // The proxy must have the original's frames, one for one: every note is a frame index.
      const check = await probeFile(ffprobe, out, prep.signal)
      const want = probe.frames ?? 0
      if (check.probe.frames !== want) {
        prep.proxy = undefined
        throw new Error(`the proxy has ${check.probe.frames} frames where the original has ${want}`)
      }
      writeFileSync(join(dir, hls ? 'hls-table.json' : 'proxy-table.json'), JSON.stringify(check.table))
      writeFileSync(done, '')
    }
    const table = FrameTableSchema.parse(readJson(join(dir, hls ? 'hls-table.json' : 'proxy-table.json')))
    prep.proxy = hls ? { via: 'hls', dir: join(dir, 'hls'), table, why } : { via: 'proxy', file: out, table, why }
  }

  private async image(prep: Prep, path: string, dir: string): Promise<void> {
    const probe = prep.probe!
    const plan = planImage(probe, extOf(path))
    if (plan.via === 'image' && prep.original) {
      prep.image = { file: prep.original.file, width: probe.width, height: probe.height }
      return
    }
    if (plan.via === 'tiles') {
      const manifest = join(dir, 'tiles.json')
      if (!existsSync(manifest)) await this.convert({ from: 'image', to: 'dzi', input: path, output: manifest, options: { width: probe.width, height: probe.height }, signal: prep.signal })
      const t = readJson<{ width: number; height: number; levels: number; cut: number[] }>(manifest)!
      prep.tiles = { preview: join(dir, 'preview.jpg'), width: t.width, height: t.height, levels: t.levels, minLevel: Math.min(...t.cut) }
      return
    }
    const display = join(dir, 'display.jpg')
    if (!existsSync(display)) await this.convert({ from: extOf(path) || 'image', to: 'jpg', input: path, output: display, signal: prep.signal })
    const shown = await probeFile(this.host.ffprobe()!, display, prep.signal)
    prep.image = { file: display, width: shown.probe.width, height: shown.probe.height, converted: extOf(path).toUpperCase() }
  }

  private convert(job: ConvertJob): Promise<ConvertResult> {
    return this.host.ctx.convert(job)
  }

  private readPlaylist(dir: string): string {
    try {
      return readFileSync(join(dir, 'index.m3u8'), 'utf8')
    } catch {
      return ''
    }
  }

  private wire(v: VersionRow, prep: Prep): MediaVersion {
    const state: MediaVersion['state'] = prep.error ? 'failed' : !prep.probe ? 'probing' : prep.running ? 'preparing' : 'ready'
    return versionWire({ ...v, ...(prep.probe ? { probe: prep.probe } : {}) }, {
      state,
      ...(prep.error ? { error: prep.error } : {}),
      ...(prep.proxyError ? { proxyError: prep.proxyError } : {}),
      ...(prep.progress !== undefined ? { progress: prep.progress } : {}),
      plays: this.playsOf(prep)
    })
  }

  private playsOf(prep: Prep): MediaPlay[] {
    const url = (file: string, mime: string): string => mediaUrl(file, { kind: mime.startsWith('image') ? 'image' : 'video', mime }, statSync(file).mtimeMs)
    const out: MediaPlay[] = []
    try {
      if (prep.adapter) out.push(prep.adapter)
      if (prep.original && prep.probe?.kind === 'video' && prep.table) out.push({ via: 'original', url: url(prep.original.file, prep.original.mime), mime: prep.original.mime, table: prep.table })
      const p = prep.proxy
      if (p?.via === 'proxy') out.push({ via: 'proxy', url: url(p.file, 'video/mp4'), table: p.table, why: p.why })
      if (p?.via === 'hls' && existsSync(join(p.dir, 'init.mp4'))) {
        const { segments, ended } = parsePlaylist(this.readPlaylist(p.dir))
        // The playlist counts from 0; the fMP4's own timeline starts where the table does (two frames late, from the encoder's B-frames).
        const from = frameStart(p.table, 0)
        out.push({ via: 'hls', init: url(join(p.dir, 'init.mp4'), 'video/mp4'), segments: segments.map(({ start, duration }) => ({ start: start + from, duration })), ended, mime: `video/mp4; codecs="avc1.640028${prep.probe?.audio ? ',mp4a.40.2' : ''}"`, table: p.table, why: p.why })
      }
      const i = prep.image
      if (i) out.push({ via: 'image', url: url(i.file, i.file.endsWith('.jpg') ? 'image/jpeg' : (prep.original?.mime ?? classifyMedia(i.file, headOf(i.file))?.mime ?? 'image/jpeg')), width: i.width, height: i.height, ...(i.converted ? { converted: i.converted } : {}) })
      const t = prep.tiles
      if (t) out.push({ via: 'tiles', preview: url(t.preview, 'image/jpeg'), width: t.width, height: t.height, tile: TILE, overlap: 0, levels: t.levels, minLevel: t.minLevel, format: 'jpg' })
    } catch (err) {
      // A file that went away between the read and this answer: the next read starts over.
      this.host.ctx.log(`media: a rendition went away: ${errorText(err)}`)
    }
    return out
  }
}

// ── the converters this pillar registers (`WorkModule.convert`) ──────

/** ffmpeg's progress file reports `frame=N`; the job's own `progress` option names it. */
const proxyConverter = (to: 'proxy.mp4' | 'proxy.m3u8'): Converter => ({
  from: 'video',
  to,
  needs: 'ffmpeg',
  threads: 4,
  async run(job, run) {
    const probe = job.options?.probe as MediaProbe | undefined
    if (!probe) throw new Error('a proxy needs the probe of its original')
    const ffmpeg = run.tools.bin('ffmpeg')!
    const progress = typeof job.options?.progress === 'string' ? job.options.progress : undefined
    const r = await run.run(ffmpeg, proxyArgs({ input: job.input, output: job.output, probe, threads: run.threads, hls: to === 'proxy.m3u8', progress }), { timeoutMs: 6 * 60 * 60_000, gentle: true })
    if (r.code !== 0) throw new Error(`ffmpeg could not make the proxy: ${tailOf(r.out)}`)
    return {}
  }
})

/** A still in a format Chromium cannot show (HEIC, TIFF, PSD's flattened picture) as a JPEG, its orientation applied. */
const stillConverter = (from: string): Converter => ({
  from,
  to: 'jpg',
  needs: 'ffmpeg',
  threads: 2,
  async run(job, run) {
    const r = await run.run(run.tools.bin('ffmpeg')!, stillArgs({ input: job.input, output: job.output, threads: run.threads }), { timeoutMs: 5 * 60_000, gentle: true })
    if (r.code !== 0 || !existsSync(job.output)) throw new Error(`ffmpeg could not convert the picture: ${tailOf(r.out)}`)
    return {}
  }
})

/** Deep Zoom tiles of a picture too large to decode whole: every level in one run, a 2048 px preview, and `tiles.json` at `job.output`. */
const tilesConverter: Converter = {
  from: 'image',
  to: 'dzi',
  needs: 'ffmpeg',
  threads: 4,
  async run(job, run) {
    const ffmpeg = run.tools.bin('ffmpeg')!
    const dir = join(job.output, '..')
    const width = Number(job.options?.width)
    const height = Number(job.options?.height)
    if (!(width > 0 && height > 0)) throw new Error('tiles need the picture size')
    const { max, levels } = tileLevels(width, height)
    // A HEIC's tile grid takes no filter of ours: decode it whole first.
    let input = job.input
    if (/\.(heic|heif)$/i.test(input)) {
      input = join(run.tmp, 'whole.jpg')
      const r = await run.run(ffmpeg, stillArgs({ input: job.input, output: input, threads: run.threads }), { timeoutMs: 5 * 60_000, gentle: true })
      if (r.code !== 0) throw new Error(`ffmpeg could not decode the picture: ${tailOf(r.out)}`)
    }
    const tiles = join(dir, 'tiles')
    rmSync(tiles, { recursive: true, force: true })
    for (const l of levels) mkdirSync(join(tiles, String(l.level)), { recursive: true })
    let r = await run.run(ffmpeg, tilesArgs({ input, dir: tiles, levels, threads: run.threads }), { timeoutMs: 15 * 60_000, gentle: true })
    if (r.code !== 0) throw new Error(`ffmpeg could not cut the tiles: ${tailOf(r.out)}`)
    // untile numbers its frames row by row; Deep Zoom names them by column and row.
    for (const l of levels) {
      for (let i = 0; i < l.cols * l.rows; i++) {
        const from = join(tiles, String(l.level), `${i}.jpg`)
        if (existsSync(from)) renameSync(from, join(tiles, String(l.level), `${i % l.cols}_${Math.floor(i / l.cols)}.jpg`))
      }
    }
    r = await run.run(ffmpeg, stillArgs({ input, output: join(dir, 'preview.jpg'), threads: run.threads, maxSide: 2048 }), { timeoutMs: 5 * 60_000, gentle: true })
    if (r.code !== 0) throw new Error(`ffmpeg could not make the preview: ${tailOf(r.out)}`)
    writeFileSync(job.output, JSON.stringify({ width, height, levels: max + 1, cut: levels.map((l) => l.level) }))
    return {}
  }
}

export const MEDIA_CONVERTERS: Converter[] = [proxyConverter('proxy.mp4'), proxyConverter('proxy.m3u8'), ...['heic', 'heif', 'tif', 'tiff', 'psd'].map(stillConverter), tilesConverter]

/** The name of a file for its first version: its own, without the folder. */
export const nameOf = (path: string): string => basename(path)
export type { HostId }
