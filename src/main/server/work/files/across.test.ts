import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FilesListing, FilesPlaces } from '@shared/contract-work-files'
import { ClientRequestSchema, type ClientRequest } from '@shared/contract'
import { filesPaneOf } from '@shared/work'
import type { Caller } from '../modules'
import { setCloudDir } from '../office/files/library'
import { forgetAcross, NOT_BOUND, reachChanged, setLiveBinding } from './across'
import { NotReachable } from './policy'
import { setHostRead } from '../peer'
import { closeFilesState, filesHandle } from './handle'
import { setSystemBin } from './trash'
import { copyRecord, recordCopy } from './copies'
import type { FileDone } from '@shared/contract-work-files'
import { forgetLibraries } from './places/libraries'
import { HOST, makeRig, peer, thread, window, WS, type Rig } from './testkit'

/**
 * Files from another window: his Mac's window has no link to the PC, so it asks the box workspace, and the box
 * asks the PC over a stand-in of its host link that runs the PC's own handler for a peer (as `servePeerWork` does).
 */

const PC = 'env_pc'
const AS_BOX: Caller = { kind: 'remote', caps: ['read', 'operate'], peer: HOST }
const macKey: Caller = { kind: 'remote', caps: ['read', 'operate'] }

let box: Rig
let pc: Rig
let far: { host: string; verb: string; scope: unknown; args: Record<string, unknown> }[]

const across = (by: Caller, method: string, params: Record<string, unknown> = {}, host = PC) =>
  filesHandle({ id: 'x', method: 'work.files.across', params: { workspaceId: WS, host, method, params } } as ClientRequest, box.ctx, by).then((r) => (r as { result: unknown }).result)

