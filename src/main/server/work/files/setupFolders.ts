import type { DatabaseSync } from 'node:sqlite'
import { rootFolder, rootsOf, setRoots, setSetupLedger, setupLedger } from '../office/files/library'
import { forgetLibraries } from './places/libraries'

/**
 * The folders a computer's setup adds to Files (his `J:` drive on a PC): each goes on this host's folder list,
 * the same list Settings → Work → Folders → Add folder… writes, and a ledger marks it as setup's. Remove takes
 * back exactly what the ledger marks; a folder that was on the list before setup stays. Each is a shared place,
 * so a thread's change in it is held as `file.act` (files/policy.ts).
 */

/** Adds each folder not on the list yet and marks it as setup's. Answers the folders it added. */
export function addSetupFolders(db: DatabaseSync, paths: readonly string[]): string[] {
  const roots = rootsOf(db)
  const listed = new Set(roots.map((r) => r.folder))
  const added = [...new Set(paths.map(rootFolder))].filter((f) => !listed.has(f))
  if (!added.length) return []
  setRoots(db, [...roots, ...added.map((folder) => ({ folder }))])
  setSetupLedger(db, [...setupLedger(db), ...added])
  forgetLibraries(db)
  return added
}

/** Takes the folders setup added off the list, and only those. Answers the folders it removed. */
export function removeSetupFolders(db: DatabaseSync): string[] {
  const ledger = new Set(setupLedger(db))
  if (!ledger.size) return []
  const roots = rootsOf(db)
  const gone = roots.filter((r) => ledger.has(r.folder)).map((r) => r.folder)
  setRoots(db, roots.filter((r) => !ledger.has(r.folder)))
  setSetupLedger(db, [])
  forgetLibraries(db)
  return gone
}
