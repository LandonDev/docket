import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClientRequest } from '@shared/contract'
import type { CanvasItem } from '@shared/work'
import { handled } from '@shared/work'
import type { WorkModule } from '../modules'
import { OUT_OF_REACH } from './place'
import { ELSEWHERE, fieldsOfSource, moveTemplate, NOT_A_TEMPLATE, removeTemplate, renameTemplate, saveTemplate, STARTER_FIXED, unhideTemplates } from './save'
import { listTemplates, sharedDir } from './shelf'
import { docx, HOST, makeRig, OTHER, phone, window, WS, xlsx, type Rig } from './testkit'
import { makeZip } from './zip'

let rig: Rig
beforeEach(() => void (rig = makeRig()))
afterEach(() => rig.close())

const none = () => []
const file = (path: string) => ({ at: 'file' as const, host: HOST, path })
const shelfFiles = (): string[] => (existsSync(join(rig.folder, 'Templates')) ? readdirSync(join(rig.folder, 'Templates')).sort() : [])
const pushed = (): (string | null)[] => rig.pushes.map((x) => (x.p as { workspaceId: string | null }).workspaceId)

describe('save', () => {
  it('copies an Office file onto the job\'s shelf as it is, and leaves the file where it was', async () => {
    const source = rig.put(join(rig.folder, 'Reports', 'Week 3.docx'), docx('Game: {{Home}} v {{Away}}'))
    const before = readFileSync(source)
    const saved = await saveTemplate(rig.ctx, window, { workspaceId: WS, source: file(source) }, { pillars: none })
    expect(saved).toEqual({ id: 'job:Week 3.docx', name: 'Week 3', kind: 'document', form: 'docx', where: 'job', fields: ['Home', 'Away'], source: file(join(rig.folder, 'Templates', 'Week 3.docx')) })
    expect(readFileSync(join(rig.folder, 'Templates', 'Week 3.docx')).equals(before)).toBe(true)
    expect(readFileSync(source).equals(before)).toBe(true)
    expect(pushed()).toEqual([WS])
  })

  it('takes the name he typed, and the next free name when one is taken', async () => {
    const source = rig.put(join(rig.folder, 'a.xlsx'), xlsx('x'))
    expect((await saveTemplate(rig.ctx, window, { workspaceId: WS, source: file(source), name: 'Mileage: 2026' }, { pillars: none })).name).toBe('Mileage 2026')
    expect((await saveTemplate(rig.ctx, window, { workspaceId: WS, source: file(source), name: 'Mileage 2026' }, { pillars: none })).id).toBe('job:Mileage 2026 2.xlsx')
    expect(shelfFiles()).toEqual(['Mileage 2026 2.xlsx', 'Mileage 2026.xlsx'])
  })

  it('keeps one for all jobs in the host\'s own data, and tells every workspace', async () => {
    const source = rig.put(join(rig.folder, 'Letter.docx'), docx('Dear {{To}}'))
    const saved = await saveTemplate(rig.ctx, window, { workspaceId: WS, source: file(source), everywhere: true }, { pillars: none })
    expect(saved).toMatchObject({ id: 'all:Letter.docx', where: 'all', source: file(join(sharedDir(rig.ctx), 'Letter.docx')) })
    expect(listTemplates(rig.ctx, OTHER).templates.map((t) => t.id)).toContain('all:Letter.docx')
    expect(pushed()).toEqual([null])
  })

  it('copies a file others can open onto the shelf and never writes beside or over it', async () => {
    // A file opened in Word from a library: named by its path, as the Office item names it.
    const library = join(rig.outside, 'OneDrive-Dummy U', 'Shared')
    const source = rig.put(join(library, 'Run of show.docx'), docx('{{Event}}'))
    const saved = await saveTemplate(rig.ctx, window, { workspaceId: WS, source: { at: 'microsoft', host: HOST, app: 'word', name: 'Run of show.docx', ref: { kind: 'path', path: source } } }, { pillars: none })
    expect(saved).toMatchObject({ id: 'job:Run of show.docx', fields: ['Event'] })
    expect(readdirSync(library)).toEqual(['Run of show.docx'])
  })

  it('copies our own document with no field as it is', async () => {
    const source = rig.put(join(rig.folder, 'Notes.tcdoc'), makeZip({ 'preview.md': '# Notes\n', 'state.yjs': new Uint8Array([1]) }))
    const asked: string[] = []
    const formats: WorkModule = { id: 'formats', ensure() {}, handle: async (req) => (asked.push(req.method), handled({ name: 'x', data: '', warnings: [] })) }
    const saved = await saveTemplate(rig.ctx, window, { workspaceId: WS, source: file(source) }, { pillars: () => [formats] })
    expect(saved).toMatchObject({ id: 'job:Notes.tcdoc', form: 'tcdoc', fields: [] })
    expect(asked).toEqual([])
  })

  it('keeps our own document with fields as Word, through the formats pillar\'s export', async () => {
    const source = rig.put(join(rig.folder, 'Brief.tcdoc'), makeZip({ 'preview.md': '# Brief for {{Client}}\n' }))
    const seen: ClientRequest[] = []
    const formats: WorkModule = {
      id: 'formats',
      ensure() {},
      handle: async (req) => {
        seen.push(req)
        return handled({ name: 'Brief.docx', data: Buffer.from(docx('Brief for {{Client}}')).toString('base64'), warnings: [] })
      }
    }
    const saved = await saveTemplate(rig.ctx, window, { workspaceId: WS, source: file(source) }, { pillars: () => [formats] })
    expect(saved).toMatchObject({ id: 'job:Brief.docx', form: 'docx', fields: ['Client'] })
    expect(seen.map((r) => [r.method, (r as { params: unknown }).params])).toEqual([['work.formats.export', { source: file(source), format: 'docx' }]])
    // The export's scratch file is gone, and the document is where it was.
    expect(readdirSync(join(rig.dataDir, 'work-templates', 'scratch'))).toEqual([])
    expect(existsSync(source)).toBe(true)
  })

  it('keeps our own document as Word when its only field is one filled without asking, so a make fills it', async () => {
    const source = rig.put(join(rig.folder, 'Dated.tcdoc'), makeZip({ 'preview.md': 'Written {{Date}}\n' }))
    const formats: WorkModule = { id: 'formats', ensure() {}, handle: async () => handled({ name: 'Dated.docx', data: Buffer.from(docx('Written {{Date}}')).toString('base64'), warnings: [] }) }
    const saved = await saveTemplate(rig.ctx, window, { workspaceId: WS, source: file(source) }, { pillars: () => [formats] })
    expect(saved).toMatchObject({ id: 'job:Dated.docx', form: 'docx', fields: [] })
  })

  it("keeps our own sheet as Excel through the sheets pillar's export when the sheet is open, and leaves the export where that pillar wrote it, with any export that was there", async () => {
    const source = rig.put(join(rig.folder, 'Log.tcsheet'), 'sheet state')
    rig.items.push({ id: 'item_9', sessionId: 't1', kind: 'sheet', title: 'Log', source: file(source) } as unknown as CanvasItem)
    const seen: ClientRequest[] = []
    const sheets: WorkModule = {
      id: 'sheets',
      ensure() {},
      handle: async (req) => {
        seen.push(req)
        // As the sheets pillar does: one fixed name among the item's own files, over any earlier export.
        return handled({ path: rig.put(join(rig.dataDir, 'canvas', 't1', 'item_9', 'Log.xlsx'), xlsx('{{Season}} log')) })
      }
    }
    expect(fieldsOfSource(rig.ctx, window, WS, file(source))).toEqual({ fields: [], later: true })
    const saved = await saveTemplate(rig.ctx, window, { workspaceId: WS, source: file(source) }, { pillars: () => [sheets] })
    expect(saved).toMatchObject({ id: 'job:Log.xlsx', form: 'xlsx', fields: ['Season'] })
    expect((seen[0] as { params: unknown }).params).toEqual({ itemId: 'item_9', format: 'xlsx' })
    // His folder gained nothing, and the export he may have made before is still among the item's files.
    expect(readdirSync(rig.folder).sort()).toEqual(['Log.tcsheet', 'Templates'])
    expect(existsSync(join(rig.dataDir, 'canvas', 't1', 'item_9', 'Log.xlsx'))).toBe(true)
  })

  it('keeps our own sheet as it is when no item shows it or its export does not answer', async () => {
    const source = rig.put(join(rig.folder, 'Log.tcsheet'), 'sheet state')
    expect(await saveTemplate(rig.ctx, window, { workspaceId: WS, source: file(source) }, { pillars: none })).toMatchObject({ id: 'job:Log.tcsheet', form: 'tcsheet' })
    rig.items.push({ id: 'item_9', sessionId: 't1', kind: 'sheet', title: 'Log', source: file(source) } as unknown as CanvasItem)
    const sheets: WorkModule = { id: 'sheets', ensure() {}, handle: async () => Promise.reject(new Error('the engine is busy')) }
    expect(await saveTemplate(rig.ctx, window, { workspaceId: WS, source: file(source), name: 'Log again' }, { pillars: () => [sheets] })).toMatchObject({ id: 'job:Log again.tcsheet' })
  })

  it('refuses what is no template, in words', async () => {
    const pdf = rig.put(join(rig.folder, 'scan.pdf'), 'pdf')
    await expect(saveTemplate(rig.ctx, window, { workspaceId: WS, source: file(pdf) }, { pillars: none })).rejects.toThrow(NOT_A_TEMPLATE)
    await expect(saveTemplate(rig.ctx, window, { workspaceId: WS, source: file(join(rig.folder, 'missing.docx')) }, { pillars: none })).rejects.toThrow(NOT_A_TEMPLATE)
    await expect(saveTemplate(rig.ctx, window, { workspaceId: WS, source: file(rig.folder) }, { pillars: none })).rejects.toThrow(NOT_A_TEMPLATE)
    await expect(saveTemplate(rig.ctx, window, { workspaceId: WS, source: { at: 'lifeos', table: 'docs', id: 'd1' } }, { pillars: none })).rejects.toThrow(NOT_A_TEMPLATE)
    await expect(saveTemplate(rig.ctx, window, { workspaceId: WS, source: { at: 'file', host: 'env_mac', path: '/Users/x/a.docx' } }, { pillars: none })).rejects.toThrow(ELSEWHERE)
    expect(shelfFiles()).toEqual([])
  })

  it('refuses a key that may not reach the file', async () => {
    const source = rig.put(join(rig.outside, 'Private.docx'), docx('x'))
    await expect(saveTemplate(rig.ctx, phone, { workspaceId: WS, source: file(source) }, { pillars: none })).rejects.toThrow(OUT_OF_REACH)
    expect(shelfFiles()).toEqual([])
  })
})

