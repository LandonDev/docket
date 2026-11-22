import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClientRequest } from '@shared/contract'
import type { TeamsEntry, TeamsLibrariesAnswer, TeamsLibrary, VmOfficeStatus } from '@shared/contract-work-office'
import type { Caller, ToolCtx, WorkCtx, WorkTool } from '../../modules'
import { FakeOffice } from '../fake'
import { copyDirOf } from '../files/handle'
import { setCloudDir } from '../files/library'
import { teamsTools, twinOf } from '../files/tools'
import { office as module, setCarrier } from '../index'
import { forgetAsked, guestWithin, isGuestPath, missingLibraries, refreshVm, storedStatus, vmLibraries, vmLibraryOf, vmPlace } from './files'
import { setVmCall, VmAsleep, VmUnreachable, type VmCall } from './link'
import { setVmState } from './office'

/**
 * Teams files in the Windows VM over a stand-in guest: a tree of files as OneDrive lays them out
 * under Windows (his own files, a site's whole Documents library, one cloud-only), answered by the
 * helper's verbs. The wire, the tools and the fence are the real ones.
 */

const MINE = 'C:\\Users\\tcuser\\OneDrive - Purdue University'
const REC = 'C:\\Users\\tcuser\\Purdue University\\RecWell - Documents'
const SITE = 'C:\\Users\\tcuser\\Purdue University\\Esports - Site Policies'

interface Node {
  dir?: true
  text?: string
  bytes?: Buffer
  local?: boolean
  modified?: number
}

class Guest {
  account: string | null = 'him@purdue.edu'
  office = { installed: true, version: '16.0', apps: ['excel', 'word', 'powerpoint'], account: null as string | null, licensed: false as boolean | null }
  awake = true
  /** every verb asked, in order */
  asked: string[] = []
  opened: string[] = []
  freed: string[] = []
  synced: Record<string, unknown>[] = []
  mounts = [
    { path: MINE, type: 'mine' as const, web: null },
    { path: REC, type: 'team' as const, web: 'https://purdue0.sharepoint.com/sites/RecWell/Shared Documents/' },
    { path: SITE, type: 'team' as const, web: null }
  ]
  tree = new Map<string, Node>([
    [`${REC}\\Team RecWell`, { dir: true }],
    [`${REC}\\Sport Programs`, { dir: true }],
    [`${REC}\\Team RecWell\\notes.txt`, { text: 'kickoff at 5', modified: 30 }],
    [`${REC}\\Team RecWell\\Budget.xlsx`, { bytes: Buffer.from('xlsx'), modified: 20 }],
    [`${REC}\\Team RecWell\\Cloud.pdf`, { bytes: Buffer.alloc(2000), local: false, modified: 10 }],
    [`${REC}\\Team RecWell\\~$Budget.xlsx`, { text: 'lock' }],
    [`${REC}\\Team RecWell\\desktop.ini`, { text: '' }],
    [`${SITE}\\Rules.txt`, { text: 'no smoking' }]
  ])
  private bytesOf = (n: Node): Buffer => n.bytes ?? Buffer.from(n.text ?? '')
  private entry = (path: string, n: Node) => ({ name: path.slice(path.lastIndexOf('\\') + 1), path, dir: !!n.dir, size: n.dir ? 0 : this.bytesOf(n).length, modified: n.modified ?? 1, local: n.local ?? true, link: false, pinned: false })
  private need(path: unknown): [string, Node] {
    const n = this.tree.get(path as string)
    if (!n) throw new Error(`No file ${String(path)}.`)
    return [path as string, n]
  }
  call: VmCall = async (verb, args = {}, opts = {}) => {
    this.asked.push(verb)
    if (!this.awake) {
      if (opts.wake === false) throw new VmAsleep()
      throw new VmUnreachable('Windows did not come up within 300 s')
    }
    switch (verb) {
      case 'guest.status':
        return { onedrive: { installed: true, running: true, account: this.account }, mounts: this.account ? this.mounts : [], office: this.office }
      case 'files.list': {
        const dir = args.dir as string
        return [...this.tree].filter(([p]) => p.startsWith(`${dir}\\`) && !p.slice(dir.length + 1).includes('\\')).map(([p, n]) => this.entry(p, n))
      }
      case 'files.stat':
        return this.entry(...this.need(args.path))
      case 'files.search': {
        const words = args.words as string[]
        const exts = (args.exts as string[] | undefined) ?? []
        const hits = [...this.tree]
          .filter(([p]) => (args.roots as string[]).some((r) => p.startsWith(`${r}\\`)))
          .filter(([p]) => words.every((w) => p.slice(p.lastIndexOf('\\') + 1).toLowerCase().includes(w)))
          .filter(([p, n]) => {
            const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase()
            return args.only === 'folder' ? !!n.dir : args.only === 'exts' ? !n.dir && exts.includes(ext) : args.only === 'other' ? !n.dir && !exts.includes(ext) : true
          })
          .map(([p, n]) => ({ ...this.entry(p, n), root: (args.roots as string[]).find((r) => p.startsWith(`${r}\\`)) }))
        return { hits, more: false }
      }
      case 'files.read': {
        const [, n] = this.need(args.path)
        n.local = true
        const all = this.bytesOf(n)
        const from = (args.offset as number) ?? 0
        const part = all.subarray(from, from + ((args.length as number) ?? all.length))
        return { data: part.toString('base64'), size: all.length, eof: from + part.length >= all.length }
      }
      case 'files.fetch': {
        const [p, n] = this.need(args.path)
        n.local = true
        return this.entry(p, n)
      }
      case 'files.free':
        this.freed.push(args.path as string)
        return true
      case 'files.open':
        this.opened.push(args.path as string)
        return null
      case 'onedrive.sync':
        this.synced.push(args)
        return null
    }
    throw new Error(`the stand-in guest has no ${verb}`)
  }
}

