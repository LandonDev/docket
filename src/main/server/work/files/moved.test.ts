import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fileDocName } from 'work-kit/collab-server'
import { ClientRequestSchema } from '@shared/contract'
import type { FileDone, FilesListing, FilesOpened, FilesTabs } from '@shared/contract-work-files'
import { filesPaneOf, type CanvasSource } from '@shared/work'
import { ensureModeTable } from '../docs/state'
import { ensureThreadTables } from '../docs/threads'
import { ensureMediaTables } from '../media/store'
import { ensureMeetingTables } from '../meetings/store'
import type { Caller } from '../modules'
import { closeFilesState } from './handle'
import { registerFileMoved } from './hooks'
import { files } from './index'
import { movedSource } from './moved'
import { at, HOST, makeRig, window, WS, type Rig } from './testkit'

/** Rename and move carry what hangs on a file (docs/agents/work-files.md "New, rename, move and copy"). */

let rig: Rig
let ops = 0
const offs: (() => void)[] = []
beforeEach(() => {
  rig = makeRig()
})
afterEach(() => {
  for (const off of offs.splice(0)) off()
  closeFilesState(rig.db)
  rig.close()
})

async function call<T = FileDone>(method: string, params: Record<string, unknown>, by: Caller = window): Promise<T> {
  const req = ClientRequestSchema.parse({ id: '1', method, params: { workspaceId: WS, ...params } })
  const out = await files.handle!(req, rig.ctx, by)
  if (!out.handled) throw new Error(`${method} was not handled`)
  return out.result as T
}
const op = (): string => `op-moved-${++ops}`
const rename = (path: string, name: string) => call('work.files.rename', { ref: at(path), name, op: op() })
const inFolder = (...p: string[]) => join(rig.folder, ...p)
const sourceOf = (id: string): CanvasSource => rig.canvas.get(id)!.source

describe('a rename carries what hangs on the file', () => {
  it('re-points a thread\'s item and a Files tab\'s, and the tab\'s key, its name and his star follow', async () => {
    const thread = rig.canvas.open('t1', { kind: 'document', source: at(inFolder('notes.txt')), title: 'notes.txt' })
    const opened = await call<FilesOpened>('work.files.open', { ref: at(inFolder('notes.txt')) })
    await call('work.files.star', { ref: at(inFolder('notes.txt')), name: 'notes.txt', on: true })
    const before = (await call<FilesTabs>('work.files.tabs', {})).rev
    rig.pushes.length = 0

    await rename(inFolder('notes.txt'), 'kickoff.txt')

    expect(sourceOf(thread.id)).toEqual(at(inFolder('kickoff.txt')))
    expect(rig.canvas.get(thread.id)).toMatchObject({ title: 'kickoff.txt', rev: thread.rev + 1 })
    expect(sourceOf(opened.item!.id)).toEqual(at(inFolder('kickoff.txt')))
    const tabs = await call<FilesTabs>('work.files.tabs', {})
    expect(tabs.rev).toBe(before + 1)
    expect(tabs.tabs.find((t) => t.id === opened.tabId)).toMatchObject({ name: 'kickoff.txt', key: `file:${HOST}:${inFolder('kickoff.txt')}` })
    expect((await call<FilesListing>('work.files.list', { at: { at: 'place', id: 'starred' } })).entries.map((e) => [e.name, e.ref])).toEqual([['kickoff.txt', at(inFolder('kickoff.txt'))]])
    // Opening the file by its new name selects the same tab.
    expect((await call<FilesOpened>('work.files.open', { ref: at(inFolder('kickoff.txt')) })).tabId).toBe(opened.tabId)
    // Each owner's canvas list is said again, and the tabs' new revision.
    const said = rig.pushes.map(({ p }) => p as { push: string; sessionId?: string; tabs?: number })
    expect(said.filter((p) => p.push === 'work.canvas').map((p) => p.sessionId)).toEqual(expect.arrayContaining(['t1', filesPaneOf(WS)]))
    expect(said).toContainEqual({ push: 'work.files', workspaceId: WS, tabs: before + 1 })
  })

  it('re-points an item deep inside a renamed folder, and a page tab that stands on it', async () => {
    const deep = rig.canvas.open('t1', { kind: 'pdf', source: at(inFolder('Events', 'Spring LAN', 'Bracket.pdf')), title: 'Bracket.pdf' })
    const other = rig.canvas.open('t1', { kind: 'document', source: at(inFolder('Events 2026.tcdoc')), title: 'Events 2026.tcdoc' })
    const page = await call<FilesTabs & { tabId: string }>('work.files.tabOpen', { page: { at: at(inFolder('Events', 'Spring LAN')), name: 'Spring LAN' } })
    await call('work.files.tabOpen', { page: { at: at(inFolder('Events')), name: 'Events' } })

    await rename(inFolder('Events'), 'Shows')

    expect(sourceOf(deep.id)).toEqual(at(inFolder('Shows', 'Spring LAN', 'Bracket.pdf')))
    expect(rig.canvas.get(deep.id)!.title).toBe('Bracket.pdf')
    // A name that only starts like the folder's is another thing.
    expect(sourceOf(other.id)).toEqual(at(inFolder('Events 2026.tcdoc')))
    const tabs = (await call<FilesTabs>('work.files.tabs', {})).tabs
    expect(tabs.find((t) => t.id === page.tabId)!.page).toEqual({ at: at(inFolder('Shows', 'Spring LAN')), name: 'Spring LAN' })
    expect(tabs.map((t) => t.name)).toEqual(['Spring LAN', 'Shows'])
  })

  it("follows a library file, whose item names Word and whose star is the place's key", async () => {
    const plan = join(rig.team, 'General', 'Plan.docx')
    const item = rig.canvas.open('t1', { kind: 'document', source: { at: 'microsoft', host: HOST, app: 'word', name: 'Plan.docx', ref: { kind: 'path', path: plan } }, title: 'Plan.docx' })
    await call('work.files.star', { ref: at(plan), name: 'Plan.docx', on: true })
    await rename(plan, 'Plan 2026.docx')
    expect(sourceOf(item.id)).toEqual({ at: 'microsoft', host: HOST, app: 'word', name: 'Plan 2026.docx', ref: { kind: 'path', path: join(rig.team, 'General', 'Plan 2026.docx') } })
    const marks = rig.db.prepare(`SELECT ref_key, name FROM work_files_marks`).all()
    expect(marks).toEqual([{ ref_key: 'lib:esportsstaffgeneral:Plan 2026.docx', name: 'Plan 2026.docx' }])
  })

  it('carries a move into another folder the same way', async () => {
    const item = rig.canvas.open('t1', { kind: 'sheet', source: at(inFolder('Budget.xlsx')), title: 'Budget.xlsx' })
    await call('work.files.move', { refs: [at(inFolder('Budget.xlsx'))], to: at(inFolder('Events')), op: op() })
    expect(sourceOf(item.id)).toEqual(at(inFolder('Events', 'Budget.xlsx')))
  })
})

