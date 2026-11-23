import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildsOf, transitionChanged, type BuildShape, type TimingNode } from './builds'

/**
 * The timing tree to steps (builds.ts), on the outlines the deck tool read from the two build decks
 * (`fixtures/steps-make.py`; steps.test.ts holds these outlines equal to what the tool reads today, behind the gate).
 */
type Fixture = Array<{ id: number; title: string; timing?: TimingNode; shapes: BuildShape[] }>
const read = (name: string): Fixture => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')) as Fixture
const kinds = read('steps-kinds.json')
const talk = read('steps-talk.json')
const slide = (deck: Fixture, title: string) => {
  const s = deck.find((x) => x.title === title)
  if (!s) throw new Error(`no slide ${title}`)
  return buildsOf(s.timing, s.shapes)
}
const none = { shapes: [], paras: [] }

describe('a slide\'s timing to the show\'s steps', () => {
  it('makes one step a press, each shape hidden until its press', () => {
    expect(slide(kinds, 'Click groups')).toEqual({
      steps: [{ shapes: [3, 4, 5], paras: [] }, { shapes: [4, 5], paras: [] }, { shapes: [5], paras: [] }, none],
      changed: 0,
      order: [3, 4, 5],
      fade: [3, 4, 5]
    })
  })

  it('folds with-previous and after-previous into their press', () => {
    expect(slide(kinds, 'With previous and after previous')).toEqual({ steps: [{ shapes: [3, 4, 5, 6], paras: [] }, { shapes: [6], paras: [] }, none], changed: 0 })
  })

  it('takes away what leaves: a shape there from the start is seen until its exit', () => {
    expect(slide(kinds, 'Exits')).toEqual({ steps: [{ shapes: [4], paras: [] }, { shapes: [3, 4], paras: [] }, { shapes: [3], paras: [] }], changed: 0 })
  })

  it('builds a text shape paragraph by paragraph, as runs', () => {
    expect(slide(kinds, 'Paragraphs one by one')!.steps).toEqual([
      { shapes: [], paras: [{ shape: 3, from: 0, to: 3 }] },
      { shapes: [], paras: [{ shape: 3, from: 1, to: 3 }] },
      { shapes: [], paras: [{ shape: 3, from: 2, to: 3 }] },
      { shapes: [], paras: [{ shape: 3, from: 3, to: 3 }] },
      none
    ])
    // two paragraphs in one press
    expect(slide(kinds, 'Paragraphs in the middle, shrunk to fit')!.steps).toEqual([
      { shapes: [], paras: [{ shape: 3, from: 0, to: 3 }] },
      { shapes: [], paras: [{ shape: 3, from: 1, to: 3 }] },
      { shapes: [], paras: [{ shape: 3, from: 2, to: 3 }] },
      none
    ])
  })

  it('plays what starts by itself as the slide comes', () => {
    expect(slide(kinds, 'After previous at the start')).toEqual({ steps: [{ shapes: [4], paras: [] }, none], changed: 0 })
  })

  it("leaves a video's own play and pause to the transport, and keeps the slide's other builds", () => {
    expect(slide(kinds, 'A video and a caption')).toEqual({ steps: [{ shapes: [4], paras: [] }, none], changed: 0 })
  })

  it('builds a group by its own id', () => {
    expect(slide(kinds, 'A group')).toEqual({ steps: [{ shapes: [3], paras: [] }, none], changed: 0 })
  })

  it('counts an entrance it plays as a fade where the file has another effect', () => {
    expect(slide(kinds, 'A picture flies in')).toEqual({ steps: [{ shapes: [3], paras: [] }, none], changed: 1 })
  })

  it.each([
    ['A trigger', 'a trigger'],
    ['An emphasis held', 'an emphasis that changes where things end'],
    ['A motion path', 'a motion path'],
    ['A nesting not known', 'a nesting the reader does not know'],
    ['A chart by series', 'an effect on a part of a shape the reader does not know']
  ])('shows %s whole, in one press, every effect counted', (title, why) => {
    const b = slide(kinds, title)!
    expect(b.steps).toEqual([none])
    expect(b.whole).toBe(why)
    expect(b.changed).toBeGreaterThanOrEqual(1)
  })

  it('reads the talk deck: bullets with a sub-point, a picture after its caption, an exit then an entrance', () => {
    expect(slide(talk, 'Spring season')).toBeNull()
    expect(slide(talk, 'What we did')!.steps).toEqual([
      { shapes: [], paras: [{ shape: 3, from: 0, to: 3 }] },
      { shapes: [], paras: [{ shape: 3, from: 2, to: 3 }] },
      { shapes: [], paras: [{ shape: 3, from: 3, to: 3 }] },
      none
    ])
    expect(slide(talk, 'The new venue')!.steps).toEqual([{ shapes: [3, 4], paras: [] }, none])
    expect(slide(talk, 'Can we grow?')!.steps).toEqual([{ shapes: [4], paras: [] }, { shapes: [3], paras: [] }])
    expect(slide(talk, 'Tickets by quarter')!.steps).toEqual([{ shapes: [3], paras: [] }, none])
  })
})

