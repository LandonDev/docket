import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fileDocName } from 'work-kit/collab-server'
import { filesPaneOf } from '@shared/work'
import { refKey } from '@shared/work/files'
import { madeFromShared, othersOpen } from '../docs/target'
import { privateBranchDir } from '../history/privateBranches'
import { servicePaths } from '../service/config'
import type { WorkCtx } from '../modules'
import { closeFilesState } from './handle'
import { HOST, makeRig, WS, type Rig } from './testkit'
import { wordRow } from './word'
import { inWordStore, settleWordStore, wordStoreDocs, wordStoreOf, wordStoreRoot } from './wordStore'

/**
 * The hidden Word store (wordStore.ts): a Word file of another computer's document and its "before" copy leave his
 * folder for a folder of the app's own data, every record still counted shared, the old files kept until a later
 * start reads the records back. Dummy files only.
 */

const MAC = 'env_mac'
let box: Rig
beforeEach(() => {
  box = makeRig()
})
afterEach(() => {
  closeFilesState(box.db)
  box.close()
})

/** A record an older build left: its document (and maybe its "before" copy) in the workspace's own folder, shown in a Files tab's item. */
function olderRecord(name: string, opts: { original?: boolean } = {}) {
  const stem = name.replace(/\.docx$/, '')
  const doc = join(box.folder, `${stem}.tcdoc`)
  writeFileSync(doc, `{"doc":"${stem}"}`)
  const original = opts.original ? join(box.folder, `${stem} (before TempCode saved it).docx`) : null
  if (original) writeFileSync(original, 'the colleague’s bytes')
  const at = Math.round(statSync(doc).mtimeMs)
  box.db
    .prepare(`INSERT INTO work_files_word (workspace_id, host, path, vm, name, version, sha, doc, doc_at, saved_at, saved_doc_at, original, at) VALUES (?, ?, ?, 0, ?, 'v1', 'sha', ?, ?, NULL, NULL, ?, 1)`)
    .run(WS, MAC, `/Users/him/Teams/General/${name}`, name, doc, at, original)
  const item = box.canvas.open(filesPaneOf(WS), { kind: 'document', source: { at: 'file', host: HOST, path: doc }, title: stem })
  box.db.prepare(`CREATE TABLE IF NOT EXISTS work_docs_threads (doc TEXT PRIMARY KEY, rows TEXT NOT NULL)`).run()
  box.db.prepare(`INSERT INTO work_docs_threads (doc, rows) VALUES (?, '[{"id":"c1"}]')`).run(fileDocName(doc))
  return { doc, original, item, path: `/Users/him/Teams/General/${name}` }
}

/** The same database read again from disk by a new connection: what the next start sees. */
function reopened(): { ctx: WorkCtx; db: DatabaseSync } {
  const file = join(box.base, 'restart.db')
  box.db.exec(`VACUUM INTO '${file}'`)
  const db = new DatabaseSync(file)
  return { db, ctx: { ...box.ctx, db } as WorkCtx }
}

