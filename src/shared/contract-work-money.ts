import { z } from 'zod'
import type { CanvasSource } from './work/canvas'
import type { SectorKey } from './work/ids'
import { STATUSES, type CategorySum, type LedgerRow, type MilesSum, type MonthSum, type OwedRow, type Period, type Sums } from './work/money'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The money pillar's wire (docs/agents/work-money.md): a job's ledger, kept
 * as a sheet in the workspace's own folder on its own host. The sheet is the
 * truth: a read is what the sheet holds now, and a write names its row by
 * what the window last saw of it, so a row he changed by hand is never
 * written over. Nothing here sends anything or moves money, and no thread
 * writes the ledger: the writes are the owner's, refused for a model caller.
 */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a day is YYYY-MM-DD')
const workspaceId = z.string().min(1).max(200)
/** Whole cents, above nothing: which way it went is said beside it. */
const cents = z.number().int().min(1).max(100_000_000_000)

/** A row as the window last saw it (`RowAt` in work/money.ts). */
export const RowAtSchema = z.object({
  ref: z.string().max(40).nullable().optional(),
  row: z.number().int().min(2).max(1_000_000),
  sig: z.string().max(600)
})

export const EntryFieldsSchema = z.object({
  date: day,
  who: z.string().trim().max(200),
  /** the For column */
  what: z.string().trim().max(500).default(''),
  category: z.string().trim().max(100).default(''),
  /** money in, or money out */
  way: z.enum(['in', 'out']),
  amount: cents,
  status: z.enum(STATUSES).default('Paid'),
  paidOn: day.nullable().optional()
})
export type EntryFields = z.infer<typeof EntryFieldsSchema>

export const MoneyRequestSchemas = [
  /** → MoneyState: this host's jobs and which have a ledger */
  request('work.money.state', z.object({})),
  /** → MoneyBooks: where a job's ledger and mileage log are, made first when they are missing; `restore` also writes the headers the ledger lacks, at the end of its first row */
  request('work.money.open', z.object({ workspaceId, restore: z.boolean().optional() })),
  /** → MoneyRead: everything the view paints for a span of local days (`to` is not in it) */
  request('work.money.read', z.object({ workspaceId, from: day, to: day })),
  /** → MoneyActed: adds a row, or with `at` changes that one */
  request('work.money.entry', z.object({ workspaceId, at: RowAtSchema.optional(), fields: EntryFieldsSchema })),
  /** → MoneyActed: an open row is paid, or paid back, on `on` (today when absent) */
  request('work.money.paid', z.object({ workspaceId, at: RowAtSchema, on: day.optional() })),
  /** → MoneySums: each job's sums for a span of local days; with no workspace, every job on this host that has a ledger */
  request('work.money.sums', z.object({ from: day, to: day, workspaceId: workspaceId.optional() })),
  /** → MoneyOwed: unpaid rows, the oldest first, and how many receipts wait for his accept */
  request('work.money.owed', z.object({ workspaceId: workspaceId.optional() })),
  /** → MoneyHits: the ledger's rows that hold the words, newest first */
  request('work.money.search', z.object({ workspaceId, query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(100).optional() }))
] as const

export interface MoneyJob {
  workspaceId: string
  name: string
  sector: SectorKey | null
  /** it has a ledger */
  made: boolean
}
export interface MoneyState {
  host: string
  jobs: MoneyJob[]
}

export interface MoneyBooks {
  ledger: CanvasSource
  mileage: CanvasSource
}

/** What keeps the view from reading the ledger as money. */
export type MoneyProblem = { kind: 'columns'; missing: string[] }

export interface MoneyRead {
  /** false: this job has no ledger yet, and everything below is empty */
  made: boolean
  period: Period
  /** the period's rows, the newest first */
  rows: LedgerRow[]
  sums: Sums
  byCategory: CategorySum[]
  /** the twelve months of the year `from` is in */
  byMonth: MonthSum[]
  /** every open row, whenever it was */
  owed: OwedRow[]
  /** the period's trips from the mileage log */
  miles: MilesSum
  /** the job's categories: its starting list, then the ledger's own words */
  categories: string[]
  /** every name in the Who column, the latest first */
  sellers: string[]
  problems: MoneyProblem[]
}

/** A write's answer: what it wrote, or that the row it named no longer reads as the window saw it (nothing was written; read again). */
export type MoneyActed = { ok: true; ref: string | null; row: number; suggested?: true } | { changed: true }

export interface MoneySums {
  rows: { workspaceId: string; sector: SectorKey | null; in: number; out: number; owedToHim: number; heOwes: number; miles: number; currency: 'USD' }[]
}
export interface MoneyOwed {
  rows: { workspaceId: string; sector: SectorKey | null; row: number; who: string; amount: number; since: string | null; way: 'toHim' | 'byHim' }[]
  toConfirm: number
}
export interface MoneyHits {
  hits: { row: number; date: string | null; who: string; amount: number; way: 'in' | 'out'; category: string; receipt?: string }[]
}

/** Something waits for his accept, or stopped waiting: to every client socket. */
export type MoneyPush = { push: 'work.money'; workspaceId: string; toConfirm: number }

export const MONEY_CAPS = {
  'work.money.state': 'read',
  'work.money.open': 'operate',
  'work.money.read': 'read',
  'work.money.entry': 'operate',
  'work.money.paid': 'operate',
  'work.money.sums': 'read',
  'work.money.owed': 'read',
  'work.money.search': 'read'
} satisfies CapsOf<typeof MoneyRequestSchemas>
export const MONEY_RELAY = {} satisfies RelayOf<typeof MoneyRequestSchemas>

/** What only the owner does: a thread's own call is refused. */
export const MONEY_OWNER_ONLY: ReadonlySet<string> = new Set(['work.money.open', 'work.money.entry', 'work.money.paid'])
