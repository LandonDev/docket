import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { everyBlock, plain, type Block } from 'work-kit/formats'
import type { WorkCtx } from '../modules'
import { GoogleApi, GoogleTokens, GOOGLE_MIME } from './client'
import { docMirror, readDoc, suggestDoc, writeDoc, type GoogleSource } from './docs'
import { FakeGoogle, FAKE_TOKEN_URL } from './fake'
import { ensureGoogleTables, googleOf, resetGoogle, setGoogleDeps } from './google'
import { mapGoogleDoc } from './mapper'

/** A Google Doc opened, his edits written back, an agent's sent as suggestions: against the fake Google. */
const ME = 'landon@example.com'
let fake: FakeGoogle
let ctx: WorkCtx
let dir: string
/** The mirror's blocks as the Work service would answer them: the test edits them as he would. */
let live: Block[]
const src: GoogleSource = { at: 'google', account: ME, fileId: 'doc1', mime: GOOGLE_MIME.doc }

const textOf = (b: Block) => plain(b.content as never)
const find = (words: string) => [...everyBlock(live)].find((b) => textOf(b) === words)!
const fresh = async () => mapGoogleDoc(await new GoogleApi(new GoogleTokens({ fetch: fake.fetch, tokenUrl: FAKE_TOKEN_URL, jwt: async () => fake.jwt }), ME, { fetch: fake.fetch }).doc('doc1')).imported.blocks

beforeEach(() => {
  fake = new FakeGoogle().account(ME)
  fake.addDoc(ME, 'doc1', 'Launch brief', [
    ['HEADING_1', 'Goals'],
    ['NORMAL_TEXT', 'We ship in March.'],
    ['NORMAL_TEXT', 'Budget is tight.'],
    ['NORMAL_TEXT', 'Ask Dana.']
  ], {
    comments: [{ commentId: 'c1', anchorId: 'kix.1', status: 'OPEN', plainTextQuote: 'March', headPost: { postId: 'p1', content: 'Is March firm?', author: { displayName: 'Grace Hopper' } } }],
    commentAnchors: { 'kix.1': { anchorId: 'kix.1', ranges: [{ startIndex: 18, endIndex: 23, tabId: 't.0' }] } }
  })
  dir = mkdtempSync(join(tmpdir(), 'm30-docs-'))
  const db = new DatabaseSync(':memory:')
  ensureGoogleTables(db)
  ctx = { db, host: 'env_box', dataDir: dir, log: () => {}, lifeos: { jwt: async () => fake.jwt } } as unknown as WorkCtx
  setGoogleDeps({ fetch: fake.fetch, tokenUrl: FAKE_TOKEN_URL, blocksOf: async () => structuredClone(live) })
})
afterEach(() => {
  resetGoogle()
  rmSync(dir, { recursive: true, force: true })
})

