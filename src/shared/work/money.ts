/**
 * Money's own rules (docs/agents/work-money.md), pure and free of zod: the
 * ledger's columns, what each status counts as, the categories, the sums,
 * the one receipt parser, and the pages Money prints. The ledger is a sheet
 * he can edit, so everything here reads cells as he may have left them:
 * headers by name in any order, a date in any common form, an unknown
 * status as Paid. Amounts are whole cents everywhere but in the sheet.
 */

// ── the ledger's columns ─────────────────────────────────────────────

export const LEDGER_COLUMNS = ['Date', 'Who', 'For', 'Category', 'In', 'Out', 'Status', 'Paid on', 'Receipt', 'Ref'] as const
export type LedgerColumn = (typeof LEDGER_COLUMNS)[number]
/** Without these the ledger cannot be read as money. */
export const LEDGER_NEEDED: readonly LedgerColumn[] = ['Date', 'In', 'Out']

export const MILEAGE_COLUMNS = ['Date', 'Trip', 'Place', 'Miles', 'Rate', 'Value', 'Ref'] as const
export type MileageColumn = (typeof MILEAGE_COLUMNS)[number]

export const STATUSES = ['Paid', 'Unpaid', 'To reimburse', 'Reimbursed', 'Requested'] as const
export type Status = (typeof STATUSES)[number]

/** A status as the sheet holds it, read without regard to case; an empty or unknown word reads as Paid. */
export function statusOf(cell: unknown): Status {
  const word = String(cell ?? '')
    .trim()
    .toLowerCase()
  return STATUSES.find((s) => s.toLowerCase() === word) ?? 'Paid'
}

/** The starting categories of a job; the ledger's own words join them (`categoriesFor`). */
export const CATEGORIES: Record<string, readonly string[]> = {
  ref: ['Game fees', 'Mileage', 'Uniform and gear', 'Dues and registration', 'Training', 'Travel', 'Meals', 'Other'],
  unify: ['Sales', 'Software', 'Hosting', 'Contractors', 'Equipment', 'Fees', 'Travel', 'Meals', 'Office', 'Taxes', 'Other'],
  purdue: ['Equipment', 'Events', 'Travel', 'Food', 'Software', 'Supplies', 'Other'],
  cosmic: ['Pay', 'Software', 'Equipment', 'Travel', 'Other'],
  hypixel: ['Pay', 'Software', 'Equipment', 'Travel', 'Other'],
  life: ['Home', 'Food', 'Health', 'Travel', 'Giving', 'Other']
}
const ANY_JOB: readonly string[] = ['Income', 'Travel', 'Meals', 'Software', 'Equipment', 'Other']

/** A job's categories: its starting list, then every word the ledger already uses, each once. */
export function categoriesFor(sector: string | null, used: readonly string[] = []): string[] {
  const out = [...(CATEGORIES[sector ?? ''] ?? ANY_JOB)]
  const seen = new Set(out.map((c) => c.toLowerCase()))
  for (const word of used) {
    const w = word.trim()
    if (!w || seen.has(w.toLowerCase())) continue
    seen.add(w.toLowerCase())
    out.push(w)
  }
  return out
}

// ── cells ────────────────────────────────────────────────────────────

export type Cell = string | number | boolean | null | undefined

