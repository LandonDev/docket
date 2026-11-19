import type { DatabaseSync } from 'node:sqlite'
import type { BrowserDriver, BrowserState, PortalSource } from '@shared/contract-work-browser'

/**
 * Who drives each thread's browser, and what the canvas says beside it
 * (docs/agents/work-browser.md). One row per pane thread. The rows are
 * about a live screen on this host's Mac, so they do not ride a thread to
 * another host: the thread arrives with the agent driving and nothing else.
 */

export function ensureBrowserTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_browser_drive (
    session_id TEXT PRIMARY KEY,
    driver TEXT NOT NULL DEFAULT 'agent',
    needs TEXT,
    site TEXT,
    sources TEXT NOT NULL DEFAULT '[]',
    since INTEGER NOT NULL,
    actor TEXT
  )`)
}

interface Row {
  session_id: string
  driver: string
  needs: string | null
  site: string | null
  sources: string
  since: number
  actor: string | null
}

const parse = <T>(raw: string | null, fallback: T): T => {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

/** A site by its host, so the agent moving from page to page of one site keeps its sources. */
const siteKey = (url: string): string => {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

const bareUrl = (url: string): string => {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}`
  } catch {
    return url.split(/[?#]/)[0] ?? url
  }
}

export class DriveStore {
  constructor(private readonly db: DatabaseSync) {}

  get(sessionId: string): BrowserState {
    const row = this.db.prepare('SELECT * FROM work_browser_drive WHERE session_id = ?').get(sessionId) as Row | undefined
    if (!row) return { sessionId, driver: 'agent', needs: null, site: null, sources: [], since: 0 }
    return {
      sessionId,
      driver: row.driver === 'owner' ? 'owner' : 'agent',
      needs: row.needs,
      site: parse<BrowserState['site']>(row.site, null),
      sources: parse<PortalSource[]>(row.sources, []),
      since: row.since
    }
  }

  /** The thread of the pane's tree that last used a browser tool: the one handing back wakes. */
  actor(sessionId: string): string | null {
    const row = this.db.prepare('SELECT actor FROM work_browser_drive WHERE session_id = ?').get(sessionId) as { actor: string | null } | undefined
    return row?.actor ?? null
  }

  private put(next: BrowserState, actor?: string): BrowserState {
    this.db
      .prepare(
        `INSERT INTO work_browser_drive (session_id, driver, needs, site, sources, since, actor) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET driver = excluded.driver, needs = excluded.needs, site = excluded.site, sources = excluded.sources, since = excluded.since,
           actor = COALESCE(excluded.actor, work_browser_drive.actor)`
      )
      .run(next.sessionId, next.driver, next.needs, next.site ? JSON.stringify(next.site) : null, JSON.stringify(next.sources), next.since, actor ?? null)
    return next
  }

  /** The agent opens a page: nothing is asked of him yet, and another site's sources go. */
  open(sessionId: string, site: { url: string; name: string }, actor: string, now = Date.now()): BrowserState {
    const was = this.get(sessionId)
    const same = !!was.site && siteKey(was.site.url) === siteKey(site.url)
    // A page's address without its query or fragment: a sign-in link's one-time code goes to no client.
    return this.put({ ...was, site: { ...site, url: bareUrl(site.url) }, needs: null, sources: same ? was.sources : [], since: was.driver === 'owner' ? was.since : now }, actor)
  }

  /** Who drives. Either way the page's need is answered: he took over to meet it, or handed back once he had. */
  drive(sessionId: string, driver: BrowserDriver, now = Date.now()): BrowserState {
    const was = this.get(sessionId)
    if (was.driver === driver && !was.needs && was.since) return was
    return this.put({ ...was, driver, needs: null, since: now })
  }

  needs(sessionId: string, needs: string, actor: string, now = Date.now()): BrowserState {
    return this.put({ ...this.get(sessionId), needs, since: now }, actor)
  }

  /** Sources by field; a field named again takes the newer source. */
  sources(sessionId: string, add: readonly PortalSource[], actor: string): BrowserState {
    const was = this.get(sessionId)
    const byField = new Map(was.sources.map((s) => [s.field, s]))
    for (const s of add) byField.set(s.field, s)
    return this.put({ ...was, sources: [...byField.values()], since: was.since || Date.now() }, actor)
  }

  remove(sessionIds: readonly string[]): void {
    const drop = this.db.prepare('DELETE FROM work_browser_drive WHERE session_id = ?')
    for (const id of sessionIds) drop.run(id)
  }
}
