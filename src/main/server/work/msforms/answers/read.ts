import type { DatabaseSync } from 'node:sqlite'
import type { MsFormResponses, MsFormWorkbook } from '@shared/contract-work-msforms'
import { ANSWERS_FRESH_MS, CHECK_MS, workbookNameOf } from '@shared/work/msforms'
import { workspaceHere } from '../../files/policy'
import type { Caller } from '../../modules'
import { CarrierBusy, CarrierRefused, CarrierSignIn, CarrierStop, type CarrierBy, type PulledWorkbook } from '../carrier/types'
import { emitNewAnswers } from '../events'
import { announce, authFor, carrierOrRefuse, type MsCtx } from '../forms'
import { folderServerPath } from '../place'
import { LIBRARY_GONE, librariesFor, MsformsError, NO_FORM, type Reached } from '../reach'
import { MsformsStore, type MsFormRow } from '../store'
import { cachedAnswers, clearAnswers, keepAnswers, markAnswersStale, shownAnswers, sweepAnswers, type CachedAnswers } from './cache'
import { AnswersUnreadable, answersOf, type ParsedAnswers } from './parse'
import { libraryRootOf } from '../carrier/pull'

/**
 * The answers read (docs/agents/work-msforms.md "Reading answers"), one at a
 * time on this host. The count first, from the Responses view: unchanged, with
 * the rows cached (or none asked for), the read stops there. Else the pull: the
 * carrier opens the workbook in Excel for the web and brings its bytes into
 * memory, the place check passes, and the rows are parsed and kept in memory
 * alone (cache.ts). The row keeps counts and times, never an answer. A read that
 * cannot finish keeps the last rows, marked stale; one that meets Microsoft's
 * sign-in marks Connections "Needs you" (`signInNeeded`).
 */

/** The box browser is his, or another carrier run holds it: the read waits for its next turn. */
export class AnswersBusy extends MsformsError {}

export const MOVED = "The workbook is no longer in the form's folder: it was moved. The answers were not read."
/** What a stop says when its cause is not one of the carrier's own sentences: no error text reaches the row or a log. */
export const READ_FAILED = 'The answers could not be read. The last rows read are shown.'

let signIn = false
/** Microsoft asked for a sign-in at the last read, and no read has got through since. */
export const signInNeeded = (): boolean => signIn

type ReadBy = Extract<CarrierBy, 'owner' | 'poller'>
const keyOf = (row: { workspaceId: string; formId: string }): string => `${row.workspaceId}\u0000${row.formId}`
const inflight = new Map<string, Promise<MsFormRow>>()
let chain: Promise<unknown> = Promise.resolve()

/**
 * Reads a form's answers, after any read before it on this host. A second ask for one form while its
 * read runs joins it; one that wants rows the first did not fetch reads again after it.
 */
export function readAnswers(ctx: MsCtx, at: Reached, o: { by: ReadBy; rows: boolean }): Promise<MsFormRow> {
  const key = keyOf(at.row)
  const running = inflight.get(key)
  if (running) return o.rows ? running.then((row) => (cachedAnswers(row.workspaceId, row.formId) ? row : readAnswers(ctx, { ...at, row }, o))) : running
  const run = chain.then(() => readOnce(ctx, at, o))
  chain = run.catch(() => {})
  const done = run.finally(() => inflight.delete(key))
  inflight.set(key, done)
  return done
}

const noAnswers = (): ParsedAnswers => ({ columns: [], rows: [], count: 0, cut: false, maxId: 0, lastAnswerAt: null })

const dirOf = (path: string): string => path.replace(/\/[^/]*$/, '')
const samePath = (a: string, b: string): boolean => {
  const norm = (p: string): string => {
    try {
      return decodeURIComponent(p).replace(/\/+$/, '').toLowerCase()
    } catch {
      return p.replace(/\/+$/, '').toLowerCase()
    }
  }
  return norm(a) === norm(b)
}

/** The workbook lies in the form's folder, and is the one the row recorded: else it is not read and not stored. */
function placeChecked(row: MsFormRow, wb: PulledWorkbook, folderPath: string): void {
  // the form's folder, or for a form made in a Team library that library's root, where Forms puts it (P1, 2026-11-24)
  if (!samePath(dirOf(wb.serverPath), folderPath) && !samePath(dirOf(wb.serverPath), libraryRootOf(folderPath))) throw new MsformsError(MOVED)
  const was = row.workbook
  if (was && (was.uniqueId.toLowerCase() !== wb.uniqueId.toLowerCase() || (was.parentId && wb.parentId && was.parentId !== wb.parentId))) throw new MsformsError(MOVED)
}