describe('the fields of a file, read before it is saved', () => {
  it('are the asked fields of an Office file and of our own document, and none for any other', () => {
    const word = rig.put(join(rig.folder, 'a.docx'), docx('{{Home}} v {{Away}} on {{Date}}'))
    const ours = rig.put(join(rig.folder, 'b.tcdoc'), makeZip({ 'preview.md': '{{Client}} {{Job}}' }))
    const sheet = rig.put(join(rig.folder, 'c.tcsheet'), 'state')
    const broken = rig.put(join(rig.folder, 'd.xlsx'), 'not a zip')
    expect(fieldsOfSource(rig.ctx, window, WS, file(word))).toEqual({ fields: ['Home', 'Away'] })
    expect(fieldsOfSource(rig.ctx, window, WS, file(ours))).toEqual({ fields: ['Client'] })
    // A sheet no item shows is kept as it is: it asks for nothing, now or later.
    expect(fieldsOfSource(rig.ctx, window, WS, file(sheet))).toEqual({ fields: [] })
    expect(fieldsOfSource(rig.ctx, window, WS, file(broken))).toEqual({ fields: [] })
    expect(shelfFiles()).toEqual([])
  })

  it('are refused for what is no template and for a key that may not reach the file', () => {
    expect(() => fieldsOfSource(rig.ctx, window, WS, file(rig.put(join(rig.folder, 'scan.pdf'), 'pdf')))).toThrow(NOT_A_TEMPLATE)
    expect(() => fieldsOfSource(rig.ctx, phone, WS, file(rig.put(join(rig.outside, 'x.docx'), docx('{{A}}'))))).toThrow(OUT_OF_REACH)
  })
})

