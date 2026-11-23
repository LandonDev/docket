import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { requiredCapability } from '@shared/capabilities'
import type { ClientRequest } from '@shared/contract'
import { ClientRequestSchema } from '@shared/contract'
import { DIGEST_CAPS, DigestRequestSchemas, type DigestList, type DigestPush, type DigestSettings } from '@shared/contract-work-digest'
import type { DigestDay } from '@shared/contract-work-digest'
import type { TellKind } from '@shared/work/tell'
import type { WorkPartDeps } from '../ctx'
import type { WorkCtx } from '../modules'
import { digest as digestModule } from '.'
import { Digest, digestOf, tellPart, type Deliverer } from './ctx'
import { DIGEST_TELLS } from './rule'
import type { LedgerRow } from './store'

/**
 * The ledger and the day's digest against a clock the test moves: what
 * waits, what interrupts, what a replaced key does, and a day made once.
 */

const NY = 'America/New_York'
const at = (day: number, hhmm: string): number => Date.parse(`2026-11-${String(day).padStart(2, '0')}T${hhmm}:00-05:00`)
const HOUR = 3_600_000

const KINDS: TellKind[] = [
  { kind: 'outbox.held', group: 'held', name: 'A held item' },
  { kind: 'clashes.new', group: 'clashes', name: 'A clash' },
  { kind: 'review.ready', group: 'review', name: 'The weekly review' }
]

interface Rig {
  db: DatabaseSync
  clock: { now: number }
  on: { value: boolean }
  digest: Digest
  pushes: DigestPush[]
  logs: string[]
  sent: { now: LedgerRow[][]; gone: LedgerRow[]; digest: { day: DigestDay; rows: LedgerRow[] }[] }
  deliverer: Deliverer
}

function makeRig(): Rig {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, kind TEXT, sector TEXT)')
  for (const [id, name, sector] of [['ws-cosmic', 'Cosmic', 'cosmic'], ['ws-purdue', 'Purdue', 'purdue']]) db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?)').run(id!, name!, 'work', sector!)
  digestModule.ensure(db)
  const clock = { now: at(23, '10:00') }
  const on = { value: true }
  const pushes: DigestPush[] = []
  const logs: string[] = []
  const sent: Rig['sent'] = { now: [], gone: [], digest: [] }
  const digest = new Digest({ db, host: 'env_box', enabled: () => on.value, log: (l) => logs.push(l), push: (p) => pushes.push(p), modules: () => [{ tells: KINDS }, { tells: DIGEST_TELLS }], now: () => clock.now })
  digest.here(NY)
  pushes.length = 0
  const deliverer: Deliverer = {
    now: (_row, open) => (sent.now.push(open), true),
    gone: (row) => void sent.gone.push(row),
    digest: (day, rows) => void sent.digest.push({ day, rows })
  }
  return { db, clock, on, digest, pushes, logs, sent, deliverer }
}

let rig: Rig
beforeEach(() => {
  rig = makeRig()
})

const held = (over: Record<string, unknown> = {}) => rig.digest.tell({ kind: 'outbox.held', workspaceId: 'ws-cosmic', title: 'Send to Dana Reyes: Re: budget', ...over })

