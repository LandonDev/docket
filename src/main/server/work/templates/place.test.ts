import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClientRequest } from '@shared/contract'
import { handled } from '@shared/work'
import type { WorkModule } from '../modules'
import { askFilesVerb, copyNoReplace, OUT_OF_REACH, OWN_FOLDER_ONLY, ownTarget, placeFile, type PlaceAsk } from './place'
import { workspaceOf } from './shelf'
import { HOST, makeRig, phone, thread, window, WS, type Rig } from './testkit'

let rig: Rig
let scratch: string
beforeEach(() => {
  rig = makeRig()
  scratch = rig.put(join(rig.dataDir, 'work-templates', 'scratch', 'x', 'template.docx'), 'filled')
})
afterEach(() => rig.close())

const ask = (over: Partial<PlaceAsk> = {}): PlaceAsk => ({ workspace: workspaceOf(rig.ctx, WS), kind: 'document', form: 'docx', title: 'Game report - Central at North', scratch, ...over })

/** A Files that cannot make a file yet, as master's answers today. */
const filesNotYet = (seen: ClientRequest[] = []): WorkModule => ({
  id: 'files',
  ensure() {},
  async handle(req) {
    seen.push(req)
    throw new Error('Files cannot make a file yet: that arrives with its milestone.')
  }
})
/** A Files that makes the file, as F2's will. */
const filesMakes = (seen: ClientRequest[] = []): WorkModule => ({
  id: 'files',
  ensure() {},
  async handle(req) {
    seen.push(req)
    const p = (req as { params: { name: string } }).params
    return handled({ entries: [{ key: 'k', ref: { at: 'file', host: HOST, path: join(rig.folder, 'Reports', `${p.name} 2.tcdoc`) }, folder: null, name: `${p.name} 2.tcdoc`, kind: 'document' }], refused: [], op: 'op' })
  }
})

describe('asking Files first', () => {
  it("hands Files the filled scratch file, the folder, the kind and the name, and answers what Files made", async () => {
    const seen: ClientRequest[] = []
    const into = { at: 'file' as const, host: HOST, path: join(rig.folder, 'Reports') }
    const placed = await placeFile(rig.ctx, window, ask({ into }), () => [filesMakes(seen)])
    expect(placed).toEqual({ source: { at: 'file', host: HOST, path: join(rig.folder, 'Reports', 'Game report - Central at North 2.tcdoc') }, title: 'Game report - Central at North 2' })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.method).toBe('work.files.make')
    expect((seen[0] as { params: Record<string, unknown> }).params).toMatchObject({ workspaceId: WS, at: into, kind: 'document', name: 'Game report - Central at North', from: { at: 'file', host: HOST, path: scratch } })
    expect(typeof (seen[0] as { params: { op: string } }).params.op).toBe('string')
    // Files wrote it: this pillar copied nothing.
    expect(readdirSync(rig.folder)).toEqual([])
  })

  it("names the workspace's own folder when the caller gave none", async () => {
    const seen: ClientRequest[] = []
    await placeFile(rig.ctx, window, ask(), () => [filesMakes(seen)])
    expect((seen[0] as { params: { at: unknown } }).params.at).toEqual({ at: 'place', id: 'folder' })
  })

  it('copies the file itself when Files cannot make one yet, or is not loaded', async () => {
    const a = await placeFile(rig.ctx, window, ask(), () => [filesNotYet()])
    expect(a).toEqual({ source: { at: 'file', host: HOST, path: join(rig.folder, 'Game report - Central at North.docx') }, title: 'Game report - Central at North' })
    const b = await placeFile(rig.ctx, window, ask(), () => [])
    expect(b.title).toBe('Game report - Central at North 2')
    expect(readFileSync(b.source.at === 'file' ? b.source.path : '', 'utf8')).toBe('filled')
  })

  it("throws any other refusal of Files' as it is, and copies nothing", async () => {
    const refuses: WorkModule = { id: 'files', ensure() {}, handle: async () => Promise.reject(new Error('Others can open that place: the window asks before this change.')) }
    await expect(placeFile(rig.ctx, window, ask(), () => [refuses])).rejects.toThrow('Others can open that place')
    expect(readdirSync(rig.folder)).toEqual([])
  })

  it("says Files' own words when Files made nothing", async () => {
    const none: WorkModule = { id: 'files', ensure() {}, handle: async () => handled({ entries: [], refused: [{ name: 'x', text: 'That folder is read only.' }], op: 'op' }) }
    await expect(placeFile(rig.ctx, window, ask(), () => [none])).rejects.toThrow('That folder is read only.')
  })

  it("never asks Files for a thread: a thread's make is a copy into the workspace's own folder", async () => {
    const seen: ClientRequest[] = []
    const placed = await placeFile(rig.ctx, thread(), ask(), () => [filesMakes(seen)])
    expect(seen).toEqual([])
    expect(placed.source).toEqual({ at: 'file', host: HOST, path: join(rig.folder, 'Game report - Central at North.docx') })
  })

  it('reads a verb Files has not built as not yet, whatever the verb', async () => {
    const notYet: WorkModule = { id: 'files', ensure() {}, handle: async () => Promise.reject(new Error('Files cannot trash yet: that arrives with its milestone.')) }
    expect(await askFilesVerb(rig.ctx, window, 'trash', { workspaceId: WS, refs: [] }, () => [notYet])).toBeNull()
  })
})

