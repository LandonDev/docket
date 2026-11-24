import type { WorkCtx } from '../modules'
import { readOnlyHooks, type ReadOnlyFile } from './hooks'

/**
 * Whether a file opens only to read, by a pillar's word (hooks.ts `registerReadOnlyFile`), for the file where it lies
 * or for a Files tab's copy of one: a copy is judged by the file it is a copy of (the tab's `copyOf`), so the editor
 * holding the copy says so too. Files asks before it makes a copy, which then does not save back
 * (handle.ts `copySeat`); the sheet editor asks for every workbook it opens and every change it writes.
 */
export function readOnlyOf(ctx: Pick<WorkCtx, 'db' | 'host'>, file: { host: string; path: string }): ReadOnlyFile | null {
  const hooks = readOnlyHooks()
  if (!hooks.length) return null
  const judge = (f: { host: string; path: string }): ReadOnlyFile | null => {
    for (const fn of hooks) {
      const word = fn(ctx, f)
      if (word) return word
    }
    return null
  }
  return judge(file) ?? (file.host === ctx.host ? judgeCopy(ctx, file.path, judge) : null)
}

/** A copy of this host is judged by the file a Files tab says it is a copy of. */
function judgeCopy(ctx: Pick<WorkCtx, 'db'>, path: string, judge: (f: { host: string; path: string }) => ReadOnlyFile | null): ReadOnlyFile | null {
  let rows: { host: unknown; path: unknown }[]
  try {
    rows = ctx.db
      .prepare(
      `SELECT json_extract(t.page, '$.copyOf.host') AS host, json_extract(t.page, '$.copyOf.path') AS path FROM work_files_tabs t JOIN work_canvas_items i ON i.id = t.item_id
       WHERE json_extract(t.page, '$.copyOf') IS NOT NULL AND json_extract(i.source, '$.path') = ?`
      )
      .all(path) as { host: unknown; path: unknown }[]
  } catch {
    // (a database with no Files tabs yet: nothing is a copy)
    return null
  }
  for (const r of rows) {
    if (typeof r.host !== 'string' || typeof r.path !== 'string') continue
    const word = judge({ host: r.host, path: r.path })
    if (word) return word
  }
  return null
}
