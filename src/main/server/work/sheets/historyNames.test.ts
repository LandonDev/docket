import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { ensureGuestTables, GuestStore } from '../guests/store'
import type { WorkCtx } from '../modules'
import { namedHistory } from '.'

describe("a sheet's history names who made each revision", () => {
  it("a guest's revisions carry the name of their link, an ended link's too, never the link's id", () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT)')
    ensureGuestTables(db)
    const store = new GuestStore(db)
    const source = { at: 'lifeos' as const, table: 'sheets' as const, id: 'ksheet1' }
    const live = store.create({ name: 'Dana Lee', source, title: 'Budget', role: 'edit', expiresAt: Date.now() + 60_000, bySession: null }).link
    const ended = store.create({ name: 'Sam Ito', source, title: 'Budget', role: 'edit', expiresAt: Date.now() + 60_000, bySession: null }).link
    store.revoke(ended.id)
    const ctx = { db, host: 'env_box' } as unknown as WorkCtx
    const got = namedHistory(ctx, {
      revisions: [
        { rev: 3, at: 3, by: `guest:${live.id}`, label: '1 cell' },
        { rev: 2, at: 2, by: `guest:${ended.id}`, label: 'Inserted rows' },
        { rev: 1, at: 1, by: 'owner', label: '2 cells' },
        { rev: 0, at: 0, by: 'file', label: 'Made' }
      ]
    })
    expect(got.names).toEqual({ [`guest:${live.id}`]: 'Dana Lee', [`guest:${ended.id}`]: 'Sam Ito', owner: 'You' })
    expect(got.revisions).toHaveLength(4)
    // A link no row names any more is a guest still, in words.
    expect(namedHistory(ctx, { revisions: [{ by: 'guest:gone' }] }).names).toEqual({ 'guest:gone': 'A guest' })
  })
})
