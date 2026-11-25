import type { DatabaseSync } from 'node:sqlite'
import type { MessagesAttemptAnswer, MessagesSendAnswer } from '@shared/contract-work-messages'
import { errorText } from '@shared/work'
import { REPLY_MAY_HAVE_GONE } from '@shared/work/messages'

/**
 * His Send answered once by its attempt key (docs/agents/work-messages.md
 * "The phone"; the iPhone plan's "Never twice, never silently"). The phone
 * names each press with a key of its own and writes it down before the
 * request leaves. The host keeps each key's answer for a day: a repeat of the
 * key (a double tap, an answer lost on the way back) gets the first answer
 * and LifeOS is never asked twice. `work.messages.attempt` reads a key's
 * answer without sending anything, so a press whose answer was lost is read
 * back on the next link and never sent again by the phone itself.
 */

export const ATTEMPT_KEPT_MS = 24 * 60 * 60 * 1000
/** A key reused for a reply in another conversation or job: nothing is sent, nothing is said of the first. */
export const ATTEMPT_OTHER = 'That attempt was for another reply'
/** A key whose send was cut off by a restart of the host before LifeOS answered. */
export const ATTEMPT_CUT = `${REPLY_MAY_HAVE_GONE}: the host restarted before LifeOS answered`

type State = 'sending' | 'sent' | 'refused' | 'unknown'
type Row = { attempt: string; workspace_id: string; chat_id: string; state: State; answer: string | null; at: number }

export function ensureAttemptsTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_messages_attempts (
    attempt TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    state TEXT NOT NULL,
    answer TEXT,
    at INTEGER NOT NULL
  )`)
}

/** Sends still waiting on LifeOS, by database and key: a repeat that comes meanwhile waits on the same answer. */
const flights = new WeakMap<DatabaseSync, Map<string, Promise<MessagesSendAnswer>>>()
const flightsOf = (db: DatabaseSync): Map<string, Promise<MessagesSendAnswer>> => {
  let map = flights.get(db)
  if (!map) flights.set(db, (map = new Map()))
  return map
}

const prune = (db: DatabaseSync, now: number): void => {
  db.prepare('DELETE FROM work_messages_attempts WHERE at < ?').run(now - ATTEMPT_KEPT_MS)
}

const rowOf = (db: DatabaseSync, attempt: string): Row | undefined =>
  db.prepare('SELECT attempt, workspace_id, chat_id, state, answer, at FROM work_messages_attempts WHERE attempt = ?').get(attempt) as Row | undefined

const settle = (db: DatabaseSync, attempt: string, state: State, answer: string): void => {
  db.prepare('UPDATE work_messages_attempts SET state = ?, answer = ? WHERE attempt = ?').run(state, answer, attempt)
}

/** The first answer again: the reply's id, or the same refusal or may-have-gone words. */
function replay(row: Row): MessagesSendAnswer {
  if (row.state === 'sent' && row.answer) return { id: row.answer }
  if (row.state === 'sending') throw new Error(ATTEMPT_CUT)
  throw new Error(row.answer ?? ATTEMPT_CUT)
}

/**
 * Runs `send` once for a key. The row is written before LifeOS hears of the
 * reply, in the same turn as the check, so two presses that arrive together
 * find it. A key seen before answers as it did; one for another reply is
 * refused.
 */
export async function sendOnce(
  db: DatabaseSync,
  p: { workspaceId: string; chatId: string; attempt: string },
  send: () => Promise<MessagesSendAnswer>,
  now: number = Date.now()
): Promise<MessagesSendAnswer> {
  prune(db, now)
  const live = flightsOf(db)
  const seen = rowOf(db, p.attempt)
  if (seen) {
    if (seen.workspace_id !== p.workspaceId || seen.chat_id !== p.chatId) throw new Error(ATTEMPT_OTHER)
    return live.get(p.attempt) ?? replay(seen)
  }
  db.prepare('INSERT INTO work_messages_attempts (attempt, workspace_id, chat_id, state, answer, at) VALUES (?, ?, ?, ?, NULL, ?)').run(p.attempt, p.workspaceId, p.chatId, 'sending', now)
  const run = (async () => {
    try {
      const answer = await send()
      settle(db, p.attempt, 'sent', answer.id)
      return answer
    } catch (err) {
      const words = errorText(err)
      settle(db, p.attempt, words.startsWith(REPLY_MAY_HAVE_GONE) ? 'unknown' : 'refused', words)
      throw err
    } finally {
      live.delete(p.attempt)
    }
  })()
  live.set(p.attempt, run)
  return run
}

/** What became of a key, read without sending: `none` when this host never heard it for this job. */
export function attemptOf(db: DatabaseSync, p: { workspaceId: string; attempt: string }, now: number = Date.now()): MessagesAttemptAnswer {
  prune(db, now)
  const row = rowOf(db, p.attempt)
  if (!row || row.workspace_id !== p.workspaceId) return { state: 'none' }
  switch (row.state) {
    case 'sending':
      return flightsOf(db).has(p.attempt) ? { state: 'sending' } : { state: 'unknown', words: ATTEMPT_CUT }
    case 'sent':
      return { state: 'sent', id: row.answer ?? '' }
    case 'refused':
      return { state: 'refused', words: row.answer ?? '' }
    case 'unknown':
      return { state: 'unknown', words: row.answer ?? ATTEMPT_CUT }
  }
}

/** A deleted workspace takes its keys with it. */
export function dropWorkspaceAttempts(db: DatabaseSync, workspaceId: string): void {
  db.prepare('DELETE FROM work_messages_attempts WHERE workspace_id = ?').run(workspaceId)
}
