import type { DatabaseSync } from 'node:sqlite'
import type { DashBlock, DashboardView, DashFrom, DashProposal, DashSheet } from '@shared/contract-work-dashboards'
import type { CanvasItem } from '@shared/work'
import { FenceError } from '../../remote/fence'
import type { Caller, WorkCtx } from '../modules'
import { aggregate, barsOf, formatValue, tableOf, type Cells } from './read'

/**
 * A dashboard on the host (docs/agents/work-dashboards.md): one row per
 * item, its blocks with what they last read, when the page was read whole,
 * and each sheet's rev at that read, so the page knows when a sheet moved.
 */

export type StoredBlock = DashBlock & { proposed?: DashProposal }

export interface DashRow {
  itemId: string
  sessionId: string
  rev: number
  title: string
  blocks: StoredBlock[]
  asOf: number | null
  /** each sheet's rev when the page was last read, by `sheetKey` */
  revs: Record<string, number>
  failed: string | null
}

export function ensureDashboardsTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_dashboards (
    item_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    rev INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL,
    blocks TEXT NOT NULL DEFAULT '[]',
    as_of INTEGER,
    revs TEXT NOT NULL DEFAULT '{}',
    failed TEXT,
    updated_at INTEGER NOT NULL
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS work_dashboards_session ON work_dashboards(session_id)')
}

type Raw = Record<string, string | number | null>
const rowOf = (r: Raw): DashRow => ({
  itemId: String(r.item_id),
  sessionId: String(r.session_id),
  rev: Number(r.rev),
  title: String(r.title),
  blocks: JSON.parse(String(r.blocks)) as StoredBlock[],
  asOf: (r.as_of as number | null) ?? null,
  revs: JSON.parse(String(r.revs)) as Record<string, number>,
  failed: (r.failed as string | null) ?? null
})

export class DashStore {
  constructor(private readonly db: DatabaseSync) {}
  get(itemId: string): DashRow | null {
    const r = this.db.prepare('SELECT * FROM work_dashboards WHERE item_id = ?').get(itemId) as Raw | undefined
    return r ? rowOf(r) : null
  }
  create(itemId: string, sessionId: string, title: string): DashRow {
    this.db.prepare('INSERT INTO work_dashboards (item_id, session_id, title, updated_at) VALUES (?, ?, ?, ?)').run(itemId, sessionId, title, Date.now())
    return this.get(itemId)!
  }
  update(itemId: string, patch: Partial<Pick<DashRow, 'blocks' | 'asOf' | 'revs' | 'failed'>>): DashRow {
    const row = this.get(itemId)!
    const next = { ...row, ...patch }
    this.db
      .prepare('UPDATE work_dashboards SET blocks = ?, as_of = ?, revs = ?, failed = ?, rev = rev + 1, updated_at = ? WHERE item_id = ?')
      .run(JSON.stringify(next.blocks), next.asOf, JSON.stringify(next.revs), next.failed, Date.now(), itemId)
    return this.get(itemId)!
  }
  removeSessions(ids: string[]): void {
    for (const id of ids) this.db.prepare('DELETE FROM work_dashboards WHERE session_id = ?').run(id)
  }

  removeItems(itemIds: readonly string[]): void {
    for (const id of itemIds) this.db.prepare('DELETE FROM work_dashboards WHERE item_id = ?').run(id)
  }
}

type Ctx = Pick<WorkCtx, 'db' | 'host' | 'canvas' | 'service' | 'push' | 'log'>

export class DashError extends Error {}

export function dashItem(ctx: Pick<WorkCtx, 'canvas'>, itemId: string): CanvasItem {
  const item = ctx.canvas.get(itemId)
  if (!item || item.kind !== 'dashboard') throw new DashError(`There is no dashboard ${itemId}.`)
  return item
}

export function dashRow(ctx: Pick<WorkCtx, 'db'>, item: CanvasItem): DashRow {
  const row = new DashStore(ctx.db).get(item.id)
  if (!row) throw new DashError(`${item.title} has no dashboard behind it.`)
  return row
}

// ── the sheets it reads ──────────────────────────────────────────────

export const sheetKey = (s: DashSheet): string => (s.at === 'lifeos' ? `lifeos:${s.id}` : `file:${s.host}:${s.path}`)

/** The sheet as the Work service's sheet host names it; a file on another host is not this host's to read. */
function refOf(ctx: Pick<WorkCtx, 'host'>, s: DashSheet): { lifeos: string } | { tcsheet: string } {
  if (s.at === 'lifeos') return { lifeos: s.id }
  if (s.host !== ctx.host) throw new DashError(`That sheet is on another host (${s.host}); open the dashboard there.`)
  if (!s.path.endsWith('.tcsheet')) throw new DashError('A dashboard reads LifeOS sheets and .tcsheet files; an Excel file is not read here yet.')
  return { tcsheet: s.path }
}

export async function sheetInfo(ctx: Ctx, s: DashSheet): Promise<{ title: string; rev: number }> {
  return (await ctx.service.internal('/internal/sheet/open', { sheet: refOf(ctx, s) })) as { title: string; rev: number }
}

