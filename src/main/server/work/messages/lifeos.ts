import type { MessagesSearchAnswer, MessagesUnansweredAnswer, MessagesUnread } from '@shared/contract-work-messages'
import { errorText, type SectorKey } from '@shared/work'
import type { ChatDetail, ChatHit, ChatRow, ChatWaiting } from '@shared/work/messages'
import type { WorkCtx } from '../modules'

/**
 * LifeOS's chat, read as the owner (docs/agents/work-messages.md). The
 * owner's client reads every sector, so each read here is fenced by hand:
 * the workspace names its sector, LifeOS is asked for that sector alone, and
 * every row it answers is checked again. A conversation of another sector
 * reads as one that does not exist.
 */

export const NOT_WORK = 'Messages is for a Work workspace with a sector'
export const NO_CHAT = 'LifeOS has no such conversation'

/** A Work workspace's sector, from the frame's own row: a code workspace, or one with no sector, is refused. */
export function workSector(ctx: Pick<WorkCtx, 'db'>, workspaceId: string): SectorKey {
  const row = ctx.db.prepare('SELECT kind, sector FROM workspaces WHERE id = ?').get(workspaceId) as { kind: string | null; sector: string | null } | undefined
  if (!row || row.kind !== 'work' || !row.sector) throw new Error(NOT_WORK)
  return row.sector
}

/** This host's Work workspaces that link a sector: the ones whose chat is watched. */
export function linkedWorkspaces(ctx: Pick<WorkCtx, 'db'>): { id: string; sector: SectorKey }[] {
  return ctx.db.prepare("SELECT id, sector FROM workspaces WHERE kind = 'work' AND sector IS NOT NULL AND sector != ''").all() as { id: string; sector: string }[]
}

/**
 * LifeOS's own words for a refusal: a ConvexError carries them as `data`, a
 * sentence ("LifeOS can't reply in discord yet") or `{code, message}` ("Your
 * Mac isn't running LifeOS"). Anything else is the error's own first line.
 */
export function refusalWords(err: unknown): string {
  const data = (err as { data?: unknown } | null)?.data
  if (typeof data === 'string' && data.trim()) return data.trim()
  const message = data && typeof data === 'object' ? (data as { message?: unknown }).message : undefined
  if (typeof message === 'string' && message.trim()) return message.trim()
  return errorText(err).split('\n')[0]!
}

/** Whether LifeOS refused the call itself (a ConvexError), as against a socket that went or a fault: nothing was done. */
export const isRefusal = (err: unknown): boolean => (err as { data?: unknown } | null)?.data !== undefined

/** A conversation and its route, only when it is in `sector`; null for one that is gone or another sector's. */
export async function chatIn(ctx: Pick<WorkCtx, 'lifeos'>, chatId: string, sector: SectorKey): Promise<ChatDetail | null> {
  const got = await ctx.lifeos.owner().query<ChatDetail | null>('chats:get', { id: chatId })
  return got?.chat && got.chat.sector === sector ? got : null
}

/** A conversation waiting on him, as Today lists it. */
export const waitingOf = (row: ChatRow): ChatWaiting => ({ chatId: row._id, chat: row.name, who: row.lastWho, text: row.lastText, at: row.lastInAt ?? row.lastAt, source: row.source })

/** This job's messages that hold the words, newest first. */
export async function searchChats(ctx: Pick<WorkCtx, 'lifeos'>, sector: SectorKey, query: string, limit?: number): Promise<MessagesSearchAnswer> {
  const rows = await ctx.lifeos.owner().query<(ChatHit & { sector?: string })[]>('chats:search', { sector, text: query, ...(limit !== undefined ? { limit } : {}) })
  const hits: ChatHit[] = []
  for (const { sector: of, ...hit } of rows ?? []) if (of === sector) hits.push(hit)
  return { hits: limit !== undefined ? hits.slice(0, limit) : hits }
}

/** The sector's conversations that wait on his answer, LifeOS's rows kept to the sector. */
export async function unansweredChats(ctx: Pick<WorkCtx, 'lifeos'>, sector: SectorKey): Promise<ChatRow[]> {
  const rows = await ctx.lifeos.owner().query<ChatRow[]>('chats:unanswered', { sector })
  return (rows ?? []).filter((r) => r.sector === sector)
}

export async function unanswered(ctx: Pick<WorkCtx, 'lifeos'>, sector: SectorKey): Promise<MessagesUnansweredAnswer> {
  return { rows: (await unansweredChats(ctx, sector)).map(waitingOf) }
}

/** LifeOS's count, as the wire and the push carry it. */
export const unreadAnswer = (got: { count?: number; newest?: number } | null | undefined): MessagesUnread => ({
  unread: typeof got?.count === 'number' ? got.count : 0,
  ...(typeof got?.newest === 'number' ? { newest: got.newest } : {})
})

export async function unread(ctx: Pick<WorkCtx, 'lifeos'>, sector: SectorKey): Promise<MessagesUnread> {
  return unreadAnswer(await ctx.lifeos.owner().query<{ count: number; newest?: number }>('chats:unread', { sector }))
}
