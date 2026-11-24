import { z } from 'zod'
import { workText, type WorkToolResult } from '@shared/work'
import { errorText } from '@shared/work/ids'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, sep } from 'node:path'
import { centsFrom, formatMoney, inPeriod, isDay, milesLine, milesOf, moneyWords, sumsOf, today, undatedWords, type LedgerRow } from '@shared/work/money'
import type { ToolCtx, WorkTool } from '../modules'
import { leave } from './inbox'
import { booksHere, LEDGER_OUTSIDE, ledgerOf, ledgerOutside, mileageLog, mileageWords, MoneyError } from './read'
import { workspaceOf, type Workspace } from './store'

/**
 * What a Work thread may do with money (docs/agents/work-money.md "The
 * tools"): read its own job's ledger, and leave an entry or a receipt in
 * the owner's To confirm list. Nothing here writes the ledger: only his
 * accept does.
 */

const fail = (text: string): WorkToolResult => ({ ...workText(text), isError: true })
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
/** A day an entry is filed on: one the ledger will read back (a date that exists, 1990 to 2100). */
const filedDay = day.refine(isDay, 'a date that exists, from 1990 to 2100')

/** The most rows one read lists; the sums are always of every row asked for. */
export const READ_ROWS_MAX = 200

const lineOf = (r: LedgerRow): string =>
  [r.date ?? 'no date', r.who || 'no name', r.category || 'no category', moneyWords(r), r.status, r.what, r.receipt ? `receipt: ${r.receipt}` : ''].filter(Boolean).join(' | ')

