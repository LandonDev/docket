import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ANY_SECTOR } from '@shared/work/templates'
import { makeFromShelf } from '../make'
import { listTemplates, resolveTemplate, setStartersRoot } from '../shelf'
import { makeRig, OTHER, thread, WS, type Rig } from '../testkit'
import { STARTER_SECTORS, starterKey, STARTERS } from './manifest'

/* The shipped starters, as a workspace's shelf lists them and a caller names them: the manifest and the shelf agree. */

let rig: Rig
beforeEach(() => {
  rig = makeRig()
  // The files this checkout ships, not the test kit's three.
  setStartersRoot(null)
})
afterEach(() => rig.close())

describe('the shipped starters on a shelf', () => {
  it.each(STARTER_SECTORS.filter((s) => s !== ANY_SECTOR))("a %s workspace lists its sector's starters, then every job's, each with the fields the manifest names", (sector) => {
    rig.db.prepare('UPDATE workspaces SET sector = ? WHERE id = ?').run(sector, WS)
    const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
    const want = [...STARTERS.filter((s) => s.sector === sector).sort(byName), ...STARTERS.filter((s) => s.sector === ANY_SECTOR).sort(byName)]
    const got = listTemplates(rig.ctx, WS).templates
    expect(got.map((t) => [t.id, t.name, t.kind, t.form, t.fields])).toEqual(want.map((s) => [`starter:${starterKey(s)}`, s.name, s.kind, s.form, s.fields]))
  })

  it("a workspace with no sector lists every job's alone", () => {
    expect(listTemplates(rig.ctx, OTHER).templates.map((t) => t.id)).toEqual(['starter:any/meeting-notes'])
  })

  it('every starter is found by its key from any workspace, and the two keys other pillars call are there', () => {
    for (const s of STARTERS) expect(resolveTemplate(rig.ctx, OTHER, starterKey(s)).entry.name).toBe(s.name)
    expect(resolveTemplate(rig.ctx, OTHER, 'unify/invoice').entry.fields).toEqual(['Client', 'Invoice number'])
    expect(resolveTemplate(rig.ctx, WS, 'Meeting notes').entry.id).toBe('starter:any/meeting-notes')
  })

  it("Money's invoice and prep's notes are made with nothing left to fill", async () => {
    const invoice = await makeFromShelf(rig.ctx, thread(), { workspaceId: OTHER, template: 'unify/invoice', fields: { Client: 'Acme', 'Invoice number': '0042' }, today: '2026-11-23' }, { pillars: () => [] })
    expect(invoice).toMatchObject({ kind: 'sheet', title: 'Invoice - Acme', unfilled: [] })
    const notes = await makeFromShelf(rig.ctx, thread(), { workspaceId: OTHER, template: 'Meeting notes', fields: { Meeting: 'Crew call' }, today: '2026-11-23' }, { pillars: () => [] })
    expect(notes).toMatchObject({ kind: 'document', title: 'Meeting notes - Crew call', unfilled: [] })
  })
})
