import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CanvasItem, WorkScope } from '@shared/work'
import { workToolNameProblem } from '@shared/work/tools'
import { templates } from '.'
import { inputShapeOf, type ToolCtx } from '../modules'
import { sharedDir } from './shelf'
import { docx, HOST, makeRig, OTHER, WS, type Rig } from './testkit'
import { templateTools } from './tools'

let rig: Rig
beforeEach(() => void (rig = makeRig()))
afterEach(() => rig.close())

const scope = (workspaceId: string | null = WS): WorkScope => ({ sessionId: 't1', workspaceId, sector: 'ref', host: HOST, away: false, routineRunId: null, shared: () => false })
const ctx = (workspaceId: string | null = WS): ToolCtx => ({ ...rig.ctx, scope: scope(workspaceId), sessionId: 't1', signal: new AbortController().signal }) as ToolCtx
const tool = (name: string) => templateTools.find((t) => t.name === name)!
const text = (r: { content: Array<{ type: string; text?: string }> }): string => r.content.map((c) => c.text ?? '').join('')

describe('the tools', () => {
  it('are three, well named, listed for a workspace thread and not for a Work Chat', () => {
    expect(templates.tools!(scope()).map((t) => t.name)).toEqual(['template_list', 'template_make', 'template_save'])
    expect(templates.tools!(scope(null))).toEqual([])
    for (const t of templateTools) expect(workToolNameProblem(t.name)).toBeNull()
    expect(templateTools.map((t) => t.readOnly)).toEqual([true, false, false])
  })

  it('take no folder, path or workspace: nothing a thread says can aim one outside its own workspace or at a library', () => {
    for (const t of templateTools) {
      const keys = Object.keys(inputShapeOf(t.input) ?? {})
      for (const banned of ['into', 'folder', 'path', 'at', 'workspaceId', 'workspace', 'host', 'source']) expect(keys, t.name).not.toContain(banned)
    }
    expect(Object.keys(inputShapeOf(tool('template_make').input) ?? {}).sort()).toEqual(['fields', 'template', 'title'])
    expect(tool('template_make').input.safeParse({ template: 'Invoice', into: { at: 'file', host: HOST, path: '/x' } }).success).toBe(false)
    expect(tool('template_save').input.safeParse({ item: 'i', source: { at: 'file', host: HOST, path: '/x' } }).success).toBe(false)
  })
})

describe('template_list', () => {
  it("names each template, what it makes, its group and what it asks for, in the thread's own workspace", async () => {
    rig.put(join(rig.folder, 'Templates', 'Assignor letter.docx'), docx('Dear {{To}}'))
    rig.put(join(sharedDir(rig.ctx), 'Mileage.docx'), docx('plain'))
    const said = await tool('template_list').run({}, ctx())
    expect(text(said).split('\n')).toEqual([
      '- Assignor letter (document; this job): asks for To',
      '- Game report (document; starter): asks for Home, Away and Site',
      '- Season log (sheet; starter)',
      '- Mileage (document; all jobs)',
      '- Meeting notes (document; starter, all jobs): asks for Meeting'
    ])
    expect((said.structuredContent as { templates: unknown[] }).templates).toHaveLength(5)
    // Another workspace, with no sector: the ones for all jobs alone, and none of this job's.
    expect(text(await tool('template_list').run({}, ctx(OTHER)))).toBe('- Mileage (document; all jobs)\n- Meeting notes (document; starter, all jobs): asks for Meeting')
  })

  it('answers a Work Chat in words', async () => {
    const said = await tool('template_list').run({}, ctx(null))
    expect(said.isError).toBe(true)
    expect(text(said)).toBe('A Work Chat has no templates: they belong to a workspace.')
  })
})

