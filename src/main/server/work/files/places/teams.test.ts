import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ClientRequestSchema } from '@shared/contract'
import type { FilesListing, FilesOpened, FilesPlaces, FilesTabs } from '@shared/contract-work-files'
import type { TeamsLibrary } from '@shared/contract-work-office'
import { filesPaneOf } from '@shared/work'
import type { FileEntry } from '@shared/work/files'
import type { Caller } from '../../modules'
import { fenceRequest, FenceError } from '../../../remote/fence'
import { setCopyAllowed } from '../../office/files/library'
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

  it('looks at one row there again', async () => {
    if (process.platform === 'win32') return
    const got = await call<{ entries: (FileEntry | null)[] }>('work.files.stat', { refs: [at(`${TOP}\\General\\Plan.docx`)] })
    expect(got.entries[0]).toMatchObject({ name: 'Plan.docx', shared: true, key: 'lib:esportsstaffgeneral:Plan.docx', ref: at(`${TOP}\\General\\Plan.docx`) })
  })

  it('opens a file there as a copy in the pane\'s own folder where the workspace allows one, the tab saying whose copy it is, and never twice', async () => {
    if (process.platform === 'win32') return
    const file = at(`${TOP}\\General\\Deck.pdf`)
    setVmCall(async (verb, args) => {
      calls.push({ verb, args })
      if (verb === 'files.stat') return guest('Deck.pdf', false, { size: 4 })
      if (verb === 'files.read') return { data: Buffer.from('%PDF').toString('base64'), size: 4, eof: true }
      throw new Error(`unexpected ${verb}`)
    })
    // Off, it is refused in the sentence whose press turns it on, and nothing is read.
    await expect(call('work.files.open', { ref: file, key: 'lib:esportsstaffgeneral:Deck.pdf' })).rejects.toThrow('turn on Copy Teams files')
    expect(calls).toEqual([])
    setCopyAllowed(rig.db, WS, true)
    const opened = await call<FilesOpened>('work.files.open', { ref: file, key: 'lib:esportsstaffgeneral:Deck.pdf' })
    expect(opened.item).toMatchObject({ sessionId: filesPaneOf(WS), kind: 'pdf', title: 'Deck.pdf' })
    const copy = (opened.item!.source as { path: string }).path
    expect(copy.startsWith(join(rig.dataDir, 'attachments', 'teams-files', filesPaneOf(WS)))).toBe(true)
    expect(readFileSync(copy, 'utf8')).toBe('%PDF')
    expect(opened.tabs).toMatchObject([{ id: opened.tabId, kind: 'file', name: 'Deck.pdf', key: 'lib:esportsstaffgeneral:Deck.pdf', copyOf: { host: HOST, path: `${TOP}\\General\\Deck.pdf`, vm: true } }])
    // Opened again it is the same tab, and the guest is not read again.
    const reads = calls.length
    expect((await call<FilesOpened>('work.files.open', { ref: file, key: 'lib:esportsstaffgeneral:Deck.pdf' })).tabId).toBe(opened.tabId)
    expect(calls).toHaveLength(reads)
    // A path outside OneDrive's mounts is refused before any byte moves.
    await expect(call('work.files.open', { ref: at('C:\\Users\\tcuser\\Desktop\\secret.pdf') })).rejects.toThrow("That is not in this workspace's folder or a library it may use.")
    // Text there opens as the file kind on its copy, read only: every file opens.
    const text = await call<FilesOpened>('work.files.open', { ref: at(`${TOP}\\General\\notes.txt`) })
    expect(text.item).toMatchObject({ kind: 'file' })
    expect(text.tabs.find((t) => t.id === text.tabId)?.copyOf).toMatchObject({ vm: true })
  })

  it("opens a file on another host of his as a copy fetched over that host's link, and refuses a thread and a peer the tab", async () => {
    const far = { at: 'file' as const, host: 'env_mac', path: '/Users/l/Library/CloudStorage/OneDrive-Dummy U/General/Budget.xlsx' }
    setCopyAllowed(rig.db, WS, true)
    const asked: unknown[] = []
    const peer = function (this: unknown, host: string) {
      return { call: async (module: string, verb: string, args: unknown) => (asked.push({ host, module, verb, args, as: (this as { scope: unknown }).scope }), { name: 'Budget.xlsx', data: Buffer.from('workbook').toString('base64') }) }
    }
    const ctx = { ...rig.ctx, peer } as typeof rig.ctx
    const out = await files.handle!({ id: '1', method: 'work.files.open', params: { workspaceId: WS, ref: far, key: 'lib:esportsstaffgeneral:Budget.xlsx' } } as never, ctx, window)
    const opened = (out as { result: FilesOpened }).result
    expect(asked).toEqual([{ host: 'env_mac', module: 'office', verb: 'filesRead', args: { source: far, as: 'bytes' }, as: { sessionId: filesPaneOf(WS), workspaceId: WS } }])
    expect(opened.item).toMatchObject({ kind: 'sheet', title: 'Budget.xlsx', source: { at: 'file', host: HOST } })
    expect(opened.tabs[0]).toMatchObject({ copyOf: { host: 'env_mac', path: far.path }, key: 'lib:esportsstaffgeneral:Budget.xlsx' })
    expect(opened.tabs[0]!.copyOf!.vm).toBeUndefined()
    await expect(files.handle!({ id: '1', method: 'work.files.open', params: { workspaceId: WS, ref: far } } as never, ctx, thread('t1'))).rejects.toThrow('the tabs of Files are his own')
    // Closing the tab tells the office pillar, which drops the copy.
    const closed = rig.removed.length
    await call('work.files.tabClose', { tabId: opened.tabId })
    expect(rig.removed.length).toBe(closed + 1)
    expect(rig.removed.at(-1)![0]!.source).toEqual(opened.item!.source)
  })

  it("opens a Mac's files one after another from a remote key's window, and the first again, with no refusal at the fence or the handler", async () => {
    // His window reaches the workspace's host as a remote key; the library is on his Mac. Each request is the fence's first (as the listener asks it), then the handler's.
    const BOX = HOST
    const MAC = 'env_1gP-MhkVVRaMwHbVCysYow'
    const lib = '/Users/l/Library/CloudStorage/OneDrive-Dummy U/Esports Staff - Documents/General'
    setCopyAllowed(rig.db, WS, true)
    const asked: string[] = []
    const peer = function (this: unknown, host: string) {
      return { call: async (_module: string, _verb: string, args: { source: { path: string } }) => (asked.push(`${host}:${args.source.path}`), { name: args.source.path.slice(args.source.path.lastIndexOf('/') + 1), data: Buffer.from('bytes').toString('base64') }) }
    }
    // A key's roots in the app are the workspaces' folders and the data folder's attachments (index.ts `managedRoots`), where a copy is kept.
    const roots = [rig.folder, join(rig.dataDir, 'attachments')]
    const reaches: typeof rig.ctx.reaches = (by, path) => by.kind !== 'remote' || roots.some((root) => path === root || path.startsWith(`${root}/`))
    const ctx = { ...rig.ctx, peer, reaches } as typeof rig.ctx
    const key: Caller = { kind: 'remote', caps: ['read', 'operate', 'approve'] }
    const open = async (name: string): Promise<FilesOpened> => {
      const req = ClientRequestSchema.parse({ id: '1', method: 'work.files.open', params: { workspaceId: WS, ref: { at: 'file', host: MAC, path: `${lib}/${name}` }, name, key: `lib:esportsstaffgeneral:${name}` } })
      fenceRequest(req, roots, [], [], BOX)
      return ((await files.handle!(req, ctx, key)) as { result: FilesOpened }).result
    }
    const deck = await open('Sponsor deck.pptx')
    const pdf = await open('Ballroom contract.pdf')
    const sheet = await open('Budget.xlsx')
    expect([deck.item!.kind, pdf.item!.kind, sheet.item!.kind]).toEqual(['slides', 'pdf', 'sheet'])
    expect(sheet.tabs.map((t) => t.name)).toEqual(['Sponsor deck.pptx', 'Ballroom contract.pdf', 'Budget.xlsx'])
    // The first again is its tab again: nothing is copied twice.
    const again = await open('Sponsor deck.pptx')
    expect(again.tabId).toBe(deck.tabId)
    expect(asked).toEqual([`${MAC}:${lib}/Sponsor deck.pptx`, `${MAC}:${lib}/Ballroom contract.pdf`, `${MAC}:${lib}/Budget.xlsx`])
    // The same key naming the file's threads, a star and a tab on the Mac's folder passes too.
    for (const [method, params] of [
      ['work.files.threads', { ref: { at: 'file', host: MAC, path: `${lib}/Budget.xlsx` } }],
      ['work.files.star', { ref: { at: 'file', host: MAC, path: `${lib}/Budget.xlsx` }, name: 'Budget.xlsx', on: true }],
      ['work.files.tabOpen', { page: { at: { at: 'file', host: MAC, path: lib }, name: 'General' } }]
    ] as [string, Record<string, unknown>][]) {
      const req = ClientRequestSchema.parse({ id: '1', method, params: { workspaceId: WS, ...params } })
      expect(() => fenceRequest(req, roots, [], [], BOX), method).not.toThrow()
      await expect(files.handle!(req, ctx, key), method).resolves.toMatchObject({ handled: true })
    }
  })

  it("opens the Windows VM's files one after another from a remote key's window, and the first again, with no refusal", async () => {
    if (process.platform === 'win32') return
    setCopyAllowed(rig.db, WS, true)
    setVmCall(async (verb, args) => {
      calls.push({ verb, args })
      const path = (args as { path: string }).path
      if (verb === 'files.stat') return guest(path.slice(path.lastIndexOf('\\') + 1), false, { size: 5 })
      if (verb === 'files.read') return { data: Buffer.from('bytes').toString('base64'), size: 5, eof: true }
      throw new Error(`unexpected ${verb}`)
    })
    const roots = [rig.folder, join(rig.dataDir, 'attachments')]
    const reaches: typeof rig.ctx.reaches = (by, path) => by.kind !== 'remote' || roots.some((root) => path === root || path.startsWith(`${root}/`))
    const ctx = { ...rig.ctx, reaches } as typeof rig.ctx
    const key: Caller = { kind: 'remote', caps: ['read', 'operate', 'approve'] }
    const open = async (name: string): Promise<FilesOpened> => {
      const req = ClientRequestSchema.parse({ id: '1', method: 'work.files.open', params: { workspaceId: WS, ref: at(`${TOP}\\General\\${name}`), name, key: `lib:esportsstaffgeneral:${name}` } })
      // A guest path is no path of this host's disk: the listener passes it for this verb, and the handler holds it to OneDrive's mounts.
      fenceRequest(req, roots, [], [], HOST)
      return ((await files.handle!(req, ctx, key)) as { result: FilesOpened }).result
    }
    const deck = await open('Sponsor deck.pptx')
    const pdf = await open('Ballroom contract.pdf')
    const sheet = await open('Budget.xlsx')
    expect([deck.item!.kind, pdf.item!.kind, sheet.item!.kind]).toEqual(['slides', 'pdf', 'sheet'])
    expect(sheet.tabs.map((t) => [t.name, t.copyOf?.vm])).toEqual([['Sponsor deck.pptx', true], ['Ballroom contract.pdf', true], ['Budget.xlsx', true]])
    const reads = calls.filter((c) => c.verb === 'files.read').length
    expect((await open('Sponsor deck.pptx')).tabId).toBe(deck.tabId)
    expect(calls.filter((c) => c.verb === 'files.read')).toHaveLength(reads)
  })

  it("never reads this host's disk for a file that claims another host: the claim goes to that host, and a tab's key answers only its own file", async () => {
    const MAC = 'env_1gP-MhkVVRaMwHbVCysYow'
    setCopyAllowed(rig.db, WS, true)
    const secret = join(rig.outside, 'secret.txt')
    const asked: string[] = []
    const peer = function (this: unknown, host: string) {
      return {
        call: async (_module: string, _verb: string, args: { source: { path: string } }) => {
          asked.push(`${host}:${args.source.path}`)
          // The Mac holds no such file in a library it syncs: its own fence refuses.
          throw new Error("That is not in a library this host syncs.")
        }
      }
    }
    const ctx = { ...rig.ctx, peer } as typeof rig.ctx
    const key: Caller = { kind: 'remote', caps: ['read', 'operate', 'approve'] }
    const req = ClientRequestSchema.parse({ id: '1', method: 'work.files.open', params: { workspaceId: WS, ref: { at: 'file', host: MAC, path: secret } } })
    // The fence passes it as the Mac's to judge; the handler sends it there and makes nothing here.
    expect(() => fenceRequest(req, [rig.folder], [], [], HOST)).not.toThrow()
    await expect(files.handle!(req, ctx, key)).rejects.toThrow('not in a library')
    expect(asked).toEqual([`${MAC}:${secret}`])
    expect((await call<FilesTabs>('work.files.tabs', {})).tabs).toEqual([])
    // The same path by this host's own id, or by no host's, is this host's, and stays fenced.
    for (const host of [HOST, undefined]) {
      const mine = { id: '1', method: 'work.files.open', params: { workspaceId: WS, ref: { at: 'file', ...(host ? { host } : {}), path: secret } } }
      expect(() => fenceRequest(mine as never, [rig.folder], [], [], HOST)).toThrow(FenceError)
    }
    // A local file's tab is not shown to a key that names its key beside some other host's file.
    const local = await call<FilesOpened>('work.files.open', { ref: at(join(rig.folder, 'Budget.xlsx')) })
    const steal = ClientRequestSchema.parse({ id: '1', method: 'work.files.open', params: { workspaceId: WS, ref: { at: 'file', host: MAC, path: '/x/y.pdf' }, key: local.tabs[0]!.key } })
    await expect(files.handle!(steal, ctx, key)).rejects.toThrow('That key names another file that is open.')
  })
})
