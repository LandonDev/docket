import type { DatabaseSync } from 'node:sqlite'
import type { GuestAttemptAnswer, GuestCreated, GuestCreatedAgain, GuestLinkRow } from '@shared/contract-work-guests'
import { errorText } from '@shared/work'

/**
 * His Create link answered once by its attempt key (docs/agents/work-guests.md
 * "The phone"; the iPhone plan's "Never twice, never silently"), as Messages'
 * Send is (messages/attempts.ts). The phone names each press with a key and
 * writes it down before the request leaves. The host keeps what each key did
 * for a day: a repeat (a double tap, an answer lost on the way back) makes no
 * second link. A repeat while the first is still making waits on the same
 * answer, address and all; a repeat after it answers gets the link with no
 * address (`GuestCreatedAgain`), since the address is never kept, only its
 * hash. `work.guests.attempt` reads a key back without making anything.
 */

export const ATTEMPT_KEPT_MS = 24 * 60 * 60 * 1000
/** A key reused for a link to another item, or for another person: nothing is made, nothing is said of the first. */
export const ATTEMPT_OTHER = 'That attempt was for another link'
/** A key whose making was cut off by a restart of the host: the link may stand, so the item's links say. */
export const ATTEMPT_CUT = 'The host restarted while making the link. Look in its live links before making another.'
/** A key that made a link since revoked or ended and no longer listed. */
export const ATTEMPT_GONE = 'That link was made and no longer opens anything.'

type State = 'making' | 'made' | 'refused'
type Row = { attempt: string; ask: string; state: State; answer: string | null; at: number }

export function ensureGuestAttemptsTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_guests_attempts (
    attempt TEXT PRIMARY KEY,
    ask TEXT NOT NULL,
    state TEXT NOT NULL,
    answer TEXT,
    at INTEGER NOT NULL
  )`)
}

/** Creates still running, by database and key: a repeat that comes meanwhile waits on the same answer. */
const flights = new WeakMap<DatabaseSync, Map<string, Promise<GuestCreated>>>()
const flightsOf = (db: DatabaseSync): Map<string, Promise<GuestCreated>> => {
  let map = flights.get(db)
  if (!map) flights.set(db, (map = new Map()))
  return map
}

const prune = (db: DatabaseSync, now: number): void => {
  db.prepare('DELETE FROM work_guests_attempts WHERE at < ?').run(now - ATTEMPT_KEPT_MS)
}

const rowOf = (db: DatabaseSync, attempt: string): Row | undefined =>
  db.prepare('SELECT attempt, ask, state, answer, at FROM work_guests_attempts WHERE attempt = ?').get(attempt) as Row | undefined

const settle = (db: DatabaseSync, attempt: string, state: State, answer: string): void => {
  db.prepare('UPDATE work_guests_attempts SET state = ?, answer = ? WHERE attempt = ?').run(state, answer, attempt)
}

/** What one press asked for: the item as named, and who for. The same key for anything else is another press. */
export const askOf = (p: { source: unknown; name: string }): string => JSON.stringify([p.source, p.name.trim()])

/**
 * Runs `make` once for a key. The row is written before anything is made, in
 * the same turn as the check, so two presses that arrive together find it. A
 * key seen before answers as it did: the same refusal, or the link it made
 * without its address; one for another link is refused.
 */
export async function makeOnce(
  db: DatabaseSync,
  p: { attempt: string; ask: string },
  make: () => Promise<GuestCreated>,
  linkOf: (id: string) => Promise<GuestLinkRow | null>,
  now: number = Date.now()
): Promise<GuestCreated | GuestCreatedAgain> {
  prune(db, now)
  const live = flightsOf(db)
  const seen = rowOf(db, p.attempt)
  if (seen) {
    if (seen.ask !== p.ask) throw new Error(ATTEMPT_OTHER)
    const flying = live.get(p.attempt)
    if (flying) return flying
    if (seen.state === 'making') throw new Error(ATTEMPT_CUT)
    if (seen.state === 'refused') throw new Error(seen.answer ?? ATTEMPT_CUT)
    const link = seen.answer ? await linkOf(seen.answer) : null
    if (!link) throw new Error(ATTEMPT_GONE)
    return { link, again: true }
  }
  db.prepare('INSERT INTO work_guests_attempts (attempt, ask, state, answer, at) VALUES (?, ?, ?, NULL, ?)').run(p.attempt, p.ask, 'making', now)
  const run = (async () => {
    try {
      const made = await make()
      settle(db, p.attempt, 'made', made.link.id)
      return made
    } catch (err) {
      settle(db, p.attempt, 'refused', errorText(err))
      throw err
    } finally {
      live.delete(p.attempt)
    }
  })()
  live.set(p.attempt, run)
  return run
}

/** What became of a key, read without making anything: `none` when this host never heard it. */
export function guestAttemptOf(db: DatabaseSync, attempt: string, now: number = Date.now()): GuestAttemptAnswer {
  prune(db, now)
  const row = rowOf(db, attempt)
  if (!row) return { state: 'none' }
  switch (row.state) {
    case 'making':
      return flightsOf(db).has(attempt) ? { state: 'making' } : { state: 'unknown', words: ATTEMPT_CUT }
    case 'made':
      return { state: 'made', linkId: row.answer ?? '' }
    case 'refused':
      return { state: 'refused', words: row.answer ?? '' }
  }
}

/**
 * Replace Address answered once by its key (the phone's press), on the same rows as Create's: a repeat after a lost
 * answer rotates nothing again and answers `again` with no address, which was shown once and is never kept; the
 * key reads back through `guestAttemptOf` (`made` is the rotation done).
 */
export async function rekeyOnce(
  db: DatabaseSync,
  p: { attempt: string; linkId: string },
  rekey: () => Promise<GuestCreated>,
  linkOf: (id: string) => Promise<GuestLinkRow | null>,
  now: number = Date.now()
): Promise<{ url: string } | { again: true }> {
  const answer = await makeOnce(db, { attempt: p.attempt, ask: JSON.stringify(['rekey', p.linkId]) }, rekey, linkOf, now)
  return 'url' in answer ? { url: answer.url } : { again: true }
}