describe('the rows other pillars keep by a path', () => {
  it("re-keys a document's comment threads and its mode, for the file and for every document under a renamed folder", async () => {
    ensureThreadTables(rig.db)
    ensureModeTable(rig.db)
    writeFileSync(inFolder('Events', 'Spring LAN', 'Notes.tcdoc'), '{}')
    const put = (path: string): void => {
      rig.db.prepare(`INSERT INTO work_docs_threads (doc, rows) VALUES (?, '[1]')`).run(fileDocName(path))
      rig.db.prepare(`INSERT INTO work_docs_mode (doc, mode) VALUES (?, 'suggests')`).run(fileDocName(path))
    }
    put(inFolder('Run of show.tcdoc'))
    put(inFolder('Events', 'Spring LAN', 'Notes.tcdoc'))
    await rename(inFolder('Run of show.tcdoc'), 'Show.tcdoc')
    await rename(inFolder('Events'), 'Shows')
    const docs = (table: string): string[] => (rig.db.prepare(`SELECT doc FROM ${table} ORDER BY doc`).all() as { doc: string }[]).map((r) => r.doc)
    const want = [fileDocName(inFolder('Show.tcdoc')), fileDocName(inFolder('Shows', 'Spring LAN', 'Notes.tcdoc'))].sort()
    expect(docs('work_docs_threads')).toEqual(want)
    expect(docs('work_docs_mode')).toEqual(want)
  })

  it("re-points a media version's file and a meeting's recording, which those pillars play from", async () => {
    ensureMediaTables(rig.db)
    ensureMeetingTables(rig.db)
    writeFileSync(inFolder('Events', 'Recap.mp4'), 'video')
    rig.db.prepare(`INSERT INTO work_media_versions (id, item_id, session_id, n, name, source, added_at, added_by) VALUES ('v1', 'i1', 't1', 1, 'Recap.mp4', ?, 0, 'owner')`).run(JSON.stringify(at(inFolder('Events', 'Recap.mp4'))))
    rig.db.prepare(`INSERT INTO work_meetings (item_id, session_id, title, source, created_at, updated_at) VALUES ('m1', 't1', 'Standup', ?, 0, 0)`).run(JSON.stringify(at(inFolder('Events', 'Recap.mp4'))))
    await rename(inFolder('Events'), 'Shows')
    const want = JSON.stringify(at(inFolder('Shows', 'Recap.mp4')))
    expect(rig.db.prepare(`SELECT source FROM work_media_versions`).get()).toEqual({ source: want })
    expect(rig.db.prepare(`SELECT source FROM work_meetings`).get()).toEqual({ source: want })
  })

  it("calls each registered pillar's hook once per file, a folder's files each", async () => {
    const seen: string[] = []
    offs.push(registerFileMoved((from, to, o) => void seen.push(`${(from as { path: string }).path.slice(rig.folder.length)} > ${(to as { path: string }).path.slice(rig.folder.length)} @${o.host}`)))
    await rename(inFolder('notes.txt'), 'a.txt')
    await rename(inFolder('Events'), 'Shows')
    expect(seen.sort()).toEqual(['/Events/Poster.png > /Shows/Poster.png @env_box', '/Events/Spring LAN/Bracket.pdf > /Shows/Spring LAN/Bracket.pdf @env_box', '/notes.txt > /a.txt @env_box'])
  })
})

