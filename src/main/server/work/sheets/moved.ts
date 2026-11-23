import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { dirname, extname, join } from 'node:path'
import { canvasSourcePath, type CanvasSource } from '@shared/work'
import type { FileMoved } from '../files/hooks'
import { servicePaths } from '../service/config'
import { importMoved } from './formatsIn'
import { csvEdited, csvSheetPath, ownCsvPath, PACKAGE_EXT, sharedCopies } from './held'

/**
 * A sheet's file was renamed or moved (docs/agents/work-files.md "The seam with the editor
 * builds", point 8): everything this pillar keeps by the file's path follows it. Called inside
 * the savepoint the rename runs in, so the rows move with it or not at all; the folders are
 * renamed last, and a row that names a folder that did not move is found again by its path.
 *
 *  - an opened Excel file: its revision row and op log (`work_sheets_files`, `work_sheets_ops`),
 *    the kept copies under `sheets/files/<hash of the path>/` (a shared workbook's under Files'
 *    scratch, `sharedCopies`), who holds it (`work_sheets_shared`), and what is keyed `file:<path>`
 *    (suggestions, a waiting format or rule, the mode and written line, our charts);
 *  - a `.tcsheet`: what is keyed `tcsheet:<path>`, and its waiting suggestions' file in the Work
 *    service's folder (`work-service/sheets/suggestions/`, by the path's hash);
 *  - a `.csv`: the sheet it opens as (`sheets/csv/<hash>.tcsheet`), with that sheet's own keys.
 *  - an `.xls`, `.ods` or `.tsv` of his own: the Excel copy it opens as (`sheets/imports/<hash>/`, formatsIn.ts),
 *    with his edits, and what the copy keeps as an opened package.
 */

const hash = (path: string): string => createHash('sha256').update(path).digest('hex').slice(0, 24)

function rekey(db: DatabaseSync, from: string, to: string): void {
  // What was kept under the new name before (a file once there, long gone) gives way to what moves in.
  for (const table of ['work_sheets_suggestions', 'work_sheets_changes', 'work_sheets_prefs', 'work_sheets_charts']) {
    db.prepare(`DELETE FROM ${table} WHERE store = ?`).run(to)
    db.prepare(`UPDATE ${table} SET store = ? WHERE store = ?`).run(to, from)
  }
}

/** Moves a file or a folder of this host's own data, over whatever stood at the new place. */
function carry(from: string, to: string): void {
  if (!existsSync(from)) return
  rmSync(to, { recursive: true, force: true })
  mkdirSync(dirname(to), { recursive: true })
  renameSync(from, to)
}

/** Where the Work service keeps a .tcsheet's waiting suggestions (service/routes/internalSheet.ts): its own folder, by the path's hash. */
const sideFile = (dataDir: string, tcsheet: string): string => join(servicePaths(dataDir).serviceDir, 'sheets', 'suggestions', `${hash(tcsheet)}.json`)

export const sheetFileMoved: FileMoved = (from: CanvasSource, to: CanvasSource, at) => {
  // Only a file on this host is kept by its path here.
  if (from.at !== 'file' || to.at !== 'file' || from.host !== at.host || to.host !== at.host) return
  const a = canvasSourcePath(from)
  const b = canvasSourcePath(to)
  if (a === null || b === null || a === b) return
  const ext = extname(a).toLowerCase()
  // (a shared file's copy is its tab's own and is found by the tab, wherever the file goes)
  const copy = importMoved(at.dataDir, a, b)
  if (copy) return movePackage(at, copy.from, copy.to)
  if (PACKAGE_EXT.has(ext)) return movePackage(at, a, b)
  if (ext === '.tcsheet') {
    rekey(at.db, `tcsheet:${a}`, `tcsheet:${b}`)
    carry(sideFile(at.dataDir, a), sideFile(at.dataDir, b))
    return
  }
  if (ext === '.csv') {
    // The sheet among the app's own files follows the file. One he edited stays his sheet under the new name, even in
    // a folder others can open; a cache of a shared file is not carried (it is read again where the file now lies).
    const was = ownCsvPath(at.dataDir, a)
    const now = ownCsvPath(at.dataDir, b)
    if (!csvEdited(was) && csvSheetPath(at.dataDir, b) !== now) {
      rmSync(was, { force: true })
      return
    }
    rekey(at.db, `tcsheet:${was}`, `tcsheet:${now}`)
    carry(sideFile(at.dataDir, was), sideFile(at.dataDir, now))
    carry(was, now)
  }
}

/** What is kept of an opened package by its path, moved from `a` to `b`. */
function movePackage(at: Parameters<FileMoved>[2], a: string, b: string): void {
  at.db.prepare('DELETE FROM work_sheets_ops WHERE path = ?').run(b)
  at.db.prepare('DELETE FROM work_sheets_files WHERE path = ?').run(b)
  at.db.prepare('UPDATE work_sheets_ops SET path = ? WHERE path = ?').run(b, a)
  at.db.prepare('UPDATE work_sheets_files SET path = ? WHERE path = ?').run(b, a)
  // Who holds a workbook others can open follows it too; whether the new place is one is asked again when it is next touched.
  at.db.prepare('DELETE FROM work_sheets_shared WHERE path = ?').run(b)
  at.db.prepare('UPDATE work_sheets_shared SET path = ? WHERE path = ?').run(b, a)
  rekey(at.db, `file:${a}`, `file:${b}`)
  carry(join(at.dataDir, 'sheets', 'files', hash(a)), join(at.dataDir, 'sheets', 'files', hash(b)))
  carry(join(sharedCopies(at.dataDir), hash(a)), join(sharedCopies(at.dataDir), hash(b)))
}
