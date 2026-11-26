import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, Store, VISIBLE } from './db'
import type { AgentEvent, SessionMeta } from '@shared/events'

/**
 * A log's last two user rows are kept on its fold row as rows land (db.ts `flushEvents`, `userSeqs`), so finding the
 * last user row reads no more of the log than that row; and the sessions table's asks by project, workspace, list
 * and backlog are index searches. Counts and plans: no clock.
 */

let db: ReturnType<typeof openDb>
let store: Store
let ran: string[]

beforeEach(() => {
  db = openDb(':memory:')
  ran = []
  const prepare = db.prepare.bind(db)
  db.prepare = ((sql: string) => {
    const st = prepare(sql)
    for (const name of ['get', 'all', 'run'] as const) {
      const real = st[name].bind(st) as (...args: unknown[]) => unknown
      ;(st as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => (ran.push(sql.replace(/\s+/g, ' ').trim()), real(...args))
    }
    return st
  }) as typeof db.prepare
  store = new Store(db)
})
afterEach(() => db.close())

const meta = (id: string): SessionMeta => ({
  id, parentId: null, projectId: null, workspaceId: null, threadType: null, planPath: null,
  provider: 'claude', model: 'm', reasoning: 'medium', agentType: 'implementer', title: id, cwd: '/tmp',
  status: 'idle', pinned: false, archived: false, fast: false, ultrafast: false, context1m: false,
  busySince: null, pausedAt: null, frozenActiveElapsed: null, threadRules: null, permission: 'edits',
  nativeId: null, createdAt: 1, updatedAt: 1
})
const user = (text: string): AgentEvent => ({ type: 'user-text', text })
const says = (text: string): AgentEvent => ({ type: 'assistant-text', text, delta: false })
/** Statements that walked a log looking for user rows. */
const walks = (): number => ran.filter((sql) => /json_extract\(payload/.test(sql)).length
const kept = (id: string): { last: number; prev: number } =>
  db.prepare('SELECT last_user_seq AS last, prev_user_seq AS prev FROM session_folds WHERE session_id = ?').get(id) as { last: number; prev: number }

describe("a log's last user rows, kept as rows land", () => {
  it('finds the last user row of a long log by its key: no walk, however far back it is', () => {
    store.insertSession(meta('a'))
    store.appendEvent('a', user('told once'))
    for (let i = 0; i < 5000; i++) store.appendEvent('a', says(`row ${i}`))
    store.flushEvents()
    ran.length = 0
    expect(store.lastUserTurnSeq('a')).toBe(1)
    expect(store.lastUserRow('a')).toMatchObject({ seq: 1, first: true, event: { text: 'told once' } })
    expect(walks()).toBe(0)
    // One row crossed SQL for the row itself, by session and seq.
    expect(ran.filter((sql) => / FROM events WHERE session_id = \? AND seq = \?/.test(sql))).toHaveLength(1)
  })

  it('keeps the last two across batches: one user row in a batch, two in a batch, none in a batch', () => {
    store.insertSession(meta('a'))
    store.appendEvent('a', user('one'))
    store.appendEvent('a', says('x'))
    store.flushEvents()
    expect(kept('a')).toEqual({ last: 1, prev: 0 })
    store.appendEvent('a', says('y'))
    store.flushEvents()
    expect(kept('a')).toEqual({ last: 1, prev: 0 })
    store.appendEvent('a', user('two'))
    store.flushEvents()
    expect(kept('a')).toEqual({ last: 4, prev: 1 })
    expect(store.lastUserRow('a')).toMatchObject({ seq: 4, first: false })
    store.appendEvent('a', user('three'))
    store.appendEvent('a', says('z'))
    store.appendEvent('a', user('four'))
    store.flushEvents()
    expect(kept('a')).toEqual({ last: 7, prev: 5 })
    expect(store.lastUserTurnSeq('a')).toBe(7)
    expect(walks()).toBe(0)
  })

  it('a log with no user row says none, and knows it without a walk once it saw the log begin', () => {
    store.insertSession(meta('a'))
    store.appendEvent('a', says('no one asked'))
    store.flushEvents()
    expect(kept('a')).toEqual({ last: 0, prev: 0 })
    expect(store.lastUserTurnSeq('a')).toBeNull()
    expect(store.lastUserRow('a')).toBeNull()
    expect(walks()).toBe(0)
  })

  it('reads the log once where the seqs are not known (a fold from before, rows changed under the store), then keeps them', () => {
    store.insertSession(meta('a'))
    for (const event of [user('one'), says('x'), user('two'), says('y')]) store.appendEvent('a', event)
    store.flushEvents()
    store.forgetSessions(['a'])
    expect(kept('a')).toEqual({ last: -1, prev: -1 })
    expect(store.lastUserRow('a')).toMatchObject({ seq: 3, first: false })
    expect(walks()).toBe(1)
    expect(kept('a')).toEqual({ last: 3, prev: 1 })
    expect(store.lastUserTurnSeq('a')).toBe(3)
    expect(walks()).toBe(1)
    // A session with no fold row at all is read once too, and its row made.
    db.exec(`DELETE FROM session_folds WHERE session_id = 'a'`)
    expect(store.lastUserTurnSeq('a')).toBe(3)
    expect(store.lastUserTurnSeq('a')).toBe(3)
    expect(walks()).toBe(2)
  })

  it('a user row landing on a log whose earlier rows it never saw keeps the one before unknown until asked', () => {
    store.insertSession(meta('a'))
    for (const event of [user('one'), says('x')]) store.appendEvent('a', event)
    store.flushEvents()
    db.exec(`DELETE FROM session_folds WHERE session_id = 'a'`)
    store.appendEvent('a', user('two'))
    store.flushEvents()
    expect(kept('a')).toEqual({ last: 3, prev: -1 })
    // The last alone needs no walk; whether it is the first does, once.
    expect(store.lastUserTurnSeq('a')).toBe(3)
    expect(walks()).toBe(0)
    expect(store.lastUserRow('a')).toMatchObject({ seq: 3, first: false })
    expect(walks()).toBe(1)
    expect(kept('a')).toEqual({ last: 3, prev: 1 })
  })
})

describe('the sessions table is searched, not scanned', () => {
  const plan = (sql: string, ...args: (string | number)[]): string =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map((row) => row.detail).join(' | ')

  it("a project's and a workspace's threads, the list by archived, and the cold mover's backlog each use an index", () => {
    expect(plan(`SELECT * FROM sessions WHERE project_id = ? AND ${VISIBLE}`, 'p')).toMatch(/SEARCH sessions USING INDEX sessions_project/)
    expect(plan(`SELECT * FROM sessions WHERE workspace_id = ? AND ${VISIBLE}`, 'w')).toMatch(/SEARCH sessions USING INDEX sessions_workspace/)
    const list = plan(`SELECT * FROM sessions WHERE ${VISIBLE} AND archived = 0 ORDER BY created_at DESC`)
    expect(list).toMatch(/SEARCH sessions USING INDEX sessions_list/)
    expect(list).not.toMatch(/TEMP B-TREE/)
    for (const sql of [`SELECT * FROM sessions WHERE project_id = 'p' AND ${VISIBLE}`, `SELECT * FROM sessions WHERE workspace_id = 'w' AND ${VISIBLE}`]) {
      expect(plan(sql)).not.toMatch(/SCAN sessions/)
    }
  })

  it('the store asks in those words', () => {
    store.insertSession(meta('a'))
    ran.length = 0
    store.listSessions({ archived: false })
    store.coldBacklog()
    store.sessionsOfProject('p')
    store.sessionsOfWorkspace('w')
    const asked = ran.filter((sql) => /^SELECT .* FROM sessions /.test(sql))
    expect(asked).toHaveLength(5)
    for (const sql of asked) expect(plan(sql.replace(/\?/g, "'x'")), sql).toMatch(/USING (COVERING )?INDEX sessions_(list|to_cold|to_hot|project|workspace)/)
    // The backlog is asked through its own small indexes, which hold only the sessions that wait.
    expect(asked.filter((sql) => /INDEXED BY sessions_to_(cold|hot)/.test(sql))).toHaveLength(2)
  })
})