let base: string
let guest: Guest
let box: WorkCtx
let vm: { state: string; cannot: string | null } | null
const window: Caller = { kind: 'local', caps: ['read', 'operate', 'approve', 'admin'] }
const scope = { sessionId: 's1', workspaceId: 'w1', sector: 'purdue', host: 'env_box', away: false, routineRunId: null, shared: () => true }
let settings: { mayUseDesktop: string[]; windowsVm?: boolean }
const call = (method: string, params: unknown, by: Caller = window, ctx: WorkCtx = box) => module.handle!({ id: '1', method, params } as unknown as ClientRequest, ctx, by).then((a) => (a as { result: unknown }).result as never)
const file = (path: string) => ({ source: { at: 'file', host: 'env_box', path } })

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'teams-vm-'))
  guest = new Guest()
  setVmCall(guest.call)
  vm = { state: 'awake', cannot: null }
  setVmState(() => vm)
  setCloudDir(() => join(base, 'no-cloud'))
  setCarrier(() => new FakeOffice())
  forgetAsked()
  settings = { mayUseDesktop: [], windowsVm: true }
  const db = new DatabaseSync(':memory:')
  module.ensure(db)
  box = { db, host: 'env_box', dataDir: join(base, 'data'), log: () => {}, reaches: () => false, scopeOf: () => scope, settings: { workspace: () => settings } } as unknown as WorkCtx
})
afterEach(() => {
  setVmCall(null)
  setVmState(null)
  rmSync(base, { recursive: true, force: true })
})

