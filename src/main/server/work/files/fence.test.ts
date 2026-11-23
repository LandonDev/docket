import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClientRequestSchema } from '@shared/contract'
import type { FileDone, FilesListing, FilesOpened, FilesPlaces, FilesTabs } from '@shared/contract-work-files'
import type { FileEntry } from '@shared/work/files'
import { FenceError, fenceRequest, guestPath } from '../../remote/fence'
import type { Caller } from '../modules'
import { closeFilesState, THREADS_BY_TOOLS } from './handle'
import { files } from './index'
import { ASK_FIRST, NEEDS_APPROVE, PEER_LIBRARIES, PEER_NO_ORIGIN, setThreadsMayWrite, THREAD_ELSEWHERE, THREADS_NOT_YET } from './policy'
import { approver, at, makeRig, peer, phone, reader, thread, window, WS, type Rig } from './testkit'

/**
 * The fence by caller (docs/agents/work-files.md "The fence, by caller"), proven with raw requests through the
 * module: what each caller may list, what an answer to a remote key is cut to, and that the door stands in
 * front of every verb before any verb is built.
 */

let rig: Rig
beforeEach(() => {
  rig = makeRig()
})
afterEach(() => {
  setThreadsMayWrite(false)
  closeFilesState(rig.db)
  rig.close()
})

async function call<T>(method: string, params: Record<string, unknown>, by: Caller = window): Promise<T> {
  const req = ClientRequestSchema.parse({ id: '1', method, params: { workspaceId: WS, ...params } })
  const out = await files.handle!(req, rig.ctx, by)
  if (!out.handled) throw new Error(`${method} was not handled`)
  return out.result as T
}
const names = (l: { entries: (FileEntry | null)[] }): string[] => l.entries.map((e) => e?.name ?? '(none)')
const OP = 'op-12345678'

