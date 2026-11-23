import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IWorkbookData } from '@univerjs/core'
import { afterAll, describe, expect, it } from 'vitest'
import { headlessSheet } from 'work-kit/sheet/engine'
import { createRules } from 'work-kit/sheet/rules'
import { importXlsx } from 'work-kit/sheet/xlsx'
import { SHEET_ROW, type SheetMutationJson, type SheetStoreKind } from '@shared/contract-work-sheets'
import { forPackage, latestRules, RULE_MUTATIONS, ruleKinds, RULES_SET, type SheetRuleKind } from '@shared/work/sheets'
import { ensurePackageTables, PackageStore } from './packages'
import { readRules } from './patch/rules'
import { localJobs } from './workerClient'

/**
 * The Data menu's matrix (the editors plan, SHT3): a rule's control is listed for a store only
 * where the rule survives. For an opened Excel file every part is the real one, end to end:
 *
 *   1. the grid's own plugin makes the rule (a headless Univer with the data plugins, through
 *      work-kit's `createRules`, which the side sheet and the row call);
 *   2. the canvas maps what the plugin emitted for the file (`forPackage`: the whole list);
 *   3. the package store saves it into a real .xlsx (the rules writer);
 *   4. the file read again holds it (`readRules`), and a cold import, which is what a grid
 *      opening the file again shows.
 *
 * A sheet the service holds is held the same way by host/rules.test.ts (the engine takes each
 * mutation, a cold host shows it, a restore brings it back) and writer.test.ts (the export).
 */
