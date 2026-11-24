import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { OfficeError, type OfficeCarrier, type WriteBound } from '../carrier'
import { ADDIN_ASSETS } from './assets'
import { withAddin } from './carrier'
import type { AddinHub } from './hub'

/**
 * What a held change's press was shown (`WriteBound`) reaches the carrier that writes it: the production carrier is
 * `withAddin(desktop, hub)`, so both its verbs hand it on, to the add-in and to the desktop; and the add-in checks it
 * in its own write, as the Mac's scripts do.
 */

const BOUND: WriteBound = { places: 1, at: [[0, 'Plan: Q3']] }

function desktop(): { carrier: OfficeCarrier; seen: unknown[][] } {
  const seen: unknown[][] = []
  const carrier = {
    documents: async () => [{ key: '/Users/o/Plan.docx', name: 'Plan.docx' }],
    presentations: async () => [{ key: '/Users/o/Deck.pptx', name: 'Deck.pptx' }],
    editDocument: async (...args: unknown[]) => (seen.push(['word', ...args]), 1),
    replaceSlideText: async (...args: unknown[]) => (seen.push(['powerpoint', ...args]), 1)
  } as unknown as OfficeCarrier
  return { carrier, seen }
}

describe('the add-in wrapper', () => {
  it('hands the binding to the desktop carrier for both verbs when no add-in holds the file', async () => {
    const d = desktop()
    const c = withAddin(d.carrier, () => null)
    await c.editDocument('/Users/o/Plan.docx', { find: 'Q3', replace: 'Q4' }, false, BOUND)
    await c.replaceSlideText('/Users/o/Deck.pptx', 'Q3', 'Q4', BOUND)
    expect(d.seen).toEqual([
      ['word', '/Users/o/Plan.docx', { find: 'Q3', replace: 'Q4' }, false, BOUND],
      ['powerpoint', '/Users/o/Deck.pptx', 'Q3', 'Q4', BOUND]
    ])
  })

  it("hands it to the add-in that holds the file, and reads the add-in's refusal as the carrier's", async () => {
    const calls: [string, unknown][] = []
    let answer: unknown = 1
    const hub = { sessionFor: () => ({ conn: 'c1' }), call: async (_conn: string, op: string, args: unknown) => (calls.push([op, args]), answer), files: () => [] } as unknown as AddinHub
    const c = withAddin(desktop().carrier, () => hub)
    await c.editDocument('Plan.docx', { find: 'Q3', replace: 'Q4' }, false, BOUND)
    await c.replaceSlideText('Deck.pptx', 'Q3', 'Q4', BOUND)
    expect(calls).toEqual([
      ['word.edit', { edit: { find: 'Q3', replace: 'Q4' }, tracked: false, bound: BOUND }],
      ['slides.replace', { find: 'Q3', replace: 'Q4', bound: BOUND }]
    ])
    answer = { refused: 'The words stand in 2 places now, not the 1 shown.' }
    await expect(c.editDocument('Plan.docx', { find: 'Q3', replace: 'Q4' }, false, BOUND)).rejects.toMatchObject({ code: 'refused' })
    await expect(c.replaceSlideText('Deck.pptx', 'Q3', 'Q4', BOUND)).rejects.toBeInstanceOf(OfficeError)
  })
})

/** The add-in's own code, on stand-ins of Word and PowerPoint: it reads again in its write and refuses on any difference. */
function addin(o: { paragraphs: string[]; hits: number; slides?: string[][] }) {
  const writes: string[] = []
  const doc = {
    changeTrackingMode: 'Off',
    load: () => {},
    body: {
      paragraphs: { load: () => {}, items: o.paragraphs.map((text) => ({ text })) },
      insertText: (text: string) => void writes.push(text),
      search: () => ({ load: () => {}, items: Array.from({ length: o.hits }, () => ({ insertText: (text: string) => void writes.push(text) })) })
    }
  }
  const Office = { HostType: { Excel: 'Excel', Word: 'Word', PowerPoint: 'PowerPoint' }, context: { host: 'Word', document: { url: 'https://x.sharepoint.com/Plan.docx' }, diagnostics: { platform: 'Mac' }, requirements: { isSetSupported: () => false } } }
  const Word = { ChangeTrackingMode: { off: 'Off', trackAll: 'TrackAll' }, run: (fn: (c: unknown) => Promise<unknown>) => fn({ document: doc, sync: () => Promise.resolve() }) }
  const sandbox: Record<string, unknown> = { setTimeout, clearTimeout }
  runInNewContext(String(ADDIN_ASSETS['core.js']!.body), sandbox)
  const made = (sandbox.TempCodeAddin as { createAddin(env: unknown): { run(verb: string, a: unknown): Promise<unknown> } }).createAddin({
    Office,
    Word,
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    url: 'ws://127.0.0.1:1/w/office',
    onState: () => {}
  })
  return { run: made.run, writes }
}

describe("the add-in's own write", () => {
  it('refuses a Word edit, writing nothing, when the count or the paragraphs differ from what his press was shown', async () => {
    const added = addin({ paragraphs: ['Plan: Q3', 'Notes: Q3'], hits: 2 })
    await expect(added.run('word.edit', { edit: { find: 'Q3', replace: 'Q4' }, tracked: false, bound: BOUND })).resolves.toEqual({ refused: 'The words stand in 2 places now, not the 1 shown.' })
    const moved = addin({ paragraphs: ['Notes', 'Plan: Q3'], hits: 1 })
    await expect(moved.run('word.edit', { edit: { find: 'Q3', replace: 'Q4' }, tracked: false, bound: BOUND })).resolves.toEqual({ refused: 'The words stand in other paragraphs now than the ones shown.' })
    expect([...added.writes, ...moved.writes]).toEqual([])
    const shown = addin({ paragraphs: ['Plan: Q3', 'Notes'], hits: 1 })
    await expect(shown.run('word.edit', { edit: { find: 'Q3', replace: 'Q4' }, tracked: false, bound: BOUND })).resolves.toBe(1)
    expect(shown.writes).toEqual(['Q4'])
  })
})