describe('a tell', () => {
  it('with no clock waits for the digest: kept, pushed, nobody told', () => {
    rig.digest.deliverer = rig.deliverer
    const row = held()!
    expect(row).toMatchObject({ host: 'env_box', group: 'held', sector: 'cosmic', how: 'waiting', day: null, toldAt: null, at: rig.clock.now })
    expect(rig.sent.now).toEqual([])
    expect(rig.pushes).toEqual([{ push: 'work.digest', row: expect.objectContaining({ id: row.id }) }])
    expect(rig.pushes[0]!.row).not.toHaveProperty('due')
    expect(rig.digest.list().waiting).toBe(1)
  })
  it('with a clock before the next digest interrupts at once', () => {
    rig.digest.deliverer = rig.deliverer
    const row = held({ by: at(23, '14:00'), key: 'held:1' })!
    expect(row).toMatchObject({ how: 'now', toldAt: rig.clock.now, due: false })
    expect(rig.sent.now).toHaveLength(1)
    expect(rig.digest.list().waiting).toBe(0)
  })
  it('with a clock the next digest still beats waits like the rest', () => {
    rig.digest.deliverer = rig.deliverer
    expect(held({ by: at(26, '14:00') })!.how).toBe('waiting')
    // inside the two hours after the next digest: it cannot first be heard of then
    expect(held({ by: at(24, '09:30') })!.how).toBe('now')
  })
  it('the caller never picks a volume: his level for the group decides', () => {
    rig.digest.deliverer = rig.deliverer
    rig.digest.set({ levels: { held: 'digest', review: 'now' } })
    expect(held({ by: at(23, '14:00') })!.how).toBe('waiting')
    expect(rig.digest.tell({ kind: 'review.ready', workspaceId: null, title: "This week's review is ready" })!.how).toBe('now')
    rig.digest.set({ levels: { held: 'clock' } })
    expect(rig.digest.settings().levels).toEqual({ review: 'now' })
  })
  it('is cut to one line, keeps a target the contract knows and drops one it does not', () => {
    const row = rig.digest.tell({ kind: 'clashes.new', workspaceId: 'ws-purdue', title: `  Budget review\n overlaps   Thumbnail review ${'x'.repeat(400)}`, detail: ' 2:00 PM ', open: { view: 'agenda', workspaceId: 'ws-purdue', at: 'ev1' } })!
    expect(row.title.length).toBe(200)
    expect(row.title.startsWith('Budget review overlaps Thumbnail review')).toBe(true)
    expect(row.detail).toBe('2:00 PM')
    expect(row.open).toEqual({ view: 'agenda', workspaceId: 'ws-purdue', at: 'ev1' })
    expect(rig.digest.tell({ kind: 'clashes.new', workspaceId: null, title: 'A clash', open: { nowhere: true } as never })!.open).toBeUndefined()
  })
  it('of a kind no module lists is kept under system and said once', () => {
    expect(rig.digest.tell({ kind: 'nobody.listed', workspaceId: null, title: 'Something happened' })!.group).toBe('system')
    rig.digest.tell({ kind: 'nobody.listed', workspaceId: null, title: 'Something else happened' })
    expect(rig.logs.filter((l) => l.includes('nobody.listed'))).toHaveLength(1)
  })
  it('with no title or no kind is dropped', () => {
    expect(rig.digest.tell({ kind: 'outbox.held', workspaceId: null, title: '  ' })).toBeNull()
    expect(rig.digest.tell({ kind: '', workspaceId: null, title: 'x' })).toBeNull()
    expect(rig.digest.list().rows).toEqual([])
  })
  it('does nothing while Work is off', () => {
    rig.on.value = false
    expect(held()).toBeNull()
    rig.digest.tick(at(24, '08:00'))
    expect(rig.digest.list().rows).toEqual([])
    expect(rig.pushes).toEqual([])
  })
})

