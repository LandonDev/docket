import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientRequestSchema, type ClientRequest } from '@shared/contract'
import { SAVE_AS_IDS, type DocLink, type SavedAs } from '@shared/work/saveAs'
import type { Caller } from '../modules'
import { filesHandle as officeHandle } from '../office/files/handle'
import { setCloudDir, setCopyAllowed } from '../office/files/library'
import { closeFilesState, filesHandle } from './handle'
import { startFileAutosaves } from './autosave'
import { liveRev, wordTiming } from './word'
import type { DocRevision } from '../service/wire'
import { forgetLibraries } from './places/libraries'
import { setThreadsMayWrite } from './policy'
import { autosaveLinks, linkTiming, resetLinkState } from './saveAs'
import { approver, HOST, makeRig, phone, reader, thread, window, WS, type Rig } from './testkit'

/**
 * Save As… (saveAs.ts): a document saved as a new file in a folder he picks, linked so each later edit reaches it,
 * on two hosts (the workspace's `env_box` and his Mac `env_mac` with a dummy Teams library) joined by a stand-in of the
 * host link that runs the Mac's own handlers. The Work service stands in too: its export is the document's text as
 * it is now, and its live revision moves with each edit. Dummy files only.
 */

const doc = vi.hoisted(() => ({ text: 'one', rev: 'r1', exported: [] as unknown[] }))
vi.mock('../formats/exporter', () => ({
  EXPORT_FORMATS: ['docx', 'odt', 'rtf', 'md'],
  exportDoc: async (_ctx: unknown, _by: unknown, p: { format: string; source: unknown }) => (doc.exported.push(p.source), { name: `Plan.${p.format}`, data: Buffer.from(`${p.format} ${doc.text}`).toString('base64'), warnings: [] })
}))
vi.mock('../formats/preview', () => ({ fileDocumentPdf: async () => Buffer.from(`pdf ${doc.text}`) }))
vi.mock('./word', async (real) => ({ ...(await real<typeof import('./word')>()), liveRev: vi.fn(async () => doc.rev) }))
vi.mock('../docs/target', async (real) => ({ ...(await real<typeof import('../docs/target')>()), targetOf: async () => ({}), titleOf: () => 'Plan', lifeosRow: async () => null, madeFromShared: () => false }))

const MAC = 'env_mac'
const AS_PEER: Caller = { kind: 'remote', caps: ['read', 'operate'], peer: HOST }

let box: Rig
let mac: Rig
let far: { verb: string; args: Record<string, unknown> }[]
let macUp: boolean

beforeEach(() => {
  box = makeRig()
  mac = makeRig()
  ;(mac.ctx as { host: string }).host = MAC
  setCloudDir((host) => (host === HOST ? box.cloud : host === MAC ? mac.cloud : join(box.base, 'no-cloud')))
  forgetLibraries(box.db)
  forgetLibraries(mac.db)
  setCopyAllowed(box.db, WS, true)
  setThreadsMayWrite(true)
  resetLinkState()
  doc.text = 'one'
  doc.rev = 'r1'
  far = []
  macUp = true
  Object.assign(box.ctx, {
    peer(this: unknown, host: string) {
      return {
        async call(module: string, verb: string, args: Record<string, unknown>) {
          far.push({ verb, args })
          if (!macUp || host !== MAC) throw new Error(`host offline: ${host} has no live link to this host`)
          const req = ClientRequestSchema.parse({ id: 'peer', method: `work.${module}.${verb}`, params: args }) as ClientRequest
          const out = module === 'office' ? await officeHandle(req, mac.ctx, AS_PEER, () => null) : await filesHandle(req, mac.ctx, AS_PEER)
          if (!out.handled) throw new Error(`${req.method} is not answered there`)
          return out.result
        }
      }
    }
  })
})
afterEach(() => {
  setThreadsMayWrite(false)
  closeFilesState(box.db)
  closeFilesState(mac.db)
  mac.close()
  box.close()
})

