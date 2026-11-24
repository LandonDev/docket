import { existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientRequestSchema, type ClientRequest } from '@shared/contract'
import type { CopyBack, FilesOpened, FilesTabs } from '@shared/contract-work-files'
import { canvasSourcePath, filesPaneOf } from '@shared/work'
import { copySavesBack } from '@shared/work/files'
import type { Caller } from '../modules'
import { copyDirOf, dropItemCopies, filesHandle as officeHandle } from '../office/files/handle'
import { setCloudDir, setCopyAllowed } from '../office/files/library'
import { copiesInFlight, copiesLeft, copyRecord, copySaved, copyTiming, retryWaiting, sendBack, settleCopies } from './copies'
import { closeFilesState, filesHandle, filesState, itemsGone } from './handle'
import { forgetLibraries } from './places/libraries'
import { setThreadsMayWrite, sharedOf } from './policy'
import { fileWritten, onFileSaved, saveFile, versionWord, workingOn } from './save'
import { approver, HOST, makeRig, phone, reader, thread, window, WS, type Rig } from './testkit'
import { versionOf } from './write'
import { adoptWordCopies, autosaveWords, wordFollowed, wordImportPlace, wordRow, wordsLeft } from './word'

// Save as Word writes the Work service's Word export; here a stand-in's bytes.
vi.mock('../formats/exporter', () => ({ exportDoc: async () => ({ name: 'Plan.docx', data: Buffer.from('word export').toString('base64'), warnings: [] }) }))

/**
 * A copy saves back (copies.ts): two hosts, the workspace's (`env_box`) and his Mac (`env_mac`) with a dummy Teams
 * library, joined by a stand-in of the host link that runs the Mac's own handlers for a peer, as `servePeerWork`
 * does, after the contract has read the call. Dummy files only.
 */

const MAC = 'env_mac'
const AS_PEER: Caller = { kind: 'remote', caps: ['read', 'operate'], peer: HOST }

let box: Rig
let mac: Rig
let far: { module: string; verb: string; args: Record<string, unknown> }[]
let macUp: boolean
let refuse: string | null
let hold: Promise<void> | null
let offSaved: () => void

beforeEach(() => {
  box = makeRig()
  mac = makeRig()
  ;(mac.ctx as { host: string }).host = MAC
  setCloudDir((host) => (host === HOST ? box.cloud : host === MAC ? mac.cloud : join(box.base, 'no-cloud')))
  forgetLibraries(box.db)
  forgetLibraries(mac.db)
  setCopyAllowed(box.db, WS, true)
  setThreadsMayWrite(true)
  copyTiming.grace = 0
  far = []
  macUp = true
  refuse = null
  hold = null
  Object.assign(box.ctx, {
    peer(this: unknown, host: string) {
      return {
        async call(module: string, verb: string, args: Record<string, unknown>) {
          far.push({ module, verb, args })
          if (!macUp || host !== MAC) throw new Error(`host offline: ${host} has no live link to this host`)
          if (refuse) throw new Error(refuse)
          if (hold && verb === 'writeBack') await hold
          const req = ClientRequestSchema.parse({ id: 'peer', method: `work.${module}.${verb}`, params: args }) as ClientRequest
          const out = module === 'office' ? await officeHandle(req, mac.ctx, AS_PEER, () => null) : await filesHandle(req, mac.ctx, AS_PEER)
          if (!out.handled) throw new Error(`${req.method} is not answered there`)
          return out.result
        }
      }
    }
  })
  // The module's start does this (index.ts): a save through the door of a copy's path sends it.
  offSaved = onFileSaved((path) => copySaved(box.ctx, path))
})
afterEach(() => {
  offSaved()
  setThreadsMayWrite(false)
  copyTiming.grace = 3000
  closeFilesState(box.db)
  closeFilesState(mac.db)
  mac.close()
  box.close()
})

const call = async <T>(method: string, params: Record<string, unknown>, by: Caller = window): Promise<T> => {
  const out = await filesHandle({ id: '1', method, params: { workspaceId: WS, ...params } } as never, box.ctx, by)
  return (out as { result: T }).result
}
const settled = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.all(copiesInFlight())
}
const writes = (): number => far.filter((c) => c.verb === 'writeBack').length

/** A file of the Mac's team library opened in a Files tab here: its copy, its tab and its path on the Mac. */
async function openFar(name: string, bytes: string) {
  const path = join(mac.team, 'General', name)
  writeFileSync(path, bytes)
  const opened = await call<FilesOpened>('work.files.open', { ref: { at: 'file', host: MAC, path }, name })
  const copy = canvasSourcePath(opened.item!.source)!
  return { path, copy, tabId: opened.tabId!, item: opened.item! }
}
const backOf = async (tabId: string): Promise<CopyBack | undefined> => (await call<FilesTabs>('work.files.tabs', {})).tabs.find((t) => t.id === tabId)?.back
/** The sheet editor's save of the copy: its bytes through Files' one door, by the version it read. */
const editorSaves = async (copy: string, bytes: string): Promise<void> => {
  const got = await saveFile({ roots: [dirname(copy)] }, `file::${copy}`, copy, Buffer.from(bytes), versionWord(await versionOf(copy)))
  expect('version' in got).toBe(true)
}

