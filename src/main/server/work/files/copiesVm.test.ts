import { readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CopyBack, FilesOpened, FilesTabs } from '@shared/contract-work-files'
import { canvasSourcePath } from '@shared/work'
import type { Caller } from '../modules'
import { setCopyAllowed } from '../office/files/library'
import { setVmCall } from '../office/vm/link'
import { setVmState } from '../office/vm/office'
import { copiesInFlight, copyRecord, copySaved } from './copies'
import { closeFilesState, filesHandle } from './handle'
import { forgetVmLists } from './places/teams'
import { forgetUploads, lookAll, uploadsOwed, uploadTiming } from './uploads'
import { setThreadsMayWrite, sharedOf } from './policy'
import { onFileSaved, saveFile, versionWord } from './save'
import { HOST, makeRig, thread, window, WS, type Rig } from './testkit'
import { versionOf } from './write'

/**
 * A copy of a file in the Windows VM saves back through the guest's versioned write (vmVerbs.ts `vmSave`), the
 * helper stood in through `setVmCall` as vmVerbs.test.ts does: the copy is read with the helper's version, a save
 * goes by that version, and a file that changed in the guest is the conflict, left as it was.
 */

const TOP = 'C:\\Users\\tcuser\\Dummy U\\Esports Staff - Documents'
const GENERAL = `${TOP}\\General`
const ROSTER = `${GENERAL}\\Roster.xlsx`
const VERBS = ['files.mkdir', 'files.rename', 'files.move', 'files.write', 'files.recycle', 'files.outcome']

