import type { DigestDay } from '@shared/contract-work-digest'
import type { DigestStore, LedgerRow } from './store'

/**
 * Making a day's digest (docs/agents/work-digest.md): every row no digest
 * holds yet is stamped with the day, and the day is counted by the rows
 * that waited (one he was told of at once is in the day's list and not in
 * its count). A day with nothing that waited makes nothing; a day is never
 * made twice.
 */
export function makeDay(store: DigestStore, day: string, now: number): { day: DigestDay; rows: LedgerRow[] } | null {
  if (store.day(day)) return null
  const rows = store.unstamped()
  const waited = rows.filter((r) => r.toldAt == null)
  if (waited.length === 0) return null
  const made: DigestDay = { day, madeAt: now, seenAt: null, count: waited.length }
  if (!store.addDay(made)) return null
  store.stamp(
    day,
    rows.map((r) => r.id)
  )
  store.prune(now)
  return { day: made, rows: waited.map((r) => ({ ...r, day, how: 'digest' as const })) }
}
