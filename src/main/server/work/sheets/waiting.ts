import { extname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { CanvasSource } from '@shared/work'
import type { FileWaiting } from '../files/hooks'
import { ChangeStore, ensureChangeTables } from './changes'
import { PACKAGE_EXT } from './held'
import { SuggestionStore } from './suggestions'

/**
 * What the sheets pillar tells Files about waiting suggestions (docs/agents/work-files.md "Home"): an opened
 * .xlsx or .xlsm keeps an agent's suggestions here by its path (`file:<path>`, held.ts `storeKey`), so a count is
 * one indexed query and no byte of the file is read; a format or a rule an agent proposed there counts with them. A `.tcsheet`'s are kept by the Work service in its own
 * folder and a LifeOS sheet's in LifeOS: neither is counted here.
 */
const PREFIX = 'file:'
const storeOf = (s: CanvasSource): string | null => (s.at === 'file' && PACKAGE_EXT.has(extname(s.path).toLowerCase()) ? `${PREFIX}${s.path}` : null)

/** The changes' table is there before it is counted: Files may ask before the sheets module has made its tables in this database. */
const ready = new WeakSet<DatabaseSync>()
function changesOf(db: DatabaseSync): ChangeStore {
  if (!ready.has(db)) {
    ensureChangeTables(db)
    ready.add(db)
  }
  return new ChangeStore(db)
}

export const sheetWaiting: FileWaiting = {
  count(sources, db: DatabaseSync) {
    const stores = sources.map(storeOf)
    const named = [...new Set(stores.filter((s): s is string => s !== null))]
    const cells = new SuggestionStore(db).openCounts(named)
    // A format or a rule an agent proposed waits too (changes.ts): one more each.
    const said = changesOf(db).openCounts(named)
    return stores.map((s) => (s === null ? 0 : (cells.get(s) ?? 0) + (said.get(s)?.count ?? 0)))
  },
  files(db, host, most) {
    const counts = new Map<string, number>()
    for (const r of new SuggestionStore(db).storesOpen(PREFIX, most)) counts.set(r.store, r.count)
    for (const r of changesOf(db).storesOpen(PREFIX, most)) counts.set(r.store, (counts.get(r.store) ?? 0) + r.count)
    return [...counts].slice(0, most).map(([store, count]) => ({ source: { at: 'file' as const, host, path: store.slice(PREFIX.length) }, count }))
  }
}
