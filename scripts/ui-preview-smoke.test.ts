import { describe, expect, it } from 'vitest'
import { listPreviewPages, previewVerdict } from './ui-preview-smoke'

describe('listPreviewPages', () => {
  it('finds documented fixture targets, adjacent components and every runtime preview export', () => {
    const files = new Map([
      ['chrome/Field.tsx', 'export function Field() {}\nexport function FieldRow() {}'],
      ['chrome/Field.fixtures.tsx', '// chrome/Field.tsx#FieldRow\nexport default []'],
      ['work/card.tsx', 'export const Card = () => null'],
      ['work/card.fixtures.tsx', 'export default []'],
      ['work/Seat.preview.tsx', 'export type Moment = string; export const Seat = () => null; export function Folded() {}\nexport { Folded as Other };'],
      ['work/Seat.preview.fixtures.tsx', 'export default []'],
      ['chrome/dialogs.fixtures.tsx', '// dialogs.fixtures.tsx#DialogGallery\nexport function DialogGallery() {}']
    ])
    expect(listPreviewPages(files)).toEqual([
      { path: 'chrome/dialogs.fixtures.tsx', name: 'DialogGallery' },
      { path: 'chrome/Field.tsx', name: 'FieldRow' },
      { path: 'work/card.tsx', name: 'Card' },
      { path: 'work/Seat.preview.tsx', name: 'Folded' },
      { path: 'work/Seat.preview.tsx', name: 'Other' },
      { path: 'work/Seat.preview.tsx', name: 'Seat' }
    ])
    expect(listPreviewPages(files, 'src/renderer/src/work/card.fixtures')).toEqual([{ path: 'work/card.tsx', name: 'Card' }])
  })

  it('names old fixture files whose target cannot be inferred', () => {
    expect(listPreviewPages(new Map([['Lost.fixtures.tsx', 'export default []']]))).toEqual([
      { path: 'Lost.fixtures.tsx', name: '(fixture target missing)' }
    ])
  })
})

describe('previewVerdict', () => {
  const fixture = (content: string) => `<section class="preview-fixture"><div class="preview-label">Draft</div><div>${content}</div></section>`

  it('names an empty fixture even if other fixtures rendered', () => {
    expect(previewVerdict('')).toBe('no fixtures')
    expect(previewVerdict(fixture('<input>') + fixture('<!-- suspense -->'))).toBe('Draft: no markup')
    expect(previewVerdict(fixture('<svg></svg>'))).toBeNull()
  })

  it('rejects boundary cards but accepts deliberate failure states and ordinary alerts', () => {
    expect(previewVerdict(fixture('<div data-chunk-failed="board"></div>'))).toBe('Draft: React error boundary')
    expect(previewVerdict(fixture('<div role="alert"><div data-slot="empty-title">Something broke</div><button>Reload window</button></div>'))).toBe('Draft: React error boundary')
    expect(previewVerdict(fixture('<div data-preview-expected-error><div data-chunk-failed="board-row"></div></div>'))).toBeNull()
    expect(previewVerdict(fixture('<div role="alert">Could not save</div>'))).toBeNull()
  })
})
