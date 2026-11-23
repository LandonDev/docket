import { describe, expect, it } from 'vitest'
import type { PrepPage } from '@shared/contract-work-prep'
import { briefMessage, briefTitle, followAgainMessage, followMessage, followTitle, pageWords } from './prompts'

const at = Date.parse('2026-11-23T19:00:00Z')
const home = 'https://example.com/roster'
const page: PrepPage = {
  workspaceId: 'ws-purdue',
  sector: 'purdue',
  event: { id: 'ev1', title: 'Staff sync', startsAt: at, endsAt: at + 3_600_000, allDay: false, location: 'Room 204' },
  people: [
    { name: 'Maya Chen', address: 'maya@x.test', mail: { id: 'm1', subject: 'Arena budget', at, unread: false } },
    { name: 'Tom Beck', address: 'tom@x.test', declined: true },
    { name: 'Dana Reyes' }
  ],
  morePeople: 0,
  invited: [],
  tasks: [
    { id: 't1', title: 'Send the roster', dueAt: at, why: 'asked', who: 'Maya Chen' },
    { id: 't2', title: 'Chair quote', why: 'waiting', who: 'Tom Beck' }
  ],
  files: [{ title: 'Roster', url: home }],
  last: {
    eventId: 'ev0', title: 'Staff sync', startsAt: at - 7 * 86_400_000,
    decided: [{ text: 'Use Room 204' }], open: [{ text: 'Who brings chairs?' }], tasks: [{ id: 't0', title: 'Order jerseys' }]
  },
  doc: {
    people: [],
    brief: { matters: [{ text: 'Review the budget', ref: { table: 'mailThreads', id: 'm1' } }], agreed: [{ text: 'Order ten chairs' }], files: [], at, by: 'brief-1' },
    notes: { text: 'Maya sends the roster.\nTom checks the chair quote.', at },
    after: {
      summary: [{ text: 'Reviewed the budget' }], decisions: [{ text: 'Ask for two quotes' }], questions: [{ text: 'When will they arrive?' }],
      tasks: [{ id: 's1', title: 'Get the quote', who: 'Tom Beck', state: 'filed', lifeosTaskId: 't3' }], at
    }
  },
  rev: 4,
  state: 'after',
  briefSessionId: 'brief-1',
  followSessionId: 'follow-1',
  briefUntil: null,
  followUntil: null,
  briefStartedAt: null,
  followStartedAt: null,
  drafts: [],
  notesFile: null,
  aheadOn: false,
  aheadOffered: false,
  problems: []
}

describe('words for a prep thread', () => {
  it('writes the event facts, people, mail, tasks, links and page history as lines', () => {
    const text = pageWords(page)
    expect(text).toMatch(/^Meeting: Staff sync \(event ev1\)\nWhen: .*Nov 23.* at .*\nEnds: .*\nPlace: Room 204/)
    expect(text).toMatch(/Send the roster, asked by Maya Chen, due .*Nov 23.* \(task t1\)/)
    for (const line of [
      'Maya Chen <maya@x.test>, newest mail “Arena budget” (mail thread m1)',
      'Tom Beck <tom@x.test>, declined', 'Dana Reyes', 'Chair quote, waiting on Tom Beck (task t2)', `Roster ${home}`,
      'Last time: Staff sync', 'Use Room 204', 'Who brings chairs?', 'Order jerseys (task t0)',
      'Review the budget (mailThreads m1)', 'Order ten chairs', 'Maya sends the roster.\nTom checks the chair quote.',
      'Reviewed the budget', 'Ask for two quotes', 'When will they arrive?', 'Get the quote, Tom Beck (filed, task t3)'
    ]) expect(text).toContain(line)
    expect(text).not.toContain('|')
  })

  it('draws an all-day event without a clock time', () => {
    const text = pageWords({ ...page, event: { ...page.event, allDay: true } })
    expect(text).toMatch(/^When: .*Nov 23.*, all day$/m)
    expect(text).not.toMatch(/^Ends:/m)
  })

  it('names the brief thread and asks for the newest mail, changes and a short brief', () => {
    expect(briefTitle(page.event.title)).toBe('Prepare: Staff sync')
    const text = briefMessage(page)
    expect(text.startsWith(pageWords(page))).toBe(true)
    expect(text).toContain('read_mail_thread')
    expect(text).toContain('Look for what changed since last time.')
    expect(text).toContain('Call prep_write')
    expect(text).toContain('at most five things')
    expect(text).toContain('Use agreed only when no earlier page says it.')
    expect(text).toContain('Send nothing and add no task.')
    expect(text.endsWith('End with the brief as your last message.')).toBe(true)
  })

  it('names the follow-up thread and asks for an outcome and one held draft from his notes', () => {
    expect(followTitle(page.event.title)).toBe('Follow up: Staff sync')
    const text = followMessage(page)
    expect(text.startsWith(pageWords(page))).toBe(true)
    expect(text).toContain('Use his notes. Call prep_follow_up')
    expect(text).toContain('Never call add_task.')
    expect(text).toContain('If the page lists no follow-up mail already waiting, draft one to the people with addresses using draft_mail. It waits for his press. Never send it.')
    expect(text.endsWith('End with the outcome as your last message.')).toBe(true)
  })
  it('lists a follow-up mail that already waits, so a second follow-up drafts no second one', () => {
    const waiting: PrepPage = { ...page, drafts: [{ outboxId: 'ob1', subject: 'Staff sync follow-up', to: ['Maya Chen', 'tom@x.test'] }] }
    expect(pageWords(waiting)).toContain('Follow-up mail already waiting for his press in the Outbox:\n- “Staff sync follow-up” to Maya Chen, tom@x.test')
    expect(pageWords(page)).not.toContain('already waiting for his press')
  })

  it('tells a recording’s thread that prep_read waits for the file, and never to read in a loop', () => {
    const text = followMessage(page, { recording: true })
    expect(text).toContain('Call prep_read first: it waits until the file has arrived and names the meeting. Then read it with meeting_read, which waits while it is transcribed.')
    expect(text).not.toContain('read again')
  })

  it('asks a stopped follow-up thread again for the meeting beside it, and for a mail only if none waits', () => {
    const recorded: PrepPage = { ...page, notesFile: { kind: 'meeting', itemId: 'it1', title: 'Staff sync.m4a' } }
    const text = followAgainMessage(recorded)
    expect(text).toContain(pageWords(recorded))
    expect(text).toContain('open beside this thread as meeting it1. Read it with meeting_read.')
    expect(text).toContain('Read the meeting beside you with meeting_read. Call prep_follow_up')
    expect(text).toContain('never call add_task')
    expect(text).toContain('If the page lists no follow-up mail already waiting, draft one to the people with addresses using draft_mail. It waits for his press. Never send it.')
    expect(text.endsWith('End with the outcome as your last message.')).toBe(true)
  })
})
