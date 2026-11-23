import { describe, expect, it } from 'vitest'
import { plain, type Block } from 'work-kit/formats'
import { GoogleApi, GoogleTokens } from './client'
import { FakeGoogle, FAKE_TOKEN_URL } from './fake'
import { mapGoogleDoc } from './mapper'
import { baseOf, planSuggest, planWrite, rebase, unsentCount } from './write'

/** The planner's hard cases, each written to the fake Doc and read back. */
const ME = 'me@example.com'

async function rig(paragraphs: [string, string][]) {
  const fake = new FakeGoogle().account(ME)
  fake.addDoc(ME, 'd', 'Doc', paragraphs)
  const api = new GoogleApi(new GoogleTokens({ fetch: fake.fetch, tokenUrl: FAKE_TOKEN_URL, jwt: async () => fake.jwt }), ME, { fetch: fake.fetch })
  const read = async () => mapGoogleDoc(await api.doc('d'))
  const first = await read()
  const base = baseOf(first.imported.blocks, first.paragraphs)
  const blocks = structuredClone(first.imported.blocks)
  const find = (words: string) => blocks.find((b) => plain(b.content as never) === words)!
  const text = (b: Block, words: string) => void (b.content = [{ type: 'text', text: words, styles: {} }])
  const para = (id: string, words: string, type = 'paragraph', props: Record<string, unknown> = {}): Block => ({ id, type, props, content: [{ type: 'text', text: words, styles: {} }], children: [] })
  const write = async () => {
    const now = await api.doc('d')
    const plan = planWrite(base, blocks, mapGoogleDoc(now).paragraphs)
    if (plan.requests.length) await api.docUpdate('d', plan.requests, { requiredRevisionId: now.revisionId! })
    return plan
  }
  const styles = async () => (await read()).imported.blocks.map((b) => [b.type, plain(b.content as never)])
  return { fake, api, read, base, blocks, find, text, para, write, styles }
}

