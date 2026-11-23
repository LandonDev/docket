import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IUniverInstanceService, type IStyleData, type IWorkbookData } from '@univerjs/core'
import { afterAll, describe, expect, it } from 'vitest'
import { TEMPCODE_THEME } from 'work-kit/format/theme'
import { headlessSheet } from 'work-kit/sheet/engine'
import { applyFormat, cellStyleOf, readFormat, type SheetFormat } from 'work-kit/sheet/format'
import { importXlsx } from 'work-kit/sheet/xlsx'
import { SHEET_ROW, type SheetFormatControl, type SheetMutationJson, type SheetStoreKind } from '@shared/contract-work-sheets'
import { GUEST_ROW } from '@shared/work/sheets'
import { blankWorkbook, TcsheetBackend, type Op, type SheetBackend, type StoredSuggestion } from './host/backends'
import { FORMAT_RANGES_MAX, GUEST_OPS, guestCells, refusal, SIZE_MAX } from './host/live'
import { SheetHost } from './host/host'
import type { SheetRef } from './host/wire'
import { ensurePackageTables, PackageStore } from './packages'
import { localJobs } from './workerClient'
import { writeXlsx } from './writer'

/**
 * The format row's matrix (the editors plan, SHT1.2): a control is drawn on a store only where
 * its change survives. For every control `SHEET_ROW` lists for a store, four things are held
 * here with the real parts, no fakes:
 *
 *   1. the grid emits a mutation for the press (a headless Univer, work-kit's own `applyFormat`);
 *   2. the service's real engine (`SheetHost`) takes it into the store;
 *   3. a cold load (a second `SheetHost` over the same store) shows it;
 *   4. the Excel export (the model writer) holds it, read back by the importer.
 *
 * A store with no row is held too: its list is empty, so nothing is drawn there.
 *
 * The `.tcsheet` leg is the real backend over a real file. The LifeOS leg is a stand-in that
 * keeps a snapshot and ops as LifeOS does (ops are opaque JSON to it): `LifeosBackend`'s own
 * calls are held against a fake Convex in host/host.test.ts.
 */

/** A store kept in memory the way LifeOS keeps a sheet: a snapshot, ops compare-and-set on rev. */
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
    this.snaps.set(rev, data)
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

const scratch = mkdtempSync(join(tmpdir(), 'sheets-row-matrix-'))
const hosts: SheetHost[] = []
afterAll(() => {
  for (const h of hosts) h.close()
  rmSync(scratch, { recursive: true, force: true })
})

/** One thing a control can do: the presses that make it (the last is the one under test), and what must then be true. */
interface Press {
  what: string
  steps: SheetFormat[]
  /** the merges the sheet then has; absent, none */
  merges?: string[]
  /** the look of A1 the press must leave, where it is worth pinning; `plain` is no formatting at all */
  a1?: Partial<ReturnType<typeof look>> | 'plain'
  /** the same for A2, the selection's last row, where a preset's mark falls */
  a2?: Partial<ReturnType<typeof look>>
}

