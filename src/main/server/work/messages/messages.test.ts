import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { MessagesPush } from '@shared/contract-work-messages'
import { loadWorkModules, PILLAR_LOADERS } from '../modules'
import { readKey } from '../outbox/rig'
import { chatRows, chatSourceRow, type ChatSourceRow } from './health'
import { messages } from './index'
import { NOT_WORK, refusalWords } from './lifeos'
import { FakeChats } from './fakeChats'
import { makeChatRig, type ChatRig } from './testRig'

/**
 * The messages pillar's reads (docs/agents/work-messages.md): each fenced to
 * the workspace's sector by hand, whatever LifeOS answers; Connections' rows
 * a chat source; and the unread push, once a change.
 */

let t: ChatRig
const rpc = <T>(method: string, params: unknown, by?: Parameters<ChatRig['rig']['rpc']>[2]) => t.rig.rpc<T>(method, params, by)
const pushes = () => t.rig.pushes.filter((p): p is MessagesPush => p.push === 'work.messages')
const settle = () => new Promise((r) => setTimeout(r, 0))
const watched = () => t.chats.watchers.filter((w) => w.fn === 'chats:unread').map((w) => String(w.args.sector)).sort()

beforeAll(async () => {
  await loadWorkModules()
})
beforeEach(async () => {
  t = await makeChatRig()
})
afterEach(async () => {
  await t.rig.close()
})

describe('the mount', () => {
  it('is loaded by its own import and makes its table twice over without a fault', async () => {
    expect(await PILLAR_LOADERS.messages()).toBe(messages)
    const db = new DatabaseSync(':memory:')
    messages.ensure(db)
    messages.ensure(db)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'work_messages_%' ORDER BY name").all().map((r) => (r as { name: string }).name)).toEqual([
      'work_messages_drafts',
      'work_messages_drafts_chat'
    ])
  })
})

describe('the fence on each read', () => {
  for (const [method, extra] of [
    ['work.messages.search', { query: 'build' }],
    ['work.messages.unanswered', {}],
    ['work.messages.unread', {}]
  ] as const) {
    it(`${method} refuses a code workspace, a Work workspace with no sector and one that does not exist, asking LifeOS nothing`, async () => {
      for (const workspaceId of ['ws-code', 'ws-nosector', 'ws-gone']) await expect(rpc(method, { workspaceId, ...extra })).rejects.toThrow(NOT_WORK)
      expect(t.chats.calls).toEqual([])
    })
  }

  it('asks LifeOS for the sector alone and drops a hit it answered from another', async () => {
    t.chats.leaky = true
    t.chats.hits = [
      { chatId: 'c1', messageId: 'm1', chat: '#builds', who: 'Dana Lee', text: 'The build is green', at: 3, source: 'slack', sector: 'cosmic' },
      { chatId: 'c2', messageId: 'm2', chat: 'Omar Reyes', who: 'Omar Reyes', text: 'The build cut is up', at: 2, source: 'discord', sector: 'hypixel' }
    ]
    const answer = await rpc<{ hits: unknown[] }>('work.messages.search', { workspaceId: 'ws-cosmic', query: 'build' }, readKey)
    expect(answer).toEqual({ hits: [{ chatId: 'c1', messageId: 'm1', chat: '#builds', who: 'Dana Lee', text: 'The build is green', at: 3, source: 'slack' }] })
    expect(t.chats.calls.at(-1)).toEqual({ fn: 'chats:search', args: { sector: 'cosmic', text: 'build' } })
  })

  it('lists the unanswered of the sector alone, as Today reads them', async () => {
    t.chats.leaky = true
    t.chats.chat({ _id: 'c1', name: 'Dana Lee', lastText: 'Can you look?', lastWho: 'Dana Lee', lastAt: 20, lastInAt: 20 })
    t.chats.chat({ _id: 'c2', name: 'Omar Reyes', sector: 'hypixel', lastAt: 30, lastInAt: 30 })
    t.chats.chat({ _id: 'c3', name: '#builds', kind: 'channel', unread: false })
    expect(await rpc('work.messages.unanswered', { workspaceId: 'ws-cosmic' })).toEqual({
      rows: [{ chatId: 'c1', chat: 'Dana Lee', who: 'Dana Lee', text: 'Can you look?', at: 20, source: 'slack' }]
    })
  })

  it('answers the unread count and when the newest came', async () => {
    t.chats.chat({ lastAt: 50 })
    t.chats.chat({ lastAt: 70 })
    t.chats.chat({ sector: 'hypixel', lastAt: 90 })
    expect(await rpc('work.messages.unread', { workspaceId: 'ws-cosmic' })).toEqual({ unread: 2, newest: 70 })
    expect(await rpc('work.messages.unread', { workspaceId: 'ws-hypixel' })).toEqual({ unread: 1, newest: 90 })
  })
})

