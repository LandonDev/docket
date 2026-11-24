import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClientRequestSchema } from '@shared/contract'
import { LIBRARY_CAN } from '@shared/work/filePlaces'
import { AttachmentUploads } from '../../attachmentUploads'
import { FenceError } from '../../remote/fence'
import type { Caller, WorkCtx } from '../modules'
import { closeFilesState, THREADS_BY_TOOLS } from './handle'
import { files } from './index'
import { NEEDS_APPROVE, OWN_ONLY } from './policy'
import { approver, at, HOST, makeRig, phone, thread, window, WS, type Rig } from './testkit'
import { stagingRoot, type UploadLanded } from './upload'
import { amendOp, writeSeams } from './write'

/** An upload into a folder of the Files place (upload.ts): begun on the wire, its bytes sent as `attachment.*`, landed at commit. */

let rig: Rig
let uploads: AttachmentUploads
let clock = 1_000_000
let ops = 0
const key: Caller = { ...phone, keyId: 'k1' }
const approving: Caller = { ...approver, keyId: 'k2' }

beforeEach(() => {
  rig = makeRig()
  const settings = new Map<string, string>()
  uploads = new AttachmentUploads({
    dirFor: () => join(rig.base, 'unused'),
    store: { getSetting: (k) => settings.get(k) ?? null, setSetting: (k, v) => void (v === null ? settings.delete(k) : settings.set(k, v)) },
    now: () => clock,
    sweepEveryMs: 0
  })
  ;(rig.ctx as { uploads: WorkCtx['uploads'] }).uploads = uploads
})
afterEach(() => {
  delete writeSeams.beforeWrite
  LIBRARY_CAN.splice(0, LIBRARY_CAN.length)
  uploads.close()
  closeFilesState(rig.db)
  rig.close()
})

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
const ownerOf = (by: Caller): string => (by.kind === 'local' ? 'local' : `key:${by.keyId}`)

/** `work.files.upload` as a socket sends it; answers the upload's id. */
async function begin(name: string, text: string, o: { at?: unknown; by?: Caller; op?: string; size?: number; asked?: boolean; own?: boolean } = {}): Promise<string> {
  const req = ClientRequestSchema.parse({
    id: '1',
    method: 'work.files.upload',
    params: { workspaceId: WS, at: o.at ?? { at: 'place', id: 'folder' }, name, size: o.size ?? Buffer.byteLength(text), sha256: sha(text), op: o.op ?? `op-upload-${++ops}`, ...(o.asked ? { asked: true } : {}), ...(o.own ? { own: true } : {}) }
  })
  const out = await files.handle!(req, rig.ctx, o.by ?? window)
  if (!out.handled) throw new Error('not handled')
  return (out.result as { uploadId: string }).uploadId
}
/** The bytes, then the commit, as `attachment.chunk` and `attachment.commit` from the same socket. */
async function send(uploadId: string, text: string, by: Caller = window): Promise<UploadLanded> {
  await uploads.chunk(ownerOf(by), { uploadId, index: 0, dataBase64: Buffer.from(text).toString('base64') })
  return (await uploads.commit(ownerOf(by), uploadId)) as UploadLanded
}
const staged = (): string[] => (existsSync(stagingRoot(rig.dataDir)) ? readdirSync(stagingRoot(rig.dataDir)) : [])

describe('Save to TempCode', () => {
  it('keeps a file in a place of his own: a workspace kept in OneDrive is refused at begin and at commit, whoever presses', async () => {
    const synced = join(rig.mine, 'Esports Ops')
    mkdirSync(synced, { recursive: true })
    // Begun while the workspace was his own, committed once it lies in his OneDrive: refused, nothing lands.
    const id = await begin('Receipt.txt', 'receipt', { by: approving, own: true })
    rig.db.prepare('UPDATE workspaces SET path = ? WHERE id = ?').run(synced, WS)
    rig.roots.splice(0, rig.roots.length, synced)
    await expect(send(id, 'receipt', approving)).rejects.toThrow(OWN_ONLY)
    await expect(begin('Receipt 2.txt', 'receipt', { by: approving, own: true })).rejects.toThrow(OWN_ONLY)
    expect(readdirSync(synced)).toEqual([])
    // A Files upload of a key that may approve is his press there, as into a library; one that may not is refused.
    await expect(begin('Plan.txt', 'plan', { by: key })).rejects.toThrow(NEEDS_APPROVE)
    await send(await begin('Plan.txt', 'plan', { by: approving }), 'plan', approving)
    expect(readdirSync(synced)).toEqual(['Plan.txt'])
  })
})