describe('a copy is made with where its file lies', () => {
  it("keeps the file's host, path and version, read in one look with its bytes, and the copy is as shared as the file", async () => {
    const { path, copy, tabId } = await openFar('Roster.xlsx', 'workbook one')
    const r = copyRecord(box.ctx, WS, MAC, path)!
    expect(r).toMatchObject({ host: MAC, path, vm: 0, kind: 'sheet', state: 'ok', closed: 0 })
    expect(r.version).toBe(versionWord(await versionOf(path)))
    expect(readFileSync(copy, 'utf8')).toBe('workbook one')
    // The Mac answered its bytes and their version together.
    expect(far.map((c) => `${c.module}.${c.verb}`)).toEqual(['office.filesRead'])
    expect(await backOf(tabId)).toEqual({ is: 'ok', writes: 0, held: 0 })
    // Every editor's hold for a shared file reads this: the copy, and a document made beside it.
    expect(sharedOf(box.ctx, { at: 'file', host: HOST, path: copy })).toBe(true)
    expect(sharedOf(box.ctx, { at: 'file', host: HOST, path: join(dirname(copy), 'Roster.tcdoc') })).toBe(true)
  })

  it('keeps no record for a kind that edits no bytes of the copy: a document opens on a copy whose changes stay here', async () => {
    const { path, copy } = await openFar('Plan.docx', 'word')
    expect(copyRecord(box.ctx, WS, MAC, path)).toBeNull()
    expect(sharedOf(box.ctx, { at: 'file', host: HOST, path: copy })).toBe(false)
    expect(copySavesBack('document', 'Plan.docx')).toBe(false)
    expect(copySavesBack('sheet', 'Roster.xlsx')).toBe(true)
    expect(copySavesBack('sheet', 'Roster.csv')).toBe(false)
    expect(copySavesBack('slides', 'Deck.pptx')).toBe(true)
    expect(copySavesBack('file', 'Agenda.md')).toBe(true)
  })
})

describe('his save goes back to the file', () => {
  it("sends a save through the door to the Mac's file by its version, and the version moves", async () => {
    const { path, copy, tabId } = await openFar('Roster.xlsx', 'workbook one')
    await editorSaves(copy, 'workbook two')
    await settled()
    expect(readFileSync(path, 'utf8')).toBe('workbook two')
    const r = copyRecord(box.ctx, WS, MAC, path)!
    expect(r.version).toBe(versionWord(await versionOf(path)))
    expect(writes()).toBe(1)
    expect(far.at(-1)!.args).toMatchObject({ origin: { from: 'window' }, ref: { at: 'file', host: MAC, path } })
    const back = await backOf(tabId)
    expect(back?.is).toBe('ok')
    expect(back?.at).toBeGreaterThan(0)
  })

  it("sends what a kind wrote without the door when his window says it saved, and nothing when the bytes are the file's", async () => {
    const { path, copy, tabId } = await openFar('Kickoff.pptx', 'deck one')
    // The deck writes its file by a rename of its own: only the window's word sends it.
    writeFileSync(copy, 'deck two')
    expect(await call<CopyBack>('work.files.copyBack', { tabId })).toMatchObject({ is: 'ok' })
    expect(readFileSync(path, 'utf8')).toBe('deck two')
    expect(await call<CopyBack>('work.files.copyBack', { tabId })).toMatchObject({ is: 'ok' })
    expect(writes()).toBe(1)
  })

  it('keeps one send in flight, and sends the newest bytes once after it', async () => {
    const { path, copy } = await openFar('Roster.xlsx', 'v1')
    let open!: () => void
    hold = new Promise((r) => (open = r))
    await editorSaves(copy, 'v2')
    await editorSaves(copy, 'v3')
    await editorSaves(copy, 'v4')
    open()
    await settled()
    expect(writes()).toBe(2)
    expect(Buffer.from(far.filter((c) => c.verb === 'writeBack')[1]!.args.data as string, 'base64').toString()).toBe('v4')
    expect(readFileSync(path, 'utf8')).toBe('v4')
  })

  it('counts each write of the copy, and says the file holds one only once a send of it landed or the file is found to hold its bytes', async () => {
    const { path, copy, tabId } = await openFar('Roster.xlsx', 'v1')
    let open!: () => void
    hold = new Promise((r) => (open = r))
    await editorSaves(copy, 'v2')
    // The write is counted at once; the file does not hold it while its send is under way.
    expect(copyRecord(box.ctx, WS, MAC, path)).toMatchObject({ writes: 1, held: 0 })
    expect(await backOf(tabId)).toMatchObject({ writes: 1, held: 0 })
    open()
    await settled()
    const sent = await backOf(tabId)
    expect(sent).toMatchObject({ is: 'ok', writes: 1, held: 1 })
    expect(sent?.at).toBeGreaterThan(0)
    // A write that leaves the bytes the file holds is held by that look, and its time is the look's, not the older send's.
    await new Promise((r) => setTimeout(r, 5))
    await editorSaves(copy, 'v2')
    await settled()
    const same = await backOf(tabId)
    expect(same).toMatchObject({ is: 'ok', writes: 2, held: 2 })
    expect(same!.at!).toBeGreaterThan(sent!.at!)
    expect(writes()).toBe(1)
    expect(readFileSync(path, 'utf8')).toBe('v2')
  })

  it("leaves a write the file could not take unheld: the line can say it is not saved there", async () => {
    const { path, copy, tabId } = await openFar('Roster.xlsx', 'ours')
    writeFileSync(path, 'theirs')
    await editorSaves(copy, 'mine')
    await settled()
    expect(await backOf(tabId)).toMatchObject({ is: 'changed', writes: 1, held: 0 })
  })

  it("writes the file kind's text to the copy through the door, which sends it on", async () => {
    const { path, copy, tabId, item } = await openFar('Agenda.md', '# Agenda')
    const read = await call<{ version: string; locked?: string }>('work.files.read', { ref: item.source, itemId: item.id, offset: 0, length: 1000 })
    expect(read.locked).toBeUndefined()
    const saved = await call<{ version: string }>('work.files.write', { ref: item.source, text: '# Agenda\n- doors', version: read.version })
    expect(saved.version).toBeDefined()
    await settled()
    expect(readFileSync(path, 'utf8')).toBe('# Agenda\n- doors')
    expect(readFileSync(copy, 'utf8')).toBe('# Agenda\n- doors')
    expect((await backOf(tabId))?.is).toBe('ok')
  })
})

