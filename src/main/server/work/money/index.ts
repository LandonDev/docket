import { join } from 'node:path'
import type { ClientRequest } from '@shared/contract'
import { MONEY_OWNER_ONLY, MoneyRequestSchemas, receiptLines, type MoneyBooks, type MoneyState } from '@shared/contract-work-money'
import { handled, NOT_HANDLED, type Handled } from '@shared/work'
import { categoriesFor } from '@shared/work/money'
import { FenceError } from '../../remote/fence'
import type { Caller, WorkCtx, WorkModule } from '../modules'
import { registerFileMoved } from '../files/hooks'
import { MONEY_TELLS, moneySearch } from './borders'
import { addRow, editRow, insideJob, MONEY_FOLDER, openBooks, payRow, restoreColumns } from './book'
import { offers, placed } from './calendar'
import { accept, announce, drop, filedPicture, forgetJob, jobOfWaiting, parseFor, receive, resume, toConfirm, waitingPicture, type JobFor } from './inbox'
import { addTrip, pruneTrips, setYearRate, skipEvent } from './mileage'
import { movedHook } from './moved'
import { exportYear, invoiceNext, invoicePage, keep } from './out'
import { booksHere, LEDGER_OUTSIDE, ledgerOf, ledgerOutside, MoneyError, owedFor, readMoney, searchMoney, sumsFor } from './read'
import { MONEY_CONVERTERS } from './reader'
import { booksOf, dropWorkspace, ensureMoneyTables, workspaceOf, workspaces, type Workspace } from './store'
import { moneyTools } from './tools'

/**
 * The money pillar's server module (docs/agents/work-money.md): a job's
 * ledger as a sheet in its own folder, read for the Money view and written
 * only by the owner. It declares no act kind: nothing here sends anything
 * or moves money.
 */

type Params<M extends string> = Extract<(typeof MoneyRequestSchemas)[number]['_output'], { method: M }>['params']
const paramsOf = <M extends string>(method: M, req: ClientRequest): Params<M> => {
  const schema = MoneyRequestSchemas.find((s) => s.shape.method.value === method)!
  const got = schema.shape.params.safeParse((req as { params?: unknown }).params)
  if (got.success) return got.data as Params<M>
  // A day that does not exist is his to put right, so it is said in words; anything else is a caller's fault and stays as the schema says it.
  const day = got.error.issues.find((i) => i.message.startsWith('That is not a day'))
  throw day ? new MoneyError(day.message) : got.error
}

/** How long `work.money.state` waits for a job's ledger before answering that job's starting categories alone. */
const STATE_WAIT_MS = 400

const OWNER_ONLY = 'Only the owner writes the ledger. A thread adds with money_add or money_receipt, which wait for his accept.'

/**
 * Who may ask about a job's money. A thread's own call reaches its own job
 * alone, and none of the writes; a remote key reaches a job only when it
 * could have named the Money folder itself.
 */
function admit(ctx: WorkCtx, by: Caller, method: string, workspaceId: string): Workspace {
  if (by.kind === 'model') {
    if (MONEY_OWNER_ONLY.has(method)) throw new MoneyError(OWNER_ONLY)
    const scope = by.sessionId ? ctx.scopeOf(by.sessionId) : null
    if (!scope || scope.workspaceId !== workspaceId) throw new MoneyError("A thread reads its own job's money, and no other's.")
  }
  const ws = workspaceOf(ctx, workspaceId)
  if (!ws) throw new MoneyError('That job is not on this computer.')
  if (by.kind === 'remote' && !ctx.reaches(by, join(ws.path, MONEY_FOLDER))) throw new FenceError(method)
  return ws
}

/** Every job the caller may ask about, for a call that names none. */
const reachable = (ctx: WorkCtx, by: Caller, method: string): Workspace[] =>
  workspaces(ctx).filter((ws) => {
    try {
      admit(ctx, by, method, ws.id)
      return true
    } catch {
      return false
    }
  })

/** Whether the caller may ask about a job: for a step that would read another job than the one the call named. */
const mayAsk =
  (ctx: WorkCtx, by: Caller, method: string) =>
  (workspaceId: string): boolean => {
    try {
      admit(ctx, by, method, workspaceId)
      return true
    } catch {
      return false
    }
  }

/** The job a receipt or a parse names: the workspace it names, when the caller may ask about it; else the first job in its sector that the caller may ask about. */
const jobFor =
  (ctx: WorkCtx, by: Caller, method: string): JobFor =>
  (p) =>
    p.workspaceId ? admit(ctx, by, method, p.workspaceId) : p.sector ? (reachable(ctx, by, method).find((ws) => ws.sector === p.sector) ?? null) : null

