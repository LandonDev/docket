import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { OutboxItem, OutboxRequest } from '@shared/contract-work-outbox'
import type { SessionMeta } from '@shared/events'
import { NOT_HIS } from '@shared/work/outboxAsk'
import type { ActKindDef, WorkModule } from '../modules'
import { outbox as outboxModule, NOT_A_PERSON } from './index'
import { outboxHostOf } from './ctx'
import { approveKey, cast, makeRig, readKey, type Rig } from './rig'
import { ASK_ANSWERED, ASK_OTHER_JOB, BAD_RECEIPT, REQUEST_TTL_MS } from './requests'

/**
 * A thread asks for his press (docs/agents/work-outbox.md "A thread asks for his press"): only on his own words in
 * that thread, only for the items they name, and only his press on the card releases any of them, each as he saw it.
 */

let rig: Rig
let sent: { chat: string; text: string }[]
let pillar: WorkModule
const signal = new AbortController().signal

beforeEach(async () => {
  sent = []
  const kind: ActKindDef<{ chat: string; text: string }, never> = {
    kind: 'teams.post',
    store: 'host',
    payload: z.object({ chat: z.string(), text: z.string() }),
    words: (p) => ({ summary: `Post in ${p.chat}`, verb: 'Post' }),
    execute: async (p) => {
      sent.push(p)
      return { summary: `Posted in ${p.chat}` }
    }
  }
  pillar = { id: 'browser', ensure() {}, acts: [kind as unknown as ActKindDef] }
  rig = await makeRig({ modules: [outboxModule, pillar] })
  const { WORK_MODULES } = await import('../modules')
  WORK_MODULES.push(pillar)
  cast(rig)
})
afterEach(async () => {
  const { WORK_MODULES } = await import('../modules')
  WORK_MODULES.splice(WORK_MODULES.indexOf(pillar), 1)
  await rig.close()
})

const post = (chat: string, sessionId = 't-work'): OutboxItem => rig.work.ctx.held.create({ kind: 'teams.post', sessionId, payload: { chat, text: `to ${chat}` } }) as OutboxItem
const thread = (): SessionMeta => rig.sessions.get('t-work')!
const call = (tool: string, args: unknown, session = thread()) => rig.work.tools.call(session, tool, args, signal)
const text = (r: { content: unknown[] }): string => (r.content as { text?: string }[]).map((c) => c.text ?? '').join('\n')
const asked = (r: { content: unknown[]; structuredContent?: unknown }): string => (r.structuredContent as { outboxRequest: { id: string } }).outboxRequest.id
const card = (id: string, by?: Parameters<Rig['rpc']>[2]) => rig.rpc<OutboxRequest>('work.outbox.request.get', { id }, by)
const press = (id: string, receipts: string[], by?: Parameters<Rig['rpc']>[2]) => rig.rpc<{ request: OutboxRequest }>('work.outbox.decide', { request: id, receipts }, by)

const threeAsked = async (): Promise<{ id: string; items: OutboxItem[] }> => {
  const items = ['Staff', 'Coaches', 'Captains'].map((c) => post(c))
  rig.say('t-work', 'send all three posts')
  const r = await call('outbox_request', { items: items.map((i) => ({ ref: `#${i.n}`, do: 'send' })), quote: 'send all three posts' })
  expect(r.isError, text(r)).toBeUndefined()
  return { id: asked(r), items }
}

