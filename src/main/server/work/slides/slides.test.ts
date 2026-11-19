import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_PRINCIPAL } from '@shared/capabilities'
import { ClientRequestSchema, type ClientRequest } from '@shared/contract'
import type { WorkPush } from '@shared/contract-work'
import type { DeckView, SlideOp } from '@shared/contract-work-slides'
import type { SessionMeta } from '@shared/events'
import type { CanvasSource, WorkScope } from '@shared/work'
import { openDb, Store } from '../../db'
import type { SessionRegistry } from '../../sessions'
import { canvasStoreOf } from '../canvas/store'
import type { Converter } from '../formats/jobs'
import { WORK_MODULES, type WorkModule } from '../modules'
import type { DeckInfo, SlideInfo } from './deck'
import { ensureSlidesTables, SlidesStore } from './store'
import { TWELVE } from './fixtures/twelve'
import { writeNewDeck } from './newDeck'

vi.mock('../scope', () => ({
  scopePart: () => ({
    scopeOf: (id: string): WorkScope => ({ sessionId: id, workspaceId: 'w1', sector: null, host: 'env_test', away: false, routineRunId: null, shared: () => false }),
    createWorkspace: async () => {
      throw new Error('not in this test')
    },
    admitSession: () => {}
  })
}))
const { startWork } = await import('../ctx')
const { canvas } = await import('../canvas')
const { slides } = await import('.')
const { SLIDES_CONVERTERS } = await import('./deck')

// ── a fake deck tool: a "pptx" is PK\3\4 and the DeckInfo as JSON ─────

const MAGIC = 'PK\u0003\u0004'
type FakeDeck = Pick<DeckInfo, 'slides' | 'layouts'>
const fakeBytes = (d: FakeDeck): string => MAGIC + JSON.stringify(d)
const readFake = (path: string): FakeDeck => JSON.parse(readFileSync(path, 'utf8').slice(MAGIC.length)) as FakeDeck
const slide = (id: number, title: string, extra: Partial<SlideInfo> = {}): SlideInfo => ({
  id,
  hidden: false,
  layout: 'Title and Content',
  title,
  notes: '',
  hash: '',
  shapes: [
    { id: 2, name: 'Title 1', kind: 'text', placeholder: 'title', bbox: [0.05, 0.05, 0.95, 0.2], text: title },
    { id: 3, name: 'Body 2', kind: 'text', placeholder: 'body', bbox: [0.05, 0.25, 0.95, 0.9], text: `About ${title}` }
  ],
  ...extra
})
const FAKE_DECK: FakeDeck = { layouts: ['Title and Content'], slides: [slide(256, 'One'), slide(257, 'Two'), slide(258, 'Three'), slide(259, 'Four')] }

/** Applies edits as the real tool does, closely enough to drive the module. */
function applyFake(d: FakeDeck, ops: SlideOp[]): string[] {
  const warnings: string[] = []
  const at = (id: number): number => d.slides.findIndex((s) => s.id === id)
  const place = (s: SlideInfo, after: number): void => void d.slides.splice(after === 0 ? 0 : at(after) + 1, 0, s)
  ops.forEach((op, i) => {
    const say = (w: string): void => void warnings.push(`edit ${i + 1}: ${w}`)
    if (op.op === 'add') {
      if (op.after && at(op.after) < 0) return say(`there is no slide ${op.after} to put the new slide after`)
      if (at(op.id!) >= 0) return say(`the deck already has a slide ${op.id}`)
      const s = slide(op.id!, op.title ?? '')
      if (op.body) s.shapes[1].text = op.body.join('\n')
      return place(s, op.after)
    }
    const k = at(op.slide)
    if (k < 0) return say(`there is no slide ${op.slide}`)
    const s = d.slides[k]
    if (op.op === 'remove') {
      // A slide whose notes say `link:<id>` links to that slide, as a jump link would: the real tool takes the link out and notes it.
      for (const o of d.slides) if (o.notes === `link:${op.slide}`) warnings.push(`note: edit ${i + 1}: slide ${o.id} linked to slide ${op.slide}; that link was taken out`)
      return void d.slides.splice(k, 1)
    }
    if (op.op === 'move') {
      if (op.after && at(op.after) < 0) return say(`there is no slide ${op.after} to put slide ${op.slide} after`)
      d.slides.splice(k, 1)
      return place(s, op.after)
    }
    if (op.op === 'notes') return void (s.notes = op.text)
    const sh = s.shapes.find((x) => (typeof op.shape === 'number' ? x.id === op.shape : x.name === op.shape))
    if (!sh) return say(`slide ${op.slide} has no shape ${op.shape}`)
    if (op.op === 'text') {
      sh.text = op.paragraphs.join('\n')
      if (sh.placeholder === 'title') s.title = sh.text
    }
  })
  return warnings
}

