import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { MessagesPush } from '@shared/contract-work-messages'
import type { SessionMeta } from '@shared/events'
import { loadWorkModules } from '../modules'
import { readKey } from '../outbox/rig'
import { messages } from './index'
import { NO_CHAT } from './lifeos'
import { FakeChats } from './fakeChats'
import { NOT_A_PERSON, NOT_HERE, sendReply } from './replies'
import { PREAMBLE } from './tools'
import { makeChatRig, type ChatRig } from './testRig'

/**
 * A thread's chat tools and his presses (docs/agents/work-messages.md):
 * `messages_read` reads its own job's chat and marks nothing read;
 * `messages_draft_reply` holds a reply, or keeps a draft where nothing can
 * send; send, undo, retry and dropping a draft are a person's, fenced to the
 * workspace's sector.
 */

let t: ChatRig
const out = (r: { content: unknown[] }): string => (r.content as { text?: string }[]).map((c) => c.text ?? '').join('\n')
const tool = (name: string, args: unknown, id = 't-cosmic') => t.rig.work.tools.call({ id, scope: 'work' } as SessionMeta, name, args, new AbortController().signal)
const model = { kind: 'model' as const, caps: ['read', 'operate', 'approve', 'admin'], sessionId: 't-cosmic' }
const asModel = (method: string, params: unknown) => messages.handle!({ id: '1', method, params } as never, t.rig.work.ctx, model)
const settle = () => new Promise((r) => setTimeout(r, 0))

beforeAll(async () => {
  await loadWorkModules()
})
beforeEach(async () => {
  t = await makeChatRig()
  t.chats.chat({ _id: 'c-dana', name: 'Dana Lee', lastAt: Date.UTC(2026, 10, 20, 15), lastText: 'Can you look at the build?' })
  t.chats.chat({ _id: 'c-builds', name: '#builds', kind: 'channel', unread: false, lastFromMe: true, lastAt: Date.UTC(2026, 10, 19, 15), lastText: 'Shipped.' })
  t.chats.chat({ _id: 'c-omar', name: 'Omar Reyes', sector: 'hypixel', source: 'discord' })
})
afterEach(async () => {
  await t.rig.close()
})

describe('who is offered chat', () => {
  it("a Work thread with a sector the owner left in AGENT_CHAT_SECTORS: both tools and the preamble's line", () => {
    const scope = (sector: string | null) => ({ sessionId: 't', workspaceId: 'w', sector, host: 'env_box', away: false, routineRunId: null, shared: () => false })
    expect(messages.tools!(scope('cosmic')).map((x) => x.name)).toEqual(['messages_read', 'messages_draft_reply'])
    expect(messages.tools!(scope(null))).toEqual([])
    expect(messages.tools!(scope('elsewhere'))).toEqual([])
    expect(messages.preamble!(scope('cosmic'))).toBe(
      "Chat: read this job's conversations with messages_read. To answer one, use messages_draft_reply: the reply waits for the owner's press. You never send chat."
    )
    expect(messages.preamble!(scope(null))).toBeNull()
    expect(PREAMBLE).toContain('You never send chat.')
  })
})

