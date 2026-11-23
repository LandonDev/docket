import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { requiredCapability } from '@shared/capabilities'
import { RELAY_METHODS } from '@shared/contract-relay'
import { ClientRequestSchema, type ClientRequest } from '@shared/contract'
import { TEMPLATES_CAPS, TEMPLATES_RELAY, TemplatesRequestSchemas } from '@shared/contract-work-templates'
import { pillarOfMethod } from '@shared/work/wire'
import { templates } from '.'
import { PILLAR_LOADERS, type Caller } from '../modules'
import { makeFromTemplate, registerStarterTemplates, templatesFor } from './api'
import { OUT_OF_REACH } from './place'
import { docx, HOST, makeRig, OTHER, phone, window, WS, type Rig } from './testkit'

/* The templates pillar's wire: its methods, the capability each needs, and that a Mac window reaches a shelf on the box. */

const methods = TemplatesRequestSchemas.map((s) => s.shape.method.value)

describe('the wire', () => {
  it('declares the eight methods, each the pillar\'s own', () => {
    expect(methods).toEqual(['work.templates.list', 'work.templates.make', 'work.templates.save', 'work.templates.rename', 'work.templates.move', 'work.templates.remove', 'work.templates.unhide', 'work.templates.fields'])
    for (const m of methods) expect(pillarOfMethod(m)).toBe('templates')
  })

  it('reads with read and changes with operate', () => {
    expect(requiredCapability({ method: 'work.templates.list' })).toBe('read')
    expect(requiredCapability({ method: 'work.templates.fields' })).toBe('read')
    for (const m of methods.slice(1, -1)) expect(TEMPLATES_CAPS[m as keyof typeof TEMPLATES_CAPS]).toBe('operate')
  })

  it('carries every method to the workspace\'s host', () => {
    expect(TEMPLATES_RELAY).toEqual({})
    for (const m of methods) expect((RELAY_METHODS as Record<string, unknown>)[m]).toBe('link')
  })

  it('takes a day only as YYYY-MM-DD, a real one', () => {
    const make = (today: string) => ClientRequestSchema.safeParse({ id: '1', method: 'work.templates.make', params: { workspaceId: 'w1', template: 'Invoice', today } }).success
    expect(make('2026-11-23')).toBe(true)
    expect(make('2026-02-30')).toBe(false)
    expect(make('11/23/2026')).toBe(false)
  })

  it('names no file by a bare path', () => {
    for (const s of TemplatesRequestSchemas) for (const key of Object.keys((s.shape.params as unknown as { shape: Record<string, unknown> }).shape)) expect(['path', 'paths', 'cwd', 'parent']).not.toContain(key)
  })
})

describe('the module', () => {
  it('loads as the templates pillar', async () => {
    const module = await PILLAR_LOADERS.templates()
    expect(module.id).toBe('templates')
  })
})