describe('a file that changed on its computer', () => {
  it('is never written over: the line says it changed, Reload takes theirs, Keep Both saves his beside it', async () => {
    const { path, copy, tabId } = await openFar('Roster.xlsx', 'ours')
    writeFileSync(path, 'theirs, longer')
    await editorSaves(copy, 'mine')
    await settled()
    expect(readFileSync(path, 'utf8')).toBe('theirs, longer')
    expect((await backOf(tabId))?.is).toBe('changed')
    // Nothing more is sent over it until he chooses.
    await call('work.files.copyBack', { tabId })
    expect(writes()).toBe(1)

    // Keep Both: his bytes beside the file under the keep-both name, through the same door there; the tab shows that file.
    const kept = await call<FilesTabs>('work.files.copyKeep', { tabId })
    const mine = join(mac.team, 'General', 'Roster (mine).xlsx')
    expect(readFileSync(mine, 'utf8')).toBe('mine')
    expect(readFileSync(path, 'utf8')).toBe('theirs, longer')
    const tab = kept.tabs.find((t) => t.id === tabId)!
    expect(tab).toMatchObject({ name: 'Roster (mine).xlsx', copyOf: { host: MAC, path: mine }, back: { is: 'ok' } })
    expect(box.canvas.get(tab.itemId!)!.title).toBe('Roster (mine).xlsx')
    // A save after it goes to the new file.
    await editorSaves(copy, 'mine, again')
    await settled()
    expect(readFileSync(mine, 'utf8')).toBe('mine, again')
  })

  it('Reload reads the file into the copy and drops what was not sent', async () => {
    const { path, copy, tabId } = await openFar('Roster.xlsx', 'ours')
    writeFileSync(path, 'theirs')
    await editorSaves(copy, 'mine')
    await settled()
    await call('work.files.copyReload', { tabId })
    expect(readFileSync(copy, 'utf8')).toBe('theirs')
    expect(copyRecord(box.ctx, WS, MAC, path)).toMatchObject({ state: 'ok', version: versionWord(await versionOf(path)) })
    // The write that was dropped is no longer owed: the file holds the copy as read again, and nothing is said saved.
    expect(await backOf(tabId)).toEqual({ is: 'ok', writes: 1, held: 1 })
  })

  it("Reload after Keep Both reads the file the tab now shows into the copy its item names, in the tab's one folder", async () => {
    const { copy, tabId, item } = await openFar('Roster.xlsx', 'ours')
    writeFileSync(join(mac.team, 'General', 'Roster.xlsx'), 'theirs')
    await editorSaves(copy, 'mine')
    await settled()
    await call('work.files.copyKeep', { tabId })
    const mine = join(mac.team, 'General', 'Roster (mine).xlsx')
    writeFileSync(mine, 'mine, changed on mac')
    await editorSaves(copy, 'his unsent change')
    await settled()
    expect((await backOf(tabId))?.is).toBe('changed')
    await call('work.files.copyReload', { tabId })
    // The item the tab shows still names its copy, and that copy holds the Mac's file now.
    const shown = box.canvas.get((await call<FilesTabs>('work.files.tabs', {})).tabs.find((t) => t.id === tabId)!.itemId!)!
    expect(canvasSourcePath(shown.source)).toBe(copy)
    expect(item.id).toBe(shown.id)
    expect(readFileSync(copy, 'utf8')).toBe('mine, changed on mac')
    expect(copyRecord(box.ctx, WS, MAC, mine)).toMatchObject({ copy, state: 'ok', version: versionWord(await versionOf(mine)) })
    expect(await backOf(tabId)).toEqual({ is: 'ok', writes: 2, held: 2 })
    // One folder for the tab: no other was made beside it.
    expect(readdirSync(copyDirOf(box.dataDir, filesPaneOf(WS)))).toEqual([basename(dirname(copy))])
  })

  it('a file gone there is said as gone, and nothing is made under its old name', async () => {
    const { path, copy, tabId } = await openFar('Roster.xlsx', 'ours')
    const { rmSync } = await import('node:fs')
    rmSync(path)
    await editorSaves(copy, 'mine')
    await settled()
    expect(existsSync(path)).toBe(false)
    expect((await backOf(tabId))?.is).toBe('gone')
  })
})

describe('the other computer not answering, or refusing', () => {
  it('waits here when the Mac does not answer, and is sent when its link is back', async () => {
    const { path, copy, tabId } = await openFar('Roster.xlsx', 'one')
    macUp = false
    await editorSaves(copy, 'two')
    await settled()
    expect((await backOf(tabId))?.is).toBe('away')
    expect(readFileSync(path, 'utf8')).toBe('one')
    // Looked at again: the link is still down, nothing is asked of it.
    retryWaiting(box.ctx, [])
    await settled()
    expect((await backOf(tabId))?.is).toBe('away')
    macUp = true
    retryWaiting(box.ctx, [MAC])
    await settled()
    expect(readFileSync(path, 'utf8')).toBe('two')
    expect((await backOf(tabId))?.is).toBe('ok')
  })

  it('is sent on the next save, and a send a dead process left under way waits as unanswered', async () => {
    const { path, copy, tabId } = await openFar('Roster.xlsx', 'one')
    macUp = false
    await editorSaves(copy, 'two')
    await settled()
    macUp = true
    await editorSaves(copy, 'three')
    await settled()
    expect(readFileSync(path, 'utf8')).toBe('three')
    box.db.prepare(`UPDATE work_files_copies SET state = 'sending'`).run()
    settleCopies(box.ctx)
    expect((await backOf(tabId))?.is).toBe('away')
  })

  it("says the Mac's refusal in its own words", async () => {
    const { path, copy, tabId } = await openFar('Roster.xlsx', 'one')
    refuse = 'this host\'s bridge policy for that host is "read", and work.files.writeBack needs operate (Settings → Hosts)'
    await editorSaves(copy, 'two')
    await settled()
    expect(await backOf(tabId)).toMatchObject({ is: 'refused', detail: refuse, held: 0 })
    expect(readFileSync(path, 'utf8')).toBe('one')
  })
})