const call = async <T>(method: string, params: Record<string, unknown>, by: Caller = window): Promise<T> => {
  const out = await filesHandle({ id: '1', method, params: { workspaceId: WS, ...params } } as never, box.ctx, by)
  return (out as { result: T }).result
}
const source = () => ({ at: 'file' as const, host: HOST, path: join(box.folder, 'Run of show.tcdoc') })
let n = 0
const op = () => `op-saveas-${++n}-0000`
const links = () => call<DocLink[]>('work.files.links', { source: source() })
/** He types, then pauses: the host's loop sees the new revision, and writes once it has held still. */
async function edit(text: string): Promise<void> {
  doc.text = text
  doc.rev = `r-${text}`
  const t = Date.now()
  await autosaveLinks(box.ctx, t)
  await autosaveLinks(box.ctx, t + linkTiming.pause + 1)
}
const save = (params: Record<string, unknown>, by?: Caller) => call<SavedAs>('work.files.saveAs', { source: source(), format: 'docx', op: op(), ...params }, by)

beforeEach(async () => void (await call('work.files.open', { ref: source() })))

describe('Save As… formats', () => {
  it('ten idle ticks read no revisions, a revision post saves once, and the 30 s sweep catches a missed post', async () => {
    await save({ at: { at: 'place', id: 'folder' } })
    const insertWord = box.db.prepare(`INSERT INTO work_files_word
      (workspace_id, host, path, name, version, doc, at, auto, base_rev) VALUES (?, ?, ?, ?, '', ?, 0, 1, ?)`)
    const insertLink = box.db.prepare(`INSERT INTO work_files_links
      SELECT ?, workspace_id, ?, format, host, ?, vm, name, place, computer, version, sha, saved_rev, saved_at, state, changed_at, detail, tried_at, made_at
      FROM work_files_links WHERE name = 'Plan.docx' AND path = ?`)
    const target = join(box.folder, 'Plan.docx')
    for (let i = 0; i < 5; i++) {
      const path = join(box.folder, `idle-${i}.tcdoc`)
      writeFileSync(path, '{}')
      insertWord.run(WS, HOST, `word-${i}.docx`, 'Idle', path, 'r1')
      insertLink.run(`link-${i}`, path, `linked-${i}.docx`, target)
    }
    const workRev = vi.fn(async () => ({ rev: 'r1' }))
    Object.assign(box.ctx, { service: { internal: workRev } })
    const linkRev = vi.mocked(liveRev)
    linkRev.mockClear()
    let post!: (notice: DocRevision) => void
    vi.useFakeTimers()
    const start = Date.now()
    const stop = startFileAutosaves(box.ctx, (receive) => (post = receive, () => {}))
    try {
      const baseline = doc.exported.length
      for (let tick = 0; tick < 10; tick++) await vi.advanceTimersByTimeAsync(1000)
      expect(workRev).not.toHaveBeenCalled()
      expect(linkRev).not.toHaveBeenCalled()
      expect(doc.exported).toHaveLength(baseline)

      doc.text = 'two'
      doc.rev = 'r2'
      post({ doc: source().path, rev: doc.rev })
      post({ doc: source().path, rev: doc.rev })
      expect((await links())[0]?.state).toBe('saving')
      await vi.advanceTimersByTimeAsync(wordTiming.pause - 1)
      expect(doc.exported).toHaveLength(baseline)
      await vi.advanceTimersByTimeAsync(1)
      await vi.waitFor(() => expect(readFileSync(target, 'utf8')).toBe('docx two'))
      expect(doc.exported).toHaveLength(baseline + 1)
      expect(workRev).not.toHaveBeenCalled()
      expect(linkRev).not.toHaveBeenCalled()

      // Leave the idle links at their saved revision so only the real link needs a write.
      linkRev.mockImplementation(async (_ctx, path) => path === source().path ? doc.rev : 'r1')
      doc.text = 'three'
      doc.rev = 'r3'
      await vi.advanceTimersByTimeAsync(start + 30_000 - Date.now())
      expect(linkRev).toHaveBeenCalledTimes(6)
      expect(workRev).toHaveBeenCalledTimes(5)
      await vi.advanceTimersByTimeAsync(wordTiming.pause)
      await vi.waitFor(() => expect(readFileSync(target, 'utf8')).toBe('docx three'))
      expect(doc.exported).toHaveLength(baseline + 2)
    } finally {
      stop()
      linkRev.mockImplementation(async () => doc.rev)
      vi.useRealTimers()
    }
  })

  it("are the exporter's own, and PDF", async () => {
    const real = await vi.importActual<typeof import('../formats/exporter')>('../formats/exporter')
    expect([...SAVE_AS_IDS].filter((f) => f !== 'pdf').sort()).toEqual([...real.EXPORT_FORMATS].sort())
  })
})

