import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { Tell } from '@shared/work/tell'
import type { WorkCtx } from '../modules'
import type { LinkSeen } from '../service/routes/seen'
import { guests } from '.'
import { GuestRuntime } from './links'
import { ensureGuestTables, GuestStore, type StoredLink } from './store'
import { dayOf, EDITED_TELL, editedKey, OPENED_TELL, openedKey, openOf, seenTells, workspaceOfLink } from './tells'

const ZONE = 'America/Chicago'
/** 9:00 PM Central on Nov 24, 2026, and the same evening an hour and a day later. */
const T = Date.UTC(2026, 10, 25, 3, 0)
const HOUR = 3_600_000

function rig() {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
  db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, path TEXT, kind TEXT, sector TEXT)')
  db.prepare("INSERT INTO workspaces VALUES ('ws-purdue', 'Purdue', '/work/purdue', 'work', 'purdue'), ('ws-code', 'Code', '/code', 'code', NULL)").run()
  ensureGuestTables(db)
  const store = new GuestStore(db)
  const seen: Record<string, LinkSeen> = {}
  const told: Tell[] = []
  const tell = Object.assign((t: Tell) => void told.push(t), { done: () => {} })
  const ctx = {
    db,
    host: 'env_box',
    log: () => {},
    push: () => {},
    tell,
    clock: { lifeos: () => ZONE, desktop: () => null, host: ZONE, onChange: () => () => {} },
    service: { url: (r: string) => `http://127.0.0.1:1${r}`, token: async () => 'ok', internal: async (route: string) => (route === '/internal/guests/seen' ? { seen } : {}) },
    lifeos: { owner: () => ({ query: async () => ({ sector: 'purdue', title: 'Run of show' }), mutation: async () => null }) }
  } as unknown as WorkCtx
  const rt = new GuestRuntime(ctx, () => undefined)
  const doc = store.create({ name: 'Dana Lee', source: { at: 'lifeos', table: 'docs', id: 'kdoc1' }, title: 'Spring LAN run of show', role: 'edit', expiresAt: T + 30 * 24 * HOUR, bySession: null }, T - HOUR).link
  const file = store.create({ name: 'Sam Ito', source: { at: 'file', table: 'sheets', id: 'f'.repeat(40), host: 'env_box', path: '/work/purdue/Budget.tcsheet' }, title: 'Budget', role: 'edit', expiresAt: T + 30 * 24 * HOUR, bySession: null }, T - HOUR).link
  return { db, store, seen, told, rt, ctx, doc, file }
}

describe('what he is told of a guest link', () => {
  it('lists its two kinds under People, where the digest shows them', () => {
    expect(guests.tells).toEqual([OPENED_TELL, EDITED_TELL])
    expect([OPENED_TELL.group, EDITED_TELL.group]).toEqual(['people', 'people'])
  })

  it('the first open of a link, once: by the name he gave it and the title it was made with', async () => {
    const r = rig()
    await r.rt.tellSeen()
    expect(r.told).toEqual([])
    r.seen[r.doc.id] = { at: T, open: 1 }
    await r.rt.tellSeen()
    expect(r.told).toEqual([{ kind: 'guests.opened', workspaceId: 'ws-purdue', title: 'Dana Lee opened Spring LAN run of show', key: openedKey(r.doc.id), open: { view: 'docs', workspaceId: 'ws-purdue', at: 'lifeos:docs:kdoc1' } }])
    expect(r.store.get(r.doc.id)!.firstOpenedAt).toBe(T)
    // Opened again, and after a restart of the service or of main: he is not told twice.
    r.seen[r.doc.id] = { at: T + HOUR, open: 0 }
    await r.rt.tellSeen()
    await new GuestRuntime(r.ctx, () => undefined).tellSeen()
    expect(r.told).toHaveLength(1)
  })

  it("a guest's edits, once a day a link: more the same evening tell nothing new, the next day's do", async () => {
    const r = rig()
    r.store.setSeen(r.file.id, { firstOpenedAt: T - HOUR })
    r.seen[r.file.id] = { at: T, open: 1, wrote: T }
    await r.rt.tellSeen()
    expect(r.told).toEqual([{ kind: 'guests.edited', workspaceId: 'ws-purdue', title: 'Sam Ito edited Budget', key: editedKey(r.file.id, '2026-11-24'), open: { view: 'files', workspaceId: 'ws-purdue' } }])
    r.seen[r.file.id] = { at: T, open: 1, wrote: T + HOUR }
    await r.rt.tellSeen()
    expect(r.told).toHaveLength(1)
    expect(r.store.get(r.file.id)!.lastWroteAt).toBe(T + HOUR)
    // Past midnight his time: a new day, a new row.
    r.seen[r.file.id] = { at: T, open: 1, wrote: T + 4 * HOUR }
    await r.rt.tellSeen()
    expect(r.told.map((t) => t.key)).toEqual([editedKey(r.file.id, '2026-11-24'), editedKey(r.file.id, '2026-11-25')])
    // The same moment read again tells nothing.
    await r.rt.tellSeen()
    expect(r.told).toHaveLength(2)
  })

  it('a title never holds what a guest typed: only the link name and the title he made it with', () => {
    const r = rig()
    const due = seenTells(r.store.live(), { [r.doc.id]: { at: T, open: 1, wrote: T } }, ZONE)
    expect(due.opened.map((o) => o.link.id)).toEqual([r.doc.id])
    expect(due.wrote).toEqual([{ link: expect.objectContaining({ id: r.doc.id }), at: T, day: '2026-11-24', tell: true }])
    expect(dayOf(T, 'UTC')).toBe('2026-11-25')
  })

  it("names the job a link's item is in: a file's by its folder, a LifeOS row's by its sector; with no job, the press goes to the list of links", async () => {
    const r = rig()
    expect(await workspaceOfLink(r.ctx, r.file, async () => null)).toBe('ws-purdue')
    expect(await workspaceOfLink(r.ctx, r.doc, async () => 'purdue')).toBe('ws-purdue')
    expect(await workspaceOfLink(r.ctx, r.doc, async () => 'hypixel')).toBeNull()
    expect(await workspaceOfLink(r.ctx, r.doc, async () => Promise.reject(new Error('LifeOS is away')))).toBeNull()
    const outside = { ...r.file, source: { ...r.file.source, path: '/elsewhere/Budget.tcsheet' } } as StoredLink
    expect(await workspaceOfLink(r.ctx, outside, async () => null)).toBeNull()
    expect(openOf(r.doc, null)).toEqual({ settings: 'work' })
    expect(openOf({ ...r.doc, source: { at: 'lifeos', table: 'sheets', id: 'ks1' } } as StoredLink, 'ws-purdue')).toEqual({ view: 'docs', workspaceId: 'ws-purdue', at: 'lifeos:sheets:ks1' })
  })
})
