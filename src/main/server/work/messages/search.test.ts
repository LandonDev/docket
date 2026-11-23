import { describe, expect, it } from 'vitest'
import type { SearchReach } from '@shared/work/search'
import type { ChatHit, ChatRow } from '@shared/work/messages'
import type { Caller, WorkCtx } from '../modules'
import { chatSearch, messageSearch } from './search'

/** This pillar in the one search: every job in reach asked by its own sector, and nothing kept from another. Made-up names only. */

const jobs: SearchReach['workspaces'] = [
  { id: 'ws-starboard', sector: 'cosmic', name: 'Starboard' },
  { id: 'ws-harbor', sector: 'hypixel', name: 'Harbor' },
  { id: 'ws-bare', sector: null, name: 'Side job' }
]
const reach: SearchReach = { workspaces: jobs, chats: true, sessionId: null }
const by: Caller = { kind: 'local', caps: ['read'] }
const ask = (text: string, limit = 5) => ({ text, reach, limit, by, signal: new AbortController().signal })

const hit = (n: number, sector: string): ChatHit & { sector: string } => ({ chatId: `c-${sector}`, messageId: `m-${sector}-${n}`, chat: sector === 'cosmic' ? 'Dana Lee' : '#builds', who: 'Dana Lee', text: `the venue moved to Friday ${n}`, at: 1_000 - n, source: 'slack', sector })
const row = (id: string, name: string, sector: string): ChatRow => ({ _id: id, source: 'discord', account: 'g', channel: id, name, kind: 'channel', sector, lastAt: 5, lastText: 'newest words', lastWho: 'Omar Reyes', lastFromMe: false, unread: false, faces: [] })

function ctx(answer: (fn: string, args: Record<string, unknown>) => unknown): { ctx: WorkCtx; asked: { fn: string; args: Record<string, unknown> }[] } {
  const asked: { fn: string; args: Record<string, unknown> }[] = []
  const ctx = { lifeos: { owner: () => ({ query: async (fn: string, args: Record<string, unknown>) => (asked.push({ fn, args }), answer(fn, args)) }) } } as unknown as WorkCtx
  return { ctx, asked }
}

describe('messages in the one search', () => {
  it('asks each job with a sector by that sector, and deals the jobs a turn each', async () => {
    const { ctx: c, asked } = ctx((_fn, args) => [1, 2, 3].map((n) => hit(n, args.sector as string)))
    const hits = await messageSearch.search(ask('venue', 3), c)
    expect(asked.map((a) => [a.fn, a.args.sector, a.args.text])).toEqual([
      ['chats:search', 'cosmic', 'venue'],
      ['chats:search', 'hypixel', 'venue']
    ])
    // limit + 1, so the frame can say there are more.
    expect(hits.map((h) => [h.workspaceId, h.key])).toEqual([
      ['ws-starboard', 'lifeos:rawMessages:m-cosmic-1'],
      ['ws-harbor', 'lifeos:rawMessages:m-hypixel-1'],
      ['ws-starboard', 'lifeos:rawMessages:m-cosmic-2'],
      ['ws-harbor', 'lifeos:rawMessages:m-hypixel-2']
    ])
    expect(hits[0]).toMatchObject({
      kind: 'message',
      title: 'Dana Lee',
      detail: 'Dana Lee',
      snippet: 'the venue moved to Friday 1',
      open: { to: 'view', view: 'messages', with: { chat: 'c-cosmic', message: 'm-cosmic-1' } },
      chip: { kind: 'chat', label: 'Dana Lee in Slack', ref: { at: 'lifeos', table: 'chats', id: 'c-cosmic' } }
    })
  })

  it('drops a hit LifeOS answered from another sector', async () => {
    const { ctx: c } = ctx(() => [hit(1, 'purdue'), hit(2, 'cosmic')])
    const hits = await messageSearch.search({ ...ask('venue'), reach: { ...reach, workspaces: [jobs[0]!] } }, c)
    expect(hits.map((h) => h.key)).toEqual(['lifeos:rawMessages:m-cosmic-2'])
  })

  it('finds a conversation by name in its own job, and opens the view on it', async () => {
    const { ctx: c, asked } = ctx((_fn, args) => (args.sector === 'cosmic' ? [row('c1', '#builds', 'cosmic'), row('c9', '#builds-old', 'purdue')] : []))
    const hits = await chatSearch.search(ask('builds'), c)
    expect(asked.map((a) => [a.fn, a.args.sector])).toEqual([
      ['chats:find', 'cosmic'],
      ['chats:find', 'hypixel']
    ])
    expect(hits).toEqual([
      {
        key: 'lifeos:chats:c1',
        kind: 'chat',
        title: '#builds',
        detail: 'newest words',
        at: 5,
        workspaceId: 'ws-starboard',
        open: { to: 'view', view: 'messages', with: { chat: 'c1' } },
        chip: { kind: 'chat', label: '#builds in Discord', ref: { at: 'lifeos', table: 'chats', id: 'c1' } }
      }
    ])
  })

  it('asks nothing where no job in reach has a sector', async () => {
    const { ctx: c, asked } = ctx(() => [])
    expect(await messageSearch.search({ ...ask('venue'), reach: { workspaces: [jobs[2]!], chats: true, sessionId: null } }, c)).toEqual([])
    expect(asked).toEqual([])
  })
})
