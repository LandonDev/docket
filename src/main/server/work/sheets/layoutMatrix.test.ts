import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IWorkbookData } from '@univerjs/core'
import { afterAll, describe, expect, it } from 'vitest'
import { headlessSheet } from 'work-kit/sheet/engine'
import { importXlsx } from 'work-kit/sheet/xlsx'
import { SHEET_LAYOUT, type SheetLayoutControl, type SheetMutationJson, type SheetStoreKind } from '@shared/contract-work-sheets'
import { forPackage, LAYOUT_SAVED, sheetStopWords } from '@shared/work/sheets'
import { blankWorkbook, TcsheetBackend, type Op, type SheetBackend, type StoredSuggestion } from './host/backends'
import { SheetHost } from './host/host'
import type { SheetRef } from './host/wire'
import { ensurePackageTables, PackageStore } from './packages'
import { localJobs } from './workerClient'
import { writeXlsx } from './writer'

/**
 * The layout's matrix: Freeze, Hide and Unhide, and the tabs' order are offered on a store only where its change
 * survives (`SHEET_LAYOUT`, the host's word in `view.layout`). For every control a store lists, with the real parts:
 *
 *   a sheet the service holds (a .tcsheet, a LifeOS sheet): the grid emits the change, the service's engine takes it,
 *   a cold load shows it, and the Excel export holds it, read back by the importer;
 *   an opened Excel file: the grid emits it, the package store writes it with the patch writer, and the file read again
 *   shows it, every value the file held still there.
 *
 * Where a store keeps none (a .csv, a workbook Excel or Google holds), the change is refused in words as he makes it.
 */

/** A store kept in memory the way LifeOS keeps a sheet: a snapshot, ops compare-and-set on rev (as rowMatrix.test.ts's). */
class MemoryBackend implements SheetBackend {
  ops: Op[] = []
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
    this.snaps.set(rev, data)
  }
  async snapshotAt(rev: number) {
    const best = Math.max(...[...this.snaps.keys()].filter((r) => r <= rev))
    return { rev: best, data: structuredClone(this.snaps.get(best)!) }
  }
  async suggestions(): Promise<StoredSuggestion[]> {
    return []
  }
  async addSuggestions() {}
  async setSuggestions() {}
}

const scratch = mkdtempSync(join(tmpdir(), 'sheets-layout-matrix-'))
const hosts: SheetHost[] = []
afterAll(() => {
  for (const h of hosts) h.close()
  rmSync(scratch, { recursive: true, force: true })
})

type Book = ReturnType<typeof headlessSheet>['workbook']

/** What a control changes, as the grid makes it (Univer's own commands, the ones work-kit's `handle.layout` runs), and what then holds. */
interface Press {
  what: string
  /** `other` is the name of a second sheet the book has */
  make(book: Book, other: string): void
  want: Partial<Layout>
}

interface Layout {
  freeze: { rows: number; columns: number }
  hiddenRows: number[]
  hiddenColumns: number[]
  order: string[]
}

/** The first sheet's frozen pane, its hidden rows and columns, and the sheets' names in order. */
function layoutOf(wb: IWorkbookData): Layout {
  const first = wb.sheets[wb.sheetOrder[0]!]!
  const freeze = first.freeze
  const hd = (data: Record<string, { hd?: number } | undefined> | undefined) =>
    Object.entries(data ?? {}).filter(([, d]) => d?.hd).map(([k]) => Number(k)).sort((a, b) => a - b)
  return {
    freeze: { rows: Math.max(0, freeze?.ySplit ?? 0), columns: Math.max(0, freeze?.xSplit ?? 0) },
    hiddenRows: hd(first.rowData as never),
    hiddenColumns: hd(first.columnData as never),
    order: wb.sheetOrder.map((id) => wb.sheets[id]!.name!)
  }
}

const PRESSES: Record<SheetLayoutControl, Press[]> = {
  freeze: [
    { what: 'the rows above and the columns left of B2', make: (book) => void book.getActiveSheet().setFreeze({ xSplit: 1, ySplit: 1, startRow: 1, startColumn: 1 }), want: { freeze: { rows: 1, columns: 1 } } },
    { what: 'the top row alone', make: (book) => void book.getActiveSheet().setFreeze({ xSplit: 0, ySplit: 1, startRow: 1, startColumn: -1 }), want: { freeze: { rows: 1, columns: 0 } } },
    {
      what: 'unfrozen again',
      make: (book) => {
        book.getActiveSheet().setFreeze({ xSplit: 2, ySplit: 3, startRow: 3, startColumn: 2 })
        book.getActiveSheet().cancelFreeze()
      },
      want: { freeze: { rows: 0, columns: 0 } }
    }
  ],
  hide: [
    {
      what: 'rows and a column hidden',
      make: (book) => {
        book.getActiveSheet().hideRows(1, 2)
        book.getActiveSheet().hideColumns(1, 1)
      },
      want: { hiddenRows: [1, 2], hiddenColumns: [1] }
    },
    {
      what: 'a row shown again',
      make: (book) => {
        book.getActiveSheet().hideRows(1, 2)
        book.getActiveSheet().showRows(2, 1)
      },
      want: { hiddenRows: [1], hiddenColumns: [] }
    }
  ],
  order: [
    {
      what: 'the second sheet dragged first',
      make: (book, other) => void book.moveSheet(book.getSheetByName(other)!, 0),
      want: {}
    }
  ]
}

