import { createHash, randomBytes } from 'node:crypto'
import type { SheetMutationJson } from '@shared/contract-work-sheets'
import type { CanvasSource, Principal } from '@shared/work'
import { hashCells, type SheetCell, type SheetChange, type SheetSource } from 'work-kit/sheet/source'
import type { WorkCtx } from '../modules'
import { cellName, parseA1 } from '../sheets/a1'
import { editsOf } from '../sheets/mutations'
import { SuggestionStore, type Which } from '../sheets/suggestions'
import { GOOGLE_MIME, type GoogleSheetJson } from './client'
import { googleOf } from './google'
import { watch } from './poll'

/**
 * A Google Sheet in the sheet canvas (docs/agents/work-google.md "Sheets"):
 * what the sheets pillar asks of this pillar for an item whose source is a
 * Google spreadsheet. Google is the truth; the grid loads the spreadsheet as
 * a Univer snapshot read through the Sheets API, sheet by sheet, each sheet's
 * id its tab name.
 *
 * Every write is compared first: the cells it changes are read again, and
 * if any holds something other than what the grid (or the agent) saw, the
 * write answers `conflict` and nothing goes. What passes goes as one
 * `values:batchUpdate`, one revision in Google. Suggestions over the sheet
 * wait in `work_sheets_suggestions` under `google:<fileId>`; an accepted set
 * is written as one batch. Each change, ours or one the version poll hears
 * (poll.ts), moves `rev`, and `since` answers `reload`.
 */

export interface GoogleSheetRef {
  account: string
  fileId: string
  name: string
}

export const googleSheetRefOf = (s: CanvasSource): GoogleSheetRef | null =>
  s.at === 'google' && s.mime === GOOGLE_MIME.sheet ? { account: s.account, fileId: s.fileId, name: 'Google Sheet' } : null

/** The suggestion store's key for a spreadsheet (M27's `SuggestionStore`). */
export const googleStore = (fileId: string): string => `google:${fileId}`

/** At most this many cells are loaded into the grid. */
export const GOOGLE_MAX_CELLS = 200_000

type Grid = Map<string, Map<string, SheetCell>>

interface Open {
  rev: number
  /** one per canvas item, by its id */
  listeners: Map<string, () => void>
  /** the snapshot by rev, and the cells it was made from */
  made: { rev: number; data: Buffer; grid: Grid; order: string[] } | null
}
const open = new Map<string, Open>()
const keyOf = (ref: Pick<GoogleSheetRef, 'account' | 'fileId'>) => `${ref.account.toLowerCase()}/${ref.fileId}`

function entry(ref: GoogleSheetRef): Open {
  let o = open.get(keyOf(ref))
  if (!o) open.set(keyOf(ref), (o = { rev: 1, listeners: new Map(), made: null }))
  return o
}

/** Follows the spreadsheet for the canvas item `itemId`: `onChange` after each change. Answers its rev. */
export function follow(ref: GoogleSheetRef, itemId: string, onChange: () => void): number {
  const o = entry(ref)
  o.listeners.set(itemId, onChange)
  watch(ref.account, ref.fileId, ref.name, itemId)
  return o.rev
}

export function unfollow(ref: GoogleSheetRef, itemId: string): void {
  open.get(keyOf(ref))?.listeners.delete(itemId)
}

export const revOf = (ref: GoogleSheetRef): number => open.get(keyOf(ref))?.rev ?? 1

/** The spreadsheet moved (our write, or someone's in Google): every grid on it reads it again. */
export function bump(ref: Pick<GoogleSheetRef, 'account' | 'fileId'>): void {
  const o = open.get(keyOf(ref))
  if (!o) return
  o.rev++
  o.made = null
  for (const fn of o.listeners.values()) fn()
}

/** Forgets every spreadsheet followed (Work off, or a test). */
export function unfollowAll(): void {
  open.clear()
}

/** A cell as the Sheets API gives it: what was typed, and for a formula what it shows. */
function cellOfApi(c: { userEnteredValue?: Record<string, unknown>; effectiveValue?: Record<string, unknown> } | undefined): SheetCell | null {
  const typed = c?.userEnteredValue
  if (!typed) return null
  const shown = c?.effectiveValue
  const val = (x: Record<string, unknown> | undefined) => (x ? (x.numberValue ?? x.stringValue ?? x.boolValue ?? null) : null)
  if (typeof typed.formulaValue === 'string') {
    const v = val(shown)
    return { f: typed.formulaValue, ...(v !== null ? { v: v as SheetCell['v'] } : {}) }
  }
  const v = val(typed)
  return v === null ? null : { v: v as SheetCell['v'] }
}