describe('the handlers', () => {
  let rig: Rig
  beforeEach(() => void (rig = makeRig()))
  afterEach(() => rig.close())

  const call = async (method: string, params: unknown, by: Caller = window): Promise<unknown> => {
    const answer = await templates.handle!({ id: '1', method, params } as unknown as ClientRequest, rig.ctx, by)
    if (!answer.handled) throw new Error(`${method} was not handled`)
    return answer.result
  }

  it('answer every method of the contract', async () => {
    const source = rig.put(join(rig.folder, 'Letter.docx'), docx('Dear {{To}}'))
    expect(await call('work.templates.list', { workspaceId: WS })).toMatchObject({ hidden: 0, templates: [{ id: 'starter:ref/game-report' }, { id: 'starter:ref/season-log' }, { id: 'starter:any/meeting-notes' }] })
    expect(await call('work.templates.save', { workspaceId: WS, source: { at: 'file', host: HOST, path: source } })).toMatchObject({ id: 'job:Letter.docx', fields: ['To'] })
    expect(await call('work.templates.rename', { workspaceId: WS, template: 'job:Letter.docx', name: 'Note' })).toMatchObject({ id: 'job:Note.docx' })
    expect(await call('work.templates.move', { workspaceId: WS, template: 'Note', everywhere: true })).toMatchObject({ id: 'all:Note.docx' })
    expect(await call('work.templates.make', { workspaceId: WS, template: 'Note', fields: { To: 'Crew' }, today: '2026-11-23' })).toEqual({ source: { at: 'file', host: HOST, path: join(rig.folder, 'Note - Crew.docx') }, kind: 'document', title: 'Note - Crew', unfilled: [] })
    expect(await call('work.templates.remove', { workspaceId: WS, template: 'all:Note.docx' })).toEqual({ confirm: true })
    expect(await call('work.templates.remove', { workspaceId: WS, template: 'all:Note.docx', confirmed: true })).toEqual({})
    expect(await call('work.templates.remove', { workspaceId: WS, template: 'Season log' })).toEqual({})
    expect(await call('work.templates.list', { workspaceId: WS })).toMatchObject({ hidden: 1 })
    expect(await call('work.templates.remove', { workspaceId: WS, template: 'Game report' })).toEqual({})
    expect(await call('work.templates.list', { workspaceId: WS })).toMatchObject({ hidden: 2 })
    // The undo of one Hide shows that starter alone.
    expect(await call('work.templates.unhide', { workspaceId: WS, template: 'starter:ref/game-report' })).toEqual({})
    expect(await call('work.templates.list', { workspaceId: WS })).toMatchObject({ hidden: 1 })
    expect(await call('work.templates.unhide', { workspaceId: WS })).toEqual({})
    expect(await call('work.templates.list', { workspaceId: WS })).toMatchObject({ hidden: 0 })
    // What a file would ask for, read before it is saved.
    expect(await call('work.templates.fields', { workspaceId: WS, source: { at: 'file', host: HOST, path: source } })).toEqual({ fields: ['To'] })
  })

  it('push the shelf after each change and never after a read', async () => {
    await call('work.templates.list', { workspaceId: WS })
    expect(rig.pushes).toEqual([])
    await call('work.templates.remove', { workspaceId: WS, template: 'Season log' })
    expect(rig.pushes).toEqual([{ p: { push: 'work.templates', workspaceId: WS } }])
  })

  it('hold a call from another pillar or a peer to the contract\'s shape', async () => {
    await expect(call('work.templates.make', { workspaceId: WS, template: 'Game report', today: 'tomorrow' })).rejects.toThrow()
    await expect(call('work.templates.list', {})).rejects.toThrow()
    expect(await templates.handle!({ id: '1', method: 'work.templates.other', params: {} } as unknown as ClientRequest, rig.ctx, window)).toEqual({ handled: false })
  })

  it("answer a remote key only for a workspace whose folder it may reach", async () => {
    rig.roots = [rig.otherFolder]
    await expect(call('work.templates.list', { workspaceId: WS }, phone)).rejects.toThrow(OUT_OF_REACH)
    expect(await call('work.templates.list', { workspaceId: OTHER }, phone)).toMatchObject({ templates: [{ id: 'starter:any/meeting-notes' }] })
  })
})

describe('the calls for other pillars', () => {
  let rig: Rig
  beforeEach(() => void (rig = makeRig()))
  afterEach(() => rig.close())

  it('make a file from a starter by its key, by name with his own winning, into a folder of the workspace, and never ask', async () => {
    const into = { at: 'file' as const, host: HOST, path: join(rig.otherFolder, 'Invoices') }
    const invoice = await makeFromTemplate(rig.ctx, { workspaceId: OTHER, template: 'unify/invoice', into, fields: { Client: 'Acme' }, today: '2026-11-23' })
    expect(invoice).toEqual({ source: { at: 'file', host: HOST, path: join(rig.otherFolder, 'Invoices', 'Invoice - Acme.xlsx') }, kind: 'sheet', title: 'Invoice - Acme', unfilled: ['Invoice number'] })
    rig.put(join(rig.folder, 'Templates', 'Meeting notes.docx'), docx('My own notes for {{Meeting}}'))
    const notes = await makeFromTemplate(rig.ctx, { workspaceId: WS, template: 'Meeting notes', fields: { Meeting: 'Crew call' }, title: 'Crew call notes' })
    expect(notes.title).toBe('Crew call notes')
    expect(readFileSync(join(rig.folder, 'Crew call notes.docx')).length).toBeGreaterThan(0)
  })

  it("never go through Files' door as him: a pillar's own call is a copy into the workspace's own folder", async () => {
    await expect(makeFromTemplate(rig.ctx, { workspaceId: WS, template: 'Game report', into: { at: 'place', id: 'env_box~lib' } })).rejects.toThrow("made in this workspace's own folder")
  })

  it('list the shelf, and take an editor\'s starters before or after the module starts', () => {
    expect(templatesFor(rig.ctx, WS).map((t) => t.name)).toEqual(['Game report', 'Season log', 'Meeting notes'])
    const off = registerStarterTemplates('document', [{ name: 'Letter', path: rig.put(join(rig.outside, 'letter.docx'), docx('{{To}}')) }])
    expect(templatesFor(rig.ctx, WS).map((t) => t.name)).toEqual(['Game report', 'Season log', 'Letter', 'Meeting notes'])
    off()
  })
})