const calls: string[] = []
/** Runs while the fake edit runs: the owner saving the file meanwhile. */
let duringEdit: (() => void) | null = null
/** Holds the outline job until it resolves: a long first render on the item's queue. */
let holdInfo: Promise<void> | null = null
/** The input of every edit job, to tell the live file from a copy. */
const editInputs: string[] = []
/** What the owner typed in each thread, for ownerSaid. */
const typed = new Map<string, string[]>()
const FAKE: Converter[] = [
  {
    from: 'pptx',
    to: 'deckinfo',
    async run(job) {
      calls.push('deckinfo')
      await holdInfo
      const d = readFake(job.input)
      writeFileSync(job.output, JSON.stringify({ width: 12192000, height: 6858000, sections: [], ...d }))
      return {}
    }
  },
  {
    from: 'pptx',
    to: 'pptxedit',
    async run(job) {
      calls.push('pptxedit')
      editInputs.push(job.input)
      duringEdit?.()
      const d = readFake(job.input)
      const { ops, strict } = job.options as { ops: SlideOp[]; strict?: boolean }
      const warnings = applyFake(d, ops)
      if (strict && warnings.some((w) => !w.startsWith('note: '))) throw new Error(warnings.join(' '))
      writeFileSync(job.output, fakeBytes(d))
      return { warnings }
    }
  },
  {
    from: 'pptx',
    to: 'pdf',
    async run(job) {
      calls.push(`pdf ${String(job.options?.filter)}`)
      writeFileSync(job.output, `%PDF-1.7 ${createHash('sha256').update(readFileSync(job.input)).digest('hex')}`)
      return {}
    }
  },
  {
    from: 'pdf',
    to: 'png',
    async run(job) {
      calls.push(`png ${String(job.options?.page)}`)
      writeFileSync(job.output, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      return {}
    }
  }
]

// ── the host ─────────────────────────────────────────────────────────

let dir: string
let db: ReturnType<typeof openDb>
let work: ReturnType<typeof startWork>
const pushes: WorkPush[] = []
const sessions = new Map<string, SessionMeta>()
const registry = {
  get: (id: string) => sessions.get(id) ?? null,
  eventsAfter: (id: string) => (typed.get(id) ?? []).map((text, seq) => ({ seq, event: { type: 'user-text', text } })),
  onRemoved: () => () => {},
  onWorkspaceDeleted: () => () => {}
} as unknown as SessionRegistry
const session = { id: 't1', scope: 'work' } as const
const signal = new AbortController().signal
const req = (method: string, params?: unknown): ClientRequest => ({ id: '1', method, params }) as ClientRequest
const call = async <T = DeckView>(method: string, params: unknown, by: Parameters<typeof work.handle>[1] = LOCAL_PRINCIPAL): Promise<T> => {
  const out = await work.handle(ClientRequestSchema.parse(req(method, params)), by)
  return (out.handled ? out.result : undefined) as T
}
const tool = (name: string, args: unknown) => work.tools.call(session, name, args, signal)
const textOf = (r: { content: Array<{ type: string; text?: string }> }): string => r.content.map((c) => c.text ?? '').join('')

async function host(converters: Converter[], dataDir?: string): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), 'tc-slides-'))
  if (dataDir) symlinkSync(join(dataDir, 'work-tools'), join(dir, 'work-tools'))
  db = openDb(join(dir, 'test.db'))
  pushes.length = 0
  calls.length = 0
  duringEdit = null
  holdInfo = null
  editInputs.length = 0
  typed.clear()
  sessions.set('t1', { id: 't1', provider: 'claude', workspaceId: 'w1', scope: 'work' } as SessionMeta)
  // ctx.convert reads the registry: the converters under test come first.
  WORK_MODULES.splice(0, WORK_MODULES.length, { id: 'formats', ensure() {}, convert: converters } as WorkModule)
  work = startWork({ db, store: new Store(db), registry, environmentId: 'env_test', dataDir: dir, log: () => {}, remoteFence: hostFence(db) }, [canvas, slides])
  work.pushes.onPush((p) => pushes.push(p))
  await call('work.set', { enabled: true })
}
function close(): void {
  work.close()
  db.close()
  WORK_MODULES.splice(0, WORK_MODULES.length)
  rmSync(dir, { recursive: true, force: true })
}
const fileSource = (path: string): CanvasSource => ({ at: 'file', host: 'env_test', path })
const openDeck = (source: CanvasSource, title = 'Deck') => canvasStoreOf(db).open('t1', { kind: 'slides', source, title })

describe('the store', () => {
  it('keeps pending edits in order, drops and rewrites them, and the mode and last write per item', () => {
    const d = mkdtempSync(join(tmpdir(), 'tc-slides-store-'))
    const sdb = openDb(join(d, 'test.db'))
    try {
      ensureSlidesTables(sdb)
      const s = new SlidesStore(sdb)
      expect(s.mode('i1')).toBe('suggests')
      s.add('i1', 't1', [{ slide: 256, op: { op: 'notes', slide: 256, text: 'a' } }, { slide: 300, op: { op: 'add', after: 256, layout: 'L', id: 300 } }], 'owner')
      s.add('i1', 't1', [{ slide: 257, op: { op: 'move', slide: 257, after: 300 } }], 'owner')
      s.add('i2', 't2', [{ slide: 256, op: { op: 'remove', slide: 256 } }], 'owner')
      const p = s.pending('i1')
      expect(p.map((o) => o.slide)).toEqual([256, 300, 257])
      s.rewrite('i1', [{ ...p[2], op: { op: 'move', slide: 257, after: 256 } }])
      s.drop('i1', [p[1].id])
      expect(s.pending('i1').map((o) => o.op)).toEqual([p[0].op, { op: 'move', slide: 257, after: 256 }])
      // A row that no longer parses is left out.
      sdb.prepare(`UPDATE work_slides_ops SET op = '{"op":"paint"}' WHERE id = ?`).run(p[0].id)
      expect(s.pending('i1')).toHaveLength(1)
      s.setMode('i1', 't1', 'writes')
      s.setWritten('i1', 't1', { id: 'w', text: 'x', at: 1, before: 'b.pptx', after: 'h' })
      expect([s.mode('i1'), s.written('i1')?.before]).toEqual(['writes', 'b.pptx'])
      s.removeSessions(['t1'])
      expect([s.mode('i1'), s.written('i1'), s.pending('i1'), s.pending('i2').length]).toEqual(['suggests', null, [], 1])
      // ensure runs at every boot.
      expect(() => ensureSlidesTables(sdb)).not.toThrow()
    } finally {
      sdb.close()
      rmSync(d, { recursive: true, force: true })
    }
  })
})

