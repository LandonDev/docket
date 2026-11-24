import { z, type ZodType } from 'zod'
import { workText, type WorkToolResult } from '@shared/work'
import { MailOfferSchema, type MailOfferResult } from '@shared/work/mailChat'
import type { ToolCtx, WorkTool } from '../../modules'
import type { MailRow } from '..'

/**
 * `mail_offer`: a card beside the mail for his press (docs/agents/work-mail.md
 * "The chat beside the mail"). The host checks every id the card names, then
 * answers the card for the transcript to draw, twice: as `structuredContent`,
 * and as the text part's JSON `{mailOffer, message}` (Claude Code keeps only a
 * result's text in the transcript, as `html_render`'s answer is read). It does
 * nothing else: what the card proposes happens only on his press, in his window.
 */

export const NOT_YOURS = 'That draft is not one this thread wrote. Offer only a draft you made here with draft_mail.'
export const NO_REWRITE = 'That draft holds no rewrite of yours. Use update_mail_draft on it first, then offer it.'
export const OUT_OF_SECTOR = (id: string): string => `Mail thread ${id} is not in this workspace’s sector. Offer only mail of this job.`
export const ONE_CARD = 'Give exactly one of draft, rewrite, rows, task or event.'

/** The tool's input as the mount needs it, a z.object: each card's key, optional. `MailOfferSchema` then holds it to exactly one. */
const OfferInput = z.object(
  Object.fromEntries(MailOfferSchema.options.flatMap((card) => Object.entries(card.shape).map(([key, shape]) => [key, (shape as ZodType).optional()]))) as Record<string, ZodType>
)

/** What the model reads beside the card. */
const SAID: Record<string, string> = {
  draft: 'He sees your draft as a card beside the mail. Nothing was sent; he puts it in his reply or not.',
  rewrite: 'He sees your rewrite of his reply as a card. His reply is unchanged until he takes it.',
  rows: 'He sees these rows as a card to press. Nothing was changed.',
  task: 'He sees this task as a card. Nothing was added until he adds it.',
  event: 'He sees this event as a card. Nothing was added until he adds it.'
}

const refuse = (text: string): WorkToolResult => ({ ...workText(text), isError: true })

/** The draft as LifeOS holds it, read as the owner; null when there is none. */
async function draftOf(ctx: ToolCtx, id: string): Promise<(MailRow & { proposed?: { by?: string } }) | null> {
  try {
    const got = await ctx.lifeos.owner().query<{ row: MailRow & { proposed?: { by?: string } } } | null>('compose:get', { id })
    return got?.row && got.row.message?.kind === 'mail' ? got.row : null
  } catch {
    return null
  }
}

/** The ids of mail threads outside the thread's sector, read as the owner (as attachment.ts reads a pane's mail). */
async function outside(ctx: ToolCtx, ids: readonly string[], sector: string): Promise<string[]> {
  const read = await Promise.all(
    [...new Set(ids)].map(async (id) => {
      try {
        const got = await ctx.lifeos.owner().query<{ thread: { sector?: string } } | null>('mail:thread', { id })
        return got?.thread.sector === sector ? null : id
      } catch {
        return id
      }
    })
  )
  return read.filter((id): id is string => id !== null)
}

export async function offer(args: unknown, ctx: ToolCtx): Promise<WorkToolResult> {
  const parsed = MailOfferSchema.safeParse(args)
  if (!parsed.success) return refuse(ONE_CARD)
  const card = parsed.data
  const sector = ctx.scope.sector
  if (!sector) return refuse('This thread has no sector, so it has no mail to offer.')
  if (!ctx.lifeos.connected()) return refuse('LifeOS is not connected.')
  // A subagent's drafts carry its root thread as their origin (outbox/ctx.ts `origin`).
  const root = ctx.canvas.paneOf(ctx.sessionId)
  if ('draft' in card) {
    const row = await draftOf(ctx, card.draft.draftId)
    if (!row || row.origin?.app !== 'tempcode' || row.origin.threadId !== root || row.origin.host !== ctx.host) return refuse(NOT_YOURS)
  } else if ('rewrite' in card) {
    const row = await draftOf(ctx, card.rewrite.draftId)
    if (!row || row.status !== 'draft' || row.proposed?.by !== `agent:${ctx.host}:${root}`) return refuse(NO_REWRITE)
  } else {
    const ids = 'rows' in card ? card.rows.threadIds : 'task' in card ? (card.task.threadId ? [card.task.threadId] : []) : card.event.threadId ? [card.event.threadId] : []
    const far = await outside(ctx, ids, sector)
    if (far.length) return refuse(OUT_OF_SECTOR(far[0]!))
  }
  const message = SAID[Object.keys(card)[0]!] ?? 'He sees this as a card to press.'
  const structuredContent: MailOfferResult = { mailOffer: card }
  return { ...workText(JSON.stringify({ mailOffer: card, message })), structuredContent: structuredContent as unknown as Record<string, unknown> }
}

export const offerTool: WorkTool = {
  name: 'mail_offer',
  description:
    'Show the owner one card beside the mail, for his press: {draft} a reply you wrote here with draft_mail; {rewrite} your rewrite of his reply, made with update_mail_draft; {rows} mail threads to archive, mark read, flag as needs me or snooze; {task} or {event} to add. It changes nothing itself. Give exactly one.',
  input: OfferInput,
  readOnly: true,
  run: offer
}
