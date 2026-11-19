import { z } from 'zod'
import type { Principal } from './work/ids'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The dashboards pillar's wire (docs/agents/work-dashboards.md): a saved
 * page of figures in the canvas pane. Its methods are
 * `work.dashboards.<verb>` and its push `work.dashboards`;
 * src/shared/work/wire.ts has the helpers and the rules.
 *
 * A dashboard is text, figures, one plain chart and flat tables. Every
 * number is read from a range of a sheet (or set by an agent from a service
 * it names), and opens where it came from. The whole page is read at once,
 * so "as of" is said once. A new block waits for the owner's Accept, even
 * on his own dashboard.
 */

/** A sheet a dashboard reads, as the sheet kind opens it: a LifeOS sheet, or a .tcsheet on a host. */
export type DashSheet = { at: 'lifeos'; table: 'sheets'; id: string } | { at: 'file'; host: string; path: string }

export const DASH_AGGS = ['cell', 'sum', 'count', 'average', 'min', 'max'] as const
export type DashAgg = (typeof DASH_AGGS)[number]
export const DASH_FORMATS = ['number', 'money', 'percent', 'text'] as const
export type DashFormat = (typeof DASH_FORMATS)[number]

/** Where a block's numbers come from: a sheet's range, and what it counts in words ("Amount, summed where Status is not Paid"). */
export interface DashFrom {
  sheet: DashSheet
  /** the sheet's name when it was read */
  sheetTitle: string
  /** A1, with the tab when it is not the first ('Invoices'!E2:E48) */
  range: string
  counts: string
}

export interface DashFigure {
  id: string
  label: string
  /** the line under the number ("4 invoices") */
  sub?: string
  format: DashFormat
  from: (DashFrom & { agg: DashAgg }) | { service: string; counts: string }
  /** as last read; null when it could not be */
  value: string | null
}

export type DashBlock =
  | { id: string; kind: 'heading'; text: string }
  | { id: string; kind: 'text'; text: string }
  | { id: string; kind: 'figures'; figures: DashFigure[] }
  /** one series of plain bars; `labels` is the range of their names, `from.range` their values; the last bar is the current one */
  | { id: string; kind: 'chart'; title: string; from: DashFrom & { labels: string }; format: DashFormat; bars: { label: string; value: number }[] }
  /** a flat table; the range's first row is its head */
  | { id: string; kind: 'table'; title: string; from: DashFrom; head: string[]; rows: string[][]; numeric: boolean[] }

/** A block waiting for his Accept, and who proposed it. */
export interface DashProposal {
  by: Principal
  reason?: string
  at: number
}

export interface DashboardView {
  itemId: string
  rev: number
  title: string
  blocks: (DashBlock & { proposed?: DashProposal })[]
  /** when the page was last read, whole */
  asOf: number | null
  /** a sheet it reads changed since */
  stale: boolean
  /** why a read failed, in words, when one did */
  failed: string | null
}

export const DASH_BLOCKS_MAX = 40
export const DASH_BARS_MAX = 24
export const DASH_TABLE_ROWS = 50
export const DASH_TABLE_COLS = 8

const itemId = z.string().min(1).max(100)
const which = z.union([z.object({ ids: z.array(z.string().max(100)).min(1).max(DASH_BLOCKS_MAX) }), z.literal('all')])

export const DashboardsRequestSchemas = [
  /** The page as last read, and whether a sheet it reads has moved since; then the `work.dashboards` push. */
  request('work.dashboards.open', z.object({ itemId })),
  /** Reads every figure again, now. */
  request('work.dashboards.refresh', z.object({ itemId })),
  /** Keep or drop proposed blocks. */
  request('work.dashboards.review', z.object({ itemId, which, verdict: z.enum(['accept', 'reject']) })),
  request('work.dashboards.remove', z.object({ itemId, blockId: z.string().max(100) }))
] as const

export type DashboardsPush = { push: 'work.dashboards'; sessionId: string; itemId: string; view: DashboardView }

export const DASHBOARDS_CAPS = {
  'work.dashboards.open': 'read',
  'work.dashboards.refresh': 'operate',
  'work.dashboards.review': 'operate',
  'work.dashboards.remove': 'operate'
} satisfies CapsOf<typeof DashboardsRequestSchemas>
export const DASHBOARDS_RELAY = {} satisfies RelayOf<typeof DashboardsRequestSchemas>
