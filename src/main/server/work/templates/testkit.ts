import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { WorkPush } from '@shared/contract-work'
import type { CanvasItem, CanvasKind, CanvasSource } from '@shared/work'
import type { ConvertJob, ConvertResult } from '../formats/jobs'
import type { Caller, PushTo, WorkCtx } from '../modules'
import { setStartersRoot } from './shelf'
import { ensureTemplatesTables } from './store'
import { makeZip } from './zip'

/**
 * What the templates pillar's tests share: one host (`env_box`) with two
 * Work workspaces, a starters folder of three dummy files, and the callers
 * of the fence. Dummy names only.
 */

export const HOST = 'env_box'
export const WS = 'w-ref'
export const OTHER = 'w-none'

export const window: Caller = { kind: 'local', caps: ['read', 'operate', 'approve', 'admin'] }
export const phone: Caller = { kind: 'remote', caps: ['read', 'operate'] }
export const thread = (sessionId = 't1'): Caller => ({ kind: 'model', caps: [], sessionId })

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
/** A Word file whose body is these paragraphs. */
export const docx = (...paragraphs: string[]): Uint8Array => makeZip({ 'word/document.xml': `<w:document ${W}><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join('')}</w:body></w:document>` })
const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
/** An Excel file with one inline string in each cell of its first row. */
export const xlsx = (...cells: string[]): Uint8Array =>
  makeZip({ 'xl/worksheets/sheet1.xml': `<worksheet ${S}><sheetData><row r="1">${cells.map((c, i) => `<c r="${String.fromCharCode(65 + i)}1" t="inlineStr"><is><t>${c}</t></is></c>`).join('')}</row></sheetData></worksheet>` })
const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
/** A deck part with one text shape: enough for the scan, not for PowerPoint. */
export const pptx = (text: string): Uint8Array => makeZip({ 'ppt/slides/slide1.xml': `<p:sld ${A}><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:sld>` })

/**
 * A `.tcdoc` the document kind made of a Word file, as its import writes it: the markdown preview, and the sidecar's
 * `source` naming the Word file it was read from and when. `importedAt` defaults to now, after the Word file was written.
 */
export const imported = (preview: string, from: string, importedAt = Date.now()): Uint8Array =>
  makeZip({ 'preview.md': preview, 'sidecar.json': `${JSON.stringify({ source: { name: from, format: 'docx', importedAt } })}\n` })

export interface Rig {
  base: string
  /** the workspace's folder, by its real path */
  folder: string
  otherFolder: string
  dataDir: string
  starters: string
  outside: string
  db: DatabaseSync
  ctx: WorkCtx
  pushes: { p: WorkPush; to?: PushTo }[]
  logs: string[]
  /** every conversion asked */
  jobs: ConvertJob[]
  /** what a conversion does; the default fails as a host with no deck tool */
  convert: (job: ConvertJob) => Promise<ConvertResult>
  /** the canvas items opened, newest last */
  items: CanvasItem[]
  /** the roots a remote key may name; the workspaces' folders by default */
  roots: string[]
  /** writes a file, making its folders */
  put(path: string, data: Uint8Array | string): string
  close(): void
}

export function makeRig(): Rig {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'tc-templates-')))
  const folder = join(base, 'Work', 'Dummy Officials')
  const otherFolder = join(base, 'Work', 'No Sector')
  const dataDir = join(base, 'data')
  const starters = join(base, 'starters')
  const outside = join(base, 'outside')
  for (const dir of [folder, otherFolder, dataDir, join(starters, 'ref'), join(starters, 'any'), join(starters, 'unify'), outside]) mkdirSync(dir, { recursive: true })
  const put = (path: string, data: Uint8Array | string): string => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, data)
    return path
  }
  put(join(starters, 'ref', 'Game report.docx'), docx('Game report: {{Home}} v {{Away}} at {{Site}}', 'Filed by {{Name}} on {{Date}} for {{Job}}'))
  put(join(starters, 'ref', 'Season log.xlsx'), xlsx('Date', 'Level', 'Site'))
  put(join(starters, 'any', 'Meeting notes.docx'), docx('{{Meeting}}', '{{Date}}'))
  put(join(starters, 'unify', 'Invoice.xlsx'), xlsx('Bill to {{Client}}', 'Invoice {{Invoice number}}'))
  setStartersRoot(starters)

  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, path TEXT, kind TEXT, sector TEXT, created_at INTEGER)')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
  db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?)').run(WS, 'Dummy Officials', folder, 'work', 'ref', 1)
  db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?)').run(OTHER, 'No Sector', otherFolder, 'work', null, 2)
  db.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?, ?, ?)').run('repo', 'temp-code', base, 'code', 'ref', 3)
  db.prepare('INSERT INTO settings VALUES (?, ?)').run('work.ownerName', 'Sam Dummy')
  ensureTemplatesTables(db)

  const rig: Rig = {
    base,
    folder,
    otherFolder,
    dataDir,
    starters,
    outside,
    db,
    pushes: [],
    logs: [],
    jobs: [],
    convert: async () => Promise.reject(new Error('python-pptx is not installed here')),
    items: [],
    roots: [folder, otherFolder],
    put,
    ctx: null as unknown as WorkCtx,
    close() {
      setStartersRoot(null)
      db.close()
      rmSync(base, { recursive: true, force: true })
    }
  }
  let n = 0
  rig.ctx = {
    db,
    host: HOST,
    dataDir,
    enabled: () => true,
    log: (line: string) => void rig.logs.push(line),
    push: (p: WorkPush, to?: PushTo) => void rig.pushes.push({ p, ...(to ? { to } : {}) }),
    reaches: (by: Caller, path: string) => by.kind !== 'remote' || rig.roots.some((root) => path === root || path.startsWith(`${root}/`)),
    convert: (job: ConvertJob) => {
      rig.jobs.push(job)
      return rig.convert(job)
    },
    canvas: {
      open: (sessionId: string, kind: CanvasKind, source: CanvasSource, title: string): CanvasItem => {
        const item = { id: `item_${++n}`, sessionId, kind, source, title } as unknown as CanvasItem
        rig.items.push(item)
        return item
      },
      get: (id: string) => rig.items.find((i) => i.id === id) ?? null,
      forSession: (sessionId: string) => rig.items.filter((i) => i.sessionId === sessionId),
      forWorkspace: () => rig.items,
      paneOf: (sessionId: string) => sessionId
    }
  } as unknown as WorkCtx
  return rig
}
