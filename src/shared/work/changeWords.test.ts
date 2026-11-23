import { describe, expect, it } from 'vitest'
import { changeWords } from './changeWords'

describe('changeWords: the words a replace changes', () => {
  it('cuts the words both sides share', () => {
    expect(changeWords('The Spring LAN comes to $4,180', 'The Spring LAN comes to $4,320, with $140 more for prizes')).toBe('"$4,180" to "$4,320, with $140 more for prizes"')
    expect(changeWords('Thursday at 7 AM', 'Thursday at 6:30 AM')).toBe('"7" to "6:30"')
    expect(changeWords('March', 'May')).toBe('"March" to "May"')
  })
  it('keeps the word beside an insertion or a removal', () => {
    expect(changeWords('Six players and two staff', 'Six players and two staff and a van')).toBe('"staff" to "staff and a van"')
    expect(changeWords('very tight budget', 'tight budget')).toBe('"very tight" to "tight"')
  })
  it('shows both whole when they differ only in their spaces, and cuts each side to its limit', () => {
    expect(changeWords('a b', 'a  b')).toBe('"a b" to "a  b"')
    expect(changeWords('x', 'y'.repeat(80))).toBe(`"x" to "${'y'.repeat(59)}…"`)
  })
})
