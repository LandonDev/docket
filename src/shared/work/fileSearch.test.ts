import { describe, expect, it } from 'vitest'
import type { SavedFileSearch } from '../contract-work-files'
import { DEFAULT_SPEC, type FindSpec, type SavedFindView } from './docFind'
import { matchesName, nameWords, parseGoTo, rankName, searchOfView, viewOfSearch } from './fileSearch'

describe('names', () => {
  it('match when every word is in the name, case-blind', () => {
    expect(matchesName('Spring Budget 2026.xlsx', nameWords('budget SPRING'))).toBe(true)
    expect(matchesName('Spring Budget.xlsx', nameWords('budget fall'))).toBe(false)
    expect(matchesName('Anything', [])).toBe(true)
  })

  it('rank a word that starts the name over one that starts a word in it, over one inside a word', () => {
    const words = nameWords('bud')
    const start = rankName('Budget.xlsx', words)
    const word = rankName('Spring budget.xlsx', words)
    const inside = rankName('Rosebud.png', words)
    expect(start).toBeGreaterThan(word)
    expect(word).toBeGreaterThan(inside)
    expect(inside).toBeGreaterThan(0)
    expect(rankName('Plan.docx', words)).toBe(0)
  })

  it('read a word with a stop in it as typed', () => {
    expect(rankName('a.b (1).txt', nameWords('(1)'))).toBeGreaterThan(0)
  })
})

describe('Go to', () => {
  it('reads each way of asking for a new thing, case-blind, with or without called or named', () => {
    expect(parseGoTo('new sheet called travel')).toEqual({ kind: 'new', what: 'sheet', name: 'travel' })
    expect(parseGoTo('New Doc named Spring Plan')).toEqual({ kind: 'new', what: 'document', name: 'Spring Plan' })
    expect(parseGoTo('new document Budget notes')).toEqual({ kind: 'new', what: 'document', name: 'Budget notes' })
    expect(parseGoTo('new folder called Receipts')).toEqual({ kind: 'new', what: 'folder', name: 'Receipts' })
    expect(parseGoTo('new deck Kickoff')).toEqual({ kind: 'new', what: 'deck', name: 'Kickoff' })
    expect(parseGoTo('new note shopping')).toEqual({ kind: 'new', what: 'text', name: 'shopping' })
    expect(parseGoTo('new text file called todo')).toEqual({ kind: 'new', what: 'text', name: 'todo' })
    expect(parseGoTo('NEW SPREADSHEET')).toEqual({ kind: 'new', what: 'sheet', name: '' })
    expect(parseGoTo('new sheet called')).toEqual({ kind: 'new', what: 'sheet', name: '' })
  })

  it('finds anything else, a word that only starts like one included', () => {
    expect(parseGoTo('  travel budget ')).toEqual({ kind: 'find', text: 'travel budget' })
    expect(parseGoTo('new')).toEqual({ kind: 'find', text: 'new' })
    expect(parseGoTo('news report')).toEqual({ kind: 'find', text: 'news report' })
    expect(parseGoTo('new documents')).toEqual({ kind: 'find', text: 'new documents' })
    expect(parseGoTo('renew sheet')).toEqual({ kind: 'find', text: 'renew sheet' })
  })
})

describe('saved searches as Docs views', () => {
  const full: FindSpec = {
    query: 'budget',
    filter: { projects: ['p1'], kinds: ['document', 'slides', 'media', 'form'], where: ['lifeos', 'google'], shared: true, by: ['agent'], within: 'week', after: 10, before: 20, review: true, held: true },
    group: 'kind',
    sort: 'name',
    layout: 'table'
  }

  it('reads every field of a Docs view it can say, and keeps the view whole beside it', () => {
    const got = searchOfView({ id: 'v1', name: 'Budgets', spec: full })
    expect(got).toEqual({
      id: 'v1',
      name: 'Budgets',
      query: 'budget',
      filter: { kinds: ['document', 'deck', 'picture', 'video'], places: ['lifeos'], project: 'p1', who: 'agent', within: 'week', after: 10, before: 20, shared: true, review: true },
      docs: full
    })
  })

  it('gives a Docs view back exactly as it was, every field, when the search is saved unchanged', () => {
    for (const spec of [full, DEFAULT_SPEC, { ...DEFAULT_SPEC, filter: { projects: ['a', 'b'], by: ['guest'], where: ['thread'] } }, { ...DEFAULT_SPEC, filter: { by: ['owner'], shared: false, kinds: ['meeting'] } }] as FindSpec[]) {
      const view: SavedFindView = { id: 'v1', name: 'A view', spec }
      expect(viewOfSearch(searchOfView(view))).toEqual(view)
    }
  })

  it('changes only what the search changed, keeping Docs’ own settings and filters', () => {
    const search = searchOfView({ id: 'v1', name: 'Budgets', spec: full })
    const got = viewOfSearch({ ...search, name: 'Pictures', query: 'poster', filter: { ...search.filter, kinds: ['picture'], who: 'Dana' } })
    expect(got).toEqual({
      id: 'v1',
      name: 'Pictures',
      spec: { ...full, query: 'poster', filter: { ...full.filter, kinds: ['media'], by: undefined }, files: { kinds: ['picture'], who: 'Dana' } }
    })
    expect(got.spec.filter).not.toHaveProperty('by')
    // Docs' own: held acts, grouping, order and layout.
    expect(got.spec).toMatchObject({ group: 'kind', sort: 'name', layout: 'table', filter: { within: 'week', held: true } })
  })

  it('gives a search back as it was, every field, through a view of its own', () => {
    const searches: SavedFileSearch[] = [
      { id: 's1', name: 'Everything', query: '' },
      { id: 's2', name: 'PDFs this week', query: '', filter: { kinds: ['pdf'], within: 'week' } },
      { id: 's2b', name: 'PDFs since', query: '', filter: { kinds: ['pdf'], after: 1_700_000_000_000 } },
      { id: 's3', name: 'All of it', query: 'spring lan', filter: { kinds: ['folder', 'picture', 'text'], places: ['folder', 'env_box~abc/General', 'lifeos'], project: 'p9', who: 'Dana', after: 1, before: 2, shared: false, review: true } },
      { id: 's4', name: 'Mine', query: 'x', filter: { who: 'me', shared: true } }
    ]
    for (const search of searches) {
      const view = viewOfSearch(search)
      const back = searchOfView({ id: search.id, name: view.name, spec: view.spec })
      expect({ ...back, docs: undefined }).toEqual({ ...search, docs: undefined })
    }
  })

  it('says each part in Docs’ words where Docs has them', () => {
    const { spec } = viewOfSearch({ name: 'x', query: 'q', filter: { kinds: ['deck', 'audio', 'folder'], places: ['folder', 'env_box~abc/General'], project: 'p1', who: 'me', shared: true } })
    expect(spec).toEqual({ ...DEFAULT_SPEC, query: 'q', filter: { kinds: ['slides', 'meeting'], where: ['folder', 'microsoft'], projects: ['p1'], by: ['owner'], shared: true }, files: { kinds: ['deck', 'audio', 'folder'], places: ['folder', 'env_box~abc/General'], who: 'me' } })
  })
})
