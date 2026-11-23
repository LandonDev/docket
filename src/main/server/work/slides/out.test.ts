import type { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_PRINCIPAL } from '@shared/capabilities'
import { ClientRequestSchema, type ClientRequest } from '@shared/contract'
import type { DeckOut, DeckReach } from '@shared/contract-work-slides'
import type { SessionMeta } from '@shared/events'
import type { CanvasSource, WorkScope } from '@shared/work'
import { openDb, Store } from '../../db'
import type { SessionRegistry } from '../../sessions'
import { canvasStoreOf } from '../canvas/store'
import { pressed, type Converter } from '../formats/jobs'
import { setPrinter } from '../formats/print'
import { WORK_MODULES, type WorkModule } from '../modules'
import type { DeckInfo, SlideInfo } from './deck'

/**
 * Preview and export through the real module (docs/agents/work-slides.md "Preview and export"), on a fake deck
 * tool whose pictures are real PDFs of one page a slide: each format made from the file, kept and read by its rev,
 * hidden slides left out until asked, notes and handouts printed through the shared printer, the video's job, his
 * press for PowerPoint's own, and a shared library's deck keeping nothing past its item.
 */

vi.mock('../scope', async (original) => ({
  ...(await original<typeof import('../scope')>()),
  scopePart: () => ({
    scopeOf: (id: string): WorkScope => ({ sessionId: id, workspaceId: 'w1', sector: null, host: 'env_test', away: false, routineRunId: null, shared: () => false }),
    createWorkspace: async () => {
      throw new Error('not in this test')
    },
    admitSession: () => {}
  })
}))
const sharedPaths = vi.hoisted(() => new Set<string>())
vi.mock('../files/policy', async (original) => {
  const real = await original<typeof import('../files/policy')>()
  return { ...real, sharedOf: (ctx: never, source: CanvasSource) => (source.at === 'file' && [...sharedPaths].some((p) => source.path.startsWith(p))) || real.sharedOf(ctx, source) }
})

const { startWork } = await import('../ctx')
const { canvas } = await import('../canvas')
const { slides } = await import('.')
const { deckCache, deckKey } = await import('./view')
const { SlidesStore } = await import('./store')

const MAGIC = 'PK\u0003\u0004'
type FakeDeck = Pick<DeckInfo, 'slides' | 'layouts'>
const hex = (n: number): string => n.toString(16).padStart(64, '0')
const slide = (id: number, title: string, extra: Partial<SlideInfo> = {}): SlideInfo => ({
  id,
  hidden: false,
  layout: 'Title and Content',
  title,
  notes: '',
  hash: '',
  draws: hex(id),
  shapes: [{ id: 2, name: 'Title 1', kind: 'text', placeholder: 'title', bbox: [0.05, 0.05, 0.95, 0.2], text: title }],
  ...extra
})
const media = (id: number, kind: 'video' | 'audio'): SlideInfo['shapes'][number] => ({ id, name: `m${id}`, kind: 'media', media: kind, bbox: [0.5, 0.5, 0.9, 0.9], text: '' })
/** Twelve slides: one hidden, three with notes, a video and a sound, a build, a fade and a wipe. */
const TWELVE: FakeDeck = {
  layouts: ['Title and Content'],
  slides: Array.from({ length: 12 }, (_, i) =>
    slide(256 + i, `Slide ${i + 1}`, {
      ...(i === 4 ? { hidden: true } : {}),
      ...(i < 3 ? { notes: `Say ${i + 1}` } : {}),
      ...(i === 6 ? { shapes: [slide(0, 'x').shapes[0]!, media(5, 'video'), media(6, 'audio')] } : {}),
      ...(i === 7 ? { builds: { steps: [{ shapes: [3], paras: [] }, { shapes: [], paras: [] }], changed: 0 } } : {}),
      ...(i === 8 ? { transition: { kind: 'fade', ms: 500 } } : {}),
      ...(i === 9 ? { transition: { kind: 'wipe', ms: 500 } } : {})
    })
  )
}

