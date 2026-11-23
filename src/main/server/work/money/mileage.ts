import type { MoneyActed, MoneyRate, MoneyTripped, TripParams } from '@shared/contract-work-money'
import { centsFrom, columnLetter, columnsOf, MILEAGE_COLUMNS, payCategory, rateFor, type Cell, type MileageColumn } from '@shared/work/money'
import type { WorkCtx } from '../modules'
import { appendRow, locked, newRef, openBooks, othersCanOpen, write, writtenRow, type A1 } from './book'
import { roleOf } from './calendar'
import { gridOf, ledgerOf, MoneyError, nextRow, writtenAt, type Grid } from './read'
import { booksOf, eventMarks, keepMiles, markEvent, setRate, type Books, type TripIntent, type Workspace } from './store'

/**
 * The mileage log and the pay that goes with a trip (docs/agents/work-money.md
 * "Mileage"). Miles are not cash: they are kept in a sheet of their own,
 * `Money/Mileage.tcsheet`, a row a trip with its value as a formula, so the
 * ledger's sums stay money alone. The pay for a game is a row in the
 * ledger, unpaid until he marks it paid.
 */

type Ctx = Pick<WorkCtx, 'db' | 'service' | 'log' | 'host' | 'dataDir'>

const LOG_COLUMNS = "The mileage log's columns changed: it needs Date, Miles, Rate and Value."
/**
 * The log as it is now, when it can take a trip: asked before anything of
 * an add is written, so the pay is not left without its trip for a cause
 * known beforehand. A trip is written whole or not at all: with no Rate or
 * Value column its row would be worth nothing in the sheet and in every
 * figure read from it.
 */
async function logOf(ctx: Ctx, books: Books): Promise<Grid> {
  const grid = await gridOf(ctx, books.mileage)
  const at = columnsOf(grid.header, MILEAGE_COLUMNS)
  if (at.Date === undefined || at.Miles === undefined || at.Rate === undefined || at.Value === undefined) throw new MoneyError(LOG_COLUMNS)
  return grid
}

/** Appends a trip to the mileage log, under the workspace's lock, under the Ref its add noted for it. */
async function appendTrip(ctx: Ctx, ws: Workspace, books: Books, t: { date: string; title: string; place: string; miles: number; rate: number }, ref: string): Promise<NonNullable<MoneyTripped['trip']>> {
  return locked(ws.id, async () => {
    const grid = await logOf(ctx, books)
    const at = columnsOf(grid.header, MILEAGE_COLUMNS)
    const value = centsFrom(t.miles * t.rate)
    const shared = await othersCanOpen(ctx, books.mileage, grid.shared)
    // A log others can open takes the trip as a suggestion: it goes under the ones that wait, as in the ledger.
    const row = nextRow(grid)
    const own = at.Ref === undefined ? null : ref
    const cell = (name: MileageColumn, v: Cell): A1[] => (at[name] === undefined ? [] : [{ at: `${columnLetter(at[name]!)}${row}`, v }])
    const cells: A1[] = [...cell('Date', t.date), ...cell('Trip', t.title), ...cell('Place', t.place || null), ...cell('Miles', t.miles), ...cell('Rate', t.rate), ...(own ? cell('Ref', own) : [])]
    // The value is the sheet's own sum, so a rate he corrects in the row corrects the value. It is rounded to cents in
    // the sheet as Money rounds it, so the column's total there is the total Money says.
    cells.push({ at: `${columnLetter(at.Value!)}${row}`, f: `ROUND(${columnLetter(at.Miles!)}${row}*${columnLetter(at.Rate!)}${row},2)` })
    const { suggested } = await write(ctx, books.mileage, cells, shared)
    return { row, ref: own, value, ...(suggested ? { suggested: true as const } : {}) }
  })
}

/**
 * A trip, and the pay that went with it. Miles go to the mileage log at the
 * year's rate and are remembered for the place; a fee goes to the ledger as
 * money in, unpaid; the calendar event it came from is marked added, so it
 * is offered no more. An event already added adds nothing again. What an
 * add means to write is noted first (`TripIntent`), each row under a Ref of
 * its own: an add that was not seen to its end (a write failed, the host
 * stopped between the two sheets) is taken up by the next one, which looks
 * for those rows and writes only what is missing.
 */
export function addTrip(ctx: Ctx, ws: Workspace, p: TripParams): Promise<MoneyTripped> {
  // What the add goes by: its calendar event, or for a trip typed by hand the sender's own key.
  const id = p.eventId ?? (p.key ? `key:${p.key}` : null)
  if (!id) return addOnce(ctx, ws, p, null)
  // One add an event at a time: a second press while the first is being written answers the first.
  const key = `${ws.id}:${id}`
  const running = adding.get(key)
  if (running) return running
  const run = addOnce(ctx, ws, p, id).finally(() => adding.delete(key))
  adding.set(key, run)
  return run
}
const adding = new Map<string, Promise<MoneyTripped>>()

