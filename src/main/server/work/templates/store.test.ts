import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { templates } from '.'
import type { WorkCtx } from '../modules'
import { ensureTemplatesTables, TemplatesStore } from './store'

let db: DatabaseSync
let store: TemplatesStore
beforeEach(() => {
  db = new DatabaseSync(':memory:')
  ensureTemplatesTables(db)
  store = new TemplatesStore(db)
})

describe('the fields index', () => {
  it('answers what was kept only while the file has the same size and time', () => {
    expect(store.fields('/t/Memo.docx', 10, 5)).toBeNull()
    store.keep('/t/Memo.docx', 10, 5, ['To', 'Subject'])
    expect(store.fields('/t/Memo.docx', 10, 5)).toEqual(['To', 'Subject'])
    expect(store.fields('/t/Memo.docx', 11, 5)).toBeNull()
    expect(store.fields('/t/Memo.docx', 10, 6)).toBeNull()
    store.keep('/t/Memo.docx', 11, 6, [])
    expect(store.fields('/t/Memo.docx', 11, 6)).toEqual([])
  })

  it('reads a row that no longer parses as never read', () => {
    db.prepare('INSERT INTO work_templates_index VALUES (?, ?, ?, ?)').run('/t/a.docx', 1, 1, 'not json')
    db.prepare('INSERT INTO work_templates_index VALUES (?, ?, ?, ?)').run('/t/b.docx', 1, 1, '{"a":1}')
    expect(store.fields('/t/a.docx', 1, 1)).toBeNull()
    expect(store.fields('/t/b.docx', 1, 1)).toBeNull()
  })

  it("drops a folder's rows whose files are gone, and no other folder's", () => {
    for (const path of ['/t/a.docx', '/t/b.docx', '/t/sub/c.docx', '/tt/d.docx', '/other/e.docx']) store.keep(path, 1, 1, [])
    store.prune('/t', new Set(['/t/a.docx']))
    const left = (db.prepare('SELECT path FROM work_templates_index ORDER BY path').all() as { path: string }[]).map((r) => r.path)
    expect(left).toEqual(['/other/e.docx', '/t/a.docx', '/t/sub/c.docx', '/tt/d.docx'])
  })
})

describe('hidden starters', () => {
  it('are kept by workspace, once each, and all shown again at once', () => {
    store.hide('w1', 'ref/game-report')
    store.hide('w1', 'ref/game-report')
    store.hide('w1', 'any/meeting-notes')
    store.hide('w2', 'ref/game-report')
    expect([...store.hidden('w1')].sort()).toEqual(['any/meeting-notes', 'ref/game-report'])
    store.unhide('w1')
    expect(store.hidden('w1').size).toBe(0)
    expect([...store.hidden('w2')]).toEqual(['ref/game-report'])
  })

  it('go with their workspace', () => {
    store.hide('w1', 'ref/game-report')
    store.hide('w2', 'ref/game-report')
    templates.workspaceRemoved!('w1', { db } as unknown as WorkCtx)
    expect(store.hidden('w1').size).toBe(0)
    expect(store.hidden('w2').size).toBe(1)
  })
})

describe('ensure', () => {
  it('runs twice and keeps what is there', () => {
    store.hide('w1', 'x/y')
    templates.ensure(db)
    expect(store.hidden('w1').size).toBe(1)
  })
})