describe.skipIf(process.platform === 'win32')('a copy of a file in the Windows VM', () => {
  let rig: Rig
  let disk: Map<string, { path: string; data: string; modified: number }>
  let writes: Record<string, unknown>[]
  let offSaved: () => void
  /** what the helper says of OneDrive's upload of the file (absent: a helper built before it could say) */
  let sync: 'in' | 'pending' | undefined
  let stats: number

  const versionIn = (path: string): string => {
    const f = disk.get(path.toLowerCase())!
    return `${Buffer.from(f.data, 'base64').length}:${f.modified}:h${f.data}`
  }
  const guest = async (verb: string, args: Record<string, unknown>): Promise<unknown> => {
    const f = disk.get(String(args.path ?? '').toLowerCase())
    switch (verb) {
      case 'files.stat':
        stats++
        return { name: f!.path.slice(f!.path.lastIndexOf('\\') + 1), path: f!.path, dir: false, size: Buffer.from(f!.data, 'base64').length, modified: f!.modified, local: true, link: false, ...(sync ? { sync } : {}) }
      case 'files.read':
        return { data: f!.data, size: Buffer.from(f!.data, 'base64').length, eof: true, ...(args.version ? { version: versionIn(f!.path), changed: f!.modified } : {}) }
      case 'files.list':
        return [...disk.values()].filter((e) => e.path.slice(0, e.path.lastIndexOf('\\')).toLowerCase() === String(args.dir).toLowerCase()).map((e) => ({ name: e.path.slice(e.path.lastIndexOf('\\') + 1), path: e.path, dir: false, size: 1, modified: e.modified, local: true, link: false }))
      case 'files.write': {
        writes.push(args)
        if (args.dir) {
          const to = `${args.dir}\\${args.name}`
          disk.set(to.toLowerCase(), { path: to, data: args.data as string, modified: 3000 })
          return { entry: { name: args.name, path: to, dir: false, size: 1, modified: 3000, local: true, link: false } }
        }
        if (!f) return { conflict: { gone: true } }
        if (versionIn(f.path) !== args.expect) return { conflict: { version: versionIn(f.path), changed: f.modified } }
        f.data = args.data as string
        f.modified = 2000
        return { version: versionIn(f.path), changed: 2000, entry: {} }
      }
    }
    throw new Error(`unexpected ${verb}`)
  }

  beforeEach(() => {
    rig = makeRig()
    disk = new Map([[ROSTER.toLowerCase(), { path: ROSTER, data: Buffer.from('vm workbook').toString('base64'), modified: 1000 }]])
    writes = []
    sync = 'pending'
    stats = 0
    forgetUploads()
    forgetVmLists()
    setVmState(() => ({ state: 'awake', cannot: null }))
    rig.db.prepare(`INSERT OR REPLACE INTO work_office_files (key, value) VALUES ('vm:status', ?)`).run(
      JSON.stringify({
        at: Date.now(),
        status: { onedrive: { installed: true, running: true, account: 'a@dummy.edu' }, mounts: [{ path: TOP, type: 'team', web: null }], office: { installed: true, version: null, apps: [], account: null, licensed: null }, verbs: VERBS },
        tops: { [TOP]: ['Events', 'General'] }
      })
    )
    setVmCall((verb, args) => guest(verb, (args ?? {}) as Record<string, unknown>))
    setCopyAllowed(rig.db, WS, true)
    setThreadsMayWrite(true)
    offSaved = onFileSaved((path) => copySaved(rig.ctx, path))
  })
  afterEach(() => {
    forgetUploads()
    offSaved()
    setVmCall(null)
    setThreadsMayWrite(false)
    closeFilesState(rig.db)
    rig.close()
  })

  const call = async <T>(method: string, params: Record<string, unknown>, by: Caller = window): Promise<T> => {
    const out = await filesHandle({ id: '1', method, params: { workspaceId: WS, ...params } } as never, rig.ctx, by)
    return (out as { result: T }).result
  }
  const settled = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.all(copiesInFlight())
  }
  const open = async () => {
    const got = await call<FilesOpened>('work.files.open', { ref: { at: 'file', host: HOST, path: ROSTER }, name: 'Roster.xlsx' })
    return { copy: canvasSourcePath(got.item!.source)!, tabId: got.tabId! }
  }
  const save = async (copy: string, text: string): Promise<void> => {
    await saveFile({ roots: [dirname(copy)] }, `file::${copy}`, copy, Buffer.from(text), versionWord(await versionOf(copy)))
    await settled()
  }
  const saveBytes = async (copy: string, data: string): Promise<void> => {
    await saveFile({ roots: [dirname(copy)] }, `file::${copy}`, copy, Buffer.from(data, 'base64'), versionWord(await versionOf(copy)))
    await settled()
  }
  const back = async (tabId: string): Promise<CopyBack | undefined> => (await call<FilesTabs>('work.files.tabs', {})).tabs.find((t) => t.id === tabId)?.back

  it("is read with the helper's version, and a save goes back by it: the guest's file changes", async () => {
    const { copy, tabId } = await open()
    expect(readFileSync(copy, 'utf8')).toBe('vm workbook')
    expect(copyRecord(rig.ctx, WS, HOST, ROSTER)).toMatchObject({ vm: 1, version: `11:1000:h${Buffer.from('vm workbook').toString('base64')}` })
    expect(sharedOf(rig.ctx, { at: 'file', host: HOST, path: copy })).toBe(true)
    expect((await call<FilesTabs>('work.files.tabs', {})).tabs.find((t) => t.id === tabId)?.copyOf).toEqual({ host: HOST, path: ROSTER, vm: true })
    await save(copy, 'edited here')
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ path: ROSTER, expect: `11:1000:h${Buffer.from('vm workbook').toString('base64')}` })
    expect(Buffer.from(disk.get(ROSTER.toLowerCase())!.data, 'base64').toString()).toBe('edited here')
    expect(copyRecord(rig.ctx, WS, HOST, ROSTER)!.version).toBe(versionIn(ROSTER))
    expect((await back(tabId))?.is).toBe('ok')
  })

  it('is the conflict when the guest\'s file changed: it is left as it was, and Keep Both writes his beside it there', async () => {
    const { copy, tabId } = await open()
    disk.get(ROSTER.toLowerCase())!.data = Buffer.from('changed in the VM').toString('base64')
    disk.get(ROSTER.toLowerCase())!.modified = 1500
    await save(copy, 'mine')
    expect(Buffer.from(disk.get(ROSTER.toLowerCase())!.data, 'base64').toString()).toBe('changed in the VM')
    expect((await back(tabId))?.is).toBe('changed')
    const kept = await call<FilesTabs>('work.files.copyKeep', { tabId })
    const mine = `${GENERAL}\\Roster (mine).xlsx`
    expect(Buffer.from(disk.get(mine.toLowerCase())!.data, 'base64').toString()).toBe('mine')
    expect(kept.tabs.find((t) => t.id === tabId)).toMatchObject({ name: 'Roster (mine).xlsx', copyOf: { host: HOST, path: mine, vm: true }, back: { is: 'ok' } })
  })

  it("Reload reads the guest's file into the copy the tab's item names, by the helper's version", async () => {
    const { copy, tabId } = await open()
    disk.get(ROSTER.toLowerCase())!.data = Buffer.from('changed in the VM').toString('base64')
    disk.get(ROSTER.toLowerCase())!.modified = 1500
    await save(copy, 'mine')
    expect((await back(tabId))?.is).toBe('changed')
    await call('work.files.copyReload', { tabId })
    expect(readFileSync(copy, 'utf8')).toBe('changed in the VM')
    expect(copyRecord(rig.ctx, WS, HOST, ROSTER)).toMatchObject({ copy, state: 'ok', version: versionIn(ROSTER) })
  })

  it('waits when the VM does not answer, and refuses a thread', async () => {
    const { copy, tabId } = await open()
    setVmCall(async () => {
      throw new (await import('../office/vm/link')).VmUnreachable('asleep')
    })
    writeFileSync(copy, 'two')
    expect(await call<CopyBack>('work.files.copyBack', { tabId })).toMatchObject({ is: 'away', held: 0 })
    await expect(call('work.files.copyBack', { tabId }, thread('t1'))).rejects.toThrow('files_* tools')
  })

  describe('saved is not uploaded: what OneDrive did with the save', () => {
    const cloud = async (tabId: string) => (await call<FilesTabs>('work.files.tabs', {})).tabs.find((t) => t.id === tabId)?.cloud
    const status = (onedrive: { running: boolean; account: string | null }): void =>
      void rig.db.prepare(`INSERT OR REPLACE INTO work_office_files (key, value) VALUES ('vm:status', ?)`).run(
        JSON.stringify({ at: Date.now(), status: { onedrive: { installed: true, ...onedrive }, mounts: [{ path: TOP, type: 'team', web: null }], office: { installed: true, version: null, apps: [], account: null, licensed: null }, verbs: VERBS }, tops: { [TOP]: ['Events', 'General'] } })
      )

    it('is uploading once written, and uploaded when OneDrive marks the file in sync; the VM is held awake only meanwhile', async () => {
      const { copy, tabId } = await open()
      expect(await cloud(tabId)).toBeUndefined()
      await save(copy, 'edited here')
      expect(await cloud(tabId)).toMatchObject({ is: 'uploading' })
      expect(uploadsOwed()).toBe(true)
      sync = 'in'
      await lookAll(rig.ctx)
      expect(await cloud(tabId)).toMatchObject({ is: 'uploaded' })
      expect(uploadsOwed()).toBe(false)
      // the next save is on its way again
      sync = 'pending'
      await save(copy, 'edited again')
      expect(await cloud(tabId)).toMatchObject({ is: 'uploading' })
    })

    it('is late past the wait, with what is known: OneDrive stopped, signed out, or else maybe paused', async () => {
      const { copy, tabId } = await open()
      await save(copy, 'edited here')
      const later = (): number => Date.now() + uploadTiming.late
      await lookAll(rig.ctx, later)
      expect(await cloud(tabId)).toMatchObject({ is: 'late' })
      expect((await cloud(tabId))?.why).toBeUndefined()
      status({ running: false, account: 'a@dummy.edu' })
      await lookAll(rig.ctx, later)
      expect(await cloud(tabId)).toMatchObject({ is: 'late', why: 'stopped' })
      status({ running: true, account: null })
      await lookAll(rig.ctx, later)
      expect(await cloud(tabId)).toMatchObject({ is: 'late', why: 'signed-out' })
      // and looked at no more once it gives up: the VM may sleep
      expect(uploadsOwed(Date.now() + uploadTiming.give)).toBe(false)
    })

    it('never wakes a sleeping VM to ask: late as asleep past the wait', async () => {
      const { copy, tabId } = await open()
      await save(copy, 'edited here')
      setVmState(() => ({ state: 'asleep', cannot: null }))
      stats = 0
      await lookAll(rig.ctx)
      expect(await cloud(tabId)).toMatchObject({ is: 'uploading' })
      await lookAll(rig.ctx, () => Date.now() + uploadTiming.late)
      expect(await cloud(tabId)).toMatchObject({ is: 'late', why: 'asleep' })
      expect(stats).toBe(0)
    })

    it('is unknown from a helper that cannot say', async () => {
      const { copy, tabId } = await open()
      sync = undefined
      await save(copy, 'edited here')
      await lookAll(rig.ctx)
      expect(await cloud(tabId)).toMatchObject({ is: 'unknown' })
    })
  })


  describe("SharePoint's own rewrite after an upload (body.ts)", () => {
    const BOOK = (cell: string, extra: Record<string, string> = {}): string =>
      Buffer.from(zipSync({ 'xl/worksheets/sheet1.xml': strToU8(`<c>${cell}</c>`), 'docProps/core.xml': strToU8('<p/>'), ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, strToU8(v)])) })).toString('base64')
    const rewrite = (data: string, modified: number): void => {
      const f = disk.get(ROSTER.toLowerCase())!
      f.data = data
      f.modified = modified
    }

    it('is no change made there: the next save goes over it', async () => {
      disk.get(ROSTER.toLowerCase())!.data = BOOK('1')
      const { copy, tabId } = await open()
      await saveBytes(copy, BOOK('2'))
      expect((await back(tabId))?.is).toBe('ok')
      // seconds later SharePoint writes its columns into the file, and OneDrive brings it down
      const sent = disk.get(ROSTER.toLowerCase())!.data
      rewrite(BOOK('2', { 'customXml/item1.xml': '<ct/>', 'docProps/custom.xml': '<c/>' }), 2500)
      expect(sent).not.toBe(disk.get(ROSTER.toLowerCase())!.data)
      await saveBytes(copy, BOOK('3'))
      expect((await back(tabId))?.is).toBe('ok')
      expect(disk.get(ROSTER.toLowerCase())!.data).toBe(BOOK('3'))
    })

    it('is still a change made there when anyone edited its body: nothing is written over it', async () => {
      disk.get(ROSTER.toLowerCase())!.data = BOOK('1')
      const { copy, tabId } = await open()
      await saveBytes(copy, BOOK('2'))
      rewrite(BOOK('someone else', { 'customXml/item1.xml': '<ct/>' }), 2500)
      await saveBytes(copy, BOOK('3'))
      expect((await back(tabId))?.is).toBe('changed')
      expect(disk.get(ROSTER.toLowerCase())!.data).toBe(BOOK('someone else', { 'customXml/item1.xml': '<ct/>' }))
    })
  })

})
