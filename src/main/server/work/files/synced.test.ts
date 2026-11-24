import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClientRequest } from '@shared/contract'
import type { FileEntry, FilePlace } from '@shared/work/files'
import type { Caller } from '../modules'
import { closeFilesState, filesHandle } from './handle'
import { SHARED_BYTES } from './policy'
import { approver, at, makeRig, phone, window, WS, type Rig } from './testkit'

/**
 * A workspace kept in his OneDrive, as the phone and a far window see it: the host's one answer on who can open it
 * (`sharedOf`), so its folder and rows read as shared and its files give their facts alone, while his own window
 * here keeps the place it always had and reads the file.
 */

let rig: Rig
let synced: string
beforeEach(() => {
  rig = makeRig()
  synced = join(rig.mine, 'Esports Ops')
  mkdirSync(join(synced, 'Events'), { recursive: true })
  writeFileSync(join(synced, 'Scan.pdf'), '%PDF-1.4 dummy')
  rig.db.prepare('UPDATE workspaces SET path = ? WHERE id = ?').run(synced, WS)
  rig.roots.splice(0, rig.roots.length, synced)
})
afterEach(() => {
  closeFilesState(rig.db)
  rig.close()
})

const call = async <T>(by: Caller, method: string, params: Record<string, unknown>): Promise<T> => {
  const out = await filesHandle({ id: 'x', method, params: { workspaceId: WS, ...params } } as unknown as ClientRequest, rig.ctx, by, undefined)
  if (!out.handled) throw new Error('not handled')
  return out.result as T
}
const folderOf = async (by: Caller) => (await call<{ places: FilePlace[] }>(by, 'work.files.places', {})).places.find((p) => p.id === 'folder')!

describe('a workspace kept in OneDrive', () => {
  it("reads as shared to a key, its folder and every row, and as it always did to his window here", async () => {
    for (const by of [phone, approver]) {
      expect((await folderOf(by)).shared).toBe(true)
      const rows = (await call<{ entries: FileEntry[] }>(by, 'work.files.list', { at: { at: 'place', id: 'folder' } })).entries
      expect(rows.map((e) => [e.name, e.shared])).toEqual(expect.arrayContaining([['Scan.pdf', true], ['Events', true]]))
      expect((await call<{ entries: (FileEntry | null)[] }>(by, 'work.files.stat', { refs: [at(join(synced, 'Scan.pdf'))] })).entries[0]).toMatchObject({ shared: true })
    }
    expect((await folderOf(window)).shared).toBe(false)
    const mine = (await call<{ entries: FileEntry[] }>(window, 'work.files.list', { at: { at: 'place', id: 'folder' } })).entries
    expect(mine.every((e) => !e.shared)).toBe(true)
  })

  it("gives a key no byte of its files, as a library's, and his window here the file", async () => {
    for (const by of [phone, approver]) await expect(call(by, 'work.files.read', { ref: at(join(synced, 'Scan.pdf')), offset: 0, length: 100 })).rejects.toThrow(SHARED_BYTES)
    expect(await call<{ data: string }>(window, 'work.files.read', { ref: at(join(synced, 'Scan.pdf')), offset: 0, length: 100 })).toMatchObject({ data: Buffer.from('%PDF-1.4 dummy').toString('base64') })
  })
})
