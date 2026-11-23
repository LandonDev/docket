import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chmod } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientRequestSchema } from '@shared/contract'
import type { FileBytes, FileSaved } from '@shared/contract-work-files'
import type { Caller } from '../modules'
import { closeFilesState } from './handle'
import { files } from './index'
import { readFile, saveCopy, saveFile, versionWord } from './save'
import { approver, at, makeRig, peer, phone, thread, window, WS, type Rig } from './testkit'
import { versionOf } from './write'

/** A file's own bytes read and replaced where it lies (save.ts), and the two wire verbs over it. */

// `chmod` runs between the new bytes' write and the last look at the file: a test puts a second writer there.
vi.mock('node:fs/promises', async (real) => {
  const fs = await real<typeof import('node:fs/promises')>()
  return { ...fs, chmod: vi.fn(fs.chmod) }
})

let rig: Rig
let notes: string
beforeEach(() => {
  rig = makeRig()
  notes = join(rig.folder, 'Events', 'Notes.md')
  writeFileSync(notes, 'first line\n')
})
afterEach(() => {
  closeFilesState(rig.db)
  rig.close()
})

const fence = () => ({ roots: [rig.folder] })
const text = (b: FileBytes): string => Buffer.from(b.data, 'base64').toString('utf8')
async function call<T>(method: string, params: Record<string, unknown>, by: Caller = window): Promise<T> {
  const req = ClientRequestSchema.parse({ id: '1', method, params: { workspaceId: WS, ...params } })
  const out = await files.handle!(req, rig.ctx, by)
  if (!out.handled) throw new Error(`${method} was not handled`)
  return out.result as T
}

describe('reading a file', () => {
  it('answers its bytes, its size and the version a save must name', async () => {
    const got = await readFile(fence(), notes, 0, 1024)
    expect(text(got)).toBe('first line\n')
    expect(got).toMatchObject({ size: 11, end: true, version: versionWord(await versionOf(notes)) })
  })

  it('reads in parts of one file: a part asked of a file that changed since is refused as stale', async () => {
    writeFileSync(notes, 'abcdefghij')
    const first = await readFile(fence(), notes, 0, 4)
    expect([text(first), first.end]).toEqual(['abcd', false])
    const rest = await readFile(fence(), notes, 4, 100, first.version)
    expect([text(rest), rest.end]).toEqual(['efghij', true])
    writeFileSync(notes, 'abcdefghiJ')
    await expect(readFile(fence(), notes, 4, 100, first.version)).rejects.toThrow('changed while it was read')
  })

  it('never reads a file whose bytes are not on this disk, a link, a folder or a path outside the fence', async () => {
    const sparse = join(rig.folder, 'Cloud.txt')
    writeFileSync(sparse, '')
    truncateSync(sparse, 1024 * 1024)
    if (statSync(sparse).blocks === 0) await expect(readFile(fence(), sparse, 0, 10)).rejects.toThrow('kept in the cloud')
    symlinkSync(join(rig.outside, 'secret.txt'), join(rig.folder, 'link.txt'))
    await expect(readFile(fence(), join(rig.folder, 'link.txt'), 0, 10)).rejects.toThrow('link')
    await expect(readFile(fence(), join(rig.folder, 'Events'), 0, 10)).rejects.toThrow('not a file')
    await expect(readFile(fence(), join(rig.outside, 'secret.txt'), 0, 10)).rejects.toThrow('outside')
  })
})

