import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import type { LifeosClient } from '../lifeos/ctx'
import { OfficeError } from './carrier'
import { FakeOffice } from './fake'
import { ensureRouteTables, OutlookRoute } from './route'

/**
 * LifeOS's Outlook route on this host, against a LifeOS in memory that
 * answers the functions M22 and M24 deployed: the presence row, the claim,
 * the journal, the ack, and the replay after a lost ack.
 */
type Call = { kind: 'query' | 'mutation'; fn: string; args: Record<string, unknown> }
let calls: Call[]
let due: unknown[]
let ops: unknown[]
let claims: boolean
let ackFails: number
let office: FakeOffice
let db: DatabaseSync

const lifeos: LifeosClient = {
  async query<T>(fn: string, args: Record<string, unknown> = {}) {
    calls.push({ kind: 'query', fn, args })
    return (fn === 'outbox:localDue' ? due.splice(0) : fn === 'calendarOps:localDue' ? ops.splice(0) : []) as T
  },
  async mutation<T>(fn: string, args: Record<string, unknown> = {}) {
    calls.push({ kind: 'mutation', fn, args })
    if (fn === 'sources:register') return 'src1' as T
    if (fn.endsWith(':localClaim')) return claims as T
    if (fn === 'outbox:localSent' && ackFails-- > 0) throw new Error('lost the link')
    return null as T
  },
  action: async () => null as never
}

const route = () => new OutlookRoute({ db, lifeos: () => lifeos, carrier: office, host: 'env_mac', log: () => {}, now: () => 5_000 })
const mutations = () => calls.filter((c) => c.kind === 'mutation').map((c) => [c.fn, c.args] as const)
const mail = (id: string) => ({
  row: { _id: id, message: { kind: 'mail', to: [{ address: 'owner@example.com' }], cc: [], bcc: [], subject: 'Plan', html: '<p><b>Plan</b></p>', text: 'Plan' } },
  address: 'owner@purdue.example'
})

beforeEach(() => {
  calls = []
  due = []
  ops = []
  claims = true
  ackFails = 0
  office = new FakeOffice()
  office.addresses = ['Owner@Purdue.example']
  db = new DatabaseSync(':memory:')
  ensureRouteTables(db)
})

