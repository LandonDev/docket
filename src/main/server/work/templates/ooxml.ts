import { excelSerial, fieldKey, fieldMatches, fillText, uniqueFields, type TemplateForm } from '@shared/work/templates'
import { partText, readZip, writeZip, type ZipEntry } from './zip'

/**
 * Fields in an Office file (docs/agents/work-templates.md "The fill"): one
 * scan for all three forms, and the fill for Word and Excel. A deck is only
 * read here: the slides pillar writes it (deckFill.ts).
 *
 * Word and PowerPoint split a typed `{{Client}}` over several runs. A
 * paragraph's text runs are joined, fields are found in the joined text,
 * and a value is written into the run where its field starts; the rest of
 * that field's runs are emptied, and every run keeps its own formatting.
 * Nothing joins across a paragraph. XML is edited as text between known
 * tags, with values escaped; every part that holds no field keeps its
 * bytes.
 */

export type OfficeForm = Extract<TemplateForm, 'docx' | 'xlsx' | 'pptx'>
export const isOfficeForm = (form: string): form is OfficeForm => form === 'docx' || form === 'xlsx' || form === 'pptx'

// ── escaping ──────────────────────────────────────────────────────────

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
export const unescapeXml = (s: string): string =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (whole, body: string) => {
    if (body[0] !== '#') return NAMED[body]!
    const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
  })
