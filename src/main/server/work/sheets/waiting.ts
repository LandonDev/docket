import { extname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { CanvasSource } from '@shared/work'
import type { FileWaiting } from '../files/hooks'
import { PACKAGE_EXT } from './held'
import { SuggestionStore } from './suggestions'

/**
 * What the sheets pillar tells Files about waiting suggestions (docs/agents/work-files.md "Home"): an opened
 * .xlsx or .xlsm keeps an agent's suggestions here by its path (`file:<path>`, held.ts `storeKey`), so a count is
 * one indexed query and no byte of the file is read. A `.tcsheet`'s are kept by the Work service in its own
 * folder and a LifeOS sheet's in LifeOS: neither is counted here.
 */
const PREFIX = 'file:'
const storeOf = (s: CanvasSource): string | null => (s.at === 'file' && PACKAGE_EXT.has(extname(s.path).toLowerCase()) ? `${PREFIX}${s.path}` : null)

export const sheetWaiting: FileWaiting = {
  count(sources, db: DatabaseSync) {
    const stores = sources.map(storeOf)
    const counts = new SuggestionStore(db).openCounts([...new Set(stores.filter((s): s is string => s !== null))])
    return stores.map((s) => (s === null ? 0 : (counts.get(s) ?? 0)))
  },
  files(db, host, most) {
    return new SuggestionStore(db).storesOpen(PREFIX, most).map((r) => ({ source: { at: 'file', host, path: r.store.slice(PREFIX.length) }, count: r.count }))
  }
}
