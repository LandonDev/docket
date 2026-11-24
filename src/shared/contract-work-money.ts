import { z } from 'zod'
import { CanvasSourceSchema, type CanvasSource } from './work/canvas'
import { SectorKeySchema, type SectorKey } from './work/ids'
import { isDay, STATUSES, type CategorySum, type LedgerRow, type MilesSum, type MonthSum, type OwedRow, type Period, type ReceiptFields, type ReceiptLine, type Sums } from './work/money'
import { request, type CapsOf, type RelayOf } from './work/wire'

/**
 * The money pillar's wire (docs/agents/work-money.md): a job's ledger, kept
 * as a sheet in the workspace's own folder on its own host. The sheet is the
 * truth: a read is what the sheet holds now, and a write names its row by
 * what the window last saw of it, so a row he changed by hand is never
 * written over. Nothing here sends anything or moves money, and no thread
 * writes the ledger: the writes are the owner's, refused for a model caller.
 */

/** An edge of a span of days: `YYYY-MM-DD`, and nothing is written from it (a year's end is the next year's first day). */
const span = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a day is YYYY-MM-DD')
/** A day that is written: one that exists, in the years the ledger reads. A day a read would drop is refused before anything is written. */
const day = span.refine(isDay, 'That is not a day Money can file: a date that exists, from 1990 to 2100.')
const workspaceId = z.string().min(1).max(200)
/** Whole cents, above nothing: which way it went is said beside it. */
const cents = z.number().int().min(1).max(100_000_000_000)