/** Everything the row can press, by the control that carries it: a control is kept only if each of these survives. */
const PRESSES: Record<Exclude<SheetFormatControl, 'undo'>, Press[]> = {
  style: [
    { what: 'Heading 1', steps: [{ style: 'heading1' }], a1: { style: 'heading1', bold: true, size: 15, borders: 'b13' } },
    { what: 'Total, a thin top and a double bottom in the theme\'s accent', steps: [{ style: 'total' }], a1: { style: 'total', borders: 't1 b7' } },
    { what: 'Input, a fill and four grey edges', steps: [{ style: 'input' }], a1: { style: 'input', fill: { hex: '#FFCC99' }, colour: { hex: '#3F3F76' }, borders: 't1 b1 l1 r1' } },
    { what: 'Note', steps: [{ style: 'note' }], a1: { style: 'note', fill: { hex: '#FFFFCC' } } },
    { what: 'Currency, a number format alone', steps: [{ bold: true }, { style: 'currency' }], a1: { style: 'currency', bold: true } },
    { what: 'a style over borders replaces every edge', steps: [{ borders: 'all' }, { style: 'heading2' }], a1: { style: 'heading2', borders: 'b13' } },
    { what: 'Clear formatting', steps: [{ bold: true, fill: { hex: '#FFDD66' }, pattern: '0.00', borders: 'all' }, { clear: true }], a1: 'plain' }
  ],
  font: [{ what: 'a family', steps: [{ family: 'Cambria' }], a1: { family: 'Cambria' } }],
  size: [{ what: 'a size', steps: [{ size: 14 }], a1: { size: 14 } }],
  bold: [
    { what: 'bold', steps: [{ bold: true }], a1: { bold: true } },
    { what: 'bold off again', steps: [{ bold: true }, { bold: false }], a1: 'plain' },
    { what: 'strikethrough, its key in the grid', steps: [{ strike: true }], a1: { strike: true } }
  ],
  italic: [{ what: 'italic', steps: [{ italic: true }], a1: { italic: true } }],
  underline: [{ what: 'underline', steps: [{ underline: true }], a1: { underline: true } }],
  colour: [
    { what: 'a theme colour with its tint', steps: [{ colour: { theme: 'accent1', tint: -0.25 } }], a1: { colour: { theme: 'accent1', tint: -0.25 } } },
    { what: 'a plain hex', steps: [{ colour: { hex: '#C00000' } }], a1: { colour: { hex: '#C00000' } } },
    { what: 'back to automatic', steps: [{ colour: { hex: '#C00000' } }, { colour: null }], a1: 'plain' }
  ],
  fill: [
    { what: 'a theme colour with its tint', steps: [{ fill: { theme: 'accent4', tint: 0.8 } }], a1: { fill: { theme: 'accent4', tint: 0.8 } } },
    { what: 'a plain hex', steps: [{ fill: { hex: '#FFDD66' } }], a1: { fill: { hex: '#FFDD66' } } },
    { what: 'no fill', steps: [{ fill: { hex: '#FFDD66' } }, { fill: null }], a1: 'plain' }
  ],
  align: [{ what: 'right', steps: [{ align: 'right' }], a1: { align: 'right' } }],
  vertical: [{ what: 'middle', steps: [{ vertical: 'middle' }], a1: { vertical: 'middle' } }],
  wrap: [{ what: 'wrap', steps: [{ wrap: true }], a1: { wrap: true } }],
  merge: [
    { what: 'merge', steps: [{ merge: true }], merges: ['0,0,1,1'] },
    { what: 'unmerge', steps: [{ merge: true }, { merge: false }], merges: [] }
  ],
  borders: [
    { what: 'outside', steps: [{ borders: 'outside' }], a1: { borders: 't1 l1' }, a2: { borders: 'b1 l1' } },
    { what: 'all', steps: [{ borders: 'all' }], a1: { borders: 't1 b1 l1 r1' } },
    { what: 'top and double bottom', steps: [{ borders: 'topDoubleBottom' }], a1: { borders: 't1' }, a2: { borders: 'b7' } },
    { what: 'bottom', steps: [{ borders: 'bottom' }], a1: 'plain', a2: { borders: 'b1' } },
    { what: 'none', steps: [{ borders: 'all' }, { borders: 'none' }], a1: 'plain' }
  ],
  number: [
    { what: 'a format from the list', steps: [{ pattern: '"$"#,##0.00' }], a1: { pattern: '"$"#,##0.00' } },
    { what: 'one more decimal', steps: [{ pattern: '"$"#,##0.00' }, { decimals: 1 }], a1: { pattern: '"$"#,##0.000' } },
    { what: 'one fewer on Accounting, whose zero keeps its room', steps: [{ pattern: '_("$"* #,##0.00_);_("$"* (#,##0.00);_("$"* "-"??_);_(@_)' }, { decimals: -1 }], a1: { pattern: '_("$"* #,##0.0_);_("$"* (#,##0.0);_("$"* "-"?_);_(@_)' } },
    { what: 'a code of his own', steps: [{ pattern: '0.0 "kg"' }], a1: { pattern: '0.0 "kg"' } },
    { what: 'back to General', steps: [{ pattern: '0.00' }, { pattern: '' }], a1: 'plain' }
  ]
}

