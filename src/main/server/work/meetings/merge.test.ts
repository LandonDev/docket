import { describe, expect, it } from 'vitest'
import { foldStrays, Merger, SEGMENT_LONG_SEC, segmentsOf, speakerIds } from './merge'
import type { RawTurn, RawWord } from './raw'

const words = (start: number, text: string, step = 0.4): RawWord[] => text.split(' ').map((w, i) => ({ w, s: start + i * step, e: start + i * step + step * 0.9 }))

describe('speakerIds', () => {
  it('numbers speakers by who is heard first, whatever the transcriber called them', () => {
    const turns: RawTurn[] = [
      { speaker: 3, start: 5, end: 8 },
      { speaker: 0, start: 1, end: 4 },
      { speaker: 3, start: 9, end: 10 }
    ]
    expect([...speakerIds(turns)]).toEqual([
      [0, 'S1'],
      [3, 'S2']
    ])
  })
})

describe('segmentsOf', () => {
  const turns: RawTurn[] = [
    { speaker: 0, start: 0, end: 4 },
    { speaker: 1, start: 4, end: 9 },
    { speaker: 0, start: 20, end: 24 }
  ]

  it('gives each word the turn it overlaps most and joins one speaker\'s run into a segment', () => {
    const { segments, speakers } = segmentsOf([...words(0.2, 'Okay let us start.'), ...words(4.3, 'Sounds good to me.'), ...words(20.1, 'Then we are done.')], turns)
    expect(speakers).toEqual(['S1', 'S2'])
    expect(segments.map((s) => [s.id, s.speaker, s.text])).toEqual([
      ['s1', 'S1', 'Okay let us start.'],
      ['s2', 'S2', 'Sounds good to me.'],
      ['s3', 'S1', 'Then we are done.']
    ])
    expect(segments[0].start).toBe(0.2)
    expect(segments[0].words).toHaveLength(4)
  })

  it('a word that straddles two turns goes to the one holding more of it', () => {
    const { segments } = segmentsOf([{ w: 'well', s: 3.9, e: 4.5 }], turns)
    expect(segments[0].speaker).toBe('S2')
  })

  it('a word in no turn takes the nearest turn in time', () => {
    const { segments } = segmentsOf([{ w: 'late', s: 10, e: 10.3 }, { w: 'early', s: 18.5, e: 18.8 }], turns)
    expect(segments.map((s) => s.speaker)).toEqual(['S2', 'S1'])
  })

  it('a pause of a second and a half starts a new segment for the same speaker', () => {
    const { segments } = segmentsOf([...words(0, 'One two.'), ...words(2.5, 'Three four.')], [{ speaker: 0, start: 0, end: 5 }])
    expect(segments.map((s) => s.text)).toEqual(['One two.', 'Three four.'])
  })

  it('a monologue is cut at a sentence end once it passes the long mark, never mid-sentence', () => {
    const long: RawWord[] = []
    for (let i = 0; i < 40; i++) long.push(...words(i * 2, `Sentence number ${i} ends here.`, 0.38))
    const { segments } = segmentsOf(long, [{ speaker: 0, start: 0, end: 90 }])
    expect(segments.length).toBeGreaterThan(1)
    for (const s of segments.slice(0, -1)) {
      expect(s.text.endsWith('.')).toBe(true)
      expect(s.end! - s.start).toBeGreaterThanOrEqual(SEGMENT_LONG_SEC)
      expect(s.end! - s.start).toBeLessThan(SEGMENT_LONG_SEC + 4)
    }
  })

  it('with no turns at all the words are one unnamed speaker\'s', () => {
    const { segments, speakers } = segmentsOf(words(0, 'Nobody was found.'), [])
    expect(speakers).toEqual([])
    expect(segments).toHaveLength(1)
    expect(segments[0].speaker).toBeNull()
  })
})

describe('Merger', () => {
  it('builds the same segments word by word as all at once, and earlier segments never change', () => {
    const turns: RawTurn[] = [
      { speaker: 0, start: 0, end: 4 },
      { speaker: 1, start: 4, end: 9 }
    ]
    const all = [...words(0.2, 'Okay let us start.'), ...words(4.3, 'Sounds good to me.'), ...words(6.5, 'And one more.')]
    const merger = new Merger(turns)
    merger.add(all.slice(0, 5))
    const early = merger.segments()
    expect(early.map((s) => s.id)).toEqual(['s1', 's2'])
    merger.add(all.slice(5))
    const late = merger.segments()
    expect(late[0]).toEqual(early[0])
    expect(late).toEqual(segmentsOf(all, turns).segments)
  })
})

describe('foldStrays', () => {
  const turns: RawTurn[] = [
    { speaker: 0, start: 0, end: 30 },
    { speaker: 1, start: 30, end: 70 },
    { speaker: 2, start: 70, end: 72 }, // a cough the clustering kept apart
    { speaker: 3, start: 100, end: 101 }
  ]

  it('folds a speaker heard for seconds into the larger one its voice is nearest', () => {
    const out = foldStrays(turns, { '0': [1, 0], '1': [0, 1], '2': [0.1, 0.9], '3': [0.9, 0.2] })
    expect(out.turns.map((t) => t.speaker)).toEqual([0, 1, 1, 0])
    expect(Object.keys(out.voices)).toEqual(['0', '1'])
  })

  it('with no voice to compare, a stray joins the speaker nearest in time', () => {
    const out = foldStrays(turns, { '0': [1, 0], '1': [0, 1] })
    expect(out.turns.map((t) => t.speaker)).toEqual([0, 1, 1, 1])
  })

  it('leaves a meeting of nothing but fragments as it was found', () => {
    const short: RawTurn[] = [
      { speaker: 0, start: 0, end: 2 },
      { speaker: 1, start: 2, end: 4 }
    ]
    expect(foldStrays(short, {}).turns).toEqual(short)
  })
})