export function gridOf(json: GoogleSheetJson): { grid: Grid; order: string[]; sizes: Map<string, { rows: number; columns: number }>; capped: boolean; ids: Map<string, number> } {
  const grid: Grid = new Map()
  const order: string[] = []
  const ids = new Map<string, number>()
  const sizes = new Map<string, { rows: number; columns: number }>()
  let budget = GOOGLE_MAX_CELLS
  let capped = false
  for (const s of json.sheets ?? []) {
    const title: string = s.properties?.title ?? 'Sheet'
    order.push(title)
    if (typeof s.properties?.sheetId === 'number') ids.set(title, s.properties.sheetId)
    const cells = new Map<string, SheetCell>()
    grid.set(title, cells)
    let rows = 0
    let columns = 0
    for (const d of s.data ?? []) {
      const r0 = d.startRow ?? 0
      const c0 = d.startColumn ?? 0
      ;(d.rowData ?? []).forEach((row: { values?: unknown[] } | null, dr: number) =>
        (row?.values ?? []).forEach((v, dc) => {
          const cell = cellOfApi(v as never)
          if (!cell) return
          if (budget <= 0) {
            capped = true
            return
          }
          budget--
          cells.set(cellName(r0 + dr, c0 + dc), cell)
          rows = Math.max(rows, r0 + dr + 1)
          columns = Math.max(columns, c0 + dc + 1)
        })
      )
    }
    sizes.set(title, { rows, columns })
  }
  return { grid, order, sizes, capped, ids }
}

async function read(ctx: WorkCtx, ref: GoogleSheetRef): Promise<{ data: Buffer; grid: Grid; order: string[] }> {
  const json = await googleOf(ctx).api(ref.account).sheet(ref.fileId)
  const { grid, order, sizes } = gridOf(json)
  const sheets: Record<string, unknown> = {}
  for (const title of order) {
    const cellData: Record<number, Record<number, unknown>> = {}
    for (const [at, cell] of grid.get(title)!) {
      const r = parseA1(at)!
      ;(cellData[r.startRow] ??= {})[r.startColumn] = cell.f ? { f: cell.f, ...(cell.v !== undefined ? { v: cell.v } : {}) } : { v: cell.v }
    }
    const size = sizes.get(title)!
    sheets[title] = { id: title, name: title, rowCount: Math.max(size.rows + 100, 1000), columnCount: Math.max(size.columns + 10, 26), cellData }
  }
  const data = Buffer.from(JSON.stringify({ id: `google:${ref.fileId}`, name: json.properties?.title ?? ref.name, appVersion: '1.5.2', locale: 'enUS', styles: {}, sheetOrder: order, sheets }))
  return { data, grid, order }
}

/** The spreadsheet as a Univer snapshot (`IWorkbookData` as JSON bytes), as of `rev`. */
export async function snapshot(ctx: WorkCtx, ref: GoogleSheetRef, rev: number): Promise<Buffer> {
  const o = entry(ref)
  if (o.made && o.made.rev === rev) return o.made.data
  const got = await read(ctx, ref)
  o.made = { rev, ...got }
  return got.data
}

