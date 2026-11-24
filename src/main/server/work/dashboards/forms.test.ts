import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MSFORM_WITHHELD_WORDS } from '@shared/work/msforms'
import type { Caller } from '../modules'

/**
 * A dashboard's Microsoft form figures (dash.ts `admitForms`): a saved form source is read, refreshed or shown only
 * for the dashboard item's own job, through the form's reach as the real caller and Purdue's withhold for a routine's
 * thread, so a page kept across a change of job or library, or a routine's refresh, shows nothing it may not read.
 */

const libs = vi.hoisted(() => ({ list: [] as unknown[] }))
vi.mock('../files/places/libraries', () => ({ librariesHere: () => libs.list, vmLibrariesHere: () => [], forgetLibraries: () => {} }))

const { admitForms, DashStore, ensureDashboardsTables, FORM_NOT_THIS_JOB, refresh, viewOf } = await import('./dash')
const { ensureMsformsTables, MsformsStore } = await import('../msforms/store')
const { NOT_THIS_JOB } = await import('../msforms/reach')

const FORM = 'Ob0wQVN8nEGx5YdY1tY_IQaWFXVrVqJAiq2zrvrF0001'
const LIBRARY = { id: 'lib', host: 'env_test', path: '/libs/RecWell', team: 'RecWell', library: 'Documents', tenant: 'Purdue', kind: 'channels', channels: [], web: 'https://purdue0.sharepoint.com/sites/RecWell/Shared Documents/', found: true }

let db: DatabaseSync
const scopes = new Map<string, { workspaceId: string; sector: string; routineRunId: string | null; routineRun?: string | null }>()
const items = new Map<string, { id: string; kind: string; workspaceId: string | null; sessionId: string; title: string }>()
const ctx = () =>
  ({
    db,
    host: 'env_test',
    canvas: { get: (id: string) => items.get(id) ?? null },
    scopeOf: (id: string) => (scopes.has(id) ? { sessionId: id, ...scopes.get(id)! } : null),
    reaches: () => true,
    settings: { workspace: () => ({}) },
    service: { internal: async () => ({ title: 'x', rev: 0 }) },
    push: () => {},
    log: () => {}
  }) as never
const thread = (sessionId: string): Caller => ({ kind: 'model', caps: [], sessionId }) as Caller
const owner = { kind: 'local', caps: [] } as Caller
const formBlock = (workspaceId = 'ws-purdue') =>
  ({ id: 'b1', kind: 'figures', figures: [{ id: 'f1', label: 'Answered', format: 'number', value: '12', from: { sheet: { at: 'msform', host: 'env_test', workspaceId, formId: FORM, tenant: 'purdue0' }, sheetTitle: 'Tryouts', range: 'count', agg: 'sum' } }] }) as never

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, kind TEXT, sector TEXT)`)
  db.prepare(`INSERT INTO workspaces VALUES ('ws-purdue', 'Purdue', '/w/purdue', 'work', 'purdue'), ('ws-cosmic', 'Cosmic', '/w/cosmic', 'work', 'cosmic')`).run()
  ensureMsformsTables(db)
  ensureDashboardsTables(db)
  libs.list = [LIBRARY]
  new MsformsStore(db).create({ workspaceId: 'ws-purdue', formId: FORM, tenant: 'purdue0', sector: 'purdue', title: 'Tryouts', folder: { libraryId: 'lib', path: 'Esports', siteUrl: 'https://purdue0.sharepoint.com/sites/RecWell' }, madeBy: 'owner' })
  scopes.clear()
  scopes.set('t-his', { workspaceId: 'ws-purdue', sector: 'purdue', routineRunId: null, routineRun: null })
  scopes.set('t-routine-child', { workspaceId: 'ws-purdue', sector: 'purdue', routineRunId: null, routineRun: 'run-1' })
  scopes.set('t-cosmic', { workspaceId: 'ws-cosmic', sector: 'cosmic', routineRunId: null, routineRun: null })
  items.clear()
  items.set('d1', { id: 'd1', kind: 'dashboard', workspaceId: 'ws-purdue', sessionId: 'pane', title: 'Tryouts' })
  items.set('d2', { id: 'd2', kind: 'dashboard', workspaceId: 'ws-cosmic', sessionId: 'pane2', title: 'Moved' })
})

describe("a dashboard's Microsoft form figures", () => {
  it("are admitted for his window and his own thread of the form's job", async () => {
    await expect(admitForms(ctx(), owner, items.get('d1')!, [formBlock()])).resolves.toBeUndefined()
    await expect(admitForms(ctx(), thread('t-his'), items.get('d1')!, [formBlock()])).resolves.toBeUndefined()
  })

  it("are refused when the source is not the dashboard's own job, another job's thread asks, or the library left reach", async () => {
    await expect(admitForms(ctx(), owner, items.get('d2')!, [formBlock()])).rejects.toThrow(FORM_NOT_THIS_JOB)
    await expect(admitForms(ctx(), thread('t-cosmic'), items.get('d1')!, [formBlock()])).rejects.toThrow(NOT_THIS_JOB)
    libs.list = []
    await expect(admitForms(ctx(), thread('t-his'), items.get('d1')!, [formBlock()])).rejects.toThrow(NOT_THIS_JOB)
  })

  it("are withheld from a Purdue routine's delegated thread, for a refresh and for the cached page", async () => {
    await expect(admitForms(ctx(), thread('t-routine-child'), items.get('d1')!, [formBlock()])).rejects.toThrow(MSFORM_WITHHELD_WORDS)
    const store = new DashStore(db)
    store.create('d1', 'pane', 'Tryouts')
    store.update('d1', { blocks: [formBlock()], asOf: 1, revs: {} })
    const before = store.get('d1')!
    await expect(refresh(ctx(), items.get('d1')! as never, undefined, 'row', thread('t-routine-child'))).rejects.toThrow(MSFORM_WITHHELD_WORDS)
    await expect(viewOf(ctx(), store.get('d1')!, thread('t-routine-child'))).rejects.toThrow(MSFORM_WITHHELD_WORDS)
    // nothing was read or written: the stored page is as it was
    expect(store.get('d1')!.rev).toBe(before.rev)
  })
})