describe('saving a file', () => {
  it('replaces its bytes when it is still the version read, keeps its mode and leaves nothing beside it', async () => {
    chmodSync(notes, 0o640)
    const read = await readFile(fence(), notes, 0, 1024)
    const saved = await saveFile(fence(), 'k', notes, Buffer.from('second line\n'), read.version)
    expect(saved).toMatchObject({ version: versionWord(await versionOf(notes)) })
    expect(readFileSync(notes, 'utf8')).toBe('second line\n')
    expect(statSync(notes).mode & 0o777).toBe(0o640)
    expect(readdirSync(join(rig.folder, 'Events')).filter((n) => n.includes('Notes'))).toEqual(['Notes.md'])
  })

  it("answers the conflict and leaves the file as it is when a second writer came first", async () => {
    const read = await readFile(fence(), notes, 0, 1024)
    writeFileSync(notes, 'theirs\n')
    const saved = await saveFile(fence(), 'k', notes, Buffer.from('mine\n'), read.version)
    expect(saved).toEqual({ conflict: { version: versionWord(await versionOf(notes)), changed: Math.round(statSync(notes).mtimeMs) } })
    expect(readFileSync(notes, 'utf8')).toBe('theirs\n')
    expect(readdirSync(join(rig.folder, 'Events')).filter((n) => n.includes('Notes'))).toEqual(['Notes.md'])
  })

  it('sees a change of the same size made in the same instant, by its hash', async () => {
    const read = await readFile(fence(), notes, 0, 1024)
    const { atime, mtime } = statSync(notes)
    writeFileSync(notes, 'FIRST line\n')
    utimesSync(notes, atime, mtime)
    expect(await saveFile(fence(), 'k', notes, Buffer.from('mine\n'), read.version)).toHaveProperty('conflict')
    expect(readFileSync(notes, 'utf8')).toBe('FIRST line\n')
  })

  it('sees a same-size rewrite that kept its time while ours was written, by the whole version, and leaves it', async () => {
    // A whole second, so the rewrite can keep the time exactly.
    const atime = 1_700_000_000
    const mtime = 1_700_000_000
    utimesSync(notes, atime, mtime)
    const read = await readFile(fence(), notes, 0, 1024)
    const real = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).chmod
    vi.mocked(chmod).mockImplementationOnce(async (path, mode) => {
      writeFileSync(notes, 'FIRST line\n')
      utimesSync(notes, atime, mtime)
      return real(path, mode)
    })
    expect(await saveFile(fence(), 'k', notes, Buffer.from('mine\n'), read.version)).toEqual({ conflict: { version: versionWord(await versionOf(notes)), changed: Math.round(statSync(notes).mtimeMs) } })
    expect(readFileSync(notes, 'utf8')).toBe('FIRST line\n')
    expect(readdirSync(join(rig.folder, 'Events')).filter((n) => n.includes('Notes'))).toEqual(['Notes.md'])
  })

  it('never makes a file again under its old name: one that was moved or deleted is a conflict', async () => {
    const read = await readFile(fence(), notes, 0, 1024)
    const { renameSync } = await import('node:fs')
    renameSync(notes, join(rig.folder, 'Events', 'Renamed.md'))
    expect(await saveFile(fence(), 'k', notes, Buffer.from('mine\n'), read.version)).toEqual({ conflict: { gone: true } })
    expect(existsSync(notes)).toBe(false)
  })

  it('runs two saves of one file one after the other: the second meets the first as a conflict', async () => {
    const read = await readFile(fence(), notes, 0, 1024)
    const [a, b] = await Promise.all([saveFile(fence(), 'k', notes, Buffer.from('a\n'), read.version), saveFile(fence(), 'k', notes, Buffer.from('b\n'), read.version)])
    expect('version' in a).toBe(true)
    expect(b).toHaveProperty('conflict')
    expect(readFileSync(notes, 'utf8')).toBe('a\n')
  })

  it('refuses a link and a path outside the fence, writing nothing', async () => {
    symlinkSync(join(rig.outside, 'secret.txt'), join(rig.folder, 'link.txt'))
    await expect(saveFile(fence(), 'k', join(rig.folder, 'link.txt'), Buffer.from('x'), '0:0:')).rejects.toThrow('link')
    await expect(saveFile(fence(), 'k', join(rig.outside, 'secret.txt'), Buffer.from('x'), '0:0:')).rejects.toThrow('outside')
    expect(readFileSync(join(rig.outside, 'secret.txt'), 'utf8')).not.toBe('x')
  })

  it('keeps his text beside the file under a name of its own, never over anything', async () => {
    const first = await saveCopy(fence(), notes, Buffer.from('mine\n'))
    expect(first).toBe(join(rig.folder, 'Events', 'Notes (mine).md'))
    const second = await saveCopy(fence(), notes, Buffer.from('mine again\n'))
    expect(second).toBe(join(rig.folder, 'Events', 'Notes (mine) 2.md'))
    expect(readFileSync(first, 'utf8')).toBe('mine\n')
    expect(readFileSync(notes, 'utf8')).toBe('first line\n')
  })
})

