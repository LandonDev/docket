import { describe, expect, it } from 'vitest'
import { matchQuote, quoteIndex, tokensOf, type QuoteSegment } from './quotes'

const segs: QuoteSegment[] = [
  { id: 's1', start: 3, end: 5.4, text: "Okay, let's get started." },
  { id: 's2', start: 5.9, end: 9.3, text: "Um, I'll share the budget sheet first, and then the schedule." },
  {
    id: 's3',
    start: 9.5,
    end: 12,
    text: 'We decided the finals move to Friday. Is that okay?',
    words: [
      { w: 'We', s: 9.5, e: 9.7 },
      { w: 'decided', s: 9.7, e: 10.1 },
      { w: 'the', s: 10.1, e: 10.2 },
      { w: 'finals', s: 10.2, e: 10.6 },
      { w: 'move', s: 10.6, e: 10.8 },
      { w: 'to', s: 10.8, e: 10.9 },
      { w: 'Friday.', s: 10.9, e: 11.3 },
      { w: 'Is', s: 11.4, e: 11.5 },
      { w: 'that', s: 11.5, e: 11.7 },
      { w: 'okay?', s: 11.7, e: 12 }
    ]
  },
  { id: 's4', start: 40, end: 44, text: 'The room is $2,400 with the RecWell discount, so it is inside the line.' },
  { id: 's5', start: 90, end: 93, text: 'We decided the finals move to Friday after all.' }
]
const index = quoteIndex(segs)

describe('tokensOf', () => {
  it('sets case, apostrophes and punctuation aside', () => {
    expect(tokensOf("I'll send $2,400, okay?")).toEqual(['ill', 'send', '2', '400', 'okay'])
  })
})

describe('matchQuote', () => {
  it('answers the transcript\'s own words and where they start', () => {
    const hit = matchQuote('is that okay', index)!
    expect(hit.text).toBe('Is that okay')
    expect(hit.segIds).toEqual(['s3'])
    // The words' own times, not the turn's.
    expect([hit.start, hit.end, hit.score]).toEqual([11.4, 12, 1])
  })

  it('keeps the transcript verbatim when the writer drops a filler or changes the case', () => {
    const hit = matchQuote("I'll share the budget sheet first, and then the schedule", index)!
    expect(hit.text).toBe("I'll share the budget sheet first, and then the schedule")
    expect(hit.score).toBe(1)
    // No word times here: the start is read off the turn in proportion.
    expect(hit.start).toBeGreaterThan(5.9)
    expect(hit.start).toBeLessThan(7)
  })

  it('finds a quote that runs over two turns', () => {
    const hit = matchQuote('and then the schedule. We decided the finals', index)!
    expect(hit.segIds).toEqual(['s2', 's3'])
    expect(hit.text).toBe('and then the schedule. We decided the finals')
  })

  it('reads money and numbers as the transcript writes them', () => {
    expect(matchQuote('the room is $2,400 with the RecWell discount', index)!.text).toBe('The room is $2,400 with the RecWell discount')
  })

  it('lets one misheard word in ten pass and returns what was said', () => {
    const hit = matchQuote('the room is 2,400 with the RecWell discount so it is inside the lane', index)!
    expect(hit.text).toBe('The room is $2,400 with the RecWell discount, so it is inside the line')
    expect(hit.score).toBeGreaterThanOrEqual(0.9)
    expect(hit.score).toBeLessThan(1)
  })

  it('refuses a paraphrase, an invention and a single common word', () => {
    expect(matchQuote('The finals were moved to Friday by the team', index)).toBeNull()
    expect(matchQuote('We will cancel the spring season', index)).toBeNull()
    expect(matchQuote('the', index)).not.toBeNull() // one word said verbatim is a quote
    expect(matchQuote('they', index)).toBeNull()
    expect(matchQuote('', index)).toBeNull()
  })

  it('takes the match in or nearest the turns the writer named when the words were said twice', () => {
    expect(matchQuote('we decided the finals move to Friday', index)!.segIds).toEqual(['s3'])
    expect(matchQuote('we decided the finals move to Friday', index, { near: ['s5'] })!.segIds).toEqual(['s5'])
  })

  it('falls back to spreading times across a turn whose text was edited away from its words', () => {
    const edited = quoteIndex([{ ...segs[2], text: 'We decided the finals move to Friday night. Is that okay?' }])
    const hit = matchQuote('is that okay', edited)!
    expect(hit.start).toBeGreaterThan(9.5)
    expect(hit.end).toBe(12)
  })
})
