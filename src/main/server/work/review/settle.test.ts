import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SlippedRef } from '@shared/work/review'
import { review } from '.'
import { NO_JOB_HERE, NOT_A_PERSON, OPEN_IN_OUTBOX, settle, undo, UNDO_GONE, undoCount } from './settle'
import { hiddenKeys } from './store'
import { approver, DAY, HOUR, makeRig, MON, reader, thread, TZ, WEEK, window, type Rig } from './testkit'

/** His presses on a slipped row: each reaches its thing's own write and nothing else, and what can be taken back is. */

let rig: Rig
beforeEach(() => {
  rig = makeRig()
  for (const fn of ['tasks:complete', 'tasks:update', 'tasks:drop', 'tasks:reopen', 'mailWaits:putBack']) rig.lifeos[fn] = null
  rig.lifeos['mailWaits:putOff'] = { state: 'due', dueAt: MON + DAY, since: MON - DAY }
  rig.lifeos['mailWaits:dismiss'] = { state: 'due', dueAt: MON + DAY, since: MON - DAY }
})
afterEach(() => rig.close())

/** Friday afternoon of the week: next week begins the Monday after. */
const NOW = MON + 4 * DAY + 15 * HOUR
const NEXT_MONDAY_9 = WEEK.to + 9 * HOUR
const task: SlippedRef = { kind: 'task', id: 'k1', dueAt: MON + DAY }
const mail: SlippedRef = { kind: 'mail', threadId: 't1', since: MON - DAY }
const heldRow: SlippedRef = { kind: 'held', ref: { at: 'host', id: 'h1' } }
const meeting: SlippedRef = { kind: 'meeting', eventId: 'e1' }
const press = (row: SlippedRef, how: 'now' | 'later' | 'drop', by = window, sector?: string) => settle(rig.ctx, by, { row, how, tz: TZ, ...(sector ? { sector } : {}) }, NOW)
const everything = () => [...rig.calls.map((c) => [c.fn, c.args]), ...rig.moduleCalls.map((c) => [c.method, c.params])]

describe('a task', () => {
  it('Done completes it, and Undo reopens it', async () => {
    const { undo: token } = await press(task, 'now')
    expect(everything()).toEqual([['tasks:complete', { id: 'k1' }]])
    await undo(window, token!, NOW)
    expect(everything().at(-1)).toEqual(['tasks:reopen', { id: 'k1' }])
  })

  it('Next week moves its due date to Monday at nine, and Undo puts the old date back', async () => {
    const { undo: token } = await press(task, 'later')
    expect(everything()).toEqual([['tasks:update', { id: 'k1', patch: { dueAt: NEXT_MONDAY_9 } }]])
    await undo(window, token!, NOW)
    expect(everything().at(-1)).toEqual(['tasks:update', { id: 'k1', patch: { dueAt: MON + DAY } }])
  })

  it('Drop drops it with the reason, and Undo reopens it', async () => {
    const { undo: token } = await press(task, 'drop')
    expect(everything()).toEqual([['tasks:drop', { id: 'k1', reason: 'Dropped in the weekly review' }]])
    await undo(window, token!, NOW)
    expect(everything().at(-1)).toEqual(['tasks:reopen', { id: 'k1' }])
  })
})

describe('a waiting mail', () => {
  it('Nudge starts the mail pillar’s own nudge in the job’s workspace on this host: a draft, with nothing to take back', async () => {
    expect(await press(mail, 'now', window, 'cosmic')).toEqual({ undo: null, sessionId: 'nudge-thread' })
    expect(everything()).toEqual([['work.mail.nudge', { workspaceId: 'w-cosmic', threadId: 't1' }]])
    // The call is his own, as he pressed it: the mail pillar checks the caller again.
    expect(rig.moduleCalls[0]!.by).toBe(window)
    await expect(press(mail, 'now', window, 'hypixel')).rejects.toThrow(NO_JOB_HERE)
    await expect(press(mail, 'now')).rejects.toThrow(NO_JOB_HERE)
  })

  it('Next week puts the wait off to Monday at nine, and Undo puts it back as it was', async () => {
    const { undo: token } = await press(mail, 'later')
    expect(everything()).toEqual([['mailWaits:putOff', { threadId: 't1', until: NEXT_MONDAY_9, since: MON - DAY }]])
    await undo(window, token!, NOW)
    expect(everything().at(-1)).toEqual(['mailWaits:putBack', { threadId: 't1', state: 'due', dueAt: MON + DAY, since: MON - DAY }])
  })

  it('Stop waiting dismisses the wait; a wait that had moved on answers with nothing to take back', async () => {
    const { undo: token } = await press(mail, 'drop')
    expect(everything()).toEqual([['mailWaits:dismiss', { threadId: 't1', since: MON - DAY }]])
    expect(token).not.toBeNull()
    rig.lifeos['mailWaits:dismiss'] = null
    expect(await press(mail, 'drop')).toEqual({ undo: null })
  })
})