describe('a Google Doc in the document canvas', () => {
  it('opens as a .tcdoc with its comments, and keeps that mirror while the Doc has not moved', async () => {
    const mirror = await docMirror(ctx, googleOf(ctx), src)
    expect(existsSync(mirror)).toBe(true)
    const threads = JSON.parse((ctx.db.prepare('SELECT rows FROM work_docs_threads').get() as { rows: string }).rows)
    expect(threads).toHaveLength(1)
    expect(threads[0].comments[0]).toMatchObject({ authorMemberId: 'external:Grace Hopper' })
    expect(await docMirror(ctx, googleOf(ctx), src)).toBe(mirror)
  })

  it("writes his edits to Google in one batchUpdate: a changed paragraph's words, a new paragraph, a removed one", async () => {
    await docMirror(ctx, googleOf(ctx), src)
    live = await fresh()
    const ship = find('We ship in March.')
    ship.content = [{ type: 'text', text: 'We ship in early March.', styles: {} }]
    const at = live.indexOf(ship)
    live.splice(at + 1, 0, { id: 'new1', type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: 'Risks', styles: {} }], children: [] })
    live.splice(live.indexOf(find('Ask Dana.')), 1)
    const before = fake.calls.filter((c) => c.endsWith(':batchUpdate')).length
    const done = await writeDoc(ctx, googleOf(ctx), src)
    expect(done).toEqual({ changed: 1, added: 1, removed: 1, refused: [] })
    expect(fake.calls.filter((c) => c.endsWith(':batchUpdate')).length - before).toBe(1)
    expect(fake.docText('doc1')).toBe('Goals\nWe ship in early March.\nRisks\nBudget is tight.\n')
    const styles = (await fresh()).map((b) => [b.type, textOf(b)])
    expect(styles).toContainEqual(['heading', 'Risks'])
    expect(styles).toContainEqual(['paragraph', 'Budget is tight.'])
    // Written once: the next write has nothing to send.
    expect(await writeDoc(ctx, googleOf(ctx), src)).toEqual({ changed: 0, added: 0, removed: 0, refused: [] })
  })

  it('finds his paragraph again after someone else wrote elsewhere in the Doc', async () => {
    await docMirror(ctx, googleOf(ctx), src)
    live = await fresh()
    find('Budget is tight.').content = [{ type: 'text', text: 'Budget is fine.', styles: {} }]
    fake.editDoc('doc1', 1, 'Q3 ')
    await writeDoc(ctx, googleOf(ctx), src)
    expect(fake.docText('doc1')).toBe('Q3 Goals\nWe ship in March.\nBudget is fine.\nAsk Dana.\n')
  })

  it("leaves a paragraph someone changed in Google since, and says so", async () => {
    await docMirror(ctx, googleOf(ctx), src)
    live = await fresh()
    find('Budget is tight.').content = [{ type: 'text', text: 'Budget is fine.', styles: {} }]
    fake.editDoc('doc1', 35, 'very ')
    const done = await writeDoc(ctx, googleOf(ctx), src)
    expect(done.changed).toBe(0)
    expect(done.refused).toEqual(['“Budget is fine.”: its words changed in Google since it was read'])
    expect(fake.docText('doc1')).toContain('Budget is very tight.')
  })

  it("sends an agent's edit as a Google suggestion, and the Doc read again shows it as one", async () => {
    const first = await docMirror(ctx, googleOf(ctx), src)
    live = await fresh()
    await suggestDoc(googleOf(ctx), src, [{ find: 'tight', replace: 'fine' }])
    expect(fake.docText('doc1')).toContain('Budget is tightfine.')
    expect(fake.docSuggestions('doc1')).toEqual(['-tight', '+fine'])
    // Nothing of his waits, so opening again reads the Doc anew, with the suggestion as a branch.
    const again = await docMirror(ctx, googleOf(ctx), src)
    expect(again).not.toBe(first)
    expect(existsSync(first)).toBe(false)
    await expect(readDoc(googleOf(ctx), src)).resolves.toContain(`${ME} suggests adding “fine”`)
  })

  it('refuses an agent edit whose words stand twice or not at all', async () => {
    await expect(suggestDoc(googleOf(ctx), src, [{ find: 'March', replace: 'May' }])).resolves.toBe(1)
    await expect(suggestDoc(googleOf(ctx), src, [{ find: 'a', replace: 'o' }])).rejects.toThrow(/stands \d+ times/)
    await expect(suggestDoc(googleOf(ctx), src, [{ find: 'June', replace: 'May' }])).rejects.toThrow('not in the Doc')
  })

  it('keeps his unwritten edits when the Doc moved, and marks it behind', async () => {
    const mirror = await docMirror(ctx, googleOf(ctx), src)
    live = await fresh()
    find('Ask Dana.').content = [{ type: 'text', text: 'Ask Dana today.', styles: {} }]
    fake.editDoc('doc1', 1, 'Q3 ')
    expect(await docMirror(ctx, googleOf(ctx), src)).toBe(mirror)
    expect(googleOf(ctx).files.get(ME, 'doc1')?.behind).toBe('2')
  })

  it('keeps no token: the database holds no access token, and the route is asked again after a 401', async () => {
    await docMirror(ctx, googleOf(ctx), src)
    fake.expireTokens()
    await expect(readDoc(googleOf(ctx), src)).resolves.toContain('Launch brief')
    const dump = JSON.stringify(ctx.db.prepare('SELECT * FROM work_google_files').all())
    expect(dump).not.toMatch(/tok-/)
  })

  it('says why an account cannot open Drive files yet', async () => {
    fake.account('work@example.com', false)
    await expect(docMirror(ctx, googleOf(ctx), { ...src, account: 'work@example.com' })).rejects.toThrow('has not allowed Drive files yet')
    await expect(docMirror(ctx, googleOf(ctx), { ...src, account: 'nobody@example.com' })).rejects.toThrow('LifeOS has no Google account')
  })
})