describe('a remote key', () => {
  it("lists the workspace's folder, and nothing of a library outside its roots", async () => {
    expect(names(await call<FilesListing>('work.files.list', { at: { at: 'place', id: 'folder' } }, phone))).toEqual(['Events', 'Budget.xlsx', 'notes.txt', 'Run of show.tcdoc'])
    await expect(call('work.files.list', { at: at(join(rig.team, 'General')) }, phone)).rejects.toThrow(FenceError)
    await expect(call('work.files.fetch', { ref: at(join(rig.team, 'General', 'Plan.docx')) }, phone)).rejects.toThrow(FenceError)
    await expect(call('work.files.open', { ref: at(join(rig.team, 'General', 'Plan.docx')) }, phone)).rejects.toThrow(FenceError)
    // A stat never throws for one row: the row it may not name is none.
    expect(names(await call('work.files.stat', { refs: [at(join(rig.folder, 'notes.txt')), at(join(rig.team, 'General', 'Plan.docx'))] }, phone))).toEqual(['notes.txt', '(none)'])
  })

  it("naming another workspace's folder gets nothing: by that workspace's id it is outside its roots, by its own it is not in its folder", async () => {
    const theirs = at(join(rig.otherFolder, 'Payroll.xlsx'))
    await expect(call('work.files.list', { at: at(rig.otherFolder) }, phone)).rejects.toThrow("That is not in this workspace's folder or a library it may use.")
    await expect(call('work.files.list', { workspaceId: 'w2', at: at(rig.otherFolder) }, phone)).rejects.toThrow(FenceError)
    await expect(call('work.files.open', { ref: theirs }, phone)).rejects.toThrow("That is not in this workspace's folder or a library it may use.")
    expect(names(await call('work.files.stat', { refs: [theirs] }, phone))).toEqual(['(none)'])
    // LifeOS is named by its rows, not a path: each row is held to w2's own sector when it is named (places/lifeos.ts).
    expect((await call<FilesPlaces>('work.files.places', { workspaceId: 'w2' }, phone)).places.map((p) => p.kind)).toEqual(['home', 'recent', 'starred', 'made', 'trash', 'lifeos'])
    await expect(call('work.files.threads', { ref: theirs }, phone)).rejects.toThrow()
  })

  it('hears of no tab and no mark that names a file it could not list', async () => {
    await call('work.files.tabOpen', { page: { at: { at: 'place', id: 'folder' }, name: 'Dummy Esports' } })
    await call('work.files.tabOpen', { page: { at: at(join(rig.team, 'General')), name: 'General' } })
    await call<FilesOpened>('work.files.open', { ref: at(join(rig.team, 'General', 'Spring budget.xlsx')) })
    await call<FilesOpened>('work.files.open', { ref: at(join(rig.folder, 'notes.txt')) })
    await call('work.files.star', { ref: at(join(rig.team, 'General', 'Plan.docx')), name: 'Plan.docx', on: true })
    await call('work.files.star', { ref: at(join(rig.folder, 'Budget.xlsx')), name: 'Budget.xlsx', on: true })
    expect((await call<FilesTabs>('work.files.tabs', {})).tabs.map((t) => t.name)).toEqual(['Dummy Esports', 'General', 'Spring budget.xlsx', 'notes.txt'])
    const cut = await call<FilesTabs>('work.files.tabs', {}, phone)
    expect(cut.tabs.map((t) => t.name)).toEqual(['Dummy Esports', 'notes.txt'])
    expect(JSON.stringify(cut)).not.toContain('Spring budget')
    expect(JSON.stringify(cut)).not.toContain('CloudStorage')
    expect(names(await call<FilesListing>('work.files.list', { at: { at: 'place', id: 'starred' } }, phone))).toEqual(['Budget.xlsx'])
    expect(names(await call<FilesListing>('work.files.list', { at: { at: 'place', id: 'recent' } }, phone))).toEqual(['notes.txt'])
    // The answer to its own change is cut the same way.
    const mine = await call<FilesTabs>('work.files.tabOpen', { page: { at: { at: 'place', id: 'starred' }, name: 'Starred' } }, phone)
    expect(mine.tabs.map((t) => t.name)).toEqual(['Dummy Esports', 'notes.txt', 'Starred'])
    await expect(call('work.files.tabOpen', { page: { at: at(join(rig.team, 'General')), name: 'General' } }, phone)).rejects.toThrow(FenceError)
    await expect(call('work.files.star', { ref: at(join(rig.team, 'General', 'Plan.docx')), name: 'Plan.docx', on: false }, phone)).rejects.toThrow(FenceError)
  })

  it("keeps a tab that stands on another host's folder whole: only its address is held here, and that host fences it", async () => {
    await call('work.files.tabOpen', { page: { at: at('/Users/l/Library/CloudStorage/OneDrive-Dummy/General', 'env_mac'), name: 'General' } })
    expect((await call<FilesTabs>('work.files.tabs', {}, phone)).tabs.map((t) => t.name)).toEqual(['General'])
  })

  it('cannot use a cursor cut for another folder or by another caller', async () => {
    const big = join(rig.team, 'General', 'Many')
    mkdirSync(big)
    for (let i = 0; i < 600; i++) writeFileSync(join(big, `f${i}.txt`), 'x')
    const theirs = (await call<FilesListing>('work.files.list', { at: at(big) })).next!
    // The window's cursor names a library folder: the key is fenced by the folder it names, whatever the cursor says.
    await expect(call('work.files.list', { at: at(big), cursor: theirs }, phone)).rejects.toThrow(FenceError)
    // Laid over a folder the key may list, it is another folder's cursor: stale, and nothing of the library comes back.
    expect(await call('work.files.list', { at: { at: 'place', id: 'folder' }, cursor: theirs }, phone)).toEqual({ entries: [], stale: true })
  })

  it('is passed a guest path by the listener only for the verbs that name one file or folder, never a method whole', () => {
    if (process.platform === 'win32') return
    const guest = 'C:\\Users\\tcuser\\Dummy U\\Esports Staff - Documents\\General'
    const roots = [rig.folder]
    const req = (method: string, params: Record<string, unknown>) => ClientRequestSchema.parse({ id: '1', method, params: { workspaceId: WS, ...params } })
    for (const [method, params] of [
      ['work.files.list', { at: at(guest) }],
      ['work.files.stat', { refs: [at(`${guest}\\Plan.docx`)] }],
      ['work.files.fetch', { ref: at(`${guest}\\Plan.docx`) }],
      ['work.files.open', { ref: at(`${guest}\\Plan.docx`) }],
      ['work.files.threads', { ref: at(`${guest}\\Plan.docx`) }],
      ['work.files.tabOpen', { page: { at: at(guest), name: 'General' } }],
      ['work.files.tabSet', { tabId: 't', page: { at: at(guest), name: 'General' } }],
      ['work.files.star', { ref: at(`${guest}\\Plan.docx`), name: 'Plan.docx', on: true }],
      ['work.files.seen', { ref: at(`${guest}\\Plan.docx`), name: 'Plan.docx' }],
      // the VM's own change verbs: each handler holds the path to OneDrive's mounts and the door (vmVerbs.test.ts)
      ['work.files.make', { at: at(guest), kind: 'folder', op: OP }],
      ['work.files.rename', { ref: at(`${guest}\\Plan.docx`), name: 'x', op: OP }],
      ['work.files.trash', { refs: [at(`${guest}\\Plan.docx`)], op: OP }],
      ['work.files.move', { refs: [at(`${guest}\\Plan.docx`)], to: at(`${guest}\\Budgets`), op: OP }]
    ] as const) {
      expect(() => fenceRequest(req(method, params), roots), method).not.toThrow()
      expect(guestPath(method, guest), method).toBe(true)
    }
    // An editor's bytes, a copy, an upload and every other pillar's method carry no guest path.
    for (const [method, params] of [
      ['work.files.read', { ref: at(`${guest}\\Plan.docx`), offset: 0, length: 10 }],
      ['work.files.write', { ref: at(`${guest}\\Plan.docx`), text: 'x', version: 'v' }],
      ['work.files.copy', { refs: [at(`${guest}\\Plan.docx`)], to: at(guest), op: OP }],
      ['work.files.upload', { at: at(guest), name: 'x.txt', size: 1, sha256: 'a'.repeat(64), op: OP }],
      ['work.canvas.open', { sessionId: 's', kind: 'pdf', source: at(`${guest}\\a.pdf`), title: 'a' }]
    ] as const)
      expect(() => fenceRequest(req(method, params), roots), method).toThrow(FenceError)
    // In one batch a guest path passes and a path of this host outside the roots still fails.
    expect(() => fenceRequest(req('work.files.stat', { refs: [at(`${guest}\\Plan.docx`), at(join(rig.team, 'General', 'Plan.docx'))] }), roots)).toThrow(FenceError)
    expect(() => fenceRequest(req('work.files.stat', { refs: [at(`${guest}\\Plan.docx`), at(join(rig.folder, 'notes.txt'))] }), roots)).not.toThrow()
    // A path that only looks like a guest's is not one: a step up, or a slash, is fenced as any path.
    expect(guestPath('work.files.list', 'C:\\Users\\..\\secret/x')).toBe(false)
  })
})

