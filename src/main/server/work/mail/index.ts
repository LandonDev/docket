import type { DatabaseSync } from 'node:sqlite'
import type { MailSendAnswer } from '@shared/contract-work-mail'
import { errorText, handled, NOT_HANDLED } from '@shared/work'
import { WORK_MODULES, type Caller, type WorkCtx, type WorkModule } from '../modules'
import { outgoingHtml } from './outgoing'

/**
 * The mail pillar's server module (docs/agents/work-mail.md): the press
 * behind TempCode's composer (`work.mail.send`), and a draft a thread made
 * opened beside that thread as a mail item. The Mail view and the composer
 * read LifeOS themselves, on a session narrowed to the workspace's sector;
 * the host only sends.
 */

/** LifeOS's `outbox` row, as much of it as the press reads. */
export interface MailRow {
  _id: string
  _creationTime: number
  status: string
  editedAt?: number
  message: { kind: string; html?: string; subject?: string } & Record<string, unknown>
  origin?: { app?: string; threadId?: string; host?: string }
}

const NOT_A_PERSON = 'only a person can send mail'
export const HELD_NOT_SCHEDULED = 'A draft a thread made goes now or not at all. Send it now, or schedule it from LifeOS.'
export const ELSEWHERE = 'A thread on another host made this draft. Send it from that host.'

function mustApprove(by: Caller): void {
  if (by.kind === 'model' || !by.caps.includes('approve')) throw new Error(NOT_A_PERSON)
}

/**
 * Sends a draft as LifeOS holds it now. A draft one of this host's threads
 * made goes through the hold, with the edit time it has now as its `rev`
 * (the composer saved what he saw a moment before), so the run-once claim,
 * the linked task and the Sent record are the hold's. Any other draft is
 * his own mail and goes as his `compose.send`. The HTML is cleaned by the
 * outgoing rules on both roads (the hold's `mail.send` cleans its own).
 */
export async function sendMail(ctx: WorkCtx, by: Caller, id: string, sendAt?: number): Promise<MailSendAnswer> {
  mustApprove(by)
  const owner = ctx.lifeos.owner()
  const got = await owner.query<{ row: MailRow } | null>('compose:get', { id })
  const row = got?.row
  if (!row || row.message?.kind !== 'mail') throw new Error('LifeOS has no such mail')
  if (row.origin?.app === 'tempcode') {
    if (row.origin.host !== ctx.host) throw new Error(ELSEWHERE)
    if (sendAt !== undefined) throw new Error(HELD_NOT_SCHEDULED)
    const outbox = WORK_MODULES.find((m) => m.id === 'outbox')
    if (!outbox?.handle) throw new Error('the Outbox is not running on this host')
    const rev = Math.round(row.editedAt ?? row._creationTime)
    const answer = await outbox.handle({ id: 'mail', method: 'work.outbox.send', params: { ref: { at: 'lifeos', table: 'outbox', id }, rev } } as never, ctx, by)
    if (!answer.handled) throw new Error('the Outbox did not take the send')
    return { id, via: 'hold' }
  }
  if (row.status !== 'draft') throw new Error(`LifeOS holds this mail as ${row.status}`)
  const message = { ...row.message, html: outgoingHtml(String(row.message.html ?? '')) }
  await owner.mutation('compose:send', { id, message, cause: 'press', ...(sendAt !== undefined ? { sendAt } : {}) })
  return { id, via: 'owner' }
}

export function ensureMailTables(db: DatabaseSync): void {
  // A draft opened once beside its thread is never opened again: a closed item stays closed.
  db.exec(`CREATE TABLE IF NOT EXISTS work_mail_opened (
    draft_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    at INTEGER NOT NULL
  )`)
}

/** Opens each new draft a thread of this host made as a mail item beside that thread, once. */
export function openDrafts(ctx: WorkCtx, rows: readonly MailRow[]): void {
  const seen = ctx.db.prepare('SELECT 1 FROM work_mail_opened WHERE draft_id = ?')
  const mark = ctx.db.prepare('INSERT OR IGNORE INTO work_mail_opened (draft_id, session_id, at) VALUES (?, ?, ?)')
  for (const row of rows) {
    const threadId = row.origin?.threadId
    if (!threadId || row.origin?.host !== ctx.host || row.message?.kind !== 'mail' || row.status !== 'draft') continue
    if (seen.get(row._id)) continue
    // A thread this host no longer has, or that is not a Work thread, gets nothing.
    if (!ctx.scopeOf(threadId)) continue
    try {
      const pane = ctx.canvas.paneOf(threadId)
      const source = { at: 'lifeos', table: 'outbox', id: row._id } as const
      const open = ctx.canvas.forSession(pane).some((i) => i.source.at === 'lifeos' && i.source.table === 'outbox' && i.source.id === row._id)
      if (!open) ctx.canvas.open(pane, 'mail', source, String(row.message.subject ?? '').trim() || 'Draft')
      mark.run(row._id, threadId, Date.now())
    } catch (err) {
      ctx.log(`mail: could not open draft ${row._id} beside its thread: ${errorText(err)}`)
    }
  }
}

const PREAMBLE = [
  'Mail: write a mail or a reply with LifeOS\'s draft_mail. The draft opens beside this thread, where he reads it and presses Send himself; you never send mail.',
  'To change a draft after it is written, use update_mail_draft: your rewrite waits in the draft until he accepts or rejects it.'
].join(' ')

export const mail: WorkModule = {
  id: 'mail',
  ensure: ensureMailTables,
  async handle(req, ctx, by) {
    if (req.method !== 'work.mail.send') return NOT_HANDLED
    return handled(await sendMail(ctx, by, req.params.id, req.params.sendAt))
  },
  start(ctx) {
    return ctx.lifeos.subscribe<MailRow[]>('outboxHeld:held', { host: ctx.host }, (rows) => openDrafts(ctx, rows ?? []))
  },
  preamble: () => PREAMBLE,
  sessionsRemoved(sessionIds, ctx) {
    const drop = ctx.db.prepare('DELETE FROM work_mail_opened WHERE session_id = ?')
    for (const id of sessionIds) drop.run(id)
  }
}
