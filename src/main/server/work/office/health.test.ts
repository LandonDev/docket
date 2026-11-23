import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OfficeAppState, TeamsLibrary } from '@shared/contract-work-office'
import type { WorkCtx } from '../modules'
import { AddinKeys, ensureAddinTables } from './addin/keys'
import { ensureFilesTables, setRoots } from './files/library'
import { officeProbe, officeRows, parseTasklist, vmRows, windowsOffice, type OfficeProbe } from './health'
import { lastReadFailure, readingVm, refreshVm } from './vm/files'
import { setVmCall, VmUnreachable } from './vm/link'
import { setVmState } from './vm/office'

/** Connections' office rows: each app, the add-in and OneDrive, read from a probe that starts nothing. */
const signal = new AbortController().signal
const app = (a: OfficeAppState['app'], o: Partial<OfficeAppState> = {}): OfficeAppState => ({ app: a, installed: true, running: false, allowed: 'unknown', ...o })
const lib = (o: Partial<TeamsLibrary> = {}): TeamsLibrary => ({ id: 'h~1', host: 'env_mac', path: '/x', team: 'Esports', library: null, tenant: 'Purdue University', kind: 'channels', channels: [], web: null, found: true, ...o })

function probe(o: Partial<OfficeProbe> & { addinState?: ReturnType<OfficeProbe['addin']> } = {}): OfficeProbe {
  return {
    platform: 'darwin',
    host: 'env_mac',
    apps: async () => [app('excel', { running: true, allowed: 'yes' }), app('word', { installed: false }), app('powerpoint', { installed: false }), app('outlook', { running: true })],
    outlookProblem: async () => null,
    route: () => ({ accounts: ['ajohnson@purdue.edu'], error: null }),
    addin: () => o.addinState ?? { paired: 0, holds: false, sideloaded: [] },
    oneDrive: async () => ({ installed: true, running: true }),
    libraries: () => [],
    gone: () => [],
    ...o
  }
}
const byId = (rows: Awaited<ReturnType<typeof officeRows>>) => Object.fromEntries(rows.map((r) => [r.id, r]))

describe('the Office apps', () => {
  it('rows each installed app, leaves out the rest, and says who Outlook is signed in as', async () => {
    const rows = byId(await officeRows(probe(), signal))
    expect(Object.keys(rows)).toEqual(['office.app:excel', 'office.app:outlook'])
    expect(rows['office.app:excel']).toMatchObject({ group: 'Office', title: 'Excel', state: 'working', line: 'Open' })
    expect(rows['office.app:outlook']).toMatchObject({ state: 'working', line: 'Open, signed in as ajohnson@purdue.edu' })
  })

  it('says New Outlook needs him, by hand, with no button', async () => {
    const rows = byId(await officeRows(probe({ outlookProblem: async () => 'New Outlook does not answer scripts' }), signal))
    expect(rows['office.app:outlook']).toMatchObject({ state: 'needs-you', line: expect.stringContaining("Turn off New Outlook in Outlook's menu") })
    expect(rows['office.app:outlook']!.fix).toBeUndefined()
  })

  it('reads a refused app as broken and a pending prompt as his', async () => {
    const apps = async () => [app('excel', { allowed: 'no' }), app('word', { allowed: 'ask' })]
    const rows = byId(await officeRows(probe({ apps }), signal))
    expect(rows['office.app:excel']).toMatchObject({ state: 'broken', line: expect.stringContaining('Privacy & Security → Automation') })
    expect(rows['office.app:word']).toMatchObject({ state: 'needs-you', line: expect.stringContaining('prompt') })
  })

  it("names the system's prompt an app waits behind, as his one press on the Mac", async () => {
    const rows = byId(await officeRows(probe({ apps: async () => [app('excel', { running: true, waiting: 'Microsoft Excel is waiting for the owner on this Mac' })] }), signal))
    expect(rows['office.app:excel']).toMatchObject({ state: 'needs-you', line: 'On the Mac, press Allow where macOS asks whether Excel may access files managed by OneDrive.' })
    expect(rows['office.app:excel']!.fix).toBeUndefined()
  })

  it("shows the route's failure on Outlook", async () => {
    const rows = byId(await officeRows(probe({ route: () => ({ accounts: [], error: 'LifeOS did not answer' }) }), signal))
    expect(rows['office.app:outlook']).toMatchObject({ state: 'broken', line: 'LifeOS did not answer' })
  })

  it('leaves the apps and files out on a host with no desktop Office', async () => {
    const rows = await officeRows(probe({ platform: 'linux', libraries: () => [lib()] }), signal)
    expect(rows).toEqual([])
  })

  it('reads Windows from the disk and the process list, New Outlook included', () => {
    const env = { ProgramFiles: 'C:\\PF', LOCALAPPDATA: 'C:\\L' }
    const on = new Set([join('C:\\PF', 'Microsoft Office', 'root', 'Office16', 'EXCEL.EXE'), join('C:\\L', 'Microsoft', 'WindowsApps', 'olk.exe')])
    const got = windowsOffice(env, (p) => on.has(p), new Set(['excel.exe', 'olk.exe']))
    expect(got.newOutlook).toBe(true)
    expect(got.apps.filter((a) => a.installed).map((a) => [a.app, a.running])).toEqual([
      ['excel', true],
      ['outlook', false]
    ])
    const classic = windowsOffice(env, (p) => p.endsWith('OUTLOOK.EXE'), new Set(['outlook.exe']))
    expect(classic).toMatchObject({ newOutlook: false, apps: expect.arrayContaining([{ app: 'outlook', installed: true, running: true, allowed: 'unknown' }]) })
    expect(parseTasklist('"EXCEL.EXE","12","Console","1","90 K"\r\n"olk.exe","13","Console","1","9 K"\r\n')).toEqual(new Set(['excel.exe', 'olk.exe']))
  })
})