interface Store {
  kind: SheetStoreKind
  ref: SheetRef
  backend(): SheetBackend
}

let n = 0
/** A fresh store of each kind the service holds, with a few cells in it. */
async function storeOf(kind: SheetStoreKind): Promise<Store> {
  const seed = blankWorkbook('workbook', 'Budget')
  seed.sheets.sheet1!.cellData = { 0: { 0: { v: 'Item' }, 1: { v: 'Amount' } }, 1: { 0: { v: 'Rent' }, 1: { v: 1200 } }, 2: { 0: { v: 'Total' }, 1: { f: '=B2*2' } } }
  if (kind === 'lifeos') {
    const memory = new MemoryBackend(seed)
    return { kind, ref: { lifeos: `sheet${++n}` }, backend: () => memory }
  }
  const path = join(scratch, `${++n}.tcsheet`)
  TcsheetBackend.create(path, 'Budget')
  // Seeded through the engine, as any write: the store has it before the presses.
  const host = new SheetHost(() => new TcsheetBackend(path))
  hosts.push(host)
  const ref: SheetRef = { tcsheet: path }
  await host.apply(ref, 0, [{ id: 'sheet.mutation.set-range-values', params: { unitId: 'workbook', subUnitId: 'sheet1', cellValue: seed.sheets.sheet1!.cellData } }], 'owner')
  host.close()
  // A new backend each time it is asked for: a cold load reads the file itself.
  return { kind, ref, backend: () => new TcsheetBackend(path) }
}

/** The grid: a headless Univer on the store's workbook with A1:B2 selected, and what a press emits. */
async function gridOn(store: Store) {
  const loaded = await store.backend().load()
  const ops = await store.backend().opsAfter(loaded.snapRev)
  const grid = headlessSheet('work', loaded.snapshot)
  for (const op of ops) for (const m of op.mutations) grid.api.syncExecuteCommand(m.id, m.params as object, { fromCollab: true })
  const emitted: SheetMutationJson[] = []
  grid.api.addEvent(grid.api.Event.CommandExecuted, (event) => {
    if (event.type === 2 && !event.options?.fromCollab && !event.options?.onlyLocal && event.id.startsWith('sheet.mutation.')) emitted.push({ id: event.id, params: event.params })
  })
  grid.workbook.getActiveSheet().getRange('A1:B2').activate()
  return { grid, emitted, rev: loaded.rev }
}

const styleAt = (wb: IWorkbookData, row: number, col: number): IStyleData => {
  const sheet = wb.sheets[wb.sheetOrder[0]!]!
  const s = sheet.cellData?.[row]?.[col]?.s
  return ((typeof s === 'string' ? wb.styles?.[s] : s) ?? {}) as IStyleData
}
const merges = (wb: IWorkbookData): string[] => (wb.sheets[wb.sheetOrder[0]!]!.mergeData ?? []).map((m) => `${m.startRow},${m.startColumn},${m.endRow},${m.endColumn}`)
/** A cell as the row would read it, plus its border edges and where they are heavy: what must survive. */
const look = (wb: IWorkbookData, row: number, col: number) => {
  const style = styleAt(wb, row, col)
  const bd = (style.bd ?? {}) as Record<string, { s?: number } | null | undefined>
  return { ...readFormat(style, TEMPCODE_THEME), borders: ['t', 'b', 'l', 'r'].filter((k) => bd[k]?.s).map((k) => `${k}${bd[k]!.s}`).join(' ') }
}

/** The selection the presses act on, A1:B2, cell by cell. */
const CELLS = [[0, 0], [0, 1], [1, 0], [1, 1]] as const
/** A cell with no formatting, as `look` reads it. */
const PLAIN = look(blankWorkbook('x', 'x'), 0, 0)

