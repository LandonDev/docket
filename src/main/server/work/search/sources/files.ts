import { fileChipOf, PLACE, type FileEntry } from '@shared/work/files'
import { fileKey, type SearchHit } from '@shared/work/search'
import { WORK_MODULES, type Caller, type WorkCtx, type WorkModule } from '../../modules'
import { askPillar } from '../ask'
import type { SearchSource } from '../source'

/**
 * Files, which are Files' to find (docs/agents/work-search.md "Files and
 * Messages"): search asks `work.files.names` for the list as he types and
 * `work.files.search` for all files of a search, a job in reach at a time,
 * with the caller it was given. It reads no file, walks no folder,
 * downloads nothing and keeps no index: what Files answers is names and
 * places, already cut to what the caller may see. Until Files answers
 * those two methods the group is absent.
 */

/** A row as Files lists one (src/shared/work/files.ts `FileEntry`), by the fields search reads. */
export interface FileRow {
  key: string
  ref: unknown | null
  name: string
  changed?: number
  local?: boolean
  where?: { place: string; name: string; trail: string[] }
}

/**
 * Where a file lies, as its row says it: its place and the folders down to
 * it. The job's own folder is named for the job, which the row already
 * says: there only the folders are said, and nothing at its top.
 */
const whereWords = (where: NonNullable<FileRow['where']>): string => (where.place === PLACE.folder ? where.trail : [where.name, ...where.trail]).filter(Boolean).join(' › ')

const hitOf = (row: FileRow, workspaceId: string): SearchHit => ({
  key: fileKey(row.key),
  kind: 'file',
  title: row.name,
  ...(row.where && whereWords(row.where) ? { detail: whereWords(row.where) } : {}),
  ...(row.changed !== undefined ? { at: row.changed } : {}),
  workspaceId,
  open: { to: 'file', ref: row.ref, name: row.name },
  // The chip Files gives the same row, so a thread can be started about a file he found (never a folder: those are left out).
  ...(chipOf(row) ? { chip: chipOf(row)! } : {}),
  ...(row.local === false ? { cloud: true as const } : {})
})

const chipOf = (row: FileRow) => fileChipOf(row as unknown as FileEntry)

/** One Files method asked of every job in reach, a turn a job, folders left out (a hit opens as a file). */
async function ask(ctx: WorkCtx, modules: readonly WorkModule[], method: string, params: (workspaceId: string) => Record<string, unknown>, o: Pick<SearchAsk, 'limit' | 'by' | 'signal' | 'note'> & { reach: { workspaces: { id: string }[] } }): Promise<SearchHit[]> {
  const asleep = new Set<string>()
  const each = await Promise.all(
    o.reach.workspaces.map(async (w) => {
      const answer = await askPillar<{ entries?: FileRow[]; asleep?: string[] }>(ctx, modules, method, params(w.id), o.by, o.signal)
      for (const name of answer?.asleep ?? []) asleep.add(name)
      return (answer?.entries ?? []).filter((row) => row.ref).map((row) => hitOf(row, w.id))
    })
  )
  // Files left a place out because its machine is asleep (a search never wakes one): said under the list, in Files' own words.
  if (asleep.size) o.note?.({ cause: 'files:asleep', line: asleepWords([...asleep]) })
  const out: SearchHit[] = []
  for (let i = 0; out.length <= o.limit && each.some((hits) => i < hits.length); i++) for (const hits of each) if (i < hits.length) out.push(hits[i])
  return out.slice(0, o.limit + 1)
}

/** What Files' own search says of the places it left asleep (work/files/model.ts `searchGap`). */
export function asleepWords(names: readonly string[]): string {
  const list = names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return names.length === 1 ? `${list} is asleep. Its files were not searched.` : `${list} are asleep. Their files were not searched.`
}

export function fileSources(modules: readonly WorkModule[] = WORK_MODULES): SearchSource[] {
  return [
    {
      kind: 'file',
      label: 'Files',
      tier: 'instant',
      search: (a, ctx) => ask(ctx, modules, 'work.files.names', (workspaceId) => ({ workspaceId, text: a.text }), a)
    },
    {
      kind: 'file',
      label: 'Files',
      tier: 'network',
      // Files' own search of every place: asked only for all files, never as he types.
      when: 'alone',
      search: (a, ctx) => ask(ctx, modules, 'work.files.search', (workspaceId) => ({ workspaceId, query: a.text }), a)
    }
  ]
}

/** How long one answer about a job's places stands. */
const COVER_MS = 60_000
const covers = new WeakMap<object, Map<string, { at: number; lifeos: boolean }>>()

/**
 * Whether Files lists LifeOS's documents for a job on this host: it answers
 * `work.files.names`, and LifeOS is one of the job's places. Then a
 * document is a file there, and the Documents source stands down for that
 * job so nothing is listed twice.
 */
export async function filesHoldLifeos(ctx: WorkCtx, workspaceId: string, by: Caller, modules: readonly WorkModule[] = WORK_MODULES, now = Date.now()): Promise<boolean> {
  const known = covers.get(ctx.db)?.get(workspaceId)
  if (known && now - known.at < COVER_MS) return known.lifeos
  let lifeos = false
  try {
    const names = await askPillar<{ entries?: unknown[] }>(ctx, modules, 'work.files.names', { workspaceId, text: '' }, by)
    if (names) {
      const places = await askPillar<{ places?: { kind?: string }[] }>(ctx, modules, 'work.files.places', { workspaceId }, by)
      lifeos = !!places?.places?.some((p) => p.kind === 'lifeos')
    }
  } catch {
    // Files answered a fault: the Documents source stays
  }
  if (!covers.has(ctx.db)) covers.set(ctx.db, new Map())
  covers.get(ctx.db)!.set(workspaceId, { at: now, lifeos })
  return lifeos
}