describe('an upload into his own folder', () => {
  it('lands under a free name, never over the file there, and says so to the windows that show the folder', async () => {
    const id = await begin('notes.txt', 'new notes')
    rig.pushes.length = 0
    const landed = await send(id, 'new notes')
    expect(landed).toMatchObject({ name: 'notes 2.txt', size: 9, kind: 'file', path: join(rig.folder, 'notes 2.txt') })
    expect(landed.entry).toMatchObject({ key: `file:${HOST}:${join(rig.folder, 'notes 2.txt')}`, name: 'notes 2.txt', kind: 'text', size: 9, ref: at(join(rig.folder, 'notes 2.txt')) })
    expect(readFileSync(join(rig.folder, 'notes.txt'), 'utf8')).toBe('kickoff at 5')
    expect(readFileSync(join(rig.folder, 'notes 2.txt'), 'utf8')).toBe('new notes')
    expect(rig.pushes.map((p) => [p.p, p.to])).toEqual([[{ push: 'work.files', workspaceId: WS, at: `file:${HOST}:${rig.folder}` }, { need: 'read', path: rig.folder }]])
    expect(staged()).toEqual([])
  })

  it('waits outside the place until its commit', async () => {
    const id = await begin('Agenda.txt', 'agenda', { at: at(join(rig.folder, 'Events')) })
    await uploads.chunk('local', { uploadId: id, index: 0, dataBase64: Buffer.from('agenda').toString('base64') })
    expect(staged()).toEqual([id])
    expect(readdirSync(join(stagingRoot(rig.dataDir), id))).toEqual([`.upload-${id}.part`])
    expect(readdirSync(join(rig.folder, 'Events')).sort()).toEqual(['Poster.png', 'Spring LAN'])
    await uploads.commit('local', id)
    expect(readFileSync(join(rig.folder, 'Events', 'Agenda.txt'), 'utf8')).toBe('agenda')
  })

  it('leaves nothing for a wrong hash or a short file', async () => {
    const wrong = await begin('a.txt', 'one thing')
    await uploads.chunk('local', { uploadId: wrong, index: 0, dataBase64: Buffer.from('another th').toString('base64').slice(0, 12) })
    await expect(uploads.commit('local', wrong)).rejects.toMatchObject({ code: expect.stringMatching(/mismatch/) })
    const short = await begin('b.txt', 'abc', { size: 10 })
    await uploads.chunk('local', { uploadId: short, index: 0, dataBase64: Buffer.from('abc').toString('base64') })
    await expect(uploads.commit('local', short)).rejects.toMatchObject({ code: 'size-mismatch' })
    expect(existsSync(join(rig.folder, 'a.txt'))).toBe(false)
    expect(existsSync(join(rig.folder, 'b.txt'))).toBe(false)
    expect(staged()).toEqual([])
  })

  it('answers the same id for the same op, and the bytes are the one socket\'s that began it', async () => {
    const id = await begin('c.txt', 'c', { op: 'op-upload-same' })
    expect(await begin('c.txt', 'c', { op: 'op-upload-same' })).toBe(id)
    await expect(uploads.chunk('key:k9', { uploadId: id, index: 0, dataBase64: 'Yw==' })).rejects.toMatchObject({ code: 'unknown-upload' })
    await expect(uploads.commit('key:k9', id)).rejects.toMatchObject({ code: 'unknown-upload' })
    expect((await send(id, 'c')).name).toBe('c.txt')
  })

  it('answers a landed op as landed, across a restart of the host, and makes nothing twice', async () => {
    const id = await begin('d.txt', 'd', { op: 'op-upload-landed' })
    expect((await send(id, 'd')).name).toBe('d.txt')
    // The host restarts: its uploads, and the commit answers they kept, are gone; the op's row is not.
    uploads.close()
    uploads = new AttachmentUploads({ dirFor: () => join(rig.base, 'unused'), store: { getSetting: () => null, setSetting: () => {} }, now: () => clock, sweepEveryMs: 0 })
    ;(rig.ctx as { uploads: WorkCtx['uploads'] }).uploads = uploads
    await expect(uploads.commit('local', id)).rejects.toMatchObject({ code: 'unknown-upload' })
    const req = ClientRequestSchema.parse({ id: '2', method: 'work.files.upload', params: { workspaceId: WS, at: { at: 'place', id: 'folder' }, name: 'd.txt', size: 1, sha256: sha('d'), op: 'op-upload-landed' } })
    const out = await files.handle!(req, rig.ctx, window)
    expect(out.handled && out.result).toEqual({ uploadId: id, landed: true })
    expect(readdirSync(rig.folder).filter((n) => n.startsWith('d'))).toEqual(['d.txt'])
  })

  it('names where the file goes on the op before it is made', async () => {
    const id = await begin('e.txt', 'e', { op: 'op-upload-reserve' })
    let row: unknown = null
    writeSeams.beforeWrite = () => {
      row = JSON.parse((rig.db.prepare(`SELECT result FROM work_files_ops WHERE id = ?`).get('op-upload-reserve') as { result: string }).result)
    }
    await send(id, 'e')
    expect(row).toEqual({ uploadId: id, landing: join(rig.folder, 'e.txt') })
  })

  it('settles a host that stopped after making the file and before saying so: its own bytes there are landed, others are not', async () => {
    const restart = (): void => {
      uploads.close()
      uploads = new AttachmentUploads({ dirFor: () => join(rig.base, 'unused'), store: { getSetting: () => null, setSetting: () => {} }, now: () => clock, sweepEveryMs: 0 })
      ;(rig.ctx as { uploads: WorkCtx['uploads'] }).uploads = uploads
    }
    const again = async (name: string, text: string, op: string): Promise<unknown> => {
      const req = ClientRequestSchema.parse({ id: '3', method: 'work.files.upload', params: { workspaceId: WS, at: { at: 'place', id: 'folder' }, name, size: Buffer.byteLength(text), sha256: sha(text), op } })
      const out = await files.handle!(req, rig.ctx, window)
      return out.handled && out.result
    }
    // The file was made under the recorded name, and the host stopped before `landed` was written.
    const id = await begin('f.txt', 'ffff', { op: 'op-upload-stopped' })
    amendOp(rig.db, 'op-upload-stopped', { uploadId: id, landing: join(rig.folder, 'f.txt') })
    writeFileSync(join(rig.folder, 'f.txt'), 'ffff')
    restart()
    expect(await again('f.txt', 'ffff', 'op-upload-stopped')).toEqual({ uploadId: id, landed: true })
    expect(readdirSync(rig.folder).filter((n) => n.startsWith('f'))).toEqual(['f.txt'])
    // A file there that is not its bytes (another's, made in the gap) is not taken as landed.
    const other = await begin('g.txt', 'gggg', { op: 'op-upload-other' })
    amendOp(rig.db, 'op-upload-other', { uploadId: other, landing: join(rig.folder, 'g.txt') })
    writeFileSync(join(rig.folder, 'g.txt'), 'not the upload')
    restart()
    expect(await again('g.txt', 'gggg', 'op-upload-other')).toEqual({ uploadId: other })
  })

  it('refuses a name no place takes, before anything is staged', async () => {
    await expect(begin('a:b.txt', 'x')).rejects.toThrow('A name cannot hold :')
    expect(staged()).toEqual([])
  })

  it('takes nothing an abort or an expiry left', async () => {
    const aborted = await begin('d.txt', 'dd')
    await uploads.abort('local', aborted)
    const idle = await begin('e.txt', 'ee')
    clock += 11 * 60_000
    await uploads.sweepExpired()
    expect(staged()).toEqual([])
    await expect(send(idle, 'ee')).rejects.toMatchObject({ code: 'unknown-upload' })
    expect(existsSync(join(rig.folder, 'd.txt')) || existsSync(join(rig.folder, 'e.txt'))).toBe(false)
  })
})

