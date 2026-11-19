import type { DatabaseSync } from 'node:sqlite'
import type { HostId } from '@shared/work'
import { registerMoveModule, tableMoveModule } from '../../sessionMove'
import type { WorkCtx } from '../modules'
import { canvasDirOf, type CanvasStore } from './store'

/**
 * The canvas items follow a thread that moves to another host
 * (sessionMove.ts `MoveModule`): the rows of `work_canvas_items` ride the
 * manifest and land with the receiver's workspace id, the folders under
 * `canvas/<sid>/` ride as files, and once the landing is the thread its
 * open list is pushed and LifeOS hears its new host.
 */

/**
 * The LifeOS mutation that rewrites `LifeosOrigin.host` on what a moved
 * thread stamped there. Milestone 4 (LifeOS's `workLinks` functions) and
 * milestone 7 (the host's LifeOS client) confirm its name and arguments.
 */
export const lifeosMoved = (threadId: string, host: HostId): { fn: string; args: { threadId: string; host: HostId } } => ({ fn: 'workLinks:moved', args: { threadId, host } })

/** The moves LifeOS has not heard of yet: one row per thread, gone once it has. */
export function ensureMovedTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_canvas_moved (session_id TEXT PRIMARY KEY, at INTEGER NOT NULL)`)
}

/** How often a move LifeOS has not heard of is tried again while Work is on. */
export const MOVED_RETRY_MS = 5 * 60_000

/**
 * Tells LifeOS of every move it has not heard of: each thread on its own,
 * so one that fails leaves the others told, and a thread stays written
 * down until LifeOS has answered for it. Never throws: LifeOS may be
 * unbuilt, unpaired or down, and one line says so.
 */
export async function tellLifeosMoved(ctx: Pick<WorkCtx, 'db' | 'lifeos' | 'host' | 'log'>): Promise<void> {
  const waiting = (ctx.db.prepare(`SELECT session_id FROM work_canvas_moved ORDER BY at`).all() as { session_id: string }[]).map((r) => r.session_id)
  if (waiting.length === 0) return
  const failed: string[] = []
  let why = ''
  for (const id of waiting) {
    try {
      if (!ctx.lifeos.connected()) throw new Error('LifeOS is not connected')
      const { fn, args } = lifeosMoved(id, ctx.host)
      await ctx.lifeos.owner().mutation(fn, args)
      ctx.db.prepare(`DELETE FROM work_canvas_moved WHERE session_id = ?`).run(id)
    } catch (err) {
      failed.push(id)
      why = err instanceof Error ? err.message : String(err)
    }
  }
  if (failed.length) ctx.log(`canvas: LifeOS has not heard that ${failed.join(', ')} moved here (it is told again later): ${why}`)
}

/** Writes down that these Work threads landed here, then tells LifeOS. */
export function noteMoved(ctx: Pick<WorkCtx, 'db' | 'lifeos' | 'host' | 'log'>, workIds: readonly string[]): Promise<void> {
  const st = ctx.db.prepare(`INSERT OR REPLACE INTO work_canvas_moved (session_id, at) VALUES (?, ?)`)
  for (const id of workIds) st.run(id, Date.now())
  return tellLifeosMoved(ctx)
}

/** While Work is on: tell LifeOS at once of what waits, then again every few minutes while anything does. Returns its stop. */
export function retryMoved(ctx: Pick<WorkCtx, 'db' | 'lifeos' | 'host' | 'log'>, everyMs = MOVED_RETRY_MS): () => void {
  void tellLifeosMoved(ctx)
  const timer = setInterval(() => void tellLifeosMoved(ctx), everyMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** Registers the canvas as a move module of this host's database. Returns its off. */
export function registerCanvasMove(db: DatabaseSync, ctx: WorkCtx, store: () => CanvasStore): () => void {
  return registerMoveModule(
    db,
    tableMoveModule('canvas', 'work_canvas_items', {
      dir: canvasDirOf,
      claimed(host, ids) {
        const withRows = ids.filter((id) => store().rowsFor([id]).length > 0)
        for (const id of withRows) store().announce(id)
        // The row decides, read off the database: the registry hears of the landing only after this.
        const scope = host.db.prepare(`SELECT scope FROM sessions WHERE id = ?`)
        const workIds = ids.filter((id) => (scope.get(id) as { scope?: string } | undefined)?.scope === 'work')
        void noteMoved(ctx, workIds)
      }
    })
  )
}
