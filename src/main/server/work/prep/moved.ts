import type { DatabaseSync } from 'node:sqlite'
import type { CanvasSource } from '@shared/work'

/**
 * His notes document renamed or moved in Files (the files pillar's `registerFileMoved`, inside the move's own
 * savepoint): every page that keeps it as its notes names it where it is now, with a new revision, so the page's
 * Notes row and the next Write in a document answer the file he sees. Only this one field: a doc is rewritten
 * through its JSON, as nothing else of the page changes.
 */
export function notesDocMoved(from: CanvasSource, to: CanvasSource, at: { db: DatabaseSync }): void {
  if (from.at !== 'file' || to.at !== 'file') return
  // The path as the doc's JSON spells it, to find the few rows that may hold it without parsing every page.
  const rows = at.db.prepare('SELECT id, doc FROM work_prep_pages WHERE instr(doc, ?) > 0').all(JSON.stringify(from.path)) as { id: string; doc: string }[]
  const set = at.db.prepare('UPDATE work_prep_pages SET doc = ?, rev = rev + 1, updated_at = ? WHERE id = ?')
  for (const row of rows) {
    let doc: { notes?: { file?: CanvasSource } | null }
    try {
      doc = JSON.parse(row.doc) as typeof doc
    } catch {
      continue
    }
    const file = doc.notes?.file
    if (file?.at !== 'file' || file.host !== from.host || file.path !== from.path) continue
    set.run(JSON.stringify({ ...doc, notes: { ...doc.notes, file: { ...file, host: to.host, path: to.path } } }), Date.now(), row.id)
  }
}
