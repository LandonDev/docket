import type { DatabaseSync } from 'node:sqlite'
import type { MailSeen, MailSendAnswer } from '@shared/contract-work-mail'
import type { OutboxItem } from '@shared/contract-work-outbox'
import { errorText, handled } from '@shared/work'
import { WORK_MODULES, type Caller, type WorkCtx, type WorkModule } from '../modules'
import { registerCanvasFetcher } from '../canvas/fetch'
import { chatCallRefusal, chatHarnessDenied, chatPreambleOf, dropChats, ensureChatTables, handleChat, offerTool } from './chat'
import { mailAttachmentFetcher } from './attachment'
import { outgoingHtml } from './outgoing'
import { withWaited } from './waited'
import { ensureWaitingTables, reportDrops, setWaiting, startNudge, waitingOf, waitingTool, type DropRow } from './waiting'

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
  message: { kind: string; html?: string; subject?: string; attachments?: { storageId?: unknown; name?: unknown }[]; forwardParts?: { partId?: unknown; name?: unknown }[] } & Record<string, unknown>
  origin?: { app?: string; threadId?: string; host?: string }
}

const NOT_A_PERSON = 'only a person can send mail'
export const ELSEWHERE = 'A thread on another host made this draft. Send it from that host.'
export const NOT_QUEUED = 'This mail did not go: the Outbox had already recorded an earlier send of it. Open the Outbox and send it from there.'
export const CHANGED = 'The draft changed after you pressed Send. Look at it again, then send.'

type Address = { address?: unknown }
const addresses = (list: unknown): string[] => (Array.isArray(list) ? (list as Address[]).map((a) => String(a?.address ?? '').trim().toLowerCase()) : [])
const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])

/** The files a row carries, as the composer names them: its attachments by storage id, a forward's parts as `part:<id>`. */
export const rowFiles = (message: MailRow['message']): string[] =>
  [
    ...(Array.isArray(message.attachments) ? message.attachments : []).map((f) => `${String(f?.storageId ?? '')}|${String(f?.name ?? '')}`),
    ...(Array.isArray(message.forwardParts) ? message.forwardParts : []).map((f) => `part:${String(f?.partId ?? '')}|${String(f?.name ?? '')}`)
  ].sort()

/**
 * Whether the row still says what he pressed Send on: the same people, subject, words, HTML, files, account and
 * From. A client that sent no HTML, files or sender (an older one) saw none: a row that has some is refused, never sent unseen.
 */
export function stillSeen(message: MailRow['message'], seen: MailSeen): boolean {
  const norm = (list: readonly string[]) => list.map((x) => x.trim().toLowerCase())
  const files = (seen.attachments ?? []).map((f) => `${f.id}|${f.name}`).sort()
  return (
    same(addresses(message.to), norm(seen.to)) &&
    same(addresses(message.cc), norm(seen.cc)) &&
    same(addresses(message.bcc), norm(seen.bcc)) &&
    String(message.subject ?? '') === seen.subject &&
    String(message.text ?? '').trim() === seen.text.trim() &&
    String(message.html ?? '') === (seen.html ?? '') &&
    same(rowFiles(message), files) &&
    String(message.accountId ?? '') === (seen.accountId ?? '') &&
    sender(message.from) === sender(seen.from)
  )
}

/** A From as the press compares it: its name as written and its address in any case; none is the empty word. */
const sender = (from: unknown): string => {
  const f = from as { name?: unknown; address?: unknown } | null | undefined
  return f?.address ? `${String(f.name ?? '').trim()}|${String(f.address).trim().toLowerCase()}` : ''
}

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
/** A time he picked: when, the zone he picked it in, and on a reply whether to hold it if they write first. */
export interface MailTime {
  sendAt: number
  sendZone?: string | undefined
  cancelIfReply?: boolean | undefined
}

