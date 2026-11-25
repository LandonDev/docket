import { createHash } from 'node:crypto'
import { constants, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { basename, isAbsolute, join, relative } from 'node:path'
import { fileDocName } from 'work-kit/collab-server'
import { freeName, refKey, splitName } from '@shared/work/files'
import type { WorkCtx } from '../modules'
import { privateBranchDir } from '../history/privateBranches'
import { servicePaths } from '../service/config'
import { wordStoreDocs, wordStoreRoot } from './imports'
import { fileMoved } from './moved'
import { workspaceHere } from './policy'

export { wordStoreDocs, wordStoreRoot }

/**
 * The hidden Word store (docs/agents/work-files.md "A Word file from another computer"; the plan's decision 3): the
 * document made of a Word file of another computer, and the file as it was before TempCode's first write over it,
 * are kept under this host's own data, one folder per workspace, never in his folder and never in a folder that
 * syncs. Each still counts shared to the hold: its record names it (docs/target.ts `keptForWord`), and anything in
 * the store does by where it lies (`madeFromShared`).
 *
 * A build before this one kept both in the workspace's own folder. `settleWordStore`, at each start, copies each such
 * file into the store and points everything that hangs on it there (`fileMoved`: the record, the canvas items, the
 * document's comments and mode, the tabs; the agent's private branches by their folder); the old file is kept until a
 * later start reads the record back naming the copy, and then goes only if its bytes are still the ones copied.
 */

/** One workspace's folder in the store: its id hashed, so no id names a path. */
export const wordStoreOf = (dataDir: string, workspaceId: string): string =>
  join(wordStoreRoot(dataDir), createHash('sha1').update(workspaceId).digest('hex').slice(0, 16))

/** The workspace's store folder, made (0700) when it is not there yet. */
export function wordStore(dataDir: string, workspaceId: string): string {
  const dir = wordStoreOf(dataDir, workspaceId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

const inside = (path: string, dir: string): boolean => {
  const r = relative(dir, path)
  return r !== '' && !r.startsWith('..') && !isAbsolute(r)
}
export const inWordStore = (dataDir: string, path: string): boolean => inside(path, wordStoreRoot(dataDir))

const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
const mtime = (path: string): number => Math.round(statSync(path).mtimeMs)

/** A copy of `from` at `to`, never over a file, with its change time: a document's `doc_at` still reads it unchanged. */
function copyKeepingTime(from: string, to: string): void {
  copyFileSync(from, to, constants.COPYFILE_EXCL)
  const at = statSync(from)
  utimesSync(to, at.atime, at.mtime)
}

/** Whether the service holds edits of this document it has not stored yet: its journal (work-kit's `UpdateJournal`, `file~<hash>.<n>.log`). */
function journaled(dataDir: string, doc: string): boolean {
  const stem = `${fileDocName(doc).replace(/:/g, '~')}.`
  try {
    return readdirSync(join(servicePaths(dataDir).serviceDir, 'journal')).some((n) => n.startsWith(stem) && n.endsWith('.log'))
  } catch {
    return false
  }
}

interface WordFiles {
  workspace_id: string
  host: string
  path: string
  doc: string | null
  original: string | null
  doc_at: number | null
  saved_doc_at: number | null
}

/**
 * At start: first the files an earlier start moved whose records now read back naming the store go from his folder
 * (`forget`); then each record whose document or original still lies in the workspace's folder is moved (`move`).
 * Answers what it did. Never throws for one record: that one stays as it was and is tried at the next start.
 */
export function settleWordStore(ctx: Pick<WorkCtx, 'db' | 'dataDir' | 'host' | 'canvas' | 'push' | 'log'>): { moved: number; forgotten: number } {
  if (!(ctx.db.prepare(`SELECT count(*) AS n FROM pragma_table_info('work_files_word')`).get() as { n: number }).n) return { moved: 0, forgotten: 0 }
  const forgotten = forget(ctx)
  let moved = 0
  const rows = ctx.db.prepare(`SELECT workspace_id, host, path, doc, original, doc_at, saved_doc_at FROM work_files_word WHERE doc IS NOT NULL OR original IS NOT NULL`).all() as unknown as WordFiles[]
  for (const r of rows) {
    const folder = workspaceHere(ctx.db, r.workspace_id)?.path
    if (!folder) continue
    try {
      if (r.doc && inside(r.doc, folder) && existsSync(r.doc) && !journaled(ctx.dataDir, r.doc)) moveDoc(ctx, r, r.doc), moved++
      if (r.original && inside(r.original, folder) && existsSync(r.original)) moveOriginal(ctx, r, r.original), moved++
    } catch (err) {
      ctx.log(`files: ${basename(r.path)}'s Word files stay in the workspace's folder this time: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (moved || forgotten) ctx.log(`files: the Word store took ${moved} file(s) from workspace folders and let ${forgotten} old one(s) go`)
  return { moved, forgotten }
}

/** A name free in the workspace's store for this file. */
const storePath = (dir: string, name: string): string => join(dir, freeName(name, (n) => existsSync(join(dir, n))))

/** What a moved file was, kept until a later start reads its record back (`work_files_word_moved`). */
const remember = (db: DatabaseSync, old: string, next: string, named: string, bytes: string | null): void =>
  void db.prepare(`INSERT OR REPLACE INTO work_files_word_moved (old, new, named, sha, at) VALUES (?, ?, ?, ?, ?)`).run(old, next, named, bytes, Date.now())

function moveDoc(ctx: Pick<WorkCtx, 'db' | 'dataDir' | 'host' | 'canvas' | 'push' | 'log'>, r: WordFiles, old: string): void {
  const next = storePath(wordStore(ctx.dataDir, r.workspace_id), basename(old))
  copyKeepingTime(old, next)
  const was = mtime(old)
  const from = { path: old, key: refKey({ at: 'file', host: ctx.host, path: old }) }
  const to = { path: next, key: refKey({ at: 'file', host: ctx.host, path: next }) }
  try {
    // The record, its items, its comments and mode, the tabs, and every pillar's rows by its path follow it, at once.
    fileMoved(ctx, from, to)
  } catch (err) {
    rmSync(next, { force: true })
    throw err
  }
  const now = mtime(next)
  const db = ctx.db
  db.prepare(`UPDATE work_files_word SET doc_at = CASE WHEN doc_at = ? THEN ? ELSE doc_at END, saved_doc_at = CASE WHEN saved_doc_at = ? THEN ? ELSE saved_doc_at END WHERE doc = ?`).run(was, now, was, now, next)
  // A star or a recent of the document named a file of his folder; in the store it is the Word file's alone.
  db.prepare(`DELETE FROM work_files_marks WHERE ref_key = ?`).run(to.key)
  remember(db, old, next, next, sha(old))
  // An agent's pending suggestions are kept by the document's path, under the service's own data.
  const root = join(servicePaths(ctx.dataDir).serviceDir, 'private-branches')
  const branches = privateBranchDir(root, old)
  if (existsSync(branches) && !existsSync(privateBranchDir(root, next))) {
    cpSync(branches, privateBranchDir(root, next), { recursive: true, errorOnExist: true })
    remember(db, branches, privateBranchDir(root, next), next, null)
  }
}

function moveOriginal(ctx: Pick<WorkCtx, 'db' | 'dataDir'>, r: WordFiles, old: string): void {
  const { stem, ext } = splitName(basename(old))
  const next = storePath(wordStore(ctx.dataDir, r.workspace_id), `${stem}${ext}`)
  copyKeepingTime(old, next)
  ctx.db.prepare(`UPDATE work_files_word SET original = ? WHERE workspace_id = ? AND host = ? AND path = ?`).run(next, r.workspace_id, r.host, r.path)
  remember(ctx.db, old, next, next, sha(old))
}

/**
 * The old files of an earlier start's move: each goes once its record reads back naming its copy in the store and the
 * copy is there, and only while its bytes are the ones copied (the service may have stored his last words into it).
 * One changed since, or one whose record is gone, is his and stays. A folder of private branches goes the same way.
 */
function forget(ctx: Pick<WorkCtx, 'db' | 'log'>): number {
  let gone = 0
  const rows = ctx.db.prepare(`SELECT old, new, named, sha FROM work_files_word_moved`).all() as { old: string; new: string; named: string; sha: string | null }[]
  for (const m of rows) {
    const named = ctx.db.prepare(`SELECT 1 FROM work_files_word WHERE doc = ? OR original = ? LIMIT 1`).get(m.named, m.named)
    if (named && existsSync(m.new) && existsSync(m.old)) {
      if (m.sha === null || sha(m.old) === m.sha) {
        rmSync(m.old, { recursive: m.sha === null, force: true })
        gone++
      } else ctx.log(`files: ${basename(m.old)} changed after it was copied to the Word store, so it stays where it is`)
    }
    ctx.db.prepare(`DELETE FROM work_files_word_moved WHERE old = ?`).run(m.old)
  }
  return gone
}
