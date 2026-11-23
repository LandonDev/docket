import { truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FilesListing } from '@shared/contract-work-files'
import type { FileEntry } from '@shared/work/files'

/**
 * No list and no stat reads a byte of a file its place keeps in the cloud (docs/agents/work-files.md
 * "Performance"): reading it would make OneDrive download it. Every way this process opens a file is watched,
 * and none of them may name the cloud-only files. A file whose bytes are here may be read (who last saved an
 * Office file comes from its own properties).
 */

const opened = vi.hoisted(() => [] as string[])
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  const note =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      if (typeof args[0] === 'string') opened.push(args[0])
      return fn(...args)
    }
  return { ...fs, openSync: note(fs.openSync), readFileSync: note(fs.readFileSync), createReadStream: note(fs.createReadStream) }
})
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  const note =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      if (typeof args[0] === 'string') opened.push(args[0])
      return fn(...args)
    }
  return { ...fs, open: note(fs.open), readFile: note(fs.readFile) }
})

const { closeFilesState } = await import('./handle')
const { files } = await import('./index')
const { at, makeRig, window, WS } = await import('./testkit')

let rig: ReturnType<typeof makeRig>
beforeEach(() => {
  rig = makeRig()
  // Cloud-only files of every sort a closer look might be tempted to read: an Office file, a picture, a text file.
  for (const name of ['Cloud budget.xlsx', 'Cloud deck.pptx', 'Cloud photo.png', 'Cloud notes.txt']) {
    writeFileSync(join(rig.team, 'General', name), '')
    truncateSync(join(rig.team, 'General', name), 300_000)
  }
  writeFileSync(join(rig.folder, 'Sparse.docx'), '')
  truncateSync(join(rig.folder, 'Sparse.docx'), 300_000)
  opened.length = 0
})
afterEach(() => {
  closeFilesState(rig.db)
  rig.close()
})

const call = async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
  const out = await files.handle!({ id: '1', method, params: { workspaceId: WS, ...params } } as never, rig.ctx, window)
  return (out as { result: T }).result
}
const cloudReads = (): string[] => opened.filter((path) => /Cloud |Sparse\.docx/.test(path))

describe('a file kept in the cloud', () => {
  it('is listed in every order, by its name and size, without one read of it', async () => {
    for (const sort of [{ by: 'name', dir: 'asc' }, { by: 'changed', dir: 'desc' }, { by: 'size', dir: 'desc' }, { by: 'kind', dir: 'asc' }]) {
      const got = await call<FilesListing>('work.files.list', { at: at(join(rig.team, 'General')), sort })
      const cloud = got.entries.filter((e) => e.name.startsWith('Cloud '))
      expect(cloud).toHaveLength(5)
      expect(cloud.every((e) => e.local === false && e.state?.is === 'cloud')).toBe(true)
    }
    await call<FilesListing>('work.files.list', { at: { at: 'place', id: 'folder' } })
    expect(cloudReads()).toEqual([])
  })

  it('is looked at again with no read of it, while a file whose bytes are here may be read for who saved it', async () => {
    const refs = ['Cloud budget.xlsx', 'Cloud deck.pptx', 'Cloud photo.png', 'Cloud notes.txt', 'Cloud only.pdf', 'Spring budget.xlsx'].map((name) => at(join(rig.team, 'General', name)))
    const got = await call<{ entries: (FileEntry | null)[] }>('work.files.stat', { refs: [...refs, at(join(rig.folder, 'Sparse.docx'))] })
    expect(got.entries.map((e) => e?.local)).toEqual([false, false, false, false, false, true, false])
    expect(cloudReads()).toEqual([])
    // The one file whose bytes are on this disk was opened, for its properties.
    expect(opened).toContain(join(rig.team, 'General', 'Spring budget.xlsx'))
  })

  it('is starred, marked seen and asked for its threads with no read of it', async () => {
    const cloud = at(join(rig.team, 'General', 'Cloud budget.xlsx'))
    await call('work.files.star', { ref: cloud, name: 'Cloud budget.xlsx', on: true })
    await call('work.files.seen', { ref: cloud, name: 'Cloud budget.xlsx' })
    await call('work.files.threads', { ref: cloud })
    await call<FilesListing>('work.files.list', { at: { at: 'place', id: 'starred' } })
    expect(cloudReads()).toEqual([])
  })
})
