import { realpathSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import type { MsFormWorkbook } from '@shared/contract-work-msforms'
import { registerReadOnlyFile } from '../files/hooks'
import { librariesHere, vmLibrariesHere } from '../files/places/libraries'
import type { WorkCtx } from '../modules'
import { siteOf } from './place'

/**
 * A Microsoft form's answers workbook (docs/agents/work-msforms.md "Open the workbook"): Forms writes a row to it for
 * every answer, so nothing of ours writes it. Opened Edit here it is read only with these words, the copy Files makes
 * of it sends nothing back, and the sheet tools refuse to change it: a copy saved back could write over rows Forms
 * added meanwhile. Live in Excel is his way to change it.
 */

export const FORMS_WORKBOOK_READ_ONLY = 'Microsoft Forms writes this workbook. Open it Live in Excel to change it.'
export const FORMS_WORKBOOK_REFUSED = 'refused: Microsoft Forms writes this workbook; no agent changes it. Nothing was written.'

/**
 * A file as Files, the sheets and the office tools name it: in a library by its id and its `/`-joined path there, or
 * by its host and path (a guest path in the VM), or by its web address (`path` an https URL, as Excel names a
 * workbook it opened from SharePoint).
 */
export type WorkbookRef = { libraryId: string; path: string } | { host: string; path: string }

/** Only the rows that have a workbook: the check reads this index and no other row. */
export function ensureWorkbookIndex(db: DatabaseSync): void {
  db.exec('CREATE INDEX IF NOT EXISTS work_msforms_by_workbook ON work_msforms (workspace_id) WHERE workbook IS NOT NULL')
}

const parts = (path: string): string[] => path.split(/[\\/]+/).filter((p) => p && p !== '.')
/** A path inside a library as compared: `/`-joined, and in one case (OneDrive and SharePoint ignore it). */
const inside = (path: string): string => parts(path).join('/').toLowerCase()

/** The workbooks of this host's forms, by their library. */
interface Book {
  libraryId: string
  path: string
  uniqueId: string
}
function workbooks(db: DatabaseSync): Book[] {
  let rows: { workbook: string }[]
  try {
    rows = db.prepare('SELECT workbook FROM work_msforms WHERE workbook IS NOT NULL').all() as { workbook: string }[]
  } catch {
    // (no forms table on this database yet, or no index: no form has a workbook here)
    return []
  }
  const out: Book[] = []
  for (const r of rows) {
    try {
      const w = JSON.parse(r.workbook) as Partial<MsFormWorkbook>
      if (typeof w.libraryId === 'string' && typeof w.path === 'string' && w.path) out.push({ libraryId: w.libraryId, path: inside(w.path), uniqueId: (w.uniqueId ?? '').replace(/[{}]/g, '').toLowerCase() })
    } catch {
      // a row that does not parse names no workbook
    }
  }
  return out
}

/** `path`'s place inside `root`, `/`-joined and lower-cased, or null when it is not inside it. */
function within(root: string, path: string): string | null {
  const r = parts(root).map((p) => p.toLowerCase())
  const p = parts(path)
  if (p.length <= r.length || r.some((seg, i) => seg !== p[i].toLowerCase())) return null
  return p.slice(r.length).join('/').toLowerCase()
}

const real = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** A workbook by its web address: its document id (`sourcedoc={…}`), or its library's site and path there. */
function byAddress(ctx: Pick<WorkCtx, 'db' | 'host'>, books: Book[], address: string): boolean {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  const doc = (url.searchParams.get('sourcedoc') ?? '').replace(/[{}]/g, '').toLowerCase()
  if (doc && books.some((b) => b.uniqueId === doc)) return true
  let named: string
  try {
    named = `${url.origin}${decodeURIComponent(url.pathname)}`.toLowerCase()
  } catch {
    return false
  }
  const libraries = [...librariesHere(ctx), ...vmLibrariesHere(ctx)]
  return books.some((b) => {
    const site = siteOf(libraries.find((l) => l.id === b.libraryId)?.web)
    return !!site && `${new URL(site.siteUrl).origin}${site.libraryPath}/${b.path}`.toLowerCase() === named
  })
}

/**
 * Whether a file is the answers workbook of a Microsoft form of this host (`work_msforms.workbook`). A library file by
 * its library id and path; or a file by where it lies: a path in one of this host's libraries on its disk, or a guest
 * path in a library of its Windows VM; or by its web address, from any host. A path on another computer is not in
 * one of this host's libraries, and is not.
 * One query of the rows that have a workbook, and only when one does a look at the libraries (kept a moment).
 */
export function isFormsWorkbook(ctx: Pick<WorkCtx, 'db' | 'host'>, ref: WorkbookRef): boolean {
  const books = workbooks(ctx.db)
  if (!books.length) return false
  if ('libraryId' in ref) {
    const path = inside(ref.path)
    return books.some((b) => b.libraryId === ref.libraryId && b.path === path)
  }
  if (/^https:\/\//i.test(ref.path)) return byAddress(ctx, books, ref.path)
  if (ref.host !== ctx.host) return false
  const ids = new Set(books.map((b) => b.libraryId))
  const libraries = [...librariesHere(ctx), ...vmLibrariesHere(ctx)].filter((l) => ids.has(l.id))
  for (const library of libraries) {
    const at = within(library.path, ref.path) ?? (library.vm ? null : within(real(library.path), real(ref.path)))
    if (at !== null && books.some((b) => b.libraryId === library.id && b.path === at)) return true
  }
  return false
}

// Files and the sheets ask through Files' hook (files/hooks.ts): neither imports this pillar.
registerReadOnlyFile((ctx, file) => (isFormsWorkbook(ctx, file) ? { reason: FORMS_WORKBOOK_READ_ONLY, refused: FORMS_WORKBOOK_REFUSED } : null))