describe('the wire', () => {
  it("reads and saves a text file in the workspace's folder for his window and for a key that may operate", async () => {
    const read = await call<FileBytes>('work.files.read', { ref: at(notes), offset: 0, length: 4096 })
    expect(text(read)).toBe('first line\n')
    const saved = await call<FileSaved>('work.files.write', { ref: at(notes), text: 'changed\n', version: read.version })
    expect(saved).toHaveProperty('version')
    expect(readFileSync(notes, 'utf8')).toBe('changed\n')
    const again = await call<FileSaved>('work.files.write', { ref: at(notes), text: 'from the phone\n', version: (saved as { version: string }).version }, phone)
    expect(again).toHaveProperty('version')
    // A stale version is the conflict, with what the file is now.
    expect(await call<FileSaved>('work.files.write', { ref: at(notes), text: 'late\n', version: read.version })).toHaveProperty('conflict.version')
    expect(readFileSync(notes, 'utf8')).toBe('from the phone\n')
  })

  it('keeps his text as a copy beside the file and answers its row', async () => {
    const read = await call<FileBytes>('work.files.read', { ref: at(notes), offset: 0, length: 4096 })
    const got = await call<FileSaved>('work.files.write', { ref: at(notes), text: 'mine\n', version: read.version, copy: true })
    expect(got).toMatchObject({ copy: { name: 'Notes (mine).md', kind: 'text' } })
    expect(readFileSync(notes, 'utf8')).toBe('first line\n')
  })

  it('answers a save of a file that was moved away as the conflict, and still keeps his text beside where it was', async () => {
    const read = await call<FileBytes>('work.files.read', { ref: at(notes), offset: 0, length: 4096 })
    const { renameSync } = await import('node:fs')
    renameSync(notes, join(rig.folder, 'Notes moved.md'))
    expect(await call<FileSaved>('work.files.write', { ref: at(notes), text: 'mine\n', version: read.version })).toEqual({ conflict: { gone: true } })
    expect(existsSync(notes)).toBe(false)
    expect(await call<FileSaved>('work.files.write', { ref: at(notes), text: 'mine\n', version: read.version, copy: true })).toMatchObject({ copy: { name: 'Notes (mine).md' } })
  })

  it('says with the bytes whether a save would be taken, so an editor never offers what the host refuses', async () => {
    const shared = join(rig.team, 'General', 'Agenda.md')
    writeFileSync(shared, 'team text\n')
    expect((await call<FileBytes>('work.files.read', { ref: at(notes), offset: 0, length: 4096 })).locked).toBeUndefined()
    // His own window may change a text file in a library of this host: it is his edit, written where the file lies.
    expect((await call<FileBytes>('work.files.read', { ref: at(shared), offset: 0, length: 4096 })).locked).toBeUndefined()
    expect((await call<FileBytes>('work.files.read', { ref: at(notes), offset: 0, length: 4096 }, thread('t1'))).locked).toBe('A thread changes files with the files_* tools.')
  })

  it("writes his own window's edit to a text file in a library, and nobody else's: a thread's and a remote key's are refused", async () => {
    const shared = join(rig.team, 'General', 'Agenda.md')
    writeFileSync(shared, 'team text\n')
    const read = await call<FileBytes>('work.files.read', { ref: at(shared), offset: 0, length: 4096 })
    await expect(call('work.files.write', { ref: at(notes), text: 'x', version: read.version }, thread('t1'))).rejects.toThrow('A thread changes files with the files_* tools.')
    for (const by of [approver, phone, peer, thread('t1')]) await expect(call('work.files.write', { ref: at(shared), text: 'x', version: read.version }, by)).rejects.toThrow()
    expect(readFileSync(shared, 'utf8')).toBe('team text\n')
    expect(await call<FileSaved>('work.files.write', { ref: at(shared), text: 'his edit\n', version: read.version })).toHaveProperty('version')
    expect(readFileSync(shared, 'utf8')).toBe('his edit\n')
    expect(readFileSync(notes, 'utf8')).toBe('first line\n')
  })

  it("gives a library's bytes to his own window alone", async () => {
    const shared = join(rig.team, 'General', 'Agenda.md')
    mkdirSync(join(rig.team, 'General'), { recursive: true })
    writeFileSync(shared, 'team text\n')
    expect(text(await call<FileBytes>('work.files.read', { ref: at(shared), offset: 0, length: 4096 }))).toBe('team text\n')
    for (const by of [peer, thread('t1')]) await expect(call('work.files.read', { ref: at(shared), offset: 0, length: 4096 }, by)).rejects.toThrow('his own window')
    await expect(call('work.files.read', { ref: at(shared), offset: 0, length: 4096 }, phone)).rejects.toThrow()
  })
})
