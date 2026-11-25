import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FilesListing } from '@shared/contract-work-files'
import type { FileEntry } from '@shared/work/files'
import type { Caller } from '../../modules'
import { refreshVm, vmLibraries } from '../../office/vm/files'
import { setVmCall, VmAsleep } from '../../office/vm/link'
import { setVmState } from '../../office/vm/office'
import { closeFilesState } from '../handle'
import { files } from '../index'
import { at, HOST, makeRig, thread, window, WS, type Rig } from '../testkit'
import { forgetVmList, forgetVmLists } from './teams'
import { keptCount, VM_LIST_KEEP_MOST, VM_LIST_KEEP_MS } from './vmKept'

/**
 * A folder in the Windows VM never makes him wait in silence (docs/agents/work-teams-files.md "A folder in the VM"):
 * lists of one folder join one guest call, a sleeping VM answers at once with the rows kept or its state, only his
 * press wakes it, and the rows a woken read finds are pushed once.
 */

const TOP = 'C:\\Users\\tcuser\\Dummy U\\Esports Staff - Documents'
const GENERAL = `${TOP}\\General`
const STATUS = (mounts: { path: string; type: string; web: null }[]) => ({ onedrive: { installed: true, running: true, account: 'a@dummy.edu' }, mounts, office: { installed: true, version: null, apps: [], account: null, licensed: null } })

