import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClientRequestSchema } from '@shared/contract'
import type { FileDone, FilesPlaces } from '@shared/contract-work-files'
import { vmCanOf } from '@shared/work/filePlaces'
import type { Caller } from '../modules'
import { fenceRequest, FenceError } from '../../remote/fence'
import { setVmCall, VmUnreachable } from '../office/vm/link'
import { setVmState } from '../office/vm/office'
import { closeFilesState } from './handle'
import { files } from './index'
import { forgetVmLists } from './places/teams'
import { setThreadsMayWrite } from './policy'
import { settleTrash } from './trash'
import { approver, at, HOST, peer, phone, thread, window, WS, type Rig, makeRig } from './testkit'

/**
 * New, rename, move, edit and delete in a library OneDrive syncs in the Windows VM (vmVerbs.ts), with the guest's
 * helper stood in through `setVmCall`: each verb's call and its answer, the helper's own verb list as the gate, the
 * door's cells for a place others can open, a lost answer asked again by its id, and the listener's fence.
 */

const TOP = 'C:\\Users\\tcuser\\Dummy U\\Esports Staff - Documents'
const GENERAL = `${TOP}\\General`
const VERBS = ['files.mkdir', 'files.rename', 'files.move', 'files.write', 'files.recycle', 'files.restore', 'files.outcome']
const OLD_HELPER = "Files in the Windows VM cannot be changed from here yet. Open it there."

interface Call {
  verb: string
  args: Record<string, unknown>
}