interface Store {
  kind: SheetStoreKind
  ref: SheetRef
  backend(): SheetBackend
}

let n = 0
/** A store the service holds, with a few cells and two sheets in it. */
async function storeOf(kind: 'tcsheet' | 'lifeos'): Promise<Store> {
  const seed = blankWorkbook('workbook', 'Budget')
  seed.sheets.sheet1!.cellData = { 0: { 0: { v: 'Item' }, 1: { v: 'Amount' } }, 1: { 0: { v: 'Rent' }, 1: { v: 1200 } }, 2: { 0: { v: 'Total' }, 1: { f: '=B2*2' } } }
  if (kind === 'lifeos') {
    seed.sheets.sheet2 = { ...structuredClone(seed.sheets.sheet1!), id: 'sheet2', name: 'Roster', cellData: { 0: { 0: { v: 'Name' } } } }
    seed.sheetOrder = ['sheet1', 'sheet2']
    const memory = new MemoryBackend(seed)
    return { kind, ref: { lifeos: `sheet${++n}` }, backend: () => memory }
  }
  const path = join(scratch, `${++n}.tcsheet`)
  TcsheetBackend.create(path, 'Budget')
  const host = new SheetHost(() => new TcsheetBackend(path))
  hosts.push(host)
  const ref: SheetRef = { tcsheet: path }
  // Seeded through the engine, as any write: the cells, then a second sheet as a grid adds one (its own mutations).
  await host.apply(ref, 0, [{ id: 'sheet.mutation.set-range-values', params: { unitId: 'workbook', subUnitId: 'sheet1', cellValue: seed.sheets.sheet1!.cellData } }], 'owner')
  host.close()
  const store: Store = { kind, ref, backend: () => new TcsheetBackend(path) }
  const { grid, emitted, rev } = await gridOn(store)
  grid.workbook.insertSheet('Roster')
  const adding = new SheetHost(() => store.backend())
  hosts.push(adding)
  await adding.apply(ref, rev, emitted, 'owner')
  adding.close()
  grid.dispose()
  return store
}

/** The grid on the store's workbook, and every mutation a change in it emits. */
async function gridOn(store: Store) {
  const loaded = await store.backend().load()
  const ops = await store.backend().opsAfter(loaded.snapRev)
  const grid = headlessSheet('work', loaded.snapshot)
  for (const op of ops) for (const m of op.mutations) grid.api.syncExecuteCommand(m.id, m.params as object, { fromCollab: true })
  const emitted: SheetMutationJson[] = []
  grid.api.addEvent(grid.api.Event.CommandExecuted, (event) => {
    if (event.type === 2 && !event.options?.fromCollab && !event.options?.onlyLocal && event.id.startsWith('sheet.mutation.')) emitted.push({ id: event.id, params: event.params })
  })
  return { grid, emitted, rev: loaded.rev }
}

const expectLayout = (got: Layout, want: Layout) => expect(got).toEqual(want)

describe.each(['tcsheet', 'lifeos'] as const)('the layout on a %s', (kind) => {
  it('lists Freeze, Hide and the tabs\' order: the service keeps a sheet it holds whole', () => {
    expect([...SHEET_LAYOUT[kind]].sort()).toEqual(['freeze', 'hide', 'order'])
  })

  for (const control of SHEET_LAYOUT[kind]) {
    it.each(PRESSES[control])(`${control}, $what: the grid emits it, the engine replays it, a cold load shows it, the export holds it`, async (press) => {
      const store = await storeOf(kind)
      const { grid, emitted, rev } = await gridOn(store)
      try {
        const before = layoutOf(grid.workbook.save())
        press.make(grid.workbook, 'Roster')
        expect(emitted.length).toBeGreaterThan(0)
        for (const m of emitted) expect(LAYOUT_SAVED[m.id], m.id).toBe(control)
        const want = layoutOf(grid.workbook.save())
        expect(want).toMatchObject(press.want)
        if (control === 'order') expect(want.order).toEqual(['Roster', before.order[0]])
        if (press.what !== 'unfrozen again') expect(want).not.toEqual(before)

        const live = new SheetHost(() => store.backend())
        hosts.push(live)
        const took = await live.apply(store.ref, rev, emitted, 'owner')
        expect('conflict' in took ? 'conflict' : 'landed').toBe('landed')
        expectLayout(layoutOf(JSON.parse((await live.snapshotJson(store.ref)).json) as IWorkbookData), want)
        live.close()

        const cold = new SheetHost(() => store.backend())
        hosts.push(cold)
        const reloaded = JSON.parse((await cold.snapshotJson(store.ref)).json) as IWorkbookData
        expectLayout(layoutOf(reloaded), want)
        cold.close()

        const { workbook: exported } = importXlsx(writeXlsx(reloaded))
        expectLayout(layoutOf(exported), want)
        expect(exported.sheets[exported.sheetOrder.find((id) => exported.sheets[id]!.name === before.order[0])!]!.cellData?.[1]?.[1]?.v).toBe(1200)
      } finally {
        grid.dispose()
      }
    })
  }
})

