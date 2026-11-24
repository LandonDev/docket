import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handled, type CanvasSource } from '@shared/work'
import type { ConvertJob } from '../formats/jobs'
import type { WorkModule } from '../modules'
import type { DeckRead } from './deckFill'
import type { JobLook } from './look'
import { GONE, makeFromShelf, type MakeAsk, type MakeDeps } from './make'
import { paragraphsOf, unescapeXml } from './ooxml'
import { OUT_OF_REACH } from './place'
import { scratchRoot } from './shelf'
import { docx, HOST, makeRig, OTHER, phone, pptx, thread, window, WS, type Rig } from './testkit'
import { makeZip, partText, readZip } from './zip'

let rig: Rig
beforeEach(() => void (rig = makeRig()))
afterEach(() => rig.close())

const none = () => []
const make = (ask: Partial<MakeAsk> & { template: string }, by = window, deps: MakeDeps = {}) => makeFromShelf(rig.ctx, by, { workspaceId: WS, today: '2026-11-23', ...ask }, { pillars: none, ...deps })
const pathOf = (source: CanvasSource): string => (source.at === 'file' ? source.path : '')
const words = (path: string, part = 'word/document.xml'): string[] => {
  const xml = partText(readZip(new Uint8Array(readFileSync(path))).find((p) => p.name === part)!)
  return paragraphsOf(xml, ['w:p'], 'w:t').map((runs) => runs.map((r) => unescapeXml(xml.slice(r.start, r.end))).join(''))
}
const scratchLeft = (): string[] => (existsSync(scratchRoot(rig.ctx)) ? readdirSync(scratchRoot(rig.ctx)) : [])

describe('a make', () => {
  it('copies the template, fills it, names it for its first field and puts it in the workspace\'s folder', async () => {
    const made = await make({ template: 'Game report', fields: { Home: 'Central', away: 'North' } })
    expect(made).toEqual({ source: { at: 'file', host: HOST, path: join(rig.folder, 'Game report - Central.docx') }, kind: 'document', title: 'Game report - Central', unfilled: ['Site'] })
    expect(words(pathOf(made.source))).toEqual(['Game report: Central v North at {{Site}}', 'Filed by Sam Dummy on November 23, 2026 for Dummy Officials'])
  })

  it('fills Date with the caller\'s day, Name with his name and Job with the workspace\'s name, without being asked', async () => {
    const made = await make({ template: 'any/meeting-notes', fields: { Meeting: 'Crew call' }, today: '2027-01-05' })
    expect(words(pathOf(made.source))).toEqual(['Crew call', 'January 5, 2027'])
    expect(made.unfilled).toEqual([])
  })

  it('takes this host\'s own day when the caller sent none', async () => {
    const made = await makeFromShelf(rig.ctx, window, { workspaceId: WS, template: 'Meeting notes' }, { pillars: none, now: () => new Date(2026, 6, 4, 23, 30) })
    expect(words(pathOf(made.source))[1]).toBe('July 4, 2026')
  })

  it('leaves Name in the file, and says so, when LifeOS has not given his name', async () => {
    rig.db.exec('DELETE FROM settings')
    const made = await make({ template: 'Game report' })
    expect(made.unfilled).toEqual(['Home', 'Away', 'Site', 'Name'])
    expect(words(pathOf(made.source))[1]).toBe('Filed by {{Name}} on November 23, 2026 for Dummy Officials')
  })

  it("lets a caller's own value for Date, Name or Job win", async () => {
    const made = await make({ template: 'Game report', fields: { Name: 'R. Dummy', job: 'Friday crew', DATE: 'last Friday' } })
    expect(words(pathOf(made.source))[1]).toBe('Filed by R. Dummy on last Friday for Friday crew')
  })

  it("takes the caller's title for the file's name, and never a character a disk refuses", async () => {
    expect((await make({ template: 'Game report', title: 'Week 3: varsity/JV' })).title).toBe('Week 3 varsity JV')
    expect(existsSync(join(rig.folder, 'Week 3 varsity JV.docx'))).toBe(true)
  })

  it('never replaces a file of the same name', async () => {
    const a = await make({ template: 'Game report' })
    const b = await make({ template: 'Game report' })
    expect([a.title, b.title]).toEqual(['Game report', 'Game report 2'])
  })

  it('makes a sheet from a starter of another sector by its key, in a folder inside the workspace', async () => {
    const into = { at: 'file' as const, host: HOST, path: join(rig.otherFolder, 'Invoices') }
    const made = await makeFromShelf(rig.ctx, thread(), { workspaceId: OTHER, template: 'unify/invoice', into, fields: { Client: 'Acme <& Co>', 'Invoice number': '0042' }, today: '2026-11-23' }, { pillars: none })
    expect(made).toEqual({ source: { at: 'file', host: HOST, path: join(rig.otherFolder, 'Invoices', 'Invoice - Acme & Co.xlsx') }, kind: 'sheet', title: 'Invoice - Acme & Co', unfilled: [] })
    const sheet = partText(readZip(new Uint8Array(readFileSync(pathOf(made.source)))).find((p) => p.name === 'xl/worksheets/sheet1.xml')!)
    expect(sheet).toContain('<t>Bill to Acme &lt;&amp; Co&gt;</t>')
    expect(sheet).toContain('<t>Invoice 0042</t>')
  })

  it('makes a plain copy of a file that is no zip, and of our own document where its Word export does not answer, naming its fields', async () => {
    rig.put(join(rig.folder, 'Templates', 'Broken.docx'), 'not a zip {{Client}}')
    rig.put(join(rig.folder, 'Templates', 'Notes.tcdoc'), makeZip({ 'preview.md': '{{Client}}' }))
    const broken = await make({ template: 'Broken', fields: { Client: 'x' } })
    expect(readFileSync(pathOf(broken.source), 'utf8')).toBe('not a zip {{Client}}')
    expect(broken.unfilled).toEqual([])
    const notes = await make({ template: 'Notes' })
    expect(notes).toMatchObject({ kind: 'document', title: 'Notes', unfilled: ['Client'] })
    expect(pathOf(notes.source)).toBe(join(rig.folder, 'Notes.tcdoc'))
  })

  it('makes a plain copy of our own document with no field', async () => {
    rig.put(join(rig.folder, 'Templates', 'Plain.tcdoc'), makeZip({ 'preview.md': 'No field here' }))
    const plain = await make({ template: 'Plain' })
    expect(plain).toMatchObject({ kind: 'document', unfilled: [] })
    expect(pathOf(plain.source)).toBe(join(rig.folder, 'Plain.tcdoc'))
  })
})