describe("the copy into the workspace's own folder", () => {
  const none = () => []

  it('never replaces a file: the next free name is taken', async () => {
    rig.put(join(rig.folder, 'Memo.docx'), 'his')
    rig.put(join(rig.folder, 'Memo 2.docx'), 'his too')
    const placed = await placeFile(rig.ctx, window, ask({ title: 'Memo' }), none)
    expect(placed.title).toBe('Memo 3')
    expect(readFileSync(join(rig.folder, 'Memo.docx'), 'utf8')).toBe('his')
    expect(readdirSync(rig.folder).sort()).toEqual(['Memo 2.docx', 'Memo 3.docx', 'Memo.docx'])
  })

  it('takes a folder inside the workspace\'s folder and makes it if missing', async () => {
    const into = { at: 'file' as const, host: HOST, path: join(rig.folder, 'Invoices', '2026') }
    const placed = await placeFile(rig.ctx, window, ask({ into, title: 'Invoice - Acme', form: 'xlsx', kind: 'sheet' }), none)
    expect(placed.source).toEqual({ at: 'file', host: HOST, path: join(rig.folder, 'Invoices', '2026', 'Invoice - Acme.xlsx') })
    expect(existsSync(join(rig.folder, 'Invoices', '2026', 'Invoice - Acme.xlsx'))).toBe(true)
  })

  it('refuses, in one sentence, a folder outside the workspace\'s own: another workspace\'s, one reached by dots or by a link, a library, another host', async () => {
    const ws = workspaceOf(rig.ctx, WS)
    mkdirSync(join(rig.folder, 'Sub'))
    symlinkSync(rig.outside, join(rig.folder, 'Sub', 'way-out'))
    for (const into of [
      { at: 'file' as const, host: HOST, path: rig.otherFolder },
      { at: 'file' as const, host: HOST, path: join(rig.folder, '..', 'No Sector') },
      { at: 'file' as const, host: HOST, path: join(rig.folder, 'Sub', 'way-out', 'deep') },
      { at: 'file' as const, host: 'env_mac', path: rig.folder },
      { at: 'place' as const, id: 'env_box~abc' },
      { at: 'drive' as const, account: 'sam@dummy.test', folderId: 'f1' }
    ]) {
      expect(() => ownTarget(rig.ctx, ws, into), JSON.stringify(into)).toThrow(OWN_FOLDER_ONLY)
      await expect(placeFile(rig.ctx, window, ask({ into }), none)).rejects.toThrow(OWN_FOLDER_ONLY)
    }
    expect(readdirSync(rig.outside)).toEqual([])
    expect(readdirSync(rig.otherFolder)).toEqual([])
  })

  it('refuses a remote key that may not reach the folder', async () => {
    rig.roots = [rig.otherFolder]
    await expect(placeFile(rig.ctx, phone, ask(), none)).rejects.toThrow(OUT_OF_REACH)
    rig.roots = [rig.folder]
    expect((await placeFile(rig.ctx, phone, ask(), none)).title).toBe('Game report - Central at North')
  })

  it('leaves no half-written or hidden file behind', async () => {
    await placeFile(rig.ctx, window, ask({ title: 'A' }), none)
    await expect(copyNoReplace(join(rig.base, 'missing.docx'), rig.folder, 'B.docx')).rejects.toThrow()
    expect(readdirSync(rig.folder)).toEqual(['A.docx'])
  })
})