describe('a tell nobody can deliver yet', () => {
  it('is kept as due, and the first look with a deliverer sends it', () => {
    const row = held({ by: at(23, '14:00'), key: 'held:1' })!
    expect(row).toMatchObject({ how: 'waiting', due: true, toldAt: null })
    rig.digest.tick()
    expect(rig.digest.store.byKey('held:1')?.due).toBe(true)
    rig.digest.deliverer = rig.deliverer
    rig.clock.now += 60_000
    rig.digest.tick()
    expect(rig.sent.now).toHaveLength(1)
    expect(rig.digest.store.byKey('held:1')).toMatchObject({ how: 'now', due: false, toldAt: rig.clock.now })
  })
  it('is not sent late once its clock passed by more than a day: it waits for the digest', () => {
    held({ by: at(23, '11:00'), key: 'held:1' })
    rig.digest.deliverer = rig.deliverer
    rig.clock.now = at(24, '12:00')
    rig.digest.tick()
    expect(rig.sent.now).toEqual([])
    expect(rig.digest.store.byKey('held:1')).toMatchObject({ how: 'waiting', due: false })
  })
  it('a deliverer that throws or takes nothing leaves it due', () => {
    rig.digest.deliverer = { ...rig.deliverer, now: () => { throw new Error('no route') } }
    expect(held({ by: at(23, '14:00'), key: 'a' })!.due).toBe(true)
    rig.digest.deliverer = { ...rig.deliverer, now: () => false }
    expect(held({ by: at(23, '14:00'), key: 'b' })!.due).toBe(true)
    expect(rig.logs.some((l) => l.includes('no route'))).toBe(true)
  })
})

describe('the same key', () => {
  beforeEach(() => {
    rig.digest.deliverer = rig.deliverer
  })
  it('replaces the same row, and saying the same thing again changes nothing', () => {
    const a = held({ key: 'held:1' })!
    rig.pushes.length = 0
    rig.clock.now += 5_000
    expect(held({ key: 'held:1' })!.at).toBe(a.at)
    expect(rig.pushes).toEqual([])
    const b = held({ key: 'held:1', title: 'Send to Dana Reyes: Re: budget, v2' })!
    expect(b.id).toBe(a.id)
    expect(rig.digest.list().rows).toHaveLength(1)
    expect(b.at).toBe(rig.clock.now)
  })
  it('in a digest already and changed is news again for the next one; unchanged it stays where it is', () => {
    held({ key: 'mail:waiting', title: '3 sent mails have no answer' })
    rig.digest.tick(at(23, '10:01'))
    rig.clock.now = at(24, '08:00')
    rig.digest.tick()
    expect(rig.digest.store.byKey('mail:waiting')).toMatchObject({ how: 'digest', day: '2026-11-24' })
    held({ key: 'mail:waiting', title: '3 sent mails have no answer' })
    expect(rig.digest.store.byKey('mail:waiting')?.day).toBe('2026-11-24')
    held({ key: 'mail:waiting', title: '4 sent mails have no answer' })
    expect(rig.digest.store.byKey('mail:waiting')).toMatchObject({ how: 'waiting', day: null })
  })
  it('told at once already is not told again, unless its clock moved earlier', () => {
    held({ key: 'clash:1', by: at(23, '15:00') })
    expect(rig.sent.now).toHaveLength(1)
    const told = rig.digest.store.byKey('clash:1')!.toldAt
    rig.clock.now += 60_000
    held({ key: 'clash:1', by: at(23, '15:00'), title: 'New words' })
    held({ key: 'clash:1', by: at(23, '16:00'), title: 'Later now' })
    expect(rig.sent.now).toHaveLength(1)
    expect(rig.digest.store.byKey('clash:1')).toMatchObject({ title: 'Later now', toldAt: told, how: 'now' })
    held({ key: 'clash:1', by: at(23, '13:00'), title: 'Earlier now' })
    expect(rig.sent.now).toHaveLength(2)
    expect(rig.digest.store.byKey('clash:1')?.toldAt).toBe(rig.clock.now)
  })
  it('done: the row goes, every window hears, and a notice he had is withdrawn', () => {
    const waited = held({ key: 'held:1' })!
    const toldNow = held({ key: 'held:2', by: at(23, '14:00') })!
    rig.pushes.length = 0
    rig.digest.done('held:1')
    rig.digest.done('held:2')
    rig.digest.done('held:none')
    expect(rig.pushes).toEqual([{ push: 'work.digest', gone: waited.id }, { push: 'work.digest', gone: toldNow.id }])
    expect(rig.sent.gone.map((r) => r.id)).toEqual([toldNow.id])
    expect(rig.digest.list().rows).toEqual([])
  })
})

