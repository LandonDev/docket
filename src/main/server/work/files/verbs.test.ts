import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClientRequestSchema } from '@shared/contract'
import type { FileDone } from '@shared/contract-work-files'
import { refKey } from '@shared/work/files'
import type { Caller } from '../modules'
import { closeFilesState, THREADS_BY_TOOLS } from './handle'
import { registerFileMaker } from './hooks'
import { files } from './index'
import { blankOf } from './make'
import { ASK_FIRST, NEEDS_APPROVE, PEER_NO_ORIGIN } from './policy'
import { approver, at, makeRig, peer, phone, thread, window, WS, type Rig } from './testkit'
import { setExcelHere, setTrashHook } from './verbs'
import { withFileLocks } from './write'

/** New, rename, move and copy through the module, each request as the contract reads it (docs/agents/work-files.md "New, rename, move and copy"). */

let rig: Rig
let ops = 0
const offs: (() => void)[] = []
beforeEach(() => {
  rig = makeRig()
})
afterEach(() => {
  for (const off of offs.splice(0)) off()
  setExcelHere(null)
  setTrashHook(null)
  closeFilesState(rig.db)
  rig.close()
})

const op = (): string => `op-${String(++ops).padStart(8, '0')}`
async function call(method: string, params: Record<string, unknown>, by: Caller = window): Promise<FileDone> {
  const req = ClientRequestSchema.parse({ id: '1', method, params: { workspaceId: WS, op: op(), ...params } })
  const out = await files.handle!(req, rig.ctx, by)
  if (!out.handled) throw new Error(`${method} was not handled`)
  return out.result as FileDone
}
const names = (d: FileDone): string[] => d.entries.map((e) => e.name)
const FOLDER = { at: 'place', id: 'folder' } as const
const general = () => at(join(rig.team, 'General'))
const inFolder = (...p: string[]) => join(rig.folder, ...p)
const blank = (form: string): Buffer => readFileSync((blankOf(form as never) as { from: string }).from)
/** The folder pushes sent, by the folder's key. */
const pushedAt = (): string[] => rig.pushes.flatMap(({ p }) => ((p as { at?: string }).at ? [(p as { at: string }).at] : []))

