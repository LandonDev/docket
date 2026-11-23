import { copyFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { importXlsx } from 'work-kit/sheet/xlsx'
import { ClientRequestSchema, type ClientRequest } from '@shared/contract'
import type { SheetView } from '@shared/contract-work-sheets'
import { filesPaneOf, mailPaneOf } from '@shared/work'
import { makeRig, at, window, WS, type Rig } from '../files/testkit'
import { setJobs, viewOf, type Sheets } from './held'
import { createSheet, sheets } from './index'
import { localJobs } from './workerClient'
import { ChangeStore, ensureChangeTables } from './changes'
import { ensureSuggestionTables, SuggestionStore } from './suggestions'

/** A sheet open in a Files tab: its owner is the pane, which has no scope row. */
let rig: Rig
let asked: { route: string; body: unknown }[]
let lifeos = false
let s: Sheets

beforeEach(() => {
  rig = makeRig()
  asked = []
  lifeos = false
  rig.db.exec('CREATE TABLE IF NOT EXISTS work_sheets_charts (store TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (store, id))')
  ensureSuggestionTables(rig.db)
  ensureChangeTables(rig.db)
  Object.assign(rig.ctx, {
    lifeos: { connected: () => lifeos },
    service: {
      internal: async (route: string, body: unknown) => {
        asked.push({ route, body })
        return { sheet: { lifeos: 'sheet-1' } }
      }
    }
  })
  const packages = { hold: () => {}, open: async () => ({ rev: 0, inspected: { sheets: [], date1904: false, reach: null }, saveError: null, missing: false }) }
  s = { ctx: rig.ctx, packages, suggestions: new SuggestionStore(rig.db), changes: new ChangeStore(rig.db), jobs: {} } as unknown as Sheets
})
afterEach(() => rig.close())

describe('a sheet on the Files pane', () => {
  it('reads as shared when it lies in a team library, and as his own in the workspace\'s folder', async () => {
    const team = rig.canvas.open(filesPaneOf(WS), { kind: 'sheet', source: at(join(rig.team, 'General', 'Spring budget.xlsx')), title: 'Spring budget.xlsx' })
    const own = rig.canvas.open(filesPaneOf(WS), { kind: 'sheet', source: at(join(rig.folder, 'Budget.xlsx')), title: 'Budget.xlsx' })
    expect((await viewOf(s, team)).shared).toBe(true)
    expect((await viewOf(s, own)).shared).toBe(false)
  })

  it('still asks a thread\'s scope, which may call a file of its own folder shared', async () => {
    rig.scopes.set('t1', { workspaceId: WS, shared: () => true } as never)
    const item = rig.canvas.open('t1', { kind: 'sheet', source: at(join(rig.folder, 'Budget.xlsx')), title: 'Budget.xlsx' })
    expect((await viewOf(s, item)).shared).toBe(true)
  })

  it('makes a sheet in the pane\'s workspace\'s sector, in LifeOS when it is connected', async () => {
    lifeos = true
    const item = await createSheet(s, filesPaneOf(WS), 'Roster')
    expect(asked[0]).toMatchObject({ route: '/internal/sheet/create', body: { title: 'Roster', at: { lifeos: { sector: 'purdue' } } } })
    expect(item).toMatchObject({ sessionId: filesPaneOf(WS), kind: 'sheet', source: { at: 'lifeos', table: 'sheets', id: 'sheet-1' } })
  })

  it('makes a .tcsheet of its own when LifeOS is not connected', async () => {
    const item = await createSheet(s, filesPaneOf(WS), 'Roster')
    expect(item.sessionId).toBe(filesPaneOf(WS))
    expect(item.source).toMatchObject({ at: 'file', host: rig.ctx.host })
    expect((item.source as { path: string }).path).toMatch(/Roster\.tcsheet$/)
  })

  it('refuses an owner that is neither a thread nor a Files pane of a Work workspace here', async () => {
    rig.db.prepare(`INSERT INTO workspaces (id, name, path, kind) VALUES ('code2', 'Repo', '/tmp', 'code')`).run()
    await expect(createSheet(s, filesPaneOf('code2'), 'X')).rejects.toThrow(/Work threads/)
    await expect(createSheet(s, filesPaneOf('gone'), 'X')).rejects.toThrow(/Work threads/)
    await expect(createSheet(s, mailPaneOf(WS), 'X')).rejects.toThrow(/Work threads/)
    await expect(createSheet(s, 'stranger', 'X')).rejects.toThrow(/Work threads/)
    expect(asked).toEqual([])
  })

  it('still makes a thread\'s sheet in its scope\'s sector', async () => {
    lifeos = true
    rig.scopes.set('t1', { workspaceId: WS, sector: 'ref' })
    const item = await createSheet(s, 't1', 'Games')
    expect(asked[0].body).toMatchObject({ at: { lifeos: { sector: 'ref' } } })
    expect(item.sessionId).toBe('t1')
  })
})

/**
 * His own edit to an .xlsx he opened from Files (the Files build's open item 1, 2026-11-23): the item is the
 * workspace's Files pane's, with no thread, and the window sends what the grid made as `work.sheets.edit` from the
 * revision it loaded. The file on disk takes the value and the format, in the workspace's own folder and in a
 * library on this host (a place others can open), and nothing is written beside it.
 */
describe('his edit to an .xlsx in a Files tab', () => {
  const CORPUS = join(import.meta.dirname, 'harness/corpus')
  const req = (method: string, params: unknown): ClientRequest => ClientRequestSchema.parse({ id: '1', method, params } as ClientRequest)
  const call = async <T,>(method: string, params: unknown): Promise<T> => {
    const out = await sheets.handle!(req(method, params), rig.ctx, window)
    if (!out.handled) throw new Error(`${method} was not handled`)
    return out.result as T
  }
  const names = (dir: string): string[] => readdirSync(dir, { recursive: true }).map(String).sort()
  const cellOf = (path: string, row: number, col: number) => {
    const { workbook } = importXlsx(new Uint8Array(readFileSync(path)))
    const sheet = workbook.sheets[workbook.sheetOrder[0]!]!
    const cell = sheet.cellData?.[row]?.[col]
    const style = (typeof cell?.s === 'string' ? workbook.styles?.[cell.s] : cell?.s) as { bl?: number } | undefined
    return { v: cell?.v, bold: style?.bl === 1, sheetId: workbook.sheetOrder[0]! }
  }

  beforeEach(() => {
    setJobs(localJobs)
    sheets.ensure!(rig.db)
  })
  afterEach(() => setJobs(null))

  for (const where of ['the workspace\'s folder', 'a library on this host'] as const) {
    it(`saves a typed value and a bold into the file itself, in ${where}`, async () => {
      const dir = where === 'a library on this host' ? join(rig.team, 'General') : rig.folder
      const path = join(dir, 'Roster.xlsx')
      copyFileSync(join(CORPUS, 'formulas.xlsx'), path)
      const item = rig.canvas.open(filesPaneOf(WS), { kind: 'sheet', source: at(path), title: 'Roster.xlsx' })
      const view = await call<SheetView>('work.sheets.open', { itemId: item.id })
      expect(view).toMatchObject({ store: 'package', rev: 0, shared: where === 'a library on this host' })
      expect(view.readOnly).toBeUndefined()
      expect(view.row).toEqual(expect.arrayContaining(['bold']))
      const before = readFileSync(path)
      const beside = names(dir)
      const { sheetId } = cellOf(path, 0, 0)
      // What the grid sends for A1 typed and committed with Return, then for ⌘B on it.
      const typed = { id: 'sheet.mutation.set-range-values', params: { unitId: 'workbook', subUnitId: sheetId, cellValue: { 0: { 0: { v: 'Typed by hand' } } } } }
      const bold = { id: 'sheet.mutation.set-range-values', params: { unitId: 'workbook', subUnitId: sheetId, cellValue: { 0: { 0: { s: { bl: 1 } } } } } }
      expect(await call('work.sheets.edit', { itemId: item.id, baseRev: 0, mutations: [typed] })).toEqual({ rev: 1 })
      expect(readFileSync(path).equals(before)).toBe(false)
      expect(cellOf(path, 0, 0)).toMatchObject({ v: 'Typed by hand', bold: false })
      expect(await call('work.sheets.edit', { itemId: item.id, baseRev: 1, mutations: [bold] })).toEqual({ rev: 2 })
      expect(cellOf(path, 0, 0)).toMatchObject({ v: 'Typed by hand', bold: true })
      // The window that opens it again loads the file as saved, at the new revision.
      const again = await call<SheetView>('work.sheets.open', { itemId: item.id })
      expect(again.rev).toBe(2)
      const frame = await call<{ data: string; format: string }>('work.sheets.load', { itemId: item.id, rev: 2, offset: 0, length: 4 * 1024 * 1024 })
      expect(Buffer.from(frame.data, 'base64').equals(readFileSync(path))).toBe(true)
      // The pane's canvases are told: the push names the pane as the owner.
      expect(rig.pushes.some(({ p }) => p.push === 'work.sheets' && p.sessionId === filesPaneOf(WS) && p.itemId === item.id && p.rev === 2)).toBe(true)
      expect(names(dir)).toEqual(beside)
    })
  }
})
