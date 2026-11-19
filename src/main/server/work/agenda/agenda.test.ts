import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OutboxItem } from '@shared/contract-work-outbox'
import type { WorkCtx } from '../modules'
import { calendarGrantFits, calendarWords, type CalendarOpPayload } from '../outbox/lifeosHeld'
import { cast, makeRig, type Rig } from '../outbox/rig'
import { ensureAgenda, recordPlain } from './index'

/**
 * Calendar acts LifeOS holds for this host's threads (milestone 24's
 * `calendarOps`), as the hold carries them after milestone 25: in his words
 * with the event's title, read fresh at the press, edited through
 * `calendarOps.save`, granted narrowly, and a plain hold recorded as a Result.
 */

let rig: Rig
const settled = () => new Promise((r) => setTimeout(r, 15))
const list = async () => (await rig.rpc<{ items: OutboxItem[] }>('work.outbox.list')).items.filter((i) => i.kind === 'calendar.op')
const sends = () => rig.lifeos.calls.filter((c) => c.fn === 'calendarOps:send')

beforeEach(async () => {
  rig = await makeRig()
  cast(rig)
  rig.lifeos.missing.clear()
  rig.lifeos.events.set('ev_1', { _id: 'ev_1', title: 'Big Ten league call', startsAt: Date.now() + 86_400_000 })
  await settled()
})
afterEach(async () => {
  await rig.close()
})

describe('a held calendar act', () => {
  it("is listed in his words with the event's title, from this host's watcher", async () => {
    rig.lifeos.calendarOp({ kind: 'accept', eventId: 'ev_1' })
    rig.lifeos.calendarOp({ kind: 'accept', eventId: 'ev_1', host: 'env_mac' })
    rig.lifeos.fire()
    await settled()
    const items = await list()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ summary: 'Accept "Big Ten league call"', verb: 'Send', state: 'held', sessionId: 't-work', account: 'landon@purdue.edu' })
    expect(rig.lifeos.watchers.find((w) => w.fn === 'calendarOps:held')?.args).toEqual({ host: 'env_box' })
    expect(sends()).toEqual([])
  })

  it('goes on his press as LifeOS holds it then, once, and completes the linked task', async () => {
    const id = rig.lifeos.calendarOp({ kind: 'accept', eventId: 'ev_1' })
    rig.lifeos.fire()
    await settled()
    const [item] = await list()
    await rig.rpc('work.outbox.send', { ref: item!.ref, rev: item!.updatedAt })
    await settled()
    expect(sends()).toEqual([{ fn: 'calendarOps:send', args: { id, cause: 'press' } }])
    // the act was read again at the press, not taken from the watcher's copy
    expect(rig.lifeos.calls.some((c) => c.fn === 'calendarOps:get' && c.args.id === id)).toBe(true)
    expect(rig.lifeos.completed.map((c) => c.reason)).toEqual(['Sent: Accept "Big Ten league call"'])
  })

  it('is stale when it changed after it was shown, and goes nowhere twice', async () => {
    const id = rig.lifeos.calendarOp({ kind: 'accept', eventId: 'ev_1' })
    rig.lifeos.fire()
    await settled()
    const def = rig.host.outbox.def('calendar.op')
    const shown = (await list())[0]!.payload as CalendarOpPayload
    const ctx = { ...rig.work.ctx, item: {} as never, decidedBy: 'owner' as const }
    // edited in LifeOS after it was drawn: what he saw is not what would go
    Object.assign(rig.lifeos.ops.get(id)!, { editedAt: Number(shown.editedAt) + 5 })
    await expect(def.execute(shown, ctx)).rejects.toThrow('edited since it was shown')
    // already on its way by another hand: nothing is sent again
    Object.assign(rig.lifeos.ops.get(id)!, { status: 'queued', editedAt: shown.editedAt })
    await def.execute(shown, ctx)
    expect(sends()).toEqual([])
  })

  it("is edited through calendarOps.save, keeping its kind, event and account", async () => {
    const id = rig.lifeos.calendarOp({ kind: 'propose', eventId: 'ev_1', payload: { comment: 'Could we move it?' } })
    rig.lifeos.fire()
    await settled()
    const [item] = await list()
    const payload = { ...(item!.payload as CalendarOpPayload), kind: 'cancel', payload: { comment: 'Thursday works better', proposedStart: 5 } }
    const after = await rig.rpc<OutboxItem>('work.outbox.edit', { ref: item!.ref, payload })
    const save = rig.lifeos.calls.find((c) => c.fn === 'calendarOps:save')
    expect(save?.args).toEqual({ id, kind: 'propose', eventId: 'ev_1', account: 'landon@purdue.edu', payload: { comment: 'Thursday works better', proposedStart: 5 } })
    expect(after.summary).toBe('Propose a new time for "Big Ten league call"')
  })

  it('takes a grant only for its kind, its account and the people it names', () => {
    const invite = (addresses: string[]): CalendarOpPayload => ({ id: 'op', kind: 'create', account: 'landon@purdue.edu', payload: { title: 'Scrim', attendees: addresses.map((address) => ({ address })) } })
    const m = { kind: 'create' as const, account: 'landon@purdue.edu', attendees: ['sam@purdue.edu'] }
    expect(calendarGrantFits(m, invite(['Sam@Purdue.edu']))).toBe(true)
    expect(calendarGrantFits(m, invite(['sam@purdue.edu', 'dana@purdue.edu']))).toBe(false)
    expect(calendarGrantFits({ ...m, account: 'other@gmail.com' }, invite(['sam@purdue.edu']))).toBe(false)
    expect(calendarGrantFits({ ...m, kind: 'cancel' }, invite(['sam@purdue.edu']))).toBe(false)
    expect(calendarGrantFits({ kind: 'accept', account: 'landon@purdue.edu' }, { id: 'op', kind: 'accept', account: 'landon@purdue.edu' })).toBe(true)
  })

  it('reads in his words for every kind', () => {
    const w = (kind: CalendarOpPayload['kind'], extra: Partial<CalendarOpPayload> = {}) => calendarWords({ id: 'op', kind, eventTitle: 'Staff sync', ...extra }).summary
    expect(w('create', { payload: { title: 'Scrim', attendees: [{ address: 'sam@purdue.edu', name: 'Sam Ortiz' }] } })).toBe('Invite Sam Ortiz to "Scrim"')
    expect(w('create', { payload: { title: 'Focus' } })).toBe('Add "Focus" to the calendar')
    expect(w('update')).toBe('Change "Staff sync"')
    expect(w('decline')).toBe('Decline "Staff sync"')
    expect(w('tentative')).toBe('Answer maybe to "Staff sync"')
    expect(w('cancel')).toBe('Cancel "Staff sync"')
  })
})

