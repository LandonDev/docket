import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { filesPaneOf, mailPaneOf } from '@shared/work'
import { makeRig, at, WS, type Rig } from '../files/testkit'
import { viewOf, type Sheets } from './held'
import { createSheet } from './index'
import { ensureSuggestionTables, SuggestionStore } from './suggestions'

/** A sheet open in a Files tab: its owner is the pane, which has no scope row. */
let rig: Rig
let asked: { route: string; body: unknown }[]
let lifeos = false
let s: Sheets

beforeEach(() => {
  rig = makeRig()
  asked = []
  lifeos = false
  rig.db.exec('CREATE TABLE IF NOT EXISTS work_sheets_charts (store TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (store, id))')
  ensureSuggestionTables(rig.db)
  Object.assign(rig.ctx, {
    lifeos: { connected: () => lifeos },
    service: {
      internal: async (route: string, body: unknown) => {
        asked.push({ route, body })
        return { sheet: { lifeos: 'sheet-1' } }
      }
    }
  })
  const packages = { open: async () => ({ rev: 0, inspected: { sheets: [], date1904: false, reach: null }, saveError: null, missing: false }) }
  s = { ctx: rig.ctx, packages, suggestions: new SuggestionStore(rig.db), jobs: {} } as unknown as Sheets
})
afterEach(() => rig.close())

describe('a sheet on the Files pane', () => {
  it('reads as shared when it lies in a team library, and as his own in the workspace\'s folder', async () => {
    const team = rig.canvas.open(filesPaneOf(WS), { kind: 'sheet', source: at(join(rig.team, 'General', 'Spring budget.xlsx')), title: 'Spring budget.xlsx' })
    const own = rig.canvas.open(filesPaneOf(WS), { kind: 'sheet', source: at(join(rig.folder, 'Budget.xlsx')), title: 'Budget.xlsx' })
    expect((await viewOf(s, team)).shared).toBe(true)
    expect((await viewOf(s, own)).shared).toBe(false)
  })

  it('still asks a thread\'s scope, which may call a file of its own folder shared', async () => {
    rig.scopes.set('t1', { workspaceId: WS, shared: () => true } as never)
    const item = rig.canvas.open('t1', { kind: 'sheet', source: at(join(rig.folder, 'Budget.xlsx')), title: 'Budget.xlsx' })
    expect((await viewOf(s, item)).shared).toBe(true)
  })

  it('makes a sheet in the pane\'s workspace\'s sector, in LifeOS when it is connected', async () => {
    lifeos = true
    const item = await createSheet(s, filesPaneOf(WS), 'Roster')
    expect(asked[0]).toMatchObject({ route: '/internal/sheet/create', body: { title: 'Roster', at: { lifeos: { sector: 'purdue' } } } })
    expect(item).toMatchObject({ sessionId: filesPaneOf(WS), kind: 'sheet', source: { at: 'lifeos', table: 'sheets', id: 'sheet-1' } })
  })

  it('makes a .tcsheet of its own when LifeOS is not connected', async () => {
    const item = await createSheet(s, filesPaneOf(WS), 'Roster')
    expect(item.sessionId).toBe(filesPaneOf(WS))
    expect(item.source).toMatchObject({ at: 'file', host: rig.ctx.host })
    expect((item.source as { path: string }).path).toMatch(/Roster\.tcsheet$/)
  })

  it('refuses an owner that is neither a thread nor a Files pane of a Work workspace here', async () => {
    rig.db.prepare(`INSERT INTO workspaces (id, name, path, kind) VALUES ('code2', 'Repo', '/tmp', 'code')`).run()
    await expect(createSheet(s, filesPaneOf('code2'), 'X')).rejects.toThrow(/Work threads/)
    await expect(createSheet(s, filesPaneOf('gone'), 'X')).rejects.toThrow(/Work threads/)
    await expect(createSheet(s, mailPaneOf(WS), 'X')).rejects.toThrow(/Work threads/)
    await expect(createSheet(s, 'stranger', 'X')).rejects.toThrow(/Work threads/)
    expect(asked).toEqual([])
  })

  it('still makes a thread\'s sheet in its scope\'s sector', async () => {
    lifeos = true
    rig.scopes.set('t1', { workspaceId: WS, sector: 'ref' })
    const item = await createSheet(s, 't1', 'Games')
    expect(asked[0].body).toMatchObject({ at: { lifeos: { sector: 'ref' } } })
    expect(item.sessionId).toBe('t1')
  })
})
