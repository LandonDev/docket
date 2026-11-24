import { afterEach, describe, expect, it } from 'vitest'
import { ANSWERS_MOST, type MsAnyQuestion } from '@shared/work/msforms'
import { ANSWERS_KEEP_MS, cachedAnswers, clearAnswers, forgetAnswers, forgetWorkspaceAnswers, keepAnswers, markAnswersStale, shownAnswers } from './cache'
import { AnswersUnreadable, answersOf } from './parse'
import { formsWorkbook, madeUpAnswers, serialOf } from './testWorkbook'

/** The answers workbook read (parse.ts) and the memory it is kept in (cache.ts), on made-up workbooks of the trial's shape. */

const QUESTIONS: MsAnyQuestion[] = [
  { title: 'Which dummy colour do you pick?', type: 'choice', options: ['Red', 'Green', 'Blue'], required: true },
  { title: 'Section two', type: 'section', required: false },
  { title: 'Write a made-up word', type: 'text', required: false },
  { title: 'Pick a made-up date', type: 'date', required: false }
]

describe('answersOf', () => {
  it("reads the trial's table by header name: Forms' five, the questions by title, a renamed one by its own header, newest first", () => {
    // the third question was renamed in the page since the list was cached; the header case differs on the first
    const bytes = formsWorkbook(['WHICH dummy colour do you pick?', 'Write a made-up word', 'Pick a date, renamed'], [
      { id: 1, start: serialOf('2026-11-24T09:00:00'), end: serialOf('2026-11-24T09:01:30'), email: 'dummy1@example.test', name: 'Dummy One', answers: ['Red', 'Zorble', '11/30/2026'] },
      { id: 2, start: serialOf('2026-11-24T10:15:00'), end: serialOf('2026-11-24T10:16:00'), email: 'dummy2@example.test', name: 'Dummy Two', answers: ['Blue', 'Quandle', '12/1/2026'] }
    ])
    const got = answersOf(bytes, QUESTIONS)
    expect(got.columns).toEqual([
      { id: 'id', label: 'Id' },
      { id: 'start', label: 'Start time' },
      { id: 'end', label: 'Completion time' },
      { id: 'email', label: 'Email' },
      { id: 'name', label: 'Name' },
      { id: 'q0', label: 'Which dummy colour do you pick?' },
      { id: 'q2', label: 'Write a made-up word' },
      { id: 'c7', label: 'Pick a date, renamed' }
    ])
    expect(got.rows).toEqual([
      ['2', '2026-11-24 10:15', '2026-11-24 10:16', 'dummy2@example.test', 'Dummy Two', 'Blue', 'Quandle', '12/1/2026'],
      ['1', '2026-11-24 09:00', '2026-11-24 09:01', 'dummy1@example.test', 'Dummy One', 'Red', 'Zorble', '11/30/2026']
    ])
    expect(got).toMatchObject({ count: 2, cut: false, maxId: 2 })
    expect(got.lastAnswerAt).toBe(new Date(2026, 10, 24, 10, 16).getTime())
  })

  it(`keeps the newest ${ANSWERS_MOST} past that many, and says so`, () => {
    const n = ANSWERS_MOST + 7
    const got = answersOf(formsWorkbook(['Write a made-up word'], madeUpAnswers(n, (i) => [`word ${i + 1}`])), QUESTIONS)
    expect(got).toMatchObject({ count: n, cut: true, maxId: n })
    expect(got.rows).toHaveLength(ANSWERS_MOST)
    expect(got.rows[0]![0]).toBe(String(n))
    expect(got.rows.at(-1)![0]).toBe('8')
  })

  it('reads an empty table as no answers, and refuses a workbook with no Forms table without quoting it', () => {
    expect(answersOf(formsWorkbook(['Write a made-up word'], []), QUESTIONS)).toMatchObject({ rows: [], count: 0, maxId: 0, lastAnswerAt: null })
    expect(() => answersOf(formsWorkbook(['Write a made-up word'], madeUpAnswers(1, () => ['Zorble']), { table: 'Ledger' }), QUESTIONS)).toThrow(AnswersUnreadable)
    expect(() => answersOf(new TextEncoder().encode('Zorble is not a workbook'), QUESTIONS)).toThrow('The answers workbook could not be read.')
  })
})

describe('the answers memory', () => {
  afterEach(() => clearAnswers())
  const some = answersOf(formsWorkbook(['Write a made-up word'], madeUpAnswers(1, () => ['Zorble'])), QUESTIONS)

  it('drops a form 30 minutes after it was last shown, and a show starts them again', () => {
    keepAnswers('w1', 'f1', some, null, 0)
    shownAnswers('w1', 'f1', ANSWERS_KEEP_MS - 1)
    expect(cachedAnswers('w1', 'f1', 2 * ANSWERS_KEEP_MS - 2)).not.toBeNull()
    expect(cachedAnswers('w1', 'f1', 2 * ANSWERS_KEEP_MS - 1)).toBeNull()
  })

  it('marks rows stale, and forgets a form, a job, and everything at a restart', () => {
    const now = Date.now()
    keepAnswers('w1', 'f1', some, null, now)
    keepAnswers('w1', 'f2', some, null, now)
    keepAnswers('w2', 'f3', some, null, now)
    markAnswersStale('w1', 'f1')
    expect(cachedAnswers('w1', 'f1', now)?.stale).toBe(true)
    forgetAnswers('w1', 'f1')
    expect(cachedAnswers('w1', 'f1', now)).toBeNull()
    forgetWorkspaceAnswers('w1')
    expect([cachedAnswers('w1', 'f2', now), cachedAnswers('w2', 'f3', now)?.answers.count]).toEqual([null, 1])
    clearAnswers()
    expect(cachedAnswers('w2', 'f3', now)).toBeNull()
  })
})
