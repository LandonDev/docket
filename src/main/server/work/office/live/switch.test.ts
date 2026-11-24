import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { METHOD_CAPABILITY } from '@shared/capabilities'
import { ClientRequestSchema, type ClientRequest } from '@shared/contract'
import type { FilesOpened, FilesTabs, FileTab } from '@shared/contract-work-files'
import type { OfficeLiveSet } from '@shared/contract-work-office'
import { canvasSourcePath, filesPaneOf, type CanvasItem } from '@shared/work'
import { refKey } from '@shared/work/files'
import { isLiveSource } from '@shared/work/officeLive'
import { files } from '../../files'
import { copiesInFlight, copyRecord, copySaved, copyTiming } from '../../files/copies'
import { closeFilesState, filesHandle } from '../../files/handle'
import { forgetLibraries } from '../../files/places/libraries'
import { setThreadsMayWrite } from '../../files/policy'
import { onFileSaved, saveFile, versionWord } from '../../files/save'
import { at, HOST, makeRig, thread, window, WS, type Rig } from '../../files/testkit'
import { wordFollowed, wordImportPlace, wordRow } from '../../files/word'
import { versionOf } from '../../files/write'
import type { Caller } from '../../modules'
import { office } from '..'
import { filesHandle as officeHandle } from '../files/handle'
import { libraryId, setCloudDir, setCopyAllowed, setRoots } from '../files/library'
import { setVmCall } from '../vm/link'
import { setVmState } from '../vm/office'
import { modeOf, setLibraryDefault, setMode } from './memory'
import { liveTiming } from './switch'

// Save as Word writes the Work service's Word export; here a stand-in's bytes.
vi.mock('../../formats/exporter', () => ({ exportDoc: async () => ({ name: 'Plan.docx', data: Buffer.from('word export').toString('base64'), warnings: [] }) }))

/**
 * Switching a Files tab between Edit here and Live (switch.ts): the workspace's host (`env_box`) and his Mac
 * (`env_mac`) with a dummy Teams library, joined by a stand-in of the host link that runs the Mac's own handlers, as
 * copies.test.ts joins them. Dummy files only.
 */

const MAC = 'env_mac'
const AS_PEER: Caller = { kind: 'remote', caps: ['read', 'operate'], peer: HOST }
const WEB = 'https://purdue0.sharepoint.com/sites/Esports/Shared%20Documents'
const VM_TOP = 'C:\\Users\\tcuser\\Dummy U\\Esports Staff - Documents'

let box: Rig
let mac: Rig
let far: string[]
/** verbs the Mac does not answer, and verbs it refuses */
let down: Set<string>
let refused: Set<string>
let hold: Promise<void> | null
let offs: (() => void)[]

beforeEach(() => {
  box = makeRig()
  mac = makeRig()
  ;(mac.ctx as { host: string }).host = MAC
  office.ensure(box.db)
  office.ensure(mac.db)
  setCloudDir((host) => (host === HOST ? box.cloud : host === MAC ? mac.cloud : join(box.base, 'no-cloud')))
  forgetLibraries(box.db)
  forgetLibraries(mac.db)
  setRoots(mac.db, [{ folder: mac.team, web: WEB }])
  setCopyAllowed(box.db, WS, true)
  setThreadsMayWrite(true)
  box.settings.set(WS, { mayUseDesktop: [MAC] })
  copyTiming.grace = 0
  far = []
  down = new Set()
  refused = new Set()
  hold = null
  Object.assign(box.ctx, {
    peer(this: unknown, host: string) {
      return {
        async call(module: string, verb: string, args: Record<string, unknown>) {
          far.push(verb)
          if (host !== MAC || down.has(verb)) throw new Error(`host offline: ${host} has no live link to this host`)
          if (refused.has(verb)) throw new Error('The Mac refused the save.')
          if (hold && verb === 'writeBack') await hold
          const req = ClientRequestSchema.parse({ id: 'peer', method: `work.${module}.${verb}`, params: args }) as ClientRequest
          const out = module === 'office' ? await officeHandle(req, mac.ctx, AS_PEER, () => null) : await filesHandle(req, mac.ctx, AS_PEER)
          if (!out.handled) throw new Error(`${req.method} is not answered there`)
          return out.result
        }
      }
    }
  })
  // As the modules do once started (files/index.ts): a copy's save is sent, a Word file's import is followed, and a
  // Files pane's item that goes is heard by every pillar.
  ;(box.canvas as unknown as { deps: { itemsRemoved: (items: CanvasItem[]) => void } }).deps.itemsRemoved = (items) => {
    files.itemsRemoved!(items, box.ctx)
    office.itemsRemoved!(items, box.ctx)
  }
  offs = [onFileSaved((path) => copySaved(box.ctx, path)), box.ctx.canvas.onReplaced((old, next) => wordFollowed(box.ctx, old, next))]
})
afterEach(() => {
  vi.useRealTimers()
  for (const off of offs) off()
  setVmCall(null)
  setThreadsMayWrite(false)
  copyTiming.grace = 3000
  Object.assign(liveTiming, { send: 30_000, version: 60_000, look: 1_000 })
  closeFilesState(box.db)
  closeFilesState(mac.db)
  mac.close()
  box.close()
})

