import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IWorkbookData } from '@univerjs/core'
import { afterAll, describe, expect, it } from 'vitest'
import { headlessSheet } from 'work-kit/sheet/engine'
import { createPages, PAGES_RESOURCE, SET_PAGE_SETUP_MUTATION } from 'work-kit/sheet/pages/access'
import { importXlsx } from 'work-kit/sheet/xlsx'
import { SHEET_ROW, type SheetMutationJson } from '@shared/contract-work-sheets'
import { forPackage, latestRules, PAGE_SETUP, RULE_MUTATIONS, ruleKinds, RULES_SET } from '@shared/work/sheets'
import { ensurePackageTables, PackageStore } from './packages'
import { readPages } from './patch/pages'
import { pagesOf, writeXlsxWhole } from './writer'
import { localJobs } from './workerClient'

/**
 * The page's controls, by where a sheet lives (the editors plan, SHT6): listed for a store only
 * where a page set-up survives. For an opened Excel file every part is the real one: the kit's own
 * `handle.pages` on a headless grid changes the set-up, the canvas's mapping sends the sheet's
 * whole set-up (`RULES_SET` of kind `pages`), the package store saves it into a real .xlsx, and
 * the file read again holds it. For a sheet the service holds: the engine replays the mutation, a
 * cold load has the set-up, and the Excel export writes it.
 */
