import { describe, expect, it } from 'vitest'
import { cpuTimeSeconds, idleGate, percentile } from './videoProof'

describe('the video proofs\' helpers', () => {
  it('reads ps cputime in each of its forms', () => {
    expect(cpuTimeSeconds('0:01.25')).toBeCloseTo(1.25)
    expect(cpuTimeSeconds(' 12:03.50\n')).toBeCloseTo(723.5)
    expect(cpuTimeSeconds('1:02:03.00')).toBeCloseTo(3723)
    expect(cpuTimeSeconds('2-01:00:00')).toBeCloseTo(2 * 86_400 + 3_600)
  })

  it('takes the nearest rank, and 0 of nothing', () => {
    expect(percentile([], 0.95)).toBe(0)
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3)
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 0.95)).toBe(95)
  })

  it('opens the gate at five idle minutes and says why it never opened', async () => {
    expect((await idleGate(() => 301, () => {})).ok).toBe(true)
    const shut = await idleGate(() => 12, () => {}, { waitMs: 0 })
    expect(shut.ok).toBe(false)
    expect(shut.why).toMatch(/no idle gap in 45 min/)
  })
})