// XML 1.0 holds no control character but tab, line feed and carriage return.
// eslint-disable-next-line no-control-regex
const BAD_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g
export const escapeXml = (s: string): string => s.replace(BAD_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// ── a part's text runs, by paragraph ──────────────────────────────────

interface Run {
  /** the open tag's span */
  open: number
  openEnd: number
  /** the text's span, between the tags */
  start: number
  end: number
}

/**
 * The text runs of a part, grouped by the paragraph that holds them. A run
 * belongs to the innermost paragraph open around it (a text box inside a
 * paragraph is its own); one outside every paragraph stands alone.
 */
export function paragraphsOf(xml: string, paraTags: readonly string[], textTag: string): Run[][] {
  const names = [...paraTags, textTag].map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const token = new RegExp(`<(/?)(${names})(?=[\\s/>])([^>]*)>`, 'g')
  const out: Run[][] = []
  const stack: Run[][] = []
  let open: { at: number; end: number } | null = null
  for (const m of xml.matchAll(token)) {
    const closing = m[1] === '/'
    const selfClosed = m[3]!.endsWith('/')
    if (m[2] === textTag) {
      if (closing) {
        if (open) {
          const run: Run = { open: open.at, openEnd: open.end, start: open.end, end: m.index }
          const para = stack[stack.length - 1]
          if (para) para.push(run)
          else out.push([run])
          open = null
        }
      } else if (!selfClosed) open = { at: m.index, end: m.index + m[0].length }
    } else if (closing) {
      const para = stack.pop()
      if (para?.length) out.push(para)
    } else if (!selfClosed) stack.push([])
  }
  // A part cut short: what was read still counts.
  for (const para of stack) if (para.length) out.push(para)
  return out.sort((a, b) => a[0]!.start - b[0]!.start)
}

interface Edit {
  start: number
  end: number
  text: string
}
const applyEdits = (xml: string, edits: Edit[]): string => {
  let out = ''
  let at = 0
  for (const e of edits.sort((a, b) => a.start - b.start)) {
    out += xml.slice(at, e.start) + e.text
    at = e.end
  }
  return out + xml.slice(at)
}

/** Whether a text tag must say its spaces count: Word and Excel drop a run's outer spaces without it. */
const needsPreserve = (textTag: string): boolean => textTag === 'w:t' || textTag === 't'

/** The edits that fill one paragraph's fields; none when it holds no field with a value. */
function fillParagraph(xml: string, runs: Run[], values: ReadonlyMap<string, string>, textTag: string): Edit[] {
  const texts = runs.map((r) => unescapeXml(xml.slice(r.start, r.end)))
  const joined = texts.join('')
  if (!joined.includes('{{')) return []
  const matches = fieldMatches(joined).filter((m) => values.has(m.key))
  if (!matches.length) return []
  const offsets: number[] = []
  let total = 0
  for (const t of texts) {
    offsets.push(total)
    total += t.length
  }
  /** the run that holds the character at `pos` */
  const runAt = (pos: number): number => {
    let i = offsets.length - 1
    while (i > 0 && offsets[i]! > pos) i--
    return i
  }
  const next = [...texts]
  const touched = new Set<number>()
  // Last field first, so a run's earlier offsets still stand when its turn comes.
  for (const m of [...matches].reverse()) {
    const value = values.get(m.key)!
    const first = runAt(m.start)
    const last = runAt(m.end - 1)
    if (first === last) next[first] = next[first]!.slice(0, m.start - offsets[first]!) + value + next[first]!.slice(m.end - offsets[first]!)
    else {
      next[last] = next[last]!.slice(m.end - offsets[last]!)
      for (let i = first + 1; i < last; i++) next[i] = ''
      next[first] = next[first]!.slice(0, m.start - offsets[first]!) + value
    }
    for (let i = first; i <= last; i++) touched.add(i)
  }
  const edits: Edit[] = []
  for (const i of touched) {
    const run = runs[i]!
    const text = next[i]!
    edits.push({ start: run.start, end: run.end, text: escapeXml(text) })
    const tag = xml.slice(run.open, run.openEnd)
    if (needsPreserve(textTag) && /^\s|\s$/.test(text) && !/xml:space\s*=/.test(tag)) edits.push({ start: run.openEnd - 1, end: run.openEnd - 1, text: ' xml:space="preserve"' })
  }
  return edits
}

/** A part's joined paragraph texts, in order. */
const paragraphTexts = (xml: string, paraTags: readonly string[], textTag: string): string[] =>
  paragraphsOf(xml, paraTags, textTag).map((runs) => runs.map((r) => unescapeXml(xml.slice(r.start, r.end))).join(''))

function fillPart(xml: string, paraTags: readonly string[], textTag: string, values: ReadonlyMap<string, string>): string {
  if (!xml.includes('{')) return xml
  const edits = paragraphsOf(xml, paraTags, textTag).flatMap((runs) => fillParagraph(xml, runs, values, textTag))
  return edits.length ? applyEdits(xml, edits) : xml
}

// ── the parts of each form ────────────────────────────────────────────

const WORD_PARTS = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/
const wordRank = (name: string): number => (name === 'word/document.xml' ? 0 : name.includes('header') ? 1 : name.includes('footer') ? 2 : 3)
const SLIDE_PART = /^ppt\/slides\/slide(\d+)\.xml$/
const SHEET_PART = /^xl\/worksheets\/sheet(\d+)\.xml$/
const STRINGS_PART = 'xl/sharedStrings.xml'
/** A sheet's page header and footer: one text each, with Excel's own `&` codes in it. */
const HEAD_FOOT = /<(oddHeader|oddFooter|evenHeader|evenFooter|firstHeader|firstFooter)>([^<]*)<\/\1>/g

const numbered = (parts: ZipEntry[], re: RegExp): ZipEntry[] => parts.filter((p) => re.test(p.name)).sort((a, b) => +re.exec(a.name)![1]! - +re.exec(b.name)![1]!)

/** A deck's slide parts in the order the deck shows them; by number where the deck's own list cannot be read. */
function slideParts(parts: ZipEntry[]): ZipEntry[] {
  const slides = numbered(parts, SLIDE_PART)
  const deck = parts.find((p) => p.name === 'ppt/presentation.xml')
  const rels = parts.find((p) => p.name === 'ppt/_rels/presentation.xml.rels')
  if (!deck || !rels) return slides
  const target = new Map<string, string>()
  for (const m of partText(rels).matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]*)"/.exec(m[0])?.[1]
    const to = /\bTarget="([^"]*)"/.exec(m[0])?.[1]
    if (id && to) target.set(id, to.startsWith('/') ? to.slice(1) : `ppt/${to}`)
  }
  const order = [...partText(deck).matchAll(/<p:sldId\b[^>]*\br:id="([^"]*)"/g)].map((m) => target.get(m[1]!))
  const rank = (name: string): number => {
    const i = order.indexOf(name)
    return i < 0 ? order.length : i
  }
  return [...slides].sort((a, b) => rank(a.name) - rank(b.name))
}

const DATE_KEY = fieldKey('Date')
/** Whether a cell's whole text is the Date field. */
const isLoneDate = (text: string): boolean => {
  const found = fieldMatches(text)
  return found.length === 1 && found[0]!.key === DATE_KEY && text.trim().length === found[0]!.end - found[0]!.start
}

