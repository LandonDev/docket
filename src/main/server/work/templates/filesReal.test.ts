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

  it('a remove of his own is never a delete he was not asked about: Trash, or the confirm', async () => {
    const answer = await removeTemplate(rig.ctx, window, WS, 'job:Crew report.docx', false, { pillars: real })
    if (answer.confirm) expect(readdirSync(join(rig.folder, 'Templates'))).toEqual(['Crew report.docx'])
    else expect(answer.trashed?.length).toBe(1)
  })
})
