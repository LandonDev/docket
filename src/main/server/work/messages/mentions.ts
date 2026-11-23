import { MENTION_PER_KIND, mentionExcerpt, type MentionHit, type MentionReach } from '@shared/work'
import { SOURCE_NAME, type ChatRow } from '@shared/work/messages'
import type { MentionSource } from '../modules'

/**
 * A conversation for the composer's `@` (docs/agents/work-canvas.md
 * "Mentions"): LifeOS's `chats:find` by name, read as the owner, so the
 * reach's sectors are the fence: a conversation of a sector the thread may
 * not read never shows, whatever LifeOS answered.
 */

const reads = (reach: MentionReach, sector: string | undefined): boolean => reach.sectors === 'all' || (!!sector && reach.sectors.includes(sector))

/** "Dana Lee in Slack": the chip's label, and what the model reads after "About this conversation:". */
export const chatLabel = (row: Pick<ChatRow, 'name' | 'source'>): string => `${row.name} in ${SOURCE_NAME[row.source]}`

export const chatHit = (row: ChatRow): MentionHit => ({
  chip: { kind: 'chat', label: chatLabel(row), ref: { at: 'lifeos', table: 'chats', id: row._id }, excerpt: mentionExcerpt(row.lastText) },
  ...(row.accountName ? { detail: row.accountName } : {}),
  at: row.lastAt
})

export const chatMentions: MentionSource = {
  kind: 'chat',
  lifeos: true,
  async search(text, reach, ctx) {
    if (reach.sectors !== 'all' && reach.sectors.length === 0) return []
    // One sector is asked for by name; a reach of several (a Work Chat) asks for all and keeps what is in reach.
    const one = reach.sectors !== 'all' && reach.sectors.length === 1 ? { sector: reach.sectors[0] } : {}
    const rows = (await ctx.lifeos.owner().query<ChatRow[]>('chats:find', { ...one, text })) ?? []
    return rows.filter((row) => reads(reach, row.sector)).slice(0, MENTION_PER_KIND).map(chatHit)
  }
}
