import type { SessionMeta } from '@shared/events'
import type { SessionRegistry } from './sessions'

/**
 * A master reads unread when a child of its batch completes a turn
 * (docs/agents/read-and-unread.md "A master's batch"). The children carry no
 * mark of their own anywhere, so the news lands on the master: the host's
 * own read mark is cleared (`markUnread`), which every window, the phone and
 * a restart already honour, and opening the master clears it again.
 *
 * Completed: the child went from not done to done, where done is the batch
 * engine's word (batch.ts `done`): `done`, or idle after a completed turn with
 * no failure on the row, no person's Stop behind it and no subagent still
 * working under it. A turn that failed or was stopped is not news; it shows
 * its own mark on the master's lines. The first meta heard of a thread only
 * sets its state, so a boot or a re-read of the same row marks nothing.
 */

type Registry = Pick<SessionRegistry, 'onMeta' | 'onRemoved' | 'get' | 'markUnread' | 'hasCompletedTurn' | 'lastTurnStopped'>

export function completedTurn(registry: Pick<Registry, 'hasCompletedTurn' | 'lastTurnStopped'>, s: SessionMeta): boolean {
  if (s.status === 'done') return true
  if (s.status !== 'idle' || s.failure) return false
  if ((s.background?.agents.length ?? 0) > 0) return false
  return registry.hasCompletedTurn(s.id) && !registry.lastTurnStopped(s.id)
}

export function watchMasterNews(registry: Registry): () => void {
  /** Each batch child's last state: done, or not. */
  const done = new Map<string, boolean>()
  const offMeta = registry.onMeta((m) => {
    if (!m.masterId || m.parentId) return
    if (m.archived) {
      done.delete(m.id)
      return
    }
    const was = done.get(m.id)
    const now = completedTurn(registry, m)
    done.set(m.id, now)
    if (was !== false || !now) return
    const master = registry.get(m.masterId)
    if (!master?.isMaster || master.parentId || master.archived) return
    registry.markUnread([master.id])
  })
  const offRemoved = registry.onRemoved((ids) => {
    for (const id of ids) done.delete(id)
  })
  return () => {
    offMeta()
    offRemoved()
  }
}