/** The workbook's path inside its library, as Files names a library's file: its server path less the library's root. */
function libraryPathOf(serverPath: string, folderPath: string): string {
  const root = libraryRootOf(folderPath)
  let path = serverPath
  try {
    path = decodeURIComponent(serverPath)
  } catch {
    // kept as it came
  }
  return path.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? path.slice(root.length + 1) : path.replace(/^.*\//, '')
}

const kindOf = (err: unknown): string =>
  err instanceof CarrierSignIn ? 'sign-in' : err instanceof CarrierStop ? 'stop' : err instanceof CarrierRefused ? 'refused' : err instanceof AnswersUnreadable ? 'unreadable' : err instanceof MsformsError ? 'refused' : 'failed'

async function readOnce(ctx: MsCtx, at: Reached, o: { by: ReadBy; rows: boolean }): Promise<MsFormRow> {
  const store = new MsformsStore(ctx.db)
  let row = store.get(at.row.workspaceId, at.row.formId)
  if (!row) throw new MsformsError(NO_FORM)
  const carrier = carrierOrRefuse()
  const kept = cachedAnswers(row.workspaceId, row.formId)
  try {
    const { count } = await carrier.count(authFor(ctx, row, 'count', o.by, { formId: row.formId }), row.formId)
    if (count === row.count && (kept || !o.rows)) {
      signIn = false
      if (!kept) return row
      kept.stale = false
      return announceRow(ctx, store.update(row.workspaceId, row.formId, { answersReadAt: Date.now(), stopped: null }))
    }
    // The first "Open results in Excel" makes a workbook others in the folder can open: it runs only on his own press,
    // or for a form that collects through his press. A draft's answers are never put in a workbook by a read.
    if (!row.workbook && o.by !== 'owner' && row.state === 'draft') {
      signIn = false
      return announceRow(ctx, store.update(row.workspaceId, row.formId, { count }))
    }
    const folderPath = folderServerPath(row.folder, at.library.web)
    if (!folderPath) throw new MsformsError(LIBRARY_GONE)
    const ask = { siteUrl: row.folder.siteUrl, folderServerPath: folderPath, uniqueId: row.workbook?.uniqueId ?? null, name: row.workbook?.name ?? workbookNameOf(row.title), lastModified: kept?.modified ?? null }
    const got = await carrier.pull(authFor(ctx, row, 'pull', o.by, { formId: row.formId, siteUrl: ask.siteUrl, folder: folderPath }), row.formId, ask)
    const now = Date.now()
    signIn = false
    if ('unchanged' in got) {
      // the Responses view shows no answer: there is no workbook to read yet
      keepAnswers(row.workspaceId, row.formId, noAnswers(), kept?.modified ?? null, now)
      return announceRow(ctx, store.update(row.workspaceId, row.formId, { count: 0, answersReadAt: now, stopped: null }))
    }
    placeChecked(row, got.workbook, folderPath)
    const answers = answersOf(got.bytes, row.questions)
    keepAnswers(row.workspaceId, row.formId, answers, got.modified, now)
    const workbook: MsFormWorkbook | undefined = row.workbook
      ? undefined
      : { libraryId: row.folder.libraryId, path: libraryPathOf(got.workbook.serverPath, folderPath), siteUrl: row.folder.siteUrl, uniqueId: got.workbook.uniqueId, parentId: got.workbook.parentId, name: got.workbook.name }
    const before = row
    row = store.update(row.workspaceId, row.formId, {
      count: answers.count,
      lastId: Math.max(before.lastId, answers.maxId),
      lastAnswerAt: answers.lastAnswerAt ?? before.lastAnswerAt,
      answersReadAt: now,
      stopped: null,
      ...(workbook ? { workbook } : {})
    })
    if (answers.maxId > before.lastId)
      emitNewAnswers({ workspaceId: row.workspaceId, formId: row.formId, title: row.title, added: Math.max(1, answers.count - before.count), count: answers.count, fromId: before.lastId + 1, toId: answers.maxId, at: now })
    return announceRow(ctx, row)
  } catch (err) {
    if (err instanceof CarrierBusy) throw new AnswersBusy(err.message)
    if (err instanceof CarrierSignIn) signIn = true
    markAnswersStale(row.workspaceId, row.formId)
    // Only sentences of our own reach the row and the log: an error's own text may quote a page.
    const words = err instanceof CarrierSignIn || err instanceof CarrierStop || err instanceof CarrierRefused || err instanceof AnswersUnreadable || err instanceof MsformsError ? err.message : READ_FAILED
    ctx.log(`msforms: an answers read stopped (${kindOf(err)})`)
    if (store.get(row.workspaceId, row.formId)) announceRow(ctx, store.update(row.workspaceId, row.formId, { stopped: words }))
    throw new MsformsError(words)
  }
}

function announceRow(ctx: MsCtx, row: MsFormRow): MsFormRow {
  announce(ctx, row)
  return row
}

function shapeOf(row: MsFormRow, entry: CachedAnswers | null): MsFormResponses {
  return {
    rev: row.rev,
    columns: entry?.answers.columns ?? [],
    rows: entry?.answers.rows ?? [],
    count: row.count,
    cut: entry?.answers.cut ?? false,
    at: entry?.at ?? null,
    stale: entry?.stale ?? false,
    none: row.workbook === null && !entry?.answers.rows.length
  }
}

/**
 * `work.msforms.responses`: the answers as last read, read first when the last read is older than
 * `ANSWERS_FRESH_MS` or the memory holds none. A read that cannot finish shows the last rows, stale;
 * with none to show, it says why.
 */
export async function responsesOf(ctx: MsCtx, at: Reached, by: Caller): Promise<MsFormResponses> {
  const { workspaceId, formId } = at.row
  const fresh = at.row.answersReadAt !== null && Date.now() - at.row.answersReadAt < ANSWERS_FRESH_MS
  if (!fresh || !cachedAnswers(workspaceId, formId)) {
    try {
      await readAnswers(ctx, at, { by: by.kind === 'model' ? 'poller' : 'owner', rows: true })
    } catch (err) {
      if (!cachedAnswers(workspaceId, formId)) throw err
    }
  }
  const row = new MsformsStore(ctx.db).get(workspaceId, formId) ?? at.row
  shownAnswers(workspaceId, formId)
  return shapeOf(row, cachedAnswers(workspaceId, formId))
}

/** `work.msforms.refresh`: his Refresh, read now. */
export async function refreshAnswers(ctx: MsCtx, at: Reached): Promise<MsFormResponses> {
  const row = await readAnswers(ctx, at, { by: 'owner', rows: true })
  shownAnswers(row.workspaceId, row.formId)
  return shapeOf(row, cachedAnswers(row.workspaceId, row.formId))
}

// ── the check schedule ───────────────────────────────────────────────

export const POLL_TICK_MS = 60_000
const tried = new Map<string, number>()
let polling = false

function ownerDrives(db: DatabaseSync): boolean {
  try {
    return !!db.prepare("SELECT 1 FROM work_browser_drive WHERE driver = 'owner' LIMIT 1").get()
  } catch {
    return false
  }
}

/**
 * One tick of the poller: each collecting form whose check is due (`CHECK_MS`: hourly, every 15
 * minutes, or only when he looks) is read for its count, and pulled when it moved. Nothing runs while
 * he drives the box browser or a read already runs; a busy carrier ends the tick, to try at the next.
 */
export async function pollAnswers(ctx: MsCtx, now = Date.now()): Promise<void> {
  sweepAnswers(now)
  if (polling || inflight.size || ownerDrives(ctx.db)) return
  polling = true
  try {
    const host: Caller = { kind: 'local', caps: [] }
    for (const row of new MsformsStore(ctx.db).all()) {
      const every = CHECK_MS[row.check]
      if (row.state !== 'collecting' || every === null) continue
      const key = keyOf(row)
      if (now - Math.max(row.answersReadAt ?? 0, tried.get(key) ?? 0) < every) continue
      const workspace = workspaceHere(ctx.db, row.workspaceId)
      if (!workspace || (workspace.sector ?? null) !== (row.sector ?? null)) continue
      const library = librariesFor(ctx, host).find((l) => l.id === row.folder.libraryId)
      if (!library) continue
      tried.set(key, now)
      try {
        await readAnswers(ctx, { workspace, row, library }, { by: 'poller', rows: false })
      } catch (err) {
        if (err instanceof AnswersBusy) {
          tried.delete(key)
          return
        }
      }
    }
  } finally {
    polling = false
  }
}

/** The pillar's poller, from its `start`. */
export function startAnswersPoller(ctx: MsCtx, every = POLL_TICK_MS): () => void {
  const timer = setInterval(() => void pollAnswers(ctx).catch(() => ctx.log('msforms: the answers check stopped')), every)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** Everything the reads hold in memory gone, as a restart leaves it. */
export function resetAnswerReads(): void {
  clearAnswers()
  inflight.clear()
  tried.clear()
  chain = Promise.resolve()
  polling = false
  signIn = false
}
