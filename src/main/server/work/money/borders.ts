import { formatDay, moneyWords } from '@shared/work/money'
import type { SearchSource } from '../search/source'
import { searchMoney } from './read'
import { workspaceOf } from './store'

/**
 * Money at its borders with the other pillars (docs/agents/work-money.md
 * "For others"): how Work search finds a ledger's rows, and the one kind of
 * news Money tells through the digest. The sums the weekly review shows
 * (`work.money.sums`) and what Today lists (`work.money.owed`) are plain
 * reads on the wire.
 */

/** A ledger's rows in Work search: each job in reach is asked, and a hit opens the Money view of its job. */
export const moneySearch: SearchSource = {
  kind: 'money',
  label: 'Money',
  // The ledger is a sheet on this host, read through the Work service's own socket and kept by revision: no network.
  tier: 'instant',
  // The ledger's own order, newest first: nothing here ranks one row over another.
  unranked: true,
  async search(ask, ctx) {
    const hits = await Promise.all(
      ask.reach.workspaces.map(async (reach) => {
        const ws = workspaceOf(ctx, reach.id)
        if (!ws) return []
        const found = await searchMoney(ctx, ws, ask.text, ask.limit + 1).catch(() => ({ hits: [] }))
        return found.hits.map((h) => ({
          key: `money:${ws.id}:${h.row}`,
          kind: 'money',
          title: h.who || h.category || 'Entry',
          detail: [h.date ? formatDay(h.date) : null, moneyWords(h.way === 'in' ? { in: h.amount, out: h.other ?? 0 } : { in: 0, out: h.amount }), h.category || null].filter(Boolean).join(', '),
          ...(h.date ? { at: Date.parse(`${h.date}T12:00:00`) } : {}),
          workspaceId: ws.id,
          open: { to: 'view' as const, view: 'money', with: { row: h.row } }
        }))
      })
    )
    return hits
      .flat()
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
      .slice(0, ask.limit + 1)
  }
}

/** What Money tells through the digest (`ctx.tell`): a receipt the phone or a thread left waiting. It may wait, so it carries no `by`. */
export const MONEY_TELLS = [{ kind: 'money.confirm', group: 'results', name: 'Receipts to confirm' }] as const