describe('the second check at commit', () => {
  it('refuses a folder swapped for a link since the begin, and nothing lands outside', async () => {
    const id = await begin('Agenda.txt', 'agenda', { at: at(join(rig.folder, 'Events')) })
    renameSync(join(rig.folder, 'Events'), join(rig.folder, 'Events was'))
    symlinkSync(rig.outside, join(rig.folder, 'Events'))
    await expect(send(id, 'agenda')).rejects.toThrow()
    expect(readdirSync(rig.outside)).toEqual(['secret.txt'])
    expect(staged()).toEqual([])
  })

  it('takes back what landed when the folder is swapped in the moment of the write', async () => {
    const id = await begin('Agenda.txt', 'agenda', { at: at(join(rig.folder, 'Events')) })
    writeSeams.beforeWrite = () => {
      renameSync(join(rig.folder, 'Events'), join(rig.folder, 'Events was'))
      symlinkSync(rig.outside, join(rig.folder, 'Events'))
    }
    await expect(send(id, 'agenda')).rejects.toThrow('The folder changed while this ran, so nothing was put there.')
    expect(readdirSync(rig.outside)).toEqual(['secret.txt'])
    expect(staged()).toEqual([])
  })

  it('refuses the caller when the door would refuse it now', async () => {
    rig.roots.push(rig.cloud)
    LIBRARY_CAN.push('upload')
    const id = await begin('Plan 2.docx', 'word', { at: at(join(rig.team, 'General')), by: approving })
    // The library stops taking uploads before the bytes are done.
    LIBRARY_CAN.splice(0, LIBRARY_CAN.length)
    await expect(send(id, 'word', approving)).rejects.toThrow('Nothing can be uploaded in General from here.')
    expect(existsSync(join(rig.team, 'General', 'Plan 2.docx'))).toBe(false)
  })
})

