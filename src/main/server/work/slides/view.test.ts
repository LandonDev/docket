import { describe, expect, it } from 'vitest'
import type { ShapeInfo, SlideInfo } from './deck'
import type { DeckInfo } from './deck'
import { changesOf, editsOf, lookWords, partNames } from './view'

const shape = (id: number, name: string, kind: ShapeInfo['kind'], placeholder?: string, text = ''): ShapeInfo => ({
  id,
  name,
  kind,
  ...(placeholder ? { placeholder } : {}),
  bbox: null,
  text
})
const slideOf = (shapes: ShapeInfo[]): SlideInfo => ({ id: 256, hidden: false, layout: 'Title and Content', title: '', notes: '', hash: '', shapes })

describe("a slide's parts in the person's words", () => {
  it('names a part by its role, never by PowerPoint’s shape name', () => {
    const names = partNames([shape(2, 'Title 1', 'text', 'title'), shape(3, 'Subtitle 2', 'text', 'subtitle'), shape(4, 'Table 3', 'table'), shape(5, 'Picture 4', 'picture')])
    expect([...names.values()]).toEqual(['Title', 'Subtitle', 'Table', 'Picture'])
  })

  it('numbers a role only where the slide has more than one of it, in the slide’s order', () => {
    const names = partNames([shape(2, 'Title 1', 'text', 'title'), shape(3, 'Content Placeholder 2', 'text', 'body'), shape(7, 'TextBox 6', 'text')])
    expect([...names.values()]).toEqual(['Title', 'Text 1', 'Text 2'])
  })

  it('labels an edit and a cell by the role', () => {
    const before = slideOf([shape(2, 'Title 1', 'text', 'title', 'Old'), { ...shape(4, 'Table 3', 'table'), cells: [['a', 'b']] }])
    const after = slideOf([shape(2, 'Title 1', 'text', 'title', 'New'), { ...shape(4, 'Table 3', 'table'), cells: [['a', 'c']] }])
    expect(editsOf(before, after).edits).toEqual([
      { where: 'Title', before: 'Old', after: 'New' },
      { where: 'Table, row 1, column 2', before: 'b', after: 'c' }
    ])
  })
})

describe('a change that rewords nothing', () => {
  const para = (text: string, look: Partial<NonNullable<ShapeInfo['paragraphs']>[number]['runs'][number]> = {}, align: 'left' | 'center' = 'left'): NonNullable<ShapeInfo['paragraphs']>[number] => ({
    level: 0,
    align,
    list: 'none',
    runs: [{ text, font: 'Calibri', size: 18, ...look }]
  })

  it('says a look in a few words: what every run shares, "some" where only part has it, "mixed" where they differ', () => {
    expect(lookWords([para('One')])).toBe('Calibri, 18 pt, left')
    expect(lookWords([para('One', { bold: true, color: 'C00000' }, 'center')])).toBe('Calibri, 18 pt, bold, #C00000, centred')
    expect(lookWords([para('One', { bold: true }), para('Two', { size: 28 })])).toBe('Calibri, mixed sizes, some bold, left')
    expect(lookWords([{ ...para('One'), list: 'bullet' }])).toBe('Calibri, 18 pt, left, bullets')
    expect(lookWords(undefined)).toBe('')
  })

  it('is said by its look before and after, so the stepper never shows a change with nothing in it', () => {
    const before = slideOf([{ ...shape(2, 'Title 1', 'text', 'title', 'One'), bbox: [0, 0, 1, 1], paragraphs: [para('One')] }])
    const bolder = slideOf([{ ...shape(2, 'Title 1', 'text', 'title', 'One'), bbox: [0, 0, 1, 1], paragraphs: [para('One', { bold: true })] }])
    expect(editsOf(before, bolder)).toEqual({ edits: [{ where: 'Title, look', before: 'Calibri, 18 pt, left', after: 'Calibri, 18 pt, bold, left' }], boxes: [[0, 0, 1, 1]], gone: [] })
    // A look on part of the words that the few words cannot tell apart is still a change.
    const two = slideOf([{ ...shape(2, 'Title 1', 'text', 'title', 'One'), bbox: [0, 0, 1, 1], paragraphs: [{ ...para('One'), runs: [{ text: 'O', font: 'Calibri', size: 18 }, { text: 'ne', font: 'Calibri', size: 18 }] }] }])
    expect(editsOf(before, two).edits).toEqual([{ where: 'Title, look', before: 'As it was', after: 'Changed within the text' }])
    expect(editsOf(before, before).edits).toEqual([])
  })
})