const call = async <T>(method: string, params: Record<string, unknown>, by: Caller = window): Promise<T> => {
  const out = await filesHandle({ id: '1', method, params: { workspaceId: WS, ...params } } as never, box.ctx, by)
  return (out as { result: T }).result
}
const set = async (tabId: string, params: Record<string, unknown> = {}, by: Caller = window): Promise<OfficeLiveSet> => {
  const req = ClientRequestSchema.parse({ id: '1', method: 'work.office.live.set', params: { workspaceId: WS, tabId, mode: 'live', ...params } })
  const out = await office.handle!(req, box.ctx, by)
  return (out as { result: OfficeLiveSet }).result
}
const tabOf = async (tabId: string): Promise<FileTab> => (await call<FilesTabs>('work.files.tabs', {})).tabs.find((t) => t.id === tabId)!
const itemOf = async (tabId: string): Promise<CanvasItem> => box.ctx.canvas.get((await tabOf(tabId)).itemId!)!
const settled = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.all(copiesInFlight())
}

/** A file of the Mac's team library opened in a Files tab here, as his row opens it. */
async function openFar(name: string, bytes: string) {
  const path = join(mac.team, 'General', name)
  writeFileSync(path, bytes)
  const opened = await call<FilesOpened>('work.files.open', { ref: at(path, MAC), name })
  return { path, tabId: opened.tabId!, item: opened.item!, copy: canvasSourcePath(opened.item!.source) }
}
/** The sheet editor's save of the copy, through Files' one door by the version it read: the copy then sends itself. */
async function edit(copy: string, bytes: string): Promise<void> {
  await saveFile({ roots: [dirname(copy)] }, `file::${copy}`, copy, Buffer.from(bytes), versionWord(await versionOf(copy)))
}

