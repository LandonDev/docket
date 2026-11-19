import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  FORM_SUBMITTED,
  type FormBody,
  type FormQuestion,
  type FormPublish,
  type FormResponses,
  type FormSuggestion,
  type FormView,
  type PublishedForm
} from '@shared/contract-work-forms'
import type { CanvasItem, HeldItem } from '@shared/work'
import type { ActCtx, WorkCtx } from '../modules'
import { ActStale } from '../outbox/kinds'
import { servicePaths } from '../service/config'
import { answerable, applySuggestion, FormsStore, mergeColumns, newPublicId, type FormRow } from './store'

/**
 * What the forms pillar does with a form (docs/agents/work-forms.md): its
 * view, the owner's edits and verdicts, the held publish and what the press
 * runs, closing and reopening, and the answers read back from the sheet.
 */

type Ctx = Pick<WorkCtx, 'db' | 'dataDir' | 'host' | 'push' | 'canvas' | 'held' | 'service' | 'scopeOf' | 'lifeos' | 'log'>

export class FormError extends Error {}

export function formItem(ctx: Pick<WorkCtx, 'canvas'>, itemId: string): CanvasItem {
  const item = ctx.canvas.get(itemId)
  if (!item || item.kind !== 'form') throw new FormError(`There is no form ${itemId}.`)
  return item
}

export function rowOf(ctx: Pick<WorkCtx, 'db'>, item: CanvasItem): FormRow {
  const row = new FormsStore(ctx.db).get(item.id)
  if (!row) throw new FormError(`${item.title} has no form behind it.`)
  return row
}

/**
 * The public page's address. The box's installed host is the one behind the
 * tunnel (`tempcode.landonhale.com`, docs/agents/work-service.md "The
 * tunnel"); any other host's page is reachable on this machine only.
 * `TEMP_CODE_WORK_PUBLIC_ORIGIN` names another origin (a proof's quick tunnel).
 */
export function linkOf(ctx: Pick<WorkCtx, 'service'>, publicId: string): string {
  const origin = process.env.TEMP_CODE_WORK_PUBLIC_ORIGIN
  if (origin) return `${origin.replace(/\/$/, '')}/f/${publicId}`
  if (process.platform === 'linux' && !process.env.TEMP_CODE_USER_DATA) return `https://tempcode.landonhale.com/f/${publicId}`
  try {
    return ctx.service.url(`/f/${publicId}`)
  } catch {
    return `http://127.0.0.1/f/${publicId}`
  }
}

export function viewOf(ctx: Pick<WorkCtx, 'service'>, row: FormRow): FormView {
  return {
    itemId: row.itemId,
    rev: row.rev,
    body: row.body,
    state: row.state,
    mode: row.mode,
    suggestions: row.suggestions,
    link: row.publicId ? linkOf(ctx, row.publicId) : null,
    publishedAt: row.publishedAt,
    closedAt: row.closedAt,
    held: row.held,
    sheet: row.sheet,
    written: row.written
  }
}

export function announce(ctx: Ctx, row: FormRow): FormView {
  const view = viewOf(ctx, row)
  ctx.push({ push: 'work.forms', sessionId: row.sessionId, itemId: row.itemId, view })
  return view
}

// ── the service's copy ───────────────────────────────────────────────

const copiesDir = (dataDir: string): string => join(servicePaths(dataDir).serviceDir, 'forms')

/**
 * Writes what the Work service serves for a published form, whole and at
 * once (a rename), so the page never reads half a file. The service reads
 * it on every request: a close stops answers on the next one.
 */
export function writeCopy(ctx: Pick<WorkCtx, 'dataDir'>, row: FormRow): void {
  if (!row.publicId || !row.sheetRef) return
  const copy: PublishedForm = {
    publicId: row.publicId,
    title: row.body.title,
    description: row.body.description,
    questions: row.body.questions,
    open: row.state === 'open',
    sheet: row.sheetRef,
    columns: row.columns
  }
  const dir = copiesDir(ctx.dataDir)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, `${row.publicId}.json`)
  writeFileSync(`${file}.tmp`, JSON.stringify(copy), { mode: 0o600 })
  renameSync(`${file}.tmp`, file)
}