describe('only his own edit goes back', () => {
  it("refuses a thread, a read key and a key that may not approve, and sends nothing for any", async () => {
    const { copy, tabId, item } = await openFar('Roster.xlsx', 'one')
    writeFileSync(copy, 'two')
    await expect(call('work.files.copyBack', { tabId }, thread('t1'))).rejects.toThrow('A thread changes files with the files_* tools.')
    await expect(call('work.files.copyBack', { tabId }, reader)).rejects.toThrow('this key may not change it')
    await expect(call('work.files.copyBack', { tabId }, phone)).rejects.toThrow('this key may not change it')
    await expect(call('work.files.write', { ref: item.source, text: 'x', version: 'v' }, thread('t1'))).rejects.toThrow('files_* tools')
    await expect(call('work.files.write', { ref: item.source, text: 'x', version: 'v' }, phone)).rejects.toThrow('this key may not change it')
    expect(writes()).toBe(0)
    // A key that may approve is his own hand.
    await call('work.files.copyBack', { tabId }, approver)
    expect(writes()).toBe(1)
  })

  it('gives a thread no route of Files to the copy: the tools and the wire refuse it, and the copy reads as shared', async () => {
    const { copy, path } = await openFar('Roster.xlsx', 'one')
    // A thread's files_* tools name a place and a path in it; the pane's copies are in no place.
    await expect(call('work.files.rename', { ref: { at: 'file', host: HOST, path: copy }, name: 'x.xlsx', op: 'op-1' }, thread('t1'))).rejects.toThrow('files_* tools')
    await expect(call('work.files.copyKeep', { tabId: 'any' }, thread('t1'))).rejects.toThrow('files_* tools')
    // A thread copying into the pane is refused: a thread copies only into itself.
    await expect(officeHandle({ id: '1', method: 'work.office.filesCopy', params: { sessionId: filesPaneOf(WS), source: { at: 'file', host: MAC, path } } } as never, box.ctx, thread('t1'), () => null)).rejects.toThrow('No such Work thread here.')
    // The editors' holds read the copy as a shared file (the sheet's suggestions, the deck's, a key's approve).
    expect(sharedOf(box.ctx, { at: 'file', host: HOST, path: copy })).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('one')
  })

  it("is admitted on the Mac only from another host of his, with its origin, for a file of a library there", async () => {
    const path = join(mac.team, 'General', 'Spring budget.xlsx')
    const ask = (by: Caller, params: Record<string, unknown>) => filesHandle({ id: '1', method: 'work.files.writeBack', params: { workspaceId: WS, ref: { at: 'file', host: MAC, path }, data: Buffer.from('x').toString('base64'), version: 'v', origin: { from: 'window' }, ...params } } as never, mac.ctx, by)
    await expect(ask(window, {})).rejects.toThrow("workspace's own host")
    await expect(ask(phone, {})).rejects.toThrow("workspace's own host")
    await expect(ask(AS_PEER, { origin: undefined })).rejects.toThrow('must say where it began')
    await expect(ask(AS_PEER, { ref: { at: 'file', host: MAC, path: join(mac.outside, 'secret.txt') } })).rejects.toThrow("not in this workspace's folder or a library")
    // A stale version is the conflict, and the file is left as it was.
    expect(await ask(AS_PEER, {}).then((a) => (a as { result: unknown }).result)).toMatchObject({ conflict: { version: expect.any(String) } })
    expect(readFileSync(path, 'utf8')).toBe('workbook')
  })
})

describe('a tab closed before its changes reached the file', () => {
  it('keeps the copy and sends it, then lets it go; reopened before, it shows what waits', async () => {
    const { path, copy, tabId } = await openFar('Roster.xlsx', 'one')
    macUp = false
    await editorSaves(copy, 'two')
    await settled()
    await call('work.files.tabClose', { tabId })
    // The tab's item went, and the copy stayed with what waits in it.
    expect(readFileSync(copy, 'utf8')).toBe('two')
    expect(copyRecord(box.ctx, WS, MAC, path)).toMatchObject({ closed: 1, state: 'away' })
    // Opened again, the tab shows the kept copy: nothing is read over it from the Mac.
    const again = await call<FilesOpened>('work.files.open', { ref: { at: 'file', host: MAC, path }, name: 'Roster.xlsx' })
    expect(canvasSourcePath(again.item!.source)).toBe(copy)
    expect(readFileSync(copy, 'utf8')).toBe('two')
    expect(far.filter((c) => c.verb === 'filesRead')).toHaveLength(1)
    await call('work.files.tabClose', { tabId: again.tabId })
    macUp = true
    retryWaiting(box.ctx, [MAC])
    await settled()
    expect(readFileSync(path, 'utf8')).toBe('two')
    expect(copyRecord(box.ctx, WS, MAC, path)).toBeNull()
    expect(existsSync(copy)).toBe(false)
  })

  it('Discard drops the copy and what waits in it at once', async () => {
    const { path, copy, tabId } = await openFar('Roster.xlsx', 'one')
    macUp = false
    await editorSaves(copy, 'two')
    await settled()
    await call('work.files.tabClose', { tabId, discard: true })
    expect(copyRecord(box.ctx, WS, MAC, path)).toBeNull()
    expect(existsSync(copy)).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('one')
  })

  it('a closed tab with nothing waiting lets its copy go once its last save had time to land', async () => {
    const { path, copy, tabId } = await openFar('Roster.xlsx', 'one')
    await call('work.files.tabClose', { tabId })
    await new Promise((r) => setTimeout(r, 5))
    await settled()
    expect(copyRecord(box.ctx, WS, MAC, path)).toBeNull()
    expect(existsSync(copy)).toBe(false)
  })

  it('Copy Teams files turned off drops the copies and what Files kept of them', async () => {
    const { path, copy } = await openFar('Roster.xlsx', 'one')
    await officeHandle({ id: '1', method: 'work.office.filesCopySet', params: { workspaceId: WS, on: false } } as never, box.ctx, window, () => null)
    expect(copyRecord(box.ctx, WS, MAC, path)).toBeNull()
    expect(existsSync(copy)).toBe(false)
    await sendBack(box.ctx, 'gone')
  })
})