const timeArgs = (time: MailTime | undefined) =>
  time
    ? {
        sendAt: time.sendAt,
        ...(time.sendZone !== undefined ? { sendZone: time.sendZone } : {}),
        ...(time.cancelIfReply !== undefined ? { cancelIfReply: time.cancelIfReply } : {})
      }
    : {}

export async function sendMail(ctx: WorkCtx, by: Caller, id: string, seen: MailSeen, time?: MailTime, waited = false): Promise<MailSendAnswer> {
  mustApprove(by)
  const owner = ctx.lifeos.owner()
  const got = await owner.query<{ row: MailRow } | null>('compose:get', { id })
  const row = got?.row
  if (!row || row.message?.kind !== 'mail') throw new Error('LifeOS has no such mail')
  // Anyone may have written between the composer's save and this read (the thread's agent, another app): what goes is what he saw.
  if (!stillSeen(row.message, seen)) throw new Error(CHANGED)
  // His press with a time on a thread's draft is his own send for that instant: it goes as his mail, scheduled,
  // and LifeOS takes the draft as his. A grant never names a time, and LifeOS refuses one from it besides.
  if (row.origin?.app === 'tempcode' && row.origin.host !== ctx.host) throw new Error(ELSEWHERE)
  if (row.origin?.app === 'tempcode' && !time) {
    const outbox = WORK_MODULES.find((m) => m.id === 'outbox')
    if (!outbox?.handle) throw new Error('the Outbox is not running on this host')
    const rev = Math.round(row.editedAt ?? row._creationTime)
    // His press already waited out the undo time in the window: this one send may skip LifeOS's
    // own queue. The mark is this module's alone to set, and it lives in this call (waited.ts):
    // the Outbox page, a grant and the phone send through the same hold in calls of their own.
    const press = () => outbox.handle!({ id: 'mail', method: 'work.outbox.send', params: { ref: { at: 'lifeos', table: 'outbox', id }, rev } } as never, ctx, by)
    const answer = await (waited ? withWaited(id, press) : press())
    if (!answer.handled) throw new Error('the Outbox did not take the send')
    // The hold settles a failed send, or a press another press beat, as a row and not a throw: say what became of it.
    const item = answer.result as OutboxItem
    if (item.state !== 'sent' && item.state !== 'sending') throw new Error(item.error ?? `This mail was not sent: the Outbox holds it as ${item.state}.`)
    // The hold answers an item it had already settled as it stands, and runs nothing. So "sent" is believed only when
    // LifeOS has the mail on its way: a draft that an earlier send of the hold's left behind (it failed in LifeOS's own
    // lane, and was opened and saved again) is never called sent while it sits there unsent.
    const after = await owner.query<{ row: MailRow } | null>('compose:get', { id })
    if (!after?.row || !['queued', 'sending', 'sent'].includes(String(after.row.status))) throw new Error(NOT_QUEUED)
    return { id, via: 'hold' }
  }
  if (row.status !== 'draft') throw new Error(`LifeOS holds this mail as ${row.status}`)
  const message = { ...row.message, html: outgoingHtml(String(row.message.html ?? '')) }
  // The row as it was read and compared a moment ago: LifeOS refuses the send if it was edited since.
  await owner.mutation('compose:send', { id, message, cause: 'press', ...timeArgs(time), ...(typeof row.editedAt === 'number' ? { editedAt: row.editedAt } : {}) })
  return { id, via: 'owner' }
}

/** His press moves a scheduled mail: another time or zone, still scheduled. */
export async function rescheduleMail(ctx: WorkCtx, by: Caller, id: string, time: MailTime): Promise<null> {
  mustApprove(by)
  await ctx.lifeos.owner().mutation('compose:reschedule', { id, ...timeArgs(time) })
  return null
}

/** His press takes a scheduled mail back to a draft, as the Outbox's Cancel send does. */
export async function cancelMail(ctx: WorkCtx, by: Caller, id: string): Promise<{ back: boolean }> {
  mustApprove(by)
  return { back: await ctx.lifeos.owner().mutation<boolean>('compose:cancel', { id }) }
}

