// A note's text: the `<text>` of one legacy comment rewritten in place. The note's box (the VML drawing),
// its author and every other comment keep their bytes. A new note is Excel's to make: it needs a drawing.
import {
  applySplices,
  children,
  documentRoot,
  elementText,
  openTag,
  valueOf,
  withBody,
  type ElementSpan,
  type Splice
} from './format-xml'
import { readRels, workbookMap } from './patch'
import { local } from './rules-xml'
import { clean, MAX_CELLS, MAX_CHARS, textOf, textTag } from './text-runs'
import { parseRef, refName } from './xml'
import { readEntry, readZip, writeZip, type Zip } from './zip'

export class NotesRefused extends Error {
  override name = 'NotesRefused'
}

export interface NotesEdit {
  kind: 'notes'
  /** the tab's name */
  sheet: string
  /** Rows and columns count from 0, as the grid's do. `text` is the note without its author line. */
  notes: readonly { row: number; column: number; text: string }[]
}
export interface NotesOptions {
  /** deflate level for the parts that change */
  level?: number
}
export interface NotesReport {
  partsChanged: string[]
  partsAdded: string[]
  partsRemoved: string[]
}
export interface Note {
  sheet: string
  row: number
  column: number
  author: string
  text: string
}

interface Piece {
  el: ElementSpan
  /** the run's `rPr` as the file has it, or '' */
  font: string
  text: string
}
interface Comment {
  row: number
  col: number
  author: string
  textEl: ElementSpan
  /** the `<t>` and `<r>` children of the text, in order */
  pieces: Piece[]
  words: string
  /** how many characters of `words` are the author's own line ("Name:"), or 0 */
  lead: number
  thread: boolean
}

function reading<T>(run: () => T): T {
  try {
    return run()
  } catch (err) {
    if (err instanceof NotesRefused) throw err
    throw new NotesRefused('This file’s notes could not be read. Change the note in Excel.', {
      cause: err
    })
  }
}