describe('a thread', () => {
  it("lists and stats its own workspace's places, and never the tabs, the marks or another workspace", async () => {
    expect(names(await call<FilesListing>('work.files.list', { at: { at: 'place', id: 'folder' } }, thread('t1')))).toContain('Budget.xlsx')
    expect(names(await call<FilesListing>('work.files.list', { at: at(join(rig.team, 'General')) }, thread('t1')))).toContain('Plan.docx')
    for (const [method, params] of [
      ['work.files.tabs', {}],
      ['work.files.open', { ref: at(join(rig.folder, 'notes.txt')) }],
      ['work.files.tabOpen', { page: { at: { at: 'place', id: 'folder' }, name: 'x' } }],
      ['work.files.tabClose', { tabId: 'x' }],
      ['work.files.tabMove', { tabId: 'x', before: null }],
      ['work.files.tabSet', { tabId: 'x', page: { at: { at: 'place', id: 'folder' }, name: 'x' } }],
      ['work.files.star', { ref: at(join(rig.folder, 'notes.txt')), name: 'notes.txt', on: true }],
      ['work.files.seen', { ref: at(join(rig.folder, 'notes.txt')), name: 'notes.txt' }],
      ['work.files.list', { at: { at: 'place', id: 'starred' } }]
    ] as const)
      await expect(call(method, params, thread('t1')), method).rejects.toThrow('the tabs of Files are his own')
    await expect(call('work.files.list', { at: { at: 'place', id: 'folder' } }, thread('t2'))).rejects.toThrow(THREAD_ELSEWHERE)
    await expect(call('work.files.list', { at: { at: 'place', id: 'folder' } }, thread('chat'))).rejects.toThrow(THREAD_ELSEWHERE)
  })
})

describe('another host of his', () => {
  it('lists the libraries alone, and holds no tab or mark here', async () => {
    expect(names(await call<FilesListing>('work.files.list', { at: at(join(rig.team, 'General')) }, peer))).toContain('Plan.docx')
    await expect(call('work.files.list', { at: { at: 'place', id: 'folder' } }, peer)).rejects.toThrow(PEER_LIBRARIES)
    await expect(call('work.files.list', { at: at(rig.folder) }, peer)).rejects.toThrow(PEER_LIBRARIES)
    await expect(call('work.files.tabs', {}, peer)).rejects.toThrow(PEER_LIBRARIES)
    await expect(call('work.files.open', { ref: at(join(rig.team, 'General', 'Plan.docx')) }, peer)).rejects.toThrow(PEER_LIBRARIES)
  })
})