describe('messages_read', () => {
  it("lists the job's conversations, newest first, with their ids, and asks LifeOS for the sector alone", async () => {
    t.chats.leaky = true
    const text = out(await tool('messages_read', {}))
    expect(text.split('\n')[0]).toBe('Conversations, newest first:')
    expect(text).toContain('- Dana Lee (Slack, CosmicGames, unread)')
    expect(text).toContain('Dana Lee: “Can you look at the build?”; conversation c-dana')
    expect(text).toContain('You: “Shipped.”; conversation c-builds')
    expect(text).not.toContain('Omar Reyes')
    expect(t.chats.calls.find((c) => c.fn === 'chats:list')?.args).toMatchObject({ sector: 'cosmic' })
  })

  it('reads a conversation oldest to newest, with times, what a message answers and its files', async () => {
    t.chats.messages.set('c-dana', [
      { _id: 'm2', who: { name: 'Landon', me: true }, text: 'On it.', sentAt: Date.UTC(2026, 10, 20, 16), files: [] },
      { _id: 'm1', who: { name: 'Dana Lee', me: false }, text: 'Can you look at the build? [file: log.txt]', sentAt: Date.UTC(2026, 10, 20, 15), replyTo: { who: 'Omar Reyes', text: 'Build 41 is red' }, files: [{ _id: 'f1', name: 'log.txt', status: 'listed' }] }
    ])
    const lines = out(await tool('messages_read', { chat: 'c-dana' })).split('\n')
    expect(lines[0]).toBe("Dana Lee in Slack, CosmicGames (conversation c-dana), oldest to newest; a message's id is what reply_to takes:")
    expect(lines[1]).toMatch(/^\[Nov 20, .+\] Dana Lee \(replying to Omar Reyes: “Build 41 is red”\): Can you look at the build\? \[files: log\.txt\]; message m1$/)
    expect(lines[2]).toMatch(/^\[Nov 20, .+\] You: On it\.; message m2$/)
  })

  it('gives times in his zone, named, whatever zone the host keeps', async () => {
    t.chats.timezone = 'America/Chicago'
    t.chats.messages.set('c-dana', [{ _id: 'm1', who: { name: 'Dana Lee', me: false }, text: 'Can you look?', sentAt: Date.UTC(2026, 10, 20, 20, 15), files: [] }])
    expect(out(await tool('messages_read', { chat: 'c-dana' })).split('\n')[1]).toBe('[Nov 20, 2:15 PM CST] Dana Lee: Can you look?; message m1')
    t.chats.timezone = 'America/New_York'
    expect(out(await tool('messages_read', { chat: 'c-dana' })).split('\n')[1]).toBe('[Nov 20, 3:15 PM EST] Dana Lee: Can you look?; message m1')
  })

  it("gives a file-only message's id, and a draft that names it answers that message", async () => {
    t.chats.messages.set('c-dana', [
      { _id: 'm9', who: { name: 'Dana Lee', me: false }, text: 'Newer words', sentAt: Date.UTC(2026, 10, 20, 17), files: [] },
      { _id: 'm8', who: { name: 'Dana Lee', me: false }, text: '[file: spec.pdf]', sentAt: Date.UTC(2026, 10, 20, 16), files: [{ _id: 'f1', name: 'spec.pdf', status: 'stored' }] }
    ])
    const lines = out(await tool('messages_read', { chat: 'c-dana', limit: 2 })).split('\n')
    expect(lines[1]).toMatch(/Dana Lee: \(no words\) \[files: spec\.pdf\]; message m8$/)
    await tool('messages_draft_reply', { chat: 'c-dana', text: 'Read it.', reply_to: 'm8' })
    expect((await t.rig.waiting())[0]!.payload).toMatchObject({ chatId: 'c-dana', replyTo: 'm8' })
  })

  it("refuses another sector's conversation whatever LifeOS answers, and marks nothing read", async () => {
    t.chats.leaky = true
    const answer = await tool('messages_read', { chat: 'c-omar' })
    expect(answer.isError).toBe(true)
    expect(out(answer)).toBe("No conversation c-omar in this job's chat. Read the list with messages_read.")
    expect(t.chats.calls.map((c) => c.fn)).not.toContain('chats:messages')
    await tool('messages_read', { chat: 'c-dana' })
    await tool('messages_read', { query: 'build' })
    expect(t.chats.calls.map((c) => c.fn).filter((fn) => fn.startsWith('chats:mark'))).toEqual([])
  })

  it("searches the job's messages and drops a hit of another sector", async () => {
    t.chats.leaky = true
    t.chats.hits = [
      { chatId: 'c-dana', messageId: 'm1', chat: 'Dana Lee', who: 'Dana Lee', text: 'Can you look at the build?', at: Date.UTC(2026, 10, 20, 15), source: 'slack', sector: 'cosmic' },
      { chatId: 'c-omar', messageId: 'm9', chat: 'Omar Reyes', who: 'Omar Reyes', text: 'The build cut is up', at: Date.UTC(2026, 10, 20, 15), source: 'discord', sector: 'hypixel' }
    ]
    const text = out(await tool('messages_read', { query: 'build' }))
    expect(text).toContain('conversation c-dana, message m1')
    expect(text).not.toContain('c-omar')
  })
})

