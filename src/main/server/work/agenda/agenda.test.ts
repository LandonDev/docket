import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OutboxItem } from '@shared/contract-work-outbox'
import type { WorkCtx } from '../modules'
import { opFields } from '../../../../renderer/src/work/agenda/calendarAct'
import { CalendarFieldsSchema, CalendarOpMatcherSchema, calendarGrantFits, calendarWords, type CalendarOpPayload } from '../outbox/lifeosHeld'
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
    // with the revision he was shown, which LifeOS checks in the send's own transaction
    expect(sends()).toEqual([{ fn: 'calendarOps:send', args: { id, cause: 'press', editedAt: (item!.payload as CalendarOpPayload).editedAt } }])
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

  it('a press refuses an event that moved since it was listed, and the listing catches up', async () => {
    rig.lifeos.calendarOp({ kind: 'accept', eventId: 'ev_1' })
    rig.lifeos.fire()
    await settled()
    const [item] = await list()
    const shown = (item!.payload as CalendarOpPayload).eventStartsAt!
    Object.assign(rig.lifeos.events.get('ev_1')!, { startsAt: shown + 7_200_000 })
    await expect(rig.rpc('work.outbox.send', { ref: item!.ref, rev: item!.updatedAt })).rejects.toThrow('changed since')
    expect(sends()).toEqual([])
    const [again] = await list()
    expect((again!.payload as CalendarOpPayload).eventStartsAt).toBe(shown + 7_200_000)
    // another view, still showing the old start, is refused too: the revision covers the start
    expect(again!.updatedAt).not.toBe(item!.updatedAt)
    await expect(rig.rpc('work.outbox.send', { ref: item!.ref, rev: item!.updatedAt })).rejects.toThrow('changed since')
    expect(sends()).toEqual([])
    await rig.rpc('work.outbox.send', { ref: again!.ref, rev: again!.updatedAt })
    await settled()
    expect(sends()).toHaveLength(1)
  })

  it('a press refuses an event renamed or moved to another place since it was listed, its start unchanged', async () => {
    rig.lifeos.calendarOp({ kind: 'accept', eventId: 'ev_1' })
    rig.lifeos.fire()
    await settled()
    const [item] = await list()
    Object.assign(rig.lifeos.events.get('ev_1')!, { title: 'New contract approval' })
    await expect(rig.rpc('work.outbox.send', { ref: item!.ref, rev: item!.updatedAt })).rejects.toThrow('changed since')
    expect(sends()).toEqual([])
    const [again] = await list()
    expect((again!.payload as CalendarOpPayload).eventTitle).toBe('New contract approval')
  })

  it("an older view is refused after any read caught the event's change, not only after a refused press", async () => {
    rig.lifeos.calendarOp({ kind: 'accept', eventId: 'ev_1' })
    rig.lifeos.fire()
    await settled()
    const [old] = await list()
    Object.assign(rig.lifeos.events.get('ev_1')!, { location: 'Room 210' })
    // the detail reads it fresh: the revision moves on with the event, durably
    const fresh = await rig.rpc<OutboxItem>('work.outbox.get', { ref: old!.ref })
    expect(fresh.updatedAt).not.toBe(old!.updatedAt)
    await expect(rig.rpc('work.outbox.send', { ref: old!.ref, rev: old!.updatedAt })).rejects.toThrow('changed since')
    expect(sends()).toEqual([])
  })

  it('does not go when its event moved after it was shown', async () => {
    const id = rig.lifeos.calendarOp({ kind: 'accept', eventId: 'ev_1' })
    rig.lifeos.fire()
    await settled()
    const [item] = await list()
    const shown = (await rig.rpc<OutboxItem>('work.outbox.get', { ref: item!.ref })).payload as CalendarOpPayload
    expect(shown.eventStartsAt).toBe(rig.lifeos.events.get('ev_1')!.startsAt)
    const def = rig.host.outbox.def('calendar.op')
    const ctx = { ...rig.work.ctx, item: {} as never, decidedBy: 'owner' as const }
    Object.assign(rig.lifeos.events.get('ev_1')!, { startsAt: Number(shown.eventStartsAt) + 7_200_000 })
    await expect(def.execute(shown, ctx)).rejects.toThrow('The event changed since it was shown')
    expect(rig.lifeos.ops.get(id)!.status).toBe('draft')
  })

  it("does not go when it is edited between the press's read and LifeOS's send", async () => {
    const id = rig.lifeos.calendarOp({ kind: 'accept', eventId: 'ev_1' })
    rig.lifeos.fire()
    await settled()
    const def = rig.host.outbox.def('calendar.op')
    const shown = (await list())[0]!.payload as CalendarOpPayload
    const ctx = { ...rig.work.ctx, item: {} as never, decidedBy: 'owner' as const }
    // the edit lands after the host's read: LifeOS's own check refuses the send
    const query = rig.lifeos.query.bind(rig.lifeos)
    rig.lifeos.query = (async (fn: string, args: Record<string, unknown>) => {
      const got = await query(fn, args)
      if (fn !== 'calendarOps:get') return got
      const read = { ...(got as object) }
      Object.assign(rig.lifeos.ops.get(id)!, { editedAt: Number(shown.editedAt) + 7 })
      return read
    }) as typeof rig.lifeos.query
    await expect(def.execute(shown, ctx)).rejects.toThrow('changed since it was shown')
    expect(rig.lifeos.ops.get(id)!.status).toBe('draft')
    // and one with no revision to check never goes
    await expect(def.execute({ ...shown, editedAt: undefined }, ctx)).rejects.toThrow('edited since it was shown')
  })

  it("is edited through calendarOps.save, keeping its kind and event", async () => {
    const id = rig.lifeos.calendarOp({ kind: 'propose', eventId: 'ev_1', payload: { comment: 'Could we move it?' } })
    rig.lifeos.fire()
    await settled()
    const [item] = await list()
    const payload = { ...(item!.payload as CalendarOpPayload), kind: 'cancel', payload: { comment: 'Thursday works better', proposedStart: 5 } }
    const after = await rig.rpc<OutboxItem>('work.outbox.edit', { ref: item!.ref, payload })
    const save = rig.lifeos.calls.find((c) => c.fn === 'calendarOps:save')
    expect(save?.args).toEqual({ id, kind: 'propose', eventId: 'ev_1', payload: { comment: 'Thursday works better', proposedStart: 5 } })
    expect(after.summary).toBe('Propose a new time for "Big Ten league call"')
  })

  it('takes a grant only for its kind, its account, its calendar and the people it names', () => {
    const invite = (addresses: string[], over: Partial<CalendarOpPayload> = {}): CalendarOpPayload => ({ id: 'op', kind: 'create', account: 'landon@purdue.edu', calendarId: 'landon@purdue.edu', payload: { title: 'Scrim', attendees: addresses.map((address) => ({ address })) }, ...over })
    const m = { kind: 'create' as const, account: 'landon@purdue.edu', calendarId: 'landon@purdue.edu', attendees: ['sam@purdue.edu'] }
    expect(calendarGrantFits(m, invite(['Sam@Purdue.edu']))).toBe(true)
    expect(calendarGrantFits(m, invite(['sam@purdue.edu', 'dana@purdue.edu']))).toBe(false)
    // an event that invites nobody is no invite: it fits no invite grant
    expect(calendarGrantFits(m, invite([]))).toBe(false)
    // the same account's team calendar, which others see, is not the calendar the grant was made on
    expect(calendarGrantFits(m, invite(['sam@purdue.edu'], { calendarId: 'esports-team@group.calendar.google.com' }))).toBe(false)
    expect(calendarGrantFits({ ...m, account: 'other@gmail.com' }, invite(['sam@purdue.edu']))).toBe(false)
    const accept = { kind: 'accept' as const, account: 'landon@purdue.edu', calendarId: null }
    expect(calendarGrantFits(accept, { id: 'op', kind: 'accept', account: 'landon@purdue.edu' })).toBe(true)
    expect(calendarGrantFits(accept, { id: 'op', kind: 'accept', account: 'landon@purdue.edu', payload: { series: true } })).toBe(false)
    // a change, a cancel or a proposal is always his press: no grant can be made for one
    for (const kind of ['update', 'cancel', 'propose']) expect(CalendarOpMatcherSchema.safeParse({ kind, account: 'a', calendarId: null }).success).toBe(false)
  })

  it('shows every field it will send', () => {
    const fields: Record<string, unknown> = { title: 'T', startsAt: 1, endsAt: 2, allDay: false, location: 'L', notes: 'N', attendees: [{ address: 'a@b.c' }], uninvite: ['d@e.f'], comment: 'C', proposedStart: 3, proposedEnd: 4, series: true }
    expect(Object.keys(fields).sort()).toEqual(Object.keys(CalendarFieldsSchema.shape).sort())
    const shown = opFields({ id: 'op', kind: 'propose', account: 'a@b.c', calendarId: 'team@group', payload: fields as never }, null).map((f) => f.label)
    expect(shown).toEqual(['Event', 'When', 'Instead', 'Where', 'Invites', 'Uninvites', 'Applies to', 'Note', 'Details', 'Calendar'])
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
  const op = (over: Record<string, unknown> = {}) => ({ _id: 'op_1', _creationTime: Date.now() + 1000, kind: 'create', plain: true, status: 'done', account: 'landon@purdue.edu', payload: { title: 'Focus' }, origin: { host: 'env_box', threadId: 't-work' }, ...over })

  it("is a Result of this host's thread, recorded once", () => {
    const added: unknown[] = []
    const ctx = ctxWith(added)
    // queued is not gone yet: nothing until Google took it
    expect(recordPlain(ctx, [op({ status: 'queued' })])).toEqual([])
    expect(recordPlain(ctx, [op()])).toEqual(['op_1'])
    expect(recordPlain(ctx, [op()])).toEqual([])
    expect(added).toEqual([{ sessionId: 't-work', kind: 'calendar.op', summary: 'Added "Focus" to the calendar', account: 'landon@purdue.edu', ref: { at: 'lifeos', table: 'calendarOps', id: 'op_1' } }])
  })

  it("is not recorded for a held act, another host's thread, a thread gone, or one that failed", () => {
    const added: unknown[] = []
    const ctx = ctxWith(added)
    recordPlain(ctx, [op({ _id: 'a', plain: undefined, status: 'draft' }), op({ _id: 'b', origin: { host: 'env_mac', threadId: 't-work' } }), op({ _id: 'c', origin: { host: 'env_box', threadId: 't-gone' } }), op({ _id: 'd', status: 'failed' }), op({ _id: 'e', _creationTime: 1 })])
    expect(added).toEqual([])
  })
})