describe("the VM's libraries", () => {
  it("lists what OneDrive syncs in the guest as this host's libraries: his files, a site's Documents with its top folders, another library", async () => {
    const got = (await call('work.office.filesLibraries', {})) as TeamsLibrariesAnswer
    expect(got.libraries.map((l) => [l.team, l.library, l.kind, l.channels, l.vm, l.host, l.tenant])).toEqual([
      ['Esports', 'Site Policies', 'library', [], true, 'env_box', 'Purdue University'],
      ['My files', null, 'mine', [], true, 'env_box', 'Purdue University'],
      ['RecWell', null, 'channels', ['Sport Programs', 'Team RecWell'], true, 'env_box', 'Purdue University']
    ])
    expect(got.libraries.find((l) => l.team === 'RecWell')!.web).toBe('https://purdue0.sharepoint.com/sites/RecWell/Shared Documents/')
    expect(got.places).toEqual([{ kind: 'vm', state: 'ok', account: 'him@purdue.edu' }])
  })

  it('answers a sleeping machine from what it kept, and never wakes it for a list', async () => {
    await call('work.office.filesLibraries', {})
    guest.awake = false
    vm = { state: 'asleep', cannot: null }
    guest.asked = []
    const got = (await call('work.office.filesLibraries', {})) as TeamsLibrariesAnswer
    expect(got.libraries).toHaveLength(3)
    expect(guest.asked).toEqual([])
  })

  it('wakes a machine that has never been read, once, to learn what it holds', async () => {
    vm = { state: 'asleep', cannot: null }
    const got = (await call('work.office.filesLibraries', {})) as TeamsLibrariesAnswer
    expect(guest.asked[0]).toBe('guest.status')
    expect(got.libraries).toHaveLength(3)
  })

  it('says what stands in the way: not set up, signed out, signed in with nothing synced, never read and out of reach', async () => {
    expect(vmPlace(box.db, { state: 'none', cannot: null })).toEqual({ kind: 'vm', state: 'not-set-up', account: null })
    expect(vmPlace(box.db, { state: 'none', cannot: 'not the box' })).toBeNull()
    expect(vmPlace(box.db, null)).toBeNull()
    guest.account = null
    expect(((await call('work.office.filesLibraries', {})) as TeamsLibrariesAnswer).places).toEqual([{ kind: 'vm', state: 'signed-out', account: null }])
    // folders an earlier sign-in left listed do not make it signed in
    await box.db.prepare("UPDATE work_office_files SET value = json_set(value, '$.status.mounts', json(?)) WHERE key = 'vm:status'").run(JSON.stringify(guest.mounts))
    expect(vmPlace(box.db, vm)).toEqual({ kind: 'vm', state: 'signed-out', account: null })
    expect(vmLibraries(box.db, 'env_box')).toHaveLength(3)
    guest.account = 'him@purdue.edu'
    guest.mounts = guest.mounts.filter((m) => m.type === 'mine')
    await refreshVm(box.db, { wake: true })
    expect(vmPlace(box.db, vm)).toEqual({ kind: 'vm', state: 'no-libraries', account: 'him@purdue.edu' })
    const fresh = new DatabaseSync(':memory:')
    module.ensure(fresh)
    guest.awake = false
    const answer = (await call('work.office.filesLibraries', {}, window, { ...box, db: fresh } as WorkCtx)) as TeamsLibrariesAnswer
    expect(answer.libraries).toEqual([])
    expect(answer.places![0]).toMatchObject({ kind: 'vm', state: 'error' })
  })

  it("leaves the VM out for a thread whose workspace has not turned it on, and for a Work Chat", async () => {
    await call('work.office.filesLibraries', {})
    const thread: Caller = { kind: 'model', caps: [], sessionId: 's1' }
    expect(((await call('work.office.filesLibraries', {}, thread)) as TeamsLibrariesAnswer).libraries).toHaveLength(3)
    settings = { mayUseDesktop: [], windowsVm: false }
    expect(((await call('work.office.filesLibraries', {}, thread)) as TeamsLibrariesAnswer).libraries).toEqual([])
    await expect(call('work.office.filesList', file(REC), thread)).rejects.toThrow('may not use the Windows VM')
  })

  it("reports Office and OneDrive in the VM as last read, without waking it", async () => {
    expect(((await call('work.office.vmStatus', {})) as VmOfficeStatus).office).toBeNull()
    await call('work.office.filesLibraries', {})
    guest.asked = []
    const status = (await call('work.office.vmStatus', {})) as VmOfficeStatus
    expect(status.office).toMatchObject({ installed: true, apps: ['excel', 'word', 'powerpoint'], licensed: false })
    expect(status.onedrive).toMatchObject({ state: 'ok', account: 'him@purdue.edu' })
    expect(guest.asked).toEqual([])
  })
})