/** What Google's USER_ENTERED takes for a cell: a formula as typed, a value as itself, text that looks like a formula kept as text. */
const typed = (c: SheetCell | null): string | number | boolean => {
  if (c === null) return ''
  if (c.f) return c.f
  const v = c.v ?? ''
  return typeof v === 'string' && /^[=+\-@']/.test(v) ? `'${v}` : (v as string | number | boolean)
}
const same = (a: SheetCell | null | undefined, b: SheetCell | null | undefined): boolean => (a?.f ?? null) === (b?.f ?? null) && (a?.f ? true : (a?.v ?? null) === (b?.v ?? null))

interface CellWrite {
  sheet: string
  row: number
  col: number
  base: SheetCell | null
  value: SheetCell | null
  /** where the cell stood when the agent suggested it (`targetOf`): absent for his own edit, and for a suggestion made before round 2 */
  target?: string | null
}

/**
 * Where a cell stands, past its value: its tab's numeric id, the other cells of its row (its label and the rest of
 * its record) and its column's header (its first row's cell). A row or column inserted before it, or a tab replaced
 * under the same title, leaves a blank at the old address that a value alone would take for the blank he approved;
 * this does not. An edit elsewhere in its column changes nothing here; one in its own row does.
 *
 * A cell whose row holds nothing else is ambiguous (round 3): every blank row of an empty stretch reads alike, so a
 * blank row inserted among them cannot be seen. Its target also keeps the sheet's version then (`@<version>`), and
 * once the sheet changed anywhere it is asked for again rather than written by its address.
 */
export function targetOf(grid: Grid, ids: ReadonlyMap<string, number>, sheet: string, row: number, col: number, version?: string): string {
  const cells = grid.get(sheet) ?? new Map<string, SheetCell>()
  // Every row's other cells (all but this column), to tell this row from the rest of its tab.
  const rows = new Map<number, [number, unknown][]>()
  for (const [name, cell] of cells) {
    const at = parseA1(name)
    if (!at || at.startColumn === col) continue
    const line = rows.get(at.startRow) ?? []
    line.push([at.startColumn, cell])
    rows.set(at.startRow, line)
  }
  const lineOf = (r: number): [number, unknown][] => (rows.get(r) ?? []).sort((a, b) => a[0] - b[0])
  const said = (r: number): string => JSON.stringify(lineOf(r))
  const line = said(row)
  const header = row === 0 ? null : (cells.get(cellName(0, col)) ?? null)
  // (the same form as round 3's, so a target kept then is read as it was)
  const hash = createHash('sha256').update(JSON.stringify([ids.get(sheet) ?? null, lineOf(row), header])).digest('hex').slice(0, 32)
  // Ambiguous: a row with nothing else in it, or one that reads as another row of the tab does (round 4), since one
  // moved above the other leaves the address holding a row that reads alike.
  const ambiguous = line === '[]' || [...rows.keys()].some((r) => r !== row && said(r) === line)
  return ambiguous && version !== undefined ? `${hash}@${version}` : hash
}
/**
 * Whether a kept target still names the cell: the same place, and for an ambiguous one a sheet that has not changed.
 * A target kept with no version whose cell is ambiguous now (kept before round 4 told repeated rows apart) cannot
 * be told so, and is asked for again.
 */
const sameTarget = (kept: string, now: string, version: string): boolean => {
  const [hash, at] = kept.split('@')
  const [nowHash, nowAmbiguous] = now.split('@')
  if (hash !== nowHash) return false
  return at === undefined ? nowAmbiguous === undefined : at === version
}

/**
 * Writes cells only if each still holds `base` in Google (read again now): one batch, or nothing.
 * Answers the cells that no longer held their base.
 */
async function compareAndWrite(ctx: WorkCtx, ref: GoogleSheetRef, cells: readonly CellWrite[]): Promise<{ written: number; moved: CellWrite[] }> {
  const api = googleOf(ctx).api(ref.account)
  const { grid, capped, ids } = gridOf(await api.sheet(ref.fileId))
  // Past the cap some cells were never read, so a compare there would pass over what they hold.
  if (capped) throw new Error(`${ref.name} holds more than ${GOOGLE_MAX_CELLS.toLocaleString('en-US')} cells: change it in Google.`)
  // The version read after the grid: a change landing between the two makes it newer than any kept, never older.
  const asOf = cells.some((c) => c.target) ? (await api.file(ref.fileId)).version : ''
  // Its value, and where it stands: a new blank at the old address of an approved blank is another cell. A
  // suggestion made before where it stood was kept (`target: null`) cannot be told so, and is asked for again.
  const moved = cells.filter((c) => !same(grid.get(c.sheet)?.get(cellName(c.row, c.col)) ?? null, c.base) || (c.target !== undefined && (c.target === null || !sameTarget(c.target, targetOf(grid, ids, c.sheet, c.row, c.col, asOf), asOf))))
  if (moved.length) return { written: 0, moved }
  if (!cells.length) return { written: 0, moved: [] }
  await api.sheetWrite(
    ref.fileId,
    cells.map((c) => ({ range: `'${c.sheet.replace(/'/g, "''")}'!${cellName(c.row, c.col)}`, values: [[typed(c.value)]] }))
  )
  const version = (await api.file(ref.fileId)).version
  googleOf(ctx).files.update(ref.account, ref.fileId, { version, ours: version })
  bump(ref)
  return { written: cells.length, moved: [] }
}

