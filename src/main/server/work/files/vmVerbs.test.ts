import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { NAME_TAKEN } from './write'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientRequestSchema } from '@shared/contract'
import type { FileDone, FilesOpened, FilesListing, FilesPlaces, FilesTabs } from '@shared/contract-work-files'
import { canvasSourcePath } from '@shared/work'
import { refKey } from '@shared/work/files'
import { vmCanOf } from '@shared/work/filePlaces'
import type { Caller } from '../modules'
import { fenceRequest, FenceError } from '../../remote/fence'
import { setVmCall, VmUnreachable } from '../office/vm/link'
import { setVmState } from '../office/vm/office'
import { setCopyAllowed } from '../office/files/library'
import { copyRecord } from './copies'
import { closeFilesState } from './handle'
import { files } from './index'
import { forgetVmLists } from './places/teams'
import { makeBytes } from './verbs'
import { setThreadsMayWrite } from './policy'
import { settleTrash } from './trash'
import { cloudOf, forgetUploads, lookAll } from './uploads'
import { approver, at, HOST, peer, phone, thread, window, WS, type Rig, makeRig } from './testkit'

// Save as Word to… writes the Work service's Word export; here a stand-in's bytes.
vi.mock('../formats/exporter', () => ({ exportDoc: async () => ({ name: 'Minutes.docx', data: Buffer.from('word export').toString('base64'), warnings: [] }) }))

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
  let refuseRecycle: boolean
  /** runs while the stand-in's Recycle Bin takes a file: his words landing in its copy meanwhile */
  let onRecycle: (() => void) | null
  /** what the stand-in's `files.stat` says of OneDrive's upload (absent: a helper that cannot say) */
  let synced: boolean | undefined
  /** the stand-in's Recycle Bin: where each thing lies there, and the path it had */
  let recycled: Map<string, { path: string; f: { path: string; dir: boolean; data: string; modified: number } }>

  const entryOf = (path: string) => {
    const f = disk.get(path.toLowerCase())!
    return { name: f.path.slice(f.path.lastIndexOf('\\') + 1), path: f.path, dir: f.dir, size: f.dir ? 0 : Buffer.from(f.data, 'base64').length, modified: f.modified, local: true, link: false }
  }
  const put = (path: string, dir = false, data = '') => disk.set(path.toLowerCase(), { path, dir, data: Buffer.from(data).toString('base64'), modified: 1000 })
  /** The helper's `VersionOf`: size, change time and the bytes' sha256. */
  const versionOf = (path: string) => {
    const e = entryOf(path)
    return `${e.size}:${e.modified}:${createHash('sha256').update(Buffer.from(disk.get(path.toLowerCase())!.data, 'base64')).digest('hex')}`
  }
  const dirOf = (p: string) => p.slice(0, p.lastIndexOf('\\'))

  const now = Date.UTC(2026, 10, 23, 17)
  const status = (verbs?: string[], mount = TOP) =>
    rig.db.prepare(`INSERT OR REPLACE INTO work_office_files (key, value) VALUES ('vm:status', ?)`).run(
      JSON.stringify({
        at: now,
        status: { onedrive: { installed: true, running: true, account: 'a@dummy.edu' }, mounts: [{ path: mount, type: 'team', web: null }], office: { installed: true, version: null, apps: [], account: null, licensed: null }, ...(verbs ? { verbs } : {}) },
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
    if (verb === 'files.outcome') {
      if (lost) throw new VmUnreachable('the link dropped')
      return journal.has(op!) ? { state: 'done', verb: 'files.recycle', value: journal.get(op!) } : { state: 'unknown' }
    }
    if (op && journal.has(op)) {
      if (lost) throw new VmUnreachable('the link dropped')
      return journal.get(op)
    }
    const answer = ((): unknown => {
      switch (verb) {
        case 'files.list':
          return [...disk.values()].filter((f) => dirOf(f.path).toLowerCase() === (args.dir as string).toLowerCase()).map((f) => entryOf(f.path))
        case 'files.stat':
          return { ...entryOf(args.path as string), ...(synced === undefined ? {} : { synced }) }
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
          if (refuseRecycle) throw new Error('The Recycle Bin refused the file.')
          onRecycle?.()
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
  const paired = <T>(method: string, params: Record<string, unknown>) => {
    fenceRequest(ClientRequestSchema.parse({ id: '1', method, params: { workspaceId: WS, ...params } }), rig.roots, [], [], HOST)
    return call<T>(method, params, approver)
  }
  const trashAt = { at: 'place', id: 'trash' }
  /** the calls that change something (reads and the status read behind an answer are left out) */
  const changes = () => calls.filter((c) => !['files.list', 'files.stat', 'files.read', 'guest.status'].includes(c.verb))
  let ops = 0
  const op = () => `op-0000-${++ops}`

  beforeEach(() => {
    vi.setSystemTime(now)
    rig = makeRig()
    calls = []
    journal = new Map()
    recycled = new Map()
    lose = 0
    refuseRecycle = false
    onRecycle = null
    synced = undefined
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
    vi.useRealTimers()
    forgetUploads()
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

    it("makes a held act's New under the name its card showed or not at all, read case-blind as the guest names", async () => {
      // As a press sends it: the folder bound by its key (the act's things), never read from this host's disk.
      const folderKey = 'lib:esportsstaffgeneral:'
      const held = (name: string) => ({ at: at(GENERAL), kind: 'text', name, op: op(), origin: { from: 'act', id: 'h1', digest: 'd'.repeat(64), things: [{ key: folderKey, version: '0:1:' }] } })
      const before = changes().length
      await expect(call('work.files.make', held('Notes'))).rejects.toThrow(NAME_TAKEN('Notes.txt'))
      expect(changes()).toHaveLength(before)
      // The same folder, a name free there: made, though the guest's folder is no path of this disk.
      await call('work.files.make', held('Agenda'))
      expect(changes().at(-1)).toMatchObject({ verb: 'files.write', args: { dir: GENERAL, name: 'Agenda.txt' } })
      // Another folder than the one it was held for: refused before the guest is asked.
      const other = { ...held('Other'), origin: { from: 'act', id: 'h1', digest: 'd'.repeat(64), things: [{ key: 'lib:elsewhere:', version: '0:1:' }] } }
      const count = changes().length
      await expect(call('work.files.make', other)).rejects.toThrow('is not as it was when this was held')
      expect(changes()).toHaveLength(count)
      // His own New takes the next free name, as before.
      await call('work.files.make', { at: at(GENERAL), kind: 'text', name: 'Notes', op: op() })
      expect(changes().at(-1)).toMatchObject({ args: { name: 'Notes 2.txt' } })
    })

    it("renames and moves a held act's thing only as the guest finds it held: another file there now is refused before the guest changes anything", async () => {
      const file = `${GENERAL}\\Plan.txt`
      const [entry] = (await call<{ entries: { key: string; size?: number; changed?: number }[] }>('work.files.stat', { refs: [at(file)] })).entries
      const asHeld = `${entry!.size ?? 0}:${entry!.changed ?? 0}:`
      const origin = (version: string) => ({ from: 'act', id: 'h1', digest: 'd'.repeat(64), things: [{ key: entry!.key, version }] })
      const before = changes().length
      // The file at that name was replaced in the guest since it was held: its version is not the one shown.
      await expect(call('work.files.rename', { ref: at(file), name: 'Plan v2.txt', op: op(), origin: origin('1:1:') })).rejects.toThrow('Plan.txt is not as it was when this was held')
      await expect(call('work.files.move', { refs: [at(file)], to: at(`${GENERAL}\\Budgets`), op: op(), origin: origin('1:1:') })).rejects.toThrow('Plan.txt is not as it was when this was held')
      expect(changes()).toHaveLength(before)
      // As held: renamed.
      await call('work.files.rename', { ref: at(file), name: 'Plan v2.txt', op: op(), origin: origin(asHeld) })
      expect(changes().at(-1)).toMatchObject({ verb: 'files.rename', args: { name: 'Plan v2.txt' } })
    })

    it("checks each thing of a held move just before its own move: one replaced while the one before it moved is refused, never moved", async () => {
      const files = [`${GENERAL}\\Plan.txt`, `${GENERAL}\\Notes.txt`]
      // Each one's own look: a page of VM rows asked at once is not looked at row by row.
      const stat = await Promise.all(files.map(async (f) => (await call<{ entries: { key: string; size?: number; changed?: number }[] }>('work.files.stat', { refs: [at(f)] })).entries[0]!))
      const things = stat.map((e) => ({ key: e.key, version: `${e.size ?? 0}:${e.changed ?? 0}:` }))
      // The first move's answer comes back once OneDrive has replaced the second file.
      setVmCall(async (verb, args) => {
        const answer = await guest(verb, (args ?? {}) as Record<string, unknown>)
        const notes = disk.get(`${GENERAL}\\Notes.txt`.toLowerCase())
        if (verb === 'files.move' && notes) notes.modified = 5000
        return answer
      })
      const done = await call<FileDone>('work.files.move', { refs: files.map((f) => at(f)), to: at(`${GENERAL}\\Budgets`), op: op(), asked: true, origin: { from: 'act', id: 'h1', digest: 'd'.repeat(64), things } })
      expect(done.entries.map((e) => e.name)).toEqual(['Plan.txt'])
      expect(done.refused).toEqual([{ name: 'Notes.txt', text: 'Notes.txt is not as it was when this was held, so nothing was done.' }])
      expect(disk.has(`${GENERAL}\\Notes.txt`.toLowerCase())).toBe(true)
      expect(changes().filter((c) => c.verb === 'files.move')).toHaveLength(1)
    })

    it("never moves or renames a file put in the held one's place between the box's look and the helper's change: it goes back, and the press is refused", async () => {
      const file = `${GENERAL}\\Plan.txt`
      const [entry] = (await call<{ entries: { key: string; size?: number; changed?: number }[] }>('work.files.stat', { refs: [at(file)] })).entries
      const asHeld = `${entry!.size ?? 0}:${entry!.changed ?? 0}:`
      const origin = { from: 'act', id: 'h1', digest: 'd'.repeat(64), things: [{ key: entry!.key, version: asHeld }] }
      // OneDrive puts another file at that name after the box looked, before the helper's change.
      let swap = true
      setVmCall(async (verb, args) => {
        const a = (args ?? {}) as Record<string, unknown>
        if (swap && (verb === 'files.move' || verb === 'files.rename') && a.path === file) {
          swap = false
          disk.get(file.toLowerCase())!.modified = 7000
        }
        return guest(verb, a)
      })
      await expect(call('work.files.move', { refs: [at(file)], to: at(`${GENERAL}\\Budgets`), op: op(), asked: true, origin })).resolves.toMatchObject({ entries: [], refused: [{ name: 'Plan.txt', text: 'Plan.txt is not as it was when this was held, so nothing was done.' }] })
      expect(disk.get(file.toLowerCase())).toMatchObject({ modified: 7000 })
      expect(disk.has(`${GENERAL}\\Budgets\\Plan.txt`.toLowerCase())).toBe(false)
      // The held version goes with the change, for a helper that checks it inside its own operation.
      expect(changes().find((c) => c.verb === 'files.move')?.args).toMatchObject({ expect: asHeld })
      // A rename the same way: the file swapped after the box's look goes back to its own name.
      const [now] = (await call<{ entries: { key: string; size?: number; changed?: number }[] }>('work.files.stat', { refs: [at(file)] })).entries
      setVmCall(async (verb, args) => {
        const a = (args ?? {}) as Record<string, unknown>
        if (verb === 'files.rename' && a.path === file) disk.get(file.toLowerCase())!.modified = 8000
        return guest(verb, a)
      })
      await expect(call('work.files.rename', { ref: at(file), name: 'Plan v2.txt', op: op(), origin: { ...origin, things: [{ key: now!.key, version: `${now!.size ?? 0}:${now!.changed ?? 0}:` }] } })).rejects.toThrow('Plan.txt is not as it was when this was held')
      expect(disk.get(file.toLowerCase())).toMatchObject({ modified: 8000 })
      expect(disk.has(`${GENERAL}\\Plan v2.txt`.toLowerCase())).toBe(false)
    })

    it("makes a Word file from Files' own blank where no maker writes one (New → Document in a Teams library in the VM)", async () => {
      const made = await call<FileDone>('work.files.make', { at: at(GENERAL), kind: 'document', name: 'Minutes', op: op() })
      const blank = readFileSync(join(process.cwd(), 'resources', 'work-files', 'blank', 'blank.docx')).toString('base64')
      expect(changes().at(-1)).toMatchObject({ verb: 'files.write', args: { dir: GENERAL, name: 'Minutes.docx', data: blank } })
      expect(made.entries[0]).toMatchObject({ name: 'Minutes.docx', kind: 'document' })
    })

    it('saves a document as Word into a VM folder through files.write, under a free name, never over a file there', async () => {
      put(`${GENERAL}\\Minutes.docx`, false, 'theirs')
      // The document is open in the workspace, as the dialog's item is.
      await call('work.files.open', { ref: { at: 'file', host: HOST, path: join(rig.folder, 'Run of show.tcdoc') } })
      const id = op()
      const got = await call<{ name: string; ref: { path: string } }>('work.files.saveAsWord', { source: { at: 'file', host: HOST, path: join(rig.folder, 'Run of show.tcdoc') }, at: at(GENERAL), op: id })
      expect(changes()).toEqual([{ verb: 'files.write', args: { dir: GENERAL, name: 'Minutes 2.docx', data: Buffer.from('word export').toString('base64'), op: `tc-files:${id}:0` } }])
      expect(got).toMatchObject({ name: 'Minutes 2.docx', ref: at(`${GENERAL}\\Minutes 2.docx`) })
      expect(Buffer.from(disk.get(`${GENERAL}\\Minutes.docx`.toLowerCase())!.data, 'base64').toString()).toBe('theirs')
      // A key that may not approve, and a thread, write nothing there.
      await expect(call('work.files.saveAsWord', { source: { at: 'file', host: HOST, path: join(rig.folder, 'Run of show.tcdoc') }, at: at(GENERAL), op: op() }, phone)).rejects.toThrow('this key may not change it')
      await expect(call('work.files.saveAsWord', { source: { at: 'file', host: HOST, path: join(rig.folder, 'Run of show.tcdoc') }, at: at(GENERAL), op: op() }, thread('t1'))).rejects.toThrow('files_* tools')
      expect(changes()).toHaveLength(1)
    })

    it("Save As… from a key that may approve makes the file in a VM library, linked, and writes it again there by the version it made", async () => {
      const source = { at: 'file', host: HOST, path: join(rig.folder, 'Run of show.tcdoc') }
      await call('work.files.open', { ref: source })
      const got = await call<{ saved: { name: string; linked: boolean } }>('work.files.saveAs', { source, at: at(GENERAL), format: 'docx', name: 'Agenda', place: 'General', op: op() }, approver)
      expect(got.saved).toMatchObject({ name: 'Agenda.docx', linked: true })
      const made = versionOf(`${GENERAL}\\Agenda.docx`)
      const [link] = await call<{ id: string; state: string }[]>('work.files.links', { source }, approver)
      expect(link).toMatchObject({ state: 'saved' })
      // His Retry writes the document again over the file, by the version the guest answered when it was made.
      await call('work.files.linkAct', { id: link!.id, act: 'retry' }, approver)
      expect(changes().at(-1)).toMatchObject({ verb: 'files.write', args: { path: `${GENERAL}\\Agenda.docx`, expect: made } })
      // A key that may not approve neither saves there nor touches the link.
      await expect(call('work.files.saveAs', { source, at: at(GENERAL), format: 'docx', op: op() }, phone)).rejects.toThrow('this key may not change it')
      await expect(call('work.files.linkAct', { id: link!.id, act: 'unlink' }, phone)).rejects.toThrow()
    })

    it('follows a Save As into a VM library to the cloud, and drops what OneDrive did once the link writes it again', async () => {
      const source = { at: 'file', host: HOST, path: join(rig.folder, 'Run of show.tcdoc') }
      const made = `${GENERAL}\\Agenda.docx`
      await call('work.files.open', { ref: source })
      await call('work.files.saveAs', { source, at: at(GENERAL), format: 'docx', name: 'Agenda', place: 'General', op: op() }, approver)
      // The file Save As made has its record, as any write of ours into a library does: never In Teams before OneDrive has it.
      expect(cloudOf(WS, HOST, made)).toMatchObject({ is: 'uploading' })
      synced = true
      await lookAll(rig.ctx)
      expect(cloudOf(WS, HOST, made)).toMatchObject({ is: 'uploaded' })
      // The link's next write is new bytes: OneDrive's word on the last ones is not told of them.
      synced = undefined
      const [link] = await call<{ id: string }[]>('work.files.links', { source }, approver)
      await call('work.files.linkAct', { id: link!.id, act: 'retry' }, approver)
      expect(cloudOf(WS, HOST, made)).toMatchObject({ is: 'uploading' })
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

    it('lets a paired key list and undo its VM delete through the OneDrive mount fence', async () => {
      const path = `${GENERAL}\\Plan.txt`
      expect(rig.ctx.reaches(approver, path)).toBe(false)
      const done = await paired<FileDone>('work.files.trash', { refs: [at(path)], op: op(), asked: true })
      expect(done.refused).toEqual([])
      const id = done.trashed![0]!
      const list = () => paired<FilesListing>('work.files.list', { at: trashAt })
      const undo = () => paired<FileDone>('work.files.restore', { ids: [id], op: op() })
      expect((await list()).entries).toMatchObject([{ key: `trash:${id}`, name: 'Plan.txt' }])

      status(VERBS, `${TOP} other`)
      expect((await list()).entries).toEqual([])
      expect(await undo()).toMatchObject({ entries: [], refused: [{ name: id, text: 'That is not in Trash any more.' }] })
      expect(changes().some((c) => c.verb === 'files.restore')).toBe(false)

      status(VERBS)
      expect(await undo()).toMatchObject({ entries: [{ name: 'Plan.txt' }], refused: [] })
      expect(disk.has(path.toLowerCase())).toBe(true)
      expect(recycled.size).toBe(0)
    })

    it('keeps an unsent copy and its tab until the Recycle Bin takes the original', async () => {
      const path = `${GENERAL}\\Plan.txt`
      setCopyAllowed(rig.db, WS, true)
      const opened = await call<FilesOpened>('work.files.open', { ref: at(path), name: 'Plan.txt' })
      const copy = canvasSourcePath(opened.item!.source)!
      writeFileSync(copy, 'unsent edits')
      rig.db.prepare("UPDATE work_files_copies SET state = 'refused', writes = 1 WHERE copy = ?").run(copy)
      const record = copyRecord(rig.ctx, WS, HOST, path)
      expect(record?.state).toBe('refused')
      const tab = async () => (await call<FilesTabs>('work.files.tabs', {})).tabs.find((t) => t.id === opened.tabId)

      refuseRecycle = true
      const remove = () => call<FileDone>('work.files.trash', { refs: [at(path)], op: op(), asked: true })
      expect(await remove()).toMatchObject({ trashed: [], refused: [{ name: 'Plan.txt', text: 'The Recycle Bin refused the file.' }] })
      expect(disk.has(path.toLowerCase())).toBe(true)
      expect(copyRecord(rig.ctx, WS, HOST, path)).toEqual(record)
      expect(readFileSync(copy, 'utf8')).toBe('unsent edits')
      expect(await tab()).toMatchObject({ copyOf: { host: HOST, path, vm: true } })

      refuseRecycle = false
      // His question showed the copy's one write: that is what goes.
      expect(await call<FileDone>('work.files.trash', { refs: [at(path)], op: op(), asked: true, writes: { [refKey(at(path))]: 1 } })).toMatchObject({ trashed: [expect.any(String)], refused: [] })
      expect(disk.has(path.toLowerCase())).toBe(false)
      expect(copyRecord(rig.ctx, WS, HOST, path)).toBeNull()
      expect(existsSync(copy)).toBe(false)
      expect(await tab()).toBeUndefined()
    })

    it('keeps what a copy took after his press while the Recycle Bin was slow: the tab closes, the copy stays', async () => {
      const path = `${GENERAL}\\Plan.txt`
      setCopyAllowed(rig.db, WS, true)
      const opened = await call<FilesOpened>('work.files.open', { ref: at(path), name: 'Plan.txt' })
      const copy = canvasSourcePath(opened.item!.source)!
      writeFileSync(copy, 'unsent edits')
      rig.db.prepare("UPDATE work_files_copies SET state = 'refused', writes = 1 WHERE copy = ?").run(copy)
      onRecycle = () => {
        writeFileSync(copy, 'unsent edits and one more')
        rig.db.prepare('UPDATE work_files_copies SET writes = 2 WHERE copy = ?').run(copy)
      }
      expect(await call<FileDone>('work.files.trash', { refs: [at(path)], op: op(), asked: true, writes: { [refKey(at(path))]: 1 } })).toMatchObject({ trashed: [expect.any(String)] })
      expect(disk.has(path.toLowerCase())).toBe(false)
      expect((await call<FilesTabs>('work.files.tabs', {})).tabs.some((t) => t.id === opened.tabId)).toBe(false)
      expect(copyRecord(rig.ctx, WS, HOST, path)).toMatchObject({ closed: 1, writes: 2 })
      expect(readFileSync(copy, 'utf8')).toBe('unsent edits and one more')
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

  describe("a file made from bytes (Save As)", () => {
    const made = (data: Buffer) => makeBytes(rig.ctx, window, { workspaceId: WS, at: { at: 'file', host: HOST, path: GENERAL }, name: 'Budget.docx', data, op: op() }, 'work.files.saveAs')
    it("answers its receipt: the helper's look at the file it made, with these bytes' hash", async () => {
      const data = Buffer.from('docx one')
      expect((await made(data)).version).toBe(`${data.length}:1000:${createHash('sha256').update(data).digest('hex')}`)
    })
    it('answers none when the file the helper looked at is not these bytes', async () => {
      // A colleague's save landed between the helper's make and its look.
      setVmCall(async (verb, args) => {
        const got = (await guest(verb, (args ?? {}) as Record<string, unknown>)) as { entry?: { size: number } }
        return verb === 'files.write' && got.entry ? { entry: { ...got.entry, size: got.entry.size + 9 } } : got
      })
      expect((await made(Buffer.from('docx one'))).version).toBeUndefined()
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

    it('keeps a VM delete pending across lost replies and restart, then recovers Undo from the helper journal', async () => {
      const path = `${GENERAL}\\Plan.txt`
      const id = op()
      const helperOp = `tc-files:${id}:0`
      const remove = () => paired<FileDone>('work.files.trash', { refs: [at(path)], op: id, asked: true })
      lose = 3
      await expect(remove()).rejects.toThrow('The Windows VM is unreachable')
      const pending = () => rig.db.prepare("SELECT id, state, json_extract(ref, '$.recycleOp') AS op FROM work_files_trash").get()
      const row = pending() as { id: string }
      expect(row).toMatchObject({ id: expect.any(String), state: 'moving', op: helperOp })
      expect(disk.has(path.toLowerCase())).toBe(false)
      expect(recycled.size).toBe(1)
      await settleTrash(rig.ctx)
      expect(pending()).toEqual(row)

      const list = () => paired<FilesListing>('work.files.list', { at: trashAt })
      expect((await list()).entries).toEqual([])
      expect(pending()).toEqual(row)
      expect((await list()).entries).toMatchObject([{ key: `trash:${row.id}`, name: 'Plan.txt' }])
      expect(await remove()).toMatchObject({ trashed: [row.id], refused: [] })
      expect(changes().filter((c) => c.verb === 'files.recycle').map((c) => c.args.op)).toEqual([helperOp, helperOp])
      expect(await paired<FileDone>('work.files.restore', { ids: [row.id], op: op() })).toMatchObject({ entries: [{ name: 'Plan.txt' }], refused: [] })
      expect(pending()).toBeUndefined()
    })

    it('settled later from the journal, keeps what he typed in the copy since the delete was asked', async () => {
      const path = `${GENERAL}\\Plan.txt`
      setCopyAllowed(rig.db, WS, true)
      const opened = await call<FilesOpened>('work.files.open', { ref: at(path), name: 'Plan.txt' })
      const copy = canvasSourcePath(opened.item!.source)!
      lose = 3
      await expect(call<FileDone>('work.files.trash', { refs: [at(path)], op: op(), asked: true })).rejects.toThrow('The Windows VM is unreachable')
      // The answer was lost: the tab is still open, and he types again.
      writeFileSync(copy, 'typed after the delete was asked')
      rig.db.prepare("UPDATE work_files_copies SET state = 'refused', writes = writes + 1 WHERE copy = ?").run(copy)
      // The next Trash listing reads the helper's journal: the file went to the bin.
      await call<FilesListing>('work.files.list', { at: trashAt })
      await call<FilesListing>('work.files.list', { at: trashAt })
      expect((await call<FilesTabs>('work.files.tabs', {})).tabs.find((t) => t.id === opened.tabId)).toBeUndefined()
      expect(readFileSync(copy, 'utf8')).toBe('typed after the delete was asked')
      expect(copyRecord(rig.ctx, WS, HOST, path)).toMatchObject({ closed: 1 })
    })

    it('uses the pending VM delete when the paired window retries with a new operation id', async () => {
      const path = `${GENERAL}\\Notes.txt`
      const remove = (id: string) => paired<FileDone>('work.files.trash', { refs: [at(path)], op: id, asked: true })
      const id = op()
      lose = 2
      await expect(remove(id)).rejects.toThrow('The Windows VM is unreachable')
      const row = rig.db.prepare('SELECT id FROM work_files_trash').get() as { id: string }
      expect(await remove(op())).toMatchObject({ trashed: [row.id], refused: [] })
      expect(changes().filter((c) => c.verb === 'files.recycle').map((c) => c.args.op)).toEqual([`tc-files:${id}:0`, `tc-files:${id}:0`])
      expect(recycled.size).toBe(1)
    })

    it('keeps an unknown delete pending and resends only its original helper id on a confirmed retry', async () => {
      const path = `${GENERAL}\\Notes.txt`
      const sent: unknown[] = []
      setVmCall(async (verb, args) => {
        if (verb === 'files.recycle') {
          sent.push(args?.op)
          if (sent.length <= 2) throw new VmUnreachable('the request did not arrive')
        }
        return guest(verb, args ?? {})
      })
      const id = op()
      const remove = (id: string) => paired<FileDone>('work.files.trash', { refs: [at(path)], op: id, asked: true })
      await expect(remove(id)).rejects.toThrow('The Windows VM is unreachable')
      expect((await paired<FilesListing>('work.files.list', { at: trashAt })).entries).toEqual([])
      expect(disk.has(path.toLowerCase())).toBe(true)
      expect(sent).toEqual([`tc-files:${id}:0`, `tc-files:${id}:0`])

      expect(await remove(op())).toMatchObject({ trashed: [expect.any(String)], refused: [] })
      expect(sent).toEqual(Array(3).fill(`tc-files:${id}:0`))
      expect(recycled.size).toBe(1)
    })

    it('drops a pending row only when the helper confirms its refusal', async () => {
      const path = `${GENERAL}\\Plan.txt`
      const id = op()
      setVmCall(async (verb, args, opts) => {
        if (verb === 'files.recycle') throw new VmUnreachable('the refusal did not arrive')
        if (verb === 'files.outcome') {
          expect(args).toEqual({ op: `tc-files:${id}:0` })
          expect(opts?.wake).toBe(false)
          return { state: 'failed', verb: 'files.recycle', message: 'The Recycle Bin refused the file.' }
        }
        return guest(verb, args ?? {})
      })
      await expect(paired('work.files.trash', { refs: [at(path)], op: id, asked: true })).rejects.toThrow('The Windows VM is unreachable')
      expect(rig.db.prepare("SELECT state FROM work_files_trash").get()).toMatchObject({ state: 'moving' })
      expect((await paired<FilesListing>('work.files.list', { at: trashAt })).entries).toEqual([])
      expect(rig.db.prepare('SELECT 1 FROM work_files_trash').get()).toBeUndefined()
      expect(disk.has(path.toLowerCase())).toBe(true)
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
      // Save as Word to… names the VM folder by its guest path and the document by a path in the roots; a document
      // outside them, or claimed for another host, is still refused.
      const doc = at(join(rig.folder, 'Run of show.tcdoc'))
      expect(fenced('work.files.saveAsWord', { source: doc, at: at(GENERAL), op: 'op-00001' })).not.toThrow()
      expect(fenced('work.files.saveAs', { source: doc, at: at(GENERAL), format: 'pdf', op: 'op-00001' })).not.toThrow()
      expect(fenced('work.files.saveAs', { source: doc, at: at('/Users/him/OneDrive', 'env_mac0000000000000000000'), format: 'docx', op: 'op-00001' })).not.toThrow()
      expect(fenced('work.files.saveAs', { source: doc, at: at('/etc'), format: 'docx', op: 'op-00001' })).toThrow(FenceError)
      expect(fenced('work.files.saveAsWord', { source: doc, at: at('/Users/him/OneDrive', 'env_mac0000000000000000000'), op: 'op-00001' })).not.toThrow()
      expect(fenced('work.files.saveAsWord', { source: at('/etc/secret.tcdoc'), at: at(GENERAL), op: 'op-00001' })).toThrow(FenceError)
      expect(fenced('work.files.saveAsWord', { source: doc, at: at('/etc'), op: 'op-00001' })).toThrow(FenceError)
    })
  })
})