describe('a thread asks', () => {
  it('lists what it may ask about, and asks: one card, nothing sent, one notice', async () => {
    const { id } = await threeAsked()
    expect(text(await call('outbox_list', {})).split('\n')[0]).toBe('#1 · Post in Staff · held · this thread')
    expect(sent).toEqual([])
    const r = await card(id)
    expect(r).toMatchObject({ state: 'open', n: 1, head: 'Post 3 messages', quote: 'send all three posts' })
    expect(r.rows.every((row) => !!row.receipt && !row.changed)).toBe(true)
    expect(rig.tells.filter((t) => t.kind === 'outbox.request')).toEqual([expect.objectContaining({ title: 'Asked: Post 3 messages', open: { thread: 't-work' } })])
  })

  it('is refused without his words in this thread: his parent\'s, a thread\'s, the app\'s, an old message and a fourth one back never count', async () => {
    const a = post('Staff')
    const ask = () => call('outbox_request', { items: [{ ref: `#${a.n}`, do: 'send' }], quote: 'send the post to Staff' })
    expect(text(await ask())).toBe(NOT_HIS)
    rig.say('t-work', 'send the post to Staff', { by: { kind: 'thread', sessionId: 't-other' } })
    rig.say('t-work', 'send the post to Staff', { by: { kind: 'app' } })
    rig.say('t-work', 'send the post to Staff', { by: undefined })
    expect(text(await ask())).toBe(NOT_HIS)
    rig.say('t-work', 'send the post to Staff', { at: Date.now() - REQUEST_TTL_MS - 1 })
    expect(text(await ask())).toBe(NOT_HIS)
    rig.say('t-work', 'send the post to Staff')
    for (const n of [1, 2, 3]) rig.say('t-work', `something else ${n}`)
    expect(text(await ask())).toBe(NOT_HIS)
    rig.say('t-work', 'send the post to Staff')
    expect((await ask()).isError).toBeUndefined()
  })

  it('never reaches another job\'s item', async () => {
    rig.workspace('ws-cosmic', { sector: 'cosmic' } as never)
    rig.thread('t-cosmic', { scope: 'work', workspaceId: 'ws-cosmic' } as Partial<SessionMeta>)
    const theirs = post('Devs', 't-cosmic')
    rig.say('t-work', `send #${theirs.n} now please`)
    const r = await call('outbox_request', { items: [{ ref: `#${theirs.n}`, do: 'send' }], quote: `send #${theirs.n} now please` })
    expect(text(r)).toBe(ASK_OTHER_JOB(`#${theirs.n}`))
  })

  it('one message of his gives one request: the same ask again answers it, and after his answer only new words do', async () => {
    const { id } = await threeAsked()
    const again = await call('outbox_request', { items: [1, 2, 3].map((n) => ({ ref: `#${n}`, do: 'send' })), quote: 'send all three posts' })
    expect(asked(again)).toBe(id)
    await rig.rpc('work.outbox.decline', { request: id })
    const after = await call('outbox_request', { items: [1, 2, 3].map((n) => ({ ref: `#${n}`, do: 'send' })), quote: 'send all three posts' })
    expect(text(after)).toBe(ASK_ANSWERED)
    expect(rig.whispers.at(-1)!.text).toBe('The owner chose Not now on request 1. The items still wait in his Outbox. Do not ask again unless he asks.')
  })
})

