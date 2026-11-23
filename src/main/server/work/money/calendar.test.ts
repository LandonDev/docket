import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CalendarOffer, MoneyRead, MoneyTripped } from '@shared/contract-work-money'
import { payCategory } from '@shared/work/money'
import type { Caller } from '../modules'
import { money } from '.'
import { dayOfEvent, forgetCalendar, setMeasure } from './calendar'
import { bench, LOCAL, req, type Bench } from './testing'

/* Pay and mileage from the calendar: what is offered, what a press adds, and what is remembered. */

// Clashes' measure of a drive, standing in: a leg per pair of stops, by the event's id.
const legs = new Map<string, { miles: number; minutes: number; measured: boolean } | null>()
const drivesAsked: unknown[][] = []
const standIn = async (_ctx: unknown, workspaceId: string, from: { event?: string }, to: { event?: string }) => {
  drivesAsked.push([workspaceId, from, to])
  return legs.get(from.event ?? to.event ?? '') ?? null
}

let b: Bench
const call = async <T>(method: string, params: unknown, by: Caller = LOCAL): Promise<T> => ((await money.handle!(req(method, params), b.ctx, by)) as { result: T }).result
const view = (from = '2026-01-01', to = '2027-01-01') => call<MoneyRead>('work.money.read', { workspaceId: 'ws-ref', from, to })
const offered = async (): Promise<CalendarOffer[]> => (await view()).calendar
const mileage = (): string => join(b.ref, 'Money', 'Mileage.tcsheet')
const ledger = (): string => join(b.ref, 'Money', 'Ledger.tcsheet')

const HOUR = 3600_000
const at = (daysAgo: number): number => Date.now() - daysAgo * 24 * HOUR
const game = (id: string, daysAgo: number, over: Record<string, unknown> = {}) => ({ _id: id, sector: 'ref', title: `Varsity at ${id}`, startsAt: at(daysAgo), endsAt: at(daysAgo) + 2 * HOUR, allDay: false, location: `${id} HS`, role: 'Referee', ...over })
const trip = (o: CalendarOffer, over: Record<string, unknown> = {}) => call<MoneyTripped>('work.money.trip', { workspaceId: 'ws-ref', eventId: o.eventId, date: o.date, title: o.title, place: o.place ?? '', ...(o.fee !== null ? { fee: o.fee } : {}), ...(o.miles !== null ? { miles: o.miles } : {}), ...over })

beforeEach(() => {
  b = bench()
  forgetCalendar()
  legs.clear()
  drivesAsked.length = 0
  setMeasure(standIn)
})

describe('what the calendar offers', () => {
  it('offers an ended game or paid item once, the oldest first, and nothing still to come', async () => {
    b.lifeos.events = [
      game('Harrison', 2, { amount: { cents: 7500, currency: 'USD' } }),
      game('West Side', 9),
      { _id: 'dentist', sector: 'ref', title: 'Dentist', startsAt: at(3), allDay: false, location: 'Main St' },
      { _id: 'dues', sector: 'ref', title: 'Association dues', startsAt: at(5), allDay: true, amount: { cents: 6000, currency: 'USD' } },
      game('Tomorrow', -1)
    ]
    const got = await offered()
    expect(got.map((o) => o.eventId)).toEqual(['West Side', 'dues', 'Harrison'])
    expect(got[2]).toEqual({ eventId: 'Harrison', date: dayOfEvent(at(2)), title: 'Varsity at Harrison', place: 'Harrison HS', fee: 7500, miles: null, measured: false })
    // It asked for the job's own sector, the last 60 days, as the owner.
    expect(b.lifeos.asked[0].fn).toBe('events:range')
    expect(b.lifeos.asked[0].args.sector).toBe('ref')
    expect(Math.round(((b.lifeos.asked[0].args.to as number) - (b.lifeos.asked[0].args.from as number)) / (24 * HOUR))).toBe(60)
  })

  it('reads the calendar at most every ten minutes', async () => {
    b.lifeos.events = [game('Harrison', 2)]
    await offered()
    await offered()
    await call('work.money.events', { workspaceId: 'ws-ref' })
    expect(b.lifeos.asked).toHaveLength(1)
  })

  it('leaves out an amount in another currency: the fee is not known, and an item with nothing else is not offered', async () => {
    b.lifeos.events = [game('Toronto', 2, { amount: { cents: 9000, currency: 'CAD' } }), { _id: 'fee-cad', sector: 'ref', title: 'Clinic', startsAt: at(4), allDay: false, amount: { cents: 5000, currency: 'CAD' } }]
    const got = await offered()
    expect(got.map((o) => [o.eventId, o.fee])).toEqual([['Toronto', null]])
  })

  it('offers nothing, and still paints the view, when LifeOS is signed out or does not answer', async () => {
    b.lifeos.events = [game('Harrison', 2)]
    b.lifeos.connected = false
    expect(await offered()).toEqual([])
    b.lifeos.connected = true
    b.lifeos.down = true
    expect(await offered()).toEqual([])
  })

  it('follows the books’ rule: every event, or none', async () => {
    b.lifeos.events = [game('Harrison', 2), { _id: 'dentist', sector: 'ref', title: 'Dentist', startsAt: at(3), allDay: false, location: 'Main St' }]
    await call('work.money.open', { workspaceId: 'ws-ref' })
    b.db.prepare("UPDATE work_money_books SET calendar = 'all'").run()
    expect((await offered()).map((o) => o.eventId)).toEqual(['dentist', 'Harrison'])
    b.db.prepare("UPDATE work_money_books SET calendar = 'off'").run()
    expect(await offered()).toEqual([])
  })

  it('lists the job’s ended events that name a place for Add → Trip…, the latest first, added or not', async () => {
    b.lifeos.events = [game('Harrison', 2), { _id: 'dentist', sector: 'ref', title: 'Dentist', startsAt: at(3), allDay: false, location: 'Main St' }, { _id: 'dues', sector: 'ref', title: 'Dues', startsAt: at(5), allDay: true }]
    const got = await call<{ events: CalendarOffer[] }>('work.money.events', { workspaceId: 'ws-ref' })
    expect(got.events.map((e) => e.eventId)).toEqual(['Harrison', 'dentist'])
  })
})

