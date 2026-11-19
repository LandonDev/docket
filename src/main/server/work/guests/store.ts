import { createHash, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { GUEST_KEEP_MS, type GuestLinkRow, type GuestRole, type GuestSource } from '@shared/contract-work-guests'

/**
 * The guest link rows (`work_guest_links`, architecture §8.6). The secret is
 * 32 random bytes, shown once in the address's fragment and kept only as its
 * SHA-256: a guess has 2^256 to cover, so no slow hash is needed. Rows are
 * never deleted while they matter: a revoked or ended one stays listed a week.
 */

export const GUEST_LINKS_TABLE = 'work_guest_links'

export function ensureGuestTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ${GUEST_LINKS_TABLE} (
    id TEXT PRIMARY KEY,
    secret_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    by_session TEXT
  )`)
}

/** A link's row as main keeps it: the public row and what only the host may read. */
export interface StoredLink extends Omit<GuestLinkRow, 'lastOpenedAt' | 'open'> {
  secretHash: string
  /** the thread whose request his press granted; null for his own */
  bySession: string | null
}

type Raw = {
  id: string
  secret_hash: string
  name: string
  source: string
  title: string
  role: string
  created_at: number
  expires_at: number
  revoked_at: number | null
  by_session: string | null
}

const rowOf = (r: Raw): StoredLink => ({
  id: r.id,
  secretHash: r.secret_hash,
  name: r.name,
  source: JSON.parse(r.source) as GuestSource,
  title: r.title,
  role: r.role as GuestRole,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
  by: r.by_session ? 'agent' : 'owner',
  bySession: r.by_session
})

export const hashSecret = (secret: string): string => createHash('sha256').update(secret, 'utf8').digest('hex')

export const isLive = (l: Pick<StoredLink, 'revokedAt' | 'expiresAt'>, now = Date.now()): boolean => l.revokedAt === null && now < l.expiresAt

export const sourceKey = (s: GuestSource): string => `${s.table}:${s.id}`

export class GuestStore {
  constructor(private readonly db: DatabaseSync) {}

  /** A new link and its secret; the secret is returned here and nowhere else. */
  create(o: { name: string; source: GuestSource; title: string; role: GuestRole; expiresAt: number; bySession: string | null }, now = Date.now()): { link: StoredLink; secret: string } {
    const id = randomBytes(12).toString('base64url')
    const secret = randomBytes(32).toString('base64url')
    this.db
      .prepare(`INSERT INTO ${GUEST_LINKS_TABLE} (id, secret_hash, name, source, title, role, created_at, expires_at, revoked_at, by_session) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
      .run(id, hashSecret(secret), o.name, JSON.stringify(o.source), o.title, o.role, now, o.expiresAt, o.bySession)
    return { link: this.get(id)!, secret }
  }

  get(id: string): StoredLink | null {
    const r = this.db.prepare(`SELECT * FROM ${GUEST_LINKS_TABLE} WHERE id = ?`).get(id) as Raw | undefined
    return r ? rowOf(r) : null
  }

  /** A new secret for a live link: the address shown before opens nothing from now on. Null for a link that is not live. */
  rekey(id: string, now = Date.now()): string | null {
    const secret = randomBytes(32).toString('base64url')
    const changed = this.db.prepare(`UPDATE ${GUEST_LINKS_TABLE} SET secret_hash = ? WHERE id = ? AND revoked_at IS NULL AND expires_at > ?`).run(hashSecret(secret), id, now).changes
    return Number(changed) > 0 ? secret : null
  }

  /** Answers whether it was live before. */
  revoke(id: string, now = Date.now()): boolean {
    return Number(this.db.prepare(`UPDATE ${GUEST_LINKS_TABLE} SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(now, id).changes) > 0
  }

  /** What the list shows: every live link, and the ones that ended or were revoked within the week. */
  listed(now = Date.now()): StoredLink[] {
    const since = now - GUEST_KEEP_MS
    return (
      this.db
        .prepare(`SELECT * FROM ${GUEST_LINKS_TABLE} WHERE (revoked_at IS NULL AND expires_at > ?) OR MIN(COALESCE(revoked_at, expires_at), expires_at) > ? ORDER BY created_at DESC`)
        .all(now, since) as Raw[]
    ).map(rowOf)
  }

  live(now = Date.now()): StoredLink[] {
    return (this.db.prepare(`SELECT * FROM ${GUEST_LINKS_TABLE} WHERE revoked_at IS NULL AND expires_at > ? ORDER BY created_at`).all(now) as Raw[]).map(rowOf)
  }

  forSource(source: GuestSource, now = Date.now()): StoredLink[] {
    return this.listed(now).filter((l) => sourceKey(l.source) === sourceKey(source))
  }

  name(id: string): string | null {
    return (this.db.prepare(`SELECT name FROM ${GUEST_LINKS_TABLE} WHERE id = ?`).get(id) as { name?: string } | undefined)?.name ?? null
  }
}

/** A guest principal's name for a list of authors (`guest:<link>`), or null when no row names it. */
export function guestNameOf(db: DatabaseSync, principal: string): string | null {
  if (!principal.startsWith('guest:')) return null
  try {
    return new GuestStore(db).name(principal.slice('guest:'.length))
  } catch {
    // No table yet (a test's database).
    return null
  }
}