describe('messages_draft_reply', () => {
  it('holds nothing where there is no way to send: it keeps a draft for him to copy and tells every window', async () => {
    t.chats.chat({ _id: 'c-clips', name: '#clips', source: 'discord', kind: 'channel' })
    t.chats.fire()
    await settle()
    const answer = await tool('messages_draft_reply', { chat: 'c-clips', text: 'Clip 3 is the one.' })
    expect(out(answer)).toBe('Saved as a draft in the conversation: nothing can send to Discord from here, the owner will copy it.')
    expect(await t.rig.waiting()).toEqual([])
    expect(t.chats.calls.map((c) => c.fn)).not.toContain('chats:reply')
    expect(await t.rig.rpc('work.messages.drafts', { workspaceId: 'ws-cosmic', chatId: 'c-clips' }, readKey)).toEqual({
      drafts: [{ id: expect.stringMatching(/^md_/), chatId: 'c-clips', sessionId: 't-cosmic', text: 'Clip 3 is the one.', at: expect.any(Number) }]
    })
    expect(t.rig.pushes.filter((p): p is MessagesPush => p.push === 'work.messages').at(-1)).toEqual({ push: 'work.messages', workspaceId: 'ws-cosmic', unread: 2, drafts: 1 })
  })

  it("refuses another sector's conversation and holds nothing", async () => {
    t.chats.leaky = true
    const answer = await tool('messages_draft_reply', { chat: 'c-omar', text: 'Sure.' })
    expect(answer.isError).toBe(true)
    expect(await t.rig.waiting()).toEqual([])
    expect(t.rig.work.ctx.db.prepare('SELECT COUNT(*) AS n FROM work_messages_drafts').get()).toEqual({ n: 0 })
  })

  it("a draft outlives its thread and goes with its workspace; dropping one is a person's", async () => {
    t.chats.chat({ _id: 'c-clips', name: '#clips', source: 'discord' })
    await tool('messages_draft_reply', { chat: 'c-clips', text: 'Clip 3.' })
    messages.sessionsRemoved?.(['t-cosmic'], t.rig.work.ctx)
    const { drafts } = await t.rig.rpc<{ drafts: { id: string }[] }>('work.messages.drafts', { workspaceId: 'ws-cosmic' })
    expect(drafts).toHaveLength(1)
    await expect(asModel('work.messages.dropDraft', { workspaceId: 'ws-cosmic', id: drafts[0]!.id })).rejects.toThrow(NOT_A_PERSON)
    // another workspace's id drops nothing
    await t.rig.rpc('work.messages.dropDraft', { workspaceId: 'ws-hypixel', id: drafts[0]!.id })
    expect((await t.rig.rpc<{ drafts: unknown[] }>('work.messages.drafts', { workspaceId: 'ws-cosmic' })).drafts).toHaveLength(1)
    await tool('messages_draft_reply', { chat: 'c-clips', text: 'Or clip 4.' })
    messages.workspaceRemoved!('ws-cosmic', t.rig.work.ctx)
    expect(t.rig.work.ctx.db.prepare("SELECT COUNT(*) AS n FROM work_messages_drafts WHERE workspace_id = 'ws-cosmic'").get()).toEqual({ n: 0 })
  })
})

