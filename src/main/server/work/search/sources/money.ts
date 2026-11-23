import type { SearchHit } from '@shared/work/search'
import { WORK_MODULES, type WorkModule } from '../../modules'
import { askPillar } from '../ask'
import type { SearchSource } from '../source'

/**
 * The ledger's rows, which are Money's to find (docs/agents/work-search.md
 * "Files and Messages"): search asks `work.money.search`, a job in reach at
 * a time, and opens a hit in that job's Money view. Absent until the pillar
 * answers; it stands down once Money's module lists its own `search` line.
 */

/** One hit as `work.money.search` answers it (src/shared/contract-work-money.ts `MoneyHits`). */
export interface MoneyRow {
  row: number
  /** a local day, `2026-11-21`, or null */
  date: string | null
  who: string
  /** cents */
  amount: number
  way?: 'in' | 'out'
  category: string
}

const amountWords = (row: MoneyRow): string => `${row.way === 'in' ? '+' : ''}$${(row.amount / 100).toFixed(2)}`

const hitOf = (row: MoneyRow, workspaceId: string): SearchHit => {
  const at = row.date ? Date.parse(`${row.date}T12:00:00`) : Number.NaN
  return {
    key: `money:${workspaceId}:${row.row}`,
    kind: 'money',
    title: row.who || row.category || 'A ledger row',
    detail: [amountWords(row), row.who ? row.category : ''].filter(Boolean).join(', '),
    ...(Number.isFinite(at) ? { at } : {}),
    workspaceId,
    open: { to: 'view', view: 'money' }
  }
}

export function moneySource(modules: readonly WorkModule[] = WORK_MODULES): SearchSource {
  return {
    kind: 'money',
    label: 'Money',
    // The ledger is a sheet read through the Work service: never in the instant tier.
    tier: 'network',
    async search(ask, ctx) {
      const each = await Promise.all(
        ask.reach.workspaces.map(async (w) =>
          ((await askPillar<{ hits?: MoneyRow[] }>(ctx, modules, 'work.money.search', { workspaceId: w.id, query: ask.text, limit: ask.limit + 1 }, ask.by, ask.signal))?.hits ?? []).map((row) => hitOf(row, w.id))
        )
      )
      // Newest first across the jobs, as each ledger answers its own.
      return each
        .flat()
        .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
        .slice(0, ask.limit + 1)
    }
  }
}
