import { afterEach, describe, expect, it } from 'vitest'
import { filesPaneOf, type CanvasItem } from '@shared/work'
import { fencedItem, itemPath, registerItemFile } from './store'

const URL = 'https://purdue0.sharepoint.com/sites/RecWell/Shared%20Documents/Team%20RecWell/Plan.docx?web=1'
const live: CanvasItem = {
  id: 'i1',
  sessionId: filesPaneOf('w1'),
  kind: 'document',
  title: 'Plan.docx',
  source: { at: 'microsoft', app: 'word', host: 'box', name: 'Plan.docx', ref: { kind: 'url', url: URL } },
  createdAt: 1
} as CanvasItem

describe('the file behind an item that names none', () => {
  let off: () => void = () => undefined
  afterEach(() => off())

  it('is what the registered pillar names, and the fence checks it', () => {
    expect(itemPath(live)).toBeNull()
    expect(fencedItem(live, () => false)).toBe(live)
    off = registerItemFile((item) => (item.id === 'i1' ? '/Library/RecWell/Plan.docx' : null))
    expect(itemPath(live)).toBe('/Library/RecWell/Plan.docx')
    expect(fencedItem(live, (p) => p.startsWith('/Library/'))).toBe(live)
    const cut = fencedItem(live, () => false)
    expect(JSON.stringify(cut)).not.toContain('sharepoint')
    expect(cut.title).toBe('')
  })
})
