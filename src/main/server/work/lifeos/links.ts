import type { DatabaseSync } from 'node:sqlite'
import type { ContextChip } from '@shared/work'
import type { LifeosClient, WorkLink } from './ctx'
import { faultOf, faultWords, redact } from './transport'

/**
 * `ctx.links` (architecture §7.3): a thread and the LifeOS task, mail
 * thread or event it is about, kept in LifeOS's `workLinks` (milestone 4's
 * functions; TempCode keeps no copy). A thread started with a chip is
 * linked once its row exists; if LifeOS cannot be reached then, the link
 * waits in this host's queue and is made when the session is back, so a
 * thread never fails to start for it.
 */

export const PENDING_TABLE = 'work_lifeos_pending_links'

export function ensureLinksTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${PENDING_TABLE} (
    session_id TEXT NOT NULL,
    entity_table TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    title TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (session_id, entity_table, entity_id)
  )`)
}

/** The LifeOS functions the links use (milestone 4's `workLinks.ts` and the widened `tasks.complete`). */
export const LINK_FNS = { link: 'workLinks:link', byThread: 'workLinks:byThread', complete: 'tasks:complete' } as const

export interface LinksDeps {
  db: DatabaseSync
  host: string
  owner: () => LifeosClient | null
  /** A Work thread's own sector; null for a Work Chat or a code thread */
  sectorOf?: (sessionId: string) => string | null
  log: (line: string) => void
  now?: () => number
}

/** The LifeOS row a chip names, or null for a chip that is not LifeOS's (a selection, a file). */
export function entityOf(about: ContextChip): { table: 'tasks' | 'mailThreads' | 'events' | 'chats'; id: string } | null {
  const ref = about.ref as { at?: string; table?: string; id?: string }
  if (ref.at !== 'lifeos' || !ref.id) return null
  return ref.table === 'tasks' || ref.table === 'mailThreads' || ref.table === 'events' || ref.table === 'chats' ? { table: ref.table, id: ref.id } : null
}

const TITLE_MAX = 200

/** A LifeOS function's own refusal (a ConvexError, with data); every other failure may pass. */
const refused = (err: unknown): boolean => faultOf(err) !== 'unreachable' && (err as { data?: unknown } | null)?.data !== undefined

export class Links {
  constructor(private readonly deps: LinksDeps) {}

  private log(line: string): void {
    this.deps.log(redact(`lifeos links: ${line}`))
  }

  /** Links the thread to the chip's row; queued when LifeOS cannot take it now. */
  async link(about: ContextChip, sessionId: string, title: string): Promise<void> {
    const entity = entityOf(about)
    if (!entity) return
    const label = (title || about.label).slice(0, TITLE_MAX)
    const owner = this.deps.owner()
    if (owner) {
      try {
        await owner.mutation(LINK_FNS.link, { entity, host: this.deps.host, threadId: sessionId, title: label })
        return
      } catch (err) {
        // Only LifeOS's own refusal is final; anything else (a dropped socket, a lapsed sign-in, a server error) waits and is tried again.
        if (refused(err)) throw new Error(`LifeOS did not link the ${about.kind}: ${faultWords(err)}`)
      }
    }
    this.deps.db
      .prepare(`INSERT OR REPLACE INTO ${PENDING_TABLE} (session_id, entity_table, entity_id, title, at) VALUES (?, ?, ?, ?, ?)`)
      .run(sessionId, entity.table, entity.id, label, this.deps.now?.() ?? Date.now())
    this.log(`thread ${sessionId}: its ${about.kind} waits to be linked until LifeOS is back`)
  }

  /** The queued links, made now; one LifeOS refuses is dropped and logged, one it cannot be reached for waits. */
  async flush(): Promise<number> {
    const owner = this.deps.owner()
    if (!owner) return 0
    const rows = this.deps.db.prepare(`SELECT session_id, entity_table, entity_id, title FROM ${PENDING_TABLE} ORDER BY at`).all() as {
      session_id: string
      entity_table: string
      entity_id: string
      title: string
    }[]
    let made = 0
    for (const row of rows) {
      try {
        await owner.mutation(LINK_FNS.link, { entity: { table: row.entity_table, id: row.entity_id }, host: this.deps.host, threadId: row.session_id, title: row.title })
        made++
      } catch (err) {
        if (!refused(err)) return made
        this.log(`thread ${row.session_id}: LifeOS refused its link: ${faultWords(err)}`)
      }
      this.deps.db.prepare(`DELETE FROM ${PENDING_TABLE} WHERE session_id = ? AND entity_table = ? AND entity_id = ?`).run(row.session_id, row.entity_table, row.entity_id)
    }
    return made
  }

  /** What a thread is tied to, as LifeOS has it. */
  async forThread(sessionId: string, owner: LifeosClient): Promise<WorkLink[]> {
    const rows = await owner.query<{ sector: string; entity: { table: string; id: string }; host: string; threadId: string; title: string; state: 'open' | 'done'; at: number }[]>(LINK_FNS.byThread, {
      threadId: sessionId
    })
    return (rows ?? []).map((r) => ({ sector: r.sector, entity: r.entity, host: r.host, threadId: r.threadId, title: r.title, state: r.state, at: r.at }))
  }

  /** Completes each open task the thread is tied to, with the reason and the thread's link. Mail and events are not completed here. */
  async completeFor(sessionId: string, reason: string, owner: LifeosClient): Promise<void> {
    const sector = this.deps.sectorOf?.(sessionId) ?? null
    for (const link of await this.forThread(sessionId, owner)) {
      if (link.entity.table !== 'tasks' || link.state !== 'open') continue
      // A Work thread of one sector never closes another sector's task, whatever its chip named.
      if (sector && link.sector !== sector) {
        this.log(`thread ${sessionId}: a linked task in ${link.sector} is not completed from a ${sector} thread`)
        continue
      }
      await owner.mutation(LINK_FNS.complete, { id: link.entity.id, reason: reason.slice(0, 500), threadLink: { host: link.host, threadId: sessionId, title: link.title } })
    }
  }

  /** A deleted thread's queued links go with it. */
  dropSessions(ids: readonly string[]): void {
    const del = this.deps.db.prepare(`DELETE FROM ${PENDING_TABLE} WHERE session_id = ?`)
    for (const id of ids) del.run(id)
  }
}
