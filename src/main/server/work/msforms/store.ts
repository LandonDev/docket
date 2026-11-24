import type { DatabaseSync } from 'node:sqlite'
import type { MsFormFolder, MsFormMode, MsFormState, MsFormWorkbook, MsSuggestion } from '@shared/contract-work-msforms'
import type { HeldRef } from '@shared/work/acts'
import type { Principal } from '@shared/work/ids'
import { MSFORM_NEW_SETTINGS, type MsAnyQuestion, type MsFormCheck, type MsFormSettings } from '@shared/work/msforms'

/**
 * The Microsoft Forms pillar's rows (docs/agents/work-msforms.md): one a form,
 * keyed by its workspace and Forms' own id, and each change of its question
 * list. No answer, respondent name or address is a column here: answers are
 * read from the workbook into memory (answers/cache.ts) and nowhere else.
 */

export interface MsFormRow {
  workspaceId: string
  formId: string
  tenant: string
  /** the job's sector when the form was made: its answers stay in that sector */
  sector: string | null
  title: string
  folder: MsFormFolder
  workbook: MsFormWorkbook | null
  state: MsFormState
  mode: MsFormMode
  settings: MsFormSettings
  questions: MsAnyQuestion[]
  rev: number
  readAt: number | null
  answersReadAt: number | null
  count: number
  /** the workbook's highest `Id` seen */
  lastId: number
  lastAnswerAt: number | null
  check: MsFormCheck
  suggestions: MsSuggestion[]
  held: { ref: HeldRef; rev: number } | null
  madeBy: Principal
  signedInAs: string | null
  /** the count he last saw on the Responses half */
  seenCount: number
  /** what the carrier last could not finish, in words */
  stopped: string | null
  /** when it last stopped taking answers */
  closedAt: number | null
  updatedAt: number
}