describe('the module, on a fake deck tool', () => {
  let path: string
  beforeEach(async () => {
    await host(FAKE)
    path = join(dir, 'Show.pptx')
    writeFileSync(path, fakeBytes(FAKE_DECK))
  })
  afterEach(close)

  it('a remote key opens and reads a deck only under the roots it could name itself', async () => {
    const remote = { kind: 'remote', keyId: 'k1', name: 'Bot', audience: 'mcp', caps: ['read', 'operate'] } as never
    const item = openDeck(fileSource(path))
    await expect(call('work.slides.open', { itemId: item.id }, remote)).rejects.toThrow('forbidden: work.slides.open is outside app-managed roots')
    await expect(call('work.slides.read', { itemId: item.id, which: 'file', offset: 0, length: 10 }, remote)).rejects.toThrow('forbidden: work.slides.read is outside app-managed roots')
    // This host's own window opens it; a key opens it once it sits under a workspace's folder.
    expect((await call('work.slides.open', { itemId: item.id })).name).toBe('Show.pptx')
    db.prepare(`INSERT INTO workspaces (id, name, path, created_at) VALUES ('w9', 'Job', ?, 1)`).run(dir)
    expect((await call('work.slides.open', { itemId: item.id }, remote)).name).toBe('Show.pptx')
  })

  it('opens a deck: the outline in file order and one render, made once for two opens at the same time', async () => {
    const item = openDeck(fileSource(path))
    const [a, b] = await Promise.all([call('work.slides.open', { itemId: item.id }), call('work.slides.open', { itemId: item.id })])
    expect(b).toEqual(a)
    expect(a).toMatchObject({ itemId: item.id, sessionId: 't1', name: 'Show.pptx', mode: 'suggests', hosted: false, changes: [], renders: { proposed: null, file: { pages: 4 } } })
    expect(a.slides.map((s) => [s.key, s.number, s.from, s.page, s.tint])).toEqual([
      ['256', 1, 'file', 1, null],
      ['257', 2, 'file', 2, null],
      ['258', 3, 'file', 3, null],
      ['259', 4, 'file', 4, null]
    ])
    expect(a.slides[0].shapes[0]).toEqual({ id: 2, name: 'Title 1', bbox: [0.05, 0.05, 0.95, 0.2], text: 'One' })
    // Hidden slides are exported, so page n is slide n.
    expect(calls).toEqual(['deckinfo', 'pdf impress_pdf_Export:{"ExportHiddenSlides":{"type":"boolean","value":"true"}}'])
  })

  it('serves a render by range, and says so when there is no proposed deck', async () => {
    const item = openDeck(fileSource(path))
    const view = await call('work.slides.open', { itemId: item.id })
    const got = await call<{ data: string; size: number; rev: string }>('work.slides.read', { itemId: item.id, which: 'file', offset: 2, length: 6 })
    expect(Buffer.from(got.data, 'base64').toString()).toBe('DF-1.7')
    expect(got.rev).toBe(view.renders.file!.rev)
    expect(got.size).toBe(view.renders.file!.size)
    await expect(call('work.slides.read', { itemId: item.id, which: 'proposed', offset: 0, length: 10 })).rejects.toThrow('No changes wait on this deck.')
  })

  it("shows an agent's revision as changes: tints, ghosts where slides leave, the words before and after", async () => {
    const item = openDeck(fileSource(path))
    const r = await tool('slides_edit', {
      item: item.id,
      because: 'own',
      ops: [
        { op: 'text', slide: 257, shape: 3, paragraphs: ['New words'] },
        { op: 'notes', slide: 257, text: 'Say it' },
        { op: 'remove', slide: 258 },
        { op: 'move', slide: 256, after: 259 },
        { op: 'add', after: 257, layout: 'Title and Content', title: 'Added' }
      ]
    })
    expect(r.isError).toBeFalsy()
    expect(textOf(r)).toContain('New slide id: 10260')
    const view = (pushes.at(-1) as { view: DeckView }).view
    expect(view.changes.map((c) => [c.id, c.kind, c.label])).toEqual([
      ['slide-257', 'changed', 'Two'],
      ['slide-258', 'removed', 'Three'],
      ['slide-256', 'moved', 'One'],
      ['slide-10260', 'added', 'Added']
    ])
    expect(view.changes[0].edits).toEqual([
      { where: 'Body 2', before: 'About Two', after: 'New words' },
      { where: 'Notes', before: '', after: 'Say it' }
    ])
    expect(view.changes[0].by).toBe('agent:env_test:t1')
    // The proposed order, with a ghost for 256's old place first and for 258 after 257.
    expect(view.slides.map((s) => [s.key, s.number, s.from, s.page, s.tint, s.change])).toEqual([
      ['ghost:256', null, 'file', 1, 'del', 'slide-256'],
      ['257', 1, 'proposed', 1, 'add', 'slide-257'],
      ['ghost:258', null, 'file', 3, 'del', 'slide-258'],
      ['10260', 2, 'proposed', 2, 'add', 'slide-10260'],
      ['259', 3, 'proposed', 3, null, null],
      ['256', 4, 'proposed', 4, 'add', 'slide-256']
    ])
    expect(view.slides[1].changed).toEqual([[0.05, 0.25, 0.95, 0.9]])
    expect(view.renders.proposed).toMatchObject({ pages: 4 })
    // The file is untouched until he accepts.
    expect(readFake(path)).toEqual(FAKE_DECK)
    const outline = textOf(await tool('slides_read', { item: item.id }))
    expect(outline).toContain('4 slides, with 4 changes that wait for the person in')
    expect(outline).toContain('Slide 2 · id 10260 · Title and Content')
  })

  it('leaves a ghost where a slide that is both reworded and moved used to be', async () => {
    const item = openDeck(fileSource(path))
    await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'move', slide: 256, after: 258 }, { op: 'notes', slide: 256, text: 'n' }] })
    const view = (pushes.at(-1) as { view: DeckView }).view
    expect(view.changes.map((c) => c.kind)).toEqual(['changed'])
    expect(view.slides.map((s) => s.key)).toEqual(['ghost:256', '257', '258', '256', '259'])
  })

  it('checks a new edit against the pending ones before it keeps it, and numbers the sentences as the agent sent them', async () => {
    const item = openDeck(fileSource(path))
    await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'remove', slide: 258 }] })
    const r = await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'notes', slide: 256, text: 'ok' }, { op: 'text', slide: 258, shape: 2, paragraphs: ['x'] }] })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toBe('Nothing was kept:\nedit 2: there is no slide 258')
    expect(new SlidesStore(db).pending(item.id)).toHaveLength(1)
  })

  it('accept writes the change into the file, keeps the old file in history and drops its rows; an anchor on a slide not yet in the file is moved', async () => {
    const item = openDeck(fileSource(path))
    await tool('slides_edit', {
      item: item.id,
      because: 'own',
      ops: [
        { op: 'add', after: 256, layout: 'Title and Content', title: 'A', id: 300 },
        { op: 'add', after: 300, layout: 'Title and Content', title: 'B', id: 301 },
        { op: 'text', slide: 259, shape: 2, paragraphs: ['Four, renamed'] }
      ]
    })
    // B alone: its anchor, A, is not in the file, so it goes after 256.
    let view = await call('work.slides.review', { itemId: item.id, changes: ['slide-301'], verdict: 'accept' })
    expect(readFake(path).slides.map((s) => s.id)).toEqual([256, 301, 257, 258, 259])
    expect(view.changes.map((c) => c.id)).toEqual(['slide-300', 'slide-259'])
    expect(readdirSync(join(dir, 'canvas', 't1', item.id, 'history'))).toHaveLength(1)
    view = await call('work.slides.review', { itemId: item.id, changes: 'all', verdict: 'accept' })
    expect(readFake(path).slides.map((s) => s.title)).toEqual(['One', 'A', 'B', 'Two', 'Three', 'Four, renamed'])
    expect(view.changes).toEqual([])
    expect(view.renders.proposed).toBeNull()
    expect(pushes.at(-1)).toMatchObject({ push: 'work.slides', view: { itemId: item.id } })
  })

  it('reject drops the change; an edit anchored on a rejected add takes that add\'s own anchor', async () => {
    const item = openDeck(fileSource(path))
    await tool('slides_edit', {
      item: item.id,
      because: 'own',
      ops: [
        { op: 'add', after: 257, layout: 'Title and Content', title: 'A', id: 300 },
        { op: 'text', slide: 300, shape: 2, paragraphs: ['A, renamed'] },
        { op: 'move', slide: 256, after: 300 }
      ]
    })
    const view = await call('work.slides.review', { itemId: item.id, changes: ['slide-300'], verdict: 'reject' })
    expect(new SlidesStore(db).pending(item.id).map((p) => p.op)).toEqual([{ op: 'move', slide: 256, after: 257 }])
    expect(view.changes.map((c) => c.id)).toEqual(['slide-256'])
    expect(readFake(path)).toEqual(FAKE_DECK)
  })

  it('in writes mode, the agent\'s own edit lands at once with Undo, which holds only while the file is what it left', async () => {
    const item = openDeck(fileSource(path))
    await call('work.slides.mode', { itemId: item.id, mode: 'writes' })
    const r = await tool('slides_edit', { item: item.id, because: 'own', summary: 'Renamed slide 1', ops: [{ op: 'text', slide: 256, shape: 2, paragraphs: ['First'] }] })
    expect(textOf(r)).toContain('Wrote 1 edit into the deck')
    expect(readFake(path).slides[0].title).toBe('First')
    const view = (pushes.at(-1) as { view: DeckView }).view
    expect(view).toMatchObject({ mode: 'writes', changes: [], written: { text: 'Renamed slide 1' } })
    const back = await call('work.slides.undo', { itemId: item.id, writeId: view.written!.id })
    expect(readFake(path)).toEqual(FAKE_DECK)
    expect(back.written).toBeUndefined()
    await expect(call('work.slides.undo', { itemId: item.id, writeId: view.written!.id })).rejects.toThrow('That write can no longer be taken back.')
    // Once the file moves on, the write stays.
    await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'text', slide: 256, shape: 2, paragraphs: ['Again'] }] })
    const again = (pushes.at(-1) as { view: DeckView }).view
    writeFileSync(path, fakeBytes({ ...FAKE_DECK, layouts: ['Other'] }))
    await expect(call('work.slides.undo', { itemId: item.id, writeId: again.written!.id })).rejects.toThrow('The deck has changed since that write')
  })

  it('in writes mode, "asked" with words the owner really typed in the thread writes at once', async () => {
    typed.set('t1', ['Please rename the first slide to Welcome, thanks'])
    const item = openDeck(fileSource(path))
    await call('work.slides.mode', { itemId: item.id, mode: 'writes' })
    const r = await tool('slides_edit', { item: item.id, because: 'asked', quote: 'rename the first slide to  welcome', ops: [{ op: 'text', slide: 256, shape: 2, paragraphs: ['Welcome'] }] })
    expect(textOf(r)).toContain('Wrote 1 edit into the deck')
    expect(readFake(path).slides[0].title).toBe('Welcome')
    expect(new SlidesStore(db).pending(item.id)).toEqual([])
  })

  it('in writes mode, "asked" with words the owner did not type stays a suggestion', async () => {
    typed.set('t1', ['Please rename the first slide to Welcome, thanks'])
    const item = openDeck(fileSource(path))
    await call('work.slides.mode', { itemId: item.id, mode: 'writes' })
    const r = await tool('slides_edit', { item: item.id, because: 'asked', quote: 'rename it', ops: [{ op: 'notes', slide: 256, text: 'x' }] })
    expect(textOf(r)).toContain("The person's words were not found in this thread, so this is a suggestion.")
    expect(readFake(path)).toEqual(FAKE_DECK)
    expect(new SlidesStore(db).pending(item.id)).toHaveLength(1)
  })

  it("a deck in PowerPoint is hosted, and an agent's own idea on it is always a suggestion", async () => {
    const item = openDeck({ at: 'microsoft', host: 'env_test', app: 'powerpoint', name: 'Show.pptx', ref: { kind: 'path', path } })
    await call('work.slides.mode', { itemId: item.id, mode: 'writes' })
    const r = await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'notes', slide: 256, text: 'x' }] })
    expect(textOf(r)).toContain('The deck is shared, so your own idea is a suggestion.')
    expect((pushes.at(-1) as { view: DeckView }).view).toMatchObject({ hosted: true, name: 'Show.pptx', changes: [{ kind: 'changed' }] })
  })

  it('a remote key reviews, sets the mode of and undoes nothing on a deck outside its roots, and hears no push of it', async () => {
    const remote = { kind: 'remote', keyId: 'k1', name: 'Bot', audience: 'mcp', caps: ['read', 'operate'] } as never
    const heard: WorkPush[] = []
    work.pushes.onPush((p) => heard.push(p), remote)
    const item = openDeck(fileSource(path))
    await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'notes', slide: 256, text: 'x' }] })
    for (const [method, params] of [
      ['work.slides.review', { itemId: item.id, changes: 'all', verdict: 'accept' }],
      ['work.slides.review', { itemId: item.id, changes: 'all', verdict: 'reject' }],
      ['work.slides.mode', { itemId: item.id, mode: 'writes' }],
      ['work.slides.undo', { itemId: item.id, writeId: 'w' }]
    ] as const)
      await expect(call(method, params, remote)).rejects.toThrow(`forbidden: ${method} is outside app-managed roots`)
    expect(new SlidesStore(db).pending(item.id)).toHaveLength(1)
    expect(new SlidesStore(db).mode(item.id)).toBe('suggests')
    expect(readFake(path)).toEqual(FAKE_DECK)
    // The owner's window heard the edit; the key did not.
    expect(pushes.some((p) => p.push === 'work.slides')).toBe(true)
    expect(heard.filter((p) => p.push === 'work.slides')).toEqual([])
    // Under a workspace's folder, the key may act and hears it.
    db.prepare(`INSERT INTO workspaces (id, name, path, created_at) VALUES ('w9', 'Job', ?, 1)`).run(dir)
    await call('work.slides.mode', { itemId: item.id, mode: 'writes' }, remote)
    expect(new SlidesStore(db).mode(item.id)).toBe('writes')
    expect(heard.filter((p) => p.push === 'work.slides')).toHaveLength(1)
  })

  it('tells the agent which slide lost a link to a slide it removes', async () => {
    const d = JSON.parse(JSON.stringify(FAKE_DECK)) as FakeDeck
    d.slides[0].notes = 'link:258'
    writeFileSync(path, fakeBytes(d))
    const item = openDeck(fileSource(path))
    const r = await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'notes', slide: 257, text: 'y' }, { op: 'remove', slide: 258 }] })
    expect(r.isError).toBeFalsy()
    expect(textOf(r)).toContain('Note on edit 2: slide 256 linked to slide 258; that link was taken out.')
    // Accepting it is no failure either.
    await call('work.slides.review', { itemId: item.id, changes: 'all', verdict: 'accept' })
    expect(readFake(path).slides.map((s) => s.id)).toEqual([256, 257, 259])
  })

  it('refuses a deck on the web or in Google with a sentence, and a file that is not a deck', async () => {
    const web = openDeck({ at: 'microsoft', host: 'env_test', app: 'powerpoint', name: 'Web.pptx', ref: { kind: 'url', url: 'https://contoso.sharepoint.com/x.pptx' } }, 'Web')
    await expect(call('work.slides.open', { itemId: web.id })).rejects.toThrow('Web lives in PowerPoint on the web. Opening it from there is not built yet.')
    const g = openDeck({ at: 'google', account: 'a', fileId: 'f', mime: 'application/vnd.google-apps.presentation' }, 'G')
    await expect(call('work.slides.open', { itemId: g.id })).rejects.toThrow('G lives in Google: open it there.')
    const junk = join(dir, 'junk.pptx')
    writeFileSync(junk, 'hello')
    await expect(call('work.slides.open', { itemId: openDeck(fileSource(junk), 'J').id })).rejects.toThrow('junk.pptx is not a PowerPoint deck.')
  })

  it("only the owner reviews or sets the mode: a thread's own call is refused", async () => {
    const item = openDeck(fileSource(path))
    const by = { kind: 'model' as const, caps: [], sessionId: 't1' }
    await expect(slides.handle!(ClientRequestSchema.parse(req('work.slides.review', { itemId: item.id, changes: 'all', verdict: 'accept' })), work.ctx, by)).rejects.toThrow('Only the owner accepts or rejects a suggestion.')
    await expect(slides.handle!(ClientRequestSchema.parse(req('work.slides.mode', { itemId: item.id, mode: 'writes' })), work.ctx, by)).rejects.toThrow('Only the owner sets')
  })

  it('a picture of one slide comes from the render, through pdf → png', async () => {
    const item = openDeck(fileSource(path))
    const r = await tool('slides_image', { item: item.id, slide: 3 })
    expect(r.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' })
    expect(calls.at(-1)).toBe('png 3')
    expect(await tool('slides_image', { item: item.id, slide: 9 })).toMatchObject({ isError: true, content: [{ text: 'The deck has 4 slides.' }] })
  })

  it('keeps the newest four renders of an item', async () => {
    const item = openDeck(fileSource(path))
    for (let i = 0; i < 6; i++) await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'notes', slide: 256, text: `n${i}` }] })
    const keys = new Set(readdirSync(join(dir, 'canvas', 't1', item.id, 'render')).map((f) => f.split('.')[0]))
    expect(keys.size).toBe(4)
  })

  it('drafts a new deck as the thread\'s own, or as a file at a path it may not overwrite', async () => {
    const r = await tool('slides_new', { title: 'Plan', slides: [{ layout: 'title', title: 'Plan' }] })
    const id = (r.structuredContent as { item: string }).item
    const own = canvasStoreOf(db).get(id)!
    expect(own).toMatchObject({ kind: 'slides', source: { at: 'thread' } })
    expect(readFileSync(join(dir, 'canvas', 't1', id, 'deck.pptx')).subarray(0, 2).toString()).toBe('PK')
    const save = join(dir, 'Saved.pptx')
    const s = await tool('slides_new', { title: 'Saved', slides: [{ layout: 'bullets', title: 'x', bullets: ['a'] }], save })
    expect(s.isError).toBeFalsy()
    expect(canvasStoreOf(db).get((s.structuredContent as { item: string }).item)?.source).toEqual(fileSource(save))
    expect(await tool('slides_new', { title: 'Saved', slides: [{ layout: 'title', title: 'x' }], save })).toMatchObject({ isError: true, content: [{ text: `There is already a file at ${save}.` }] })
    expect(await tool('slides_new', { title: 'R', slides: [{ layout: 'title', title: 'x' }], save: 'rel.pptx' })).toMatchObject({ isError: true })
  })

  it('accepting a remove re-anchors an edit left waiting on that slide', async () => {
    const item = openDeck(fileSource(path))
    await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'add', after: 258, layout: 'Title and Content', title: 'N', id: 300 }, { op: 'remove', slide: 258 }] })
    await call('work.slides.review', { itemId: item.id, changes: ['slide-258'], verdict: 'accept' })
    expect(new SlidesStore(db).pending(item.id).map((p) => p.op)).toEqual([{ op: 'add', after: 257, layout: 'Title and Content', title: 'N', id: 300 }])
    await call('work.slides.review', { itemId: item.id, changes: 'all', verdict: 'accept' })
    expect(readFake(path).slides.map((s) => s.id)).toEqual([256, 257, 300, 259])
  })

  it('an older suggestion the file has outgrown does not block a new one', async () => {
    const item = openDeck(fileSource(path))
    await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'notes', slide: 258, text: 'x' }] })
    writeFileSync(path, fakeBytes({ ...FAKE_DECK, slides: FAKE_DECK.slides.filter((s) => s.id !== 258) }))
    const r = await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'notes', slide: 256, text: 'y' }] })
    expect(r.isError).toBeFalsy()
    expect(new SlidesStore(db).pending(item.id)).toHaveLength(2)
  })

  it('in writes mode, an edit made while suggestions wait waits with them', async () => {
    const item = openDeck(fileSource(path))
    await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'notes', slide: 256, text: 'x' }] })
    await call('work.slides.mode', { itemId: item.id, mode: 'writes' })
    const r = await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'notes', slide: 257, text: 'y' }] })
    expect(textOf(r)).toContain('Suggestions already wait on this deck, so this waits with them.')
    expect(readFake(path)).toEqual(FAKE_DECK)
  })

  it('reads the mode on the item\'s queue: an edit waiting behind a render follows a switch to suggests', async () => {
    const item = openDeck(fileSource(path))
    await call('work.slides.mode', { itemId: item.id, mode: 'writes' })
    let release!: () => void
    holdInfo = new Promise((res) => (release = res))
    // A new file version: its outline is made again, and held.
    writeFileSync(path, fakeBytes({ ...FAKE_DECK, layouts: ['Title and Content', 'Other'] }))
    const opening = call('work.slides.open', { itemId: item.id })
    const editing = tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'notes', slide: 256, text: 'x' }] })
    await new Promise((res) => setTimeout(res, 20))
    new SlidesStore(db).setMode(item.id, 't1', 'suggests')
    release()
    await opening
    expect(textOf(await editing)).toContain('Suggested 1 revised slide')
    expect(readFake(path).slides[0].notes).toBe('')
  })

  it('checks a new suggestion against the copy it hashed, never the live file', async () => {
    const item = openDeck(fileSource(path))
    await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'notes', slide: 256, text: 'x' }] })
    expect(editInputs.length).toBeGreaterThan(0)
    expect(editInputs).not.toContain(path)
  })

  it('keeps the copy from before a write first: when keeping it fails, the file is as it was', async () => {
    const item = openDeck(fileSource(path))
    await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'notes', slide: 256, text: 'x' }] })
    // history/ cannot be made: a file holds its name.
    writeFileSync(join(dir, 'canvas', 't1', item.id, 'history'), 'in the way')
    await expect(call('work.slides.review', { itemId: item.id, changes: 'all', verdict: 'accept' })).rejects.toThrow()
    expect(readFake(path)).toEqual(FAKE_DECK)
    expect(new SlidesStore(db).pending(item.id)).toHaveLength(1)
  })

  it('accepting one change puts a slide where the strip showed it, though its anchor is a waiting add that moves later', async () => {
    const item = openDeck(fileSource(path))
    await tool('slides_edit', {
      item: item.id,
      because: 'own',
      ops: [
        { op: 'add', after: 256, layout: 'Title and Content', title: 'X', id: 300 },
        { op: 'move', slide: 257, after: 300 },
        { op: 'move', slide: 300, after: 259 }
      ]
    })
    const shown = (pushes.at(-1) as { view: DeckView }).view.slides.filter((s) => !s.key.startsWith('ghost:')).map((s) => s.id)
    expect(shown).toEqual([256, 257, 258, 259, 300])
    await call('work.slides.review', { itemId: item.id, changes: ['slide-257'], verdict: 'accept' })
    expect(readFake(path).slides.map((s) => s.id)).toEqual([256, 257, 258, 259])
    await call('work.slides.review', { itemId: item.id, changes: ['slide-300'], verdict: 'accept' })
    expect(readFake(path).slides.map((s) => s.id)).toEqual(shown)
  })

  it('accepting changes one at a time ends in the order the strip showed', async () => {
    const item = openDeck(fileSource(path))
    await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'add', after: 257, layout: 'Title and Content', title: 'X', id: 300 }, { op: 'move', slide: 257, after: 300 }] })
    const shown = (pushes.at(-1) as { view: DeckView }).view.slides.filter((s) => !s.key.startsWith('ghost:')).map((s) => s.id)
    expect(shown).toEqual([256, 300, 257, 258, 259])
    await call('work.slides.review', { itemId: item.id, changes: ['slide-257'], verdict: 'accept' })
    await call('work.slides.review', { itemId: item.id, changes: ['slide-300'], verdict: 'accept' })
    expect(readFake(path).slides.map((s) => s.id)).toEqual(shown)
  })

  it('Accept all writes what still fits and names the change that no longer does, which stays waiting', async () => {
    const item = openDeck(fileSource(path))
    await tool('slides_edit', {
      item: item.id,
      because: 'own',
      ops: [
        { op: 'notes', slide: 256, text: 'kept' },
        { op: 'notes', slide: 259, text: 'a' },
        { op: 'text', slide: 259, shape: 'Body 2', paragraphs: ['b'] },
        { op: 'add', after: 256, layout: 'Title and Content', title: 'Mine', id: 500 }
      ]
    }).then((r) => expect(r.isError).toBeFalsy())
    // Meanwhile he renamed a shape on slide 4, and added a slide that took the id the host gave.
    const d = JSON.parse(JSON.stringify(FAKE_DECK)) as FakeDeck
    d.slides[3].shapes[1].name = 'Renamed'
    d.slides.push(slide(500, 'His own'))
    writeFileSync(path, fakeBytes(d))
    await expect(call('work.slides.review', { itemId: item.id, changes: 'all', verdict: 'accept' })).rejects.toThrow(
      '2 changes could not be accepted and still wait; the rest went in. “Four”: its edit 2 of 2: slide 259 has no shape Body 2. “Mine”: its edit 1 of 1: the deck already has a slide 500.'
    )
    expect(readFake(path).slides[0].notes).toBe('kept')
    expect(readFake(path).slides[3].notes).toBe('')
    expect(new SlidesStore(db).pending(item.id).map((p) => p.slide)).toEqual([259, 259, 500])
    // What went in was pushed.
    expect((pushes.at(-1) as { view: DeckView }).view.changes.map((c) => c.id)).toEqual(['slide-259', 'slide-500'])
  })

  it('never overwrites a save the owner made while an edit was being written', async () => {
    const item = openDeck(fileSource(path))
    await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'notes', slide: 256, text: 'x' }] })
    const saved = fakeBytes({ ...FAKE_DECK, layouts: ['Saved by him'] })
    duringEdit = () => writeFileSync(path, saved)
    await expect(call('work.slides.review', { itemId: item.id, changes: 'all', verdict: 'accept' })).rejects.toThrow('The deck changed while this was being made. Nothing was written')
    expect(readFileSync(path, 'utf8')).toBe(saved)
    expect(new SlidesStore(db).pending(item.id)).toHaveLength(1)
  })

  it('writes through a link to its target, and keeps the file\'s mode', async () => {
    const link = join(dir, 'Link.pptx')
    symlinkSync(path, link)
    chmodSync(path, 0o600)
    const item = openDeck(fileSource(link))
    await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'notes', slide: 256, text: 'x' }] })
    await call('work.slides.review', { itemId: item.id, changes: 'all', verdict: 'accept' })
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFake(path).slides[0].notes).toBe('x')
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('makes an outline cut short again rather than failing on it', async () => {
    const item = openDeck(fileSource(path))
    await call('work.slides.open', { itemId: item.id })
    const render = join(dir, 'canvas', 't1', item.id, 'render')
    for (const f of readdirSync(render)) if (f.endsWith('.json')) writeFileSync(join(render, f), '{"slides":[')
    expect((await call('work.slides.open', { itemId: item.id })).slides).toHaveLength(4)
  })

  it('clears its rows when a thread is removed', async () => {
    const item = openDeck(fileSource(path))
    await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'notes', slide: 256, text: 'x' }] })
    slides.sessionsRemoved!(['t1'], work.ctx)
    expect(new SlidesStore(db).pending(item.id)).toEqual([])
  })
})