describe('the layout on an opened Excel file', () => {
  const CORPUS = join(import.meta.dirname, 'harness/corpus')
  let k = 0
  async function opened() {
    const dir = join(scratch, `pkg${++k}`)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'Budget.xlsx')
    copyFileSync(join(CORPUS, 'patch/base.xlsx'), path)
    const db = new DatabaseSync(':memory:')
    ensurePackageTables(db)
    const store = new PackageStore(db, await localJobs(), join(dir, 'copies'), () => null)
    await store.open(path)
    const read = () => importXlsx(new Uint8Array(readFileSync(path))).workbook
    const grid = headlessSheet('work', read())
    const emitted: SheetMutationJson[] = []
    grid.api.addEvent(grid.api.Event.CommandExecuted, (event) => {
      if (event.type === 2 && !event.options?.fromCollab && !event.options?.onlyLocal && event.id.startsWith('sheet.mutation.')) emitted.push({ id: event.id, params: event.params })
    })
    return { path, store, grid, emitted, read }
  }

  it('lists what a sheet the service holds lists: the patch writer writes each', () => {
    expect([...SHEET_LAYOUT.package].sort()).toEqual([...SHEET_LAYOUT.tcsheet].sort())
  })

  for (const control of SHEET_LAYOUT.package) {
    it.each(PRESSES[control])(`${control}, $what: the grid emits it, the file takes it, and the file read again shows it`, async (press) => {
      const { path, store, grid, emitted, read } = await opened()
      try {
        const before = read()
        press.make(grid.workbook, 'Untouched')
        expect(emitted.length).toBeGreaterThan(0)
        // what the canvas sends for this file: every mutation kept where the host lists the control
        for (const m of emitted) expect(forPackage(m, () => null, { formats: true, layout: SHEET_LAYOUT.package })).toEqual({ keep: [m] })
        const want = layoutOf(grid.workbook.save())
        if (control === 'order') expect(want.order).toEqual(['Untouched', 'Data'])
        expect(await store.edit(path, 0, emitted, 'owner')).toEqual({ rev: 1 })
        const after = read()
        expectLayout(layoutOf(after), want)
        // nothing else changed: every value each sheet held, it holds
        const values = (wb: IWorkbookData) =>
          Object.fromEntries(wb.sheetOrder.map((id) => [wb.sheets[id]!.name, JSON.stringify(Object.entries(wb.sheets[id]!.cellData ?? {}).map(([r, cols]) => [r, Object.entries((cols ?? {}) as Record<string, { v?: unknown; f?: unknown } | null>).map(([c, cell]) => [c, cell?.v ?? null, cell?.f ?? null])]))]))
        expect(values(after)).toEqual(values(before))
      } finally {
        grid.dispose()
      }
    })
  }
})

describe('where a store keeps none, the change is refused in words', () => {
  const at = (id: string): SheetMutationJson => ({ id, params: { unitId: 'b', subUnitId: 's1', ranges: [{ startRow: 1, endRow: 1, startColumn: 0, endColumn: 0 }], xSplit: 1, ySplit: 1, fromOrder: 1, toOrder: 0 } })

  it('a .csv lists none', () => {
    expect(SHEET_LAYOUT.csv).toEqual([])
  })

  it('a workbook Excel or Google holds (a package with no layout): each is stopped as he makes it, and said', () => {
    for (const id of Object.keys(LAYOUT_SAVED)) {
      expect(forPackage(at(id), () => null, { formats: false }), id).toEqual({ stop: sheetStopWords('other') })
      expect(forPackage(at(id), () => null, { formats: false, google: true }), id).toEqual({ stop: sheetStopWords('other', true) })
    }
  })

  it('a host that lists only some keeps only those', () => {
    expect(forPackage(at('sheet.mutation.set-frozen'), () => null, { layout: ['hide'] })).toEqual({ stop: sheetStopWords('other') })
    expect(forPackage(at('sheet.mutation.set-row-hidden'), () => null, { layout: ['hide'] })).toEqual({ keep: [at('sheet.mutation.set-row-hidden')] })
  })
})