describe('his presses', () => {
  it('his Send asks LifeOS as the owner, inside the sector, and says its refusal in its words', async () => {
    expect(await t.rig.rpc('work.messages.send', { workspaceId: 'ws-cosmic', chatId: 'c-dana', replyTo: 'm1', text: 'On it.' })).toEqual({ id: expect.stringMatching(/^out_/) })
    expect(t.chats.replies).toEqual([{ id: expect.any(String), chatId: 'c-dana', replyTo: 'm1', text: 'On it.' }])
    await expect(t.rig.rpc('work.messages.send', { workspaceId: 'ws-cosmic', chatId: 'c-omar', text: 'x' })).rejects.toThrow(NO_CHAT)
    t.chats.refuseNext = FakeChats.refusal("LifeOS can't reply in discord yet")
    await expect(t.rig.rpc('work.messages.send', { workspaceId: 'ws-cosmic', chatId: 'c-dana', text: 'x' })).rejects.toThrow(/^LifeOS can't reply in discord yet$/)
    expect(t.chats.replies).toHaveLength(1)
  })

  it('his Send that failed past a refusal says it may have gone, apart from a refusal', async () => {
    t.chats.refuseNext = new Error('socket hang up')
    await expect(t.rig.rpc('work.messages.send', { workspaceId: 'ws-cosmic', chatId: 'c-dana', text: 'x' })).rejects.toThrow(/^It may have gone: socket hang up$/)
  })

  it('with OWN_REPLY_HELD his reply waits in the Outbox instead, with no thread, and the answer names it', async () => {
    const answer = await sendReply(t.rig.work.ctx, { kind: 'local', caps: ['approve'] }, { workspaceId: 'ws-cosmic', chatId: 'c-dana', text: 'On it.' }, true)
    const [item] = await t.rig.waiting()
    expect(item).toMatchObject({ kind: 'chat.reply', state: 'held', sessionId: null, payload: { chatId: 'c-dana', chat: 'Dana Lee', text: 'On it.' } })
    expect(answer).toEqual({ id: item!.ref.id })
    expect(t.chats.replies).toEqual([])
    expect(await t.rig.rpc('work.outbox.send', { ref: item!.ref })).toMatchObject({ state: 'sent' })
    expect(t.chats.replies).toHaveLength(1)
  })

  it('undo and retry act only on a reply of a conversation of the job', async () => {
    t.chats.messages.set('c-dana', [{ _id: 'mine', who: { name: 'Landon', me: true }, text: 'On it.', sentAt: 1, files: [], reply: { outboxId: 'out_7', status: 'queued' } }])
    t.chats.replies.push({ id: 'out_7', chatId: 'c-dana', text: 'On it.' })
    expect(await t.rig.rpc('work.messages.undo', { workspaceId: 'ws-cosmic', chatId: 'c-dana', id: 'out_7' })).toEqual({ text: 'On it.' })
    expect(await t.rig.rpc('work.messages.retry', { workspaceId: 'ws-cosmic', chatId: 'c-dana', id: 'out_7' })).toEqual({})
    await expect(t.rig.rpc('work.messages.undo', { workspaceId: 'ws-cosmic', chatId: 'c-dana', id: 'out_other' })).rejects.toThrow(NOT_HERE)
    await expect(t.rig.rpc('work.messages.retry', { workspaceId: 'ws-cosmic', chatId: 'c-omar', id: 'out_7' })).rejects.toThrow(NO_CHAT)
    await expect(t.rig.rpc('work.messages.undo', { workspaceId: 'ws-code', chatId: 'c-dana', id: 'out_7' })).rejects.toThrow()
    expect(t.chats.undone).toEqual(['out_7'])
    expect(t.chats.retried).toEqual(['out_7'])
  })

  it("refuse a thread's own call, and a key that may not approve", async () => {
    for (const [method, params] of [
      ['work.messages.send', { workspaceId: 'ws-cosmic', chatId: 'c-dana', text: 'x' }],
      ['work.messages.undo', { workspaceId: 'ws-cosmic', chatId: 'c-dana', id: 'out_7' }],
      ['work.messages.retry', { workspaceId: 'ws-cosmic', chatId: 'c-dana', id: 'out_7' }],
      ['work.messages.dropDraft', { workspaceId: 'ws-cosmic', id: 'md_1' }]
    ] as const) {
      await expect(asModel(method, params)).rejects.toThrow(NOT_A_PERSON)
      if (method !== 'work.messages.dropDraft') await expect(t.rig.rpc(method, params, readKey)).rejects.toThrow()
    }
    expect(t.chats.calls.map((c) => c.fn)).toEqual([])
  })
})
