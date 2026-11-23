import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { ChangeStore, ensureChangeTables, type ChangeAsk } from './changes'
import { ensureSuggestionTables, SuggestionStore } from './suggestions'
import { sheetWaiting } from './waiting'

/** A format or a rule an agent proposed, kept on this host until the owner takes or drops it. */
let db: DatabaseSync
let store: ChangeStore
let t = 0
const ASK: ChangeAsk = { kind: 'format', range: 'B2:B9', format: { bold: true } }
const add = (key: string, id: string, over: Partial<Parameters<ChangeStore['add']>[1]> = {}): void =>
  store.add(key, { id, changeSet: `set-${id}`, by: 'agent:h:t1', sheet: 's1', range: { startRow: 1, endRow: 8, startColumn: 1, endColumn: 1 }, words: 'Bold on B2:B9', ask: ASK, rev: 3, ...over })

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  ensureChangeTables(db)
  t = 0
  store = new ChangeStore(db, () => ++t)
})

describe('the changes a sheet holds', () => {
  it('are kept with their ask and the revision the agent saw, and shown without the ask, oldest first', () => {
    add('file:/a.xlsx', 'f1', { reason: 'the totals' })
    add('file:/a.xlsx', 'r1', { range: null, words: 'The name Budgeted for B2:B9', ask: { kind: 'rule', rule: { kind: 'name', name: 'Budgeted', refersTo: 'B2:B9' } } })
    add('file:/b.xlsx', 'x')
    expect(store.held('file:/a.xlsx').map((c) => [c.id, c.kind, c.rev, c.ask.kind])).toEqual([
      ['f1', 'format', 3, 'format'],
      ['r1', 'rule', 3, 'rule']
    ])
    const shown = store.open('file:/a.xlsx')
    expect(shown[0]).toEqual({ id: 'f1', changeSet: 'set-f1', by: 'agent:h:t1', kind: 'format', sheet: 's1', range: { startRow: 1, endRow: 8, startColumn: 1, endColumn: 1 }, words: 'Bold on B2:B9', state: 'pending', reason: 'the totals' })
    expect(shown[1]).toMatchObject({ range: null, kind: 'rule' })
    expect(JSON.stringify(shown)).not.toContain('"ask"')
  })

  it('are picked by id, by change set or all; taken or dropped, one is gone for good', () => {
    add('k', 'a')
    add('k', 'b')
    add('k', 'c')
    expect(store.pick('k', { ids: ['b', 'nope'] }).map((c) => c.id)).toEqual(['b'])
    expect(store.pick('k', { changeSet: 'set-c' }).map((c) => c.id)).toEqual(['c'])
    expect(store.pick('k', 'all')).toHaveLength(3)
    store.mark('k', ['a'], 'accepted')
    store.mark('k', ['b'], 'rejected')
    expect(store.open('k').map((c) => c.id)).toEqual(['c'])
    // a decided one is not opened again
    store.mark('k', ['a'], 'orphaned')
    expect(store.open('k').map((c) => c.id)).toEqual(['c'])
  })

  it('turn orphaned together when rows, columns or sheets change, and can then only be dropped', () => {
    add('k', 'a')
    add('k', 'name', { range: null })
    add('other', 'z')
    store.orphanAll('k')
    expect(store.open('k').map((c) => c.state)).toEqual(['orphaned', 'orphaned'])
    expect(store.open('other').map((c) => c.state)).toEqual(['pending'])
    store.mark('k', ['a', 'name'], 'rejected')
    expect(store.open('k')).toEqual([])
  })
})

describe('what Files is told waits in a workbook', () => {
  it('counts a proposed format or rule with the cell suggestions, by the file\'s path, and lists the files that hold any', () => {
    ensureSuggestionTables(db)
    const cells = new SuggestionStore(db, () => ++t)
    cells.add('file:/work/a.xlsx', 'cs1', 'agent:h:t1', undefined, [{ sheet: 's1', row: 0, col: 0, base: null, proposed: { v: 1 } }])
    add('file:/work/a.xlsx', 'f1')
    add('file:/work/b.xlsx', 'f2')
    add('tcsheet:/work/c.tcsheet', 'f3')
    const at = (path: string) => ({ at: 'file' as const, host: 'h', path })
    expect(sheetWaiting.count([at('/work/a.xlsx'), at('/work/b.xlsx'), at('/work/none.xlsx'), at('/work/c.tcsheet'), at('/work/notes.docx')], db)).toEqual([2, 1, 0, 0, 0])
    expect(sheetWaiting.files(db, 'h', 10).map((f) => [(f.source as { path: string }).path, f.count]).sort()).toEqual([
      ['/work/a.xlsx', 2],
      ['/work/b.xlsx', 1]
    ])
  })

  it('answers in a database where the sheets module has made no table of changes yet', () => {
    const bare = new DatabaseSync(':memory:')
    ensureSuggestionTables(bare)
    expect(sheetWaiting.count([{ at: 'file', host: 'h', path: '/a.xlsx' }], bare)).toEqual([0])
    expect(sheetWaiting.files(bare, 'h', 5)).toEqual([])
  })
})
