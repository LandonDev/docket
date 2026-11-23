import { describe, expect, it } from 'vitest'
import { changeWords } from './changeWords'

describe('changeWords: the words a replace changes', () => {
  it('cuts the words both sides share', () => {
    expect(changeWords('The Spring LAN comes to $4,180', 'The Spring LAN comes to $4,320, with $140 more for prizes')).toBe('"$4,180" to "$4,320, with $140 more for prizes"')
    expect(changeWords('Thursday at 7 AM', 'Thursday at 6:30 AM')).toBe('"7 AM" to "6:30 AM"')
    expect(changeWords('due Friday', 'due Monday')).toBe('"due Friday" to "due Monday"')
    expect(changeWords('March', 'May')).toBe('"March" to "May"')
  })
  it('keeps the word beside an insertion or a removal', () => {
    expect(changeWords('Six players and two staff', 'Six players and two staff and a van')).toBe('"staff" to "staff and a van"')
    expect(changeWords('very tight budget', 'tight budget')).toBe('"very tight" to "tight"')
  })
  it('shows both whole when they differ only in their spaces, and cuts each side to its limit', () => {
    expect(changeWords('a b', 'a  b')).toBe('"a b" to "a  b"')
    // a character that cannot be seen is written as its escape
    expect(changeWords('ab', 'a\u200bb')).toBe('"ab" to "a\\u200bb"')
    expect(changeWords('x', 'y'.repeat(80))).toBe(`"x" to "${'y'.repeat(59)}…"`)
    // one long word changed past the cut reads where it differs
    const url = `https://purdue0.sharepoint.com/sites/esports/Shared%20Documents/Budgets/spring-lan-budget-`
    expect(changeWords(`${url}draft`, `${url}final`)).toBe('"…s/spring-lan-budget-draft" to "…s/spring-lan-budget-final"')
  })
})