async function handle(req: ClientRequest, ctx: WorkCtx, by: Caller, signal?: AbortSignal): Promise<Handled> {
  // A thread's own call is refused before anything it sent is read; so is a call from another host, which only a
  // thread's tool makes (`servePeerWork`): no thread writes the ledger, on this host or from another.
  if ((by.kind === 'model' || by.peer) && MONEY_OWNER_ONLY.has(req.method)) throw new MoneyError(OWNER_ONLY)
  switch (req.method) {
    case 'work.money.state': {
      // A job's categories are its starting list and every word its ledger already uses, as the desktop offers them: a
      // sender that draws a picker (the phone) can then choose any of them.
      const jobs = await Promise.all(
        reachable(ctx, by, req.method).map(async (ws) => {
          const books = booksHere(ctx, ws.id)
          // Asked of every job at once and never waited on for long: a sender checks this call before it sends (the
          // phone's Save), so one job's slow ledger must not hold the answer. A job not read in time answers its
          // starting list; its read goes on and is kept, so the next ask has its words.
          const late = new Promise<string[]>((resolve) => setTimeout(() => resolve([]), STATE_WAIT_MS).unref?.())
          const used = books ? await Promise.race([ledgerOf(ctx, books).then((l) => l.rows.map((r) => r.category), () => []), late]) : []
          return { workspaceId: ws.id, name: ws.name, sector: ws.sector, made: books !== null, categories: categoriesFor(ws.sector, used) }
        })
      )
      return handled({ host: ctx.host, jobs } satisfies MoneyState)
    }
    case 'work.money.open': {
      const p = paramsOf('work.money.open', req)
      const ws = admit(ctx, by, req.method, p.workspaceId)
      // The ledger is answered whatever state the mileage log is in: one that cannot be opened is null, never a refusal of both.
      const books = await openBooks(ctx, ws, 'ledger')
      const restored = p.restore ? await restoreColumns(ctx, ws, books) : null
      const mileage = insideJob(ws, books.mileage) ? { at: 'file' as const, host: ctx.host, path: books.mileage } : null
      return handled({ ledger: { at: 'file', host: ctx.host, path: books.ledger }, mileage, ...(restored?.suggested ? { suggested: true as const } : {}) } satisfies MoneyBooks)
    }
    case 'work.money.read': {
      const p = paramsOf('work.money.read', req)
      const ws = admit(ctx, by, req.method, p.workspaceId)
      // The calendar is LifeOS's to answer: when it cannot, the view still paints, with nothing offered.
      const [read, calendar] = await Promise.all([readMoney(ctx, ws, { from: p.from, to: p.to }), offers(ctx, ws, booksOf(ctx, ws.id)).catch(() => [])])
      return handled({ ...read, toConfirm: toConfirm(ctx, ws.id), calendar })
    }
    case 'work.money.entry': {
      const p = paramsOf('work.money.entry', req)
      const ws = admit(ctx, by, req.method, p.workspaceId)
      if (ledgerOutside(ctx, ws.id)) throw new MoneyError(LEDGER_OUTSIDE)
      const books = booksHere(ctx, ws.id)
      const acted = !p.at ? await addRow(ctx, ws, p.fields) : books ? await editRow(ctx, ws, books, p.at, p.fields) : { changed: true as const }
      // Every other window on this job reads again.
      if ('ok' in acted) announce(ctx, ws.id)
      return handled(acted)
    }
    case 'work.money.paid': {
      const p = paramsOf('work.money.paid', req)
      const ws = admit(ctx, by, req.method, p.workspaceId)
      if (ledgerOutside(ctx, ws.id)) throw new MoneyError(LEDGER_OUTSIDE)
      const books = booksHere(ctx, ws.id)
      const acted = books ? await payRow(ctx, ws, books, p.at, p.on) : { changed: true as const }
      if ('ok' in acted) announce(ctx, ws.id)
      return handled(acted)
    }
    case 'work.money.sums': {
      const p = paramsOf('work.money.sums', req)
      // Only the jobs the caller may ask about are opened: another job's broken sheet never keeps these from being answered.
      return handled(await sumsFor(ctx, { from: p.from, to: p.to }, p.workspaceId ? [admit(ctx, by, req.method, p.workspaceId)] : reachable(ctx, by, req.method)))
    }
    case 'work.money.owed': {
      const p = paramsOf('work.money.owed', req)
      return handled(await owedFor(ctx, p.workspaceId ? [admit(ctx, by, req.method, p.workspaceId)] : reachable(ctx, by, req.method)))
    }
    case 'work.money.search': {
      const p = paramsOf('work.money.search', req)
      return handled(await searchMoney(ctx, admit(ctx, by, req.method, p.workspaceId), p.query, p.limit))
    }
    case 'work.money.parse': {
      const p = paramsOf('work.money.parse', req)
      return handled(await parseFor(ctx, receiptLines(p.lines), jobFor(ctx, by, req.method)(p), p.sector))
    }
    case 'work.money.receive': {
      const p = paramsOf('work.money.receive', req)
      return handled(await receive(ctx, p, by, jobFor(ctx, by, req.method), mayAsk(ctx, by, req.method)))
    }
    case 'work.money.accept': {
      const p = paramsOf('work.money.accept', req)
      admit(ctx, by, req.method, jobOfWaiting(ctx, p.id))
      return handled(await accept(ctx, p.id, p.fields, p.workspaceId ? admit(ctx, by, req.method, p.workspaceId) : undefined, mayAsk(ctx, by, req.method)))
    }
    case 'work.money.drop': {
      const p = paramsOf('work.money.drop', req)
      admit(ctx, by, req.method, jobOfWaiting(ctx, p.id))
      return handled({ dropped: await drop(ctx, p.id, p.undo === true) })
    }
    case 'work.money.picture': {
      const p = paramsOf('work.money.picture', req)
      if (p.id) {
        admit(ctx, by, req.method, jobOfWaiting(ctx, p.id))
        return handled(await waitingPicture(ctx, p.id, p.part, signal))
      }
      if (!p.workspaceId || !p.receipt) throw new MoneyError('A picture is a waiting receipt by its id, or a filed one by its job and name.')
      return handled(await filedPicture(ctx, by, admit(ctx, by, req.method, p.workspaceId), p.receipt, p.part, signal))
    }
    case 'work.money.events': {
      const p = paramsOf('work.money.events', req)
      return handled({ events: await placed(ctx, admit(ctx, by, req.method, p.workspaceId)) })
    }
    case 'work.money.trip': {
      const p = paramsOf('work.money.trip', req)
      const ws = admit(ctx, by, req.method, p.workspaceId)
      const tripped = await addTrip(ctx, ws, p)
      // A trip and its pay change what every window on this job shows.
      if (!tripped.already) announce(ctx, ws.id)
      return handled(tripped)
    }
    case 'work.money.skip': {
      const p = paramsOf('work.money.skip', req)
      const ws = admit(ctx, by, req.method, p.workspaceId)
      const skipped = await skipEvent(ctx, ws, p.eventId, p.undo === true)
      announce(ctx, ws.id)
      return handled({ skipped })
    }
    case 'work.money.rate': {
      const p = paramsOf('work.money.rate', req)
      return handled(await setYearRate(ctx, admit(ctx, by, req.method, p.workspaceId), p.year, p.rate))
    }
    case 'work.money.export': {
      const p = paramsOf('work.money.export', req)
      return handled(await exportYear(ctx, admit(ctx, by, req.method, p.workspaceId), p, signal))
    }
    case 'work.money.invoiceNext': {
      const p = paramsOf('work.money.invoiceNext', req)
      return handled(await invoiceNext(ctx, admit(ctx, by, req.method, p.workspaceId), p.kind))
    }
    case 'work.money.invoice': {
      const p = paramsOf('work.money.invoice', req)
      return handled(await invoicePage(ctx, admit(ctx, by, req.method, p.workspaceId), p.key, p.invoice))
    }
    case 'work.money.keep': {
      const p = paramsOf('work.money.keep', req)
      const ws = admit(ctx, by, req.method, p.workspaceId)
      const kept = await keep(ctx, ws, p)
      if (kept.acted) announce(ctx, ws.id)
      return handled(kept)
    }
    default:
      return NOT_HANDLED
  }
}

const module: WorkModule = {
  id: 'money',
  ensure: ensureMoneyTables,
  handle,
  // A job's ledger is read by a thread of that job alone; a Work Chat, outside every job, gets no money tool.
  tools: (scope) => (scope.workspaceId ? moneyTools : []),
  preamble: (scope) =>
    scope.workspaceId
      ? "Money: `money_read` reads this job's ledger (a sheet the owner keeps). `money_add` leaves an entry and `money_receipt` a receipt's file in the owner's To confirm list. You never write the ledger: nothing you add is in it until the owner accepts it in the Money view, so never say an entry was recorded."
      : null,
  convert: MONEY_CONVERTERS,
  search: [moneySearch],
  start(ctx) {
    const stopReading = resume(ctx)
    pruneTrips(ctx)
    const off = registerFileMoved(movedHook(ctx))
    return () => {
      stopReading()
      off()
    }
  },
  workspaceRemoved(workspaceId, ctx) {
    forgetJob(ctx, workspaceId)
    dropWorkspace(ctx, workspaceId)
  }
}

// `tells` rides beside the module until the digest declares it on WorkModule; then it moves into the literal above.
export const money: WorkModule = Object.assign(module, { tells: MONEY_TELLS })
