import type { DatabaseSync } from 'node:sqlite'
import type { FrameioStatus } from '@shared/contract-work-frameio'
import type { MediaProbe } from '@shared/contract-work-media'
import { registerMoveModule, tableMoveModule } from '../../sessionMove'
import type { WorkCtx } from '../modules'
import { FrameioApi } from './api'
import { DEFAULT_REDIRECT, FrameioAuth, frameioConfig } from './auth'

/**
 * One host's Frame.io at run time, by database (a module gets the context
 * and nothing else): the sign-in, the API over it, and what was read of
 * each file's rendition. `work_frameio_items` remembers which canvas items
 * show which Frame.io files, so a webhook finds them; `work_frameio_settings`
 * keeps the public address webhooks come to.
 */

export function ensureFrameioTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_frameio_items (
    item_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    account TEXT NOT NULL,
    stack_id TEXT,
    file_ids TEXT NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS work_frameio_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
  registerMoveModule(db, tableMoveModule('frameio-items', 'work_frameio_items'))
}

export interface FrameioItemRow {
  itemId: string
  sessionId: string
  account: string
  stackId: string | null
  fileIds: string[]
}

export interface Live {
  auth: FrameioAuth
  api: FrameioApi
  /** each Frame.io file's rendition as probed: its height for mark sizes */
  probes: Map<string, MediaProbe>
}
const lives = new WeakMap<DatabaseSync, Live>()

export function frameioOf(ctx: WorkCtx): Live {
  let live = lives.get(ctx.db)
  if (!live) {
    const auth = new FrameioAuth({
      me: async (access) => {
        const res = await frameioConfig.fetch(`${frameioConfig.api.replace(/\/$/, '')}/me`, { headers: { Authorization: `Bearer ${access}`, Accept: 'application/json' } })
        const body = (await res.json().catch(() => ({}))) as { data?: { id: string; name: string; email?: string } }
        if (!res.ok || !body.data?.id) throw new Error(`Frame.io did not say who signed in (${res.status}). The account may not be on V4 yet.`)
        return { id: body.data.id, name: body.data.name, ...(body.data.email ? { email: body.data.email } : {}) }
      },
      changed: () => ctx.push({ push: 'work.frameio', status: statusOf(ctx) }, { need: 'read' }),
      log: (line) => ctx.log(line)
    })
    lives.set(ctx.db, (live = { auth, api: new FrameioApi(auth), probes: new Map() }))
  }
  return live
}

export function stopFrameio(ctx: WorkCtx): void {
  lives.get(ctx.db)?.auth.cancel()
  lives.delete(ctx.db)
}

export const setting = (db: DatabaseSync, key: string): string | null => (db.prepare(`SELECT value FROM work_frameio_settings WHERE key = ?`).get(key) as { value: string } | undefined)?.value ?? null
export function setSetting(db: DatabaseSync, key: string, value: string | null): void {
  if (value === null) db.prepare(`DELETE FROM work_frameio_settings WHERE key = ?`).run(key)
  else db.prepare(`INSERT INTO work_frameio_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value)
}

export function statusOf(ctx: WorkCtx): FrameioStatus {
  const t = frameioConfig.tokens.read()
  const live = lives.get(ctx.db)
  const publicUrl = setting(ctx.db, 'publicUrl')
  return {
    signedIn: !!t,
    ...(t?.user ? { user: t.user } : {}),
    ...(t?.clientId ? { clientId: t.clientId } : {}),
    redirectUri: t?.redirectUri ?? DEFAULT_REDIRECT,
    ...(publicUrl ? { publicUrl } : {}),
    pending: !!live?.auth.isPending,
    ...(live?.auth.error ? { error: live.auth.error } : {})
  }
}

const rowOf = (r: Record<string, string | null>): FrameioItemRow => ({ itemId: String(r.item_id), sessionId: String(r.session_id), account: String(r.account), stackId: r.stack_id, fileIds: JSON.parse(String(r.file_ids)) as string[] })

export const itemsOf = (db: DatabaseSync): FrameioItemRow[] => (db.prepare(`SELECT * FROM work_frameio_items`).all() as Record<string, string | null>[]).map(rowOf)
export const frameioItem = (db: DatabaseSync, itemId: string): FrameioItemRow | null => {
  const r = db.prepare(`SELECT * FROM work_frameio_items WHERE item_id = ?`).get(itemId) as Record<string, string | null> | undefined
  return r ? rowOf(r) : null
}
export function saveItem(db: DatabaseSync, row: FrameioItemRow): void {
  db.prepare(
    `INSERT INTO work_frameio_items (item_id, session_id, account, stack_id, file_ids) VALUES (?, ?, ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET stack_id = excluded.stack_id, file_ids = excluded.file_ids`
  ).run(row.itemId, row.sessionId, row.account, row.stackId, JSON.stringify(row.fileIds))
}
export function removeSessionItems(db: DatabaseSync, ids: readonly string[]): void {
  for (const id of ids) db.prepare(`DELETE FROM work_frameio_items WHERE session_id = ?`).run(id)
}