describe("LifeOS's Outlook route", () => {
  it('says why when Outlook cannot carry mail, and reports no account and claims nothing', async () => {
    office.problem = 'New Outlook does not answer scripts yet'
    const r = route()
    await r.beat()
    due = [mail('m1')]
    await r.pump()
    expect(r.state).toEqual({ accounts: [], beatAt: 5_000, error: 'New Outlook does not answer scripts yet' })
    expect(calls.filter((c) => c.fn !== 'outbox:localDue' && c.fn !== 'calendarOps:localDue')).toEqual([])
    expect(office.log.map((l) => l.verb)).not.toContain('accounts')
  })

  it('reports each Outlook address once, then only beats', async () => {
    const r = route()
    await r.beat()
    await r.beat()
    expect(mutations()).toEqual([
      ['sources:register', { kind: 'email', account: 'owner@purdue.example', channel: 'outlook-local:env_mac', label: 'Outlook on env_mac' }],
      ['sources:heartbeat', { id: 'src1', status: 'ok' }],
      ['sources:heartbeat', { id: 'src1', status: 'ok' }]
    ])
    expect(r.state).toEqual({ accounts: ['owner@purdue.example'], beatAt: 5_000, error: null })
  })

  it('claims a due mail, sends it formatted from its account, and acks it', async () => {
    const r = route()
    await r.beat()
    calls = []
    due = [mail('m1')]
    await r.pump()
    expect(calls[0]).toEqual({ kind: 'query', fn: 'outbox:localDue', args: { host: 'env_mac', now: 5_000 } })
    expect(office.sent).toEqual([{ account: 'owner@purdue.example', to: ['owner@example.com'], cc: [], bcc: [], subject: 'Plan', html: '<p><b>Plan</b></p>' }])
    expect(mutations()).toEqual([
      ['outbox:localClaim', { id: 'm1', host: 'env_mac', version: 0 }],
      ['outbox:localSent', { id: 'm1', host: 'env_mac', providerMessageId: 'sent-1' }]
    ])
    expect(db.prepare('SELECT * FROM work_office_journal').all()).toEqual([])
  })

  it('claims a due mail only as the row it read: the version and the edit time go with the claim', async () => {
    const r = route()
    await r.beat()
    calls = []
    due = [{ ...mail('m7'), row: { ...mail('m7').row, version: 4, editedAt: 99 } }] as never
    await r.pump()
    expect(mutations()[0]).toEqual(['outbox:localClaim', { id: 'm7', host: 'env_mac', version: 4, editedAt: 99 }])
  })

  it('sends nothing it could not claim', async () => {
    const r = route()
    await r.beat()
    claims = false
    due = [mail('m1')]
    await r.pump()
    expect(office.sent).toEqual([])
  })

  it('fails a mail Outlook refused, in words', async () => {
    const r = route()
    await r.beat()
    calls = []
    office.failNext = { verb: 'sendMail', error: new OfficeError('Microsoft Outlook is not open.', 'not-running') }
    due = [mail('m1')]
    await r.pump()
    expect(mutations()[1]).toEqual(['outbox:localFailed', { id: 'm1', host: 'env_mac', error: 'Outlook on env_mac: Microsoft Outlook is not open.' }])
  })

  it('keeps a sent mail in the journal when the ack is lost, and acks it on the next pass without sending again', async () => {
    const r = route()
    await r.beat()
    ackFails = 1
    due = [mail('m1')]
    await expect(r.pump()).rejects.toThrow('lost the link')
    expect(db.prepare('SELECT tbl, id, provider_id FROM work_office_journal').all()).toEqual([{ tbl: 'outbox', id: 'm1', provider_id: 'sent-1' }])
    calls = []
    await r.pump()
    expect(office.sent).toHaveLength(1)
    expect(mutations()[0]).toEqual(['outbox:localSent', { id: 'm1', host: 'env_mac', providerMessageId: 'sent-1' }])
    expect(db.prepare('SELECT * FROM work_office_journal').all()).toEqual([])
  })

  it('never hands Outlook a row it already journaled, even when LifeOS offers it again', async () => {
    const r = route()
    await r.beat()
    ackFails = 99
    due = [mail('m1')]
    await expect(r.pump()).rejects.toThrow('lost the link')
    due = [mail('m1')]
    await r.pump().catch(() => undefined)
    expect(office.sent).toHaveLength(1)
  })

  it('keeps a send that ended unclearly journaled, to be acked as sent, rather than failing it', async () => {
    const r = route()
    await r.beat()
    office.failNext = { verb: 'sendMail', error: new OfficeError('Microsoft Outlook answered: timed out') }
    due = [mail('m1')]
    await expect(r.pump()).rejects.toThrow('timed out')
    expect(mutations().some(([fn]) => fn === 'outbox:localFailed')).toBe(false)
    calls = []
    await r.pump()
    expect(mutations()[0]).toEqual(['outbox:localSent', { id: 'm1', host: 'env_mac' }])
  })

  it('carries an accepted invitation and a new meeting, and fails what Outlook here does not carry', async () => {
    office.calendar.push({ id: 'uid:abc', subject: 'Standup', start: '2026-11-20T15:00:00.000Z', end: '2026-11-20T15:15:00.000Z', location: '', organizer: 'dana@example.com', attendees: [], response: '' })
    const r = route()
    await r.beat()
    calls = []
    ops = [
      { _id: 'c1', kind: 'accept', account: 'owner@purdue.example', uid: 'abc', payload: { comment: 'See you' } },
      { _id: 'c2', kind: 'create', account: 'owner@purdue.example', payload: { title: 'Review', startsAt: Date.UTC(2026, 10, 21, 15), endsAt: Date.UTC(2026, 10, 21, 16), attendees: [{ address: 'dana@example.com' }] } },
      { _id: 'c3', kind: 'propose', account: 'owner@purdue.example', payload: {} }
    ]
    await r.pump()
    expect(calls.find((c) => c.fn === 'calendarOps:localDue')?.args).toEqual({ accounts: ['owner@purdue.example'] })
    expect(office.answers).toEqual([{ id: 'uid:abc', answer: 'accept' }])
    expect(office.calendar.map((e) => e.subject)).toEqual(['Standup', 'Review'])
    expect(mutations().filter(([fn]) => !fn.endsWith('localClaim'))).toEqual([
      ['calendarOps:localDone', { id: 'c1', host: 'env_mac', providerEventId: 'uid:abc', response: 'accepted' }],
      ['calendarOps:localDone', { id: 'c2', host: 'env_mac', providerEventId: 'ev-2' }],
      ['calendarOps:localFailed', { id: 'c3', host: 'env_mac', error: 'Outlook on env_mac does not carry "propose" yet: do it in Outlook.' }]
    ])
  })

  it('keeps an invitation that ended unclear journaled and acks it done, and fails one Outlook refused', async () => {
    const r = route()
    await r.beat()
    const invite = (id: string) => ({ _id: id, kind: 'create', account: 'owner@purdue.example', payload: { title: 'Review', startsAt: Date.UTC(2026, 10, 21, 15), endsAt: Date.UTC(2026, 10, 21, 16), attendees: [{ address: 'dana@example.com' }] } })
    office.failNext = { verb: 'createEvent', error: new OfficeError('Outlook has not said whether it sent this') }
    ops = [invite('c4')]
    await expect(r.pump()).rejects.toThrow('has not said')
    expect(mutations().some(([fn]) => fn === 'calendarOps:localFailed')).toBe(false)
    calls = []
    await r.pump()
    expect(mutations()[0]).toEqual(['calendarOps:localDone', { id: 'c4', host: 'env_mac' }])

    calls = []
    office.failNext = { verb: 'createEvent', error: new OfficeError('Outlook does not know dana, so nothing was sent.', 'not-found') }
    ops = [invite('c5')]
    await r.pump()
    expect(mutations().filter(([fn]) => !fn.endsWith('localClaim'))).toEqual([
      ['calendarOps:localFailed', { id: 'c5', host: 'env_mac', error: 'Outlook on env_mac: Outlook does not know dana, so nothing was sent.' }]
    ])
  })

  it('drops a journaled mail that another machine has claimed since, and says so once', async () => {
    db.prepare('INSERT INTO work_office_journal (tbl, id, provider_id, at) VALUES (?, ?, ?, ?)').run('outbox', 'gone1', null, 1)
    const logs: string[] = []
    const taken: LifeosClient = { ...lifeos, mutation: async <T,>(fn: string, args: Record<string, unknown> = {}) => (fn === 'outbox:localSent' ? Promise.reject(new Error('[CONVEX M(outbox:localSent)] Uncaught ConvexError: another machine took that mail')) : lifeos.mutation<T>(fn, args)) }
    const r = new OutlookRoute({ db, lifeos: () => taken, carrier: office, host: 'env_box', log: (l) => logs.push(l), now: () => 5_000 })
    await r.pump()
    await r.pump()
    expect(db.prepare('SELECT count(*) AS n FROM work_office_journal').get()).toEqual({ n: 0 })
    expect(logs.filter((l) => l.includes('gone1'))).toEqual([expect.stringContaining('dropped from the journal')])
  })
})
