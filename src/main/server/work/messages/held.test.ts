import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { OutboxItem } from '@shared/contract-work-outbox'
import { loadWorkModules, WORK_MODULES } from '../modules'
import { wordsOf } from '../outbox/earned'
import { approveKey } from '../outbox/rig'
import { FakeChats } from './fakeChats'
import { CHAT_GONE, chatReplyKind } from './held'
import { makeChatRig, type ChatRig } from './testRig'

/**
 * A chat reply waits for his press (docs/agents/work-messages.md "The hold"):
 * a thread's draft is held, stays held under Away, goes once on two presses,
 * is never a thread's to press or to grant, and on the press reads the
 * conversation again: stale when it left the job, not sent when LifeOS says no.
 */

let t: ChatRig
const text = (r: { content: unknown[] }): string => (r.content as { text?: string }[]).map((c) => c.text ?? '').join('\n')
const draft = (args: unknown, id = 't-cosmic') => t.rig.work.tools.call({ id, scope: 'work' }, 'messages_draft_reply', args, new AbortController().signal)
const send = (ref: unknown, by?: Parameters<ChatRig['rig']['rpc']>[2]) => t.rig.rpc<OutboxItem>('work.outbox.send', { ref }, by)
const words = 'Looking now, the build should be green by noon.'

beforeAll(async () => {
  await loadWorkModules()
})
beforeEach(async () => {
  t = await makeChatRig()
  t.chats.chat({ _id: 'c-dana', name: 'Dana Lee', source: 'slack' })
})
afterEach(async () => {
  await t.rig.close()
})

describe('a drafted reply', () => {
  it('is held with where it goes and its first words, and nothing reaches LifeOS', async () => {
    expect(text(await draft({ chat: 'c-dana', text: words }))).toBe(
      'Held: Reply in Slack to Dana Lee: “Looking now, the build should be green by noon.”. It waits for the owner\'s press; nothing is sent until then. This is a finished step, not a failure: carry on.'
    )
    const [item] = await t.rig.waiting()
    expect(item).toMatchObject({ kind: 'chat.reply', state: 'held', verb: 'Send', sessionId: 't-cosmic', workspaceId: 'ws-cosmic', sector: 'cosmic', payload: { chatId: 'c-dana', source: 'slack', chat: 'Dana Lee', text: words } })
    expect(t.chats.replies).toEqual([])
  })

  it('stays held under Away, goes once on his press, and a second press sends nothing more', async () => {
    t.rig.away.enabled = true
    await draft({ chat: 'c-dana', text: words, reply_to: 'm-41' })
    const [item] = await t.rig.waiting()
    expect(item!.state).toBe('held')
    expect(t.chats.replies).toEqual([])
    const sent = await send(item!.ref)
    expect(sent.state).toBe('sent')
    expect(t.chats.replies).toEqual([{ id: expect.any(String), chatId: 'c-dana', replyTo: 'm-41', text: words }])
    expect(await send(item!.ref, approveKey)).toMatchObject({ state: 'sent' })
    expect(t.chats.replies).toHaveLength(1)
    const full = await t.rig.rpc<OutboxItem>('work.outbox.get', { ref: item!.ref })
    expect(full.result).toEqual({ summary: 'Sent to Dana Lee in Slack', ref: { at: 'lifeos', table: 'outbox', id: t.chats.replies[0]!.id } })
  })

  it("is refused to a thread's own call, whatever it carries, and takes no grant", async () => {
    await draft({ chat: 'c-dana', text: words })
    const [item] = await t.rig.waiting()
    const outbox = WORK_MODULES.find((m) => m.id === 'outbox')!
    const model = { kind: 'model' as const, caps: ['read', 'operate', 'approve', 'admin'], sessionId: 't-cosmic' }
    await expect(outbox.handle!({ id: '1', method: 'work.outbox.send', params: { ref: item!.ref } } as never, t.rig.work.ctx, model)).rejects.toThrow()
    await expect(t.rig.rpc('work.outbox.grant', { from: item!.ref, matcher: { chatId: 'c-dana' } })).rejects.toThrow()
    expect(t.chats.replies).toEqual([])
    // a second reply to the same conversation waits for its own press
    await send(item!.ref)
    await draft({ chat: 'c-dana', text: 'One more thing.' })
    expect((await t.rig.waiting()).map((i) => i.state)).toEqual(['held'])
    expect(t.chats.replies).toHaveLength(1)
  })

  it('keeps its first words, so an edit before the press is known as one; it earns no grant', () => {
    expect(wordsOf('chat.reply', { chatId: 'c-dana', source: 'slack', chat: 'Dana Lee', text: words })).toEqual({ chatId: 'c-dana', text: words })
    expect(chatReplyKind.matcher).toBeUndefined()
  })

  it('may be edited in the Outbox in its words alone', async () => {
    await draft({ chat: 'c-dana', text: words })
    const [item] = await t.rig.waiting()
    const edited = await t.rig.rpc<OutboxItem>('work.outbox.edit', { ref: item!.ref, payload: { ...(item!.payload as object), chatId: 'c-other', chat: 'Omar Reyes', text: 'Green by one.' } })
    expect(edited.payload).toMatchObject({ chatId: 'c-dana', chat: 'Dana Lee', text: 'Green by one.' })
    expect(edited.summary).toBe('Reply in Slack to Dana Lee: “Green by one.”')
  })
})

