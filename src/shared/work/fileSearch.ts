import type { FileSearchFilter, SavedFileSearch } from '../contract-work-files'
import { DEFAULT_SPEC, queryTerms, type FindBy, type FindKind, type FindSpec, type FindWhere, type SavedFindView } from './docFind'
import type { EntryKind } from './files'

/**
 * Go to and search in the Files place (docs/agents/work-files.md "Search and Go to"): the rules both sides and
 * other builds share. Pure and zod-free. The host matches names with these; the window reads Go to's words
 * with `parseGoTo`; the one-search build asks Files for file hits and ranks them the same way.
 */

/** The most rows Go to lists, and the most a page of search results holds. */
export const NAMES_MOST = 20
export const SEARCH_PAGE = 100

/** A query's words, lower case, with quotes and stops at a word's ends dropped (the Docs finder's own rule). */
export const nameWords = (text: string): string[] => queryTerms(text)

/** Whether a name holds every word, case-blind. No words: every name. */
export function matchesName(name: string, words: readonly string[]): boolean {
  const n = name.toLowerCase()
  return words.every((w) => n.includes(w))
}

/**
 * How well a name fits the words: 0 when it does not hold them all; else higher is better. A word that starts
 * the name counts most, then one that starts a word in it, then one inside a word.
 */
