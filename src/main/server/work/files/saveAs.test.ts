import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientRequestSchema, type ClientRequest } from '@shared/contract'
import { SAVE_AS_IDS, type DocLink, type SavedAs } from '@shared/work/saveAs'
import type { Caller } from '../modules'
import { filesHandle as officeHandle } from '../office/files/handle'
import { setCloudDir, setCopyAllowed } from '../office/files/library'
import { closeFilesState, filesHandle, filesState } from './handle'
import { startFileAutosaves } from './autosave'
import { liveRev, wordTiming } from './word'
import type { DocRevision } from '../service/wire'
import { forgetLibraries } from './places/libraries'
import { NOT_REACHED, NotReachable, setThreadsMayWrite } from './policy'
import { AGENT_JUST_WROTE, autosaveLinks, linkTiming, resetLinkState } from './saveAs'
import { linkedOut, privateWrite } from '../docs/target'
import { approver, HOST, makeRig, phone, reader, thread, window, WS, type Rig } from './testkit'

/**
 * Save As… (saveAs.ts): a document saved as a new file in a folder he picks, linked so each later edit reaches it,
 * on two hosts (the workspace's `env_box` and his Mac `env_mac` with a dummy Teams library) joined by a stand-in of the
 * host link that runs the Mac's own handlers. The Work service stands in too: its export is the document's text as
 * it is now, and its live revision moves with each edit. Dummy files only.
 */