describe.skipIf(process.platform === 'win32')('the Windows VM changed through its helper', () => {
  let rig: Rig
  let calls: Call[]
  /** what the stand-in guest holds, by lowercased path */
  let disk: Map<string, { path: string; dir: boolean; data: string; modified: number }>
  /** the stand-in's own journal: an op answered once */
  let journal: Map<string, unknown>
  let lose: number
  /** the stand-in's Recycle Bin: where each thing lies there, and the path it had */
  let recycled: Map<string, { path: string; f: { path: string; dir: boolean; data: string; modified: number } }>

  const entryOf = (path: string) => {
    const f = disk.get(path.toLowerCase())!
    return { name: f.path.slice(f.path.lastIndexOf('\\') + 1), path: f.path, dir: f.dir, size: f.dir ? 0 : Buffer.from(f.data, 'base64').length, modified: f.modified, local: true, link: false }
  }
  const put = (path: string, dir = false, data = '') => disk.set(path.toLowerCase(), { path, dir, data: Buffer.from(data).toString('base64'), modified: 1000 })
  const versionOf = (path: string) => {
    const e = entryOf(path)
    return `${e.size}:${e.modified}:h${disk.get(path.toLowerCase())!.data}`
  }
  const dirOf = (p: string) => p.slice(0, p.lastIndexOf('\\'))

  const status = (verbs?: string[]) =>
    rig.db.prepare(`INSERT OR REPLACE INTO work_office_files (key, value) VALUES ('vm:status', ?)`).run(
      JSON.stringify({
        at: Date.now(),
        status: { onedrive: { installed: true, running: true, account: 'a@dummy.edu' }, mounts: [{ path: TOP, type: 'team', web: null }], office: { installed: true, version: null, apps: [], account: null, licensed: null }, ...(verbs ? { verbs } : {}) },
        tops: { [TOP]: ['Events', 'General'] }
      })
    )

  /** The helper as the guest runs it: each change once per op, a taken name refused. */
  const guest = async (verb: string, args: Record<string, unknown>): Promise<unknown> => {
    calls.push({ verb, args })
    // The request arrives and is done; its answer is lost on the way back.
    const lost = lose > 0 && verb.startsWith('files.') && verb !== 'files.list' && verb !== 'files.stat'
    if (lost) lose--
    const op = args.op as string | undefined
    if (op && journal.has(op)) {
      if (lost) throw new VmUnreachable('the link dropped')
      return journal.get(op)
    }
    const answer = ((): unknown => {
      switch (verb) {
        case 'files.list':
          return [...disk.values()].filter((f) => dirOf(f.path).toLowerCase() === (args.dir as string).toLowerCase()).map((f) => entryOf(f.path))
        case 'files.stat':
          return entryOf(args.path as string)
        case 'files.read': {
          const f = disk.get((args.path as string).toLowerCase())!
          return { data: f.data, size: Buffer.from(f.data, 'base64').length, eof: true, ...(args.version ? { version: versionOf(f.path), changed: f.modified } : {}) }
        }
        case 'files.mkdir':
        case 'files.write': {
          if (verb === 'files.write' && args.path) {
            const path = args.path as string
            if (!disk.has(path.toLowerCase())) return { conflict: { gone: true } }
            if (versionOf(path) !== args.expect) return { conflict: { version: versionOf(path), changed: 1000 } }
            disk.get(path.toLowerCase())!.data = args.data as string
            disk.get(path.toLowerCase())!.modified = 2000
            return { version: versionOf(path), changed: 2000, entry: entryOf(path) }
          }
          const to = `${args.dir}\\${args.name}`
          if (disk.has(to.toLowerCase())) throw Object.assign(new Error(`A file named "${args.name}" is already there.`), { code: 'refused' })
          verb === 'files.mkdir' ? put(to, true) : disk.set(to.toLowerCase(), { path: to, dir: false, data: args.data as string, modified: 1000 })
          return { entry: entryOf(to) }
        }
        case 'files.rename':
        case 'files.move': {
          const from = args.path as string
          const to = verb === 'files.rename' ? `${dirOf(from)}\\${args.name}` : `${args.dir}\\${from.slice(from.lastIndexOf('\\') + 1)}`
          if (disk.has(to.toLowerCase()) && to.toLowerCase() !== from.toLowerCase()) throw new Error(`A file named "${to.slice(to.lastIndexOf('\\') + 1)}" is already there.`)
          const f = disk.get(from.toLowerCase())!
          disk.delete(from.toLowerCase())
          disk.set(to.toLowerCase(), { ...f, path: to })
          return { entry: entryOf(to) }
        }
        case 'files.recycle': {
          const path = args.path as string
          const bin = `C:\\$Recycle.Bin\\S-1-5-21\\$R${journal.size}`
          recycled.set(bin, { path, f: disk.get(path.toLowerCase())! })
          disk.delete(path.toLowerCase())
          return { name: path.slice(path.lastIndexOf('\\') + 1), bin }
        }
        case 'files.restore': {
          const held = recycled.get(args.bin as string)
          if (!held) throw new Error('That is not in the Recycle Bin any more.')
          if (held.path.toLowerCase() !== (args.to as string).toLowerCase()) throw new Error('The Recycle Bin holds something else there, so nothing was put back.')
          let to = held.path
          for (let i = 1; disk.has(to.toLowerCase()); i++) to = held.path.replace(/(\.[^.\\]*)?$/, (ext) => ` (restored)${i > 1 ? ` ${i}` : ''}${ext}`)
          disk.set(to.toLowerCase(), { ...held.f, path: to })
          recycled.delete(args.bin as string)
          return { entry: entryOf(to) }
        }
      }
      throw new Error(`unexpected ${verb}`)
    })()
    if (op) journal.set(op, answer)
    if (lost) throw new VmUnreachable('the link dropped')
    return answer
  }

  const call = async <T>(method: string, params: Record<string, unknown>, by: Caller = window): Promise<T> => {
    const out = await files.handle!({ id: '1', method, params: { workspaceId: WS, ...params } } as never, rig.ctx, by)
    return (out as { result: T }).result
  }
  /** the calls that change something (reads and the status read behind an answer are left out) */
  const changes = () => calls.filter((c) => !['files.list', 'files.stat', 'files.read', 'guest.status'].includes(c.verb))
  let ops = 0
  const op = () => `op-0000-${++ops}`

  beforeEach(() => {
    rig = makeRig()
    calls = []
    journal = new Map()
    recycled = new Map()
    lose = 0
    disk = new Map()
    put(`${GENERAL}\\Plan.txt`, false, 'first')
    put(`${GENERAL}\\Budgets`, true)
    put(`${GENERAL}\\Notes.txt`, false, 'x')
    put(`${TOP}\\Events\\Flyer.txt`, false, 'y')
    forgetVmLists()
    setVmState(() => ({ state: 'awake', cannot: null }))
    status(VERBS)
    setVmCall((verb, args) => guest(verb, (args ?? {}) as Record<string, unknown>))
  })
  afterEach(() => {
    setVmCall(null)
    setThreadsMayWrite(false)
    closeFilesState(rig.db)
    rig.close()
  })

  describe('what the helper says it has', () => {
    it('maps the helper\'s verbs to the place\'s, and offers nothing without a way to ask a lost answer again', () => {
      expect(vmCanOf(VERBS)).toEqual(['make', 'rename', 'move', 'edit', 'trash'])
      expect(vmCanOf(['files.rename', 'files.outcome'])).toEqual(['rename'])
      expect(vmCanOf(VERBS.filter((v) => v !== 'files.outcome'))).toEqual([])
      expect(vmCanOf(undefined)).toEqual([])
    })

    it('gives a VM place the verbs its helper has, with what New makes there, and an older helper none', async () => {
      const got = await call<FilesPlaces>('work.files.places', {})
      const general = got.places.find((p) => p.vm && p.name === 'General')!
      expect(general.can).toEqual(vmCanOf(VERBS))
      // A folder and a text file always; an Office file only where a maker writes it (none is registered here).
      expect(general.makes).toEqual(['document', 'text', 'folder'])
      expect(calls).toEqual([])
      status()
      const old = (await call<FilesPlaces>('work.files.places', {})).places.find((p) => p.vm && p.name === 'General')!
      expect(old.can).toEqual([])
      expect(old.makes).toBeUndefined()
    })

    it('refuses every change in an older helper\'s place in the grammar\'s sentence, and asks it nothing', async () => {
      status()
      await expect(call('work.files.make', { at: at(GENERAL), kind: 'folder', op: op() })).rejects.toThrow(OLD_HELPER)
      await expect(call('work.files.rename', { ref: at(`${GENERAL}\\Plan.txt`), name: 'Plan 2.txt', op: op() })).rejects.toThrow(OLD_HELPER)
      await expect(call('work.files.move', { refs: [at(`${GENERAL}\\Plan.txt`)], to: at(`${GENERAL}\\Budgets`), op: op() })).rejects.toThrow(OLD_HELPER)
      await expect(call('work.files.write', { ref: at(`${GENERAL}\\Plan.txt`), text: 'x', version: 'v' })).rejects.toThrow(OLD_HELPER)
      expect(calls).toEqual([])
    })
  })

  describe('each verb', () => {
    it('makes a folder and a text file under a free name, and answers them as rows of the place', async () => {
      const id = op()
      const folder = await call<FileDone>('work.files.make', { at: at(GENERAL), kind: 'folder', op: id })
      expect(changes()).toEqual([{ verb: 'files.mkdir', args: { dir: GENERAL, name: 'Untitled folder', op: `tc-files:${id}:0` } }])
      expect(folder).toMatchObject({ refused: [], op: id, entries: [{ name: 'Untitled folder', kind: 'folder', key: 'lib:esportsstaffgeneral:Untitled folder', shared: true, folder: at(`${GENERAL}\\Untitled folder`) }] })
      // A name taken case-blind gets the next free one; the form's extension is added.
      const text = await call<FileDone>('work.files.make', { at: at(GENERAL), kind: 'text', name: 'notes', op: op() })
      expect(changes().at(-1)).toMatchObject({ verb: 'files.write', args: { dir: GENERAL, name: 'notes 2.txt', data: '' } })
      expect(text.entries[0]).toMatchObject({ name: 'notes 2.txt', kind: 'text', ref: at(`${GENERAL}\\notes 2.txt`) })
      // The changed folder is said to every window that may read it.
      expect(rig.pushes.filter((p) => (p.p as { at?: string }).at === 'lib:esportsstaffgeneral:')).toHaveLength(2)
    })

    it("makes a Word file from Files' own blank where no maker writes one (New → Document in a Teams library in the VM)", async () => {
      const made = await call<FileDone>('work.files.make', { at: at(GENERAL), kind: 'document', name: 'Minutes', op: op() })
      const blank = readFileSync(join(process.cwd(), 'resources', 'work-files', 'blank', 'blank.docx')).toString('base64')
      expect(changes().at(-1)).toMatchObject({ verb: 'files.write', args: { dir: GENERAL, name: 'Minutes.docx', data: blank } })
      expect(made.entries[0]).toMatchObject({ name: 'Minutes.docx', kind: 'document' })
    })

    it('refuses a template and a name NTFS would not take, before the guest is asked', async () => {
      await expect(call('work.files.make', { at: at(GENERAL), kind: 'text', from: at(`${GENERAL}\\Plan.txt`), op: op() })).rejects.toThrow('made blank')
      await expect(call('work.files.make', { at: at(GENERAL), kind: 'folder', name: 'CON', op: op() })).rejects.toThrow('Windows keeps that name for itself.')
      expect(changes()).toEqual([])
    })

    it('renames a file, and his star on it follows', async () => {
      await call('work.files.star', { ref: at(`${GENERAL}\\Plan.txt`), name: 'Plan.txt', on: true })
      const id = op()
      const done = await call<FileDone>('work.files.rename', { ref: at(`${GENERAL}\\Plan.txt`), name: 'Plan final.txt', op: id })
      expect(changes()).toEqual([{ verb: 'files.rename', args: { path: `${GENERAL}\\Plan.txt`, name: 'Plan final.txt', op: `tc-files:${id}:0` } }])
      expect(done.entries[0]).toMatchObject({ name: 'Plan final.txt', key: 'lib:esportsstaffgeneral:Plan final.txt', starred: true })
      // A taken name is the guest's refusal in its own words; the place's top is never renamed.
      await expect(call('work.files.rename', { ref: at(`${GENERAL}\\Notes.txt`), name: 'Plan final.txt', op: op() })).rejects.toThrow('A file named "Plan final.txt" is already there.')
      await expect(call('work.files.rename', { ref: { at: 'place', id: 'box~x' }, name: 'x', op: op() })).rejects.toThrow()
    })

    it('moves each thing into a folder of the same place under an id of its own, a taken name refused alone', async () => {
      put(`${GENERAL}\\Budgets\\Notes.txt`, false, 'there')
      const id = op()
      const done = await call<FileDone>('work.files.move', { refs: [at(`${GENERAL}\\Plan.txt`), at(`${GENERAL}\\Notes.txt`)], to: at(`${GENERAL}\\Budgets`), op: id })
      expect(changes().map((c) => [c.verb, c.args.path, c.args.dir, c.args.op])).toEqual([
        ['files.move', `${GENERAL}\\Plan.txt`, `${GENERAL}\\Budgets`, `tc-files:${id}:0`],
        ['files.move', `${GENERAL}\\Notes.txt`, `${GENERAL}\\Budgets`, `tc-files:${id}:1`]
      ])
      expect(done.entries.map((e) => e.key)).toEqual(['lib:esportsstaffgeneral:Budgets/Plan.txt'])
      expect(done.refused).toEqual([{ name: 'Notes.txt', text: 'A file named "Notes.txt" is already there.' }])
    })

    it('refuses a move to another place of the VM in the grammar\'s sentence, and asks the guest nothing', async () => {
      await expect(call('work.files.move', { refs: [at(`${GENERAL}\\Plan.txt`)], to: at(`${TOP}\\Events`), op: op() })).rejects.toThrow('Teams files stay in Teams.')
      await expect(call('work.files.copy', { refs: [at(`${GENERAL}\\Plan.txt`)], to: at(`${GENERAL}\\Budgets`), op: op() })).rejects.toThrow('Nothing can be copied in General from here.')
      expect(changes()).toEqual([])
    })

    it('reads a file for his editor with its version, and saves it by that version, a stale one answered as a conflict', async () => {
      const read = await call<{ data: string; version: string; locked?: string }>('work.files.read', { ref: at(`${GENERAL}\\Plan.txt`), offset: 0, length: 100 })
      expect(read).toMatchObject({ data: Buffer.from('first').toString('base64'), version: versionOf(`${GENERAL}\\Plan.txt`) })
      expect(read.locked).toBeUndefined()
      const stale = await call<{ conflict?: unknown }>('work.files.write', { ref: at(`${GENERAL}\\Plan.txt`), text: 'second', version: '5:1:old' })
      expect(stale).toEqual({ conflict: { version: read.version, changed: 1000 } })
      const saved = await call<{ version: string }>('work.files.write', { ref: at(`${GENERAL}\\Plan.txt`), text: 'second', version: read.version })
      expect(saved.version).toBe(versionOf(`${GENERAL}\\Plan.txt`))
      const write = changes().filter((c) => c.verb === 'files.write').at(-1)!
      expect(write.args).toMatchObject({ path: `${GENERAL}\\Plan.txt`, data: Buffer.from('second').toString('base64'), expect: read.version })
      expect(write.args.op).toMatch(/^tc-files:/)
      // Gone, it is the save's conflict.
      disk.delete(`${GENERAL}\\Plan.txt`.toLowerCase())
      expect(await call('work.files.write', { ref: at(`${GENERAL}\\Plan.txt`), text: 'third', version: saved.version })).toEqual({ conflict: { gone: true } })
      // His edits kept beside it instead: "Name (mine).ext", never over anything.
      const copy = await call<{ copy: { name: string } }>('work.files.write', { ref: at(`${GENERAL}\\Plan.txt`), text: 'third', version: saved.version, copy: true })
      expect(copy.copy.name).toBe('Plan (mine).txt')
    })

    it('sends a file to the Recycle Bin after his window asks, keeping a row Trash lists, and puts it back on Undo', async () => {
      const id = op()
      await expect(call('work.files.trash', { refs: [at(`${GENERAL}\\Plan.txt`)], op: op() })).rejects.toThrow('Others can open that place: the window asks before this change.')
      const done = await call<FileDone>('work.files.trash', { refs: [at(`${GENERAL}\\Plan.txt`)], op: id, asked: true })
      expect(changes()).toEqual([{ verb: 'files.recycle', args: { path: `${GENERAL}\\Plan.txt`, op: `tc-files:${id}:0` } }])
      expect(done.trashed).toHaveLength(1)
      const row = rig.db.prepare(`SELECT state, provider, name, ref FROM work_files_trash WHERE id = ?`).get(done.trashed![0]!) as { state: string; provider: string; name: string; ref: string }
      expect([row.state, row.provider, row.name, JSON.parse(row.ref).bin]).toEqual(['held', 'onedrive', 'Plan.txt', expect.stringMatching(/^C:\\\$Recycle\.Bin\\/)])
      // Trash lists it; its file left the folder.
      const listed = (await call<{ entries: { name: string; where?: unknown }[] }>('work.files.list', { at: { at: 'place', id: 'trash' } })).entries
      expect(listed.map((e) => [e.name, e.where])).toEqual([['Plan.txt', { place: expect.stringMatching(/\/General$/), name: 'General', trail: [] }]])
      expect(disk.has(`${GENERAL}\\Plan.txt`.toLowerCase())).toBe(false)
      // Undo: the helper takes it out of the bin to where it was, by where it said it lies.
      const back = await call<FileDone>('work.files.restore', { ids: done.trashed, op: op() })
      expect(back.entries.map((e) => e.name)).toEqual(['Plan.txt'])
      expect(changes().at(-1)).toEqual({ verb: 'files.restore', args: { bin: JSON.parse(row.ref).bin, to: `${GENERAL}\\Plan.txt`, op: expect.stringMatching(/^tc-files:restore:/) } })
      expect(disk.has(`${GENERAL}\\Plan.txt`.toLowerCase())).toBe(true)
      expect(rig.db.prepare(`SELECT 1 FROM work_files_trash`).get()).toBeUndefined()
    })

    it('puts a deleted folder back beside a new one of its name, and a helper without the verb says where to put it back', async () => {
      const done = await call<FileDone>('work.files.trash', { refs: [at(`${GENERAL}\\Budgets`)], op: op(), asked: true })
      put(`${GENERAL}\\Budgets`, true)
      expect((await call<FileDone>('work.files.restore', { ids: done.trashed, op: op() })).entries.map((e) => e.name)).toEqual(['Budgets (restored)'])
      const again = await call<FileDone>('work.files.trash', { refs: [at(`${GENERAL}\\Notes.txt`)], op: op(), asked: true })
      status(VERBS.filter((v) => v !== 'files.restore'))
      expect((await call<FileDone>('work.files.restore', { ids: again.trashed, op: op() })).refused).toEqual([{ name: 'Notes.txt', text: 'Put it back from the Recycle Bin in the Windows VM.' }])
    })

    it('refuses the place itself, and a delete a thread asks for is never run from the wire', async () => {
      const top = await call<FileDone>('work.files.trash', { refs: [at(GENERAL)], op: op(), asked: true })
      expect(top.refused).toEqual([{ name: 'General', text: 'A place itself cannot be deleted.' }])
      expect(changes()).toEqual([])
    })

  })

  describe('a lost answer', () => {
    it('leaves no Trash row standing for a VM delete a dead process left half asked', async () => {
      rig.db
        .prepare(`INSERT INTO work_files_trash (id, workspace_id, ref, name, place, was_at, state, deleted_at, by, provider) VALUES ('r1', ?, ?, 'Plan.txt', 'p', ?, 'moving', 1, 'owner', 'onedrive')`)
        .run(WS, JSON.stringify(at(`${GENERAL}\\Plan.txt`)), JSON.stringify(at(GENERAL)))
      await settleTrash(rig.ctx)
      expect(rig.db.prepare(`SELECT 1 FROM work_files_trash WHERE id = 'r1'`).get()).toBeUndefined()
    })

    it('is asked again by the same id, which the guest answers without doing it twice', async () => {
      lose = 1
      const id = op()
      const done = await call<FileDone>('work.files.make', { at: at(GENERAL), kind: 'folder', name: 'Lost', op: id })
      expect(done.entries[0]!.name).toBe('Lost')
      expect(changes().map((c) => [c.verb, c.args.op])).toEqual([
        ['files.mkdir', `tc-files:${id}:0`],
        ['files.mkdir', `tc-files:${id}:0`]
      ])
      expect([...disk.keys()].filter((k) => k.endsWith('\\lost'))).toHaveLength(1)
    })

    it('lost twice, keeps nothing in the journal, so the same id from the caller asks the guest once more and is answered', async () => {
      lose = 2
      const id = op()
      await expect(call('work.files.rename', { ref: at(`${GENERAL}\\Plan.txt`), name: 'Renamed.txt', op: id })).rejects.toThrow('The Windows VM is unreachable')
      expect(rig.db.prepare(`SELECT 1 FROM work_files_ops WHERE id = ?`).get(id)).toBeUndefined()
      // The rename was done in the guest; the same id again is answered from its journal, not refused for a name that is gone.
      const again = await call<FileDone>('work.files.rename', { ref: at(`${GENERAL}\\Plan.txt`), name: 'Renamed.txt', op: id })
      expect(again.entries[0]!.name).toBe('Renamed.txt')
      expect(changes().filter((c) => c.verb === 'files.rename').map((c) => c.args.op)).toEqual([`tc-files:${id}:0`, `tc-files:${id}:0`, `tc-files:${id}:0`])
    })
  })

  describe('the door, for a place others can open', () => {
    it('lets his window and a key with approve change it, and refuses a key without', async () => {
      await expect(call('work.files.rename', { ref: at(`${GENERAL}\\Plan.txt`), name: 'A.txt', op: op() }, phone)).rejects.toThrow('Others can open that place: this key may not change it.')
      await expect(call<FileDone>('work.files.rename', { ref: at(`${GENERAL}\\Plan.txt`), name: 'A.txt', op: op() }, approver)).resolves.toMatchObject({ entries: [{ name: 'A.txt' }] })
      // An editor's bytes go to his own window alone.
      await expect(call('work.files.read', { ref: at(`${GENERAL}\\A.txt`), offset: 0, length: 10 }, approver)).rejects.toThrow('read in his own window')
      await expect(call('work.files.write', { ref: at(`${GENERAL}\\A.txt`), text: 'x', version: 'v' }, approver)).rejects.toThrow('read in his own window')
    })

    it('refuses a thread on the wire: its changes go through the files_* tools, which hold them', async () => {
      rig.settings.set(WS, { windowsVm: true })
      await expect(call('work.files.rename', { ref: at(`${GENERAL}\\Plan.txt`), name: 'A.txt', op: op() }, thread('t1'))).rejects.toThrow('A thread changes files with the files_* tools.')
      expect(changes()).toEqual([])
    })

    it('needs where a change from another host began', async () => {
      await expect(call('work.files.rename', { ref: at(`${GENERAL}\\Plan.txt`), name: 'A.txt', op: op() }, peer)).rejects.toThrow('A change from another host of his must say where it began.')
      await expect(call<FileDone>('work.files.rename', { ref: at(`${GENERAL}\\Plan.txt`), name: 'A.txt', op: op(), origin: { from: 'window' } }, peer)).resolves.toMatchObject({ entries: [{ name: 'A.txt' }] })
    })

    it('never lets a guest path outside OneDrive\'s mounts reach the helper', async () => {
      for (const path of ['C:\\Users\\tcuser\\Desktop\\secret.txt', `${GENERAL}\\..\\..\\..\\Desktop\\secret.txt`, `${GENERAL}\\Plan.txt:stream`, `${GENERAL}/Plan.txt`, `${GENERAL}\\Plan.txt.`]) {
        await expect(call('work.files.rename', { ref: at(path), name: 'x.txt', op: op() }), path).rejects.toThrow()
        await expect(call('work.files.make', { at: at(path), kind: 'folder', op: op() }), path).rejects.toThrow()
      }
      await expect(call('work.files.move', { refs: [at(`${GENERAL}\\Plan.txt`)], to: at('C:\\Users\\tcuser\\Desktop'), op: op() })).rejects.toThrow("That is not in this workspace's folder or a library it may use.")
      expect(changes()).toEqual([])
    })
  })

  describe("the listener's fence", () => {
    const fenced = (method: string, params: Record<string, unknown>) => () => fenceRequest(ClientRequestSchema.parse({ id: '1', method, params: { workspaceId: WS, ...params } }), [rig.folder], [], [], HOST)

    it('passes a guest path in each verb that changes a file there, and still refuses this host\'s paths outside the roots', () => {
      const file = at(`${GENERAL}\\Plan.txt`)
      expect(fenced('work.files.make', { at: at(GENERAL), kind: 'folder', op: 'op-00001' })).not.toThrow()
      expect(fenced('work.files.rename', { ref: file, name: 'x.txt', op: 'op-00001' })).not.toThrow()
      expect(fenced('work.files.move', { refs: [file], to: at(`${GENERAL}\\Budgets`), op: 'op-00001' })).not.toThrow()
      expect(fenced('work.files.trash', { refs: [file], op: 'op-00001' })).not.toThrow()
      for (const method of ['work.files.make', 'work.files.rename', 'work.files.trash']) {
        const params = method === 'work.files.make' ? { at: at('/etc'), kind: 'folder', op: 'op-00001' } : method === 'work.files.rename' ? { ref: at('/etc/passwd'), name: 'x', op: 'op-00001' } : { refs: [at('/etc/passwd')], op: 'op-00001' }
        expect(fenced(method, params), method).toThrow(FenceError)
      }
      expect(fenced('work.files.move', { refs: [file], to: at('/etc'), op: 'op-00001' })).toThrow(FenceError)
      // An editor's bytes there are not for a key: the fence refuses the guest path for read and write.
      expect(fenced('work.files.read', { ref: file, offset: 0, length: 10 })).toThrow(FenceError)
      expect(fenced('work.files.write', { ref: file, text: 'x', version: 'v' })).toThrow(FenceError)
      expect(fenced('work.files.copy', { refs: [file], to: at(GENERAL), op: 'op-00001' })).toThrow(FenceError)
    })
  })
})
