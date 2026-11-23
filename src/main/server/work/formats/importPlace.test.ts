import { copyFileSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { filesPaneOf, type CanvasItem } from '@shared/work'
import type { Caller } from '../modules'
import { importFolderOf, importsRoot } from '../files/imports'
import { at, HOST, makeRig, WS, type Rig } from '../files/testkit'
import { threadsHolding } from '../office/files/handle'
import { importFile } from './importer'

/** Where an import's document lands, by the place of the file it was made of, and how it takes a tab's place. */
const CORPUS = join(dirname(createRequire(import.meta.url).resolve('work-kit/formats/docx')), 'corpus')
const window: Caller = { kind: 'local', caps: [] }
let rig: Rig
beforeEach(() => {
  rig = makeRig()
})
afterEach(() => rig.close())

const pathOf = (s: unknown): string => (s as { path: string }).path

describe('an import of a file others can open', () => {
  it('writes nothing into a team library: a Word file\'s document lands under work-files/imports', async () => {
    const original = join(rig.team, 'General', 'review.docx')
    copyFileSync(join(CORPUS, 'review.docx'), original)
    const before = readdirSync(dirname(original)).sort()
    const got = await importFile(rig.ctx, window, { sessionId: 't1', from: { at: 'source', source: at(original) } })
    expect(readdirSync(dirname(original)).sort()).toEqual(before)
    const folder = importFolderOf(rig.dataDir, { host: HOST, path: original })
    expect(dirname(folder)).toBe(importsRoot(rig.dataDir))
    expect(pathOf(got.source)).toBe(join(folder, 'review.tcdoc'))
    expect(statSync(folder).mode & 0o777).toBe(0o700)
    expect(got.itemId && rig.canvas.get(got.itemId)?.sessionId).toBe('t1')
    // The Files place still finds the thread that holds it (office's threadsHolding reads the same folder).
    expect(threadsHolding(rig.ctx, WS, at(original)).map((t) => t.itemId)).toEqual([got.itemId])
  })

  it('keeps one folder per source file: a second import of it is the next free name there', async () => {
    const original = join(rig.mine, 'Agenda.md')
    writeFileSync(original, '# Agenda\n\nKickoff at five.\n')
    const a = await importFile(rig.ctx, window, { from: { at: 'source', source: at(original) } })
    const b = await importFile(rig.ctx, window, { from: { at: 'source', source: at(original) } })
    const folder = importFolderOf(rig.dataDir, { host: HOST, path: original })
    expect([pathOf(a.source), pathOf(b.source)]).toEqual([join(folder, 'Agenda.tcdoc'), join(folder, 'Agenda 2.tcdoc')])
    expect(readdirSync(rig.mine)).toEqual(['Agenda.md', 'Mine.docx'])
  })

  it('still writes beside a file in the workspace\'s own folder', async () => {
    const got = await importFile(rig.ctx, window, { from: { at: 'source', source: at(join(rig.folder, 'notes.txt')) } })
    expect(pathOf(got.source)).toBe(join(rig.folder, 'notes.tcdoc'))
    expect(existsSync(importsRoot(rig.dataDir))).toBe(false)
  })
})

describe('an import on the Files pane', () => {
  it('takes the tab\'s item\'s place, and a listener of the store hears the old item and the new', async () => {
    const pane = filesPaneOf(WS)
    const original = join(rig.team, 'General', 'Minutes.md')
    writeFileSync(original, '# Minutes\n')
    const old = rig.canvas.open(pane, { kind: 'document', source: at(original), title: 'Minutes.md' })
    const heard: [CanvasItem, CanvasItem][] = []
    rig.canvas.onItemReplaced((a, b) => void heard.push([a, b]))
    const got = await importFile(rig.ctx, window, { sessionId: pane, itemId: old.id, from: { at: 'source', source: at(original) } })
    expect(rig.canvas.get(old.id)).toBeNull()
    const made = rig.canvas.get(got.itemId!)!
    expect(made).toMatchObject({ sessionId: pane, kind: 'document', title: 'Minutes', source: got.source })
    expect(heard.map(([a, b]) => [a.id, b.id])).toEqual([[old.id, made.id]])
    expect(dirname(pathOf(got.source))).toBe(importFolderOf(rig.dataDir, { host: HOST, path: original }))
  })

  it('never closes another owner\'s item', async () => {
    const theirs = rig.canvas.open('t1', { kind: 'document', source: at(join(rig.folder, 'notes.txt')), title: 'notes.txt' })
    await importFile(rig.ctx, window, { sessionId: filesPaneOf(WS), itemId: theirs.id, from: { at: 'source', source: at(join(rig.folder, 'notes.txt')) } })
    expect(rig.canvas.get(theirs.id)?.state).toBe('open')
  })

  it('keeps a dropped file in the pane\'s workspace folder, and refuses an owner that is neither a thread nor a pane here', async () => {
    const data = Buffer.from('# Dropped\n').toString('base64')
    const got = await importFile(rig.ctx, window, { sessionId: filesPaneOf(WS), from: { at: 'bytes', name: 'Dropped.md', data } })
    expect(pathOf(got.source)).toBe(join(rig.folder, 'Dropped.tcdoc'))
    expect(existsSync(join(rig.folder, 'Dropped.md'))).toBe(true)
    await expect(importFile(rig.ctx, window, { sessionId: filesPaneOf('code1'), from: { at: 'bytes', name: 'x.md', data } })).rejects.toThrow(/Work thread or the Files place/)
    await expect(importFile(rig.ctx, window, { sessionId: 'stranger', from: { at: 'bytes', name: 'x.md', data } })).rejects.toThrow(/Work thread or the Files place/)
  })
})
