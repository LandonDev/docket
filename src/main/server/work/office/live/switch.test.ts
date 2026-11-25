import { shiftMtime } from '../../mtime.testkit'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
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
import { forgetUploads, setUploadReader, uploadTiming } from '../../files/uploads'
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
import { liveTiming, sameName } from './switch'

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
  uploadTiming.every = 5
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
  uploadTiming.every = 2000
  forgetUploads()
  setUploadReader(null)
  Object.assign(liveTiming, { send: 30_000, upload: 30_000, version: 60_000, look: 1_000 })
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

  it('waits for OneDrive to take his send up, and stays as it is while it has not', async () => {
    Object.assign(liveTiming, { upload: 60, look: 5 })
    // The Mac's OneDrive has not uploaded the bytes the send wrote.
    let up = false
    setUploadReader(async () => up)
    const { copy, tabId, item } = await openFar('Roster.xlsx', 'workbook')
    await edit(copy!, 'his edit')
    await settled()
    await expect(set(tabId)).rejects.toThrow('Your changes to Roster.xlsx are still uploading to OneDrive. Try Live again in a moment.')
    expect((await itemOf(tabId)).id).toBe(item.id)
    // Uploaded: the web shows his change, and the switch goes.
    up = true
    expect(await set(tabId)).toEqual({ is: 'done' })
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
    shiftMtime(path, 5000)
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
      shiftMtime(doc, ahead)
    }

    it('asks when it holds edits the Word file has not', async () => {
      const { doc, tabId } = await imported()
      touch(doc, '{"doc":"his edit"}', 5000)
      expect(await set(tabId)).toEqual({ is: 'ask', why: 'word', words: 'Your edits to Plan.docx are not in the Word file yet.' })
      expect(readFileSync(doc, 'utf8')).toBe('{"doc":"his edit"}')
    })

    it('asks while his words are in the service and not in the Word file, whatever the autosave last saw, and keeps the document', async () => {
      const { doc, tabId } = await imported()
      // The autosave saw the document at r1, as made of the Word file; he typed since (r2), and the .tcdoc is not written yet.
      box.db.prepare(`UPDATE work_files_word SET base_rev = 'r1' WHERE doc = ?`).run(doc)
      let rev = 'r2'
      ;(box.ctx as { service: unknown }).service = { internal: async (route: string) => (route === '/internal/docs/rev' ? { rev } : null) }
      expect(await set(tabId)).toEqual({ is: 'ask', why: 'word', words: 'Your edits to Plan.docx are not in the Word file yet.' })
      expect(existsSync(doc)).toBe(true)
      // Back at what the Word file holds: nothing of his is lost, and the switch goes.
      rev = 'r1'
      expect(await set(tabId)).toEqual({ is: 'done' })
      expect(existsSync(doc)).toBe(false)
    })

    it('keeps the document when the service cannot say what it holds, however old the file looks', async () => {
      const { doc, tabId, item } = await imported()
      // Made of the Word file at r1, its file untouched since: only the service knows whether he typed.
      box.db.prepare(`UPDATE work_files_word SET base_rev = 'r1' WHERE doc = ?`).run(doc)
      ;(box.ctx as { service: unknown }).service = {
        internal: async (route: string) => {
          if (route === '/internal/docs/rev') throw new Error('The Work service is not answering.')
          return { ok: true }
        }
      }
      expect(await set(tabId)).toEqual({ is: 'ask', why: 'word', words: 'Your edits to Plan.docx are not in the Word file yet.' })
      expect(existsSync(doc)).toBe(true)
      expect((await itemOf(tabId)).source).toMatchObject({ at: 'file', path: doc })
      expect(item.id).toBeTruthy()
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

  it('after typing, stays live once 60 s pass with nothing come down, even over a new time on the same bytes', async () => {
    const { path, tabId } = await liveHere()
    Object.assign(liveTiming, { version: 80, look: 5 })
    let failed: unknown = null
    const switching = set(tabId, { mode: 'here', typed: 3 }).catch((err: unknown) => (failed = err))
    // OneDrive is frozen; something restamps the file without his words.
    shiftMtime(path, 5000)
    await new Promise((done) => setTimeout(done, 30))
    expect(failed).toBeNull()
    await switching
    expect(String(failed)).toContain('What you typed in Plan.docx has not come down from OneDrive yet, so it stays live.')
    expect(isLiveSource((await itemOf(tabId)).source)).toBe(true)
    expect(modeOf(box.db, WS, (await tabOf(tabId)).key!, null)).toBe('live')
  })

  it('after typing, takes only a change made after his last key in the live seat, never an earlier sync', async () => {
    const { path, tabId } = await liveHere()
    Object.assign(liveTiming, { version: 2_000, look: 5 })
    // OneDrive brought down a save from earlier in the session, 5 s before his last key (1 s before the press).
    writeFileSync(path, 'word, with his first words')
    shiftMtime(path, -5000)
    let done = false
    const switching = set(tabId, { mode: 'here', typed: 12, quiet: 1000 }).then(() => (done = true))
    await new Promise((settle) => setTimeout(settle, 60))
    expect(done).toBe(false)
    expect(isLiveSource((await itemOf(tabId)).source)).toBe(true)
    // The save after the unload comes down: that change holds his last key.
    writeFileSync(path, 'word, with every word')
    await switching
    expect((await itemOf(tabId)).source).toMatchObject({ ref: { kind: 'path', path } })
  })

  it('after typing, takes at once a change already made after his last key', async () => {
    const { path, tabId } = await liveHere()
    Object.assign(liveTiming, { version: 2_000, look: 5 })
    writeFileSync(path, 'word, with every word')
    shiftMtime(path, -1000)
    expect(await set(tabId, { mode: 'here', typed: 12, quiet: 30_000 })).toEqual({ is: 'done' })
  })

  it("after typing, takes at once a change on his Mac made after his last key, by the Mac's own clock", async () => {
    const { path, tabId } = await openFar('Plan.docx', 'word')
    expect(await set(tabId)).toEqual({ is: 'done' })
    Object.assign(liveTiming, { version: 200, look: 5 })
    // Word for the web said Saved: OneDrive has brought his typing down to the Mac before his press.
    writeFileSync(path, 'word, with every word')
    shiftMtime(path, -1000)
    const t0 = Date.now()
    expect(await set(tabId, { mode: 'here', typed: 12, quiet: 30_000 })).toEqual({ is: 'done' })
    expect(Date.now() - t0).toBeLessThan(150)
  })

  it('after typing, never takes a later sync of a save from before his last key: the seat stays live', async () => {
    const { path, tabId } = await liveHere()
    Object.assign(liveTiming, { version: 150, look: 5 })
    let failed: unknown = null
    const switching = set(tabId, { mode: 'here', typed: 12, quiet: 1000 }).catch((err: unknown) => (failed = err))
    await new Promise((settle) => setTimeout(settle, 30))
    // A save from 5 s before his last key comes down late, while the switch waits.
    writeFileSync(path, 'word, with his first words')
    shiftMtime(path, -5000)
    await switching
    expect(String(failed)).toContain('has not come down from OneDrive yet')
    expect(isLiveSource((await itemOf(tabId)).source)).toBe(true)
  })

  /** A dummy Word file whose own properties name who saved it. */
  const savedBy = (who: string, words: string): Uint8Array =>
    zipSync(
      {
        'docProps/core.xml': strToU8(`<?xml version="1.0"?><cp:coreProperties xmlns:cp="x" xmlns:dc="y"><cp:lastModifiedBy>${who}</cp:lastModifiedBy></cp:coreProperties>`),
        'word/document.xml': strToU8(`<w:document>${words}</w:document>`)
      },
      { level: 0 }
    )
  /** His name in Work, as Settings keeps it (the app's own table, which the rig's database lacks). */
  const hisName = (name: string): void => {
    box.db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    box.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('work.ownerName', name)
  }

  it("after typing, never takes a coauthor's save from between his last key and the press: it may not hold his words", async () => {
    const { path, tabId } = await liveHere()
    hisName('Landon')
    Object.assign(liveTiming, { version: 80, look: 5 })
    // Dana saved after his last key, before Word had sent his typing up: only her edit is in it.
    writeFileSync(path, savedBy('Dana Lee', 'her edit'))
    shiftMtime(path, -500)
    expect(await set(tabId, { mode: 'here', typed: 12, quiet: 1000 })).toEqual({ is: 'ask', why: 'other', name: 'Dana Lee', words: 'Dana Lee saved Plan.docx after your last key, and nothing shows your typing in that save, so it stays live until a save of yours comes down.' })
    expect(isLiveSource((await itemOf(tabId)).source)).toBe(true)
  })

  it('after typing, takes at once his own save from after his last key, under the name Office saved it by', async () => {
    const { path, tabId } = await liveHere()
    hisName('Landon')
    Object.assign(liveTiming, { version: 2_000, look: 5 })
    writeFileSync(path, savedBy('Landon Johnson', 'his typing'))
    shiftMtime(path, -500)
    expect(await set(tabId, { mode: 'here', typed: 12, quiet: 1000 })).toEqual({ is: 'done' })
  })

  it("after typing, takes a coauthor's save made after the press: Teams had his words by then", async () => {
    const { path, tabId } = await liveHere()
    hisName('Landon')
    Object.assign(liveTiming, { version: 2_000, look: 5 })
    writeFileSync(path, savedBy('Dana Lee', 'her edit'))
    shiftMtime(path, -500)
    let done = false
    const switching = set(tabId, { mode: 'here', typed: 12, quiet: 1000 }).then(() => (done = true))
    await new Promise((settle) => setTimeout(settle, 40))
    expect(done).toBe(false)
    writeFileSync(path, savedBy('Dana Lee', 'her edit and his typing'))
    shiftMtime(path, 1000)
    await switching
    expect((await itemOf(tabId)).source).toMatchObject({ ref: { kind: 'path', path } })
  })

  it('after a refusal, the next press with no keys counted still waits: the guest that came back counts from zero', async () => {
    const { path, tabId } = await liveHere()
    Object.assign(liveTiming, { version: 60, look: 5 })
    await expect(set(tabId, { mode: 'here', typed: 12, quiet: 1000 })).rejects.toThrow('has not come down from OneDrive yet')
    // He presses again at once, in the guest that came back: it read no keys.
    await expect(set(tabId, { mode: 'here', typed: 0 })).rejects.toThrow('has not come down from OneDrive yet')
    expect(isLiveSource((await itemOf(tabId)).source)).toBe(true)
    // His typing comes down: the next press takes it, and the one after that asks nothing more.
    writeFileSync(path, 'word, with every word')
    expect(await set(tabId, { mode: 'here' })).toEqual({ is: 'done' })
    expect(await set(tabId)).toEqual({ is: 'done' })
    expect(await set(tabId, { mode: 'here' })).toEqual({ is: 'done' })
  })

  it("after a refusal, a later press reads his last key from the first: a coauthor's save before it still holds the seat", async () => {
    const { path, tabId } = await liveHere()
    hisName('Landon')
    Object.assign(liveTiming, { version: 60, look: 5 })
    writeFileSync(path, savedBy('Dana Lee', 'her edit'))
    shiftMtime(path, -500)
    expect(await set(tabId, { mode: 'here', typed: 12, quiet: 1000 })).toMatchObject({ is: 'ask', why: 'other', name: 'Dana Lee' })
    await new Promise((settle) => setTimeout(settle, 20))
    expect(await set(tabId, { mode: 'here' })).toMatchObject({ is: 'ask', why: 'other', name: 'Dana Lee' })
  })

  it("after Switch Anyway, never takes a coauthor's save made after the press: Word did not let go with his words saved", async () => {
    const { path, tabId } = await liveHere()
    hisName('Landon')
    Object.assign(liveTiming, { version: 150, look: 5 })
    const switching = set(tabId, { mode: 'here', typed: 1, quiet: 1000, forced: true })
    await new Promise((settle) => setTimeout(settle, 30))
    writeFileSync(path, savedBy('Dana Lee', 'her edit'))
    shiftMtime(path, 1000)
    expect(await switching).toMatchObject({ is: 'ask', why: 'other', name: 'Dana Lee' })
    expect(isLiveSource((await itemOf(tabId)).source)).toBe(true)
  })

  it('after Switch Anyway, takes his own save made after the press', async () => {
    const { path, tabId } = await liveHere()
    hisName('Landon')
    Object.assign(liveTiming, { version: 2_000, look: 5 })
    const switching = set(tabId, { mode: 'here', typed: 1, quiet: 1000, forced: true })
    await new Promise((settle) => setTimeout(settle, 30))
    writeFileSync(path, savedBy('Landon Johnson', 'his words'))
    shiftMtime(path, 1000)
    expect(await switching).toEqual({ is: 'done' })
  })

  it("after typing, never takes a coauthor's save on his Mac from before the press, read there", async () => {
    const { path, tabId } = await openFar('Plan.docx', 'word')
    expect(await set(tabId)).toEqual({ is: 'done' })
    hisName('Landon')
    Object.assign(liveTiming, { version: 80, look: 5 })
    writeFileSync(path, savedBy('Dana Lee', 'her edit'))
    shiftMtime(path, -500)
    expect(await set(tabId, { mode: 'here', typed: 12, quiet: 1000 })).toMatchObject({ is: 'ask', why: 'other', name: 'Dana Lee' })
  })

  /** A dummy Word file that names only who made it, and no one who saved it since. */
  const madeBy = (who: string, words: string): Uint8Array =>
    zipSync(
      {
        'docProps/core.xml': strToU8(`<?xml version="1.0"?><cp:coreProperties xmlns:cp="x" xmlns:dc="y"><dc:creator>${who}</dc:creator></cp:coreProperties>`),
        'word/document.xml': strToU8(`<w:document>${words}</w:document>`)
      },
      { level: 0 }
    )

  it("after typing, never reads the file's maker as its saver: a file that names no saver keeps the clock's rule", async () => {
    const { path, tabId } = await liveHere()
    hisName('Landon')
    Object.assign(liveTiming, { version: 80, look: 5 })
    writeFileSync(path, madeBy('Dana Lee', 'her draft and his typing'))
    shiftMtime(path, -500)
    expect(await set(tabId, { mode: 'here', typed: 12, quiet: 1000 })).toEqual({ is: 'done' })
  })

  it("after typing, never reads the maker of a file on his Mac as its saver, read there", async () => {
    const { path, tabId } = await openFar('Plan.docx', 'word')
    expect(await set(tabId)).toEqual({ is: 'done' })
    hisName('Landon')
    Object.assign(liveTiming, { version: 80, look: 5 })
    writeFileSync(path, madeBy('Dana Lee', 'her draft and his typing'))
    shiftMtime(path, -500)
    expect(await set(tabId, { mode: 'here', typed: 12, quiet: 1000 })).toEqual({ is: 'done' })
  })

  it('reads one person by two names, by whole words', () => {
    expect(sameName('Landon', 'Landon Johnson')).toBe(true)
    expect(sameName('landon johnson', 'Johnson, Landon')).toBe(true)
    expect(sameName('Landon', 'Landonia Smith')).toBe(false)
    expect(sameName('Dana Lee', 'Landon')).toBe(false)
    // His first name and his last name or its initial.
    expect(sameName('Landon Hale', 'Landon H.')).toBe(true)
    expect(sameName('L. Hale', 'Landon Hale')).toBe(false)
    expect(sameName('Landon Hale', 'Lana H.')).toBe(false)
    expect(sameName('Landon Hale', 'Landon K.')).toBe(false)
  })

  it("after typing, takes a save under a name he says is his, then and from then on", async () => {
    const { path, tabId } = await liveHere()
    hisName('Landon Hale')
    Object.assign(liveTiming, { version: 60, look: 5 })
    writeFileSync(path, savedBy('lhale', 'his typing'))
    shiftMtime(path, -500)
    expect(await set(tabId, { mode: 'here', typed: 12, quiet: 1000 })).toMatchObject({ is: 'ask', why: 'other', name: 'lhale' })
    expect(isLiveSource((await itemOf(tabId)).source)).toBe(true)
    // That's Me: the same press again, naming the save as his.
    expect(await set(tabId, { mode: 'here', mine: 'lhale' })).toEqual({ is: 'done' })
    expect(await set(tabId)).toEqual({ is: 'done' })
    writeFileSync(path, savedBy('lhale', 'his typing, and more'))
    shiftMtime(path, -500)
    expect(await set(tabId, { mode: 'here', typed: 3, quiet: 1000 })).toEqual({ is: 'done' })
  })

  it("takes That's Me by the asked press's last key, whatever `quiet` a window resends from it", async () => {
    const { path, tabId } = await liveHere()
    hisName('Landon Hale')
    Object.assign(liveTiming, { version: 150, look: 5 })
    // His save as lhale came down 100 ms after his last key.
    writeFileSync(path, savedBy('lhale', 'his typing'))
    shiftMtime(path, -900)
    expect(await set(tabId, { mode: 'here', typed: 12, quiet: 1000 })).toMatchObject({ is: 'ask', why: 'other', name: 'lhale' })
    // A window a build behind sends the first press's `quiet` again with That's Me, timed back then.
    expect(await set(tabId, { mode: 'here', typed: 12, quiet: 1000, mine: 'lhale' })).toEqual({ is: 'done' })
  })

  it("after a refusal, a tab opened again keeps the base it had: his typing come down meanwhile passes the next press", async () => {
    const { path, tabId } = await liveHere()
    Object.assign(liveTiming, { version: 60, look: 5 })
    await expect(set(tabId, { mode: 'here', typed: 12, quiet: 1000 })).rejects.toThrow('has not come down from OneDrive yet')
    await call('work.files.tabClose', { tabId })
    // His typing comes down while the tab is closed; the file opens live again, as remembered.
    writeFileSync(path, 'word, with every word')
    const again = await call<FilesOpened>('work.files.open', { ref: at(path) })
    expect(isLiveSource(again.item!.source)).toBe(true)
    expect(await set(again.tabId!, { mode: 'here' })).toEqual({ is: 'done' })
  })

  it('after Switch Anyway with no keys counted, never takes a save from before the press, and takes his own after it', async () => {
    const { path, tabId } = await liveHere()
    hisName('Landon')
    Object.assign(liveTiming, { version: 60, look: 5 })
    // Dana's save is there before the press: a ribbon change counted no keys, so nothing dates his last one.
    writeFileSync(path, savedBy('Dana Lee', 'her edit'))
    shiftMtime(path, -500)
    await expect(set(tabId, { mode: 'here', typed: 1, forced: true })).rejects.toThrow('has not come down from OneDrive yet')
    expect(isLiveSource((await itemOf(tabId)).source)).toBe(true)
    // Nor a file that names no one, saved before the press.
    writeFileSync(path, 'word, of before the press')
    shiftMtime(path, -500)
    await expect(set(tabId, { mode: 'here', typed: 1, forced: true })).rejects.toThrow('has not come down from OneDrive yet')
    Object.assign(liveTiming, { version: 2_000, look: 5 })
    const switching = set(tabId, { mode: 'here', typed: 1, forced: true })
    await new Promise((settle) => setTimeout(settle, 30))
    writeFileSync(path, savedBy('Landon Johnson', 'his words'))
    shiftMtime(path, 1000)
    expect(await switching).toEqual({ is: 'done' })
  })

  it("after Switch Anyway whose first look fails, still never takes a coauthor's save: the next good look times the press", async () => {
    // Council r6 (Sol 3): a missed first stat dropped the author check for the whole wait.
    const { path, tabId } = await liveHere()
    hisName('Landon')
    Object.assign(liveTiming, { version: 150, look: 5 })
    rmSync(path)
    const switching = set(tabId, { mode: 'here', typed: 1, quiet: 1000, forced: true })
    await new Promise((settle) => setTimeout(settle, 30))
    writeFileSync(path, savedBy('Dana Lee', 'her edit'))
    shiftMtime(path, 1000)
    expect(await switching).toMatchObject({ is: 'ask', why: 'other', name: 'Dana Lee' })
    expect(isLiveSource((await itemOf(tabId)).source)).toBe(true)
    // His own save after that look passes.
    Object.assign(liveTiming, { version: 2_000, look: 5 })
    const again = set(tabId, { mode: 'here', typed: 1, quiet: 1000, forced: true })
    await new Promise((settle) => setTimeout(settle, 30))
    writeFileSync(path, savedBy('Landon Johnson', 'his words'))
    shiftMtime(path, 3000)
    expect(await again).toEqual({ is: 'done' })
  })

  it('after typing, a press whose first look fails never takes a late sync of a save from before his last key', async () => {
    // Council r7 (Opus 1, Sol 3): a plain press timed nothing when its first look failed, so any change passed.
    const { path, tabId } = await liveHere()
    Object.assign(liveTiming, { version: 150, look: 5 })
    rmSync(path)
    const switching = set(tabId, { mode: 'here', typed: 12, quiet: 1000 })
    await new Promise((settle) => setTimeout(settle, 30))
    // A save from 4 s before his last key comes down late.
    writeFileSync(path, 'word, with his first words')
    shiftMtime(path, -5000)
    await expect(switching).rejects.toThrow('has not come down from OneDrive yet')
    expect(isLiveSource((await itemOf(tabId)).source)).toBe(true)
  })

  it("after typing, a press whose first look fails never takes a coauthor's save from between his last key and the press", async () => {
    const { path, tabId } = await liveHere()
    hisName('Landon')
    Object.assign(liveTiming, { version: 150, look: 5 })
    rmSync(path)
    const switching = set(tabId, { mode: 'here', typed: 12, quiet: 1000 })
    await new Promise((settle) => setTimeout(settle, 30))
    // Dana saved half a second before the press; her save comes down after the missed look.
    writeFileSync(path, savedBy('Dana Lee', 'her edit'))
    shiftMtime(path, -530)
    expect(await switching).toMatchObject({ is: 'ask', why: 'other', name: 'Dana Lee' })
    expect(isLiveSource((await itemOf(tabId)).source)).toBe(true)
  })

  it('after Switch Anyway with no keys counted and a failed first look, takes his own save from before the next good look', async () => {
    // The next good look reads the holder's clock at the press, never at its own later time.
    const { path, tabId } = await liveHere()
    hisName('Landon')
    Object.assign(liveTiming, { version: 2_000, look: 5 })
    rmSync(path)
    const switching = set(tabId, { mode: 'here', typed: 1, forced: true })
    await new Promise((settle) => setTimeout(settle, 60))
    // His save lands just after the press, before any look sees the file again.
    writeFileSync(path, savedBy('Landon Johnson', 'his words'))
    shiftMtime(path, -40)
    expect(await switching).toEqual({ is: 'done' })
  })

  it("under a refusal that stands, takes a coauthor's save made long after his last key: Word had merged his typing into it", async () => {
    // Council r6 (Opus 1): a coworker's save hours after his last key asked "Is Dana Lee you?" on every press.
    const { path, tabId } = await liveHere()
    hisName('Landon')
    Object.assign(liveTiming, { version: 60, look: 5 })
    // His last key ten minutes ago; nothing came down, so the press is refused and the refusal stands.
    await expect(set(tabId, { mode: 'here', typed: 12, quiet: 600_000 })).rejects.toThrow('has not come down from OneDrive yet')
    // Nine minutes after his last key, Dana saves: by then Teams held his typing.
    writeFileSync(path, savedBy('Dana Lee', 'her edit and his typing'))
    shiftMtime(path, -60_000)
    expect(await set(tabId, { mode: 'here' })).toEqual({ is: 'done' })
  })

  it('takes a name as his only from his press', async () => {
    const { path, tabId } = await liveHere()
    hisName('Landon Hale')
    Object.assign(liveTiming, { version: 60, look: 5 })
    writeFileSync(path, savedBy('Dana Lee', 'her edit'))
    shiftMtime(path, -500)
    await expect(set(tabId, { mode: 'here', typed: 12, quiet: 1000, mine: 'Dana Lee' }, thread())).rejects.toThrow()
    expect(await set(tabId, { mode: 'here', typed: 12, quiet: 1000 })).toMatchObject({ is: 'ask', why: 'other', name: 'Dana Lee' })
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