describe.each(['tcsheet', 'lifeos'] as const)('the format row on a %s', (kind) => {
  it('lists every control: the service keeps a sheet it holds whole', () => {
    // (the Data menu's rows are listed after these: rulesMatrix.test.ts)
    expect(SHEET_ROW[kind].filter((c) => c === 'undo' || c in PRESSES).sort()).toEqual(['align', 'bold', 'borders', 'colour', 'fill', 'font', 'italic', 'merge', 'number', 'size', 'style', 'underline', 'undo', 'vertical', 'wrap'])
  })

  for (const control of SHEET_ROW[kind].filter((c): c is Exclude<SheetFormatControl, 'undo'> => c !== 'undo' && c in PRESSES)) {
    it.each(PRESSES[control])(`${control}, $what: the grid emits it, the engine replays it, a cold load shows it, the export holds it`, async (press) => {
      const store = await storeOf(kind)
      const { grid, emitted, rev } = await gridOn(store)
      try {
        // 1. the presses, in the grid
        for (const step of press.steps) {
          const before = emitted.length
          expect(applyFormat(grid.api, step, TEMPCODE_THEME)).toBe(true)
          expect(emitted.length, `the grid emitted nothing for ${JSON.stringify(step)}`).toBeGreaterThan(before)
        }
        const made = grid.workbook.save()
        const want = CELLS.map(([r, c]) => look(made, r, c))
        const wantMerges = merges(made)
        expect(wantMerges).toEqual(press.merges ?? [])
        if (press.a1 === 'plain') expect(want[0]).toEqual(PLAIN)
        else if (press.a1) expect(want[0]).toMatchObject(press.a1)
        if (press.a2) expect(want[2]).toMatchObject(press.a2)
        // a press that is not a merge or a way back to plain left a mark to follow through the store
        if (!press.merges && press.a1 !== 'plain') expect(want).not.toEqual(CELLS.map(() => PLAIN))

        // 2. the service's engine takes it
        const live = new SheetHost(() => store.backend())
        hosts.push(live)
        const took = await live.apply(store.ref, rev, emitted, 'owner')
        expect('conflict' in took ? 'conflict' : 'landed').toBe('landed')
        const warm = JSON.parse((await live.snapshotJson(store.ref)).json) as IWorkbookData
        expect(CELLS.map(([r, c]) => look(warm, r, c))).toEqual(want)
        expect(merges(warm)).toEqual(wantMerges)
        live.close()

        // 3. a cold load: another engine over the same store
        const cold = new SheetHost(() => store.backend())
        hosts.push(cold)
        const reloaded = JSON.parse((await cold.snapshotJson(store.ref)).json) as IWorkbookData
        expect(CELLS.map(([r, c]) => look(reloaded, r, c))).toEqual(want)
        expect(merges(reloaded)).toEqual(wantMerges)
        // the value under the formatting is what it was (a merge keeps its first cell's)
        expect(reloaded.sheets.sheet1!.cellData?.[0]?.[0]?.v).toBe('Item')
        cold.close()

        // 4. the Excel export holds it: read back, each cell looks the same and wears the same named style
        const { workbook: exported } = importXlsx(writeXlsx(reloaded))
        expect(CELLS.map(([r, c]) => look(exported, r, c))).toEqual(want)
        expect(merges(exported)).toEqual(wantMerges)
        expect(exported.sheets[exported.sheetOrder[0]!]!.cellData?.[0]?.[0]?.v).toBe('Item')
      } finally {
        grid.dispose()
      }
    })
  }

  it('undo: what it takes back is taken back in the store too', async () => {
    const store = await storeOf(kind)
    const { grid, emitted, rev } = await gridOn(store)
    try {
      // Undo belongs to the workbook in hand, which a headless grid must be told.
      grid.univer.__getInjector().get(IUniverInstanceService).focusUnit('workbook')
      applyFormat(grid.api, { bold: true, fill: { hex: '#FFDD66' } }, TEMPCODE_THEME)
      expect(await grid.api.undo()).toBe(true)
      expect(emitted.length).toBeGreaterThanOrEqual(2)
      const host = new SheetHost(() => store.backend())
      hosts.push(host)
      await host.apply(store.ref, rev, emitted, 'owner')
      host.close()
      const cold = new SheetHost(() => store.backend())
      hosts.push(cold)
      const reloaded = JSON.parse((await cold.snapshotJson(store.ref)).json) as IWorkbookData
      expect(cellStyleOf(styleAt(reloaded, 0, 0), TEMPCODE_THEME)).toBe('normal')
      cold.close()
    } finally {
      grid.dispose()
    }
  })
})

