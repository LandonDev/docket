import { copyFile, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { CaptureFiled, CaptureFileParams, CaptureState } from '@shared/contract-work-capture'
import { WORK_HOME, type ContextChip, type SectorKey } from '@shared/work'
import { freeKeptName, keptFileName } from '../../attachmentUploads'
import type { Caller, WorkCtx } from '../modules'

/**
 * Filing a capture (docs/agents/work-capture.md). It is the owner's own
 * write, made on the host's own LifeOS session: a quick add from "Capture"
 * in the sector he picked, or from "Unsorted" in Life, which LifeOS's bot
 * files (its guide says so). Nothing here calls a model or sends anything
 * outward; a thread starts only when he asked for one.
 */

export const TITLE_MAX = 200
/** Where an unsorted capture's task waits, and so where its files are kept. */
export const UNSORTED_HOME: SectorKey = 'life'

const LAST_KEY = 'last'

export function ensureCaptureTables(db: WorkCtx['db']): void {
  db.exec('CREATE TABLE IF NOT EXISTS work_capture_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  // What each capture made, by its key, so a repeat answers it again and copies nothing twice.
  db.exec('CREATE TABLE IF NOT EXISTS work_capture_filed (key TEXT PRIMARY KEY, result TEXT NOT NULL, at INTEGER NOT NULL)')
}

/** Captures are kept by key for a week: long past any retry. */
const FILED_KEEP_MS = 7 * 24 * 3600_000

export const sectorName = (sector: SectorKey): string => sector.charAt(0).toUpperCase() + sector.slice(1)

/** This host's Work workspace for a sector: its id, name and folder; null when there is none. */
export function homeOf(ctx: Pick<WorkCtx, 'db'>, sector: SectorKey): { id: string; name: string; path: string } | null {
  const row = ctx.db.prepare("SELECT id, name, path FROM workspaces WHERE kind = 'work' AND sector = ? ORDER BY created_at LIMIT 1").get(sector) as
    | { id: string; name: string; path: string }
    | undefined
  return row ?? null
}

export function captureState(ctx: Pick<WorkCtx, 'db' | 'lifeos' | 'host'>): CaptureState {
  const last = ctx.db.prepare('SELECT value FROM work_capture_state WHERE key = ?').get(LAST_KEY) as { value: string } | undefined
  const homes = (ctx.db.prepare("SELECT DISTINCT sector FROM workspaces WHERE kind = 'work' AND sector IS NOT NULL").all() as { sector: string }[]).map((r) => r.sector)
  return { host: ctx.host, last: last && last.value !== '' ? last.value : null, homes, connected: ctx.lifeos.connected() }
}

/**
 * The task's title and notes from what he typed: the first line is the
 * title (cut at TITLE_MAX, the rest of it kept in the notes), the other
 * lines are the notes, and a line names the files and where they are kept.
 * With no words, the first file's name is the title.
 */
export function taskWords(text: string, kept: string[], where: string | null): { title: string; description: string } {
  const lines = text.replace(/\r\n?/g, '\n').trim().split('\n')
  const first = lines[0]?.trim() ?? ''
  const cut = first.length > TITLE_MAX ? first.slice(0, TITLE_MAX - 1).trimEnd() + '…' : first
  const title = cut || kept[0] || 'Capture'
  const rest = [first.length > TITLE_MAX ? first : '', ...lines.slice(1)].join('\n').trim()
  const files = kept.length && where ? `Kept in ${where}: ${kept.join(', ')}` : ''
  return { title, description: [rest, files].filter(Boolean).join('\n\n') }
}

/** The first message of a thread he started from a capture: his words, then each kept file's path on this host. */
export function threadText(text: string, paths: string[]): string {
  const words = text.trim()
  const files = paths.map((p) => `- ${p}`).join('\n')
  if (!files) return words
  return [words, `Files:\n${files}`].filter(Boolean).join('\n\n')
}

export async function fileCapture(ctx: WorkCtx, p: CaptureFileParams, by: Caller, now = Date.now()): Promise<CaptureFiled> {
  const before = ctx.db.prepare('SELECT result FROM work_capture_filed WHERE key = ?').get(p.key) as { result: string } | undefined
  if (before) return JSON.parse(before.result) as CaptureFiled
  const filed = await fileOnce(ctx, p, by, now)
  ctx.db.prepare('DELETE FROM work_capture_filed WHERE at < ?').run(now - FILED_KEEP_MS)
  ctx.db.prepare('INSERT OR REPLACE INTO work_capture_filed (key, result, at) VALUES (?, ?, ?)').run(p.key, JSON.stringify(filed), now)
  return filed
}

async function fileOnce(ctx: WorkCtx, p: CaptureFileParams, by: Caller, now: number): Promise<CaptureFiled> {
  const files = p.files ?? []
  if (!p.text.trim() && !files.length) throw new Error('Nothing to capture.')
  if (!ctx.lifeos.connected()) throw new Error('LifeOS is not connected on this computer.')
  const sector = p.sector ?? UNSORTED_HOME
  const home = files.length || p.start ? homeOf(ctx, sector) : null
  if (files.length && !home) throw new Error(`No ${sectorName(sector)} workspace on this computer to keep the file in.`)

  // Each file is checked before any is copied, so a refusal leaves the folder as it was.
  const paths: string[] = []
  for (const source of files) {
    if (source.at !== 'file') throw new Error('Only files can be captured.')
    if (source.host !== ctx.host) throw new Error('That file is on another computer.')
    if (!ctx.reaches(by, source.path)) throw new Error('That file is outside what this key may reach.')
    const info = await stat(source.path).catch(() => null)
    if (!info?.isFile()) throw new Error(`${basename(source.path)} is not a file.`)
    paths.push(source.path)
  }
  const kept: string[] = []
  const keptPaths: string[] = []
  for (const from of paths) {
    const name = freeKeptName(home!.path, keptFileName(basename(from)))
    await copyFile(from, join(home!.path, name))
    kept.push(name)
    keptPaths.push(join(home!.path, name))
  }

  const { title, description } = taskWords(p.text, kept, home?.name ?? null)
  const key = `capture:${p.key}`
  let taskId: string
  try {
    taskId = await ctx.lifeos.owner().mutation<string>('tasks:create', {
      sector,
      title,
      key,
      source: { kind: 'manual', container: 'quick-add', channel: p.sector ? 'Capture' : 'Unsorted', messageId: key, sentAt: now },
      ...(description ? { description } : {})
    })
  } catch (err) {
    // No task, no files: what was copied for it goes, so his next try leaves one copy.
    await Promise.all(keptPaths.map((path) => rm(path, { force: true })))
    throw err
  }
  ctx.db.prepare('INSERT INTO work_capture_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(LAST_KEY, p.sector ?? '')

  if (!p.start) return { taskId, kept }
  const about: ContextChip = { kind: 'task', label: title, ref: { at: 'lifeos', table: 'tasks', id: taskId } }
  // A sorted capture starts in its sector's workspace; an unsorted one, or one with no workspace here, in Work Chats.
  // The task is filed whatever the thread does: a start that fails says so beside it, and his next try files nothing twice.
  try {
    const threadId = await ctx.threads.start({ workspaceId: p.sector && home ? home.id : WORK_HOME, text: threadText(p.text, keptPaths), about })
    return { taskId, kept, threadId }
  } catch (err) {
    return { taskId, kept, threadError: err instanceof Error ? err.message : String(err) }
  }
}
