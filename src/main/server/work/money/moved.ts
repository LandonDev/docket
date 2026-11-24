import { existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { columnLetter } from '@shared/work/money'
import type { FileMoved } from '../files/hooks'
import type { WorkCtx } from '../modules'
import { locked, MONEY_FOLDER, othersCanOpen } from './book'
import { booksHere, forgetGrid, ledgerOf } from './read'
import { booksOf, putBooks, workspaces } from './store'

/**
 * A file of Money's that he renames or moves in Files keeps its link
 * (docs/agents/work-money.md "A file that moves"). The ledger and the
 * mileage log are followed in the books' own row, at once. A receipt's new
 * path is written into its row's Receipt cell, a moment later: the hook
 * runs inside the rename's savepoint and may not wait, so the cell is
 * written after it, and only once the file is truly at its new place.
 */

type Ctx = Pick<WorkCtx, 'db' | 'service' | 'log' | 'host' | 'dataDir'>

const under = (root: string, path: string): string | null => {
  const rel = relative(root, path)
  return rel && !rel.startsWith('..') && !rel.startsWith(sep) ? rel.split(sep).join('/') : null
}

/**
 * Rewrites every Receipt cell that held `from` to `to`, both paths under the
 * job's Money folder. The column is found by its header in the sheet as it
 * stands, and its cells read raw: a ledger that cannot be read as money just
 * now (he renamed Out while he works on it) still has its link kept. Only
 * the Receipt column is written: a cell of his elsewhere that reads the same
 * (a formula that mirrors Receipt) is his, and stays. With no Receipt header
 * nothing is written: no cell is known to be the link.
 */
export async function relink(ctx: Ctx, workspaceId: string, from: string, to: string): Promise<number> {
  const ws = workspaces(ctx).find((w) => w.id === workspaceId)
  if (!ws) return 0
  return locked(workspaceId, async () => {
    // The ledger as it stands now, and only while it lies in the job's own folder: one he moved out of it is not written.
    const books = booksHere(ctx, workspaceId)
    if (!books) return 0
    const ledger = await ledgerOf(ctx, books)
    const named = ledger.grid.header.flatMap((h, i) => (String(h ?? '').trim().toLowerCase() === 'receipt' ? [i] : []))
    // Two Receipt headers: which is the link cannot be said, and nothing is written.
    if (named.length !== 1) return 0
    const col = named[0]
    const cells = ledger.grid.body.flatMap((line, i) => (line[col] === from ? [{ at: `${columnLetter(col)}${i + 2}`, v: to }] : []))
    const shared = cells.length > 0 && (await othersCanOpen(ctx, books.ledger, ledger.grid.shared))
    if (cells.length) await ctx.service.internal('/internal/sheet/cells', { sheet: { tcsheet: books.ledger }, cells, by: 'money', suggest: shared, ...(shared ? { reason: 'Money' } : {}) })
    return cells.length
  })
}

/** What Files calls on a rename or a move, for as long as Money runs. */
export function movedHook(ctx: Ctx): FileMoved {
  return (from, to) => {
    if (from.at !== 'file' || to.at !== 'file' || from.host !== ctx.host || to.host !== ctx.host) return
    for (const ws of workspaces(ctx)) {
      const root = join(ws.path, MONEY_FOLDER)
      const books = booksOf(ctx, ws.id)
      if (books && (from.path === books.ledger || from.path === books.mileage)) {
        putBooks(ctx, { workspaceId: ws.id, ledger: from.path === books.ledger ? to.path : books.ledger, mileage: from.path === books.mileage ? to.path : books.mileage })
        forgetGrid(from.path)
        return
      }
      const was = under(root, from.path)
      if (!was) continue
      // Moved out of the Money folder: the cell keeps the old name, which then opens nothing, and he sees it.
      const now = under(root, to.path)
      if (!now) return
      setTimeout(() => {
        if (!existsSync(to.path) || existsSync(from.path)) return
        relink(ctx, ws.id, was, now).catch((err) => ctx.log(`money: a moved receipt kept its old name in the ledger (${String(err)})`))
      }, 0)
      return
    }
  }
}