/**
 * An opened Excel file: the grid is the file as the importer reads it, the press goes to the
 * package store, which saves it into the file with the patch writer, and the file read again is
 * both the cold load and what Excel opens.
 */
/**
 * A guest with an Edit link gets the row too (`GUEST_ROW`, the hosted page). Every press of every
 * control it lists must pass the live route's guest check as the route applies it (`guestCells`,
 * then `refusal`), and land in the host as the grid drew it; and the list names nothing the
 * route would refuse.
 */
describe('the format row for a guest with an Edit link', () => {
  it('lists the format controls and no Data control', () => {
    expect([...GUEST_ROW].sort()).toEqual(['align', 'bold', 'borders', 'colour', 'fill', 'font', 'italic', 'merge', 'number', 'size', 'style', 'underline', 'undo', 'vertical', 'wrap'])
    for (const control of GUEST_ROW) expect(SHEET_ROW.tcsheet).toContain(control)
  })

  for (const control of GUEST_ROW.filter((c): c is Exclude<SheetFormatControl, 'undo'> => c !== 'undo')) {
    it.each(PRESSES[control])(`${control}, $what: the route lets a guest send it, and the host holds it`, async (press) => {
      const store = await storeOf('tcsheet')
      const { grid, emitted, rev } = await gridOn(store)
      try {
        for (const step of press.steps) expect(applyFormat(grid.api, step, TEMPCODE_THEME)).toBe(true)
        expect(emitted.length).toBeGreaterThan(0)
        for (const m of emitted) expect(GUEST_OPS.has(m.id), m.id).toBe(true)
        const sent = guestCells(emitted)
        expect(refusal(sent, 'edit', true)).toBeNull()
        const made = grid.workbook.save()
        const live = new SheetHost(() => store.backend())
        hosts.push(live)
        const took = await live.apply(store.ref, rev, sent, 'guest:L1')
        expect('conflict' in took ? 'conflict' : 'landed').toBe('landed')
        const held = JSON.parse((await live.snapshotJson(store.ref)).json) as IWorkbookData
        // what a guest's cells are cut down to (values, formulas, styles, types) loses nothing of the press
        expect(CELLS.map(([r, c]) => look(held, r, c))).toEqual(CELLS.map(([r, c]) => look(made, r, c)))
        expect(merges(held)).toEqual(merges(made))
      } finally {
        grid.dispose()
      }
    })
  }

  it('a width, a height and a row told to fit pass; and an undo of each, which gives every column its own back', async () => {
    const store = await storeOf('tcsheet')
    const { grid, emitted, rev } = await gridOn(store)
    try {
      const sheet = grid.workbook.getActiveSheet()
      sheet.setColumnWidths(0, 2, 160)
      sheet.setRowHeights(0, 2, 40)
      sheet.setRowAutoHeight(0, 1)
      await grid.api.undo()
      await grid.api.undo()
      await grid.api.undo()
      expect(new Set(emitted.map((m) => m.id))).toEqual(new Set(['sheet.mutation.set-worksheet-col-width', 'sheet.mutation.set-worksheet-row-height', 'sheet.mutation.set-worksheet-row-is-auto-height']))
      expect(refusal(guestCells(emitted), 'edit', true)).toBeNull()
      const live = new SheetHost(() => store.backend())
      hosts.push(live)
      expect('conflict' in (await live.apply(store.ref, rev, guestCells(emitted), 'guest:L1'))).toBe(false)
    } finally {
      grid.dispose()
    }
  })

  it('holds a guest\'s sizes and merges to the sheet as it stands: nothing past its end, no merge over a merged cell', async () => {
    const store = await storeOf('tcsheet')
    const live = new SheetHost(() => store.backend())
    hosts.push(live)
    const rev = (await store.backend().load()).rev
    const at = (id: string, params: Record<string, unknown>): SheetMutationJson => ({ id, params: { unitId: 'workbook', subUnitId: 'sheet1', ...params } })
    const guest = (m: SheetMutationJson[]) => live.apply(store.ref, rev, guestCells(m), 'guest:L1')
    // one height over every row a grid can have passes the route's shape check, and is refused by the sheet's own size
    const everyRow = [at('sheet.mutation.set-worksheet-row-height', { ranges: [{ startRow: 0, endRow: 1_048_575, startColumn: 0, endColumn: 0 }], rowHeight: 40 })]
    expect(refusal(everyRow, 'edit', true)).toBeNull()
    await expect(guest(everyRow)).rejects.toThrow('that range runs past the end of the sheet')
    await expect(guest([at('sheet.mutation.set-worksheet-col-width', { ranges: [{ startRow: 0, endRow: 0, startColumn: 0, endColumn: 16_383 }], colWidth: 40 })])).rejects.toThrow('past the end of the sheet')
    // nothing of either was stored
    expect((await store.backend().load()).rev).toBe(rev)
    // a merge, then one over it: the second is refused; parting the first and merging wider in one batch passes
    const first = { startRow: 4, endRow: 5, startColumn: 0, endColumn: 1 }
    expect('conflict' in (await guest([at('sheet.mutation.add-worksheet-merge', { ranges: [first] })]))).toBe(false)
    const next = (await store.backend().load()).rev
    const wider = { startRow: 4, endRow: 6, startColumn: 0, endColumn: 2 }
    await expect(live.apply(store.ref, next, [at('sheet.mutation.add-worksheet-merge', { ranges: [wider] })], 'guest:L1')).rejects.toThrow('those cells overlap a merged cell')
    expect('conflict' in (await live.apply(store.ref, next, [at('sheet.mutation.remove-worksheet-merge', { ranges: [first] }), at('sheet.mutation.add-worksheet-merge', { ranges: [wider] })], 'guest:L1'))).toBe(false)
    // the owner's own grid is not held to it (its row parts merges itself)
    const own = (await store.backend().load()).rev
    const past = [at('sheet.mutation.set-worksheet-row-height', { ranges: [{ startRow: 0, endRow: 4_999, startColumn: 0, endColumn: 0 }], rowHeight: 40 })]
    await expect(live.apply(store.ref, own, past, 'guest:L1')).rejects.toThrow('past the end of the sheet')
    expect('conflict' in (await live.apply(store.ref, own, past, 'owner'))).toBe(false)
  })

  it('refuses a guest a merge or a size that is not one, and everything of the Data menu', () => {
    const S = 'sheet1'
    const at = (id: string, params: Record<string, unknown>): SheetMutationJson[] => [{ id, params: { unitId: 'workbook', subUnitId: S, ...params } }]
    const range = { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 }
    const guest = (m: SheetMutationJson[]): string | null => refusal(m, 'edit', true)
    expect(guest(at('sheet.mutation.add-worksheet-merge', { ranges: [range] }))).toBeNull()
    expect(guest(at('sheet.mutation.remove-worksheet-merge', { ranges: [range] }))).toBeNull()
    expect(guest(at('sheet.mutation.set-worksheet-col-width', { ranges: [range], colWidth: 160 }))).toBeNull()
    expect(guest(at('sheet.mutation.set-worksheet-col-width', { ranges: [range], colWidth: { 0: 88, 1: null } }))).toBeNull()
    expect(guest(at('sheet.mutation.set-worksheet-row-height', { ranges: [range], rowHeight: 40 }))).toBeNull()
    // ranges that are not ranges on the grid
    for (const ranges of [undefined, [], 'A1', [null], [{ ...range, startRow: -1 }], [{ ...range, endRow: 1.5 }], [{ ...range, startRow: 2 }], [{ ...range, endRow: 1_048_576 }], [{ ...range, endColumn: 16_384 }], Array.from({ length: FORMAT_RANGES_MAX + 1 }, () => range)])
      expect(guest(at('sheet.mutation.add-worksheet-merge', { ranges })), JSON.stringify(ranges)?.slice(0, 60)).toBe('a merge, a size change or a number format names at most 1000 ranges on the grid')
    // sizes that are not sizes
    for (const colWidth of [undefined, '160', -1, SIZE_MAX + 1, Number.NaN, [160], {}, { x: 1 }, { 0: '9' }, { 16384: 9 }, { 0: SIZE_MAX + 1 }])
      expect(guest(at('sheet.mutation.set-worksheet-col-width', { ranges: [range], colWidth })), JSON.stringify(colWidth)).toBe('a column is at most 2000 wide')
    expect(guest(at('sheet.mutation.set-worksheet-row-height', { ranges: [range], rowHeight: 1e9 }))).toBe('a row is at most 2000 tall')
    // the owner's own grid is not held to the guest's bounds
    expect(refusal(at('sheet.mutation.set-worksheet-col-width', { ranges: [range], colWidth: 5000 }), 'edit', false)).toBeNull()
    // nothing of the Data menu, no sheet added or removed, no cells moved
    for (const id of ['sheet.mutation.add-conditional-rule', 'data-validation.mutation.addRule', 'sheet.mutation.set-filter-range', 'sheet.mutation.set-filter-criteria', 'sheet.mutation.reorder-range', 'sheet.mutation.insert-sheet', 'sheet.mutation.remove-sheet', 'sheet.mutation.set-worksheet-name', 'sheet.mutation.move-range', 'sheet.mutation.move-rows', 'sheet.mutation.set-row-hidden', 'sheet.mutation.add-table', 'tempcode.sheet.rules'])
      expect(guest(at(id, {})), id).toMatch(/^a guest cannot /)
    expect(guest([{ id: 'formula.mutation.set-defined-name', params: { unitId: 'workbook', id: 'n', name: 'N', formulaOrRefString: '=1' } }])).toBe("a guest cannot change the workbook's names")
    // and the list is exactly this
    expect([...GUEST_OPS].sort()).toEqual([
      'sheet.mutation.add-worksheet-merge',
      'sheet.mutation.insert-col',
      'sheet.mutation.insert-row',
      'sheet.mutation.remove-col',
      'sheet.mutation.remove-rows',
      'sheet.mutation.remove-worksheet-merge',
      'sheet.mutation.remove.numfmt',
      'sheet.mutation.set-range-values',
      'sheet.mutation.set-worksheet-col-width',
      'sheet.mutation.set-worksheet-row-auto-height',
      'sheet.mutation.set-worksheet-row-height',
      'sheet.mutation.set-worksheet-row-is-auto-height',
      'sheet.mutation.set.numfmt'
    ])
  })
})