/**
 * No edit is dropped in silence (.temp-code/plans/landed/F-edits-lost.md): whatever takes a copy's item away, and
 * whatever the host does at start or when Copy Teams files goes off, a copy whose changes have not reached its file
 * stays with its record until they do. Only his Discard drops it.
 */
describe('a copy with changes that have not reached its file', () => {
  /** The frame's removal hooks, the office pillar's first (the order that once took the folder). */
  const removedHooks = (): void => {
    for (const items of box.removed.splice(0)) {
      dropItemCopies(box.ctx, items)
      if (items.some((i) => i.sessionId === filesPaneOf(WS))) itemsGone(box.ctx, items.map((i) => i.id))
      copiesLeft(box.ctx, items)
    }
  }

  it("is sent by the host itself when a kind writes it its own way (the deck's replace), with no ask of his window", async () => {
    const { path, copy } = await openFar('Kickoff.pptx', 'deck one')
    writeFileSync(copy, 'deck two')
    fileWritten(copy)
    await settled()
    expect(readFileSync(path, 'utf8')).toBe('deck two')
    expect(writes()).toBe(1)
  })

  it("waits, as its tab closes, for the editor's work on it under way: his last edit lands and is sent, never let go first", async () => {
    const { path, copy, tabId } = await openFar('Kickoff.pptx', 'deck one')
    // The deck's write of his last words, sent as the tab closed, still being made when the close is judged.
    let finish: () => void = () => {}
    const work = workingOn(copy, new Promise<void>((resolve) => (finish = resolve)).then(() => {
      writeFileSync(copy, 'deck with his words')
      fileWritten(copy)
    }))
    await call('work.files.tabClose', { tabId })
    await new Promise((r) => setTimeout(r, 20))
    expect(existsSync(copy)).toBe(true)
    expect(copyRecord(box.ctx, WS, MAC, path)).toMatchObject({ closed: 1 })
    finish()
    await work
    await settled()
    expect(readFileSync(path, 'utf8')).toBe('deck with his words')
    expect(copyRecord(box.ctx, WS, MAC, path)).toBeNull()
  })

  it("keeps its copy when its item goes by another way than its tab's close, and sends it", async () => {
    const { path, copy, item } = await openFar('Roster.xlsx', 'one')
    macUp = false
    writeFileSync(copy, 'his edit')
    box.ctx.canvas.remove([item.id])
    removedHooks()
    expect(existsSync(copy)).toBe(true)
    expect(copyRecord(box.ctx, WS, MAC, path)).toMatchObject({ closed: 1 })
    macUp = true
    retryWaiting(box.ctx, [MAC])
    await settled()
    expect(readFileSync(path, 'utf8')).toBe('his edit')
    expect(copyRecord(box.ctx, WS, MAC, path)).toBeNull()
    expect(existsSync(copy)).toBe(false)
  })

  it('keeps its folder from the office pillar\'s drop while its record stands, closed or not', async () => {
    const { copy, item } = await openFar('Roster.xlsx', 'one')
    dropItemCopies(box.ctx, [item])
    expect(existsSync(copy)).toBe(true)
  })

  it('is never read over from the file when opened again while its bytes are not what the file holds', async () => {
    const { path, copy, tabId } = await openFar('Roster.xlsx', 'one')
    writeFileSync(copy, 'his unsent edit')
    // The tab's row went with nothing told (a window's list behind, a stray dropped at start).
    box.db.prepare(`DELETE FROM work_files_tabs WHERE id = ?`).run(tabId)
    const again = await call<FilesOpened>('work.files.open', { ref: { at: 'file', host: MAC, path }, name: 'Roster.xlsx' })
    expect(canvasSourcePath(again.item!.source)).toBe(copy)
    expect(readFileSync(copy, 'utf8')).toBe('his unsent edit')
    expect(far.filter((c) => c.verb === 'filesRead')).toHaveLength(1)
  })

  it('is sent after a restart once its computer answers, though no window asked before the host stopped', async () => {
    const { path, copy } = await openFar('Notes.txt', 'one')
    writeFileSync(copy, 'typed before the restart')
    settleCopies(box.ctx)
    retryWaiting(box.ctx, [MAC])
    await settled()
    expect(readFileSync(path, 'utf8')).toBe('typed before the restart')
    expect(copyRecord(box.ctx, WS, MAC, path)).toMatchObject({ state: 'ok', closed: 0 })
  })

  it('stays when Copy Teams files goes off, and is sent; a copy with nothing waiting goes', async () => {
    const waiting = await openFar('Roster.xlsx', 'one')
    const clean = await openFar('Notes.txt', 'notes')
    macUp = false
    writeFileSync(waiting.copy, 'his edit')
    await officeHandle({ id: '1', method: 'work.office.filesCopySet', params: { workspaceId: WS, on: false } } as never, box.ctx, window, () => null)
    expect(readFileSync(waiting.copy, 'utf8')).toBe('his edit')
    expect(copyRecord(box.ctx, WS, MAC, waiting.path)).not.toBeNull()
    expect(copyRecord(box.ctx, WS, MAC, clean.path)).toBeNull()
    expect(existsSync(clean.copy)).toBe(false)
    macUp = true
    await sendBack(box.ctx, copyRecord(box.ctx, WS, MAC, waiting.path)!.id)
    expect(readFileSync(waiting.path, 'utf8')).toBe('his edit')
  })
})

