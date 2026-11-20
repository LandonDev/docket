import type { CanvasSource } from './canvas'

/**
 * Finding documents in a Work workspace (docs/agents/work-docs.md "Finding
 * documents"): what one entry of the Docs view's list is, and the filters,
 * sorts and groups over it. Pure and zod-free, so the view, the host's
 * `work.docs.find` and the agent's `doc_find` read the same rules, and a
 * first-paint file may import it. The host builds the entries; this file
 * only judges them.
 */

/** The kinds the view lists, in its order: a canvas kind each. */
export const FIND_KINDS = ['document', 'sheet', 'pdf', 'slides', 'media', 'meeting', 'form', 'dashboard'] as const
export type FindKind = (typeof FIND_KINDS)[number]
export const FIND_KIND_WORDS: Record<FindKind, string> = {
  document: 'Document',
  sheet: 'Sheet',
  pdf: 'PDF',
  slides: 'Deck',
  media: 'Media',
  meeting: 'Recording',
  form: 'Form',
  dashboard: 'Dashboard'
}

/** Where an entry's truth lives: LifeOS, the workspace's folder, Google, Microsoft, or a thread that made it. */
export const FIND_WHERE = ['lifeos', 'folder', 'google', 'microsoft', 'thread'] as const
export type FindWhere = (typeof FIND_WHERE)[number]
export const FIND_WHERE_WORDS: Record<FindWhere, string> = { lifeos: 'LifeOS', folder: 'Folder', google: 'Google', microsoft: 'Microsoft', thread: 'Thread' }

/** Who last changed it, as far as its store says. */
export const FIND_BY = ['owner', 'agent', 'guest'] as const
export type FindBy = (typeof FIND_BY)[number]
export const FIND_BY_WORDS: Record<FindBy, string> = { owner: 'You', agent: 'An agent', guest: 'A guest' }

/** A file's extension to the kind that opens it, as the canvas kinds claim them (work/<pillar>/canvas.ts). */
const EXT_KIND: Record<string, FindKind> = {}
const claim = (kind: FindKind, exts: string) => exts.split(' ').forEach((e) => (EXT_KIND[e] = kind))
claim('document', 'tcdoc docx doc odt rtf md markdown txt')
claim('sheet', 'tcsheet xlsx xlsm csv')
claim('pdf', 'pdf')
claim('slides', 'pptx')
claim('media', 'png jpg jpeg gif webp avif heic heif tif tiff bmp psd mp4 m4v mov webm mkv mxf avi mts m2ts ogv')
claim('meeting', 'wav mp3 m4a aac flac ogg opus wma aiff amr')
export const kindOfFile = (name: string): FindKind | null => EXT_KIND[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] ?? null

/** A Google file's kind by its MIME type. */
export function kindOfMime(mime: string): FindKind | null {
  if (mime.endsWith('.document')) return 'document'
  if (mime.endsWith('.spreadsheet')) return 'sheet'
  if (mime.endsWith('.presentation')) return 'slides'
  if (mime.endsWith('.form')) return 'form'
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('image/') || mime.startsWith('video/')) return 'media'
  if (mime.startsWith('audio/')) return 'meeting'
  return null
}

/** One thing the Docs view lists. */
export interface FindEntry {
  /** stable across reads: `lifeos:docs:<id>`, `file:<path>`, `google:<fileId>`, `microsoft:<name>`, `item:<itemId>` */
  key: string
  title: string
  kind: FindKind
  where: FindWhere
  /** what to open it by */
  source: CanvasSource
  /** the thread whose canvas holds it, for an item only a thread has */
  sessionId?: string
  /** its LifeOS project, for a LifeOS row */
  projectId?: string
  editedAt: number
  createdAt: number
  /** others can see or edit it: LifeOS's shared flag, a live guest link, or a Google or Microsoft file */
  shared: boolean
  /** a live guest link names it */
  guest: boolean
  lastBy?: FindBy
  /** open comment threads */
  comments: number
  /** suggestions waiting for him */
  waiting: number
  /** held acts that name it */
  held: number
  /** the words around a match inside it, when a search found it there */
  snippet?: string
}

