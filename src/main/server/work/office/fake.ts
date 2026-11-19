import type { OfficeApp, OfficeCell } from '@shared/contract-work-office'
import { parseA1 } from '../sheets/a1'
import { OfficeError, type CalendarEvent, type MailFull, type MailOut, type OfficeCarrier, type EventOut } from './carrier'

/**
 * An Office in memory, as the recorded carrier for the box's tests
 * (docs/agents/work-office.md "Testing"): workbooks of cells, documents of
 * paragraphs, decks of text, Outlook's mail and calendar. Every call is
 * logged in `log`, so a test can say what reached Office and what never did.
 */

interface FakeCell {
  v: OfficeCell
  f: string
  z: string
}

export interface FakeBook {
  name: string
  sheets: Map<string, Map<string, FakeCell>>
}

const at = (r: number, c: number): string => `${r},${c}`

/** A file by its key, or by its name alone, as the Mac carrier's scripts find one (mac.ts `byKey`, `book`). */
const byKeyOrName = <T>(files: Map<string, T>, key: string): T | undefined => files.get(key) ?? [...files].find(([k]) => k.split(/[\\/]/).pop() === key)?.[1]

export class FakeOffice implements OfficeCarrier {
  readonly kind = 'fake' as const
  readonly log: { verb: string; args: unknown[] }[] = []
  readonly books = new Map<string, FakeBook>()
  readonly docs = new Map<string, { paragraphs: string[]; tracked: string[] }>()
  readonly decks = new Map<string, string[][]>()
  readonly mailbox: MailFull[] = []
  readonly sent: MailOut[] = []
  readonly drafts: MailOut[] = []
  readonly calendar: CalendarEvent[] = []
  readonly answers: { id: string; answer: string }[] = []
  readonly opened: { app: OfficeApp; ref: unknown }[] = []
  addresses: string[] = ['owner@example.com']
  /** a call to this verb throws, once */
  failNext: { verb: string; error: OfficeError } | null = null

  private seen(verb: string, ...args: unknown[]): void {
    this.log.push({ verb, args })
    if (this.failNext?.verb === verb) {
      const { error } = this.failNext
      this.failNext = null
      throw error
    }
  }

  /** A workbook with its sheets' cells: `{ Sheet1: { A1: 3, B1: '=A1*2' } }`. A formula's value is left null until `setValue`. */
  addBook(key: string, sheets: Record<string, Record<string, OfficeCell>>): FakeBook {
    const book: FakeBook = { name: key.split(/[\\/]/).pop() ?? key, sheets: new Map() }
    for (const [name, cells] of Object.entries(sheets)) {
      const m = new Map<string, FakeCell>()
      for (const [a1, v] of Object.entries(cells)) {
        const r = parseA1(a1)!
        m.set(at(r.startRow, r.startColumn), typeof v === 'string' && v.startsWith('=') ? { v: null, f: v, z: 'General' } : { v, f: '', z: 'General' })
      }
      book.sheets.set(name, m)
    }
    this.books.set(key, book)
    return book
  }

  /** Someone typed in Excel: a cell changes without us. */
  type(key: string, sheet: string, a1: string, v: OfficeCell): void {
    const r = parseA1(a1)!
    this.sheetOf(key, sheet).set(at(r.startRow, r.startColumn), typeof v === 'string' && v.startsWith('=') ? { v: null, f: v, z: 'General' } : { v, f: '', z: 'General' })
  }

  /** A co-author inserted `n` rows above `row` (zero-based): every cell at or below it moves down. */
  insertRows(key: string, sheet: string, row: number, n: number): void {
    const s = this.sheetOf(key, sheet)
    const moved = [...s.entries()].map(([k, c]) => {
      const [r, col] = k.split(',').map(Number)
      return [r >= row ? at(r + n, col) : k, c] as const
    })
    s.clear()
    for (const [k, c] of moved) s.set(k, c)
  }

  private sheetOf(key: string, sheet: string): Map<string, FakeCell> {
    const book = byKeyOrName(this.books, key)
    if (!book) throw new OfficeError(`No open workbook ${key}.`, 'not-found')
    const s = book.sheets.get(sheet)
    if (!s) throw new OfficeError(`${book.name} has no sheet ${sheet}.`, 'not-found')
    return s
  }

  /** what `outlookProblem` answers */
  problem: string | null = null
  async outlookProblem() {
    return this.problem
  }

  async apps() {
    this.seen('apps')
    return (['excel', 'word', 'powerpoint', 'outlook'] as const).map((app) => ({ app, installed: true, running: true, allowed: 'yes' as const }))
  }

  async workbooks() {
    this.seen('workbooks')
    return [...this.books.entries()].map(([key, b]) => ({
      key,
      name: b.name,
      sheets: [...b.sheets.entries()].map(([name, cells]) => {
        let rows = 0
        let columns = 0
        for (const k of cells.keys()) {
          const [r, c] = k.split(',').map(Number)
          rows = Math.max(rows, r + 1)
          columns = Math.max(columns, c + 1)
        }
        return { name, rows, columns }
      })
    }))
  }

