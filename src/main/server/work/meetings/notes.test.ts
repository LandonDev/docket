import { describe, expect, it } from 'vitest'
import type { DocSegment } from './merge'
import { checkNotes, NotesInputSchema, undoneNotes } from './notes'

const segments: DocSegment[] = [
  { id: 's1', speaker: 'S1', start: 652, end: 660, text: 'On nationals: I need the final number by Friday, or it misses this quarter\'s request.' },
  { id: 's2', speaker: 'S2', start: 680, end: 688, text: "I'll send it Friday. Flights and hotel are in; I'm waiting on the registration fee." },
  { id: 's3', speaker: 'S2', start: 941, end: 948, text: "It's $2,400 with the RecWell discount, so it's inside the line." },
  { id: 's4', speaker: 'S2', start: 1000, end: 1004, text: "Then let's book it. I'll send the form today." }
]

describe('checkNotes', () => {
  it('keeps a line that names real turns, and plays it from the first', () => {
    const { notes, dropped } = checkNotes({ decisions: [{ text: 'The LAN is in the ballroom', refs: ['s3', 's4'] }] }, segments, null, 5)
    expect(dropped).toEqual([])
    expect(notes.decisions).toEqual([{ id: 'd1', text: 'The LAN is in the ballroom', refs: ['s3', 's4'], at: 941 }])
    expect(notes.writtenAt).toBe(5)
  })

  it('replaces a quote with the transcript\'s own words and ties the line to the turn it was found in', () => {
    const { notes, dropped } = checkNotes({ decisions: [{ text: 'The room costs $2,400', quote: 'its 2,400 with the recwell discount' }] }, segments, null)
    expect(dropped).toEqual([])
    expect(notes.decisions[0].quote).toBe("It's $2,400 with the RecWell discount")
    expect(notes.decisions[0].refs).toEqual(['s3'])
    expect(notes.decisions[0].at).toBeGreaterThanOrEqual(941)
    expect(notes.decisions[0].at).toBeLessThan(948)
  })

  it('every quote kept is in the transcript: a paraphrase is left off, and a line resting on nothing else is dropped', () => {
    const { notes, dropped } = checkNotes(
      {
        summary: [{ text: 'They agreed the budget was fine', quote: 'everyone agreed the budget looked great' }],
        decisions: [{ text: 'The ballroom is booked', refs: ['s4'], quote: 'we have booked the ballroom already' }]
      },
      segments,
      null
    )
    expect(notes.summary).toEqual([])
    expect(notes.decisions).toHaveLength(1)
    expect(notes.decisions[0].quote).toBeUndefined()
    expect(dropped).toHaveLength(3)
    expect(dropped.join('\n')).toMatch(/is not in the transcript/)
    expect(dropped.join('\n')).toMatch(/was not kept/)
    // Whatever was kept and quotes something quotes the transcript.
    const text = segments.map((s) => s.text).join(' ')
    for (const n of [...notes.summary, ...notes.decisions, ...notes.questions, ...notes.actions]) if (n.quote) expect(text).toContain(n.quote)
  })

  it('drops a segment id that does not exist and says which', () => {
    const { notes, dropped } = checkNotes({ questions: [{ text: 'Can the drop carry 24 stations?', refs: ['s2', 's99'] }, { text: 'Who covers Dec 3?', refs: ['s41'] }] }, segments, null)
    expect(notes.questions.map((q) => [q.id, q.refs])).toEqual([['q1', ['s2']]])
    expect(dropped.filter((d) => d.includes('there is no segment'))).toHaveLength(2)
  })

  it('a task waits as proposed; one LifeOS already holds is shown as filed and never proposed', () => {
    const { notes } = checkNotes(
      {
        actions: [
          { text: 'Send Dana the nationals budget', refs: ['s2'], due: '2026-11-20' },
          { text: 'Order badge printer ribbon', refs: ['s4'], lifeosTaskId: 'k57' }
        ]
      },
      segments,
      null
    )
    expect(notes.actions.map((a) => [a.id, a.state, a.due, a.lifeosTaskId])).toEqual([
      ['a1', 'proposed', '2026-11-20', undefined],
      ['a2', 'filed', undefined, 'k57']
    ])
  })

  it('a rewrite keeps the owner\'s word: a filed task stays filed, a rejected one stays rejected, and a filed one left out is kept', () => {
    const first = checkNotes({ actions: [{ text: 'Send Dana the budget', refs: ['s2'] }, { text: 'Book the ballroom', refs: ['s4'] }, { text: 'Call Sam', refs: ['s1'] }] }, segments, null).notes
    first.actions[0] = { ...first.actions[0], state: 'filed', lifeosTaskId: 'k1' }
    first.actions[1] = { ...first.actions[1], state: 'rejected' }
    first.actions[2] = { ...first.actions[2], state: 'filed', lifeosTaskId: 'k3' }
    const { notes } = checkNotes({ actions: [{ text: 'Book the ballroom.', refs: ['s4'] }, { text: 'send dana the budget', refs: ['s2'] }, { text: 'Ask about power', refs: ['s3'] }] }, segments, first)
    expect(notes.actions.map((a) => [a.id, a.text, a.state, a.lifeosTaskId])).toEqual([
      ['a1', 'Book the ballroom.', 'rejected', undefined],
      ['a2', 'send dana the budget', 'filed', 'k1'],
      ['a3', 'Ask about power', 'proposed', undefined],
      ['a4', 'Call Sam', 'filed', 'k3']
    ])
  })

  it('the input schema refuses a due date that is not a date', () => {
    expect(NotesInputSchema.safeParse({ actions: [{ text: 'x', refs: ['s1'], due: 'Friday' }] }).success).toBe(false)
    expect(NotesInputSchema.safeParse({ actions: [{ text: 'x', refs: ['s1'], due: '2026-11-20' }] }).success).toBe(true)
    expect(NotesInputSchema.safeParse({ actions: [{ text: 'x', refs: ['s1'], due: '2026-11-20T15:00:00-05:00' }] }).success).toBe(true)
  })
})

describe('undoneNotes', () => {
  it('puts back what was there before, and never loses a task filed since', () => {
    const before = checkNotes({ decisions: [{ text: 'Old decision', refs: ['s1'] }] }, segments, null, 1).notes
    const current = checkNotes({ decisions: [{ text: 'New decision', refs: ['s3'] }], actions: [{ text: 'Book the ballroom', refs: ['s4'] }, { text: 'Call Sam', refs: ['s1'] }] }, segments, before, 2).notes
    current.actions[0] = { ...current.actions[0], state: 'filed', lifeosTaskId: 'k2' }
    const undone = undoneNotes(current, before)!
    expect(undone.decisions.map((d) => d.text)).toEqual(['Old decision'])
    expect(undone.actions.map((a) => [a.id, a.text, a.state])).toEqual([['a1', 'Book the ballroom', 'filed']])
    expect(undoneNotes(checkNotes({ summary: [{ text: 'x', refs: ['s1'] }] }, segments, null).notes, null)).toBeNull()
  })
})