describe('rename', () => {
  it('gives one of his own a new name and keeps its form', async () => {
    rig.put(join(rig.folder, 'Templates', 'Letter.docx'), docx('{{To}}'))
    const t = await renameTemplate(rig.ctx, window, WS, 'job:Letter.docx', 'Assignor letter')
    expect(t).toMatchObject({ id: 'job:Assignor letter.docx', name: 'Assignor letter', fields: ['To'] })
    expect(shelfFiles()).toEqual(['Assignor letter.docx'])
  })

  it('never takes a name another template has, whatever its case, and takes a change of case alone', async () => {
    rig.put(join(rig.folder, 'Templates', 'Letter.docx'), docx('a'))
    rig.put(join(rig.folder, 'Templates', 'Memo.docx'), docx('b'))
    await expect(renameTemplate(rig.ctx, window, WS, 'Letter', 'MEMO')).rejects.toThrow('A template named MEMO is already there.')
    expect((await renameTemplate(rig.ctx, window, WS, 'Letter', 'LETTER')).name).toBe('LETTER')
    expect(shelfFiles()).toEqual(['LETTER.docx', 'Memo.docx'])
  })

  it('refuses a starter and a name of nothing', async () => {
    await expect(renameTemplate(rig.ctx, window, WS, 'Game report', 'Mine')).rejects.toThrow(STARTER_FIXED)
    rig.put(join(rig.folder, 'Templates', 'Letter.docx'), docx('a'))
    await expect(renameTemplate(rig.ctx, window, WS, 'Letter', ' /. ')).rejects.toThrow('A template needs a name.')
  })
})