describe('make', () => {
  it("names a new thing for its kind, made free case-blind, in the form the workspace's folder keeps", async () => {
    expect(names(await call('work.files.make', { at: FOLDER, kind: 'document' }))).toEqual(['Untitled document.tcdoc'])
    expect(names(await call('work.files.make', { at: FOLDER, kind: 'document' }))).toEqual(['Untitled document 2.tcdoc'])
    expect(readFileSync(inFolder('Untitled document.tcdoc'))).toEqual(blank('tcdoc'))
    writeFileSync(inFolder('untitled sheet.tcsheet'), 'mine')
    expect(names(await call('work.files.make', { at: FOLDER, kind: 'sheet' }))).toEqual(['Untitled sheet 2.tcsheet'])
    expect(readFileSync(inFolder('untitled sheet.tcsheet'), 'utf8')).toBe('mine')
    expect(names(await call('work.files.make', { at: FOLDER, kind: 'deck' }))).toEqual(['Untitled deck.pptx'])
    const text = await call('work.files.make', { at: FOLDER, kind: 'text' })
    expect(text.entries[0]).toMatchObject({ name: 'Untitled.md', kind: 'text', size: 0, ref: at(inFolder('Untitled.md')) })
    const folder = await call('work.files.make', { at: at(inFolder('Events')), kind: 'folder' })
    expect(folder.entries[0]).toMatchObject({ name: 'Untitled folder', kind: 'folder', folder: at(inFolder('Events', 'Untitled folder')) })
    expect(folder.refused).toEqual([])
  })

  it("takes his name, adds the form's extension when it is missing, and refuses a name that is not allowed", async () => {
    expect(names(await call('work.files.make', { at: FOLDER, kind: 'sheet', name: 'Budget' }))).toEqual(['Budget.tcsheet'])
    expect(names(await call('work.files.make', { at: FOLDER, kind: 'sheet', name: 'Plan.tcsheet' }))).toEqual(['Plan.tcsheet'])
    expect(names(await call('work.files.make', { at: FOLDER, kind: 'folder', name: 'Events' }))).toEqual(['Events 2'])
    await expect(call('work.files.make', { at: FOLDER, kind: 'text', name: 'a/b' })).rejects.toThrow('A name cannot hold /')
    await expect(call('work.files.make', { at: FOLDER, kind: 'text', name: 'con' })).rejects.toThrow('Windows keeps that name for itself.')
  })

  it("makes in the workspace's folder from a lens, and refuses a file as the folder", async () => {
    expect((await call('work.files.make', { at: { at: 'place', id: 'recent' }, kind: 'text' })).entries[0]!.ref).toEqual(at(inFolder('Untitled.md')))
    await expect(call('work.files.make', { at: at(inFolder('notes.txt')), kind: 'text' })).rejects.toThrow('That is a file, not a folder.')
  })

  it('makes in a library the forms the team can open, and offers there only what opens ready to edit', async () => {
    expect(names(await call('work.files.make', { at: general(), kind: 'text' }))).toEqual(['Untitled.txt'])
    const folder = await call('work.files.make', { at: general(), kind: 'folder' })
    expect(folder.entries[0]).toMatchObject({ name: 'Untitled folder', shared: true, key: 'lib:esportsstaffgeneral:Untitled folder' })
    await expect(call('work.files.make', { at: general(), kind: 'sheet' })).rejects.toThrow("A sheet cannot be made in General yet. Make it in Excel, or in your workspace's folder.")
    await expect(call('work.files.make', { at: general(), kind: 'document' })).rejects.toThrow("A document cannot be made in General yet. Make it in Word, or in your workspace's folder.")
    await expect(call('work.files.make', { at: general(), kind: 'deck' })).rejects.toThrow("A deck cannot be made in General yet. Make it in PowerPoint, or in your workspace's folder.")
    // Excel on this host stands behind the grid: a sheet is offered, as Excel's own form.
    setExcelHere(() => true)
    expect(names(await call('work.files.make', { at: general(), kind: 'sheet' }))).toEqual(['Untitled sheet.xlsx'])
    expect(readFileSync(join(rig.team, 'General', 'Untitled sheet.xlsx'))).toEqual(blank('xlsx'))
  })

  it('uses a registered maker in a private folder, and leaves nothing of that folder behind', async () => {
    const seen: string[] = []
    offs.push(
      registerFileMaker('sheet', {
        forms: ['tcsheet', 'xlsx'],
        blank: async (t) => {
          seen.push(`${t.form}:${t.title}`)
          expect(t.path.startsWith(join(rig.dataDir, 'work-files', 'staging'))).toBe(true)
          writeFileSync(t.path, `made ${t.title}`)
        }
      })
    )
    expect(names(await call('work.files.make', { at: FOLDER, kind: 'sheet', name: 'Budget 2027' }))).toEqual(['Budget 2027.tcsheet'])
    expect(readFileSync(inFolder('Budget 2027.tcsheet'), 'utf8')).toBe('made Budget 2027')
    // The maker writes .xlsx, so a library offers a sheet now.
    expect(names(await call('work.files.make', { at: general(), kind: 'sheet' }))).toEqual(['Untitled sheet.xlsx'])
    expect(seen).toEqual(['tcsheet:Budget 2027', 'xlsx:Untitled sheet'])
    expect(readdirSync(join(rig.dataDir, 'work-files', 'staging'))).toEqual([])
  })

  it('starts from a template he may read, of a form the kind takes there', async () => {
    const made = await call('work.files.make', { at: at(inFolder('Events')), kind: 'document', from: at(inFolder('Run of show.tcdoc')) })
    expect(names(made)).toEqual(['Untitled document.tcdoc'])
    expect(readFileSync(inFolder('Events', 'Untitled document.tcdoc'), 'utf8')).toBe('{}')
    // A Word template in his own folder keeps its own form.
    writeFileSync(inFolder('Letter.docx'), 'word')
    expect(names(await call('work.files.make', { at: FOLDER, kind: 'document', name: 'To Dana', from: at(inFolder('Letter.docx')) }))).toEqual(['To Dana.docx'])
    await expect(call('work.files.make', { at: FOLDER, kind: 'document', from: at(inFolder('notes.txt')) })).rejects.toThrow('notes.txt cannot start a document here. Pick a .tcdoc or .docx file.')
    await expect(call('work.files.make', { at: FOLDER, kind: 'document', from: at(inFolder('Events')) })).rejects.toThrow('That is a folder, not a file.')
    await expect(call('work.files.make', { at: FOLDER, kind: 'sheet', from: at(join(rig.team, 'General', 'Spring budget.xlsx')) })).rejects.toThrow('Teams files stay in Teams.')
    await expect(call('work.files.make', { at: FOLDER, kind: 'text', from: at(join(rig.outside, 'secret.txt')) })).rejects.toThrow("That is not in this workspace's folder or a library it may use.")
    // Into a library: only the library's form, and asked first, since the team will see it.
    setExcelHere(() => true)
    writeFileSync(inFolder('Template.xlsx'), 'sheet template')
    await expect(call('work.files.make', { at: general(), kind: 'sheet', from: at(inFolder('Budget.xlsx')) })).rejects.toThrow(ASK_FIRST)
    expect(names(await call('work.files.make', { at: general(), kind: 'sheet', from: at(inFolder('Template.xlsx')), asked: true }))).toEqual(['Untitled sheet.xlsx'])
    writeFileSync(inFolder('Plan.tcsheet'), 'ours')
    await expect(call('work.files.make', { at: general(), kind: 'sheet', from: at(inFolder('Plan.tcsheet')), asked: true })).rejects.toThrow('Plan.tcsheet cannot start a sheet here. Pick a .xlsx file.')
  })

  it('does a retry of one operation id once, and says the folder changed to whoever could name it', async () => {
    const id = 'op-retry-make'
    const first = await call('work.files.make', { at: FOLDER, kind: 'document', op: id })
    const again = await call('work.files.make', { at: FOLDER, kind: 'document', op: id })
    expect(again).toEqual(first)
    expect(readdirSync(rig.folder).filter((n) => n.startsWith('Untitled'))).toEqual(['Untitled document.tcdoc'])
    const push = rig.pushes.find(({ p }) => (p as { at?: string }).at === refKey(at(rig.folder)))
    expect(push).toEqual({ p: { push: 'work.files', workspaceId: WS, at: refKey(at(rig.folder)) }, to: { need: 'read', path: rig.folder } })
  })

  it('takes each caller as the door says: a key, a key with approve where others can open the place, a peer with its origin, never a thread', async () => {
    rig.roots.push(rig.team)
    expect(names(await call('work.files.make', { at: FOLDER, kind: 'text' }, phone))).toEqual(['Untitled.md'])
    await expect(call('work.files.make', { at: general(), kind: 'text' }, phone)).rejects.toThrow(NEEDS_APPROVE)
    expect(names(await call('work.files.make', { at: general(), kind: 'text' }, approver))).toEqual(['Untitled.txt'])
    await expect(call('work.files.make', { at: general(), kind: 'folder' }, peer)).rejects.toThrow(PEER_NO_ORIGIN)
    expect(names(await call('work.files.make', { at: general(), kind: 'folder', origin: { from: 'window' } }, peer))).toEqual(['Untitled folder'])
    await expect(call('work.files.make', { at: FOLDER, kind: 'text' }, thread('t1'))).rejects.toThrow(THREADS_BY_TOOLS)
  })
})

