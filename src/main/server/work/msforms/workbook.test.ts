import { copyFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClientRequestSchema, type ClientRequest } from '@shared/contract'
import type { FilesOpened } from '@shared/contract-work-files'
import type { SheetView } from '@shared/contract-work-sheets'
import { canvasSourcePath, filesPaneOf } from '@shared/work'
import type { ToolCtx } from '../modules'
import { setCopyAllowed } from '../office/files/library'
import { setVmCall } from '../office/vm/link'
import { setVmState } from '../office/vm/office'
import { copiesInFlight, copyRecord, copySaved } from '../files/copies'
import { closeFilesState, filesHandle } from '../files/handle'
import { librariesHere, vmLibrariesHere } from '../files/places/libraries'
import { forgetVmLists } from '../files/places/teams'
import { readOnlyOf } from '../files/readOnly'
import { onFileSaved, saveFile, versionWord } from '../files/save'
import { versionOf } from '../files/write'
import { at, HOST, makeRig, window, WS, type Rig } from '../files/testkit'
import { forgetUploads } from '../files/uploads'
import { setJobs } from '../sheets/held'
import { sheets } from '../sheets/index'
import { sheetTools } from '../sheets/tools'
import { localJobs } from '../sheets/workerClient'
import { ensureMsformsTables, MsformsStore } from './store'
import { FORM_A } from './testing'
import { ensureWorkbookIndex, FORMS_WORKBOOK_READ_ONLY, FORMS_WORKBOOK_READ_REFUSED, FORMS_WORKBOOK_REFUSED, isFormsWorkbook, NO_WORKBOOK, workbookFile } from './workbook'
import { modeOf } from '../office/live/memory'
import { refKey } from '@shared/work/files'

/**
 * A Microsoft form's answers workbook is Forms' to write (docs/agents/work-msforms.md "Open the workbook"): opened Edit
 * here it reads only, with the reason, and takes no edit; a copy of one in the Windows VM sends nothing back; a sheet
 * tool's change is refused. Another workbook in the same folder is as it was. On the Files rig, with a library on this
 * host's disk and one in the VM (its helper stood in, as copiesVm.test.ts does).
 */

const CORPUS = join(import.meta.dirname, '../sheets/harness/corpus')
const TOP = 'C:\\Users\\tcuser\\Dummy U\\Esports Staff - Documents'
const VM_BOOK = `${TOP}\\Forms\\Sign-ups.xlsx`
const VM_OTHER = `${TOP}\\Forms\\Roster.xlsx`

