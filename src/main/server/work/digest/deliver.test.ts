import { nowLine } from '@shared/work/digest'
import { describe, expect, it, vi } from 'vitest'
import type { DigestDay } from '@shared/contract-work-digest'
import type { TellRow } from '@shared/work/tell'
import { makeDeliverer, mergeByKey, NOW_KEY, ofDay, PEER_WAIT_MS, type DeliverDeps } from './deliver'
import type { LedgerRow } from './store'

/** A tell and a day's digest handed to the notifier: the fold, the one sender, the peers' count. */

let n = 0
const row = (over: Partial<LedgerRow> = {}): LedgerRow => ({
  id: `t${++n}`,
  host: 'env_box',
  kind: 'prep.starting',
  group: 'meetings',
  workspaceId: 'ws-purdue',
  sector: 'purdue',
  title: 'Budget review starts at 2:00 PM',
  at: 1_000,
  how: 'waiting',
  day: null,
  toldAt: null,
  due: false,
  ...over
})
const DAY: DigestDay = { day: '2026-11-24', madeAt: 5_000, seenAt: null, count: 2 }

function rig(over: Partial<DeliverDeps> = {}) {
  const work: Parameters<NonNullable<ReturnType<DeliverDeps['notifier']>>['work']>[0][] = []
  const held: unknown[][] = []
  const logs: string[] = []
  const notifier = { work: (x: (typeof work)[number]) => void work.push(x), held: (...a: unknown[]) => void held.push(a) }
  const deliverer = makeDeliverer({ notifier: () => notifier, sendsDigest: () => true, peers: () => [], log: (l) => logs.push(l), ...over })
  return { deliverer, work, held, logs }
}