export const EDITED_WITHIN = ['day', 'week', 'month', 'quarter', 'year'] as const
export type EditedWithin = (typeof EDITED_WITHIN)[number]
export const EDITED_WITHIN_WORDS: Record<EditedWithin, string> = { day: 'Past day', week: 'Past week', month: 'Past month', quarter: 'Past 3 months', year: 'Past year' }
const DAY = 86_400_000
const WITHIN_MS: Record<EditedWithin, number> = { day: DAY, week: 7 * DAY, month: 30 * DAY, quarter: 90 * DAY, year: 365 * DAY }

/** Every part is optional and they all hold at once; a list part holds when the entry is any one of it. */
export interface FindFilter {
  /** LifeOS project ids; `''` is "no project" */
  projects?: string[]
  kinds?: FindKind[]
  where?: FindWhere[]
  /** shared, or guest-linked */
  shared?: boolean
  by?: FindBy[]
  /** edited within a span before now (a saved view keeps the span, so it stays current) */
  within?: EditedWithin
  /** edited at or after / before, ms since the epoch (the agent's dates) */
  after?: number
  before?: number
  /** has open comments or suggestions waiting */
  review?: boolean
  /** has a held act */
  held?: boolean
}

export const FIND_GROUPS = ['project', 'kind', 'edited', 'where', 'none'] as const
export type FindGroup = (typeof FIND_GROUPS)[number]
export const FIND_SORTS = ['edited', 'created', 'name'] as const
export type FindSort = (typeof FIND_SORTS)[number]

/** What a saved view keeps: the search, the filters, the grouping, the order and the layout. */
export interface FindSpec {
  query: string
  filter: FindFilter
  group: FindGroup
  sort: FindSort
  layout: 'list' | 'table'
}
export const DEFAULT_SPEC: FindSpec = { query: '', filter: {}, group: 'project', sort: 'edited', layout: 'list' }

export interface SavedFindView {
  id: string
  name: string
  spec: FindSpec
}

/** How many filters are set: the Filter control's count. */
export function filterCount(f: FindFilter): number {
  let n = 0
  for (const v of Object.values(f)) if (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== false) n++
  return n
}

const has = <T>(list: T[] | undefined, v: T) => !list?.length || list.includes(v)

export function passes(e: FindEntry, f: FindFilter, now = Date.now()): boolean {
  if (!has(f.projects, e.projectId ?? '')) return false
  if (!has(f.kinds, e.kind)) return false
  if (!has(f.where, e.where)) return false
  if (f.by?.length && (!e.lastBy || !f.by.includes(e.lastBy))) return false
  if (f.shared && !e.shared && !e.guest) return false
  if (f.within && e.editedAt < now - WITHIN_MS[f.within]) return false
  if (f.after !== undefined && e.editedAt < f.after) return false
  if (f.before !== undefined && e.editedAt >= f.before) return false
  if (f.review && e.comments + e.waiting === 0) return false
  if (f.held && e.held === 0) return false
  return true
}

/** A query's words, lowercased; quotes and punctuation at a word's ends dropped. */
export const queryTerms = (q: string): string[] =>
  q
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean)