describe("LifeOS's refusals", () => {
  it('are its own words: a sentence, a coded message, or the first line of anything else', () => {
    expect(refusalWords(FakeChats.refusal("LifeOS can't reply in discord yet"))).toBe("LifeOS can't reply in discord yet")
    expect(refusalWords(FakeChats.refusal({ code: 'mac-offline', message: "Your Mac isn't running LifeOS" }))).toBe("Your Mac isn't running LifeOS")
    expect(refusalWords(new Error('fetch failed\n    at x'))).toBe('fetch failed')
  })
})

describe("Connections' rows", () => {
  const now = new Date(2026, 10, 23, 15, 0).getTime()
  const linked = new Set(['cosmic', 'hypixel'])
  const src = (over: Partial<ChatSourceRow>): ChatSourceRow => ({ _id: 's1', kind: 'slack', account: 'T01', label: 'CosmicGames', sector: 'cosmic', enabled: true, status: 'ok', lastSyncAt: now - 60_000, ...over })

  it('says a fresh source works, under Chat, shared and in its sector', () => {
    expect(chatSourceRow(src({}), linked, now)).toEqual({
      id: 'messages.source:s1',
      pillar: 'messages',
      group: 'Chat',
      title: 'CosmicGames Slack',
      shared: true,
      sector: 'cosmic',
      state: 'working',
      line: 'Synced 2:59 PM'
    })
  })

  it('holds each kind to its own limit: Slack and Discord fifteen minutes, iMessage and Teams a day and a half', () => {
    expect(chatSourceRow(src({ lastSyncAt: now - 16 * 60_000 }), linked, now)).toMatchObject({ state: 'broken', line: 'No sync since 2:44 PM' })
    expect(chatSourceRow(src({ kind: 'discord', label: 'Hypixel Discord', lastSyncAt: new Date(2026, 10, 3, 9).getTime() }), linked, now)).toMatchObject({
      title: 'Hypixel Discord',
      state: 'broken',
      line: 'No sync since Nov 3'
    })
    expect(chatSourceRow(src({ kind: 'teams', label: '', account: 'pc', lastSyncAt: undefined, reportedAt: now - 20 * 3_600_000 }), linked, now)).toMatchObject({ title: 'pc Teams', state: 'working' })
    expect(chatSourceRow(src({ kind: 'imessage', label: 'Messages', lastSyncAt: now - 40 * 3_600_000 }), linked, now)).toMatchObject({ title: 'Messages iMessage', state: 'broken' })
    expect(chatSourceRow(src({ lastSyncAt: undefined }), linked, now)).toMatchObject({ state: 'broken', line: 'Never synced' })
  })

  it('says an error in its redacted words, and a source LifeOS stopped reading needs him', () => {
    expect(chatSourceRow(src({ status: 'error', error: 'token lob_abcdefghijklmnop was refused' }), linked, now)).toMatchObject({ state: 'broken', line: expect.not.stringContaining('lob_abcdefghijklmnop') })
    expect(chatSourceRow(src({ status: 'error' }), linked, now)).toMatchObject({ state: 'broken', line: 'The last sync failed' })
    expect(chatSourceRow(src({ status: 'idle', error: 'The bot was removed' }), linked, now)).toMatchObject({ state: 'needs-you', line: 'Stopped in LifeOS: The bot was removed' })
  })

  it('has no row for a source turned off, a mail source, or a chat of a sector no Work workspace links', () => {
    expect(chatSourceRow(src({ enabled: false }), linked, now)).toBeNull()
    expect(chatSourceRow(src({ kind: 'email' }), linked, now)).toBeNull()
    expect(chatSourceRow(src({ sector: 'purdue' }), linked, now)).toBeNull()
    expect(chatSourceRow(src({ sector: undefined }), linked, now)).toBeNull()
  })

  it("reads sources:list for this host's linked sectors, one broken row when it fails, nothing while signed out", async () => {
    t.chats.sources = [src({ _id: 'a' }), src({ _id: 'b', sector: 'purdue' }), src({ _id: 'c', kind: 'email', label: 'Mail' })]
    expect((await chatRows(t.rig.work.ctx, now)).map((r) => r.id)).toEqual(['messages.source:a'])
    t.chats.sources = null as never
    t.chats.query = (() => Promise.reject(new Error('fetch failed'))) as never
    expect(await chatRows(t.rig.work.ctx, now)).toEqual([{ id: 'messages.sources', pillar: 'messages', group: 'Chat', title: 'Chat', state: 'broken', line: 'LifeOS did not list them: fetch failed' }])
    t.chats.connected = false
    expect(await chatRows(t.rig.work.ctx, now)).toEqual([])
  })

  it('shows in work.health with the other pillars', async () => {
    t.chats.sources = [src({ _id: 'a', lastSyncAt: Date.now() })]
    const report = await rpc<{ rows: { id: string; state: string }[] }>('work.health', {})
    expect(report.rows.filter((r) => r.id.startsWith('messages.'))).toEqual([expect.objectContaining({ id: 'messages.source:a', state: 'working' })])
  })
})

