import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClientRequestSchema } from '@shared/contract'
import type { FileDone, FilesListing, FilesOpened, FilesTabs } from '@shared/contract-work-files'
import type { Caller } from '../modules'
import { closeFilesState, THREADS_BY_TOOLS } from './handle'
import { files } from './index'
import { workspaceHere } from './policy'
import { approver, at, HOST, makeRig, peer, phone, thread, window, WS, type Rig } from './testkit'
import { NOT_IN_TRASH, purgeOld, purgeRows, restoreRows, settleTrash, trashAfterMove, trashInLibrary, trashRoot, TRASH_DAYS } from './trash'
import { withFileLocks } from './write'

/** Trash for the workspace's own folder (trash.ts), through the module as a socket's requests reach it. */

let rig: Rig
let ops = 0
beforeEach(() => {
  rig = makeRig()
})
afterEach(() => {
  closeFilesState(rig.db)
  rig.close()
})

async function call<T>(method: string, params: Record<string, unknown>, by: Caller = window): Promise<T> {
  const req = ClientRequestSchema.parse({ id: '1', method, params: { workspaceId: WS, ...params } })
  const out = await files.handle!(req, rig.ctx, by)
  if (!out.handled) throw new Error(`${method} was not handled`)
  return out.result as T
}
const op = (): string => `op-trash-${++ops}`
const trash = (paths: string[], o: { op?: string; by?: Caller } = {}): Promise<FileDone> => call<FileDone>('work.files.trash', { refs: paths.map((p) => at(p)), op: o.op ?? op() }, o.by)
const restore = (ids: string[], by: Caller = window): Promise<FileDone> => call<FileDone>('work.files.restore', { ids, op: op() }, by)
const listTrash = (by: Caller = window): Promise<FilesListing> => call<FilesListing>('work.files.list', { at: { at: 'place', id: 'trash' } }, by)
const listFolder = async (path?: string): Promise<string[]> => (await call<FilesListing>('work.files.list', { at: path ? at(path) : { at: 'place', id: 'folder' } })).entries.map((e) => e.name)
type Row = { id: string; workspace_id: string; name: string; state: string; held_at: number | null }
const rows = (): Row[] => rig.db.prepare(`SELECT id, workspace_id, name, state, held_at FROM work_files_trash ORDER BY deleted_at`).all() as Row[]
const binOf = (id: string): string => join(trashRoot(rig.dataDir), WS, id)
/** Every name under a folder, links not followed. */
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? [e.name, ...walk(join(dir, e.name))] : [e.name]))