async function addOnce(ctx: Ctx, ws: Workspace, p: TripParams, id: string | null): Promise<MoneyTripped> {
  const mark = id ? eventMarks(ctx, ws.id).get(id) : undefined
  // Already added (a second press, or a list that went stale): nothing is written twice, and the answer says nothing was.
  if (mark?.state === 'added') return { pay: null, trip: null, already: true }
  const books = await openBooks(ctx, ws)
  // An add that was begun and not finished: still offered (`adding`), or skipped since with its note kept. Either way
  // it is taken up where it stopped, whichever way he comes back to it (the offer, or Add → Trip… on a skipped one).
  const begun = mark && (mark.state === 'adding' || mark.intent || mark.fee !== null) ? mark : null
  const was: TripIntent | null = begun?.intent ?? null
  // What the add that was begun already wrote: its rows are looked for by their Refs, in the sheets and among what waits there.
  const paid = was ? writtenRow(await ledgerOf(ctx, books), { ref: was.pay }) : null
  const logged = was ? writtenAt(await gridOf(ctx, books.mileage), 'Ref', was.trip) : null
  // An add begun before intents were kept wrote its pay and then stopped: that pay is not written twice.
  const payDone = paid !== null || (begun !== null && !was)
  // The fee that was written stands; the miles are his now, else the ones the unfinished add meant to log.
  const fee = payDone ? (begun?.fee ?? 0) : (p.fee ?? 0)
  const miles = logged ? (was?.miles ?? 0) : (p.miles ?? 0) > 0 ? p.miles! : (was?.miles ?? 0)
  if (!(miles > 0) && !(fee > 0)) throw new MoneyError('A trip has miles, pay, or both.')
  if (miles > 0 && !logged) await logOf(ctx, books)
  const role = p.eventId ? (roleOf(ws.id, p.eventId) ?? mark?.role ?? null) : null
  const intent: TripIntent = { pay: was?.pay ?? newRef(), trip: was?.trip ?? newRef(), ...(miles > 0 ? { miles } : {}) }
  if (id) markEvent(ctx, ws.id, id, { state: 'adding', role, fee: fee > 0 ? fee : null, intent })
  let pay: MoneyActed | null = paid ? { ok: true, ref: paid.ref, row: paid.row, ...(paid.suggested ? { suggested: true as const } : {}) } : null
  if (!payDone && fee > 0) {
    const got = await appendRow(ctx, ws, books, { Date: p.date, Who: p.place, For: p.title, Category: payCategory(ws.sector), In: fee / 100, Status: 'Unpaid' }, { ref: intent.pay })
    pay = { ok: true, ref: got.ref, row: got.row, ...(got.suggested ? { suggested: true as const } : {}) }
  }
  let trip: MoneyTripped['trip'] = null
  const rate = rateFor(Number(p.date.slice(0, 4)), books.rates)
  if (logged) trip = { row: logged.row, ref: intent.trip, value: centsFrom(miles * rate), ...(logged.suggested ? { suggested: true as const } : {}) }
  else if (miles > 0) {
    trip = await appendTrip(ctx, ws, books, { date: p.date, title: p.title, place: p.place, miles, rate }, intent.trip)
    if (p.place) keepMiles(ctx, ws.id, p.place, miles)
  }
  if (id) markEvent(ctx, ws.id, id, { state: 'added', role, fee: fee > 0 ? fee : null, intent: null })
  return { pay, trip }
}

/** A hand-typed trip's note is kept a month, so the same Add again writes nothing twice; after that only the rows stand. */
export function pruneTrips(ctx: Pick<WorkCtx, 'db'>, now = Date.now()): void {
  ctx.db.prepare("DELETE FROM work_money_events WHERE event_id LIKE 'key:%' AND state = 'added' AND at < ?").run(now - 30 * 24 * 3600_000)
}

/**
 * An event he does not want offered again; `undo` offers it again. An event
 * already added is neither. One whose add was begun and not finished keeps
 * what that add noted, so undoing the skip takes it up where it stopped and
 * its pay is not written twice.
 */
export function skipEvent(ctx: Pick<WorkCtx, 'db'>, ws: Workspace, eventId: string, undo = false): void {
  const mark = eventMarks(ctx, ws.id).get(eventId)
  if (undo) {
    if (mark?.state !== 'skipped') return
    if (mark.intent || mark.fee !== null) markEvent(ctx, ws.id, eventId, { ...mark, state: 'adding' })
    else ctx.db.prepare('DELETE FROM work_money_events WHERE workspace_id = ? AND event_id = ?').run(ws.id, eventId)
    return
  }
  // Skipped already (a second window, or the same press sent again): nothing changes, and what a begun add noted stays.
  if (mark?.state === 'added' || mark?.state === 'skipped') return
  const begun = mark?.state === 'adding' ? mark : null
  markEvent(ctx, ws.id, eventId, { state: 'skipped', role: begun?.role ?? roleOf(ws.id, eventId), fee: begun?.fee ?? null, intent: begun?.intent ?? null })
}

/** His own rate for a year. The books are made first when the job has none, so the rate has a row to live in. */
export async function setYearRate(ctx: Ctx, ws: Workspace, year: number, rate: number): Promise<MoneyRate> {
  if (!booksOf(ctx, ws.id)) await openBooks(ctx, ws)
  setRate(ctx, ws.id, year, rate)
  return { year, rate, own: true }
}