describe("his window on another computer of his (a key that may approve)", () => {
  it("reads a text copy's words and saves them back; a read key reads none", async () => {
    const { path, copy, tabId, item } = await openFar('Notes.txt', 'notes')
    const read = await call<{ data: string; version: string; locked?: string }>('work.files.read', { ref: item.source, itemId: item.id, offset: 0, length: 1000 }, approver)
    expect(Buffer.from(read.data, 'base64').toString()).toBe('notes')
    expect(read.locked).toBeUndefined()
    await expect(call('work.files.read', { ref: item.source, itemId: item.id, offset: 0, length: 1000 }, reader)).rejects.toThrow()
    await call('work.files.write', { ref: item.source, text: 'notes, typed on his Mac', version: read.version }, approver)
    await settled()
    expect(readFileSync(path, 'utf8')).toBe('notes, typed on his Mac')
    expect((await backOf(tabId))?.is).toBe('ok')
    expect(readFileSync(copy, 'utf8')).toBe('notes, typed on his Mac')
  })
})

/**
 * A Word file of another computer (word.ts, the owner's ruling of 2026-11-23): opened in a Files tab it becomes a
 * document kept in the workspace's own folder; the Word file changes only by Save as Word, over it by version, or
 * beside it with Keep Both.
 */
describe('a Word file of another computer', () => {
  /** The document kind's import of the copy, as the importer does it: where Files says, then the item's replace. */
  async function imported(name: string, bytes: string) {
    const opened = await openFar(name, bytes)
    const folder = wordImportPlace(box.ctx, opened.copy, opened.item.id)
    const doc = join(folder ?? dirname(opened.copy), name.replace(/\.docx$/, '.tcdoc'))
    writeFileSync(doc, '{"doc":1}')
    const next = box.ctx.canvas.replace(filesPaneOf(WS), opened.item.id, 'document', { at: 'file', host: HOST, path: doc }, name.replace(/\.docx$/, ''))
    return { ...opened, folder, doc, next }
  }
  let offFollow: () => void = () => {}
  beforeEach(() => {
    offFollow = box.ctx.canvas.onReplaced((old, next) => wordFollowed(box.ctx, old, next))
  })
  afterEach(() => offFollow())
  const tabOf = async (tabId: string) => (await call<FilesTabs>('work.files.tabs', {})).tabs.find((t) => t.id === tabId)
  const closeAndHear = async (tabId: string) => {
    await call('work.files.tabClose', { tabId })
    for (const items of box.removed.splice(0)) wordsLeft(box.ctx, items)
  }

  it("becomes a document in the workspace's own folder, and the tab says the Word file has not changed", async () => {
    const { folder, doc, tabId, path } = await imported('Plan.docx', 'word bytes')
    expect(folder).toBe(box.folder)
    expect(wordRow(box.ctx, WS, MAC, path)).toMatchObject({ doc })
    expect((await tabOf(tabId))?.word).toEqual({ since: true })
  })

  it('Save as Word writes the export over the file by its version; later edits say they are not in it yet', async () => {
    const { doc, tabId, path } = await imported('Plan.docx', 'word bytes')
    const saved = await call<{ at: number }>('work.files.wordSave', { tabId })
    expect(saved.at).toBeGreaterThan(0)
    expect(readFileSync(path, 'utf8')).toBe('word export')
    expect((await tabOf(tabId))?.word).toEqual({ at: saved.at, since: false })
    writeFileSync(doc, '{"doc":2}')
    utimesSync(doc, new Date(), new Date(Date.now() + 5000))
    expect((await tabOf(tabId))?.word).toEqual({ at: saved.at, since: true })
  })

  it('keeps his edited document when the tab closes, and opens it again for the Word file, reading nothing over it', async () => {
    const { doc, tabId, path } = await imported('Plan.docx', 'word bytes')
    writeFileSync(doc, '{"doc":"his edit"}')
    utimesSync(doc, new Date(), new Date(Date.now() + 5000))
    await closeAndHear(tabId)
    expect(readFileSync(doc, 'utf8')).toBe('{"doc":"his edit"}')
    const reads = far.filter((c) => c.verb === 'filesRead').length
    const again = await call<FilesOpened>('work.files.open', { ref: { at: 'file', host: MAC, path }, name: 'Plan.docx' })
    expect(again.item).toMatchObject({ kind: 'document', source: { path: doc } })
    expect(far.filter((c) => c.verb === 'filesRead')).toHaveLength(reads)
  })

  it('drops a document he only looked at when its tab closes', async () => {
    const { doc, tabId, path } = await imported('Plan.docx', 'word bytes')
    await closeAndHear(tabId)
    expect(existsSync(doc)).toBe(false)
    expect(wordRow(box.ctx, WS, MAC, path)).toBeNull()
  })

  it('never writes over a Word file that changed there: the conflict, then Keep Both beside it', async () => {
    const { tabId, path } = await imported('Plan.docx', 'word bytes')
    writeFileSync(path, 'a colleague saved')
    const clash = await call<{ conflict: unknown }>('work.files.wordSave', { tabId })
    expect(clash.conflict).toBeTruthy()
    expect(readFileSync(path, 'utf8')).toBe('a colleague saved')
    const kept = await call<{ copy: { name: string } }>('work.files.wordSave', { tabId, keep: true })
    expect(kept.copy.name).toBe('Plan (mine).docx')
    expect(readFileSync(join(dirname(path), 'Plan (mine).docx'), 'utf8')).toBe('word export')
  })

  it('is never called changed when only its version moved (a sync touched it, its bytes the same)', async () => {
    const { tabId, path } = await imported('Plan.docx', 'word bytes')
    utimesSync(path, new Date(), new Date(Date.now() + 60_000))
    const got = await call<{ at?: number }>('work.files.wordSave', { tabId })
    expect(got.at).toBeGreaterThan(0)
    expect(readFileSync(path, 'utf8')).toBe('word export')
  })

  it('Replace on his press writes over a file that changed there, the file as it was kept first in the workspace folder', async () => {
    const { tabId, path } = await imported('Plan.docx', 'word bytes')
    writeFileSync(path, 'a colleague saved')
    const clash = await call<{ conflict?: { changed: number } }>('work.files.wordSave', { tabId })
    expect(clash.conflict?.changed).toBeGreaterThan(0)
    const got = await call<{ at?: number }>('work.files.wordSave', { tabId, replace: true })
    expect(got.at).toBeGreaterThan(0)
    expect(readFileSync(path, 'utf8')).toBe('word export')
    const original = join(box.folder, 'Plan (before TempCode saved it).docx')
    expect(readFileSync(original, 'utf8')).toBe('a colleague saved')
    expect(wordRow(box.ctx, WS, MAC, path)).toMatchObject({ original })
    // Kept once: a later save writes no second copy.
    await call('work.files.wordSave', { tabId, replace: true })
    expect(readdirSync(box.folder).filter((n) => n.includes('before TempCode'))).toHaveLength(1)
  })

  it('refuses a thread, a read key and a key that may not approve', async () => {
    const { tabId, path } = await imported('Plan.docx', 'word bytes')
    await expect(call('work.files.wordSave', { tabId }, thread('t1'))).rejects.toThrow('files_* tools')
    await expect(call('work.files.wordSave', { tabId }, reader)).rejects.toThrow('this key may not change it')
    await expect(call('work.files.wordSave', { tabId }, phone)).rejects.toThrow('this key may not change it')
    expect(readFileSync(path, 'utf8')).toBe('word bytes')
  })
})