export function ensureMsformsTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_msforms (
    workspace_id TEXT NOT NULL,
    form_id TEXT NOT NULL,
    tenant TEXT NOT NULL,
    sector TEXT,
    title TEXT NOT NULL,
    folder TEXT NOT NULL,
    workbook TEXT,
    state TEXT NOT NULL DEFAULT 'draft',
    mode TEXT NOT NULL DEFAULT 'suggests',
    settings TEXT NOT NULL,
    questions TEXT NOT NULL DEFAULT '[]',
    rev INTEGER NOT NULL DEFAULT 0,
    read_at INTEGER,
    answers_read_at INTEGER,
    count INTEGER NOT NULL DEFAULT 0,
    last_id INTEGER NOT NULL DEFAULT 0,
    last_answer_at INTEGER,
    "check" TEXT NOT NULL DEFAULT 'hour',
    suggestions TEXT NOT NULL DEFAULT '[]',
    held TEXT,
    made_by TEXT NOT NULL,
    signed_in_as TEXT,
    seen_count INTEGER NOT NULL DEFAULT 0,
    stopped TEXT,
    closed_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, form_id)
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS work_msforms_versions (
    workspace_id TEXT NOT NULL,
    form_id TEXT NOT NULL,
    rev INTEGER NOT NULL,
    questions TEXT NOT NULL,
    at INTEGER NOT NULL,
    by TEXT NOT NULL,
    PRIMARY KEY (workspace_id, form_id, rev)
  )`)
}

type Raw = Record<string, unknown>
const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string' || !v) return fallback
  try {
    return JSON.parse(v) as T
  } catch {
    return fallback
  }
}
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

function rowOf(r: Raw): MsFormRow {
  return {
    workspaceId: String(r.workspace_id),
    formId: String(r.form_id),
    tenant: String(r.tenant),
    sector: (r.sector as string | null) ?? null,
    title: String(r.title),
    folder: json<MsFormFolder>(r.folder, { libraryId: '', path: '', siteUrl: '' }),
    workbook: json<MsFormWorkbook | null>(r.workbook, null),
    state: r.state as MsFormState,
    mode: r.mode as MsFormMode,
    settings: { ...MSFORM_NEW_SETTINGS, ...json<Partial<MsFormSettings>>(r.settings, {}) },
    questions: json<MsAnyQuestion[]>(r.questions, []),
    rev: Number(r.rev),
    readAt: num(r.read_at),
    answersReadAt: num(r.answers_read_at),
    count: Number(r.count),
    lastId: Number(r.last_id),
    lastAnswerAt: num(r.last_answer_at),
    check: r.check as MsFormCheck,
    suggestions: json<MsSuggestion[]>(r.suggestions, []),
    held: json<MsFormRow['held']>(r.held, null),
    madeBy: r.made_by as Principal,
    signedInAs: (r.signed_in_as as string | null) ?? null,
    seenCount: Number(r.seen_count),
    stopped: (r.stopped as string | null) ?? null,
    closedAt: num(r.closed_at),
    updatedAt: Number(r.updated_at)
  }
}

/** The columns a patch may set, and how each is written. */
const COLUMNS: Record<keyof Omit<MsFormRow, 'workspaceId' | 'formId'>, [string, (v: never) => unknown]> = {
  tenant: ['tenant', (v: string) => v],
  sector: ['sector', (v: string | null) => v],
  title: ['title', (v: string) => v],
  folder: ['folder', (v: MsFormFolder) => JSON.stringify(v)],
  workbook: ['workbook', (v: MsFormWorkbook | null) => (v ? JSON.stringify(v) : null)],
  state: ['state', (v: MsFormState) => v],
  mode: ['mode', (v: MsFormMode) => v],
  settings: ['settings', (v: MsFormSettings) => JSON.stringify(v)],
  questions: ['questions', (v: MsAnyQuestion[]) => JSON.stringify(v)],
  rev: ['rev', (v: number) => v],
  readAt: ['read_at', (v: number | null) => v],
  answersReadAt: ['answers_read_at', (v: number | null) => v],
  count: ['count', (v: number) => v],
  lastId: ['last_id', (v: number) => v],
  lastAnswerAt: ['last_answer_at', (v: number | null) => v],
  check: ['"check"', (v: MsFormCheck) => v],
  suggestions: ['suggestions', (v: MsSuggestion[]) => JSON.stringify(v)],
  held: ['held', (v: MsFormRow['held']) => (v ? JSON.stringify(v) : null)],
  madeBy: ['made_by', (v: Principal) => v],
  signedInAs: ['signed_in_as', (v: string | null) => v],
  seenCount: ['seen_count', (v: number) => v],
  stopped: ['stopped', (v: string | null) => v],
  closedAt: ['closed_at', (v: number | null) => v],
  updatedAt: ['updated_at', (v: number) => v]
}

export type MsFormPatch = Partial<Omit<MsFormRow, 'workspaceId' | 'formId' | 'updatedAt' | 'rev'>>

export class MsformsStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now
  ) {}

  get(workspaceId: string, formId: string): MsFormRow | null {
    const r = this.db.prepare('SELECT * FROM work_msforms WHERE workspace_id = ? AND form_id = ?').get(workspaceId, formId) as Raw | undefined
    return r ? rowOf(r) : null
  }

  /** The job's forms, newest change first. */
  list(workspaceId: string): MsFormRow[] {
    return (this.db.prepare('SELECT * FROM work_msforms WHERE workspace_id = ? ORDER BY updated_at DESC, form_id').all(workspaceId) as Raw[]).map(rowOf)
  }

  /** Every form on this host, for the poller. */
  all(): MsFormRow[] {
    return (this.db.prepare('SELECT * FROM work_msforms ORDER BY updated_at DESC').all() as Raw[]).map(rowOf)
  }

  byHeld(id: string): MsFormRow | null {
    const rows = (this.db.prepare("SELECT * FROM work_msforms WHERE held IS NOT NULL AND json_extract(held, '$.ref.id') = ?").all(id) as Raw[]).map(rowOf)
    return rows[0] ?? null
  }

  /** A form the carrier just made. Its first version is its questions as made. */
  create(row: Pick<MsFormRow, 'workspaceId' | 'formId' | 'tenant' | 'sector' | 'title' | 'folder' | 'madeBy'> & Partial<MsFormRow>): MsFormRow {
    const at = this.now()
    const full: MsFormRow = {
      workbook: null,
      state: 'draft',
      mode: 'suggests',
      settings: { ...MSFORM_NEW_SETTINGS, accepting: true },
      questions: [],
      rev: 0,
      readAt: null,
      answersReadAt: null,
      count: 0,
      lastId: 0,
      lastAnswerAt: null,
      check: 'hour',
      suggestions: [],
      held: null,
      signedInAs: null,
      seenCount: 0,
      stopped: null,
      closedAt: null,
      ...row,
      updatedAt: at
    }
    this.db
      .prepare(
        `INSERT INTO work_msforms (workspace_id, form_id, tenant, sector, title, folder, workbook, state, mode, settings, questions, rev, read_at, answers_read_at, count, last_id, last_answer_at, "check", suggestions, held, made_by, signed_in_as, seen_count, stopped, closed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, form_id) DO NOTHING`
      )
      .run(
        full.workspaceId,
        full.formId,
        full.tenant,
        full.sector,
        full.title,
        JSON.stringify(full.folder),
        full.workbook ? JSON.stringify(full.workbook) : null,
        full.state,
        full.mode,
        JSON.stringify(full.settings),
        JSON.stringify(full.questions),
        full.rev,
        full.readAt,
        full.answersReadAt,
        full.count,
        full.lastId,
        full.lastAnswerAt,
        full.check,
        JSON.stringify(full.suggestions),
        full.held ? JSON.stringify(full.held) : null,
        full.madeBy,
        full.signedInAs,
        full.seenCount,
        full.stopped,
        full.closedAt,
        full.updatedAt
      )
    this.version(full.workspaceId, full.formId, full.rev, full.questions, full.madeBy)
    return this.get(full.workspaceId, full.formId)!
  }

  /**
   * Changes a form. A change of its questions, title or settings moves `rev`
   * (`bump`), which is what a held press checks, and keeps the question list
   * as a version when it moved.
   */
  update(workspaceId: string, formId: string, patch: MsFormPatch, o: { bump?: boolean; by?: Principal | 'page' } = {}): MsFormRow {
    const was = this.get(workspaceId, formId)
    if (!was) throw new Error('That Microsoft form is not in this job any more.')
    const sets: string[] = []
    const values: unknown[] = []
    for (const [key, value] of Object.entries(patch) as [keyof MsFormPatch, never][]) {
      if (value === undefined) continue
      const [column, write] = COLUMNS[key]
      sets.push(`${column} = ?`)
      values.push(write(value))
    }
    const moved = patch.questions !== undefined && JSON.stringify(patch.questions) !== JSON.stringify(was.questions)
    const rev = o.bump || moved ? was.rev + 1 : was.rev
    sets.push('rev = ?', 'updated_at = ?')
    values.push(rev, this.now())
    this.db.prepare(`UPDATE work_msforms SET ${sets.join(', ')} WHERE workspace_id = ? AND form_id = ?`).run(...(values as (string | number | null)[]), workspaceId, formId)
    if (moved) this.version(workspaceId, formId, rev, patch.questions!, o.by ?? 'page')
    return this.get(workspaceId, formId)!
  }

  versions(workspaceId: string, formId: string): { rev: number; questions: MsAnyQuestion[]; at: number; by: Principal | 'page' }[] {
    return (this.db.prepare('SELECT rev, questions, at, by FROM work_msforms_versions WHERE workspace_id = ? AND form_id = ? ORDER BY rev').all(workspaceId, formId) as Raw[]).map((r) => ({
      rev: Number(r.rev),
      questions: json<MsAnyQuestion[]>(r.questions, []),
      at: Number(r.at),
      by: r.by as Principal | 'page'
    }))
  }

  private version(workspaceId: string, formId: string, rev: number, questions: MsAnyQuestion[], by: Principal | 'page'): void {
    this.db.prepare('INSERT OR REPLACE INTO work_msforms_versions (workspace_id, form_id, rev, questions, at, by) VALUES (?, ?, ?, ?, ?, ?)').run(workspaceId, formId, rev, JSON.stringify(questions), this.now(), by)
  }

  remove(workspaceId: string, formId: string): void {
    this.db.prepare('DELETE FROM work_msforms WHERE workspace_id = ? AND form_id = ?').run(workspaceId, formId)
    this.db.prepare('DELETE FROM work_msforms_versions WHERE workspace_id = ? AND form_id = ?').run(workspaceId, formId)
  }

  removeWorkspace(workspaceId: string): MsFormRow[] {
    const rows = this.list(workspaceId)
    this.db.prepare('DELETE FROM work_msforms WHERE workspace_id = ?').run(workspaceId)
    this.db.prepare('DELETE FROM work_msforms_versions WHERE workspace_id = ?').run(workspaceId)
    return rows
  }
}