const moneyRead: WorkTool = {
  name: 'money_read',
  description:
    "Reads this job's ledger: money in and out, what is owed, and each entry for a span of days. Read only. The ledger is a sheet the owner keeps; to add to it use money_add or money_receipt, which wait for the owner's accept.",
  input: z.object({
    from: day.optional().describe('First day, YYYY-MM-DD. Default: January 1 of this year.'),
    to: day.optional().describe('The day after the last day, YYYY-MM-DD. Default: tomorrow.'),
    category: z.string().max(100).optional().describe('Only entries in this category.')
  }),
  readOnly: true,
  async run(args, ctx: ToolCtx) {
    const a = args as { from?: string; to?: string; category?: string }
    const ws = ctx.scope.workspaceId ? workspaceOf(ctx, ctx.scope.workspaceId) : null
    if (!ws) return fail('This thread is not in a job, so it has no ledger to read.')
    if (ledgerOutside(ctx, ws.id)) return fail(LEDGER_OUTSIDE)
    const books = booksHere(ctx, ws.id)
    if (!books) return workText(`${ws.name} has no ledger yet.`)
    try {
      const now = today()
      const period = { from: a.from ?? `${now.slice(0, 4)}-01-01`, to: a.to ?? new Date(Date.parse(`${now}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10) }
      const [ledger, log] = await Promise.all([ledgerOf(ctx, books), mileageLog(ctx, books)])
      if (ledger.twice?.length) return fail(`The ledger's columns changed: ${ledger.twice.join(', ')} stands twice. The owner puts it right in the ledger.`)
      if (ledger.missing.length) return fail(`The ledger's columns changed: it has no ${ledger.missing.join(', ')} column. The owner restores them in the Money view.`)
      const trips = log.trips
      const wanted = a.category?.trim().toLowerCase()
      const all = wanted ? ledger.rows.filter((r) => r.category.toLowerCase() === wanted) : ledger.rows
      const rows = all.filter((r) => inPeriod(r.date, period)).sort((x, y) => (x.date ?? '').localeCompare(y.date ?? '') || x.row - y.row)
      const sums = sumsOf(all, period)
      const miles = milesOf(trips, period)
      const head = [
        `${ws.name}, ${period.from} up to ${period.to}${wanted ? `, ${a.category}` : ''}`,
        `In ${formatMoney(sums.in)}, out ${formatMoney(sums.out)}, net ${formatMoney(sums.net)}`,
        `Owed to the owner ${formatMoney(sums.owedToHim)}, the owner owes ${formatMoney(sums.heOwes)} (all time)`,
        ...(log.problem ? [`Mileage: not read. ${mileageWords(log.problem)}`] : miles.miles && !wanted ? [`Mileage: ${milesLine(miles)}`] : []),
        ...(ledger.undated.length ? [undatedWords(ledger.undated)] : [])
      ]
      const shown = rows.slice(-READ_ROWS_MAX)
      const cut = rows.length > shown.length ? [`Showing the latest ${shown.length} of ${rows.length} entries: narrow the days to see the rest.`] : []
      return workText([...head, '', ...(shown.length ? shown.map(lineOf) : ['No entries.']), ...cut].join('\n'))
    } catch (err) {
      return fail(`The ledger could not be read: ${errorText(err)}`)
    }
  }
}

const jobOf = (ctx: ToolCtx): Workspace | null => (ctx.scope.workspaceId ? workspaceOf(ctx, ctx.scope.workspaceId) : null)
const NO_JOB = 'This thread is not in a job, so it has no ledger.'

/** One key for one thing a thread leaves: the same call again answers the first and leaves nothing twice. */
const keyOf = (ctx: ToolCtx, what: unknown): string => `agent:${ctx.sessionId}:${createHash('sha256').update(JSON.stringify(what)).digest('hex').slice(0, 24)}`

/**
 * A file a thread may hand to Money: one of this host, in its job's own
 * folder or among the files the canvas keeps for this thread's own pane (an
 * attachment one of its items fetched). A thread names no other file of his.
 */
function fileFor(ctx: ToolCtx, ws: Workspace, path: string): string {
  if (!isAbsolute(path)) throw new MoneyError('Name the file by its full path on this computer.')
  let real: string
  try {
    real = realpathSync(path)
  } catch {
    throw new MoneyError('There is no file at that path on this computer.')
  }
  const inside = (root: string): boolean => existsSync(root) && real.startsWith(realpathSync(root) + sep)
  // Its own pane's fetched files and no other's: not another job's waiting receipts, another thread's canvas, or anything else the app keeps.
  const pane = join(ctx.dataDir, 'canvas', ctx.canvas.paneOf(ctx.sessionId))
  if (!inside(ws.path) && !inside(pane)) throw new MoneyError("A thread files a receipt from its job's own folder or from an item in its own canvas.")
  return real
}

/** The file of an item in this thread's canvas: a file's own path, or the copy a mail's attachment was fetched to (the canvas keeps it under its item's folder). */
function fileOfItem(ctx: ToolCtx, itemId: string): string {
  const item = ctx.canvas.get(itemId)
  if (!item || item.sessionId !== ctx.canvas.paneOf(ctx.sessionId)) throw new MoneyError(`This thread has no item ${itemId} in its canvas.`)
  if (item.source.at === 'file') {
    if (item.source.host !== ctx.host) throw new MoneyError('That file is on another computer.')
    return item.source.path
  }
  const dir = join(ctx.dataDir, 'canvas', item.sessionId, item.id, 'file')
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => !f.endsWith('.part')) : []
  if (files.length !== 1) throw new MoneyError(`${item.title} has not been opened yet, so its file is not on this computer: open it in the canvas first.`)
  return join(dir, files[0])
}

const moneyAdd: WorkTool = {
  name: 'money_add',
  description:
    "Leaves one entry (money in or out) in the owner's To confirm list in Money. It is not in the ledger until the owner accepts it: say so. Use money_receipt instead when all you have is a receipt's file.",
  input: z.object({
    date: filedDay.describe('The day, YYYY-MM-DD.'),
    who: z.string().min(1).max(200).describe('Who was paid, or who pays.'),
    amount: z.number().positive().max(1_000_000_000).describe('Dollars, above zero: 48.17'),
    way: z.enum(['in', 'out']).describe('`out`: money the owner spent. `in`: money the owner is paid.'),
    category: z.string().max(100).optional(),
    for: z.string().max(500).optional().describe('What it was for, in a few words.'),
    file: z.string().max(4000).optional().describe("A receipt's full path on this computer, in this job's folder."),
    key: z.string().min(1).max(100).optional().describe('A word of your own for this entry. Send the same key only to retry this same call; each entry otherwise waits on its own, two equal ones too.')
  }),
  readOnly: false,
  async run(args, ctx: ToolCtx) {
    const a = args as { date: string; who: string; amount: number; way: 'in' | 'out'; category?: string; for?: string; file?: string; key?: string }
    const ws = jobOf(ctx)
    if (!ws) return fail(NO_JOB)
    try {
      // Cents by the ledger's own rule (half a cent goes up), and never an amount that rounds to nothing.
      const amount = centsFrom(a.amount)
      if (amount < 1) return fail('The amount is less than a cent.')
      const got = await leave(ctx, {
        // Two calls with the same fields are two entries (two $12 parking fees on one day): only the thread's own key, sent
        // again, says a call is a retry of the first.
        key: a.key ? keyOf(ctx, { key: a.key }) : `agent:${ctx.sessionId}:${randomUUID()}`,
        ws,
        sessionId: ctx.sessionId,
        fields: { amount, date: a.date, who: a.who.trim(), category: a.category?.trim() || null, way: a.way, ...(a.for?.trim() ? { what: a.for.trim() } : {}) },
        ...(a.file ? { file: fileFor(ctx, ws, a.file) } : {})
      })
      const words = `${a.who.trim()}, ${a.way === 'in' ? '+' : ''}${formatMoney(amount)}, ${a.date}`
      return workText(got.fresh ? `Left for the owner to confirm in Money: ${words}. It is not in the ledger until he accepts it.` : `That entry was already left for the owner (${words}): nothing was added twice.`)
    } catch (err) {
      return fail(err instanceof MoneyError ? err.message : `The entry could not be left: ${errorText(err)}`)
    }
  }
}

const moneyReceipt: WorkTool = {
  name: 'money_receipt',
  description:
    "Hands a receipt's file (a picture or a PDF) to Money: it is read on the owner's own computer and waits in his To confirm list with what was read. It is not in the ledger until the owner accepts it.",
  input: z.object({
    file: z.string().max(4000).optional().describe("The receipt's full path on this computer, in this job's folder."),
    item: z.string().max(100).optional().describe("Or the id of a PDF or picture item in this thread's canvas (a mail's attachment that is open there).")
  }),
  readOnly: false,
  async run(args, ctx: ToolCtx) {
    const a = args as { file?: string; item?: string }
    const ws = jobOf(ctx)
    if (!ws) return fail(NO_JOB)
    if (!a.file === !a.item) return fail('Name the receipt by `file` or by `item`, one of the two.')
    try {
      const file = fileFor(ctx, ws, a.file ?? fileOfItem(ctx, a.item!))
      const got = await leave(ctx, { key: keyOf(ctx, { receipt: file }), ws, sessionId: ctx.sessionId, file })
      return workText(got.fresh ? 'The receipt is with Money: it is being read and will wait for the owner to confirm. It is not in the ledger until he accepts it.' : 'That receipt was already handed to Money: nothing was added twice.')
    } catch (err) {
      return fail(err instanceof MoneyError ? err.message : `The receipt could not be handed over: ${errorText(err)}`)
    }
  }
}

export const moneyTools: WorkTool[] = [moneyRead, moneyAdd, moneyReceipt]