describe('a Word template he edited', () => {
  // Edit opened Game report.docx; the document kind kept his edits in Game report.tcdoc beside it.
  const edited = () => {
    rig.put(join(rig.folder, 'Templates', 'Game report.docx'), docx('Old: {{Home}} v {{Away}} at {{Site}}'))
    rig.put(join(rig.folder, 'Templates', 'Game report.tcdoc'), makeZip({ 'preview.md': 'Edited: {{Home}} v {{Away}} at {{Site}} by {{Name}}' }))
  }
  const exported: string[] = []
  const formats: WorkModule = {
    id: 'formats',
    ensure() {},
    handle: async (req) => {
      exported.push(JSON.stringify((req as { params: unknown }).params))
      return handled({ name: 'x.docx', data: Buffer.from(docx('Edited: {{Home}} v {{Away}} at {{Site}} by {{Name}}')).toString('base64'), warnings: [] })
    }
  }

  it('makes Word from his edits, with the fields filled, and names what is left', async () => {
    edited()
    exported.length = 0
    const made = await make({ template: 'Game report', fields: { Home: 'Central', Away: 'North' } }, window, { pillars: () => [formats] })
    expect(exported).toEqual([JSON.stringify({ source: { at: 'file', host: HOST, path: join(rig.folder, 'Templates', 'Game report.tcdoc') }, format: 'docx' })])
    expect(pathOf(made.source)).toBe(join(rig.folder, 'Game report - Central.docx'))
    expect(words(pathOf(made.source))).toEqual(['Edited: Central v North at {{Site}} by Sam Dummy'])
    expect(made.unfilled).toEqual(['Site'])
  })
})

describe('the scratch folder', () => {
  it('is gone after a make', async () => {
    await make({ template: 'Game report' })
    expect(scratchLeft()).toEqual([])
  })

  it('is gone after a make that failed, and the template is as it was', async () => {
    const template = join(rig.starters, 'ref', 'Game report.docx')
    const before = readFileSync(template)
    const refuses: WorkModule = { id: 'files', ensure() {}, handle: async (req) => (req.method === 'work.files.places' ? handled({ places: [{ id: 'folder', can: ['make'] }] }) : Promise.reject(new Error('That folder is read only.'))) }
    await expect(make({ template: 'Game report', fields: { Home: 'Central' } }, window, { pillars: () => [refuses] })).rejects.toThrow('That folder is read only.')
    expect(scratchLeft()).toEqual([])
    expect(readFileSync(template).equals(before)).toBe(true)
    expect(readdirSync(rig.folder)).toEqual([])
  })

  it('is where the fill happens: the template\'s own file is never written', async () => {
    const template = join(rig.starters, 'ref', 'Game report.docx')
    const before = readFileSync(template)
    await make({ template: 'Game report', fields: { Home: 'Central', Away: 'North', Site: 'Field 2' } })
    expect(readFileSync(template).equals(before)).toBe(true)
  })
})