describe('a change to shapes, a slide or the deck itself, in words', () => {
  const box = (id: number, kind: ShapeInfo['kind'], bbox: [number, number, number, number], extra: Partial<ShapeInfo> = {}): ShapeInfo => ({ ...shape(id, `Shape ${id}`, kind), bbox, ...extra })

  it('says a shape added, removed, moved, recoloured and reordered, and a slide hidden or given another layout', () => {
    const before = slideOf([box(2, 'picture', [0, 0, 0.5, 0.5]), box(3, 'other', [0.5, 0, 1, 0.5], { fill: 'FF0000' }), box(4, 'other', [0, 0.5, 0.5, 1]), box(5, 'text', [0.5, 0.5, 1, 1], { text: 'Going' })])
    const after: SlideInfo = {
      ...slideOf([box(4, 'other', [0, 0.5, 0.5, 1]), box(3, 'other', [0.5, 0, 1, 0.5], { fill: 'none', line: { color: '00AA00', width: 2 } }), box(2, 'picture', [0.1, 0.1, 0.6, 0.6]), box(9, 'picture', [0, 0, 0.2, 0.2])]),
      hidden: true,
      layout: 'Title Only'
    }
    expect(editsOf(before, after).edits).toEqual([
      // Parts are named in the slide's order as it will be: the shape sent behind is now the second of its kind.
      { where: 'Shape 2, look', before: 'fill #FF0000', after: 'no fill, outline #00AA00 2 pt' },
      { where: 'Picture 1, look', before: 'Where it was', after: 'Moved or resized' },
      { where: 'Picture 2', before: '', after: 'Added' },
      { where: 'Text', before: 'Going', after: 'Removed' },
      { where: 'Order', before: 'As it was', after: 'Shapes brought forward or sent back' },
      { where: 'In the show', before: 'Shown', after: 'Hidden' },
      { where: 'Layout', before: 'Title and Content', after: 'Title Only' }
    ])
    // The boxes to tint are the shapes the change touched.
    expect(editsOf(before, after).boxes).toEqual([[0.5, 0, 1, 0.5], [0.1, 0.1, 0.6, 0.6], [0, 0, 0.2, 0.2]])
    // And where the shape it takes away lay, to tint as removed.
    expect(editsOf(before, after).gone).toEqual([[0.5, 0.5, 1, 1]])
  })

  it('counts an edit of the deck itself as one change of its own: its theme and its sections', () => {
    const deck = (theme: DeckInfo['theme'], sections: DeckInfo['sections']): DeckInfo => ({ width: 1, height: 1, layouts: [], slides: [slideOf([])], theme, sections })
    const file = deck({ colors: { accent1: '4472C4', dk2: '44546A' }, major: 'Calibri Light', minor: 'Calibri' }, [])
    const proposed = deck({ colors: { accent1: '112233', dk2: '44546A' }, major: 'Georgia', minor: 'Calibri' }, [{ name: 'Opening', slideIds: [256] }])
    const changes = changesOf(file, proposed, [
      { id: 'a', slide: 0, op: { op: 'theme', colors: { accent1: '112233' }, major: 'Georgia' }, by: 'owner' },
      { id: 'b', slide: 0, op: { op: 'section', act: 'rename', section: 0, name: 'Opening' }, by: 'owner' }
    ])
    expect(changes).toEqual([
      {
        id: 'slide-0',
        kind: 'changed',
        slideId: 0,
        label: 'The deck',
        edits: [
          { where: 'Theme fonts', before: 'Calibri Light and Calibri', after: 'Georgia and Calibri' },
          { where: 'Theme colours', before: 'accent1 #4472C4', after: 'accent1 #112233' },
          { where: 'Sections', before: 'None', after: 'Opening' }
        ],
        by: 'owner'
      }
    ])
    // A slide copied is a slide added; a slide moved and nothing else is a move.
    const two: DeckInfo = { ...file, slides: [slideOf([]), { ...slideOf([]), id: 300 }] }
    expect(changesOf(file, two, [{ id: 'c', slide: 300, op: { op: 'duplicate', slide: 256, id: 300 }, by: 'owner' }])[0].kind).toBe('added')
    expect(changesOf(file, file, [{ id: 'd', slide: 256, op: { op: 'move', slide: 256, after: 0 }, by: 'owner' }])[0].kind).toBe('moved')
    expect(changesOf(file, file, [{ id: 'e', slide: 256, op: { op: 'hide', slide: 256, hidden: true }, by: 'owner' }])[0].kind).toBe('changed')
  })
})