const calls: Array<{ to: string; options?: Record<string, unknown>; shared?: boolean; pressed: boolean }> = []
const realPdf = async (pages: number, width = 960): Promise<Uint8Array> => {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) doc.addPage([width, 540])
  return doc.save()
}
/** A join pack as the pictures job writes it. */
const joined = (parts: Buffer[]): Buffer => {
  const head = Buffer.alloc(4 + 8 * parts.length)
  head.writeUInt32BE(parts.length)
  parts.forEach((p, i) => head.writeBigUInt64BE(BigInt(p.length), 4 + 8 * i))
  return Buffer.concat([head, ...parts])
}
/** An .mp4 whose movie header says `seconds`. */
const mp4 = (seconds: number): Buffer => {
  const box = Buffer.alloc(40)
  box.write('mvhd', 4)
  box.writeUInt32BE(1000, 20)
  box.writeUInt32BE(Math.round(seconds * 1000), 24)
  return Buffer.concat([Buffer.from('\u0000\u0000\u0000\u0018ftypisom'), box])
}
let powerpoint: 'ready' | 'asleep' = 'asleep'
const record = (job: { to: string; options?: Record<string, unknown>; shared?: boolean; pressed?: unknown }): void => void calls.push({ to: job.to, options: job.options, shared: job.shared, pressed: pressed(job) })
const readFake = (path: string): FakeDeck => JSON.parse(readFileSync(path, 'utf8').slice(MAGIC.length)) as FakeDeck
const FAKE: Converter[] = [
  {
    from: 'pptx',
    to: 'deckinfo',
    async run(job) {
      writeFileSync(job.output, JSON.stringify({ width: 12192000, height: 6858000, sections: [], ...readFake(job.input) }))
      return {}
    }
  },
  {
    from: 'pptx',
    to: 'pdf',
    async run(job) {
      record(job)
      writeFileSync(job.output, await realPdf(readFake(job.input).slides.length))
      return {}
    }
  },
  {
    from: 'pdf',
    to: 'slidepics',
    async run(job) {
      record(job)
      const o = job.options as { pages: number[]; pack: string; names?: string[] }
      writeFileSync(job.output, o.pack === 'zip' ? Buffer.from(`PK\u0003\u0004${o.names!.join(',')}`) : joined(o.pages.map((p) => Buffer.from(`picture ${p}`))))
      return {}
    }
  },
  {
    from: 'slidepics',
    to: 'slidevideo',
    async run(job) {
      record(job)
      const frames = readFileSync(job.input).readUInt32BE(0)
      writeFileSync(job.output, mp4(frames * (job.options as { seconds: number }).seconds))
      return {}
    }
  },
  {
    from: 'pptx',
    to: 'odp',
    async run(job) {
      record(job)
      writeFileSync(job.output, `odp ${readFileSync(job.input, 'utf8')}`)
      return {}
    }
  },
  {
    from: 'odp',
    to: 'pdf',
    async run(job) {
      record(job)
      // The OpenDocument file's own picture: told apart from the deck's by its width.
      writeFileSync(job.output, await realPdf(JSON.parse(readFileSync(job.input, 'utf8').slice(4 + MAGIC.length)).slides.length, 720))
      return {}
    }
  },
  {
    from: 'pptx',
    to: 'pdf+powerpoint',
    ready: () => powerpoint,
    async run(job) {
      record(job)
      writeFileSync(job.output, await realPdf(readFake(job.input).slides.length, 961))
      return {}
    }
  }
]

let dir: string
let db: ReturnType<typeof openDb>
let work: ReturnType<typeof startWork>
const sessions = new Map<string, SessionMeta>()
const registry = { get: (id: string) => sessions.get(id) ?? null, eventsAfter: () => [], onRemoved: () => () => {}, onWorkspaceDeleted: () => () => {} } as unknown as SessionRegistry
const req = (method: string, params?: unknown): ClientRequest => ({ id: '1', method, params }) as ClientRequest
const call = async <T = DeckOut>(method: string, params: unknown, by: Parameters<typeof work.handle>[1] = LOCAL_PRINCIPAL): Promise<T> => {
  const out = await work.handle(ClientRequestSchema.parse(req(method, params)), by)
  return (out.handled ? out.result : undefined) as T
}
const read = async (itemId: string, rev: string, size: number): Promise<Buffer> => {
  const parts: Buffer[] = []
  for (let at = 0; at < size; at += 7) parts.push(Buffer.from((await call<{ data: string }>('work.slides.previewRead', { itemId, rev, offset: at, length: 7 })).data, 'base64'))
  return Buffer.concat(parts)
}
const pagesIn = async (bytes: Buffer): Promise<number[]> => (await PDFDocument.load(bytes)).getPages().map((p) => p.getWidth())
/** Every page printed: one PDF page a `<section>` of the HTML. */
const printed: string[] = []

