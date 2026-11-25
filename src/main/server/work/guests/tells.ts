import type { Tell, TellKind } from '@shared/work/tell'
import { within } from '../files/policy'
import type { WorkCtx } from '../modules'
import { canonicalPath } from '../service/ctx'
import type { LinkSeen } from '../service/routes/seen'
import type { StoredLink } from './store'

/**
 * What the owner is told of a guest link (docs/agents/work-guests.md "Tells"), through the digest and never a
 * thread: the first time it is opened, and once a day for each link whose guest changed the item. Neither has a
 * deadline, so both wait for the day's digest. A title holds the name he gave the link and the item's title as it
 * was when he made it: never a word a guest typed.
 */

export const OPENED_TELL: TellKind = { kind: 'guests.opened', group: 'people', name: 'A guest opened a link' }
export const EDITED_TELL: TellKind = { kind: 'guests.edited', group: 'people', name: 'A guest edited a document or sheet' }

export const openedKey = (linkId: string): string => `guest-open:${linkId}`
export const editedKey = (linkId: string, day: string): string => `guest-edit:${linkId}:${day}`

/** A moment's day in his zone, as a digest's is named ('2026-11-24'). */
export const dayOf = (at: number, zone: string): string => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)

export interface SeenTells {
  /** links opened for the first time, with when */
  opened: { link: StoredLink; at: number }[]
  /** links whose guest changed the item since he was last told; `tell`: on a day he has not been told of yet */
  wrote: { link: StoredLink; at: number; day: string; tell: boolean }[]
}

/** The rule, with no clock and no store: what the service saw, against what he has been told. */
export function seenTells(links: readonly StoredLink[], seen: Readonly<Record<string, LinkSeen>>, zone: string): SeenTells {
  const out: SeenTells = { opened: [], wrote: [] }
  for (const link of links) {
    const s = seen[link.id]
    if (!s) continue
    if (link.firstOpenedAt === null && s.at > 0) out.opened.push({ link, at: s.at })
    if (s.wrote !== undefined && s.wrote > (link.lastWroteAt ?? 0)) {
      const day = dayOf(s.wrote, zone)
      out.wrote.push({ link, at: s.wrote, day, tell: link.lastWroteAt === null || dayOf(link.lastWroteAt, zone) !== day })
    }
  }
  return out
}

/** The job a link's item is in, on this host: a file's by its folder, a LifeOS row's by its sector when LifeOS answers. */
export async function workspaceOfLink(ctx: Pick<WorkCtx, 'db'>, link: StoredLink, sectorOf: (link: StoredLink) => Promise<string | null>): Promise<string | null> {
  let rows: { id: string; path: string | null; sector: string | null }[]
  try {
    rows = ctx.db.prepare("SELECT id, path, sector FROM workspaces WHERE kind = 'work'").all() as typeof rows
  } catch {
    return null
  }
  if (link.source.at === 'file') {
    const real = canonicalPath(link.source.path)
    return rows.find((w) => w.path && within(real, canonicalPath(w.path)))?.id ?? null
  }
  const sector = await sectorOf(link).catch(() => null)
  return sector ? (rows.find((w) => w.sector === sector)?.id ?? null) : null
}

/** Where a press on a link's tell goes: the document or sheet in its job, else the list of guest links. */
export function openOf(link: StoredLink, workspaceId: string | null): NonNullable<Tell['open']> {
  if (!workspaceId) return { settings: 'work' }
  if (link.source.at === 'file') return { view: 'files', workspaceId }
  return link.source.table === 'projects' ? { view: 'projects', workspaceId, at: link.source.id } : { view: 'docs', workspaceId, at: `lifeos:${link.source.table}:${link.source.id}` }
}

export const openedTitle = (link: Pick<StoredLink, 'name' | 'title'>): string => `${link.name} opened ${link.title}`
export const editedTitle = (link: Pick<StoredLink, 'name' | 'title'>): string => `${link.name} edited ${link.title}`
