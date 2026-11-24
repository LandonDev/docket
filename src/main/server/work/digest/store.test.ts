import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeDay } from './make'
import { DigestStore, ensureDigestTables, KEEP_DAYS, type LedgerRow } from './store'

/** The ledger's rows: one row a key, the three states, the day's guard and the 30 days. */

const DAY = 24 * 3_600_000
let db: DatabaseSync
let store: DigestStore
let n = 0
const row = (over: Partial<LedgerRow> = {}): LedgerRow => ({
  id: `t${++n}`,
  host: 'env_box',
  kind: 'outbox.held',
  group: 'held',
  workspaceId: 'ws-cosmic',
  sector: 'cosmic',
  title: 'Send to Dana Reyes: Re: budget',
  at: 1_000,
  how: 'waiting',
  day: null,
  toldAt: null,
  due: false,
  ...over
})

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  ensureDigestTables(db)
  ensureDigestTables(db)
  store = new DigestStore(db, 'env_box')
  n = 0
})

describe('a row', () => {
  it('reads back as it was written, with how it stands derived from its day and when he was told', () => {
    const full = row({ key: 'held:1', detail: 'From the budget thread', open: { held: { at: 'host', id: 'h1' } }, by: 5_000 })
    store.put(full)
    expect(store.byKey('held:1')).toEqual(full)
    store.put({ ...full, day: '2026-11-23' })
    expect(store.byId(full.id)?.how).toBe('digest')
    store.put({ ...full, day: '2026-11-23', toldAt: 2_000 })
    expect(store.byId(full.id)?.how).toBe('now')
  })
  it('is one row a key: a second id under the same key is refused, and a row with no key is its own', () => {
    store.put(row({ key: 'clash:1' }))
    expect(() => store.put(row({ key: 'clash:1' }))).toThrow()
    store.put(row())
    store.put(row())
    expect(store.rows()).toHaveLength(3)
  })
  it('drops an open target the contract does not know rather than failing the list', () => {
    store.put(row({ key: 'k' }))
    db.prepare("UPDATE work_digest_tells SET open = '{\"nowhere\":1}' WHERE key = 'k'").run()
    expect(store.byKey('k')?.open).toBeUndefined()
  })
  it('goes when it is done, and with its workspace', () => {
    const a = row({ key: 'a' })
    store.put(a)
    store.put(row({ workspaceId: 'ws-ref' }))
    store.remove(a.id)
    expect(store.byKey('a')).toBeNull()
    expect(store.removeWorkspace('ws-ref')).toHaveLength(1)
    expect(store.rows()).toEqual([])
  })
})

describe('what waits, what is due and what has a clock', () => {
  it('counts the rows no digest holds and he was never told of', () => {
    store.put(row())
    store.put(row({ day: '2026-11-22' }))
    store.put(row({ toldAt: 500 }))
    store.put(row({ due: true }))
    expect(store.waitingCount()).toBe(2)
    expect(store.due().map((r) => r.id)).toEqual(['t4'])
    expect(store.unstamped().map((r) => r.id)).toEqual(['t1', 't3'])
  })
  it('finds a clock still ahead whatever digest the row is in, and never one he was told of', () => {
    store.put(row({ by: 9_000, day: '2026-11-22' }))
    store.put(row({ by: 9_000, toldAt: 100 }))
    store.put(row({ by: 500 }))
    store.put(row())
    expect(store.clocked(1_000).map((r) => r.id)).toEqual(['t1'])
  })
  it('lists the interrupts still open: told, and the clock not passed', () => {
    store.put(row({ toldAt: 900, by: 5_000 }))
    store.put(row({ toldAt: 900, by: 950 }))
    store.put(row({ toldAt: 900 }))
    store.put(row())
    // a clock already past when it was told (a send that failed) stays open: it is what he must still hear of
    store.put(row({ toldAt: 900, by: 900 }))
    expect(store.openNow(1_000).map((r) => r.id)).toEqual(['t1', 't3', 't5'])
    // one told more than a day ago with no clock is no longer open
    expect(store.openNow(900 + DAY + 1)).toEqual([])
  })
})

describe('a day', () => {
  it('is made of every row no digest holds, counted by those that waited, and never twice', () => {
    store.put(row({ at: 10 }))
    store.put(row({ at: 20, workspaceId: 'ws-purdue', sector: 'purdue' }))
    store.put(row({ at: 30, toldAt: 30 }))
    store.put(row({ at: 40, due: true }))
    const made = makeDay(store, '2026-11-23', 5_000)
    expect(made?.day).toEqual({ day: '2026-11-23', madeAt: 5_000, seenAt: null, count: 2 })
    expect(made?.rows.map((r) => r.id)).toEqual(['t1', 't2'])
    // the row he was told of at once is in the day's list; the due one still waits for its notice
    expect(store.rows({ day: '2026-11-23' }).map((r) => r.id).sort()).toEqual(['t1', 't2', 't3'])
    expect(store.byId('t4')?.day).toBeNull()
    store.put(row({ at: 50 }))
    expect(makeDay(store, '2026-11-23', 6_000)).toBeNull()
    expect(store.byId('t5')?.day).toBeNull()
    expect(store.days()).toHaveLength(1)
  })
  it('is not made of nothing: an empty day leaves no row', () => {
    store.put(row({ toldAt: 30 }))
    expect(makeDay(store, '2026-11-23', 5_000)).toBeNull()
    expect(store.days()).toEqual([])
    expect(store.byId('t1')?.day).toBeNull()
  })
  it('is seen once', () => {
    store.addDay({ day: '2026-11-23', madeAt: 1, seenAt: null, count: 3 })
    expect(store.seen('2026-11-23', 10)?.seenAt).toBe(10)
    expect(store.seen('2026-11-23', 20)?.seenAt).toBe(10)
    expect(store.seen('2026-11-01', 20)).toBeNull()
  })
})

describe('the 30 days', () => {
  it('prunes what is older, keeping a row whose clock is still ahead, and names what it dropped', () => {
    const now = 100 * DAY
    store.put(row({ at: now - (KEEP_DAYS + 1) * DAY, day: '2026-01-01' }))
    store.put(row({ at: now - (KEEP_DAYS + 1) * DAY, by: now + DAY, day: '2026-01-01' }))
    store.put(row({ at: now - DAY }))
    store.addDay({ day: '2026-01-01', madeAt: now - (KEEP_DAYS + 1) * DAY, seenAt: null, count: 2 })
    expect(store.prune(now)).toEqual(['t1'])
    expect(store.rows().map((r) => r.id).sort()).toEqual(['t2', 't3'])
    expect(store.days()).toEqual([])
  })
})

describe('settings and quiet threads', () => {
  it('keeps a setting by key and a thread that started on its own until it is deleted', () => {
    expect(store.setting('at')).toBeNull()
    store.setSetting('at', '07:30')
    store.setSetting('at', '09:00')
    expect(store.setting('at')).toBe('09:00')
    store.quiet('s1', 1)
    store.quiet('s1', 2)
    expect(store.isQuiet('s1')).toBe(true)
    store.unquiet(['s1', 's2'])
    expect(store.isQuiet('s1')).toBe(false)
  })
})
