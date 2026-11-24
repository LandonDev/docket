import { randomUUID } from 'node:crypto'
import type { EntryFields, MoneyActed } from '@shared/contract-work-money'
import { formatDay, formatMoney } from '@shared/work/money'
import type { WorkCtx } from '../modules'
import { addRow, appendRow, openBooks, newRef, valuesOf, writtenRow } from './book'
import { keyed } from './inbox'
import { ledgerOf, MoneyError } from './read'
import type { Workspace } from './store'

/**
 * A plain entry from the form under the dialog's own key (docs/agents/work-money.md
 * "Adding"), as a trip and an invoice are: a Save whose answer was lost and is
 * pressed again files one row. The key's outcome is a row of
 * `work_money_inbox` (source `entry`, never in To confirm): the Ref the row
 * will carry and the figures noted before the ledger is touched, then what
 * was filed. Taken up again, the note's row is looked for by that Ref; a
 * ledger that cannot be read is never taken for one without it.
 */

type Ctx = Pick<WorkCtx, 'db' | 'service' | 'log' | 'host' | 'dataDir'>
interface Noted {
  intent?: { ref: string; workspaceId: string; fields: EntryFields }
  acted?: MoneyActed
  as?: EntryFields
}
type Row = { id: string; workspace_id: string; state: string; ref: string | null }

export function addEntry(ctx: Ctx, ws: Workspace, fields: EntryFields, key?: string): Promise<MoneyActed> {
  if (!key) return addRow(ctx, ws, fields)
  return keyed(`entry:${key}`, () => entryOnce(ctx, ws, fields, `entry:${key}`))
}

const KEYS = ['date', 'who', 'what', 'category', 'way', 'amount', 'status', 'paidOn'] as const
/** The same Save again is answered as the first; one that asks for other figures is told what was saved. */
function answer(acted: MoneyActed, as: EntryFields, fields: EntryFields): MoneyActed {
  if (KEYS.every((k) => (as[k] ?? null) === (fields[k] ?? null))) return acted
  throw new MoneyError(`That entry was already saved: ${formatMoney(as.amount)} on ${formatDay(as.date)}. Change its row in the ledger.`)
}

async function entryOnce(ctx: Ctx, ws: Workspace, fields: EntryFields, key: string): Promise<MoneyActed> {
  const before = ctx.db.prepare('SELECT id, workspace_id, state, ref FROM work_money_inbox WHERE key = ?').get(key) as Row | undefined
  if (before && before.workspace_id !== ws.id) throw new MoneyError('That entry was saved in another job.')
  const noted = before?.ref ? (JSON.parse(before.ref) as Noted) : null
  if (before?.state === 'filed' && noted?.acted && noted.as) return answer(noted.acted, noted.as, fields)
  const id = before?.id ?? randomUUID()
  if (!before) {
    const now = Date.now()
    ctx.db.prepare("INSERT INTO work_money_inbox (id, key, workspace_id, state, source, created_at, updated_at) VALUES (?, ?, ?, 'partial', 'entry', ?, ?)").run(id, key, ws.id, now, now)
  }
  const note = (ref: string | null): void => void ctx.db.prepare('UPDATE work_money_inbox SET ref = ?, updated_at = ? WHERE id = ?').run(ref, Date.now(), id)
  const done = (got: { ref: string | null; row: number; suggested: boolean }, as: EntryFields): MoneyActed => {
    const acted: MoneyActed = { ok: true, ref: got.ref, row: got.row, ...(got.suggested ? { suggested: true as const } : {}) }
    ctx.db.prepare("UPDATE work_money_inbox SET state = 'filed', ref = ?, updated_at = ? WHERE id = ?").run(JSON.stringify({ acted, as } satisfies Noted), Date.now(), id)
    return acted
  }
  // A ledger gone from its place while this note stands is not replaced by an empty one (`openBooks`).
  const books = await openBooks(ctx, ws, 'ledger')
  // A first Save whose answer was lost: its row is looked for by its Ref in a ledger that was read, never guessed.
  if (noted?.intent) {
    const found = writtenRow(await ledgerOf(ctx, books), { ref: noted.intent.ref })
    if (found) return answer(done(found, noted.intent.fields), noted.intent.fields, fields)
  }
  const ref = newRef()
  note(JSON.stringify({ intent: { ref, workspaceId: ws.id, fields } } satisfies Noted))
  let got: Awaited<ReturnType<typeof appendRow>>
  try {
    got = await appendRow(ctx, ws, books, valuesOf(fields), { ref })
  } catch (err) {
    // As for a receipt: landed though its answer did not, it is saved; not readable now, the note stays; not there, cleared.
    const landed = await ledgerOf(ctx, books).then(
      (l) => writtenRow(l, { ref }),
      () => undefined
    )
    if (landed) return done(landed, fields)
    if (landed === undefined) throw err
    note(null)
    throw err
  }
  return done(got, fields)
}