describe('by caller', () => {
  it('a library: a key without approve is refused; with it, and asked, the file lands', async () => {
    rig.roots.push(rig.cloud)
    LIBRARY_CAN.push('upload')
    await expect(begin('Plan.docx', 'word', { at: at(join(rig.team, 'General')), by: key, asked: true })).rejects.toThrow(NEEDS_APPROVE)
    const id = await begin('Plan.docx', 'word', { at: at(join(rig.team, 'General')), by: approving, asked: true })
    const landed = await send(id, 'word', approving)
    expect(landed.name).toBe('Plan 2.docx')
    expect(landed.entry).toMatchObject({ key: 'lib:esportsstaffgeneral:Plan 2.docx', shared: true })
    expect(readFileSync(join(rig.team, 'General', 'Plan 2.docx'), 'utf8')).toBe('word')
  })

  it("a library today: the place's own refusal, since its adapter takes no upload yet", async () => {
    await expect(begin('Plan.docx', 'word', { at: at(join(rig.team, 'General')), asked: true })).rejects.toThrow('Nothing can be uploaded in General from here.')
  })

  it('a key with operate uploads into his own folder', async () => {
    const id = await begin('f.txt', 'f', { by: key })
    expect((await send(id, 'f', key)).name).toBe('f.txt')
  })

  it('a key that could not name the folder is refused at begin', async () => {
    rig.roots.splice(0, rig.roots.length, join(rig.folder, 'Events'))
    await expect(begin('g.txt', 'g', { at: at(rig.folder), by: key })).rejects.toThrow(FenceError)
    expect(staged()).toEqual([])
  })

  it('a thread is refused', async () => {
    await expect(begin('h.txt', 'h', { by: thread('t1') })).rejects.toThrow(THREADS_BY_TOOLS)
    expect(staged()).toEqual([])
  })
})
