import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IWorkbookData } from '@univerjs/core'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { headlessSheet } from 'work-kit/sheet/engine'
import type { SheetMutationJson } from '@shared/contract-work-sheets'
import { blankWorkbook, TcsheetBackend, type Op, type SheetBackend, type StoredSuggestion } from './backends'
import { SheetHost } from './host'
import { GUEST_OPS, moveThrough, MOVES_AS_IS, refusal } from './live'
import { RULE_RESOURCES, ruleMutations, WORKBOOK_MUTATIONS } from './rules'
import { ruleModel, ruleMutations as askedMutations, place } from '../asks'
import type { SheetRef } from './wire'

/**
 * The engine first (the editors plan, SHT3): a rule made in the grid is a mutation, and the
 * service's engine must take it, keep it through a cold load, and carry it through history and
 * restore. The mutations here are the grid's own: each feature's Univer command run in a headless
 * engine on the store's workbook, its mutations caught as the canvas reports them
 * (work-kit's `isSheetMutation`), then sent through `host.apply`. Both stores: the real
 * `.tcsheet` backend over a real file, and a stand-in that keeps ops as LifeOS does.
 */

class MemoryBackend implements SheetBackend {
  ops: Op[] = []
  rows: StoredSuggestion[] = []
  snaps = new Map<number, IWorkbookData>()
  constructor(data: IWorkbookData) {
    this.snaps.set(0, structuredClone(data))
  }
  async load() {
    const snapRev = Math.max(...this.snaps.keys())
    return { title: 'Budget', shared: false, snapshot: structuredClone(this.snaps.get(snapRev)!), snapRev, rev: this.ops.at(-1)?.rev ?? 0 }
  }
  async sharedNow() {
    return false
  }
  async opsAfter(rev: number) {
    return this.ops.filter((o) => o.rev > rev)
  }
  async append(baseRev: number, ops: { by: string; mutations: Op['mutations'] }[]) {
    const rev = this.ops.at(-1)?.rev ?? 0
    if (rev !== baseRev) return { stale: rev }
    let r = rev
    for (const op of ops) this.ops.push({ rev: ++r, by: op.by, at: r, mutations: structuredClone(op.mutations) })
    return { rev: r }
  }
  async cutSnapshot(rev: number, data: IWorkbookData) {
    this.snaps.set(rev, structuredClone(data))
  }
  async snapshotAt(rev: number) {
    const best = Math.max(...[...this.snaps.keys()].filter((r) => r <= rev))
    return { rev: best, data: structuredClone(this.snaps.get(best)!) }
  }
  async suggestions() {
    return structuredClone(this.rows)
  }
  async addSuggestions() {}
  async setSuggestions() {}
}