const CORPUS = join(import.meta.dirname, 'harness/corpus')
const scratch = mkdtempSync(join(tmpdir(), 'sheets-rules-matrix-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

let n = 0
async function opened() {
  const path = join(scratch, `${++n}.xlsx`)
  copyFileSync(join(CORPUS, 'formulas.xlsx'), path)
  const db = new DatabaseSync(':memory:')
  ensurePackageTables(db)
  const store = new PackageStore(db, await localJobs(), join(scratch, `files-${n}`), () => null)
  const state = await store.open(path)
  const { workbook } = importXlsx(new Uint8Array(readFileSync(path)))
  const grid = headlessSheet('univer', workbook, { rules: true })
  const rules = createRules(grid.api, () => false)
  const emitted: SheetMutationJson[] = []
  grid.api.addEvent(grid.api.Event.CommandExecuted, (event) => {
    if (event.type === 2 && !event.options?.fromCollab && !event.options?.onlyLocal && (event.id in RULE_MUTATIONS || event.id.startsWith('sheet.mutation.'))) emitted.push({ id: event.id, params: event.params })
  })
  const sheet = workbook.sheetOrder.find((id) => workbook.sheets[id]?.name === 'Data')!
  grid.workbook.setActiveSheet(grid.workbook.getSheetBySheetId(sheet)!)
  const kinds = ruleKinds(SHEET_ROW.package)
  /** What the canvas sends for the turn: each mutation as the file takes it, each list once. */
  const sent = (): SheetMutationJson[] => {
    const out: SheetMutationJson[] = []
    for (const m of emitted.splice(0)) {
      const got = forPackage(m, () => null, {
        formats: true,
        kinds,
        rules: (kind: SheetRuleKind, at?: string) => (kind === 'conditional' ? rules.conditional.list(at) : kind === 'validation' ? rules.validation.list(at) : kind === 'names' ? rules.names.list() : kind === 'tables' ? [] : kind === 'pages' ? null : rules.filter.get(at))
      })
      if ('stop' in got) throw new Error(`stopped: ${got.stop} (${m.id})`)
      out.push(...got.keep)
    }
    return latestRules(out)
  }
  const save = async (): Promise<number> => {
    // Univer runs some of these mutations a tick after their command (a validation removed): the canvas gathers a turn the same way.
    await new Promise((done) => setTimeout(done, 0))
    const mutations = sent()
    expect(mutations.length).toBeGreaterThan(0)
    expect(mutations.every((m) => m.id === RULES_SET)).toBe(true)
    const got = await store.edit(path, (await store.open(path)).rev, mutations, 'owner')
    if ('conflict' in got) throw new Error('conflict')
    return got.rev
  }
  const file = () => readRules(new Uint8Array(readFileSync(path))).sheets.Data!
  const names = () => Object.values(readRules(new Uint8Array(readFileSync(path))).names)
  const cold = (resource: string): Record<string, unknown> => {
    const { workbook: again } = importXlsx(new Uint8Array(readFileSync(path)))
    return JSON.parse(again.resources?.find((r) => r.name === resource)?.data ?? '{}') as Record<string, unknown>
  }
  const cells = (): unknown => importXlsx(new Uint8Array(readFileSync(path))).workbook.sheets[sheet]!.cellData
  return { path, store, state, grid, rules, sheet, save, file, names, cold, cells, before: cells(), workbook: workbook as IWorkbookData }
}

const B = { startRow: 1, endRow: 8, startColumn: 1, endColumn: 1 }

describe('the Data menu\'s controls, by where a sheet lives', () => {
  it('are listed for every store that keeps a rule, and for none that does not', () => {
    const data = ['conditional', 'filter', 'names', 'sort', 'table', 'validation']
    for (const store of ['lifeos', 'tcsheet', 'package'] as SheetStoreKind[]) expect(SHEET_ROW[store].filter((c) => data.includes(c)).sort(), store).toEqual(data)
    expect(SHEET_ROW.csv).toEqual([])
    expect([...ruleKinds(SHEET_ROW.package)].sort()).toEqual(['conditional', 'filter', 'names', 'pages', 'tables', 'validation'])
  })
})

describe('a rule made in an opened Excel file', () => {
  it('a conditional format: made, changed, moved first and removed, each saved and read back from the file', async () => {
    const t = await opened()
    try {
      const first = t.rules.conditional.add({ ranges: [B], stopIfTrue: false, rule: { type: 'highlightCell', subType: 'number', operator: 'greaterThan', value: 100, style: { cl: { rgb: '#C00000' }, bl: 1 } } } as never)!
      expect(await t.save()).toBe(1)
      expect(t.file().conditional).toHaveLength(1)
      expect(t.file().conditional[0]).toMatchObject({ ranges: [B], rule: { subType: 'number', operator: 'greaterThan', value: 100, style: { bl: 1 } } })
      // a second rule on top, then the first changed: two saves, the order kept
      t.rules.conditional.add({ ranges: [B], stopIfTrue: false, rule: { type: 'colorScale', config: [{ index: 0, color: '#F8696B', value: { type: 'min' } }, { index: 1, color: '#63BE7B', value: { type: 'max' } }] } } as never)
      await t.save()
      expect(t.file().conditional.map((r) => (r.rule as { type: string }).type)).toEqual(['colorScale', 'highlightCell'])
      const held = t.rules.conditional.list().find((r) => r.cfId === first)!
      t.rules.conditional.set(first, { ...held, rule: { ...held.rule, value: 250 } } as never)
      await t.save()
      expect(t.file().conditional.map((r) => (r.rule as { value?: number }).value)).toEqual([undefined, 250])
      // moved to win first
      expect(t.rules.conditional.move(first, 0)).toBe(true)
      await t.save()
      expect(t.file().conditional.map((r) => (r.rule as { type: string }).type)).toEqual(['highlightCell', 'colorScale'])
      // what a grid opening the file again shows
      expect((t.cold('SHEET_CONDITIONAL_FORMATTING_PLUGIN')[t.sheet] as unknown[]).length).toBe(2)
      for (const rule of t.rules.conditional.list()) t.rules.conditional.remove(rule.cfId)
      await t.save()
      expect(t.file().conditional).toEqual([])
      // no cell's contents moved through any of it
      expect(t.cells()).toEqual(t.before)
    } finally {
      t.grid.dispose()
    }
  })

  it('a validation: a list made, its range changed, removed', async () => {
    const t = await opened()
    try {
      const id = t.rules.validation.add({ type: 'list', formula1: 'Open,Done', ranges: [{ startRow: 1, endRow: 8, startColumn: 2, endColumn: 2 }], showErrorMessage: true, errorStyle: 1, allowBlank: true } as never)!
      await t.save()
      expect(t.file().validation).toHaveLength(1)
      expect(t.file().validation[0]).toMatchObject({ type: 'list', formula1: 'Open,Done', showErrorMessage: true, ranges: [{ startRow: 1, endRow: 8, startColumn: 2, endColumn: 2 }] })
      const held = t.rules.validation.list().find((r) => r.uid === id)!
      t.rules.validation.set(id, { ...held, ranges: [{ startRow: 1, endRow: 20, startColumn: 2, endColumn: 2 }] } as never)
      await t.save()
      expect(t.file().validation[0]!.ranges).toEqual([expect.objectContaining({ startRow: 1, endRow: 20 })])
      expect((t.cold('SHEET_DATA_VALIDATION_PLUGIN')[t.sheet] as unknown[]).length).toBe(1)
      t.rules.validation.remove(id)
      await t.save()
      expect(t.file().validation).toEqual([])
      expect(t.cells()).toEqual(t.before)
    } finally {
      t.grid.dispose()
    }
  })

  it('a name: the workbook\'s and one sheet\'s own, changed and removed', async () => {
    const t = await opened()
    try {
      const had = t.names().length
      const book = t.rules.names.add({ name: 'Budgeted', formulaOrRefString: 'Data!$B$2:$B$9' } as never)!
      const local = t.rules.names.add({ name: 'Local', formulaOrRefString: 'Data!$A$1', localSheetId: t.sheet } as never)!
      await t.save()
      const made = t.names().filter((x) => x.name === 'Budgeted' || x.name === 'Local')
      expect(made.map((x) => [x.name, x.formulaOrRefString, x.localSheetId ?? null]).sort()).toEqual([
        ['Budgeted', 'Data!$B$2:$B$9', null],
        ['Local', 'Data!$A$1', t.sheet]
      ])
      const held = t.rules.names.list().find((x) => x.id === book)!
      t.rules.names.set(book, { ...held, formulaOrRefString: 'Data!$B$2:$B$20' } as never)
      await t.save()
      expect(t.names().find((x) => x.name === 'Budgeted')!.formulaOrRefString).toBe('Data!$B$2:$B$20')
      t.rules.names.remove(book)
      t.rules.names.remove(local)
      await t.save()
      expect(t.names()).toHaveLength(had)
    } finally {
      t.grid.dispose()
    }
  })

  it('the filter: laid over a range, and taken off', async () => {
    const t = await opened()
    try {
      const ref = { startRow: 0, endRow: 8, startColumn: 0, endColumn: 2 }
      expect(t.rules.filter.set(ref)).toBe(true)
      await t.save()
      expect(t.file().filter).toMatchObject({ ref })
      expect(t.cold('SHEET_FILTER_PLUGIN')[t.sheet]).toMatchObject({ ref })
      expect(t.rules.filter.set(null)).toBe(true)
      await t.save()
      expect(t.file().filter).toBeNull()
      expect(t.cells()).toEqual(t.before)
    } finally {
      t.grid.dispose()
    }
  })

  it('a revision for a rule says its list, and a grid that stood before it reads the file again', async () => {
    const t = await opened()
    try {
      t.rules.conditional.add({ ranges: [B], stopIfTrue: false, rule: { type: 'highlightCell', subType: 'duplicateValues', style: { bg: { rgb: '#FFC7CE' } } } } as never)
      const rev = await t.save()
      expect(t.store.history(t.path)[0]).toMatchObject({ rev, label: 'Conditional formatting', by: 'owner' })
      expect(t.store.since(t.path, rev - 1)).toEqual({ rev, reload: true })
      // an edit made on the revision before it still lands: no cell moved
      const cell: SheetMutationJson = { id: 'sheet.mutation.set-range-values', params: { unitId: 'workbook', subUnitId: t.sheet, cellValue: { 30: { 0: { v: 'late' } } } } }
      expect(await t.store.edit(t.path, rev - 1, [cell], 'owner')).toEqual({ rev: rev + 1 })
      expect(t.file().conditional).toHaveLength(1)
    } finally {
      t.grid.dispose()
    }
  })
})
