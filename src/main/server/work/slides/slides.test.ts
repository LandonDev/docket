import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_PRINCIPAL } from '@shared/capabilities'
import { ClientRequestSchema, type ClientRequest } from '@shared/contract'
import type { WorkPush } from '@shared/contract-work'
import type { DeckView, ShowDeck, SlideOp } from '@shared/contract-work-slides'
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

// The rest of the scope module is the real one: other parts of the context read it (the outbox's scope facts).
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
/** Paths the test calls a place others can open (a Teams library); every other path is judged by the real rule. */
const sharedPaths = vi.hoisted(() => new Set<string>())
vi.mock('../files/policy', async (original) => {
  const real = await original<typeof import('../files/policy')>()
  return { ...real, sharedOf: (ctx: never, source: CanvasSource) => (source.at === 'file' && [...sharedPaths].some((p) => source.path.startsWith(p))) || real.sharedOf(ctx, source) }
})

const { startWork } = await import('../ctx')
const { canvas } = await import('../canvas')
const { slides } = await import('.')
const { SLIDES_CONVERTERS } = await import('./deck')
const { deckBase, deckCache, deckKey, fileKey, fileMoved, setSlideRenderer } = await import('./view')
/** Where a deck keeps its renders and versions: by the file for a file of his own, else in the item's own folder. */
const folderOf = (item: { id: string; source: CanvasSource }, sub = 'render'): string =>
  deckKey(item as never).startsWith('file:') && !sharedPaths.size ? (sub === 'history' ? deckBase : deckCache)(dir, deckKey(item as never)) : join(dir, 'canvas', 't1', item.id)

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
/** Every job a converter was handed: what it made, and whether it was marked a shared file's. */
const jobs: Array<{ to: string; shared?: boolean }> = []
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
      jobs.push({ to: job.to, shared: job.shared })
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
      jobs.push({ to: job.to, shared: job.shared })
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
      jobs.push({ to: job.to, shared: job.shared })
      writeFileSync(job.output, `%PDF-1.7 ${createHash('sha256').update(readFileSync(job.input)).digest('hex')}`)
      return {}
    }
  },
  {
    from: 'pdf',
    to: 'png',
    async run(job) {
      calls.push(`png ${String(job.options?.page)}`)
      jobs.push({ to: job.to, shared: job.shared })
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
      // The mode is the seat's: an item with no seat has none to set.
      s.setMode('i1', 'writes')
      expect(s.mode('i1')).toBe('suggests')
      s.seat('i1', 't1', 'i1')
      s.setMode('i1', 'writes')
      s.setWritten('i1', 't1', { id: 'w', text: 'x', at: 1, before: 'b.pptx', after: 'h' })
      expect([s.mode('i1'), s.written('i1')?.before]).toEqual(['writes', 'b.pptx'])
      expect(s.removeSessions(['t1'])).toEqual([{ deck: 'i1', left: 0, shared: false }])
      expect([s.mode('i1'), s.written('i1'), s.pending('i1'), s.pending('i2').length]).toEqual(['suggests', null, [], 1])
      // A key with nothing kept under it moves nothing: renaming a link to a deck must not wipe the deck's own rows.
      s.rekey('file:/a/link.pptx', 'i2')
      expect(s.pending('i2')).toHaveLength(1)
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
    expect(a.slides[0].shapes[0]).toEqual({ id: 2, name: 'Title 1', label: 'Title', bbox: [0.05, 0.05, 0.95, 0.2], text: 'One', kind: 'text' })
    expect([a.slides[0].layout, a.size]).toEqual(['Title and Content', { width: 12192000, height: 6858000 }])
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

  it('a show is the file as it is, in its own order, whatever suggestions wait', async () => {
    const item = openDeck(fileSource(path))
    const view = await call('work.slides.open', { itemId: item.id })
    const r = await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'remove', slide: 258 }, { op: 'move', slide: 256, after: 259 }, { op: 'text', slide: 257, shape: 3, paragraphs: ['New words'] }] })
    expect(r.isError).toBeFalsy()
    const show = await call<ShowDeck>('work.slides.show', { itemId: item.id })
    expect(show).toMatchObject({ itemId: item.id, name: 'Show.pptx', rev: view.rev, render: view.renders.file })
    expect(show.slides.map((s) => [s.id, s.number, s.page, s.title, s.hidden])).toEqual([
      [256, 1, 1, 'One', false],
      [257, 2, 2, 'Two', false],
      [258, 3, 3, 'Three', false],
      [259, 4, 4, 'Four', false]
    ])
    // A remote key gets no show of a deck outside its roots.
    const remote = { kind: 'remote', keyId: 'k1', name: 'Bot', audience: 'mcp', caps: ['read', 'operate'] } as never
    await expect(call('work.slides.show', { itemId: item.id }, remote)).rejects.toThrow('forbidden: work.slides.show is outside app-managed roots')
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
      { where: 'Text', before: 'About Two', after: 'New words' },
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
    expect(new SlidesStore(db).pending(deckKey(item))).toHaveLength(1)
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
    expect(readdirSync(join(folderOf(item, 'history'), 'history'))).toHaveLength(1)
    view = await call('work.slides.review', { itemId: item.id, changes: 'all', verdict: 'accept' })
    expect(readFake(path).slides.map((s) => s.title)).toEqual(['One', 'A', 'B', 'Two', 'Three', 'Four, renamed'])
    expect(view.changes).toEqual([])
    expect(view.renders.proposed).toBeNull()
    expect(pushes.at(-1)).toMatchObject({ push: 'work.slides', view: { itemId: item.id } })
  })

  it('a press made on one preview is refused once the changes moved on, for an accept and a reject alike; a press with no rev is not checked', async () => {
    const item = openDeck(fileSource(path))
    await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'text', slide: 257, shape: 3, paragraphs: ['First words'] }] })
    const opened = await call('work.slides.open', { itemId: item.id })
    const shown = opened.renders.proposed!.rev
    // With a picture, the changes' revision is the picture's: one rule, one value.
    expect(opened.changesRev).toBe(shown)
    // The agent's next edit joins after the phone drew its preview: that preview's press changes nothing.
    await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'text', slide: 257, shape: 3, paragraphs: ['Second words'] }] })
    const before = pushes.length
    for (const verdict of ['accept', 'reject'] as const) {
      await expect(call('work.slides.review', { itemId: item.id, changes: 'all', verdict, rev: shown })).rejects.toThrow('The suggestions changed since this preview')
    }
    expect(readFake(path)).toEqual(FAKE_DECK)
    expect(new SlidesStore(db).pending(deckKey(item))).toHaveLength(2)
    // Every client is shown the changes as they are now.
    expect(pushes.length).toBeGreaterThan(before)
    // The fresh preview's rev is taken; a press with none (an older phone build) is not checked.
    const now = (await call('work.slides.open', { itemId: item.id })).renders.proposed!.rev
    expect(now).not.toBe(shown)
    const view = await call('work.slides.review', { itemId: item.id, changes: 'all', verdict: 'reject', rev: now })
    expect(view.changes).toEqual([])
    await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'text', slide: 257, shape: 3, paragraphs: ['Third words'] }] })
    expect((await call('work.slides.review', { itemId: item.id, changes: 'all', verdict: 'accept' })).changes).toEqual([])
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
    expect(new SlidesStore(db).pending(deckKey(item)).map((p) => p.op)).toEqual([{ op: 'move', slide: 256, after: 257 }])
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
    expect(new SlidesStore(db).pending(deckKey(item))).toEqual([])
  })

  it('in writes mode, "asked" with words the owner did not type stays a suggestion', async () => {
    typed.set('t1', ['Please rename the first slide to Welcome, thanks'])
    const item = openDeck(fileSource(path))
    await call('work.slides.mode', { itemId: item.id, mode: 'writes' })
    const r = await tool('slides_edit', { item: item.id, because: 'asked', quote: 'rename it', ops: [{ op: 'notes', slide: 256, text: 'x' }] })
    expect(textOf(r)).toContain("The person's words were not found in this thread, so this is a suggestion.")
    expect(readFake(path)).toEqual(FAKE_DECK)
    expect(new SlidesStore(db).pending(deckKey(item))).toHaveLength(1)
  })

  it("a deck in PowerPoint is hosted, and an agent's own idea on it is always a suggestion", async () => {
    const item = openDeck({ at: 'microsoft', host: 'env_test', app: 'powerpoint', name: 'Show.pptx', ref: { kind: 'path', path } })
    await call('work.slides.mode', { itemId: item.id, mode: 'writes' })
    const r = await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'notes', slide: 256, text: 'x' }] })
    expect(textOf(r)).toContain('The deck is shared, so your own idea is a suggestion.')
    expect((pushes.at(-1) as { view: DeckView }).view).toMatchObject({ hosted: true, name: 'Show.pptx', changes: [{ kind: 'changed' }] })
  })

  describe('a deck in a place others can open (a Teams or OneDrive library)', () => {
    let team: string
    let deckAt: string
    beforeEach(() => {
      team = join(dir, 'Esports Staff')
      mkdirSync(team)
      deckAt = join(team, 'Show.pptx')
      writeFileSync(deckAt, fakeBytes(FAKE_DECK))
      sharedPaths.add(team)
    })
    afterEach(() => sharedPaths.clear())

    it("an agent's own idea is a suggestion even where the deck says Agent writes: the file stays byte for byte as it was, nothing is written beside it, and no copy may leave this host", async () => {
      const item = openDeck(fileSource(deckAt))
      await call('work.slides.mode', { itemId: item.id, mode: 'writes' })
      const before = readFileSync(deckAt)
      jobs.length = 0
      const r = await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'text', slide: 257, shape: 3, paragraphs: ['New words'] }, { op: 'add', after: 256, layout: 'Title and Content', title: 'Added' }] })
      expect(r.isError).toBeFalsy()
      expect(textOf(r)).toContain('The deck is shared, so your own idea is a suggestion.')
      expect(r.structuredContent).toMatchObject({ direct: false })
      // Nothing reached the file or its folder: the edits are rows on this host and the proposed deck is under app data.
      expect(readFileSync(deckAt).equals(before)).toBe(true)
      expect(readdirSync(team)).toEqual(['Show.pptx'])
      expect(new SlidesStore(db).pending(deckKey(item))).toHaveLength(2)
      const view = (pushes.at(-1) as { view: DeckView }).view
      expect(view.changes).toHaveLength(2)
      expect(view.written).toBeUndefined()
      // Every tool run on a copy of it says the copy is a shared file's, so the runner never carries it to another host.
      expect(jobs.length).toBeGreaterThan(0)
      expect(jobs.every((j) => j.shared === true)).toBe(true)
      // A picture of the proposed deck for the agent is made here too.
      jobs.length = 0
      await tool('slides_image', { item: item.id, slide: 1 })
      expect(jobs.at(-1)).toMatchObject({ to: 'png', shared: true })
      // His accept is what writes it, as an ordinary edit.
      await call('work.slides.review', { itemId: item.id, changes: 'all', verdict: 'accept', rev: view.changesRev })
      expect(readFileSync(deckAt).equals(before)).toBe(false)
      expect(readdirSync(team)).toEqual(['Show.pptx'])
    })

    it('what he asked for in so many words is still written at once', async () => {
      typed.set('t1', ['Please retitle the second slide to New words for the staff meeting'])
      const item = openDeck(fileSource(deckAt))
      await call('work.slides.mode', { itemId: item.id, mode: 'writes' })
      const before = readFileSync(deckAt)
      const r = await tool('slides_edit', { item: item.id, because: 'asked', quote: 'retitle the second slide to New words', ops: [{ op: 'text', slide: 257, shape: 3, paragraphs: ['New words'] }] })
      expect(r.structuredContent).toMatchObject({ direct: true })
      expect(readFileSync(deckAt).equals(before)).toBe(false)
    })

    it('a deck of his own is still written at once in Agent writes, and its copies carry no mark', async () => {
      const item = openDeck(fileSource(path))
      await call('work.slides.mode', { itemId: item.id, mode: 'writes' })
      jobs.length = 0
      const r = await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'text', slide: 257, shape: 3, paragraphs: ['New words'] }] })
      expect(r.structuredContent).toMatchObject({ direct: true })
      expect(jobs.some((j) => j.shared)).toBe(false)
    })

    it('an agent never puts a new deck in such a place: nothing is written there and it is told to make it in the thread', async () => {
      const r = await tool('slides_new', { title: 'Staff update', slides: [{ layout: 'title', title: 'Staff update' }], save: join(team, 'Staff update.pptx') })
      expect(r.isError).toBe(true)
      expect(textOf(r)).toContain('is a place other people can open, and an agent does not put a new deck there')
      expect(readdirSync(team)).toEqual(['Show.pptx'])
    })
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
    expect(new SlidesStore(db).pending(deckKey(item))).toHaveLength(1)
    expect(new SlidesStore(db).mode(deckKey(item))).toBe('suggests')
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
    const keys = new Set(readdirSync(join(folderOf(item), 'render')).map((f) => f.split('.')[0]))
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
    expect(new SlidesStore(db).pending(deckKey(item)).map((p) => p.op)).toEqual([{ op: 'add', after: 257, layout: 'Title and Content', title: 'N', id: 300 }])
    await call('work.slides.review', { itemId: item.id, changes: 'all', verdict: 'accept' })
    expect(readFake(path).slides.map((s) => s.id)).toEqual([256, 257, 300, 259])
  })

  it('an older suggestion the file has outgrown does not block a new one', async () => {
    const item = openDeck(fileSource(path))
    await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'notes', slide: 258, text: 'x' }] })
    writeFileSync(path, fakeBytes({ ...FAKE_DECK, slides: FAKE_DECK.slides.filter((s) => s.id !== 258) }))
    const r = await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'notes', slide: 256, text: 'y' }] })
    expect(r.isError).toBeFalsy()
    expect(new SlidesStore(db).pending(deckKey(item))).toHaveLength(2)
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
    new SlidesStore(db).setMode(item.id, 'suggests')
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
    mkdirSync(folderOf(item, 'history'), { recursive: true })
    writeFileSync(join(folderOf(item, 'history'), 'history'), 'in the way')
    await expect(call('work.slides.review', { itemId: item.id, changes: 'all', verdict: 'accept' })).rejects.toThrow()
    expect(readFake(path)).toEqual(FAKE_DECK)
    expect(new SlidesStore(db).pending(deckKey(item))).toHaveLength(1)
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
    expect(new SlidesStore(db).pending(deckKey(item)).map((p) => p.slide)).toEqual([259, 259, 500])
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
    expect(new SlidesStore(db).pending(deckKey(item))).toHaveLength(1)
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
    const render = join(folderOf(item), 'render')
    for (const f of readdirSync(render)) if (f.endsWith('.json')) writeFileSync(join(render, f), '{"slides":[')
    expect((await call('work.slides.open', { itemId: item.id })).slides).toHaveLength(4)
  })

  it('clears its rows when a thread is removed', async () => {
    const item = openDeck(fileSource(path))
    await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'notes', slide: 256, text: 'x' }] })
    slides.sessionsRemoved!(['t1'], work.ctx)
    expect(new SlidesStore(db).pending(deckKey(item))).toEqual([])
  })
})

