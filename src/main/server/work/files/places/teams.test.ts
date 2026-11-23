import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FilesListing, FilesPlaces } from '@shared/contract-work-files'
import type { TeamsLibrary } from '@shared/contract-work-office'
import type { FileEntry } from '@shared/work/files'
import type { Caller } from '../../modules'
import { setVmCall } from '../../office/vm/link'
import { setVmState } from '../../office/vm/office'
import { closeFilesState } from '../handle'
import { files } from '../index'
import { at, HOST, makeRig, phone, thread, window, WS, type Rig } from '../testkit'
import { forgetVmLists, libraryTrail, placeOfPath, placesIn } from './teams'

/** Teams and OneDrive as places (teams.ts): one place per channel or library, and the Windows VM's folders read through its helper. */

const lib = (over: Partial<TeamsLibrary>): TeamsLibrary => ({ id: 'h~1', host: 'h', path: '/cloud/Team - Documents', team: 'Team', library: null, tenant: 'Dummy U', kind: 'channels', channels: ['Events', 'General'], web: null, found: true, ...over })

describe('the places a library holds', () => {
  it("is one place per channel for a team's Documents, each keyed so two computers hold one place", () => {
    const places = placesIn(lib({}), { state: 'ok' })
    expect(places.map((p) => [p.place.id, p.place.kind, p.place.name, p.place.group, p.place.key, p.top])).toEqual([
      ['h~1/Events', 'teams', 'Events', 'Team', 'teamevents', '/cloud/Team - Documents/Events'],
      ['h~1/General', 'teams', 'General', 'Team', 'teamgeneral', '/cloud/Team - Documents/General']
    ])
    expect(places.every((p) => p.place.shared && p.place.root.at === 'file')).toBe(true)
  })

  it("is the library itself for a site's other library, his own OneDrive, and a folder he added", () => {
    expect(placesIn(lib({ kind: 'library', library: 'Site Policies', channels: [] }), { state: 'ok' }).map((p) => [p.place.name, p.place.key, p.place.group])).toEqual([['Site Policies', 'teamsitepolicies', 'Team']])
    expect(placesIn(lib({ kind: 'mine', team: 'My files', channels: [] }), { state: 'ok' }).map((p) => [p.place.kind, p.place.name, p.place.key])).toEqual([['onedrive', 'My OneDrive', 'mine']])
    expect(placesIn(lib({ kind: 'folder', team: 'Scans', channels: [] }), { state: 'ok' }).map((p) => [p.place.name, p.place.key])).toEqual([['Scans', 'folder:h~1']])
    // A team's Documents with no channel folder yet is one place named Documents.
    expect(placesIn(lib({ channels: [] }), { state: 'ok' }).map((p) => p.place.name)).toEqual(['Documents'])
  })

  it('names a guest path with its own separator, says the VM as its computer, and finds the place a path lies in', () => {
    const vm = lib({ id: 'box~vm', host: 'box', path: 'C:\\Users\\tcuser\\Dummy U\\Team - Documents', vm: true })
    const places = placesIn(vm, { state: 'asleep', at: 5 })
    expect(places[1]).toMatchObject({ top: 'C:\\Users\\tcuser\\Dummy U\\Team - Documents\\General', place: { host: 'Windows VM', vm: true, state: { state: 'asleep', at: 5 } } })
    const general = placeOfPath(places, vm, 'c:\\users\\tcuser\\dummy u\\team - documents\\general\\Budgets\\2026.xlsx')
    expect(general?.place.name).toBe('General')
    // A file at the library's own top is in no channel.
    expect(placeOfPath(places, vm, 'C:\\Users\\tcuser\\Dummy U\\Team - Documents\\Loose.docx')).toBeNull()
    expect(libraryTrail(places[1]!, 'C:\\Users\\tcuser\\Dummy U\\Team - Documents\\General\\Budgets').map((c) => c.name)).toEqual(['General', 'Budgets'])
  })
})