describe('writing his edits to a Google Doc', () => {
  it('removes the last two paragraphs as one range', async () => {
    const r = await rig([['HEADING_1', 'Title'], ['NORMAL_TEXT', 'One'], ['NORMAL_TEXT', 'Two'], ['NORMAL_TEXT', 'Three']])
    r.blocks.splice(r.blocks.indexOf(r.find('Two')), 2)
    expect((await r.write()).removed).toBe(2)
    expect(r.fake.docText('d')).toBe('Title\nOne\n')
  })

  it('removes every paragraph and adds one', async () => {
    const r = await rig([['NORMAL_TEXT', 'One'], ['NORMAL_TEXT', 'Two']])
    r.blocks.splice(0, 2, r.para('n', 'Fresh'))
    await r.write()
    expect(r.fake.docText('d').replace(/\n+$/, '\n')).toBe('Fresh\n')
  })

  it('keeps the style of the paragraph left last when the closing heading goes', async () => {
    const r = await rig([['NORMAL_TEXT', 'One'], ['NORMAL_TEXT', 'Two'], ['HEADING_2', 'Three']])
    r.blocks.splice(r.blocks.indexOf(r.find('Three')), 1)
    await r.write()
    expect(await r.styles()).toEqual([
      ['paragraph', 'One'],
      ['paragraph', 'Two']
    ])
  })

  it('refuses a paragraph whose words stand twice equally near, rather than guess', async () => {
    const r = await rig([['NORMAL_TEXT', 'Same'], ['NORMAL_TEXT', 'Mid'], ['NORMAL_TEXT', 'Same']])
    r.text(r.blocks[2], 'Same!')
    r.fake.editDoc('d', 1, 'Same\n')
    const plan = await r.write()
    expect(plan.changed).toBe(0)
    expect(r.fake.docText('d')).toBe('Same\nSame\nMid\nSame\n')
  })

  it('does not place a new paragraph after one that changed in Google', async () => {
    const r = await rig([['NORMAL_TEXT', 'One'], ['NORMAL_TEXT', 'Two']])
    r.blocks.push(r.para('n', 'NEW'))
    r.fake.editDoc('d', 6, 'X')
    const plan = await r.write()
    expect(plan.added).toBe(0)
    expect(plan.refused.map((x) => x.blockId)).toEqual(['n'])
    expect(r.fake.docText('d')).toBe('One\nTXwo\n')
  })

  it('keeps a surrogate pair whole', async () => {
    const r = await rig([['NORMAL_TEXT', 'a😀b']])
    r.text(r.blocks[0], 'a😁b')
    await r.write()
    expect(r.fake.docText('d')).toBe('a😁b\n')
  })

  it('names a change of formatting alone, and counts it as unsent', async () => {
    const r = await rig([['NORMAL_TEXT', 'One']])
    r.blocks[0].content = [{ type: 'text', text: 'One', styles: { bold: true } }]
    expect(unsentCount(r.base, r.blocks)).toBe(1)
    const plan = await r.write()
    expect(plan.refused).toEqual([{ blockId: r.blocks[0].id, why: 'a change of formatting is made in Google, not from here' }])
  })

  it('keeps a refused edit as his after the write, so a later read never drops it', async () => {
    const r = await rig([['NORMAL_TEXT', 'One'], ['NORMAL_TEXT', 'Two']])
    r.text(r.find('One'), 'Uno')
    r.text(r.find('Two'), 'Dos')
    r.fake.editDoc('d', 1, 'X')
    const plan = await r.write()
    expect(plan.changed).toBe(1)
    const kept = { [r.blocks[0].id]: r.base.paragraphs[r.blocks[0].id] }
    const after = rebase(r.blocks, (await r.read()).paragraphs, kept)
    expect(unsentCount(after, r.blocks)).toBe(1)
  })

  it('takes no place for a paragraph that holds only a page break: nothing counts as unsent', async () => {
    const fake = new FakeGoogle().account(ME)
    const doc = {
      documentId: 'p',
      revisionId: 'r',
      body: {
        content: [
          { startIndex: 1, endIndex: 7, paragraph: { elements: [{ startIndex: 1, endIndex: 7, textRun: { content: 'Intro\n' } }] } },
          { startIndex: 7, endIndex: 9, paragraph: { elements: [{ startIndex: 7, endIndex: 8, pageBreak: {} }, { startIndex: 8, endIndex: 9, textRun: { content: '\n' } }] } },
          { startIndex: 9, endIndex: 15, paragraph: { elements: [{ startIndex: 9, endIndex: 15, textRun: { content: 'After\n' } }] } }
        ]
      }
    }
    void fake
    const m = mapGoogleDoc(doc)
    const base = baseOf(m.imported.blocks, m.paragraphs)
    expect(m.paragraphs.map((p) => p.text)).toEqual(['Intro', 'After'])
    expect(unsentCount(base, m.imported.blocks)).toBe(0)
    expect(planWrite(base, m.imported.blocks, m.paragraphs).refused).toEqual([])
  })

  it('compares an untouched table equal when the service reads it back with the editor\'s defaults', () => {
    const m = mapGoogleDoc({ body: { content: [{ startIndex: 1, endIndex: 5, table: { tableRows: [{ tableCells: [{ content: [{ paragraph: { elements: [{ textRun: { content: 'x\n' } }] } }] }] }] } }] } })
    const served = structuredClone(m.imported.blocks)
    served[0].props = { textColor: 'default' }
    const base = baseOf(m.imported.blocks, m.paragraphs, served)
    expect(unsentCount(base, served)).toBe(0)
  })
})

describe("planSuggest: an agent's edits as one batchUpdate", () => {
  const para = (tabId: string, text: string, start: number) => ({ blockId: `${tabId}${start}`, tabId, start, end: start + text.length + 1, text, exact: true, style: 'NORMAL_TEXT' })
  it('takes the same indexes in two tabs as two places, and refuses two edits on one range in one tab', () => {
    const fresh = [para('t.1', 'Ship in March.', 1), para('t.2', 'Pay in April.', 1)]
    const plan = planSuggest(fresh, [{ find: 'March', replace: 'May' }, { find: 'April', replace: 'June' }])
    expect('requests' in plan && plan.requests).toHaveLength(4)
    expect(planSuggest([para('t.1', 'Ship in March.', 1)], [{ find: 'in March', replace: 'x' }, { find: 'March.', replace: 'y' }])).toMatchObject({ error: 'Two edits touch "March.".', at: 1, why: 'overlap' })
  })
})
