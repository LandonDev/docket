import { readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { strFromU8, unzipSync } from 'fflate'
import type { CanvasSource } from '@shared/work'
import { editableNotes, newestOf, notesCandidates } from './docWords'

/**
 * His notes document renamed or moved in Files (the files pillar's `registerFileMoved`, inside the move's own
 * savepoint): every page that keeps it as its notes names, from then on, the document he edits where it is now,
 * with a new revision, so the page's Notes row and the next Write in a document answer the file he sees. Beside the
 * plain case, two keep the page on his edits (`editableNotes`): a Word file moved away from the document the editor
 * made of it names that document, which stayed; and that document moved names it where it went, but only when it
 * was the one the page stood for before the move (the newest; an older import of the same file moved changes nothing). Only this one
 * field: a doc is rewritten through its JSON, as nothing else of the page changes. Answers the rows it changed, for
 * the pillar to say once the move has landed.
 */
export function notesDocMoved(from: CanvasSource, to: CanvasSource, at: { db: DatabaseSync; dataDir: string; host: string }): string[] {
  const changed: string[] = []
  if (from.at !== 'file' || to.at !== 'file') return changed
  // A document the editor made of a Word file names it in its sidecar: a page that keeps that Word file follows it too.
  const madeOf = /\.tcdoc$/i.test(to.path) ? sidecarName(to.path) : undefined
  const word = madeOf ? join(dirname(from.path), madeOf) : undefined
  const named = [from.path, ...(word && wasChosen(at, word, from.path, to.path) ? [word] : [])]
  const set = at.db.prepare('UPDATE work_prep_pages SET doc = ?, rev = rev + 1, updated_at = ? WHERE id = ?')
  for (const path of named) {
    // The path as the doc's JSON spells it, to find the few rows that may hold it without parsing every page.
    const rows = at.db.prepare('SELECT id, doc FROM work_prep_pages WHERE instr(doc, ?) > 0').all(JSON.stringify(path)) as { id: string; doc: string }[]
    for (const row of rows) {
      let doc: { notes?: { file?: CanvasSource } | null }
      try {
        doc = JSON.parse(row.doc) as typeof doc
      } catch {
        continue
      }
      const file = doc.notes?.file
      if (file?.at !== 'file' || file.host !== from.host || file.path !== path || changed.includes(row.id)) continue
      // The Word file itself moved: a document the editor made of it stayed where it was, and is what he edits.
      const stayed = path === from.path ? editableNotes(at, from) : undefined
      const next: CanvasSource = stayed?.at === 'file' && stayed.path !== from.path ? stayed : { at: 'file', host: to.host, path: to.path }
      set.run(JSON.stringify({ ...doc, notes: { ...doc.notes, file: next } }), Date.now(), row.id)
      changed.push(row.id)
    }
  }
  return changed
}

/**
 * Whether the moved document was the one the page stood for before the move: the documents made of the Word file as
 * they were (the moved one at its old path, with its save time, which a move keeps), and the newest of them by the
 * same choice `editableNotes` makes.
 */
function wasChosen(at: { host: string; dataDir: string }, word: string, from: string, to: string): boolean {
  let moved: number
  try {
    moved = statSync(to).mtimeMs
  } catch {
    return false
  }
  const before = notesCandidates(at, word).filter((c) => c.path !== to)
  return newestOf([...before, { path: from, at: moved }]) === from
}

/** The Word file a document was made of, by its name, from the document's sidecar. */
function sidecarName(path: string): string | undefined {
  try {
    const got = unzipSync(new Uint8Array(readFileSync(path)), { filter: (f) => f.name === 'sidecar.json' })['sidecar.json']
    const name = got ? (JSON.parse(strFromU8(got)) as { source?: { name?: string } }).source?.name : undefined
    return name && name === basename(name) ? name : undefined
  } catch {
    return undefined
  }
}
