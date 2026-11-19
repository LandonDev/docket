import { describe, expect, it } from 'vitest'
import type { ShapeInfo, SlideInfo } from './deck'
import { editsOf, partNames } from './view'

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
