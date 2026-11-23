import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { PILLAR_IDS, PILLAR_MILESTONE } from '@shared/work'
import { WORK_PILLAR_CONTRACTS } from '@shared/contract-work'
import { FILES_CAPS, FILES_RELAY } from '@shared/contract-work-files'
import { CanvasStore, ensureCanvasTables, setCanvasStore } from '../canvas/store'
import { PILLAR_LOADERS, type WorkCtx } from '../modules'
import { fileMakerFor, fileMovedHooks, filePreviewerFor, registerFileMaker, registerFileMoved, registerFilePreviewer } from './hooks'
import { files } from './index'
import { FILES_TABLES } from './tables'

/** A context that is enough to start the module: its tables and the canvas's, and a store behind them. */
const startCtx = (): WorkCtx => {
  const db = new DatabaseSync(':memory:')
  files.ensure(db)
  ensureCanvasTables(db)
  setCanvasStore(db, new CanvasStore({ db, dataDir: '/nowhere', session: () => null, push: () => {}, log: () => {} }))
  return { db, push: () => {}, log: () => {} } as unknown as WorkCtx
}

/** The files pillar as the one mount sees it: its id, its tables, its contract rows, and the registries its start leaves alone. */

const offs: (() => void)[] = []
afterEach(() => {
  for (const off of offs.splice(0)) off()
})

describe('the mount', () => {
  it('is the last pillar, milestone 54, loaded by its own import', async () => {
    expect(PILLAR_IDS.at(-1)).toBe('files')
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
    expect(fileMovedHooks()).toHaveLength(1)

    const after = { forms: ['xlsx'] as const, blank: async () => {} }
    offs.push(registerFileMaker('sheet', after))
    offs.push(registerFilePreviewer('sheet', async () => null))
    offs.push(registerFileMoved(() => {}))
    expect(fileMakerFor('sheet', 'xlsx')).toBe(after)
    expect(filePreviewerFor('sheet')).not.toBeNull()
    expect(fileMovedHooks()).toHaveLength(2)

    // Work turned off and on again: both are still there.
    stop()
    files.start!(startCtx())()
    expect(fileMakerFor('document', 'docx')).toBe(before)
    expect(fileMakerFor('sheet', 'xlsx')).toBe(after)
    expect(fileMovedHooks()).toHaveLength(2)
  })
})
