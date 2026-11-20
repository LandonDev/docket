import { describe, expect, it } from 'vitest'
import { editedBucket, filterCount, findIn, groupRows, kindOfFile, kindOfMime, passes, queryTerms, snippetOf, type FindEntry } from './docFind'

const NOW = new Date(2026, 10, 19, 15, 0).getTime()
const DAY = 86_400_000

const entry = (o: Partial<FindEntry> & { key: string; title: string }): FindEntry => ({
  kind: 'document',
  where: 'lifeos',
  source: { at: 'lifeos', table: 'docs', id: o.key },
  editedAt: NOW,
  createdAt: NOW - 10 * DAY,
  shared: false,
  guest: false,
  comments: 0,
  waiting: 0,
  held: 0,
  ...o
})

const budget = entry({ key: 'b', title: 'Q3 Budget', kind: 'sheet', projectId: 'p1', editedAt: NOW - 20 * DAY, createdAt: NOW - 40 * DAY, lastBy: 'agent' })
const brief = entry({ key: 'r', title: 'Brief', projectId: 'p2', comments: 2, lastBy: 'owner', createdAt: NOW - 50 * DAY })
const scan = entry({ key: 'f', title: 'scan.pdf', kind: 'pdf', where: 'folder', editedAt: NOW - 2 * DAY, guest: true, held: 1 })

describe('the filters', () => {
  it('hold all at once, each list part by any one of it', () => {
    const all = [budget, brief, scan]
    const keys = (f: Parameters<typeof passes>[1]) => all.filter((e) => passes(e, f, NOW)).map((e) => e.key)
    expect(keys({})).toEqual(['b', 'r', 'f'])
    expect(keys({ kinds: ['sheet', 'pdf'] })).toEqual(['b', 'f'])
    expect(keys({ projects: [''] })).toEqual(['f'])
    expect(keys({ projects: ['p1', 'p2'], by: ['owner'] })).toEqual(['r'])
    expect(keys({ where: ['folder'] })).toEqual(['f'])
    expect(keys({ shared: true })).toEqual(['f'])
    expect(keys({ within: 'week' })).toEqual(['r', 'f'])
    expect(keys({ after: NOW - 30 * DAY, before: NOW - 10 * DAY })).toEqual(['b'])
    expect(keys({ review: true })).toEqual(['r'])
    expect(keys({ held: true })).toEqual(['f'])
    expect(keys({ by: ['guest'] })).toEqual([])
  })

  it('count what is set', () => {
    expect(filterCount({})).toBe(0)
    expect(filterCount({ kinds: [], shared: false })).toBe(0)
    expect(filterCount({ kinds: ['pdf'], within: 'day', held: true })).toBe(3)
  })
})

describe('a search', () => {
  it('matches every word in the title, or a text hit, title matches first', () => {
    const hits = new Map([['r', '…the budget for the trip…']])
    const got = findIn([budget, brief, scan], { query: 'budget', filter: {}, sort: 'edited' }, hits, NOW)
    expect(got.map((e) => e.key)).toEqual(['b', 'r'])
    expect(got[1]!.snippet).toBe('…the budget for the trip…')
    expect(findIn([budget], { query: 'q3 "budget"', filter: {}, sort: 'edited' }, new Map(), NOW)).toHaveLength(1)
    expect(findIn([budget], { query: 'q3 plan', filter: {}, sort: 'edited' }, new Map(), NOW)).toHaveLength(0)
    expect(queryTerms('  "Budget,"  q3 ')).toEqual(['budget', 'q3'])
  })

  it('sorts by edit, creation or name', () => {
    const keys = (sort: 'edited' | 'created' | 'name') => findIn([budget, brief, scan], { query: '', filter: {}, sort }, new Map(), NOW).map((e) => e.key)
    expect(keys('edited')).toEqual(['r', 'f', 'b'])
    expect(keys('created')).toEqual(['f', 'b', 'r'])
    expect(keys('name')).toEqual(['r', 'b', 'f'])
  })
})

describe('the groups', () => {
  const names = new Map([['p1', 'Plans'], ['p2', 'Admin']])
  const labels = (g: Parameters<typeof groupRows>[1]) => groupRows([budget, brief, scan], g, names, NOW).map((x) => `${x.label}:${x.rows.map((r) => r.key).join('')}`)

  it('go by project with loose rows last, kind, place and span', () => {
    expect(labels('project')).toEqual(['Admin:r', 'Plans:b', 'No project:f'])
    expect(labels('kind')).toEqual(['Document:r', 'Sheet:b', 'PDF:f'])
    expect(labels('where')).toEqual(['LifeOS:br', 'Folder:f'])
    expect(labels('edited')).toEqual(['Today:r', 'Past week:f', 'Past month:b'])
    expect(labels('none')).toEqual([':brf'])
    expect(groupRows([], 'none', names, NOW)).toEqual([])
  })

  it('name spans by the calendar', () => {
    expect(editedBucket(NOW - 16 * 3_600_000, NOW).label).toBe('Yesterday')
    expect(editedBucket(NOW - 400 * DAY, NOW).label).toBe('Older')
  })
})

describe('kinds of files', () => {
  it('follow the canvas kinds', () => {
    expect(['a.TCDOC', 'b.xlsx', 'c.pdf', 'd.pptx', 'e.mov', 'f.m4a', 'g.zip', 'noext', 'h.md'].map(kindOfFile)).toEqual(['document', 'sheet', 'pdf', 'slides', 'media', 'meeting', null, null, 'document'])
    expect(kindOfMime('application/vnd.google-apps.spreadsheet')).toBe('sheet')
    expect(kindOfMime('application/zip')).toBeNull()
  })
})

describe('a snippet', () => {
  it('is the words around the first match, cut at word ends', () => {
    const text = `${'word '.repeat(40)}needle ${'tail '.repeat(40)}`
    const got = snippetOf(text, ['NEEDLE'])
    expect(got.startsWith('…word')).toBe(true)
    expect(got.endsWith('tail…')).toBe(true)
    expect(snippetOf('short text', ['text'])).toBe('short text')
    expect(snippetOf('nothing here', ['absent'])).toBe('')
  })
})