describe('the fence for a guest path', () => {
  it('knows a guest path by its drive and backslashes', () => {
    expect(isGuestPath('C:\\Users\\tcuser\\x')).toBe(true)
    expect(isGuestPath('/Users/him/x')).toBe(false)
    expect(guestWithin('c:\\users\\TCUSER\\a\\b', 'C:\\Users\\tcuser\\a')).toBe(true)
    expect(guestWithin('C:\\Users\\tcuser\\ab', 'C:\\Users\\tcuser\\a')).toBe(false)
  })

  it('admits only a path inside a library OneDrive syncs there: no step up, no other separator, no trailing dot or space', async () => {
    await call('work.office.filesLibraries', {})
    const libs = vmLibraries(box.db, 'env_box')
    expect(vmLibraryOf(libs, `${REC}\\Team RecWell\\notes.txt`)?.library.team).toBe('RecWell')
    expect(vmLibraryOf(libs, `${REC.toLowerCase()}\\team recwell`)?.library.team).toBe('RecWell')
    for (const bad of [`${REC}\\..\\..\\NTUSER.DAT`, `${REC}\\Team RecWell/../../x`, 'C:\\Users\\tcuser\\Documents\\x.txt', `${REC}\\a.\\b`, `${REC}\\a \\b`, 'C:\\Windows']) expect(vmLibraryOf(libs, bad), bad).toBeNull()
    await expect(call('work.office.filesRead', file('C:\\Users\\tcuser\\NTUSER.DAT'))).rejects.toThrow('not in a Teams folder')
    await expect(call('work.office.filesList', file(`${REC}\\..\\..`))).rejects.toThrow('not in a Teams folder')
  })

  it("lets his own remote window read a VM library, which is no path of this host's disk, and sends its bytes to no caller", async () => {
    await call('work.office.filesLibraries', {})
    const key: Caller = { kind: 'remote', caps: ['read', 'operate'] }
    await expect(call('work.office.filesList', file(`${REC}\\Team RecWell`), key)).resolves.toMatchObject({ entries: expect.any(Array) })
    await expect(call('work.office.filesRead', { ...file(`${REC}\\Team RecWell\\notes.txt`), as: 'bytes' }, { ...key, peer: 'env_mac' })).rejects.toThrow('bytes go to no caller')
  })
})