/** A row as the window last saw it (`RowAt` in work/money.ts). */
export const RowAtSchema = z.object({
  ref: z.string().max(40).nullable().optional(),
  row: z.number().int().min(2).max(1_000_000),
  sig: z.string().max(64)
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

/** A receipt travels in parts of at most this many bytes, as an attachment's chunks do. */
export const MONEY_PART_BYTES = 2 * 1024 * 1024
/** The largest receipt Money takes. */
export const MONEY_FILE_MAX = 25_000_000
const PARTS_MAX = Math.ceil(MONEY_FILE_MAX / MONEY_PART_BYTES)

/** One run of text a reader found and where it stands (`ReceiptLine` in work/money.ts). */
export const ReceiptLineSchema = z.object({
  text: z.string().max(500),
  /** left, top, right, bottom: four numbers in any one unit */
  box: z.array(z.number()).length(4).optional(),
  score: z.number().optional()
})
/** Lines as they came over the wire, as the parser reads them: each box was checked to hold four numbers. */
export const receiptLines = (lines: readonly z.infer<typeof ReceiptLineSchema>[]): ReceiptLine[] => lines as unknown as ReceiptLine[]
export const RECEIPT_LINES_MAX = 2000

/** What was read off a receipt, or what he typed over it: each may be missing. */
export const ReceiptFieldsSchema = z.object({
  amount: cents.nullable(),
  date: day.nullable(),
  who: z.string().trim().max(200).nullable(),
  category: z.string().trim().max(100).nullable()
})

/** How a receipt came in: dropped on the desktop, sent from the phone, filed from a mail's or a file's item, or left by a thread. */
export const MONEY_SOURCES = ['drop', 'phone', 'mail', 'agent'] as const
export type MoneySource = (typeof MONEY_SOURCES)[number]

/** A receipt names its job (a workspace or a sector) and is bytes or a file, one of the two: the host refuses anything else in words. */
export const ReceiveParamsSchema = z.object({
  /** the sender's own id for this receipt: a repeat with the same key answers the first and files nothing twice */
  key: z.string().min(8).max(100),
  /** the job: a workspace of this host, or the sector whose workspace here takes it (the phone names the sector) */
  workspaceId: workspaceId.optional(),
  sector: SectorKeySchema.optional(),
  name: z.string().min(1).max(255),
  mime: z.string().max(100).optional(),
  /** the bytes, in order: part `part` of `parts`, each at most MONEY_PART_BYTES */
  part: z.number().int().min(0).max(PARTS_MAX - 1).optional(),
  parts: z.number().int().min(1).max(PARTS_MAX).optional(),
  dataBase64: z
    .string()
    .max(Math.ceil((MONEY_PART_BYTES * 4) / 3) + 4)
    .optional(),
  /** in place of the bytes: a file already on this host, which the host copies */
  file: CanvasSourceSchema.optional(),
  /** what the sender already read (the phone's own reader): the host does not read it again */
  lines: z.array(ReceiptLineSchema).max(RECEIPT_LINES_MAX).optional(),
  /** what he accepted where he sent it from: with an amount and a date it is filed at once, else it waits in To confirm */
  fields: ReceiptFieldsSchema.optional(),
  /** the sender showed him what the parser read before he sent it: a field he left empty stays empty, and nothing read here fills it */
  seen: z.boolean().optional(),
  source: z.enum(['drop', 'phone', 'mail']).default('drop')
})
export type ReceiveParams = z.infer<typeof ReceiveParamsSchema>

/** A trip, and the pay that went with it: from a calendar event he was offered, or typed by hand. */
export const TripParamsSchema = z.object({
  workspaceId,
  /** the calendar event it came from: it is then marked added, and offered no more */
  eventId: z.string().min(1).max(200).optional(),
  /** a trip typed by hand: the sender's own id for this add, so the same Add again writes nothing twice */
  key: z.string().min(8).max(100).optional(),
  /** he picked the event himself in Add → Trip…: one he skipped before is taken up again. Without it (an offer's Add, Add all) a skipped event stays skipped */
  reopen: z.boolean().optional(),
  date: day,
  /** the trip's name: the event's title */
  title: z.string().trim().min(1).max(300),
  place: z.string().trim().max(300).default(''),
  /** miles there and back; absent or 0: no row in the mileage log */
  miles: z.number().min(0).max(100_000).optional(),
  /** what he is paid for it, in cents; absent or 0: no row in the ledger */
  fee: z.number().int().min(0).max(100_000_000_000).optional()
})
export type TripParams = z.infer<typeof TripParamsSchema>

const InvoiceLineSchema = z.object({ what: z.string().trim().min(1).max(300), quantity: z.number().min(0).max(1_000_000), rate: z.number().int().min(0).max(100_000_000_000) })
/** His own details on what he sends. A name is needed: the one who gets the page must know who it is from. */
export const InvoiceFromSchema = z.object({ name: z.string().trim().min(1).max(200), address: z.string().trim().max(600), pay: z.string().trim().max(600) })
/** An invoice (it asks to be paid) or a purchase request (it asks leave to buy): `Invoice` in work/money.ts. */
export const InvoiceSchema = z.object({
  kind: z.enum(['invoice', 'request']),
  number: z.string().trim().min(1).max(40),
  to: z.string().trim().min(1).max(300),
  date: day,
  due: day.nullable(),
  lines: z.array(InvoiceLineSchema).min(1).max(100),
  from: InvoiceFromSchema,
  reason: z.string().trim().max(2000).optional()
})

/** A file the window made for Money to keep: the tax summary it printed, or an invoice's PDF, which files the invoice's row with it. */
export const KeepParamsSchema = z.object({
  workspaceId,
  /** the sender's own id for this file: a repeat with the same key answers the first */
  key: z.string().min(8).max(100),
  what: z.enum(['summary', 'invoice']),
  /** a summary's year */
  year: z.number().int().min(1990).max(2100).optional(),
  /** a summary's export: the `generation` its `work.money.export` answered. A summary of an older export than the year's newest is refused, so a slow print never replaces a newer one's page */
  generation: z.number().int().min(0).optional(),
  /** an invoice's own fields: kept with the file as its row in the ledger */
  invoice: InvoiceSchema.optional(),
  part: z.number().int().min(0).max(PARTS_MAX - 1),
  parts: z.number().int().min(1).max(PARTS_MAX),
  dataBase64: z.string().max(Math.ceil((MONEY_PART_BYTES * 4) / 3) + 4)
})

export const MoneyRequestSchemas = [
  /** → MoneyState: this host's jobs and which have a ledger */
  request('work.money.state', z.object({})),
  /** → MoneyBooks: where a job's ledger and mileage log are, made first when they are missing; `restore` also writes the headers the ledger lacks, at the end of its first row */
  request('work.money.open', z.object({ workspaceId, restore: z.boolean().optional() })),
  /** → MoneyRead: everything the view paints for a span of local days (`to` is not in it) */
  request('work.money.read', z.object({ workspaceId, from: span, to: span })),
  /** → MoneyActed: adds a row, or with `at` changes that one */
  request('work.money.entry', z.object({ workspaceId, at: RowAtSchema.optional(), fields: EntryFieldsSchema })),
  /** → MoneyActed: an open row is paid, or paid back, on `on` (today when absent) */
  request('work.money.paid', z.object({ workspaceId, at: RowAtSchema, on: day.optional() })),
  /** → MoneySums: each job's sums for a span of local days; with no workspace, every job on this host that has a ledger */
  request('work.money.sums', z.object({ from: span, to: span, workspaceId: workspaceId.optional() })),
  /** → MoneyOwed: unpaid rows, the oldest first, and how many receipts wait for his accept */
  request('work.money.owed', z.object({ workspaceId: workspaceId.optional() })),
  /** → MoneyHits: the ledger's rows that hold the words, newest first */
  request('work.money.search', z.object({ workspaceId, query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(100).optional() })),
  /** → ReceiptFields: the one parser on a reader's lines, with what the job's ledger knows of the seller; the phone asks it for its own reader's lines */
  request('work.money.parse', z.object({ lines: z.array(ReceiptLineSchema).max(RECEIPT_LINES_MAX), workspaceId: workspaceId.optional(), sector: SectorKeySchema.nullable().optional() })),
  /** → MoneyReceived: a receipt's bytes (in parts) or a file of this host, into To confirm; filed at once when `fields` holds an amount and a date */
  request('work.money.receive', ReceiveParamsSchema),
  /** → MoneyActed: his accept. The file is kept under Money/Receipts/<year>/, the row appended, the waiting one filed; `workspaceId` sends it to another job */
  request('work.money.accept', z.object({ id: z.string().min(1).max(100), fields: EntryFieldsSchema, workspaceId: workspaceId.optional() })),
  /** → null: a waiting one is dropped; its file is kept a while, so `undo` puts it back in To confirm as it was */
  request('work.money.drop', z.object({ id: z.string().min(1).max(100), undo: z.boolean().optional() })),
  /** → MoneyPicture: a waiting receipt's picture (`id`) or a filed row's (`workspaceId` and the Receipt cell), a part at a time; a PDF is drawn as its first page */
  request('work.money.picture', z.object({ id: z.string().min(1).max(100).optional(), workspaceId: workspaceId.optional(), receipt: z.string().min(1).max(600).optional(), part: z.number().int().min(0).max(63).default(0) })),
  /** → MoneyEvents: the job's ended calendar events of the last 60 days that name a place, for Add → Trip… */
  request('work.money.events', z.object({ workspaceId })),
  /** → MoneyTripped: a trip into the mileage log and its pay into the ledger (Game fees, Unpaid); the event it came from is marked added */
  request('work.money.trip', TripParamsSchema),
  /** → null: a calendar event he does not want offered again; `undo` offers it again */
  request('work.money.skip', z.object({ workspaceId, eventId: z.string().min(1).max(200), undo: z.boolean().optional() })),
  /** → MoneyRate: his own mileage rate for a year, in dollars a mile */
  request('work.money.rate', z.object({ workspaceId, year: z.number().int().min(1990).max(2100), rate: z.number().min(0).max(100) })),
  /** → MoneyExport: makes Money/Tax <year>/ with the year's CSV and Excel file; with `pdf`, also answers the summary's page for the window to print and hand back with `keep` */
  request('work.money.export', z.object({ workspaceId, year: z.number().int().min(1990).max(2100), csv: z.boolean().default(true), xlsx: z.boolean().default(true), pdf: z.boolean().default(true) })),
  /** → MoneyInvoiceNext: the next free number, his details as he last gave them, and the terms he last used */
  request('work.money.invoiceNext', z.object({ workspaceId, kind: z.enum(['invoice', 'request']).default('invoice') })),
  /** → MoneyInvoicePage: checks an invoice, takes its number for this Create (`key`, the one `keep` then names), keeps his details and terms for next time, and answers its page for the window to print and hand back with `keep` */
  request('work.money.invoice', z.object({ workspaceId, key: z.string().min(8).max(100), invoice: InvoiceSchema })),
  /** → MoneyKept: a file the window printed, kept in the job's Money folder; an invoice's also files its row (Sales, Unpaid; a request: Requested) */
  request('work.money.keep', KeepParamsSchema)
] as const

export interface MoneyJob {
  workspaceId: string
  name: string
  sector: SectorKey | null
  /** it has a ledger */
  made: boolean
  /** the job's starting categories, for a sender that draws a picker (the phone) */
  categories: string[]
}
export interface MoneyState {
  host: string
  jobs: MoneyJob[]
}

export interface MoneyBooks {
  ledger: CanvasSource
  /** null: the mileage log cannot be opened (its file leads outside the job's folder); the ledger is answered all the same */
  mileage: CanvasSource | null
  /** `restore` on a ledger others can open: the missing headers wait as a suggestion in the sheet, and the columns are not back until he accepts it there */
  suggested?: true
}

/**
 * What keeps the view from reading the ledger as money: needed headers are
 * gone. `renamed` names the headers Money does not know that hold cells:
 * with any, a missing column is likely there under another name, so
 * `restore` (which adds empty columns) is refused and the fix is his, in
 * the sheet: name the column back.
 */
export type MoneyProblem =
  /** `waits`: the missing headers already wait in the sheet as a suggestion (a restore on a ledger others can open): accepting it there is what is left to do */
  | { kind: 'columns'; missing: string[]; renamed: string[]; waits?: true }
  /**
   * The mileage log cannot be read, so the miles shown are none and are not
   * the truth: `outside`, its file leads out of the job's folder; `columns`,
   * it holds rows and lacks Date or Miles (`missing`); `unreadable`, the
   * sheet could not be opened at all. An export is refused until it is
   * right. The ledger reads all the same.
   */
  | { kind: 'mileage'; reason: 'outside' | 'columns' | 'unreadable'; missing: string[] }

export interface MoneyRead {
  /** false: this job has no ledger yet, and everything below is empty */
  made: boolean
  /** the job has money at all: a ledger row or a trip, in any period. False: nothing has ever been entered */
  any: boolean
  /** the job's Money folder on its host: a row's Receipt is a path under it (`receiptSource`) */
  root: Extract<CanvasSource, { at: 'file' }>
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
  /** what waits for his accept, the oldest first */
  toConfirm: ToConfirm[]
  /** past calendar events not yet added or skipped, the oldest first */
  calendar: CalendarOffer[]
  /** the mileage rate for the year `from` is in, in dollars a mile; `own`: he set it himself */
  rate: MoneyRate
  problems: MoneyProblem[]
}

/** A past calendar event offered as pay and a trip. Whole (a fee and measured miles): one press adds it. */
export interface CalendarOffer {
  eventId: string
  date: string
  title: string
  place: string | null
  /** cents; null: not known */
  fee: number | null
  /** miles there and back; null: not known */
  miles: number | null
  /** the miles are his own or measured along roads; false: an estimate he must check before it is added */
  measured: boolean
}
export interface MoneyEvents {
  events: CalendarOffer[]
}
export interface MoneyTripped {
  /** the event it named was added before: nothing was written this time */
  already?: true
  /** for a trip typed by hand (its `key`): what this Add or an earlier one under its key filed, so a form changed since is not taken for saved */
  filed?: { miles: number | null; fee: number | null; date?: string; title?: string; place?: string }
  /** the event was skipped (in another window, or while this Add waited its turn): nothing was written */
  skipped?: true
  /** the ledger's row for the pay, when there was a fee */
  pay: MoneyActed | null
  /** the mileage log's row, when there were miles; `suggested`: the log is a sheet others can open, and the row waits there as a suggestion */
  trip: { row: number; ref: string | null; value: number; suggested?: true } | null
}
export interface MoneyRate {
  year: number
  rate: number
  own: boolean
}
export interface MoneyExport {
  /** the folder that holds them, on this host */
  folder: CanvasSource
  /** the names of the files made */
  files: string[]
  /** the summary's page, for the window to print: null when no PDF was asked for */
  summary: { name: string; html: string } | null
  /** one line each for what could not be made */
  warnings: string[]
  /** a file this export wrote took the place of an earlier export's */
  replaced: boolean
  /** this export's place among the year's exports, later ones higher: the summary's `keep` sends it back, and the host keeps only the newest export's page */
  generation: number
}
export interface MoneyInvoiceNext {
  number: string
  from: z.infer<typeof InvoiceFromSchema> | null
  /** days from the date to the due date, as he last had them */
  dueDays: number
}
export interface MoneyInvoicePage {
  /** the file's name: "Invoice 1042 Rivera Dental.pdf" */
  name: string
  html: string
}
export interface MoneyKept {
  /** more parts are expected */
  partial?: true
  /** the kept file, on this host */
  source?: CanvasSource
  /** its path under Money/, as the Receipt column holds it */
  receipt?: string
  /** an invoice's row */
  acted?: MoneyActed
  /** a summary took the place of an earlier one in the year's folder */
  replaced?: true
}

/** A row's receipt as a file the window can open: the Receipt cell's path under the job's Money folder, in its host's own spelling. */
export function receiptSource(root: MoneyRead['root'], receipt: string): Extract<CanvasSource, { at: 'file' }> {
  const sep = root.path.includes('\\') && !root.path.includes('/') ? '\\' : '/'
  return { at: 'file', host: root.host, path: [root.path, ...receipt.split(/[\\/]/).filter((part) => part && part !== '.' && part !== '..')].join(sep) }
}

/** One thing that waits for his accept: a receipt being read or read, or an entry a thread left. */
export interface ToConfirm {
  id: string
  /** `reading`: the host is still reading the file; `ready`: the fields are as far as they could be read */
  state: 'reading' | 'ready'
  source: MoneySource
  /** the file's name as it came; null for an entry with no file */
  name: string | null
  /** it has a picture to show beside the fields */
  picture: boolean
  fields: ReceiptFields & { way?: 'in' | 'out'; what?: string }
  /** the thread that left it */
  threadId?: string
  at: number
}

export interface MoneyReceived {
  id: string
  /** `partial`: more parts are expected; `filed`: it is in the ledger already; `dropped`: he discarded it, and a retry does not bring it back */
  state: 'partial' | 'reading' | 'ready' | 'filed' | 'dropped'
  /** with `filed`: the ledger is a sheet others can open, so the row waits there as a suggestion and is not in the ledger until he accepts it */
  suggested?: boolean
}

export interface MoneyPicture {
  mime: string
  name: string
  size: number
  parts: number
  dataBase64: string
}

/** A write's answer: what it wrote, or that the row it named no longer reads as the window saw it (nothing was written; read again). */
export type MoneyActed = { ok: true; ref: string | null; row: number; suggested?: true } | { changed: true }

export interface MoneySums {
  /** `problem`: that job's books could not be read whole (a needed column gone, the mileage log unreadable, the sheet not answering), so its figures here are not its money and must not be shown as if they were */
  rows: { workspaceId: string; sector: SectorKey | null; in: number; out: number; owedToHim: number; heOwes: number; miles: number; currency: 'USD'; problem?: true }[]
}
export interface MoneyOwed {
  /** `both`: the row has money both in and out; the host always says it, and a reader that does not care may leave it out */
  rows: { workspaceId: string; sector: SectorKey | null; row: number; who: string; what: string; amount: number; since: string | null; way: 'toHim' | 'byHim'; reimburse: boolean; both?: boolean }[]
  toConfirm: number
  /** the jobs whose ledger could not be read: what they are owed is not known, which is not nothing */
  problems?: string[]
}
export interface MoneyHits {
  /** `amount` and `way` are the row's one side; a row with money both ways also says `other`, the cents out */
  hits: { row: number; date: string | null; who: string; amount: number; way: 'in' | 'out'; other?: number; category: string; receipt?: string }[]
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
  'work.money.search': 'read',
  'work.money.parse': 'read',
  'work.money.receive': 'operate',
  'work.money.accept': 'operate',
  'work.money.drop': 'operate',
  'work.money.picture': 'read',
  'work.money.events': 'read',
  'work.money.trip': 'operate',
  'work.money.skip': 'operate',
  'work.money.rate': 'operate',
  'work.money.export': 'operate',
  'work.money.invoiceNext': 'read',
  'work.money.invoice': 'operate',
  'work.money.keep': 'operate'
} satisfies CapsOf<typeof MoneyRequestSchemas>
export const MONEY_RELAY = {} satisfies RelayOf<typeof MoneyRequestSchemas>

/** What only the owner does: a thread's own call is refused. */
export const MONEY_OWNER_ONLY: ReadonlySet<string> = new Set([
  'work.money.open',
  'work.money.entry',
  'work.money.paid',
  'work.money.receive',
  'work.money.accept',
  'work.money.drop',
  'work.money.trip',
  'work.money.skip',
  'work.money.rate',
  'work.money.export',
  'work.money.invoice',
  'work.money.keep'
])
