/**
 * The templates pillar, in process (docs/agents/work-templates.md "Proofs"):
 *
 *   bun scripts/proof-bun.ts scripts/proof-templates.ts
 *   TEMP_CODE_WORK_TOOLS_DATA=/srv/agents/temp-code-data .temp-code/bin/heavy bun scripts/proof-bun.ts scripts/proof-templates.ts
 *
 * A dummy workspace folder on a real database, the pillar's own module as
 * the host loads it, and a stand-in thread that calls `template_list`,
 * `template_make` and `template_save`. The templates are the fill's
 * fixtures: a Word file whose field Word split over three runs, a workbook
 * with a lone date cell, and a deck PowerPoint split. Each made file is read
 * back. With TEMP_CODE_WORK_TOOLS_DATA (a userData whose toolchain has
 * python-pptx and LibreOffice) the deck is filled by the slides pillar's
 * real edit and every filled file is opened by LibreOffice, which must make
 * a PDF of it. Dummy names only. Exits 0 when every check holds.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CanvasItem, CanvasKind, CanvasSource, WorkScope } from '@shared/work'
import { LIBREOFFICE_CONVERTERS } from '../src/main/server/work/formats'
import { convertersOf, JobRunner, type ConvertJob, type ConvertResult } from '../src/main/server/work/formats/jobs'
import { PILLAR_LOADERS, type ToolCtx, type WorkModule } from '../src/main/server/work/modules'
import { SLIDES_CONVERTERS } from '../src/main/server/work/slides/deck'
import { paragraphsOf, scanOffice, unescapeXml } from '../src/main/server/work/templates/ooxml'
import { partText, readZip } from '../src/main/server/work/templates/zip'

const DATA = process.env.TEMP_CODE_WORK_TOOLS_DATA
const FIXTURES = join(import.meta.dir, '..', 'src', 'main', 'server', 'work', 'templates', 'fixtures')
const HOST = 'env_proof'
const WS = 'w-proof'

let checks = 0
const failures: string[] = []
function check(what: string, ok: boolean, got?: unknown): void {
  checks++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok || got === undefined ? '' : `\n       got: ${JSON.stringify(got)}`}`)
  if (!ok) failures.push(what)
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

const base = mkdtempSync(join(tmpdir(), 'tc-proof-templates-'))
const folder = join(base, 'Work', 'Dummy Officials')
const dataDir = join(base, 'data')
mkdirSync(join(folder, 'Templates'), { recursive: true })
mkdirSync(dataDir, { recursive: true })
// No starter ships into this proof: the shelf is the job's own folder alone.
process.env.TEMP_CODE_WORK_TEMPLATES = join(base, 'no-starters')
copyFileSync(join(FIXTURES, 'split.docx'), join(folder, 'Templates', 'Game report.docx'))
copyFileSync(join(FIXTURES, 'fields.xlsx'), join(folder, 'Templates', 'Invoice.xlsx'))
copyFileSync(join(FIXTURES, 'split.pptx'), join(folder, 'Templates', 'Pitch.pptx'))

const db = new DatabaseSync(join(dataDir, 'proof.db'))
db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, path TEXT, kind TEXT, sector TEXT, created_at INTEGER)')
db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?)').run(WS, 'Dummy Officials', folder, 'work', 'ref', 1)
db.prepare('INSERT INTO settings VALUES (?, ?)').run('work.ownerName', 'Sam Dummy')

const runner = DATA ? new JobRunner({ host: HOST, dataDir: DATA, converters: convertersOf([{ id: 'slides', ensure() {}, convert: [...SLIDES_CONVERTERS, ...LIBREOFFICE_CONVERTERS] } as WorkModule]), log: () => {} }) : null
const items: CanvasItem[] = []
const logs: string[] = []
const scope: WorkScope = { sessionId: 't-proof', workspaceId: WS, sector: 'ref', host: HOST, away: false, routineRunId: null, shared: () => false }
const ctx = {
  db,
  host: HOST,
  dataDir,
  enabled: () => true,
  log: (line: string) => void logs.push(line),
  push: () => {},
  reaches: () => true,
  convert: (job: ConvertJob): Promise<ConvertResult> => (runner ? runner.convert(job) : Promise.reject(new Error('no deck tool on this host'))),
  canvas: {
    open: (sessionId: string, kind: CanvasKind, source: CanvasSource, title: string): CanvasItem => {
      const item = { id: `item_${items.length + 1}`, sessionId, kind, source, title } as unknown as CanvasItem
      items.push(item)
      return item
    },
    get: (id: string) => items.find((i) => i.id === id) ?? null,
    forSession: (sessionId: string) => items.filter((i) => i.sessionId === sessionId),
    forWorkspace: () => items,
    paneOf: (sessionId: string) => sessionId
  },
  scope,
  sessionId: 't-proof',
  signal: new AbortController().signal
} as unknown as ToolCtx

const text = (r: { content: Array<{ type: string; text?: string }> }): string => r.content.map((c) => c.text ?? '').join('')
const part = (path: string, name: string): string => partText(readZip(new Uint8Array(readFileSync(path))).find((p) => p.name === name)!)
const words = (xml: string, para: string, t: string): string[] => paragraphsOf(xml, [para], t).map((runs) => runs.map((r) => unescapeXml(xml.slice(r.start, r.end))).join(''))
const pathOf = (item: CanvasItem): string => (item.source.at === 'file' ? item.source.path : '')

try {
  const module = await PILLAR_LOADERS.templates()
  module.ensure(db)
  const tools = module.tools!(scope)
  const tool = (name: string) => tools.find((t) => t.name === name)!
  check('the module loads as the templates pillar and lists three tools', module.id === 'templates' && same(tools.map((t) => t.name), ['template_list', 'template_make', 'template_save']))

  const listed = await tool('template_list').run({}, ctx)
  console.log(text(listed).replace(/^/gm, '     '))
  check('the shelf names each template, its kind and the fields it asks for', same(text(listed).split('\n'), ['- Game report (document; this job): asks for Client, Site and Crew', '- Invoice (sheet; this job): asks for Client and Invoice number', '- Pitch (deck; this job): asks for Client and Budget']), text(listed))

  // ── a Word file whose field is split over three runs ────────────────
  const report = await tool('template_make').run({ template: 'Game report', fields: { Client: 'Central at North', Crew: 'R, U1 & U2' } }, ctx)
  console.log(`     ${text(report)}`)
  check('template_make answers the item and the field still to fill', !report.isError && same(report.structuredContent, { item: 'item_1', title: 'Game report - Central at North', kind: 'document', unfilled: ['Site'] }), report.structuredContent)
  const reportPath = pathOf(items[0]!)
  check("the file is in the workspace's own folder, named for its first field", reportPath === join(folder, 'Game report - Central at North.docx') && existsSync(reportPath), reportPath)
  const body = words(part(reportPath, 'word/document.xml'), 'w:p', 'w:t')
  console.log(body.map((l) => `     | ${l}`).join('\n'))
  check('the split field is filled where it stood, Name and Date without asking, and Site left as written', same(body.slice(0, 2), ['Game report for Central at North at {{Site}}.', `Filed by Sam Dummy on ${body[1]!.match(/on (.+?)\. /)?.[1]}. Central at North again, and {{Site}} left alone.`]) && /on [A-Z][a-z]+ \d{1,2}, \d{4}\. /.test(body[1]!), body)
  check('a value with an ampersand is safe', body[3] === 'Crew: R, U1 & U2', body[3])
  check('the header holds the job and the day', /^Dummy Officials · [A-Z][a-z]+ \d{1,2}, \d{4}$/.test(words(part(reportPath, 'word/header1.xml'), 'w:p', 'w:t')[0]!), words(part(reportPath, 'word/header1.xml'), 'w:p', 'w:t'))
  const before = readZip(new Uint8Array(readFileSync(join(FIXTURES, 'split.docx'))))
  const after = readZip(new Uint8Array(readFileSync(reportPath)))
  const untouched = before.filter((e) => e.name !== 'word/document.xml' && e.name !== 'word/header1.xml')
  check(`every other part keeps its bytes (${untouched.length} parts)`, untouched.every((e) => Buffer.from(after.find((a) => a.name === e.name)!.packed).equals(Buffer.from(e.packed))))
  check('the template itself is as it was', readFileSync(join(folder, 'Templates', 'Game report.docx')).equals(readFileSync(join(FIXTURES, 'split.docx'))))

  // ── a workbook: shared strings, an inline string, a lone date cell ──
  const invoice = await tool('template_make').run({ template: 'Invoice', fields: { Client: 'Acme <Co>', 'Invoice number': '0042' }, title: 'Invoice 0042' }, ctx)
  console.log(`     ${text(invoice)}`)
  const invoicePath = pathOf(items[1]!)
  const sheet = part(invoicePath, 'xl/worksheets/sheet1.xml')
  check('the sheet is named by its title and nothing is left to fill', same(invoice.structuredContent, { item: 'item_2', title: 'Invoice 0042', kind: 'sheet', unfilled: [] }), invoice.structuredContent)
  check('a lone Date cell in a date format is a true date', /<c r="B2" s="1"><v>\d{5}<\/v><\/c>/.test(sheet), sheet.match(/<c r="B2"[^>]*>.*?<\/c>/)?.[0])
  check('strings are filled, and escaped', part(invoicePath, 'xl/sharedStrings.xml').includes('<si><t>Bill to Acme &lt;Co&gt;</t></si>') && sheet.includes('From Dummy Officials'))
  check('numbers and formulas are as they were', sheet.includes('<c r="B3"><v>120.5</v></c><c r="C3"><f>B3*2</f><v>241</v></c>'))

  // ── a deck, by the slides pillar's own edit ─────────────────────────
  const pitch = await tool('template_make').run({ template: 'Pitch', fields: { Client: 'Acme & Co' } }, ctx)
  console.log(`     ${text(pitch)}`)
  const pitchPath = pathOf(items[2]!)
  if (runner) {
    check('the deck is filled by the slides pillar: only Budget is left', same((pitch.structuredContent as { unfilled: string[] }).unfilled, ['Budget']), pitch.structuredContent)
    check('the field PowerPoint split over three runs reads whole', words(part(pitchPath, 'ppt/slides/slide1.xml'), 'a:p', 'a:t').includes('Pitch for Acme & Co'), words(part(pitchPath, 'ppt/slides/slide1.xml'), 'a:p', 'a:t'))
  } else {
    check('with no deck tool the deck is a plain copy and every field is named', same((pitch.structuredContent as { unfilled: string[] }).unfilled, scanOffice('pptx', new Uint8Array(readFileSync(join(FIXTURES, 'split.pptx'))))), pitch.structuredContent)
    check('and the host says why', logs.some((l) => l.includes('Pitch was not filled')), logs)
  }
  check('the three items are open in the thread\'s canvas, each in its kind', same(items.map((i) => [i.kind, i.sessionId]), [['document', 't-proof'], ['sheet', 't-proof'], ['slides', 't-proof']]), items.map((i) => i.kind))
  check('no scratch folder is left', !existsSync(join(dataDir, 'work-templates', 'scratch')) || readdirSync(join(dataDir, 'work-templates', 'scratch')).length === 0)

  // ── save a made file as a template, and use that ────────────────────
  const saved = await tool('template_save').run({ item: 'item_1', name: 'Central report' }, ctx)
  console.log(`     ${text(saved)}`)
  check('template_save puts a copy on the shelf and says what it asks for', text(saved) === 'Saved Central report to Templates. It asks for Site.' && existsSync(reportPath), text(saved))
  const again = await tool('template_make').run({ template: 'Central report', fields: { Site: 'Field 2' } }, ctx)
  check('the saved template makes a file with nothing left to fill', same((again.structuredContent as { unfilled: string[] }).unfilled, []) && words(part(pathOf(items[3]!), 'word/document.xml'), 'w:p', 'w:t')[0] === 'Game report for Central at North at Field 2.', again.structuredContent)

  // ── every filled file opens in LibreOffice ──────────────────────────
  if (runner) {
    for (const [path, from] of [[reportPath, 'docx'], [invoicePath, 'xlsx'], [pitchPath, 'pptx']] as const) {
      const out = join(base, `${from}.pdf`)
      try {
        await runner.convert({ from, to: 'pdf', input: path, output: out })
        check(`LibreOffice opens the filled .${from} and makes a PDF of it (${statSync(out).size} bytes)`, statSync(out).size > 1000 && readFileSync(out).subarray(0, 5).toString() === '%PDF-')
      } catch (err) {
        check(`LibreOffice opens the filled .${from}`, false, err instanceof Error ? err.message : String(err))
      }
    }
  } else console.log('     (no TEMP_CODE_WORK_TOOLS_DATA: the real deck edit and the LibreOffice open were not run)')
} finally {
  db.close()
  rmSync(base, { recursive: true, force: true })
}

console.log(failures.length ? `\nFAILED ${failures.length} of ${checks} checks` : `\nPASS ${checks} checks`)
process.exit(failures.length ? 1 : 0)
