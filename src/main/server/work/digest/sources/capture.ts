import type { Tell } from '@shared/work/tell'
import type { Source, SourceEnv } from './index'

/**
 * Captures to sort (docs/agents/work-capture.md): one row a day while
 * anything he captured with no sector still waits in Life's "Unsorted" for
 * LifeOS's bot.
 *
 * The capture pillar files a capture and reads nothing back, so it has no
 * method that counts them. The count is read where the captures are: the
 * host's own LifeOS session, as the owner, lists Life's open tasks
 * (`tasks:list {sector: 'life'}`, the read the lifeos pillar's mentions
 * make), and the ones whose source channel is "Unsorted" are the ones the
 * capture pillar filed there (capture/file.ts writes that channel). No
 * pillar's table or file is read.
 */

/** The sector unsorted captures wait in, and the channel the capture pillar files them under. */
const UNSORTED_SECTOR = 'life'
const UNSORTED_CHANNEL = 'Unsorted'

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
  async read(env) {
    if (!env.ctx.lifeos.connected()) return []
    let tasks: { source?: { channel?: string } | null }[]
    try {
      tasks = await env.ctx.lifeos.owner().query<{ source?: { channel?: string } | null }[]>('tasks:list', { sector: UNSORTED_SECTOR })
    } catch {
      // LifeOS did not answer: nothing is known, so nothing is said.
      return []
    }
    const tell = unsortedTell(env, tasks.filter((t) => t.source?.channel === UNSORTED_CHANNEL).length)
    return tell ? [tell] : []
  }
}
