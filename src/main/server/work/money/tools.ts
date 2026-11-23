import { z } from 'zod'
import { workText, type WorkToolResult } from '@shared/work'
import { errorText } from '@shared/work/ids'
import { formatMoney, inPeriod, milesLine, milesOf, sumsOf, today, type LedgerRow } from '@shared/work/money'
import type { ToolCtx, WorkTool } from '../modules'
import { booksHere, ledgerOf, mileageRows } from './read'
import { workspaceOf } from './store'

/**
 * What a Work thread may do with money (docs/agents/work-money.md "The
 * tools"): read its own job's ledger. Nothing here writes the ledger; what
 * an agent adds waits in the owner's To confirm list.
 */

const fail = (text: string): WorkToolResult => ({ ...workText(text), isError: true })
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

/** The most rows one read lists; the sums are always of every row asked for. */
export const READ_ROWS_MAX = 200

const lineOf = (r: LedgerRow): string =>
  [r.date ?? 'no date', r.who || 'no name', r.category || 'no category', r.in ? `+${formatMoney(r.in)}` : formatMoney(r.out), r.status, r.what, r.receipt ? `receipt: ${r.receipt}` : ''].filter(Boolean).join(' | ')

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
    const books = booksHere(ctx, ws.id)
    if (!books) return workText(`${ws.name} has no ledger yet.`)
    try {
      const now = today()
      const period = { from: a.from ?? `${now.slice(0, 4)}-01-01`, to: a.to ?? new Date(Date.parse(`${now}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10) }
      const [ledger, trips] = await Promise.all([ledgerOf(ctx, books), mileageRows(ctx, books)])
      if (ledger.missing.length) return fail(`The ledger's columns changed: it has no ${ledger.missing.join(', ')} column. The owner restores them in the Money view.`)
      const wanted = a.category?.trim().toLowerCase()
      const all = wanted ? ledger.rows.filter((r) => r.category.toLowerCase() === wanted) : ledger.rows
      const rows = all.filter((r) => inPeriod(r.date, period)).sort((x, y) => (x.date ?? '').localeCompare(y.date ?? '') || x.row - y.row)
      const sums = sumsOf(all, period)
      const miles = milesOf(trips, period)
      const head = [
        `${ws.name}, ${period.from} up to ${period.to}${wanted ? `, ${a.category}` : ''}`,
        `In ${formatMoney(sums.in)}, out ${formatMoney(sums.out)}, net ${formatMoney(sums.net)}`,
        `Owed to the owner ${formatMoney(sums.owedToHim)}, the owner owes ${formatMoney(sums.heOwes)} (all time)`,
        ...(miles.miles && !wanted ? [`Mileage: ${milesLine(miles)}`] : [])
      ]
      const shown = rows.slice(-READ_ROWS_MAX)
      const cut = rows.length > shown.length ? [`Showing the latest ${shown.length} of ${rows.length} entries: narrow the days to see the rest.`] : []
      return workText([...head, '', ...(shown.length ? shown.map(lineOf) : ['No entries.']), ...cut].join('\n'))
    } catch (err) {
      return fail(`The ledger could not be read: ${errorText(err)}`)
    }
  }
}

export const moneyTools: WorkTool[] = [moneyRead]
