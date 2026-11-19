import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { LOCAL_PRINCIPAL } from '@shared/capabilities'
import { ClientRequestSchema, type ClientRequest } from '@shared/contract'
import { playFor, VIEWER_DEFAULT_PLAYS, type MediaNote, type MediaProbe, type MediaView } from '@shared/contract-work-media'
import type { SessionMeta } from '@shared/events'
import type { WorkScope } from '@shared/work'
import { openDb, Store } from '../../db'
import { setMediaRoots } from '../../media'
import type { SessionRegistry } from '../../sessions'
import { statePath, Toolchain, type ToolchainState } from '../formats/tools'
import { runTool } from '../formats/tools'
import type { ToolCtx } from '../modules'
import { proxyArgs, proxyFilter, tileLevels, tilesArgs } from './encode'
import { parsePlaylist } from './prepare'
import { frameTableOf, parsePacketTimes, parseProbe } from './probe'
import { frameOf } from './tools'

// Milestone 6 builds the scope; here a Work thread's scope is the test's.
vi.mock('../scope', () => ({
  scopePart: () => ({
    scopeOf: (id: string): WorkScope => ({ sessionId: id, workspaceId: 'w1', sector: null, host: 'env_test', away: false, routineRunId: null, shared: () => false }),
    createWorkspace: async () => {
      throw new Error('not in this test')
    },
    admitSession: () => {}
  })
}))
// A clip of a few seconds stands in for one over ten minutes, so the HLS path runs in a test.
vi.mock('./plan', async (actual) => {
  const real = await actual<typeof import('./plan')>()
  return { ...real, planVideo: (p: MediaProbe, plays?: readonly string[]) => real.planVideo(p, plays, (p.durationS ?? 0) > 2.5 ? 2 : real.HLS_OVER_S) }
})

// The plan as it is, under the mock the pillar runs with.
const { planImage, planVideo, playKey } = await vi.importActual<typeof import('./plan')>('./plan')

const video = (over: Partial<MediaProbe> = {}): MediaProbe => ({ kind: 'video', container: 'mov', size: 1, mtimeMs: 1, width: 3840, height: 2160, rotation: 0, codec: 'h264', pixFmt: 'yuv420p', bitDepth: 8, rate: { num: 24, den: 1 }, durationS: 10, frames: 240, ...over })

describe('what plays', () => {
  it('plays the original where the viewer decodes it, else a proxy, as HLS past ten minutes', () => {
    expect(planVideo(video())).toEqual({ via: 'original' })
    expect(planVideo(video({ codec: 'prores', pixFmt: 'yuv422p10le', bitDepth: 10 }))).toEqual({ via: 'proxy', why: 'This viewer does not play ProRes' })
    expect(planVideo(video({ codec: 'hevc' }))).toMatchObject({ via: 'proxy' })
    expect(planVideo(video({ codec: 'hevc' }), ['h264', 'hevc'])).toEqual({ via: 'original' })
    expect(planVideo(video({ codec: 'prores', durationS: 2892 }))).toMatchObject({ via: 'hls' })
    expect(planVideo(video({ interlaced: true }))).toEqual({ via: 'proxy', why: 'It is interlaced' })
    expect(playKey({ codec: 'h264', pixFmt: 'yuv422p10le', bitDepth: 10 })).toBe('h264-hi')
    expect(planVideo(video({ pixFmt: 'yuv422p10le', bitDepth: 10 }), ['h264'])).toMatchObject({ via: 'proxy' })
  })

  it('shows a picture as it is, converts HEIC and TIFF on the host, and tiles one past 40 megapixels', () => {
    const img = (codec: string, width = 4032, height = 3024): MediaProbe => ({ ...video({ codec, width, height }), kind: 'image' })
    expect(planImage(img('mjpeg'), 'jpg')).toEqual({ via: 'image' })
    expect(planImage(img('hevc'), 'heic')).toMatchObject({ via: 'convert' })
    expect(planImage(img('tiff'), 'tif')).toMatchObject({ via: 'convert' })
    expect(planImage(img('mjpeg', 20000, 12000), 'jpg')).toEqual({ via: 'tiles', why: 'It is 240 megapixels' })
  })
})