describe('a fault while carrying', () => {
  it('leaves the database and the disk as they were', async () => {
    const item = rig.canvas.open('t1', { kind: 'document', source: at(inFolder('notes.txt')), title: 'notes.txt' })
    await call('work.files.star', { ref: at(inFolder('notes.txt')), name: 'notes.txt', on: true })
    ensureThreadTables(rig.db)
    rig.db.prepare(`INSERT INTO work_docs_threads (doc, rows) VALUES (?, '[]')`).run(fileDocName(inFolder('notes.txt')))
    // A hook that writes before it throws: its write goes back with the rest.
    offs.push(registerFileMoved((_from, _to, o) => void o.db.prepare(`UPDATE work_canvas_items SET title = 'spoiled'`).run()))
    offs.push(
      registerFileMoved(() => {
        throw new Error('The comments could not be carried.')
      })
    )
    await expect(rename(inFolder('notes.txt'), 'kickoff.txt')).rejects.toThrow('The comments could not be carried.')
    expect(existsSync(inFolder('notes.txt'))).toBe(true)
    expect(existsSync(inFolder('kickoff.txt'))).toBe(false)
    expect(rig.canvas.get(item.id)).toMatchObject({ title: 'notes.txt', source: at(inFolder('notes.txt')), rev: item.rev })
    expect(rig.db.prepare(`SELECT ref_key FROM work_files_marks`).all()).toEqual([{ ref_key: `file:${HOST}:${inFolder('notes.txt')}` }])
    expect(rig.db.prepare(`SELECT doc FROM work_docs_threads`).all()).toEqual([{ doc: fileDocName(inFolder('notes.txt')) }])
  })

  it('moves a whole folder back, and reports it as that thing not moved', async () => {
    offs.push(
      registerFileMoved(() => {
        throw new Error('The comments could not be carried.')
      })
    )
    const done = await call('work.files.move', { refs: [at(inFolder('Events')), at(inFolder('notes.txt'))], to: at(inFolder('.hidden')), op: op() })
    expect(done).toMatchObject({ entries: [], refused: [{ name: 'Events', text: 'The comments could not be carried.' }, { name: 'notes.txt', text: 'The comments could not be carried.' }] })
    expect(existsSync(inFolder('Events', 'Spring LAN', 'Bracket.pdf'))).toBe(true)
    expect(existsSync(inFolder('.hidden', 'Events'))).toBe(false)
    expect(existsSync(inFolder('notes.txt'))).toBe(true)
  })
})

describe('movedSource', () => {
  it('re-points the thing itself and what lies under it, on this host only', () => {
    expect(movedSource(at('/w/a/b.txt'), HOST, '/w/a', '/w/c')).toEqual(at('/w/c/b.txt'))
    expect(movedSource(at('/w/a'), HOST, '/w/a', '/w/c')).toEqual(at('/w/c'))
    expect(movedSource(at('/w/ab.txt'), HOST, '/w/a', '/w/c')).toBeNull()
    expect(movedSource(at('/w/a/b.txt', 'env_mac'), HOST, '/w/a', '/w/c')).toBeNull()
    expect(movedSource({ at: 'lifeos', table: 'docs', id: 'd1' }, HOST, '/w/a', '/w/c')).toBeNull()
    expect(movedSource({ at: 'microsoft', host: HOST, app: 'excel', name: 'B.xlsx', ref: { kind: 'path', path: '/w/a/B.xlsx' } }, HOST, '/w/a', '/w/c')).toEqual({
      at: 'microsoft',
      host: HOST,
      app: 'excel',
      name: 'B.xlsx',
      ref: { kind: 'path', path: '/w/c/B.xlsx' }
    })
  })
})
