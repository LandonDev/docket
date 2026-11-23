import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Bbox, PdfField, PdfFieldType, PdfFieldValue, PdfMark, PdfMode, PdfProvenance, PdfSignature, PdfWritten } from '@shared/contract-work-pdf'
import { PdfSignatureSchema } from '@shared/contract-work-pdf'
import type { CanvasItem, Principal } from '@shared/work'
import { registerMoveModule } from '../../sessionMove'
import { dropKept, ensureFileKeys, fileKeyedMoveModule, keptOf, type FileKeyed, type Kept } from '../canvas/fileKey'
import type { FormField } from './form'

/**
 * What this host keeps over a PDF item (docs/agents/work-pdf.md "The
 * store"): one row per field that has something of ours in it (an agent's
 * value, the owner's, a box placed on a page), his highlights, the item's
 * mode, and his one saved signature. The file itself is never written.
 * Rows are kept by the file (`file_key`, canvas/fileKey.ts): a Files tab and
 * a thread on one file read and write one set, under the item `keep` names.
 */

/** The tables kept by the file; a highlight's id is its own, so a copy that leaves takes new ones. */
export const PDF_KEYED: FileKeyed = {
  kind: 'pdf',
  items: 'work_pdf_items',
  rows: ['work_pdf_fields', 'work_pdf_marks'],
  renumber: { work_pdf_marks: (row, fresh) => ({ ...row, id: fresh(String(row.id)) }) }
}