describe('the proxy command line', () => {
  it('keeps every frame and its time, a keyframe a second, H.264 8-bit 4:2:0 within 1920', () => {
    const args = proxyArgs({ input: '/in.mov', output: '/out.mp4', probe: video({ codec: 'prores', rate: { num: 24000, den: 1001 } }), threads: 3 })
    const at = (flag: string): string => args[args.indexOf(flag) + 1]
    expect(at('-fps_mode')).toBe('passthrough')
    expect(at('-g')).toBe('24')
    expect(at('-c:v')).toBe('libx264')
    expect(at('-crf')).toBe('23')
    expect(at('-maxrate')).toBe('10M')
    expect(at('-vf')).toBe('scale=1920:-2:flags=bicubic,format=yuv420p')
    expect(args.slice(-4)).toEqual(['+faststart', '-f', 'mp4', '/out.mp4'])
    expect(proxyFilter(video({ width: 1080, height: 1920, rotation: 0, interlaced: true }))).toBe('bwdif=mode=send_frame,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p')
    expect(proxyFilter(video({ width: 3840, height: 2160, rotation: 90 }))).toBe('scale=-2:1920:flags=bicubic,format=yuv420p')
    const hls = proxyArgs({ input: '/in.mov', output: '/c/hls/index.m3u8', probe: video(), threads: 2, hls: true })
    expect(hls).toEqual(expect.arrayContaining(['hls', 'fmp4', '/c/hls/seg%05d.m4s', 'event']))
  })

  it('cuts Deep Zoom levels from the first with more than one tile up to full size', () => {
    const { max, levels } = tileLevels(9000, 6000)
    expect(max).toBe(14)
    expect(levels.map((l) => [l.level, l.cols, l.rows])).toEqual([
      [9, 1, 1],
      [10, 2, 1],
      [11, 3, 2],
      [12, 5, 3],
      [13, 9, 6],
      [14, 18, 12]
    ])
    const args = tilesArgs({ input: '/big.jpg', dir: '/t', levels, threads: 2 })
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('untile=18x12')
  })

  it('reads an HLS playlist as it grows', () => {
    const text = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4.000000,\nseg00000.m4s\n#EXTINF:1.5,\nseg00001.m4s\n'
    expect(parsePlaylist(text)).toEqual({ segments: [{ start: 0, duration: 4, name: 'seg00000.m4s' }, { start: 4, duration: 1.5, name: 'seg00001.m4s' }], ended: false })
    expect(parsePlaylist(`${text}#EXT-X-ENDLIST\n`).ended).toBe(true)
  })
})

describe('probing', () => {
  it('reads ffprobe as a video, a timecode, a still and a tile grid', () => {
    const json = {
      format: { format_name: 'mov,mp4', duration: '4.004' },
      streams: [
        { codec_type: 'video', codec_name: 'h264', profile: 'High', width: 640, height: 360, pix_fmt: 'yuv420p', r_frame_rate: '30000/1001', avg_frame_rate: '30000/1001', nb_frames: '120', tags: { timecode: '00:00:58;00' }, side_data_list: [{ rotation: -90 }] },
        { codec_type: 'audio', codec_name: 'aac', channels: 2 }
      ]
    }
    expect(parseProbe(json, { size: 9, mtimeMs: 2, ext: 'mov' })).toMatchObject({ kind: 'video', codec: 'h264', rate: { num: 30000, den: 1001 }, frames: 120, timecode: '00:00:58;00', rotation: 270, bitDepth: 8, audio: { codec: 'aac', channels: 2 } })
    const heic = { format: { format_name: 'mov,mp4' }, streams: [{ codec_type: 'video', codec_name: 'hevc', width: 1280, height: 720 }], stream_groups: [{ type: 'Tile Grid', components: [{ width: 2560, height: 1440 }] }] }
    expect(parseProbe(heic, { size: 9, mtimeMs: 2, ext: 'heic' })).toMatchObject({ kind: 'image', width: 2560, height: 1440 })
    expect(() => parseProbe({ streams: [{ codec_type: 'audio' }] }, { size: 1, mtimeMs: 1, ext: 'm4a' })).toThrow('no picture')
  })

  it('keeps a frame table as a rate when the frames sit on it, and every time when they do not', () => {
    const on = Array.from({ length: 48 }, (_, i) => i / 24 + 0.0833)
    expect(frameTableOf(on, { rate: { num: 24, den: 1 } })).toEqual({ kind: 'cfr', start: 0.0833, rate: { num: 24, den: 1 }, count: 48 })
    // B-frames come in decode order; the table sorts them.
    expect(frameTableOf([0, 2 / 24, 1 / 24], { rate: { num: 24, den: 1 } })).toMatchObject({ kind: 'cfr', count: 3 })
    const gappy = Array.from({ length: 30 }, (_, i) => i / 30).filter((_, i) => i < 10 || i > 14)
    expect(frameTableOf(gappy, { rate: { num: 30, den: 1 }, durationS: 1 })).toMatchObject({ kind: 'vfr', times: gappy })
    expect(parsePacketTimes('0.000000,\n0.041667\nN/A\n')).toEqual([0, 0.041667])
  })

  it('takes a moment the way an agent writes it', () => {
    const t = { kind: 'cfr' as const, start: 0, rate: { num: 24, den: 1 }, count: 3216 }
    expect(frameOf(t, 984)).toBe(984)
    expect(frameOf(t, '0:41')).toBe(984)
    expect(frameOf(t, '1:32.5')).toBe(2220)
    expect(frameOf(t, '12s')).toBe(288)
    expect(frameOf(t, '01:00:41:12', '01:00:00:00', t.rate)).toBe(996)
    expect(frameOf(t, 99999)).toBe(3215)
    // Seconds with decimals are seconds, never a timecode's frames.
    expect(frameOf(t, '0:00:41.50', '01:00:00:00', t.rate)).toBe(996)
    expect(() => frameOf(t, 'soon')).toThrow('is not a time')
  })
})

