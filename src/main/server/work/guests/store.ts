import { createHash, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { canonicalPath } from '../service/ctx'
import { GUEST_KEEP_MS, type GuestLinkRow, type GuestLinkSource, type GuestRole } from '@shared/contract-work-guests'

/**
 * The guest link rows (`work_guest_links`, architecture §8.6). The secret is
 * 32 random bytes, shown once in the address's fragment and kept only as its
 * SHA-256: a guess has 2^256 to cover, so no slow hash is needed. Rows are
 * never deleted while they matter: a revoked or ended one stays listed a week.
 */

export const GUEST_LINKS_TABLE = 'work_guest_links'
export const GUEST_MARKS_TABLE = 'work_guest_marks'

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
  // What this host has marked shared in LifeOS: a project link marks every document and sheet the
  // project shows, and only this remembers them once the link is over and the host has restarted.
  db.exec(`CREATE TABLE IF NOT EXISTS ${GUEST_MARKS_TABLE} (key TEXT PRIMARY KEY)`)
  // A file link's file, by the id inside it (fileIdent.ts); null for a LifeOS row's link, and for a file's made before the rule.
  const columns = new Set((db.prepare(`PRAGMA table_info(${GUEST_LINKS_TABLE})`).all() as { name: string }[]).map((c) => c.name))
  if (!columns.has('file_uid')) db.exec(`ALTER TABLE ${GUEST_LINKS_TABLE} ADD COLUMN file_uid TEXT`)
  // When the link was first opened, and when its guest last changed the item: what the owner has been told of (tells.ts).
  if (!columns.has('first_opened_at')) db.exec(`ALTER TABLE ${GUEST_LINKS_TABLE} ADD COLUMN first_opened_at INTEGER`)
  if (!columns.has('last_wrote_at')) db.exec(`ALTER TABLE ${GUEST_LINKS_TABLE} ADD COLUMN last_wrote_at INTEGER`)
}

/** A link's row as main keeps it: the public row and what only the host may read. */
export interface StoredLink extends Omit<GuestLinkRow, 'lastOpenedAt' | 'open'> {
  secretHash: string
  /** the thread whose request his press granted; null for his own */
  bySession: string | null
  /** a file link's file, by the id inside it; null for any other link, and until an older file link's is read */
  fileUid: string | null
  /** when the link was first opened, as the owner was told; null until it is */
  firstOpenedAt: number | null
  /** when its guest last changed the item, as last told; null until they do */
  lastWroteAt: number | null
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
  file_uid?: string | null
  first_opened_at?: number | null
  last_wrote_at?: number | null
}

const rowOf = (r: Raw): StoredLink => ({
  id: r.id,
  secretHash: r.secret_hash,
  name: r.name,
  source: JSON.parse(r.source) as GuestLinkSource,
  title: r.title,
  role: r.role as GuestRole,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
  by: r.by_session ? 'agent' : 'owner',
  bySession: r.by_session,
  fileUid: r.file_uid ?? null,
  firstOpenedAt: r.first_opened_at ?? null,
  lastWroteAt: r.last_wrote_at ?? null
})

export const hashSecret = (secret: string): string => createHash('sha256').update(secret, 'utf8').digest('hex')

export const isLive = (l: Pick<StoredLink, 'revokedAt' | 'expiresAt'>, now = Date.now()): boolean => l.revokedAt === null && now < l.expiresAt

/** A link's item as a key: a LifeOS row's `<table>:<id>` (as LifeOS's marks are named), a file's `file:<id>`. */
export const sourceKey = (s: Pick<GuestLinkSource, 'at' | 'table' | 'id'>): string => (s.at === 'file' ? `file:${s.id}` : `${s.table}:${s.id}`)

/** A file's id among the links: a digest of its resolved path, so two spellings of one file are one item. */
export const fileLinkId = (resolved: string): string => createHash('sha256').update(resolved, 'utf8').digest('hex').slice(0, 40)

export class GuestStore {
  constructor(private readonly db: DatabaseSync) {}

