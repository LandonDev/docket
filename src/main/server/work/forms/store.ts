import { randomBytes, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { FormBody, FormMode, FormQuestion, FormState, FormSuggestion } from '@shared/contract-work-forms'
import type { CanvasSource, HeldRef } from '@shared/work'

/**
 * The forms pillar's table (docs/agents/work-forms.md "The store"): one row
 * per form item. The row is the form's truth; the Work service gets a copy
 * of what was published (publish.ts), and answers live in the sheet.
 */

export interface FormRow {
  itemId: string
  sessionId: string
  rev: number
  body: FormBody
  state: FormState
  mode: FormMode
  suggestions: FormSuggestion[]
  publicId: string | null
  publishedAt: number | null
  closedAt: number | null
  held: { ref: HeldRef; rev: number } | null
  /** the responses sheet as the canvas opens it, and as the service's sheet host names it */
  sheet: CanvasSource | null
  sheetRef: { lifeos: string } | { tcsheet: string } | null
  /** the sheet's columns after A, by question id: fixed once written, new questions added at the end */
  columns: string[]
  written: { text: string; at: number } | null
}

export function ensureFormsTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_forms (
    item_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    rev INTEGER NOT NULL DEFAULT 0,
    body TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'draft',
    mode TEXT NOT NULL DEFAULT 'suggests',
    suggestions TEXT NOT NULL DEFAULT '[]',
    public_id TEXT UNIQUE,
    published_at INTEGER,
    closed_at INTEGER,
    held TEXT,
    sheet TEXT,
    sheet_ref TEXT,
    columns TEXT NOT NULL DEFAULT '[]',
    written TEXT,
    updated_at INTEGER NOT NULL
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS work_forms_session ON work_forms(session_id)')
}

type Raw = Record<string, string | number | null>
const json = <T>(v: string | number | null, or: T): T => (typeof v === 'string' ? (JSON.parse(v) as T) : or)

function rowOf(r: Raw): FormRow {
  return {
    itemId: String(r.item_id),
    sessionId: String(r.session_id),
    rev: Number(r.rev),
    body: json(r.body, { title: 'Form', description: '', questions: [] }),
    state: r.state as FormState,
    mode: r.mode as FormMode,
    suggestions: json(r.suggestions, []),
    publicId: (r.public_id as string | null) ?? null,
    publishedAt: (r.published_at as number | null) ?? null,
    closedAt: (r.closed_at as number | null) ?? null,
    held: json(r.held, null),
    sheet: json(r.sheet, null),
    sheetRef: json(r.sheet_ref, null),
    columns: json(r.columns, []),
    written: json(r.written, null)
  }
}

export class FormsStore {
  constructor(private readonly db: DatabaseSync) {}

  get(itemId: string): FormRow | null {
    const r = this.db.prepare('SELECT * FROM work_forms WHERE item_id = ?').get(itemId) as Raw | undefined
    return r ? rowOf(r) : null
  }

  create(itemId: string, sessionId: string, body: FormBody): FormRow {
    this.db.prepare('INSERT INTO work_forms (item_id, session_id, body, updated_at) VALUES (?, ?, ?, ?)').run(itemId, sessionId, JSON.stringify(body), Date.now())
    return this.get(itemId)!
  }

  /** Writes the changed fields; a change to the form itself (`body`) moves `rev`. */
  update(itemId: string, patch: Partial<Omit<FormRow, 'itemId' | 'sessionId' | 'rev'>>): FormRow {
    const cols: string[] = []
    const vals: (string | number | null)[] = []
    const set = (col: string, v: string | number | null): void => {
      cols.push(`${col} = ?`)
      vals.push(v)
    }
    if (patch.body) {
      set('body', JSON.stringify(patch.body))
      cols.push('rev = rev + 1')
    }
    if (patch.state) set('state', patch.state)
    if (patch.mode) set('mode', patch.mode)
    if (patch.suggestions) set('suggestions', JSON.stringify(patch.suggestions))
    if (patch.publicId !== undefined) set('public_id', patch.publicId)
    if (patch.publishedAt !== undefined) set('published_at', patch.publishedAt)
    if (patch.closedAt !== undefined) set('closed_at', patch.closedAt)
    if (patch.held !== undefined) set('held', patch.held && JSON.stringify(patch.held))
    if (patch.sheet !== undefined) set('sheet', patch.sheet && JSON.stringify(patch.sheet))
    if (patch.sheetRef !== undefined) set('sheet_ref', patch.sheetRef && JSON.stringify(patch.sheetRef))
    if (patch.columns) set('columns', JSON.stringify(patch.columns))
    if (patch.written !== undefined) set('written', patch.written && JSON.stringify(patch.written))
    set('updated_at', Date.now())
    this.db.prepare(`UPDATE work_forms SET ${cols.join(', ')} WHERE item_id = ?`).run(...vals, itemId)
    return this.get(itemId)!
  }

  /** The forms whose publish waits on this held row. */
  byHeld(ref: HeldRef): FormRow[] {
    // Few forms wait on a press at once, so they are read whole.
    const all = this.db.prepare('SELECT * FROM work_forms WHERE held IS NOT NULL').all() as Raw[]
    return all.map(rowOf).filter((r) => r.held && JSON.stringify(r.held.ref) === JSON.stringify(ref))
  }

  /** Every published form, for writing the service's copies again when Work turns on. */
  published(): FormRow[] {
    return (this.db.prepare('SELECT * FROM work_forms WHERE public_id IS NOT NULL').all() as Raw[]).map(rowOf)
  }

  removeSessions(ids: string[]): FormRow[] {
    const gone: FormRow[] = []
    for (const id of ids) {
      gone.push(...(this.db.prepare('SELECT * FROM work_forms WHERE session_id = ?').all(id) as Raw[]).map(rowOf))
      this.db.prepare('DELETE FROM work_forms WHERE session_id = ?').run(id)
    }
    return gone
  }

  /** A closed Files tab's forms, answered as they were so the caller drops their pages and folders. */
  removeItems(itemIds: readonly string[]): FormRow[] {
    const gone: FormRow[] = []
    for (const id of itemIds) {
      gone.push(...(this.db.prepare('SELECT * FROM work_forms WHERE item_id = ?').all(id) as Raw[]).map(rowOf))
      this.db.prepare('DELETE FROM work_forms WHERE item_id = ?').run(id)
    }
    return gone
  }
}

export const newPublicId = (): string => randomBytes(12).toString('base64url')
export const newQuestionId = (): string => randomUUID().slice(0, 8)

// ── changes to a form, kept pure so tests read them plainly ─────────

/** A change applied to a form's questions; null when the question it names is gone. */
export function applySuggestion(body: FormBody, s: FormSuggestion): FormBody | null {
  const qs = body.questions
  if (s.op === 'add') {
    if (qs.some((q) => q.id === s.question.id)) return null
    const at = s.after == null ? 0 : qs.findIndex((q) => q.id === s.after) + 1
    if (s.after != null && at === 0) return { ...body, questions: [...qs, s.question] }
    return { ...body, questions: [...qs.slice(0, at), s.question, ...qs.slice(at)] }
  }
  const i = qs.findIndex((q) => q.id === s.question.id)
  if (i < 0) return null
  if (s.op === 'remove') return { ...body, questions: qs.filter((_, j) => j !== i) }
  return { ...body, questions: qs.map((q, j) => (j === i ? s.question : q)) }
}

/** The questions that take an answer, in order. */
export const answerable = (qs: readonly FormQuestion[]): FormQuestion[] => qs.filter((q) => q.type !== 'section')

/** The sheet's columns: those already written keep their place, new questions go at the end. */
export function mergeColumns(columns: readonly string[], qs: readonly FormQuestion[]): string[] {
  const next = [...columns]
  for (const q of answerable(qs)) if (!next.includes(q.id)) next.push(q.id)
  return next
}

/** A choice or a dropdown keeps its options; another type has none. */
export function tidyQuestion(q: FormQuestion): FormQuestion {
  const takesOptions = q.type === 'choice' || q.type === 'dropdown'
  const { options, ...rest } = q
  return takesOptions ? { ...rest, options: options?.length ? options : ['Option 1'] } : { ...rest, required: q.type === 'section' ? false : q.required }
}