describe('Save As… into the workspace folder', () => {
  it('makes the file under his name, linked, and each edit after it reaches the file', async () => {
    const got = await save({ at: { at: 'place', id: 'folder' }, name: 'Master Plan' })
    expect(got).toMatchObject({ saved: { name: 'Master Plan.docx', linked: true } })
    const file = join(box.folder, 'Master Plan.docx')
    expect(readFileSync(file, 'utf8')).toBe('docx one')
    expect(await links()).toMatchObject([{ name: 'Master Plan.docx', format: 'docx', state: 'saved', place: 'Dummy Esports' }])
    await edit('two')
    expect(readFileSync(file, 'utf8')).toBe('docx two')
    expect((await links())[0]!.state).toBe('saved')
  })

  it('says Saving while his newest words are not in the file, and only then Saved', async () => {
    await save({ at: { at: 'place', id: 'folder' } })
    doc.text = 'two'
    doc.rev = 'r-two'
    await autosaveLinks(box.ctx, Date.now())
    expect((await links())[0]!.state).toBe('saving')
    expect(readFileSync(join(box.folder, 'Plan.docx'), 'utf8')).toBe('docx one')
  })

  it('rewrites a linked PDF whole, and a second link of the same document too', async () => {
    await save({ at: { at: 'place', id: 'folder' }, format: 'pdf' })
    await save({ at: { at: 'file', host: HOST, path: join(box.team, 'General') }, format: 'md', place: 'General' })
    expect((await links()).map((l) => `${l.name} ${l.state}`)).toEqual(['Plan.pdf saved', 'Plan.md saved'])
    await edit('two')
    expect(readFileSync(join(box.folder, 'Plan.pdf'), 'utf8')).toBe('pdf two')
    expect(readFileSync(join(box.team, 'General', 'Plan.md'), 'utf8')).toBe('md two')
  })

  it('Just a copy makes the file once and links nothing', async () => {
    expect(await save({ at: { at: 'place', id: 'folder' }, link: false })).toMatchObject({ saved: { name: 'Plan.docx', linked: false } })
    expect(await links()).toEqual([])
    await edit('two')
    expect(readFileSync(join(box.folder, 'Plan.docx'), 'utf8')).toBe('docx one')
  })
})

describe("a mail's attachment read as a document", () => {
  it('is saved as by its own source: the host exports the document its open item read it into', async () => {
    const MAIL = { at: 'mail' as const, threadId: 'mt1', messageId: 'mm1', partId: '2', name: 'Brief.docx' }
    const item = box.ctx.canvas.open('t1', 'document', MAIL, 'Brief.docx')
    doc.exported.length = 0
    const got = await call<SavedAs>('work.files.saveAs', { source: MAIL, format: 'docx', op: op(), at: { at: 'place', id: 'folder' }, link: false })
    expect(got).toMatchObject({ saved: { name: 'Plan.docx' } })
    const { attachmentDocPathOf } = await vi.importActual<typeof import('../docs/target')>('../docs/target')
    expect(doc.exported).toEqual([{ at: 'file', host: HOST, path: attachmentDocPathOf(box.ctx.dataDir, item) }])
    // One no item of the workspace shows is refused, as any document not open here is.
    await expect(call('work.files.saveAs', { source: { ...MAIL, partId: '3' }, format: 'docx', op: op(), at: { at: 'place', id: 'folder' } })).rejects.toThrow()
  })
})

describe('a file of that name is there', () => {
  const general = () => join(box.team, 'General')
  it('answers so and writes nothing; Keep Both saves beside it, Replace over it by the version read now', async () => {
    const at = { at: 'file', host: HOST, path: general() }
    expect(await save({ at })).toEqual({ exists: { name: 'Plan.docx' } })
    expect(readFileSync(join(general(), 'Plan.docx'), 'utf8')).toBe('word')
    expect(await save({ at, exists: 'keep' })).toMatchObject({ saved: { name: 'Plan 2.docx' } })
    expect(readFileSync(join(general(), 'Plan.docx'), 'utf8')).toBe('word')
    expect(await save({ at, exists: 'replace' })).toMatchObject({ saved: { name: 'Plan.docx', linked: true } })
    expect(readFileSync(join(general(), 'Plan.docx'), 'utf8')).toBe('docx one')
  })
})