export function dropCopy(ctx: Pick<WorkCtx, 'dataDir'>, publicId: string): void {
  rmSync(join(copiesDir(ctx.dataDir), `${publicId}.json`), { force: true })
}

// ── the owner's edits ────────────────────────────────────────────────

/** His own edit. A published form's page changes at once, and its sheet gains a column for a new question. */
export async function save(ctx: Ctx, item: CanvasItem, rev: number, body: FormBody): Promise<FormView> {
  const store = new FormsStore(ctx.db)
  const row = rowOf(ctx, item)
  if (row.rev !== rev) throw new FormError('The form changed since you opened it; your edit was not kept. Try again.')
  return announce(ctx, await afterChange(ctx, store.update(item.id, { body })))
}

/** After the form changed: a published form's columns and the service's copy follow. */
async function afterChange(ctx: Ctx, row: FormRow): Promise<FormRow> {
  if (!row.publicId) return row
  const columns = mergeColumns(row.columns, row.body.questions)
  const next = columns.length !== row.columns.length ? new FormsStore(ctx.db).update(row.itemId, { columns }) : row
  if (next !== row) await writeHeader(ctx, next).catch((err) => ctx.log(`forms: the header row of ${row.itemId} was not written: ${String(err)}`))
  writeCopy(ctx, next)
  return next
}

export async function review(ctx: Ctx, item: CanvasItem, which: { ids: string[] } | 'all', verdict: 'accept' | 'reject'): Promise<FormView> {
  const store = new FormsStore(ctx.db)
  const row = rowOf(ctx, item)
  const picked = which === 'all' ? row.suggestions : row.suggestions.filter((s) => which.ids.includes(s.id))
  let body = row.body
  const gone: string[] = []
  if (verdict === 'accept')
    for (const s of picked) {
      const next = applySuggestion(body, s)
      if (next) body = next
      else gone.push(s.question.label)
    }
  const left = row.suggestions.filter((s) => !picked.includes(s))
  const next = store.update(item.id, { suggestions: left, ...(body !== row.body ? { body } : {}) })
  const view = announce(ctx, body !== row.body ? await afterChange(ctx, next) : next)
  if (gone.length) throw new FormError(`${gone.join(', ')}: that question is gone, so the change was dropped.`)
  return view
}

/**
 * An agent's change. Before the form is published the mode decides; once it
 * is published every change waits for him, since the page is public.
 */
export async function agentChange(ctx: Ctx, item: CanvasItem, changes: Omit<FormSuggestion, 'id' | 'at'>[], newId: () => string): Promise<{ view: FormView; waiting: boolean }> {
  const store = new FormsStore(ctx.db)
  const row = rowOf(ctx, item)
  const at = Date.now()
  const made = changes.map((c) => ({ ...c, id: newId(), at }))
  if (row.publicId || row.mode === 'suggests') {
    const next = store.update(item.id, { suggestions: [...row.suggestions, ...made] })
    return { view: announce(ctx, next), waiting: true }
  }
  let body = row.body
  for (const s of made) {
    const next = applySuggestion(body, s)
    if (!next) throw new FormError(`There is no question ${s.question.id} in the form.`)
    body = next
  }
  const text = `Changed ${made.length === 1 ? 'a question' : `${made.length} questions`}`
  return { view: announce(ctx, store.update(item.id, { body, written: { text, at } })), waiting: false }
}

// ── publishing ───────────────────────────────────────────────────────

/** Holds the publish for his press. A publish already held at this rev is the one. */
export function hold(ctx: Ctx, item: CanvasItem): { view: FormView; held: HeldItem | null } {
  const store = new FormsStore(ctx.db)
  const row = rowOf(ctx, item)
  if (row.state === 'open') throw new FormError(`${row.body.title} is published already.`)
  if (!answerable(row.body.questions).length) throw new FormError('A form needs a question before it is published.')
  if (row.held && row.held.rev === row.rev) return { view: viewOf(ctx, row), held: null }
  const payload: FormPublish = { itemId: item.id, title: row.body.title, rev: row.rev, questions: answerable(row.body.questions).length, content: formWords(row.body) }
  const held = ctx.held.create({ kind: 'form.publish', sessionId: item.sessionId, payload })
  const next = held.state === 'held' ? store.update(item.id, { held: { ref: held.ref, rev: row.rev } }) : (store.get(item.id) ?? row)
  return { view: announce(ctx, next), held }
}