describe('move', () => {
  it("moves one of his own to all jobs and back, under a free name", async () => {
    rig.put(join(rig.folder, 'Templates', 'Letter.docx'), docx('{{To}}'))
    rig.put(join(sharedDir(rig.ctx), 'Letter.docx'), docx('another'))
    const everywhere = await moveTemplate(rig.ctx, window, WS, 'job:Letter.docx', true)
    expect(everywhere).toMatchObject({ id: 'all:Letter 2.docx', where: 'all', fields: ['To'] })
    expect(shelfFiles()).toEqual([])
    const back = await moveTemplate(rig.ctx, window, WS, 'all:Letter 2.docx', false)
    expect(back).toMatchObject({ id: 'job:Letter 2.docx', where: 'job' })
    expect(readdirSync(sharedDir(rig.ctx))).toEqual(['Letter.docx'])
    expect(pushed()).toEqual([null, null])
  })

  it('does nothing to one already there, and refuses a starter', async () => {
    rig.put(join(rig.folder, 'Templates', 'Letter.docx'), docx('a'))
    expect((await moveTemplate(rig.ctx, window, WS, 'Letter', false)).id).toBe('job:Letter.docx')
    expect(rig.pushes).toEqual([])
    await expect(moveTemplate(rig.ctx, window, WS, 'Meeting notes', false)).rejects.toThrow(STARTER_FIXED)
  })
})