function hostFence(db: DatabaseSync): { roots(): string[]; denied(): string[] } {
  return { roots: () => (db.prepare(`SELECT cwd AS p FROM projects UNION SELECT path AS p FROM workspaces`).all() as Array<{ p: string }>).map((r) => r.p), denied: () => [] }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tc-slides-out-'))
  db = openDb(join(dir, 'test.db'))
  calls.length = 0
  printed.length = 0
  powerpoint = 'asleep'
  sessions.set('t1', { id: 't1', provider: 'claude', workspaceId: 'w1', scope: 'work' } as SessionMeta)
  WORK_MODULES.splice(0, WORK_MODULES.length, { id: 'formats', ensure() {}, convert: FAKE } as WorkModule)
  setPrinter(async (html) => {
    printed.push(html)
    return { pdf: await realPdf((html.match(/<section class="p">/g) ?? []).length, 612), warnings: [] }
  })
  work = startWork({ db, store: new Store(db), registry, environmentId: 'env_test', dataDir: dir, log: () => {}, remoteFence: hostFence(db) }, [canvas, slides])
  await call('work.set', { enabled: true })
})
afterEach(() => {
  setPrinter(null)
  sharedPaths.clear()
  work.close()
  db.close()
  WORK_MODULES.splice(0, WORK_MODULES.length)
  rmSync(dir, { recursive: true, force: true })
})

const fileSource = (path: string): CanvasSource => ({ at: 'file', host: 'env_test', path })
const openDeck = (path: string) => canvasStoreOf(db).open('t1', { kind: 'slides', source: fileSource(path), title: 'Talk' })
function deckAt(path: string, deck: FakeDeck = TWELVE): string {
  writeFileSync(path, MAGIC + JSON.stringify(deck))
  return path
}
const preview = (itemId: string, ask: Record<string, unknown>) => call('work.slides.preview', { itemId, ...ask })

describe("a deck's formats, made from the file", () => {
  it("draws the PDF from the deck's own picture with its hidden slide left out until asked, kept by rev and read by range", async () => {
    const item = openDeck(deckAt(join(dir, 'Talk.pptx')))
    const pdf = await preview(item.id, { format: 'pdf' })
    expect(pdf.file.name).toBe('Talk.pdf')
    expect(pdf.drawnBy).toBe('tempcode')
    expect(pdf.pdf).toEqual({ rev: pdf.file.rev, size: pdf.file.size, pages: 11 })
    expect(await pagesIn(await read(item.id, pdf.file.rev, pdf.file.size))).toHaveLength(11)
    expect(pdf.facts).toEqual({ slides: 12, hidden: 1, notes: 3, animated: 1, transitions: 2, videos: 1, sounds: 1, pending: 0 })
    const made = calls.length
    // Asked again: the kept file, nothing made.
    expect(await preview(item.id, { format: 'pdf', hidden: false, layout: 'slides' })).toEqual(pdf)
    expect(calls.length).toBe(made)
    const all = await preview(item.id, { format: 'pdf', hidden: true })
    expect(all.pdf!.pages).toBe(12)
    expect(all.file.rev).not.toBe(pdf.file.rev)
    await expect(call('work.slides.previewRead', { itemId: item.id, rev: '0'.repeat(32), offset: 0, length: 8 })).rejects.toThrow('That file is gone')
  })

  it('is the .pptx itself with LibreOffice drawing it, and the OpenDocument file drawn from that file', async () => {
    const path = deckAt(join(dir, 'Talk.pptx'))
    const item = openDeck(path)
    const pptx = await preview(item.id, { format: 'pptx' })
    expect([pptx.file.name, pptx.drawnBy, pptx.pdf!.pages]).toEqual(['Talk.pptx', 'libreoffice', 12])
    expect((await read(item.id, pptx.file.rev, pptx.file.size)).equals(readFileSync(path))).toBe(true)
    const odp = await preview(item.id, { format: 'odp' })
    expect([odp.file.name, odp.drawnBy]).toEqual(['Talk.odp', 'libreoffice'])
    expect(calls.filter((c) => c.to === 'odp' || (c.to === 'pdf' && c.options?.filter))).toHaveLength(3)
    // Its pages are the .odp's own (720 wide), not the deck's (960).
    expect(new Set(await pagesIn(await read(item.id, odp.pdf!.rev, odp.pdf!.size)))).toEqual(new Set([720]))
  })

  it('prints notes pages and handouts through the shared printer, from the shown slides\' pictures', async () => {
    const item = openDeck(deckAt(join(dir, 'Talk.pptx')))
    const notes = await preview(item.id, { format: 'pdf', layout: 'notes' })
    expect(notes.pdf!.pages).toBe(11)
    const six = await preview(item.id, { format: 'print', layout: { handouts: 6 }, hidden: true, page: { paper: 'A4', orientation: 'portrait', margins: { top: 36, right: 36, bottom: 36, left: 36 }, header: true, footer: true } })
    expect(six.pdf!.pages).toBe(2)
    expect(printed[1]).toContain('@page{size:595.3pt 841.9pt;margin:0}')
    expect(printed[0]).toContain('Say 1')
    const asked = calls.filter((c) => c.to === 'slidepics').map((c) => c.options!.pages)
    expect(asked[0]).toEqual([1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12])
    expect(asked[1]).toHaveLength(12)
  })

  it('makes pictures at the width he picks, in a zip named slide by slide, with small ones to show', async () => {
    const item = openDeck(deckAt(join(dir, 'Talk.pptx')))
    const pics = await preview(item.id, { format: 'pics', picture: { type: 'jpeg', width: 1280 } })
    expect(pics.file.name).toBe('Talk.zip')
    expect(pics.thumbs!.map((t) => t.name)).toEqual(['01', '02', '03', '04', '06', '07', '08', '09', '10', '11', '12'].map((n) => `Slide ${n}.jpg`))
    expect(pics.thumbs![0]!.thumb).toBe(`data:image/jpeg;base64,${Buffer.from('picture 1').toString('base64')}`)
    const [zip, small] = calls.filter((c) => c.to === 'slidepics').map((c) => c.options!)
    expect(zip).toMatchObject({ width: 1280, height: 720, type: 'jpeg', pack: 'zip' })
    expect(small).toMatchObject({ width: 320, pack: 'join' })
  })

  it('makes the video of the slides from 1080p pictures at 5 s a slide with a fade, and says how long it runs', async () => {
    const item = openDeck(deckAt(join(dir, 'Talk.pptx'), { ...TWELVE, slides: TWELVE.slides.map((s) => ({ ...s, hidden: false })) }))
    const video = await preview(item.id, { format: 'video', video: { seconds: 5, height: 1080 } })
    expect(video.video).toMatchObject({ seconds: 60, height: 1080 })
    expect(video.video!.poster).toMatch(/^data:image\/jpeg;base64,/)
    expect(video.file.name).toBe('Talk.mp4')
    expect(calls.find((c) => c.to === 'slidepics' && c.options!.type === 'png')!.options).toMatchObject({ width: 1920, height: 1080, pages: [...Array(12).keys()].map((i) => i + 1) })
    expect(calls.find((c) => c.to === 'slidevideo')!.options).toEqual({ seconds: 5, fade: 0.5, fps: 30 })
  })
})