describe('a folder in the Windows VM', () => {
  let rig: Rig
  let state: string
  let calls: { verb: string; args: Record<string, unknown>; wake?: boolean }[]
  /** each guest list waits for its own release, so lists can be held in flight */
  let held: (() => void)[]
  let failNext: Error | null
  let rows: string[]
  const guest = (name: string, dir = false) => ({ name, path: `${GENERAL}\\${name}`, dir, size: dir ? 0 : 1000, modified: 5_000, local: true, link: false })
  const call = async <T>(method: string, params: Record<string, unknown>, by: Caller = window): Promise<T> => {
    const out = await files.handle!({ id: '1', method, params: { workspaceId: WS, ...params } } as never, rig.ctx, by)
    return (out as { result: T }).result
  }
  const list = (params: Record<string, unknown> = {}, by: Caller = window) => call<FilesListing>('work.files.list', { at: at(GENERAL), ...params }, by)
  const lists = () => calls.filter((c) => c.verb === 'files.list' && c.args.dir === GENERAL)
  const filesPushes = () => rig.pushes.filter((x) => x.p.push === 'work.files')
  const release = async () => {
    while (held.length) held.shift()!()
    await new Promise((r) => setTimeout(r, 0))
  }

  beforeEach(() => {
    rig = makeRig()
    calls = []
    held = []
    failNext = null
    rows = ['Budgets', 'Plan.docx', 'Deck.pptx', 'Sheet.xlsx']
    forgetVmLists()
    state = 'awake'
    setVmState(() => ({ state, cannot: null }))
    rig.db.prepare(`INSERT INTO work_office_files (key, value) VALUES ('vm:status', ?)`).run(JSON.stringify({ at: 1_700_000_000_000, status: STATUS([{ path: TOP, type: 'team', web: null }]), tops: { [TOP]: ['General'] } }))
    setVmCall(async (verb, args = {}, opts) => {
      const wake = (opts as { wake?: boolean } | undefined)?.wake
      calls.push({ verb, args, wake })
      if (verb === 'files.list') {
        if (wake === false && state !== 'awake') throw new VmAsleep()
        await new Promise<void>((r) => held.push(r))
        if (failNext) {
          const err = failNext
          failNext = null
          throw err
        }
        // A woken machine is awake once it answers.
        state = 'awake'
        return rows.map((n) => guest(n, n === 'Budgets'))
      }
      if (verb === 'files.stat') return guest(String(args.path).split('\\').pop()!)
      if (verb === 'guest.status') throw new Error('not in this test')
      throw new Error(`unexpected ${verb}`)
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    setVmCall(null)
    setVmState(null)
    forgetVmLists()
    closeFilesState(rig.db)
    rig.close()
  })

  it('asks the guest once for three lists of one folder at once, and once more for none of their pages', async () => {
    if (process.platform === 'win32') return
    const three = Promise.all([list(), list({ sort: { by: 'name', dir: 'desc' } }), list()])
    await new Promise((r) => setTimeout(r, 0))
    await release()
    const got = await three
    expect(lists()).toHaveLength(1)
    expect(got.map((g) => g.entries.length)).toEqual([4, 4, 4])
    // Awake, the rows are the guest's own: no kept time, no sleep.
    expect(got[0]!.asOf).toBeUndefined()
    expect(got[0]!.sleeping).toBeUndefined()
    // Awake and read a moment ago, the folder is not asked again.
    await list()
    expect(lists()).toHaveLength(1)
  })

  it('answers a list he did not press for at once while it sleeps: the rows kept, when they were read, and no call to the VM', async () => {
    if (process.platform === 'win32') return
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const first = list()
    await new Promise((r) => setTimeout(r, 0))
    await release()
    await first
    state = 'asleep'
    calls = []
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000 + 60_000)
    const got = await list({ wake: false })
    expect(calls).toEqual([])
    expect(got).toMatchObject({ asOf: 1_000_000, sleeping: 'asleep' })
    expect(got.entries.map((e) => e.name)).toEqual(['Budgets', 'Deck.pptx', 'Plan.docx', 'Sheet.xlsx'])
    // Past their life the rows are not served: the state alone.
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000 + VM_LIST_KEEP_MS + 1)
    const old = await list({ wake: false })
    expect(old).toMatchObject({ entries: [], sleeping: 'asleep' })
    expect(old.asOf).toBeUndefined()
    expect(calls).toEqual([])
  })

  it("never wakes it for a thread's list, nor asks a sleeping machine at all", async () => {
    if (process.platform === 'win32') return
    state = 'asleep'
    rig.settings.set(WS, { windowsVm: true })
    const got = await list({}, thread('t1'))
    expect(got).toMatchObject({ entries: [], sleeping: 'asleep' })
    // Even one that asks to wake it: a thread's list is never his press.
    await list({ wake: true }, thread('t1'))
    expect(calls).toEqual([])
  })

  it('a folder dropped while its read is under way keeps nothing from that read, and no list after the drop joins it', async () => {
    if (process.platform === 'win32') return
    const library = vmLibraries(rig.db, HOST).find((l) => GENERAL.toLowerCase().startsWith(l.path.toLowerCase()))!
    // A read under way when a change through Files drops the folder: it answers its own list, and keeps nothing.
    const before = list()
    await new Promise((r) => setTimeout(r, 0))
    forgetVmList(library.id, GENERAL)
    // A list after the drop is its own guest call, not the one from before.
    const after = list()
    await new Promise((r) => setTimeout(r, 0))
    expect(lists()).toHaveLength(2)
    held.shift()!()
    await before
    expect(keptCount()).toBe(0)
    await release()
    await after
    expect(keptCount()).toBe(1)
    // Work off, or a library gone, with a read under way: nothing comes back from it either.
    forgetVmList(library.id, GENERAL)
    const third = list()
    await new Promise((r) => setTimeout(r, 0))
    expect(lists()).toHaveLength(3)
    forgetVmLists()
    await release()
    await third
    expect(keptCount()).toBe(0)
  })

  it('never wakes it for a next page that does not say: a scroll is no press (the phone sends no `wake`)', async () => {
    if (process.platform === 'win32') return
    state = 'asleep'
    // The phone's next page and its share sheet's walk send a cursor and no `wake`: no call to the VM, and no wake.
    const next = await list({ cursor: 'a-next-page' })
    expect(next.sleeping).toBe('asleep')
    expect(calls).toEqual([])
    // A first page that does not say stays his press, as a window a release behind and the phone's tap send it.
    const first = list()
    await new Promise((r) => setTimeout(r, 0))
    expect(calls.filter((c) => c.verb === 'files.list').map((c) => c.wake)).toEqual([true])
    await release()
    await first
  })

  it('answers his press on a sleeping VM before the wake ends, and pushes the folder once when its rows land', async () => {
    if (process.platform === 'win32') return
    state = 'asleep'
    const got = await list({ wake: true })
    expect(got).toMatchObject({ entries: [], sleeping: 'waking' })
    expect(lists().map((c) => c.wake)).toEqual([true])
    // A second press and a refetch while it wakes join the one wake, and say it is waking.
    expect(await list({ wake: true })).toMatchObject({ sleeping: 'waking' })
    expect(await list({ wake: false })).toMatchObject({ sleeping: 'waking' })
    expect(lists()).toHaveLength(1)
    expect(filesPushes()).toEqual([])
    await release()
    const pushed = filesPushes()
    expect(pushed).toHaveLength(1)
    expect(pushed[0]!.p).toMatchObject({ push: 'work.files', workspaceId: WS, at: 'lib:esportsstaffgeneral:' })
    expect(pushed[0]!.to).toEqual({ need: 'read' })
    // The places hear it is awake.
    expect(rig.pushes.filter((x) => x.p.push === 'work.office.files')).toHaveLength(1)
    // The push's refetch is answered from what the wake read, with no second call.
    const after = await list({ wake: false })
    expect(after.entries).toHaveLength(4)
    expect(after.sleeping).toBeUndefined()
    expect(lists()).toHaveLength(1)
  })

  it('serves the rows kept while it wakes, and the folder as it is now once the woken read lands: a file added elsewhere shows', async () => {
    if (process.platform === 'win32') return
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const first = list()
    await new Promise((r) => setTimeout(r, 0))
    await release()
    await first
    state = 'asleep'
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000 + 30_000)
    // Added in Teams by someone else while the VM slept.
    rows = [...rows, 'Added elsewhere.docx']
    const waking = await list({ wake: true })
    expect(waking).toMatchObject({ asOf: 1_000_000, sleeping: 'waking' })
    expect(waking.entries.map((e) => e.name)).not.toContain('Added elsewhere.docx')
    await release()
    expect(filesPushes()).toHaveLength(1)
    const now = await list({ wake: false })
    expect(now.entries.map((e) => e.name)).toContain('Added elsewhere.docx')
    expect(now.asOf).toBeUndefined()
    expect(now.sleeping).toBeUndefined()
  })

  it('a wake that fails is pushed too, and the folder then says it sleeps, with its press', async () => {
    if (process.platform === 'win32') return
    state = 'asleep'
    failNext = new Error('it would not wake')
    await list({ wake: true })
    await release()
    expect(filesPushes()).toHaveLength(1)
    expect(rig.pushes.filter((x) => x.p.push === 'work.office.files')).toHaveLength(0)
    state = 'asleep'
    expect(await list({ wake: false })).toMatchObject({ entries: [], sleeping: 'asleep' })
  })

  it('asks the guest once for a page of Office rows and who saved them: the rows on screen are not looked at one by one', async () => {
    if (process.platform === 'win32') return
    rows = Array.from({ length: 30 }, (_, i) => `Report ${i}.docx`)
    const first = list()
    await new Promise((r) => setTimeout(r, 0))
    await release()
    const got = await first
    const stat = await call<{ entries: (FileEntry | null)[] }>('work.files.stat', { refs: got.entries.map((e) => e.ref) })
    expect(stat.entries.every((e) => e === null)).toBe(true)
    // (The places' own status read behind, `guest.status`, is no call about the folder's rows.)
    const rowCalls = () => calls.filter((c) => c.verb.startsWith('files.')).map((c) => c.verb)
    expect(rowCalls()).toEqual(['files.list'])
    // One file's own look (its tab) still asks.
    await call('work.files.stat', { refs: [got.entries[0]!.ref] })
    expect(rowCalls()).toEqual(['files.list', 'files.stat'])
  })

  it('runs the fence before kept rows: a caller that may not name the VM is refused, and so is a path outside its libraries', async () => {
    if (process.platform === 'win32') return
    const first = list()
    await new Promise((r) => setTimeout(r, 0))
    await release()
    await first
    state = 'asleep'
    // The workspace does not let its threads use the VM: kept rows or not, it is refused.
    await expect(list({ wake: false }, thread('t1'))).rejects.toThrow()
    await expect(call('work.files.list', { at: at('C:\\Users\\tcuser\\Desktop'), wake: false })).rejects.toThrow("That is not in this workspace's folder or a library it may use.")
  })

  it('drops what it kept for a library OneDrive no longer syncs, a folder changed through Files, and everything when Work goes off', async () => {
    if (process.platform === 'win32') return
    const read = async () => {
      const p = list()
      await new Promise((r) => setTimeout(r, 0))
      await release()
      await p
    }
    await read()
    expect(keptCount()).toBe(1)
    // A change through Files to another library's folder leaves it; one to this folder drops it.
    const id = vmLibraries(rig.db, HOST)[0]!.id
    forgetVmList('another', GENERAL)
    expect(keptCount()).toBe(1)
    forgetVmList(id, `${GENERAL}\\`)
    expect(keptCount()).toBe(0)
    await read()
    // The guest read again without the library: its folders go.
    setVmCall(async (verb) => {
      if (verb === 'guest.status') return STATUS([{ path: 'C:\\Users\\tcuser\\OneDrive - Dummy U', type: 'mine', web: null }])
      return []
    })
    await refreshVm(rig.db)
    expect(keptCount()).toBe(0)
    // Work off: the module's stop drops them all.
    setVmCall(async (verb, args, opts) => {
      calls.push({ verb, args: args ?? {}, wake: (opts as { wake?: boolean } | undefined)?.wake })
      return [guest('Plan.docx')]
    })
    rig.db.prepare(`UPDATE work_office_files SET value = ? WHERE key = 'vm:status'`).run(JSON.stringify({ at: 1, status: STATUS([{ path: TOP, type: 'team', web: null }]), tops: { [TOP]: ['General'] } }))
    await list()
    expect(keptCount()).toBe(1)
    const stop = files.start!(rig.ctx)
    stop()
    expect(keptCount()).toBe(0)
  })

  it(`keeps ${VM_LIST_KEEP_MOST} folders at most`, async () => {
    if (process.platform === 'win32') return
    setVmCall(async () => [guest('Plan.docx')])
    rig.db.prepare(`UPDATE work_office_files SET value = ? WHERE key = 'vm:status'`).run(JSON.stringify({ at: 1, status: STATUS([{ path: TOP, type: 'team', web: null }]), tops: { [TOP]: ['General'] } }))
    for (let i = 0; i < VM_LIST_KEEP_MOST + 5; i++) await list({ at: at(`${GENERAL}\\F${i}`) })
    expect(keptCount()).toBe(VM_LIST_KEEP_MOST)
  })
})