describe('a Word file saved by itself', () => {
  const BLANK = readFileSync(join(process.cwd(), 'resources', 'work-files', 'blank', 'blank.docx'))
  let off: () => void = () => {}
  beforeEach(() => {
    off = box.ctx.canvas.onReplaced((old, next) => wordFollowed(box.ctx, old, next))
  })
  afterEach(() => off())
  async function opened(name: string, bytes: Buffer | string) {
    const path = join(mac.team, 'General', name)
    writeFileSync(path, bytes)
    const got = await call<FilesOpened>('work.files.open', { ref: { at: 'file', host: MAC, path }, name })
    const copy = canvasSourcePath(got.item!.source)!
    const doc = join(box.folder, name.replace(/\.docx$/, '.tcdoc'))
    writeFileSync(doc, '{"doc":1}')
    box.ctx.canvas.replace(filesPaneOf(WS), got.item!.id, 'document', { at: 'file', host: HOST, path: doc }, 'x')
    return { path, copy, doc, tabId: got.tabId! }
  }
  const typed = (doc: string, words: string, ago = 10_000): void => {
    writeFileSync(doc, JSON.stringify({ words }))
    utimesSync(doc, new Date(Date.now() - ago), new Date(Date.now() - ago))
  }
  const tabOf = async (tabId: string) => (await call<FilesTabs>('work.files.tabs', {})).tabs.find((t) => t.id === tabId)

  it('a document born here (our blank) saves by itself after a pause, unasked, with no copy of a blank kept', async () => {
    const { path, doc, tabId } = await opened('Notes.docx', BLANK)
    expect((await tabOf(tabId))?.word).toMatchObject({ auto: true, since: true })
    // Still typing: nothing goes.
    typed(doc, 'one', 0)
    await autosaveWords(box.ctx)
    expect(readFileSync(path).equals(BLANK)).toBe(true)
    typed(doc, 'one')
    await autosaveWords(box.ctx)
    expect(readFileSync(path, 'utf8')).toBe('word export')
    expect((await tabOf(tabId))?.word).toMatchObject({ auto: true, since: false })
    expect(readdirSync(box.folder).filter((n) => n.includes('before TempCode'))).toHaveLength(0)
  })

  it("a Word file of someone's saves by itself only once he chose it, and stops at a change made there until his press", async () => {
    const { path, doc, tabId } = await opened('Plan.docx', 'word bytes')
    typed(doc, 'his edit')
    await autosaveWords(box.ctx)
    expect(readFileSync(path, 'utf8')).toBe('word bytes')
    expect((await tabOf(tabId))?.word?.auto).toBeUndefined()
    await call('work.files.wordAuto', { tabId, on: true })
    await autosaveWords(box.ctx)
    expect(readFileSync(path, 'utf8')).toBe('word export')
    // A colleague saves there; his next edit's autosave stops and writes nothing.
    writeFileSync(path, 'a colleague saved')
    typed(doc, 'his next edit')
    await autosaveWords(box.ctx)
    expect(readFileSync(path, 'utf8')).toBe('a colleague saved')
    expect((await tabOf(tabId))?.word?.stopped).toBeGreaterThan(0)
    typed(doc, 'and more')
    await autosaveWords(box.ctx)
    expect(readFileSync(path, 'utf8')).toBe('a colleague saved')
    // His Replace writes over it and autosave goes on.
    await call('work.files.wordSave', { tabId, replace: true })
    expect(readFileSync(path, 'utf8')).toBe('word export')
    expect((await tabOf(tabId))?.word?.stopped).toBeUndefined()
  })

  it('a thread and a read key cannot set it', async () => {
    const { tabId } = await opened('Plan.docx', 'word bytes')
    await expect(call('work.files.wordAuto', { tabId, on: true }, thread('t1'))).rejects.toThrow()
    await expect(call('work.files.wordAuto', { tabId, on: true }, reader)).rejects.toThrow()
    expect((await tabOf(tabId))?.word?.auto).toBeUndefined()
  })
})

