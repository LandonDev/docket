import type { DatabaseSync } from 'node:sqlite'
import { errorText, type SectorKey } from '@shared/work'
import type { WorkCtx } from '../modules'
import type { ChatRow } from '@shared/work/messages'
import { linkedWorkspaces, unreadAnswer } from './lifeos'
import { tellKey, tellOf, tellOfChat } from './tell'

/**
 * The live half of the pillar, while Work is on, for each linked Work
 * workspace of this host: one `chats:unread` subscription, whose count
 * reaches every window as the `work.messages` push, once a change; and one
 * `chats:unanswered`, whose conversations are told to the digest as they
 * come into the list and taken back as they leave it (tell.ts). Workspaces
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
  /** the conversations told as waiting on him */
  waiting: Set<string>
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

  /** Tells each conversation newly waiting on him, once, and takes back each that no longer does. */
  private waiting(workspaceId: string, w: Watched, rows: readonly ChatRow[]): void {
    if (this.watched.get(workspaceId) !== w) return
    const tell = tellOf(this.ctx)
    const now = new Map(rows.filter((r) => r.sector === w.sector).map((r) => [r._id, r]))
    for (const [id, row] of now) if (!w.waiting.has(id)) tell?.(tellOfChat(workspaceId, row))
    for (const id of w.waiting) if (!now.has(id)) tell?.done(tellKey(id))
    w.waiting = new Set(now.keys())
  }

  private watch(workspaceId: string, sector: SectorKey): void {
    const w: Watched = { sector, offs: [], waiting: new Set() }
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
      w.offs.push(this.ctx.lifeos.subscribe<ChatRow[] | null>('chats:unanswered', { sector }, (rows) => this.waiting(workspaceId, w, rows ?? [])))
    } catch (err) {
      this.ctx.log(`messages: could not watch ${workspaceId}'s chat: ${errorText(err)}`)
    }
  }
}
