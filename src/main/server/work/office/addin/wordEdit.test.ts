import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { ADDIN_ASSETS } from './assets'

/**
 * The add-in's Word edit on a stub Word: an untracked edit (his approved change, or a write to his own file) turns
 * Track Changes off for its own write where Word lets it, and puts back what was there, so an approved change never
 * lands as a tracked revision co-authors see.
 */
function word(opts: { mode: string; api14: boolean }) {
  const writes: { text: string; mode: string }[] = []
  const doc = {
    changeTrackingMode: opts.mode,
    load: () => {},
    body: {
      insertText: (text: string) => void writes.push({ text, mode: doc.changeTrackingMode }),
      search: () => ({ load: () => {}, items: [{ insertText: (text: string) => void writes.push({ text, mode: doc.changeTrackingMode }) }] })
    }
  }
  const Office = { HostType: { Excel: 'Excel', Word: 'Word', PowerPoint: 'PowerPoint' }, context: { host: 'Word', document: { url: 'https://x.sharepoint.com/Brief.docx' }, diagnostics: { platform: 'Mac' }, requirements: { isSetSupported: (set: string, v: string) => opts.api14 && set === 'WordApi' && v === '1.4' } } }
  const Word = { ChangeTrackingMode: { off: 'Off', trackAll: 'TrackAll' }, run: (fn: (c: unknown) => Promise<unknown>) => fn({ document: doc, sync: () => Promise.resolve() }) }
  const sandbox: Record<string, unknown> = { setTimeout, clearTimeout }
  runInNewContext(String(ADDIN_ASSETS['core.js']!.body), sandbox)
  const addin = (sandbox.TempCodeAddin as { createAddin(env: unknown): { run(verb: string, a: unknown): Promise<number> } }).createAddin({
    Office,
    Word,
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    url: 'ws://127.0.0.1:1/w/office',
    onState: () => {}
  })
  return { addin, doc, writes }
}

describe("the add-in's Word edit", () => {
  it('writes an untracked edit with Track Changes off in a document that tracks, and puts tracking back', async () => {
    const w = word({ mode: 'TrackAll', api14: true })
    await expect(w.addin.run('word.edit', { edit: { find: 'one', replace: 'two' }, tracked: false })).resolves.toBe(1)
    await w.addin.run('word.edit', { edit: { insert: 'End.', at: 'end' }, tracked: false })
    expect(w.writes).toEqual([
      { text: 'two', mode: 'Off' },
      { text: 'End.', mode: 'Off' }
    ])
    expect(w.doc.changeTrackingMode).toBe('TrackAll')
  })

  it('still writes on a Word without WordApi 1.4, which cannot be asked', async () => {
    const w = word({ mode: 'Off', api14: false })
    await w.addin.run('word.edit', { edit: { insert: 'End.', at: 'end' }, tracked: false })
    expect(w.writes).toEqual([{ text: 'End.', mode: 'Off' }])
  })
})
