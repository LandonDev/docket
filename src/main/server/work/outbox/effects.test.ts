import { describe, expect, it } from 'vitest'
import type { OutboxItem } from '@shared/contract-work-outbox'
import { effectOf, people, PRIVATE_EFFECT } from './effects'
import { seenBy } from './index'

describe('what a press does, in one sentence', () => {
  it('names who it reaches, as whom and when, for each kind', () => {
    const cases: [Parameters<typeof effectOf>[0], unknown, string][] = [
      // the fields under it name who: the sentence says when, and who sees it
      ['mail.send', { message: { from: { address: 'landon@purdue.edu' }, to: [{ name: 'Dana Lee', address: 'dana@x.edu' }], cc: [], bcc: [] } }, 'Goes as your mail after your undo time.'],
      ['calendar.op', { kind: 'accept', eventTitle: 'Staff sync' }, 'Tells the organizer you will come.'],
      ['calendar.op', { kind: 'create', payload: { title: 'Scrim', attendees: ['a@x'] } }, 'Sends the invite as you; each guest gets it.'],
      ['office.mail.send', { account: 'me@purdue.edu', to: ['sam@x.edu'], cc: [], bcc: [] }, 'Goes from Outlook as soon as you press.'],
      ['office.calendar.op', { op: 'answer', subject: 'Budget', answer: 'decline', organizer: 'Pat' }, 'Tells Pat you will not come.'],
      ['teams.post', { chat: 'Esports staff, General', text: 'hi' }, 'Posts as you; everyone in the chat sees it.'],
      ['chat.reply', { source: 'slack', chat: '#ops', text: 'ok' }, 'Sends as you; everyone in the conversation sees it.'],
      ['share.google', { email: 'sam@x.edu', role: 'commenter', name: 'Plan', notify: true }, 'Lets sam@x.edu comment on Plan in Google Drive, and Google mails them.'],
      ['form.publish', { title: 'Tryouts' }, 'Publishes Tryouts: anyone with its link can answer.'],
      ['msform.publish', { act: 'audience', title: 'Survey' }, 'Changes who can answer Survey.'],
      ['file.act', { things: [{ key: 'k', name: 'Risk.docx', version: '7' }] }, 'Changes a file in a place others can open, the moment you press.'],
      ['file.act', { things: [{ key: 'a' }, { key: 'b' }] }, 'Changes files in a place others can open, the moment you press.'],
      ['portal.submit', {}, 'Carries this out as you.']
    ]
    for (const [kind, payload, words] of cases) expect(effectOf(kind, payload, 'America/Chicago'), kind).toBe(words)
  })

  it('says of a scheduled item only as whom: its time leads the item, whatever its kind', () => {
    expect(effectOf('office.mail.send', { to: ['a@x'] }, 'America/Chicago', undefined, true)).toBe('Sends as you.')
  })

  it('takes a kind\'s own words first, and never throws on a payload it cannot read', () => {
    expect(effectOf('teams.post', { chat: 'x' }, 'America/Chicago', () => 'Its own words.')).toBe('Its own words.')
    expect(effectOf('mail.send', null, 'America/Chicago')).toBe('Carries this out as you.')
    expect(effectOf('office.edit', null, 'America/Chicago')).toBe('Changes the file for everyone who can open it, the moment you press.')
  })

  it("says what a guest link means, never its fields again: who, what they can do and its end are drawn under it", () => {
    const link = { name: 'Dana', role: 'edit', title: 'Plan', expiresAt: Date.UTC(2026, 10, 25, 3, 30) }
    expect(effectOf('share.guestLink', link, 'America/Chicago')).toBe('Anyone with the link opens it without signing in.')
  })

  /** Round 1's carry (R1-F10): "Does this on the screen in Chromium: the step shown." named the app twice and no step. */
  it('says a computer step by its own word, else what it lands on, and never the app its row names', () => {
    const app = { name: 'Chromium', bundleId: 'org.chromium.Chromium' }
    expect(effectOf('computer.act', { app, label: 'Submit', read: { on: 'button "Submit expense"' } }, 'UTC')).toBe('Presses Submit on the screen as you.')
    expect(effectOf('computer.act', { app, label: ' ', read: { on: 'button "Submit expense"' } }, 'UTC')).toBe('Acts on button "Submit expense" as you.')
    expect(effectOf('computer.act', { app, label: '', read: null }, 'UTC')).toBe('Acts on the screen as you.')
    expect(effectOf('computer.act', { app, label: 'Submit' }, 'UTC')).not.toMatch(/Chromium|step shown/)
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
