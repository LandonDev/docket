import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { DecisionResult, OutboxItem } from '@shared/contract-work-outbox'
import type { ActKindDef, WorkModule } from '../modules'
import { outbox as outboxModule } from './index'
import { outboxHostOf } from './ctx'
import { BAD_TIME, ON_ITS_WAY } from './outbox'
import { cast, makeRig, type Rig } from './rig'
import { MISSED, MISSED_MS } from './store'

/**
 * Send later (docs/agents/work-outbox.md "Send later"): his press with a time. The host keeps the time; a held
 * LifeOS mail goes to LifeOS with it, its only timer; any other kind that may wait is run by the host's one timer on
 * its own claim, with its checks made again at its time, never late after an outage.
 */

let rig: Rig
let sent: unknown[]
let pillar: WorkModule
const settled = () => new Promise((r) => setTimeout(r, 15))
const decide = (items: unknown[]) => rig.rpc<{ results: DecisionResult[] }>('work.outbox.decide', { items })
const HOUR = 3_600_000

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
  await settled()
})
afterEach(async () => {
  const { WORK_MODULES } = await import('../modules')
  WORK_MODULES.splice(WORK_MODULES.indexOf(pillar), 1)
  await rig.close()
})

/** Every scheduled row's time moved to `at`, as if the clock had gone on. */
const pastDue = (at: number): void => void rig.work.ctx.db.prepare(`UPDATE work_held_acts SET schedule_at = ? WHERE state = 'scheduled'`).run(at)

const post = (text = 'hi'): OutboxItem => rig.work.ctx.held.create({ kind: 'teams.post', sessionId: 't-work', payload: { chat: 'Staff', text } }) as OutboxItem

