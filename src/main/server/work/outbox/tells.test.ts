import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { GrantOffer, OutboxItem } from '@shared/contract-work-outbox'
import type { Tell } from '@shared/work/tell'
import type { ActKindDef, Caller, WorkCtx } from '../modules'
import { seenBy } from './index'
import { OfficeCalendarSchema } from '../office/held'
import { calendarOpKind } from './lifeosHeld'
import { failedKey, heldKey, offerKey, OUTBOX_TELLS, syncTells, tellFailed, tellHeld, tellOffer, WAITING_MAX, type TellsDeps, type TellsSource } from './tells'

/** What the Outbox tells through `ctx.tell`: a held item, a failed send, an offered grant, and the ledger kept in step. */

const NOW = Date.parse('2026-11-23T15:00:00Z')
const HOUR = 3_600_000

let told: Tell[]
let done: string[]
let only: [string, string[]][]
let deps: TellsDeps
const kinds = new Map<string, ActKindDef>()

const item = (over: Partial<OutboxItem> = {}): OutboxItem =>
  ({
    ref: { at: 'host', id: 'h1' },
    kind: 'addon.call',
    workspaceId: 'ws-purdue',
    sessionId: 't-work',
    sector: 'purdue',
    summary: 'Send to Dana Reyes: Re: budget',
    verb: 'Send',
    account: null,
    state: 'held',
    payload: {},
    createdAt: NOW - HOUR,
    decidedBy: null,
    decidedAt: null,
    n: 1,
    why: 'pillar',
    grantId: null,
    error: null,
    result: null,
    routineRunId: null,
    updatedAt: NOW - HOUR,
    ...over
  }) as OutboxItem

beforeEach(() => {
  told = []
  done = []
  only = []
  kinds.clear()
  const workspaces = [
    { id: 'repo', kind: 'code', sector: 'cosmic' },
    { id: 'ws-purdue', kind: 'work', sector: 'purdue' },
    { id: 'ws-cosmic', kind: 'work', sector: 'cosmic' }
  ]
  const tell = Object.assign((t: Tell) => void told.push(t), { done: (key: string) => void done.push(key), only: (prefix: string, keys: readonly string[]) => void only.push([prefix, [...keys]]), quiet: () => {} })
  deps = { ctx: { tell, log: () => {} } as unknown as WorkCtx, kindOf: (kind) => kinds.get(kind), workspaces: () => workspaces, now: () => NOW }
})

describe('the kinds', () => {
  it('are listed once with their groups: held items and failed sends are his to set together, an offer is quiet', () => {
    expect(OUTBOX_TELLS.map((t) => [t.kind, t.group])).toEqual([
      ['outbox.held', 'held'],
      ['outbox.failed', 'held'],
      ['outbox.offer', 'system']
    ])
  })
})

describe('a held change to a file others can open', () => {
  const edit = (kind: 'office.edit' | 'google.edit') => item({ kind, summary: 'Make the change in Brief.docx: Replace “Q3 draft” With “Q3 final”', payload: { name: 'Brief.docx', edit: { find: 'Q3 draft', replace: 'Q3 final' } } })
  it('is told, held or failed, with no file name and none of its words: a notice may reach a webhook or a phone before his press', () => {
    for (const kind of ['office.edit', 'google.edit'] as const) {
      told = []
      tellHeld(deps, edit(kind))
      tellFailed(deps, { ...edit(kind), state: 'failed', decidedAt: NOW - 1000, error: 'Word is not open.' })
      expect(told.map((t) => t.title)).toEqual(['Held: a change to a file others can open', 'Not sent: a change to a file others can open'])
      expect(JSON.stringify(told)).not.toMatch(/Brief|Q3/)
      expect(told[0]!.open).toEqual({ held: { at: 'host', id: 'h1' }, thread: 't-work' })
    }
  })
  it('is shown whole only to his press: a read or operate key, or another host, gets that it waits and nothing of it', () => {
    const shown = edit('office.edit')
    for (const by of [{ kind: 'remote', caps: ['read'] }, { kind: 'remote', caps: ['read', 'operate'] }, { kind: 'remote', caps: ['read', 'operate'], peer: 'env_mac' }] as Caller[]) {
      const seen = seenBy(by, shown)
      expect(seen).toMatchObject({ summary: 'a change to a file others can open', payload: null, ref: shown.ref, state: 'held' })
      expect(JSON.stringify(seen)).not.toMatch(/Brief|Q3/)
    }
    for (const by of [{ kind: 'local', caps: [] }, { kind: 'remote', caps: ['read', 'operate', 'approve'] }] as Caller[]) expect(seenBy(by, shown)).toBe(shown)
    // Every other kind is listed as before.
    const mail = item()
    expect(seenBy({ kind: 'remote', caps: ['read'] }, mail)).toBe(mail)
  })
})