describe('what a make refuses', () => {
  it('a template that is not on the shelf, in words', async () => {
    await expect(make({ template: 'Budget' })).rejects.toThrow('There is no template "Budget" in Dummy Officials.')
  })

  it('a template whose file is gone: it is no longer on the shelf', async () => {
    const path = rig.put(join(rig.folder, 'Templates', 'Letter.docx'), docx('{{To}}'))
    expect((await make({ template: 'job:Letter.docx' })).title).toBe('Letter')
    rmSync(path)
    await expect(make({ template: 'job:Letter.docx' })).rejects.toThrow('There is no template "job:Letter.docx" in Dummy Officials.')
    expect(GONE('Letter')).toBe('The file of the template "Letter" is gone.')
  })

  it("a key that may not reach the workspace's folder", async () => {
    rig.roots = [rig.otherFolder]
    await expect(make({ template: 'Game report' }, phone)).rejects.toThrow(OUT_OF_REACH)
    expect(readdirSync(rig.folder)).toEqual([])
    rig.roots = [rig.folder]
    expect((await make({ template: 'Game report' }, phone)).title).toBe('Game report')
  })

  it('a folder outside the workspace\'s own', async () => {
    await expect(make({ template: 'Game report', into: { at: 'file', host: HOST, path: rig.outside } })).rejects.toThrow("made in this workspace's own folder")
    expect(readdirSync(rig.outside)).toEqual([])
    expect(scratchLeft()).toEqual([])
  })
})

describe('a deck', () => {
  const DECK: DeckRead = { slides: [{ id: 256, shapes: [{ id: 2, text: 'For {{Client}}' }] }] }

  it('is filled by the slides pillar\'s edit, on the scratch copy', async () => {
    rig.put(join(rig.folder, 'Templates', 'Pitch.pptx'), pptx('For {{Client}}'))
    const jobs: ConvertJob[] = []
    rig.convert = async (job) => {
      jobs.push(job)
      if (job.to === 'deckinfo') writeFileSync(job.output!, JSON.stringify(DECK))
      else writeFileSync(job.output!, pptx('For Acme'))
      return { output: job.output!, ranOn: HOST, warnings: [] }
    }
    const made = await make({ template: 'Pitch', fields: { Client: 'Acme' } })
    expect(jobs.map((j) => j.to)).toEqual(['deckinfo', 'pptxedit'])
    expect(jobs.every((j) => j.input.startsWith(scratchRoot(rig.ctx)))).toBe(true)
    expect(jobs[1]!.options).toEqual({ ops: [{ op: 'text', slide: 256, shape: 2, paragraphs: ['For Acme'] }], strict: false })
    expect(made).toMatchObject({ kind: 'deck', title: 'Pitch - Acme', unfilled: [] })
    expect(readFileSync(pathOf(made.source)).equals(Buffer.from(pptx('For Acme')))).toBe(true)
  })

  it('is placed as a plain copy, its fields named, when no host can run the edit', async () => {
    rig.put(join(rig.folder, 'Templates', 'Pitch.pptx'), pptx('For {{Client}}'))
    const made = await make({ template: 'Pitch', fields: { Client: 'Acme' } })
    expect(made).toMatchObject({ kind: 'deck', title: 'Pitch - Acme', unfilled: ['Client'] })
    expect(rig.logs.join('\n')).toContain('Pitch was not filled: python-pptx is not installed here')
    expect(scratchLeft()).toEqual([])
  })
})

describe("a job's look", () => {
  it('is asked once, for the workspace, after the fill and before the file is placed', async () => {
    const order: string[] = []
    const look = (_ctx: unknown, workspaceId: string): JobLook | null => {
      // The scratch copy is filled by now, and nothing is in the folder yet.
      const scratch = join(scratchRoot(rig.ctx), readdirSync(scratchRoot(rig.ctx))[0]!, 'template.docx')
      order.push(`look:${workspaceId}:${words(scratch)[0]}:${readdirSync(rig.folder).length}`)
      return null
    }
    await make({ template: 'Game report', fields: { Home: 'Central', Away: 'North', Site: 'Field 2' } }, window, { look })
    expect(order).toEqual(['look:w-ref:Game report: Central v North at Field 2:0'])
  })
})

describe('a sheet\'s lone Date cell', () => {
  it('becomes a true date from the caller\'s day, and words when the caller said the day in words', async () => {
    const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    const book = makeZip({
      'xl/styles.xml': `<styleSheet ${S}><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
      'xl/worksheets/sheet1.xml': `<worksheet ${S}><sheetData><row r="1"><c r="A1" s="1" t="inlineStr"><is><t>{{Date}}</t></is></c></row></sheetData></worksheet>`
    })
    rig.put(join(rig.folder, 'Templates', 'Log.xlsx'), book)
    const sheet = (path: string): string => partText(readZip(new Uint8Array(readFileSync(path))).find((p) => p.name === 'xl/worksheets/sheet1.xml')!)
    expect(sheet(pathOf((await make({ template: 'Log' })).source))).toContain('<c r="A1" s="1"><v>46349</v></c>')
    expect(sheet(pathOf((await make({ template: 'Log', fields: { Date: 'next week' } })).source))).toContain('<is><t>next week</t></is>')
  })
})
