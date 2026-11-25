import { describe, expect, it } from 'vitest'
import { needsHim } from './outboxCount'
import { COUNT_FIXTURE, COUNT_FIXTURE_WAITS } from './outboxCount.fixture'

describe('the one count', () => {
  it('counts held, live, failed and out of date until put away; not a send under way, one he scheduled, or one that is done', () => {
    expect(needsHim({ state: 'held' })).toBe(true)
    expect(needsHim({ state: 'live' })).toBe(true)
    expect(needsHim({ state: 'failed' })).toBe(true)
    expect(needsHim({ state: 'stale' })).toBe(true)
    expect(needsHim({ state: 'stale', dismissedAt: 5 })).toBe(false)
    expect(needsHim({ state: 'sending' })).toBe(false)
    expect(needsHim({ state: 'sending', scheduledFor: 9 })).toBe(false)
    expect(needsHim({ state: 'held', scheduledFor: 9 })).toBe(false)
    expect(needsHim({ state: 'sent' })).toBe(false)
    expect(needsHim({ state: 'discarded' })).toBe(false)
  })

  it('the shared fixture, which the host, Today and the digest are each held to', () => {
    expect(COUNT_FIXTURE.filter(needsHim).length).toBe(COUNT_FIXTURE_WAITS)
  })
})

describe('a request\'s name', () => {
  it('names a later send as its own act, and a generic one never names a tool', async () => {
    const { summaryHead } = await import('./outboxHead')
    const mail = (to: string) => ({ kind: 'office.mail.send' as const, verb: 'Send', payload: { to: [{ address: to }] } })
    expect(summaryHead([], 0, { later: [mail('a@x'), mail('b@x')] })).toMatch(/^Send 2 \w+ to 2 people later$/)
    const call = { kind: 'addon.call' as const, verb: 'Echo', payload: { addonId: 'a1', tool: 'echo', words: 'Echo', addon: 'League' } }
    expect(summaryHead([call, call])).toBe('Echo with League, 2 times')
    expect(summaryHead([call, call], 0, { generic: true })).not.toMatch(/League|Echo/)
  })
})