describe('the format row on an opened Excel file', () => {
  const CORPUS = join(import.meta.dirname, 'harness/corpus')
  let n = 0
  async function opened() {
    const dir = join(scratch, `pkg${++n}`)
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
    // cells of the file that hold values and no formatting of their own
    grid.workbook.getActiveSheet().getRange('A30:B31').activate()
    return { path, store, grid, emitted, read }
  }
  const AT = [[29, 0], [29, 1], [30, 0], [30, 1]] as const

  it('lists every control: the patch writer saves each press into the file', () => {
    expect([...SHEET_ROW.package].sort()).toEqual([...SHEET_ROW.tcsheet].sort())
  })

  for (const control of SHEET_ROW.package.filter((c): c is Exclude<SheetFormatControl, 'undo'> => c !== 'undo' && c in PRESSES)) {
    it.each(PRESSES[control])(`${control}, $what: the grid emits it, the file takes it, and the file read again shows it`, async (press) => {
      const { path, store, grid, emitted, read } = await opened()
      try {
        const theme = (read().custom as { theme: Parameters<typeof applyFormat>[2] }).theme
        const lookAt = (wb: IWorkbookData, row: number, col: number) => {
          const style = styleAt(wb, row, col)
          const bd = (style.bd ?? {}) as Record<string, { s?: number } | null | undefined>
          return { ...readFormat(style, theme!), borders: ['t', 'b', 'l', 'r'].filter((k) => bd[k]?.s).map((k) => `${k}${bd[k]!.s}`).join(' ') }
        }
        const before = read()
        for (const step of press.steps) expect(applyFormat(grid.api, step, theme)).toBe(true)
        expect(emitted.length).toBeGreaterThan(0)
        const made = grid.workbook.save()
        const want = AT.map(([r, c]) => lookAt(made, r, c))
        const got = await store.edit(path, 0, emitted, 'owner')
        expect(got).toEqual({ rev: 1 })
        const after = read()
        // the file read again: each cell looks as the grid drew it, and wears the same named style
        expect(AT.map(([r, c]) => lookAt(after, r, c))).toEqual(want)
        const mergesOf = (wb: IWorkbookData) => merges(wb).filter((m) => m.startsWith('29,') || m.startsWith('30,'))
        expect(mergesOf(after)).toEqual(press.merges ? press.merges.map(() => '29,0,30,1') : [])
        // nothing but formatting changed: every value the file held, it holds
        const first = before.sheetOrder[0]!
        // (a cell that now holds only a style is no value)
        const values = (wb: IWorkbookData) =>
          JSON.stringify(
            Object.entries(wb.sheets[first]!.cellData ?? {})
              .map(([r, cols]) => [r, Object.entries((cols ?? {}) as Record<string, { v?: unknown; f?: string | null } | null>).filter(([, cell]) => (cell?.v ?? null) !== null || !!cell?.f).map(([c, cell]) => [c, cell?.v ?? null, cell?.f ?? null])] as const)
              .filter(([, cols]) => cols.length > 0)
          )
        if (!press.merges?.length) expect(values(after)).toBe(values(before))
      } finally {
        grid.dispose()
      }
    })
  }

  it('undo: what it takes back is taken back in the file too', async () => {
    const { path, store, grid, emitted, read } = await opened()
    try {
      grid.univer.__getInjector().get(IUniverInstanceService).focusUnit(read().id)
      applyFormat(grid.api, { bold: true, fill: { hex: '#FFDD66' } }, TEMPCODE_THEME)
      expect(await grid.api.undo()).toBe(true)
      await store.edit(path, 0, emitted, 'owner')
      expect(readFormat(styleAt(read(), 29, 0), TEMPCODE_THEME)).toMatchObject({ bold: false, fill: null })
    } finally {
      grid.dispose()
    }
  })
})

