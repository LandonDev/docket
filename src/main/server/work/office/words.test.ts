import { describe, expect, it } from 'vitest'
import { officeActs } from './held'

/** What an Outlook calendar answer is called in the Outbox: a tentative one is "Answer maybe", so its past reads "Answered maybe". */
describe('an Outlook answer in words', () => {
  const cal = officeActs({ carrier: () => ({}) as never }).find((a) => a.kind === 'office.calendar.op')!
  const answer = (a: 'accept' | 'decline' | 'tentative') => cal.words({ host: 'env_mac', op: 'answer', id: 'ev-9', subject: 'Scrim night', start: '2026-11-22T00:00:00Z', answer: a } as never)

  it('says a tentative answer as Answer maybe', () => {
    expect(answer('tentative')).toEqual({ summary: 'Answer maybe to Scrim night', verb: 'Answer maybe' })
  })

  it('keeps Accept and Decline', () => {
    expect(answer('accept')).toEqual({ summary: 'Accept Scrim night', verb: 'Accept' })
    expect(answer('decline')).toEqual({ summary: 'Decline Scrim night', verb: 'Decline' })
  })
})
