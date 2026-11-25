import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadWorkModules } from '../modules'
import { readKey } from '../outbox/rig'
import { ATTEMPT_CUT, ATTEMPT_EXPIRED, ATTEMPT_KEPT_MS, ATTEMPT_OTHER, attemptOf, sendOnce } from './attempts'
import { FakeChats } from './fakeChats'
import { messages } from './index'
import { NOT_A_PERSON } from './replies'
import { makeChatRig, type ChatRig } from './testRig'

/**
 * His Send answered once by the phone's attempt key (attempts.ts): a repeat
 * of the key gets the first answer and LifeOS hears the reply once; a lost
 * answer is read back by the same key, and the read sends nothing.
 */

let t: ChatRig
const send = (attempt: string, extra: Record<string, unknown> = {}) =>
  t.rig.rpc('work.messages.send', { workspaceId: 'ws-cosmic', chatId: 'c-dana', text: 'On it.', attempt, ...extra })
const read = (attempt: string, workspaceId = 'ws-cosmic') => t.rig.rpc('work.messages.attempt', { workspaceId, attempt })

beforeAll(async () => {
  await loadWorkModules()
})
beforeEach(async () => {
  t = await makeChatRig()
  t.chats.chat({ _id: 'c-dana', name: 'Dana Lee', lastAt: Date.UTC(2026, 10, 20, 15), lastText: 'Can you look at the build?' })
  t.chats.chat({ _id: 'c-ops', name: '#ops', kind: 'channel', lastAt: Date.UTC(2026, 10, 20, 14), lastText: 'Deploy at 3' })
})
afterEach(async () => {
  await t.rig.close()
})

