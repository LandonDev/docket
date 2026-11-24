import type { MailChatKind } from '@shared/work/mailChat'
import { mailChatWithheld } from '@shared/work/mailChat'
import type { Caller, WorkCtx } from '../../modules'
import { workSector } from '../waiting'
import { markNarrowed } from '../../narrowing'
import { chatRow } from './find'

/**
 * `work.mail.chat.adopt`: his window marks a fresh Work thread as a mail chat
 * before its first message goes, so the narrowing and the preamble are in
 * place for the first turn (harnesses start at the first send).
 */

export const NOT_A_PERSON = 'only a person can start a mail chat'
export const WITHHELD = 'Mail chats are off for this job.'
export const MOVING = 'This thread is moving to another host; ask again once it has landed.'

/** Whether the thread's move to another host has begun, or it is still landing here (sessionMove.ts). */
function moving(ctx: Pick<WorkCtx, 'db'>, sessionId: string): boolean {
  const row = ctx.db.prepare('SELECT moving_to, moving_from, moved_to FROM sessions WHERE id = ?').get(sessionId) as { moving_to: string | null; moving_from: string | null; moved_to: string | null } | undefined
  return !!row && !!(row.moving_to || row.moving_from || row.moved_to)
}
export const NOT_A_ROOT = "That is not a thread of this workspace's on this host, at the top of its tree."
export const NOT_FRESH = 'That thread has messages already: a mail chat starts empty.'
export const OTHER_SECTOR = "That mail is not in this workspace's sector."
export const NO_MAIL = 'A chat about a mail names the mail.'
export const OTHER_SUBJECT = 'That thread is already a mail chat about something else.'

export interface Adopt {
  workspaceId: string
  sessionId: string
  kind: MailChatKind
  mailThreadId?: string
}

/** Whether the mail is in the sector, read as the owner: the host's own key sees every sector, so the sector is the fence. */
async function inSector(ctx: WorkCtx, mailThreadId: string, sector: string): Promise<boolean> {
  try {
    const got = await ctx.lifeos.owner().query<{ thread: { sector?: string } } | null>('mail:thread', { id: mailThreadId })
    return got?.thread.sector === sector
  } catch {
    // An id LifeOS cannot read is no mail of this sector.
    return false
  }
}

export async function adoptChat(ctx: WorkCtx, by: Caller, p: Adopt, now = Date.now()): Promise<{ ok: true }> {
  if (by.kind === 'model' || !by.caps.includes('operate')) throw new Error(NOT_A_PERSON)
  const sector = workSector(ctx, p.workspaceId)
  if (mailChatWithheld(sector)) throw new Error(WITHHELD)
  const scope = ctx.scopeOf(p.sessionId)
  if (!scope || scope.workspaceId !== p.workspaceId || ctx.canvas.paneOf(p.sessionId) !== p.sessionId) throw new Error(NOT_A_ROOT)
  if (p.kind === 'mail' && !p.mailThreadId) throw new Error(NO_MAIL)
  const mailThreadId = p.mailThreadId ?? null
  const had = chatRow(ctx.db, p.sessionId)
  if (had) {
    // Asked again (a retry after a lost answer): the same subject answers the same, whatever the thread holds now.
    if (had.workspaceId === p.workspaceId && had.kind === p.kind && had.mailThreadId === mailThreadId) {
      // A host that stopped between the row and the rearm: end any harness again before the first send.
      await ctx.threads.rearm(p.sessionId)
      return { ok: true }
    }
    throw new Error(OTHER_SUBJECT)
  }
  if (!ctx.threads.fresh(p.sessionId)) throw new Error(NOT_FRESH)
  if (mailThreadId && !(await inSector(ctx, mailThreadId, sector))) throw new Error(OTHER_SECTOR)
  // Read again after the wait on LifeOS: a second press may have written the row meanwhile.
  const raced = chatRow(ctx.db, p.sessionId)
  if (raced) {
    if (raced.kind === p.kind && raced.mailThreadId === mailThreadId) {
      await ctx.threads.rearm(p.sessionId)
      return { ok: true }
    }
    throw new Error(OTHER_SUBJECT)
  }
  if (!ctx.threads.fresh(p.sessionId)) throw new Error(NOT_FRESH)
  // Read just before the row: a thread whose move has begun would leave without it.
  if (moving(ctx, p.sessionId)) throw new Error(MOVING)
  ctx.db.prepare('INSERT INTO work_mail_chats (session_id, workspace_id, kind, mail_thread_id, created_at) VALUES (?, ?, ?, ?, ?)').run(p.sessionId, p.workspaceId, p.kind, mailThreadId, now)
  // The frame's own mark: if Mail does not load on a later start, the frame alone keeps this thread from running.
  markNarrowed(ctx.db, p.sessionId, 'mail', now)
  // The registry boots a harness at create, before this row: end it, so the first send boots one with the narrowing.
  await ctx.threads.rearm(p.sessionId)
  return { ok: true }
}
