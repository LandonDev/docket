import { createHash } from 'node:crypto'
import { join } from 'node:path'

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