  async readRange(book: string, sheet: string, address: string) {
    this.seen('readRange', book, sheet, address)
    const s = this.sheetOf(book, sheet)
    const r = parseA1(address)
    if (!r) throw new OfficeError(`${address} is not a range.`, 'not-found')
    const rows = (fn: (c: FakeCell | undefined) => unknown) =>
      Array.from({ length: r.endRow - r.startRow + 1 }, (_, i) => Array.from({ length: r.endColumn - r.startColumn + 1 }, (_, j) => fn(s.get(at(r.startRow + i, r.startColumn + j)))))
    return {
      values: rows((c) => c?.v ?? null) as OfficeCell[][],
      formulas: rows((c) => c?.f ?? '') as string[][],
      formats: rows((c) => c?.z ?? 'General') as string[][]
    }
  }

  async writeRange(book: string, sheet: string, address: string, grid: OfficeCell[][]) {
    this.seen('writeRange', book, sheet, address, grid)
    const s = this.sheetOf(book, sheet)
    const r = parseA1(address)!
    grid.forEach((row, i) =>
      row.forEach((v, j) => {
        const k = at(r.startRow + i, r.startColumn + j)
        if (v === null) s.delete(k)
        else s.set(k, typeof v === 'string' && v.startsWith('=') ? { v: null, f: v, z: s.get(k)?.z ?? 'General' } : { v, f: '', z: s.get(k)?.z ?? 'General' })
      })
    )
  }

  async documents() {
    this.seen('documents')
    return [...this.docs.keys()].map((key) => ({ key, name: key.split('/').pop() ?? key }))
  }

  async readDocument(doc: string) {
    this.seen('readDocument', doc)
    return [...this.docOf(doc).paragraphs]
  }

  async editDocument(doc: string, edit: Parameters<OfficeCarrier['editDocument']>[1], tracked: boolean) {
    this.seen('editDocument', doc, edit, tracked)
    const d = this.docOf(doc)
    let n = 1
    if ('insert' in edit) {
      if (edit.at === 'start') d.paragraphs.unshift(edit.insert)
      else d.paragraphs.push(edit.insert)
    } else {
      n = d.paragraphs.reduce((sum, p) => sum + p.split(edit.find).length - 1, 0)
      d.paragraphs = d.paragraphs.map((p) => p.split(edit.find).join(edit.replace))
    }
    if (tracked && n) d.tracked.push(JSON.stringify(edit))
    return n
  }

  private docOf(doc: string) {
    const d = byKeyOrName(this.docs, doc)
    if (!d) throw new OfficeError(`Nothing open named ${doc}.`, 'not-found')
    return d
  }

  async presentations() {
    this.seen('presentations')
    return [...this.decks.keys()].map((key) => ({ key, name: key.split('/').pop() ?? key }))
  }

  async readSlides(pres: string) {
    this.seen('readSlides', pres)
    const d = byKeyOrName(this.decks, pres)
    if (!d) throw new OfficeError(`Nothing open named ${pres}.`, 'not-found')
    return d.map((texts, i) => ({ index: i + 1, texts: [...texts] }))
  }

  async replaceSlideText(pres: string, find: string, replace: string) {
    this.seen('replaceSlideText', pres, find, replace)
    const d = byKeyOrName(this.decks, pres)
    if (!d) throw new OfficeError(`Nothing open named ${pres}.`, 'not-found')
    let n = 0
    for (const slide of d)
      slide.forEach((t, i) => {
        if (t.includes(find)) {
          slide[i] = t.split(find).join(replace)
          n++
        }
      })
    return n
  }

  async accounts() {
    this.seen('accounts')
    return [...this.addresses]
  }

  async listMail(q: { folder: 'inbox' | 'sent' | 'drafts'; limit: number; query?: string }) {
    this.seen('listMail', q)
    return this.mailbox.filter((m) => !q.query || m.subject.includes(q.query)).slice(0, q.limit)
  }

  async readMail(id: string) {
    this.seen('readMail', id)
    const m = this.mailbox.find((x) => x.id === id)
    if (!m) throw new OfficeError(`Outlook has no mail ${id}.`, 'not-found')
    return m
  }

  async draftMail(m: MailOut) {
    this.seen('draftMail', m)
    this.drafts.push(m)
    return `draft-${this.drafts.length}`
  }

  async sendMail(m: MailOut) {
    this.seen('sendMail', m)
    this.sent.push(m)
    return { id: `sent-${this.sent.length}` }
  }

  async events(from: string, to: string) {
    this.seen('events', from, to)
    return this.calendar.filter((e) => e.start >= from && e.start < to)
  }

  async createEvent(e: EventOut) {
    this.seen('createEvent', e)
    const id = `ev-${this.calendar.length + 1}`
    this.calendar.push({ id, subject: e.subject, start: e.start, end: e.end, location: e.location ?? '', organizer: this.addresses[0], attendees: e.attendees, response: '' })
    return id
  }

  async answerEvent(id: string, answer: string) {
    this.seen('answerEvent', id, answer)
    this.answers.push({ id, answer })
  }

  async eventByUid(uid: string) {
    this.seen('eventByUid', uid)
    return this.calendar.find((e) => e.id === uid || e.id === `uid:${uid}`)?.id ?? null
  }

  async open(app: OfficeApp, ref: unknown) {
    this.seen('open', app, ref)
    this.opened.push({ app, ref })
  }
}
