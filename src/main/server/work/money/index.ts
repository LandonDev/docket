import { join } from 'node:path'
import type { ClientRequest } from '@shared/contract'
import { MONEY_OWNER_ONLY, MoneyRequestSchemas, type MoneyBooks, type MoneyState } from '@shared/contract-work-money'
import { handled, NOT_HANDLED, type Handled } from '@shared/work'
import { FenceError } from '../../remote/fence'
import type { Caller, WorkCtx, WorkModule } from '../modules'
import { addRow, editRow, MONEY_FOLDER, openBooks, payRow, restoreColumns } from './book'
import { booksHere, MoneyError, owedFor, readMoney, searchMoney, sumsFor } from './read'
import { dropWorkspace, ensureMoneyTables, workspaceOf, workspaces, type Workspace } from './store'
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
  return schema.shape.params.parse(req.params) as Params<M>
}

/**
 * Who may ask about a job's money. A thread's own call reaches its own job
 * alone, and none of the writes; a remote key reaches a job only when it
 * could have named the Money folder itself.
 */
function admit(ctx: WorkCtx, by: Caller, method: string, workspaceId: string): Workspace {
  if (by.kind === 'model') {
    if (MONEY_OWNER_ONLY.has(method)) throw new MoneyError('Only the owner writes the ledger. A thread adds with money_add or money_receipt, which wait for his accept.')
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

async function handle(req: ClientRequest, ctx: WorkCtx, by: Caller): Promise<Handled> {
  switch (req.method) {
    case 'work.money.state': {
      const jobs = reachable(ctx, by, req.method).map((ws) => ({ workspaceId: ws.id, name: ws.name, sector: ws.sector, made: booksHere(ctx, ws.id) !== null }))
      return handled({ host: ctx.host, jobs } satisfies MoneyState)
    }
    case 'work.money.open': {
      const p = paramsOf('work.money.open', req)
      const ws = admit(ctx, by, req.method, p.workspaceId)
      const books = await openBooks(ctx, ws)
      if (p.restore) await restoreColumns(ctx, ws, books)
      return handled({ ledger: { at: 'file', host: ctx.host, path: books.ledger }, mileage: { at: 'file', host: ctx.host, path: books.mileage } } satisfies MoneyBooks)
    }
    case 'work.money.read': {
      const p = paramsOf('work.money.read', req)
      return handled(await readMoney(ctx, admit(ctx, by, req.method, p.workspaceId), { from: p.from, to: p.to }))
    }
    case 'work.money.entry': {
      const p = paramsOf('work.money.entry', req)
      const ws = admit(ctx, by, req.method, p.workspaceId)
      if (!p.at) return handled(await addRow(ctx, ws, p.fields))
      const books = booksHere(ctx, ws.id)
      return handled(books ? await editRow(ctx, ws, books, p.at, p.fields) : { changed: true })
    }
    case 'work.money.paid': {
      const p = paramsOf('work.money.paid', req)
      const ws = admit(ctx, by, req.method, p.workspaceId)
      const books = booksHere(ctx, ws.id)
      return handled(books ? await payRow(ctx, ws, books, p.at, p.on) : { changed: true })
    }
    case 'work.money.sums': {
      const p = paramsOf('work.money.sums', req)
      if (p.workspaceId) return handled(await sumsFor(ctx, { from: p.from, to: p.to }, admit(ctx, by, req.method, p.workspaceId).id))
      const mine = new Set(reachable(ctx, by, req.method).map((ws) => ws.id))
      const all = await sumsFor(ctx, { from: p.from, to: p.to })
      return handled({ rows: all.rows.filter((r) => mine.has(r.workspaceId)) })
    }
    case 'work.money.owed': {
      const p = paramsOf('work.money.owed', req)
      if (p.workspaceId) return handled(await owedFor(ctx, admit(ctx, by, req.method, p.workspaceId).id))
      const mine = reachable(ctx, by, req.method)
      const parts = await Promise.all(mine.map((ws) => owedFor(ctx, ws.id)))
      const rows = parts.flatMap((part) => part.rows).sort((a, b) => (a.since ?? '9999').localeCompare(b.since ?? '9999'))
      return handled({ rows, toConfirm: parts.reduce((n, part) => n + part.toConfirm, 0) })
    }
    case 'work.money.search': {
      const p = paramsOf('work.money.search', req)
      return handled(await searchMoney(ctx, admit(ctx, by, req.method, p.workspaceId), p.query, p.limit))
    }
    default:
      return NOT_HANDLED
  }
}

export const money: WorkModule = {
  id: 'money',
  ensure: ensureMoneyTables,
  handle,
  // A job's ledger is read by a thread of that job alone; a Work Chat, outside every job, gets no money tool.
  tools: (scope) => (scope.workspaceId ? moneyTools : []),
  preamble: (scope) =>
    scope.workspaceId ? "Money: `money_read` reads this job's ledger (a sheet the owner keeps). You never write the ledger: what you add with a money tool waits for the owner's accept in the Money view." : null,
  workspaceRemoved: (workspaceId, ctx) => dropWorkspace(ctx, workspaceId)
}