describe('a delete', () => {
  it('takes a file and a folder out of the folder and lists them in Trash, newest first, with where each was', async () => {
    const one = await trash([join(rig.folder, 'notes.txt')])
    const two = await trash([join(rig.folder, 'Events', 'Spring LAN')])
    expect(one).toMatchObject({ entries: [], refused: [], trashed: [expect.any(String)] })
    expect(await listFolder()).not.toContain('notes.txt')
    expect(await listFolder(join(rig.folder, 'Events'))).toEqual(['Poster.png'])
    const listed = await listTrash()
    expect(listed.place).toBe('trash')
    expect(listed.trail).toEqual([{ name: 'Trash', at: { at: 'place', id: 'trash' } }])
    expect(listed.entries.map((e) => [e.key, e.name, e.kind, e.ref, e.folder, e.where])).toEqual([
      [`trash:${two.trashed![0]}`, 'Spring LAN', 'folder', null, null, { place: 'folder', name: 'Dummy Esports', trail: ['Events'] }],
      [`trash:${one.trashed![0]}`, 'notes.txt', 'text', null, null, { place: 'folder', name: 'Dummy Esports', trail: [] }]
    ])
    expect(listed.entries[1]).toMatchObject({ size: 'kickoff at 5'.length, changed: expect.any(Number) })
    expect(rows().map((r) => r.state)).toEqual(['held', 'held'])
    // The bytes wait outside the workspace's folder, where no listing of it and no walk finds them.
    expect(readFileSync(join(binOf(one.trashed![0]), 'notes.txt'), 'utf8')).toBe('kickoff at 5')
    expect(existsSync(join(binOf(two.trashed![0]), 'Spring LAN', 'Bracket.pdf'))).toBe(true)
    expect(relative(rig.folder, trashRoot(rig.dataDir)).startsWith('..')).toBe(true)
    expect(walk(rig.folder)).not.toContain('notes.txt')
    expect(walk(rig.folder)).not.toContain('Bracket.pdf')
  })

  it('says it to the windows that show the folder and Trash', async () => {
    rig.pushes.length = 0
    await trash([join(rig.folder, 'notes.txt')])
    expect(rig.pushes.map((p) => [p.p, p.to])).toEqual([
      [{ push: 'work.files', workspaceId: WS, at: `file:${HOST}:${rig.folder}` }, { need: 'read', path: rig.folder }],
      [{ push: 'work.files', workspaceId: WS, at: 'place:trash' }, { need: 'read' }]
    ])
  })

  it('done twice under one op deletes once and answers the same', async () => {
    const id = op()
    const first = await trash([join(rig.folder, 'notes.txt')], { op: id })
    expect(await trash([join(rig.folder, 'notes.txt')], { op: id })).toEqual(first)
    expect(rows()).toHaveLength(1)
  })

  it('closes the Files tab that shows the file first, its item with it', async () => {
    const opened = await call<FilesOpened>('work.files.open', { ref: at(join(rig.folder, 'notes.txt')) })
    expect(rig.canvas.get(opened.item!.id)).not.toBeNull()
    await trash([join(rig.folder, 'notes.txt')])
    const tabs = await call<FilesTabs>('work.files.tabs', {})
    expect(tabs.tabs.filter((t) => t.kind === 'file')).toEqual([])
    expect(rig.canvas.get(opened.item!.id)).toBeNull()
  })

  it('closes the tabs of files inside a folder that goes', async () => {
    const opened = await call<FilesOpened>('work.files.open', { ref: at(join(rig.folder, 'Events', 'Spring LAN', 'Bracket.pdf')) })
    await trash([join(rig.folder, 'Events')])
    expect((await call<FilesTabs>('work.files.tabs', {})).tabs.some((t) => t.id === opened.tabId)).toBe(false)
  })

  it('refuses a file a thread is writing in, in the grammar\'s sentence, and leaves it', async () => {
    const path = join(rig.folder, 'notes.txt')
    let done!: () => void
    const held = withFileLocks([`file:${HOST}:${path}`], () => new Promise<void>((r) => (done = r)))
    const got = await trash([path])
    done()
    await held
    expect(got).toMatchObject({ trashed: [], refused: [{ name: 'notes.txt', text: 'A thread is writing in this file. Try when it is done.' }] })
    expect(existsSync(path)).toBe(true)
    expect(rows()).toEqual([])
  })

  it("keeps a library's refusal: a delete there is the provider's, and stays off", async () => {
    await expect(trash([join(rig.team, 'General', 'Plan.docx')])).rejects.toThrow('Delete it in Teams.')
    // One refused ref refuses the whole change: nothing else went.
    await expect(trash([join(rig.folder, 'notes.txt'), join(rig.team, 'General', 'Plan.docx')])).rejects.toThrow('Delete it in Teams.')
    expect(existsSync(join(rig.folder, 'notes.txt'))).toBe(true)
  })

  it('refuses a thread and another host of his, and a key outside its roots', async () => {
    await expect(trash([join(rig.folder, 'notes.txt')], { by: thread('t1') })).rejects.toThrow(THREADS_BY_TOOLS)
    await expect(trash([join(rig.folder, 'notes.txt')], { by: peer })).rejects.toThrow()
    rig.roots.splice(0, rig.roots.length, join(rig.folder, 'Events'))
    await expect(trash([join(rig.folder, 'notes.txt')], { by: phone })).rejects.toThrow()
    expect(rows()).toEqual([])
  })

  it('lets a key with operate delete in his own folder', async () => {
    expect((await trash([join(rig.folder, 'notes.txt')], { by: phone })).trashed).toHaveLength(1)
  })
})

