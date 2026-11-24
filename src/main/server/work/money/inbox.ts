import { randomUUID } from 'node:crypto'
import { constants, existsSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import type { EntryFields, MoneyActed, MoneyPicture, MoneyReceived, MoneySource, ReceiveParams, ToConfirm } from '@shared/contract-work-money'
import { MONEY_FILE_MAX, receiptLines } from '@shared/contract-work-money'
import { errorText, type SectorKey } from '@shared/work/ids'
import { fileWord, formatDay, formatMoney, knownSellers, parseReceipt, receiptFileName, receiptName, type ReceiptFields, type ReceiptLine } from '@shared/work/money'
import { FenceError } from '../../remote/fence'
import type { Caller, WorkCtx } from '../modules'
import { appendRow, insideJob, MONEY_FOLDER, moneyFolder, newRef, openBooks, valuesOf, writtenRow } from './book'
import { pageFolder, partOf, takePart } from './parts'
import { booksHere, ledgerOf, MoneyError, waiting } from './read'
import { extOf, isReceiptFile, pdfPicture, readReceipt, shownPicture } from './reader'
import { workspaceOf, type Workspace } from './store'

/**
 * What waits for his accept (docs/agents/work-money.md "In: four ways, one
 * list"). A dropped file, a phone's scan, a mail's file and an agent's
 * entry each make one row in `work_money_inbox`, by the sender's own key,
 * so a retry files nothing twice. A file is kept under this host's data
 * folder while it waits; his accept moves it into the job's own folder and
 * appends the ledger's row. Nothing reaches the ledger on a guess he
 * cannot see.
 */

type State = 'partial' | 'reading' | 'ready' | 'filed' | 'dropped'
type Ctx = Pick<WorkCtx, 'db' | 'dataDir' | 'host' | 'service' | 'log' | 'push' | 'reaches' | 'convert'>

/** What a waiting row holds beside what was read: which way the money went and what it was for (an agent's entry says). */
export type Waiting = ReceiptFields & { way?: 'in' | 'out'; what?: string }

interface Row {
  id: string
  key: string
  workspace_id: string
  state: State
  source: MoneySource
  name: string | null
  mime: string | null
  file: string | null
  lines: string | null
  fields: string | null
  session_id: string | null
  ref: string | null
  error: string | null
  created_at: number
  updated_at: number
}

const incoming = (ctx: Pick<WorkCtx, 'dataDir'>): string => join(ctx.dataDir, 'work-money', 'incoming')
const folderOf = (ctx: Pick<WorkCtx, 'dataDir'>, id: string): string => join(incoming(ctx), id)
/** Where a row's bytes wait: a receipt's under its own id, a printed page's (a `kept` row, key `kept:<key>`) where `keep` puts its parts. */
const scratchOf = (ctx: Pick<WorkCtx, 'dataDir'>, row: { id: string; key: string; source: string; workspace_id: string }): string =>
  row.source === 'kept' ? pageFolder(ctx.dataDir, row.workspace_id, row.key.replace(/^kept:/, '')) : folderOf(ctx, row.id)

const byKey = (ctx: Ctx, key: string): Row | undefined => ctx.db.prepare('SELECT * FROM work_money_inbox WHERE key = ?').get(key) as Row | undefined
const byId = (ctx: Pick<WorkCtx, 'db'>, id: string): Row | undefined => ctx.db.prepare('SELECT * FROM work_money_inbox WHERE id = ?').get(id) as Row | undefined
const fieldsOf = (row: Row): Waiting => ({ amount: null, date: null, who: null, category: null, ...(row.fields ? (JSON.parse(row.fields) as Waiting) : {}) })

function set(ctx: Ctx, id: string, patch: Partial<Pick<Row, 'state' | 'file' | 'lines' | 'fields' | 'ref' | 'error' | 'workspace_id'>>, now = Date.now()): void {
  const keys = Object.keys(patch) as (keyof typeof patch)[]
  ctx.db.prepare(`UPDATE work_money_inbox SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => patch[k] ?? null), now, id)
}

/** Tells every window how many wait in a job now. */
export function announce(ctx: Pick<WorkCtx, 'db' | 'push'>, workspaceId: string): void {
  ctx.push({ push: 'work.money', workspaceId, toConfirm: waiting(ctx, workspaceId) })
}

/**
 * A waiting one the owner did not put there himself (the phone's, an
 * agent's) is told through the digest's `ctx.tell`, with no `by`: it may
 * wait. Until the digest's first milestone is on master there is no such
 * member, and this does nothing.
 */
type Tell = ((t: { kind: string; workspaceId: string | null; title: string; detail?: string; open?: unknown; key: string }) => void) & { done?(key: string): void }
const tellOf = (ctx: object): Tell | undefined => (ctx as { tell?: Tell }).tell
const tellKey = (id: string): string => `money:${id}`
function tell(ctx: Ctx, row: Pick<Row, 'id' | 'workspace_id' | 'source' | 'name'>, fields: Waiting): void {
  if (row.source === 'drop' || row.source === 'mail') return
  const what = [fields.who, fields.amount !== null ? `$${(fields.amount / 100).toFixed(2)}` : null].filter(Boolean).join(', ')
  tellOf(ctx)?.({ kind: 'money.confirm', workspaceId: row.workspace_id, title: 'A receipt to confirm', ...(what || row.name ? { detail: what || row.name! } : {}), open: { view: 'money', workspaceId: row.workspace_id }, key: tellKey(row.id) })
}
const told = (ctx: Ctx, id: string): void => void tellOf(ctx)?.done?.(tellKey(id))

/**
 * The job a receipt or a parse names, among the ones its caller may ask
 * about: a workspace of this host, or the first Work workspace here in the
 * sector it names. The module hands this in (`index.ts`), so no ledger is
 * opened for a caller who could not have named it.
 */
export type JobFor = (p: { workspaceId?: string; sector?: SectorKey | null }) => Workspace | null

/** One at a time for each sender's key: an upload's parts, its putting together and its filing never run twice at once, and the second sees what the first left. */
const keys = new Map<string, Promise<unknown>>()
export function keyed<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (keys.get(key) ?? Promise.resolve()).then(fn, fn)
  const tail = run.catch(() => {})
  keys.set(key, tail)
  void tail.then(() => keys.get(key) === tail && keys.delete(key))
  return run
}

/** A name safe as a file's own in this host's folder: no folder part, nothing that could leave it. */
const safeName = (name: string): string => {
  const ext = extOf(name)
  return `${fileWord(basename(name.replace(/\\/g, '/')).replace(/\.[^.]*$/, ''), 80) || 'Receipt'}.${ext}`
}

function insert(
  ctx: Ctx,
  r: { id?: string; key: string; workspaceId: string; state: State; source: MoneySource; name?: string; mime?: string; file?: string; sessionId?: string; fields?: Waiting; lines?: ReceiptLine[] },
  now = Date.now()
): string {
  const id = r.id ?? randomUUID()
  ctx.db
    .prepare('INSERT INTO work_money_inbox (id, key, workspace_id, state, source, name, mime, file, lines, fields, session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, r.key, r.workspaceId, r.state, r.source, r.name ?? null, r.mime ?? null, r.file ?? null, r.lines ? JSON.stringify(r.lines) : null, r.fields ? JSON.stringify(r.fields) : null, r.sessionId ?? null, now, now)
  return id
}

/** What the ledger knows of each seller, for the parser; nothing when the job has no ledger yet or it cannot be read. */
async function knownOf(ctx: Ctx, workspaceId: string): Promise<Record<string, string>> {
  const books = booksHere(ctx, workspaceId)
  if (!books) return {}
  return ledgerOf(ctx, books).then(
    (l) => knownSellers(l.rows),
    () => ({})
  )
}

/** The one parser, with what the job's ledger knows of each seller. With no job the caller may ask about, the receipt is read all the same, with no seller's history. */
export async function parseFor(ctx: Ctx, lines: readonly ReceiptLine[], ws: Workspace | null, sector?: SectorKey | null): Promise<ReceiptFields> {
  return parseReceipt(lines, { sector: ws?.sector ?? sector ?? null, known: ws ? await knownOf(ctx, ws.id) : {} })
}

/**
 * What he typed where he sent it from wins over what was read. A field he
 * left empty takes the reading, unless the sender had already shown him
 * what was read (`seen`): then empty is his own word, and stays empty.
 */
const merged = (read: ReceiptFields, typed?: Partial<Waiting>, seen = false): Waiting =>
  seen && typed
    ? { amount: null, date: null, who: null, category: null, ...typed }
    : {
        ...typed,
        amount: typed?.amount ?? read.amount,
        date: typed?.date ?? read.date,
        who: typed?.who || read.who,
        category: typed?.category || read.category
      }

const reading = new Map<string, AbortController>()
/** How long a discarded receipt's file is kept, so a discard can be undone. */
export const DROPPED_KEEP_MS = 7 * 24 * 3600_000

/** Reads a waiting file in the background and makes it ready, with whatever could be read. A file that cannot be read is ready with empty fields. */
export function read(ctx: Ctx, id: string): Promise<void> {
  const stop = new AbortController()
  reading.set(id, stop)
  return (async () => {
    const row = byId(ctx, id)
    if (!row || row.state !== 'reading') return
    let lines: ReceiptLine[] = []
    let error: string | null = null
    try {
      // With no file to read (it never arrived, or is gone) it is ready as it stands: nothing waits as "reading" for ever.
      if (row.file && existsSync(row.file)) lines = await readReceipt(ctx, row.file, stop.signal)
      else error = 'no file'
    } catch (err) {
      error = errorText(err)
      ctx.log(`money: ${row.name ?? id} was not read (${error})`)
    }
    const now = byId(ctx, id)
    // Discarded or accepted while it was being read: his word stands.
    if (!now || now.state !== 'reading') return
    const ws = workspaceOf(ctx, now.workspace_id)
    const fields = merged(parseReceipt(lines, { sector: ws?.sector ?? null, known: await knownOf(ctx, now.workspace_id) }), fieldsOf(now))
    // His discard or accept during the read stands: only a row still being read is made ready.
    const made = ctx.db
      .prepare("UPDATE work_money_inbox SET state = 'ready', lines = ?, fields = ?, error = ?, updated_at = ? WHERE id = ? AND state = 'reading'")
      .run(JSON.stringify(lines), JSON.stringify(fields), error, Date.now(), id)
    if (!made.changes) return
    announce(ctx, now.workspace_id)
    tell(ctx, now, fields)
  })().finally(() => reading.delete(id))
}

/** Reading picks up where a restart left it, and parts nobody finished in a day go. Returns what stops the reads in hand. */
export function resume(ctx: Ctx, now = Date.now()): () => void {
  // Parts nobody finished: never a row that carries a filing's note (a keep begun and not settled), which its own Create settles.
  const stale = ctx.db.prepare("SELECT id, key, source, workspace_id FROM work_money_inbox WHERE state = 'partial' AND ref IS NULL AND updated_at < ?").all(now - 24 * 3600_000) as { id: string; key: string; source: string; workspace_id: string }[]
  for (const row of stale) {
    rmSync(scratchOf(ctx, row), { recursive: true, force: true })
    ctx.db.prepare('DELETE FROM work_money_inbox WHERE id = ?').run(row.id)
  }
  // A discarded receipt's file is kept a week, for Undo; after that only its row stays.
  for (const { id } of ctx.db.prepare("SELECT id FROM work_money_inbox WHERE state = 'dropped' AND file IS NOT NULL AND updated_at < ?").all(now - DROPPED_KEEP_MS) as { id: string }[]) {
    rmSync(folderOf(ctx, id), { recursive: true, force: true })
    ctx.db.prepare('UPDATE work_money_inbox SET file = NULL WHERE id = ?').run(id)
  }
  // A filed or dropped row is kept for good, as a sender's key and what came of it: a phone that lost the answer keeps
  // its draft and may send it again months later, and must hear "filed" or "discarded", never file it afresh. After a
  // month only what was read goes; the key, the outcome and what was filed stay (a few hundred bytes a receipt).
  ctx.db.prepare("UPDATE work_money_inbox SET lines = NULL WHERE state IN ('filed', 'dropped') AND lines IS NOT NULL AND updated_at < ?").run(now - 30 * 24 * 3600_000)
  for (const { id } of ctx.db.prepare("SELECT id FROM work_money_inbox WHERE state = 'reading'").all() as { id: string }[]) void read(ctx, id)
  return () => {
    for (const stop of reading.values()) stop.abort()
  }
}

function answer(row: Pick<Row, 'id' | 'state' | 'ref'>): MoneyReceived {
  const acted = row.state === 'filed' && row.ref ? filedOf(row).acted : null
  return { id: row.id, state: row.state, ...(acted && 'ok' in acted && acted.suggested ? { suggested: true } : {}) }
}

/**
 * A receipt comes in: its bytes in parts, or a file of this host. The whole
 * file waits under this host's data folder. With the sender's own lines
 * (the phone's reader) it is not read again; with fields that hold an
 * amount and a date it is filed at once, as his own accept.
 */
export function receive(ctx: Ctx, p: ReceiveParams, by: Caller, jobFor: JobFor, may: (workspaceId: string) => boolean = () => true): Promise<MoneyReceived> {
  if ((p.file !== undefined) === (p.dataBase64 !== undefined)) throw new MoneyError('A receipt is its bytes or a file, one of the two.')
  if (!p.workspaceId && !p.sector) throw new MoneyError('A receipt names its job.')
  // A file with no extension Money knows is taken by its type (a mail's attachment), under a name that says what it is.
  const filed = receiptFileName(p.name, p.mime)
  if (!filed) throw new MoneyError('Money files pictures and PDFs.')
  const ws = jobFor(p)
  if (!ws) throw new MoneyError(p.workspaceId ? 'That job is not on this computer.' : 'No workspace for that job on this computer.')
  // One at a time a key: two parts that land together, or the last part sent twice, put the file together and file it once.
  return keyed(`in:${p.key}`, () => receiveOnce(ctx, { ...p, name: filed }, by, ws, may))
}

async function receiveOnce(ctx: Ctx, p: ReceiveParams, by: Caller, ws: Workspace, may: (workspaceId: string) => boolean): Promise<MoneyReceived> {
  const before = byKey(ctx, p.key)
  // A key is one receipt of one job: sent again under another job it is neither finished there nor answered from here.
  if (before && before.workspace_id !== ws.id) throw new MoneyError('That receipt was sent to another job. Scan it again for this one.')
  if (before && before.state !== 'partial') {
    // He accepted it where he sent it from (an amount and a date) and it still waits here: its filing failed the
    // first time (the ledger's columns, say). The same Save again tries the filing again, and answers what came of it.
    if ((before.state === 'ready' || before.state === 'reading') && p.fields?.amount && p.fields.date) {
      const acted = await accept(ctx, before.id, phoneFields(p.fields), ws, may, { phone: true })
      return { id: before.id, state: 'filed', ...('ok' in acted && acted.suggested ? { suggested: true } : {}) }
    }
    // Filed already, and his Save again says other figures than were filed (he edited the draft after an answer was
    // lost): "filed" would let the phone drop a draft whose figures are not the ledger's. He is told what was filed.
    // After a complete Save there, a field he cleared since is such a change too; a draft he sent incomplete and filed
    // on the desktop is answered as filed.
    if (before.state === 'filed' && before.ref) {
      const as = filedOf(before).as
      if (p.fields?.amount && p.fields.date) unlike(before, phoneFields(p.fields), ws.id, may)
      else if (p.fields && as?.phone) unlike(before, null, ws.id, may)
      else if (as && as.workspaceId !== ws.id && !may(as.workspaceId)) return { id: before.id, state: 'filed' }
    }
    return answer(before)
  }
  const id = before?.id ?? insert(ctx, { key: p.key, workspaceId: ws.id, state: 'partial', source: p.source, name: basename(p.name.replace(/\\/g, '/')).slice(0, 255), mime: p.mime })
  const dir = folderOf(ctx, id)
  const name = safeName(p.name)

  let whole: string | null
  if (p.file) {
    const source = p.file
    if (source.at !== 'file') throw new MoneyError('Only a file can be filed as a receipt.')
    if (source.host !== ctx.host) throw new MoneyError('That file is on another computer.')
    if (!ctx.reaches(by, source.path)) throw new FenceError('work.money.receive')
    const info = statSync(source.path, { throwIfNoEntry: false })
    if (!info?.isFile()) throw new MoneyError(`${basename(source.path)} is not a file.`)
    if (info.size > MONEY_FILE_MAX) throw new MoneyError('That file is over 25 MB.')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    whole = join(dir, name)
    await copyFile(source.path, whole)
  } else {
    if (p.part === undefined || p.parts === undefined) throw new MoneyError('Bytes come as a part of so many parts.')
    whole = await takePart(dir, name, { part: p.part, parts: p.parts, dataBase64: p.dataBase64! })
    if (!whole) {
      set(ctx, id, { state: 'partial' })
      return { id, state: 'partial' }
    }
  }

  const typed = p.fields ? { ...p.fields, way: 'out' as const } : undefined
  if (p.lines) {
    const fields = merged(await parseFor(ctx, receiptLines(p.lines), ws), typed, p.seen === true)
    set(ctx, id, { state: 'ready', file: whole, lines: JSON.stringify(p.lines), fields: JSON.stringify(fields) })
  } else {
    set(ctx, id, { state: 'reading', file: whole, ...(typed ? { fields: JSON.stringify(typed) } : {}) })
  }

  // He accepted it where he sent it from: an amount and a date are enough to file it.
  if (p.fields?.amount && p.fields.date) {
    set(ctx, id, { state: 'ready' })
    const acted = await accept(ctx, id, phoneFields(p.fields), ws, may, { phone: true })
    return { id, state: 'filed', ...('ok' in acted && acted.suggested ? { suggested: true } : {}) }
  }
  announce(ctx, ws.id)
  const row = byId(ctx, id)!
  if (row.state === 'reading') void read(ctx, id)
  else tell(ctx, row, fieldsOf(row))
  return answer(row)
}

/** What a Save where he sent it from files: his figures, money out, paid. */
const phoneFields = (f: NonNullable<ReceiveParams['fields']>): EntryFields => ({ date: f.date!, who: f.who ?? '', what: '', category: f.category ?? '', way: 'out', amount: f.amount!, status: 'Paid' })

/** What a filed one was filed as, beside the answer it gave: the fields and the job; `phone`, a complete Save where he sent it from. */
interface Filed {
  fields: EntryFields
  workspaceId: string
  phone?: boolean
}
const FILED_KEYS = ['date', 'who', 'what', 'category', 'way', 'amount', 'status', 'paidOn'] as const
function filedOf(row: Pick<Row, 'ref'>): { acted: MoneyActed; as: Filed | null } {
  const { as, ...acted } = JSON.parse(row.ref!) as MoneyActed & { as?: Filed }
  return { acted: acted as MoneyActed, as: as ?? null }
}

/** Said to a caller who may not ask about the job a receipt was filed into: that it was, and nothing of that job's figures. */
const FILED_ELSEWHERE = 'That receipt was already filed in another job.'

/**
 * A press on one that is filed already answers the first only when it asks
 * for what was filed: the same figures, the same job. One that differs (a
 * second window, a draft edited after a lost answer) is told what was
 * filed, so nothing closes on figures the ledger does not hold; told only
 * the figures of a job the caller may ask about. A row filed before what it
 * was filed as was kept answers as it did.
 */
function unlike(row: Pick<Row, 'ref'>, fields: EntryFields | null, workspaceId: string, may: (workspaceId: string) => boolean): void {
  if (!row.ref) return
  const { as } = filedOf(row)
  if (!as) return
  if (as.workspaceId !== workspaceId && !may(as.workspaceId)) throw new MoneyError(FILED_ELSEWHERE)
  const same = fields !== null && as.workspaceId === workspaceId && FILED_KEYS.every((k) => (as.fields[k] ?? null) === (fields[k] ?? null))
  if (same) return
  const elsewhere = as.workspaceId !== workspaceId ? ' in another job' : ''
  throw new MoneyError(`That receipt was already filed${elsewhere}: ${formatMoney(as.fields.amount)} on ${formatDay(as.fields.date)}. Change its row in the ledger.`)
}

/** An entry a thread leaves for his accept: it has fields, perhaps a file, and names its thread. */
export async function leave(ctx: Ctx, o: { key: string; ws: Workspace; sessionId: string; fields?: Waiting; file?: string }): Promise<{ id: string; state: State; fresh: boolean }> {
  const before = byKey(ctx, o.key)
  if (before) return { id: before.id, state: before.state, fresh: false }
  if (o.file) {
    if (!isReceiptFile(o.file)) throw new MoneyError('Money files pictures and PDFs.')
    const info = statSync(o.file, { throwIfNoEntry: false })
    if (!info?.isFile()) throw new MoneyError(`${basename(o.file)} is not a file on this computer.`)
    if (info.size > MONEY_FILE_MAX) throw new MoneyError('That file is over 25 MB.')
  }
  // With fields it is ready as the thread wrote it; with a file alone it is read like any receipt.
  const state: State = o.fields ? 'ready' : 'reading'
  const id = randomUUID()
  let whole: string | undefined
  if (o.file) {
    // The copy first: one that fails (the file went, the disk is full) leaves nothing waiting with a file it does not have.
    const dir = folderOf(ctx, id)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    whole = join(dir, safeName(o.file))
    try {
      await copyFile(o.file, whole)
    } catch (err) {
      rmSync(dir, { recursive: true, force: true })
      throw new MoneyError(`${basename(o.file)} could not be copied (${errorText(err)}).`)
    }
  }
  // Two of the same call at once: the first to land is the one, and the other's copy goes.
  if (byKey(ctx, o.key)) {
    rmSync(folderOf(ctx, id), { recursive: true, force: true })
    const first = byKey(ctx, o.key)!
    return { id: first.id, state: first.state, fresh: false }
  }
  insert(ctx, { id, key: o.key, workspaceId: o.ws.id, state, source: 'agent', name: o.file ? basename(o.file) : undefined, file: whole, sessionId: o.sessionId, fields: o.fields })
  announce(ctx, o.ws.id)
  if (state === 'reading') void read(ctx, id)
  else tell(ctx, { id, workspace_id: o.ws.id, source: 'agent', name: null }, { amount: null, date: null, who: null, category: null, ...o.fields })
  return { id, state, fresh: true }
}

/** A free name in a folder: the name itself, else "name (2).ext", "name (3).ext"… */
function freeName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let n = 2; ; n++) {
    const next = `${stem} (${n})${ext}`
    if (!existsSync(join(dir, next))) return next
  }
}

/**
 * Keeps a file in the job's Money folder under a name of its own, never
 * over another file (an exclusive copy), and answers its path under
 * `Money/` as the Receipt column holds it.
 */
export async function keepFile(ws: Workspace, from: string, sub: readonly string[], name: string): Promise<{ path: string; receipt: string }> {
  const dir = moneyFolder(ws, ...sub)
  for (let tries = 0; ; tries++) {
    const free = freeName(dir, name)
    try {
      await copyFile(from, join(dir, free), constants.COPYFILE_EXCL)
      return { path: join(dir, free), receipt: [...sub, free].join('/') }
    } catch (err) {
      // Another file took the name between the look and the copy: look again.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || tries > 20) throw err
    }
  }
}

/**
 * His accept: the file is kept under `Money/Receipts/<year>/` by its day,
 * seller and amount, the row is appended with the file's path in Receipt,
 * and the waiting one is filed. `to` sends it to another job. Every accept
 * and every discard of one receipt runs in that receipt's own queue, each
 * reading the row afresh when its turn comes: a second press (one that
 * waited behind a first that failed, too) never appends a second row.
 * `phone`: a complete Save where he sent it from.
 */
export function accept(ctx: Ctx, id: string, fields: EntryFields, to?: Workspace, may: (workspaceId: string) => boolean = () => true, o: { phone?: boolean } = {}): Promise<MoneyActed> {
  return turn(id, () => acceptOnce(ctx, id, fields, to, may, o.phone === true))
}
/** One receipt's queue: its accepts and discards, one after another, each after the last has ended however it ended. */
const turn = <T>(id: string, fn: () => Promise<T>): Promise<T> => keyed(`receipt:${id}`, fn)

/**
 * What an accept in hand means to write, noted on the waiting row before
 * the ledger is touched: the Ref its row will carry, the job, the file it
 * kept, and the figures of that press, which are what a row found later by
 * this note was filed with, whatever a later press asks for.
 */
interface Intent {
  ref: string
  workspaceId: string
  receipt?: string
  fields?: EntryFields
  phone?: boolean
}
function intentOf(row: Pick<Row, 'state' | 'ref'>): Intent | null {
  if (row.state === 'filed' || !row.ref) return null
  try {
    return (JSON.parse(row.ref) as { intent?: Intent }).intent ?? null
  } catch {
    return null
  }
}

/** A file an unfinished accept kept that no row came to name: it is that accept's own, and goes. */
const keptPath = (ws: Workspace, receipt: string): string => join(ws.path, MONEY_FOLDER, ...receipt.split('/').filter((p) => p && p !== '.' && p !== '..'))
function unkeep(ws: Workspace, receipt: string): void {
  const path = keptPath(ws, receipt)
  if (existsSync(path) && insideJob(ws, path)) rmSync(path, { force: true })
}

/** The waiting one is filed: its row is in the ledger (or waits there), its own copy of the file goes, and everyone who counts is told. */
function fileIt(ctx: Ctx, row: Row, ws: Workspace, acted: MoneyActed, fields: EntryFields, phone: boolean): MoneyActed {
  reading.get(row.id)?.abort()
  // `workspace_id` stays the job it was sent to: the sender's key is that job's, wherever he filed it. What it was
  // filed as stays beside the answer, so a later press that asks for other figures is told (`unlike`).
  set(ctx, row.id, { state: 'filed', ref: JSON.stringify({ ...acted, as: { fields, workspaceId: ws.id, ...(phone ? { phone: true } : {}) } satisfies Filed }), file: null })
  rmSync(folderOf(ctx, row.id), { recursive: true, force: true })
  announce(ctx, row.workspace_id)
  if (ws.id !== row.workspace_id) announce(ctx, ws.id)
  told(ctx, row.id)
  return acted
}

async function acceptOnce(ctx: Ctx, id: string, fields: EntryFields, to: Workspace | undefined, may: (workspaceId: string) => boolean, phone: boolean): Promise<MoneyActed> {
  const row = byId(ctx, id)
  if (!row || row.state === 'dropped' || row.state === 'partial') throw new MoneyError('That one is not waiting any more.')
  const target = (to ?? workspaceOf(ctx, row.workspace_id))?.id ?? row.workspace_id
  if (row.state === 'filed') {
    if (!row.ref) return { changed: true }
    unlike(row, fields, target, may)
    return filedOf(row).acted
  }
  // An accept of this one was begun and not seen to its end: settled first, by its own ledger.
  if (await settleBegun(ctx, row, may, fields, phone)) {
    // Filed as that press asked: its figures are the row's, whatever this one asks. A press that asks for other
    // figures is told what was filed (`unlike`), never answered as if its own had landed.
    const now = byId(ctx, id)!
    unlike(now, fields, target, may)
    return filedOf(now).acted
  }
  const ws = to ?? workspaceOf(ctx, row.workspace_id)
  if (!ws) throw new MoneyError('That job is not on this computer.')
  // The file it came with must still be here: a row is not filed for a receipt whose picture is gone.
  if (row.file && !existsSync(row.file)) throw new MoneyError("That receipt's file is no longer on this computer. Discard it, then add it again.")
  const books = await openBooks(ctx, ws, 'ledger')
  const ref = newRef()
  const note = (receipt?: string): void => set(ctx, id, { ref: JSON.stringify({ intent: { ref, workspaceId: ws.id, fields, ...(phone ? { phone: true } : {}), ...(receipt ? { receipt } : {}) } } satisfies { intent: Intent }) })
  note()
  let kept: { path: string; receipt: string } | null = null
  let got: Awaited<ReturnType<typeof appendRow>>
  try {
    if (row.file) {
      kept = await keepFile(ws, row.file, ['Receipts', fields.date.slice(0, 4)], receiptName({ date: fields.date, who: fields.who, amount: fields.amount }, extOf(row.file)))
      note(kept.receipt)
    }
    got = await appendRow(ctx, ws, books, { ...valuesOf(fields), ...(kept ? { Receipt: kept.receipt } : {}) }, { ref })
  } catch (err) {
    // The write may have landed though its answer did not (the sheet's reply was lost on the way): a fresh read
    // settles it. Landed: it is filed, with its file. Not readable now: nothing is known, so the file and the note
    // stay for the next accept to settle. Not there: no row, no kept file, and the waiting one is as it was.
    const landed = await ledgerOf(ctx, books).then(
      (l) => writtenRow(l, { ref, receipt: kept?.receipt }),
      () => undefined
    )
    if (landed) return fileIt(ctx, row, ws, { ok: true, ref: landed.ref, row: landed.row, ...(landed.suggested ? { suggested: true as const } : {}) }, fields, phone)
    if (landed === undefined) throw err
    if (kept) rmSync(kept.path, { force: true })
    set(ctx, id, { ref: null })
    throw err
  }
  return fileIt(ctx, row, ws, { ok: true, ref: got.ref, row: got.row, ...(got.suggested ? { suggested: true as const } : {}) }, fields, phone)
}

/**
 * An accept of this one that was begun and not seen to its end (the host
 * stopped, or the sheet's reply and the read after it were both lost)
 * is settled by the ledger it was filing into: its row is looked for by its
 * Ref, else by its file. Found: the receipt is filed as that press asked
 * (true). Read and not there: the file that accept kept goes and its note is
 * cleared (false). A ledger that cannot be read, or is no longer in the
 * job's folder (moved out of it, or gone from its place), is not "not
 * there": nothing is deleted, filed or cleared, and he is told. Every press
 * of a receipt, Save or Discard, settles this first.
 */
async function settleBegun(ctx: Ctx, row: Row, may: (workspaceId: string) => boolean, fields?: EntryFields, phone = false): Promise<boolean> {
  const begun = intentOf(row)
  if (!begun) return false
  const there = workspaceOf(ctx, begun.workspaceId)
  if (!there) throw new MoneyError('That receipt was being filed into a job that is not on this computer any more, so Money cannot tell whether it was.')
  // The job that accept was filing into may be another than the one this caller named (he was sending it to another
  // job): its ledger is read, and its file touched, only for a caller who may ask about that job too.
  if (!may(there.id)) throw new MoneyError('That receipt is being filed in another job. Finish it from there.')
  const books = booksHere(ctx, there.id)
  if (!books) throw new MoneyError(UNSETTLED)
  const ledger = await ledgerOf(ctx, books).catch(() => {
    throw new MoneyError(UNSETTLED)
  })
  const found = writtenRow(ledger, { ...begun, moved: !!begun.receipt && !existsSync(keptPath(there, begun.receipt)) })
  if (found) {
    fileIt(ctx, row, there, { ok: true, ref: found.ref, row: found.row, ...(found.suggested ? { suggested: true as const } : {}) }, begun.fields ?? fields ?? EMPTY_FIELDS, begun.fields ? begun.phone === true : phone)
    return true
  }
  if (begun.receipt) unkeep(there, begun.receipt)
  set(ctx, row.id, { ref: null })
  return false
}
const UNSETTLED = "Money cannot tell yet whether this receipt reached the ledger: the ledger it was being filed into cannot be read where it was. Put it back in the job's folder, then try again."
const EMPTY_FIELDS: EntryFields = { date: '', who: '', what: '', category: '', way: 'out', amount: 0, status: 'Paid' }

/**
 * A waiting one is dropped. Its file is kept (a phone's scan is the only
 * copy once the phone has let go of its draft), so `undo` puts it back in
 * To confirm as it was. A discard waits its turn behind an accept of the
 * same receipt, and answers whether it took: false when that accept filed
 * it first, or one begun before it is found in the ledger, so no window
 * says Discarded (or offers Undo) for a receipt in the ledger.
 */
export function drop(ctx: Ctx, id: string, undo = false, may: (workspaceId: string) => boolean = () => true): Promise<boolean> {
  return turn(id, async () => {
    const row = byId(ctx, id)
    if (!row) return false
    if (undo) {
      if (row.state !== 'dropped') return false
      set(ctx, id, { state: 'ready' })
      announce(ctx, row.workspace_id)
      return true
    }
    if (row.state === 'dropped') return true
    if (row.state === 'filed' || row.state === 'partial') return false
    // An accept of it begun and not settled may have landed: settled first, so a receipt in the ledger is never said
    // discarded. Filed: false. Not known: the error says so, and it still waits.
    if (await settleBegun(ctx, row, may)) return false
    reading.get(id)?.abort()
    set(ctx, id, { state: 'dropped' })
    announce(ctx, row.workspace_id)
    told(ctx, id)
    return true
  })
}

/** A workspace is gone: the files that waited for it go too. */
export function forgetJob(ctx: Pick<WorkCtx, 'db' | 'dataDir'>, workspaceId: string): void {
  for (const row of ctx.db.prepare('SELECT id, key, source, workspace_id FROM work_money_inbox WHERE workspace_id = ?').all(workspaceId) as { id: string; key: string; source: string; workspace_id: string }[]) {
    reading.get(row.id)?.abort()
    rmSync(scratchOf(ctx, row), { recursive: true, force: true })
  }
}

/** The job a waiting one belongs to, for the caller's fence. */
export const jobOfWaiting = (ctx: Pick<WorkCtx, 'db'>, id: string): string => {
  const row = byId(ctx, id)
  if (!row) throw new MoneyError('That one is not waiting any more.')
  return row.workspace_id
}

/** What waits in a job, the oldest first. */
export function toConfirm(ctx: Pick<WorkCtx, 'db'>, workspaceId: string): ToConfirm[] {
  const rows = ctx.db.prepare("SELECT * FROM work_money_inbox WHERE workspace_id = ? AND state IN ('reading', 'ready') ORDER BY created_at, id").all(workspaceId) as unknown as Row[]
  return rows.map((row) => ({
    id: row.id,
    state: row.state as 'reading' | 'ready',
    source: row.source,
    name: row.name,
    picture: row.file !== null,
    fields: fieldsOf(row),
    ...(row.session_id ? { threadId: row.session_id } : {}),
    at: row.created_at
  }))
}

const MIMES: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' }

/** A file of Money's as a picture the window shows, a part at a time: itself, its JPEG (a HEIC, a TIFF), or a PDF's first page. */
async function pictureOf(ctx: Ctx, path: string, name: string, part: number, signal?: AbortSignal): Promise<MoneyPicture> {
  const shown = extOf(path) === 'pdf' ? { path: await pdfPicture(ctx, path, signal), ext: 'png' } : await shownPicture(ctx, path, signal)
  if (!shown) throw new MoneyError('That file has no picture to show.')
  return { mime: MIMES[shown.ext] ?? 'application/octet-stream', name, ...partOf(shown.path, part) }
}

/** A waiting receipt's picture. */
export function waitingPicture(ctx: Ctx, id: string, part: number, signal?: AbortSignal): Promise<MoneyPicture> {
  const row = byId(ctx, id)
  if (!row?.file || !existsSync(row.file)) throw new MoneyError('That one has no picture.')
  return pictureOf(ctx, row.file, row.name ?? basename(row.file), part, signal)
}

/** A filed row's receipt, by the Receipt cell: a file inside the job's own Money folder and nowhere else. */
export function filedPicture(ctx: Ctx, by: Caller, ws: Workspace, receipt: string, part: number, signal?: AbortSignal): Promise<MoneyPicture> {
  const root = join(ws.path, MONEY_FOLDER)
  const path = join(root, ...receipt.split(/[\\/]/).filter((p) => p && p !== '.' && p !== '..'))
  let real: string
  try {
    // The Money folder itself must lie in the job's own folder: one that is a link to another job's shows none of that job's files.
    if (!insideJob(ws, root)) throw new Error('outside')
    real = realpathSync(path)
    if (!real.startsWith(realpathSync(root) + sep)) throw new Error('outside')
  } catch {
    throw new MoneyError('That receipt is not in the Money folder any more.')
  }
  if (!isReceiptFile(real)) throw new MoneyError('That file has no picture to show.')
  if (!ctx.reaches(by, real)) throw new FenceError('work.money.picture')
  return pictureOf(ctx, real, basename(real), part, signal)
}