describe('on his press', () => {
  it('is stale for a conversation that moved to another job, or is gone, and sends nothing', async () => {
    await draft({ chat: 'c-dana', text: words })
    t.chats.chat({ _id: 'c-omar', name: 'Omar Reyes' })
    await draft({ chat: 'c-omar', text: words })
    const [a, b] = await t.rig.waiting()
    t.chats.chats.get('c-dana')!.sector = 'hypixel'
    t.chats.chats.delete('c-omar')
    for (const item of [a!, b!]) expect(await send(item.ref)).toMatchObject({ state: 'stale', error: CHAT_GONE })
    expect(t.chats.replies).toEqual([])
  })

  it("is not sent when LifeOS's route says no, in LifeOS's words, and a plain press may try again", async () => {
    t.chats.chat({ _id: 'c-mom', name: 'Mom', source: 'imessage' })
    t.chats.routes.set('c-mom', { can: false, why: "Your Mac isn't running LifeOS" })
    await draft({ chat: 'c-mom', text: 'Home by six.' })
    const [item] = await t.rig.waiting()
    expect(await send(item!.ref)).toMatchObject({ state: 'failed', error: "Your Mac isn't running LifeOS" })
    t.chats.routes.delete('c-mom')
    expect(await send(item!.ref)).toMatchObject({ state: 'sent' })
    expect(t.chats.replies.map((r) => r.text)).toEqual(['Home by six.'])
  })

  it("is not sent when LifeOS refuses the reply, in its words; a fault that may have reached it reads may-have-gone", async () => {
    await draft({ chat: 'c-dana', text: words })
    const [item] = await t.rig.waiting()
    t.chats.refuseNext = FakeChats.refusal({ code: 'mac-offline', message: "Your Mac isn't running LifeOS" })
    expect(await send(item!.ref)).toMatchObject({ state: 'failed', error: "Your Mac isn't running LifeOS" })
    t.chats.refuseNext = new Error('socket hang up')
    const after = await send(item!.ref)
    expect(after.state).toBe('failed')
    expect(after.error).toContain('socket hang up')
    expect(t.chats.replies).toEqual([])
  })

  it('reads a source that has no way to send as not sent, in its own words', async () => {
    const act = { lifeos: t.chats.client(), item: { sector: 'cosmic' } } as never
    t.chats.chat({ _id: 'c-disc', source: 'discord', name: '#clips' })
    await expect(chatReplyKind.execute({ chatId: 'c-disc', source: 'discord', chat: '#clips', text: 'x' }, act)).rejects.toThrow("LifeOS can't reply in Discord yet")
    t.chats.routes.set('c-disc', { can: false, why: "LifeOS can't reply in discord yet" })
    await expect(chatReplyKind.execute({ chatId: 'c-disc', source: 'discord', chat: '#clips', text: 'x' }, act)).rejects.toThrow("LifeOS can't reply in discord yet")
    expect(t.chats.replies).toEqual([])
  })
})
