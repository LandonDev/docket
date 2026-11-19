import type { OfficeCell } from '@shared/contract-work-office'
import { parseAddress } from '../excel'

/**
 * A stub Office.js for the add-in's proofs: `Office` and `Excel` in the
 * shapes Microsoft documents (Excel.run, request context, load and sync,
 * proxies whose properties throw until loaded, `worksheets.onChanged` with
 * `source`, `triggerSource` and `address`), over a workbook in memory. Our
 * own writes come back as changes with `triggerSource: 'ThisLocalAddin'`, as
 * Excel's do (ExcelApi 1.14).
 */

type Cell = { v: OfficeCell; f: string }
type Handler = (e: Record<string, unknown>) => void

class NotLoaded extends Error {
  code = 'PropertyNotLoaded'
}

class Context {
  private queue: (() => void)[] = []
  readonly workbook: { worksheets: ReturnType<FakeExcelHost['worksheets']> }
  constructor(readonly host: FakeExcelHost) {
    this.workbook = { worksheets: host.worksheets(this) }
  }
  later(fn: () => void): void {
    this.queue.push(fn)
  }
  sync(): Promise<void> {
    const q = this.queue
    this.queue = []
    return Promise.resolve().then(() => {
      for (const fn of q) fn()
    })
  }
}

/** A proxy: `load` asks for properties, `sync` fills them, reading one not loaded throws. */
function proxy<T extends Record<string, unknown>>(ctx: Context, read: () => T): { load(props?: string): void } & T {
  let data: T | null = null
  const target = {
    load(_props?: string) {
      ctx.later(() => (data = read()))
    }
  }
  return new Proxy(target, {
    get(t, p) {
      if (p in t) return (t as Record<string | symbol, unknown>)[p]
      if (!data) throw new NotLoaded(`${String(p)} is not loaded`)
      return data[p as keyof T]
    }
  }) as never
}

export class FakeExcelHost {
  readonly sheets: { id: string; name: string; cells: Map<string, Cell> }[] = []
  private readonly changed = new Set<Handler>()
  private readonly outline = new Set<Handler>()
  readonly Office: Record<string, unknown>
  readonly Excel: { run<T>(fn: (ctx: Context) => Promise<T> | T): Promise<T> }

  constructor(
    readonly url: string,
    sheets: Record<string, Record<string, OfficeCell>>,
    platform: 'OfficeOnline' | 'Mac' | 'PC' = 'OfficeOnline'
  ) {
    for (const [name, cells] of Object.entries(sheets)) this.addSheet(name, cells)
    this.Office = { HostType: { Excel: 'Excel', Word: 'Word', PowerPoint: 'PowerPoint' }, context: { host: 'Excel', document: { url }, diagnostics: { platform } } }
    this.Excel = { run: (fn) => {
      const ctx = new Context(this)
      return Promise.resolve(fn(ctx)).then(async (v) => (await ctx.sync(), v))
    } }
  }

  addSheet(name: string, cells: Record<string, OfficeCell> = {}): void {
    const map = new Map<string, Cell>()
    for (const [a1, v] of Object.entries(cells)) {
      const r = parseAddress(a1)
      map.set(`${r.startRow},${r.startColumn}`, typeof v === 'string' && v.startsWith('=') ? { v: 0, f: v } : { v, f: '' })
    }
    this.sheets.push({ id: `{${this.sheets.length + 1}}`, name, cells: map })
    for (const h of this.outline) h({ type: 'WorksheetAdded' })
  }

  get(sheet: string, a1: string): OfficeCell {
    const r = parseAddress(a1)
    return this.sheet(sheet).cells.get(`${r.startRow},${r.startColumn}`)?.v ?? null
  }

  /** He types in a cell: Excel tells every add-in, with the range, as his own (`Local`) or a co-author's (`Remote`). */
  type(sheet: string, a1: string, v: OfficeCell, source: 'Local' | 'Remote' = 'Local'): void {
    this.put(sheet, a1, [[v]], source, 'Unknown')
  }

  private sheet(name: string) {
    const s = this.sheets.find((x) => x.name === name)
    if (!s) throw Object.assign(new Error(`The requested resource doesn't exist.`), { code: 'ItemNotFound' })
    return s
  }

  private put(sheet: string, address: string, grid: OfficeCell[][], source: string, triggerSource: string): void {
    const s = this.sheet(sheet)
    const r = parseAddress(address)
    grid.forEach((row, i) =>
      row.forEach((v, j) => {
        const k = `${r.startRow + i},${r.startColumn + j}`
        if (v === null || v === '') s.cells.delete(k)
        else s.cells.set(k, typeof v === 'string' && v.startsWith('=') ? { v: 0, f: v } : { v, f: '' })
      })
    )
    for (const h of this.changed) h({ type: 'WorksheetChanged', worksheetId: s.id, address, source, triggerSource, changeType: 'RangeEdited' })
  }

  worksheets(ctx: Context) {
    const host = this
    const list = proxy(ctx, () => ({ items: host.sheets.map((s) => sheetProxy(s)) }))
    const sheetProxy = (s: FakeExcelHost['sheets'][number]) => ({
      id: s.id,
      name: s.name,
      getUsedRangeOrNullObject: (_valuesOnly?: boolean) =>
        proxy(ctx, () => {
          const keys = [...s.cells.keys()].map((k) => k.split(',').map(Number))
          if (!keys.length) return { isNullObject: true, rowIndex: 0, columnIndex: 0, rowCount: 0, columnCount: 0 }
          const rows = keys.map((k) => k[0]!)
          const cols = keys.map((k) => k[1]!)
          const r0 = Math.min(...rows)
          const c0 = Math.min(...cols)
          return { isNullObject: false, rowIndex: r0, columnIndex: c0, rowCount: Math.max(...rows) - r0 + 1, columnCount: Math.max(...cols) - c0 + 1 }
        }),
      getRange(address: string) {
        const r = parseAddress(address)
        const read = () => {
          const cells = host.sheet(s.name).cells
          const grid = <T>(f: (c: Cell | undefined) => T): T[][] =>
            Array.from({ length: r.endRow - r.startRow + 1 }, (_, i) => Array.from({ length: r.endColumn - r.startColumn + 1 }, (_, j) => f(cells.get(`${r.startRow + i},${r.startColumn + j}`))))
          return { values: grid((c) => c?.v ?? ''), formulas: grid((c) => (c ? c.f || c.v : '')), numberFormat: grid(() => 'General') }
        }
        const p = proxy(ctx, read)
        return new Proxy(p, {
          set(_t, prop, value) {
            if (prop !== 'formulas' && prop !== 'values') return false
            ctx.later(() => host.put(s.name, address, value as OfficeCell[][], 'Local', 'ThisLocalAddin'))
            return true
          }
        })
      }
    })
    const event = (set: Set<Handler>) => ({
      add(h: Handler) {
        set.add(h)
        return { remove: () => set.delete(h) }
      }
    })
    return Object.assign(list, {
      getItem: (name: string) => sheetProxy(host.sheet(name)),
      onChanged: event(this.changed),
      onAdded: event(this.outline),
      onDeleted: event(this.outline)
    })
  }
}