describe("PowerPoint's own picture", () => {
  it('wakes nothing for a thread, draws on his press, and says it is asleep before', async () => {
    const item = openDeck(deckAt(join(dir, 'Talk.pptx')))
    expect(await call<DeckReach>('work.slides.reach', { itemId: item.id })).toEqual({ pdf: 'asleep', video: 'none' })
    // A thread's own call (through the module, as a bridge call reaches it) carries no press: nothing is woken.
    const thread = { kind: 'model' as const, caps: ['read', 'operate'], sessionId: 't1' }
    await expect(slides.handle!(ClientRequestSchema.parse(req('work.slides.preview', { itemId: item.id, format: 'pptx', office: true })), work.ctx, thread)).rejects.toThrow('asleep')
    const his = await preview(item.id, { format: 'pptx', office: true })
    expect(his.drawnBy).toBe('powerpoint')
    expect(calls.filter((c) => c.to === 'pdf+powerpoint').map((c) => c.pressed)).toEqual([true])
    expect(new Set(await pagesIn(await read(item.id, his.pdf!.rev, his.pdf!.size)))).toEqual(new Set([961]))
  })
})

describe("a shared library's deck", () => {
  it('converts on this host alone and keeps nothing past its item', async () => {
    const team = join(dir, 'Esports Staff')
    mkdirSync(team)
    const path = deckAt(join(team, 'Talk.pptx'))
    sharedPaths.add(team)
    const item = openDeck(path)
    for (const format of ['pptx', 'pdf', 'pics', 'video', 'odp']) await preview(item.id, { format })
    await preview(item.id, { format: 'pdf', layout: { handouts: 3 } })
    expect(calls.length).toBeGreaterThan(8)
    expect(calls.every((c) => c.shared === true)).toBe(true)
    const own = join(dir, 'canvas', 't1', item.id)
    expect(readdirSync(join(own, 'out')).filter((f) => f.endsWith('.json'))).toHaveLength(6)
    expect(existsSync(deckCache(dir, deckKey(item)))).toBe(false)
    expect(readdirSync(team)).toEqual(['Talk.pptx'])
    // The tab closes: the canvas deletes the item's folder and the pillar lets go of its seat.
    slides.itemsRemoved!([item], work.ctx)
    canvasStoreOf(db).remove([item.id])
    expect(existsSync(own)).toBe(false)
    expect(new SlidesStore(db).seats(deckKey(item))).toEqual([])
  })
})
