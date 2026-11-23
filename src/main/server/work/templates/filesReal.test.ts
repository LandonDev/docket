import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { files } from '../files'
import { makeRig, phone, thread, window, WS, type Rig } from '../files/testkit'
import { makeFromShelf } from './make'
import { folderCan } from './place'
import { removeTemplate } from './save'
import { setStartersRoot } from './shelf'
import { ensureTemplatesTables } from './store'
import { docx } from './testkit'

/*
 * The make and the remove against the real files module, as it is on
 * master: not a stand-in. Whatever Files' folder can do today, a make ends
 * with the file in the workspace's own folder and a remove never deletes
 * unasked. When Files' folder learns to make and to trash, the same calls
 * go through its door, and this file's first test says which it is.
 */

let rig: Rig
let none: string
beforeEach(() => {
  rig = makeRig()
  ensureTemplatesTables(rig.db)
  none = mkdtempSync(join(tmpdir(), 'tc-no-starters-'))
  setStartersRoot(none)
  mkdirSync(join(rig.folder, 'Templates'), { recursive: true })
  writeFileSync(join(rig.folder, 'Templates', 'Crew report.docx'), docx('Report for {{Client}}'))
})
afterEach(() => {
  setStartersRoot(null)
  rmSync(none, { recursive: true, force: true })
  rig.close()
})

const real = () => [files]

describe('with the real files module', () => {
  it("asks Files' own places what the folder can do, and gets an answer", async () => {
    const can = await folderCan(rig.ctx, window, WS, 'make', real)
    expect(typeof can).toBe('boolean')
    // The answer is Files' own; a rejection would have read as false and hidden a broken call.
    const answer = await files.handle!({ id: '1', method: 'work.files.places', params: { workspaceId: WS } } as never, rig.ctx, window)
    expect(answer.handled && (answer.result as { places: { id: string }[] }).places.some((p) => p.id === 'folder')).toBe(true)
  })

  it.each([
    ['his window', window],
    ['a paired device', phone],
    ['a thread', thread()]
  ])("a make by %s ends with the file in the workspace's own folder", async (_who, by) => {
    const made = await makeFromShelf(rig.ctx, by, { workspaceId: WS, template: 'Crew report', fields: { Client: 'Central' }, today: '2026-11-23' }, { pillars: real })
    expect(made).toMatchObject({ kind: 'document', unfilled: [] })
    expect(made.title.startsWith('Crew report - Central')).toBe(true)
    expect(made.source.at === 'file' && existsSync(made.source.path) && made.source.path.startsWith(rig.folder)).toBe(true)
  })

  it("his window's make in a folder of the workspace goes through Files, which keeps the template's form and takes the name", async () => {
    if (!(await folderCan(rig.ctx, window, WS, 'make', real))) return // Files' folder cannot make yet: the plain copy is held by the test above
    const into = { at: 'file' as const, host: 'env_box', path: join(rig.folder, 'Events') }
    const made = await makeFromShelf(rig.ctx, window, { workspaceId: WS, template: 'Crew report', into, fields: { Client: 'Central' }, today: '2026-11-23' }, { pillars: real })
    expect(made).toEqual({ source: { at: 'file', host: 'env_box', path: join(rig.folder, 'Events', 'Crew report - Central.docx') }, kind: 'document', title: 'Crew report - Central', unfilled: [] })
    // Filled before Files ever saw it, and never over another file.
    const again = await makeFromShelf(rig.ctx, window, { workspaceId: WS, template: 'Crew report', into, fields: { Client: 'Central' }, today: '2026-11-23' }, { pillars: real })
    expect(again.title).not.toBe(made.title)
    expect(readdirSync(join(rig.folder, 'Events')).filter((n) => n.startsWith('Crew report - Central')).length).toBe(2)
  })

  it("a make in a library others can open is Files' to refuse or to ask about, in its own words, and nothing is written there", async () => {
    const before = readdirSync(join(rig.team, 'General')).sort()
    const into = { at: 'file' as const, host: 'env_box', path: join(rig.team, 'General') }
    await expect(makeFromShelf(rig.ctx, window, { workspaceId: WS, template: 'Crew report', into, fields: { Client: 'Central' } }, { pillars: real })).rejects.toThrow()
    // A thread never reaches Files' door at all: the workspace's own folder only.
    await expect(makeFromShelf(rig.ctx, thread(), { workspaceId: WS, template: 'Crew report', into }, { pillars: real })).rejects.toThrow("made in this workspace's own folder")
    expect(readdirSync(join(rig.team, 'General')).sort()).toEqual(before)
  })

  it('a remove of his own is never a delete he was not asked about: Trash, or the confirm', async () => {
    const answer = await removeTemplate(rig.ctx, window, WS, 'job:Crew report.docx', false, { pillars: real })
    if (answer.confirm) expect(readdirSync(join(rig.folder, 'Templates'))).toEqual(['Crew report.docx'])
    else {
      // Files' Trash took it: it is off the shelf, and Put back returns it.
      expect(answer.trashed?.length).toBe(1)
      expect(readdirSync(join(rig.folder, 'Templates'))).toEqual([])
      await files.handle!({ id: '1', method: 'work.files.restore', params: { workspaceId: WS, ids: answer.trashed, op: 'restore-0001' } } as never, rig.ctx, window)
      expect(readdirSync(join(rig.folder, 'Templates'))).toEqual(['Crew report.docx'])
    }
  })
})