const scratch = mkdtempSync(join(tmpdir(), 'sheet-rules-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const hosts: SheetHost[] = []
afterEach(() => {
  for (const h of hosts.splice(0)) h.close()
})
const hostOf = (backend: () => SheetBackend) => {
  const h = new SheetHost(backend)
  hosts.push(h)
  return h
}

const U = 'workbook'
const S = 'sheet1'
const CELLS = {
  0: { 0: { v: 'Qty' }, 1: { v: 'Price' } },
  1: { 0: { v: 3 }, 1: { v: 30 } },
  2: { 0: { v: 1 }, 1: { v: 10 } },
  3: { 0: { v: 2 }, 1: { v: 20 } }
}

interface Store {
  ref: SheetRef
  backend: () => SheetBackend
}
let n = 0
async function storeOf(kind: 'tcsheet' | 'lifeos'): Promise<Store> {
  if (kind === 'lifeos') {
    const seed = blankWorkbook(U, 'Budget')
    seed.sheets[S]!.cellData = CELLS
    const memory = new MemoryBackend(seed)
    return { ref: { lifeos: `rules${++n}` }, backend: () => memory }
  }
  const path = join(scratch, `${++n}.tcsheet`)
  TcsheetBackend.create(path, 'Budget')
  const seeding = new SheetHost(() => new TcsheetBackend(path))
  await seeding.apply({ tcsheet: path }, 0, [{ id: 'sheet.mutation.set-range-values', params: { unitId: U, subUnitId: S, cellValue: CELLS } }], 'owner')
  seeding.close()
  return { ref: { tcsheet: path }, backend: () => new TcsheetBackend(path) }
}

/** What the canvas reports (work-kit's `isSheetMutation`, which lives in the grid's module, beside React). */
const reported = (id: string) => id.startsWith('sheet.mutation.') || id.startsWith('data-validation.mutation.') || WORKBOOK_MUTATIONS.has(id)

/** The grid on the store's workbook: runs a feature's commands and returns the mutations it reports. */
async function gridPress(host: SheetHost, ref: SheetRef, steps: Array<[string, object]>): Promise<SheetMutationJson[]> {
  const { json } = await host.snapshotJson(ref)
  const grid = headlessSheet('work', JSON.parse(json) as IWorkbookData, { rules: true })
  const out: SheetMutationJson[] = []
  const sub = grid.api.addEvent(grid.api.Event.CommandExecuted, (event) => {
    if (event.type === 2 && reported(event.id)) out.push({ id: event.id, params: structuredClone(event.params ?? {}) as object })
  })
  try {
    for (const [id, params] of steps) expect(await grid.api.executeCommand(id, params), id).toBe(true)
  } finally {
    sub.dispose()
    grid.dispose()
  }
  return out
}

const resourceOf = (json: string, name: string): unknown => {
  const wb = JSON.parse(json) as IWorkbookData
  return JSON.parse(wb.resources?.find((r) => r.name === name)?.data || 'null')
}

const RANGE = { startRow: 0, endRow: 3, startColumn: 0, endColumn: 1 }
const COL_A = { startRow: 1, endRow: 3, startColumn: 0, endColumn: 0 }
const highlight = { cfId: 'hi', ranges: [COL_A], stopIfTrue: false, rule: { type: 'highlightCell', subType: 'number', operator: 'greaterThan', value: 1, style: { bg: { rgb: '#FF0000' } } } }
const list = { uid: 'dv-list', type: 'list', formula1: 'Yes,No', ranges: [{ startRow: 1, endRow: 3, startColumn: 3, endColumn: 3 }] }

interface Feature {
  name: string
  steps: Array<[string, object]>
  /** What the snapshot holds of it: null when it is not there. */
  read: (json: string) => unknown
  made: unknown
}

const FEATURES: Feature[] = [
  {
    name: 'a conditional format',
    steps: [['sheet.command.add-conditional-rule', { unitId: U, subUnitId: S, rule: highlight }]],
    // A sheet whose last rule went keeps an empty list.
    read: (json) => {
      const rules = (resourceOf(json, RULE_RESOURCES.conditionalFormats) as Record<string, unknown[]> | null)?.[S]
      return rules?.length ? rules : null
    },
    made: [highlight]
  },
  {
    name: 'a validation',
    steps: [['sheet.command.addDataValidation', { unitId: U, subUnitId: S, rule: list }]],
    read: (json) => (resourceOf(json, RULE_RESOURCES.validations) as Record<string, unknown> | null)?.[S] ?? null,
    made: [list]
  },
  {
    name: 'a filter with a criterion',
    steps: [
      ['sheet.command.set-filter-range', { unitId: U, subUnitId: S, range: RANGE }],
      ['sheet.command.set-filter-criteria', { unitId: U, subUnitId: S, col: 1, criteria: { colId: 1, filters: { filters: ['10', '30'] } } }]
    ],
    read: (json) => {
      const f = (resourceOf(json, RULE_RESOURCES.filters) as Record<string, { ref: unknown; filterColumns: unknown }> | null)?.[S]
      return f ? { ref: f.ref, filterColumns: f.filterColumns } : null
    },
    made: { ref: RANGE, filterColumns: [{ colId: 1, filters: { filters: ['10', '30'] } }] }
  },
  {
    name: 'a workbook name and a sheet-scoped name',
    steps: [
      ['sheet.command.insert-defined-name', { unitId: U, id: 'n1', name: 'Rate', formulaOrRefString: 'Sheet1!$B$2' }],
      ['sheet.command.insert-defined-name', { unitId: U, id: 'n2', name: 'Local', formulaOrRefString: 'Sheet1!$A$2:$A$4', localSheetId: S }]
    ],
    read: (json) => {
      const names = resourceOf(json, RULE_RESOURCES.definedNames) as Record<string, unknown> | null
      return names && Object.keys(names).length ? names : null
    },
    made: {
      n1: { id: 'n1', name: 'Rate', formulaOrRefString: 'Sheet1!$B$2' },
      n2: { id: 'n2', name: 'Local', formulaOrRefString: 'Sheet1!$A$2:$A$4', localSheetId: S }
    }
  },
  {
    name: 'a sort',
    steps: [['sheet.command.sort-range', { unitId: U, subUnitId: S, range: RANGE, orderRules: [{ type: 'asc', colIndex: 0 }], hasTitle: true }]],
    read: (json) => {
      const cells = (JSON.parse(json) as IWorkbookData).sheets[S]!.cellData as Record<number, Record<number, { v?: unknown }>>
      const column = [1, 2, 3].map((r) => cells[r]?.[0]?.v)
      return column.join() === '1,2,3' ? column : null
    },
    made: [1, 2, 3]
  }
]

describe.each(['tcsheet', 'lifeos'] as const)('rules on the %s store', (kind) => {
  for (const f of FEATURES) {
    it(`${f.name}: applied, kept through a cold load, and carried by history, compare and restore`, async () => {
      const store = await storeOf(kind)
      const host = hostOf(store.backend)
      const before = (await host.open(store.ref)).rev
      const mutations = await gridPress(host, store.ref, f.steps)
      expect(mutations.length).toBeGreaterThan(0)
      const got = await host.apply(store.ref, before, mutations, 'owner')
      expect(got).toEqual({ rev: before + 1 })
      expect(f.read((await host.snapshotJson(store.ref)).json)).toEqual(f.made)

      // A cold load: a second host over the same store.
      const cold = hostOf(store.backend)
      expect(f.read((await cold.snapshotJson(store.ref)).json)).toEqual(f.made)

      // History lists the rule's op; compare across it still answers.
      const { revisions } = await cold.history(store.ref)
      expect(revisions[0]?.rev).toBe(before + 1)
      const diff = await cold.compare(store.ref, before, before + 1, 100)
      expect(diff).toHaveProperty('cells')

      // Restore to before the rule: it is gone. To after: it is back.
      const back = await cold.restore(store.ref, before, 'owner')
      expect(back.rev).toBe(before + 2)
      expect(f.read((await cold.snapshotJson(store.ref)).json)).toBeNull()
      const again = await cold.restore(store.ref, before + 1, 'owner')
      expect(again.rev).toBe(before + 3)
      expect(f.read((await cold.snapshotJson(store.ref)).json)).toEqual(f.made)
      // And a third cold load agrees with the restores.
      expect(f.read((await hostOf(store.backend).snapshotJson(store.ref)).json)).toEqual(f.made)
    })
  }
})

describe('what a sheet holds, as a new rule is checked against it', () => {
  it('open answers each name with its scope, each sheet\'s filter and the ranges that have a validation', async () => {
    const store = await storeOf('tcsheet')
    const host = hostOf(store.backend)
    const first = await host.open(store.ref)
    expect(first.rules).toEqual({ names: [], filters: {}, validations: {} })
    const asked = (rule: Parameters<typeof ruleModel>[0], range?: string) => askedMutations(first.unit, ruleModel(rule, range ? place(range, first.sheets) : null, first.sheets))
    const mutations = [
      ...asked({ kind: 'name', name: 'Rate', refersTo: '=0.08' }),
      ...asked({ kind: 'name', name: 'Local', refersTo: 'A1', scope: first.sheets[0]!.name }),
      ...asked({ kind: 'filter', range: 'A1:D28' }, 'A1:D28'),
      ...asked({ kind: 'list', range: 'C2:C5', items: ['Open', 'Done'] }, 'C2:C5')
    ]
    expect(await host.apply(store.ref, first.rev, mutations, 'owner')).toEqual({ rev: first.rev + 1 })
    const id = first.sheets[0]!.id
    const want = {
      names: [{ name: 'Rate' }, { name: 'Local', scope: id }],
      filters: { [id]: { startRow: 0, endRow: 27, startColumn: 0, endColumn: 3 } },
      validations: { [id]: [{ startRow: 1, endRow: 4, startColumn: 2, endColumn: 2 }] }
    }
    expect((await host.open(store.ref)).rules).toEqual(want)
    // a cold host reads the same from the store
    expect((await hostOf(store.backend).open(store.ref)).rules).toEqual(want)
  })
})

describe('a table on a sheet the service holds', () => {
  const tablesOf = (json: string): { id: string; name: string; range: { startRow: number; endRow: number; startColumn: number; endColumn: number } }[] => {
    const all = resourceOf(json, RULE_RESOURCES.tables) as Record<string, { tables?: { id: string; name: string; range: { startRow: number; endRow: number; startColumn: number; endColumn: number } }[] }>
    return all[S]?.tables ?? []
  }
  const add: SheetMutationJson = { id: 'sheet.mutation.add-table', params: { unitId: U, subUnitId: S, tableId: 't1', name: 'Budget', range: { startRow: 0, endRow: 4, startColumn: 0, endColumn: 2 }, header: ['Line', 'Qty', 'Each'], options: {} } }

  it.each(['tcsheet', 'lifeos'] as const)('%s: made, kept through a cold load, renamed, removed, and brought back by a restore', async (kind) => {
    const store = await storeOf(kind)
    const host = hostOf(store.backend)
    const before = (await host.open(store.ref)).rev
    expect(await host.apply(store.ref, before, [add], 'owner')).toEqual({ rev: before + 1 })
    expect(tablesOf((await host.snapshotJson(store.ref)).json)).toMatchObject([{ id: 't1', name: 'Budget', range: { startRow: 0, endRow: 4, startColumn: 0, endColumn: 2 } }])
    // a cold load from the store has it
    expect(tablesOf((await hostOf(store.backend).snapshotJson(store.ref)).json)).toMatchObject([{ id: 't1', name: 'Budget' }])
    // a guest may not send it; the owner's page may
    expect(refusal([add], 'edit', true)).toBe('a guest cannot add table')
    expect(refusal([add], 'edit', false)).toBeNull()
    // removed, then restored to when it was there: it is back, by its own id and name
    const gone: SheetMutationJson = { id: 'sheet.mutation.delete-table', params: { unitId: U, subUnitId: S, tableId: 't1' } }
    expect(await host.apply(store.ref, before + 1, [gone], 'owner')).toEqual({ rev: before + 2 })
    expect(tablesOf((await host.snapshotJson(store.ref)).json)).toEqual([])
    const back = await host.restore(store.ref, before + 1, 'owner')
    expect(back.rev).toBe(before + 3)
    expect(tablesOf((await host.snapshotJson(store.ref)).json)).toMatchObject([{ id: 't1', name: 'Budget', range: { startRow: 0, endRow: 4, startColumn: 0, endColumn: 2 } }])
    // and to before it was made: gone again, in a cold host too
    await host.restore(store.ref, before, 'owner')
    expect(tablesOf((await hostOf(store.backend).snapshotJson(store.ref)).json)).toEqual([])
  })

  it('a table\'s mutation made on an older revision is not moved through rows inserted meanwhile: the client reloads', () => {
    const insert: SheetMutationJson = { id: 'sheet.mutation.insert-row', params: { unitId: U, subUnitId: S, range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 25 } } }
    expect(moveThrough([add], [insert])).toBeNull()
  })
})

describe('a snapshot cut carries the rules', () => {
  it('the 500th op cuts a snapshot that holds the rule, and a cold load from it has it', async () => {
    const store = await storeOf('lifeos')
    const host = hostOf(store.backend)
    let rev = (await host.open(store.ref)).rev
    rev = ((await host.apply(store.ref, rev, await gridPress(host, store.ref, FEATURES[0]!.steps), 'owner')) as { rev: number }).rev
    while (rev < 500) {
      const got = await host.apply(store.ref, rev, [{ id: 'sheet.mutation.set-range-values', params: { unitId: U, subUnitId: S, cellValue: { 9: { 9: { v: rev } } } } }], 'owner')
      rev = (got as { rev: number }).rev
    }
    const memory = store.backend() as MemoryBackend
    expect([...memory.snaps.keys()]).toContain(500)
    expect((resourceOf(JSON.stringify(memory.snaps.get(500)), RULE_RESOURCES.conditionalFormats) as Record<string, unknown>)[S]).toEqual([highlight])
    expect(FEATURES[0]!.read((await hostOf(store.backend).snapshotJson(store.ref)).json)).toEqual([highlight])
  }, 120_000)
})

describe('ruleMutations', () => {
  const book = (resources: Record<string, unknown>): IWorkbookData => {
    const wb = blankWorkbook(U, 'B')
    wb.resources = Object.entries(resources).map(([name, data]) => ({ name, data: JSON.stringify(data) }))
    return wb
  }
  it('nothing when the rules are the same', () => {
    const a = book({ [RULE_RESOURCES.conditionalFormats]: { [S]: [highlight] } })
    expect(ruleMutations(U, a, structuredClone(a))).toEqual([])
  })
  it("a sheet's conditional formats replaced whole, the last added first so the order comes out the same", () => {
    const second = { ...highlight, cfId: 'two' }
    const out = ruleMutations(U, book({ [RULE_RESOURCES.conditionalFormats]: { [S]: [highlight] } }), book({ [RULE_RESOURCES.conditionalFormats]: { [S]: [highlight, second] } }))
    expect(out.map((m) => [m.id, (m.params as { cfId?: string; rule?: { cfId: string } }).cfId ?? (m.params as { rule: { cfId: string } }).rule.cfId])).toEqual([
      ['sheet.mutation.delete-conditional-rule', 'hi'],
      ['sheet.mutation.add-conditional-rule', 'two'],
      ['sheet.mutation.add-conditional-rule', 'hi']
    ])
  })
  it('a sheet the current workbook no longer has is left alone', () => {
    expect(ruleMutations(U, book({}), book({ [RULE_RESOURCES.validations]: { gone: [list] } }))).toEqual([])
  })
  it('a changed name is removed and set again; a new one set; a dropped one removed', () => {
    const from = book({ [RULE_RESOURCES.definedNames]: { a: { id: 'a', name: 'A', formulaOrRefString: '1' }, b: { id: 'b', name: 'B', formulaOrRefString: '2' } } })
    const to = book({ [RULE_RESOURCES.definedNames]: { a: { id: 'a', name: 'A', formulaOrRefString: '3' }, c: { id: 'c', name: 'C', formulaOrRefString: '4' } } })
    expect(ruleMutations(U, from, to).map((m) => [m.id, (m.params as { id: string }).id])).toEqual([
      ['formula.mutation.remove-defined-name', 'a'],
      ['formula.mutation.remove-defined-name', 'b'],
      ['formula.mutation.set-defined-name', 'a'],
      ['formula.mutation.set-defined-name', 'c']
    ])
  })
})

describe('the live route and rule mutations', () => {
  const name: SheetMutationJson = { id: 'formula.mutation.set-defined-name', params: { unitId: U, id: 'n1', name: 'Rate', formulaOrRefString: 'Sheet1!$B$2' } }
  const local: SheetMutationJson = { id: 'formula.mutation.set-defined-name', params: { unitId: U, id: 'n2', name: 'Local', formulaOrRefString: 'Sheet1!$A$1', localSheetId: S } }
  const removed: SheetMutationJson = { id: 'formula.mutation.remove-defined-name', params: { unitId: U, id: 'n1', name: 'Rate', formulaOrRefString: 'Sheet1!$B$2' } }

  it('an editor may send a defined name, which has no sheet; a guest may not', () => {
    expect(refusal([name, local, removed], 'edit', false)).toBeNull()
    expect(refusal([name], 'edit', true)).toBe("a guest cannot change the workbook's names")
    expect(refusal([name], 'view', false)).toBe('this link can view, not edit')
    for (const id of WORKBOOK_MUTATIONS) expect(GUEST_OPS.has(id)).toBe(false)
  })

  it('an editor, the owner\'s own page, may add or remove a sheet and part a merge; a guest may do the last alone', () => {
    const added: SheetMutationJson = { id: 'sheet.mutation.insert-sheet', params: { unitId: U, subUnitId: 's9', index: 1, sheet: { id: 's9', name: 'More' } } }
    const gone: SheetMutationJson = { id: 'sheet.mutation.remove-sheet', params: { unitId: U, subUnitId: S } }
    const parted: SheetMutationJson = { id: 'sheet.mutation.remove-worksheet-merge', params: { unitId: U, subUnitId: S, ranges: [{ startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 }] } }
    expect(refusal([added, gone, parted], 'edit', false)).toBeNull()
    expect(refusal([parted], 'edit', true)).toBeNull()
    expect(refusal([added], 'edit', true)).not.toBeNull()
    expect(refusal([gone], 'edit', true)).not.toBeNull()
  })

  it("a defined name's shape is checked; any other mutation still names its sheet", () => {
    expect(refusal([{ id: name.id, params: { unitId: U, name: 'Rate', formulaOrRefString: 'x' } }], 'edit', false)).toBe('a defined name is an id, a name and a formula')
    expect(refusal([{ id: name.id, params: { unitId: U, id: 'n', name: 'R', formulaOrRefString: 'x', localSheetId: 7 } }], 'edit', false)).toBe("a defined name's sheet is a sheet id")
    expect(refusal([{ id: 'sheet.mutation.add-conditional-rule', params: { unitId: U, rule: highlight } }], 'edit', false)).toBe('a mutation names its sheet')
    expect(refusal([{ id: 'sheet.mutation.add-conditional-rule', params: { unitId: U, subUnitId: S, rule: highlight } }], 'edit', false)).toBeNull()
    expect(refusal([{ id: 'sheet.mutation.add-conditional-rule', params: { unitId: U, subUnitId: S, rule: highlight } }], 'edit', true)).toBe('a guest cannot add conditional rule')
  })

  const inserted: SheetMutationJson = { id: 'sheet.mutation.insert-row', params: { unitId: U, subUnitId: S, range: { startRow: 1, endRow: 1, startColumn: 0, endColumn: 19 } } }
  const values: SheetMutationJson = { id: 'sheet.mutation.set-range-values', params: { unitId: U, subUnitId: S, cellValue: { 2: { 0: { v: 9 } } } } }
  const withRanges: SheetMutationJson[] = [
    { id: 'sheet.mutation.add-conditional-rule', params: { unitId: U, subUnitId: S, rule: highlight } },
    { id: 'sheet.mutation.set-conditional-rule', params: { unitId: U, subUnitId: S, cfId: 'hi', rule: highlight } },
    { id: 'data-validation.mutation.addRule', params: { unitId: U, subUnitId: S, rule: list } },
    { id: 'data-validation.mutation.updateRule', params: { unitId: U, subUnitId: S, ruleId: 'dv-list', payload: { type: 0, payload: { type: 'list', formula1: '=$A$2:$A$4' } } } },
    { id: 'sheet.mutation.set-filter-range', params: { unitId: U, subUnitId: S, range: RANGE } },
    { id: 'sheet.mutation.set-filter-criteria', params: { unitId: U, subUnitId: S, col: 1, criteria: null } },
    { id: 'sheet.mutation.remove-filter', params: { unitId: U, subUnitId: S } },
    { id: 'sheet.mutation.mark-dirty-filter-change', params: { unitId: U, subUnitId: S, filterRange: RANGE } },
    name,
    { id: 'sheet.mutation.reorder-range', params: { unitId: U, subUnitId: S, range: RANGE, order: { 1: 2, 2: 1 } } },
    { id: 'sheet.mutation.add-table', params: { unitId: U, subUnitId: S, range: RANGE } }
  ]
  const byIdOnly: SheetMutationJson[] = [
    { id: 'sheet.mutation.delete-conditional-rule', params: { unitId: U, subUnitId: S, cfId: 'hi' } },
    { id: 'sheet.mutation.move-conditional-rule', params: { unitId: U, subUnitId: S, start: { id: 'a', type: 'before' }, end: { id: 'b', type: 'after' } } },
    { id: 'data-validation.mutation.removeRule', params: { unitId: U, subUnitId: S, ruleId: 'dv-list' } },
    removed
  ]

  it('a rule with a range, a setting or a formula is not moved through rows inserted meanwhile: null, the client reloads', () => {
    for (const m of withRanges) expect(moveThrough([m], [inserted]), m.id).toBeNull()
    // Nor is a batch that holds one beside cells that could move.
    expect(moveThrough([values, withRanges[0]!], [inserted])).toBeNull()
  })

  it('a rule named only by its id passes a structural op as it is, cells beside it still move', () => {
    expect([...MOVES_AS_IS].sort()).toEqual(byIdOnly.map((m) => m.id).sort())
    for (const m of byIdOnly) expect(moveThrough([m], [inserted]), m.id).toEqual([m])
    const moved = moveThrough([values, byIdOnly[0]!], [inserted])
    expect(moved?.[1]).toEqual(byIdOnly[0])
    expect((moved?.[0]?.params as { cellValue: Record<string, unknown> }).cellValue).toEqual({ 3: { 0: { v: 9 } } })
  })

  it('with nothing structural missed, every rule mutation passes unchanged', () => {
    const missed: SheetMutationJson[] = [values, ...byIdOnly]
    for (const m of [...withRanges, ...byIdOnly]) expect(moveThrough([m], missed)).toEqual([m])
  })
})