describe('Send later on the host timer', () => {
  it('is offered only for a kind that may wait, and waits, uncounted, in the Scheduled list until its time', async () => {
    const item = post()
    const [listed] = (await rig.rpc<{ items: OutboxItem[] }>('work.outbox.list')).items
    expect(listed!.later).toBe(true)
    const at = Date.now() + HOUR
    const { results } = await decide([{ ref: item.ref, do: 'later', at, zone: 'America/Chicago', rev: listed!.updatedAt }])
    expect(results[0]).toMatchObject({ ok: true, item: { state: 'scheduled', scheduledFor: at, scheduledZone: 'America/Chicago' } })
    const { items, waiting } = await rig.rpc<{ items: OutboxItem[]; waiting: number }>('work.outbox.list')
    expect(items.map((i) => i.state)).toEqual(['scheduled'])
    expect(waiting).toBe(0)
    expect(sent).toEqual([])
  })

  it('refuses a time too soon or too far, and a kind that cannot wait', async () => {
    const item = post()
    expect((await decide([{ ref: item.ref, do: 'later', at: Date.now() + 5_000 }])).results[0]!.error).toBe(BAD_TIME)
    const slack = await rig.addon('slack', 'ws-purdue')
    await rig.claudeCall('t-work', slack.id, 'echo', { text: 'x' })
    const echo = (await rig.waiting()).find((i) => i.kind === 'addon.call')!
    expect(echo.later).toBeUndefined()
    expect((await decide([{ ref: echo.ref, do: 'later', at: Date.now() + HOUR }])).results[0]!.error).toBe('This cannot be sent later.')
  })

  it('goes once at its time through its own claim; a Cancel send in between wins', async () => {
    const a = post('a')
    const b = post('b')
    const at = Date.now() + 2 * 60_000
    await decide([{ ref: a.ref, do: 'later', at }, { ref: b.ref, do: 'later', at }])
    await rig.rpc('work.outbox.cancelSend', { ref: b.ref })
    const host = outboxHostOf(rig.work.ctx)!
    // its time came: the timer's own run
    pastDue(Date.now() - 1_000)
    await (host.outbox as unknown as { due(): Promise<void> }).due()
    expect(sent).toEqual([{ chat: 'Staff', text: 'a' }])
    expect(host.store.byRef(a.ref)).toMatchObject({ state: 'sent', via: 'scheduled' })
    expect(host.store.byRef(b.ref)).toMatchObject({ state: 'held' })
    // a second run finds nothing due
    await (host.outbox as unknown as { due(): Promise<void> }).due()
    expect(sent).toHaveLength(1)
  })

  it('Cancel send and Send now from an older view are refused', async () => {
    const a = post('a')
    const { results } = await decide([{ ref: a.ref, do: 'later', at: Date.now() + HOUR }])
    const seen = results[0]!.item!.updatedAt
    outboxHostOf(rig.work.ctx)!.store.reschedule((a.ref as { id: string }).id, Date.now() + 2 * HOUR, null)
    await expect(rig.rpc('work.outbox.sendNow', { ref: a.ref, rev: seen })).rejects.toThrow(/changed since/)
    await expect(rig.rpc('work.outbox.cancelSend', { ref: a.ref, rev: seen })).rejects.toThrow(/changed since/)
    expect(sent).toEqual([])
  })

  it('Work turned off in the middle of a due batch claims no more of it', async () => {
    const a = post('a')
    const b = post('b')
    await decide([{ ref: a.ref, do: 'later', at: Date.now() + 2 * 60_000 }, { ref: b.ref, do: 'later', at: Date.now() + 2 * 60_000 }])
    pastDue(Date.now() - 1_000)
    const outbox = outboxHostOf(rig.work.ctx)!.outbox as unknown as { due(): Promise<void>; startSchedules(): () => void }
    const stop = outbox.startSchedules()
    stop()
    await outbox.due()
    expect(sent).toEqual([])
  })

  it('Send now goes at once on the same claim', async () => {
    const a = post('a')
    await decide([{ ref: a.ref, do: 'later', at: Date.now() + HOUR }])
    expect(await rig.rpc<OutboxItem>('work.outbox.sendNow', { ref: a.ref })).toMatchObject({ state: 'sent' })
    expect(sent).toHaveLength(1)
  })

  it('a time missed while the host was off goes back to him, never out late', async () => {
    const a = post('a')
    await decide([{ ref: a.ref, do: 'later', at: Date.now() + 2 * 60_000 }])
    const host = outboxHostOf(rig.work.ctx)!
    pastDue(Date.now() - MISSED_MS - 60_000)
    expect(host.store.recover().missed).toBe(1)
    expect(host.store.byRef(a.ref)).toMatchObject({ state: 'held', error: MISSED })
    expect(sent).toEqual([])
  })

  it('removing its thread settles it', async () => {
    const a = post('a')
    await decide([{ ref: a.ref, do: 'later', at: Date.now() + HOUR }])
    outboxHostOf(rig.work.ctx)!.store.closeSessions(['t-work'], 'gone')
    expect(outboxHostOf(rig.work.ctx)!.store.byRef(a.ref)).toMatchObject({ state: 'stale' })
  })
})

