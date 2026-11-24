import { describe, expect, it } from 'vitest'
import type { OutboxItem } from '@shared/contract-work-outbox'
import { effectOf, people, PRIVATE_EFFECT } from './effects'
import { seenBy } from './index'

describe('what a press does, in one sentence', () => {
  it('names who it reaches, as whom and when, for each kind', () => {
    const cases: [Parameters<typeof effectOf>[0], unknown, string][] = [
      ['mail.send', { message: { from: { address: 'landon@purdue.edu' }, to: [{ name: 'Dana Lee', address: 'dana@x.edu' }], cc: [], bcc: [] } }, 'Goes from landon@purdue.edu to Dana Lee after your undo time.'],
      ['mail.send', { message: { to: [{ address: 'a@x' }, { address: 'b@x' }], cc: [{ address: 'c@x' }], bcc: [] } }, 'Goes to a@x and b@x, with 1 more on copy after your undo time.'],
      ['calendar.op', { kind: 'accept', eventTitle: 'Staff sync' }, 'Tells the organizer you will come to Staff sync.'],
      ['calendar.op', { kind: 'create', payload: { title: 'Scrim', attendees: ['a@x'] } }, 'Sends an invite for Scrim to a@x.'],
      ['office.mail.send', { account: 'me@purdue.edu', to: ['sam@x.edu'], cc: [], bcc: [] }, 'Goes from me@purdue.edu to sam@x.edu as soon as you press.'],
      ['office.calendar.op', { op: 'answer', subject: 'Budget', answer: 'decline', organizer: 'Pat' }, 'Tells Pat you will not come to Budget.'],
      ['teams.post', { chat: 'Esports staff, General', text: 'hi' }, 'Posts as you in Teams, in Esports staff, General, where everyone in it sees it.'],
      ['chat.reply', { source: 'slack', chat: '#ops', text: 'ok' }, 'Sends as you in Slack to #ops.'],
      ['share.google', { email: 'sam@x.edu', role: 'commenter', name: 'Plan', notify: true }, 'Lets sam@x.edu comment on Plan in Google Drive, and Google mails them.'],
      ['form.publish', { title: 'Tryouts' }, 'Publishes Tryouts: anyone with its link can answer.'],
      ['msform.publish', { act: 'audience', title: 'Survey' }, 'Changes who can answer Survey.'],
      ['portal.submit', {}, 'Carries this out as you.']
    ]
    for (const [kind, payload, words] of cases) expect(effectOf(kind, payload), kind).toBe(words)
  })

  it('takes a kind\'s own words first, and never throws on a payload it cannot read', () => {
    expect(effectOf('teams.post', { chat: 'x' }, () => 'Its own words.')).toBe('Its own words.')
    expect(effectOf('mail.send', null)).toBe('Carries this out as you.')
    expect(effectOf('office.edit', null)).toBe('Changes the file for everyone who can open it, the moment you press.')
  })

  it('names three people, then how many more', () => {
    expect(people([{ name: 'A', address: 'a' }, 'b', { address: 'c' }])).toBe('A, b and c')
    expect(people(['a', 'b', 'c', 'd', 'e'])).toBe('a, b and 3 others')
  })

  it('says only "Changes a file others can open" of a private change to a caller that cannot press', () => {
    const item = { kind: 'office.edit', summary: 'Edit Plan.docx', payload: { name: 'Plan.docx' }, effect: 'Changes Plan.docx for everyone who can open it, the moment you press.', changed: { at: 1, by: 'thread', first: { words: 'secret' } }, reason: 'Plan.docx is wrong', error: null, result: null } as unknown as OutboxItem
    const seen = seenBy({ kind: 'remote', caps: ['read'] } as never, item)
    expect(seen.effect).toBe(PRIVATE_EFFECT)
    expect(seen.changed).toEqual({ at: 1, by: 'thread' })
    expect(seen.reason).toBe('a change to a file others can open')
    expect(seenBy({ kind: 'local', caps: ['read', 'operate', 'approve', 'admin'] } as never, item).effect).toBe(item.effect)
  })
})