const CORPUS = join(import.meta.dirname, 'harness/corpus')
const scratch = mkdtempSync(join(tmpdir(), 'sheets-pages-matrix-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const emittedOf = (grid: ReturnType<typeof headlessSheet>): SheetMutationJson[] => {
  const emitted: SheetMutationJson[] = []
  grid.api.addEvent(grid.api.Event.CommandExecuted, (event) => {
    if (event.type === 2 && !event.options?.fromCollab && !event.options?.onlyLocal && (event.id in RULE_MUTATIONS || event.id.startsWith('sheet.mutation.'))) emitted.push({ id: event.id, params: event.params })
  })
  return emitted
}

describe('the page\'s controls, by where a sheet lives', () => {
  it('are listed for every store that keeps a page set-up, and for none that does not', () => {
    for (const store of ['lifeos', 'tcsheet', 'package'] as const) expect(SHEET_ROW[store], store).toEqual(expect.arrayContaining(['page', 'pageBreaks', 'printArea', 'breakHere']))
    expect(SHEET_ROW.csv).toEqual([])
    expect(ruleKinds(SHEET_ROW.package).has('pages')).toBe(true)
    expect(PAGE_SETUP).toBe(SET_PAGE_SETUP_MUTATION)
  })

  it('a set-up\'s change goes to an opened Excel file as the sheet\'s whole set-up, and is left out where the host keeps none', () => {
    const setup = { orientation: 'landscape' }
    const m = { id: PAGE_SETUP, params: { unitId: 'workbook', subUnitId: 's1', setup } }
    expect(forPackage(m, () => null, { formats: true, kinds: ruleKinds(['page']), rules: (kind, sheet) => (kind === 'pages' && sheet === 's1' ? setup : undefined) })).toEqual({ keep: [{ id: RULES_SET, params: { kind: 'pages', subUnitId: 's1', list: setup } }] })
    // rows put into a sheet with breaks send one more of these in the same command: never a reason to stop the insert
    expect(forPackage(m, () => null, { formats: true, kinds: ruleKinds(['filter']), rules: () => [] })).toEqual({ keep: [] })
    expect(forPackage(m, () => null, { google: true })).toEqual({ keep: [] })
  })
})

describe('a page set-up changed in an opened Excel file', () => {
  it('orientation, margins, a manual break and a print area: each saved and read back from the file', async () => {
    const path = join(scratch, 'pages.xlsx')
    copyFileSync(join(CORPUS, 'formulas.xlsx'), path)
    const db = new DatabaseSync(':memory:')
    ensurePackageTables(db)
    const store = new PackageStore(db, await localJobs(), join(scratch, 'files'), () => null)
    await store.open(path)
    const { workbook } = importXlsx(new Uint8Array(readFileSync(path)))
    const sheet = workbook.sheetOrder.find((id) => workbook.sheets[id]?.name === 'Data')!
    const grid = headlessSheet('univer', workbook, { rules: true, pages: true })
    try {
      const pages = createPages(grid.api, () => false)
      expect(pages.kept).toBe(true)
      const emitted = emittedOf(grid)
      grid.workbook.setActiveSheet(grid.workbook.getSheetBySheetId(sheet)!)
      const kinds = ruleKinds(SHEET_ROW.package)
      const save = async (): Promise<number> => {
        await new Promise((done) => setTimeout(done, 0))
        const out: SheetMutationJson[] = []
        for (const m of emitted.splice(0)) {
          const got = forPackage(m, () => null, { formats: true, kinds, rules: (kind, at) => (kind === 'pages' ? pages.get(at) : undefined) })
          if ('stop' in got) throw new Error(`stopped: ${got.stop} (${m.id})`)
          out.push(...got.keep)
        }
        const mutations = latestRules(out)
        expect(mutations).toHaveLength(1)
        expect(mutations[0]).toMatchObject({ id: RULES_SET, params: { kind: 'pages', subUnitId: sheet } })
        const got = await store.edit(path, (await store.open(path)).rev, mutations, 'owner')
        if ('conflict' in got) throw new Error('conflict')
        return got.rev
      }
      const file = () => readPages(new Uint8Array(readFileSync(path))).find((entry) => entry.sheet === 'Data')!.setup
      const before = importXlsx(new Uint8Array(readFileSync(path))).workbook.sheets[sheet]!.cellData

      expect(pages.set(sheet, { orientation: 'landscape' })).toBe(true)
      expect(await save()).toBe(1)
      expect(file().orientation).toBe('landscape')
      expect(store.history(path)[0]).toMatchObject({ rev: 1, label: 'Page set-up', by: 'owner' })

      const margins = { ...pages.get(sheet).margins, left: 1.25, right: 1.25 }
      expect(pages.set(sheet, { margins })).toBe(true)
      await save()
      expect(file().margins).toMatchObject({ left: 1.25, right: 1.25 })
      expect(file().orientation).toBe('landscape')

      expect(pages.addBreak('row', 4, sheet)).toBe(true)
      await save()
      expect(JSON.stringify(file())).toContain('4')
      expect(pages.get(sheet)).toEqual(expect.objectContaining({ orientation: 'landscape' }))

      expect(pages.setPrintArea({ startRow: 0, endRow: 8, startColumn: 0, endColumn: 2 }, sheet)).toBe(true)
      await save()
      // what the file says is what the grid holds: read back whole
      expect(file()).toEqual(pages.get(sheet))
      // what a grid opening the file again shows
      const again = importXlsx(new Uint8Array(readFileSync(path))).workbook
      const cold = JSON.parse(again.resources?.find((r) => r.name === PAGES_RESOURCE)?.data ?? '{}') as Record<string, unknown>
      expect(cold[sheet]).toEqual(pages.get(sheet))
      // no cell's contents moved through any of it
      expect(again.sheets[sheet]!.cellData).toEqual(before)
    } finally {
      grid.dispose()
    }
  })
})

describe('a page set-up on a sheet the service holds', () => {
  const book = (): IWorkbookData =>
    ({
      id: 'wb',
      name: 'Budget',
      appVersion: '0.5.0',
      locale: 'enUS',
      styles: {},
      sheetOrder: ['s1'],
      sheets: { s1: { id: 's1', name: 'Data', rowCount: 100, columnCount: 26, cellData: { 0: { 0: { v: 'Item' }, 1: { v: 'Cost' } }, 1: { 0: { v: 'Desk' }, 1: { v: 120 } } } } },
      resources: []
    }) as unknown as IWorkbookData

  it('the engine replays the mutation, a cold load has the set-up, and the Excel export writes it', () => {
    // the window's grid makes the change
    const window = headlessSheet('univer', book(), { rules: true, pages: true })
    const emitted = emittedOf(window)
    const pages = createPages(window.api, () => false)
    expect(pages.set('s1', { orientation: 'landscape' })).toBe(true)
    expect(pages.addBreak('row', 0, 's1')).toBe(true)
    const sent = emitted.filter((m) => m.id === PAGE_SETUP)
    expect(sent.length).toBeGreaterThan(0)
    const want = pages.get('s1')
    window.dispose()

    // the service's engine takes each as it came
    const engine = headlessSheet('work', book(), { rules: true, pages: true })
    for (const m of sent) expect(engine.api.syncExecuteCommand(m.id, m.params as object, { fromCollab: true })).toBe(true)
    const snapshot = engine.workbook.save()
    engine.dispose()
    expect(JSON.parse(snapshot.resources?.find((r) => r.name === PAGES_RESOURCE)?.data ?? '{}').s1).toEqual(want)

    // a cold load shows it
    const cold = headlessSheet('work', snapshot, { rules: true, pages: true })
    expect(createPages(cold.api, () => false).get('s1')).toEqual(want)
    cold.dispose()

    // and the export holds it
    expect(pagesOf(snapshot, () => 'Data')).toEqual([{ sheet: 'Data', setup: want }])
    const { bytes, left } = writeXlsxWhole(snapshot)
    expect(left).toEqual([])
    expect(readPages(bytes).find((entry) => entry.sheet === 'Data')!.setup).toEqual(want)
  })

  it('without the pages plugin the mutation is no command: the host mounts it', () => {
    const bare = headlessSheet('work', book(), { rules: true })
    expect(() => bare.api.syncExecuteCommand(PAGE_SETUP, { unitId: 'wb', subUnitId: 's1', setup: null }, { fromCollab: true })).toThrow()
    bare.dispose()
  })
})
