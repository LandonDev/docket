import type { DatabaseSync } from 'node:sqlite'
import { inReach, RECENT_KIND, SEARCH_LABELS, SEARCH_RECENTS, SEARCH_RECENTS_KEPT, type SearchGroup, type SearchHit, type SearchReach } from '@shared/work/search'

/**
 * What he opened from search, newest first (docs/agents/work-search.md
 * "Recent"): the field's list before he types. A row keeps a thing's kind,
 * title, id and job and how to open it again; never a body, a snippet or a
 * file's contents.
 */

export function ensureRecents(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_search_recent (key TEXT PRIMARY KEY, hit TEXT NOT NULL, opened_at INTEGER NOT NULL)`)
}

/** A hit as Recent keeps it: no fact, no snippet, and its chip without the words it carried. */
function kept(hit: SearchHit): SearchHit {
  const chip = hit.chip ? { kind: hit.chip.kind, label: hit.chip.label, ref: hit.chip.ref } : undefined
  // A thread is kept without the row his words were found in: from Recent it opens where it now stands.
  const open =
    hit.open.to === 'chip'
      ? { to: 'chip' as const, chip: { kind: hit.open.chip.kind, label: hit.open.chip.label, ref: hit.open.chip.ref } }
      : hit.open.to === 'thread'
        ? { to: 'thread' as const, sessionId: hit.open.sessionId }
        : hit.open
  return { key: hit.key, kind: hit.kind, title: hit.title, workspaceId: hit.workspaceId, open, ...(chip ? { chip } : {}), ...(hit.cloud ? { cloud: true as const } : {}) }
}

export function recordOpened(db: DatabaseSync, hit: SearchHit, now = Date.now()): void {
  db.prepare(`INSERT INTO work_search_recent (key, hit, opened_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET hit = excluded.hit, opened_at = excluded.opened_at`).run(hit.key, JSON.stringify(kept(hit)), now)
  db.prepare(`DELETE FROM work_search_recent WHERE key NOT IN (SELECT key FROM work_search_recent ORDER BY opened_at DESC, key LIMIT ?)`).run(SEARCH_RECENTS_KEPT)
}

type Row = { key: string; hit: string; opened_at: number }

/** The newest things he opened whose job is still in reach, as one group; null when there are none. */
export function recentGroup(db: DatabaseSync, reach: SearchReach, keep: (hit: SearchHit) => boolean = () => true, limit = SEARCH_RECENTS): SearchGroup | null {
  if (limit <= 0) return null
  const hits: SearchHit[] = []
  // Two things that would read the same in the list (a row keeps a title and no more) are one, the newest: the
  // eight sent are eight he can tell apart.
  const looks = new Set<string>()
  for (const row of db.prepare(`SELECT key, hit, opened_at FROM work_search_recent ORDER BY opened_at DESC, key`).all() as unknown as Row[]) {
    if (hits.length >= limit) break
    try {
      // Kept again as it is read: a row written before a rule of `kept` (a thread's `seq`) is held to it too.
      const hit = { ...kept(JSON.parse(row.hit) as SearchHit), openedAt: row.opened_at }
      const look = `${hit.kind}\n${hit.title}\n${hit.workspaceId}`
      if (!inReach(reach, hit.workspaceId ?? null) || !keep(hit) || looks.has(look)) continue
      looks.add(look)
      hits.push(hit)
    } catch {
      // a row from a shape this build no longer reads
    }
  }
  return hits.length ? { source: 'search.recent', kind: RECENT_KIND, label: SEARCH_LABELS[RECENT_KIND], hits, more: false } : null
}

/** When he last opened a thing, by key. */
export function openedAt(db: DatabaseSync): (key: string) => number | undefined {
  const read = db.prepare(`SELECT opened_at FROM work_search_recent WHERE key = ?`)
  return (key) => (read.get(key) as { opened_at: number } | undefined)?.opened_at
}

/** A deleted job's rows go with it. */
export function dropWorkspace(db: DatabaseSync, workspaceId: string): void {
  for (const row of db.prepare(`SELECT key, hit FROM work_search_recent`).all() as unknown as Row[]) {
    let gone = true
    try {
      gone = (JSON.parse(row.hit) as SearchHit).workspaceId === workspaceId
    } catch {
      // an unreadable row is dropped too
    }
    if (gone) db.prepare(`DELETE FROM work_search_recent WHERE key = ?`).run(row.key)
  }
}
