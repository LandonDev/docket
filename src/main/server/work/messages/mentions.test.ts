import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { MentionAnswer } from '@shared/work'
import type { ChatRow } from '@shared/work/messages'
import { loadWorkModules } from '../modules'
import { chatHit } from './mentions'
import type { ChatTell } from './tell'
import { makeChatRig, type ChatRig } from './testRig'

/**
 * Threads and the digest (docs/agents/work-messages.md "Threads and the
 * digest"): `@` finds a conversation of the thread's own sector and none of
 * another's; a chip names it as the model reads it; a conversation that
 * comes to wait on him is told once, and taken back when it leaves.
 */

let t: ChatRig
const settle = () => new Promise((r) => setTimeout(r, 0))
const at = (sessionId: string, text: string) => t.rig.rpc<MentionAnswer>('work.canvas.mentions', { sessionId, text, kinds: ['chat'] })

beforeAll(async () => {
  await loadWorkModules()
})
beforeEach(async () => {
  t = await makeChatRig()
  t.chats.chat({ _id: 'c-dana', name: 'Dana Lee', lastText: 'Can you look at the build?', lastAt: 30 })
  t.chats.chat({ _id: 'c-builds', name: '#builds', kind: 'channel', lastWho: 'Omar Reyes', lastText: 'Build 41 is red', lastAt: 20 })
  t.chats.chat({ _id: 'c-dan', name: 'Dan Ortiz', sector: 'hypixel', source: 'discord', lastAt: 40 })
})
afterEach(async () => {
  await t.rig.close()
})

describe('@ a conversation', () => {
  it("finds the thread's own sector's conversations and none of another's, whatever LifeOS answers", async () => {
    t.chats.leaky = true
    const cosmic = await at('t-cosmic', 'dan')
    expect(cosmic.hits.map((h) => h.chip)).toEqual([{ kind: 'chat', label: 'Dana Lee in Slack', ref: { at: 'lifeos', table: 'chats', id: 'c-dana' }, excerpt: 'Can you look at the build?' }])
    expect(t.chats.calls.find((c) => c.fn === 'chats:find')?.args).toEqual({ sector: 'cosmic', text: 'dan' })
    const hypixel = await at('t-hypixel', 'dan')
    expect(hypixel.hits.map((h) => h.chip.label)).toEqual(['Dan Ortiz in Discord'])
  })

  it('names the account and the time on the row', () => {
    expect(chatHit(t.chats.chats.get('c-dana') as ChatRow)).toMatchObject({ detail: 'CosmicGames', at: 30 })
  })
})

describe('the digest', () => {
  it('is told once of a conversation that comes to wait on him, and told it is done when it leaves', async () => {
    const told: ChatTell[] = []
    const done: string[] = []
    // What waits already was heard before the digest came: only what comes after is told.
    t.chats.fire()
    ;(t.rig.work.ctx as unknown as { tell: unknown }).tell = Object.assign((x: ChatTell) => void told.push(x), { done: (key: string) => void done.push(key) })
    t.chats.fire()
    expect(told).toEqual([])
    t.chats.chat({ _id: 'c-new', name: 'Omar Reyes', lastWho: 'Omar Reyes', lastText: 'Is the cut ready for review today?', lastAt: 50 })
    t.chats.fire()
    t.chats.fire()
    expect(told).toEqual([
      {
        kind: 'messages.new',
        workspaceId: 'ws-cosmic',
        title: 'Omar Reyes wrote in Slack',
        detail: 'Is the cut ready for review today?',
        open: { view: 'messages', workspaceId: 'ws-cosmic', at: 'c-new' },
        key: 'messages:c-new'
      }
    ])
    t.chats.chats.get('c-new')!.unread = false
    t.chats.fire()
    expect(done).toEqual(['messages:c-new'])
    expect(told).toHaveLength(1)
  })

  it('says where, for a channel, and tells nothing of another sector or while there is no digest', async () => {
    await settle()
    const told: ChatTell[] = []
    t.chats.chat({ _id: 'c-ch', name: '#clips', kind: 'channel', lastWho: 'Dana Lee', lastText: 'New cut is up' })
    t.chats.fire()
    ;(t.rig.work.ctx as unknown as { tell: unknown }).tell = Object.assign((x: ChatTell) => void told.push(x), { done: () => {} })
    t.chats.leaky = true
    t.chats.chat({ _id: 'c-ch2', name: '#builds-2', kind: 'channel', lastWho: 'Dana Lee', lastText: 'Second' })
    t.chats.chat({ _id: 'c-hx', sector: 'hypixel', name: 'Dan Ortiz', lastWho: 'Dan Ortiz' })
    t.chats.fire()
    expect(told.map((x) => [x.workspaceId, x.title])).toEqual([
      ['ws-cosmic', 'Dana Lee wrote in #builds-2'],
      ['ws-hypixel', 'Dan Ortiz wrote in Slack']
    ])
  })
})
