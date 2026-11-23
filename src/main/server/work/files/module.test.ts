import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { PILLAR_IDS, PILLAR_MILESTONE } from '@shared/work'
import { WORK_PILLAR_CONTRACTS } from '@shared/contract-work'
import { FILES_CAPS, FILES_RELAY } from '@shared/contract-work-files'
import { CanvasStore, ensureCanvasTables } from '../canvas/store'
import { PILLAR_LOADERS, type WorkCtx } from '../modules'
import { fileMakerFor, fileMovedHooks, filePreviewerFor, registerFileMaker, registerFileMoved, registerFilePreviewer } from './hooks'
import { files } from './index'
import { admitWrite, setThreadsMayWrite, type DoorPlace } from './policy'
import { fileActKind } from './tools'
import { FILES_TABLES } from './tables'

/** A context that is enough to start the module: its tables and the canvas's, and a store behind them. */
const startCtx = (): WorkCtx => {
  const db = new DatabaseSync(':memory:')
  files.ensure(db)
  ensureCanvasTables(db)
  const store = new CanvasStore({ db, dataDir: '/nowhere', session: () => null, push: () => {}, log: () => {} })
  return { db, push: () => {}, log: () => {}, canvas: { remove: (ids: string[]) => store.remove(ids), onReplaced: (fn: never) => store.onItemReplaced(fn) } } as unknown as WorkCtx
}

/** The files pillar as the one mount sees it: its id, its tables, its contract rows, and the registries its start leaves alone. */

const offs: (() => void)[] = []
afterEach(() => {
  for (const off of offs.splice(0)) off()
})

describe('the mount', () => {
  it('is a pillar, milestone 54, loaded by its own import', async () => {
    // Pillars built after it (prep and the rest of round 3) mount after it.
    expect(PILLAR_IDS).toContain('files')
    expect(PILLAR_MILESTONE.files).toBe(54)
    expect(await PILLAR_LOADERS.files()).toBe(files)
  })

  it('makes its tables, and making them again changes nothing', () => {
    const db = new DatabaseSync(':memory:')
    files.ensure(db)
    files.ensure(db)
    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'work_files_%' ORDER BY name`).all() as { name: string }[]).map((r) => r.name)
    expect(names).toEqual([...FILES_TABLES].sort())
  })

  it('gives every method a capability, and a relay row only to a method it has', () => {
    const { requests, caps, relay } = WORK_PILLAR_CONTRACTS.files
    expect(caps).toBe(FILES_CAPS)
    expect(Object.keys(caps)).toHaveLength(requests.length)
    for (const method of Object.keys(relay)) expect(caps, method).toHaveProperty([method])
    // Emptying Trash is this host's own; bytes, pictures and changes cross only to an unlocked screen.
    expect(FILES_RELAY['work.files.purge']).toBe('never')
    for (const method of ['fetch', 'read', 'preview', 'thumbs', 'make', 'rename', 'move', 'copy', 'trash', 'restore', 'upload'] as const) expect(FILES_RELAY[`work.files.${method}`], method).toBe('screen')
    expect(FILES_CAPS['work.files.purge']).toBe('approve')
  })
})

describe('the registries a kind fills (hooks.ts) and the module start', () => {
  it('keeps a registration made before the module starts, and one made after', () => {
    const before = { forms: ['docx'] as const, blank: async () => {} }
    offs.push(registerFileMaker('document', before))
    offs.push(registerFilePreviewer('document', async () => null))
    offs.push(registerFileMoved(() => {}))
    const stop = files.start!(startCtx())
    expect(fileMakerFor('document', 'docx')).toBe(before)
    expect(filePreviewerFor('document')).not.toBeNull()
    // The start adds its own, which carries a file's LifeOS project links (places/lifeos.ts), and takes it at its stop.
    expect(fileMovedHooks()).toHaveLength(2)

    const after = { forms: ['xlsx'] as const, blank: async () => {} }
    offs.push(registerFileMaker('sheet', after))
    offs.push(registerFilePreviewer('sheet', async () => null))
    offs.push(registerFileMoved(() => {}))
    expect(fileMakerFor('sheet', 'xlsx')).toBe(after)
    expect(filePreviewerFor('sheet')).not.toBeNull()
    expect(fileMovedHooks()).toHaveLength(3)

    // Work turned off and on again: both are still there.
    stop()
    files.start!(startCtx())()
    expect(fileMakerFor('document', 'docx')).toBe(before)
    expect(fileMakerFor('sheet', 'xlsx')).toBe(after)
    expect(fileMovedHooks()).toHaveLength(2)
  })
})

describe('the agents\' side (F5)', () => {
  afterEach(() => setThreadsMayWrite(false))

  it('mounts the files_* tools, the file.act kind and a preamble line, and its start lets a thread change files', () => {
    expect(files.tools!({ workspaceId: 'w1' } as never).map((t) => t.name)).toEqual(['files_places', 'files_list', 'files_search', 'files_open', 'files_make', 'files_move', 'files_copy', 'files_trash', 'files_undo'])
    expect(files.acts).toEqual([fileActKind])
    expect(files.preamble!({ workspaceId: 'w1' } as never)).toContain('held for the owner\'s press')
    const own: DoorPlace = { id: 'folder', kind: 'folder', name: 'Dummy Esports', host: '', env: 'env_box', shared: false, can: ['rename'], state: { state: 'ok' } }
    const thread = { kind: 'model', caps: [], sessionId: 't1' } as const
    setThreadsMayWrite(false)
    expect(() => admitWrite(thread, { verb: 'rename', from: own, entry: { name: 'a.txt', kind: 'text' } })).toThrow()
    files.start!(startCtx())()
    expect(admitWrite(thread, { verb: 'rename', from: own, entry: { name: 'a.txt', kind: 'text' } })).toBe('run')
    expect(admitWrite(thread, { verb: 'rename', from: { ...own, id: 'team', kind: 'teams', shared: true }, entry: { name: 'a.txt', kind: 'text' } })).toBe('hold')
  })
})
