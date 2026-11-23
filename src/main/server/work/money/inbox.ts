import { randomUUID } from 'node:crypto'
import { constants, existsSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import type { EntryFields, MoneyActed, MoneyPicture, MoneyReceived, MoneySource, ReceiveParams, ToConfirm } from '@shared/contract-work-money'
import { MONEY_FILE_MAX, receiptLines } from '@shared/contract-work-money'
import { errorText, type SectorKey } from '@shared/work/ids'
import { fileWord, knownSellers, parseReceipt, receiptName, type ReceiptFields, type ReceiptLine } from '@shared/work/money'
import { FenceError } from '../../remote/fence'
import type { Caller, WorkCtx } from '../modules'
import { appendRow, MONEY_FOLDER, openBooks, valuesOf } from './book'
import { partOf, takePart } from './parts'
import { booksHere, ledgerOf, MoneyError, waiting } from './read'
import { extOf, isReceiptFile, pdfPicture, readReceipt, shownPicture } from './reader'
import { workspaceOf, workspaces, type Workspace } from './store'

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

/** The job a receipt names: a workspace of this host, or the first Work workspace here in the sector it names. */
export function jobOf(ctx: Pick<WorkCtx, 'db'>, p: { workspaceId?: string; sector?: SectorKey }): Workspace {
  const ws = p.workspaceId ? workspaceOf(ctx, p.workspaceId) : (workspaces(ctx).find((w) => w.sector === p.sector) ?? null)
  if (!ws) throw new MoneyError(p.workspaceId ? 'That job is not on this computer.' : 'No workspace for that job on this computer.')
  return ws
}

/** A name safe as a file's own in this host's folder: no folder part, nothing that could leave it. */
const safeName = (name: string): string => {
  const ext = extOf(name)
  return `${fileWord(basename(name.replace(/\\/g, '/')).replace(/\.[^.]*$/, ''), 80) || 'Receipt'}.${ext}`
}

function insert(ctx: Ctx, r: { key: string; workspaceId: string; state: State; source: MoneySource; name?: string; mime?: string; sessionId?: string; fields?: Waiting; lines?: ReceiptLine[] }, now = Date.now()): string {
  const id = randomUUID()
  ctx.db
    .prepare('INSERT INTO work_money_inbox (id, key, workspace_id, state, source, name, mime, lines, fields, session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, r.key, r.workspaceId, r.state, r.source, r.name ?? null, r.mime ?? null, r.lines ? JSON.stringify(r.lines) : null, r.fields ? JSON.stringify(r.fields) : null, r.sessionId ?? null, now, now)
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

/** The one parser, with what this job's ledger knows. */
export async function parseFor(ctx: Ctx, lines: readonly ReceiptLine[], at: { workspaceId?: string; sector?: SectorKey | null }): Promise<ReceiptFields> {
  const ws = at.workspaceId ? workspaceOf(ctx, at.workspaceId) : (workspaces(ctx).find((w) => w.sector === at.sector) ?? null)
  return parseReceipt(lines, { sector: ws?.sector ?? at.sector ?? null, known: ws ? await knownOf(ctx, ws.id) : {} })
}

/** What he typed where he sent it from wins over what was read; a field he left empty takes the reading. */
const merged = (read: ReceiptFields, typed?: Partial<Waiting>): Waiting => ({
  ...typed,
  amount: typed?.amount ?? read.amount,
  date: typed?.date ?? read.date,
  who: typed?.who || read.who,
  category: typed?.category || read.category
})

const reading = new Map<string, AbortController>()

/** Reads a waiting file in the background and makes it ready, with whatever could be read. A file that cannot be read is ready with empty fields. */
export function read(ctx: Ctx, id: string): Promise<void> {
  const stop = new AbortController()
  reading.set(id, stop)
  return (async () => {
    const row = byId(ctx, id)
    if (!row || row.state !== 'reading' || !row.file) return
    let lines: ReceiptLine[] = []
    let error: string | null = null
    try {
      lines = await readReceipt(ctx, row.file, stop.signal)
    } catch (err) {
      error = errorText(err)
      ctx.log(`money: ${row.name ?? id} was not read (${error})`)
    }
    const now = byId(ctx, id)
    // Discarded or accepted while it was being read: his word stands.
    if (!now || now.state !== 'reading') return
    const ws = workspaceOf(ctx, now.workspace_id)
    const fields = merged(parseReceipt(lines, { sector: ws?.sector ?? null, known: await knownOf(ctx, now.workspace_id) }), fieldsOf(now))
    set(ctx, id, { state: 'ready', lines: JSON.stringify(lines), fields: JSON.stringify(fields), error })
    announce(ctx, now.workspace_id)
    tell(ctx, now, fields)
  })().finally(() => reading.delete(id))
}

/** Reading picks up where a restart left it, and parts nobody finished in a day go. Returns what stops the reads in hand. */
export function resume(ctx: Ctx, now = Date.now()): () => void {
  const stale = ctx.db.prepare("SELECT id FROM work_money_inbox WHERE state = 'partial' AND updated_at < ?").all(now - 24 * 3600_000) as { id: string }[]
  for (const { id } of stale) {
    rmSync(folderOf(ctx, id), { recursive: true, force: true })
    ctx.db.prepare('DELETE FROM work_money_inbox WHERE id = ?').run(id)
  }
  // Filed and dropped rows are kept a month, so a late retry still answers the first.
  ctx.db.prepare("DELETE FROM work_money_inbox WHERE state IN ('filed', 'dropped') AND updated_at < ?").run(now - 30 * 24 * 3600_000)
  for (const { id } of ctx.db.prepare("SELECT id FROM work_money_inbox WHERE state = 'reading'").all() as { id: string }[]) void read(ctx, id)
  return () => {
    for (const stop of reading.values()) stop.abort()
  }
}

const answer = (row: Pick<Row, 'id' | 'state'>): MoneyReceived => ({ id: row.id, state: row.state })

/**
 * A receipt comes in: its bytes in parts, or a file of this host. The whole
 * file waits under this host's data folder. With the sender's own lines
 * (the phone's reader) it is not read again; with fields that hold an
 * amount and a date it is filed at once, as his own accept.
 */
export async function receive(ctx: Ctx, p: ReceiveParams, by: Caller, admit: (workspaceId: string) => Workspace): Promise<MoneyReceived> {
  if ((p.file !== undefined) === (p.dataBase64 !== undefined)) throw new MoneyError('A receipt is its bytes or a file, one of the two.')
  if (!p.workspaceId && !p.sector) throw new MoneyError('A receipt names its job.')
  if (!isReceiptFile(p.name)) throw new MoneyError('Money files pictures and PDFs.')
  const ws = admit(jobOf(ctx, p).id)
  const before = byKey(ctx, p.key)
  if (before && before.state !== 'partial') return answer(before)
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
    const fields = merged(await parseFor(ctx, receiptLines(p.lines), { workspaceId: ws.id }), typed)
    set(ctx, id, { state: 'ready', file: whole, lines: JSON.stringify(p.lines), fields: JSON.stringify(fields) })
  } else {
    set(ctx, id, { state: 'reading', file: whole, ...(typed ? { fields: JSON.stringify(typed) } : {}) })
  }

  // He accepted it where he sent it from: an amount and a date are enough to file it.
  if (p.fields?.amount && p.fields.date) {
    set(ctx, id, { state: 'ready' })
    await accept(ctx, id, { date: p.fields.date, who: p.fields.who ?? '', what: '', category: p.fields.category ?? '', way: 'out', amount: p.fields.amount, status: 'Paid' }, ws)
    return { id, state: 'filed' }
  }
  announce(ctx, ws.id)
  const row = byId(ctx, id)!
  if (row.state === 'reading') void read(ctx, id)
  else tell(ctx, row, fieldsOf(row))
  return answer(row)
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
  const id = insert(ctx, { key: o.key, workspaceId: o.ws.id, state, source: 'agent', name: o.file ? basename(o.file) : undefined, sessionId: o.sessionId, fields: o.fields })
  if (o.file) {
    const dir = folderOf(ctx, id)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const whole = join(dir, safeName(o.file))
    await copyFile(o.file, whole)
    set(ctx, id, { file: whole })
  }
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
  const dir = join(ws.path, MONEY_FOLDER, ...sub)
  mkdirSync(dir, { recursive: true })
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
 * and the waiting one is filed. `to` sends it to another job. A second
 * accept of the same one answers the first.
 */
export async function accept(ctx: Ctx, id: string, fields: EntryFields, to?: Workspace): Promise<MoneyActed> {
  const row = byId(ctx, id)
  if (!row || row.state === 'dropped' || row.state === 'partial') throw new MoneyError('That one is not waiting any more.')
  if (row.state === 'filed') return row.ref ? (JSON.parse(row.ref) as MoneyActed) : { changed: true }
  const ws = to ?? workspaceOf(ctx, row.workspace_id)
  if (!ws) throw new MoneyError('That job is not on this computer.')
  const books = await openBooks(ctx, ws)
  let kept: { path: string; receipt: string } | null = null
  if (row.file && existsSync(row.file)) {
    kept = await keepFile(ws, row.file, ['Receipts', fields.date.slice(0, 4)], receiptName({ date: fields.date, who: fields.who, amount: fields.amount }, extOf(row.file)))
  }
  let got: Awaited<ReturnType<typeof appendRow>>
  try {
    got = await appendRow(ctx, ws, books, { ...valuesOf(fields), ...(kept ? { Receipt: kept.receipt } : {}) })
  } catch (err) {
    // No row, no kept file: the waiting one stays as it was for his next try.
    if (kept) rmSync(kept.path, { force: true })
    throw err
  }
  const acted: MoneyActed = { ok: true, ref: got.ref, row: got.row, ...(got.suggested ? { suggested: true as const } : {}) }
  reading.get(id)?.abort()
  set(ctx, id, { state: 'filed', ref: JSON.stringify(acted), file: null, workspace_id: ws.id })
  rmSync(folderOf(ctx, id), { recursive: true, force: true })
  announce(ctx, row.workspace_id)
  if (ws.id !== row.workspace_id) announce(ctx, ws.id)
  told(ctx, id)
  return acted
}

/** A waiting one is dropped, and its file with it. */
export function drop(ctx: Ctx, id: string): void {
  const row = byId(ctx, id)
  if (!row || row.state === 'filed' || row.state === 'dropped') return
  reading.get(id)?.abort()
  set(ctx, id, { state: 'dropped', file: null })
  rmSync(folderOf(ctx, id), { recursive: true, force: true })
  announce(ctx, row.workspace_id)
  told(ctx, id)
}

/** A workspace is gone: the files that waited for it go too. */
export function forgetJob(ctx: Pick<WorkCtx, 'db' | 'dataDir'>, workspaceId: string): void {
  for (const { id } of ctx.db.prepare('SELECT id FROM work_money_inbox WHERE workspace_id = ?').all(workspaceId) as { id: string }[]) {
    reading.get(id)?.abort()
    rmSync(folderOf(ctx, id), { recursive: true, force: true })
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
    real = realpathSync(path)
    if (!real.startsWith(realpathSync(root) + sep)) throw new Error('outside')
  } catch {
    throw new MoneyError('That receipt is not in the Money folder any more.')
  }
  if (!isReceiptFile(real)) throw new MoneyError('That file has no picture to show.')
  if (!ctx.reaches(by, real)) throw new FenceError('work.money.picture')
  return pictureOf(ctx, real, basename(real), part, signal)
}
