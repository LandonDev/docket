import { closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { frameCentre, FrameTableSchema, VIEWER_DEFAULT_PLAYS, type FrameTable, type MediaPlay, type MediaProbe, type MediaVersion } from '@shared/contract-work-media'
import { errorText, type HostId } from '@shared/work'
import { classifyMedia, fsMedia, mediaUrl } from '../../media'
import type { ConvertJob, ConvertResult, Converter } from '../formats/jobs'
import { runTool, tailOf } from '../formats/tools'
import { frameArgs, proxyArgs, stillArgs, tileLevels, tilesArgs, TILE } from './encode'
import { planImage, planVideo } from './plan'
import { parsePacketTimes, probeFile, type Probed } from './probe'
import { mediaSourceFor } from './sources'
import { mediaCacheDir, versionWire, type VersionRow } from './store'
import type { WorkCtx } from '../modules'

/**
 * Turns a version's file into something the canvas can show
 * (docs/agents/work-media.md, "What plays"): probe it, decide from what the
 * viewer decodes, and make what is missing (a proxy, an HLS proxy, a HEIC's
 * JPEG, Deep Zoom tiles) through `ctx.convert`, under the host's cap on jobs
 * and threads. What it makes is kept under the version's cache folder and
 * reused after a restart; a file that changed on disk starts over.
 */

/** What preparing needs of the host: the context, where userData is, and how to find ffprobe. */
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

interface Prep {
  key: string
  state: MediaVersion['state']
  error?: string
  progress?: number
  probe?: MediaProbe
  table?: FrameTable
  /** paths and facts, URLs minted when the view is read */
  out?:
    | { via: 'original' | 'proxy'; file: string; mime: string; table: FrameTable; why?: string }
    | { via: 'hls'; dir: string; table: FrameTable; why: string }
    | { via: 'image'; file: string; width: number; height: number; converted?: string }
    | { via: 'tiles'; preview: string; width: number; height: number; levels: number; minLevel: number }
    | { via: 'adapter'; play: MediaPlay }
}

const sigOf = (path: string): string => {
  const st = statSync(path)
  return `${st.size}:${Math.floor(st.mtimeMs)}`
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

const MIME_OF: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', jpg: 'image/jpeg', m4s: 'video/iso.segment' }

export class Preparer {
  private preps = new Map<string, Prep>()
  private running = new Map<string, Promise<void>>()

  constructor(private readonly host: PrepHost) {}

  /** The version as the wire shows it now; starts the work it needs for this viewer if it is not under way. */
  view(v: VersionRow, plays: readonly string[] = VIEWER_DEFAULT_PLAYS): MediaVersion {
    const key = plays.slice().sort().join(',')
    const have = this.preps.get(v.id)
    if (!have || (have.key !== key && have.state !== 'probing' && have.state !== 'preparing') || (have.state === 'failed' && !this.running.has(v.id))) {
      if (!this.running.has(v.id)) this.start(v, plays, key)
    }
    return this.wire(v, this.preps.get(v.id)!)
  }

  /** The version as it stands, starting nothing new unless nothing was ever started for it (a push, a tool). */
  peek(v: VersionRow): MediaVersion {
    const have = this.preps.get(v.id)
    return have ? this.wire(v, have) : this.view(v)
  }

  /** Waits for the version's work in flight (tools, tests). */
  async settled(versionId: string): Promise<void> {
    await this.running.get(versionId)
  }

  prepOf(versionId: string): Prep | undefined {
    return this.preps.get(versionId)
  }

  /** The table notes on this version are keyed to: the original's, which every proxy matches frame for frame. */
  table(versionId: string): FrameTable | undefined {
    return this.preps.get(versionId)?.table
  }

  forget(versionIds: readonly string[]): void {
    for (const id of versionIds) {
      this.preps.delete(id)
      rmSync(mediaCacheDir(this.host.dataDir, id), { recursive: true, force: true })
    }
  }

  /** A still of one frame (or the picture) as JPEG bytes, at most `maxSide` px: what the agent looks at. */
  async still(v: VersionRow, frame: number | null, maxSide = 1280): Promise<Buffer> {
    const ffmpeg = this.host.ffmpeg()
    if (!ffmpeg) throw new Error('ffmpeg is not installed on this host (Settings, Work, Conversion tools)')
    await this.settled(v.id)
    const prep = this.preps.get(v.id)
    if (!prep || prep.state === 'failed') throw new Error(prep?.error ?? 'the file has not been read yet')
    // A picture's still comes from what the canvas shows: a HEIC's grid is decoded once, into that JPEG, since ffmpeg refuses a filter on a tile grid.
    const input = frame === null && prep.out && (prep.out.via === 'image' || prep.out.via === 'tiles') ? (prep.out.via === 'image' ? prep.out.file : prep.out.preview) : this.inputOf(v)
    const dir = join(mediaCacheDir(this.host.dataDir, v.id), 'stills')
    mkdirSync(dir, { recursive: true })
    const out = join(dir, `${frame ?? 'still'}-${maxSide}.jpg`)
    if (!existsSync(out)) {
      const at = frame !== null && prep.table ? frameCentre(prep.table, frame) : 0
      const args = frame === null ? stillArgs({ input, output: out, threads: 2, maxSide }) : frameArgs({ input, output: out, at, maxSide })
      const r = await runTool(ffmpeg, args, { timeoutMs: 120_000, gentle: true, signal: this.host.signal })
      if (r.code !== 0) throw new Error(`ffmpeg could not take the frame: ${tailOf(r.out)}`)
    }
    return readFileSync(out)
  }

  /** One Deep Zoom tile's bytes, or null past the picture's edge. */
  tile(versionId: string, level: number, x: number, y: number): Buffer | null {
    const prep = this.preps.get(versionId)
    if (prep?.out?.via !== 'tiles') return null
    const file = join(mediaCacheDir(this.host.dataDir, versionId), 'tiles', String(level), `${x}_${y}.jpg`)
    return existsSync(file) ? readFileSync(file) : null
  }

  /** The URL of one HLS segment, minted when the canvas wants it. */
  segmentUrl(versionId: string, index: number): string | null {
    const prep = this.preps.get(versionId)
    if (prep?.out?.via !== 'hls') return null
    const { segments } = parsePlaylist(this.readPlaylist(prep.out.dir))
    const seg = segments[index]
    if (!seg || !/^[\w.-]+$/.test(seg.name)) return null
    const file = join(prep.out.dir, seg.name)
    if (!existsSync(file)) return null
    return mediaUrl(file, { kind: 'video', mime: MIME_OF.m4s }, statSync(file).mtimeMs)
  }

  // ── the work ───────────────────────────────────────────────────────

  private start(v: VersionRow, plays: readonly string[], key: string): void {
    const prev = this.preps.get(v.id)
    const prep: Prep = { key, state: prev?.probe ? 'preparing' : 'probing', ...(prev?.probe ? { probe: prev.probe, table: prev.table } : {}) }
    this.preps.set(v.id, prep)
    const run = this.run(v, prep, plays)
      .catch((err) => {
        prep.state = 'failed'
        prep.error = errorText(err)
        this.host.ctx.log(`media: ${v.name}: ${prep.error}`)
      })
      .finally(() => {
        this.running.delete(v.id)
        this.host.changed(v.itemId)
      })
    this.running.set(v.id, run)
  }

  private async run(v: VersionRow, prep: Prep, plays: readonly string[]): Promise<void> {
    if (v.source.at !== 'file') {
      const adapter = mediaSourceFor(v.source.at)
      if (!adapter) throw new Error(`a ${v.source.at} file cannot be shown here yet`)
      const got = await adapter.resolve(v.source, this.host.ctx, this.host.signal)
      if (got.probe) prep.probe = got.probe
      if ('table' in got.play) prep.table = got.play.table
      prep.out = { via: 'adapter', play: got.play }
      prep.state = 'ready'
      return
    }
    if (v.source.host !== this.host.ctx.host) throw new Error(`the file is on ${v.source.host}; open it from a thread there`)
    const path = v.source.path
    if (!existsSync(path)) throw new Error(`there is no file at ${path}`)
    const dir = mediaCacheDir(this.host.dataDir, v.id)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    // A file rewritten since it was read is a new picture: what was made from the old one goes.
    const sig = sigOf(path)
    if (readJson<{ sig: string }>(join(dir, 'sig.json'))?.sig !== sig) {
      for (const name of readdirSync(dir)) rmSync(join(dir, name), { recursive: true, force: true })
      writeFileSync(join(dir, 'sig.json'), JSON.stringify({ sig }))
      prep.probe = undefined
      prep.table = undefined
    }
    if (!prep.probe) {
      prep.state = 'probing'
      const probed = await this.probe(path, dir)
      prep.probe = probed.probe
      prep.table = probed.table
    }
    prep.state = 'preparing'
    this.host.changed(v.itemId)
    if (prep.probe.kind === 'video') await this.video(v, prep, path, dir, plays)
    else await this.image(prep, path, dir)
    prep.state = 'ready'
    prep.progress = undefined
  }

  private async probe(path: string, dir: string): Promise<Probed> {
    const cached = readJson<Probed>(join(dir, 'probe.json'))
    if (cached?.probe && (!cached.table || FrameTableSchema.safeParse(cached.table).success)) return cached
    const ffprobe = this.host.ffprobe()
    if (!ffprobe) throw new Error('ffprobe is not installed on this host (Settings, Work, Conversion tools)')
    const probed = await probeFile(ffprobe, path, this.host.signal)
    writeFileSync(join(dir, 'probe.json'), JSON.stringify(probed))
    return probed
  }

  /** The original as a URL the media host serves, linked into the cache when it sits outside the folders it serves. */
  private async served(path: string, dir: string): Promise<{ file: string; mime: string } | null> {
    const direct = await fsMedia(path)
    if (direct) return { file: path, mime: direct.mime }
    const link = join(dir, `original.${extOf(path) || 'bin'}`)
    try {
      if (!existsSync(link)) linkSync(path, link)
    } catch {
      return null
    }
    const type = classifyMedia(link, headOf(link))
    return type ? { file: link, mime: type.mime } : null
  }

  private inputOf(v: VersionRow): string {
    if (v.source.at === 'file') return v.source.path
    throw new Error('this version has no file on this host')
  }

  private async video(v: VersionRow, prep: Prep, path: string, dir: string, plays: readonly string[]): Promise<void> {
    const probe = prep.probe!
    const plan = planVideo(probe, plays)
    if (plan.via === 'original') {
      const served = await this.served(path, dir)
      if (served) {
        prep.out = { via: 'original', file: served.file, mime: served.mime, table: prep.table! }
        return
      }
    }
    const why = plan.via === 'original' ? 'It is outside the folders this host serves' : plan.why
    const hls = plan.via === 'hls'
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
        if (hls && !prep.out && !shifting && existsSync(join(dir, 'hls', 'seg00001.m4s'))) {
          shifting = true
          void firstPts(ffprobe, out, this.host.signal).then((start) => {
            if (start !== null && !prep.out) prep.out = { via: 'hls', dir: join(dir, 'hls'), table: shifted(prep.table!, start), why }
            shifting = start === null ? false : shifting
          })
        }
      }, 2000)
      try {
        await this.convert({ from: 'video', to: hls ? 'proxy.m3u8' : 'proxy.mp4', input: path, output: out, options: { probe, progress } })
      } finally {
        clearInterval(timer)
        rmSync(progress, { force: true })
      }
      // The proxy must have the original's frames, one for one: every note is a frame index.
      const check = await probeFile(ffprobe, out, this.host.signal)
      const want = probe.frames ?? 0
      if (check.probe.frames !== want) throw new Error(`the proxy has ${check.probe.frames} frames where the original has ${want}`)
      writeFileSync(join(dir, hls ? 'hls-table.json' : 'proxy-table.json'), JSON.stringify(check.table))
      writeFileSync(done, '')
    }
    const table = FrameTableSchema.parse(readJson(join(dir, hls ? 'hls-table.json' : 'proxy-table.json')))
    prep.out = hls ? { via: 'hls', dir: join(dir, 'hls'), table, why } : { via: 'proxy', file: out, mime: 'video/mp4', table, why }
  }

  private async image(prep: Prep, path: string, dir: string): Promise<void> {
    const probe = prep.probe!
    const plan = planImage(probe, extOf(path))
    if (plan.via === 'image') {
      const served = await this.served(path, dir)
      if (served) {
        prep.out = { via: 'image', file: served.file, width: probe.width, height: probe.height }
        return
      }
    }
    if (plan.via === 'tiles') {
      const manifest = join(dir, 'tiles.json')
      if (!existsSync(manifest)) await this.convert({ from: 'image', to: 'dzi', input: path, output: manifest, options: { width: probe.width, height: probe.height } })
      const t = readJson<{ width: number; height: number; levels: number; cut: number[] }>(manifest)!
      prep.out = { via: 'tiles', preview: join(dir, 'preview.jpg'), width: t.width, height: t.height, levels: t.levels, minLevel: Math.min(...t.cut) }
      return
    }
    const display = join(dir, 'display.jpg')
    if (!existsSync(display)) await this.convert({ from: extOf(path) || 'image', to: 'jpg', input: path, output: display })
    const ffprobe = this.host.ffprobe()!
    const shown = await probeFile(ffprobe, display, this.host.signal)
    prep.out = { via: 'image', file: display, width: shown.probe.width, height: shown.probe.height, converted: extOf(path).toUpperCase() }
  }

  private convert(job: ConvertJob): Promise<ConvertResult> {
    return this.host.ctx.convert({ ...job, signal: this.host.signal })
  }

  private readPlaylist(dir: string): string {
    try {
      return readFileSync(join(dir, 'index.m3u8'), 'utf8')
    } catch {
      return ''
    }
  }

  private wire(v: VersionRow, prep: Prep): MediaVersion {
    const base = versionWire({ ...v, ...(prep.probe ? { probe: prep.probe } : {}) }, {
      state: prep.state,
      ...(prep.error ? { error: prep.error } : {}),
      ...(prep.progress !== undefined ? { progress: prep.progress } : {})
    })
    const play = this.playOf(prep)
    return play ? { ...base, play } : base
  }

  private playOf(prep: Prep): MediaPlay | null {
    const o = prep.out
    if (!o) return null
    const url = (file: string, mime: string): string => mediaUrl(file, { kind: mime.startsWith('image') ? 'image' : 'video', mime }, statSync(file).mtimeMs)
    switch (o.via) {
      case 'adapter':
        return o.play
      case 'original':
        return { via: 'original', url: url(o.file, o.mime), mime: o.mime, table: o.table }
      case 'proxy':
        return { via: 'proxy', url: url(o.file, o.mime), table: o.table, why: o.why ?? '' }
      case 'hls': {
        const init = join(o.dir, 'init.mp4')
        if (!existsSync(init)) return null
        const { segments, ended } = parsePlaylist(this.readPlaylist(o.dir))
        return { via: 'hls', init: url(init, 'video/mp4'), segments: segments.map(({ start, duration }) => ({ start, duration })), ended, mime: `video/mp4; codecs="avc1.640028${prep.probe?.audio ? ',mp4a.40.2' : ''}"`, table: o.table, why: o.why }
      }
      case 'image':
        return { via: 'image', url: url(o.file, o.file.endsWith('.jpg') ? 'image/jpeg' : (MIME_OF[extOf(o.file)] ?? classifyMedia(o.file, headOf(o.file))?.mime ?? 'image/jpeg')), width: o.width, height: o.height, ...(o.converted ? { converted: o.converted } : {}) }
      case 'tiles':
        return { via: 'tiles', preview: url(o.preview, 'image/jpeg'), width: o.width, height: o.height, tile: TILE, overlap: 0, levels: o.levels, minLevel: o.minLevel, format: 'jpg' }
    }
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