export function ensurePdfTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_pdf_items (
    item_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'suggests',
    signed_at INTEGER, signed_rev TEXT, signed_hash TEXT,
    written TEXT, labels TEXT,
    updated_at INTEGER NOT NULL)`)
  db.exec(`CREATE TABLE IF NOT EXISTS work_pdf_fields (
    item_id TEXT NOT NULL, session_id TEXT NOT NULL, key TEXT NOT NULL,
    origin TEXT NOT NULL, type TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
    page INTEGER NOT NULL DEFAULT 1, bbox TEXT,
    value TEXT, proposed TEXT, state TEXT NOT NULL,
    provenance TEXT NOT NULL DEFAULT '[]', by TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (item_id, key))`)
  db.exec(`CREATE INDEX IF NOT EXISTS work_pdf_fields_by_session ON work_pdf_fields (session_id)`)
  db.exec(`CREATE TABLE IF NOT EXISTS work_pdf_marks (
    id TEXT PRIMARY KEY, item_id TEXT NOT NULL, session_id TEXT NOT NULL,
    page INTEGER NOT NULL, quads TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', note TEXT,
    by TEXT NOT NULL, at INTEGER NOT NULL)`)
  db.exec(`CREATE INDEX IF NOT EXISTS work_pdf_marks_by_item ON work_pdf_marks (item_id, page)`)
  // One row: the owner's drawn signature is this host's, not a thread's, and never rides a move.
  db.exec(`CREATE TABLE IF NOT EXISTS work_pdf_signature (id TEXT PRIMARY KEY CHECK (id = 'owner'), strokes TEXT NOT NULL, updated_at INTEGER NOT NULL)`)
  // A highlight an older build made has no item row: one is made, so the item's rows are found by its file too.
  db.exec(`INSERT OR IGNORE INTO work_pdf_items (item_id, session_id, updated_at) SELECT item_id, session_id, MAX(at) FROM work_pdf_marks WHERE item_id NOT IN (SELECT item_id FROM work_pdf_items) GROUP BY item_id`)
  db.exec(`INSERT OR IGNORE INTO work_pdf_items (item_id, session_id, updated_at) SELECT item_id, session_id, MAX(updated_at) FROM work_pdf_fields WHERE item_id NOT IN (SELECT item_id FROM work_pdf_items) GROUP BY item_id`)
  ensureFileKeys(db, PDF_KEYED)
  // A thread that moves takes what it kept over its PDFs with it, and what it shared with a tab stays here too.
  registerMoveModule(db, fileKeyedMoveModule('pdf-items', 'work_pdf_items', PDF_KEYED))
  registerMoveModule(db, fileKeyedMoveModule('pdf-fields', 'work_pdf_fields', PDF_KEYED))
  registerMoveModule(db, fileKeyedMoveModule('pdf-marks', 'work_pdf_marks', PDF_KEYED))
}

interface FieldRow {
  item_id: string
  session_id: string
  key: string
  origin: string
  type: string
  label: string
  page: number
  bbox: string | null
  value: string | null
  proposed: string | null
  state: string
  provenance: string
  by: string | null
  updated_at: number
}

const parse = <T,>(raw: string | null | undefined, otherwise: T): T => {
  if (raw === null || raw === undefined) return otherwise
  try {
    return JSON.parse(raw) as T
  } catch {
    return otherwise
  }
}
/** A stored value: JSON, so `false` and `""` are values and SQL NULL is "none of ours". */
const put = (v: PdfFieldValue | undefined): string | null => (v === undefined || v === null ? null : JSON.stringify(v))
const got = (raw: string | null): PdfFieldValue => parse<PdfFieldValue>(raw, null)

/** A value an agent proposes or writes for one field. */
export interface FieldFill {
  key: string
  value: string | boolean
  source: PdfProvenance
}
/** A box placed on a page that has no field there. */
export interface FieldPlace {
  key: string
  type: PdfFieldType
  label: string
  page: number
  bbox: Bbox
}

export class PdfStore {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Where an item's rows are: the id and session every other method takes. Two items of a workspace on one file
   * answer one keeper; the first to come makes its row, with the file's key.
   */
  keep(item: Pick<CanvasItem, 'id' | 'sessionId' | 'workspaceId' | 'source'>): Kept {
    const kept = keptOf(this.db, PDF_KEYED, item)
    if (kept.fileKey) this.db.prepare(`INSERT OR IGNORE INTO work_pdf_items (item_id, session_id, file_key, updated_at) VALUES (?, ?, ?, ?)`).run(kept.id, kept.sessionId, kept.fileKey, Date.now())
    return kept
  }

  // ── the item ──────────────────────────────────────────────────────

  private item(itemId: string): { mode: PdfMode; signed_at: number | null; written: string | null; labels: string | null } | undefined {
    return this.db.prepare(`SELECT mode, signed_at, written, labels FROM work_pdf_items WHERE item_id = ?`).get(itemId) as never
  }

  private touch(itemId: string, sessionId: string): void {
    this.db.prepare(`INSERT INTO work_pdf_items (item_id, session_id, updated_at) VALUES (?, ?, ?) ON CONFLICT (item_id) DO UPDATE SET updated_at = excluded.updated_at`).run(itemId, sessionId, Date.now())
  }

  mode(itemId: string): PdfMode {
    return this.item(itemId)?.mode === 'writes' ? 'writes' : 'suggests'
  }

  setMode(itemId: string, sessionId: string, mode: PdfMode): void {
    this.touch(itemId, sessionId)
    this.db.prepare(`UPDATE work_pdf_items SET mode = ? WHERE item_id = ?`).run(mode, itemId)
  }

  signedAt(itemId: string): number | null {
    return this.item(itemId)?.signed_at ?? null
  }

  written(itemId: string): (PdfWritten & { before: FieldRow[]; keys: string[]; after?: Record<string, string> }) | null {
    return parse(this.item(itemId)?.written, null)
  }

  /** Labels read off the page for fields that carry none, by the file's rev. */
  labels(itemId: string, rev: string): Record<string, string> | null {
    const kept = parse<{ rev: string; labels: Record<string, string> } | null>(this.item(itemId)?.labels, null)
    return kept?.rev === rev ? kept.labels : null
  }

  setLabels(itemId: string, sessionId: string, rev: string, labels: Record<string, string>): void {
    this.touch(itemId, sessionId)
    this.db.prepare(`UPDATE work_pdf_items SET labels = ? WHERE item_id = ?`).run(JSON.stringify({ rev, labels }), itemId)
  }

  // ── fields ────────────────────────────────────────────────────────

  private rows(itemId: string): FieldRow[] {
    return this.db.prepare(`SELECT * FROM work_pdf_fields WHERE item_id = ? ORDER BY page, key`).all(itemId) as unknown as FieldRow[]
  }

  private row(itemId: string, key: string): FieldRow | undefined {
    return this.db.prepare(`SELECT * FROM work_pdf_fields WHERE item_id = ? AND key = ?`).get(itemId, key) as FieldRow | undefined
  }

  private write(row: FieldRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO work_pdf_fields (item_id, session_id, key, origin, type, label, page, bbox, value, proposed, state, provenance, by, updated_at, file_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${FILE_KEY})`
      )
      .run(row.item_id, row.session_id, row.key, row.origin, row.type, row.label, row.page, row.bbox, row.value, row.proposed, row.state, row.provenance, row.by, row.updated_at, row.item_id)
  }

  private drop(itemId: string, key: string): void {
    this.db.prepare(`DELETE FROM work_pdf_fields WHERE item_id = ? AND key = ?`).run(itemId, key)
  }

  /**
   * The form as the canvas draws it: the file's own fields with what we
   * keep over them, then the boxes placed on its pages. `labels` are the
   * ones read off the page for fields that carry none.
   */
  fields(itemId: string, form: readonly FormField[], labels: Record<string, string> | null = null): PdfField[] {
    const rows = new Map(this.rows(itemId).map((r) => [r.key, r]))
    const out: PdfField[] = []
    for (const f of form) {
      const row = rows.get(f.key)
      rows.delete(f.key)
      const label = f.label || labels?.[f.key] || shortName(f.key)
      const base = { key: f.key, label, type: f.type, page: f.page, bbox: f.bbox, origin: 'acroform' as const, ...(f.options ? { options: f.options } : {}) }
      if (!row || row.origin !== 'acroform') {
        out.push({ ...base, value: f.value, state: f.type === 'signature' ? 'needs-owner' : isEmpty(f.value) ? 'empty' : 'accepted', provenance: [] })
        continue
      }
      out.push({ ...base, ...this.shown(row, f.value) })
    }
    // What is left are boxes of ours; a row for a field the file no longer has is not shown.
    for (const row of rows.values()) {
      if (row.origin !== 'overlay') continue
      const bbox = parse<Bbox | null>(row.bbox, null)
      if (!bbox) continue
      out.push({ key: row.key, label: row.label, type: row.type as PdfFieldType, page: row.page, bbox, origin: 'overlay', ...this.shown(row, null) })
    }
    return out
  }

  private shown(row: FieldRow, own: PdfFieldValue): Pick<PdfField, 'value' | 'proposed' | 'state' | 'provenance' | 'by'> {
    const value = row.value === null ? own : got(row.value)
    const state = row.state as PdfField['state']
    return {
      value,
      ...(state === 'proposed' ? { proposed: got(row.proposed) } : {}),
      state,
      provenance: parse<PdfProvenance[]>(row.provenance, []),
      ...(row.by ? { by: row.by as Principal } : {})
    }
  }

  /** The values of ours the file's own fields carry in a copy: what he accepted or typed, never what still waits. */
  ownValues(itemId: string): Array<{ key: string; value: string | boolean }> {
    return this.rows(itemId).flatMap((row) => {
      if (row.origin !== 'acroform' || row.type === 'signature' || row.value === null) return []
      const value = got(row.value)
      return value === null ? [] : [{ key: row.key, value }]
    })
  }

  /** How many values still wait for him. */
  pending(itemId: string): number {
    return this.rows(itemId).filter((row) => row.state === 'proposed').length
  }

  /**
   * Places boxes on pages (a flat form's line, a signature line, its date).
   * Only `box:` keys, never one the form owns. Placing a key again moves its
   * box, but never retypes it (a value would ride into a box of another
   * kind), and never moves a signature or date he filled: his ink goes only
   * where he pressed Sign. Returns what it refused, one sentence each.
   */
  place(itemId: string, sessionId: string, places: readonly FieldPlace[], by: Principal, known: readonly FormField[] = []): { placed: string[]; refused: string[] } {
    const owned = new Set(known.map((f) => f.key))
    const placed: string[] = []
    const refused: string[] = []
    for (const p of places) {
      if (!p.key.startsWith(BOX) || owned.has(p.key)) {
        refused.push(`${p.key}: a placed box's key starts with "${BOX}" and is not one of the form's fields`)
        continue
      }
      const was = this.row(itemId, p.key)
      if (was && was.type !== p.type) {
        refused.push(`${p.key}: it is a ${was.type} box; place a new key for a ${p.type} box`)
        continue
      }
      const owner = p.type === 'signature' || p.type === 'date'
      const moved = !!was && (was.page !== p.page || was.bbox !== JSON.stringify(p.bbox))
      if (owner && was && was.state !== 'needs-owner' && moved) {
        refused.push(`${p.key}: the owner has signed there; it cannot be moved`)
        continue
      }
      this.write({
        item_id: itemId,
        session_id: sessionId,
        key: p.key,
        origin: 'overlay',
        type: p.type,
        label: p.label,
        page: p.page,
        bbox: JSON.stringify(p.bbox),
        value: was?.value ?? null,
        proposed: was?.proposed ?? null,
        state: was && was.state !== 'empty' && was.state !== 'needs-owner' ? was.state : owner ? 'needs-owner' : 'empty',
        provenance: was?.provenance ?? '[]',
        by: was?.by ?? by,
        updated_at: Date.now()
      })
      placed.push(p.key)
    }
    this.touch(itemId, sessionId)
    return { placed, refused }
  }

  /**
   * An agent's values. `direct`: the mode is "Agent writes", so each lands
   * accepted and the lot is one write he can take back; else each waits as
   * a suggestion. `known` are the file's own fields: a value for a key that
   * is neither one of those nor a placed box is refused by name.
   */
  fill(itemId: string, sessionId: string, fills: readonly FieldFill[], by: Principal, known: readonly FormField[], direct: boolean): { done: string[]; refused: string[]; written?: PdfWritten } {
    const form = new Map(known.map((f) => [f.key, f]))
    const done: string[] = []
    const refused: string[] = []
    // Each key's row as it was before this call, once: a key filled twice in one call undoes to its first state.
    const before = new Map<string, FieldRow | null>()
    const now = Date.now()
    for (const fill of fills) {
      const was = this.row(itemId, fill.key)
      const own = form.get(fill.key)
      const type = (was?.type ?? own?.type) as PdfFieldType | undefined
      if (!type) {
        refused.push(`${fill.key}: the form has no field of that name`)
        continue
      }
      if (type === 'signature' || type === 'date') {
        refused.push(`${fill.key}: the signature and its date are the owner's to place`)
        continue
      }
      if (own?.readOnly) {
        refused.push(`${fill.key}: the form does not let this field be changed`)
        continue
      }
      if ((type === 'checkbox') !== (typeof fill.value === 'boolean')) {
        refused.push(`${fill.key}: ${type === 'checkbox' ? 'a checkbox takes true or false' : 'this field takes text'}`)
        continue
      }
      if (type === 'choice' && own?.options && !own.options.includes(String(fill.value))) {
        refused.push(`${fill.key}: not one of its options (${own.options.join(', ')})`)
        continue
      }
      if (typeof fill.value === 'string' && own?.maxLength !== undefined && fill.value.length > own.maxLength) {
        refused.push(`${fill.key}: at most ${own.maxLength} characters fit`)
        continue
      }
      if (!before.has(fill.key)) before.set(fill.key, was ?? null)
      // A value that was still waiting is replaced, and its source with it.
      const provenance = JSON.stringify([fill.source, ...parse<PdfProvenance[]>(was?.provenance, []).slice(was?.state === 'proposed' ? 1 : 0)].slice(0, 20))
      const base = {
        item_id: itemId,
        session_id: sessionId,
        key: fill.key,
        origin: was?.origin ?? 'acroform',
        type,
        label: was?.label ?? '',
        page: was?.page ?? own?.page ?? 1,
        bbox: was?.bbox ?? null,
        provenance,
        by,
        updated_at: now
      }
      this.write(direct ? { ...base, value: put(fill.value), proposed: null, state: 'accepted' } : { ...base, value: was?.value ?? null, proposed: put(fill.value), state: 'proposed' })
      done.push(fill.key)
    }
    this.touch(itemId, sessionId)
    if (!direct || done.length === 0) return { done, refused }
    const keys = [...before.keys()]
    const written = { id: randomUUID(), text: `Filled ${keys.length} ${keys.length === 1 ? 'field' : 'fields'}`, at: now }
    const rows = [...before.values()].filter((r): r is FieldRow => r !== null)
    // What the write left in each field: Undo puts back only a field that still holds it.
    const after = Object.fromEntries(keys.map((k) => [k, rowKey(this.row(itemId, k))]))
    this.db.prepare(`UPDATE work_pdf_items SET written = ? WHERE item_id = ?`).run(JSON.stringify({ ...written, keys, before: rows, after }), itemId)
    return { done, refused, written }
  }

  /** Takes back the agent's last direct write: each field it touched is as it was. */
  undo(itemId: string, writeId: string): boolean {
    const w = this.written(itemId)
    if (!w || w.id !== writeId) return false
    // A field changed since the write (his own correction, a review, a later suggestion) is his now: Undo leaves it.
    const keys = w.keys.filter((k) => !w.after || w.after[k] === rowKey(this.row(itemId, k)) || w.after[k] === rowKeyBefore(this.row(itemId, k)))
    const sessionId = (this.db.prepare(`SELECT session_id FROM work_pdf_items WHERE item_id = ?`).get(itemId) as { session_id: string } | undefined)?.session_id
    for (const key of keys) this.drop(itemId, key)
    // A row as it was, under the item that keeps them now: another may have kept them when the write was made.
    for (const row of w.before) if (keys.includes(row.key)) this.write({ ...row, item_id: itemId, session_id: sessionId ?? row.session_id })
    this.db.prepare(`UPDATE work_pdf_items SET written = NULL WHERE item_id = ?`).run(itemId)
    return true
  }

  /** The owner takes or drops what waits. Returns the keys it settled. */
  review(itemId: string, keys: readonly string[] | 'all', verdict: 'accept' | 'reject'): string[] {
    const settled: string[] = []
    for (const row of this.rows(itemId)) {
      if (row.state !== 'proposed' || (keys !== 'all' && !keys.includes(row.key))) continue
      if (verdict === 'accept') {
        this.write({ ...row, value: row.proposed, proposed: null, state: 'accepted', updated_at: Date.now() })
      } else {
        // The entry that came with the value goes with it; what he had before stands.
        const provenance = JSON.stringify(parse<PdfProvenance[]>(row.provenance, []).slice(1))
        if (row.value === null && row.origin === 'acroform') this.drop(itemId, row.key)
        else this.write({ ...row, proposed: null, state: row.value === null ? 'empty' : 'accepted', provenance, updated_at: Date.now() })
      }
      settled.push(row.key)
    }
    return settled
  }

  /** The owner's own value. null: none of ours (the file's own shows again); a box of ours is emptied. */
  setOwn(itemId: string, sessionId: string, key: string, value: PdfFieldValue, own: FormField | undefined): void {
    const was = this.row(itemId, key)
    if (!was && !own) throw new Error(`The form has no field named ${key}.`)
    const type = (was?.type ?? own?.type) as PdfFieldType
    if (type === 'signature' || type === 'date') throw new Error('Press Sign to place your signature and the date.')
    if (value === null) {
      if (was?.origin === 'overlay') this.write({ ...was, value: null, proposed: null, state: 'empty', provenance: '[]', updated_at: Date.now() })
      else this.drop(itemId, key)
      return
    }
    if ((type === 'checkbox') !== (typeof value === 'boolean')) throw new Error(type === 'checkbox' ? 'A checkbox is on or off.' : 'This field takes text.')
    const typed: PdfProvenance = { kind: 'manual', label: 'You typed it', confidence: 1 }
    this.write({
      item_id: itemId,
      session_id: sessionId,
      key,
      origin: was?.origin ?? 'acroform',
      type,
      label: was?.label ?? '',
      page: was?.page ?? own?.page ?? 1,
      bbox: was?.bbox ?? null,
      value: put(value),
      proposed: null,
      state: 'accepted',
      provenance: JSON.stringify([typed, ...parse<PdfProvenance[]>(was?.provenance, []).slice(was?.state === 'proposed' ? 1 : 0)].slice(0, 20)),
      by: 'owner',
      updated_at: Date.now()
    })
    this.touch(itemId, sessionId)
  }

  /**
   * His press: the signature goes on, or comes off. The date fields say the
   * day. A signature is bound to what he signed: the file's `rev` and the
   * values the copy carries (`valuesHash`); `signedOver` drops it when
   * either moves.
   */
  sign(itemId: string, sessionId: string, signed: boolean, form: readonly FormField[], today: string, rev: string | null = null): void {
    this.touch(itemId, sessionId)
    this.db.prepare(`UPDATE work_pdf_items SET signed_at = ?, signed_rev = ?, signed_hash = NULL WHERE item_id = ?`).run(signed ? Date.now() : null, signed ? rev : null, itemId)
    const now = Date.now()
    // The file's own signature fields get a row so the page shows them signed.
    for (const f of form) {
      if (f.type !== 'signature') continue
      if (!signed) this.drop(itemId, f.key)
      else this.write({ item_id: itemId, session_id: sessionId, key: f.key, origin: 'acroform', type: 'signature', label: f.label, page: f.page, bbox: null, value: 'true', proposed: null, state: 'accepted', provenance: '[]', by: 'owner', updated_at: now })
    }
    for (const row of this.rows(itemId)) {
      if (row.origin !== 'overlay' || (row.type !== 'signature' && row.type !== 'date')) continue
      this.write({ ...row, value: signed ? put(row.type === 'date' ? today : true) : null, state: signed ? 'accepted' : 'needs-owner', by: 'owner', updated_at: now })
    }
    if (signed) this.db.prepare(`UPDATE work_pdf_items SET signed_hash = ? WHERE item_id = ?`).run(this.valuesHash(itemId), itemId)
  }

  /**
   * What the signed copy carries, as one hash: each value the export writes
   * (a form field's value of ours, as `ownValues` reads it; a box's value),
   * and where each placed box sits. A suggestion waiting over a value is not
   * in it: the copy carries the value, not the suggestion.
   */
  valuesHash(itemId: string): string {
    const carried = this.rows(itemId).flatMap((r) => {
      if (r.origin === 'overlay') return [[r.key, r.type, r.page, r.bbox, r.value]]
      return r.type === 'signature' || r.value === null ? [] : [[r.key, r.value]]
    })
    return createHash('sha256').update(JSON.stringify(carried)).digest('hex')
  }

  /**
   * Whether his signature still stands on this item: he signed, and neither
   * the file (`rev`) nor the values have changed since. When either has, the
   * signature comes off (as his own press to unsign would) and this says no.
   */
  signedOver(itemId: string, sessionId: string, rev: string, form: readonly FormField[]): boolean {
    const it = this.db.prepare(`SELECT signed_at, signed_rev, signed_hash FROM work_pdf_items WHERE item_id = ?`).get(itemId) as { signed_at: number | null; signed_rev: string | null; signed_hash: string | null } | undefined
    if (!it?.signed_at) return false
    if (it.signed_rev === rev && it.signed_hash === this.valuesHash(itemId)) return true
    this.sign(itemId, sessionId, false, form, '')
    return false
  }

  // ── highlights ────────────────────────────────────────────────────

  marks(itemId: string): PdfMark[] {
    const rows = this.db.prepare(`SELECT * FROM work_pdf_marks WHERE item_id = ? ORDER BY page, at`).all(itemId) as unknown as Array<{ id: string; page: number; quads: string; text: string; note: string | null; by: string; at: number }>
    return rows.map((r) => ({ id: r.id, page: r.page, quads: parse<Bbox[]>(r.quads, []), text: r.text, ...(r.note ? { note: r.note } : {}), by: r.by as Principal, at: r.at }))
  }

  mark(itemId: string, sessionId: string, mark: { page: number; quads: Bbox[]; text: string; note?: string }, by: Principal): string {
    const id = randomUUID()
    this.touch(itemId, sessionId)
    this.db
      .prepare(`INSERT INTO work_pdf_marks (id, item_id, session_id, page, quads, text, note, by, at, file_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${FILE_KEY})`)
      .run(id, itemId, sessionId, mark.page, JSON.stringify(mark.quads), mark.text, mark.note ?? null, by, Date.now(), itemId)
    return id
  }

  unmark(itemId: string, markId: string): void {
    this.db.prepare(`DELETE FROM work_pdf_marks WHERE item_id = ? AND id = ?`).run(itemId, markId)
  }

  // ── the signature ─────────────────────────────────────────────────

  signature(): PdfSignature | null {
    const row = this.db.prepare(`SELECT strokes FROM work_pdf_signature WHERE id = 'owner'`).get() as { strokes: string } | undefined
    const parsed = PdfSignatureSchema.safeParse(parse(row?.strokes, null))
    return parsed.success ? parsed.data : null
  }

  setSignature(signature: PdfSignature | null): void {
    if (!signature) return void this.db.prepare(`DELETE FROM work_pdf_signature WHERE id = 'owner'`).run()
    this.db.prepare(`INSERT OR REPLACE INTO work_pdf_signature (id, strokes, updated_at) VALUES ('owner', ?, ?)`).run(JSON.stringify(signature), Date.now())
  }

  // ── deleted threads ───────────────────────────────────────────────

  /** Deleted threads' rows; what one kept for a file another item still shows passes to that item. */
  removeSessions(ids: readonly string[]): void {
    dropKept(this.db, PDF_KEYED, { sessions: ids })
  }

  /** A closed Files tab's rows: the item is gone, its owner is not; what it kept for a file a thread still shows passes to the thread's item. Its own folder went with the canvas item. */
  removeItems(itemIds: readonly string[]): void {
    dropKept(this.db, PDF_KEYED, { items: itemIds })
  }
}

/** The prefix of a box's key: our own ids, apart from every key a form can have. */
export const BOX = 'box:'
/** A row as one string, to tell whether it changed: what it holds, not which item keeps it. */
const rowKey = (row: FieldRow | undefined): string => {
  if (!row) return 'none'
  const { item_id: _i, session_id: _s, file_key: _f, ...held } = row as FieldRow & { file_key?: string | null }
  return JSON.stringify({ ...held, updated_at: 0 })
}
/** The same as a write made before the file key wrote it. */
const rowKeyBefore = (row: FieldRow | undefined): string => {
  if (!row) return 'none'
  const { file_key: _f, ...was } = row as FieldRow & { file_key?: string | null }
  return JSON.stringify({ ...was, updated_at: 0 })
}
/** A new row takes the key its item's row holds. */
const FILE_KEY = `(SELECT file_key FROM work_pdf_items WHERE item_id = ?)`

const isEmpty = (v: PdfFieldValue): boolean => v === null || v === '' || v === false

/** A field's name as a person can read it when the file gives no label: the last part of `topmostSubform[0].Page1[0].f1_01[0]`. */
export function shortName(key: string): string {
  const last = key.split('.').pop() ?? key
  return last.replace(/\[\d+\]$/, '')
}
