import { describe, expect, it } from 'vitest'
import { durationOf } from './duration'

describe("Work's one duration form", () => {
  it('says minutes, hours, and hours with minutes, never a bare letter', () => {
    expect(durationOf(12)).toBe('12 min')
    expect(durationOf(60)).toBe('1 hr')
    expect(durationOf(70)).toBe('1 hr 10 min')
    expect(durationOf(990)).toBe('16 hr 30 min')
    expect(durationOf(-3)).toBe('0 min')
    expect(durationOf(37.6)).toBe('38 min')
  })
})