describe('Put back', () => {
  it('puts a file and a folder back where they were, and the row goes', async () => {
    const { trashed } = await trash([join(rig.folder, 'notes.txt'), join(rig.folder, 'Events', 'Spring LAN')])
    const back = await restore(trashed!)
    expect(back.refused).toEqual([])
    expect(back.entries.map((e) => [e.name, e.where])).toEqual([
      ['notes.txt', { place: 'folder', name: 'Dummy Esports', trail: [] }],
      ['Spring LAN', { place: 'folder', name: 'Dummy Esports', trail: ['Events'] }]
    ])
    expect(readFileSync(join(rig.folder, 'notes.txt'), 'utf8')).toBe('kickoff at 5')
    expect(existsSync(join(rig.folder, 'Events', 'Spring LAN', 'Bracket.pdf'))).toBe(true)
    expect(rows()).toEqual([])
    expect(existsSync(binOf(trashed![0]))).toBe(false)
    expect((await listTrash()).entries).toEqual([])
  })

  it('takes a "(restored)" name when its own is taken there', async () => {
    const { trashed } = await trash([join(rig.folder, 'notes.txt')])
    writeFileSync(join(rig.folder, 'notes.txt'), 'a new one')
    const back = await restore(trashed!)
    expect(back.entries.map((e) => e.name)).toEqual(['notes (restored).txt'])
    expect(readFileSync(join(rig.folder, 'notes.txt'), 'utf8')).toBe('a new one')
    expect(readFileSync(join(rig.folder, 'notes (restored).txt'), 'utf8')).toBe('kickoff at 5')
  })

  it("goes to the folder's top when its own folder is gone, and says where it went", async () => {
    const { trashed } = await trash([join(rig.folder, 'Events', 'Poster.png')])
    rmSync(join(rig.folder, 'Events'), { recursive: true })
    const back = await restore(trashed!)
    expect(back.entries.map((e) => [e.name, e.where])).toEqual([['Poster.png', { place: 'folder', name: 'Dummy Esports', trail: [] }]])
    expect(existsSync(join(rig.folder, 'Poster.png'))).toBe(true)
  })

  it('refuses an id that is no held row of this workspace, by its id', async () => {
    const { trashed } = await trash([join(rig.folder, 'notes.txt')])
    await restore(trashed!)
    expect(await restore([...trashed!, 'nope'])).toMatchObject({ entries: [], refused: [{ name: trashed![0], text: NOT_IN_TRASH }, { name: 'nope', text: NOT_IN_TRASH }] })
  })
})

describe('from a remote key', () => {
  it('puts back with operate, empties Trash only with approve', async () => {
    const { trashed } = await trash([join(rig.folder, 'notes.txt'), join(rig.folder, 'Budget.xlsx')])
    expect((await restore([trashed![0]], phone)).entries.map((e) => e.name)).toEqual(['notes.txt'])
    await expect(call('work.files.restore', { ids: [trashed![1]], op: op() }, { kind: 'remote', caps: ['read'] })).rejects.toThrow('This key may not put files back.')
    await expect(call('work.files.purge', {}, phone)).rejects.toThrow('This key may not empty Trash.')
    expect(await call('work.files.purge', {}, approver)).toEqual({ purged: 1 })
    expect(rows()).toEqual([])
    expect(existsSync(binOf(trashed![1]))).toBe(false)
  })

  it("gets nothing of another workspace's rows, nor of a row it could not name", async () => {
    const theirs = await call<FileDone>('work.files.trash', { workspaceId: 'w2', refs: [at(join(rig.otherFolder, 'Payroll.xlsx'))], op: op() })
    const id = theirs.trashed![0]
    rig.roots.push(rig.otherFolder)
    // Named under his own workspace: no such row there.
    expect(await restore([id], approver)).toMatchObject({ entries: [], refused: [{ name: id, text: NOT_IN_TRASH }] })
    expect(await call('work.files.purge', { ids: [id] }, approver)).toEqual({ purged: 0 })
    // A key whose roots leave a row out does not see it, put it back or purge it.
    rig.roots.splice(0, rig.roots.length, rig.folder)
    expect((await call<FilesListing>('work.files.list', { workspaceId: 'w2', at: { at: 'place', id: 'trash' } }, approver)).entries).toEqual([])
    expect(await call<FileDone>('work.files.restore', { workspaceId: 'w2', ids: [id], op: op() }, approver)).toMatchObject({ refused: [{ name: id, text: NOT_IN_TRASH }] })
    expect(await call('work.files.purge', { workspaceId: 'w2' }, approver)).toEqual({ purged: 0 })
    expect(rows().map((r) => [r.workspace_id, r.state])).toEqual([['w2', 'held']])
  })

  it('is no thread\'s and no peer\'s to read or change', async () => {
    await expect(listTrash(thread('t1'))).rejects.toThrow('the tabs of Files are his own')
    await expect(call('work.files.purge', {}, thread('t1'))).rejects.toThrow(THREADS_BY_TOOLS)
    await expect(listTrash(peer)).rejects.toThrow()
  })
})