describe('the Word store takes what an older build left in his folder', () => {
  it('copies the document and its "before" copy, points everything at the copies, and keeps the old files for now', () => {
    const a = olderRecord('Plan.docx', { original: true })
    const store = wordStoreOf(box.dataDir, WS)
    expect(settleWordStore(box.ctx)).toEqual({ moved: 2, forgotten: 0 })
    const row = wordRow(box.ctx, WS, MAC, a.path)!
    expect(row.doc).toBe(join(store, 'Plan.tcdoc'))
    expect(row.original).toBe(join(store, 'Plan (before TempCode saved it).docx'))
    expect(readFileSync(row.doc!, 'utf8')).toBe('{"doc":"Plan"}')
    // Its time came with it: the document still reads as unchanged since it was made.
    expect(row.doc_at).toBe(Math.round(statSync(row.doc!).mtimeMs))
    // The tab's item and the document's comments follow it.
    expect(box.canvas.get(a.item.id)?.source).toMatchObject({ path: row.doc })
    expect(box.db.prepare(`SELECT rows FROM work_docs_threads WHERE doc = ?`).get(fileDocName(row.doc!))).toBeTruthy()
    // Nothing is lost before the record reads back at a later start: the old files are still there.
    expect(existsSync(a.doc)).toBe(true)
    expect(existsSync(a.original!)).toBe(true)
  })

  it('every migrated record still counts shared to the hold: by its record, and by where it lies with none', () => {
    const records = ['Plan.docx', 'Roster.docx', 'Agenda.docx'].map((n) => olderRecord(n, { original: true }))
    settleWordStore(box.ctx)
    const rows = box.db.prepare(`SELECT doc, original FROM work_files_word`).all() as { doc: string; original: string }[]
    expect(rows).toHaveLength(records.length)
    for (const r of rows) {
      expect(inWordStore(box.dataDir, r.doc)).toBe(true)
      expect(madeFromShared(box.ctx, { at: 'file', host: HOST, path: r.doc })).toBe(true)
      expect(othersOpen(box.ctx, { at: 'file', doc: fileDocName(r.doc), path: r.doc, source: { at: 'file', host: HOST, path: r.doc } }, null)).toBe(true)
      expect(madeFromShared(box.ctx, { at: 'file', host: HOST, path: r.original })).toBe(true)
    }
    // A document in the store whose record went counts shared all the same.
    box.db.exec(`DELETE FROM work_files_word`)
    for (const r of rows) expect(madeFromShared(box.ctx, { at: 'file', host: HOST, path: r.doc })).toBe(true)
  })

  it('lets the old files go only at a later start, once the records read back from disk naming the copies', () => {
    const a = olderRecord('Plan.docx', { original: true })
    settleWordStore(box.ctx)
    const next = reopened()
    try {
      const row = wordRow(next.ctx, WS, MAC, a.path)!
      expect(inWordStore(box.dataDir, row.doc!)).toBe(true)
      expect(madeFromShared(next.ctx, { at: 'file', host: HOST, path: row.doc! })).toBe(true)
      expect(settleWordStore(next.ctx)).toEqual({ moved: 0, forgotten: 2 })
      expect(existsSync(a.doc)).toBe(false)
      expect(existsSync(a.original!)).toBe(false)
      expect(readFileSync(row.doc!, 'utf8')).toBe('{"doc":"Plan"}')
      // His folder holds nothing the store made.
      expect(readdirSync(box.folder).filter((n) => n.startsWith('Plan'))).toEqual([])
    } finally {
      next.db.close()
    }
  })

  it('keeps an old file that changed after it was copied (the service stored his last words into it)', () => {
    const a = olderRecord('Plan.docx')
    settleWordStore(box.ctx)
    writeFileSync(a.doc, '{"doc":"his late words"}')
    expect(settleWordStore(box.ctx)).toEqual({ moved: 0, forgotten: 0 })
    expect(readFileSync(a.doc, 'utf8')).toBe('{"doc":"his late words"}')
  })

  it('keeps the old file when its record no longer names the copy', () => {
    const a = olderRecord('Plan.docx')
    settleWordStore(box.ctx)
    box.db.exec(`DELETE FROM work_files_word`)
    expect(settleWordStore(box.ctx).forgotten).toBe(0)
    expect(existsSync(a.doc)).toBe(true)
  })

  it('leaves a document whose edits wait in the service journal for a later start', () => {
    const a = olderRecord('Plan.docx')
    const journal = join(servicePaths(box.dataDir).serviceDir, 'journal')
    mkdirSync(journal, { recursive: true })
    writeFileSync(join(journal, `${fileDocName(a.doc).replace(/:/g, '~')}.1.log`), 'owed')
    expect(settleWordStore(box.ctx).moved).toBe(0)
    expect(wordRow(box.ctx, WS, MAC, a.path)?.doc).toBe(a.doc)
  })

  it("carries an agent's private branches with the document, and drops the old folder at the later start", () => {
    const a = olderRecord('Plan.docx')
    const root = join(servicePaths(box.dataDir).serviceDir, 'private-branches')
    mkdirSync(privateBranchDir(root, a.doc), { recursive: true })
    writeFileSync(join(privateBranchDir(root, a.doc), 'index.json'), '[{"id":"b1"}]')
    settleWordStore(box.ctx)
    const doc = wordRow(box.ctx, WS, MAC, a.path)!.doc!
    expect(readFileSync(join(privateBranchDir(root, doc), 'index.json'), 'utf8')).toBe('[{"id":"b1"}]')
    expect(existsSync(privateBranchDir(root, a.doc))).toBe(true)
    settleWordStore(box.ctx)
    expect(existsSync(privateBranchDir(root, a.doc))).toBe(false)
  })

  it('drops a star or a recent that named the document in his folder', () => {
    const a = olderRecord('Plan.docx')
    const key = refKey({ at: 'file', host: HOST, path: a.doc })
    box.db.prepare(`INSERT INTO work_files_marks (workspace_id, ref_key, ref, name, opened_at) VALUES (?, ?, ?, ?, 1)`).run(WS, key, JSON.stringify({ file: { at: 'file', host: HOST, path: a.doc } }), basename(a.doc))
    settleWordStore(box.ctx)
    expect(box.db.prepare(`SELECT count(*) AS n FROM work_files_marks`).get()).toEqual({ n: 0 })
  })
})

describe("a remote key's reach into the store", () => {
  it('names each kept document alone, never the store folder or another file in it', () => {
    olderRecord('Plan.docx', { original: true })
    settleWordStore(box.ctx)
    const docs = wordStoreDocs(box.db, box.dataDir)
    expect(docs).toEqual([join(wordStoreOf(box.dataDir, WS), 'Plan.tcdoc')])
    expect(docs).not.toContain(wordStoreRoot(box.dataDir))
    expect(docs.some((d) => d.endsWith('.docx'))).toBe(false)
  })
})