describe('a linked file someone changed there', () => {
  it('stops the writes until his press: Replace writes over it, Unlink leaves it as it is', async () => {
    await save({ at: { at: 'place', id: 'folder' } })
    const file = join(box.folder, 'Plan.docx')
    writeFileSync(file, 'a colleague saved')
    await edit('two')
    expect(readFileSync(file, 'utf8')).toBe('a colleague saved')
    const [l] = await links()
    expect(l).toMatchObject({ state: 'changed' })
    // Nothing more is tried on its own.
    await edit('three')
    expect(readFileSync(file, 'utf8')).toBe('a colleague saved')
    await call('work.files.linkAct', { id: l!.id, act: 'replace' })
    expect(readFileSync(file, 'utf8')).toBe('docx three')
    await call('work.files.linkAct', { id: l!.id, act: 'unlink' })
    await edit('four')
    expect(readFileSync(file, 'utf8')).toBe('docx three')
    expect(await links()).toEqual([])
  })

  it('Keep Both saves the document beside the changed file and links that one', async () => {
    await save({ at: { at: 'place', id: 'folder' } })
    writeFileSync(join(box.folder, 'Plan.docx'), 'a colleague saved')
    await edit('two')
    const [l] = await links()
    const after = await call<DocLink[]>('work.files.linkAct', { id: l!.id, act: 'keep' })
    expect(after).toMatchObject([{ name: 'Plan 2.docx', state: 'saved' }])
    expect(readFileSync(join(box.folder, 'Plan 2.docx'), 'utf8')).toBe('docx two')
    expect(readFileSync(join(box.folder, 'Plan.docx'), 'utf8')).toBe('a colleague saved')
  })

  it('a file deleted there is said, and never made again on its own', async () => {
    await save({ at: { at: 'place', id: 'folder' } })
    const file = join(box.folder, 'Plan.docx')
    const { rmSync } = await import('node:fs')
    rmSync(file)
    await edit('two')
    expect((await links())[0]!.state).toBe('gone')
    expect(existsSync(file)).toBe(false)
  })
})

describe('a library on his Mac', () => {
  const general = () => join(mac.team, 'General')
  it("is made and written again by the Mac's own door; while the Mac is away the document waits, then is written", async () => {
    const got = await save({ at: { at: 'file', host: MAC, path: general() }, name: 'Budget', place: 'General', computer: 'MacBook' })
    expect(got).toMatchObject({ saved: { name: 'Budget.docx', linked: true } })
    expect(far.map((c) => c.verb)).toEqual(['stat', 'writeBack'])
    expect(readFileSync(join(general(), 'Budget.docx'), 'utf8')).toBe('docx one')
    macUp = false
    await edit('two')
    expect(await links()).toMatchObject([{ state: 'waiting', place: 'General', computer: 'MacBook' }])
    macUp = true
    const later = Date.now() + linkTiming.retry + linkTiming.pause + 10
    await autosaveLinks(box.ctx, later)
    expect(readFileSync(join(general(), 'Budget.docx'), 'utf8')).toBe('docx two')
    expect((await links())[0]!.state).toBe('saved')
  })
})

describe('who may save as', () => {
  it('refuses a thread, a read key, and a key that may not approve where others can open the folder', async () => {
    const here = { at: 'file', host: HOST, path: join(box.team, 'General') }
    await expect(save({ at: here, exists: 'keep' }, thread('t1'))).rejects.toThrow('files_* tools')
    await expect(save({ at: { at: 'place', id: 'folder' } }, reader)).rejects.toThrow('This key may not change files.')
    box.roots.push(box.team)
    await expect(save({ at: here, exists: 'keep' }, phone)).rejects.toThrow('this key may not change it')
    expect(await links()).toEqual([])
    // A key that may approve is his own hand, and links.
    expect(await save({ at: here, exists: 'keep' }, approver)).toMatchObject({ saved: { linked: true } })
    const [l] = await links()
    await expect(call('work.files.linkAct', { id: l!.id, act: 'unlink' }, thread('t1'))).rejects.toThrow('files_* tools')
  })
})