/** Every word of the query stands in the title (as a word's start or anywhere in it). */
export function titleMatches(title: string, terms: string[]): boolean {
  const t = title.toLowerCase()
  return terms.every((term) => t.includes(term))
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

export function compareBy(sort: FindSort): (a: FindEntry, b: FindEntry) => number {
  if (sort === 'name') return (a, b) => collator.compare(a.title, b.title) || b.editedAt - a.editedAt
  if (sort === 'created') return (a, b) => b.createdAt - a.createdAt
  return (a, b) => b.editedAt - a.editedAt
}

/**
 * The entries a spec shows, in order: filtered, then, with a query, those whose title
 * matches or whose text the host found (`hits`, key to snippet), title matches first.
 */
export function findIn(entries: FindEntry[], spec: Pick<FindSpec, 'query' | 'filter' | 'sort'>, hits: ReadonlyMap<string, string> = new Map(), now = Date.now()): FindEntry[] {
  const terms = queryTerms(spec.query)
  const order = compareBy(spec.sort)
  const out: { e: FindEntry; title: boolean }[] = []
  for (const e of entries) {
    if (!passes(e, spec.filter, now)) continue
    if (!terms.length) {
      out.push({ e, title: true })
      continue
    }
    const title = titleMatches(e.title, terms)
    const snippet = hits.get(e.key)
    if (title || snippet !== undefined) out.push({ e: snippet ? { ...e, snippet } : e, title })
  }
  return out.sort((a, b) => Number(b.title) - Number(a.title) || order(a.e, b.e)).map((x) => x.e)
}

export interface FindGroupRows {
  key: string
  label: string
  rows: FindEntry[]
}

const startOfDay = (t: number) => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** The span an edit falls in, by the calendar: Today, Yesterday, then by the past week, month and year. */
export function editedBucket(t: number, now = Date.now()): { key: string; label: string } {
  const today = startOfDay(now)
  if (t >= today) return { key: '0', label: 'Today' }
  if (t >= today - DAY) return { key: '1', label: 'Yesterday' }
  if (t >= today - 7 * DAY) return { key: '2', label: 'Past week' }
  if (t >= today - 30 * DAY) return { key: '3', label: 'Past month' }
  if (t >= today - 365 * DAY) return { key: '4', label: 'Past year' }
  return { key: '5', label: 'Older' }
}

/**
 * Rows in groups, each group keeping the rows' order. Projects go by name with loose rows
 * last; kinds and places in their lists' order; edits newest span first. `none` is one group
 * with no label.
 */
export function groupRows(rows: FindEntry[], group: FindGroup, projectNames: ReadonlyMap<string, string>, now = Date.now()): FindGroupRows[] {
  if (group === 'none') return rows.length ? [{ key: '', label: '', rows }] : []
  const groups = new Map<string, FindGroupRows>()
  for (const e of rows) {
    let key: string
    let label: string
    if (group === 'project') {
      const name = e.projectId ? projectNames.get(e.projectId) : undefined
      key = name ? `p:${e.projectId}` : '~'
      label = name ?? 'No project'
    } else if (group === 'kind') {
      key = String(FIND_KINDS.indexOf(e.kind)).padStart(2, '0')
      label = FIND_KIND_WORDS[e.kind]
    } else if (group === 'where') {
      key = String(FIND_WHERE.indexOf(e.where))
      label = FIND_WHERE_WORDS[e.where]
    } else ({ key, label } = editedBucket(e.editedAt, now))
    let g = groups.get(key)
    if (!g) groups.set(key, (g = { key, label, rows: [] }))
    g.rows.push(e)
  }
  const list = [...groups.values()]
  if (group === 'project') return list.sort((a, b) => (a.key === '~' ? 1 : b.key === '~' ? -1 : collator.compare(a.label, b.label)))
  return list.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/** The words around the first place any term stands in `text`, cut at word ends and marked where cut; '' when none does. */
export function snippetOf(text: string, terms: string[], around = 60): string {
  const lower = text.toLowerCase()
  let at = -1
  let len = 0
  for (const term of terms) {
    const i = lower.indexOf(term.toLowerCase())
    if (i >= 0 && (at < 0 || i < at)) {
      at = i
      len = term.length
    }
  }
  if (at < 0) return ''
  let from = Math.max(0, at - around)
  let to = Math.min(text.length, at + len + around)
  if (from > 0) from = text.indexOf(' ', from) + 1 || from
  if (to < text.length) {
    const end = text.lastIndexOf(' ', to)
    if (end > at + len) to = end
  }
  const words = text.slice(from, to).replace(/\s+/g, ' ').trim()
  return `${from > 0 ? '…' : ''}${words}${to < text.length ? '…' : ''}`
}
