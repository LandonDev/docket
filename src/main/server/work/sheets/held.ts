import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, join } from 'node:path'
import type { SheetChart, SheetMutationJson, SheetView } from '@shared/contract-work-sheets'
import { agentPrincipal, canvasSourcePath, type CanvasItem, type Principal } from '@shared/work'
import { FenceError } from '../../remote/fence'
import { Toolchain } from '../formats/tools'
import type { Caller, WorkCtx } from '../modules'
import { excelStore } from '../office/excel'
import { excelRefOf, type ExcelRef } from '../office/grid'
import type { HostAnswer, HostAsk, SheetRef } from './host/wire'
import { cellsOfMutations, PackageStore } from './packages'
import { SuggestionStore } from './suggestions'
import type { SheetJobs } from './workerClient'

/**
 * Where a sheet item lives and how the pillar reaches it
 * (docs/agents/work-sheets.md): an opened package is held here, in main,
 * through the package store and the sheet worker; a LifeOS sheet and a
 * `.tcsheet` file are held by the Work service (host/), which main asks over
 * its socket.
 */

export type Held = { at: 'package'; path: string } | { at: 'service'; ref: SheetRef } | { at: 'excel'; ref: ExcelRef }

export const PACKAGE_EXT = new Set(['.xlsx', '.xlsm'])

/** The store an item names. */
export function heldOf(item: Pick<CanvasItem, 'source' | 'title'>): Held {
  const s = item.source
  if (s.at === 'lifeos' && s.table === 'sheets') return { at: 'service', ref: { lifeos: s.id } }
  if (s.at === 'file') {
    const ext = extname(s.path).toLowerCase()
    if (PACKAGE_EXT.has(ext)) return { at: 'package', path: s.path }
    if (ext === '.tcsheet') return { at: 'service', ref: { tcsheet: s.path } }
    throw new Error(`${basename(s.path)} is not a workbook this canvas opens (.xlsx, .xlsm or .tcsheet).`)
  }
  // A workbook that lives in Excel: Excel is the truth, the office pillar's helper reads and writes it (milestone 28).
  const excel = excelRefOf(s)
  if (excel) return { at: 'excel', ref: excel }
  throw new Error(`${item.title} lives in ${s.at}: its sheet opens there (milestone 30).`)
}

/** The key suggestions, the mode and charts are kept under. */
export const storeKey = (h: Held): string =>
  h.at === 'package' ? `file:${h.path}` : h.at === 'excel' ? excelStore(h.ref.book) : 'lifeos' in h.ref ? `lifeos:${h.ref.lifeos}` : `tcsheet:${h.ref.tcsheet}`

/** A file path an agent names: absolute, a workbook, there. */
export function heldOfPath(path: string): Exclude<Held, { at: 'excel' }> {
  if (!isAbsolute(path)) throw new Error(`${path} is not an absolute path.`)
  if (!existsSync(path)) throw new Error(`There is no file at ${path}.`)
  return heldOf({ source: { at: 'file', host: '', path }, title: basename(path) }) as Exclude<Held, { at: 'excel' }>
}

/** What every caller of the pillar shares: one package store, one suggestion store, one worker. */
export interface Sheets {
  ctx: WorkCtx
  packages: PackageStore
  suggestions: SuggestionStore
  jobs: SheetJobs
}

const made = new WeakMap<WorkCtx['db'], Sheets>()
let jobsFor: (() => Promise<SheetJobs>) | null = null
/** A test hands its own jobs (the in-process ones). */
export const setJobs = (fn: (() => Promise<SheetJobs>) | null): void => {
  jobsFor = fn
}

export async function sheetsOf(ctx: WorkCtx): Promise<Sheets> {
  const hit = made.get(ctx.db)
  if (hit) return hit
  const jobs = jobsFor
    ? await jobsFor()
    : process.versions.electron
      ? (await import('./spawnWorker')).appJobs()
      : await (await import('./workerClient')).localJobs()
  const tools = new Toolchain(ctx.dataDir)
  const suggestions = new SuggestionStore(ctx.db)
  const s: Sheets = {
    ctx,
    // A change from outside moves cells we cannot follow: every open suggestion over the file is orphaned.
    packages: new PackageStore(ctx.db, jobs, join(ctx.dataDir, 'sheets', 'files'), () => tools.dir('ironcalc'), Date.now, (path) => suggestions.orphanAll(`file:${path}`)),
    suggestions,
    jobs
  }
  made.set(ctx.db, s)
  return s
}