describe('adding a trip', () => {
  it('writes the pay to the ledger as money in, unpaid, and the miles to the log at the year’s rate with the value as a formula', async () => {
    b.lifeos.events = [game('Harrison', 2, { amount: { cents: 7500, currency: 'USD' } })]
    const [offer] = await offered()
    const got = await trip(offer, { miles: 24, date: '2026-11-21' })
    expect(got.pay).toMatchObject({ ok: true, row: 2 })
    expect(got.trip).toMatchObject({ row: 2, value: 1680 })
    expect(b.sheets.grid(ledger())[1].slice(0, 7)).toEqual(['2026-11-21', 'Harrison HS', 'Varsity at Harrison', 'Game fees', 75, '', 'Unpaid'])
    expect(b.sheets.grid(mileage())[1].slice(0, 6)).toEqual(['2026-11-21', 'Varsity at Harrison', 'Harrison HS', 24, 0.7, '=D2*E2'])
    const now = await view()
    expect(now.calendar).toEqual([])
    expect(now.owed).toMatchObject([{ who: 'Harrison HS', amount: 7500, way: 'toHim' }])
    expect(now.miles).toEqual({ miles: 24, value: 1680, rate: 0.7 })
    // Money wrote nothing to LifeOS (the stand-in throws on any mutation).
  })

  it('offers an event once: added, it is offered no more, and a second press adds nothing again', async () => {
    b.lifeos.events = [game('Harrison', 2, { amount: { cents: 7500, currency: 'USD' } })]
    const [offer] = await offered()
    await trip(offer, { miles: 24 })
    expect(await trip(offer, { miles: 24 })).toEqual({ pay: null, trip: null })
    expect(b.sheets.grid(ledger())).toHaveLength(2)
    expect(b.sheets.grid(mileage())).toHaveLength(2)
    expect(await offered()).toEqual([])
  })

  it('never offers a skipped one again, and a skip does not undo an added one', async () => {
    b.lifeos.events = [game('Harrison', 2), game('West Side', 3)]
    await call('work.money.skip', { workspaceId: 'ws-ref', eventId: 'Harrison' })
    expect((await offered()).map((o) => o.eventId)).toEqual(['West Side'])
    forgetCalendar()
    expect((await offered()).map((o) => o.eventId)).toEqual(['West Side'])
    const [west] = await offered()
    await trip(west, { fee: 8000 })
    await call('work.money.skip', { workspaceId: 'ws-ref', eventId: 'West Side' })
    expect(b.db.prepare("SELECT state FROM work_money_events WHERE event_id = 'West Side'").get()).toEqual({ state: 'added' })
  })

  it('remembers the miles he gave a place, and the fee he gave a role, for the next one', async () => {
    b.lifeos.events = [game('Harrison', 9), game('Harrison', 2, { _id: 'Harrison again', title: 'JV at Harrison' })]
    const [first, second] = await offered()
    expect([first.fee, first.miles, second.fee, second.miles]).toEqual([null, null, null, null])
    await trip(first, { fee: 7500, miles: 24 })
    const [next] = await offered()
    expect(next).toMatchObject({ eventId: 'Harrison again', fee: 7500, miles: 24, measured: true })
    // The place is found whatever its case and spacing.
    b.lifeos.events = [...(b.lifeos.events as object[]), game('x', 1, { _id: 'third', location: '  harrison   hs ' })]
    forgetCalendar()
    expect((await offered()).find((o) => o.eventId === 'third')?.miles).toBe(24)
  })

  it('takes a trip typed by hand, with miles alone or pay alone, and refuses one with neither', async () => {
    const miles = await call<MoneyTripped>('work.money.trip', { workspaceId: 'ws-ref', date: '2026-11-20', title: 'Rules clinic', place: 'Lafayette', miles: 12.5 })
    expect(miles).toMatchObject({ pay: null, trip: { row: 2, value: 875 } })
    const pay = await call<MoneyTripped>('work.money.trip', { workspaceId: 'ws-ref', date: '2026-11-20', title: 'Scrimmage', fee: 4000 })
    expect(pay.trip).toBeNull()
    expect(pay.pay).toMatchObject({ ok: true })
    await expect(call('work.money.trip', { workspaceId: 'ws-ref', date: '2026-11-20', title: 'Nothing' })).rejects.toThrow('miles, pay, or both')
  })

  it('files pay under the job’s own word for it', () => {
    expect([payCategory('ref'), payCategory('unify'), payCategory('cosmic'), payCategory('purdue'), payCategory(null)]).toEqual(['Game fees', 'Sales', 'Pay', 'Income', 'Income'])
  })

  it('is his alone', async () => {
    const MODEL: Caller = { kind: 'model', caps: ['read', 'operate'], sessionId: 't-ref' }
    await expect(call('work.money.trip', { workspaceId: 'ws-ref', date: '2026-11-20', title: 'X', miles: 1 }, MODEL)).rejects.toThrow('Only the owner')
    await expect(call('work.money.skip', { workspaceId: 'ws-ref', eventId: 'e' }, MODEL)).rejects.toThrow('Only the owner')
    await expect(call('work.money.rate', { workspaceId: 'ws-ref', year: 2026, rate: 0.72 }, MODEL)).rejects.toThrow('Only the owner')
  })
})