describe('the Windows VM through its helper', () => {
  let rig: Rig
  let calls: { verb: string; args: unknown; wake?: boolean }[]
  const TOP = 'C:\\Users\\tcuser\\Dummy U\\Esports Staff - Documents'
  const guest = (name: string, dir = false, over: Record<string, unknown> = {}) => ({ name, path: `${TOP}\\General\\${name}`, dir, size: dir ? 0 : 1000, modified: 5_000, local: !name.startsWith('Cloud'), link: false, ...over })
  const call = async <T>(method: string, params: Record<string, unknown>, by: Caller = window): Promise<T> => {
    const out = await files.handle!({ id: '1', method, params: { workspaceId: WS, ...params } } as never, rig.ctx, by)
    return (out as { result: T }).result
  }

  beforeEach(() => {
    rig = makeRig()
    calls = []
    forgetVmLists()
    setVmState(() => ({ state: 'asleep', cannot: null }))
    rig.db.prepare(`INSERT INTO work_office_files (key, value) VALUES ('vm:status', ?)`).run(
      JSON.stringify({ at: 1_700_000_000_000, status: { onedrive: { installed: true, running: true, account: 'a@dummy.edu' }, mounts: [{ path: TOP, type: 'team', web: null }, { path: 'C:\\Users\\tcuser\\OneDrive - Dummy U', type: 'mine', web: null }], office: { installed: true, version: null, apps: [], account: null, licensed: null } }, tops: { [TOP]: ['Events', 'General'] } })
    )
    setVmCall(async (verb, args, opts) => {
      calls.push({ verb, args, wake: (opts as { wake?: boolean } | undefined)?.wake })
      if (verb === 'files.list') return [guest('Budgets', true), guest('Plan.docx'), guest('Cloud deck.pptx'), guest('~$Plan.docx'), guest('way out', true, { link: true })]
      if (verb === 'files.stat') return guest('Plan.docx')
      throw new Error(`unexpected ${verb}`)
    })
  })
  afterEach(() => {
    setVmCall(null)
    closeFilesState(rig.db)
    rig.close()
  })

  it('lists its places at once from what was kept, asleep with the time it was read, and never calls the VM for it', async () => {
    if (process.platform === 'win32') return
    const got = await call<FilesPlaces>('work.files.places', {})
    const vm = got.places.filter((p) => p.vm)
    expect(vm.map((p) => [p.kind, p.name, p.host, p.state.state, p.state.at])).toEqual([
      ['teams', 'Events', 'Windows VM', 'asleep', 1_700_000_000_000],
      ['teams', 'General', 'Windows VM', 'asleep', 1_700_000_000_000],
      ['onedrive', 'My OneDrive', 'Windows VM', 'asleep', 1_700_000_000_000]
    ])
    // The same place on this host's own disk and in its VM has one key: the window draws it once.
    expect(got.places.filter((p) => p.key === 'esportsstaffgeneral').map((p) => !!p.vm)).toEqual([false, true])
    expect(got.sources.map((s) => [s.kind, s.state])).toEqual([['folders', 'ok'], ['vm', 'ok']])
    expect(calls).toEqual([])
  })

  it('gives a remote key the VM\'s places, and a thread only where its workspace turns the VM on', async () => {
    if (process.platform === 'win32') return
    expect((await call<FilesPlaces>('work.files.places', {}, phone)).places.filter((p) => p.vm)).toHaveLength(3)
    expect((await call<FilesPlaces>('work.files.places', {}, thread('t1'))).places.filter((p) => p.vm)).toHaveLength(0)
    rig.settings.set(WS, { windowsVm: true })
    expect((await call<FilesPlaces>('work.files.places', {}, thread('t1'))).places.filter((p) => p.vm)).toHaveLength(3)
  })

  it('lists a folder there through the helper, sorted and keyed as any library folder, hidden names and links left out, and asks once for the pages of one scroll', async () => {
    if (process.platform === 'win32') return
    const got = await call<FilesListing>('work.files.list', { at: at(`${TOP}\\General`) })
    expect(got.entries.map((e) => [e.name, e.kind, e.key, e.local])).toEqual([
      ['Budgets', 'folder', 'lib:esportsstaffgeneral:Budgets', undefined],
      ['Cloud deck.pptx', 'deck', 'lib:esportsstaffgeneral:Cloud deck.pptx', false],
      ['Plan.docx', 'document', 'lib:esportsstaffgeneral:Plan.docx', true]
    ])
    expect(got.entries[0]!.folder).toEqual(at(`${TOP}\\General\\Budgets`))
    expect(got.trail!.map((c) => c.name)).toEqual(['General'])
    expect(got.asOf).toBe(1_700_000_000_000)
    await call<FilesListing>('work.files.list', { at: at(`${TOP}\\General`), sort: { by: 'name', dir: 'desc' } })
    expect(calls.filter((c) => c.verb === 'files.list')).toHaveLength(1)
    // A path outside OneDrive's mounts never reaches the helper.
    await expect(call('work.files.list', { at: at('C:\\Users\\tcuser\\Desktop') })).rejects.toThrow("That is not in this workspace's folder or a library it may use.")
    expect(calls.filter((c) => c.verb === 'files.list')).toHaveLength(1)
  })

  it('looks at one row there again, and says a file there opens as a copy or in its app', async () => {
    if (process.platform === 'win32') return
    const got = await call<{ entries: (FileEntry | null)[] }>('work.files.stat', { refs: [at(`${TOP}\\General\\Plan.docx`)] })
    expect(got.entries[0]).toMatchObject({ name: 'Plan.docx', shared: true, key: 'lib:esportsstaffgeneral:Plan.docx', ref: at(`${TOP}\\General\\Plan.docx`) })
    await expect(call('work.files.open', { ref: at(`${TOP}\\General\\Plan.docx`) })).rejects.toThrow('Plan.docx is in the Windows VM: it opens as a copy, or in its app there.')
    expect(HOST).toBe('env_box')
  })
})