describe('a folder, a search, a file', () => {
  beforeEach(() => call('work.office.filesLibraries', {}))

  it('lists folders first, hides lock and system files, and marks a file OneDrive keeps in the cloud', async () => {
    const { entries } = (await call('work.office.filesList', file(`${REC}\\Team RecWell`))) as { entries: TeamsEntry[] }
    expect(entries.map((e) => [e.name, e.kind, e.local, e.size])).toEqual([
      ['Budget.xlsx', 'workbook', true, 4],
      ['Cloud.pdf', 'pdf', false, 2000],
      ['notes.txt', 'text', true, 12]
    ])
    const top = (await call('work.office.filesList', file(REC))) as { entries: TeamsEntry[] }
    expect(top.entries.map((e) => [e.name, e.kind])).toEqual([
      ['Sport Programs', 'folder'],
      ['Team RecWell', 'folder']
    ])
  })

  it('searches names in the guest, by kind, newest first, over the VM and this host together', async () => {
    const all = (await call('work.office.filesSearch', { query: 'e' })) as { entries: TeamsEntry[] }
    expect(all.entries.map((e) => e.name)).toEqual(['notes.txt', 'Budget.xlsx', 'Team RecWell', 'Rules.txt'].filter((n) => all.entries.some((e) => e.name === n)))
    const books = (await call('work.office.filesSearch', { query: 'budget', kind: 'workbook' })) as { entries: TeamsEntry[] }
    expect(books.entries.map((e) => [e.name, e.library])).toEqual([['Budget.xlsx', vmLibraries(box.db, 'env_box').find((l) => l.team === 'RecWell')!.id]])
    const folders = (await call('work.office.filesSearch', { query: 'recwell', kind: 'folder' })) as { entries: TeamsEntry[] }
    expect(folders.entries.map((e) => e.name)).toEqual(['Team RecWell'])
  })

  it('downloads a cloud-only file through the guest', async () => {
    const { entry } = (await call('work.office.filesFetch', file(`${REC}\\Team RecWell\\Cloud.pdf`))) as { entry: TeamsEntry }
    expect(entry).toMatchObject({ name: 'Cloud.pdf', local: true })
  })

  it("reads a text file's head, refuses a workbook and a PDF in the usual words, and sends a file it downloaded only for the read back to the cloud", async () => {
    await expect(call('work.office.filesRead', file(`${REC}\\Team RecWell\\notes.txt`))).resolves.toEqual({ name: 'notes.txt', text: 'kickoff at 5', truncated: false })
    await expect(call('work.office.filesRead', file(`${REC}\\Team RecWell\\Budget.xlsx`))).rejects.toThrow('office_range_read')
    expect(guest.freed).toEqual([])
    await expect(call('work.office.filesRead', file(`${REC}\\Team RecWell\\Cloud.pdf`))).rejects.toThrow('pdf tools')
    await new Promise((r) => setTimeout(r, 5))
    expect(guest.freed).toEqual([`${REC}\\Team RecWell\\Cloud.pdf`])
  })

  it("opens a file in its app on the VM's desktop: an Office file through the VM's carrier, anything else by Windows", async () => {
    await call('work.office.filesOpen', file(`${REC}\\Team RecWell\\Cloud.pdf`))
    expect(guest.opened).toEqual([`${REC}\\Team RecWell\\Cloud.pdf`])
    await expect(call('work.office.filesOpen', file(`${REC}\\Team RecWell`))).rejects.toThrow('folder')
  })

  it('a machine that cannot be reached says so in words that start the same way', async () => {
    guest.awake = false
    await expect(call('work.office.filesList', file(REC))).rejects.toThrow(/^The Windows VM is unreachable: /)
  })
})

describe('the libraries he wants synced', () => {
  const recwell = { siteId: '4fd8dedb-f376-4cea-b051-253af131361a', webId: '20800660-0676-4d7a-9c06-161e41d7b1da', listId: '357b5683-0508-442a-91ce-35742a9a0e15', webUrl: 'https://purdue0.sharepoint.com/sites/RecWell', webTitle: 'RecWell', listTitle: 'Documents' }
  const other = { ...recwell, listId: '00000000-0508-442a-91ce-35742a9a0e15', webTitle: 'Club', listTitle: 'Files' }

  it('only a person sets the list, and a signed-out OneDrive is asked for nothing', async () => {
    await expect(call('work.office.vmSync', { libraries: [recwell] }, { kind: 'model', caps: [], sessionId: 's1' })).rejects.toThrow('Only the owner')
    guest.account = null
    expect(await call('work.office.vmSync', { libraries: [recwell, other] })).toEqual({ wanted: 2, missing: 0 })
    expect(guest.synced).toEqual([])
  })

  it("asks OneDrive for each wanted library it lacks once he is signed in, as that library's own Sync button would, and not again for ten minutes", async () => {
    await call('work.office.vmSync', { libraries: [recwell, other] })
    expect(guest.synced).toEqual([{ ...other, email: 'him@purdue.edu' }])
    expect(missingLibraries(box.db).map((l) => l.webTitle)).toEqual(['Club'])
    await refreshVm(box.db, { wake: false })
    expect(guest.synced).toHaveLength(1)
  })
})