describe('the add-in', () => {
  it('is left out where nothing of it is', async () => {
    expect((await officeRows(probe(), signal)).some((r) => r.id === 'office.addin')).toBe(false)
  })

  it('asks him to pair on the host that holds add-ins, through Settings', async () => {
    const rows = byId(await officeRows(probe({ platform: 'linux', addinState: { paired: 0, holds: true, sideloaded: [] } }), signal))
    expect(rows['office.addin']).toEqual({ id: 'office.addin', pillar: 'office', group: 'Office', title: 'Office add-in', state: 'needs-you', line: 'Not paired', fix: { kind: 'page', label: 'Pair…', page: 'settings:work' } })
  })

  it('says paired and where it is sideloaded, once, with no key of its own', async () => {
    const rows = byId(await officeRows(probe({ addinState: { paired: 2, holds: false, sideloaded: ['excel', 'word'] } }), signal))
    expect(rows['office.addin']).toMatchObject({ state: 'working', line: 'Paired, sideloaded in Excel and Word' })
    expect(rows['office.addin']!.fix).toBeUndefined()
    const mac = byId(await officeRows(probe({ addinState: { paired: 0, holds: false, sideloaded: ['excel'] } }), signal))
    expect(mac['office.addin']).toMatchObject({ state: 'working', line: 'Sideloaded in Excel' })
  })
})

describe('Teams files', () => {
  it('says OneDrive syncs the libraries, and for whom', async () => {
    const rows = byId(await officeRows(probe({ libraries: () => [lib(), lib({ id: 'h~2' })] }), signal))
    expect(rows['office.files.onedrive']).toMatchObject({ group: 'Files', title: 'OneDrive', state: 'working', line: 'Syncing 2 libraries for Purdue University' })
  })

  it('is broken when OneDrive is closed or gone, and left out when nothing is synced', async () => {
    const closed = byId(await officeRows(probe({ libraries: () => [lib()], oneDrive: async () => ({ installed: true, running: false }) }), signal))
    expect(closed['office.files.onedrive']).toMatchObject({ state: 'broken', line: 'Closed, so the 1 library here does not sync. Open OneDrive.' })
    const gone = byId(await officeRows(probe({ libraries: () => [lib()], oneDrive: async () => ({ installed: false, running: false }) }), signal))
    expect(gone['office.files.onedrive']).toMatchObject({ state: 'broken' })
    expect((await officeRows(probe(), signal)).some((r) => r.group === 'Files')).toBe(false)
  })

  it('names a folder he added that is gone, with the list as its fix', async () => {
    const rows = await officeRows(probe({ gone: () => ['/Users/o/Purdue/Esports - Documents'] }), signal)
    expect(rows.find((r) => r.group === 'Files')).toMatchObject({ title: 'Esports - Documents', state: 'broken', fix: { kind: 'page', page: 'settings:work' } })
  })
})