describe('an interrupt', () => {
  it('is one notice named for the job, opening the tell\'s own target, under the one key every interrupt replaces', () => {
    const { deliverer, work } = rig()
    const r = row({ key: 'prep:ev1', by: 9_000, detail: 'With Dana Reyes', open: { view: 'agenda', workspaceId: 'ws-purdue', at: 'ev1' } })
    expect(deliverer.now(r, [r])).toBe(true)
    expect(work).toEqual([
      { title: 'Purdue', body: 'Budget review starts at 2:00 PM\nWith Dana Reyes', urgent: true, work: { key: NOW_KEY, tell: 'prep:ev1', by: 9_000, open: { view: 'agenda', workspaceId: 'ws-purdue', at: 'ev1' } } }
    ])
  })
  it('names every one still open when more than one is, so a banner that replaced another says everything, and opens the list', () => {
    const { deliverer, work } = rig()
    const a = row({ key: 'prep:ev1', toldAt: 100, open: { thread: 't1' } })
    const b = row({ key: 'lapse:frameio:1', kind: 'connections.ending', sector: null, workspaceId: null, title: 'Sign-in to Frame.io ends today', open: { settings: 'connections' } })
    deliverer.now(b, [a, b])
    // the one that could not wait just now is named first
    expect(work).toEqual([{ title: 'Work', body: '2 things need you: Sign-in to Frame.io ends today; Budget review starts at 2:00 PM', urgent: true, work: { key: NOW_KEY, tell: 'lapse:frameio:1' } }])
  })
  it('cuts each title short before joining them and counts what does not fit, so one long title never crowds another out', () => {
    const long = 'A sign-in that ends today and has a very long name indeed, longer than a banner could ever show in one go'
    expect(nowLine([long, 'Budget review starts at 2:00 PM'])).toBe(`2 things need you: ${long.slice(0, 59).trimEnd()}…; Budget review starts at 2:00 PM`)
    const many = nowLine(Array.from({ length: 9 }, (_, i) => `Thing number ${i + 1} cannot wait any longer than this`))
    expect(many.length).toBeLessThanOrEqual(200)
    expect(many.startsWith('9 things need you: Thing number 1 cannot wait')).toBe(true)
    expect(many).toMatch(/; and \d more$/)
    expect(nowLine(['Only this'])).toBe('Only this')
  })
  it('names the one that could not wait just now first, so it is never the one counted among the rest', () => {
    const { deliverer, work } = rig()
    const long = (i: number): string => `Thing number ${i} that has been open for a while and has a long name`
    const old = [1, 2, 3].map((i) => row({ key: `old:${i}`, title: long(i), toldAt: 100 + i }))
    const fresh = row({ key: 'new:1', title: 'The new thing that cannot wait' })
    deliverer.now(fresh, [...old, fresh])
    expect(work[0]!.body.startsWith('4 things need you: The new thing that cannot wait; ')).toBe(true)
    expect(work[0]!.body.length).toBeLessThanOrEqual(200)
  })
  it("leaves out of the fold one that went out on its own thread: that banner is its own", () => {
    const { deliverer, work } = rig()
    const invite = row({ kind: 'outbox.held', group: 'held', title: 'Held: Invite Dana Reyes to Budget review', toldAt: 100, open: { held: { at: 'lifeos', table: 'calendarOps', id: 'op1' }, thread: 'thread-1' } })
    const lapse = row({ key: 'lapse:frameio:1', kind: 'connections.ending', sector: null, workspaceId: null, title: 'Sign-in to Frame.io ends Nov 23 at 6:30 PM', open: { settings: 'connections' } })
    deliverer.now(lapse, [invite, lapse])
    expect(work).toEqual([{ title: 'Work', body: 'Sign-in to Frame.io ends Nov 23 at 6:30 PM', urgent: true, work: { key: NOW_KEY, tell: 'lapse:frameio:1', open: { settings: 'connections' } } }])
  })
  it('of a row with no key is named by its id, and one about no job is titled Work', () => {
    const { deliverer, work } = rig()
    const r = row({ sector: null, workspaceId: null })
    deliverer.now(r, [r])
    expect(work[0]).toMatchObject({ title: 'Work', work: { key: NOW_KEY, tell: r.id } })
    expect(work[0]!.work).not.toHaveProperty('open')
    expect(work[0]!.work).not.toHaveProperty('by')
  })
  it("that opens a held item a thread made goes out on that thread through the notifier's held, as it always did", () => {
    const { deliverer, work, held } = rig()
    const r = row({ kind: 'outbox.held', group: 'held', title: 'Held: Invite Dana Reyes to Budget review', by: 9_000, open: { held: { at: 'lifeos', table: 'calendarOps', id: 'op1' }, thread: 'thread-1' } })
    expect(deliverer.now(r, [r])).toBe(true)
    expect(held).toEqual([['thread-1', 'Held: Invite Dana Reyes to Budget review', { at: 'lifeos', table: 'calendarOps', id: 'op1' }]])
    expect(work).toEqual([])
    // a held item no thread made has no thread to hang on: it is a notice of Work's
    const loose = row({ kind: 'outbox.held', group: 'held', title: 'Held: Send to Dana Reyes', open: { held: { at: 'host', id: 'h1' } } })
    deliverer.now(loose, [loose])
    expect(work).toHaveLength(1)
    expect(work[0]!.work).toMatchObject({ open: { held: { at: 'host', id: 'h1' } } })
  })
  it('is not taken while the host has no notifier yet', () => {
    const { deliverer, work } = rig({ notifier: () => null })
    const r = row()
    expect(deliverer.now(r, [r])).toBe(false)
    expect(work).toEqual([])
  })
})