describe('a plain hold', () => {
  const ctxWith = (added: unknown[]): WorkCtx => {
    const db = new DatabaseSync(':memory:')
    ensureAgenda(db)
    return { db, host: 'env_box', scopeOf: (id: string) => (id === 't-work' ? ({ workspaceId: 'ws', sector: 'purdue' } as never) : null), results: { add: (r: unknown) => void added.push(r) } } as unknown as WorkCtx
  }
  const op = (over: Record<string, unknown> = {}) => ({ _id: 'op_1', kind: 'create', plain: true, status: 'queued', account: 'landon@purdue.edu', payload: { title: 'Focus' }, origin: { host: 'env_box', threadId: 't-work' }, ...over })

  it("is a Result of this host's thread, recorded once", () => {
    const added: unknown[] = []
    const ctx = ctxWith(added)
    expect(recordPlain(ctx, [op()])).toEqual(['op_1'])
    expect(recordPlain(ctx, [op({ status: 'done' })])).toEqual([])
    expect(added).toEqual([{ sessionId: 't-work', kind: 'calendar.op', summary: 'Added "Focus" to the calendar', account: 'landon@purdue.edu', ref: { at: 'lifeos', table: 'calendarOps', id: 'op_1' } }])
  })

  it("is not recorded for a held act, another host's thread, a thread gone, or one that failed", () => {
    const added: unknown[] = []
    const ctx = ctxWith(added)
    recordPlain(ctx, [op({ _id: 'a', plain: undefined, status: 'draft' }), op({ _id: 'b', origin: { host: 'env_mac', threadId: 't-work' } }), op({ _id: 'c', origin: { host: 'env_box', threadId: 't-gone' } }), op({ _id: 'd', status: 'failed' })])
    expect(added).toEqual([])
  })
})
