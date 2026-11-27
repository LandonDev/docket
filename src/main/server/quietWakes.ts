import { writtenByOwner, type AgentEvent, type SessionMeta, type SessionStatus, type UserTextBy } from '@shared/events'

/**
 * Who started a thread's turn (docs/agents/read-and-unread.md "Quiet
 * wakes"): the person (his own message or steer), another thread (a
 * master's or a parent's message), or the app (a subagent's or the batch's
 * report, a background task's notice, a scheduled wake, the notes reminder,
 * a turn the harness started itself). A resume after a restart, a pause or
 * a fixed error keeps the turn's own origin.
 */
export type TurnBy = 'person' | 'thread' | 'app'

export function turnByOf(by: UserTextBy | undefined): TurnBy {
  if (!by) return 'app'
  if (writtenByOwner(by)) return 'person'
  return by.kind === 'thread' ? 'thread' : 'app'
}

/** The statuses a new turn starts from; a waiting or paused turn goes on as the same turn. */
export const TURN_EDGE: ReadonlySet<SessionStatus | undefined> = new Set<SessionStatus | undefined>([
  undefined,
  'idle',
  'watching',
  'done',
  'error',
  'stopped',
  'queued'
])

/** The statuses that end a turn in the log; `stopped` is the cut a restart leaves, not an end. */
const TURN_ENDS: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['idle', 'watching', 'done', 'error'])

/**
 * The origin of the newest turn, read from its log rows (oldest first):
 * walking back past the turn's own end, the user row that started it says
 * who; the turn end before it, met first, means the app started it. Null:
 * the rows reach back past neither.
 */
export function turnByFromLog(events: readonly AgentEvent[]): TurnBy | null {
  let worked = false
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'user-text') return turnByOf(e.by)
    if (e.type !== 'status') continue
    if (e.status === 'running' || e.status === 'starting') worked = true
    else if (worked && TURN_ENDS.has(e.status)) return 'app'
  }
  return null
}

/** A master in these needs him or failed: its mark is not kept read. */
const NEWS_STATUSES: ReadonlySet<SessionStatus> = new Set<SessionStatus>(['waiting', 'error', 'stopped'])

/** A pinned, live root master, not in a state that is news by itself. */
export function quietMaster(s: Pick<SessionMeta, 'isMaster' | 'parentId' | 'archived' | 'status'>): boolean {
  return s.isMaster === true && !s.parentId && !s.archived && !NEWS_STATUSES.has(s.status)
}
