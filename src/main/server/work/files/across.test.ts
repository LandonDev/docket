import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FilesListing, FilesPlaces } from '@shared/contract-work-files'
import { ClientRequestSchema, type ClientRequest } from '@shared/contract'
import { filesPaneOf } from '@shared/work'
import type { Caller } from '../modules'
import { setCloudDir } from '../office/files/library'
import { NOT_BOUND, setLiveBinding } from './across'
import { setHostRead } from '../peer'
import { closeFilesState, filesHandle } from './handle'
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
afterEach(() => {
  setLiveBinding()
  closeFilesState(box.db)
  closeFilesState(pc.db)
  pc.close()
  box.close()
})

describe('work.files.across', () => {
  it("lists the PC's places through the box workspace, as the workspace's Files pane, read only", async () => {
    const got = (await across(macKey, 'work.files.places')) as FilesPlaces
    expect(far).toMatchObject([{ host: PC, verb: 'places', scope: { sessionId: filesPaneOf(WS), workspaceId: WS }, args: { workspaceId: WS } }])
    expect(got.host).toBe(PC)
    // Another host reaches only the PC's libraries, never a workspace's own folder or marks.
    const names = got.places.map((p) => p.name)
    expect(names).toEqual(expect.arrayContaining(['General', 'Events', 'My OneDrive']))
    expect(got.places.every((p) => p.env === PC && p.can.length === 0 && !p.makes)).toBe(true)
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