// ── the pillar end to end, with the toolchain's real ffmpeg ───────────

/** A userData the installer filled: the env's, else the box's or the Mac's. */
const TOOLS = [process.env.TEMP_CODE_WORK_TOOLS_DATA, '/srv/agents/temp-code-data', join(process.env.HOME ?? '', 'Library/Application Support/temp-code')].find(
  (d): d is string => !!d && existsSync(statePath(d)) && new Toolchain(d).has('ffmpeg')
)
const FIXTURES = join(import.meta.dirname, 'fixtures')

describe.skipIf(!TOOLS)('the media pillar on a real ffmpeg', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let work: Awaited<ReturnType<typeof import('../ctx').startWork>>
  const sessions = new Map<string, SessionMeta>()
  const registry = { get: (id: string) => sessions.get(id) ?? null, onRemoved: () => () => {}, onWorkspaceDeleted: () => () => {} } as unknown as SessionRegistry
  const call = async <T,>(method: string, params: unknown): Promise<T> => {
    const out = await work.handle(ClientRequestSchema.parse({ id: '1', method, params } as ClientRequest), LOCAL_PRINCIPAL)
    if (!out.handled) throw new Error(`${method} was not handled`)
    return out.result as T
  }
  const ffmpeg = (): string => new Toolchain(TOOLS!).bin('ffmpeg')!
  const make = async (name: string, args: string[]): Promise<string> => {
    const out = join(dir, 'clips', name)
    const r = await runTool(ffmpeg(), ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-threads', '2', ...args, out], { timeoutMs: 120_000, gentle: true })
    if (r.code !== 0) throw new Error(r.out)
    return out
  }
  const open = async (path: string, title: string): Promise<string> => {
    const item = await call<{ id: string }>('work.canvas.open', { sessionId: 't1', kind: 'media', title, source: { at: 'file', host: 'env_test', path } })
    return item.id
  }
  /** The view once every version has settled. */
  const settled = async (itemId: string, plays?: string[]): Promise<MediaView> => {
    for (let i = 0; i < 600; i++) {
      const view = await call<MediaView>('work.media.view', { itemId, ...(plays ? { plays } : {}) })
      if (view.versions.every((v) => v.state === 'ready' || v.state === 'failed')) return view
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error('the item did not settle')
  }
  const toolCtx = (): ToolCtx => ({ ...work.ctx, scope: work.ctx.scopeOf('t1')!, sessionId: 't1', signal: new AbortController().signal })
  const tool = async (name: string, args: unknown) => {
    const { mediaTools } = await import('./tools')
    return mediaTools.find((t) => t.name === name)!.run(args, toolCtx())
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tc-media-'))
    const tools = join(dir, 'work-tools')
    mkdirSync(tools, { recursive: true })
    const state = JSON.parse(readFileSync(statePath(TOOLS!), 'utf8')) as ToolchainState
    for (const t of Object.values(state.tools)) if (t.ok && t.dir && t.name === 'ffmpeg') symlinkSync(join(TOOLS!, 'work-tools', t.name), join(tools, t.name))
    copyFileSync(statePath(TOOLS!), statePath(dir))
    mkdirSync(join(dir, 'clips'))
    // The server serves media from its roots, the attachments folder among them; here, the test's folder.
    setMediaRoots(() => [dir])
    sessions.set('t1', { id: 't1', provider: 'claude', workspaceId: 'w1', scope: 'work' } as SessionMeta)
    db = openDb(join(dir, 'test.db'))
    const { loadWorkModules } = await import('../modules')
    await loadWorkModules()
    const { startWork } = await import('../ctx')
    const { canvas } = await import('../canvas')
    const { media } = await import('./index')
    work = startWork({ db, store: new Store(db), registry, environmentId: 'env_test', dataDir: dir, log: () => {} }, [canvas, media])
    await call('work.set', { enabled: true })
  }, 60_000)
  afterAll(() => {
    work?.close()
    db?.close()
    setMediaRoots(() => [])
    rmSync(dir, { recursive: true, force: true })
  })

  it('plays an H.264 original as it is, keyed by its frame table', async () => {
    const path = await make('a.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '24'])
    const view = await settled(await open(path, 'A'))
    expect(view.kind).toBe('video')
    const v = view.versions[0]
    expect(v).toMatchObject({ n: 1, name: 'a.mp4', state: 'ready', probe: { codec: 'h264', frames: 48 } })
    const play = playFor(v, VIEWER_DEFAULT_PLAYS)
    expect(play).toMatchObject({ via: 'original', mime: 'video/mp4', table: { kind: 'cfr', count: 48, rate: { num: 24, den: 1 } } })
    expect(play?.via === 'original' && play.url).toMatch(/^tempcode-asset:\/\/file\/[a-f0-9]{32}\/a\.mp4/)
    expect(v.plays.map((p) => p.via)).toEqual(['original'])
  }, 60_000)

  it('makes a frame-for-frame H.264 proxy of a 4K ProRes clip the viewer cannot decode', async () => {
    const path = await make('b.mov', ['-f', 'lavfi', '-i', 'testsrc2=s=3840x2160:r=24:d=1', '-c:v', 'prores_ks', '-profile:v', '0', '-pix_fmt', 'yuv422p10le'])
    const view = await settled(await open(path, 'B'))
    const v = view.versions[0]
    expect(v.probe).toMatchObject({ codec: 'prores', width: 3840, height: 2160, frames: 24 })
    expect(playFor(v, VIEWER_DEFAULT_PLAYS)).toMatchObject({ via: 'proxy', why: 'This viewer does not play ProRes', table: { kind: 'cfr', count: 24 } })
    // A viewer that says it plays ProRes takes the original, and the proxy stays for the others: two viewers never flip it.
    const mac = await settled(view.itemId, ['h264', 'prores'])
    expect(mac.versions[0].plays.map((p) => p.via)).toEqual(['original', 'proxy'])
    expect(playFor(mac.versions[0], ['h264', 'prores'])?.via).toBe('original')
    expect(playFor(mac.versions[0], VIEWER_DEFAULT_PLAYS)?.via).toBe('proxy')
  }, 120_000)

  it('cuts a long clip into an HLS proxy whose segments are minted when asked for', async () => {
    const path = await make('c.mov', ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=9', '-c:v', 'prores_ks', '-profile:v', '0'])
    const view = await settled(await open(path, 'C'))
    const play = playFor(view.versions[0], VIEWER_DEFAULT_PLAYS)
    expect(play).toMatchObject({ via: 'hls', ended: true, table: { count: 225 } })
    if (play?.via !== 'hls') throw new Error('not hls')
    expect(play.segments.length).toBeGreaterThanOrEqual(2)
    // The segments are on the fMP4's own timeline, which starts where its table does.
    expect(play.segments[0].start).toBeCloseTo(play.table.kind === 'cfr' ? play.table.start : 0)
    const { data } = await call<{ data: string }>('work.media.segment', { itemId: view.itemId, versionId: view.versions[0].id, index: 1 })
    expect(Buffer.from(data, 'base64').subarray(4, 8).toString('latin1')).toMatch(/styp|moof/)
  }, 120_000)

  it('keeps a note at its frame, and an agent\'s note waits for the person in Suggests', async () => {
    const path = join(dir, 'clips', 'a.mp4')
    const itemId = await open(path, 'A')
    const view = await settled(itemId)
    const versionId = view.versions[0].id
    const mine = await call<MediaNote>('work.media.note', { itemId, anchor: { versionId, frame: 17, region: { x: 0.1, y: 0.2, w: 0.3, h: 0.3 } }, body: 'The logo is soft here' })
    expect(mine).toMatchObject({ by: 'owner', state: 'kept', anchor: { frame: 17 } })
    expect((await call<MediaView>('work.media.view', { itemId })).notes.find((n) => n.id === mine.id)?.anchor.frame).toBe(17)

    // His own file: the agent writes straight on, with an Undo.
    const wrote = await tool('media_note', { item: itemId, at: '0:01', text: 'A frame of black' })
    expect(wrote.isError).toBeUndefined()
    let now = await call<MediaView>('work.media.view', { itemId })
    const agent = now.notes.find((n) => n.body === 'A frame of black')!
    expect(agent).toMatchObject({ state: 'kept', by: 'agent:env_test:t1', anchor: { frame: 24 } })
    expect(now.lastWrite?.text).toBe('Added a note')
    now = await call<MediaView>('work.media.undo', { itemId, writeId: now.lastWrite!.id })
    expect(now.notes.some((n) => n.body === 'A frame of black')).toBe(false)
    expect(now.lastWrite).toBeUndefined()

    // Suggests: it waits; Accept makes it his.
    await call('work.media.mode', { itemId, mode: 'suggests' })
    await tool('media_chapters', { item: itemId, chapters: [{ at: 0, title: 'Open' }, { at: '0:01', title: 'Middle' }] })
    now = await call<MediaView>('work.media.view', { itemId })
    const waiting = now.notes.filter((n) => n.state === 'suggested')
    expect(waiting.map((n) => [n.kind, n.anchor.frame, n.body])).toEqual([
      ['chapter', 0, 'Open'],
      ['chapter', 24, 'Middle']
    ])
    now = await call<MediaView>('work.media.decide', { itemId, which: waiting[0].id, accept: true })
    expect(now.notes.find((n) => n.id === waiting[0].id)).toMatchObject({ state: 'kept', by: 'owner' })
    now = await call<MediaView>('work.media.decide', { itemId, which: 'all', accept: false })
    expect(now.notes.some((n) => n.state === 'suggested')).toBe(false)
  }, 60_000)

  it('shows the agent a frame and its facts', async () => {
    const itemId = await open(join(dir, 'clips', 'a.mp4'), 'A')
    const info = await tool('media_info', { item: itemId })
    expect(info.content[0]).toMatchObject({ type: 'text' })
    expect((info.content[0] as { text: string }).text).toContain('48 frames (0 to 47)')
    const frames = await tool('media_frames', { item: itemId, at: [0, '0:01'] })
    expect(frames.content.filter((c) => c.type === 'image')).toHaveLength(2)
    expect(frames.content[0]).toMatchObject({ type: 'text', text: 'v1 frame 0, 0:00 (00:00:00:00)' })
  }, 60_000)

  it('adds a version; its notes stay on the version they were made on', async () => {
    const itemId = await open(join(dir, 'clips', 'a.mp4'), 'A')
    const v2 = await make('a2.mp4', ['-f', 'lavfi', '-i', 'testsrc=s=320x180:r=24:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'])
    await call('work.media.version', { itemId, source: { at: 'file', host: 'env_test', path: v2 } })
    const view = await settled(itemId)
    expect(view.versions.map((v) => [v.n, v.name, v.probe?.frames])).toEqual([
      [1, 'a.mp4', 48],
      [2, 'a2.mp4', 24]
    ])
    expect(view.notes.every((n) => n.anchor.versionId === view.versions[0].id)).toBe(true)
  }, 60_000)

  /** The mean luma of a still, from ffmpeg itself: the clips below light frame n at 5n. */
  const luma = async (jpeg: Buffer): Promise<number> => {
    const at = join(dir, `still-${Math.random().toString(36).slice(2)}.jpg`)
    writeFileSync(at, jpeg)
    const r = await runTool(ffmpeg(), ['-v', 'error', '-i', at, '-vf', 'scale=1:1:flags=area,format=gray', '-f', 'rawvideo', '-'], { timeoutMs: 30_000 })
    return r.out.charCodeAt(0)
  }

  it('shows the agent frame n itself, also from a stream whose timeline starts late', async () => {
    const mp4 = await make('luma.mp4', ['-f', 'lavfi', '-i', "color=c=black:s=64x64:r=24:d=2,format=gray,geq=lum='min(255\\,5*N)'", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '24'])
    const ts = await make('luma.ts', ['-i', mp4, '-c', 'copy', '-f', 'mpegts'])
    for (const path of [mp4, ts]) {
      const itemId = await open(path, `Luma ${path.slice(-2)}`)
      await settled(itemId)
      const frames = await tool('media_frames', { item: itemId, at: [0, 10, 25] })
      const shots = frames.content.filter((c): c is { type: 'image'; data: string; mimeType: string } => c.type === 'image')
      expect(shots).toHaveLength(3)
      const seen = await Promise.all(shots.map((c) => luma(Buffer.from(c.data, 'base64'))))
      for (const [i, n] of [0, 10, 25].entries()) expect(Math.abs(seen[i] - 5 * n), `${path} frame ${n}`).toBeLessThan(3)
    }
  }, 120_000)

  it('keeps every frame of a long clip in its table, past what a child\'s output keeps', async () => {
    // 130,000 packets: about 1.3 MB of times, past the runner's megabyte.
    const path = await make('long.mp4', ['-f', 'lavfi', '-i', 'color=c=gray:s=16x16:r=1000:d=130', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '1000'])
    const view = await settled(await open(path, 'Long'))
    expect(view.versions[0].probe?.frames).toBe(130_000)
  }, 120_000)

  it('refuses a picture outside the folders this host shows, and never links it in', async () => {
    const away = mkdtempSync(join(tmpdir(), 'tc-media-away-'))
    try {
      const path = join(away, 'secret.png')
      const r = await runTool(ffmpeg(), ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', path], { timeoutMs: 30_000 })
      expect(r.code).toBe(0)
      const view = await settled(await open(path, 'Secret'))
      expect(view.versions[0]).toMatchObject({ state: 'failed', plays: [] })
      expect(view.versions[0].error).toMatch(/outside the folders this host shows/)
      expect(existsSync(join(dir, 'attachments', 'work-media', view.versions[0].id, 'original.png'))).toBe(false)
    } finally {
      rmSync(away, { recursive: true, force: true })
    }
  }, 60_000)

  it('keeps a failure until the file changes, then starts over', async () => {
    const path = join(dir, 'clips', 'broken.mp4')
    writeFileSync(path, 'not a video')
    const itemId = await open(path, 'Broken')
    expect((await settled(itemId)).versions[0].state).toBe('failed')
    // Asked again, it does not start again: a viewer's every read would re-run it.
    expect((await call<MediaView>('work.media.view', { itemId, plays: ['h264'] })).versions[0].state).toBe('failed')
    copyFileSync(join(dir, 'clips', 'a.mp4'), path)
    const now = await settled(itemId)
    expect(now.versions[0]).toMatchObject({ state: 'ready', probe: { frames: 48 } })
  }, 60_000)

  it('cuts a picture past 40 megapixels into tiles', async () => {
    const path = await make('big.jpg', ['-f', 'lavfi', '-i', 'testsrc2=s=8192x5120', '-frames:v', '1', '-q:v', '4'])
    const view = await settled(await open(path, 'Big'))
    expect(view.kind).toBe('image')
    const play = playFor(view.versions[0], VIEWER_DEFAULT_PLAYS)
    expect(play).toMatchObject({ via: 'tiles', width: 8192, height: 5120, tile: 512, levels: 14, minLevel: 9 })
    const { data } = await call<{ data: string }>('work.media.tile', { itemId: view.itemId, versionId: view.versions[0].id, level: 13, x: 15, y: 9 })
    expect(Buffer.from(data, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
  }, 120_000)

  it('shows an iPhone-style HEIC (Apple\'s encoder, a 512 px tile grid, turned by its irot) as a JPEG the host made', async () => {
    // fixtures/*.heic: written on the Mac by `sips -s format heic` (ImageIO), 4032×3024 in 512 px tiles; portrait.heic carries irot 3.
    const path = join(dir, 'clips', 'portrait.heic')
    copyFileSync(join(FIXTURES, 'portrait.heic'), path)
    const itemId = await open(path, 'Portrait')
    const view = await settled(itemId)
    expect(view.kind).toBe('image')
    expect(view.versions[0].probe).toMatchObject({ codec: 'hevc', width: 4032, height: 3024 })
    expect(playFor(view.versions[0], VIEWER_DEFAULT_PLAYS)).toMatchObject({ via: 'image', converted: 'HEIC', width: 3024, height: 4032 })
    // The agent sees the same picture, small: a grid takes no filter, so the still is cut from the host's JPEG.
    const still = await tool('media_frames', { item: itemId })
    expect(still.isError).toBeUndefined()
    expect(still.content.filter((c) => c.type === 'image')).toHaveLength(1)
  }, 60_000)
})