const doc = vi.hoisted(() => ({ text: 'one', rev: 'r1', exported: [] as unknown[], gate: null as Promise<void> | null }))
vi.mock('../formats/exporter', () => ({
  EXPORT_FORMATS: ['docx', 'odt', 'rtf', 'md'],
  exportDoc: async (_ctx: unknown, _by: unknown, p: { format: string; source: unknown }) => {
    // The next export, held until a test lets it go: its words are those he had when it started.
    const text = doc.text
    const gate = doc.gate
    doc.gate = null
    if (gate) await gate
    return (doc.exported.push(p.source), { name: `Plan.${p.format}`, data: Buffer.from(`${p.format} ${text}`).toString('base64'), warnings: [] })
  }
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
/** run on the Mac before it answers a writeBack: someone there makes a file meanwhile */
let beforeWrite: (() => void) | null
/** the Mac's next writeBack answer is lost on the way back, after it was done there */
let loseAnswer: boolean
/** the Mac is online and answers each writeBack with this sentence, as its door says it over the link */
let farSays: string | null

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
  doc.gate = null
  far = []
  macUp = true
  beforeWrite = null
  loseAnswer = false
  farSays = null
  Object.assign(box.ctx, {
    peer(this: unknown, host: string) {
      return {
        async call(module: string, verb: string, args: Record<string, unknown>) {
          far.push({ verb, args })
          if (!macUp || host !== MAC) throw new Error(`host offline: ${host} has no live link to this host`)
          if (verb === 'writeBack') beforeWrite?.()
          if (verb === 'writeBack' && farSays) throw new Error(farSays)
          const req = ClientRequestSchema.parse({ id: 'peer', method: `work.${module}.${verb}`, params: args }) as ClientRequest
          const out = module === 'office' ? await officeHandle(req, mac.ctx, AS_PEER, () => null) : await filesHandle(req, mac.ctx, AS_PEER)
          if (!out.handled) throw new Error(`${req.method} is not answered there`)
          if (verb === 'writeBack' && loseAnswer) {
            loseAnswer = false
            throw new Error('The request timed out.')
          }
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
      SELECT ?, workspace_id, ?, format, host, ?, vm, name, place, computer, version, sha, saved_rev, saved_at, state, changed_at, detail, tried_at, made_at, seen_version, tried_sha
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
    const asked = await save({ at })
    expect(asked).toEqual({ exists: { name: 'Plan.docx', version: expect.any(String) } })
    expect(readFileSync(join(general(), 'Plan.docx'), 'utf8')).toBe('word')
    expect(await save({ at, exists: 'keep' })).toMatchObject({ saved: { name: 'Plan 2.docx' } })
    expect(readFileSync(join(general(), 'Plan.docx'), 'utf8')).toBe('word')
    const version = 'exists' in asked ? asked.exists.version : undefined
    expect(await save({ at, exists: 'replace', version })).toMatchObject({ saved: { name: 'Plan.docx', linked: true } })
    expect(readFileSync(join(general(), 'Plan.docx'), 'utf8')).toBe('docx one')
  })
})

describe('Replace, bound to the version he saw', () => {
  const general = () => join(box.team, 'General')
  it('the first Save As: a colleague who saves while the question is up keeps his file, and the question comes again with his version', async () => {
    const at = { at: 'file', host: HOST, path: general() }
    const path = join(general(), 'Plan.docx')
    const asked = await save({ at })
    if (!('exists' in asked)) throw new Error('no question')
    writeFileSync(path, 'newer colleague edit after the question')
    const again = await save({ at, exists: 'replace', version: asked.exists.version })
    expect(readFileSync(path, 'utf8')).toBe('newer colleague edit after the question')
    expect(again).toEqual({ exists: { name: 'Plan.docx', version: expect.any(String) } })
    expect('exists' in again && again.exists.version).not.toBe(asked.exists.version)
    // A window that names no version is asked again, never written over (the audit's scratch case).
    expect(await save({ at, exists: 'replace' })).toMatchObject({ exists: { name: 'Plan.docx' } })
    expect(readFileSync(path, 'utf8')).toBe('newer colleague edit after the question')
    // His Replace of what he was shown now goes over it.
    expect(await save({ at, exists: 'replace', version: 'exists' in again ? again.exists.version : '' })).toMatchObject({ saved: { name: 'Plan.docx' } })
    expect(readFileSync(path, 'utf8')).toBe('docx one')
  })

  it('a link: a change made there after the one he was shown is shown instead of written over', async () => {
    await save({ at: { at: 'place', id: 'folder' } })
    const file = join(box.folder, 'Plan.docx')
    writeFileSync(file, 'a colleague saved')
    await edit('two')
    const [l] = await links()
    writeFileSync(file, 'a colleague saved again')
    const after = await call<DocLink[]>('work.files.linkAct', { id: l!.id, act: 'replace', version: l!.version })
    expect(readFileSync(file, 'utf8')).toBe('a colleague saved again')
    expect(after[0]).toMatchObject({ state: 'changed' })
    expect(after[0]!.version).not.toBe(l!.version)
    expect(await call<DocLink[]>('work.files.linkAct', { id: l!.id, act: 'replace' })).toMatchObject([{ state: 'changed' }])
    expect(readFileSync(file, 'utf8')).toBe('a colleague saved again')
    await call('work.files.linkAct', { id: l!.id, act: 'replace', version: after[0]!.version })
    expect(readFileSync(file, 'utf8')).toBe('docx two')
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
    expect(l!.version).toEqual(expect.any(String))
    await call('work.files.linkAct', { id: l!.id, act: 'replace', version: l!.version })
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

  it("with the Mac online and its mapped drive gone for one save, the document waits and is written once, when the drive is back", async () => {
    await save({ at: { at: 'file', host: MAC, path: general() }, name: 'Budget', place: 'General', computer: 'MacBook' })
    farSays = new NotReachable('J:').message
    await edit('two')
    expect(await links()).toMatchObject([{ state: 'waiting' }])
    farSays = null
    const writes = far.filter((c) => c.verb === 'writeBack').length
    const later = Date.now() + linkTiming.retry + linkTiming.pause + 10
    await autosaveLinks(box.ctx, later)
    await autosaveLinks(box.ctx, later + linkTiming.retry + linkTiming.pause + 10)
    expect(far.filter((c) => c.verb === 'writeBack').length).toBe(writes + 1)
    expect(readFileSync(join(general(), 'Budget.docx'), 'utf8')).toBe('docx two')
    expect((await links())[0]!.state).toBe('saved')
  })

  it('a policy refusal there stays a refusal: said in its words, nothing written, never sent again on its own', async () => {
    await save({ at: { at: 'file', host: MAC, path: general() }, name: 'Budget', place: 'General', computer: 'MacBook' })
    farSays = NOT_REACHED
    await edit('two')
    expect(await links()).toMatchObject([{ state: 'refused', detail: NOT_REACHED }])
    const writes = far.filter((c) => c.verb === 'writeBack').length
    farSays = null
    await autosaveLinks(box.ctx, Date.now() + linkTiming.retry + linkTiming.pause + 10)
    expect(far.filter((c) => c.verb === 'writeBack').length).toBe(writes)
    expect(readFileSync(join(general(), 'Budget.docx'), 'utf8')).toBe('docx one')
  })
})

describe('a file made but not found again at once', () => {
  const general = () => join(mac.team, 'General')
  /** The holder's look at the new file fails once, as a sync folder's fresh file can (audit, J23 B1). */
  const missOnce = (rig: Rig, name: string, how: 'throw' | 'none'): void => {
    const lister = filesState(rig.ctx).lister
    const row = lister.row.bind(lister)
    let missed = false
    lister.row = async (path: string) => {
      if (!missed && path.endsWith(name)) {
        missed = true
        if (how === 'throw') throw new Error(`${name} is not there any more.`)
        return null
      }
      return row(path)
    }
  }
  const budgets = (dir: string) => readdirSync(dir).filter((n) => /^Budget( \d+)?\.docx$/.test(n))

  it("on his Mac is the file the Mac made: the answer is its receipt, never a false Not saved", async () => {
    missOnce(mac, 'Budget.docx', 'throw')
    const got = await save({ at: { at: 'file', host: MAC, path: general() }, name: 'Budget', place: 'General', computer: 'MacBook' })
    expect(got).toMatchObject({ saved: { name: 'Budget.docx', linked: true } })
    expect(budgets(general())).toEqual(['Budget.docx'])
    expect(await links()).toMatchObject([{ name: 'Budget.docx', state: 'saved' }])
  })

  it('here is the file this host made', async () => {
    missOnce(box, 'Budget.docx', 'none')
    expect(await save({ at: { at: 'file', host: HOST, path: join(box.team, 'General') }, name: 'Budget', place: 'General' })).toMatchObject({ saved: { name: 'Budget.docx' } })
    expect(budgets(join(box.team, 'General'))).toEqual(['Budget.docx'])
  })

  it('a lost answer sent again under the same press is the same file, never a silent "Budget 2"', async () => {
    const id = op()
    const params = { at: { at: 'file', host: MAC, path: general() }, name: 'Budget', place: 'General', computer: 'MacBook', op: id }
    loseAnswer = true
    await expect(save(params)).rejects.toThrow(/timed out/)
    expect(budgets(general())).toEqual(['Budget.docx'])
    expect(await save(params)).toMatchObject({ saved: { name: 'Budget.docx', linked: true } })
    expect(budgets(general())).toEqual(['Budget.docx'])
    expect(await links()).toHaveLength(1)
    // A new press is his own choice again: the file is there, so he is asked.
    expect(await save({ ...params, op: op() })).toMatchObject({ exists: { name: 'Budget.docx' } })
  })
})

describe("a linked file's write whose answer was lost", () => {
  const general = () => join(mac.team, 'General')
  it('is known as the link\'s own on the next write: newer words go over it, a colleague\'s save still stops it', async () => {
    await save({ at: { at: 'file', host: MAC, path: general() }, name: 'Budget', place: 'General', computer: 'MacBook' })
    const file = join(general(), 'Budget.docx')
    loseAnswer = true
    await edit('two')
    expect(readFileSync(file, 'utf8')).toBe('docx two')
    expect(await links()).toMatchObject([{ state: 'waiting' }])
    // He typed on; the link is tried again and writes over its own write, never calling it a change made there.
    doc.text = 'three'
    doc.rev = 'r-three'
    const later = Date.now() + linkTiming.retry + linkTiming.pause + 10
    await autosaveLinks(box.ctx, later)
    await autosaveLinks(box.ctx, later + linkTiming.pause + 1)
    expect(readFileSync(file, 'utf8')).toBe('docx three')
    expect(await links()).toMatchObject([{ state: 'saved' }])
    // A colleague's bytes there are still a change made there.
    writeFileSync(file, 'a colleague saved')
    await edit('four')
    expect(readFileSync(file, 'utf8')).toBe('a colleague saved')
    expect(await links()).toMatchObject([{ state: 'changed' }])
  })
})

describe('a target on his Mac', () => {
  const general = () => join(mac.team, 'General')
  it('is asked whether it is there and its version by one byte, never pulled whole, before Replace writes over it by that version', async () => {
    writeFileSync(join(general(), 'Budget.docx'), 'x'.repeat(3 * 1024 * 1024))
    far.length = 0
    expect(await save({ at: { at: 'file', host: MAC, path: general() }, name: 'Budget', place: 'General', computer: 'MacBook' })).toMatchObject({ exists: { name: 'Budget.docx' } })
    const reads = far.filter((c) => c.verb === 'filesRead')
    expect(reads.map((c) => c.args.length)).toEqual([1])
    expect(readFileSync(join(general(), 'Budget.docx'), 'utf8')).toHaveLength(3 * 1024 * 1024)
  })

  it('leaves a file made there meanwhile as it is: the document is made beside it, never over it', async () => {
    beforeWrite = () => {
      beforeWrite = null
      writeFileSync(join(general(), 'Budget.docx'), 'made there meanwhile')
    }
    const got = await save({ at: { at: 'file', host: MAC, path: general() }, name: 'Budget', place: 'General', computer: 'MacBook' })
    expect(readFileSync(join(general(), 'Budget.docx'), 'utf8')).toBe('made there meanwhile')
    expect(got).not.toMatchObject({ saved: { name: 'Budget.docx' } })
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

describe("the hold's race: an agent's write on its way as he links the document", () => {
  const flush = () => new Promise((r) => setTimeout(r, 20))
  it('is waited for; one that wrote straight in never reaches the file before he has looked, and his next press links', async () => {
    // The agent's verdict was read while the document was private; its write lands after his press.
    const w = privateWrite(source().path)
    const saving = save({ at: { at: 'file', host: HOST, path: join(box.team, 'General') }, name: 'Budget', place: 'General' })
    await flush()
    // The document counts linked from his press: a verdict read now only suggests, and nothing is exported yet.
    expect(linkedOut(box.ctx, source().path)).toBe(true)
    const exported = doc.exported.length
    doc.text = 'agent words'
    doc.rev = 'r-agent'
    w.end(true)
    await expect(saving).rejects.toThrow(AGENT_JUST_WROTE)
    expect(doc.exported).toHaveLength(exported)
    expect(existsSync(join(box.team, 'General', 'Budget.docx'))).toBe(false)
    expect(await links()).toEqual([])
    expect(linkedOut(box.ctx, source().path)).toBe(false)
    // He has seen it: his next press saves and links what is on screen.
    expect(await save({ at: { at: 'file', host: HOST, path: join(box.team, 'General') }, name: 'Budget', place: 'General' })).toMatchObject({ saved: { name: 'Budget.docx', linked: true } })
  })

  it('one that only suggested holds nothing back, and his own words save as ever', async () => {
    const w = privateWrite(source().path)
    const saving = save({ at: { at: 'place', id: 'folder' } })
    await flush()
    doc.text = 'his words'
    doc.rev = 'r-his'
    w.end(false)
    expect(await saving).toMatchObject({ saved: { name: 'Plan.docx', linked: true } })
    expect(readFileSync(join(box.folder, 'Plan.docx'), 'utf8')).toBe('docx his words')
    await edit('more of his words')
    expect(readFileSync(join(box.folder, 'Plan.docx'), 'utf8')).toBe('docx more of his words')
  })
})

describe("a link's presses and writes, one at a time (audit A5)", () => {
  const held = () => {
    let open!: () => void
    doc.gate = new Promise<void>((ok) => (open = ok))
    return () => open()
  }
  const tick = () => new Promise((ok) => setTimeout(ok, 20))

  it('Keep Both marks the revision its export was made of: words typed as it read are written next, never said saved', async () => {
    await save({ at: { at: 'place', id: 'folder' } })
    writeFileSync(join(box.folder, 'Plan.docx'), 'a colleague saved')
    await edit('two')
    const [l] = await links()
    // He types as the press reads the revision: the export holds those words, and the link says so.
    vi.mocked(liveRev).mockImplementationOnce(async () => {
      doc.text = 'three'
      doc.rev = 'r-three'
      return doc.rev
    })
    await call<DocLink[]>('work.files.linkAct', { id: l!.id, act: 'keep' })
    await autosaveLinks(box.ctx, Date.now())
    const now = { state: (await links())[0]!.state, text: readFileSync(join(box.folder, 'Plan 2.docx'), 'utf8') }
    expect(now).not.toEqual({ state: 'saved', text: 'docx two' })
    expect(now.text === 'docx three' || now.state === 'saving').toBe(true)
  })

  it('Unlink waits for a write under way, which lands; nothing is written after', async () => {
    await save({ at: { at: 'place', id: 'folder' } })
    const [l] = await links()
    doc.text = 'two'
    doc.rev = 'r-two'
    const t = Date.now()
    await autosaveLinks(box.ctx, t)
    const go = held()
    const writing = autosaveLinks(box.ctx, t + linkTiming.pause + 1)
    await tick()
    let unlinked = false
    const unlinking = call('work.files.linkAct', { id: l!.id, act: 'unlink' }).then(() => (unlinked = true))
    await tick()
    expect(unlinked).toBe(false)
    go()
    await Promise.all([writing, unlinking])
    expect(readFileSync(join(box.folder, 'Plan.docx'), 'utf8')).toBe('docx two')
    expect(await links()).toEqual([])
    await edit('three')
    expect(readFileSync(join(box.folder, 'Plan.docx'), 'utf8')).toBe('docx two')
  })

  it('Keep Both waits for a write under way: the older write never lands its receipt on the file Keep Both made', async () => {
    await save({ at: { at: 'place', id: 'folder' } })
    const [l] = await links()
    doc.text = 'two'
    doc.rev = 'r-two'
    const t = Date.now()
    await autosaveLinks(box.ctx, t)
    const go = held()
    const writing = autosaveLinks(box.ctx, t + linkTiming.pause + 1)
    await tick()
    // He typed on: Keep Both's file holds newer words than the write under way.
    doc.text = 'two, kept'
    doc.rev = 'r-kept'
    const keeping = call<DocLink[]>('work.files.linkAct', { id: l!.id, act: 'keep' })
    await tick()
    go()
    await Promise.all([writing, keeping])
    expect(await links()).toMatchObject([{ name: 'Plan 2.docx' }])
    await edit('three')
    expect(readFileSync(join(box.folder, 'Plan 2.docx'), 'utf8')).toBe('docx three')
    expect(readFileSync(join(box.folder, 'Plan.docx'), 'utf8')).toBe('docx two')
    expect(await links()).toMatchObject([{ name: 'Plan 2.docx', state: 'saved' }])
  })

  it('one link a document and a file: Save As to the same file again takes its link, never a second writer', async () => {
    await save({ at: { at: 'place', id: 'folder' } })
    const asked = await save({ at: { at: 'place', id: 'folder' } })
    if (!('exists' in asked)) throw new Error('no question')
    expect(await save({ at: { at: 'place', id: 'folder' }, exists: 'replace', version: asked.exists.version })).toMatchObject({ saved: { name: 'Plan.docx', linked: true } })
    expect(await links()).toHaveLength(1)
    await edit('two')
    expect(readFileSync(join(box.folder, 'Plan.docx'), 'utf8')).toBe('docx two')
    expect(await links()).toMatchObject([{ state: 'saved' }])
  })
})

