import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import type { ClientRequest } from '@shared/contract'
import { filesPaneOf } from '@shared/work'
import type { Caller } from '../../modules'
import { importFolderOf } from '../../files/imports'
import { at, HOST, makeRig, thread, window, WS, type Rig } from '../../files/testkit'
import { office } from '../index'
import { setVmState } from '../vm/office'
import { copyDirOf, copyFolderOf, filesHandle, threadsHolding } from './handle'
import { setCopyAllowed } from './library'

/** Teams file copies and imports for a Files tab, whose owner is the workspace's pane and not a thread. */
const PANE = filesPaneOf(WS)
const FAR = { at: 'file' as const, host: 'env_mac', path: '/c/Team/General/Plan.docx' }
let rig: Rig
let asked: { host: string; scope: unknown; verb: string }[]

beforeEach(() => {
  rig = makeRig()
  asked = []
  Object.assign(rig.ctx, {
    peer(this: { scope?: unknown }, host: string) {
      const scope = this?.scope
      return { call: async (_m: string, verb: string) => (asked.push({ host, scope, verb }), { name: 'Plan.docx', data: Buffer.from('word').toString('base64') }) }
    }
  })
})
afterEach(() => rig.close())

const copy = (sessionId: string, source: object = FAR, by: Caller = window) =>
  filesHandle({ id: '1', method: 'work.office.filesCopy', params: { sessionId, source } } as unknown as ClientRequest, rig.ctx, by, () => null).then((a) => (a as { result: { source: { path: string } } }).result)
/** A copy as copyIn would have left it, for an owner. */
const copied = (owner: string, path = FAR.path): string => {
  const dir = copyFolderOf(rig.dataDir, owner, { host: FAR.host, path })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'Plan.docx'), 'word')
  return join(dir, 'Plan.docx')
}

describe('a copy for a Files tab', () => {
  it('lands in the pane\'s own copies, asking the far host with the pane as its scope', async () => {
    setCopyAllowed(rig.db, WS, true)
    const got = await copy(PANE)
    expect(got.source.path).toBe(join(copyFolderOf(rig.dataDir, PANE, FAR), 'Plan.docx'))
    expect(got.source.path.startsWith(copyDirOf(rig.dataDir, 'filespane_w1'))).toBe(true)
    expect(readFileSync(got.source.path, 'utf8')).toBe('word')
    expect(asked).toEqual([{ host: 'env_mac', scope: { sessionId: PANE, workspaceId: WS }, verb: 'filesRead' }])
  })

  it('is refused while Copy Teams files is off, for a pane of no Work workspace here, and to a thread naming the pane', async () => {
    await expect(copy(PANE)).rejects.toThrow('keeps Teams files where they are')
    setCopyAllowed(rig.db, WS, true)
    setCopyAllowed(rig.db, 'code1', true)
    await expect(copy(filesPaneOf('code1'))).rejects.toThrow('No such Work workspace')
    await expect(copy(PANE, FAR, thread('t1'))).rejects.toThrow('No such Work thread here.')
    expect(asked).toEqual([])
  })

  it('still copies a thread\'s file into its own folder, with its own scope', async () => {
    setCopyAllowed(rig.db, WS, true)
    const got = await copy('t1', FAR, thread('t1'))
    expect(got.source.path).toBe(join(copyFolderOf(rig.dataDir, 't1', FAR), 'Plan.docx'))
    expect((asked[0]!.scope as { sessionId: string }).sessionId).toBe('t1')
  })

  it('out of the Windows VM needs only that the VM is set up, where a thread needs its workspace to use it', async () => {
    setCopyAllowed(rig.db, WS, true)
    const guest = { at: 'file', host: HOST, path: 'C:\\Users\\dummy\\Team\\Plan.docx' }
    await expect(copy(PANE, guest)).rejects.toThrow('may not use the Windows VM')
    setVmState(() => ({ state: 'ready', cannot: null }))
    // Past the VM's gate, the file is looked for in the libraries OneDrive syncs there: none in this rig.
    await expect(copy(PANE, guest)).rejects.toThrow('not in a Teams folder')
    await expect(copy('t1', guest, thread('t1'))).rejects.toThrow('may not use the Windows VM')
  })
})

