import { rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { jobDir, listTemplates, NO_WORKSPACE, NoTemplateError, registerStarterTemplates, resolveTemplate, sharedDir, shelfOf, startersRoot, tcdocFields, workspaceOf } from './shelf'
import { TemplatesStore } from './store'
import { docx, makeRig, OTHER, pptx, WS, xlsx, type Rig } from './testkit'
import { makeZip } from './zip'

let rig: Rig
beforeEach(() => void (rig = makeRig()))
afterEach(() => rig.close())

const ids = (workspaceId = WS): string[] => listTemplates(rig.ctx, workspaceId).templates.map((t) => t.id)
const own = (name: string, data: Uint8Array | string = docx('plain')): string => rig.put(join(rig.folder, 'Templates', name), data)
const all = (name: string, data: Uint8Array | string = docx('plain')): string => rig.put(join(sharedDir(rig.ctx), name), data)

describe('the three groups', () => {
  it("lists the job's own, then its sector's starters, then all jobs', then every job's starters, each by name", () => {
    own('Zebra crew.docx')
    own('assignor letter.docx')
    all('Mileage.xlsx', xlsx('Miles'))
    expect(ids()).toEqual(['job:assignor letter.docx', 'job:Zebra crew.docx', 'starter:ref/game-report', 'starter:ref/season-log', 'all:Mileage.xlsx', 'starter:any/meeting-notes'])
  })

  it('says what each is: its name without the extension, its kind and form, where it stands, and its file on this host', () => {
    own('Pitch.pptx', pptx('For {{Client}}'))
    const t = listTemplates(rig.ctx, WS).templates[0]!
    expect(t).toEqual({ id: 'job:Pitch.pptx', name: 'Pitch', kind: 'deck', form: 'pptx', where: 'job', fields: ['Client'], source: { at: 'file', host: 'env_box', path: join(rig.folder, 'Templates', 'Pitch.pptx') } })
  })

  it("gives a workspace with no sector every job's starters alone", () => {
    expect(ids(OTHER)).toEqual(['starter:any/meeting-notes'])
  })

  it('reads the top level of the Templates folder only, and no lock file, dot file or other kind of file', () => {
    own('Real.docx')
    own('sub/Nested.docx')
    own('~$Real.docx', 'lock')
    own('.hidden.docx')
    own('notes.txt', 'words')
    own('scan.pdf', 'pdf')
    expect(ids().filter((i) => i.startsWith('job:'))).toEqual(['job:Real.docx'])
  })

  it('asks only for the fields he must type, in the file\'s order, each once', () => {
    const report = listTemplates(rig.ctx, WS).templates.find((t) => t.id === 'starter:ref/game-report')!
    expect(report.fields).toEqual(['Home', 'Away', 'Site'])
  })

  it("lists a .tcdoc placed by hand with the fields its preview holds, and a .tcsheet with none, unopened", () => {
    own('Notes.tcdoc', makeZip({ 'preview.md': '# {{Client}} on {{Date}}' }))
    own('Log.tcsheet', 'not even a zip')
    const mine = listTemplates(rig.ctx, WS).templates.filter((t) => t.where === 'job')
    expect(mine.map((t) => [t.name, t.kind, t.form, t.fields])).toEqual([
      ['Log', 'sheet', 'tcsheet', []],
      ['Notes', 'document', 'tcdoc', ['Client']]
    ])
  })

  it('lists an Office file that is no zip as a plain copy', () => {
    own('Broken.docx', 'not a zip')
    expect(listTemplates(rig.ctx, WS).templates.find((t) => t.name === 'Broken')?.fields).toEqual([])
  })

  it('refuses a workspace that is not a Work workspace here', () => {
    expect(() => listTemplates(rig.ctx, 'repo')).toThrow(NO_WORKSPACE)
    expect(() => workspaceOf(rig.ctx, 'nope')).toThrow(NO_WORKSPACE)
  })
})

describe('the cache', () => {
  it('opens a file only when its size or time changed', () => {
    const path = own('Letter.docx', docx('Dear {{Client}}'))
    const at = new Date(2026, 0, 1)
    utimesSync(path, at, at)
    expect(listTemplates(rig.ctx, WS).templates[0]!.fields).toEqual(['Client'])
    // What is kept for this size and time answers: the file is not opened again.
    const info = statSync(path)
    new TemplatesStore(rig.db).keep(path, info.size, Math.floor(info.mtimeMs), ['Kept'])
    expect(listTemplates(rig.ctx, WS).templates[0]!.fields).toEqual(['Kept'])
    // A new time: read again.
    const later = new Date(2026, 0, 2)
    utimesSync(path, later, later)
    expect(listTemplates(rig.ctx, WS).templates[0]!.fields).toEqual(['Client'])
    // A new size: read again.
    writeFileSync(path, docx('Dear {{Friend}}, about {{Project}}'))
    utimesSync(path, later, later)
    expect(listTemplates(rig.ctx, WS).templates[0]!.fields).toEqual(['Friend', 'Project'])
  })

  it('forgets a file that left the folder', () => {
    const path = own('Gone.docx', docx('{{A}}'))
    listTemplates(rig.ctx, WS)
    rmSync(path)
    listTemplates(rig.ctx, WS)
    expect(rig.db.prepare('SELECT count(*) AS n FROM work_templates_index WHERE path = ?').get(path)).toEqual({ n: 0 })
  })
})

describe('hidden starters', () => {
  it('are left out and counted, in this workspace alone', () => {
    new TemplatesStore(rig.db).hide(WS, 'ref/game-report')
    new TemplatesStore(rig.db).hide(WS, 'any/meeting-notes')
    const list = listTemplates(rig.ctx, WS)
    expect(list.templates.map((t) => t.id)).toEqual(['starter:ref/season-log'])
    expect(list.hidden).toBe(2)
    expect(listTemplates(rig.ctx, OTHER)).toMatchObject({ hidden: 0, templates: [{ id: 'starter:any/meeting-notes' }] })
  })

  it('count only starters this shelf would show', () => {
    new TemplatesStore(rig.db).hide(WS, 'unify/invoice')
    expect(listTemplates(rig.ctx, WS).hidden).toBe(0)
  })
})

describe('resolve', () => {
  it('takes an id', () => {
    own('Game report.docx')
    expect(resolveTemplate(rig.ctx, WS, 'starter:ref/game-report').entry.id).toBe('starter:ref/game-report')
    expect(resolveTemplate(rig.ctx, WS, 'job:Game report.docx').entry.id).toBe('job:Game report.docx')
  })

  it("takes a starter's key, also one of another sector's", () => {
    expect(resolveTemplate(rig.ctx, WS, 'any/meeting-notes').entry.id).toBe('starter:any/meeting-notes')
    expect(resolveTemplate(rig.ctx, OTHER, 'unify/invoice').entry).toMatchObject({ id: 'starter:unify/invoice', name: 'Invoice', fields: ['Client', 'Invoice number'] })
  })

  it("takes a name, without case: the job's own first, then all jobs', then the job's starter, then every job's", () => {
    expect(resolveTemplate(rig.ctx, WS, 'meeting NOTES').entry.id).toBe('starter:any/meeting-notes')
    expect(resolveTemplate(rig.ctx, WS, 'Game report').entry.id).toBe('starter:ref/game-report')
    all('Game report.docx')
    all('Meeting notes.docx')
    expect(resolveTemplate(rig.ctx, WS, 'Game report').entry.id).toBe('all:Game report.docx')
    expect(resolveTemplate(rig.ctx, WS, 'Meeting notes').entry.id).toBe('all:Meeting notes.docx')
    own('Game Report.docx')
    expect(resolveTemplate(rig.ctx, WS, 'game report').entry.id).toBe('job:Game Report.docx')
    // The id still names ours.
    expect(resolveTemplate(rig.ctx, WS, 'starter:ref/game-report').entry.where).toBe('starter')
  })

  it('still finds a starter he hid: hiding takes it off the shelf, not from a caller', () => {
    new TemplatesStore(rig.db).hide(WS, 'ref/game-report')
    expect(resolveTemplate(rig.ctx, WS, 'Game report').entry.id).toBe('starter:ref/game-report')
    expect(resolveTemplate(rig.ctx, WS, 'ref/game-report').entry.id).toBe('starter:ref/game-report')
  })

  it('says in words that there is none', () => {
    expect(() => resolveTemplate(rig.ctx, WS, 'Budget')).toThrow(NoTemplateError)
    expect(() => resolveTemplate(rig.ctx, WS, 'Budget')).toThrow('There is no template "Budget" in Dummy Officials.')
    expect(() => resolveTemplate(rig.ctx, WS, 'starter:../../etc/passwd')).toThrow(NoTemplateError)
    expect(() => resolveTemplate(rig.ctx, WS, 'job:../Secret.docx')).toThrow(NoTemplateError)
  })
})

describe('his own of a starter\'s name', () => {
  it("takes the starter's place on the shelf, in the job's folder or for all jobs, and gives it back when it goes", () => {
    const path = own('game REPORT.docx', docx('Mine: {{Teams}}'))
    all('Meeting notes.docx')
    expect(ids()).toEqual(['job:game REPORT.docx', 'starter:ref/season-log', 'all:Meeting notes.docx'])
    // Not hidden: he hid nothing.
    expect(listTemplates(rig.ctx, WS).hidden).toBe(0)
    // A caller that names ours by its id or key still finds it.
    expect(resolveTemplate(rig.ctx, WS, 'ref/game-report').entry.where).toBe('starter')
    expect(resolveTemplate(rig.ctx, WS, 'Game report').entry.id).toBe('job:game REPORT.docx')
    rmSync(path)
    expect(ids()).toEqual(['starter:ref/game-report', 'starter:ref/season-log', 'all:Meeting notes.docx'])
  })
})

describe("an editor's own starters", () => {
  it('stand in the All jobs group, whether registered before or after the shelf was first read', () => {
    const budget = rig.put(join(rig.outside, 'budget.xlsx'), xlsx('{{Year}} budget'))
    const offBefore = registerStarterTemplates('sheet', [{ name: 'Budget', path: budget }])
    expect(ids()).toContain('starter:any/budget')
    offBefore()
    expect(ids()).not.toContain('starter:any/budget')
    const off = registerStarterTemplates('sheet', [{ name: 'Budget', path: budget }])
    expect(listTemplates(rig.ctx, OTHER).templates.map((t) => [t.id, t.name, t.fields])).toEqual([
      ['starter:any/budget', 'Budget', ['Year']],
      ['starter:any/meeting-notes', 'Meeting notes', ['Meeting']]
    ])
    off()
  })

  it('take the place, and the key, of one of ours with the same name, and are shown once', () => {
    const notes = rig.put(join(rig.outside, 'notes.docx'), docx('{{Topic}}'))
    const report = rig.put(join(rig.outside, 'report.docx'), docx('{{Teams}}'))
    const off = registerStarterTemplates('document', [
      { name: 'Meeting notes', path: notes },
      { name: 'Game report', path: report }
    ])
    const list = listTemplates(rig.ctx, WS).templates
    expect(list.map((t) => t.id)).toEqual(['starter:ref/game-report', 'starter:ref/season-log', 'starter:any/meeting-notes'])
    expect(list[0]).toMatchObject({ fields: ['Teams'], source: { path: report } })
    expect(list[2]).toMatchObject({ fields: ['Topic'], source: { path: notes } })
    expect(resolveTemplate(rig.ctx, WS, 'any/meeting-notes').entry.path).toBe(notes)
    off()
    expect(resolveTemplate(rig.ctx, WS, 'any/meeting-notes').entry.path).toBe(join(rig.starters, 'any', 'Meeting notes.docx'))
  })
})

describe("the starters' folder", () => {
  it('is resources/work-templates under the app\'s root: the checkout in a dev tree, the build\'s folder on the box, the app\'s own folder when packed', () => {
    rig.close()
    expect(startersRoot({}, () => '/srv/build/temp-code')).toBe('/srv/build/temp-code/resources/work-templates')
    expect(startersRoot({}, () => '/Applications/TempCode.app/Contents/Resources/app')).toBe('/Applications/TempCode.app/Contents/Resources/app/resources/work-templates')
    expect(startersRoot({ TEMP_CODE_WORK_TEMPLATES: '/tmp/mine' }, () => '/x')).toBe('/tmp/mine')
    rig = makeRig()
  })

  it('is found from this checkout', () => {
    rig.close()
    expect(startersRoot({})).toMatch(/resources[\\/]work-templates$/)
    rig = makeRig()
  })

  it('never reads outside itself for a sector with a path in its name', () => {
    rig.db.prepare('UPDATE workspaces SET sector = ? WHERE id = ?').run('../outside', WS)
    rig.put(join(rig.outside, 'Leak.docx'), docx('x'))
    expect(shelfOf(rig.ctx, WS).entries.map((e) => e.id)).toEqual(['starter:any/meeting-notes'])
  })
})

describe('our own document', () => {
  it('names the fields its markdown preview holds', () => {
    const path = rig.put(join(rig.folder, 'Brief.tcdoc'), makeZip({ 'preview.md': '# {{Client}}\n\n{{Date}} {{Project}}' }))
    expect(tcdocFields(path)).toEqual(['Client', 'Project'])
    expect(tcdocFields(join(rig.folder, 'missing.tcdoc'))).toEqual([])
    expect(jobDir(workspaceOf(rig.ctx, WS))).toBe(join(rig.folder, 'Templates'))
  })
})

describe('a Word template and the document made of it', () => {
  it('stand as one tile, the document, which asks what his edits ask', () => {
    own('Game report.docx', docx('Old {{Home}}'))
    own('Game report.tcdoc', makeZip({ 'preview.md': 'Edited {{Home}} v {{Away}} at {{Site}}' }))
    all('Letter.docx', docx('{{To}}'))
    all('Letter.tcdoc', makeZip({ 'preview.md': 'Dear {{To}} and {{Cc}}' }))
    const list = listTemplates(rig.ctx, WS).templates
    expect(list.filter((t) => t.name === 'Game report')).toEqual([expect.objectContaining({ id: 'job:Game report.tcdoc', where: 'job', fields: ['Home', 'Away', 'Site'] })])
    expect(list.filter((t) => t.name === 'Letter')).toEqual([expect.objectContaining({ id: 'all:Letter.tcdoc', fields: ['To', 'Cc'] })])
    // The shelf's own entry knows the Word file it stands for; the wire never says it.
    expect(shelfOf(rig.ctx, WS).entries.find((e) => e.id === 'job:Game report.tcdoc')?.twin).toBe(join(rig.folder, 'Templates', 'Game report.docx'))
    expect(Object.keys(list.find((t) => t.name === 'Letter')!)).not.toContain('twin')
  })

  it('is found by name as the document', () => {
    own('Game report.docx', docx('Old {{Home}}'))
    own('Game report.tcdoc', makeZip({ 'preview.md': 'Edited {{Home}}' }))
    expect(resolveTemplate(rig.ctx, WS, 'Game report').entry.id).toBe('job:Game report.tcdoc')
  })
})