describe('the day', () => {
  beforeEach(() => {
    rig.digest.deliverer = rig.deliverer
    // the first look ever: nothing was missed
    rig.digest.tick()
  })
  it('is made at his time from what waited, across jobs, and told once', () => {
    held()
    rig.digest.tell({ kind: 'review.ready', workspaceId: 'ws-purdue', title: "This week's review is ready" })
    held({ by: at(23, '14:00'), key: 'now:1' })
    rig.pushes.length = 0
    rig.clock.now = at(24, '07:59')
    rig.digest.tick()
    expect(rig.sent.digest).toEqual([])
    rig.clock.now = at(24, '08:00')
    rig.digest.tick()
    expect(rig.sent.digest).toHaveLength(1)
    expect(rig.sent.digest[0]!.day).toEqual({ day: '2026-11-24', madeAt: rig.clock.now, seenAt: null, count: 2 })
    expect(rig.sent.digest[0]!.rows.map((r) => r.sector).sort()).toEqual(['cosmic', 'purdue'])
    expect(rig.pushes).toContainEqual({ push: 'work.digest', day: { day: '2026-11-24', madeAt: rig.clock.now, seenAt: null, count: 2 } })
    // the one he was told of at once is in the day's list and not in its count
    expect(rig.digest.list({ day: '2026-11-24' }).rows).toHaveLength(3)
    expect(rig.digest.list().waiting).toBe(0)
    rig.clock.now += 30_000
    rig.digest.tick()
    expect(rig.sent.digest).toHaveLength(1)
  })
  it('an empty day sends nothing and leaves no day', () => {
    rig.clock.now = at(24, '08:00')
    rig.digest.tick()
    expect(rig.sent.digest).toEqual([])
    expect(rig.digest.list().days).toEqual([])
    // what arrives after today's time waits for tomorrow's
    held()
    rig.clock.now = at(24, '09:00')
    rig.digest.tick()
    expect(rig.sent.digest).toEqual([])
    rig.clock.now = at(25, '08:00')
    rig.digest.tick()
    expect(rig.sent.digest[0]!.day.day).toBe('2026-11-25')
  })
  it('a time missed while the host was down is made once at start, late, never twice', () => {
    held()
    // the host was down from the 23rd to the afternoon of the 25th: two times missed, one digest
    rig.clock.now = at(25, '15:00')
    const stop = rig.digest.start({ interval: false })
    stop()
    expect(rig.sent.digest).toHaveLength(1)
    expect(rig.sent.digest[0]!.day).toMatchObject({ day: '2026-11-25', madeAt: rig.clock.now, count: 1 })
    held()
    rig.digest.start({ interval: false })()
    expect(rig.sent.digest).toHaveLength(1)
  })
  it("follows the zone of the desktop he last used, not the host's", () => {
    held()
    rig.digest.here('America/Chicago')
    // 8:00 in New York is 7:00 in Chicago: not yet
    rig.clock.now = at(24, '08:00')
    rig.digest.tick()
    expect(rig.sent.digest).toEqual([])
    rig.clock.now = at(24, '09:00')
    rig.digest.tick()
    expect(rig.sent.digest).toHaveLength(1)
    expect(() => rig.digest.here('Mars/Olympus')).toThrow('unknown time zone')
  })
  it('a row in a digest still interrupts when its clock comes inside the window', () => {
    // An invite held on Monday the 23rd for an event on Thursday the 26th at 2:00 PM.
    held({ key: 'held:invite', by: at(26, '14:00') })
    rig.clock.now = at(24, '08:00')
    rig.digest.tick()
    expect(rig.digest.store.byKey('held:invite')).toMatchObject({ how: 'digest', day: '2026-11-24' })
    rig.clock.now = at(25, '09:00')
    rig.digest.tick()
    expect(rig.sent.now).toEqual([])
    // After Thursday's 8:00 the next digest is Friday's: its 2:00 PM clock cannot wait for that.
    rig.clock.now = at(26, '08:00') + 30_000
    rig.digest.tick()
    expect(rig.sent.now).toHaveLength(1)
    expect(rig.digest.store.byKey('held:invite')).toMatchObject({ how: 'now', day: '2026-11-24', toldAt: rig.clock.now })
    rig.clock.now += 30_000
    rig.digest.tick()
    expect(rig.sent.now).toHaveLength(1)
  })
  it('is seen once, and every window hears', () => {
    held()
    rig.clock.now = at(24, '08:00')
    rig.digest.tick()
    rig.pushes.length = 0
    rig.clock.now += HOUR
    rig.digest.seen('2026-11-24')
    rig.digest.seen('2026-11-24')
    rig.digest.seen('2026-11-01')
    expect(rig.pushes).toEqual([{ push: 'work.digest', day: { day: '2026-11-24', madeAt: at(24, '08:00'), seenAt: rig.clock.now, count: 1 } }])
  })
})

