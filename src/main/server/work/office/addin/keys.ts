import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

/**
 * The add-in's keys (docs/agents/work-office.md "Pairing"). TempCode shows a
 * short code; the add-in sends it once and gets a key of its own, which it
 * keeps in its pane's storage. Only the key's hash is kept here. A code lives
 * five minutes and opens one pairing; one code at a time. A caller (by its
 * address) gets five wrong tries a code, so nobody else can spend his code's
 * tries; past a thousand wrong tries in all the code dies.
 */

export const CODE_MS = 5 * 60_000
export const CODE_TRIES = 5
export const CODE_TRIES_ALL = 1000
/** No 0/O, 1/I/L: read off a screen and typed. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const CODE_LENGTH = 8

export interface AddinKey {
  id: string
  name: string
  app: string
  createdAt: number
  seenAt: number | null
}

export function ensureAddinTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_office_addin_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    app TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    seen_at INTEGER
  )`)
}

const hashOf = (key: string): string => createHash('sha256').update(key).digest('hex')

export class AddinKeys {
  private code: { code: string; expiresAt: number; tries: number; by: Map<string, number> } | null = null

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now
  ) {}

  /** A new pairing code; the one before it stops working. */
  mint(): { code: string; expiresAt: number } {
    let code = ''
    for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)]
    this.code = { code, expiresAt: this.now() + CODE_MS, tries: 0, by: new Map() }
    return { code, expiresAt: this.code.expiresAt }
  }

  /** Pairs an add-in with the code: its new key, or null (and a try spent) when the code is wrong or gone. */
  pair(code: unknown, name: string, app: string, from = '?'): { id: string; key: string } | null {
    const c = this.code
    if (!c || c.expiresAt <= this.now()) {
      this.code = null
      return null
    }
    const spent = c.by.get(from) ?? 0
    if (spent >= CODE_TRIES) return null
    if (typeof code !== 'string' || code.toUpperCase() !== c.code) {
      c.by.set(from, spent + 1)
      if (++c.tries >= CODE_TRIES_ALL) this.code = null
      return null
    }
    this.code = null
    const id = randomUUID()
    const key = `tca_${randomBytes(32).toString('base64url')}`
    this.db
      .prepare('INSERT INTO work_office_addin_keys (id, name, app, hash, created_at, seen_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, name.slice(0, 80) || 'Office add-in', app.slice(0, 20), hashOf(key), this.now(), this.now())
    return { id, key }
  }

  /** The key's id, or null: a key the host never minted, or one he removed. */
  check(key: unknown): string | null {
    if (typeof key !== 'string' || !key.startsWith('tca_') || key.length > 100) return null
    const row = this.db.prepare('SELECT id FROM work_office_addin_keys WHERE hash = ?').get(hashOf(key)) as { id: string } | undefined
    if (!row) return null
    this.db.prepare('UPDATE work_office_addin_keys SET seen_at = ? WHERE id = ?').run(this.now(), row.id)
    return row.id
  }

  list(): AddinKey[] {
    return (this.db.prepare('SELECT id, name, app, created_at, seen_at FROM work_office_addin_keys ORDER BY created_at').all() as { id: string; name: string; app: string; created_at: number; seen_at: number | null }[]).map((r) => ({
      id: r.id,
      name: r.name,
      app: r.app,
      createdAt: r.created_at,
      seenAt: r.seen_at
    }))
  }

  remove(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM work_office_addin_keys WHERE id = ?').run(id).changes) > 0
  }
}
