import { describe, expect, it } from 'vitest'
import type { MsAnyQuestion } from '@shared/work/msforms'
import { choiceOf, OTHER, seriesOf } from './series'

const got = {
  count: 4,
  columns: [
    { id: 'id', label: 'Id' },
    { id: 'done', label: 'Completion time' },
    { id: 'email', label: 'Email' },
    { id: 'q0', label: 'Your name' },
    { id: 'q1', label: 'Which night?' },
    { id: 'q2', label: 'Games' }
  ],
  rows: [
    ['4', '2026-11-25 10:00', 'dana@purdue.edu', 'Dana Lee', 'Tuesday', 'Valorant;Rocket League;'],
    ['3', '2026-11-24 15:00', 'sam@purdue.edu', 'Sam Roy', 'tuesday', 'Valorant;'],
    ['2', '2026-11-24 12:00', 'ali@purdue.edu', 'Ali Khan', 'Monday', ''],
    ['1', '2026-11-23 09:00', 'jo@purdue.edu', 'Jo Park', 'Late night with Jo', 'Chess;']
  ]
}

const questions: MsAnyQuestion[] = [
  { title: 'Your name', type: 'text', required: true },
  { ref: 'r1', title: 'Which night?', type: 'choice', options: ['Monday', 'Tuesday', 'Wednesday'], required: false },
  { title: 'Games', type: 'choice', multiple: true, options: ['Valorant', 'Rocket League'], required: false }
]

const night = { ...choiceOf(questions, 'Which night?')!, column: 4 }

describe('a form as a dashboard source', () => {
  it('counts a choice question by its declared options alone, and every other answer under one fixed label', () => {
    const values = seriesOf(got, 'option:Which night?', night).map((r) => r[0]!.v)
    const labels = seriesOf(got, 'option:which night?#labels', night).map((r) => r[0]!.v)
    expect(labels).toEqual(['Monday', 'Tuesday', 'Wednesday', OTHER])
    expect(values).toEqual([1, 2, 0, 1])
    // an answer's own words never become a label
    expect(labels).not.toContain('Late night with Jo')
  })

  it('counts each option picked in a many-answer choice', () => {
    const games = { ...choiceOf(questions, 'Games')!, column: 5 }
    expect(seriesOf(got, 'option:Games#labels', games).map((r) => r[0]!.v)).toEqual(['Valorant', 'Rocket League', OTHER])
    expect(seriesOf(got, 'option:Games', games).map((r) => r[0]!.v)).toEqual([2, 1, 1])
  })

  it('resolves only a choice question of the form, by its title or Forms id: never a name, an address or a text answer', () => {
    expect(choiceOf(questions, 'which night?')).toEqual({ index: 1, options: ['Monday', 'Tuesday', 'Wednesday'] })
    expect(choiceOf(questions, 'r1')?.index).toBe(1)
    for (const named of ['Your name', 'Email', 'Name', 'Completion time', 'Shirt size']) expect(choiceOf(questions, named), named).toBeNull()
    expect(() => seriesOf(got, 'option:Your name')).toThrow('no choice question "Your name"')
  })

  it('counts nothing for a question the answers have no column of yet, with its options as labels', () => {
    expect(seriesOf(got, 'option:Which night?#labels', { ...night, column: -1 }).map((r) => r[0]!.v)).toEqual(['Monday', 'Tuesday', 'Wednesday'])
    expect(seriesOf(got, 'option:Which night?', { ...night, column: -1 }).map((r) => r[0]!.v)).toEqual([0, 0, 0])
  })

  it('counts answers per day, oldest first, and the whole count', () => {
    expect(seriesOf(got, 'day#labels').map((r) => r[0]!.v)).toEqual(['2026-11-23', '2026-11-24', '2026-11-25'])
    expect(seriesOf(got, 'day').map((r) => r[0]!.v)).toEqual([1, 2, 1])
    expect(seriesOf(got, 'count')).toEqual([[{ at: 'A1', v: 4 }]])
  })

  it('refuses a range it does not know', () => {
    expect(() => seriesOf(got, 'A1:B2')).toThrow('count, option:<question> or day')
  })
})