describe("the day's digest", () => {
  it('is one quiet notice naming the count and the jobs', async () => {
    const { deliverer, work } = rig()
    await deliverer.digestSent(DAY, [row({ sector: 'cosmic' }), row({ sector: 'purdue' }), row({ sector: 'cosmic' })])
    expect(work).toEqual([{ title: 'Work', body: 'Digest: 3 things in Cosmic and Purdue', urgent: false, work: { key: 'digest:2026-11-24', digest: '2026-11-24' } }])
  })
  it('is sent by one host: a host that is not the sender sends none, though it made its day', async () => {
    const { deliverer, work } = rig({ sendsDigest: () => false })
    await deliverer.digestSent(DAY, [row()])
    expect(work).toEqual([])
  })
  it('adds what each linked host holds for the day, a thing two hosts tell under one key counted once', async () => {
    const mac: TellRow[] = [
      row({ host: 'env_mac', sector: 'ref', key: 'clash:1', title: 'A clash' }),
      row({ host: 'env_mac', sector: 'hypixel', title: 'Thumbnail review is ready' })
    ]
    const { deliverer, work } = rig({ peers: () => [Promise.resolve(mac)] })
    await deliverer.digestSent(DAY, [row({ sector: 'cosmic' }), row({ sector: 'ref', key: 'clash:1', title: 'A clash' })])
    expect(work[0]!.body).toBe('Digest: 3 things in Cosmic, Hypixel and Ref')
  })
  it('a day this host has nothing for still goes out when a linked host holds something: a Mac\'s jobs are not left unsaid', async () => {
    const mac: TellRow[] = [row({ host: 'env_mac', sector: 'purdue' }), row({ host: 'env_mac', sector: 'cosmic' })]
    const { deliverer, work } = rig({ peers: () => [Promise.resolve(mac)] })
    await deliverer.digestSent({ ...DAY, count: 0 }, [])
    expect(work).toEqual([{ title: 'Work', body: 'Digest: 2 things in Cosmic and Purdue', urgent: false, work: { key: 'digest:2026-11-24', digest: '2026-11-24' } }])
    // and with nothing anywhere, nothing is sent
    const none = rig({ peers: () => [Promise.resolve([])] })
    await none.deliverer.digestSent({ ...DAY, count: 0 }, [])
    expect(none.work).toEqual([])
  })
  it('a linked host that does not answer in five seconds, or refuses, adds nothing and holds nothing up', async () => {
    vi.useFakeTimers()
    try {
      const never = new Promise<TellRow[]>(() => {})
      const refused = Promise.reject(new Error('unknown method'))
      const { deliverer, work } = rig({ peers: () => [never, refused, Promise.resolve([row({ host: 'env_pc', sector: 'unify' })])] })
      const sent = deliverer.digestSent(DAY, [row({ sector: 'cosmic' })])
      await vi.advanceTimersByTimeAsync(PEER_WAIT_MS - 1)
      expect(work).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      await sent
      expect(work[0]!.body).toBe('Digest: 2 things in Cosmic and Unify')
    } finally {
      vi.useRealTimers()
    }
  })
  it('two hosts with one asleep give one phone digest: the sender sends its own, the sleeper sends none when it wakes', async () => {
    // The box (the sender) at the time: the Mac is asleep, its link is down, so it is not asked.
    const box = rig({ peers: () => [] })
    await box.deliverer.digestSent(DAY, [row({ sector: 'cosmic' })])
    // The Mac wakes and makes its day late: it is not the sender.
    const mac = rig({ sendsDigest: () => false })
    await mac.deliverer.digestSent({ ...DAY, madeAt: 9_000 }, [row({ host: 'env_mac', sector: 'purdue' })])
    expect([...box.work, ...mac.work]).toHaveLength(1)
  })
  it('a fault while it is sent is logged and never thrown at the clock', async () => {
    const { deliverer, logs } = rig({
      sendsDigest: () => {
        throw new Error('no settings')
      }
    })
    expect(() => deliverer.digest(DAY, [row()])).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
    expect(logs).toEqual(["digest: the day's notice was not sent: no settings"])
  })
})

describe('what a linked host holds for the day', () => {
  it('is its rows that waited, in that day or not stamped yet; one he was told of at once is not counted', () => {
    const rows = [row({ day: '2026-11-24' }), row({ day: null }), row({ day: '2026-11-23' }), row({ day: '2026-11-24', toldAt: 5 }), row({ day: null, toldAt: 5 })]
    expect(ofDay({ rows }, '2026-11-24').map((r) => r.id)).toEqual([rows[0]!.id, rows[1]!.id])
  })
  it('merges by key, and a row with no key is its own on each host', () => {
    const a = row({ key: 'k' })
    const b = row({ key: 'k', host: 'env_mac' })
    const c = row({ id: 'same', host: 'env_box' })
    const d = row({ id: 'same', host: 'env_mac' })
    expect(mergeByKey([[a, c], [b, d]])).toEqual([a, c, d])
  })
})
