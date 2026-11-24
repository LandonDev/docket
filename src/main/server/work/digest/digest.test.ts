import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { requiredCapability } from '@shared/capabilities'
import type { ClientRequest } from '@shared/contract'
import { ClientRequestSchema } from '@shared/contract'
import { DIGEST_CAPS, DigestRequestSchemas, type DigestList, type DigestPush, type DigestSettings } from '@shared/contract-work-digest'
import type { DigestDay } from '@shared/contract-work-digest'
import type { NoticeWork, Tell, TellKind } from '@shared/work/tell'
import type { WorkPartDeps } from '../ctx'
import type { WorkCtx } from '../modules'
import { digest as digestModule } from '.'
import { Digest, digestOf, LIST_WAIT_MS, peerDays, pushNeed, tellPart, type Deliverer } from './ctx'
import { makeDeliverer, ofDay, PEER_WAIT_MS } from './deliver'
import { tellFailed, type TellsDeps } from '../outbox/tells'
import type { OutboxItem } from '@shared/contract-work-outbox'
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

describe('an interrupt owed and not yet sent', () => {
  it('follows the level he set since: a group set to wait sends nothing when the notifier comes', () => {
    held({ by: at(23, '14:00'), key: 'held:1' })
    rig.digest.set({ levels: { held: 'digest' } })
    rig.digest.deliverer = rig.deliverer
    rig.digest.tick()
    expect(rig.sent.now).toEqual([])
    expect(rig.digest.store.byKey('held:1')).toMatchObject({ how: 'waiting', due: false, toldAt: null })
  })
})

