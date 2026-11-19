import { describe, expect, it } from 'vitest'
import { writeSuggests } from './internalSheet'

describe("a LifeOS bot's write to a sheet", () => {
  it('waits as suggestions on a shared sheet whatever reason it gives, and writes on one only the owner sees', () => {
    // The route never reads `because` for this: "asked" and "routine" are the model's word, which only main can check.
    expect(writeSuggests(false, true)).toBe(true)
    expect(writeSuggests(false, false)).toBe(false)
    expect(writeSuggests(true, false)).toBe(true)
  })
})
