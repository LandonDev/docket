import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClientRequestSchema, type ClientRequest } from '@shared/contract'
import type { CopyBack, FilesOpened, FilesTabs } from '@shared/contract-work-files'
import { canvasSourcePath, filesPaneOf } from '@shared/work'
import { copySavesBack } from '@shared/work/files'
import type { Caller } from '../modules'
import { filesHandle as officeHandle } from '../office/files/handle'
import { setCloudDir, setCopyAllowed } from '../office/files/library'
import { copiesInFlight, copyRecord, copySaved, copyTiming, retryWaiting, sendBack, settleCopies } from './copies'
import { closeFilesState, filesHandle } from './handle'
import { forgetLibraries } from './places/libraries'
import { setThreadsMayWrite, sharedOf } from './policy'
import { onFileSaved, saveFile, versionWord } from './save'
import { approver, HOST, makeRig, phone, reader, thread, window, WS, type Rig } from './testkit'
import { versionOf } from './write'

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
    expect(await backOf(tabId)).toEqual({ is: 'ok' })
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
    expect(await backOf(tabId)).toEqual({ is: 'ok' })
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
    expect(await backOf(tabId)).toEqual({ is: 'refused', detail: refuse })
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