async function readRange(ctx: Ctx, s: DashSheet, range: string): Promise<Cells> {
  const got = (await ctx.service.internal('/internal/sheet/range', { sheet: refOf(ctx, s), range })) as { cells: Cells }
  return got.cells
}

const sourcesOf = (b: DashBlock): DashFrom[] =>
  b.kind === 'chart' || b.kind === 'table' ? [b.from] : b.kind === 'figures' ? b.figures.flatMap((f) => ('sheet' in f.from ? [f.from] : [])) : []

/** A block with what its ranges hold now. */
async function readBlock(ctx: Ctx, b: StoredBlock): Promise<StoredBlock> {
  if (b.kind === 'figures')
    return {
      ...b,
      figures: await Promise.all(b.figures.map(async (f) => ('sheet' in f.from ? { ...f, value: formatValue(aggregate(await readRange(ctx, f.from.sheet, f.from.range), f.from.agg), f.format) } : f)))
    }
  if (b.kind === 'chart') {
    const [labels, values] = await Promise.all([readRange(ctx, b.from.sheet, b.from.labels), readRange(ctx, b.from.sheet, b.from.range)])
    return { ...b, bars: barsOf(labels, values) }
  }
  if (b.kind === 'table') return { ...b, ...tableOf(await readRange(ctx, b.from.sheet, b.from.range)) }
  return b
}

/**
 * Reads every block again, as one read: "as of" is when it finished. A read
 * that fails says why and keeps the page as it was, so no number shows under
 * an "as of" it was not read at; `keep: 'list'` keeps `blocks` instead (a
 * block just proposed stays, unread).
 */
export async function refresh(ctx: Ctx, item: CanvasItem, blocks?: StoredBlock[], keep: 'row' | 'list' = 'row'): Promise<DashRow> {
  const store = new DashStore(ctx.db)
  const row = dashRow(ctx, item)
  const list = blocks ?? row.blocks
  try {
    const sheets = new Map<string, DashSheet>()
    for (const b of list) for (const f of sourcesOf(b)) sheets.set(sheetKey(f.sheet), f.sheet)
    const revs: Record<string, number> = {}
    for (const [key, s] of sheets) revs[key] = (await sheetInfo(ctx, s)).rev
    const read = await Promise.all(list.map((b) => readBlock(ctx, b)))
    return store.update(item.id, { blocks: read, asOf: Date.now(), revs, failed: null })
  } catch (err) {
    const failed = err instanceof Error ? err.message : String(err)
    return store.update(item.id, { blocks: keep === 'list' ? list : row.blocks, failed })
  }
}

/** Whether a sheet the page reads has moved since it was read. A sheet that cannot be asked counts as moved. */
async function staleOf(ctx: Ctx, row: DashRow): Promise<boolean> {
  for (const [key, rev] of Object.entries(row.revs)) {
    const s = row.blocks.flatMap(sourcesOf).find((f) => sheetKey(f.sheet) === key)?.sheet
    if (!s) continue
    try {
      if ((await sheetInfo(ctx, s)).rev !== rev) return true
    } catch {
      return true
    }
  }
  return false
}

export async function viewOf(ctx: Ctx, row: DashRow): Promise<DashboardView> {
  return { itemId: row.itemId, rev: row.rev, title: row.title, blocks: row.blocks, asOf: row.asOf, stale: row.asOf !== null && (await staleOf(ctx, row)), failed: row.failed }
}

/** The files a page reads: a push about it reaches only the sockets whose caller could name every one (`PushTo.path`). */
export const filesOf = (row: DashRow): string[] => row.blocks.flatMap(sourcesOf).flatMap((f) => (f.sheet.at === 'file' ? [f.sheet.path] : []))

export async function announce(ctx: Ctx, row: DashRow): Promise<DashboardView> {
  const view = await viewOf(ctx, row)
  const files = filesOf(row)
  ctx.push({ push: 'work.dashboards', sessionId: row.sessionId, itemId: row.itemId, view }, files.length ? { path: files } : undefined)
  return view
}

/** A remote key sees a dashboard only when it could name every file the page reads itself. */
export function fenceDash(ctx: Pick<WorkCtx, 'reaches'>, by: Caller, row: DashRow, method: string): void {
  for (const path of filesOf(row)) if (!ctx.reaches(by, path)) throw new FenceError(method)
}

// ── what the owner decides ───────────────────────────────────────────

export function review(ctx: Ctx, item: CanvasItem, which: { ids: string[] } | 'all', verdict: 'accept' | 'reject'): DashRow {
  const row = dashRow(ctx, item)
  const picked = (b: StoredBlock): boolean => !!b.proposed && (which === 'all' || which.ids.includes(b.id))
  const blocks = row.blocks.flatMap((b): StoredBlock[] => {
    if (!picked(b)) return [b]
    if (verdict === 'reject') return []
    const { proposed: _, ...kept } = b
    return [kept as StoredBlock]
  })
  return new DashStore(ctx.db).update(item.id, { blocks })
}

export function removeBlock(ctx: Ctx, item: CanvasItem, blockId: string): DashRow {
  const row = dashRow(ctx, item)
  if (!row.blocks.some((b) => b.id === blockId)) throw new DashError('That block is not on the dashboard.')
  return new DashStore(ctx.db).update(item.id, { blocks: row.blocks.filter((b) => b.id !== blockId) })
}