describe('a Files tab\'s copies are dropped', () => {
  it('when the tab closes: its file\'s folder goes, another tab\'s and a thread\'s stay', () => {
    const mine = copied(PANE)
    const other = copied(PANE, '/c/Team/General/Other.docx')
    const threads = copied('t1')
    const item = rig.canvas.open(PANE, { kind: 'document', source: at(mine), title: 'Plan.docx' })
    rig.canvas.close(item.id)
    office.itemsRemoved!(rig.removed.at(-1)!, rig.ctx)
    expect(existsSync(mine)).toBe(false)
    expect(existsSync(other)).toBe(true)
    expect(existsSync(threads)).toBe(true)
  })

  it('not while the document an import made of the copy shows in the tab that took its place', () => {
    const mine = copied(PANE)
    const item = rig.canvas.open(PANE, { kind: 'document', source: at(mine), title: 'Plan.docx' })
    const doc = join(copyFolderOf(rig.dataDir, PANE, FAR), 'Plan.tcdoc')
    writeFileSync(doc, '{}')
    rig.canvas.replace(PANE, item.id, { kind: 'document', source: at(doc), title: 'Plan' })
    office.itemsRemoved!(rig.removed.at(-1)!, rig.ctx)
    expect(existsSync(doc)).toBe(true)
    // Its own tab closed, the folder goes.
    const made = rig.canvas.list(PANE).find((i) => i.title === 'Plan')!
    rig.canvas.close(made.id)
    office.itemsRemoved!(rig.removed.at(-1)!, rig.ctx)
    expect(existsSync(doc)).toBe(false)
  })

  it('when a tab of a file that is no copy closes, nothing in the copies is touched', () => {
    const mine = copied(PANE)
    const item = rig.canvas.open(PANE, { kind: 'document', source: at(join(rig.folder, 'notes.txt')), title: 'notes.txt' })
    rig.canvas.close(item.id)
    office.itemsRemoved!(rig.removed.at(-1)!, rig.ctx)
    expect(existsSync(mine)).toBe(true)
  })

  it('when Copy Teams files is turned off: the pane\'s and the workspace\'s threads\', not another workspace\'s', async () => {
    const pane = copied(PANE)
    const t1 = copied('t1')
    const t2 = copied('t2')
    const otherPane = copied(filesPaneOf('w2'))
    await filesHandle({ id: '1', method: 'work.office.filesCopySet', params: { workspaceId: WS, on: false } } as unknown as ClientRequest, rig.ctx, window, () => null)
    expect([existsSync(pane), existsSync(t1), existsSync(t2), existsSync(otherPane)]).toEqual([false, false, true, true])
  })

  it('when the workspace is removed', () => {
    const pane = copied(PANE)
    const t1 = copied('t1')
    const otherPane = copied(filesPaneOf('w2'))
    office.workspaceRemoved!(WS, rig.ctx)
    expect([existsSync(pane), existsSync(t1), existsSync(otherPane)]).toEqual([false, false, true])
  })
})

describe('the thread that holds a Teams file', () => {
  /** A `.tcdoc` whose sidecar says what it was imported from, as the importer writes it; `from: null` records nothing. */
  const tcdoc = (path: string, from: string | null) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, zipSync({ 'sidecar.json': strToU8(JSON.stringify(from ? { source: { name: from, format: 'docx', importedAt: 1 } } : {})) }))
  }

  it('is found by the document an import made of it under this host\'s data', () => {
    const plan = join(rig.team, 'General', 'Plan.docx')
    const made = join(importFolderOf(rig.dataDir, { host: HOST, path: plan }), 'Plan 2.tcdoc')
    tcdoc(made, 'Plan.docx')
    const item = rig.canvas.open('t1', { kind: 'document', source: at(made), title: 'Plan 2' })
    expect(threadsHolding(rig.ctx, WS, at(plan)).map((t) => [t.sessionId, t.itemId])).toEqual([['t1', item.id]])
    // Another file's import folder is not this file's.
    expect(threadsHolding(rig.ctx, WS, at(join(rig.team, 'Events', 'Plan.docx')))).toEqual([])
  })

  it('is never a thread holding a document of his that only shares the name: the import must say it came from the file', () => {
    const trip = join(rig.folder, 'Trip.docx')
    writeFileSync(trip, 'word')
    const mine = join(rig.folder, 'Trip.tcdoc')
    tcdoc(mine, null)
    rig.canvas.open('t1', { kind: 'document', source: at(mine), title: 'Trip' })
    expect(threadsHolding(rig.ctx, WS, at(trip))).toEqual([])
    // One imported from another file of that name elsewhere is not this one's either.
    tcdoc(mine, 'Trip.pdf')
    expect(threadsHolding(rig.ctx, WS, at(trip))).toEqual([])
    tcdoc(mine, 'Trip.docx')
    expect(threadsHolding(rig.ctx, WS, at(trip)).map((t) => t.sessionId)).toEqual(['t1'])
  })
})
