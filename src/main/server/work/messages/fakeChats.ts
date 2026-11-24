import type { ChatHit, ChatMessage, ChatRoute, ChatRow } from '@shared/work/messages'
import type { LifeosClient } from '../lifeos/ctx'
import type { WorkCtx } from '../modules'
import type { ChatSourceRow } from './health'

/**
 * LifeOS's chat functions in memory, for the pillar's tests: conversations,
 * their messages and routes, sources, and the live queries the test fires.
 * `leaky` makes it answer every sector's rows whatever sector was asked, so
 * a test proves the host's own fence and not LifeOS's. Made-up people only.
 */
export class FakeChats implements LifeosClient {
  chats = new Map<string, ChatRow>()
  messages = new Map<string, ChatMessage[]>()
  routes = new Map<string, ChatRoute>()
  sources: ChatSourceRow[] = []
  hits: (ChatHit & { sector: string })[] = []
  calls: { fn: string; args: Record<string, unknown> }[] = []
  watchers: { fn: string; args: Record<string, unknown>; on: (v: unknown) => void }[] = []
  replies: { id: string; chatId: string; replyTo?: string; text: string }[] = []
  undone: string[] = []
  retried: string[] = []
  connected = true
  leaky = false
  /** LifeOS's `settings.timezone`, his zone; none: `settings:get` answers no zone */
  timezone: string | undefined = undefined
  /** the next `replies:undo` throws this */
  undoFails: unknown = null
  /** conversations whose `chats:messages` read fails */
  messagesFail = new Set<string>()
  /** the next `chats:reply` throws this */
  refuseNext: unknown = null
  private n = 0

  chat(over: Partial<ChatRow> = {}): ChatRow {
    const id = over._id ?? `chat_${++this.n}`
    const row: ChatRow = {
      _id: id,
      source: 'slack',
      account: 'T01',
      accountName: 'CosmicGames',
      channel: `D${this.n}`,
      name: 'Dana Lee',
      kind: 'direct',
      sector: 'cosmic',
      lastAt: 1_000,
      lastText: 'Can you look at the build?',
      lastWho: 'Dana Lee',
      lastFromMe: false,
      lastInAt: 1_000,
      lastInId: `${id}-in`,
      lastForMeAt: 1_000,
      unread: true,
      faces: [{ name: 'Dana Lee' }],
      ...over
    }
    this.chats.set(id, row)
    return row
  }

  private inSector = (sector: unknown) => (row: { sector: string }) => this.leaky || sector === undefined || row.sector === sector
  private newest = <T extends { lastAt: number }>(rows: T[]): T[] => [...rows].sort((a, b) => b.lastAt - a.lastAt)
  private unanswered(sector: unknown): ChatRow[] {
    return this.newest([...this.chats.values()].filter(this.inSector(sector)).filter((c) => c.unread && (c.lastInAt ?? 0) > (c.lastOutAt ?? 0)))
  }
  private unreadCount(sector: unknown): { count: number; newest?: number } {
    const rows = [...this.chats.values()].filter((c) => c.sector === sector && c.unread)
    return rows.length ? { count: rows.length, newest: Math.max(...rows.map((c) => c.lastAt)) } : { count: 0 }
  }

  /** Fire the live queries, as Convex does when a row changes. */
  fire(): void {
    for (const w of [...this.watchers]) {
      if (w.fn === 'chats:unread') w.on(this.unreadCount(w.args.sector))
      if (w.fn === 'chats:unanswered') w.on(this.unanswered(w.args.sector))
    }
  }

  private async run<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ fn, args })
    if (!this.connected) throw new Error('LifeOS is unreachable')
    switch (fn) {
      case 'chats:get': {
        const chat = this.chats.get(String(args.id))
        return (chat ? { chat, source: null, route: this.routes.get(chat._id) ?? { can: true } } : null) as T
      }
      case 'chats:list':
        return { page: this.newest([...this.chats.values()].filter(this.inSector(args.sector))), isDone: true, continueCursor: '' } as T
      case 'chats:messages': {
        if (this.messagesFail.has(String(args.chatId))) throw new Error('LifeOS is unreachable')
        const all = this.messages.get(String(args.chatId)) ?? []
        const n = (args.paginationOpts as { numItems?: number } | undefined)?.numItems ?? 50
        return { page: all.slice(0, n), isDone: all.length <= n, continueCursor: '' } as T
      }
      case 'chats:unread':
        return this.unreadCount(args.sector) as T
      case 'chats:unanswered':
        return this.unanswered(args.sector) as T
      case 'chats:search':
        return this.hits.filter(this.inSector(args.sector)).filter((h) => h.text.toLowerCase().includes(String(args.text).toLowerCase())) as T
      case 'chats:find': {
        const text = String(args.text ?? '').toLowerCase()
        return this.newest([...this.chats.values()].filter(this.inSector(args.sector)).filter((c) => !text || c.name.toLowerCase().includes(text))).slice(0, 20) as T
      }
      case 'chats:reply': {
        if (this.refuseNext) {
          const err = this.refuseNext
          this.refuseNext = null
          throw err
        }
        const id = `out_${++this.n}`
        this.replies.push({ id, chatId: String(args.chatId), ...(typeof args.replyTo === 'string' ? { replyTo: args.replyTo } : {}), text: String(args.text) })
        return id as T
      }
      case 'replies:undo':
        if (this.undoFails) {
          const err = this.undoFails
          this.undoFails = null
          throw err
        }
        this.undone.push(String(args.id))
        return (this.replies.find((r) => r.id === args.id)?.text ?? '') as T
      case 'replies:retry':
        this.retried.push(String(args.id))
        return null as T
      case 'sources:list':
        return this.sources as T
      case 'settings:get':
        return (this.timezone ? { timezone: this.timezone } : {}) as T
    }
    throw new Error(`no function ${fn}`)
  }
  query = <T>(fn: string, args?: Record<string, unknown>): Promise<T> => this.run<T>(fn, args)
  mutation = <T>(fn: string, args?: Record<string, unknown>): Promise<T> => this.run<T>(fn, args)
  action = <T>(fn: string, args?: Record<string, unknown>): Promise<T> => this.run<T>(fn, args)

  /** The context's `lifeos` over this fake: a subscription answers at once, then on each `fire`. */
  client(): WorkCtx['lifeos'] {
    return {
      connected: () => this.connected,
      owner: () => this,
      jwt: async () => 'jwt',
      subscribe: (fn, args, on) => {
        const w = { fn, args: (args ?? {}) as Record<string, unknown>, on: on as (v: unknown) => void }
        this.watchers.push(w)
        queueMicrotask(() => {
          if (!this.watchers.includes(w)) return
          if (fn === 'chats:unread') w.on(this.unreadCount(w.args.sector))
          if (fn === 'chats:unanswered') w.on(this.unanswered(w.args.sector))
        })
        return () => void this.watchers.splice(this.watchers.indexOf(w), 1)
      }
    }
  }

  /** A ConvexError as LifeOS throws one: its words in `data`. */
  static refusal(data: string | { code: string; message: string }): Error {
    return Object.assign(new Error(`[CONVEX M(chats:reply)] Server Error\nUncaught ConvexError: ${typeof data === 'string' ? data : JSON.stringify(data)}`), { data })
  }
}