describe('rename', () => {
  it('renames in the same folder, never over anything, and says the folder changed', async () => {
    const done = await call('work.files.rename', { ref: at(inFolder('notes.txt')), name: 'kickoff.txt' })
    expect(done.entries[0]).toMatchObject({ name: 'kickoff.txt', ref: at(inFolder('kickoff.txt')), kind: 'text' })
    expect(existsSync(inFolder('notes.txt'))).toBe(false)
    expect(pushedAt()).toContain(refKey(at(rig.folder)))
    await expect(call('work.files.rename', { ref: at(inFolder('kickoff.txt')), name: 'Budget.xlsx' })).rejects.toThrow('A file named "Budget.xlsx" is already there.')
    await expect(call('work.files.rename', { ref: at(inFolder('kickoff.txt')), name: 'Events' })).rejects.toThrow('A folder named "Events" is already there.')
    expect(readFileSync(inFolder('Budget.xlsx'), 'utf8')).toBe('x'.repeat(1200))
    await expect(call('work.files.rename', { ref: at(inFolder('kickoff.txt')), name: 'a:b.txt' })).rejects.toThrow('A name cannot hold :')
  })

  it('renames by case alone, a folder, and a file in a library', async () => {
    expect(names(await call('work.files.rename', { ref: at(inFolder('notes.txt')), name: 'Notes.txt' }))).toEqual(['Notes.txt'])
    const folder = await call('work.files.rename', { ref: at(inFolder('Events')), name: 'Shows' })
    expect(folder.entries[0]).toMatchObject({ name: 'Shows', kind: 'folder' })
    expect(existsSync(inFolder('Shows', 'Spring LAN', 'Bracket.pdf'))).toBe(true)
    const plan = await call('work.files.rename', { ref: at(join(rig.team, 'General', 'Plan.docx')), name: 'Plan 2026.docx' })
    expect(plan.entries[0]).toMatchObject({ name: 'Plan 2026.docx', shared: true, key: 'lib:esportsstaffgeneral:Plan 2026.docx' })
  })

  it('refuses a place itself, and a file a thread is writing in', async () => {
    await expect(call('work.files.rename', { ref: FOLDER, name: 'Elsewhere' })).rejects.toThrow('A place itself cannot be renamed or moved.')
    await expect(call('work.files.rename', { ref: general(), name: 'Elsewhere' })).rejects.toThrow('A place itself cannot be renamed or moved.')
    let release!: () => void
    const held = withFileLocks([refKey(at(inFolder('notes.txt')))], () => new Promise<void>((r) => (release = r)))
    await expect(call('work.files.rename', { ref: at(inFolder('notes.txt')), name: 'a.txt' })).rejects.toThrow('A thread is writing in this file. Try when it is done.')
    release()
    await held
    expect(names(await call('work.files.rename', { ref: at(inFolder('notes.txt')), name: 'a.txt' }))).toEqual(['a.txt'])
  })

  it('does a retry once, and holds a key to its row of the door', async () => {
    const id = 'op-retry-rename'
    const first = await call('work.files.rename', { ref: at(inFolder('notes.txt')), name: 'a.txt', op: id })
    expect(await call('work.files.rename', { ref: at(inFolder('notes.txt')), name: 'a.txt', op: id })).toEqual(first)
    await expect(call('work.files.rename', { ref: at(inFolder('Budget.xlsx')), name: 'b.xlsx', op: id })).rejects.toThrow('That operation id was used for another change.')
    expect(names(await call('work.files.rename', { ref: at(inFolder('a.txt')), name: 'b.txt' }, phone))).toEqual(['b.txt'])
    rig.roots.push(rig.team)
    await expect(call('work.files.rename', { ref: at(join(rig.team, 'General', 'Plan.docx')), name: 'P.docx' }, phone)).rejects.toThrow(NEEDS_APPROVE)
    expect(names(await call('work.files.rename', { ref: at(join(rig.team, 'General', 'Plan.docx')), name: 'P.docx' }, approver))).toEqual(['P.docx'])
    await expect(call('work.files.rename', { ref: at(inFolder('b.txt')), name: 'c.txt' }, thread('t1'))).rejects.toThrow(THREADS_BY_TOOLS)
  })
})