describe('a file remembered as Live', () => {
  it('opens a file of this host’s library on the web in its tab, keyed as Files keys it', async () => {
    setRoots(box.db, [{ folder: box.team, web: WEB }])
    setLibraryDefault(box.db, libraryId(HOST, box.team), 'live')
    const opened = await call<FilesOpened>('work.files.open', { ref: at(join(box.team, 'General', 'Plan.docx')) })
    expect(opened.item).toMatchObject({ kind: 'document', source: { at: 'microsoft', app: 'word', host: HOST, name: 'Plan.docx', ref: { kind: 'url', url: `${WEB}/General/Plan.docx?web=1` } } })
    expect(isLiveSource(opened.item!.source)).toBe(true)
    const tab = await tabOf(opened.tabId!)
    expect(tab.copyOf).toBeUndefined()
    // Opened again, the same tab answers; Edit here remembered for it opens it as Files would.
    expect((await call<FilesOpened>('work.files.open', { ref: at(join(box.team, 'General', 'Plan.docx')) })).tabId).toBe(opened.tabId)
    await call('work.files.tabClose', { tabId: opened.tabId })
    setMode(box.db, WS, tab.key!, 'here')
    const here = await call<FilesOpened>('work.files.open', { ref: at(join(box.team, 'General', 'Plan.docx')) })
    expect(here.item!.source).toMatchObject({ at: 'microsoft', ref: { kind: 'path' } })
    expect((await tabOf(here.tabId!)).key).toBe(tab.key)
  })

  it('opens a file of another host with no copy made', async () => {
    const path = join(mac.team, 'General', 'Roster.xlsx')
    writeFileSync(path, 'workbook')
    setMode(box.db, WS, refKey(at(path, MAC)), 'live')
    const opened = await call<FilesOpened>('work.files.open', { ref: at(path, MAC), name: 'Roster.xlsx' })
    expect(opened.item).toMatchObject({ kind: 'sheet', source: { at: 'microsoft', app: 'excel', host: HOST, ref: { url: `${WEB}/General/Roster.xlsx?web=1` } } })
    expect((await tabOf(opened.tabId!)).copyOf).toEqual({ host: MAC, path })
    expect(far).not.toContain('filesRead')
    expect(copyRecord(box.ctx, WS, MAC, path)).toBeNull()
    // Remembered as Edit here, it opens as its copy and asks the Mac nothing more.
    await call('work.files.tabClose', { tabId: opened.tabId })
    setMode(box.db, WS, refKey(at(path, MAC)), 'here')
    far = []
    expect((await call<FilesOpened>('work.files.open', { ref: at(path, MAC), name: 'Roster.xlsx' })).item!.source).toMatchObject({ at: 'file', host: HOST })
    expect(far).toEqual(['filesRead'])
  })

  it('opens a file in the sleeping VM without waking it', async () => {
    setVmState(() => ({ state: 'asleep', cannot: null }))
    const guest = vi.fn(async () => {
      throw new Error('The VM must stay asleep.')
    })
    setVmCall(guest)
    const status = { mounts: [{ path: VM_TOP, type: 'team', web: WEB }], onedrive: { installed: true, running: true, account: 'owner@example.com' }, office: { installed: true, apps: ['word'], version: null, account: null, licensed: null } }
    box.db.prepare('INSERT OR REPLACE INTO work_office_files (key, value) VALUES (?, ?)').run('vm:status', JSON.stringify({ at: 10, status, tops: { [VM_TOP]: ['General'] } }))
    const path = `${VM_TOP}\\General\\Deck.pptx`
    setMode(box.db, WS, refKey(at(path)), 'live')
    const opened = await call<FilesOpened>('work.files.open', { ref: at(path), name: 'Deck.pptx' })
    expect(opened.item).toMatchObject({ kind: 'slides', source: { at: 'microsoft', app: 'powerpoint', ref: { url: `${WEB}/General/Deck.pptx?web=1` } } })
    expect((await tabOf(opened.tabId!)).copyOf).toEqual({ host: HOST, path, vm: true })
    expect(guest).not.toHaveBeenCalled()
  })

  it('opens his copy whose changes wait instead, and a file with no address as Files would', async () => {
    const { path, copy, tabId } = await openFar('Roster.xlsx', 'workbook')
    down.add('writeBack')
    await edit(copy!, 'his edit')
    await settled()
    await call('work.files.tabClose', { tabId })
    setMode(box.db, WS, refKey(at(path, MAC)), 'live')
    const again = await call<FilesOpened>('work.files.open', { ref: at(path, MAC), name: 'Roster.xlsx' })
    expect(again.item!.source).toMatchObject({ at: 'file', path: copy })
    const mine = join(box.mine, 'Mine.docx')
    setLibraryDefault(box.db, libraryId(HOST, box.mine), 'live')
    expect((await call<FilesOpened>('work.files.open', { ref: at(mine) })).item!.source).toMatchObject({ at: 'microsoft', ref: { kind: 'path', path: mine } })
  })
})