describe('where a change would not be kept', () => {
  it('a sheet read from a .csv draws no row: its list has no control', () => {
    expect(SHEET_ROW.csv).toEqual([])
  })

  it('a theme colour is written as the theme colour with its tint, beside the theme itself', async () => {
    const wb = blankWorkbook('workbook', 'Budget')
    const grid = headlessSheet('work', wb)
    try {
      grid.workbook.getActiveSheet().getRange('A1').activate()
      applyFormat(grid.api, { colour: { theme: 'accent1', tint: -0.25 }, fill: { theme: 'accent4', tint: 0.8 }, bold: true }, TEMPCODE_THEME)
      grid.workbook.getActiveSheet().getRange('A1').setValue('Total')
      const bytes = writeXlsx(grid.workbook.save())
      const { readZip, readText } = await import('./patch/zip')
      const z = readZip(bytes)
      const styles = readText(z, 'xl/styles.xml')
      expect(styles).toContain('<color theme="4" tint="-0.25"/>')
      expect(styles).toContain('<fgColor theme="7" tint="0.8"/>')
      const theme = readText(z, 'xl/theme/theme1.xml')
      expect(theme).toContain('name="TempCode"')
      expect(theme).toContain(`<a:accent1><a:srgbClr val="${TEMPCODE_THEME.colours.accent1}"/></a:accent1>`)
      expect(readText(z, 'xl/_rels/workbook.xml.rels')).toContain('theme/theme1.xml')
      expect(readText(z, '[Content_Types].xml')).toContain('/xl/theme/theme1.xml')
      // read back, the colour is still that theme colour, drawn in the theme's own hex
      const { workbook } = importXlsx(bytes)
      expect(readFormat(styleAt(workbook, 0, 0), TEMPCODE_THEME)).toMatchObject({ bold: true, colour: { theme: 'accent1', tint: -0.25 }, fill: { theme: 'accent4', tint: 0.8 } })
      expect((workbook.custom as { theme: { name: string } }).theme.name).toBe('TempCode')
    } finally {
      grid.dispose()
    }
  })
})