describe('move', () => {
  it('moves inside a place file by file: a taken name is its own refused row, the rest move, nothing is replaced', async () => {
    writeFileSync(inFolder('Events', 'notes.txt'), 'the other notes')
    const done = await call('work.files.move', { refs: [at(inFolder('notes.txt')), at(inFolder('Budget.xlsx')), at(inFolder('Run of show.tcdoc'))], to: at(inFolder('Events')) })
    expect(names(done)).toEqual(['Budget.xlsx', 'Run of show.tcdoc'])
    expect(done.refused).toEqual([{ name: 'notes.txt', text: 'A file named "notes.txt" is already there.' }])
    expect(readFileSync(inFolder('Events', 'notes.txt'), 'utf8')).toBe('the other notes')
    expect(readFileSync(inFolder('notes.txt'), 'utf8')).toBe('kickoff at 5')
    expect(existsSync(inFolder('Budget.xlsx'))).toBe(false)
    expect(done.entries[0]!.ref).toEqual(at(inFolder('Events', 'Budget.xlsx')))
    expect(pushedAt()).toEqual(expect.arrayContaining([refKey(at(rig.folder)), refKey(at(inFolder('Events')))]))
  })

  it('refuses a folder into itself, and a place itself', async () => {
    const done = await call('work.files.move', { refs: [at(inFolder('Events'))], to: at(inFolder('Events', 'Spring LAN')) })
    expect(done.refused).toEqual([{ name: 'Events', text: 'A folder cannot go inside itself.' }])
    expect((await call('work.files.move', { refs: [FOLDER], to: at(inFolder('Events')) })).refused).toEqual([{ name: 'Dummy Esports', text: 'A place itself cannot be renamed or moved.' }])
  })

  it('never moves out of a shared place, and into one only after its question', async () => {
    await expect(call('work.files.move', { refs: [at(join(rig.team, 'General', 'Plan.docx'))], to: FOLDER })).rejects.toThrow('Teams files stay in Teams.')
    await expect(call('work.files.move', { refs: [at(inFolder('notes.txt'))], to: general() })).rejects.toThrow(ASK_FIRST)
    // With his yes it is a copy there, checked, and the source in Trash, where Put back finds it.
    const done = await call('work.files.move', { refs: [at(inFolder('notes.txt'))], to: general(), asked: true })
    expect(done.refused).toEqual([])
    expect(done.entries[0]).toMatchObject({ name: 'notes.txt', shared: true })
    expect(existsSync(inFolder('notes.txt'))).toBe(false)
    expect((rig.db.prepare(`SELECT name, state FROM work_files_trash WHERE workspace_id = ?`).all(WS) as { name: string; state: string }[])).toEqual([{ name: 'notes.txt', state: 'held' }])
  })

  it('moves into a library as a copy, checked, then the source to Trash; a Trash that fails takes the copy away', async () => {
    await expect(call('work.files.move', { refs: [at(inFolder('notes.txt'))], to: general() })).rejects.toThrow(ASK_FIRST)
    expect(existsSync(join(rig.team, 'General', 'notes.txt'))).toBe(false)
    const trashed: string[] = []
    setTrashHook(async (_ctx, workspace, path, id) => {
      expect(readFileSync(join(rig.team, 'General', 'notes.txt'), 'utf8')).toBe('kickoff at 5')
      trashed.push(`${workspace.id}:${path}:${id}`)
      rmSync(path)
    })
    const done = await call('work.files.move', { refs: [at(inFolder('notes.txt'))], to: general(), asked: true, op: 'op-across-1' })
    expect(done.entries[0]).toMatchObject({ name: 'notes.txt', shared: true, ref: at(join(rig.team, 'General', 'notes.txt')) })
    expect(trashed).toEqual([`${WS}:${inFolder('notes.txt')}:op-across-1`])
    setTrashHook(async () => {
      throw new Error('Trash is full.')
    })
    const failed = await call('work.files.move', { refs: [at(inFolder('Budget.xlsx'))], to: general(), asked: true })
    expect(failed).toMatchObject({ entries: [], refused: [{ name: 'Budget.xlsx', text: 'Trash is full.' }] })
    expect(existsSync(join(rig.team, 'General', 'Budget.xlsx'))).toBe(false)
    expect(existsSync(inFolder('Budget.xlsx'))).toBe(true)
  })

  it('holds a key and a peer to their rows of the door', async () => {
    expect(names(await call('work.files.move', { refs: [at(inFolder('notes.txt'))], to: at(inFolder('Events')) }, phone))).toEqual(['notes.txt'])
    await expect(call('work.files.move', { refs: [at(inFolder('Budget.xlsx'))], to: at(inFolder('Events')) }, peer)).rejects.toThrow()
    await expect(call('work.files.move', { refs: [at(join(rig.team, 'General', 'Plan.docx'))], to: at(join(rig.team, 'General', 'Budgets')) }, peer)).rejects.toThrow(PEER_NO_ORIGIN)
    expect(names(await call('work.files.move', { refs: [at(join(rig.team, 'General', 'Plan.docx'))], to: at(join(rig.team, 'General', 'Budgets')), origin: { from: 'window' } }, peer))).toEqual(['Plan.docx'])
    await expect(call('work.files.move', { refs: [at(inFolder('Budget.xlsx'))], to: at(inFolder('Events')) }, thread('t1'))).rejects.toThrow(THREADS_BY_TOOLS)
    await expect(call('work.files.move', { refs: [at(join(rig.outside, 'secret.txt'))], to: at(inFolder('Events')) }, phone)).rejects.toThrow()
  })
})