describe('what he sets', () => {
  it('starts at 8:00 with every group at its clock, and says when the next digest is', () => {
    expect(rig.digest.settings()).toEqual({ at: '08:00', zone: NY, levels: {}, nextAt: at(24, '08:00') })
  })
  it('a new time moves the next digest and tells every window', () => {
    const next = rig.digest.set({ at: '17:30' })
    expect(next).toMatchObject({ at: '17:30', nextAt: at(23, '17:30') })
    expect(rig.pushes).toEqual([{ push: 'work.digest', settings: next }])
  })
  it('a time moved into the past is not made late: the change misses nothing', () => {
    rig.digest.deliverer = rig.deliverer
    rig.digest.tick()
    held()
    // 10:00 now; a digest at 9:30 would have been half an hour ago
    rig.digest.set({ at: '09:30' })
    rig.clock.now += 60_000
    rig.digest.tick()
    expect(rig.sent.digest).toEqual([])
    rig.clock.now = at(24, '09:30')
    rig.digest.tick()
    expect(rig.sent.digest).toHaveLength(1)
  })
})

describe('the wire', () => {
  const ctx = (): WorkCtx => {
    const c = { db: rig.db, host: 'env_box', enabled: () => rig.on.value, log: (l: string) => void rig.logs.push(l), push: (p: DigestPush) => void rig.pushes.push(p) } as unknown as WorkCtx
    Object.assign(c, tellPart(c, { db: rig.db, environmentId: 'env_box' } as unknown as WorkPartDeps))
    return c
  }
  const call = async <T>(c: WorkCtx, method: string, params: unknown): Promise<T> => {
    const req = ClientRequestSchema.parse({ id: '1', method, params }) as ClientRequest
    const answer = await digestModule.handle!(req, c, { kind: 'local', caps: [] })
    if (!answer.handled) throw new Error('not handled')
    return answer.result as T
  }
  it('reads with read, marks seen and says the zone with operate, and sets with admin', () => {
    expect(DigestRequestSchemas.map((s) => s.shape.method.value)).toEqual(['work.digest.list', 'work.digest.get', 'work.digest.set', 'work.digest.here', 'work.digest.seen'])
    expect(DIGEST_CAPS).toEqual({ 'work.digest.list': 'read', 'work.digest.get': 'read', 'work.digest.set': 'admin', 'work.digest.here': 'operate', 'work.digest.seen': 'operate' })
    expect(requiredCapability({ method: 'work.digest.set' })).toBe('admin')
    expect(ClientRequestSchema.safeParse({ id: '1', method: 'work.digest.set', params: { at: '25:00' } }).success).toBe(false)
    expect(ClientRequestSchema.safeParse({ id: '1', method: 'work.digest.set', params: { levels: { held: 'loud' } } }).success).toBe(false)
    expect(ClientRequestSchema.safeParse({ id: '1', method: 'work.digest.set', params: { levels: { nobody: 'now' } } }).success).toBe(false)
  })
  it('answers the list, the settings and a tell through ctx.tell', async () => {
    const c = ctx()
    c.tell({ kind: 'outbox.held', workspaceId: 'ws-cosmic', title: 'Send to Dana Reyes: Re: budget', key: 'held:1' })
    c.tell.quiet('thread-1')
    expect(digestOf(c)!.store.isQuiet('thread-1')).toBe(true)
    const list = await call<DigestList>(c, 'work.digest.list', {})
    expect(list).toMatchObject({ days: [], waiting: 1, rows: [{ title: 'Send to Dana Reyes: Re: budget', how: 'waiting' }] })
    // the registry is empty in this test: the digest's own kinds are listed by its module alone
    expect(Array.isArray(list.groups)).toBe(true)
    await call(c, 'work.digest.here', { zone: NY })
    const set = await call<DigestSettings>(c, 'work.digest.set', { at: '07:15', levels: { results: 'digest' } })
    expect(set).toMatchObject({ at: '07:15', zone: NY, levels: { results: 'digest' } })
    expect(await call<DigestSettings>(c, 'work.digest.get', {})).toEqual(set)
    expect(await call(c, 'work.digest.seen', { day: '2026-11-24' })).toBeNull()
    c.tell.done('held:1')
    expect((await call<DigestList>(c, 'work.digest.list', {})).rows).toEqual([])
    digestModule.sessionsRemoved!(['thread-1'], c)
    expect(digestOf(c)!.store.isQuiet('thread-1')).toBe(false)
    c.tell({ kind: 'outbox.held', workspaceId: 'ws-cosmic', title: 'Another' })
    digestModule.workspaceRemoved!('ws-cosmic', c)
    expect((await call<DigestList>(c, 'work.digest.list', {})).rows).toEqual([])
  })
  it('the module makes its tables, starts only its own look, and lists its kinds', () => {
    expect(digestModule.id).toBe('digest')
    expect(digestModule.tells).toBe(DIGEST_TELLS)
    const c = ctx()
    const stop = digestModule.start!(c)
    expect(typeof stop).toBe('function')
    stop()
  })
})

