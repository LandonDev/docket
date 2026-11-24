import { readdirSync, readFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handled } from '@shared/work'
import type { WorkModule } from '../modules'
import { makeFromShelf } from './make'
import { moveTemplate, removeTemplate, renameTemplate } from './save'
import { listTemplates, sharedDir, shelfOf } from './shelf'
import { docx, imported, makeRig, window, WS, type Rig } from './testkit'

/*
 * A Word template he edited is two files, the Word file and the document made of it (`ShelfEntry.twin`). What makes
 * them one is known by the files themselves, not their names: it holds through this pillar's rename and move, and two
 * files this pillar put side by side are never joined by the import's record, which names files by name alone.
 */

let rig: Rig
beforeEach(() => void (rig = makeRig()))
afterEach(() => rig.close())

const templates = () => join(rig.folder, 'Templates')
const pair = () => {
  rig.put(join(templates(), 'Game report.docx'), docx('Old {{Home}}'))
  rig.put(join(templates(), 'Game report.tcdoc'), imported('Edited {{Home}} v {{Away}}', 'Game report.docx'))
}
const named = (name: string, workspaceId = WS) => listTemplates(rig.ctx, workspaceId).templates.filter((t) => t.name === name)
/** The formats pillar's export, standing in: it names the document it was asked for. */
const exports: string[] = []
const formats: WorkModule = {
  id: 'formats',
  ensure() {},
  handle: async (req) => {
    exports.push(((req as { params: { source: { path: string } } }).params.source.path))
    return handled({ name: 'x.docx', data: Buffer.from(docx('Edited {{Home}} v {{Away}}')).toString('base64'), warnings: [] })
  }
}

describe('a pair this pillar renamed', () => {
  it('stays one tile under the new name, and makes from his edits', async () => {
    pair()
    expect(named('Game report')).toHaveLength(1)
    await renameTemplate(rig.ctx, window, WS, 'Game report', 'Match report')
    expect(readdirSync(templates()).sort()).toEqual(['Match report.docx', 'Match report.tcdoc'])
    expect(named('Match report')).toEqual([expect.objectContaining({ id: 'job:Match report.tcdoc', fields: ['Home', 'Away'] })])
    exports.length = 0
    const made = await makeFromShelf(rig.ctx, window, { workspaceId: WS, template: 'Match report', fields: { Home: 'Central' }, today: '2026-11-23' }, { pillars: () => [formats] })
    expect(exports).toEqual([join(templates(), 'Match report.tcdoc')])
    expect(made.unfilled).toEqual(['Away'])
  })
})

describe('a pair this pillar moved under a free name', () => {
  it('stays one tile in its new group', async () => {
    pair()
    expect(named('Game report')).toHaveLength(1)
    rig.put(join(sharedDir(rig.ctx), 'Game report.docx'), docx('Another one'))
    expect(await moveTemplate(rig.ctx, window, WS, 'job:Game report.tcdoc', true)).toMatchObject({ id: 'all:Game report 2.tcdoc' })
    expect(named('Game report 2')).toEqual([expect.objectContaining({ id: 'all:Game report 2.tcdoc', where: 'all' })])
    expect(shelfOf(rig.ctx, WS).entries.find((e) => e.id === 'all:Game report 2.tcdoc')?.twin).toBe(join(sharedDir(rig.ctx), 'Game report 2.docx'))
  })
})

describe('a lone document this pillar moved beside an older Word file of its name', () => {
  it('is not joined to it, and removing the document leaves the Word file as it was', async () => {
    // A document read from a Word file named Letter.docx, which is not this one.
    rig.put(join(templates(), 'Letter.tcdoc'), imported('His own {{Client}}', 'Letter.docx'))
    const theirs = rig.put(join(sharedDir(rig.ctx), 'Letter.docx'), docx('Dear {{To}}'))
    const old = new Date(Date.now() - 86_400_000)
    utimesSync(theirs, old, old)
    const bytes = readFileSync(theirs)
    await moveTemplate(rig.ctx, window, WS, 'job:Letter.tcdoc', true)
    expect(named('Letter').map((t) => t.id).sort()).toEqual(['all:Letter.docx', 'all:Letter.tcdoc'])
    const asked = await removeTemplate(rig.ctx, window, WS, 'all:Letter.tcdoc', null, { pillars: () => [] })
    await removeTemplate(rig.ctx, window, WS, 'all:Letter.tcdoc', asked.version!, { pillars: () => [] })
    expect(readdirSync(sharedDir(rig.ctx))).toEqual(['Letter.docx'])
    expect(readFileSync(theirs).equals(bytes)).toBe(true)
  })

  it('and a lone Word file renamed beside a document of its name is not joined to it either', async () => {
    rig.put(join(templates(), 'Memo.tcdoc'), imported('{{To}}', 'Memo.docx'))
    rig.put(join(templates(), 'Draft.docx'), docx('{{To}}'))
    const old = new Date(Date.now() - 86_400_000)
    utimesSync(join(templates(), 'Draft.docx'), old, old)
    await renameTemplate(rig.ctx, window, WS, 'job:Draft.docx', 'Memo')
    expect(named('Memo').map((t) => t.id).sort()).toEqual(['job:Memo.docx', 'job:Memo.tcdoc'])
  })
})