describe('miles from Clashes', () => {
  it('fills the miles of a place he never gave, there and back, and offers one press only when both legs were measured along roads', async () => {
    b.lifeos.events = [game('Harrison', 2, { amount: { cents: 7500, currency: 'USD' } }), game('West Side', 3, { amount: { cents: 8000, currency: 'USD' } }), game('Nowhere', 4)]
    legs.set('Harrison', { miles: 12.04, minutes: 21, measured: true })
    legs.set('West Side', { miles: 30, minutes: 40, measured: false })
    const got = await offered()
    expect(got.map((o) => [o.eventId, o.miles, o.measured])).toEqual([
      ['Nowhere', null, false],
      ['West Side', 60, false],
      ['Harrison', 24.1, true]
    ])
    // Two legs an event, from the job's start and back.
    expect(drivesAsked).toContainEqual(['ws-ref', { start: true }, { event: 'Harrison' }])
    expect(drivesAsked).toContainEqual(['ws-ref', { event: 'Harrison' }, { start: true }])
    // Asked once: the next read holds what it was told.
    const asked = drivesAsked.length
    await offered()
    expect(drivesAsked).toHaveLength(asked)
  })

  it('asks nothing for a place whose miles he already gave, and his miles are his own word', async () => {
    b.lifeos.events = [game('Harrison', 9), game('Harrison', 2, { _id: 'again' })]
    legs.set('Harrison', { miles: 12, minutes: 20, measured: false })
    const [first] = await offered()
    expect(first).toMatchObject({ miles: 24, measured: false })
    // He checked the estimate and accepted 26 miles: kept by place.
    await trip(first, { fee: 7500, miles: 26 })
    const [next] = await offered()
    expect(next).toMatchObject({ eventId: 'again', miles: 26, measured: true })
  })
})

describe('miles with no Clashes to ask', () => {
  it('leaves the miles for him to type when the clashes pillar cannot measure (Work off there, LifeOS away)', async () => {
    // The real call, on a LifeOS that refuses: no miles, and the view still paints.
    setMeasure(null)
    b.lifeos.events = [game('Harrison', 2)]
    expect(await offered()).toMatchObject([{ eventId: 'Harrison', miles: null, measured: false }])
  })
})

describe('the rate', () => {
  it('uses the last rate we are sure of until he sets the year’s own, then his', async () => {
    expect((await view()).rate).toEqual({ year: 2026, rate: 0.7, own: false })
    expect(await call('work.money.rate', { workspaceId: 'ws-ref', year: 2026, rate: 0.725 })).toEqual({ year: 2026, rate: 0.725, own: true })
    expect((await view()).rate).toEqual({ year: 2026, rate: 0.725, own: true })
    // A later year falls back to the newest year before it that has one: his 2026.
    expect((await view('2027-01-01', '2028-01-01')).rate).toEqual({ year: 2027, rate: 0.725, own: false })
    expect((await view('2025-01-01', '2026-01-01')).rate).toEqual({ year: 2025, rate: 0.7, own: false })
    await call('work.money.trip', { workspaceId: 'ws-ref', date: '2026-11-20', title: 'Clinic', miles: 10 })
    expect(b.sheets.grid(mileage())[1][4]).toBe(0.725)
  })
})
