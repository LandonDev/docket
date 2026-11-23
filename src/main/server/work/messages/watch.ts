import type { DatabaseSync } from 'node:sqlite'
import { errorText, type SectorKey } from '@shared/work'
import type { WorkCtx } from '../modules'
import { linkedWorkspaces, unreadAnswer } from './lifeos'

/**
 * The live half of the pillar, while Work is on: one `chats:unread`
 * subscription a linked Work workspace of this host, whose count reaches
 * every window as the `work.messages` push, once a change. Workspaces
 * coming and going are followed by the module's hooks (`follow`).
 */

/** The running watch of a host, by its database: a tool's context is a copy of the one `start` was given. */
const watches = new WeakMap<DatabaseSync, ChatWatch>()
export const watchOf = (ctx: Pick<WorkCtx, 'db'>): ChatWatch | undefined => watches.get(ctx.db)

/** Starts the watch for a context; its return stops it. */
export function startWatch(ctx: WorkCtx): () => void {
  const watch = new ChatWatch(ctx)
  watches.set(ctx.db, watch)
  return () => {
    watch.stop()
    if (watches.get(ctx.db) === watch) watches.delete(ctx.db)
  }
}

interface Watched {
  sector: SectorKey
  offs: (() => void)[]
  unread?: number
}

export class ChatWatch {
  private readonly watched = new Map<string, Watched>()

  constructor(private readonly ctx: WorkCtx) {
    this.follow()
  }

  /** Watches every linked workspace not yet watched, and lets go of one that is gone or now links another sector. */
  follow(): void {
    const linked = new Map(linkedWorkspaces(this.ctx).map((w) => [w.id, w.sector]))
    for (const [id, w] of this.watched) if (linked.get(id) !== w.sector) this.drop(id)
    for (const [id, sector] of linked) if (!this.watched.has(id)) this.watch(id, sector)
  }

  /** A workspace was deleted: stop watching it now, whether or not its row is gone yet. */
  drop(workspaceId: string): void {
    const w = this.watched.get(workspaceId)
    if (!w) return
    this.watched.delete(workspaceId)
    for (const off of w.offs) off()
  }

  /** The last count LifeOS answered for a workspace, if it has answered. */
  unreadOf(workspaceId: string): number | undefined {
    return this.watched.get(workspaceId)?.unread
  }

  stop(): void {
    for (const id of [...this.watched.keys()]) this.drop(id)
  }

  private watch(workspaceId: string, sector: SectorKey): void {
    const w: Watched = { sector, offs: [] }
    this.watched.set(workspaceId, w)
    try {
      w.offs.push(
        this.ctx.lifeos.subscribe<{ count: number; newest?: number } | null>('chats:unread', { sector }, (value) => {
          // An answer for a workspace no longer watched, or watched again since, is not this one's.
          if (this.watched.get(workspaceId) !== w) return
          const { unread } = unreadAnswer(value)
          if (w.unread === unread) return
          w.unread = unread
          this.ctx.push({ push: 'work.messages', workspaceId, unread })
        })
      )
    } catch (err) {
      this.ctx.log(`messages: could not watch ${workspaceId}'s chat: ${errorText(err)}`)
    }
  }
}
