import type { Tell } from '@shared/work/tell'
import type { Source, SourceEnv } from './index'

/**
 * Captures to sort (docs/agents/work-capture.md): one row a day while
 * anything he captured with no sector still waits in Life's "Unsorted" for
 * LifeOS's bot.
 *
 * TELLS NOTHING YET. The capture pillar has no method that counts them: its
 * wire is `work.capture.state` (the last sector, the homes, whether LifeOS
 * answers) and `work.capture.file`, and it never reads LifeOS's tasks, so
 * there is no read of its own to borrow. It needs a read method such as
 * `work.capture.unsorted {} → {count}` (the open Life tasks whose source
 * channel is "Unsorted"). `unsortedTell` is the row that read will make.
 */

export const unsortedTitle = (count: number): string => (count === 1 ? '1 capture to sort' : `${count} captures to sort`)

/** The row for `count` unsorted captures: opens Tasks in this host's Life workspace, where they wait, when there is one. */
export function unsortedTell(env: Pick<SourceEnv, 'workspaces' | 'day'>, count: number): Tell | null {
  if (count <= 0) return null
  const life = env.workspaces().find((w) => w.sector === 'life')
  return { kind: 'capture.unsorted', workspaceId: null, title: unsortedTitle(count), key: `capture-unsorted:${env.day}`, ...(life ? { open: { view: 'tasks', workspaceId: life.id } } : {}) }
}

export const capture: Source = {
  id: 'capture',
  pillar: 'capture',
  every: 0,
  read: () => []
}