describe('a restore racing a purge', () => {
  it('lets exactly one claim the row, and never loses a file that was put back', async () => {
    const workspace = workspaceHere(rig.db, WS)!
    const wins = [0, 0]
    for (let i = 0; i < 50; i++) {
      const path = join(rig.folder, `race ${i}.txt`)
      writeFileSync(path, `race ${i}`)
      const { trashed } = await trash([path])
      // Each side starts after a short random wait, so either may go first, or reach the row mid-way through the other.
      const later = <T,>(fn: () => Promise<T>): Promise<T> => new Promise((r) => setTimeout(r, Math.random() * 3)).then(fn)
      const [back, gone] = await Promise.all([later(() => restoreRows(rig.ctx, window, workspace, trashed!, op())), later(() => purgeRows(rig.ctx, window, workspace, trashed!))])
      const restored = back.entries.length === 1
      expect(restored !== (gone.purged === 1), `run ${i}`).toBe(true)
      expect(existsSync(path), `run ${i}`).toBe(restored)
      if (restored) expect(readFileSync(path, 'utf8')).toBe(`race ${i}`)
      wins[restored ? 0 : 1]++
      expect(rows(), `run ${i}`).toEqual([])
      expect(existsSync(binOf(trashed![0])), `run ${i}`).toBe(false)
    }
    // Both sides won some: the race was run, not one order fifty times.
    expect(wins[0]).toBeGreaterThan(0)
    expect(wins[1]).toBeGreaterThan(0)
  })
})

describe('the boot check', () => {
  /** A row as a dead process left it, its bytes placed by `place`. */
  function leftRow(state: string, name: string, place: (bin: string, path: string) => void): { id: string; path: string } {
    const id = `left-${state}-${++ops}`
    const path = join(rig.folder, name)
    const file = { at: 'file', host: HOST, path }
    rig.db
      .prepare(`INSERT INTO work_files_trash (id, workspace_id, ref, name, place, was_at, state, held_at, deleted_at, by) VALUES (?, ?, ?, ?, 'folder', ?, ?, ?, ?, 'owner')`)
      .run(id, WS, JSON.stringify(file), name, JSON.stringify({ ...file, path: rig.folder }), state, state === 'moving' ? null : Date.now(), Date.now())
    mkdirSync(binOf(id), { recursive: true })
    place(join(binOf(id), name), path)
    return { id, path }
  }
  const stateOf = (id: string): string | null => (rig.db.prepare(`SELECT state FROM work_files_trash WHERE id = ?`).get(id) as { state: string } | undefined)?.state ?? null

  it('holds a delete whose bytes reached Trash, and drops one whose bytes are still in place', async () => {
    const moved = leftRow('moving', 'notes.txt', (bin, path) => renameSync(path, bin))
    const notYet = leftRow('moving', 'Budget.xlsx', () => {})
    // A move by hard link cut between the link and the unlink: both names, one file.
    const linked = leftRow('moving', 'Run of show.tcdoc', (bin, path) => linkSync(path, bin))
    // A copy to another disk cut short: a part of it in Trash, the file whole in place.
    const partial = leftRow('moving', 'notes2.txt', (bin, path) => {
      writeFileSync(path, 'whole')
      writeFileSync(bin, 'wh')
    })
    expect(await settleTrash(rig.ctx)).toEqual({ held: 1, undone: 3, restored: 0, purged: 0 })
    expect(stateOf(moved.id)).toBe('held')
    expect((await listTrash()).entries.map((e) => e.name)).toEqual(['notes.txt'])
    for (const left of [notYet, linked, partial]) {
      expect(stateOf(left.id)).toBeNull()
      expect(existsSync(binOf(left.id))).toBe(false)
      expect(existsSync(left.path)).toBe(true)
    }
    expect(readFileSync(partial.path, 'utf8')).toBe('whole')
  })

  it('keeps both halves of a folder whose source was half removed after its copy', async () => {
    const half = leftRow('moving', 'Events', (bin, path) => {
      mkdirSync(join(bin, 'Spring LAN'), { recursive: true })
      writeFileSync(join(bin, 'Poster.png'), 'png')
      rmSync(join(path, 'Poster.png'))
    })
    // And a same-disk folder move cut before its rename: an empty folder in Trash, the source whole.
    const empty = leftRow('moving', 'Events2', (bin, path) => {
      mkdirSync(join(path, 'inner'), { recursive: true })
      mkdirSync(bin)
    })
    await settleTrash(rig.ctx)
    expect(stateOf(half.id)).toBe('held')
    expect(existsSync(join(binOf(half.id), 'Events', 'Poster.png'))).toBe(true)
    expect(existsSync(join(half.path, 'Spring LAN'))).toBe(true)
    expect(stateOf(empty.id)).toBeNull()
    expect(existsSync(join(empty.path, 'inner'))).toBe(true)
  })

  it('finishes a restore whose bytes left Trash, and holds again one whose bytes did not', async () => {
    const done = leftRow('restoring', 'back.txt', (_bin, path) => writeFileSync(path, 'back'))
    const notYet = leftRow('restoring', 'waiting.txt', (bin) => writeFileSync(bin, 'waiting'))
    expect(await settleTrash(rig.ctx)).toEqual({ held: 1, undone: 0, restored: 1, purged: 0 })
    expect(stateOf(done.id)).toBeNull()
    expect(existsSync(binOf(done.id))).toBe(false)
    expect(stateOf(notYet.id)).toBe('held')
    expect(await restore([notYet.id])).toMatchObject({ entries: [{ name: 'waiting.txt' }] })
  })

  it('finishes a purge', async () => {
    const left = leftRow('purging', 'gone.txt', (bin) => writeFileSync(bin, 'gone'))
    expect(await settleTrash(rig.ctx)).toEqual({ held: 0, undone: 0, restored: 0, purged: 1 })
    expect(stateOf(left.id)).toBeNull()
    expect(existsSync(binOf(left.id))).toBe(false)
  })

  it('runs when the module starts', async () => {
    const moved = leftRow('moving', 'notes.txt', (bin, path) => renameSync(path, bin))
    const stop = files.start!(rig.ctx)
    for (let i = 0; i < 50 && stateOf(moved.id) !== 'held'; i++) await new Promise((r) => setTimeout(r, 10))
    if (typeof stop === 'function') stop()
    expect(stateOf(moved.id)).toBe('held')
  })
})