const TYPE_WORDS: Record<FormQuestion['type'], string> = { short: 'short answer', long: 'long answer', choice: 'choice', dropdown: 'dropdown', section: 'section' }

/** The form in words, as the Outbox shows a held publish: the description, then each question in order with its kind, whether it is required, and its options. */
export function formWords(body: FormBody): string {
  const lines: string[] = []
  if (body.description.trim()) lines.push(body.description.trim(), '')
  let n = 0
  for (const q of body.questions) {
    if (q.type === 'section') {
      lines.push('', q.label)
      continue
    }
    lines.push(`${++n}. ${q.label} (${TYPE_WORDS[q.type]}${q.required ? ', required' : ''})`)
    for (const o of q.options ?? []) lines.push(`   - ${o}`)
  }
  return lines.join('\n').trim()
}

/** What his press runs: the form as held goes live, its sheet made on the first publish. */
export async function publish(ctx: ActCtx, p: FormPublish): Promise<{ summary: string; ref: unknown }> {
  const store = new FormsStore(ctx.db)
  const row = store.get(p.itemId)
  if (!row) throw new ActStale('The form is gone. Nothing was published.')
  if (row.rev !== p.rev) throw new ActStale('The form changed after this was held. Nothing was published; publish it again.')
  if (row.state === 'open') throw new ActStale(`${row.body.title} is published already.`)
  // The form as he pressed it: an edit that lands while the sheet is made is not published on this press (milestone 50's hold review, 19).
  let next = row
  if (!row.sheetRef) {
    const made = await makeSheet(ctx, row)
    next = { ...row, sheet: made.source, sheetRef: made.ref }
    store.update(row.itemId, { sheet: made.source, sheetRef: made.ref })
  }
  // The sheet's header and the service's copy first: a write that fails leaves the form a draft he can publish again.
  const live: FormRow = { ...next, columns: mergeColumns(next.columns, next.body.questions), publicId: next.publicId ?? newPublicId(), state: 'open', publishedAt: Date.now(), closedAt: null, held: null }
  await writeHeader(ctx, live)
  if (store.get(p.itemId)?.rev !== p.rev) throw new ActStale('The form changed while it was being published. Nothing was published; publish it again.')
  writeCopy(ctx, live)
  next = store.update(row.itemId, { columns: live.columns, publicId: live.publicId, state: 'open', publishedAt: live.publishedAt, closedAt: null, held: null })
  announce(ctx, next)
  const link = linkOf(ctx, next.publicId!)
  return { summary: `Published ${next.body.title}`, ref: { itemId: row.itemId, link } }
}

/** A held publish that was decided some other way (discarded, stale, failed) stops waiting. */
export function settled(ctx: Ctx, item: HeldItem): void {
  if (item.kind !== 'form.publish') return
  const store = new FormsStore(ctx.db)
  for (const row of store.byHeld(item.ref)) announce(ctx, store.update(row.itemId, { held: null }))
}

/** The sheet answers go to: a LifeOS sheet in the workspace's sector when this host serves them, else a .tcsheet beside the form. */
async function makeSheet(ctx: Ctx, row: FormRow): Promise<{ source: NonNullable<FormRow['sheet']>; ref: NonNullable<FormRow['sheetRef']> }> {
  const title = `${row.body.title}, responses`
  const sector = ctx.scopeOf(ctx.canvas.paneOf(row.sessionId))?.sector
  if (sector && ctx.lifeos.connected()) {
    try {
      const got = (await ctx.service.internal('/internal/sheet/create', { title, at: { lifeos: { sector } } })) as { sheet: { lifeos: string } }
      return { source: { at: 'lifeos', table: 'sheets', id: got.sheet.lifeos }, ref: got.sheet }
    } catch (err) {
      // Another host serves LifeOS's sheets: the answers stay on this one, in a file.
      ctx.log(`forms: no LifeOS sheet for ${row.itemId} (${String(err)}); using a file`)
    }
  }
  const dir = join(ctx.dataDir, 'work-forms', row.itemId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `${row.body.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').trim() || 'Form'} responses.tcsheet`)
  await ctx.service.internal('/internal/sheet/create', { title, at: { tcsheet: path } })
  return { source: { at: 'file', host: ctx.host, path }, ref: { tcsheet: path } }
}