describe('a Word file opened, whichever hears the replace first', () => {
  for (const order of ['the tab follows first', 'the record is made first'] as const) {
    it(`names its document in the record when ${order}`, async () => {
      // The tab store's own follow is registered when the Files state is first made.
      if (order === 'the tab follows first') filesState(box.ctx)
      const off = box.ctx.canvas.onReplaced((old, next) => wordFollowed(box.ctx, old, next))
      try {
        const opened = await openFar('Agenda.docx', 'word bytes')
        const folder = wordImportPlace(box.ctx, opened.copy, opened.item.id)
        const doc = join(folder!, 'Agenda.tcdoc')
        writeFileSync(doc, '{"doc":1}')
        box.ctx.canvas.replace(filesPaneOf(WS), opened.item.id, 'document', { at: 'file', host: HOST, path: doc }, 'Agenda')
        expect(wordRow(box.ctx, WS, MAC, opened.path)).toMatchObject({ doc })
        expect((await call<FilesTabs>('work.files.tabs', {})).tabs.find((t) => t.id === opened.tabId)?.word).toEqual({ since: true })
      } finally {
        off()
      }
    })
  }
})

describe('a Word file an older build opened, its document beside the copy with his edits', () => {
  it('is adopted at start as the kept document: never deleted with its tab, opened again for the Word file', async () => {
    const opened = await openFar('Screening.docx', 'word bytes')
    // As 1.0.367 left it: no record, and the document made beside the copy in the copy's own folder.
    box.db.prepare(`DELETE FROM work_files_word`).run()
    const doc = join(dirname(opened.copy), 'Screening.tcdoc')
    writeFileSync(doc, '{"his":"edits"}')
    box.ctx.canvas.replace(filesPaneOf(WS), opened.item.id, 'document', { at: 'file', host: HOST, path: doc }, 'Screening')
    expect(adoptWordCopies(box.ctx, (id) => filesState(box.ctx).tabs.list(id).tabs)).toBe(1)
    expect(wordRow(box.ctx, WS, MAC, opened.path)).toMatchObject({ doc, version: '' })
    // Adopting twice adds nothing.
    expect(adoptWordCopies(box.ctx, (id) => filesState(box.ctx).tabs.list(id).tabs)).toBe(0)
    expect((await call<FilesTabs>('work.files.tabs', {})).tabs.find((t) => t.id === opened.tabId)?.word).toEqual({ since: true })
    // His tab closes: the pillars' drops, the office pillar's first, leave the document where it lies.
    await call('work.files.tabClose', { tabId: opened.tabId })
    for (const items of box.removed.splice(0)) {
      dropItemCopies(box.ctx, items)
      wordsLeft(box.ctx, items)
    }
    expect(readFileSync(doc, 'utf8')).toBe('{"his":"edits"}')
    const again = await call<FilesOpened>('work.files.open', { ref: { at: 'file', host: MAC, path: opened.path }, name: 'Screening.docx' })
    expect(again.item).toMatchObject({ kind: 'document', source: { path: doc } })
    // Copy Teams files off keeps it as well.
    await officeHandle({ id: '1', method: 'work.office.filesCopySet', params: { workspaceId: WS, on: false } } as never, box.ctx, window, () => null)
    expect(existsSync(doc)).toBe(true)
  })

  it("Save as Word knows the file unchanged by the copy's own bytes beside it, with no version on record, and writes", async () => {
    const opened = await openFar('Screening.docx', 'word bytes')
    box.db.prepare(`DELETE FROM work_files_word`).run()
    const doc = join(dirname(opened.copy), 'Screening.tcdoc')
    writeFileSync(doc, '{"his":"edits"}')
    box.ctx.canvas.replace(filesPaneOf(WS), opened.item.id, 'document', { at: 'file', host: HOST, path: doc }, 'Screening')
    adoptWordCopies(box.ctx, (id) => filesState(box.ctx).tabs.list(id).tabs)
    const got = await call<{ at?: number }>('work.files.wordSave', { tabId: opened.tabId })
    expect(got.at).toBeGreaterThan(0)
    expect(readFileSync(opened.path, 'utf8')).toBe('word export')
    // A colleague's save after that is a change: never written over without his Replace.
    writeFileSync(opened.path, 'a colleague saved')
    writeFileSync(doc, '{"his":"more"}')
    const clash = await call<{ conflict?: { changed: number } }>('work.files.wordSave', { tabId: opened.tabId })
    expect(clash.conflict?.changed).toBeGreaterThan(0)
    expect(readFileSync(opened.path, 'utf8')).toBe('a colleague saved')
  })
})