describe('the tools from a thread on the box', () => {
  const tools = (): Record<string, WorkTool> => Object.fromEntries(teamsTools({ carrier: () => null }).map((t) => [t.name, t]))
  const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text
  const MAC_TEAM = '/Users/him/Library/CloudStorage/OneDrive-purdue.edu-RecWell-TeamRecWell'
  const macLib: TeamsLibrary = { id: 'env_mac~1', host: 'env_mac', path: MAC_TEAM, team: 'RecWell-TeamRecWell', library: null, tenant: 'purdue.edu', kind: 'library', channels: [], web: null, found: true }
  let macUp: boolean
  let macAsked: { verb: string; args: unknown }[]
  let canvas: { kind: string; source: unknown; title: string }[]
  const thread = (): ToolCtx => {
    canvas = []
    return Object.assign({ ...box }, {
      scope,
      sessionId: 's1',
      signal: new AbortController().signal,
      peer: (host: string) => ({
        call: async (_m: string, verb: string, args: unknown) => {
          if (!macUp) throw new Error(`Mac offline: ${host} has no live link to this host`)
          macAsked.push({ verb, args })
          if (verb === 'filesLibraries') return { host, libraries: [macLib], roots: [], off: [] }
          if (verb === 'filesList') return { entries: [{ name: 'From the Mac.txt', path: `${MAC_TEAM}/Sub/From the Mac.txt`, library: macLib.id, kind: 'text', size: 3, modified: 5, local: true, by: null }] }
          if (verb === 'filesRead') return { name: 'notes.txt', text: 'from the Mac', truncated: false }
          return { entries: [], more: false }
        }
      }),
      canvas: { paneOf: (id: string) => id, open: (_p: string, kind: string, source: unknown, title: string) => (canvas.push({ kind, source, title }), { id: 'item1' }) }
    }) as unknown as ToolCtx
  }
  beforeEach(async () => {
    macUp = true
    macAsked = []
    settings = { mayUseDesktop: ['env_mac'], windowsVm: true }
    await call('work.office.filesLibraries', {})
  })

  it('finds the same place on two machines: a folder synced by itself on a Mac is that folder of the whole library in the VM', () => {
    const libs = [...vmLibraries(box.db, 'env_box'), macLib]
    const rec = libs.find((l) => l.vm && l.team === 'RecWell')!
    expect(twinOf(libs, macLib, 'Sub/x.txt')).toEqual({ library: rec, file: 'Team RecWell/Sub/x.txt' })
    expect(twinOf(libs, rec, 'Team RecWell/Sub/x.txt')).toEqual({ library: macLib, file: 'Sub/x.txt' })
    expect(twinOf(libs, rec, 'Sport Programs/x.txt')).toBeNull()
    expect(twinOf(libs, { ...macLib, kind: 'folder' }, 'x')).toBeNull()
  })

  it("shows a place once: the Mac's folder of a library the VM holds whole is not listed again", async () => {
    const libs = JSON.parse(text(await tools().teams_libraries!.run({}, thread()))) as { id: string; team: string; in?: string; channels?: string[] }[]
    expect(libs.map((l) => l.team).sort()).toEqual(['Esports', 'My files', 'RecWell'])
    expect(libs.find((l) => l.team === 'RecWell')).toMatchObject({ in: 'the Windows VM', channels: ['Sport Programs', 'Team RecWell'] })
  })

  it("lists the Mac's library when OneDrive in the VM is signed out", async () => {
    guest.account = null
    await refreshVm(box.db, { wake: true })
    const libs = JSON.parse(text(await tools().teams_libraries!.run({}, thread()))) as { team: string }[]
    expect(libs.map((l) => l.team)).toEqual(['RecWell-TeamRecWell'])
  })

  it('lists, reads and searches a VM library, naming files by their place in it', async () => {
    const rec = vmLibraries(box.db, 'env_box').find((l) => l.team === 'RecWell')!
    const listed = JSON.parse(text(await tools().teams_list!.run({ library: rec.id, folder: 'Team RecWell' }, thread()))) as { file: string; downloaded?: boolean }[]
    expect(listed.map((e) => e.file)).toEqual(['Team RecWell/Budget.xlsx', 'Team RecWell/Cloud.pdf', 'Team RecWell/notes.txt'])
    expect(listed.find((e) => e.file.endsWith('Cloud.pdf'))!.downloaded).toBe(false)
    expect(text(await tools().teams_read!.run({ library: rec.id, file: 'Team RecWell/notes.txt' }, thread()))).toBe('kickoff at 5')
    const found = JSON.parse(text(await tools().teams_search!.run({ query: 'budget' }, thread()))) as { library: string; file: string }[]
    expect(found).toEqual([expect.objectContaining({ library: rec.id, file: 'Team RecWell/Budget.xlsx' })])
  })

  it('reads from the Mac when the VM cannot be reached, at the same place, and from the VM when the Mac cannot', async () => {
    const rec = vmLibraries(box.db, 'env_box').find((l) => l.team === 'RecWell')!
    const ctx = thread()
    await tools().teams_libraries!.run({}, ctx)
    guest.awake = false
    vm = { state: 'asleep', cannot: null }
    expect(text(await tools().teams_read!.run({ library: rec.id, file: 'Team RecWell/notes.txt' }, ctx))).toBe('from the Mac')
    expect(macAsked.at(-1)).toEqual({ verb: 'filesRead', args: { source: { at: 'file', host: 'env_mac', path: `${MAC_TEAM}/notes.txt` }, as: 'text' } })
    const listed = JSON.parse(text(await tools().teams_list!.run({ library: rec.id, folder: 'Team RecWell/Sub' }, ctx))) as { file: string }[]
    expect(listed.map((e) => e.file)).toEqual(['Team RecWell/Sub/From the Mac.txt'])
    // a folder the Mac does not hold has no twin: the VM's own failure is the answer
    expect(text(await tools().teams_read!.run({ library: rec.id, file: 'Sport Programs/x.txt' }, ctx))).toMatch(/Windows VM is unreachable/)
    guest.awake = true
    vm = { state: 'awake', cannot: null }
    macUp = false
    expect(text(await tools().teams_read!.run({ library: macLib.id, file: 'notes.txt' }, ctx))).toBe('kickoff at 5')
  })

  it('opens a VM file from a copy on this host when the workspace allows copies, and in its app in the VM', async () => {
    const rec = vmLibraries(box.db, 'env_box').find((l) => l.team === 'RecWell')!
    const ctx = thread()
    const refused = text(await tools().teams_open!.run({ library: rec.id, file: 'Team RecWell/Cloud.pdf' }, ctx))
    expect(refused).toMatch(/stays in the VM/)
    expect(canvas).toEqual([])
    expect(guest.opened).toEqual([`${REC}\\Team RecWell\\Cloud.pdf`])
    await call('work.office.filesCopySet', { workspaceId: 'w1', on: true })
    const out = text(await tools().teams_open!.run({ library: rec.id, file: 'Team RecWell/Cloud.pdf' }, ctx))
    expect(out).toMatch(/from a copy on this host/)
    expect(canvas).toEqual([{ kind: 'pdf', source: { at: 'file', host: 'env_box', path: expect.stringContaining(copyDirOf(box.dataDir, 's1')) }, title: 'Cloud.pdf' }])
    expect(readFileSync((canvas[0]!.source as { path: string }).path)).toHaveLength(2000)
  })

  it("answers an Office file's key as the guest's path, said to be in the Windows VM", async () => {
    const rec = vmLibraries(box.db, 'env_box').find((l) => l.team === 'RecWell')!
    const office: string[] = []
    const t = Object.fromEntries(teamsTools({ carrier: () => null, vmOpenOffice: async (app, path) => void office.push(`${app}:${path}`) }).map((x) => [x.name, x]))
    const out = text(await t.teams_open!.run({ library: rec.id, file: 'Team RecWell/Budget.xlsx' }, thread()))
    expect(out).toContain(`open in Excel in the Windows VM; its key for the office tools is ${JSON.stringify(`${REC}\\Team RecWell\\Budget.xlsx`)}`)
    expect(office).toEqual([`excel:${REC}\\Team RecWell\\Budget.xlsx`])
  })
})