/** The legacy comments of one sheet, and which of them stand in for a thread. */
function commentsOf(zip: Zip, sheetPart: string, read: (part: string) => string) {
  const rels = readRels(zip, sheetPart).rels.filter(
    (rel) => !rel.external && zip.byName.has(rel.target)
  )
  const path = rels.find((rel) => rel.type.endsWith('/comments'))?.target
  if (!path) return undefined
  const threads = new Set<string>()
  for (const rel of rels) {
    if (!rel.type.endsWith('/threadedComment')) continue
    const xml = read(rel.target)
    const root = documentRoot(xml)
    if (!root) continue
    for (const el of children(xml, root)) {
      const ref = local(el.name) === 'threadedComment' && valueOf(openTag(xml, el), 'ref')
      if (ref) threads.add(ref.replace(/\$/g, '').toUpperCase())
    }
  }
  const xml = read(path)
  const root = documentRoot(xml)
  if (!root || local(root.name) !== 'comments') throw new Error('no comments root')
  const authors: string[] = []
  const comments: Comment[] = []
  for (const section of children(xml, root)) {
    if (local(section.name) === 'authors')
      for (const el of children(xml, section))
        if (local(el.name) === 'author') authors.push(textOf(xml, el))
    if (local(section.name) !== 'commentList') continue
    for (const el of children(xml, section)) {
      if (local(el.name) !== 'comment') continue
      const opening = openTag(xml, el)
      const ref = (valueOf(opening, 'ref') ?? '').replace(/\$/g, '').toUpperCase()
      const textEl = [...children(xml, el)].find((child) => local(child.name) === 'text')
      if (!textEl || !/^[A-Z]{1,3}\d+$/.test(ref)) continue
      const pieces: Piece[] = []
      for (const child of children(xml, textEl)) {
        if (local(child.name) === 't')
          pieces.push({ el: child, font: '', text: textOf(xml, child) })
        if (local(child.name) !== 'r') continue
        const piece: Piece = { el: child, font: '', text: '' }
        for (const part of children(xml, child)) {
          if (local(part.name) === 't') piece.text += textOf(xml, part)
          if (local(part.name) === 'rPr') piece.font = elementText(xml, part)
        }
        pieces.push(piece)
      }
      const author = authors[Number(valueOf(opening, 'authorId'))] ?? ''
      const words = pieces.map((piece) => piece.text).join('')
      // Excel begins a note with its author's name and a colon on a line of their own, in bold.
      const lead = author && words.startsWith(author + ':') ? author.length + 1 : 0
      const own = lead && (words.length === lead || /^\r?\n/.test(words.slice(lead)))
      comments.push({
        ...parseRef(ref),
        author,
        textEl,
        pieces,
        words,
        lead: own ? lead : 0,
        // The note Excel leaves for older readers of a thread is not a note of his.
        thread: threads.has(ref) || /^tc=\{/.test(author)
      })
    }
  }
  return { path, xml, comments }
}

/** The note without its author line. */
const body = (note: Comment) => clean(note.words.slice(note.lead).replace(/^\r?\n/, ''))

function openBook(bytes: Uint8Array) {
  const zip = readZip(bytes)
  const book = workbookMap(zip)
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
  return { zip, book, read: (part: string) => decoder.decode(readEntry(zip, part)) }
}

/** The notes of the workbook, or of one tab, without the notes that stand in for threads. Rows and columns count from 0. */
export function readNotes(bytes: Uint8Array, sheet?: string): Note[] {
  return reading(() => {
    const { zip, book, read } = openBook(bytes)
    const tabs = book.sheets.filter(
      (tab) => tab.kind === 'worksheet' && (sheet === undefined || tab.name === sheet)
    )
    if (sheet !== undefined && !tabs.length)
      throw new NotesRefused(`No worksheet named “${sheet}”.`)
    const out: Note[] = []
    for (const tab of tabs)
      for (const note of commentsOf(zip, tab.part, read)?.comments ?? [])
        if (!note.thread)
          out.push({
            sheet: tab.name,
            row: note.row - 1,
            column: note.col - 1,
            author: note.author,
            text: body(note)
          })
    return out
  })
}

/** The inside of a note's `<text>` with new words: the author's line as it was, then the words in the note's own font. */
function rewritten(xml: string, note: Comment, text: string): string {
  const prefix = note.textEl.name.slice(0, -4)
  const kept: string[] = []
  let at = 0
  for (const piece of note.pieces) {
    const end = at + piece.text.length
    // A run that is the author's line and no more stays byte for byte.
    if (end <= note.lead && local(piece.el.name) === 'r') {
      kept.push(elementText(xml, piece.el))
      at = end
      continue
    }
    const head = piece.text.slice(0, Math.max(0, note.lead - at)) + (note.lead ? '\n' : '')
    if (local(piece.el.name) === 't') return kept.join('') + textTag(prefix, head + text)
    return kept.join('') + `<${prefix}r>${piece.font}${textTag(prefix, head + text)}</${prefix}r>`
  }
  // Only the author's line was there: the words follow it in its font, not in bold.
  const last = note.pieces.at(-1)
  if (!last) return textTag(prefix, text)
  const font = last.font.replace(
    /<(?:[\w.-]+:)?b(?:\s[^>]*)?\/>|<(?:[\w.-]+:)?b(?:\s[^>]*)?>\s*<\/(?:[\w.-]+:)?b>/,
    ''
  )
  return kept.join('') + `<${prefix}r>${font}${textTag(prefix, '\n' + text)}</${prefix}r>`
}

/** Replace the text of notes that are already in the file, changing only their comments parts. */
export function patchNotes(
  bytes: Uint8Array,
  edits: readonly NotesEdit[],
  options: NotesOptions = {}
): { bytes: Uint8Array; report: NotesReport } {
  const report: NotesReport = { partsChanged: [], partsAdded: [], partsRemoved: [] }
  if (!edits.length) return { bytes, report }
  const { zip, book, read } = reading(() => openBook(bytes))
  const tabs = new Map(
    book.sheets.filter((tab) => tab.kind === 'worksheet').map((tab) => [tab.name, tab])
  )
  const bySheet = new Map<string, Map<string, string>>()
  let count = 0
  for (const edit of edits) {
    if (!edit || edit.kind !== 'notes' || !tabs.has(edit.sheet))
      throw new NotesRefused(`No worksheet named “${String(edit?.sheet).slice(0, 60)}”.`)
    if (!Array.isArray(edit.notes)) throw new NotesRefused('Give the notes whose text changes.')
    if ((count += edit.notes.length) > MAX_CELLS)
      throw new NotesRefused('Change at most 20,000 notes at once.')
    const notes = bySheet.get(edit.sheet) ?? new Map<string, string>()
    bySheet.set(edit.sheet, notes)
    for (const note of edit.notes) {
      const row = note?.row + 1
      const col = note?.column + 1
      if (
        !Number.isInteger(row) ||
        !Number.isInteger(col) ||
        row < 1 ||
        row > 1_048_576 ||
        col < 1 ||
        col > 16_384
      )
        throw new NotesRefused('That cell is outside the worksheet.')
      if (typeof note.text !== 'string') throw new NotesRefused('Give the note’s text.')
      if (note.text.length > MAX_CHARS)
        throw new NotesRefused(
          `The note at ${refName(row, col)} would hold more than 32,767 characters, the most a note takes.`
        )
      // The last word on a note wins.
      notes.set(refName(row, col), clean(note.text))
    }
  }

  const replace = new Map<string, Uint8Array>()
  for (const [name, notes] of bySheet) {
    const found = reading(() => commentsOf(zip, tabs.get(name)!.part, read))
    const byCell = new Map(found?.comments.map((note) => [refName(note.row, note.col), note]))
    const changes: Splice[] = []
    for (const [cell, text] of notes) {
      const note = byCell.get(cell)
      if (!note)
        throw new NotesRefused(`${cell} has no note in this file. Add a new note in Excel.`)
      if (note.thread)
        throw new NotesRefused(`The comment at ${cell} is a thread. Reply to it in Excel.`)
      if (text === body(note)) continue
      const { xml } = found!
      const el = note.textEl
      const inside = rewritten(xml, note, text)
      if (el.openEnd === el.end)
        changes.push({
          start: el.start,
          end: el.end,
          text: withBody(openTag(xml, el), el.name, inside)
        })
      else changes.push({ start: el.openEnd, end: el.close, text: inside })
    }
    if (changes.length)
      replace.set(found!.path, new TextEncoder().encode(applySplices(found!.xml, changes)))
  }
  if (!replace.size) return { bytes, report }
  report.partsChanged = [...replace.keys()]
  return { bytes: writeZip(zip, replace, new Set(), new Map(), { level: options.level }), report }
}