describe('trees the reader is not sure of', () => {
  const shapes: BuildShape[] = [{ id: 3, kind: 'text', text: 'a\nb' }, { id: 4, kind: 'media' }]
  const fx = (cls: string, spid: number, extra: Partial<TimingNode> = {}, inner: TimingNode[] = []): TimingNode => ({
    t: 'par',
    c: [
      {
        t: 'cTn',
        a: { presetClass: cls, presetID: '1', nodeType: 'clickEffect', fill: 'hold', ...(extra.a ?? {}) },
        c: [
          { t: 'stCondLst', c: [{ t: 'cond', a: { delay: '0' } }] },
          { t: 'childTnLst', c: [{ t: 'set', c: [{ t: 'cBhvr', c: [{ t: 'cTn', a: { dur: '1' } }, { t: 'tgtEl', c: [{ t: 'spTgt', a: { spid: String(spid) }, c: inner }] }] }] }] }
        ]
      }
    ]
  })
  const press = (effects: TimingNode[], delay = 'indefinite'): TimingNode => ({
    t: 'par',
    c: [{ t: 'cTn', c: [{ t: 'stCondLst', c: [{ t: 'cond', a: { delay } }] }, { t: 'childTnLst', c: [{ t: 'par', c: [{ t: 'cTn', c: [{ t: 'stCondLst', c: [{ t: 'cond', a: { delay: '0' } }] }, { t: 'childTnLst', c: effects }] }] }] }] }]
  })
  const tree = (...parts: TimingNode[]): TimingNode => ({ t: 'timing', c: [{ t: 'tnLst', c: [{ t: 'par', c: [{ t: 'cTn', a: { nodeType: 'tmRoot' }, c: [{ t: 'childTnLst', c: parts }] }] }] }] })
  const main = (...presses: TimingNode[]): TimingNode => ({ t: 'seq', c: [{ t: 'cTn', a: { nodeType: 'mainSeq' }, c: [{ t: 'childTnLst', c: presses }] }] })

  it('shows a slide whole for a shape it does not have, a paragraph past the end, a cut-short tree', () => {
    expect(buildsOf(tree(main(press([fx('entr', 9)]))), shapes)!.whole).toBe('an effect on a shape the reader does not know')
    const para = (st: number) => [{ t: 'txEl', c: [{ t: 'pRg', a: { st: String(st), end: String(st) } }] }]
    expect(buildsOf(tree(main(press([fx('entr', 3, {}, para(1))]))), shapes)!.steps).toEqual([{ shapes: [], paras: [{ shape: 3, from: 1, to: 1 }] }, none])
    expect(buildsOf(tree(main(press([fx('entr', 3, {}, para(2))]))), shapes)!.whole).toBe('an effect on a paragraph the reader does not know')
    expect(buildsOf({ t: 'timing', over: true }, shapes)).toEqual({ steps: [none], changed: 1, whole: 'a timing too long to read' })
  })

  it('leaves out an emphasis that goes back as it was, keeping its press', () => {
    const pulse = fx('emph', 3, { a: { autoRev: '1' } })
    expect(buildsOf(tree(main(press([fx('entr', 3)]), press([pulse]))), shapes)).toEqual({ steps: [{ shapes: [3], paras: [] }, none, none], changed: 1 })
  })

  it('counts a video started by the main sequence and keeps the press', () => {
    expect(buildsOf(tree(main(press([fx('mediacall', 4)]))), shapes)).toEqual({ steps: [none, none], changed: 1 })
  })

  it('has no builds where the timing holds only the media nodes', () => {
    expect(buildsOf(tree({ t: 'video', c: [{ t: 'cMediaNode' }] }), shapes)).toBeNull()
    expect(buildsOf(undefined, shapes)).toBeNull()
  })

  it('gives the order only where the timing is no more than a builds edit writes: one shape a press, by Appear or by Fade', () => {
    const more: BuildShape[] = [...shapes, { id: 5, kind: 'other' }, { id: 6, kind: 'other', group: 7 }]
    expect(buildsOf(tree(main(press([fx('entr', 5)]), press([fx('entr', 3)]))), more)).toEqual({ steps: [{ shapes: [3, 5], paras: [] }, { shapes: [3], paras: [] }, none], changed: 0, order: [5, 3] })
    // Those that fade in are named, in the order's own order; a slide of Appear alone names none.
    const fade = (spid: number, a: Record<string, string> = {}) => fx('entr', spid, { a: { presetID: '10', ...a } })
    expect(buildsOf(tree(main(press([fade(5)]), press([fx('entr', 3)]))), more)).toMatchObject({ changed: 0, order: [5, 3], fade: [5] })
    expect(buildsOf(tree(main(press([fade(3)]), press([fade(5)]))), more)).toMatchObject({ order: [3, 5], fade: [3, 5] })
    // PowerPoint's own three fades on presses.
    expect(slide(kinds, 'Click groups')).toMatchObject({ order: [3, 4, 5], fade: [3, 4, 5] })
    for (const timing of [
      // any other entrance, a fade that is not its press's own effect, a fade twice
      tree(main(press([fx('entr', 5, { a: { presetID: '2' } })]))),
      tree(main(press([fade(5, { nodeType: 'withEffect' })]))),
      tree(main(press([fade(5)]), press([fade(5)]))),
      tree(main(press([fade(5), fade(3)]))),
      tree(main(press([fx('entr', 5), fx('entr', 3)]))),
      tree(main(press([fx('entr', 5)], '0'), press([fx('entr', 3)]))),
      tree(main(press([fx('exit', 5)]))),
      tree(main(press([fx('entr', 7)]))),
      tree(main(press([fx('entr', 3)])), { t: 'video', c: [{ t: 'cMediaNode' }] })
    ])
      expect(buildsOf(timing, more)).not.toHaveProperty('order')
    for (const title of ['With previous and after previous', 'Exits', 'Paragraphs one by one', 'After previous at the start', 'A group', 'A picture flies in']) expect(slide(kinds, title)).not.toHaveProperty('order')
  })

  it('refuses an entrance that undoes itself, and a start on an event', () => {
    expect(buildsOf(tree(main(press([fx('entr', 3, { a: { autoRev: '1' } })]))), shapes)!.whole).toBe('an entrance or exit that undoes itself')
    const onEvent = press([fx('entr', 3)])
    onEvent.c![0].c![0].c![0].a = { evt: 'onBegin', delay: '0' }
    expect(buildsOf(tree(main(onEvent)), shapes)!.whole).toBe('a start the reader does not know')
  })
})

describe('transitions', () => {
  it('counts every transition but a fade, a push and a cut as changed', () => {
    expect([undefined, { kind: 'fade', ms: 500 }, { kind: 'push', ms: 500 }, { kind: 'cut', ms: 0 }, { kind: 'wipe', ms: 500 }, { kind: 'morph', ms: 2000 }].map(transitionChanged)).toEqual([0, 0, 0, 0, 1, 1])
  })
})