/** The texts of a workbook's shared strings, by index. */
const sharedStrings = (xml: string): string[] => {
  // Each `si` is one string; one with no text run still holds its place.
  const out: string[] = []
  for (const m of xml.matchAll(/<si(?=[\s/>])([^>]*)>([\s\S]*?)<\/si>|<si\s*\/>/g)) {
    const body = m[2] ?? ''
    out.push(paragraphTexts(body.replace(/<rPh(?=[\s>])[\s\S]*?<\/rPh>/g, ''), [], 't').join(''))
  }
  return out
}

interface Cell {
  start: number
  end: number
  attrs: string
  body: string
}
/** A sheet's cells that hold something, in the file's order. */
function cellsOf(xml: string): Cell[] {
  const out: Cell[] = []
  for (const m of xml.matchAll(/<c(?=[\s>])([^>]*[^/>])?>([\s\S]*?)<\/c>/g)) out.push({ start: m.index, end: m.index + m[0].length, attrs: m[1] ?? '', body: m[2]! })
  return out
}
const cellType = (attrs: string): string => /\bt="([^"]*)"/.exec(attrs)?.[1] ?? 'n'
const cellValue = (body: string): string => /<v(?=[\s>])[^>]*>([^<]*)<\/v>/.exec(body)?.[1] ?? ''

// ── the scan ──────────────────────────────────────────────────────────

/** Every field name in an Office file, in the file's order, each once. Throws `NotZipError` for a file that is no zip. */
export function scanOffice(form: OfficeForm, bytes: Uint8Array): string[] {
  const parts = readZip(bytes)
  const names: string[] = []
  const take = (text: string): void => {
    if (text.includes('{{')) for (const m of fieldMatches(text)) names.push(m.name)
  }
  if (form === 'docx') {
    for (const part of parts.filter((p) => WORD_PARTS.test(p.name)).sort((a, b) => wordRank(a.name) - wordRank(b.name) || a.name.localeCompare(b.name))) paragraphTexts(partText(part), ['w:p'], 'w:t').forEach(take)
  } else if (form === 'pptx') {
    for (const part of slideParts(parts)) paragraphTexts(partText(part), ['a:p'], 'a:t').forEach(take)
  } else {
    const strings = parts.find((p) => p.name === STRINGS_PART)
    const shared = strings ? sharedStrings(partText(strings)) : []
    const sheets = numbered(parts, SHEET_PART).map(partText)
    // In the cells' order, sheet by sheet: a workbook's shared strings stand in the order they were first typed, not where they are.
    for (const xml of sheets) {
      for (const cell of cellsOf(xml)) {
        const type = cellType(cell.attrs)
        if (type === 's') take(shared[+cellValue(cell.body)] ?? '')
        else if (type === 'inlineStr') take(paragraphTexts(cell.body, ['is'], 't').join(''))
      }
    }
    for (const xml of sheets) for (const m of xml.matchAll(HEAD_FOOT)) take(unescapeXml(m[2]!))
    // A string no cell shows (a rich string in a table's head, say) is still the file's.
    shared.forEach(take)
  }
  return uniqueFields(names)
}

// ── the fill ──────────────────────────────────────────────────────────

/** Excel's built-in number formats that show a date or a time. */
const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58])
/** Whether a format's code shows a date: a day, month, year, hour or second letter outside its quotes and brackets. */
const isDateCode = (code: string): boolean => /[dmyhs]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '').replace(/general/gi, ''))

/** The cell styles (a cell's `s`) whose number format shows a date. */
export function dateStyles(stylesXml: string): Set<number> {
  const custom = new Set<number>()
  for (const m of stylesXml.matchAll(/<numFmt\b[^>]*>/g)) {
    const id = /\bnumFmtId="(\d+)"/.exec(m[0])?.[1]
    const code = /\bformatCode="([^"]*)"/.exec(m[0])?.[1]
    if (id && code !== undefined && isDateCode(unescapeXml(code))) custom.add(+id)
  }
  const out = new Set<number>()
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? ''
  let i = 0
  for (const m of xfs.matchAll(/<xf\b[^>]*>/g)) {
    const id = +(/\bnumFmtId="(\d+)"/.exec(m[0])?.[1] ?? 0)
    if (DATE_FORMATS.has(id) || custom.has(id)) out.add(i)
    i++
  }
  return out
}

/**
 * A lone `{{Date}}` cell whose own format shows a date becomes the day as a
 * number Excel reads as one, and keeps that format. A cell in any other
 * format is left for the text fill, which writes the day in words: a bare
 * number would say 46349.
 */