/**
 * The person's edit from the grid: cell contents only, compared with the snapshot the grid stands on
 * and written as one batch. A grid behind, or a cell someone changed in Google, gets `conflict`.
 */
export async function edit(ctx: WorkCtx, ref: GoogleSheetRef, baseRev: number, mutations: readonly SheetMutationJson[], _by: Principal): Promise<{ rev: number } | { conflict: true; rev: number }> {
  const o = entry(ref)
  if (baseRev !== o.rev) return { conflict: true, rev: o.rev }
  const seen = o.made?.rev === o.rev ? o.made.grid : (await read(ctx, ref)).grid
  const cells = editsOf(mutations, (id) => id).map((e) => {
    const at = parseA1(e.cell)!
    const value: SheetCell | null = e.formula ? { f: e.formula } : e.value === null || e.value === undefined ? null : { v: e.value as SheetCell['v'] }
    return { sheet: e.sheet, row: at.startRow, col: at.startColumn, base: seen.get(e.sheet)?.get(e.cell) ?? null, value }
  })
  const got = await compareAndWrite(ctx, ref, cells)
  if (got.moved.length) {
    bump(ref)
    return { conflict: true, rev: revOf(ref) }
  }
  new SuggestionStore(ctx.db).conflictOn(googleStore(ref.fileId), new Set(cells.map((c) => `${c.sheet}:${c.row}:${c.col}`)))
  return { rev: revOf(ref) }
}

/**
 * Takes or drops an agent's suggestions. The accepted cells that still hold what the agent saw are
 * written as one batch; a cell changed since turns `conflict` and is not written.
 */
export async function review(ctx: WorkCtx, ref: GoogleSheetRef, which: Which, verdict: 'accept' | 'reject'): Promise<{ written: number; conflicts: number }> {
  const store = new SuggestionStore(ctx.db)
  const key = googleStore(ref.fileId)
  const picked = store.pick(key, which)
  if (verdict === 'reject') {
    store.mark(key, picked.map((p) => p.id), 'rejected')
    return { written: 0, conflicts: 0 }
  }
  const pending = picked.filter((p) => p.state === 'pending')
  const targets = store.targetsOf(key, pending.map((p) => p.id))
  const cells = pending.map((p) => ({ sheet: p.sheet, row: p.row, col: p.col, base: p.base as SheetCell | null, value: p.proposed as SheetCell | null, id: p.id, target: targets.get(p.id) ?? null }))
  const idsOf = (xs: CellWrite[]) => xs.map((c) => (c as (typeof cells)[number]).id)
  // The cells that moved wait as conflicts; the rest still go together, as one batch.
  const moved = new Set<string>()
  let got = await compareAndWrite(ctx, ref, cells)
  for (const id of idsOf(got.moved)) moved.add(id)
  if (got.moved.length) {
    got = await compareAndWrite(ctx, ref, cells.filter((c) => !moved.has(c.id)))
    for (const id of idsOf(got.moved)) moved.add(id)
  }
  store.mark(key, [...moved], 'conflict')
  // Accepted only once Google has them; if Google moved again under the second write, the rest stay waiting.
  if (!got.moved.length) store.mark(key, cells.filter((c) => !moved.has(c.id)).map((c) => c.id), 'accepted')
  return { written: got.written, conflicts: moved.size }
}