describe.skipIf(process.platform === 'win32')("a Microsoft form's answers workbook", () => {
  let rig: Rig
  let forms: MsformsStore
  let disk: Map<string, { path: string; data: string; modified: number }>
  let writes: unknown[]
  let offSaved: () => void

  const req = (method: string, params: unknown): ClientRequest => ClientRequestSchema.parse({ id: '1', method, params } as ClientRequest)
  const sheet = async <T,>(method: string, params: unknown): Promise<T> => {
    const out = await sheets.handle!(req(method, params), rig.ctx, window)
    if (!out.handled) throw new Error(`${method} was not handled`)
    return out.result as T
  }
  const files = async <T,>(method: string, params: Record<string, unknown>): Promise<T> => {
    const out = await filesHandle({ id: '1', method, params: { workspaceId: WS, ...params } } as never, rig.ctx, window)
    return (out as { result: T }).result
  }
  const diskLibrary = () => librariesHere(rig.ctx).find((l) => rig.team.startsWith(l.path))!
  const vmLibrary = () => vmLibrariesHere(rig.ctx).find((l) => l.path === TOP)!
  const insideOf = (root: string, path: string): string => path.slice(root.length).split(/[\\/]+/).filter(Boolean).join('/')
  /** A form of the job whose workbook is `path` in `library`, or none when `path` is null. */
  const form = (formId: string, library: { id: string; path: string }, path: string | null): void => {
    forms.create({ workspaceId: WS, formId, tenant: 'dummyu', sector: 'purdue', title: 'TempCode proof sign-ups', folder: { libraryId: library.id, path: 'Forms', siteUrl: 'https://dummyu.sharepoint.com/sites/Esports' }, madeBy: 'owner' })
    if (path) forms.update(WS, formId, { workbook: { libraryId: library.id, path: insideOf(library.path, path), siteUrl: 'https://dummyu.sharepoint.com/sites/Esports', uniqueId: 'fce429aa-7efc-4bac-93c5-6219e85183f4', parentId: 'p1', name: 'Sign-ups.xlsx' } })
  }

  beforeEach(() => {
    rig = makeRig()
    ensureMsformsTables(rig.db)
    ensureWorkbookIndex(rig.db)
    sheets.ensure!(rig.db)
    setJobs(localJobs)
    forms = new MsformsStore(rig.db)
    disk = new Map(
      [VM_BOOK, VM_OTHER].map((p) => [p.toLowerCase(), { path: p, data: Buffer.from('vm workbook').toString('base64'), modified: 1000 }])
    )
    writes = []
    forgetUploads()
    forgetVmLists()
    setVmState(() => ({ state: 'awake', cannot: null }))
    rig.db.prepare(`INSERT OR REPLACE INTO work_office_files (key, value) VALUES ('vm:status', ?)`).run(
      JSON.stringify({
        at: Date.now(),
        status: { onedrive: { installed: true, running: true, account: 'a@dummy.edu' }, mounts: [{ path: TOP, type: 'team', web: 'https://dummyu.sharepoint.com/sites/Esports/Shared Documents' }], office: { installed: true, version: null, apps: [], account: null, licensed: null }, verbs: ['files.write'] },
        tops: { [TOP]: ['Forms'] }
      })
    )
    setVmCall(async (verb, args) => {
      const a = (args ?? {}) as Record<string, unknown>
      const f = disk.get(String(a.path ?? '').toLowerCase())!
      if (verb === 'files.stat') return { name: f.path.slice(f.path.lastIndexOf('\\') + 1), path: f.path, dir: false, size: 11, modified: f.modified, local: true, link: false }
      if (verb === 'files.read') return { data: f.data, size: 11, eof: true, ...(a.version ? { version: `11:${f.modified}`, changed: f.modified } : {}) }
      if (verb === 'files.write') {
        writes.push(a)
        return { version: '12:2000', changed: 2000, entry: {} }
      }
      throw new Error(`unexpected ${verb}`)
    })
    setCopyAllowed(rig.db, WS, true)
    offSaved = onFileSaved((path) => copySaved(rig.ctx, path))
  })
  afterEach(() => {
    forgetUploads()
    offSaved()
    setVmCall(null)
    setJobs(null)
    closeFilesState(rig.db)
    rig.close()
  })

  it('is known by its library and path, by where it lies on this host or in the VM, and by its web address', () => {
    const lib = diskLibrary()
    const book = join(rig.team, 'General', 'Answers.xlsx')
    form(FORM_A, lib, book)
    expect(isFormsWorkbook(rig.ctx, { libraryId: lib.id, path: 'General/Answers.xlsx' })).toBe(true)
    expect(isFormsWorkbook(rig.ctx, { libraryId: lib.id, path: 'general\\answers.XLSX' })).toBe(true)
    expect(isFormsWorkbook(rig.ctx, { host: HOST, path: book })).toBe(true)
    // another workbook in the same folder, the same name in another library, another computer's path
    expect(isFormsWorkbook(rig.ctx, { host: HOST, path: join(rig.team, 'General', 'Spring budget.xlsx') })).toBe(false)
    expect(isFormsWorkbook(rig.ctx, { libraryId: 'other~lib', path: 'General/Answers.xlsx' })).toBe(false)
    expect(isFormsWorkbook(rig.ctx, { host: 'env_mac', path: book })).toBe(false)
    // by its web address, as Excel names a workbook it opened from SharePoint: its document id, from any host
    const doc = 'https://dummyu.sharepoint.com/sites/Esports/_layouts/15/Doc.aspx?sourcedoc=%7BFCE429AA-7EFC-4BAC-93C5-6219E85183F4%7D&file=Answers.xlsx'
    expect(isFormsWorkbook(rig.ctx, { host: 'env_mac', path: doc })).toBe(true)
    expect(isFormsWorkbook(rig.ctx, { host: HOST, path: doc.replace('FCE429AA', 'ACE429AA') })).toBe(false)
    form(`${FORM_A.slice(0, 40)}vm00`, vmLibrary(), VM_BOOK)
    expect(isFormsWorkbook(rig.ctx, { host: HOST, path: VM_BOOK })).toBe(true)
    expect(isFormsWorkbook(rig.ctx, { host: HOST, path: VM_OTHER })).toBe(false)
    // or by its library's site and its place there
    expect(vmLibrary().web).toBeTruthy()
    expect(isFormsWorkbook(rig.ctx, { host: 'env_mac', path: 'https://dummyu.sharepoint.com/sites/Esports/Shared%20Documents/Forms/Sign-ups.xlsx' })).toBe(true)
    expect(isFormsWorkbook(rig.ctx, { host: 'env_mac', path: 'https://dummyu.sharepoint.com/sites/Esports/Shared%20Documents/Forms/Roster.xlsx' })).toBe(false)
  })

  it('is no form\'s while the form has no workbook yet', () => {
    form(FORM_A, diskLibrary(), null)
    expect(isFormsWorkbook(rig.ctx, { libraryId: diskLibrary().id, path: 'General/Answers.xlsx' })).toBe(false)
    expect(isFormsWorkbook(rig.ctx, { host: HOST, path: join(rig.team, 'General', 'Answers.xlsx') })).toBe(false)
    expect(readOnlyOf(rig.ctx, at(join(rig.team, 'General', 'Answers.xlsx')))).toBeNull()
  })

  it('opens Edit here read only with the reason, takes no edit, and leaves another workbook in its folder as it was', async () => {
    const book = join(rig.team, 'General', 'Answers.xlsx')
    const other = join(rig.team, 'General', 'Roster.xlsx')
    copyFileSync(join(CORPUS, 'formulas.xlsx'), book)
    copyFileSync(join(CORPUS, 'formulas.xlsx'), other)
    form(FORM_A, diskLibrary(), book)
    const item = rig.canvas.open(filesPaneOf(WS), { kind: 'sheet', source: at(book), title: 'Answers.xlsx' })
    const mine = rig.canvas.open(filesPaneOf(WS), { kind: 'sheet', source: at(other), title: 'Roster.xlsx' })
    expect((await sheet<SheetView>('work.sheets.open', { itemId: item.id })).readOnly).toBe(FORMS_WORKBOOK_READ_ONLY)
    const view = await sheet<SheetView>('work.sheets.open', { itemId: mine.id })
    expect(view.readOnly).toBeUndefined()
    const before = readFileSync(book)
    const typed = { id: 'sheet.mutation.set-range-values', params: { unitId: 'workbook', subUnitId: 'x', cellValue: { 0: { 0: { v: 'over a row' } } } } }
    await expect(sheet('work.sheets.edit', { itemId: item.id, baseRev: 0, mutations: [typed] })).rejects.toThrow(FORMS_WORKBOOK_READ_ONLY)
    expect(readFileSync(book).equals(before)).toBe(true)
  })

  it("refuses a sheet tool's change, and a thread's read of its answers through the generic sheet reader", async () => {
    const book = join(rig.team, 'General', 'Answers.xlsx')
    copyFileSync(join(CORPUS, 'formulas.xlsx'), book)
    form(FORM_A, diskLibrary(), book)
    const ctx = { db: rig.db, host: HOST, dataDir: rig.ctx.dataDir } as unknown as ToolCtx
    const run = (name: string, args: unknown) => sheetTools.find((t) => t.name === name)!.run(args, ctx) as Promise<{ content: { text: string }[]; isError?: boolean }>
    const before = readFileSync(book)
    for (const [name, args] of [
      ['sheet_write', { file: book, cells: [{ at: 'A2', v: 'x' }], because: 'asked', quote: 'put x in A2' }],
      ['sheet_suggest', { file: book, cells: [{ at: 'A2', v: 'x' }] }]
    ] as const) {
      const got = await run(name, args)
      expect(got.isError).toBe(true)
      expect(got.content[0].text).toBe(FORMS_WORKBOOK_REFUSED)
    }
    expect(readFileSync(book).equals(before)).toBe(true)
    // the answers reach a thread only through msform_answers, in the form's own job
    const read = await run('sheet_read', { file: book, range: 'A1:C3' })
    expect(read.isError).toBe(true)
    expect(read.content[0].text).toBe(FORMS_WORKBOOK_READ_REFUSED)
    // another workbook in the same folder is not refused so (this ctx has no sheet host to read it with: only the refusal is judged)
    const other = join(rig.team, 'General', 'Roster.xlsx')
    copyFileSync(join(CORPUS, 'formulas.xlsx'), other)
    expect((await run('sheet_read', { file: other, range: 'A1:C3' })).content[0].text).not.toBe(FORMS_WORKBOOK_READ_REFUSED)
  })

  it('names the workbook as Files does for Open the Workbook, remembered as Excel for the web', async () => {
    const lib = diskLibrary()
    const book = join(rig.team, 'General', 'Answers.xlsx')
    copyFileSync(join(CORPUS, 'formulas.xlsx'), book)
    form(FORM_A, lib, book)
    const got = await workbookFile(rig.ctx, window, { workspaceId: WS, formId: FORM_A })
    expect(got).toEqual({ ref: { at: 'file', host: HOST, path: book }, name: 'Sign-ups.xlsx' })
    // keyed as the seat chooser keys a library file of this host: one row, Live
    expect(rig.db.prepare("SELECT mode FROM work_office_live WHERE workspace_id = ?").all(WS)).toEqual([{ mode: 'live' }])
    // in the VM: a guest path, keyed as a copy's tab is
    const vm = `${FORM_A.slice(0, 40)}vm00`
    form(vm, vmLibrary(), VM_BOOK)
    const far = await workbookFile(rig.ctx, window, { workspaceId: WS, formId: vm })
    expect(far.ref).toEqual({ at: 'file', host: HOST, path: VM_BOOK })
    expect(modeOf(rig.db, WS, refKey(far.ref), null)).toBe('live')
    // no workbook yet
    const none = `${FORM_A.slice(0, 40)}none`
    form(none, lib, null)
    await expect(workbookFile(rig.ctx, window, { workspaceId: WS, formId: none })).rejects.toThrow(NO_WORKBOOK)
  })

  it('in the VM opens as a copy that sends nothing back, and reads only by the file it is a copy of', async () => {
    form(FORM_A, vmLibrary(), VM_BOOK)
    const got = await files<FilesOpened>('work.files.open', { ref: { at: 'file', host: HOST, path: VM_BOOK }, name: 'Sign-ups.xlsx' })
    const copy = canvasSourcePath(got.item!.source)!
    expect(copyRecord(rig.ctx, WS, HOST, VM_BOOK)).toBeNull()
    expect(readOnlyOf(rig.ctx, at(copy))).toEqual({ reason: FORMS_WORKBOOK_READ_ONLY, refused: FORMS_WORKBOOK_REFUSED, readRefused: FORMS_WORKBOOK_READ_REFUSED })
    // A save of the copy (as an editor's would be) goes nowhere.
    await saveFile({ roots: [dirname(copy)] }, `file::${copy}`, copy, Buffer.from('changed here'), versionWord(await versionOf(copy)))
    await Promise.all(copiesInFlight())
    expect(writes).toEqual([])
    // Another workbook of that folder saves back as before.
    const roster = await files<FilesOpened>('work.files.open', { ref: { at: 'file', host: HOST, path: VM_OTHER }, name: 'Roster.xlsx' })
    expect(copyRecord(rig.ctx, WS, HOST, VM_OTHER)).not.toBeNull()
    expect(readOnlyOf(rig.ctx, at(canvasSourcePath(roster.item!.source)!))).toBeNull()
  })
})