function fillDateCells(xml: string, loneShared: ReadonlySet<number>, serial: number, dated: ReadonlySet<number>): { xml: string; taken: number } {
  const edits: Edit[] = []
  let taken = 0
  for (const cell of cellsOf(xml)) {
    if (!dated.has(+(/\bs="(\d+)"/.exec(cell.attrs)?.[1] ?? 0))) continue
    const type = cellType(cell.attrs)
    const lone = type === 's' ? loneShared.has(+cellValue(cell.body)) : type === 'inlineStr' && isLoneDate(paragraphTexts(cell.body, ['is'], 't').join(''))
    if (!lone) continue
    if (type === 's') taken++
    edits.push({ start: cell.start, end: cell.end, text: `<c${cell.attrs.replace(/\s+t="[^"]*"/, '')}><v>${serial}</v></c>` })
  }
  return { xml: edits.length ? applyEdits(xml, edits) : xml, taken }
}

/** Excel reads `&` in a header as the start of a code: a value's own is doubled. */
const fillHeadFoot = (xml: string, values: ReadonlyMap<string, string>): string =>
  xml.replace(HEAD_FOOT, (whole, tag: string, text: string) => {
    const raw = unescapeXml(text)
    if (!raw.includes('{{')) return whole
    const safe = new Map([...values].map(([k, v]) => [k, v.replace(/&/g, '&&')]))
    const filled = fillText(raw, safe)
    return filled === raw ? whole : `<${tag}>${escapeXml(filled)}</${tag}>`
  })

export interface FillOptions {
  /** the caller's day, `YYYY-MM-DD`: a sheet's lone `{{Date}}` cell becomes that day as a true date */
  today?: string
}

/**
 * A Word or an Excel file with its fields filled. Only the parts that held
 * a field with a value are written again; `changed` names them.
 */
export function fillOffice(form: 'docx' | 'xlsx', bytes: Uint8Array, values: ReadonlyMap<string, string>, options: FillOptions = {}): { bytes: Uint8Array; changed: string[] } {
  const parts = readZip(bytes)
  const changed = new Map<string, Uint8Array>()
  const encoder = new TextEncoder()
  const put = (part: ZipEntry, before: string, after: string): void => {
    if (after !== before) changed.set(part.name, encoder.encode(after))
  }
  if (form === 'docx') {
    for (const part of parts.filter((p) => WORD_PARTS.test(p.name))) {
      const xml = partText(part)
      put(part, xml, fillPart(xml, ['w:p'], 'w:t', values))
    }
  } else {
    const strings = parts.find((p) => p.name === STRINGS_PART)
    const stringsXml = strings ? partText(strings) : ''
    const serial = options.today && values.has(DATE_KEY) ? excelSerial(options.today, /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(partTextOf(parts, 'xl/workbook.xml'))) : null
    const lone = new Set<number>()
    if (serial !== null) sharedStrings(stringsXml).forEach((text, i) => void (isLoneDate(text) && lone.add(i)))
    const dated = serial !== null ? dateStyles(partTextOf(parts, 'xl/styles.xml')) : new Set<number>()
    let taken = 0
    for (const part of numbered(parts, SHEET_PART)) {
      const xml = partText(part)
      let next = xml
      if (serial !== null && dated.size) {
        const cells = fillDateCells(next, lone, serial, dated)
        next = cells.xml
        taken += cells.taken
      }
      next = fillHeadFoot(fillPart(next, ['is'], 't', values), values)
      put(part, xml, next)
    }
    if (strings) {
      let next = fillPart(stringsXml, ['si'], 't', values)
      // The cells that became dates no longer point at a string: the table's count of uses says so.
      if (taken) next = next.replace(/(<sst\b[^>]*\bcount=")(\d+)(")/, (_w, a: string, n: string, b: string) => `${a}${Math.max(0, +n - taken)}${b}`)
      put(strings, stringsXml, next)
    }
  }
  return { bytes: changed.size ? writeZip(parts, changed) : bytes, changed: [...changed.keys()] }
}

const partTextOf = (parts: ZipEntry[], name: string): string => {
  const part = parts.find((p) => p.name === name)
  return part ? partText(part) : ''
}

/** The markdown preview a `.tcdoc` carries, or null for a file that holds none. */
export function tcdocPreview(bytes: Uint8Array): string | null {
  try {
    const part = readZip(bytes).find((p) => p.name === 'preview.md')
    return part ? partText(part) : null
  } catch {
    return null
  }
}