describe('a held item', () => {
  it('is told in his words with no clock, opening the item, and naming the thread that made it', () => {
    tellHeld(deps, item())
    expect(told).toEqual([{ kind: 'outbox.held', workspaceId: 'ws-purdue', title: 'Held: Send to Dana Reyes: Re: budget', key: 'held:host:h1', open: { held: { at: 'host', id: 'h1' }, thread: 't-work' } }])
    expect(told[0]).not.toHaveProperty('by')
  })
  it('made by no thread opens the item alone, and one in no workspace of this host is told under the job of its sector', () => {
    tellHeld(deps, item({ sessionId: null, workspaceId: '~work', sector: 'cosmic', ref: { at: 'lifeos', table: 'outbox', id: 'ob1' } }))
    expect(told[0]).toMatchObject({ workspaceId: 'ws-cosmic', key: 'held:lifeos:outbox:ob1', open: { held: { at: 'lifeos', table: 'outbox', id: 'ob1' } } })
    expect(told[0]!.open).not.toHaveProperty('thread')
    tellHeld(deps, item({ workspaceId: null, sector: null }))
    expect(told[1]!.workspaceId).toBeNull()
  })
  it("carries its kind's clock: an invite or an answer is too late once its event has begun", () => {
    kinds.set('calendar.op', calendarOpKind as unknown as ActKindDef)
    const starts = NOW + 3 * HOUR
    tellHeld(deps, item({ kind: 'calendar.op', ref: { at: 'lifeos', table: 'calendarOps', id: 'op1' }, summary: 'Accept Budget review', payload: { id: 'op1', kind: 'accept', eventId: 'ev1', eventStartsAt: starts } }))
    tellHeld(deps, item({ kind: 'calendar.op', ref: { at: 'lifeos', table: 'calendarOps', id: 'op2' }, summary: 'Invite Dana Reyes to Spring LAN walkthrough', payload: { id: 'op2', kind: 'create', payload: { title: 'Spring LAN walkthrough', startsAt: starts + HOUR } } }))
    tellHeld(deps, item({ kind: 'calendar.op', ref: { at: 'lifeos', table: 'calendarOps', id: 'op3' }, summary: 'Cancel a thing', payload: { id: 'op3', kind: 'cancel' } }))
    expect(told.map((t) => t.by)).toEqual([starts, starts + HOUR, undefined])
    expect(told[0]).toMatchObject({ key: 'held:lifeos:calendarOps:op1', title: 'Held: Accept Budget review' })
  })
  it("Outlook's calendar act says its event's start too, and a payload the kind cannot read has no clock rather than a wrong one", () => {
    const by = (p: unknown): number | null => {
      const parsed = OfficeCalendarSchema.safeParse(p)
      if (!parsed.success) return null
      const start = Date.parse((parsed.data.op === 'create' ? parsed.data.event.start : parsed.data.start) ?? '')
      return Number.isFinite(start) ? start : null
    }
    kinds.set('office.calendar.op', { kind: 'office.calendar.op', store: 'host', payload: OfficeCalendarSchema, by } as unknown as ActKindDef)
    tellHeld(deps, item({ kind: 'office.calendar.op', payload: { host: 'env_mac', op: 'create', event: { subject: 'Budget review', start: '2026-11-23T19:00:00+00:00', end: '2026-11-23T20:00:00+00:00', attendees: ['dana@example.edu'] } } }))
    tellHeld(deps, item({ kind: 'office.calendar.op', ref: { at: 'host', id: 'h2' }, payload: { nonsense: true } }))
    expect(told.map((t) => t.by)).toEqual([Date.parse('2026-11-23T19:00:00Z'), undefined])
  })
  it('a kind with no clock, or one whose clock throws, keeps', () => {
    kinds.set('addon.call', { kind: 'addon.call', store: 'host', payload: z.object({}), by: () => { throw new Error('bad') } } as unknown as ActKindDef)
    tellHeld(deps, item())
    expect(told[0]).not.toHaveProperty('by')
  })
  it('that is no longer waiting is not told', () => {
    tellHeld(deps, item({ state: 'sent' }))
    tellHeld(deps, item({ state: 'failed' }))
    expect(told).toEqual([])
  })
})

describe('a send that failed', () => {
  it('interrupts while it is fresh, since he believes it went: its clock is the moment it failed', () => {
    tellFailed(deps, item({ state: 'failed', decidedAt: NOW - 60_000, error: 'The mail server\n refused the recipient' }))
    expect(told).toEqual([{ kind: 'outbox.failed', workspaceId: 'ws-purdue', title: 'Not sent: Send to Dana Reyes: Re: budget', detail: 'The mail server refused the recipient', key: 'unsent:host:h1@' + (NOW - 60_000), open: { held: { at: 'host', id: 'h1' }, thread: 't-work' }, by: NOW - 60_000 }])
  })
  it('each press that fails again is its own failure: a retry that fails rings anew rather than reading as an edit', () => {
    tellFailed(deps, item({ state: 'failed', decidedAt: NOW - 60_000 }))
    tellFailed(deps, item({ state: 'failed', decidedAt: NOW - 1_000 }))
    expect(told.map((t) => t.key)).toEqual([`unsent:host:h1@${NOW - 60_000}`, `unsent:host:h1@${NOW - 1_000}`])
    // each time, the item's other attempts are retired first, and the key from before attempts had one
    expect(only.at(-1)).toEqual(['unsent:host:h1@', [`unsent:host:h1@${NOW - 1_000}`]])
    expect(done).toEqual(['unsent:host:h1', 'unsent:host:h1'])
    // LifeOS's own: no press here, one key
    expect(failedKey({ at: 'lifeos', table: 'outbox', id: 'ob1' })).toBe('unsent:lifeos:outbox:ob1')
  })
  it('a day old it waits for the digest: an old failure found at start is not rung as news', () => {
    tellFailed(deps, item({ state: 'failed', decidedAt: NOW - 25 * HOUR }))
    expect(told[0]).not.toHaveProperty('by')
    expect(told[0]).not.toHaveProperty('detail')
  })
})

