import type { MoneyActed, MoneyRate, MoneyTripped, TripParams } from '@shared/contract-work-money'
import { columnLetter, columnsOf, MILEAGE_COLUMNS, payCategory, rateFor, type Cell, type MileageColumn } from '@shared/work/money'
import type { WorkCtx } from '../modules'
import { appendRow, locked, newRef, openBooks, write, type A1 } from './book'
import { roleOf } from './calendar'
import { gridOf, MoneyError } from './read'
import { booksOf, eventMarks, keepMiles, markEvent, setRate, type Books, type Workspace } from './store'

/**
 * The mileage log and the pay that goes with a trip (docs/agents/work-money.md
 * "Mileage"). Miles are not cash: they are kept in a sheet of their own,
 * `Money/Mileage.tcsheet`, a row a trip with its value as a formula, so the
 * ledger's sums stay money alone. The pay for a game is a row in the
 * ledger, unpaid until he marks it paid.
 */

type Ctx = Pick<WorkCtx, 'db' | 'service' | 'log'>

/** Appends a trip to the mileage log, under the workspace's lock. */
async function appendTrip(ctx: Ctx, ws: Workspace, books: Books, t: { date: string; title: string; place: string; miles: number; rate: number }): Promise<{ row: number; ref: string | null; value: number }> {
  return locked(ws.id, async () => {
    const grid = await gridOf(ctx, books.mileage)
    const at = columnsOf(grid.header, MILEAGE_COLUMNS)
    if (at.Date === undefined || at.Miles === undefined) throw new MoneyError("The mileage log's columns changed: it needs Date and Miles.")
    const row = grid.last + 1
    const ref = at.Ref === undefined ? null : newRef()
    const cell = (name: MileageColumn, v: Cell): A1[] => (at[name] === undefined ? [] : [{ at: `${columnLetter(at[name]!)}${row}`, v }])
    const cells: A1[] = [...cell('Date', t.date), ...cell('Trip', t.title), ...cell('Place', t.place || null), ...cell('Miles', t.miles), ...cell('Rate', t.rate), ...(ref ? cell('Ref', ref) : [])]
    // The value is the sheet's own sum, so a rate he corrects in the row corrects the value.
    if (at.Value !== undefined && at.Rate !== undefined) cells.push({ at: `${columnLetter(at.Value)}${row}`, f: `${columnLetter(at.Miles)}${row}*${columnLetter(at.Rate)}${row}` })
    await write(ctx, books.mileage, cells, grid.shared)
    return { row, ref, value: Math.round(t.miles * t.rate * 100) }
  })
}

/**
 * A trip, and the pay that went with it. Miles go to the mileage log at the
 * year's rate and are remembered for the place; a fee goes to the ledger as
 * money in, unpaid; the calendar event it came from is marked added, so it
 * is offered no more. An event already added adds nothing again, and one
 * whose pay was written before its trip failed writes only the trip.
 */
export function addTrip(ctx: Ctx, ws: Workspace, p: TripParams): Promise<MoneyTripped> {
  if (!p.eventId) return addOnce(ctx, ws, p)
  // One add an event at a time: a second press while the first is being written answers the first.
  const key = `${ws.id}:${p.eventId}`
  const running = adding.get(key)
  if (running) return running
  const run = addOnce(ctx, ws, p).finally(() => adding.delete(key))
  adding.set(key, run)
  return run
}
const adding = new Map<string, Promise<MoneyTripped>>()

async function addOnce(ctx: Ctx, ws: Workspace, p: TripParams): Promise<MoneyTripped> {
  const mark = p.eventId ? eventMarks(ctx, ws.id).get(p.eventId) : undefined
  if (mark?.state === 'added') return { pay: null, trip: null }
  const miles = p.miles ?? 0
  const fee = p.fee ?? 0
  if (!(miles > 0) && !(fee > 0)) throw new MoneyError('A trip has miles, pay, or both.')
  const books = await openBooks(ctx, ws)
  const role = p.eventId ? roleOf(ws.id, p.eventId) : null
  let pay: MoneyActed | null = null
  // Its pay is in the ledger already when an earlier add wrote it and then failed on the trip: it is not written twice.
  if (fee > 0 && mark?.state !== 'adding') {
    const got = await appendRow(ctx, ws, books, { Date: p.date, Who: p.place, For: p.title, Category: payCategory(ws.sector), In: fee / 100, Status: 'Unpaid' })
    pay = { ok: true, ref: got.ref, row: got.row, ...(got.suggested ? { suggested: true as const } : {}) }
    if (p.eventId) markEvent(ctx, ws.id, p.eventId, { state: 'adding', role, fee })
  }
  let trip: MoneyTripped['trip'] = null
  if (miles > 0) {
    trip = await appendTrip(ctx, ws, books, { date: p.date, title: p.title, place: p.place, miles, rate: rateFor(Number(p.date.slice(0, 4)), books.rates) })
    if (p.place) keepMiles(ctx, p.place, miles)
  }
  if (p.eventId) markEvent(ctx, ws.id, p.eventId, { state: 'added', role: role ?? mark?.role ?? null, fee: fee > 0 ? fee : (mark?.fee ?? null) })
  return { pay, trip }
}

/** An event he does not want offered again. */
export function skipEvent(ctx: Pick<WorkCtx, 'db'>, ws: Workspace, eventId: string): void {
  if (eventMarks(ctx, ws.id).get(eventId)?.state === 'added') return
  markEvent(ctx, ws.id, eventId, { state: 'skipped', role: roleOf(ws.id, eventId), fee: null })
}

/** His own rate for a year. The books are made first when the job has none, so the rate has a row to live in. */
export async function setYearRate(ctx: Ctx, ws: Workspace, year: number, rate: number): Promise<MoneyRate> {
  if (!booksOf(ctx, ws.id)) await openBooks(ctx, ws)
  setRate(ctx, ws.id, year, rate)
  return { year, rate, own: true }
}
