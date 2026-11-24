import { describe, expect, it } from 'vitest'
import { seriesOf } from './series'

const got = {
  count: 4,
  columns: [
    { id: 'id', label: 'Id' },
    { id: 'done', label: 'Completion time' },
    { id: 'q1', label: 'Which night?' }
  ],
  rows: [
    ['4', '2026-11-25 10:00', 'Tuesday'],
    ['3', '2026-11-24 15:00', 'Tuesday'],
    ['2', '2026-11-24 12:00', 'Monday'],
    ['1', '2026-11-23 09:00', 'Late night']
  ]
}

describe('a form as a dashboard source', () => {
  it('counts by a choice question’s options, then answers the options do not hold', () => {
    const values = seriesOf(got, 'option:Which night?', ['Monday', 'Tuesday', 'Wednesday']).map((r) => r[0]!.v)
    const labels = seriesOf(got, 'option:which night?#labels', ['Monday', 'Tuesday', 'Wednesday']).map((r) => r[0]!.v)
    expect(labels).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Late night'])
    expect(values).toEqual([1, 2, 0, 1])
  })

  it('counts answers per day, oldest first, and the whole count', () => {
    expect(seriesOf(got, 'day#labels').map((r) => r[0]!.v)).toEqual(['2026-11-23', '2026-11-24', '2026-11-25'])
    expect(seriesOf(got, 'day').map((r) => r[0]!.v)).toEqual([1, 2, 1])
    expect(seriesOf(got, 'count')).toEqual([[{ at: 'A1', v: 4 }]])
  })

  it('refuses a question the answers do not have, and a range it does not know', () => {
    expect(() => seriesOf(got, 'option:Shirt size')).toThrow('no question "Shirt size"')
    expect(() => seriesOf(got, 'A1:B2')).toThrow('count, option:<question> or day')
  })
})