describe('template_make', () => {
  it("makes the file in the workspace's own folder, opens it in the thread's canvas and answers the item and what is still to fill", async () => {
    const said = await tool('template_make').run({ template: 'Game report', fields: { Home: 'Central', Away: 'North' } }, ctx())
    expect(said.isError).toBeUndefined()
    expect(text(said)).toBe('Made Game report - Central and opened it as item item_1. Still to fill: {{Site}}.')
    expect(said.structuredContent).toEqual({ item: 'item_1', title: 'Game report - Central', kind: 'document', unfilled: ['Site'] })
    expect(rig.items).toEqual([{ id: 'item_1', sessionId: 't1', kind: 'document', source: { at: 'file', host: HOST, path: join(rig.folder, 'Game report - Central.docx') }, title: 'Game report - Central' }])
    expect(existsSync(join(rig.folder, 'Game report - Central.docx'))).toBe(true)
  })

  it('opens a deck in the slides canvas and a sheet in the sheet canvas', async () => {
    await tool('template_make').run({ template: 'Season log' }, ctx())
    expect(rig.items[0]).toMatchObject({ kind: 'sheet', title: 'Season log' })
  })

  it('holds nothing and asks Files nothing: the file is his own, in his own folder', async () => {
    let held = 0
    const withHeld = { ...ctx(), held: { create: () => (held++, {} as never), onDecided: () => () => {} } } as ToolCtx
    await tool('template_make').run({ template: 'Meeting notes', fields: { Meeting: 'Crew call' } }, withHeld)
    expect(held).toBe(0)
    expect(readdirSync(rig.folder)).toEqual(['Meeting notes - Crew call.docx'])
  })

  it('answers a template that is not there as the tool\'s error, and opens nothing', async () => {
    const said = await tool('template_make').run({ template: 'Budget' }, ctx())
    expect(said.isError).toBe(true)
    expect(text(said)).toBe('There is no template "Budget" in Dummy Officials.')
    expect(rig.items).toEqual([])
  })

  it("never reaches another workspace's shelf", async () => {
    rig.put(join(rig.otherFolder, 'Templates', 'Payroll.docx'), docx('x'))
    expect((await tool('template_make').run({ template: 'Payroll' }, ctx())).isError).toBe(true)
    expect((await tool('template_make').run({ template: 'job:Payroll.docx' }, ctx())).isError).toBe(true)
  })
})

describe('template_save', () => {
  const open = (source: CanvasItem['source'], over: Partial<CanvasItem> = {}): CanvasItem => {
    const item = { id: `item_${rig.items.length + 1}`, sessionId: 't1', kind: 'document', title: 'Week 3.docx', source, ...over } as unknown as CanvasItem
    rig.items.push(item)
    return item
  }

  it("puts the file of one of the thread's own items on the shelf, as a copy, and says what it asks for", async () => {
    const path = rig.put(join(rig.folder, 'Week 3.docx'), docx('{{Home}} v {{Away}}'))
    const item = open({ at: 'file', host: HOST, path })
    const said = await tool('template_save').run({ item: item.id, name: 'Weekly report' }, ctx())
    expect(text(said)).toBe('Saved Weekly report to Templates. It asks for Home and Away.')
    expect(said.structuredContent).toEqual({ id: 'job:Weekly report.docx', name: 'Weekly report', fields: ['Home', 'Away'] })
    expect(existsSync(path)).toBe(true)
  })

  it("names it for the item when no name is given, and keeps it for all jobs when asked", async () => {
    const item = open({ at: 'file', host: HOST, path: rig.put(join(rig.folder, 'Week 3.docx'), docx('plain')) })
    const said = await tool('template_save').run({ item: item.id, everywhere: true }, ctx())
    expect(said.structuredContent).toMatchObject({ id: 'all:Week 3.docx', name: 'Week 3' })
  })

  it("takes a deck the thread made, from the item's own folder", async () => {
    const item = open({ at: 'thread' }, { kind: 'slides', title: 'Pitch' })
    rig.put(join(rig.dataDir, 'canvas', 't1', item.id, 'deck.pptx'), 'deck bytes')
    const said = await tool('template_save').run({ item: item.id }, ctx())
    expect(said.structuredContent).toMatchObject({ id: 'job:Pitch.pptx' })
  })

  it("refuses an item of another thread, an item that is no file, and one that is no template", async () => {
    const theirs = open({ at: 'file', host: HOST, path: rig.put(join(rig.folder, 'Theirs.docx'), docx('x')) }, { sessionId: 't2' })
    expect(text(await tool('template_save').run({ item: theirs.id }, ctx()))).toBe(`There is no item ${theirs.id} in this thread's canvas.`)
    expect(text(await tool('template_save').run({ item: 'nope' }, ctx()))).toBe("There is no item nope in this thread's canvas.")
    const doc = open({ at: 'lifeos', table: 'docs', id: 'd1' })
    expect(text(await tool('template_save').run({ item: doc.id }, ctx()))).toContain('Only a Word, Excel or PowerPoint file')
    const draft = open({ at: 'thread' })
    expect(text(await tool('template_save').run({ item: draft.id }, ctx()))).toBe('That item is not a file yet: keep it as a file first.')
    expect(existsSync(join(rig.folder, 'Templates'))).toBe(false)
  })
})