/** A1's column letters for a column counted from 0. */
export const columnLetter = (i: number): string => {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

/** Whole cents from a cell: a number of dollars, or text like "$1,204.50" or "(12.00)". Zero for anything else. */
export function centsOf(cell: Cell): number {
  if (typeof cell === 'number') return Number.isFinite(cell) ? Math.round(cell * 100) : 0
  if (typeof cell !== 'string') return 0
  const text = cell.trim()
  const m = /^\(?-?\s*\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*\)?$/.exec(text)
  if (!m) return 0
  const n = Math.round(Number(m[1].replace(/,/g, '') + (m[2] ?? '')) * 100)
  return /^\(|^-/.test(text) ? -n : n
}

/** Dollars as the sheet holds them. */
export const dollarsOf = (cents: number): number => Math.round(cents) / 100

/** "$1,204.50"; a minus before the sign for less than nothing. */
export function formatMoney(cents: number): string {
  const abs = Math.abs(Math.round(cents))
  const whole = Math.floor(abs / 100).toLocaleString('en-US')
  return `${cents < 0 ? '-' : ''}$${whole}.${String(abs % 100).padStart(2, '0')}`
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const pad = (n: number): string => String(n).padStart(2, '0')
const iso = (y: number, m: number, d: number): string | null => {
  if (m < 1 || m > 12 || d < 1 || y < 1990 || y > 2100) return null
  // The day must exist in that month: February 30 is not a date.
  if (d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return null
  return `${y}-${pad(m)}-${pad(d)}`
}
const year4 = (y: number): number => (y < 100 ? 2000 + y : y)
const monthOf = (word: string): number => {
  const w = word.toLowerCase().replace(/\.$/, '')
  if (w.length < 3) return 0
  return MONTHS.findIndex((m) => m.startsWith(w) && (w.length === 3 || m === w || (w === 'sept' && m === 'september'))) + 1
}

const DATE_FORMS: readonly [RegExp, (m: RegExpExecArray) => string | null][] = [
  [/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/, (m) => iso(Number(m[1]), Number(m[2]), Number(m[3]))],
  [/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/, (m) => iso(year4(Number(m[3])), Number(m[1]), Number(m[2]))],
  [/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/, (m) => iso(Number(m[3]), monthOf(m[1]), Number(m[2]))],
  [/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/, (m) => iso(Number(m[3]), monthOf(m[2]), Number(m[1]))]
]

/** Every date in a line of text, in the US forms a receipt prints, as ISO days, in the order they stand. */
export function datesIn(text: string): string[] {
  const found: { at: number; day: string }[] = []
  for (const [form, read] of DATE_FORMS) {
    const all = new RegExp(form.source, 'g')
    for (let m = all.exec(text); m; m = all.exec(text)) {
      const day = read(m)
      if (day) found.push({ at: m.index, day })
    }
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.day)
}

/** A day from a cell: ISO text, a US date as he may have typed it, or a sheet's serial number. Null for anything else. */
export function dayOf(cell: Cell): string | null {
  if (typeof cell === 'number') {
    // A spreadsheet's serial day: 25569 is 1970-01-01.
    if (!Number.isFinite(cell) || cell < 32874 || cell > 73415) return null
    return new Date(Math.round((cell - 25569) * 86400_000)).toISOString().slice(0, 10)
  }
  if (typeof cell !== 'string') return null
  return datesIn(cell.trim())[0] ?? null
}

/** Today as a local ISO day. */
export function today(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** "Nov 21, 2026" from an ISO day. */
export function formatDay(day: string, withYear = true): string {
  const [y, m, d] = day.split('-').map(Number)
  const month = MONTHS[m - 1]
  if (!month || !d) return day
  return `${month[0].toUpperCase()}${month.slice(1, 3)} ${d}${withYear ? `, ${y}` : ''}`
}

/** Whole days from one ISO day to another. */
export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400_000)

// ── rows ─────────────────────────────────────────────────────────────

export interface LedgerRow {
  /** the row's number in the sheet */
  row: number
  /** Money's own id for a row it wrote; a row he typed has none */
  ref: string | null
  /** an ISO day; null when the cell holds none */
  date: string | null
  who: string
  /** the For column */
  what: string
  category: string
  /** cents in */
  in: number
  /** cents out */
  out: number
  status: Status
  paidOn: string | null
  /** the receipt's path under Money/, or empty */
  receipt: string
}

/** Where each column stands in the header, counted from 0; absent when the sheet has no such header. */
export type Columns<C extends string> = Partial<Record<C, number>>

/** Finds each column by its header's name, in any order and any case. */
export function columnsOf<C extends string>(header: readonly Cell[], names: readonly C[]): Columns<C> {
  const at: Columns<C> = {}
  header.forEach((cell, i) => {
    const word = String(cell ?? '')
      .trim()
      .toLowerCase()
    const name = names.find((n) => n.toLowerCase() === word)
    if (name && at[name] === undefined) at[name] = i
  })
  return at
}

export interface LedgerRead {
  rows: LedgerRow[]
  columns: Columns<LedgerColumn>
  /** the needed headers the sheet lacks: with any, no row is read */
  missing: LedgerColumn[]
}

const textOf = (cell: Cell): string => (cell === null || cell === undefined ? '' : String(cell).trim())

/**
 * The ledger's rows from its cells: `header` is row 1, `body` the rows
 * under it. A row with no date, no name and no amount is a blank line and
 * is left out; every other row is read, whoever typed it.
 */
export function rowsOf(header: readonly Cell[], body: readonly (readonly Cell[])[], firstRow = 2): LedgerRead {
  const columns = columnsOf(header, LEDGER_COLUMNS)
  const missing = LEDGER_NEEDED.filter((c) => columns[c] === undefined)
  if (missing.length) return { rows: [], columns, missing }
  const at = (line: readonly Cell[], c: LedgerColumn): Cell => (columns[c] === undefined ? undefined : line[columns[c]!])
  const rows: LedgerRow[] = []
  body.forEach((line, i) => {
    const date = dayOf(at(line, 'Date'))
    const who = textOf(at(line, 'Who'))
    const cin = Math.abs(centsOf(at(line, 'In')))
    const cout = Math.abs(centsOf(at(line, 'Out')))
    if (!date && !who && !cin && !cout) return
    rows.push({
      row: firstRow + i,
      ref: textOf(at(line, 'Ref')) || null,
      date,
      who,
      what: textOf(at(line, 'For')),
      category: textOf(at(line, 'Category')),
      in: cin,
      out: cout,
      status: statusOf(at(line, 'Status')),
      paidOn: dayOf(at(line, 'Paid on')),
      receipt: textOf(at(line, 'Receipt'))
    })
  })
  return { rows, columns, missing: [] }
}

/** What a row was when the window last saw it: its date, name and amounts. A row that no longer reads so has changed. */
export const sigOf = (row: Pick<LedgerRow, 'date' | 'who' | 'in' | 'out'>): string => `${row.date ?? ''}|${row.who}|${row.in}|${row.out}`

/** How the window names a row to act on: by `ref` when Money wrote it, else by number and what it read. */
export interface RowAt {
  ref?: string | null
  row: number
  sig: string
}

/** The row an act names, in a fresh read: by Ref first, else by its number when it still reads the same. Null: the ledger changed. */
export function findRow(rows: readonly LedgerRow[], at: RowAt): LedgerRow | null {
  if (at.ref) {
    const byRef = rows.filter((r) => r.ref === at.ref)
    if (byRef.length === 1) return byRef[0]
  }
  const same = rows.find((r) => r.row === at.row)
  return same && sigOf(same) === at.sig ? same : null
}

// ── what a row counts as ─────────────────────────────────────────────

export interface Counted {
  /** money that came in */
  income: number
  /** money he spent and it is his cost (or will be until it is paid back) */
  cost: number
  /** not yet paid to him: an unpaid sale, or a cost waiting to be paid back */
  owedToHim: number
  /** a bill he has not paid */
  heOwes: number
}

/** The status table (the plan's): what one row adds to each sum. */
export function countOf(row: Pick<LedgerRow, 'in' | 'out' | 'status'>): Counted {
  const c: Counted = { income: 0, cost: 0, owedToHim: 0, heOwes: 0 }
  if (row.in) {
    if (row.status === 'Unpaid') c.owedToHim += row.in
    else c.income += row.in
  }
  if (row.out) {
    if (row.status === 'Unpaid') c.heOwes += row.out
    else if (row.status === 'To reimburse') {
      c.cost += row.out
      c.owedToHim += row.out
    } else if (row.status === 'Paid') c.cost += row.out
    // Reimbursed or Requested: not his cost.
  }
  return c
}

/** A span of local days: `from` is in it, `to` is not. */
export interface Period {
  from: string
  to: string
}
export const inPeriod = (day: string | null, p: Period): boolean => day !== null && day >= p.from && day < p.to

export const monthPeriod = (year: number, month: number): Period => ({
  from: `${year}-${pad(month)}-01`,
  to: month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`
})
export const yearPeriod = (year: number): Period => ({ from: `${year}-01-01`, to: `${year + 1}-01-01` })

export interface Sums {
  /** the period's */
  in: number
  out: number
  net: number
  /** not the period's: everything still open */
  owedToHim: number
  heOwes: number
}

export function sumsOf(rows: readonly LedgerRow[], period: Period): Sums {
  const s: Sums = { in: 0, out: 0, net: 0, owedToHim: 0, heOwes: 0 }
  for (const row of rows) {
    const c = countOf(row)
    s.owedToHim += c.owedToHim
    s.heOwes += c.heOwes
    if (!inPeriod(row.date, period)) continue
    s.in += c.income
    s.out += c.cost
  }
  s.net = s.in - s.out
  return s
}

export interface CategorySum {
  category: string
  /** signed cents: money in is above nothing, money out below */
  amount: number
  /** its part of all the money going its way in the period, 0 to 1 */
  share: number
}

/** The period's money by category, the largest first. A row with no category counts under "Other". */
export function byCategory(rows: readonly LedgerRow[], period: Period): CategorySum[] {
  const sums = new Map<string, { name: string; amount: number }>()
  let totalIn = 0
  let totalOut = 0
  for (const row of rows) {
    if (!inPeriod(row.date, period)) continue
    const c = countOf(row)
    if (!c.income && !c.cost) continue
    const name = row.category || 'Other'
    const sum = sums.get(name.toLowerCase()) ?? { name, amount: 0 }
    sum.amount += c.income - c.cost
    sums.set(name.toLowerCase(), sum)
    totalIn += c.income
    totalOut += c.cost
  }
  return [...sums.values()]
    .filter((s) => s.amount !== 0)
    .map((s) => ({ category: s.name, amount: s.amount, share: Math.abs(s.amount) / ((s.amount > 0 ? totalIn : totalOut) || 1) }))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount) || a.category.localeCompare(b.category))
}

export interface MonthSum {
  /** 1 to 12 */
  month: number
  in: number
  out: number
}

/** A year's money in and out, month by month. */
export function byMonth(rows: readonly LedgerRow[], year: number): MonthSum[] {
  const months: MonthSum[] = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, in: 0, out: 0 }))
  for (const row of rows) {
    if (!row.date || Number(row.date.slice(0, 4)) !== year) continue
    const c = countOf(row)
    const m = months[Number(row.date.slice(5, 7)) - 1]
    m.in += c.income
    m.out += c.cost
  }
  return months
}

export interface OwedRow {
  row: number
  ref: string | null
  sig: string
  who: string
  what: string
  amount: number
  /** the row's date: what the wait is counted from */
  since: string | null
  way: 'toHim' | 'byHim'
}

/** Every open row, the oldest first: what is owed to him, and what he owes. */
export function owedOf(rows: readonly LedgerRow[]): OwedRow[] {
  const out: OwedRow[] = []
  for (const row of rows) {
    const c = countOf(row)
    const base = { row: row.row, ref: row.ref, sig: sigOf(row), who: row.who, what: row.what, since: row.date }
    if (c.owedToHim) out.push({ ...base, amount: c.owedToHim, way: 'toHim' })
    if (c.heOwes) out.push({ ...base, amount: c.heOwes, way: 'byHim' })
  }
  return out.sort((a, b) => (a.since ?? '9999').localeCompare(b.since ?? '9999') || a.row - b.row)
}

/** What paying an open row writes: an unpaid row is Paid, a cost waiting to be paid back is Reimbursed. */
export const paidStatus = (status: Status): Status => (status === 'To reimburse' || status === 'Requested' ? 'Reimbursed' : 'Paid')

// ── mileage ──────────────────────────────────────────────────────────

/**
 * Dollars a business mile, by year. The last one we are sure of stands for
 * every later year until he sets that year's own (More → Mileage rate…).
 */
export const MILEAGE_RATES: Record<number, number> = { 2023: 0.655, 2024: 0.67, 2025: 0.7 }

/** The rate for a year: his own for it, else the table's, else the newest year before it that has one. */
export function rateFor(year: number, own: Record<number, number> = {}): number {
  const all = { ...MILEAGE_RATES, ...own }
  if (all[year] !== undefined) return all[year]
  const before = Object.keys(all)
    .map(Number)
    .filter((y) => y < year)
    .sort((a, b) => b - a)[0]
  return all[before ?? Math.min(...Object.keys(all).map(Number))]
}

export interface MileageRow {
  row: number
  ref: string | null
  date: string | null
  trip: string
  place: string
  miles: number
  /** dollars a mile */
  rate: number
  /** cents */
  value: number
}

export function mileageOf(header: readonly Cell[], body: readonly (readonly Cell[])[], firstRow = 2): MileageRow[] {
  const columns = columnsOf(header, MILEAGE_COLUMNS)
  if (columns.Miles === undefined) return []
  const at = (line: readonly Cell[], c: MileageColumn): Cell => (columns[c] === undefined ? undefined : line[columns[c]!])
  const num = (cell: Cell): number => (typeof cell === 'number' && Number.isFinite(cell) ? cell : Number(String(cell ?? '').replace(/[$,\s]/g, '')) || 0)
  const rows: MileageRow[] = []
  body.forEach((line, i) => {
    const miles = num(at(line, 'Miles'))
    if (!miles) return
    const rate = num(at(line, 'Rate'))
    const value = at(line, 'Value')
    rows.push({
      row: firstRow + i,
      ref: textOf(at(line, 'Ref')) || null,
      date: dayOf(at(line, 'Date')),
      trip: textOf(at(line, 'Trip')),
      place: textOf(at(line, 'Place')),
      miles,
      rate,
      value: value === undefined || value === null || value === '' ? Math.round(miles * rate * 100) : centsOf(value)
    })
  })
  return rows
}

export interface MilesSum {
  miles: number
  /** cents */
  value: number
  /** the one rate every trip of the period was logged at, in dollars; null when they differ or there is none */
  rate: number | null
}

export function milesOf(rows: readonly MileageRow[], period: Period): MilesSum {
  const inside = rows.filter((r) => inPeriod(r.date, period))
  const rates = new Set(inside.map((r) => r.rate))
  return {
    miles: Math.round(inside.reduce((n, r) => n + r.miles, 0) * 10) / 10,
    value: inside.reduce((n, r) => n + r.value, 0),
    rate: rates.size === 1 ? [...rates][0] : null
  }
}

/** "412 mi · $288.40 at $0.70": the view's one line. */
export function milesLine(sum: MilesSum): string {
  const miles = `${sum.miles.toLocaleString('en-US')} mi · ${formatMoney(sum.value)}`
  return sum.rate === null ? miles : `${miles} at $${sum.rate.toFixed(sum.rate * 100 === Math.round(sum.rate * 100) ? 2 : 3)}`
}

// ── reading a receipt ────────────────────────────────────────────────

/** One run of text a reader found, with where it stands: `[left, top, right, bottom]` in any one unit, top-left first. */
export interface ReceiptLine {
  text: string
  box?: readonly [number, number, number, number]
  score?: number
}

export interface ReceiptFields {
  /** cents */
  amount: number | null
  /** an ISO day, never after today */
  date: string | null
  who: string | null
  category: string | null
}

export interface ParseHints {
  sector?: string | null
  /** the category he last gave each seller in this ledger, by the seller's name in lower case */
  known?: Readonly<Record<string, string>>
  /** an ISO day: no date after it is read (the default is this machine's today) */
  today?: string
}

/**
 * The text as a person reads it: runs that stand on one line are joined
 * left to right (a label and its amount come back from a reader as two
 * boxes), and the lines run top to bottom. Runs with no box keep the order
 * they came in, one a line.
 */
export function joinLines(lines: readonly ReceiptLine[]): string[] {
  const boxed = lines.filter((l) => l.box && l.text.trim())
  if (boxed.length !== lines.filter((l) => l.text.trim()).length) return lines.map((l) => l.text.trim()).filter(Boolean)
  const sorted = [...boxed].sort((a, b) => a.box![1] + a.box![3] - (b.box![1] + b.box![3]))
  const rows: ReceiptLine[][] = []
  for (const line of sorted) {
    const [, top, , bottom] = line.box!
    const last = rows[rows.length - 1]
    const peer = last?.[0].box
    // On one line when they share more than half of the shorter one's height.
    const shared = peer ? Math.min(bottom, peer[3]) - Math.max(top, peer[1]) : 0
    if (peer && shared > 0.5 * Math.min(bottom - top, peer[3] - peer[1])) last.push(line)
    else rows.push([line])
  }
  return rows.map((row) =>
    row
      .sort((a, b) => a.box![0] - b.box![0])
      .map((l) => l.text.trim())
      .join(' ')
  )
}

const FIGURE = /(?<![\d.,/-])(\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{2})?(?![\d/%-]|\.\d)|\$\s?\d+(?:\.\d{2})?(?![\d/%-]|\.\d)|\d{1,3}(?:,\d{3})+\.\d{2}(?![\d/%-]|\.\d)|\d+\.\d{2}(?![\d/%-]|\.\d))/g
/** Every money figure in a line, in cents: a number with cents, or one after a dollar sign. */
export function figuresIn(text: string): number[] {
  return [...text.matchAll(FIGURE)].map((m) => Math.round(Number(m[1].replace(/[$,\s]/g, '')) * 100)).filter((n) => Number.isFinite(n))
}

const TOTAL_WORDS = /\b(grand\s+total|amount\s+due|balance\s+due|total\s+due|balance|total)\b/i
const NOT_THE_TOTAL = /\b(sub\s*-?\s*total|total\s+(tax|savings|discount|items?|qty|points)|tax\s+total|items?\s+total)\b/i

const CATEGORY_WORDS: readonly [RegExp, readonly string[]][] = [
  [/\b(fuel|gasoline|unleaded|diesel|gallons?|parking|garage|toll|airlines?|hotel|inn|lodging|uber|lyft|taxi|rental)\b/i, ['Travel']],
  [/\b(cafe|coffee|restaurant|trattoria|grill|pizza|diner|bakery|deli|kitchen|burger|taco|espresso|latte|bistro|bar)\b/i, ['Meals', 'Food']],
  [/\b(software|subscription|license|licence|saas|cloud|domain|hosting)\b/i, ['Software', 'Hosting']],
  [/\b(hardware|lumber|tools?|electronics|office\s+supply|supplies)\b/i, ['Equipment', 'Supplies', 'Office', 'Home']],
  [/\b(uniform|whistle|referee|jersey|cleats|sporting)\b/i, ['Uniform and gear', 'Equipment']]
]

/** A seller's name as it should read in the ledger: one space between words, no stray marks, and not in capitals. */
export function cleanSeller(text: string): string {
  const flat = text
    .replace(/\s+/g, ' ')
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9.)]+$/g, '')
    .trim()
  const shown = /[a-z]/.test(flat) ? flat : flat.toLowerCase().replace(/(^|[\s\-/&(])([a-z])/g, (_, lead: string, letter: string) => lead + letter.toUpperCase())
  return shown.slice(0, 60).trim()
}

const sellerLike = (row: string): boolean => {
  const letters = row.replace(/[^A-Za-z]/g, '').length
  if (letters < 3) return false
  if (datesIn(row).length || figuresIn(row).length) return false
  // A line that is mostly digits is a phone number or an address, not a name.
  return letters >= row.replace(/[^0-9]/g, '').length
}

/**
 * The one receipt parser: four fields from a reader's lines, each null when
 * it could not be read. It guesses nothing and calls no model.
 *
 * The amount is the figure beside the last of Total, Amount due, Balance or
 * Grand total (a figure on that line, else the next line's), else the
 * largest money figure. The date is the first one that is not after today.
 * The seller is the first line of words above the first figure. The
 * category is the one he last gave that seller, else what the receipt's
 * own words say, when the job has such a category.
 */
export function parseReceipt(lines: readonly ReceiptLine[], hints: ParseHints = {}): ReceiptFields {
  const rows = joinLines(lines)
  const notAfter = hints.today ?? today()

  let amount: number | null = null
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!TOTAL_WORDS.test(row) || NOT_THE_TOTAL.test(row)) continue
    const here = figuresIn(row)
    // A label on a line of its own: its figure is the next line's, when that line is a figure alone.
    const next = here.length || i + 1 >= rows.length || /[A-Za-z]{3}/.test(rows[i + 1]) ? [] : figuresIn(rows[i + 1])
    const found = here.length ? here[here.length - 1] : next[0]
    if (found !== undefined) amount = found
  }
  if (amount === null) {
    const all = rows.flatMap(figuresIn)
    if (all.length) amount = Math.max(...all)
  }

  const date = rows.flatMap(datesIn).find((d) => d <= notAfter) ?? null

  const firstFigure = rows.findIndex((row) => figuresIn(row).length > 0)
  const above = firstFigure < 0 ? rows : rows.slice(0, firstFigure)
  const sellerRow = above.find(sellerLike)
  const who = sellerRow ? cleanSeller(sellerRow) || null : null

  let category: string | null = (who && hints.known?.[who.toLowerCase()]) || null
  if (!category) {
    const list = categoriesFor(hints.sector ?? null)
    const all = rows.join('\n')
    for (const [words, names] of CATEGORY_WORDS) {
      if (!words.test(all)) continue
      const name = names.find((n) => list.includes(n))
      if (name) {
        category = name
        break
      }
    }
  }
  return { amount, date, who, category }
}

/** The category he last gave each seller, from the ledger's own rows, newest row winning. */
export function knownSellers(rows: readonly LedgerRow[]): Record<string, string> {
  const known: Record<string, string> = {}
  for (const row of rows) if (row.who && row.category) known[row.who.toLowerCase()] = row.category
  return known
}

// ── names of files ───────────────────────────────────────────────────

/** A word safe in a file's name on every system, with nothing that could leave its folder. */
export const fileWord = (text: string, max = 60): string =>
  text
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, max)
    .trim()

/** "2026-11-21 Blue Heron Coffee 10.43.png": a kept receipt's name. */
export function receiptName(f: { date: string | null; who: string | null; amount: number | null }, ext: string): string {
  const amount = f.amount === null ? '' : (Math.abs(f.amount) / 100).toFixed(2)
  const words = [f.date ?? '', fileWord(f.who ?? '', 40), amount].filter(Boolean).join(' ')
  return `${words || 'Receipt'}.${ext.replace(/^\./, '').toLowerCase() || 'pdf'}`
}

// ── out: the CSV ─────────────────────────────────────────────────────

const csvCell = (cell: string | number): string => {
  const text = String(cell)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}
const csvLine = (cells: readonly (string | number)[]): string => cells.map(csvCell).join(',')

/** A year's ledger as RFC 4180 text: its rows under the ledger's own headers, then the mileage log's under its own. */
export function csvOf(rows: readonly LedgerRow[], mileage: readonly MileageRow[], year: number): string {
  const period = yearPeriod(year)
  const lines = [csvLine(LEDGER_COLUMNS)]
  for (const r of rows) {
    if (!inPeriod(r.date, period)) continue
    lines.push(csvLine([r.date ?? '', r.who, r.what, r.category, r.in ? dollarsOf(r.in).toFixed(2) : '', r.out ? dollarsOf(r.out).toFixed(2) : '', r.status, r.paidOn ?? '', r.receipt, r.ref ?? '']))
  }
  const trips = mileage.filter((m) => inPeriod(m.date, period))
  if (trips.length) {
    lines.push('', csvLine(MILEAGE_COLUMNS))
    for (const m of trips) lines.push(csvLine([m.date ?? '', m.trip, m.place, m.miles, m.rate, dollarsOf(m.value).toFixed(2), m.ref ?? '']))
  }
  return lines.join('\r\n') + '\r\n'
}

// ── out: the pages Money prints ──────────────────────────────────────

const esc = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** One plain page style for what Money prints: black on white, system type, hairline tables. A printed page is paper, so it names its own inks. */
const PAGE_CSS = `
  @page { margin: 0.75in; }
  body { font: 11pt/1.45 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #111; margin: 0; }
  h1 { font-size: 18pt; font-weight: 600; margin: 0 0 2pt; }
  h2 { font-size: 11pt; font-weight: 600; margin: 20pt 0 4pt; }
  p { margin: 0; }
  .muted { color: #555; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th { text-align: left; font-weight: 600; font-size: 9pt; color: #555; border-bottom: 1px solid #999; padding: 4pt 8pt 4pt 0; }
  td { border-bottom: 1px solid #ddd; padding: 4pt 8pt 4pt 0; vertical-align: top; }
  th.n, td.n { text-align: right; padding-right: 0; }
  tr.total td { border-bottom: 0; font-weight: 600; }
  .two { display: flex; justify-content: space-between; gap: 24pt; margin-top: 16pt; }
  .pre { white-space: pre-line; }
`

const page = (title: string, body: string): string => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body>${body}</body></html>`

/**
 * The year for tax time on one page set: totals by category, in, out,
 * mileage and its value, then every row with its receipt's name. Costs
 * paid back (Reimbursed, Requested) are listed and left out of the sums,
 * as everywhere else.
 */
export function taxSummaryHtml(rows: readonly LedgerRow[], mileage: readonly MileageRow[], o: { year: number; job: string }): string {
  const period = yearPeriod(o.year)
  const sums = sumsOf(rows, period)
  const cats = byCategory(rows, period)
  const miles = milesOf(mileage, period)
  const inside = rows.filter((r) => inPeriod(r.date, period)).sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.row - b.row)
  const catRows = cats.map((c) => `<tr><td>${esc(c.category)}</td><td class="n">${c.amount > 0 ? '+' : ''}${formatMoney(Math.abs(c.amount))}</td></tr>`).join('')
  const rowLines = inside
    .map((r) => {
      const amount = r.in ? `+${formatMoney(r.in)}` : formatMoney(r.out)
      const receipt = r.receipt ? esc(r.receipt.split('/').pop() ?? r.receipt) : ''
      return `<tr><td>${esc(r.date ?? '')}</td><td>${esc(r.who)}</td><td>${esc(r.category)}</td><td>${esc(r.status)}</td><td class="n">${amount}</td><td>${receipt}</td></tr>`
    })
    .join('')
  const body = `
    <h1>${esc(o.job)}: ${o.year}</h1>
    <p class="muted">Money in and out, from the ledger.</p>
    <h2>Totals</h2>
    <table>
      <tr><td>In</td><td class="n">${formatMoney(sums.in)}</td></tr>
      <tr><td>Out</td><td class="n">${formatMoney(sums.out)}</td></tr>
      <tr class="total"><td>Net</td><td class="n">${formatMoney(sums.net)}</td></tr>
    </table>
    ${miles.miles ? `<h2>Mileage</h2><p>${esc(milesLine(miles))}</p>` : ''}
    ${catRows ? `<h2>By category</h2><table>${catRows}</table>` : ''}
    <h2>Every entry</h2>
    <table><tr><th>Date</th><th>Who</th><th>Category</th><th>Status</th><th class="n">Amount</th><th>Receipt</th></tr>${rowLines}</table>`
  return page(`${o.job} ${o.year}`, body)
}

export interface InvoiceLine {
  what: string
  quantity: number
  /** cents for one */
  rate: number
}
/** His own details on what he sends: asked whole once, then kept. */
export interface InvoiceFrom {
  name: string
  address: string
  /** how to pay him, in his words */
  pay: string
}
export interface Invoice {
  /** an invoice asks to be paid; a purchase request asks leave to buy */
  kind: 'invoice' | 'request'
  number: string
  /** who it goes to: the client, or for a request the vendor */
  to: string
  date: string
  due: string | null
  lines: InvoiceLine[]
  from: InvoiceFrom
  /** a request's reason */
  reason?: string
}

export const INVOICE_FIRST = 1001
export const INVOICE_DUE_DAYS = 14

export const lineTotal = (line: InvoiceLine): number => Math.round(line.quantity * line.rate)
export const invoiceTotal = (lines: readonly InvoiceLine[]): number => lines.reduce((n, l) => n + lineTotal(l), 0)

/** The number after the highest one used: 1001 for the first. */
export function nextInvoiceNumber(used: readonly (string | number)[]): number {
  const numbers = used.map((u) => Number(String(u).replace(/\D/g, ''))).filter((n) => Number.isInteger(n) && n > 0)
  return numbers.length ? Math.max(...numbers) + 1 : INVOICE_FIRST
}

/** A day that many days after an ISO day. */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400_000).toISOString().slice(0, 10)
}

/** Money's own plain invoice page, and the purchase request under its name. */
export function invoiceHtml(inv: Invoice): string {
  const request = inv.kind === 'request'
  const title = request ? `Purchase request ${inv.number}` : `Invoice ${inv.number}`
  const lines = inv.lines
    .map((l) => `<tr><td>${esc(l.what)}</td><td class="n">${l.quantity}</td><td class="n">${formatMoney(l.rate)}</td><td class="n">${formatMoney(lineTotal(l))}</td></tr>`)
    .join('')
  const body = `
    <h1>${esc(title)}</h1>
    <p class="muted">${esc(formatDay(inv.date))}${inv.due ? ` · ${request ? 'Needed by' : 'Due'} ${esc(formatDay(inv.due))}` : ''}</p>
    <div class="two">
      <div><h2>From</h2><p>${esc(inv.from.name)}</p><p class="muted pre">${esc(inv.from.address)}</p></div>
      <div><h2>${request ? 'Vendor' : 'To'}</h2><p class="pre">${esc(inv.to)}</p></div>
    </div>
    ${request && inv.reason ? `<h2>Reason</h2><p class="pre">${esc(inv.reason)}</p>` : ''}
    <h2>${request ? 'Items' : 'For'}</h2>
    <table>
      <tr><th>What</th><th class="n">Quantity</th><th class="n">Rate</th><th class="n">Amount</th></tr>
      ${lines}
      <tr class="total"><td>Total</td><td></td><td></td><td class="n">${formatMoney(invoiceTotal(inv.lines))}</td></tr>
    </table>
    ${!request && inv.from.pay ? `<h2>How to pay</h2><p class="pre">${esc(inv.from.pay)}</p>` : ''}`
  return page(title, body)
}