describe('what was kept', () => {
  it('survives in the pillar\'s own table and is null before any read', async () => {
    expect(storedStatus(box.db)).toBeNull()
    await refreshVm(box.db, { wake: true, now: () => 42 })
    expect(storedStatus(box.db)).toMatchObject({ at: 42, tops: { [REC]: ['Sport Programs', 'Team RecWell'] } })
    mkdirSync(join(base, 'x'), { recursive: true })
    writeFileSync(join(base, 'x', 'ok'), '1')
  })
})

describe('his sign-in', () => {
  const person = window
  it('no thread may ask for it, and a host with no VM says so', async () => {
    await expect(call('work.office.vmSignIn', {}, { kind: 'model', caps: [], sessionId: 's1' })).rejects.toThrow('Only the owner')
    vm = { state: 'none', cannot: null }
    await expect(call('work.office.vmSignIn', {}, person)).rejects.toThrow('not set up')
  })

  it("walks OneDrive's sign-in with the address Outlook here is signed in as, and says where it stopped", async () => {
    guest.account = null
    const asked: { verb: string; args: unknown }[] = []
    const base = guest.call
    setVmCall(async (verb, args, opts) => {
      if (verb.startsWith('ui.') || verb === 'onedrive.signin') {
        asked.push({ verb, args })
        const names = (args as { names?: string[] }).names ?? []
        const on = 'Approve a request on my Microsoft Authenticator app'
        return verb === 'onedrive.signin' ? null : names.includes(on) ? on : null
      }
      return base(verb, args, opts)
    })
    const answer = (await call('work.office.vmSignIn', { account: 'him@purdue.edu' }, person)) as { computer: string; account: string; line: string }
    expect(answer).toEqual({ computer: 'vm:windows', account: 'him@purdue.edu', line: "A number is on the Windows VM's screen: enter it in Microsoft Authenticator on your phone." })
    expect(asked.filter((a) => a.verb === 'ui.press').at(-1)).toEqual({ verb: 'ui.press', args: { names: ['Approve a request on my Microsoft Authenticator app'] } })
  })

  it('with OneDrive signed in and Office not licensed, opens Word for its sign-in; with both done, says who', async () => {
    const asked: string[] = []
    const base = guest.call
    setVmCall(async (verb, args, opts) => (verb === 'office.start' || verb.startsWith('ui.') ? (asked.push(verb), verb === 'ui.press' ? 'Sign in' : null) : base(verb, args, opts)))
    module.handle!({ id: '1', method: 'work.office.filesLibraries', params: {} } as unknown as ClientRequest, box, person)
    const first = (await call('work.office.vmSignIn', {}, person)) as { line: string }
    expect(asked[0]).toBe('office.start')
    expect(first.line).toMatch(/Office's sign-in is open/)
    guest.office = { ...guest.office, licensed: true, account: 'him@purdue.edu' }
    const done = (await call('work.office.vmSignIn', {}, person)) as { line: string }
    expect(done.line).toBe('The Windows VM is signed in as him@purdue.edu.')
  })
})
