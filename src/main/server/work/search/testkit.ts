import { DatabaseSync } from 'node:sqlite'
import type { MentionReach } from '@shared/work'
import type { SearchHit, SearchReach } from '@shared/work/search'
import type { Caller, WorkCtx } from '../modules'
import { ensureRecents } from './recents'
import type { SearchSource } from './source'

/**
 * What the search pillar's tests share: one host with three jobs (Purdue,
 * Cosmic and one with no sector), a code workspace, a LifeOS that answers
 * from a table of made-up rows, and the callers. Dummy names only.
 */

export const PURDUE = 'ws-purdue'
export const COSMIC = 'ws-cosmic'
export const BARE = 'ws-bare'
export const CODE = 'ws-code'

export const window: Caller = { kind: 'local', caps: ['read', 'operate', 'approve', 'admin'] }
export const phone: Caller = { kind: 'remote', caps: ['read', 'operate', 'approve'] }
export const thread = (sessionId = 't1'): Caller => ({ kind: 'model', caps: [], sessionId })

export const jobs: SearchReach['workspaces'] = [
  { id: PURDUE, sector: 'purdue', name: 'Purdue' },
  { id: COSMIC, sector: 'cosmic', name: 'Cosmic' },
  { id: BARE, sector: null, name: 'Side job' }
]
export const everywhere: SearchReach = { workspaces: jobs, chats: true, sessionId: null }
export const onlyPurdue: SearchReach = { workspaces: [jobs[0]], chats: false, sessionId: null }

export interface Rig {
  db: DatabaseSync
  ctx: WorkCtx
  logs: string[]
  /** every LifeOS query made, by function */
  asked: { fn: string; args: Record<string, unknown> }[]
  /** what LifeOS answers a function: rows, or a function of the args */
  rows: Record<string, unknown>
  /** flips LifeOS to a state that is not connected, in its own words */
  lifeosDown(words?: string): void
  /** the paths a remote key may name */
  reachable: Set<string>
  /** what `ctx.mentionReach` answers a thread */
  reaches: Map<string, MentionReach | null>
}

export function makeRig(): Rig {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'code', sector TEXT, created_at INTEGER NOT NULL)`)
  const add = db.prepare(`INSERT INTO workspaces (id, name, path, kind, sector, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
  jobs.forEach((w, i) => add.run(w.id, w.name, `/work/${w.id}`, 'work', w.sector, i + 1))
  add.run(CODE, 'temp-code', '/code/temp-code', 'code', 'cosmic', 9)
  ensureRecents(db)
  const logs: string[] = []
  const asked: Rig['asked'] = []
  const rows: Record<string, unknown> = {}
  let down: string | null = null
  const reachable = new Set<string>()
  const reaches = new Map<string, MentionReach | null>()
  const ctx = {
    db,
    host: 'env_box',
    log: (line: string) => void logs.push(line),
    reaches: (by: Caller, path: string) => by.kind !== 'remote' || reachable.has(path),
    mentionReach: (sessionId: string) => reaches.get(sessionId) ?? null,
    lifeos: {
      connected: () => down === null,
      owner: () => ({
        query: async (fn: string, args: Record<string, unknown> = {}) => {
          if (down !== null) throw Object.assign(new Error(down), { name: 'LifeosUnavailable' })
          asked.push({ fn, args })
          const answer = rows[fn]
          return typeof answer === 'function' ? (answer as (a: Record<string, unknown>) => unknown)(args) : answer
        }
      })
    }
  } as unknown as WorkCtx
  return { db, ctx, logs, asked, rows, lifeosDown: (words = 'This host is not signed in to LifeOS') => void (down = words), reachable, reaches }
}

/** A hit of made-up values. */
export const hit = (key: string, workspaceId: string | null, over: Partial<SearchHit> = {}): SearchHit => ({
  key,
  kind: 'mail',
  title: key,
  workspaceId,
  open: { to: 'view', view: 'mail', with: { mail: key } },
  ...over
})

/** A source that answers what it is given, and counts its asks. */
export function fakeSource(kind: string, answer: SearchHit[] | ((ask: Parameters<SearchSource['search']>[0]) => Promise<SearchHit[]> | SearchHit[]), over: Partial<SearchSource> = {}): SearchSource & { asks: Parameters<SearchSource['search']>[0][] } {
  const asks: Parameters<SearchSource['search']>[0][] = []
  return {
    kind,
    label: kind,
    tier: 'instant',
    asks,
    async search(ask) {
      asks.push(ask)
      return typeof answer === 'function' ? answer(ask) : answer
    },
    ...over
  }
}