describe('the module without LibreOffice in reach', () => {
  beforeEach(() => host(FAKE.filter((c) => c.to !== 'pdf')))
  afterEach(close)

  it('carries a sentence for the missing picture and the outline alone', async () => {
    const path = join(dir, 'Show.pptx')
    writeFileSync(path, fakeBytes(FAKE_DECK))
    const view = await call('work.slides.open', { itemId: openDeck(fileSource(path)).id })
    expect(view.renderError).toBe('There is no picture of the slides: LibreOffice is not installed on this host or on one it reaches.')
    expect(view.renders.file).toBeNull()
    expect(view.slides).toHaveLength(4)
  })
})

const DATA = process.env.TEMP_CODE_WORK_TOOLS_DATA
describe.skipIf(!DATA)('a real deck, through python-pptx and LibreOffice', () => {
  beforeEach(async () => {
    const { LIBREOFFICE_CONVERTERS } = await import('../formats')
    const { PDF_CONVERTERS } = await import('../pdf/extract')
    await host([...SLIDES_CONVERTERS, ...LIBREOFFICE_CONVERTERS, ...PDF_CONVERTERS], DATA)
  })
  afterEach(close)

  it('renders a 12-slide deck, a page a slide, and shows a suggestion on the proposed render', { timeout: 180_000 }, async () => {
    const path = join(dir, 'Twelve.pptx')
    writeFileSync(path, await writeNewDeck({ title: 'Twelve', slides: TWELVE }))
    const item = openDeck(fileSource(path))
    const view = await call('work.slides.open', { itemId: item.id })
    // The done-when line: a 12-slide deck renders.
    expect(view.renderError).toBeUndefined()
    expect(view.renders.file).toMatchObject({ pages: 12 })
    expect(view.slides.map((s) => s.title)).toEqual(TWELVE.map((s) => s.title))
    const pdf = Buffer.from((await call<{ data: string }>('work.slides.read', { itemId: item.id, which: 'file', offset: 0, length: 4 * 1024 * 1024 })).data, 'base64').toString('latin1')
    expect(pdf.startsWith('%PDF-')).toBe(true)
    expect(pdf.match(/\/Type\s*\/Page[^s]/g)).toHaveLength(12)
    const third = view.slides[2]
    const body = third.shapes.find((s) => s.text.startsWith('First'))!
    const r = await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'text', slide: third.id, shape: body.id, paragraphs: ['Changed'] }] })
    expect(r.isError).toBeFalsy()
    const after = (pushes.at(-1) as { view: DeckView }).view
    expect(after.renders.proposed).toMatchObject({ pages: 12 })
    expect(after.changes).toEqual([expect.objectContaining({ kind: 'changed', slideId: third.id, edits: [{ where: body.name, before: body.text, after: 'Changed' }] })])
    expect(after.slides[2]).toMatchObject({ tint: 'add', from: 'proposed', changed: [body.bbox] })
    expect(existsSync(path)).toBe(true)
    // A picture of the changed slide, from the proposed render.
    const shot = await tool('slides_image', { item: item.id, slide: 3 })
    expect(shot.isError).toBeFalsy()
    const png = Buffer.from((shot.content[0] as { data: string }).data, 'base64')
    expect(png.subarray(1, 4).toString()).toBe('PNG')
  })
})

/** The listener's roots as index.ts hands them in (managedRoots): every project's checkout and workspace's folder. */
function hostFence(db: DatabaseSync): { roots(): string[]; denied(): string[] } {
  return { roots: () => (db.prepare(`SELECT cwd AS p FROM projects UNION SELECT path AS p FROM workspaces`).all() as Array<{ p: string }>).map((r) => r.p), denied: () => [] }
}