describe('a clock slept through', () => {
  beforeEach(() => {
    rig.digest.deliverer = rig.deliverer
    rig.digest.tick()
  })
  it('is told when the host wakes, within a day of it; past that it waits for the digest', () => {
    // A noon invite on the 24th waits for the 8:00 digest; the host sleeps through 8:00 and noon.
    held({ key: 'held:noon', by: at(24, '12:00') })
    expect(rig.sent.now).toEqual([])
    rig.clock.now = at(24, '12:05')
    rig.digest.tick()
    expect(rig.digest.store.byKey('held:noon')).toMatchObject({ how: 'now', toldAt: rig.clock.now })
    // one whose clock passed more than a day before the host woke is not rung
    held({ key: 'held:long', by: at(25, '12:00') })
    rig.clock.now = at(26, '12:30')
    rig.digest.tick()
    expect(rig.digest.store.byKey('held:long')?.toldAt).toBeNull()
    expect(rig.sent.now).toHaveLength(1)
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
  it('filed under a job it had no workspace for before: the row follows, and it is not news again', () => {
    const first = rig.digest.tell({ kind: 'outbox.held', workspaceId: null, title: 'Not sent: Re: budget', key: 'unsent:x', by: at(23, '09:00') })!
    expect(first).toMatchObject({ how: 'now', sector: null })
    rig.pushes.length = 0
    rig.clock.now += HOUR
    const moved = rig.digest.tell({ kind: 'outbox.held', workspaceId: 'ws-cosmic', title: 'Not sent: Re: budget', key: 'unsent:x', by: at(23, '09:00') })!
    expect(moved).toMatchObject({ id: first.id, workspaceId: 'ws-cosmic', sector: 'cosmic', at: first.at, toldAt: first.toldAt, how: 'now' })
    expect(rig.sent.now).toHaveLength(1)
    expect(rig.digest.store.byKey('unsent:x')?.sector).toBe('cosmic')
    expect(rig.pushes).toEqual([{ push: 'work.digest', row: expect.objectContaining({ id: first.id, sector: 'cosmic' }) }])
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

describe('a send that fails again at once', () => {
  it('is one banner on the phone, naming the one item and opening it, not two attempts of it', () => {
    const work: { body: string; work: NoticeWork }[] = []
    rig.digest.deliverer = makeDeliverer({ notifier: () => ({ work: (n: (typeof work)[number]) => void work.push(n), held: () => {} }) as never, sendsDigest: () => true, peers: () => [], log: () => {} })
    const tell = Object.assign((t: Tell) => void rig.digest.tell(t), { done: (k: string) => rig.digest.done(k), only: (p: string, k: readonly string[]) => rig.digest.only(p, k), quiet: () => {} })
    const deps: TellsDeps = { ctx: { tell, log: () => {} } as never, kindOf: () => undefined, workspaces: () => [{ id: 'ws-cosmic', kind: 'work', sector: 'cosmic' }], now: () => rig.clock.now }
    const item = { ref: { at: 'host', id: 'h1' }, kind: 'addon.call', workspaceId: 'ws-cosmic', sessionId: null, sector: 'cosmic', summary: 'Send to Dana Reyes: Re: budget', state: 'failed', error: 'The server refused it', decidedAt: rig.clock.now - 60_000, updatedAt: rig.clock.now - 60_000 } as unknown as OutboxItem
    tellFailed(deps, item)
    // he presses Send again and it fails within the Outbox's 250 ms sync
    rig.clock.now += 5_000
    tellFailed(deps, { ...item, decidedAt: rig.clock.now - 1_000, updatedAt: rig.clock.now - 1_000 })
    expect(work).toHaveLength(2)
    expect(work[1]!.body).toBe('Not sent: Send to Dana Reyes: Re: budget\nThe server refused it')
    expect(work[1]!.work).toMatchObject({ open: { held: { at: 'host', id: 'h1' } } })
    expect(rig.digest.list().rows.filter((r) => r.title.startsWith('Not sent'))).toHaveLength(1)
  })
})

describe('a set told by its keys', () => {
  it('only: of the rows under a prefix, those no longer named are done, and no other row is touched', () => {
    rig.digest.deliverer = rig.deliverer
    const a = held({ key: 'held:host:a' })!
    held({ key: 'held:host:b' })
    held({ key: 'held:lifeos:outbox:c' })
    held({ key: 'unsent:host:a' })
    held()
    rig.pushes.length = 0
    rig.digest.only('held:host:', ['held:host:b', 'held:host:never-told'])
    expect(rig.pushes).toEqual([{ push: 'work.digest', gone: a.id }])
    expect(rig.digest.list().rows.map((r) => r.key ?? null).sort()).toEqual([null, 'held:host:b', 'held:lifeos:outbox:c', 'unsent:host:a'].sort())
    // an empty prefix names no set: nothing goes
    rig.digest.only('', [])
    expect(rig.digest.list().rows).toHaveLength(4)
    rig.digest.only('held:', [])
    expect(rig.digest.list().rows.map((r) => r.key ?? null).sort()).toEqual([null, 'unsent:host:a'].sort())
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
  it('an empty day makes no day and sends nothing of its own', () => {
    rig.clock.now = at(24, '08:00')
    rig.digest.tick()
    expect(rig.sent.digest.filter((d) => d.rows.length > 0)).toEqual([])
    expect(rig.digest.list().days).toEqual([])
    rig.sent.digest.length = 0
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
  it('keeps the zone of the window that came to the front last: an older one reconnecting does not take it back', () => {
    const t = rig.clock.now
    rig.digest.here('America/New_York', t + 1_000)
    rig.digest.here('America/Los_Angeles', t + 2_000)
    // the Mac, left in front since t + 1,000, says it again when its link comes back
    rig.digest.here('America/New_York', t + 1_000)
    expect(rig.digest.zone()).toBe('America/Los_Angeles')
    rig.digest.here('America/Chicago', t + 3_000)
    expect(rig.digest.zone()).toBe('America/Chicago')
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
  it('a day this host has nothing for is still handed to the deliverer: the sender adds what its linked hosts hold', () => {
    rig.clock.now = at(24, '08:00')
    rig.digest.tick()
    // no day of its own, no push, but the deliverer is asked with an empty day
    expect(rig.digest.list().days).toEqual([])
    expect(rig.sent.digest).toEqual([{ day: { day: '2026-11-24', madeAt: rig.clock.now, seenAt: null, count: 0 }, rows: [] }])
    rig.clock.now += 30_000
    rig.digest.tick()
    expect(rig.sent.digest).toHaveLength(1)
  })
  it('a stop while the sources are read at digest time loses no day: it is made at the next start', async () => {
    held()
    let release: () => void = () => {}
    rig.digest.beforeDay = () => new Promise<void>((done) => (release = done))
    rig.clock.now = at(24, '08:00')
    rig.digest.tick()
    // a second look while the first make waits starts no second one
    rig.digest.tick()
    expect(rig.sent.digest).toEqual([])
    // the host stops here: a new digest on the same database, as after a restart
    const again = new Digest({ db: rig.db, host: 'env_box', enabled: () => true, log: () => {}, push: () => {}, modules: () => [], now: () => rig.clock.now })
    const sent: unknown[] = []
    again.deliverer = { ...rig.deliverer, digest: (day) => void sent.push(day) }
    rig.clock.now += 60_000
    again.tick()
    expect(sent).toHaveLength(1)
    // the first one, let go at last, finds the day made and makes no second
    release()
    await rig.digest.making
    expect(rig.digest.list().days).toHaveLength(1)
  })
  it("the day's notice is owed until a notifier takes it, and is sent once, at a later look", async () => {
    held()
    const answers = [false, true]
    const offered: string[] = []
    rig.digest.deliverer = { ...rig.deliverer, digest: (day) => (offered.push(day.day), Promise.resolve(answers.shift() ?? true)) }
    rig.clock.now = at(24, '08:00')
    rig.digest.tick()
    await rig.digest.making
    await new Promise((r) => setTimeout(r, 0))
    expect(offered).toEqual(['2026-11-24'])
    rig.clock.now += 30_000
    rig.digest.tick()
    await new Promise((r) => setTimeout(r, 0))
    expect(offered).toEqual(['2026-11-24', '2026-11-24'])
    rig.clock.now += 30_000
    rig.digest.tick()
    await new Promise((r) => setTimeout(r, 0))
    expect(offered).toHaveLength(2)
  })
  it('an owed notice of a day he has already seen on a desktop is not sent', async () => {
    held()
    const offered: string[] = []
    rig.digest.deliverer = { ...rig.deliverer, digest: (day) => (offered.push(day.day), false) }
    rig.clock.now = at(24, '08:00')
    rig.digest.tick()
    await new Promise((r) => setTimeout(r, 0))
    rig.digest.seen('2026-11-24')
    rig.clock.now += 30_000
    rig.digest.tick()
    await new Promise((r) => setTimeout(r, 0))
    expect(offered).toEqual(['2026-11-24'])
    expect(rig.digest.store.setting('owed')).toBe('')
  })
  it('is made in one write: a fault part way leaves the slot to be made whole at the next look', () => {
    held()
    const prune = rig.digest.store.prune.bind(rig.digest.store)
    rig.digest.store.prune = () => {
      throw new Error('disk full')
    }
    rig.clock.now = at(24, '08:00')
    expect(() => rig.digest.tick()).toThrow('disk full')
    expect(rig.digest.list().days).toEqual([])
    expect(rig.digest.list().waiting).toBe(1)
    rig.digest.store.prune = prune
    rig.clock.now += 30_000
    rig.digest.tick()
    expect(rig.digest.list().days).toMatchObject([{ day: '2026-11-24', count: 1 }])
    expect(rig.sent.digest).toHaveLength(1)
  })
  it('keeps the 30 days at each digest time even when nothing waited, and every window hears what went', () => {
    const old = { ...held({ key: 'old', by: at(23, '10:30') })!, at: at(23, '10:00') - 40 * 24 * HOUR, by: at(23, '10:00') - 40 * 24 * HOUR }
    rig.digest.store.put(old)
    rig.pushes.length = 0
    rig.clock.now = at(24, '08:00')
    rig.digest.tick()
    expect(rig.digest.list().days).toEqual([])
    expect(rig.digest.store.byKey('old')).toBeNull()
    expect(rig.pushes).toContainEqual({ push: 'work.digest', gone: old.id })
  })
  it('a linked host that asks at its digest time is answered once the sources are read', async () => {
    held()
    let release: () => void = () => {}
    rig.digest.beforeDay = () =>
      new Promise<void>((done) => (release = done)).then(() => {
        rig.digest.tell({ kind: 'review.ready', workspaceId: 'ws-purdue', title: 'A guest edited Pricing' })
      })
    rig.clock.now = at(24, '08:00')
    // the other host asks before this one's own look has come round
    const asked = rig.digest.listMade({})
    await new Promise((r) => setTimeout(r, 0))
    release()
    const list = await asked
    expect(list.rows.map((r) => r.title).sort()).toEqual(['A guest edited Pricing', 'Send to Dana Reyes: Re: budget'])
    expect(list.days).toMatchObject([{ day: '2026-11-24', count: 2 }])
  })
  it('a linked host whose sources are slow still answers inside the asker\'s limit, with what waited', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      held()
      // a source that takes longer than the asker waits
      rig.digest.beforeDay = () => new Promise<void>(() => {})
      rig.clock.now = at(24, '08:00')
      let list: DigestList | null = null
      void rig.digest.listMade({ day: '2026-11-24' }).then((l) => void (list = l))
      await vi.advanceTimersByTimeAsync(LIST_WAIT_MS)
      expect(LIST_WAIT_MS).toBeLessThan(PEER_WAIT_MS)
      expect(ofDay(list!, '2026-11-24').map((r) => r.title)).toEqual(['Send to Dana Reyes: Re: budget'])
    } finally {
      vi.useRealTimers()
    }
  })
  it("asked for a day it has made, a linked host answers that day's rows alone: one told since waits for its next day", async () => {
    held({ title: 'In the day' })
    rig.clock.now = at(24, '08:00')
    rig.digest.tick()
    held({ title: 'Told after the day was made' })
    expect(ofDay(await rig.digest.listMade({ day: '2026-11-24' }), '2026-11-24').map((r) => r.title)).toEqual(['In the day'])
    // the next day, that row is the next day's
    rig.clock.now = at(25, '07:59')
    expect(ofDay(await rig.digest.listMade({ day: '2026-11-25' }), '2026-11-25').map((r) => r.title)).toEqual(['Told after the day was made'])
  })
  it('asked for a day it handled with nothing in it, a linked host counts no row told since', async () => {
    rig.clock.now = at(24, '08:00')
    rig.digest.tick()
    expect(rig.digest.list().days).toEqual([])
    held({ title: 'Told after the slot' })
    expect(ofDay(await rig.digest.listMade({ day: '2026-11-24' }), '2026-11-24')).toEqual([])
  })
  it('the sender asks each linked host for the day by name', async () => {
    const asked: unknown[] = []
    const far = { hosts: () => ['env_mac'], read: async <T,>(host: string, module: string, verb: string, args: unknown): Promise<T> => (asked.push([host, module, verb, args]), { days: [], rows: [], waiting: 0, groups: [] } as T) }
    await Promise.all(peerDays(far, '2026-11-24'))
    expect(asked).toEqual([['env_mac', 'digest', 'list', { day: '2026-11-24' }]])
    expect(peerDays(undefined, '2026-11-24')).toEqual([])
  })
  it('a clock long past when it is first told does not ring: it waits for the digest', () => {
    const row = held({ key: 'old', by: at(21, '09:00') })!
    expect(row).toMatchObject({ how: 'waiting', due: false })
    expect(rig.sent.now).toEqual([])
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
  it('keeps when he last set each field, and says nothing of it before he ever did', () => {
    expect(rig.digest.settings().setAt).toBeUndefined()
    // The zone a desktop says is not his setting.
    rig.digest.here('America/Chicago')
    expect(rig.digest.settings().setAt).toBeUndefined()
    const first = rig.clock.now
    expect(rig.digest.set({ levels: { held: 'now' } }).setAt).toEqual({ held: first })
    rig.clock.now += 5_000
    expect(rig.digest.set({ at: '07:15' }).setAt).toEqual({ held: first, at: first + 5_000 })
  })
  it('a write that brings it to what another host holds is stamped with that setting\'s own time, and never undoes a newer one of its own', () => {
    const t0 = rig.clock.now
    rig.digest.set({ at: '07:30' })
    rig.clock.now += 60_000
    // Another host was set later for Meetings, earlier for the time: only Meetings is taken.
    const next = rig.digest.set({ at: '08:00', levels: { meetings: 'digest', held: 'now' }, setAt: { at: t0 - 1_000, meetings: t0 + 30_000, held: t0 + 40_000 } })
    expect(next.at).toBe('07:30')
    expect(next.levels).toEqual({ meetings: 'digest', held: 'now' })
    expect(next.setAt).toEqual({ at: t0, meetings: t0 + 30_000, held: t0 + 40_000 })
    // The same write again changes nothing.
    expect(rig.digest.set({ levels: { meetings: 'now' }, setAt: { meetings: t0 + 30_000 } }).levels).toEqual({ meetings: 'digest', held: 'now' })
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
    Object.assign(c, tellPart(c, { db: rig.db, environmentId: 'env_box', whileOn: () => {} } as unknown as WorkPartDeps))
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
  it("a held item's row reaches only the keys that may decide it; the rest, and a gone, reach every key that may read", () => {
    const needs: { push: DigestPush; need?: string }[] = []
    const c = { db: rig.db, host: 'env_box', enabled: () => true, log: () => {}, push: (p: DigestPush, to?: { need?: string }) => void needs.push({ push: p, need: to?.need }) } as unknown as WorkCtx
    Object.assign(c, tellPart(c, { db: rig.db, environmentId: 'env_box', whileOn: () => {} } as unknown as WorkPartDeps))
    c.tell({ kind: 'outbox.held', workspaceId: 'ws-cosmic', title: 'Held: Send to Dana Reyes: Re: budget', key: 'held:host:1', open: { held: { at: 'host', id: '1' } } })
    c.tell({ kind: 'review.ready', workspaceId: 'ws-cosmic', title: 'The week is ready', key: 'review:1' })
    c.tell.done('held:host:1')
    expect(needs.map((n) => [n.push.row?.title ?? (n.push.gone ? 'gone' : '?'), n.need])).toEqual([
      ['Held: Send to Dana Reyes: Re: budget', 'approve'],
      ['The week is ready', 'read'],
      ['gone', 'read']
    ])
    // by its group alone too: a failed send names the draft as a held one does
    expect(pushNeed({ push: 'work.digest', row: { group: 'held' } as never })).toBe('approve')
    expect(pushNeed({ push: 'work.digest', day: { day: '2026-11-24', madeAt: 0, seenAt: null, count: 2 } })).toBe('read')
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

describe('the gate and the notifier', () => {
  it('the notifier is handed the gate at the first look that finds it, and loses it when Work goes off', () => {
    const gates: unknown[] = []
    const notifier = { setGate: (g: unknown) => void gates.push(g), work: () => {}, held: () => {} }
    let built: typeof notifier | null = null
    const offs: (() => void)[] = []
    const c = { db: rig.db, host: 'env_box', enabled: () => true, log: () => {}, push: () => {}, scopeOf: () => null } as unknown as WorkCtx
    tellPart(c, {
      db: rig.db,
      environmentId: 'env_box',
      notifier: () => built,
      whileOn: (run: () => (() => void) | void) => {
        const off = run()
        if (off) offs.push(off)
      }
    } as unknown as WorkPartDeps)
    const digest = digestOf(c)!
    // late in boot: no notifier yet
    digest.tick()
    expect(gates).toEqual([])
    built = notifier
    digest.tick()
    digest.tick()
    expect(gates).toHaveLength(1)
    expect(typeof gates[0]).toBe('function')
    // Work off: the notifier is today's again
    for (const off of offs) off()
    expect(gates).toEqual([gates[0], null])
    // and on again: handed over once more
    digest.tick()
    expect(gates).toHaveLength(3)
  })
})

describe('ctx.tell is total', () => {
  it('never throws, whatever the store does, and says the fault once', () => {
    const logs: string[] = []
    const broken = { prepare: () => { throw new Error('the table is gone') }, exec: () => { throw new Error('the table is gone') } }
    const c = { db: broken, host: 'env_box', enabled: () => true, log: (l: string) => void logs.push(l), push: () => {} } as unknown as WorkCtx
    const { tell } = tellPart(c, { db: broken, environmentId: 'env_box', whileOn: () => {} } as unknown as WorkPartDeps)
    expect(() => tell({ kind: 'outbox.held', workspaceId: 'w', title: 'Held', key: 'k' })).not.toThrow()
    expect(() => tell.done('k')).not.toThrow()
    expect(() => tell.only('held:', ['k'])).not.toThrow()
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
    expect(() => tell.only('held:', [])).not.toThrow()
    expect(() => tell.quiet('s')).not.toThrow()
    expect(digestOf(c)).toBeUndefined()
  })
})