/** An agent's cells over the spreadsheet, as one change set of suggestions, each with what it saw there. */
export async function suggest(ctx: WorkCtx, ref: GoogleSheetRef, by: Principal, reason: string | undefined, cells: { sheet: string; row: number; col: number; value: SheetCell | null }[]): Promise<{ changeSet: string; count: number }> {
  const api = googleOf(ctx).api(ref.account)
  // The version read before the grid: a change landing between the two makes it older than the grid it keeps, so a
  // review sees the sheet changed since and asks again; never newer, which would hide that change.
  const version = (await api.file(ref.fileId)).version
  const { grid, order, ids } = gridOf(await api.sheet(ref.fileId))
  for (const c of cells) if (!grid.has(c.sheet)) throw new Error(`There is no sheet "${c.sheet}": the sheets are ${order.map((s) => `"${s}"`).join(', ')}.`)
  // Its own id each time: two suggestions in one millisecond never share one, so an id he was shown means one value.
  const changeSet = `cs-${Date.now().toString(36)}${randomBytes(4).toString('hex')}`
  const count = new SuggestionStore(ctx.db).add(
    googleStore(ref.fileId),
    changeSet,
    by,
    reason,
    cells.map((c) => ({ sheet: c.sheet, row: c.row, col: c.col, base: grid.get(c.sheet)!.get(cellName(c.row, c.col)) ?? null, proposed: c.value, target: targetOf(grid, ids, c.sheet, c.row, c.col, version) }))
  )
  bump(ref)
  return { changeSet, count }
}

/** The spreadsheet in Google, for the switch: the canvas opens it in the system browser. */
export async function webLink(ctx: WorkCtx, ref: GoogleSheetRef): Promise<string> {
  return (await googleOf(ctx).api(ref.account).file(ref.fileId)).webViewLink ?? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(ref.fileId)}/edit`
}

/**
 * The spreadsheet as work-kit's `SheetSource` (M26), named by tab: Google computes formulas, so a
 * write is read back; nothing is heard live, the version poll stands in (`live: false`). A write
 * reads its cells, compares their hash with `baseHash`, then writes them as one batch.
 */
export function googleSource(ctx: WorkCtx, ref: GoogleSheetRef): SheetSource {
  const api = () => googleOf(ctx).api(ref.account)
  const listeners = new Set<(c: SheetChange) => void>()
  // A change this source's own write made is not told back to its subscribers.
  let own = false
  const outline = async () => {
    const json = await api().sheet(ref.fileId)
    return (json.sheets ?? []).map((s) => ({ id: s.properties.title as string, name: s.properties.title as string, rowCount: s.properties.gridProperties?.rowCount ?? 1000, columnCount: s.properties.gridProperties?.columnCount ?? 26 }))
  }
  return {
    capabilities: { formulas: 'store', write: true, formats: false, live: false, maxReadCells: GOOGLE_MAX_CELLS, maxWriteCells: 10_000 },
    async read(range) {
      const { grid } = gridOf(await api().sheet(ref.fileId))
      const sheet = grid.get(range.sheet)
      if (!sheet) throw new Error(`There is no sheet "${range.sheet}".`)
      const cells: SheetCell[][] = []
      for (let r = range.startRow; r <= range.endRow; r++) {
        const row: SheetCell[] = []
        for (let c = range.startColumn; c <= range.endColumn; c++) row.push(sheet.get(cellName(r, c)) ?? {})
        cells.push(row)
      }
      return { range, cells, hash: hashCells(cells.flat()) }
    },
    async write(cells, baseHash) {
      const { grid } = gridOf(await api().sheet(ref.fileId))
      const now = cells.map((c) => grid.get(c.sheet)?.get(cellName(c.row, c.column)) ?? {})
      if (hashCells(now) !== baseHash) return 'conflict'
      own = true
      try {
        const got = await compareAndWrite(ctx, ref, cells.map((c, i) => ({ sheet: c.sheet, row: c.row, col: c.column, base: Object.keys(now[i]).length ? now[i] : null, value: c.cell })))
        return got.moved.length ? 'conflict' : 'ok'
      } finally {
        own = false
      }
    },
    subscribe(onChange) {
      listeners.add(onChange)
      void outline().then((sheets) => listeners.has(onChange) && onChange({ kind: 'outline', sheets }), () => {})
      const id = `source:${Math.random().toString(36).slice(2)}`
      follow(ref, id, () => {
        if (own) return
        void outline().then((sheets) => {
          if (!listeners.has(onChange)) return
          for (const s of sheets) onChange({ kind: 'cells', ranges: [{ sheet: s.id, startRow: 0, startColumn: 0, endRow: s.rowCount - 1, endColumn: s.columnCount - 1 }], by: 'google' })
        }, () => {})
      })
      return () => {
        listeners.delete(onChange)
        unfollow(ref, id)
      }
    }
  }
}