beforeEach(() => {
  box = makeRig()
  pc = makeRig()
  ;(pc.ctx as { host: string }).host = PC
  setCloudDir((host) => (host === HOST ? join(box.base, 'no-cloud') : host === PC ? pc.cloud : join(box.base, 'no-cloud')))
  forgetLibraries(box.db)
  forgetLibraries(pc.db)
  far = []
  Object.assign(box.ctx, {
    peer: {
      call(this: unknown, o: { scope: unknown }, host: string) {
        return {
          async call(module: string, verb: string, args: Record<string, unknown>) {
            far.push({ host, verb, scope: o.scope, args })
            const req = ClientRequestSchema.parse({ id: 'peer', method: `work.${module}.${verb}`, params: args }) as ClientRequest
            const out = await filesHandle(req, pc.ctx, AS_BOX)
            if (!out.handled) throw new Error(`${req.method} is not answered there`)
            return out.result
          }
        }
      }
    }
  })
})
/** The PC's own bin, a stand-in: a folder of its own, from where Put back takes a thing to the path it names. */
let binDir: string
let binRefuses: string | null
beforeEach(() => {
  binDir = join(pc.base, 'bin')
  mkdirSync(binDir, { recursive: true })
  binRefuses = null
  setSystemBin({
    put: async (path) => {
      if (binRefuses) throw new Error(binRefuses)
      const at = join(binDir, `${Date.now()}-${basename(path)}`)
      renameSync(path, at)
      return at
    },
    back: async (bin, to) => (renameSync(bin, to), to)
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  forgetAcross()
  setSystemBin(null)
  setLiveBinding()
  closeFilesState(box.db)
  closeFilesState(pc.db)
  pc.close()
  box.close()
})

describe("a desktop's link coming back or going", () => {
  it('tells each Work workspace that may use it that its places changed, and no other', () => {
    box.settings.set(WS, { mayUseDesktop: [PC] })
    box.pushes.length = 0
    reachChanged(box.ctx, PC)
    expect(box.pushes.map((x) => x.p)).toEqual([{ push: 'work.files', workspaceId: WS, places: true }])
    box.pushes.length = 0
    reachChanged(box.ctx, 'env_elsewhere')
    expect(box.pushes).toEqual([])
  })

  it("says an away desktop's folder in the typed away, so a window reads it as away and a send waits for it", async () => {
    Object.assign(box.ctx, { peer: { call: () => ({ call: async () => Promise.reject(new Error(`Mac offline: ${PC} has no live link to this host`)) }) } })
    const err = await across(window, 'work.files.list', { at: { at: 'file', host: PC, path: pc.team } }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NotReachable)
  })
})

describe('work.files.across', () => {
  it("lists the PC's places through the box workspace, as the workspace's Files pane, with Delete, Rename and Move alone of the changes", async () => {
    const got = (await across(macKey, 'work.files.places')) as FilesPlaces
    expect(far).toMatchObject([{ host: PC, verb: 'places', scope: { sessionId: filesPaneOf(WS), workspaceId: WS }, args: { workspaceId: WS } }])
    expect(got.host).toBe(PC)
    // Another host reaches only the PC's libraries, never a workspace's own folder or marks.
    const names = got.places.map((p) => p.name)
    expect(names).toEqual(expect.arrayContaining(['General', 'Events', 'My OneDrive']))
    expect(got.places.every((p) => p.env === PC && p.can.every((verb) => verb === 'trash' || verb === 'rename' || verb === 'move') && !p.makes)).toBe(true)
  })

  it('lists a folder there, and states its rows', async () => {
    const general = join(pc.team, 'General')
    const got = (await across(window, 'work.files.list', { at: { at: 'file', host: PC, path: general } })) as FilesListing
    expect(got.entries.map((e) => e.name)).toEqual(expect.arrayContaining(['Budgets', 'Spring budget.xlsx', 'Plan.docx']))
    const stat = (await across(window, 'work.files.stat', { refs: [{ at: 'file', host: PC, path: join(general, 'Plan.docx') }] })) as { entries: { name: string }[] }
    expect(stat.entries[0]?.name).toBe('Plan.docx')
  })

  it('says a desktop with no live link (asleep, off its VPN, TempCode closed) is not reachable now, in words a window reads as away', async () => {
    Object.assign(box.ctx, { peer: { call: () => ({ call: async () => { throw new Error(`host offline: ${PC} has no live link to this host`) } }) } })
    await expect(across(macKey, 'work.files.places')).rejects.toThrow(/^That computer is not reachable now\.$/)
    // One named while linked keeps its name here once it is away.
    setHostRead(box.ctx, { hosts: () => [], read: async () => null as never, name: () => 'Purdue laptop' })
    await expect(across(macKey, 'work.files.places')).rejects.toThrow('Purdue laptop is not reachable now.')
    setHostRead(box.ctx, { hosts: () => [], read: async () => null as never, name: () => null })
    await expect(across(macKey, 'work.files.places')).rejects.toThrow('Purdue laptop is not reachable now.')
    // Any other refusal there passes as it was said.
    Object.assign(box.ctx, { peer: { call: () => ({ call: async () => { throw new Error("this host's bridge is off for that host") } }) } })
    await expect(across(macKey, 'work.files.places')).rejects.toThrow("this host's bridge is off for that host")
  })

  it('asks nothing of a desktop whose binding is not live', async () => {
    setLiveBinding((id) => id !== PC)
    await expect(across(macKey, 'work.files.places')).rejects.toThrow(NOT_BOUND)
    expect(far).toEqual([])
  })

  it('refuses a thread, another host, this host itself, and a workspace that is not here', async () => {
    await expect(across(thread(), 'work.files.places')).rejects.toThrow()
    await expect(across(peer, 'work.files.places')).rejects.toThrow("Another host reaches only this host's libraries.")
    await expect(across(macKey, 'work.files.places', {}, HOST)).rejects.toThrow('That is this host')
    await expect(filesHandle({ id: 'x', method: 'work.files.across', params: { workspaceId: 'nope', host: PC, method: 'work.files.places', params: {} } } as ClientRequest, box.ctx, macKey)).rejects.toThrow()
    expect(far).toEqual([])
  })
})

describe('a delete of a file another host holds', () => {
  const call = <T>(by: Caller, method: string, params: Record<string, unknown>): Promise<T> =>
    filesHandle({ id: 'x', method, params: { workspaceId: WS, ...params } } as ClientRequest, box.ctx, by).then((r) => (r as { result: T }).result)

  it("through the box from a window that cannot reach the PC: the PC's own bin takes it, and Undo puts it back there", async () => {
    const plan = join(pc.team, 'General', 'Plan.docx')
    const done = (await across(window, 'work.files.trash', { refs: [{ at: 'file', host: PC, path: plan }], op: 'op-far-1', asked: true })) as FileDone
    expect(done.refused).toEqual([])
    expect(done.trashed).toHaveLength(1)
    expect(existsSync(plan)).toBe(false)
    expect(far.at(-1)).toMatchObject({ host: PC, verb: 'trash', args: { origin: { from: 'window' } } })
    const back = (await across(window, 'work.files.restore', { ids: done.trashed, op: 'op-far-2' })) as FileDone
    expect(back.refused).toEqual([])
    expect(existsSync(plan)).toBe(true)
  })

  it('lists the PC\'s places with Delete, Rename and Move, and nothing else that would change them', async () => {
    const got = (await across(macKey, 'work.files.places')) as FilesPlaces
    const general = got.places.find((p) => p.name === 'General')!
    expect([...general.can].sort()).toEqual(['move', 'rename', 'trash'])
  })

  it("sent to the box by a window that named the PC's file: the box sends it on, and the Undo it answers puts it back there", async () => {
    const plan = join(pc.team, 'General', 'Plan.docx')
    const done = await call<FileDone>(window, 'work.files.trash', { refs: [{ at: 'file', host: PC, path: plan }], op: 'op-far-3', asked: true })
    expect(done.refused).toEqual([])
    expect(existsSync(plan)).toBe(false)
    const back = await call<FileDone>(window, 'work.files.restore', { ids: done.trashed, op: 'op-far-4' })
    expect(back.refused).toEqual([])
    expect(existsSync(plan)).toBe(true)
  })

  it('is his press alone: a thread and a key that may not approve are refused, and nothing leaves the PC', async () => {
    const plan = join(pc.team, 'General', 'Plan.docx')
    await expect(across(macKey, 'work.files.trash', { refs: [{ at: 'file', host: PC, path: plan }], op: 'op-far-5', asked: true })).rejects.toThrow()
    await expect(call(macKey, 'work.files.trash', { refs: [{ at: 'file', host: PC, path: plan }], op: 'op-far-6', asked: true })).rejects.toThrow()
    await expect(call(thread('t1'), 'work.files.trash', { refs: [{ at: 'file', host: PC, path: plan }], op: 'op-far-7', asked: true })).rejects.toThrow()
    expect(existsSync(plan)).toBe(true)
  })

  it('says plainly when the PC is not reachable, and deletes nothing', async () => {
    const plan = join(pc.team, 'General', 'Plan.docx')
    ;(box.ctx as { peer: unknown }).peer = { call: () => ({ call: async () => { throw new Error('host offline: env_pc has no live link to this host') } }) }
    await expect(across(window, 'work.files.trash', { refs: [{ at: 'file', host: PC, path: plan }], op: 'op-far-8', asked: true })).rejects.toThrow(/is not reachable now/)
    expect(existsSync(plan)).toBe(true)
  })

  it("a bin the PC's own computer refuses keeps the file there, said by its name", async () => {
    const plan = join(pc.team, 'General', 'Plan.docx')
    binRefuses = 'The Recycle Bin refused the file.'
    const done = (await across(window, 'work.files.trash', { refs: [{ at: 'file', host: PC, path: plan }], op: 'op-far-9', asked: true })) as FileDone
    expect(done.refused).toEqual([{ name: 'Plan.docx', text: 'The Recycle Bin refused the file.' }])
    expect(existsSync(plan)).toBe(true)
  })
})

describe('a rename or a move of a file another host holds', () => {
  const call = <T>(by: Caller, method: string, params: Record<string, unknown>): Promise<T> =>
    filesHandle({ id: 'x', method, params: { workspaceId: WS, ...params } } as ClientRequest, box.ctx, by).then((r) => (r as { result: T }).result)
  const general = () => join(pc.team, 'General')

  it('renames it on the PC through the box, on his press, and the box\'s copy of it follows', async () => {
    const plan = join(general(), 'Plan.docx')
    recordCopy(box.ctx, { workspaceId: WS, host: PC, path: plan, vm: false, copy: join(box.base, 'copy', 'Plan.docx'), name: 'Plan.docx', kind: 'document', version: 'v1', sha256: 's' })
    const done = await call<FileDone>(window, 'work.files.rename', { ref: { at: 'file', host: PC, path: plan }, name: 'Plan 2026.docx', op: 'op-rename-1' })
    expect(done.entries[0]?.name).toBe('Plan 2026.docx')
    expect(existsSync(join(general(), 'Plan 2026.docx'))).toBe(true)
    expect(copyRecord(box.ctx, WS, PC, join(general(), 'Plan 2026.docx'))).not.toBeNull()
    expect(copyRecord(box.ctx, WS, PC, plan)).toBeNull()
  })

  it('renames and moves through the window\'s road to a desktop it cannot reach', async () => {
    const plan = join(general(), 'Plan.docx')
    const renamed = (await across(window, 'work.files.rename', { ref: { at: 'file', host: PC, path: plan }, name: 'Kickoff.docx', op: 'op-rename-2' })) as FileDone
    expect(renamed.entries[0]?.name).toBe('Kickoff.docx')
    const moved = (await across(window, 'work.files.move', { refs: [{ at: 'file', host: PC, path: join(general(), 'Kickoff.docx') }], to: { at: 'file', host: PC, path: join(general(), 'Budgets') }, op: 'op-move-01', asked: true })) as FileDone
    expect(moved.refused).toEqual([])
    expect(existsSync(join(general(), 'Budgets', 'Kickoff.docx'))).toBe(true)
  })

  it('refuses a move to another computer, a key that may not approve, and a thread, and changes nothing', async () => {
    const plan = join(general(), 'Plan.docx')
    await expect(call(window, 'work.files.move', { refs: [{ at: 'file', host: PC, path: plan }], to: { at: 'file', host: HOST, path: box.folder }, op: 'op-move-02', asked: true })).rejects.toThrow(/copy it there first/)
    await expect(across(macKey, 'work.files.rename', { ref: { at: 'file', host: PC, path: plan }, name: 'x.docx', op: 'op-rename-3' })).rejects.toThrow()
    await expect(call(thread('t1'), 'work.files.rename', { ref: { at: 'file', host: PC, path: plan }, name: 'x.docx', op: 'op-rename-4' })).rejects.toThrow()
    expect(existsSync(plan)).toBe(true)
  })
})

describe('a listing of another desktop, joined while in flight', () => {
  const general = () => join(pc.team, 'General')
  const list = (by: Caller = window) => across(by, 'work.files.list', { at: { at: 'file', host: PC, path: general() } }) as Promise<FilesListing>
  const lists = () => far.filter((f) => f.verb === 'list')
  beforeEach(() => box.settings.set(WS, { mayUseDesktop: [PC] }))

  it('asks the desktop once for two lists of one folder at the same time, and again for each list after it answered', async () => {
    const [a, b] = await Promise.all([list(), list(macKey)])
    expect(lists()).toHaveLength(1)
    expect(b.entries.map((e) => e.name)).toEqual(a.entries.map((e) => e.name))
    // Nothing kept once it answered: the next list goes to the desktop and meets its own gates there.
    await list()
    expect(lists()).toHaveLength(2)
    // Another ask (another folder, another order) is its own.
    await across(window, 'work.files.list', { at: { at: 'file', host: PC, path: general() }, sort: { by: 'name', dir: 'desc' } })
    expect(lists()).toHaveLength(3)
  })

  it('a desktop that stops sharing shows nothing from here on the next list, however soon', async () => {
    await list()
    // Its bridge policy for this host is turned off there: the next list is that desktop's refusal, not rows from before.
    const was = (box.ctx as { peer: unknown }).peer
    Object.assign(box.ctx, { peer: { call: () => ({ call: async () => { throw new Error('forbidden: this host may not use that desktop') } }) } })
    await expect(list()).rejects.toThrow('forbidden')
    Object.assign(box.ctx, { peer: was })
  })

  it('a list after a change sent there never joins a list from before the change', async () => {
    // The desktop holds its answers to lists until let go.
    const held: (() => void)[] = []
    const was = (box.ctx as { peer: { call(o: unknown, host: string): { call(m: string, v: string, a: Record<string, unknown>): Promise<unknown> } } }).peer
    Object.assign(box.ctx, {
      peer: {
        call: (o: unknown, host: string) => ({
          call: async (m: string, v: string, a: Record<string, unknown>) => {
            if (v === 'list') await new Promise<void>((go) => held.push(go))
            return was.call(o, host).call(m, v, a)
          }
        })
      }
    })
    const before = list()
    await vi.waitFor(() => expect(held).toHaveLength(1))
    await across(window, 'work.files.rename', { ref: { at: 'file', host: PC, path: join(general(), 'Plan.docx') }, name: 'Plan v2.docx', op: 'op-rename-0002' })
    const after = list()
    // Two asks of the desktop, not one joined: the second is its own.
    await vi.waitFor(() => expect(held).toHaveLength(2))
    held.forEach((go) => go())
    await before
    expect((await after).entries.map((e) => e.name)).toContain('Plan v2.docx')
  })

  it('runs the gates on every ask: a binding stopped or the desktop no longer allowed is refused, and Work off says so', async () => {
    await list()
    setLiveBinding((id) => id !== PC)
    await expect(list()).rejects.toThrow(NOT_BOUND)
    setLiveBinding()
    // No longer "May use this computer": the call is made, and refused, as it would be with nothing kept.
    box.settings.set(WS, { mayUseDesktop: [] })
    Object.assign(box.ctx, { peer: { call: () => ({ call: async () => { throw new Error("this workspace may not use that host's desktop") } }) } })
    await expect(list()).rejects.toThrow("this workspace may not use that host's desktop")
    box.settings.set(WS, { mayUseDesktop: [PC] })
    ;(box.ctx as { enabled: () => boolean }).enabled = () => false
    await expect(list()).rejects.toThrow('Work is off on this host')
  })

})