/** His press sends a scheduled mail now, after LifeOS's undo time. */
export async function sendMailNow(ctx: WorkCtx, by: Caller, id: string): Promise<{ sendAt: number }> {
  mustApprove(by)
  return { sendAt: await ctx.lifeos.owner().mutation<number>('compose:sendNow', { id }) }
}

export function ensureMailTables(db: DatabaseSync): void {
  // The mail chats' table first: a fault in another of the pillar's tables must never leave a mail chat unnarrowed.
  ensureChatTables(db)
  // A draft opened once beside its thread is never opened again: a closed item stays closed.
  db.exec(`CREATE TABLE IF NOT EXISTS work_mail_opened (
    draft_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    at INTEGER NOT NULL
  )`)
  ensureWaitingTables(db)
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
const WAITING_LINE = 'mail_waiting lists the mail he sent in this sector that no one has answered.'

export const mail: WorkModule = {
  id: 'mail',
  ensure: ensureMailTables,
  async handle(req, ctx, by) {
    switch (req.method) {
      case 'work.mail.send':
      {
        const { id, seen, sendAt, sendZone, cancelIfReply, waited } = req.params
        const time = sendAt !== undefined ? { sendAt, sendZone, cancelIfReply } : undefined
        return handled(await sendMail(ctx, by, id, seen, time, waited === true))
      }
      case 'work.mail.reschedule': {
        const { id, sendAt, sendZone, cancelIfReply } = req.params
        return handled(await rescheduleMail(ctx, by, id, { sendAt, sendZone, cancelIfReply }))
      }
      case 'work.mail.sendNow':
        return handled(await sendMailNow(ctx, by, req.params.id))
      case 'work.mail.cancel':
        return handled(await cancelMail(ctx, by, req.params.id))
      case 'work.mail.nudge':
        return handled(await startNudge(ctx, by, req.params.workspaceId, req.params.threadId))
      case 'work.mail.waiting':
        return handled(await waitingOf(ctx, by, req.params.workspaceId))
      case 'work.mail.setWaiting': {
        const { workspaceId, days, routine } = req.params
        return handled(await setWaiting(ctx, by, workspaceId, { ...(days !== undefined ? { days } : {}), ...(routine !== undefined ? { routine } : {}) }))
      }
      default:
        return handleChat(req, ctx, by)
    }
  },
  // mail_offer's cards are harmless anywhere: it only shows one, after checking its ids.
  tools: (scope) => (scope.sector ? [waitingTool, offerTool] : []),
  callRefusal: chatCallRefusal,
  harnessDenied: chatHarnessDenied,
  start(ctx) {
    // A mail's attachment opened in a canvas comes through the host, inside the pane's sector (attachment.ts).
    const offFetch = registerCanvasFetcher(mailAttachmentFetcher)
    const offDrafts = ctx.lifeos.subscribe<MailRow[]>('outboxHeld:held', { host: ctx.host }, (rows) => openDrafts(ctx, rows ?? []))
    // A nudge LifeOS dropped because a reply came is told to the thread that drafted it, once.
    const told = new Set<string>()
    const offDrops = ctx.lifeos.subscribe<DropRow[]>('mailWaits:drops', { host: ctx.host }, (rows) => void reportDrops(ctx, rows ?? [], told))
    return () => {
      offFetch()
      offDrafts()
      offDrops()
    }
  },
  preamble: (scope) => [scope.sector ? `${PREAMBLE} ${WAITING_LINE}` : PREAMBLE, chatPreambleOf(scope.sessionId)].filter(Boolean).join('\n\n'),
  sessionsRemoved(sessionIds, ctx) {
    const drop = ctx.db.prepare('DELETE FROM work_mail_opened WHERE session_id = ?')
    for (const id of sessionIds) drop.run(id)
    dropChats(ctx.db, sessionIds)
  }
}