describe('OneDrive and Office in the Windows VM', () => {
  type Vm = NonNullable<ReturnType<NonNullable<OfficeProbe['vm']>>>
  const vm = (o: Partial<Vm> = {}): Vm => ({ office: { installed: true, version: '16.0', apps: ['excel', 'word', 'powerpoint', 'outlook'], account: null, licensed: false }, onedrive: { kind: 'vm', state: 'signed-out', account: null }, at: 5, libraries: 0, coming: 0, ...o })
  const SIGN_IN = { kind: 'page', label: 'Sign in…', page: 'windows-vm-sign-in' }

  it('asks for his sign-in, one press, while OneDrive is signed out or Office has no licence', async () => {
    const rows = byId(await officeRows(probe({ platform: 'linux', vm: () => vm() }), signal))
    expect(rows['office.vm.onedrive']).toMatchObject({ group: 'Files', title: 'OneDrive on the Windows VM', state: 'needs-you', line: 'Signed out', fix: SIGN_IN })
    expect(rows['office.vm.office']).toMatchObject({ group: 'Office', title: 'Office on the Windows VM', state: 'needs-you', line: 'Excel, Word and PowerPoint are installed. Sign in to finish.', fix: SIGN_IN })
  })

  it('says who is signed in and how much is synced once it works', () => {
    const rows = byId(vmRows(vm({ onedrive: { kind: 'vm', state: 'ok', account: 'him@purdue.edu' }, libraries: 1, office: { installed: true, version: '16.0', apps: ['excel', 'word'], account: 'him@purdue.edu', licensed: true } })))
    expect(rows['office.vm.onedrive']).toMatchObject({ state: 'working', line: 'Signed in as him@purdue.edu, 1 Teams library' })
    expect(rows['office.vm.office']).toMatchObject({ state: 'working', line: 'Excel and Word, signed in as him@purdue.edu' })
    expect(rows['office.vm.onedrive']!.fix).toBeUndefined()
  })

  it('says the libraries asked of OneDrive are on their way, and leaves Office out where it is not installed', () => {
    const rows = byId(vmRows(vm({ onedrive: { kind: 'vm', state: 'no-libraries', account: 'him@purdue.edu' }, coming: 1, office: { installed: false, version: null, apps: [], account: null, licensed: null } })))
    expect(rows['office.vm.onedrive']).toMatchObject({ state: 'working', line: 'Signed in as him@purdue.edu, its libraries are on their way' })
    expect(rows['office.vm.office']).toBeUndefined()
  })

  it("says a helper that did not answer its last read as broken, in the failure's own words", () => {
    const rows = byId(vmRows(vm({ onedrive: { kind: 'vm', state: 'error', account: 'him@purdue.edu', detail: "The Windows VM's Office helper did not answer" } })))
    expect(rows['office.vm.onedrive']).toMatchObject({ state: 'broken', line: "The Windows VM's Office helper did not answer" })
  })

  it('is left out where this host keeps no VM, and until the VM has been read', async () => {
    expect(vmRows(null)).toEqual([])
    expect(vmRows(vm({ at: null }))).toEqual([])
    expect(Object.keys(byId(await officeRows(probe({ platform: 'linux' }), signal)))).toEqual([])
  })
})

describe('the probe on this host', () => {
  let ctx: WorkCtx
  afterEach(() => ctx?.db.close())

  it('counts paired add-ins from the table, holds them only on the tunnel host, and finds a gone folder', () => {
    const db = new DatabaseSync(':memory:')
    ensureAddinTables(db)
    ensureFilesTables(db)
    ctx = { db, host: 'env_box' } as unknown as WorkCtx
    const keys = new AddinKeys(db)
    const { code } = keys.mint()
    const made = keys.pair(code, 'Excel on the web', 'excel')!
    setRoots(db, [{ folder: '/nowhere/at/all' }, { folder: '/also/nowhere', off: true }])
    const p = officeProbe(ctx, () => null, { TEMP_CODE_USER_DATA: '/srv/agents/temp-code-data' })
    expect(p.addin()).toMatchObject({ paired: 1, holds: process.platform === 'linux' })
    expect(p.gone()).toEqual(['/nowhere/at/all'])
    expect(officeProbe(ctx, () => null, { TEMP_CODE_USER_DATA: '/tmp/dev' }).addin().holds).toBe(false)
    // A row says paired, never the key.
    return officeRows(p, signal).then((rows) => expect(JSON.stringify(rows)).not.toContain(made.key))
  })

  it("answers the VM's rows from what was kept while its helper never answers, and reads it behind the check", async () => {
    const db = new DatabaseSync(':memory:')
    ensureAddinTables(db)
    ensureFilesTables(db)
    const pushes: unknown[] = []
    ctx = { db, host: 'env_box', log: () => {}, push: (p: unknown) => pushes.push(p) } as unknown as WorkCtx
    const status = { onedrive: { installed: true, running: true, account: 'him@purdue.edu' }, mounts: [], office: { installed: true, version: '16.0', apps: ['excel'], account: null, licensed: true } }
    setVmState(() => ({ state: 'awake', cannot: null }))
    setVmCall(async () => status)
    await refreshVm(db, { wake: false, now: () => 0 })
    let fail: (err: Error) => void = () => {}
    setVmCall(() => new Promise((_, no) => (fail = no)))
    try {
      const before = byId(await officeRows(officeProbe(ctx, () => null), signal))
      expect(before['office.vm.onedrive']).toMatchObject({ state: 'working', line: 'Signed in as him@purdue.edu, no Teams library synced' })
      expect(readingVm(db)).toBe(true)
      fail(new VmUnreachable("The Windows VM's Office helper did not answer"))
      await vi.waitFor(() => expect(readingVm(db)).toBe(false))
      expect(lastReadFailure(db)).toMatch(/Office helper did not answer/)
      expect(pushes).toEqual([{ push: 'work.office.files' }])
      const after = byId(await officeRows(officeProbe(ctx, () => null), signal))
      expect(after['office.vm.onedrive']).toMatchObject({ state: 'broken', line: expect.stringContaining('Office helper did not answer') })
    } finally {
      fail(new Error('done'))
      setVmCall(null)
      setVmState(null)
    }
  })
})
