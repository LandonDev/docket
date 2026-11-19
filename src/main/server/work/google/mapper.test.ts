import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { everyBlock, plain, type Block } from 'work-kit/formats'
import { mapGoogleDoc } from './mapper'

/** The formats research's three fixtures (fixtures/SOURCES.md), as its run counted them. */
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'))
const counts = (blocks: Block[]) => [...everyBlock(blocks)].reduce<Record<string, number>>((m, b) => ((m[b.type] = (m[b.type] ?? 0) + 1), m), {})

describe('the Docs API mapper', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm30-mapper-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('maps a real capture (hast-complete) as the research counted it', () => {
    const m = mapGoogleDoc(fixture('hast-complete.json'))
    expect(counts(m.imported.blocks)).toMatchObject({ heading: 19, bulletListItem: 3, numberedListItem: 3, table: 5, image: 4, divider: 1 })
    // a merged cell, and the covered cell under it skipped
    const tables = [...everyBlock(m.imported.blocks)].filter((b) => b.type === 'table')
    expect(JSON.stringify(tables)).toContain('"colspan":2')
    expect(m.imported.sidecar.dropped).toMatchObject({ 'equation(content not in API)': 1, internalLink: 2, 'embeddedObject:drawing': 1 })
    expect(m.imported.sidecar.page.sections.map((s) => s.columns)).toEqual([1, 2, 1])
  })

  it("maps Google's own sample dump, with tabs", () => {
    const m = mapGoogleDoc(fixture('google-test-mule.json'))
    expect(counts(m.imported.blocks)).toMatchObject({ paragraph: 4, heading: 2, bulletListItem: 3, numberedListItem: 3, table: 1 })
    expect(m.imported.sidecar.dropped['listGlyph:ALPHA']).toBe(3)
  })

  it('maps comments, replies, resolved threads and suggestions with their authors (synthetic-review)', () => {
    const m = mapGoogleDoc(fixture('synthetic-review.json'))
    const t = m.imported.sidecar.threads
    expect(t.map((x) => [x.id, x.resolved, x.comments.length])).toEqual([
      ['AAAA1', false, 2],
      ['AAAA2', true, 1]
    ])
    // the open thread's words are "in March", in the paragraph that holds them
    const line = [...everyBlock(m.imported.blocks)].find((b) => b.id === t[0].ranges[0].blockId)!
    expect(plain(line.content as never).slice(t[0].ranges[0].from, t[0].ranges[0].to)).toBe('in March')
    expect(t[0].comments.map((c) => c.author)).toEqual(['Grace Hopper', 'Ada Lovelace'])
    const changes = m.imported.sidecar.changes.map((c) => [c.kind, c.text, c.author])
    expect(changes).toEqual([
      ['delete', 'two', 'Grace Hopper'],
      ['insert', 'three', 'Grace Hopper']
    ])
    expect(m.imported.sidecar.page.headers.length).toBe(1)
    expect(m.imported.sidecar.page.footers.length).toBe(1)
    expect(m.imported.sidecar.notes.length).toBe(1)
    // the child tab follows under its title
    expect([...everyBlock(m.imported.blocks)].some((b) => b.type === 'heading' && plain(b.content as never) === 'Appendix')).toBe(true)
  })

  it('places each body paragraph, and says which ones a write may touch', () => {
    const m = mapGoogleDoc(fixture('synthetic-review.json'))
    const byText = new Map(m.paragraphs.map((p) => [p.text, p]))
    const goals = byText.get('Goals')!
    expect(goals).toMatchObject({ start: 14, end: 20, exact: true, tabId: 't.0' })
    // a paragraph with a waiting suggestion is Google's to change
    expect(m.paragraphs.find((p) => p.text.includes('We ship'))!.exact).toBe(false)
    expect(m.known.length).toBe([...everyBlock(m.imported.blocks)].length)
  })

  it('makes a .tcdoc whose blocks keep the ids writes are keyed by', async () => {
    const { writeImportedTcdoc } = await import('work-kit/formats/tcdoc')
    const m = mapGoogleDoc(fixture('synthetic-review.json'))
    const made = await writeImportedTcdoc(join(dir, 'review.tcdoc'), m.imported)
    expect(made.threads.length).toBe(2)
    expect(made.branches.map((b) => b.author)).toEqual(['Grace Hopper'])
    expect(made.outsiders).toBe(true)
  })

  it('keeps links to the web, mail and phone only', () => {
    const doc = {
      body: { content: [{ startIndex: 1, endIndex: 6, paragraph: { elements: [{ startIndex: 1, endIndex: 6, textRun: { content: 'evil\n', textStyle: { link: { url: 'javascript:alert(1)' } } } }] } }] }
    }
    const m = mapGoogleDoc(doc)
    expect(m.imported.blocks[0].content).toEqual([{ type: 'text', text: 'evil', styles: {} }])
  })
})
