import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { METHOD_CAPABILITY } from '@shared/capabilities'
import { ClientRequestSchema, type ClientRequest } from '@shared/contract'
import type { FilesOpened } from '@shared/contract-work-files'
import { filesPaneOf } from '@shared/work'
import type { OfficeLiveOf, TeamsLibrariesAnswer, TeamsLibrary } from '@shared/contract-work-office'
import { closeFilesState, filesState } from '../../files/handle'
import { files } from '../../files'
import { at, HOST, makeRig, phone, thread, window, WS, type Rig } from '../../files/testkit'
import { servePeerWork } from '../../peer'
import { office } from '..'
import { FakeOffice } from '../fake'
import { libraryId, setRoots } from '../files/library'
import { setVmCall } from '../vm/link'
import { setVmState } from '../vm/office'
import { liveHandle } from './handle'
import { modeOf, setMode } from './memory'

const request = (method: string, params: Record<string, unknown>): ClientRequest => ClientRequestSchema.parse({ id: '1', method, params })
const WEB = 'https://purdue0.sharepoint.com/sites/Esports/Shared%20Documents'
const VM_TOP = 'C:\\Users\\tcuser\\Dummy U\\Esports Staff - Documents'

describe('the live Office wire', () => {
  let rig: Rig
  let library: string
  const desktop = new FakeOffice()
  const open = async (path: string): Promise<FilesOpened> => {
    const result = await files.handle!(request('work.files.open', { workspaceId: WS, ref: at(path) }), rig.ctx, window)
    return (result as { result: FilesOpened }).result
  }
  const liveOf = (tabId: string, by = window, workspaceId = WS) => liveHandle(request('work.office.live.of', { workspaceId, tabId }), rig.ctx, by, () => desktop)

  beforeEach(() => {
    rig = makeRig()
    office.ensure(rig.db)
    library = libraryId(HOST, rig.team)
  })
  afterEach(() => {
    setVmCall(null)
    closeFilesState(rig.db)
    rig.db.close()
    rig.close()
  })

  it('reads a Files tab by workspace and stable key, and picks the desktop that holds the file', async () => {
    setRoots(rig.db, [{ folder: rig.team, web: WEB }])
    const path = join(rig.team, 'General', 'Plan.docx')
    const { tabId, tabs } = await open(path)
    const key = tabs.find((t) => t.id === tabId)!.key!
    expect(await liveOf(tabId!)).toEqual({
      handled: true, result: { mode: 'here', address: `${WEB}/General/Plan.docx?web=1`, app: 'word', tenant: 'purdue0', desktops: [{ source: at(path) }] }
    })
    expect(await office.handle!(request('work.office.live.setLibraryDefault', { libraryId: library, mode: 'live' }), rig.ctx, window))
      .toEqual({ handled: true, result: { mode: 'live' } })
    expect(await office.handle!(request('work.office.live.of', { workspaceId: WS, tabId }), rig.ctx, window))
      .toMatchObject({ handled: true, result: { mode: 'live', address: `${WEB}/General/Plan.docx?web=1` } })
    expect(await liveOf(tabId!)).toMatchObject({ result: { mode: 'live' } })
    setMode(rig.db, WS, key, 'here')
    expect(await liveOf(tabId!)).toMatchObject({ result: { mode: 'here' } })
    await expect(liveOf(tabId!, window, 'w2')).rejects.toThrow('closed')
    office.workspaceRemoved!(WS, rig.ctx)
    expect(modeOf(rig.db, WS, key, library)).toBe('live')
  })

  it('keeps the original address when the tab’s Word item becomes an imported document', async () => {
    const docx = join(rig.team, 'General', 'Plan.docx')
    const plan = await open(docx)
    rig.canvas.replace(filesPaneOf(WS), plan.item!.id, { kind: 'document', source: at(join(rig.folder, 'Run of show.tcdoc')), title: 'Plan' })
    await office.handle!(request('work.office.filesSetRoots', { roots: [{ folder: rig.team, web: WEB }] }), rig.ctx, window)
    expect(await liveOf(plan.tabId!)).toMatchObject({ result: { address: `${WEB}/General/Plan.docx?web=1`, app: 'word', desktops: [{ source: at(docx) }] } })
  })

  it('leaves a workspace file without a live control and explains a refused library address', async () => {
    setRoots(rig.db, [{ folder: rig.team, web: 'https://purdue0.sharepoint.com/:f:/s/Esports/Share' }])
    const local = await open(join(rig.folder, 'Budget.xlsx'))
    expect(await liveOf(local.tabId!)).toMatchObject({ result: { address: null, app: null, desktops: [] } })
    const plan = await open(join(rig.team, 'General', 'Plan.docx'))
    expect(await liveOf(plan.tabId!)).toMatchObject({ result: { address: null, app: 'word', why: 'Use the library’s folder address instead of a sharing link.' } })
  })

  it('uses the sleeping VM’s cached namespace and shows just the desktop apps that are installed', async () => {
    const path = join(rig.team, 'General', 'Plan.docx')
    setRoots(rig.db, [{ folder: rig.team, web: 'https://purdue0.sharepoint.com/sites/Esports/Saved' }])
    setVmState(() => ({ state: 'asleep', cannot: null }))
    const guest = vi.fn(async () => { throw new Error('The VM must stay asleep.') })
    setVmCall(guest)
    const status = {
      mounts: [{ path: VM_TOP, type: 'team', web: WEB }],
      onedrive: { installed: true, running: true, account: 'owner@example.com' },
      office: { installed: true, apps: ['word'], version: null, account: null, licensed: null }
    }
    const keep = rig.db.prepare('INSERT OR REPLACE INTO work_office_files (key, value) VALUES (?, ?)')
    const save = () => keep.run('vm:status', JSON.stringify({ at: 10, status, tops: { [VM_TOP]: ['General'] } }))
    save()
    const plan = await open(path)
    const vmPath = `${VM_TOP}\\General\\Plan.docx`
    expect(await liveOf(plan.tabId!)).toMatchObject({
      result: { address: `${WEB}/General/Plan.docx?web=1`, desktops: [{ source: at(path) }, { source: at(vmPath), vm: true }] }
    })
    const copied = filesState(rig.ctx).tabs.openFile(WS, { key: 'vm:plan', name: 'Plan.docx', kind: 'document', source: at(join(rig.folder, 'Run of show.tcdoc')), copyOf: { host: HOST, path: vmPath, vm: true } })
    expect(await liveOf(copied.tabId)).toMatchObject({
      result: { address: `${WEB}/General/Plan.docx?web=1`, app: 'word', desktops: [{ source: at(vmPath), vm: true }, { source: at(path) }] }
    })
    status.office.apps = ['excel']
    save()
    const result = await liveOf(plan.tabId!)
    expect((result as { result: OfficeLiveOf }).result.desktops).toEqual([{ source: at(path) }])
    expect(guest).not.toHaveBeenCalled()
  })

  it('uses the original library and its default for a copied file from a peer', async () => {
    const host = 'env_mac'
    const path = '/sync/Esports - Documents/General/Plan.docx'
    const far: TeamsLibrary = {
      id: `${host}~esports`, host, path: '/sync/Esports - Documents', team: 'Esports Staff', library: null,
      tenant: 'Dummy U', kind: 'channels', channels: ['General'], found: true, web: WEB
    }
    rig.settings.set(WS, { mayUseDesktop: [host] })
    const read = vi.fn(async (_module: string, verb: string) => {
      if (verb === 'filesLibraries') return { host, libraries: [far], roots: [], off: [] }
      if (verb === 'live.libraryDefault') return { mode: 'live' }
      return { carrier: 'mac', apps: await desktop.apps() }
    })
    rig.ctx.peer = () => ({ call: read })
    const { tabId } = filesState(rig.ctx).tabs.openFile(WS, {
      key: 'esportsgeneral:plan', name: 'Plan.docx', kind: 'document', source: at(join(rig.folder, 'Run of show.tcdoc')), copyOf: { host, path }
    })
    expect(await liveOf(tabId)).toMatchObject({ result: { address: `${WEB}/General/Plan.docx?web=1`, mode: 'live', app: 'word', desktops: [{ source: at(path, host) }, { source: at(join(rig.team, 'General', 'Plan.docx')) }] } })
    expect(read).toHaveBeenCalledWith('office', 'filesLibraries', { cached: true })
    expect(read).toHaveBeenCalledWith('office', 'live.libraryDefault', { libraryId: far.id })
    setMode(rig.db, WS, 'esportsgeneral:plan', 'here')
    expect(await liveOf(tabId)).toMatchObject({ result: { mode: 'here' } })
    setMode(rig.db, WS, 'esportsgeneral:plan', 'live')
    read.mockRejectedValue(new Error('offline'))
    expect(await liveOf(tabId)).toMatchObject({ result: { mode: 'live', address: null, why: 'The file’s library did not answer.' } })
  })

  it('holds tab metadata and preferences to the Files caller and the path fence', async () => {
    const plan = await open(join(rig.team, 'General', 'Plan.docx'))
    await expect(liveOf(plan.tabId!, phone)).rejects.toThrow()
    await expect(liveOf(plan.tabId!, thread())).rejects.toThrow('tabs of Files')
    rig.roots.push(rig.team)
    expect(await liveOf(plan.tabId!, phone)).toMatchObject({ result: { app: 'word', address: null } })
    const params = { libraryId: library, mode: 'live' }
    expect(METHOD_CAPABILITY['work.office.live.of']).toBe('operate')
    expect(METHOD_CAPABILITY['work.office.live.libraryDefault']).toBe('operate')
    expect(METHOD_CAPABILITY['work.office.live.setLibraryDefault']).toBe('operate')
    expect(ClientRequestSchema.safeParse({ id: '1', method: 'work.office.live.setLibraryDefault', params: { ...params, mode: 'web' } }).success).toBe(false)
    const deps = { ctx: rig.ctx, modules: [office], policyOf: () => 'read+run' as const }
    await expect(servePeerWork(deps, 'env_mac', { kind: 'call', module: 'office', verb: 'live.libraryDefault', args: { libraryId: library } })).resolves.toEqual({ mode: 'here' })
    await expect(servePeerWork({ ...deps, policyOf: () => 'read' }, 'env_mac', { kind: 'call', module: 'office', verb: 'live.libraryDefault', args: { libraryId: library } })).rejects.toThrow('needs operate')
  })

  it('answers a Files entry’s web address and app with no tab, for the phone’s Open in Word', async () => {
    const address = (path: string, by = window, host = HOST) => liveHandle(request('work.office.live.address', { workspaceId: WS, ref: at(path, host) }), rig.ctx, by, () => desktop)
    const none = { handled: true, result: { address: null, app: null } }
    setRoots(rig.db, [{ folder: rig.team, web: WEB }])
    expect(await address(join(rig.team, 'General', 'Plan.docx'))).toEqual({ handled: true, result: { address: `${WEB}/General/Plan.docx?web=1`, app: 'word' } })
    expect(await address(join(rig.team, 'General', 'Spring budget.xlsx'))).toMatchObject({ result: { address: `${WEB}/General/Spring%20budget.xlsx?web=1`, app: 'excel' } })
    expect(await address(join(rig.team, 'General', 'Cloud only.pdf'))).toEqual(none)
    expect(await address(join(rig.folder, 'Budget.xlsx'))).toEqual(none)
    expect(await office.handle!(request('work.office.live.address', { workspaceId: WS, ref: { at: 'lifeos', table: 'docs', id: 'd1' } }), rig.ctx, window)).toEqual(none)
    // A phone sees the address only of a library its key reaches; a thread has no Files of its own to ask from.
    await expect(address(join(rig.team, 'General', 'Plan.docx'), phone)).rejects.toThrow()
    rig.roots.push(rig.team)
    expect(await address(join(rig.team, 'General', 'Plan.docx'), phone)).toMatchObject({ result: { app: 'word' } })
    await expect(address(join(rig.team, 'General', 'Plan.docx'), thread())).rejects.toThrow('tabs of Files')
    expect(METHOD_CAPABILITY['work.office.live.address']).toBe('read')

    // Another host's library answers from its own list; one that does not answer gives no address.
    const host = 'env_mac'
    const far: TeamsLibrary = {
      id: `${host}~esports`, host, path: '/sync/Esports - Documents', team: 'Esports Staff', library: null,
      tenant: 'Dummy U', kind: 'channels', channels: ['General'], found: true, web: WEB
    }
    rig.settings.set(WS, { mayUseDesktop: [host] })
    const read = vi.fn(async () => ({ host, libraries: [far], roots: [], off: [] }))
    rig.ctx.peer = () => ({ call: read })
    expect(await address('/sync/Esports - Documents/General/Run.pptx', window, host)).toEqual({ handled: true, result: { address: `${WEB}/General/Run.pptx?web=1`, app: 'powerpoint' } })
    read.mockRejectedValue(new Error('offline'))
    expect(await address('/sync/Esports - Documents/General/Run.pptx', window, host)).toEqual(none)
  })

  it('can list cached libraries without triggering the first VM read', async () => {
    setVmState(() => ({ state: 'asleep', cannot: null }))
    const guest = vi.fn(async () => { throw new Error('The VM must stay asleep.') })
    setVmCall(guest)
    const answer = await office.handle!(request('work.office.filesLibraries', { cached: true }), rig.ctx, window)
    expect(answer.handled).toBe(true)
    expect((answer as { result: TeamsLibrariesAnswer }).result.libraries.map((l) => l.path)).toEqual([rig.team, rig.mine])
    expect(guest).not.toHaveBeenCalled()
  })
})