/** One call to the Work service's sheet host. */
export async function host<A extends HostAsk['op']>(ctx: WorkCtx, op: A, body: Omit<Extract<HostAsk, { op: A }>, 'op'>): Promise<HostAnswer<A>> {
  return (await ctx.service.internal(`/internal/sheet/${op}`, body)) as HostAnswer<A>
}

/** A remote key reaches a file item only where it could name the file itself. */
export function fence(ctx: WorkCtx, by: Caller, item: CanvasItem, method: string): void {
  const path = canvasSourcePath(item.source)
  if (path !== null && !ctx.reaches(by, path)) throw new FenceError(method)
}

/** Who did it, as a principal: the owner at a screen, else the thread whose call it is. */
export const principalOf = (ctx: WorkCtx, by: Caller): Principal => (by.kind === 'model' && by.sessionId ? agentPrincipal(ctx.host, by.sessionId) : 'owner')

export function chartsOf(ctx: WorkCtx, store: string): SheetChart[] {
  const rows = ctx.db.prepare('SELECT json FROM work_sheets_charts WHERE store = ? ORDER BY rowid').all(store) as { json: string }[]
  return rows.map((r) => JSON.parse(r.json) as SheetChart)
}

export function setChart(ctx: WorkCtx, store: string, chart: SheetChart, remove: boolean): void {
  if (remove) ctx.db.prepare('DELETE FROM work_sheets_charts WHERE store = ? AND id = ?').run(store, chart.id)
  else ctx.db.prepare('INSERT INTO work_sheets_charts (store, id, json) VALUES (?, ?, ?) ON CONFLICT (store, id) DO UPDATE SET json = excluded.json').run(store, chart.id, JSON.stringify(chart))
}

/** The view a canvas draws: the store's state, with this host's suggestions, mode, written line and charts. */
export async function viewOf(s: Sheets, item: CanvasItem): Promise<SheetView> {
  const held = heldOf(item)
  const key = storeKey(held)
  const shared = s.ctx.scopeOf(item.sessionId)?.shared(item.source) ?? false
  const base = { itemId: item.id, sessionId: item.sessionId, mode: s.suggestions.mode(key), charts: chartsOf(s.ctx, key) }
  const written = s.suggestions.written(key)
  if (held.at === 'package') {
    const st = await s.packages.open(held.path)
    return {
      ...base,
      name: basename(held.path),
      store: 'package',
      rev: st.rev,
      shared,
      suggestions: s.suggestions.open(key),
      ...(written ? { written } : {}),
      ...(st.inspected.reach ? { reach: st.inspected.reach } : {}),
      ...(st.inspected.readOnly ? { readOnly: st.inspected.readOnly } : {}),
      ...(st.inspected.date1904 ? { date1904: true } : {}),
      ...(st.saveError ? { saveError: st.saveError } : {}),
      ...(st.missing ? { missing: true } : {})
    }
  }
  if (held.at === 'excel') {
    const grid = await import('../office/grid')
    return {
      ...base,
      name: held.ref.name,
      // In the canvas it is a file whose cell contents save and nothing else, as an opened package.
      store: 'package',
      rev: await grid.follow(s.ctx, held.ref, () => void import('./index').then((m) => m.announce(s, item))),
      shared,
      suggestions: s.suggestions.open(key),
      ...(written ? { written } : {}),
      reach: { parts: ['formatting', 'inserting rows and columns'], to: 'excel' }
    }
  }
  const st = await host(s.ctx, 'open', { sheet: held.ref })
  return {
    ...base,
    name: st.title,
    store: 'lifeos' in held.ref ? 'lifeos' : 'tcsheet',
    rev: st.rev,
    shared: shared || st.shared,
    suggestions: st.suggestions,
    ...(written ? { written } : {}),
    ...(st.missing ? { missing: true } : {})
  }
}

/** Bytes of a file by range. */
export function readRange(path: string, offset: number, length: number): { data: string; size: number } {
  const size = statSync(path).size
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(Math.max(0, Math.min(length, size - offset)))
    readSync(fd, buf, 0, buf.length, offset)
    return { data: buf.toString('base64'), size }
  } finally {
    closeSync(fd)
  }
}

/** The owner's edits landed: a suggestion over a cell they changed no longer holds. */
export function afterEdit(s: Sheets, key: string, mutations: readonly SheetMutationJson[]): void {
  s.suggestions.conflictOn(key, cellsOfMutations(mutations))
}

export const newId = (): string => randomUUID()