describe('the door stands before every verb', () => {
  const notes = () => at(join(rig.folder, 'notes.txt'))
  const plan = () => at(join(rig.team, 'General', 'Plan.docx'))
  const general = () => at(join(rig.team, 'General'))

  it("admits his window in his own place, and the grammar's refusal comes before the verb is even looked for", async () => {
    const done = await call<FileDone>('work.files.rename', { ref: notes(), name: 'kickoff.txt', op: OP })
    expect(done.entries.map((e) => e.name)).toEqual(['kickoff.txt'])
    // A place that does not carry out a verb says so in its own sentence, before anything is read.
    await expect(call('work.files.trash', { refs: [plan()], op: OP })).rejects.toThrow('Delete it in Teams.')
    await expect(call('work.files.copy', { refs: [plan()], to: { at: 'place', id: 'folder' }, op: OP })).rejects.toThrow('Teams files stay in Teams.')
  })

  it('refuses every change from a thread, whatever it names', async () => {
    for (const [method, params] of [
      ['work.files.make', { at: { at: 'place', id: 'folder' }, kind: 'document', op: OP }],
      ['work.files.rename', { ref: notes(), name: 'a.txt', op: OP }],
      ['work.files.move', { refs: [notes()], to: at(join(rig.folder, 'Events')), op: OP }],
      ['work.files.copy', { refs: [notes()], to: general(), op: OP, asked: true }],
      ['work.files.trash', { refs: [notes()], op: OP }],
      ['work.files.upload', { at: general(), name: 'a.txt', size: 1, sha256: 'a'.repeat(64), op: OP }]
    ] as const)
      await expect(call(method, params, thread('t1')), method).rejects.toThrow()
    // A thread's change goes through the files_* tools alone (tools.ts), so the wire refuses it outright, with or without the switch.
    for (const on of [false, true]) {
      setThreadsMayWrite(on)
      await expect(call('work.files.rename', { ref: notes(), name: 'a.txt', op: OP }, thread('t1'))).rejects.toThrow(THREADS_BY_TOOLS)
    }
    setThreadsMayWrite(false)
    await expect(call('work.files.restore', { ids: ['x'], op: OP }, thread('t1'))).rejects.toThrow(THREADS_BY_TOOLS)
    await expect(call('work.files.purge', {}, thread('t1'))).rejects.toThrow(THREADS_BY_TOOLS)
    // And one outside its workspace is refused as that, before any place is read.
    await expect(call('work.files.rename', { ref: at(join(rig.otherFolder, 'Payroll.xlsx')), name: 'a.xlsx', op: OP }, thread('t1'))).rejects.toThrow()
    await expect(call('work.files.rename', { ref: notes(), name: 'a.txt', op: OP }, thread('t2'))).rejects.toThrow(THREAD_ELSEWHERE)
  })

  it('refuses a key outside its roots at the fence, and a peer in his own folder as no library', async () => {
    await expect(call('work.files.rename', { ref: plan(), name: 'a.docx', op: OP }, phone)).rejects.toThrow(FenceError)
    await expect(call('work.files.rename', { ref: plan(), name: 'a.docx', op: OP }, approver)).rejects.toThrow(FenceError)
    await expect(call('work.files.rename', { ref: notes(), name: 'a.txt', op: OP }, peer)).rejects.toThrow(PEER_LIBRARIES)
    await expect(call('work.files.make', { at: { at: 'place', id: 'folder' }, kind: 'folder', op: OP }, peer)).rejects.toThrow(PEER_LIBRARIES)
  })

  it('reads the Trash verbs as the workspace\'s own rows: no peer, no thread', async () => {
    await expect(call('work.files.restore', { ids: ['x'], op: OP }, peer)).rejects.toThrow(PEER_LIBRARIES)
    await expect(call('work.files.purge', {}, peer)).rejects.toThrow(PEER_LIBRARIES)
    // His window is answered: an id that is no row of this workspace is refused by its id, and nothing is purged.
    expect(await call('work.files.restore', { ids: ['x'], op: OP })).toMatchObject({ entries: [], refused: [{ name: 'x', text: 'That is not in Trash any more.' }] })
    expect(await call('work.files.purge', {})).toEqual({ purged: 0 })
  })

  it('names only strings the door itself made', () => {
    expect([ASK_FIRST, NEEDS_APPROVE, PEER_NO_ORIGIN, THREADS_NOT_YET].every((s) => s.endsWith('.'))).toBe(true)
  })
})

describe('a read-only key', () => {
  it('may list, and its capability is the listener\'s to hold it to for the rest', async () => {
    expect(names(await call<FilesListing>('work.files.list', { at: { at: 'place', id: 'folder' } }, reader))).toContain('Budget.xlsx')
    expect((await call<FilesTabs>('work.files.tabs', {}, reader)).tabs).toEqual([])
  })
})
