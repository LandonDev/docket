import { TELL_GROUPS, type Tell, type TellGroup, type TellKind, type TellLevel, type TellOpen } from '@shared/work/tell'

/**
 * The whole rule (docs/agents/work-digest.md): whether a tell interrupts or
 * waits for the day's digest. What he asked for answers him as it always
 * did and never comes here; what arrives on its own waits, unless only he
 * can unblock it and it will not keep.
 */

/** A thing due this long after the next digest still interrupts: one due at 9:30 is not first heard of at 8:00. */
export const KEEP_MS = 2 * 3_600_000

/** A due row whose clock passed longer ago than this is no longer sent late: it waits for the digest. */
export const LATE_MS = 24 * 3_600_000

/**
 * A routine's question or approval reaches him at once, as any thread's
 * does. True: a routine's questions wait for the digest as its results do
 * (gate.ts reads it).
 */
export const ROUTINE_ASKS_WAIT = false

/**
 * `level` is the group's setting. `clock`: at once when the tell has a
 * `by` that falls before the next digest plus `KEEP_MS`, else it waits.
 * `now`: always at once. `digest`: always waits.
 */
export function decide(t: { by?: number | null }, level: TellLevel, nextDigestAt: number): 'now' | 'wait' {
  if (level === 'now') return 'now'
  if (level === 'digest') return 'wait'
  return t.by != null && t.by < nextDigestAt + KEEP_MS ? 'now' : 'wait'
}

/** A row already told at once is told again on a replace only when its clock moved earlier. */
export const retold = (prev: { by?: number | null }, next: { by?: number | null }): boolean => next.by != null && (prev.by == null || next.by < prev.by)

/** The digest's own kinds: what its gate and its sources tell for pillars that hand a read, not a tell. */
export const DIGEST_TELLS: TellKind[] = [
  { kind: 'routines.done', group: 'results', name: 'A routine finished' },
  { kind: 'routines.failed', group: 'results', name: 'A routine failed' },
  { kind: 'routines.stuck', group: 'results', name: 'A routine went quiet' },
  { kind: 'routines.asks', group: 'results', name: 'A routine asks' },
  { kind: 'connections.ending', group: 'ending', name: 'A sign-in or licence is about to end' },
  { kind: 'mail.waiting', group: 'people', name: 'Sent mail with no answer' },
  { kind: 'docs.guest', group: 'people', name: 'A guest edited a document' },
  { kind: 'capture.unsorted', group: 'system', name: 'Captures to sort' },
  { kind: 'winvm.failed', group: 'system', name: 'The Windows VM needs you' },
  { kind: 'prep.starting', group: 'meetings', name: 'A meeting is about to start' },
  { kind: 'prep.ready', group: 'meetings', name: 'Prep is ready' },
  // A sibling that tells for itself lists its own kinds; one that does not yet is given its group here (the first listing wins).
  { kind: 'review.ready', group: 'review', name: 'The weekly review' },
  { kind: 'messages.new', group: 'people', name: 'New chat' }
]

/**
 * Where a press goes for a kind whose teller names no target: the weekly
 * review tells with its week in its key (`review:<the week's first day>`)
 * and no `open`.
 */
export function defaultOpen(t: Pick<Tell, 'kind' | 'key'>): TellOpen | undefined {
  if (t.kind === 'review.ready') {
    const at = t.key?.startsWith('review:') ? t.key.slice('review:'.length) : ''
    return { place: 'review', ...(at ? { at } : {}) }
  }
  return undefined
}

/** Every listed kind's group, by kind; a kind two modules list keeps the first. */
export function groupsByKind(modules: readonly { tells?: TellKind[] }[]): Map<string, TellGroup> {
  const out = new Map<string, TellGroup>()
  for (const module of modules) for (const t of module.tells ?? []) if (!out.has(t.kind) && TELL_GROUPS.includes(t.group)) out.set(t.kind, t.group)
  return out
}

/** The groups some module lists a kind for, in the list's own order. */
export function groupsListed(modules: readonly { tells?: TellKind[] }[]): TellGroup[] {
  const listed = new Set(groupsByKind(modules).values())
  return TELL_GROUPS.filter((g) => listed.has(g))
}