  /** A new link and its secret; the secret is returned here and nowhere else. */
  create(o: { name: string; source: GuestLinkSource; title: string; role: GuestRole; expiresAt: number; bySession: string | null; fileUid?: string | null }, now = Date.now()): { link: StoredLink; secret: string } {
    const id = randomBytes(12).toString('base64url')
    const secret = randomBytes(32).toString('base64url')
    this.db
      .prepare(`INSERT INTO ${GUEST_LINKS_TABLE} (id, secret_hash, name, source, title, role, created_at, expires_at, revoked_at, by_session, file_uid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
      .run(id, hashSecret(secret), o.name, JSON.stringify(o.source), o.title, o.role, now, o.expiresAt, o.bySession, o.fileUid ?? null)
    return { link: this.get(id)!, secret }
  }

  /** What the owner has been told of a link: its first open, its guest's last change (tells.ts). */
  setSeen(id: string, o: { firstOpenedAt?: number; lastWroteAt?: number }): void {
    if (o.firstOpenedAt !== undefined) this.db.prepare(`UPDATE ${GUEST_LINKS_TABLE} SET first_opened_at = ? WHERE id = ? AND first_opened_at IS NULL`).run(o.firstOpenedAt, id)
    if (o.lastWroteAt !== undefined) this.db.prepare(`UPDATE ${GUEST_LINKS_TABLE} SET last_wrote_at = ? WHERE id = ?`).run(o.lastWroteAt, id)
  }

  /** A file link made before links knew their file by its id: the id its file carries now is taken as its own, once. */
  setFileUid(id: string, uid: string): void {
    this.db.prepare(`UPDATE ${GUEST_LINKS_TABLE} SET file_uid = ? WHERE id = ? AND file_uid IS NULL`).run(uid, id)
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

  /** A link that was never made: LifeOS did not take its item's `shared`, so nothing of it was ever live. */
  forget(id: string): void {
    this.db.prepare(`DELETE FROM ${GUEST_LINKS_TABLE} WHERE id = ?`).run(id)
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

  /** A live link's role, changed; false for a link that is not live. */
  setRole(id: string, role: GuestRole, now = Date.now()): boolean {
    return Number(this.db.prepare(`UPDATE ${GUEST_LINKS_TABLE} SET role = ? WHERE id = ? AND revoked_at IS NULL AND expires_at > ?`).run(role, id, now).changes) > 0
  }

  forSource(source: Pick<GuestLinkSource, 'at' | 'table' | 'id'>, now = Date.now()): StoredLink[] {
    return this.listed(now).filter((l) => sourceKey(l.source) === sourceKey(source))
  }

  /** The LifeOS rows (`docs:<id>`, `sheets:<id>`, `projects:<id>`) this host marked shared and has not unmarked. */
  marks(): string[] {
    return (this.db.prepare(`SELECT key FROM ${GUEST_MARKS_TABLE}`).all() as { key: string }[]).map((r) => r.key)
  }

  setMark(key: string, on: boolean): void {
    if (on) this.db.prepare(`INSERT OR IGNORE INTO ${GUEST_MARKS_TABLE} (key) VALUES (?)`).run(key)
    else this.db.prepare(`DELETE FROM ${GUEST_MARKS_TABLE} WHERE key = ?`).run(key)
  }

  name(id: string): string | null {
    return (this.db.prepare(`SELECT name FROM ${GUEST_LINKS_TABLE} WHERE id = ?`).get(id) as { name?: string } | undefined)?.name ?? null
  }
}

/**
 * Whether a live guest link names this file (by `fileLinkId` of its resolved path): someone outside may open it, so
 * an agent's own change to it waits as a suggestion, as on a LifeOS row marked shared. Read by name, as other pillars
 * read this table; a database without it (a test's) has none.
 */
export function fileLinked(db: DatabaseSync | undefined, resolved: string, now = Date.now()): boolean {
  if (!db) return false
  try {
    return !!db.prepare(`SELECT 1 FROM ${GUEST_LINKS_TABLE} WHERE revoked_at IS NULL AND expires_at > ? AND json_extract(source, '$.at') = 'file' AND json_extract(source, '$.id') = ? LIMIT 1`).get(now, fileLinkId(resolved))
  } catch {
    return false
  }
}

/**
 * What ends a guest's edit access to a file, by this host's database: the guests runtime puts itself here
 * (links.ts), so the pillar that is about to send a document's edits on to another file can ask without reaching it.
 */
const editEnders = new WeakMap<object, (resolved: string) => Promise<void>>()
export const setEditEnder = (db: DatabaseSync, end: (resolved: string) => Promise<void>): void => void editEnders.set(db, end)

/**
 * Before a document's edits start going to another file (Save As keeps the two linked, files/saveAs.ts): every guest
 * who could edit it can only view it from now, their sockets closed, so nothing a guest types reaches that file.
 */
export async function endGuestEditOn(db: DatabaseSync | undefined, resolved: string): Promise<void> {
  if (db && fileLinked(db, resolved)) await editEnders.get(db)?.(resolved)
}

/** Which guests have a file open now, by the file's link id, per host database: what the guests runtime last read from the service (links.ts). */
const present = new WeakMap<object, Map<string, string>>()

/** "Dana Lee", "Dana Lee and Sam Ito", "Dana Lee and 2 others": who is in a file, in the words a row says before "is in it". */
export function whoWords(names: readonly string[]): string {
  const [first, second, ...rest] = names
  if (first === undefined) return ''
  if (second === undefined) return first
  return rest.length ? `${first} and ${rest.length + 1} others` : `${first} and ${second}`
}

/** The guests runtime says who is in which file now (every live file link with a socket open). */
export function setGuestsPresent(db: DatabaseSync, links: readonly { source: { at: string; id: string }; name: string; open: number }[]): void {
  const names = new Map<string, string[]>()
  for (const l of links) if (l.source.at === 'file' && l.open > 0) names.set(l.source.id, [...(names.get(l.source.id) ?? []), l.name])
  present.set(db, new Map([...names].map(([id, who]) => [id, whoWords(who)])))
}

/** Who of his guests has this file open now, as last read (within half a minute); null for nobody. The Files place says it in the file's row. */
export function guestsPresentIn(db: DatabaseSync | undefined, resolved: string): string | null {
  return (db && present.get(db)?.get(fileLinkId(resolved))) || null
}

/** `fileLinked` for a canvas source: a file on this disk, by its resolved path. */
export function guestLinkedFile(db: DatabaseSync | undefined, source: { at: string; path?: string }): boolean {
  if (source.at !== 'file' || typeof source.path !== 'string') return false
  return fileLinked(db, canonicalPath(source.path))
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