describe('his Send by its attempt key', () => {
  it('sent twice with one key, one after the other: LifeOS hears it once and both get the first answer', async () => {
    const first = await send('phone-attempt-1')
    expect(first).toEqual({ id: expect.stringMatching(/^out_/) })
    expect(await send('phone-attempt-1')).toEqual(first)
    expect(t.chats.replies).toHaveLength(1)
    // A new key is a new press.
    expect(await send('phone-attempt-2')).not.toEqual(first)
    expect(t.chats.replies).toHaveLength(2)
  })

  it('a double tap that reaches the host at once: the second waits on the first and nothing goes twice', async () => {
    const [a, b] = await Promise.all([send('phone-attempt-1'), send('phone-attempt-1')])
    expect(a).toEqual(b)
    expect(t.chats.replies).toHaveLength(1)
  })

  it('a lost answer read back by the same key: sent, with its id, and the read sends nothing', async () => {
    const sent = (await send('phone-attempt-1')) as { id: string }
    // The answer never reached the phone; on the next link it asks.
    expect(await read('phone-attempt-1')).toEqual({ state: 'sent', id: sent.id })
    expect(await read('phone-attempt-1')).toEqual({ state: 'sent', id: sent.id })
    expect(t.chats.replies).toHaveLength(1)
  })

  it('a key the host never heard reads none, and reading it sends nothing', async () => {
    expect(await read('phone-attempt-9')).toEqual({ state: 'none' })
    expect(t.chats.replies).toEqual([])
    expect(t.chats.calls.filter((c) => c.fn === 'chats:reply')).toEqual([])
  })

  it("LifeOS's refusal is the first answer: a repeat says it again and asks LifeOS nothing", async () => {
    t.chats.refuseNext = FakeChats.refusal("LifeOS can't reply in discord yet")
    await expect(send('phone-attempt-1')).rejects.toThrow(/^LifeOS can't reply in discord yet$/)
    const asked = t.chats.calls.filter((c) => c.fn === 'chats:reply').length
    await expect(send('phone-attempt-1')).rejects.toThrow(/^LifeOS can't reply in discord yet$/)
    expect(t.chats.calls.filter((c) => c.fn === 'chats:reply')).toHaveLength(asked)
    expect(await read('phone-attempt-1')).toEqual({ state: 'refused', words: "LifeOS can't reply in discord yet" })
  })

  it('may have gone stays may have gone: a repeat never sends it again', async () => {
    t.chats.refuseNext = new Error('socket hang up')
    await expect(send('phone-attempt-1')).rejects.toThrow(/^It may have gone: socket hang up$/)
    await expect(send('phone-attempt-1')).rejects.toThrow(/^It may have gone: socket hang up$/)
    expect(t.chats.replies).toEqual([])
    expect(await read('phone-attempt-1')).toEqual({ state: 'unknown', words: 'It may have gone: socket hang up' })
  })

  it('a key cut off by a restart of the host reads unknown and is never sent again', async () => {
    t.rig.work.ctx.db
      .prepare('INSERT INTO work_messages_attempts (attempt, workspace_id, chat_id, state, answer, at) VALUES (?, ?, ?, ?, NULL, ?)')
      .run('phone-attempt-1', 'ws-cosmic', 'c-dana', 'sending', Date.now())
    expect(await read('phone-attempt-1')).toEqual({ state: 'unknown', words: ATTEMPT_CUT })
    await expect(send('phone-attempt-1')).rejects.toThrow(ATTEMPT_CUT)
    expect(t.chats.replies).toEqual([])
  })

  it('a key reused for another conversation is refused and says nothing of the first', async () => {
    await send('phone-attempt-1')
    await expect(send('phone-attempt-1', { chatId: 'c-ops' })).rejects.toThrow(ATTEMPT_OTHER)
    expect(t.chats.replies).toHaveLength(1)
    // Another job's read of the key knows nothing of it.
    expect(await read('phone-attempt-1', 'ws-hypixel')).toEqual({ state: 'none' })
  })

  it('a key is kept a day, then forgotten', async () => {
    const db = t.rig.work.ctx.db
    let sends = 0
    const once = () => sendOnce(db, { workspaceId: 'ws-cosmic', chatId: 'c-dana', attempt: 'phone-attempt-1' }, async () => ({ id: `out_${++sends}` }), 1_000)
    expect(await once()).toEqual({ id: 'out_1' })
    expect(attemptOf(db, { workspaceId: 'ws-cosmic', attempt: 'phone-attempt-1' }, 1_000 + ATTEMPT_KEPT_MS - 1)).toEqual({ state: 'sent', id: 'out_1' })
    expect(attemptOf(db, { workspaceId: 'ws-cosmic', attempt: 'phone-attempt-1' }, 1_000 + ATTEMPT_KEPT_MS + 1)).toEqual({ state: 'none' })
  })

  it("a phone key past the day is unknown when read and refused when repeated, never 'never heard' or sent anew", async () => {
    const db = t.rig.work.ctx.db
    const made = 5_000_000_000_000
    const key = `phone-${made}-0b3c9a50-0000-4000-8000-000000000001`
    let sends = 0
    expect(await sendOnce(db, { workspaceId: 'ws-cosmic', chatId: 'c-dana', attempt: key }, async () => ({ id: `out_${++sends}` }), made)).toEqual({ id: 'out_1' })
    const later = made + ATTEMPT_KEPT_MS + 1
    expect(attemptOf(db, { workspaceId: 'ws-cosmic', attempt: key }, later)).toEqual({ state: 'unknown', words: ATTEMPT_EXPIRED })
    await expect(sendOnce(db, { workspaceId: 'ws-cosmic', chatId: 'c-dana', attempt: key }, async () => ({ id: `out_${++sends}` }), later)).rejects.toThrow(ATTEMPT_EXPIRED)
    expect(sends).toBe(1)
  })

  it('a Send with no key works as before, and a workspace removed takes its keys', async () => {
    await t.rig.rpc('work.messages.send', { workspaceId: 'ws-cosmic', chatId: 'c-dana', text: 'x' })
    await t.rig.rpc('work.messages.send', { workspaceId: 'ws-cosmic', chatId: 'c-dana', text: 'x' })
    expect(t.chats.replies).toHaveLength(2)
    await send('phone-attempt-1')
    messages.workspaceRemoved!('ws-cosmic', t.rig.work.ctx)
    expect(t.rig.work.ctx.db.prepare('SELECT COUNT(*) AS n FROM work_messages_attempts').get()).toEqual({ n: 0 })
  })

  it("the read is a person's with approve: a thread and a read key are refused", async () => {
    const model = { kind: 'model' as const, caps: ['read', 'operate', 'approve', 'admin'], sessionId: 't-cosmic' }
    await expect(messages.handle!({ id: '1', method: 'work.messages.attempt', params: { workspaceId: 'ws-cosmic', attempt: 'phone-attempt-1' } } as never, t.rig.work.ctx, model)).rejects.toThrow(NOT_A_PERSON)
    await expect(t.rig.rpc('work.messages.attempt', { workspaceId: 'ws-cosmic', attempt: 'phone-attempt-1' }, readKey)).rejects.toThrow()
    await expect(read('phone-attempt-1', 'ws-code')).rejects.toThrow()
  })
})