describe('his press on the card', () => {
  it('sends exactly the ticked rows, each through the normal path, and the thread hears once', async () => {
    const { id, items } = await threeAsked()
    const r = await card(id)
    const ticked = r.rows.slice(0, 2).map((row) => row.receipt!)
    const { request } = await press(id, ticked)
    expect(request.state).toBe('answered')
    expect(sent.map((s) => s.chat)).toEqual(['Staff', 'Coaches'])
    expect(outboxHostOf(rig.work.ctx)!.store.byRef(items[2]!.ref)!.state).toBe('held')
    expect(outboxHostOf(rig.work.ctx)!.store.byRef(items[0]!.ref)).toMatchObject({ via: `request:${id}`, decidedBy: 'owner' })
    // one note for the whole press, none per item
    expect(rig.whispers.map((w) => w.text)).toEqual(['The owner approved request 1: sent 2, 1 left out. Do not send any of them another way.'])
    // a second press, another device: nothing runs again
    await press(id, ticked, approveKey)
    expect(sent).toHaveLength(2)
  })

  it('refuses a receipt it did not issue, a ref or action swapped in, and widening', async () => {
    const { id } = await threeAsked()
    await card(id)
    await expect(press(id, ['rc_forged'])).rejects.toThrow(BAD_RECEIPT)
    await expect(rig.rpc('work.outbox.decide', { request: id, receipts: ['x'], items: [{ ref: { at: 'host', id: 'ha_x' }, do: 'send' }] })).rejects.toThrow(/names its receipts/)
    expect(sent).toEqual([])
  })

  it('a row that changed since the ask starts with no receipt; opening it gives a fresh one at what he sees', async () => {
    const { id, items } = await threeAsked()
    const store = outboxHostOf(rig.work.ctx)!.store
    store.edit((items[0]!.ref as { id: string }).id, { payload: { chat: 'Staff', text: 'rewritten' }, summary: 'Post in Staff', verb: 'Post' })
    const r = await card(id)
    expect(r.rows[0]).toMatchObject({ changed: true })
    expect(r.rows[0]!.receipt).toBeUndefined()
    const fresh = await rig.rpc<{ receipt: string }>('work.outbox.request.view', { id, ref: items[0]!.ref })
    await press(id, [fresh.receipt])
    expect(sent).toEqual([{ chat: 'Staff', text: 'rewritten' }])
  })

  it('a receipt drawn before a change is refused at the claim: what goes is what he saw', async () => {
    const { id, items } = await threeAsked()
    const r = await card(id)
    outboxHostOf(rig.work.ctx)!.store.edit((items[0]!.ref as { id: string }).id, { payload: { chat: 'Staff', text: 'moved' }, summary: 'Post in Staff', verb: 'Post' })
    const { request } = await press(id, [r.rows[0]!.receipt!])
    expect(request.rows[0]!.result).toMatchObject({ ok: false })
    expect(sent).toEqual([])
  })

  it('only a person with approve answers: a thread, a read key and an MCP key cannot', async () => {
    const { id } = await threeAsked()
    const r = await card(id)
    const req = { id: '1', method: 'work.outbox.decide', params: { request: id, receipts: [r.rows[0]!.receipt!] } } as never
    for (const by of [{ kind: 'model', caps: ['approve'], sessionId: 't-work' }, { kind: 'remote', caps: ['read', 'approve'], audience: 'mcp' }])
      await expect(outboxModule.handle!(req, rig.work.ctx, by as never)).rejects.toThrow(NOT_A_PERSON)
    await expect(card(id, readKey)).rejects.toThrow()
    expect(sent).toEqual([])
    await press(id, [r.rows[0]!.receipt!], approveKey)
    expect(outboxHostOf(rig.work.ctx)!.store.byRef(r.rows[0]!.ref)).toMatchObject({ decidedBy: 'owner:remote' })
  })

  it('a declined, void or expired request sends nothing', async () => {
    const { id } = await threeAsked()
    const r = await card(id)
    await rig.rpc('work.outbox.decline', { request: id })
    expect((await press(id, [r.rows[0]!.receipt!])).request.state).toBe('declined')
    expect(sent).toEqual([])
  })

  it('a newer request voids the open one, and a removed thread ends its requests', async () => {
    const { id } = await threeAsked()
    rig.say('t-work', 'send the post to Staff')
    await call('outbox_request', { items: [{ ref: '#1', do: 'send' }], quote: 'send the post to Staff' })
    expect((await card(id)).state).toBe('void')
    const open = await rig.rpc<{ requests: OutboxRequest[] }>('work.outbox.requests', {})
    expect(open.requests).toHaveLength(1)
    outboxModule.sessionsRemoved!(['t-work'], rig.work.ctx)
    expect((await rig.rpc<{ requests: OutboxRequest[] }>('work.outbox.requests', {})).requests).toEqual([])
  })

  it.each([
    ['Work', (k: string) => k === 'work'],
    ['Code', (k: string) => k === 'code'],
    ['both', () => true]
  ])('stays open while Away is on for %s, and across the flips: no part of Away answers it', async (_name, on) => {
    rig.away.on = on as never
    rig.away.enabled = true
    const { id } = await threeAsked()
    await new Promise((r) => setTimeout(r, 30))
    rig.away.enabled = false
    rig.away.on = () => false
    rig.away.enabled = true
    await new Promise((r) => setTimeout(r, 30))
    expect((await card(id)).state).toBe('open')
    expect(rig.cards).toEqual([])
    expect(sent).toEqual([])
  })
})
