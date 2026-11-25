import { createHash } from 'node:crypto'
import { isAbsolute, join, relative } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

/**
 * Where a document made of a shared file is kept. A `.tcdoc` is written beside the file it was made of only in
 * his own places: beside a file others can open (a Teams library, a cloud folder) it would sync to everyone, so
 * it goes under this host's data instead, one folder per source file. The office pillar reads the same rule to
 * find the thread that holds such a document, so this file imports nothing but node's own.
 */
export const importsRoot = (dataDir: string): string => join(dataDir, 'work-files', 'imports')

/** The one folder for the documents made of a source file, stable for its host and path. */
export const importFolderOf = (dataDir: string, source: { host: string; path: string }): string =>
  join(importsRoot(dataDir), createHash('sha1').update(`${source.host}\0${source.path}`).digest('hex').slice(0, 16))

/**
 * The hidden Word store (wordStore.ts): a Word file of another computer's kept document and its "before" copy, one
 * folder per workspace under this host's data. Here so the hold's rule (docs/target.ts) reads it with node's own alone.
 */
export const wordStoreRoot = (dataDir: string): string => join(dataDir, 'work-files', 'word')

/**
 * The kept documents in the store (records' `doc`), for the listener's path fence (server/index.ts `managedRoots`):
 * a remote key reaches each one as it reached it in the workspace's folder, file by file, and nothing else there.
 */
export function wordStoreDocs(db: DatabaseSync, dataDir: string): string[] {
  if (!(db.prepare(`SELECT count(*) AS n FROM pragma_table_info('work_files_word')`).get() as { n: number }).n) return []
  const root = wordStoreRoot(dataDir)
  return (db.prepare(`SELECT DISTINCT doc FROM work_files_word WHERE doc IS NOT NULL`).all() as { doc: string }[]).map((r) => r.doc).filter((doc) => {
    const r = relative(root, doc)
    return r !== '' && !r.startsWith('..') && !isAbsolute(r)
  })
}