/** The fake deck tool with real pictures: an outline that hashes what each slide is drawn from, and a PDF of one page a slide whose width is the slide's id. */
const PICTURED: Converter[] = [
  {
    from: 'pptx',
    to: 'deckinfo',
    async run(job) {
      const d = readFake(job.input)
      const slides = d.slides.map((s) => ({ ...s, draws: createHash('sha256').update(JSON.stringify([s.id, s.title, s.shapes])).digest('hex') }))
      writeFileSync(job.output, JSON.stringify({ width: 12192000, height: 6858000, sections: [], ...d, slides }))
      return {}
    }
  },
  FAKE[1],
  {
    from: 'pptx',
    to: 'pdf',
    async run(job) {
      calls.push('pdf whole')
      const doc = await PDFDocument.create()
      for (const s of readFake(job.input).slides) doc.addPage([s.id, 100])
      writeFileSync(job.output, await doc.save())
      return {}
    }
  },
  FAKE[3]
]
const pageWidths = async (bytes: Uint8Array): Promise<number[]> => (await PDFDocument.load(bytes)).getPages().map((p) => p.getWidth())

describe('a deck kept by its file, drawn slide by slide', () => {
  let path: string
  beforeEach(async () => {
    await host(PICTURED)
    path = join(dir, 'Show.pptx')
    writeFileSync(path, fakeBytes(FAKE_DECK))
  })
  afterEach(() => {
    setSlideRenderer(null)
    close()
  })
  const readAll = async (method: string, params: Record<string, unknown>): Promise<{ bytes: Uint8Array; rev: string }> => {
    const got = await call<{ data: string; size: number; rev: string }>(method, { ...params, offset: 0, length: 4 * 1024 * 1024 })
    return { bytes: Buffer.from(got.data, 'base64'), rev: got.rev }
  }

  it('two items on one file are one deck: one list of waiting edits, each seat its own mode, and both are told of a change as their own item', async () => {
    sessions.set('t2', { id: 't2', provider: 'claude', workspaceId: 'w1', scope: 'work' } as SessionMeta)
    const [a, b] = [openDeck(fileSource(path), 'In a thread'), canvasStoreOf(db).open('t2', { kind: 'slides', source: fileSource(path), title: 'In a Files tab' })]
    expect(a.id).not.toBe(b.id)
    await call('work.slides.open', { itemId: a.id })
    await call('work.slides.open', { itemId: b.id })
    expect(deckKey(a)).toBe(deckKey(b))
    pushes.length = 0
    await call('work.slides.mode', { itemId: b.id, mode: 'writes' })
    // "Agent writes" is a leave given in one tab: the other seat on the same file keeps its own.
    expect((await call('work.slides.open', { itemId: a.id })).mode).toBe('suggests')
    // Each seat hears the deck as its own item, in its own mode.
    expect((pushes as Array<{ view: DeckView }>).map((p) => [p.view.itemId, p.view.sessionId, p.view.mode]).sort()).toEqual([[a.id, 't1', 'suggests'], [b.id, 't2', 'writes']].sort())
    // An agent's own idea from the seat that suggests waits, whatever the other seat's mode.
    await tool('slides_edit', { item: a.id, because: 'own', ops: [{ op: 'text', slide: 257, shape: 3, paragraphs: ['New words'] }] })
    const other = await call('work.slides.open', { itemId: b.id })
    expect(other.changes.map((c) => c.id)).toEqual(['slide-257'])
    // The other seat accepts what was suggested through the first.
    await call('work.slides.review', { itemId: b.id, changes: 'all', verdict: 'accept', rev: other.changesRev })
    expect((await call('work.slides.open', { itemId: a.id })).changes).toEqual([])
    expect(readFake(path).slides[1].shapes[1].text).toBe('New words')
    // Its renders and versions are kept by the file, once, not under either item.
    expect(readdirSync(join(deckBase(dir, deckKey(a)), 'history'))).toHaveLength(1)
    expect(existsSync(join(dir, 'canvas', 't1', a.id, 'render'))).toBe(false)
  })

  it('rows kept under an item from before decks were kept by the file move to the file, once', async () => {
    const item = openDeck(fileSource(path))
    const store = new SlidesStore(db)
    db.prepare(`INSERT INTO work_slides_items (item_id, session_id, mode, updated_at) VALUES (?, 't1', 'writes', 1)`).run(item.id)
    store.add(item.id, 't1', [{ slide: 256, op: { op: 'notes', slide: 256, text: 'kept' } }], 'agent:env_test:t1')
    const view = await call('work.slides.open', { itemId: item.id })
    // Its mode becomes its seat's; its waiting edits become the deck's.
    expect([view.mode, view.changes.map((c) => c.id)]).toEqual(['writes', ['slide-256']])
    expect([store.pending(item.id), store.mode(item.id)]).toEqual([[], 'writes'])
    expect(store.pending(deckKey(item))).toHaveLength(1)
  })

  it('two items from before on one file both keep their waiting edits, in the order each was opened', async () => {
    sessions.set('t2', { id: 't2', provider: 'claude', workspaceId: 'w1', scope: 'work' } as SessionMeta)
    const [a, b] = [openDeck(fileSource(path), 'A'), canvasStoreOf(db).open('t2', { kind: 'slides', source: fileSource(path), title: 'B' })]
    const store = new SlidesStore(db)
    store.add(a.id, 't1', [{ slide: 256, op: { op: 'notes', slide: 256, text: 'from a' } }], 'agent:env_test:t1')
    store.add(b.id, 't2', [{ slide: 257, op: { op: 'notes', slide: 257, text: 'from b' } }], 'agent:env_test:t2')
    await call('work.slides.open', { itemId: a.id })
    const view = await call('work.slides.open', { itemId: b.id })
    expect(view.changes.map((c) => c.id)).toEqual(['slide-256', 'slide-257'])
    expect(store.pending(deckKey(a)).map((p) => (p.op as { text: string }).text)).toEqual(['from a', 'from b'])
  })

  it('a deck a thread made is its item\'s own: kept under the item and gone with it', async () => {
    const r = await tool('slides_new', { title: 'Own', slides: [{ layout: 'title', title: 'Own' }] })
    const id = (r.structuredContent as { item: string }).item
    const item = canvasStoreOf(db).get(id)!
    expect(deckKey(item)).toBe(id)
  })

  it('a file of his own keeps its waiting edits and its versions when its last seat leaves; only its pictures go', async () => {
    const item = openDeck(fileSource(path))
    await call('work.slides.open', { itemId: item.id })
    await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'notes', slide: 256, text: 'x' }] })
    const base = deckCache(dir, deckKey(item))
    expect(existsSync(join(base, 'pages'))).toBe(true)
    slides.itemsRemoved!([item], work.ctx)
    expect(new SlidesStore(db).pending(deckKey(item))).toHaveLength(1)
    expect(new SlidesStore(db).seats(deckKey(item))).toEqual([])
    // The pictures go on the deck's own queue, after whatever was still drawing them.
    await vi.waitFor(() => expect(existsSync(base)).toBe(false))
  })

  it('a removed thread leaves its seats as a closed tab does: a file of his own loses its pictures, a file others can open everything', async () => {
    const item = openDeck(fileSource(path))
    await call('work.slides.mode', { itemId: item.id, mode: 'writes' })
    await call('work.slides.open', { itemId: item.id })
    new SlidesStore(db).add(deckKey(item), '', [{ slide: 257, op: { op: 'notes', slide: 257, text: 'another thread’s' } }], 'agent:env_test:t9')
    const base = deckCache(dir, deckKey(item))
    expect(existsSync(join(base, 'pages'))).toBe(true)
    slides.sessionsRemoved!(['t1'], work.ctx)
    expect(new SlidesStore(db).seats(deckKey(item))).toEqual([])
    expect(new SlidesStore(db).pending(deckKey(item))).toHaveLength(1)
    await vi.waitFor(() => expect(existsSync(base)).toBe(false))
    // The leave he gave in that thread went with it: the file opened again elsewhere suggests.
    sessions.set('t2', { id: 't2', provider: 'claude', workspaceId: 'w1', scope: 'work' } as SessionMeta)
    const again = canvasStoreOf(db).open('t2', { kind: 'slides', source: fileSource(path), title: 'Again' })
    expect((await call('work.slides.open', { itemId: again.id })).mode).toBe('suggests')

    const team = join(dir, 'Esports Staff')
    mkdirSync(team)
    const shared = join(team, 'Show.pptx')
    writeFileSync(shared, fakeBytes(FAKE_DECK))
    sharedPaths.add(team)
    try {
      const b = canvasStoreOf(db).open('t2', { kind: 'slides', source: fileSource(shared), title: 'Shared' })
      await call('work.slides.open', { itemId: b.id })
      new SlidesStore(db).add(deckKey(b), '', [{ slide: 256, op: { op: 'notes', slide: 256, text: 'waits' } }], 'agent:env_test:t9')
      slides.sessionsRemoved!(['t2'], work.ctx)
      expect(new SlidesStore(db).pending(deckKey(b))).toEqual([])
    } finally {
      sharedPaths.clear()
    }
  })

  it('an item that never took a seat leaves the deck as its other seats hold it', async () => {
    const team = join(dir, 'Esports Staff')
    mkdirSync(team)
    const shared = join(team, 'Show.pptx')
    writeFileSync(shared, fakeBytes(FAKE_DECK))
    sharedPaths.add(team)
    try {
      sessions.set('t2', { id: 't2', provider: 'claude', workspaceId: 'w1', scope: 'work' } as SessionMeta)
      const [a, never] = [openDeck(fileSource(shared), 'A'), canvasStoreOf(db).open('t2', { kind: 'slides', source: fileSource(shared), title: 'Never opened' })]
      await tool('slides_edit', { item: a.id, because: 'own', ops: [{ op: 'notes', slide: 256, text: 'x' }] })
      // A tab on the same file, from before, closed without ever being opened.
      slides.itemsRemoved!([never], work.ctx)
      expect(new SlidesStore(db).pending(deckKey(a))).toHaveLength(1)
      expect(new SlidesStore(db).seats(deckKey(a)).map((s) => s.itemId)).toEqual([a.id])
    } finally {
      sharedPaths.clear()
    }
  })

  it('a deck is one others can open when any seat on it says so: its suggestions stay on this host through every seat', async () => {
    const team = join(dir, 'Esports Staff')
    mkdirSync(team)
    const shared = join(team, 'Show.pptx')
    writeFileSync(shared, fakeBytes(FAKE_DECK))
    sessions.set('t2', { id: 't2', provider: 'claude', workspaceId: 'w1', scope: 'work' } as SessionMeta)
    // One seat opened while the folder was not known to be a library keeps its pictures by the file.
    const plain = canvasStoreOf(db).open('t2', { kind: 'slides', source: fileSource(shared), title: 'Plain' })
    await call('work.slides.open', { itemId: plain.id })
    expect(existsSync(deckCache(dir, deckKey(plain)))).toBe(true)
    sharedPaths.add(team)
    try {
      // The same path through a seat that knows it as PowerPoint's: the deck is shared for both from now.
      const hosted = canvasStoreOf(db).open('t1', { kind: 'slides', source: { at: 'microsoft', host: 'env_test', app: 'powerpoint', name: 'Show.pptx', ref: { kind: 'path', path: shared } }, title: 'Hosted' })
      await call('work.slides.mode', { itemId: hosted.id, mode: 'writes' })
      sharedPaths.clear()
      expect(new SlidesStore(db).sharedDeck(deckKey(plain))).toBe(true)
      // What the earlier seat kept by the file is gone, and nothing is kept there again.
      expect([existsSync(deckBase(dir, deckKey(plain))), existsSync(deckCache(dir, deckKey(plain)))]).toEqual([false, false])
      jobs.length = 0
      const r = await tool('slides_edit', { item: hosted.id, because: 'own', ops: [{ op: 'notes', slide: 256, text: 'x' }] })
      expect(textOf(r)).toContain('Suggested 1 revised slide')
      expect(readFake(shared)).toEqual(FAKE_DECK)
      // The seat that names it as a plain file draws the same waiting suggestion, marked shared on every job.
      jobs.length = 0
      const view = await call('work.slides.open', { itemId: plain.id })
      expect(view.changes).toHaveLength(1)
      expect(jobs.length).toBeGreaterThan(0)
      expect(jobs.every((j) => j.shared === true)).toBe(true)
      expect([existsSync(deckBase(dir, deckKey(plain))), existsSync(deckCache(dir, deckKey(plain)))]).toEqual([false, false])
    } finally {
      sharedPaths.clear()
    }
  })

  it('on a file others can open, only the tab that made a direct write offers its Undo, and it goes with that tab', async () => {
    const team = join(dir, 'Esports Staff')
    mkdirSync(team)
    const shared = join(team, 'Show.pptx')
    writeFileSync(shared, fakeBytes(FAKE_DECK))
    sharedPaths.add(team)
    try {
      typed.set('t1', ['rename slide 1 to First'])
      sessions.set('t2', { id: 't2', provider: 'claude', workspaceId: 'w1', scope: 'work' } as SessionMeta)
      const [a, b] = [openDeck(fileSource(shared), 'A'), canvasStoreOf(db).open('t2', { kind: 'slides', source: fileSource(shared), title: 'B' })]
      await call('work.slides.open', { itemId: b.id })
      await call('work.slides.mode', { itemId: a.id, mode: 'writes' })
      const r = await tool('slides_edit', { item: a.id, because: 'asked', quote: 'rename slide 1 to First', ops: [{ op: 'text', slide: 256, shape: 2, paragraphs: ['First'] }] })
      expect(textOf(r)).toContain('Wrote 1 edit')
      const [mine, theirs] = [await call('work.slides.open', { itemId: a.id }), await call('work.slides.open', { itemId: b.id })]
      expect(mine.written).toBeDefined()
      // The copy from before is in the writing item's folder: the other seat has nothing to put back.
      expect(theirs.written).toBeUndefined()
      await expect(call('work.slides.undo', { itemId: b.id, writeId: mine.written!.id })).rejects.toThrow('That write can no longer be taken back.')
      slides.itemsRemoved!([a], work.ctx)
      expect(new SlidesStore(db).written(deckKey(b))).toBeNull()
    } finally {
      sharedPaths.clear()
      typed.clear()
    }
  })

  it('a file others can open keeps nothing past its last seat, and a seat that stays keeps the deck', async () => {
    const team = join(dir, 'Esports Staff')
    mkdirSync(team)
    const shared = join(team, 'Show.pptx')
    writeFileSync(shared, fakeBytes(FAKE_DECK))
    sharedPaths.add(team)
    try {
      sessions.set('t2', { id: 't2', provider: 'claude', workspaceId: 'w1', scope: 'work' } as SessionMeta)
      const [a, b] = [openDeck(fileSource(shared), 'A'), canvasStoreOf(db).open('t2', { kind: 'slides', source: fileSource(shared), title: 'B' })]
      expect(a.id).not.toBe(b.id)
      await call('work.slides.open', { itemId: a.id })
      await call('work.slides.open', { itemId: b.id })
      await tool('slides_edit', { item: a.id, because: 'own', ops: [{ op: 'notes', slide: 256, text: 'x' }] })
      // Nothing of a shared file is kept by the file under app data: each seat's renders are in its own item's folder.
      expect([existsSync(deckBase(dir, deckKey(a))), existsSync(deckCache(dir, deckKey(a)))]).toEqual([false, false])
      slides.itemsRemoved!([a], work.ctx)
      expect(new SlidesStore(db).pending(deckKey(b))).toHaveLength(1)
      slides.itemsRemoved!([b], work.ctx)
      expect(new SlidesStore(db).pending(deckKey(b))).toEqual([])
    } finally {
      sharedPaths.clear()
    }
  })

  it('a file renamed under its deck keeps its waiting edits, its mode and its versions under the new name', async () => {
    const item = openDeck(fileSource(path))
    await call('work.slides.mode', { itemId: item.id, mode: 'writes' })
    await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'notes', slide: 256, text: 'x' }] })
    const was = deckKey(item)
    const to = join(dir, 'Renamed.pptx')
    renameSync(path, to)
    fileMoved(fileSource(path), fileSource(to), { db, dataDir: dir })
    const now = fileKey(to)
    expect(now).not.toBe(was)
    expect(new SlidesStore(db).mode(item.id)).toBe('writes')
    expect(new SlidesStore(db).written(now)).not.toBeNull()
    expect(new SlidesStore(db).written(was)).toBeNull()
    expect(readdirSync(join(deckBase(dir, now), 'history'))).toHaveLength(1)
    expect([existsSync(deckBase(dir, was)), existsSync(deckCache(dir, was)), existsSync(join(deckCache(dir, now), 'render'))]).toEqual([false, false, true])
    expect(new SlidesStore(db).seats(now).map((s) => s.itemId)).toEqual([item.id])
  })

  it('after an edit only the slide whose picture changed is drawn again, alone, and every other slide keeps its picture’s name', async () => {
    const drawn: string[] = []
    setSlideRenderer({
      slide: async (input, page, output) => {
        drawn.push(`slide ${page}`)
        const doc = await PDFDocument.create()
        doc.addPage([readFake(input).slides[page - 1].id, 100])
        writeFileSync(output, await doc.save())
        return readFake(input).slides.length
      },
      deck: async (input, output) => {
        drawn.push('deck')
        const doc = await PDFDocument.create()
        for (const s of readFake(input).slides) doc.addPage([s.id, 100])
        writeFileSync(output, await doc.save())
      }
    })
    const item = openDeck(fileSource(path))
    await call('work.slides.mode', { itemId: item.id, mode: 'writes' })
    const before = await call('work.slides.open', { itemId: item.id })
    // Four slides never seen: drawn one at a time by the LibreOffice kept running.
    expect(drawn).toEqual(['slide 1', 'slide 2', 'slide 3', 'slide 4'])
    expect(before.slides.every((s) => s.pic && s.pic.size > 0)).toBe(true)
    drawn.length = 0
    await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'text', slide: 257, shape: 3, paragraphs: ['New words'] }] })
    const after = await call('work.slides.open', { itemId: item.id })
    expect(drawn).toEqual(['slide 2'])
    expect(calls.filter((c) => c === 'pdf whole')).toEqual([])
    expect(after.slides.map((s, i) => s.pic!.rev === before.slides[i].pic!.rev)).toEqual([true, false, true, true])
    // The deck's PDF is those pages in order, and one slide's own picture is read by its id.
    const deck = await readAll('work.slides.read', { itemId: item.id, which: 'file' })
    expect(await pageWidths(deck.bytes)).toEqual([256, 257, 258, 259])
    const one = await readAll('work.slides.slide', { itemId: item.id, which: 'file', slide: 258 })
    expect(await pageWidths(one.bytes)).toEqual([258])
    expect(one.rev).toBe(after.slides[2].pic!.rev)
    await expect(call('work.slides.slide', { itemId: item.id, which: 'file', slide: 999, offset: 0, length: 10 })).rejects.toThrow('The deck has no slide 999.')
    await expect(call('work.slides.slide', { itemId: item.id, which: 'proposed', slide: 258, offset: 0, length: 10 })).rejects.toThrow('No changes wait on this deck.')
    const remote = { kind: 'remote', keyId: 'k1', name: 'Bot', audience: 'mcp', caps: ['read', 'operate'] } as never
    await expect(call('work.slides.slide', { itemId: item.id, which: 'file', slide: 258, offset: 0, length: 10 }, remote)).rejects.toThrow('forbidden: work.slides.slide is outside app-managed roots')
  })

  it('with no LibreOffice kept running the deck is one whole export, and a slide’s own picture is still there', async () => {
    const item = openDeck(fileSource(path))
    const view = await call('work.slides.open', { itemId: item.id })
    expect(calls.filter((c) => c === 'pdf whole')).toHaveLength(1)
    expect(view.slides.every((s) => !!s.pic)).toBe(true)
    const one = await readAll('work.slides.slide', { itemId: item.id, which: 'file', slide: 259 })
    expect(await pageWidths(one.bytes)).toEqual([259])
  })

  it('a removed thread’s waiting edits go with it, wherever the deck is', async () => {
    const item = openDeck(fileSource(path))
    await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'notes', slide: 256, text: 'x' }] })
    new SlidesStore(db).add(deckKey(item), '', [{ slide: 257, op: { op: 'notes', slide: 257, text: 'another thread’s' } }], 'agent:env_test:t9')
    slides.sessionsRemoved!(['t1'], work.ctx)
    expect(new SlidesStore(db).pending(deckKey(item)).map((p) => p.by)).toEqual(['agent:env_test:t9'])
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
    // Nothing waits: no changes revision.
    expect(view.changesRev).toBeUndefined()
  })

  it('with no picture, the changes still carry a revision, and a review on it is checked on accept and on reject alike', async () => {
    const path = join(dir, 'Show.pptx')
    writeFileSync(path, fakeBytes(FAKE_DECK))
    const item = openDeck(fileSource(path))
    await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'text', slide: 257, shape: 3, paragraphs: ['First words'] }] })
    const shownView = await call('work.slides.open', { itemId: item.id })
    expect(shownView.renderError).toBeDefined()
    expect(shownView.renders.proposed).toBeNull()
    const shown = shownView.changesRev!
    expect(shown).toMatch(/^[0-9a-f]{16}$/)
    // The agent's next edit moves the revision: the text-diff review he saw is refused, for an accept and a reject alike.
    await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'text', slide: 257, shape: 3, paragraphs: ['Second words'] }] })
    for (const verdict of ['accept', 'reject'] as const) {
      await expect(call('work.slides.review', { itemId: item.id, changes: 'all', verdict, rev: shown })).rejects.toThrow('The suggestions changed since this preview')
    }
    expect(readFake(path)).toEqual(FAKE_DECK)
    expect(new SlidesStore(db).pending(deckKey(item))).toHaveLength(2)
    // The fresh revision is taken.
    const now = (await call('work.slides.open', { itemId: item.id })).changesRev!
    expect(now).not.toBe(shown)
    expect((await call('work.slides.review', { itemId: item.id, changes: 'all', verdict: 'reject', rev: now })).changes).toEqual([])
    // A press with no rev (an older phone build) is still taken, as today.
    await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'text', slide: 257, shape: 3, paragraphs: ['Third words'] }] })
    expect((await call('work.slides.review', { itemId: item.id, changes: 'all', verdict: 'accept' })).changes).toEqual([])
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
    expect(after.changes).toEqual([expect.objectContaining({ kind: 'changed', slideId: third.id, edits: [{ where: 'Text', before: body.text, after: 'Changed' }] })])
    expect(after.slides[2]).toMatchObject({ tint: 'add', from: 'proposed', changed: [body.bbox] })
    expect(existsSync(path)).toBe(true)
    // A picture of the changed slide, from the proposed render.
    const shot = await tool('slides_image', { item: item.id, slide: 3 })
    expect(shot.isError).toBeFalsy()
    const png = Buffer.from((shot.content[0] as { data: string }).data, 'base64')
    expect(png.subarray(1, 4).toString()).toBe('PNG')
  })

  it('draws an edited slide alone with the LibreOffice kept running, and ends it when Work is turned off', { timeout: 180_000 }, async () => {
    const path = join(dir, 'Twelve.pptx')
    writeFileSync(path, await writeNewDeck({ title: 'Twelve', slides: TWELVE }))
    const item = openDeck(fileSource(path))
    const view = await call('work.slides.open', { itemId: item.id })
    expect(view.renders.file).toMatchObject({ pages: 12 })
    // The module's own resident drew it: its profile is in the pillar's folder.
    const resident = join(dir, 'work-slides', '.cache', 'resident')
    expect(existsSync(join(resident, 'profile'))).toBe(true)
    const pipes = (): string[] => readdirSync(resident).filter((f) => f.startsWith('pipe-'))
    expect(pipes()).toHaveLength(1)
    const pages = join(deckCache(dir, deckKey(item)), 'pages')
    const before = new Set(readdirSync(pages))
    expect(before.size).toBe(12)
    const third = view.slides[2]
    const body = third.shapes.find((s) => s.text.startsWith('First'))!
    const began = Date.now()
    await tool('slides_edit', { item: item.id, because: 'own', ops: [{ op: 'text', slide: third.id, shape: body.id, paragraphs: ['Changed'] }] })
    const took = Date.now() - began
    const after = (pushes.at(-1) as { view: DeckView }).view
    expect(after.renders.proposed).toMatchObject({ pages: 12 })
    // One new page: the edited slide's. Every other slide's picture is the one it had.
    expect(readdirSync(pages).filter((f) => !before.has(f))).toHaveLength(1)
    expect(after.slides.filter((s, i) => s.pic?.rev !== view.slides[i].pic?.rev).map((s) => s.number)).toEqual([3])
    console.log(`slides: an edit to its picture, 12 slides, through the module: ${took} ms`)
    // Work off: the process and its pipe go.
    await call('work.set', { enabled: false })
    await vi.waitFor(() => expect(pipes()).toEqual([]), { timeout: 15_000, interval: 100 })
  })
})

/** The listener's roots as index.ts hands them in (managedRoots): every project's checkout and workspace's folder. */
function hostFence(db: DatabaseSync): { roots(): string[]; denied(): string[] } {
  return { roots: () => (db.prepare(`SELECT cwd AS p FROM projects UNION SELECT path AS p FROM workspaces`).all() as Array<{ p: string }>).map((r) => r.p), denied: () => [] }
}