describe('an offered grant', () => {
  it('waits, and opens the sent item it sits beside', () => {
    const offer: GrantOffer = { id: 'go1', workspaceId: 'ws-purdue', kind: 'mail.send', label: 'Mail to dana@example.edu', routineId: null, from: { at: 'lifeos', table: 'outbox', id: 'ob5' }, count: 5, createdAt: NOW }
    tellOffer(deps, offer)
    expect(told).toEqual([{ kind: 'outbox.offer', workspaceId: 'ws-purdue', title: 'You could stop holding Mail to dana@example.edu', detail: 'You sent the last 5 as written', key: 'offer:go1', open: { held: { at: 'lifeos', table: 'outbox', id: 'ob5' } } }])
    expect(offerKey('go1')).toBe('offer:go1')
  })
})

describe('the ledger kept in step', () => {
  const source = (over: Partial<TellsSource> = {}): TellsSource => ({ waiting: () => [], offers: () => [], lifeosLoaded: () => ({ outbox: true, calendarOps: true }), ...over })
  it('what left the Outbox is done, a held item, a failed send and an offer are told, each list by its own keys', () => {
    const held = item()
    const mail = item({ ref: { at: 'lifeos', table: 'outbox', id: 'ob1' } })
    const failed = item({ ref: { at: 'host', id: 'h9' }, state: 'failed', decidedAt: NOW - 1 })
    const offer: GrantOffer = { id: 'go1', workspaceId: 'ws-purdue', kind: 'mail.send', label: 'Mail to Dana', routineId: null, from: { at: 'host', id: 'h3' }, count: 5, createdAt: NOW }
    syncTells(deps, source({ waiting: () => [held, mail, failed, item({ ref: { at: 'host', id: 'h4' }, state: 'sending' })], offers: () => [offer] }))
    // a held item first read at boot is told (the ledger changes nothing for one it already holds in the same words)
    expect(told.map((t) => [t.kind, t.key])).toEqual([
      ['outbox.held', heldKey(held.ref)],
      ['outbox.held', heldKey(mail.ref)],
      ['outbox.failed', failedKey(failed.ref, failed.decidedAt)],
      ['outbox.offer', 'offer:go1']
    ])
    const kept = [heldKey(held.ref), heldKey(mail.ref)]
    const unsent = [failedKey(failed.ref, failed.decidedAt)]
    expect(only).toEqual([
      // the failed item's earlier attempts go before its new one is told
      ['unsent:host:h9@', unsent],
      ['offer:', ['offer:go1']],
      ['held:host:', kept],
      ['unsent:host:', unsent],
      ['held:lifeos:outbox:', kept],
      ['unsent:lifeos:outbox:', unsent],
      ['held:lifeos:calendarOps:', kept],
      ['unsent:lifeos:calendarOps:', unsent]
    ])
  })
  it('a list as long as the read allows may be cut short: it tells, and withdraws nothing held or failed', () => {
    const many = Array.from({ length: WAITING_MAX }, (_, n) => item({ ref: { at: 'host', id: `h${n}` } }))
    syncTells(deps, source({ waiting: () => many }))
    expect(told).toHaveLength(WAITING_MAX)
    expect(only.map(([prefix]) => prefix)).toEqual(['offer:'])
  })
  it("a list LifeOS has not answered yet is left alone: a host that just came up withdraws nothing that still waits", () => {
    syncTells(deps, source({ lifeosLoaded: () => ({ outbox: true, calendarOps: false }) }))
    expect(only.map(([prefix]) => prefix)).toEqual(['offer:', 'held:host:', 'unsent:host:', 'held:lifeos:outbox:', 'unsent:lifeos:outbox:'])
    only = []
    // Work off: LifeOS is not watched at all
    syncTells(deps, source({ lifeosLoaded: () => null }))
    expect(only.map(([prefix]) => prefix)).toEqual(['offer:', 'held:host:', 'unsent:host:'])
  })
  it('never throws at the Outbox: a fault is logged', () => {
    const logs: string[] = []
    syncTells({ ...deps, ctx: { ...deps.ctx, log: (l: string) => void logs.push(l) } as never }, source({ waiting: () => { throw new Error('the table is gone') } }))
    expect(logs).toEqual(['outbox: what it tells was not brought up to date: the table is gone'])
  })
})