describe('Edit here → Live', () => {
  it('swaps the item in place when nothing waits: the tab and its key stay, the mode is remembered, the copy goes', async () => {
    const { path, tabId, item } = await openFar('Roster.xlsx', 'workbook')
    const before = await tabOf(tabId)
    expect(await set(tabId)).toEqual({ is: 'done' })
    const after = await tabOf(tabId)
    expect(after).toMatchObject({ id: tabId, key: before.key, name: 'Roster.xlsx', copyOf: { host: MAC, path } })
    expect(await itemOf(tabId)).toMatchObject({ kind: 'sheet', source: { at: 'microsoft', app: 'excel', ref: { url: `${WEB}/General/Roster.xlsx?web=1` } } })
    expect(box.ctx.canvas.get(item.id)).toBeNull()
    expect(modeOf(box.db, WS, before.key!, null)).toBe('live')
    await new Promise((done) => setTimeout(done, 10))
    await settled()
    expect(copyRecord(box.ctx, WS, MAC, path)).toBeNull()
    // Already live: nothing moves.
    const live = await itemOf(tabId)
    expect(await set(tabId)).toEqual({ is: 'done' })
    expect((await itemOf(tabId)).id).toBe(live.id)
  })

  it('waits for a send under way, then switches with his change on the Mac', async () => {
    const { path, copy, tabId } = await openFar('Roster.xlsx', 'workbook')
    let release = (): void => {}
    hold = new Promise((done) => (release = done))
    await edit(copy!, 'his edit')
    let answered = false
    const switching = set(tabId).then((r) => ((answered = true), r))
    await new Promise((done) => setTimeout(done, 20))
    expect(answered).toBe(false)
    release()
    expect(await switching).toEqual({ is: 'done' })
    expect(readFileSync(path, 'utf8')).toBe('his edit')
    expect(isLiveSource((await itemOf(tabId)).source)).toBe(true)
  })

  it('asks when a send does not land within its wait', async () => {
    liveTiming.send = 30
    const { copy, tabId, item } = await openFar('Roster.xlsx', 'workbook')
    let release = (): void => {}
    hold = new Promise((done) => (release = done))
    await edit(copy!, 'his edit')
    expect(await set(tabId)).toMatchObject({ is: 'ask', why: 'away' })
    expect((await itemOf(tabId)).id).toBe(item.id)
    release()
    await settled()
  })

  it('asks over a file that changed there, and with Keep Both saves his beside it, then goes live on that file', async () => {
    const { path, copy, tabId, item } = await openFar('Roster.xlsx', 'workbook')
    writeFileSync(path, 'a colleague saved')
    utimesSync(path, new Date(), new Date(Date.now() + 5000))
    await edit(copy!, 'his edit')
    await settled()
    expect(await set(tabId)).toEqual({ is: 'ask', why: 'changed', words: 'Roster.xlsx changed on its computer since you opened it. Keep Both saves your changes beside it.' })
    expect((await itemOf(tabId)).id).toBe(item.id)
    expect(await set(tabId, { choice: 'keep-both' })).toEqual({ is: 'done' })
    const mine = join(dirname(path), 'Roster (mine).xlsx')
    expect(readFileSync(mine, 'utf8')).toBe('his edit')
    expect(readFileSync(path, 'utf8')).toBe('a colleague saved')
    expect(await tabOf(tabId)).toMatchObject({ id: tabId, name: 'Roster (mine).xlsx', copyOf: { host: MAC, path: mine } })
    expect((await itemOf(tabId)).source).toMatchObject({ ref: { url: `${WEB}/General/Roster%20(mine).xlsx?web=1` } })
  })

  it('asks over a file that went', async () => {
    const { path, copy, tabId } = await openFar('Roster.xlsx', 'workbook')
    rmSync(path)
    await edit(copy!, 'his edit')
    await settled()
    // The Mac lists its library from its cache: the file's address is still known.
    expect(await set(tabId)).toMatchObject({ is: 'ask', why: 'gone' })
  })

  it('asks while the Mac does not answer, and with the choice leaves the copy to send once it does', async () => {
    const { path, copy, tabId } = await openFar('Roster.xlsx', 'workbook')
    down.add('writeBack')
    await edit(copy!, 'his edit')
    await settled()
    expect(await set(tabId)).toMatchObject({ is: 'ask', why: 'away' })
    expect(await set(tabId, { choice: 'keep-both' })).toEqual({ is: 'done' })
    await settled()
    expect(copyRecord(box.ctx, WS, MAC, path)).toMatchObject({ state: 'away', closed: 1 })
    expect(existsSync(copy!)).toBe(true)
  })

  it('asks when the Mac refused the change, with its words', async () => {
    const { copy, tabId } = await openFar('Roster.xlsx', 'workbook')
    refused.add('writeBack')
    await edit(copy!, 'his edit')
    await settled()
    expect(await set(tabId)).toEqual({ is: 'ask', why: 'refused', words: 'Your changes to Roster.xlsx were refused: The Mac refused the save.' })
  })

  describe('a Word file’s document', () => {
    /** The document kind's import of the copy, as the importer does it: where Files says, then the item's replace. */
    async function imported() {
      const opened = await openFar('Plan.docx', 'word bytes')
      const doc = join(wordImportPlace(box.ctx, opened.copy!, opened.item.id)!, 'Plan.tcdoc')
      writeFileSync(doc, '{"doc":1}')
      box.ctx.canvas.replace(filesPaneOf(WS), opened.item.id, 'document', at(doc), 'Plan')
      return { ...opened, doc }
    }
    const touch = (doc: string, bytes: string, ahead: number) => {
      writeFileSync(doc, bytes)
      utimesSync(doc, new Date(), new Date(Date.now() + ahead))
    }

    it('asks when it holds edits the Word file has not', async () => {
      const { doc, tabId } = await imported()
      touch(doc, '{"doc":"his edit"}', 5000)
      expect(await set(tabId)).toEqual({ is: 'ask', why: 'word', words: 'Your edits to Plan.docx are not in the Word file yet.' })
      expect(readFileSync(doc, 'utf8')).toBe('{"doc":"his edit"}')
    })

    it('switches once they are saved as Word, and leaves no document for a later Edit here to show', async () => {
      const { doc, tabId, path } = await imported()
      touch(doc, '{"doc":"his edit"}', 5000)
      await call('work.files.wordSave', { tabId })
      expect(await set(tabId)).toEqual({ is: 'done' })
      expect(existsSync(doc)).toBe(false)
      expect(wordRow(box.ctx, WS, MAC, path)?.doc ?? null).toBeNull()
      // Word on the web changed the file; Edit here reads it, not the old document.
      writeFileSync(path, 'word, edited on the web')
      expect(await set(tabId, { mode: 'here' })).toEqual({ is: 'done' })
      const item = await itemOf(tabId)
      expect(item.source.at === 'file' && readFileSync(item.source.path, 'utf8')).toBe('word, edited on the web')
      expect(wordRow(box.ctx, WS, MAC, path)).toMatchObject({ doc: null })
    })

    it('switches over a document he only looked at', async () => {
      const { doc, tabId } = await imported()
      expect(await set(tabId)).toEqual({ is: 'done' })
      expect(existsSync(doc)).toBe(false)
    })
  })

  it('is his press alone', async () => {
    const { tabId } = await openFar('Roster.xlsx', 'workbook')
    await expect(set(tabId, {}, thread())).rejects.toThrow()
    expect(METHOD_CAPABILITY['work.office.live.set']).toBe('operate')
    expect(ClientRequestSchema.safeParse({ id: '1', method: 'work.office.live.set', params: { workspaceId: WS, tabId, mode: 'live', choice: 'discard' } }).success).toBe(false)
  })
})