describe('the unread push', () => {
  it('fires once a change, for each linked workspace, and never for the same count again', async () => {
    await settle()
    expect(pushes()).toEqual([
      { push: 'work.messages', workspaceId: 'ws-cosmic', unread: 0 },
      { push: 'work.messages', workspaceId: 'ws-hypixel', unread: 0 }
    ])
    t.chats.fire()
    expect(pushes()).toHaveLength(2)
    t.chats.chat({ _id: 'c1' })
    t.chats.chat({ _id: 'c2' })
    t.chats.fire()
    t.chats.fire()
    expect(pushes().slice(2)).toEqual([{ push: 'work.messages', workspaceId: 'ws-cosmic', unread: 2 }])
    t.chats.chats.get('c1')!.unread = false
    t.chats.chats.get('c2')!.unread = false
    t.chats.fire()
    expect(pushes().slice(3)).toEqual([{ push: 'work.messages', workspaceId: 'ws-cosmic', unread: 0 }])
  })

  it('watches nothing of a code workspace or one with no sector', () => {
    expect(watched()).toEqual(['cosmic', 'hypixel'])
  })

  it('follows a workspace made and one deleted', async () => {
    await settle()
    t.workspace('ws-ref', { kind: 'work', sector: 'ref' } as never)
    messages.workspaceCreated!('ws-ref', t.rig.work.ctx)
    expect(watched()).toEqual(['cosmic', 'hypixel', 'ref'])
    messages.workspaceRemoved!('ws-hypixel', t.rig.work.ctx)
    expect(watched()).toEqual(['cosmic', 'ref'])
    t.chats.chat({ sector: 'hypixel' })
    t.chats.fire()
    await settle()
    expect(pushes().filter((p) => p.workspaceId === 'ws-hypixel')).toHaveLength(1)
  })

  it('stops with Work, and starts nothing while it is off', async () => {
    await settle()
    t.rig.work.settings.set({ enabled: false })
    expect(watched()).toEqual([])
    messages.workspaceCreated!('ws-cosmic', t.rig.work.ctx)
    expect(watched()).toEqual([])
  })
})