describe('ctx.tell is total', () => {
  it('never throws, whatever the store does, and says the fault once', () => {
    const logs: string[] = []
    const broken = { prepare: () => { throw new Error('the table is gone') }, exec: () => { throw new Error('the table is gone') } }
    const c = { db: broken, host: 'env_box', enabled: () => true, log: (l: string) => void logs.push(l), push: () => {} } as unknown as WorkCtx
    const { tell } = tellPart(c, { db: broken, environmentId: 'env_box' } as unknown as WorkPartDeps)
    expect(() => tell({ kind: 'outbox.held', workspaceId: 'w', title: 'Held', key: 'k' })).not.toThrow()
    expect(() => tell.done('k')).not.toThrow()
    expect(() => tell.quiet('s')).not.toThrow()
    expect(() => tell(null as never)).not.toThrow()
    expect(logs.filter((l) => l.startsWith('digest:')).length).toBeGreaterThan(0)
    expect(logs.filter((l) => l.includes('the table is gone'))).toHaveLength(1)
  })
  it('never throws when the part cannot even be made: its members are plain functions, never the failing proxy', () => {
    const c = { get db(): never { throw new Error('no database') }, host: 'env_box', enabled: () => true, log: () => { throw new Error('no log either') }, push: () => {} } as unknown as WorkCtx
    const deps = { get db(): never { throw new Error('no database') }, environmentId: 'env_box' } as unknown as WorkPartDeps
    const { tell } = tellPart(c, deps)
    expect(() => tell({ kind: 'x.y', workspaceId: null, title: 'T' })).not.toThrow()
    expect(() => tell.done('k')).not.toThrow()
    expect(() => tell.quiet('s')).not.toThrow()
    expect(digestOf(c)).toBeUndefined()
  })
})