describe('Live → Edit here', () => {
  /** A file of this host's library, live in its tab. */
  async function liveHere() {
    setRoots(box.db, [{ folder: box.team, web: WEB }])
    const path = join(box.team, 'General', 'Plan.docx')
    const opened = await call<FilesOpened>('work.files.open', { ref: at(path) })
    expect(await set(opened.tabId!)).toEqual({ is: 'done' })
    return { path, tabId: opened.tabId!, key: (await tabOf(opened.tabId!)).key }
  }

  it('opens the file fresh in the same tab, and remembers Edit here', async () => {
    const { path, tabId, key } = await liveHere()
    expect(await set(tabId, { mode: 'here' })).toEqual({ is: 'done' })
    expect(await itemOf(tabId)).toMatchObject({ kind: 'document', source: { at: 'microsoft', ref: { kind: 'path', path } } })
    expect(await tabOf(tabId)).toMatchObject({ id: tabId, key })
    expect(modeOf(box.db, WS, key!, null)).toBe('here')
  })

  it('after typing, waits for the file’s version to move', async () => {
    const { path, tabId } = await liveHere()
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    let done = false
    const switching = set(tabId, { mode: 'here', typed: 12 }).then(() => (done = true))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(done).toBe(false)
    expect(isLiveSource((await itemOf(tabId)).source)).toBe(true)
    writeFileSync(path, 'word, with his typing')
    await vi.advanceTimersByTimeAsync(1_000)
    await switching
    expect(done).toBe(true)
    expect((await itemOf(tabId)).source).toMatchObject({ ref: { kind: 'path', path } })
  })

  it('after typing, opens what is there once 60 s pass', async () => {
    const { tabId } = await liveHere()
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    let done = false
    const switching = set(tabId, { mode: 'here', typed: 3 }).then(() => (done = true))
    await vi.advanceTimersByTimeAsync(59_000)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    await switching
    expect(done).toBe(true)
    expect(isLiveSource((await itemOf(tabId)).source)).toBe(false)
  })

  it('opens a far file as its copy again', async () => {
    const { path, tabId } = await openFar('Roster.xlsx', 'workbook')
    expect(await set(tabId)).toEqual({ is: 'done' })
    await new Promise((done) => setTimeout(done, 10))
    await settled()
    writeFileSync(path, 'workbook, edited on the web')
    expect(await set(tabId, { mode: 'here' })).toEqual({ is: 'done' })
    const item = await itemOf(tabId)
    expect(item).toMatchObject({ kind: 'sheet', source: { at: 'file', host: HOST } })
    expect(readFileSync(canvasSourcePath(item.source)!, 'utf8')).toBe('workbook, edited on the web')
    expect(copyRecord(box.ctx, WS, MAC, path)).toMatchObject({ state: 'ok', closed: 0 })
  })
})