describe('the 30-day purge', () => {
  it('empties rows held longer than 30 days, bytes and all, and keeps the rest', async () => {
    const { trashed } = await trash([join(rig.folder, 'notes.txt'), join(rig.folder, 'Budget.xlsx')])
    const now = Date.now()
    rig.db.prepare(`UPDATE work_files_trash SET held_at = ? WHERE id = ?`).run(now - TRASH_DAYS * 24 * 60 * 60 * 1000 - 1, trashed![0])
    expect(await purgeOld(rig.ctx, now)).toBe(1)
    expect(rows().map((r) => r.name)).toEqual(['Budget.xlsx'])
    expect(existsSync(binOf(trashed![0]))).toBe(false)
    expect(existsSync(binOf(trashed![1]))).toBe(true)
  })
})

describe('a deleted workspace', () => {
  it('leaves no row and no byte of its Trash', async () => {
    const { trashed } = await trash([join(rig.folder, 'notes.txt')])
    files.workspaceRemoved!(WS, rig.ctx)
    expect(rows()).toEqual([])
    expect(existsSync(join(trashRoot(rig.dataDir), WS))).toBe(false)
    expect(existsSync(binOf(trashed![0]))).toBe(false)
  })
})

describe('for the other verbs', () => {
  it("puts a moved file's source in Trash once, under its own id within the move's op", async () => {
    const workspace = workspaceHere(rig.db, WS)!
    const path = join(rig.folder, 'notes.txt')
    const id = await trashAfterMove(rig.ctx, workspace, path, 'move-1')
    expect(rows().map((r) => [r.id, r.state])).toEqual([[id, 'held']])
    expect(existsSync(path)).toBe(false)
    // The same move again answers the same row and does nothing twice.
    expect(await trashAfterMove(rig.ctx, workspace, path, 'move-1')).toBe(id)
    expect(rows()).toHaveLength(1)
    await expect(trashAfterMove(rig.ctx, workspace, join(rig.team, 'General', 'Plan.docx'), 'move-2')).rejects.toThrow("Only a file of the workspace's folder goes to Trash here.")
  })

  it("holds a library's delete as a provider's row with no bytes here, through the bin it is given (not wired)", async () => {
    const binned: string[] = []
    const path = join(rig.team, 'General', 'Plan.docx')
    const id = await trashInLibrary(rig.ctx, { workspaceId: WS, placeId: 'lib', path }, async (p) => void binned.push(p))
    expect(binned).toEqual([path])
    expect(rig.db.prepare(`SELECT state, provider, place FROM work_files_trash WHERE id = ?`).get(id)).toEqual({ state: 'held', provider: 'onedrive', place: 'lib' })
    expect(existsSync(binOf(id))).toBe(false)
    // A bin that fails leaves no row.
    await expect(trashInLibrary(rig.ctx, { workspaceId: WS, placeId: 'lib', path }, async () => Promise.reject(new Error('no bin')))).rejects.toThrow('no bin')
    expect(rows()).toHaveLength(1)
    // And Put back sends him to the bin.
    expect((await restore([id])).refused).toEqual([{ name: 'Plan.docx', text: 'Put it back from the recycle bin.' }])
  })
})
