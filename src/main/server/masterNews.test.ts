import { describe, expect, it } from 'vitest'
import type { SessionMeta } from '@shared/events'
import { watchMasterNews } from './masterNews'

function fake() {
  const metas = new Map<string, SessionMeta>()
  const listeners = new Set<(m: SessionMeta, producer: string) => void>()
  const removed = new Set<(ids: string[]) => void>()
  const completed = new Set<string>()
  const stopped = new Set<string>()
  const unread: string[] = []
  const registry = {
    onMeta(l: (m: SessionMeta, producer: string) => void) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    onRemoved(l: (ids: string[]) => void) {
      removed.add(l)
      return () => removed.delete(l)
    },
    get: (id: string) => metas.get(id) ?? null,
    markUnread: (ids: readonly string[]) => void unread.push(...ids),
    hasCompletedTurn: (id: string) => completed.has(id),
    lastTurnStopped: (id: string) => stopped.has(id)
  }
  const put = (m: Partial<SessionMeta> & { id: string }) => {
    const next = { status: 'idle', updatedAt: 1, ...metas.get(m.id), ...m } as SessionMeta
    metas.set(m.id, next)
    for (const l of listeners) l(next, 'test')
  }
  put({ id: 'm', isMaster: true })
  return { registry, put, completed, stopped, unread, remove: (ids: string[]) => removed.forEach((l) => l(ids)) }
}

describe('watchMasterNews', () => {
  it('marks the master unread when a batch child completes a turn', () => {
    const f = fake()
    const off = watchMasterNews(f.registry)
    f.put({ id: 'c', masterId: 'm', status: 'running' })
    expect(f.unread).toEqual([])
    f.completed.add('c')
    f.put({ id: 'c', status: 'idle' })
    expect(f.unread).toEqual(['m'])
    // The same settled row heard again is not news.
    f.put({ id: 'c', updatedAt: 2 })
    expect(f.unread).toEqual(['m'])
    off()
    f.put({ id: 'c', status: 'running' })
    f.put({ id: 'c', status: 'idle' })
    expect(f.unread).toEqual(['m'])
  })

  it('counts a child that turns done, and one whose subagents finish', () => {
    const f = fake()
    watchMasterNews(f.registry)
    f.put({ id: 'a', masterId: 'm', status: 'running' })
    f.put({ id: 'a', status: 'done' })
    f.completed.add('b')
    f.put({ id: 'b', masterId: 'm', status: 'idle', background: { agents: [{ id: 's' }] } as never })
    f.put({ id: 'b', background: { agents: [] } as never })
    expect(f.unread).toEqual(['m', 'm'])
  })

  it('leaves the master alone on a failure, a Stop, an error or the first meta heard', () => {
    const f = fake()
    watchMasterNews(f.registry)
    f.completed.add('c')
    f.put({ id: 'c', masterId: 'm', status: 'idle' })
    f.put({ id: 'c', status: 'running' })
    f.put({ id: 'c', status: 'idle', failure: { summary: 'usage limit' } as never })
    f.put({ id: 'c', status: 'running', failure: undefined })
    f.put({ id: 'c', status: 'error' })
    f.put({ id: 'c', status: 'running' })
    f.stopped.add('c')
    f.put({ id: 'c', status: 'idle' })
    expect(f.unread).toEqual([])
  })

  it('ignores subagents, archived rows and a master that is gone or archived', () => {
    const f = fake()
    watchMasterNews(f.registry)
    f.completed.add('s').add('c').add('x')
    f.put({ id: 's', masterId: 'm', parentId: 'c', status: 'running' })
    f.put({ id: 's', status: 'idle' })
    f.put({ id: 'c', masterId: 'm', status: 'running' })
    f.put({ id: 'c', status: 'idle', archived: true })
    f.put({ id: 'x', masterId: 'gone', status: 'running' })
    f.put({ id: 'x', status: 'idle' })
    f.put({ id: 'm', archived: true })
    f.put({ id: 'y', masterId: 'm', status: 'running' })
    f.put({ id: 'y', status: 'done' })
    expect(f.unread).toEqual([])
  })

  it('forgets a removed child', () => {
    const f = fake()
    watchMasterNews(f.registry)
    f.put({ id: 'c', masterId: 'm', status: 'running' })
    f.remove(['c'])
    f.completed.add('c')
    f.put({ id: 'c', status: 'idle' })
    expect(f.unread).toEqual([])
  })
})
