import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionMeta } from '@shared/events'
import { WORK_SETTING_KEY } from '@shared/work'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'

/**
 * A Work root's outcome line rides its session summary (`SessionMeta.workOutcome`, work/threads/record.ts): the
 * registry asks Work's hook with the decorated meta, for a Work root alone; a code thread's and a subagent's meta are
 * as they were. `refreshMeta` says a thread's meta again when what Work folds into it moved.
 */

vi.mock('./drivers', () => ({ BUILT_IN_DRIVERS: {} }))

let root: string
let db: ReturnType<typeof openDb>
let store: Store
let registry: SessionRegistry

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tc-work-outcome-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
  const ws = join(root, 'repo')
  await mkdir(ws)
  store.insertWorkspace({ id: 'ws1', name: 'repo', path: ws, git: false, createdAt: 1 })
  store.insertProject({ id: 'p1', workspaceId: 'ws1', name: 'app', mode: 'local', branch: null, cwd: ws, archived: false, createdAt: 1 })
  store.setSetting(WORK_SETTING_KEY, JSON.stringify({ enabled: true }))
})
afterEach(async () => {
  await registry.close()
  db.close()
  await rm(root, { recursive: true, force: true })
})

describe('the outcome in the session summary', () => {
  it('folds Work’s outcome into a Work root alone, from its decorated meta', async () => {
    const asked: SessionMeta[] = []
    registry.workOutcomeOf = (meta) => (asked.push(meta), { words: '1 mail to send', tone: 'held' })
    const work = await registry.create({ scope: 'work', threadType: 'chat', workspaceId: null, provider: 'claude' })
    const code = await registry.create({ projectId: 'p1', threadType: 'chat', provider: 'claude' })
    expect(registry.get(work.id)?.workOutcome).toEqual({ words: '1 mail to send', tone: 'held' })
    expect(registry.get(code.id)).not.toHaveProperty('workOutcome')
    expect(asked.every((m) => m.id === work.id && m.scope === 'work' && 'treeHasLiveWork' in m)).toBe(true)
  })

  it('without Work mounted, no thread carries it', async () => {
    const work = await registry.create({ scope: 'work', threadType: 'chat', workspaceId: null, provider: 'claude' })
    expect(registry.get(work.id)).not.toHaveProperty('workOutcome')
  })

  it('says a thread’s meta again on refreshMeta, with the outcome as it is now', async () => {
    let words = '1 mail to send'
    registry.workOutcomeOf = () => ({ words, tone: 'held' })
    const work = await registry.create({ scope: 'work', threadType: 'chat', workspaceId: null, provider: 'claude' })
    const heard: SessionMeta[] = []
    registry.onMeta((meta) => void heard.push(meta))
    words = 'Mail sent'
    registry.refreshMeta([work.id, 'gone'])
    expect(heard.map((m) => [m.id, m.workOutcome?.words])).toEqual([[work.id, 'Mail sent']])
  })
})
