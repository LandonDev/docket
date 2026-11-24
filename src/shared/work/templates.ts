import type { CanvasKind, CanvasSource } from './canvas'
import { extOf } from './files'

/**
 * Templates per job (docs/agents/work-templates.md): what a template is on
 * the wire, and the grammar of a field. Pure, no node import and no zod, so
 * the host's fill and the window's dialog read one rule.
 *
 * A template is an ordinary file. A field is `{{Client}}` typed in its
 * text: two braces, a name of 1 to 40 letters, digits and spaces, two
 * braces. Names match without case, and the spaces around one do not count.
 */

/** The forms a template's file may have: its extension. */
export const TEMPLATE_FORMS = ['docx', 'xlsx', 'pptx', 'tcdoc', 'tcsheet'] as const
export type TemplateForm = (typeof TEMPLATE_FORMS)[number]
export const isTemplateForm = (value: string): value is TemplateForm => (TEMPLATE_FORMS as readonly string[]).includes(value)

/** What a template makes, in the words Files' New uses. */
export const TEMPLATE_KINDS = ['document', 'sheet', 'deck'] as const
export type TemplateKind = (typeof TEMPLATE_KINDS)[number]

const KIND_OF_FORM: Record<TemplateForm, TemplateKind> = { docx: 'document', tcdoc: 'document', xlsx: 'sheet', tcsheet: 'sheet', pptx: 'deck' }
/** A file name's template form and kind; null for a file no template can be. */
export function templateFormOf(name: string): { form: TemplateForm; kind: TemplateKind } | null {
  const ext = extOf(name)
  return isTemplateForm(ext) ? { form: ext, kind: KIND_OF_FORM[ext] } : null
}
/** The canvas kind that opens what a template makes. */
export const canvasKindOf = (kind: TemplateKind): CanvasKind => (kind === 'deck' ? 'slides' : kind)

/** The group a template stands in: the job's own, the ones for all jobs, ours. */
export type TemplateWhere = 'job' | 'all' | 'starter'

export interface Template {
  /** `job:<file name>`, `all:<file name>` or `starter:<sector>/<slug>` */
  id: string
  /** the file's name without its extension */
  name: string
  kind: TemplateKind
  form: TemplateForm
  where: TemplateWhere
  /** the fields the dialog asks for, in the file's order, each once; never Date, Name or Job */
  fields: string[]
  source: CanvasSource
}

/** What a make answers: the file, what it is, its title, and the fields still in it as written. */
export interface TemplateMade {
  source: CanvasSource
  kind: TemplateKind
  title: string
  unfilled: string[]
}

// ── fields ────────────────────────────────────────────────────────────

export const FIELD_NAME_MAX = 40
/** One field anywhere in a text. The name's letters and digits are any script's. */
const FIELD = /\{\{([\p{L}\p{N} ]{1,40})\}\}/gu

/**
 * What a field with no value becomes. True: it stays in the file as
 * written, so what is missing is plain. False: it is taken out.
 */
export const LEAVE_UNFILLED = true

/** A field's name as it is matched: no case, no outer spaces, one space between words. */
export const fieldKey = (name: string): string => name.trim().replace(/ +/g, ' ').toLowerCase()

/** The fields filled without asking. */
export const FILLED_FIELDS = ['Date', 'Name', 'Job'] as const
const FILLED_KEYS = new Set(FILLED_FIELDS.map(fieldKey))
export const isFilledField = (name: string): boolean => FILLED_KEYS.has(fieldKey(name))

export interface FieldMatch {
  /** the name as written, trimmed */
  name: string
  key: string
  start: number
  end: number
}

/** Every field in a text, in order. A name of spaces alone is no field. */
export function fieldMatches(text: string): FieldMatch[] {
  const out: FieldMatch[] = []
  for (const m of text.matchAll(FIELD)) {
    const key = fieldKey(m[1]!)
    if (key) out.push({ name: m[1]!.trim().replace(/ +/g, ' '), key, start: m.index, end: m.index + m[0].length })
  }
  return out
}

/** A text's field names in its order, each once, as first written. */
export const fieldsOf = (text: string): string[] => uniqueFields(fieldMatches(text).map((m) => m.name))

/** Names in order, each once without case. */
export function uniqueFields(names: Iterable<string>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const name of names) {
    const key = fieldKey(name)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out
}

/** The fields a dialog asks for: every one but Date, Name and Job. */
export const askedFields = (fields: readonly string[]): string[] => fields.filter((f) => !isFilledField(f))

/** Values by key, from values by any spelling of the name. An empty value is no value. */
export function fieldValues(values: Readonly<Record<string, string | undefined>>): Map<string, string> {
  const out = new Map<string, string>()
  for (const [name, value] of Object.entries(values)) if (typeof value === 'string' && value.trim() !== '') out.set(fieldKey(name), value)
  return out
}