describe('remove', () => {
  it('hides a starter in this workspace alone, and unhide shows every one again', async () => {
    expect(await removeTemplate(rig.ctx, window, WS, 'starter:any/meeting-notes', false, { pillars: none })).toEqual({})
    expect(listTemplates(rig.ctx, WS)).toMatchObject({ hidden: 1 })
    expect(listTemplates(rig.ctx, WS).templates.map((t) => t.id)).not.toContain('starter:any/meeting-notes')
    expect(listTemplates(rig.ctx, OTHER).templates.map((t) => t.id)).toContain('starter:any/meeting-notes')
    expect(existsSync(join(rig.starters, 'any', 'Meeting notes.docx'))).toBe(true)
    unhideTemplates(rig.ctx, window, WS)
    expect(listTemplates(rig.ctx, WS)).toMatchObject({ hidden: 0 })
    expect(pushed()).toEqual([WS, WS])
  })

  it('deletes nothing of his own until the window says he was asked, where Files has no Trash yet', async () => {
    rig.put(join(rig.folder, 'Templates', 'Letter.docx'), docx('a'))
    // Files as master's is today: the folder can do nothing.
    const notYet: WorkModule = { id: 'files', ensure() {}, handle: async (req) => (req.method === 'work.files.places' ? handled({ places: [{ id: 'folder', can: [] }] }) : Promise.reject(new Error('Nothing can be deleted in Dummy Officials from here.'))) }
    expect(await removeTemplate(rig.ctx, window, WS, 'job:Letter.docx', false, { pillars: () => [notYet] })).toEqual({ confirm: true })
    expect(shelfFiles()).toEqual(['Letter.docx'])
    expect(rig.pushes).toEqual([])
    expect(await removeTemplate(rig.ctx, window, WS, 'job:Letter.docx', true, { pillars: () => [notYet] })).toEqual({})
    expect(shelfFiles()).toEqual([])
    expect(pushed()).toEqual([WS])
  })

  it("sends one of the job's own to Files' Trash where Files has one, and answers the rows Put back takes", async () => {
    const path = rig.put(join(rig.folder, 'Templates', 'Letter.docx'), docx('a'))
    const seen: ClientRequest[] = []
    const files: WorkModule = { id: 'files', ensure() {}, handle: async (req) => (req.method === 'work.files.places' ? handled({ places: [{ id: 'folder', can: ['trash'] }] }) : (seen.push(req), handled({ entries: [], refused: [], trashed: ['trash_1'], op: 'op' }))) }
    expect(await removeTemplate(rig.ctx, window, WS, 'Letter', false, { pillars: () => [files] })).toEqual({ trashed: ['trash_1'] })
    expect(seen[0]!.method).toBe('work.files.trash')
    expect((seen[0] as { params: Record<string, unknown> }).params).toMatchObject({ workspaceId: WS, refs: [file(path)] })
    // Files moved it (the stand-in did not): this pillar deleted nothing.
    expect(shelfFiles()).toEqual(['Letter.docx'])
  })

  it("says Files' own refusal, and deletes nothing", async () => {
    rig.put(join(rig.folder, 'Templates', 'Letter.docx'), docx('a'))
    const files: WorkModule = { id: 'files', ensure() {}, handle: async (req) => (req.method === 'work.files.places' ? handled({ places: [{ id: 'folder', can: ['trash'] }] }) : handled({ entries: [], refused: [{ name: 'Letter.docx', text: 'That file is open in Word.' }], op: 'op' })) }
    await expect(removeTemplate(rig.ctx, window, WS, 'Letter', true, { pillars: () => [files] })).rejects.toThrow('That file is open in Word.')
    expect(shelfFiles()).toEqual(['Letter.docx'])
  })

  it('deletes one for all jobs only once confirmed: it lies in the app\'s own data, which has no Trash', async () => {
    rig.put(join(sharedDir(rig.ctx), 'Letter.docx'), docx('a'))
    const files: WorkModule = { id: 'files', ensure() {}, handle: async () => Promise.reject(new Error('never asked')) }
    expect(await removeTemplate(rig.ctx, window, WS, 'all:Letter.docx', false, { pillars: () => [files] })).toEqual({ confirm: true })
    expect(await removeTemplate(rig.ctx, window, WS, 'all:Letter.docx', true, { pillars: () => [files] })).toEqual({})
    expect(readdirSync(sharedDir(rig.ctx))).toEqual([])
    expect(pushed()).toEqual([null])
  })

  it('refuses a key that may not reach the workspace', async () => {
    rig.put(join(rig.folder, 'Templates', 'Letter.docx'), docx('a'))
    rig.roots = []
    await expect(removeTemplate(rig.ctx, phone, WS, 'Letter', true, { pillars: none })).rejects.toThrow(OUT_OF_REACH)
    await expect(renameTemplate(rig.ctx, phone, WS, 'Letter', 'X')).rejects.toThrow(OUT_OF_REACH)
    expect(() => unhideTemplates(rig.ctx, phone, WS)).toThrow(OUT_OF_REACH)
    expect(shelfFiles()).toEqual(['Letter.docx'])
  })
})
