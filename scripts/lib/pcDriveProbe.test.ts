import { describe, expect, it } from 'vitest'
import { callLine, callName, median, sumCalls, type Call } from './pcDriveProbe'

const call = (method: string, ms: number | null, o: Partial<Call> = {}): Call => ({ link: 'local', method, params: {}, at: 0, ms, ok: ms === null ? null : true, size: null, n: null, ...o })

describe('the PC drive bench sums', () => {
  it('names an across call by the method it carries', () => {
    expect(callName({ method: 'work.files.across', inner: 'work.files.list' })).toBe('work.files.across→work.files.list')
    expect(callName({ method: 'work.files.list' })).toBe('work.files.list')
  })

  it('sums calls per name, the slowest name first, and counts failed and unanswered ones', () => {
    const sums = sumCalls([
      call('work.files.stat', 300, { size: 100 }),
      call('work.files.list', 9800, { size: 5000 }),
      call('work.files.stat', 400, { size: 100 }),
      call('work.files.stat', null),
      call('work.files.read', 50, { ok: false })
    ])
    expect(sums.map((s) => s.name)).toEqual(['work.files.list', 'work.files.stat', 'work.files.read'])
    expect(sums[1]).toMatchObject({ n: 3, maxMs: 400, sumMs: 700, size: 200, pending: 1 })
    expect(sums[2]).toMatchObject({ failed: 1 })
  })

  it('says where the time went in one line', () => {
    const line = callLine([call('work.files.list', 9800, { size: 3 * 2 ** 20 }), call('work.files.stat', 300)])
    expect(line).toBe('1× work.files.list (slowest 9.80 s, 3.0 MB answered); 1× work.files.stat (slowest 0.30 s)')
  })

  it('takes the median of what was measured', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(2.5)
    expect(median([NaN, 5])).toBe(5)
    expect(median([])).toBeNaN()
  })
})