export function rankName(name: string, words: readonly string[]): number {
  if (!matchesName(name, words)) return 0
  const n = name.toLowerCase()
  let rank = 1
  for (const w of words) {
    if (n.startsWith(w)) rank += 4
    else if (new RegExp(`[^\\p{L}\\p{N}]${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u').test(n)) rank += 2
  }
  return rank
}

export type GoToWhat = 'document' | 'sheet' | 'deck' | 'text' | 'folder'
export type GoTo = { kind: 'new'; what: GoToWhat; name: string } | { kind: 'find'; text: string }

const NEW_WORDS: [RegExp, GoToWhat][] = [
  [/^text\s+file\b/, 'text'],
  [/^(document|doc)\b/, 'document'],
  [/^(spreadsheet|sheet)\b/, 'sheet'],
  [/^(deck|slides|presentation)\b/, 'deck'],
  [/^(note|text)\b/, 'text'],
  [/^folder\b/, 'folder']
]

/**
 * What Go to's words ask for: a new thing ("new sheet called travel", "new doc named Plan", "new folder
 * Receipts", "new note", "new text file …"; the words case-blind, "called" and "named" optional, the name as
 * typed and '' when none is given), else names to find.
 */
export function parseGoTo(text: string): GoTo {
  const m = /^\s*new\s+(.*)$/is.exec(text)
  if (m) {
    const rest = m[1]!
    for (const [word, what] of NEW_WORDS) {
      const hit = word.exec(rest.toLowerCase())
      if (!hit) continue
      const name = rest
        .slice(hit[0].length)
        .replace(/^\s*(called|named)\b/i, '')
        .trim()
      return { kind: 'new', what, name }
    }
  }
  return { kind: 'find', text: text.trim() }
}

// ── saved searches are the Docs view's saved views ────────────────────

/**
 * The parts of a filter Docs cannot say exactly, kept beside its spec in the same row (`files` in the spec's
 * JSON). Docs' own wire drops the key when Docs saves the view again, so it is never left stale.
 */
export interface FilesPart {
  kinds?: EntryKind[]
  places?: string[]
  who?: string
}
type Spec = FindSpec & { files?: FilesPart }

const KIND_OF_FIND: Record<FindKind, EntryKind[]> = { document: ['document'], sheet: ['sheet'], pdf: ['pdf'], slides: ['deck'], media: ['picture', 'video'], meeting: ['audio'], form: [], dashboard: [] }
const FIND_OF_KIND: Partial<Record<EntryKind, FindKind>> = { document: 'document', sheet: 'sheet', pdf: 'pdf', deck: 'slides', picture: 'media', video: 'media', audio: 'meeting' }
/** A Docs place that is a Files place has the same id; the rest (Google, Microsoft items, a thread's) are no place of Files. */
const PLACE_OF_WHERE: Partial<Record<FindWhere, string>> = { lifeos: 'lifeos', folder: 'folder' }
const WHO_OF_BY: Partial<Record<FindBy, string>> = { owner: 'me', agent: 'agent' }

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)]
const some = <T>(xs: T[] | undefined): T[] | undefined => (xs && xs.length ? xs : undefined)
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * Each part of a search's filter as read from a view's spec, and written into one. Field by field:
 *  - `kinds`: Docs' kinds are canvas kinds: a deck is `slides`, a picture or video `media`, sound `meeting`;
 *    a form and a dashboard are no file kind, and a folder, text, an archive and other files are no Docs kind.
 *  - `places`: Docs' `where` of `lifeos` and `folder` are the places of those ids; any other place (a library)
 *    is Docs' `microsoft`. Google, a thread's own and Microsoft's are no Files place.
 *  - `project`: Docs keeps a list; one project is said both ways, more is Docs' alone.
 *  - `who`: Docs' `by` of `owner` is `me`, of `agent` is `agent`; a name is Files' alone.
 *  - `within`, `after`, `before`, `shared`, `review`: the same words. Docs reads `shared: false` as no filter.
 *  - Docs' `held`, `group`, `sort` and `layout` are Docs' alone: kept in `docs`, never lost, and read by no search
 *    (docs/agents/work-files.md "Search and Go to" says why each was left).
 */
const PARTS: { [K in keyof FileSearchFilter]-?: { from: (s: Spec) => FileSearchFilter[K]; into: (s: Spec, v: FileSearchFilter[K]) => void } } = {
  kinds: {
    from: (s) => s.files?.kinds ?? some(uniq((s.filter.kinds ?? []).flatMap((k) => KIND_OF_FIND[k]))),
    into: (s, v) => {
      s.filter.kinds = some(uniq((v ?? []).flatMap((k) => FIND_OF_KIND[k] ?? [])))
      s.files = { ...s.files, kinds: v }
    }
  },
  places: {
    from: (s) => s.files?.places ?? some(uniq((s.filter.where ?? []).flatMap((w) => PLACE_OF_WHERE[w] ?? []))),
    into: (s, v) => {
      s.filter.where = some(uniq((v ?? []).map((p): FindWhere => (p === 'lifeos' || p === 'folder' ? p : 'microsoft'))))
      s.files = { ...s.files, places: v }
    }
  },
  project: {
    from: (s) => (s.filter.projects?.length === 1 && s.filter.projects[0] ? s.filter.projects[0] : undefined),
    into: (s, v) => void (s.filter.projects = v ? [v] : undefined)
  },
  who: {
    from: (s) => s.files?.who ?? (s.filter.by?.length === 1 ? WHO_OF_BY[s.filter.by[0]!] : undefined),
    into: (s, v) => {
      s.filter.by = v === 'me' ? ['owner'] : v === 'agent' ? ['agent'] : undefined
      s.files = { ...s.files, who: v }
    }
  },
  within: { from: (s) => s.filter.within, into: (s, v) => void (s.filter.within = v) },
  after: { from: (s) => s.filter.after, into: (s, v) => void (s.filter.after = v) },
  before: { from: (s) => s.filter.before, into: (s, v) => void (s.filter.before = v) },
  shared: { from: (s) => s.filter.shared, into: (s, v) => void (s.filter.shared = v) },
  review: { from: (s) => s.filter.review, into: (s, v) => void (s.filter.review = v) }
}
const KEYS = Object.keys(PARTS) as (keyof FileSearchFilter)[]

/** Drops the keys a spec or filter holds as `undefined`, so what is stored and compared says only what is set. */
function bare<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T
}

/** A Docs view as a saved search. The view's whole spec rides along in `docs`, so saving it back keeps every setting Docs has. */
export function searchOfView(view: SavedFindView): SavedFileSearch {
  const spec = view.spec as Spec
  const filter = bare(Object.fromEntries(KEYS.map((k) => [k, PARTS[k].from(spec)])) as FileSearchFilter)
  return { id: view.id, name: view.name, query: spec.query, ...(Object.keys(filter).length ? { filter } : {}), docs: view.spec }
}

/**
 * A saved search as a Docs view. Built over the view it was (`search.docs`), and changing only the parts the
 * search changed, so a view saved from Files keeps Docs' grouping, order, layout and the filters only Docs says.
 */
export function viewOfSearch(search: Pick<SavedFileSearch, 'name' | 'query' | 'filter' | 'docs'> & { id?: string }): { id?: string; name: string; spec: FindSpec } {
  const was = (search.docs ?? DEFAULT_SPEC) as Spec
  const spec: Spec = { ...was, filter: { ...was.filter }, ...(was.files ? { files: { ...was.files } } : {}), query: search.query }
  const filter = search.filter ?? {}
  for (const k of KEYS) {
    if (!same(PARTS[k].from(was), filter[k])) (PARTS[k].into as (s: Spec, v: unknown) => void)(spec, filter[k])
  }
  spec.filter = bare(spec.filter)
  if (spec.files) {
    const files = bare(spec.files)
    if (Object.keys(files).length) spec.files = files
    else delete spec.files
  }
  return { ...(search.id ? { id: search.id } : {}), name: search.name, spec }
}