/** A text with each field that has a value replaced by it. A field with none stays as written (`LEAVE_UNFILLED`). */
export function fillText(text: string, values: ReadonlyMap<string, string>): string {
  let out = ''
  let at = 0
  for (const m of fieldMatches(text)) {
    const value = values.get(m.key)
    if (value === undefined && LEAVE_UNFILLED) continue
    out += text.slice(at, m.start) + (value ?? '')
    at = m.end
  }
  return out + text.slice(at)
}

// ── the three filled without asking ───────────────────────────────────

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/** Whether a string is a day as the window sends it: `YYYY-MM-DD`, and a real one. */
export function isDay(day: string): boolean {
  const m = DAY.exec(day)
  if (!m) return false
  const date = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!))
  return date.getUTCFullYear() === +m[1]! && date.getUTCMonth() === +m[2]! - 1 && date.getUTCDate() === +m[3]!
}

/** "November 23, 2026" for `2026-11-23`. */
export function longDate(day: string): string {
  const m = DAY.exec(day)
  if (!m || !isDay(day)) throw new Error(`${day} is not a day.`)
  return `${MONTHS[+m[2]! - 1]} ${+m[3]!}, ${m[1]}`
}

/** A day as Excel counts it: days since 1899-12-30 (1904 workbooks start 1,462 days later). */
export function excelSerial(day: string, date1904 = false): number {
  const m = DAY.exec(day)
  if (!m || !isDay(day)) throw new Error(`${day} is not a day.`)
  const days = Math.round((Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!) - Date.UTC(1899, 11, 30)) / 86_400_000)
  return date1904 ? days - 1462 : days
}

/** A clock's day where the caller stands, as `YYYY-MM-DD`. */
export function dayOf(now: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`
}

/** The values every make starts with: the day, his name, the workspace's name. One he has none of is left out. */
export function filledValues(o: { today: string; ownerName?: string | null; job?: string | null }): Map<string, string> {
  return fieldValues({ Date: longDate(o.today), Name: o.ownerName ?? undefined, Job: o.job ?? undefined })
}

// ── the new file's name ───────────────────────────────────────────────

export const MADE_NAME_MAX = 120

/**
 * A title as a file's stem: no character a disk or OneDrive refuses, no dots or spaces at its ends, cut to
 * `MADE_NAME_MAX`. Nor a start that names no file a person made, which the shelf and Files never show: a dot, or
 * `~$`, Office's lock file beside an open document.
 */
export function fileStem(title: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = title.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim()
  return clean.slice(0, MADE_NAME_MAX).replace(/[. ]+$/, '').replace(/^(?:[. ]|~\$)+/, '')
}

/**
 * What a file made from a template is called: the caller's title, else the
 * template's name, then " - " and the first asked field's value when it
 * has one ("Game report - Central at North").
 */
export function madeTitle(template: { name: string; fields: readonly string[] }, values: ReadonlyMap<string, string>, title?: string): string {
  const said = title ? fileStem(title) : ''
  if (said) return said
  const first = template.fields.map((f) => values.get(fieldKey(f))).find((v) => v !== undefined)
  const tail = first ? fileStem(first) : ''
  return fileStem(tail ? `${template.name} - ${tail}` : template.name) || 'Untitled'
}

// ── ids ───────────────────────────────────────────────────────────────

/** A template's id: its group and its file's name, or a starter's sector and slug. */
export const templateId = (where: TemplateWhere, key: string): string => `${where}:${key}`
export function parseTemplateId(id: string): { where: TemplateWhere; key: string } | null {
  const colon = id.indexOf(':')
  const where = id.slice(0, colon)
  const key = id.slice(colon + 1)
  return colon > 0 && key && (where === 'job' || where === 'all' || where === 'starter') ? { where, key } : null
}

/** Where the starters every job gets are kept, and the sector part of their ids. */
export const ANY_SECTOR = 'any'
/** The job's own templates folder, at the top of the workspace's folder. */
export const TEMPLATES_FOLDER = 'Templates'

/** "Client and Game", "Client, Game and Site": a list of field names in a sentence. */
export function fieldList(fields: readonly string[]): string {
  if (fields.length < 2) return fields[0] ?? ''
  return `${fields.slice(0, -1).join(', ')} and ${fields[fields.length - 1]}`
}

/** A starter's slug from its name: "Statement of work" is `statement-of-work`. Its file is `<sector>/<Name>.<ext>`, its key `<sector>/<slug>`. */
export const starterSlug = (name: string): string =>
  name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
/** A starter's key as a caller writes it: `unify/invoice`. */
export const STARTER_KEY = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/