describe('copy', () => {
  it('copies beside itself under the next free name, and a folder whole', async () => {
    expect(names(await call('work.files.copy', { refs: [at(inFolder('notes.txt'))], to: FOLDER }))).toEqual(['notes 2.txt'])
    expect(names(await call('work.files.copy', { refs: [at(inFolder('notes.txt'))], to: FOLDER }))).toEqual(['notes 3.txt'])
    expect(readFileSync(inFolder('notes 3.txt'), 'utf8')).toBe('kickoff at 5')
    const events = await call('work.files.copy', { refs: [at(inFolder('Events'))], to: FOLDER })
    expect(events.entries[0]).toMatchObject({ name: 'Events 2', kind: 'folder' })
    expect(readFileSync(inFolder('Events 2', 'Spring LAN', 'Bracket.pdf'), 'utf8')).toBe('pdf')
    expect(readFileSync(inFolder('notes.txt'), 'utf8')).toBe('kickoff at 5')
  })

  it('copies into a library only once asked, and never out of one', async () => {
    await expect(call('work.files.copy', { refs: [at(inFolder('notes.txt'))], to: general() })).rejects.toThrow(ASK_FIRST)
    const done = await call('work.files.copy', { refs: [at(inFolder('notes.txt')), at(inFolder('Budget.xlsx'))], to: general(), asked: true })
    expect(done.entries.map((e) => [e.name, e.shared])).toEqual([
      ['notes.txt', true],
      ['Budget.xlsx', true]
    ])
    expect(existsSync(inFolder('notes.txt'))).toBe(true)
    await expect(call('work.files.copy', { refs: [at(join(rig.team, 'General', 'Plan.docx'))], to: FOLDER })).rejects.toThrow('Teams files stay in Teams.')
    rig.roots.push(rig.team)
    await expect(call('work.files.copy', { refs: [at(inFolder('notes.txt'))], to: general(), asked: true }, phone)).rejects.toThrow(NEEDS_APPROVE)
    await expect(call('work.files.copy', { refs: [at(inFolder('notes.txt'))], to: general() }, approver)).rejects.toThrow(ASK_FIRST)
    expect(names(await call('work.files.copy', { refs: [at(inFolder('notes.txt'))], to: general(), asked: true }, approver))).toEqual(['notes 2.txt'])
  })

  it('reports what it could not copy, file by file', async () => {
    const done = await call('work.files.copy', { refs: [at(inFolder('notes.txt')), FOLDER], to: at(inFolder('Events')) })
    expect(names(done)).toEqual(['notes.txt'])
    expect(done.refused).toEqual([{ name: 'Dummy Esports', text: 'A place itself cannot be copied.' }])
    // A link out is no file of the workspace: the whole change is refused before anything is written.
    await expect(call('work.files.copy', { refs: [at(inFolder('Budget.xlsx')), at(inFolder('way out'))], to: at(inFolder('Events')) })).rejects.toThrow("That is not in this workspace's folder or a library it may use.")
    expect(existsSync(inFolder('Events', 'Budget.xlsx'))).toBe(false)
  })
})