describe('Send later for a mail LifeOS holds', () => {
  const draft = async (): Promise<OutboxItem> => {
    rig.lifeos.draft({ subject: 'Re: roster' })
    rig.lifeos.fire()
    await settled()
    return (await rig.waiting()).find((i) => i.kind === 'mail.send')!
  }

  it('goes to LifeOS with his time through the hold, and the thread hears it and the task completes once it went', async () => {
    const item = await draft()
    expect(item.later).toBe(true)
    const at = Date.now() + HOUR
    const { results } = await decide([{ ref: item.ref, do: 'later', at, zone: 'America/Chicago', rev: item.updatedAt }])
    expect(results[0]).toMatchObject({ ok: true, item: { state: 'scheduled', scheduledFor: at } })
    const send = rig.lifeos.calls.find((c) => c.fn === 'compose:send')!
    expect(send.args).toMatchObject({ cause: 'press', sendAt: at, sendZone: 'America/Chicago' })
    expect(rig.whispers).toEqual([])
    // LifeOS's own timer sends it
    rig.lifeos.deliver((item.ref as { id: string }).id)
    await settled()
    await settled()
    const row = outboxHostOf(rig.work.ctx)!.store.byRef(item.ref)!
    expect(row.state).toBe('sent')
    expect(rig.whispers.filter((w) => /queued held item/.test(w.text))).toHaveLength(1)
  })

  it('Cancel send puts it back only once LifeOS took it back; Mail\'s own cancel is the same verb', async () => {
    const item = await draft()
    await decide([{ ref: item.ref, do: 'later', at: Date.now() + HOUR, rev: item.updatedAt }])
    expect(await rig.rpc<OutboxItem>('work.outbox.cancelSend', { ref: item.ref })).toMatchObject({ state: 'held' })
    await settled()
    const again = (await rig.waiting()).find((i) => i.kind === 'mail.send')!
    await decide([{ ref: again.ref, do: 'later', at: Date.now() + HOUR, rev: again.updatedAt }])
    // LifeOS already sent it: the cancel is refused and the row stays as it is
    const id = (item.ref as { id: string }).id
    rig.lifeos.rows.get(id)!.status = 'sent'
    await expect(rig.rpc('work.outbox.cancelSend', { ref: item.ref })).rejects.toThrow(ON_ITS_WAY)
    expect(outboxHostOf(rig.work.ctx)!.store.byRef(item.ref)!.state).toBe('scheduled')
  })

  it('removing its thread takes the time back from LifeOS before the row is put away; unreachable, it asks again', async () => {
    const item = await draft()
    await decide([{ ref: item.ref, do: 'later', at: Date.now() + HOUR, rev: item.updatedAt }])
    const id = (item.ref as { id: string }).id
    rig.lifeos.connected = false
    outboxModule.sessionsRemoved!(['t-work'], rig.work.ctx)
    await settled()
    const store = outboxHostOf(rig.work.ctx)!.store
    expect(store.byRef(item.ref)).toMatchObject({ state: 'scheduled', cancelWanted: true })
    rig.lifeos.connected = true
    rig.lifeos.fire()
    await settled()
    await settled()
    expect(store.byRef(item.ref)).toMatchObject({ state: 'stale', dismissedBy: 'host' })
    expect(rig.lifeos.rows.get(id)!.status).toBe('draft')
  })

  it('a listing read before his Send later never puts the row back: only a fresh read does', async () => {
    const item = await draft()
    await decide([{ ref: item.ref, do: 'later', at: Date.now() + HOUR, rev: item.updatedAt }])
    // the watcher's list as it stood before the time was set
    const lifeos = outboxHostOf(rig.work.ctx)!.outbox.lifeos as unknown as { settleScheduled(items: OutboxItem[]): Promise<void> }
    await lifeos.settleScheduled([{ ...item, scheduledFor: undefined } as OutboxItem])
    expect(outboxHostOf(rig.work.ctx)!.store.byRef(item.ref)!.state).toBe('scheduled')
  })

  it('LifeOS not taking the time puts the row back with why', async () => {
    const item = await draft()
    rig.lifeos.failNext.set('compose:send', 'LifeOS is down')
    const { results } = await decide([{ ref: item.ref, do: 'later', at: Date.now() + HOUR, rev: item.updatedAt }])
    expect(results[0]).toMatchObject({ ok: false, error: 'LifeOS is down' })
    expect(outboxHostOf(rig.work.ctx)!.store.byRef(item.ref)).toMatchObject({ state: 'held', error: 'LifeOS did not take the time: LifeOS is down' })
  })

  it('Undo takes a mail back in its undo time; once it went, Undo answers no', async () => {
    const item = await draft()
    await rig.rpc('work.outbox.send', { ref: item.ref, rev: item.updatedAt })
    const back = await rig.rpc<{ back: boolean; item?: OutboxItem }>('work.outbox.undoSend', { ref: item.ref })
    expect(back).toMatchObject({ back: true, item: { state: 'held' } })
    expect(rig.whispers.at(-1)!.text).toMatch(/^The owner took back held item \d+ \(.*\) before it went\./)
    await settled()
    const again = (await rig.waiting()).find((i) => i.kind === 'mail.send')!
    await rig.rpc('work.outbox.send', { ref: again.ref, rev: again.updatedAt })
    rig.lifeos.deliver((item.ref as { id: string }).id)
    expect(await rig.rpc('work.outbox.undoSend', { ref: item.ref })).toEqual({ back: false })
  })
})