export const columnLetter = (i: number): string => {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

/** Row 1: Submitted, then each column's question as it reads now. */
async function writeHeader(ctx: Ctx, row: FormRow): Promise<void> {
  if (!row.sheetRef) return
  const labels = new Map(row.body.questions.map((q) => [q.id, q.label]))
  const cells = [FORM_SUBMITTED, ...row.columns.map((id) => labels.get(id) ?? id)].map((v, i) => ({ at: `${columnLetter(i)}1`, v }))
  await ctx.service.internal('/internal/sheet/cells', { sheet: row.sheetRef, cells, by: `form:${row.publicId ?? row.itemId}`, suggest: false })
}

// ── closing ──────────────────────────────────────────────────────────

export function setOpen(ctx: Ctx, item: CanvasItem, open: boolean): FormView {
  const store = new FormsStore(ctx.db)
  const row = rowOf(ctx, item)
  if (!row.publicId) throw new FormError(`${row.body.title} is not published.`)
  if ((row.state === 'open') === open) return viewOf(ctx, row)
  const next = store.update(item.id, open ? { state: 'open', closedAt: null } : { state: 'closed', closedAt: Date.now() })
  writeCopy(ctx, next)
  return announce(ctx, next)
}

// ── the answers ──────────────────────────────────────────────────────

/** The most rows the canvas reads back; past it the table says the sheet holds more. */
export const RESPONSES_MAX = 2000
const READ_CELLS = 10_000

type Range = { cells: { at: string; v?: string | number | boolean }[][] }

export async function responses(ctx: Ctx, item: CanvasItem, since?: number): Promise<FormResponses | { same: true; rev: number }> {
  const row = rowOf(ctx, item)
  const labels = new Map(row.body.questions.map((q) => [q.id, q.label]))
  const columns = [...row.columns.map((id) => ({ id, label: labels.get(id) ?? 'Removed question' })), { id: 'submitted', label: FORM_SUBMITTED }]
  if (!row.sheetRef) return { rev: 0, columns, rows: [], count: 0, cut: false }
  const { rev } = (await ctx.service.internal('/internal/sheet/open', { sheet: row.sheetRef })) as { rev: number }
  if (since !== undefined && since === rev) return { same: true, rev }
  const width = row.columns.length + 1
  const last = columnLetter(width - 1)
  const per = Math.max(1, Math.floor(READ_CELLS / width))
  const rows: string[][] = []
  let cut = false
  for (let start = 2; ; start += per) {
    const got = (await ctx.service.internal('/internal/sheet/range', { sheet: row.sheetRef, range: `A${start}:${last}${start + per - 1}` })) as Range
    let empty = 0
    for (const line of got.cells) {
      const byCol = new Map(line.map((c) => [c.at.replace(/\d+$/, ''), c.v === undefined ? '' : String(c.v)]))
      const submitted = byCol.get('A') ?? ''
      if (!submitted) {
        empty++
        continue
      }
      // Questions first, then when it came in, as the table reads.
      rows.push([...row.columns.map((_, i) => byCol.get(columnLetter(i + 1)) ?? ''), submitted])
    }
    if (got.cells.length < per || empty === got.cells.length) break
    if (rows.length >= RESPONSES_MAX) {
      cut = true
      break
    }
  }
  rows.reverse()
  return { rev, columns, rows: rows.slice(0, RESPONSES_MAX), count: rows.length, cut }
}
