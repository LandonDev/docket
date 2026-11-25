import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { draftFileOf, draftOf, type Draft } from '@shared/work/drafts'
import { DraftStore } from './drafts'

/** The draft store (drafts.ts) on a scratch folder: a fresh store on the same folder is the app started again. */

const dirs: string[] = []
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'tc-drafts-'))
  dirs.push(dir)
  return join(dir, 'drafts')
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const place = { workspaceId: 'w1', holder: 'env_box', file: draftFileOf({ path: '/w/Notes.md', at: 'file', host: 'env_box' }) }
const draft = (text: string, base = 'v1', at = 1): Draft => ({ ...place, base, name: 'Notes.md', at, body: { kind: 'text', text, bom: false, crlf: false } })

describe('the draft store', () => {
  it('keeps the newest edit of a draft through a restart, by its base', async () => {
    const store = new DraftStore(scratch())
    store.put(draft('one', 'v1', 1), 7)
    store.put(draft('one two', 'v1', 2), 7)
    await store.settled()
    const again = new DraftStore(store.dir)
    expect(await again.list(place)).toEqual([draft('one two', 'v1', 2)])
  })

  it('offers no draft a live window is editing, and offers it once that window lets it go', async () => {
    const store = new DraftStore(scratch())
    store.put(draft('mine'), 7)
    expect(await store.list(place)).toEqual([])
    store.releaseOwner(7)
    expect(await store.list(place)).toEqual([draft('mine')])
    await store.settled()
  })

  it('drops a draft the host acknowledged, and its folder with it', async () => {
    const store = new DraftStore(scratch())
    store.put(draft('sent'))
    store.drop(draft('sent'))
    await store.settled()
    expect(await new DraftStore(store.dir).list(place)).toEqual([])
    expect(readdirSync(store.dir)).toEqual([])
  })

  it('keeps one draft a base, newest first, and never another file’s', async () => {
    const store = new DraftStore(scratch())
    store.put(draft('old base', 'v1', 1))
    store.put(draft('new base', 'v2', 2))
    store.put({ ...draft('other file'), file: draftFileOf({ at: 'file', host: 'env_box', path: '/w/Other.md' }) })
    await store.settled()
    expect((await new DraftStore(store.dir).list(place)).map((d) => (d.body.kind === 'text' ? d.body.text : null))).toEqual(['new base', 'old base'])
  })

  it('names one file one way whatever order its source was written in', () => {
    expect(draftFileOf({ at: 'file', host: 'h', path: '/p' })).toBe(draftFileOf({ path: '/p', host: 'h', at: 'file' }))
  })

  it('takes from a window only a draft of a kind it keeps, with every key', () => {
    expect(draftOf(draft('x'))).toEqual(draft('x'))
    expect(draftOf({ ...draft('x'), base: '' })).toBeNull()
    expect(draftOf({ ...draft('x'), body: { kind: 'sheet' } })).toBeNull()
    expect(draftOf({ ...draft('x'), body: { kind: 'sheet', mutations: [] } })).toBeNull()
    const cells = { kind: 'sheet', mutations: [{ id: 'sheet.mutation.set-range-values', params: { cellValue: { 0: { 0: { v: 42 } } } } }] }
    expect(draftOf({ ...draft('x'), body: cells })?.body).toEqual(cells)
    expect(draftOf({ ...draft('x'), body: { kind: 'sheet', mutations: [{ id: 'x', params: 'y'.repeat(4 * 1024 * 1024) }] } })).toBeNull()
    expect(draftOf({ ...draft('x'), body: { kind: 'other' } })).toBeNull()
    const box = { kind: 'deck', slideId: 3, shapeId: 2, words: [['Who comes']], model: [{ runs: [{ text: 'Who comes today' }] }] }
    expect(draftOf({ ...draft('x'), body: box })?.body).toEqual(box)
    expect(draftOf({ ...draft('x'), body: { ...box, words: [[1]] } })).toBeNull()
    expect(draftOf({ ...draft('x'), body: { ...box, slideId: 'x' } })).toBeNull()
    expect(draftOf({ ...draft('x'), body: { kind: 'document', frames: ['AmQxAAIq'] } })?.body).toEqual({ kind: 'document', frames: ['AmQxAAIq'] })
    expect(draftOf({ ...draft('x'), body: { kind: 'document', frames: ['not base64!'] } })).toBeNull()
    expect(draftOf({ ...draft('x'), body: { kind: 'document', frames: [] } })).toBeNull()
    expect(draftOf({ ...draft('x'), body: { kind: 'text', text: 'x'.repeat(4 * 1024 * 1024 + 1) } })).toBeNull()
  })
})
