import { mentionExcerptAt } from '@shared/work'
import { lifeosKey, SEARCH_SNIPPET, type SearchHit } from '@shared/work/search'
import type { ChatRow } from '@shared/work/messages'
import type { SearchSource } from '../search/source'
import { searchChats } from './lifeos'
import { chatLabel } from './mentions'

/**
 * This pillar in the one search (docs/agents/work-search.md "How a pillar
 * registers"): a job's messages that hold the words, and its conversations
 * by name. Each job in reach with a sector is asked by that sector, as the
 * owner, and what LifeOS answers is kept to it (lifeos.ts). A hit opens the
 * Messages view on its conversation, a message's on the message.
 */

/** A message's line for a row: cut round the words that found it, so a long message still shows why it is there. */
const clip = (text: string, asked: string): string => mentionExcerptAt(text, asked, SEARCH_SNIPPET) ?? ''

/** One turn a job, so one job's rows never fill the group before another's first. */
function dealt(each: SearchHit[][], limit: number): SearchHit[] {
  const out: SearchHit[] = []
  for (let i = 0; out.length <= limit && each.some((hits) => i < hits.length); i++) for (const hits of each) if (i < hits.length) out.push(hits[i]!)
  return out.slice(0, limit + 1)
}

/** Messages that hold the words. */
export const messageSearch: SearchSource = {
  kind: 'message',
  label: 'Messages',
  tier: 'network',
  lifeos: true,
  async search(ask, ctx) {
    const jobs = ask.reach.workspaces.filter((w) => w.sector)
    const each = await Promise.all(
      jobs.map(async (job) => {
        const { hits } = await searchChats(ctx, job.sector!, ask.text, Math.min(ask.limit + 1, 50))
        return hits.map(
          (hit): SearchHit => ({
            key: lifeosKey('rawMessages', hit.messageId),
            kind: 'message',
            title: hit.chat,
            detail: hit.who,
            snippet: clip(hit.text, ask.text),
            at: hit.at,
            workspaceId: job.id,
            open: { to: 'view', view: 'messages', with: { chat: hit.chatId, message: hit.messageId } },
            chip: { kind: 'chat', label: chatLabel({ name: hit.chat, source: hit.source }), ref: { at: 'lifeos', table: 'chats', id: hit.chatId }, quote: clip(hit.text, ask.text) }
          })
        )
      })
    )
    return dealt(each, ask.limit)
  }
}

/** Conversations by name. Listed here, so the mention bridge does not list them a second time. */
export const chatSearch: SearchSource = {
  kind: 'chat',
  label: 'Conversations',
  tier: 'network',
  lifeos: true,
  async search(ask, ctx) {
    const jobs = ask.reach.workspaces.filter((w) => w.sector)
    const each = await Promise.all(
      jobs.map(async (job) => {
        const rows = (await ctx.lifeos.owner().query<ChatRow[]>('chats:find', { sector: job.sector, text: ask.text })) ?? []
        return rows
          .filter((row) => row.sector === job.sector)
          .map(
            (row): SearchHit => ({
              key: lifeosKey('chats', row._id),
              kind: 'chat',
              title: row.name,
              ...(row.lastText ? { detail: clip(row.lastText, '') } : {}),
              at: row.lastAt,
              workspaceId: job.id,
              open: { to: 'view', view: 'messages', with: { chat: row._id } },
              chip: { kind: 'chat', label: chatLabel(row), ref: { at: 'lifeos', table: 'chats', id: row._id } }
            })
          )
      })
    )
    return dealt(each, ask.limit)
  }
}
