import type { HeldState } from './acts'

/**
 * Whether a held item waits on the owner: the one count the rail, Today,
 * the digest and the phone all show (docs/agents/work-outbox.md "One count").
 * Held, live and failed wait; so does an item that went out of date, until he
 * discards it. One being sent, one he scheduled, and one that went or was
 * discarded do not.
 */
export function needsHim(item: { state: HeldState | string; scheduledFor?: number | null; dismissedAt?: number | null }): boolean {
  if (item.scheduledFor != null) return false
  if (item.state === 'held' || item.state === 'live' || item.state === 'failed') return true
  return item.state === 'stale' && item.dismissedAt == null
}