describe('a held item', () => {
  it('is never sent from here: its "now" is refused, and no call is made', async () => {
    await expect(press(heldRow, 'now')).rejects.toThrow(OPEN_IN_OUTBOX)
    expect(everything()).toEqual([])
    // No press of any kind on any row reaches the Outbox's send.
    for (const row of [task, mail, heldRow, meeting]) for (const how of ['now', 'later', 'drop'] as const) await press(row, how, window, 'purdue').catch(() => {})
    expect(rig.moduleCalls.map((c) => c.method)).not.toContain('work.outbox.send')
  })

  it('Next week is a mark that hides it until Monday, and Undo removes the mark', async () => {
    const { undo: token } = await press(heldRow, 'later')
    expect(everything()).toEqual([])
    expect([...hiddenKeys(rig.db, NOW)]).toEqual(['held:host:h1'])
    expect([...hiddenKeys(rig.db, WEEK.to)]).toEqual([])
    await press(heldRow, 'later')
    await undo(window, token!, NOW)
    expect([...hiddenKeys(rig.db, NOW)]).toEqual([])
  })

  it('Discard is the Outbox’s own discard, as his press, and cannot be taken back', async () => {
    expect(await press(heldRow, 'drop', approver)).toEqual({ undo: null })
    expect(everything()).toEqual([['work.outbox.discard', { ref: { at: 'host', id: 'h1' } }]])
    expect(rig.moduleCalls[0]!.by).toBe(approver)
  })
})

describe('a meeting', () => {
  it('Next week hides it until Monday; None needed hides it for good; Undo brings it back', async () => {
    await press(meeting, 'later')
    expect([...hiddenKeys(rig.db, WEEK.to - 1)]).toEqual(['meeting:e1'])
    expect([...hiddenKeys(rig.db, WEEK.to)]).toEqual([])
    const { undo: token } = await press(meeting, 'drop')
    expect([...hiddenKeys(rig.db, WEEK.to + 365 * DAY)]).toEqual(['meeting:e1'])
    await undo(window, token!, NOW)
    expect([...hiddenKeys(rig.db, NOW)]).toEqual([])
    expect(everything()).toEqual([])
  })

  it('leaves the follow-up to the window, which starts a thread about it', async () => {
    await expect(press(meeting, 'now')).rejects.toThrow('Start the follow-up from the page')
  })
})

describe('who may press, and take back', () => {
  it('refuses a thread’s own call and a key that may not approve, through the wire too', async () => {
    for (const by of [thread(), reader]) {
      for (const row of [task, mail, heldRow, meeting]) for (const how of ['now', 'later', 'drop'] as const) await expect(press(row, how, by, 'purdue')).rejects.toThrow(NOT_A_PERSON)
      await expect(review.handle!({ id: '1', method: 'work.review.settle', params: { row: task, how: 'now', tz: TZ } } as never, rig.ctx, by)).rejects.toThrow(NOT_A_PERSON)
      await expect(undo(by, 'any', NOW)).rejects.toThrow(NOT_A_PERSON)
    }
    expect(everything()).toEqual([])
    expect([...hiddenKeys(rig.db, NOW)]).toEqual([])
  })

  it('takes a press back once, and not after half an hour', async () => {
    // The wire reads the clock itself, so this press is made now.
    const a = (await settle(rig.ctx, window, { row: task, how: 'now', tz: TZ }, Date.now())).undo!
    expect(await review.handle!({ id: '1', method: 'work.review.undo', params: { token: a } } as never, rig.ctx, window)).toEqual({ handled: true, result: { ok: true } })
    await expect(undo(window, a, NOW)).rejects.toThrow(UNDO_GONE)
    const b = (await press(task, 'drop')).undo!
    await expect(undo(window, b, NOW + 31 * 60_000)).rejects.toThrow(UNDO_GONE)
    await expect(undo(window, 'made-up', NOW)).rejects.toThrow(UNDO_GONE)
    expect(rig.calls.filter((c) => c.fn === 'tasks:reopen')).toHaveLength(1)
    expect(undoCount()).toBe(0)
  })

  it('a row dealt with here reads as dealt with when a kept week is read again', async () => {
    const { weekFor } = await import('.')
    rig.lifeos['mail:accounts'] = []
    rig.lifeos['events:range'] = [{ _id: 'e1', sector: 'purdue', title: 'Budget review', startsAt: MON + 14 * HOUR, endsAt: MON + 15 * HOUR, allDay: false, attendees: [{ address: 'dana@example.edu' }] }]
    rig.lifeos['review:sentBetween'] = []
    rig.lifeos['review:doneBetween'] = []
    rig.lifeos['review:answeredBetween'] = { rows: [], answeredSince: null }
    rig.lifeos['tasks:due'] = []
    rig.lifeos['mailWaits:list'] = { page: [], isDone: true, continueCursor: '' }
    const ask = { from: WEEK.from, to: WEEK.to, tz: TZ, by: 'owner' as const }
    expect((await weekFor(rig.ctx, ask, undefined, NOW)).slipped.rows.map((r) => [r.key, r.open])).toEqual([['meeting:e1', true]])
    // The week ends; on Monday he says the meeting needs nothing.
    await settle(rig.ctx, window, { row: meeting, how: 'drop', tz: TZ }, WEEK.to + HOUR)
    expect((await weekFor(rig.ctx, ask, undefined, WEEK.to + 2 * HOUR)).slipped.rows.map((r) => [r.key, r.open])).toEqual([['meeting:e1', false]])
  })
})
