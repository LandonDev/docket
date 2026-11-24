#!/usr/bin/env bun
/**
 * The bench tree for the PC drive bench (scripts/bench-pc-drive.ts): dummy files, all valid, on the rig's SMB share.
 *
 *   bun scripts/make-pc-drive-bench.ts [/tmp/tc-pc-rig/jshare]
 *
 * Makes `<share>/Bench` (made aside and moved in whole, so a stopped run leaves nothing half made):
 *  - 300 entries at the top: 40 folders (`A` and `Folder 01`…`Folder 39`, two small notes each) and 260 files:
 *    .docx, .xlsx, .pptx, .pdf and .txt of mixed sizes, a few of them 1–3 MB;
 *  - three levels down, `A\B\C`, each level 100 entries (`A` and `A\B` 10 folders and 90 files, `C` 100 files);
 *  - three named files: `Big.docx` 5 MB, `Deck.pptx` 20 MB, `Report.pdf` 10 MB, their size a picture of noise
 *    (it does not compress), each with the line "BENCH <name> first page" on its first page or slide.
 * Names and sizes come from a fixed seed, so a rebuild is the same tree. `<share>/Bench.manifest.json` lists it.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { strToU8, zipSync } from 'fflate'

const MB = 1024 * 1024
const KB = 1024

// ── a seeded random, for names and sizes ───────────────────────────────────
let seed = 0x5eed1234
const rand = (): number => {
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  return (seed >>> 0) / 2 ** 32
}
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!

// ── a PNG of noise: valid, stored, its size what we ask ─────────────────────
const CRC = new Int32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
function crc32(buf: Uint8Array): number {
  let c = -1
  for (const b of buf) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}
/** A square RGB picture of noise of about `bytes`. */
export function noisePng(bytes: number): { png: Buffer; side: number } {
  const side = Math.max(8, Math.floor(Math.sqrt(bytes / 3)))
  const row = side * 3 + 1
  const raw = randomBytes(row * side)
  for (let y = 0; y < side; y++) raw[y * row] = 0
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(side, 0)
  ihdr.writeUInt32BE(side, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 0 })), chunk('IEND', new Uint8Array())])
  return { png, side }
}

// ── the kinds ──────────────────────────────────────────────────────────────
const WORDS = 'budget roster schedule match practice venue travel scrimmage league report minutes agenda invoice season draft review plan notes summary update'.split(' ')
const sentence = (n: number): string => Array.from({ length: n }, () => pick(WORDS)).join(' ')
const mark = (name: string): string => `BENCH ${name} first page`

async function docx(name: string, size: number): Promise<Buffer> {
  const { Document, Packer, Paragraph, TextRun, ImageRun, HeadingLevel } = await import('docx')
  const pad = size > 40 * KB ? noisePng(size - 12 * KB) : null
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(mark(name))] }),
          ...Array.from({ length: 12 }, () => new Paragraph({ children: [new TextRun(sentence(24))] })),
          ...(pad ? [new Paragraph({ children: [new ImageRun({ type: 'png', data: pad.png, transformation: { width: 400, height: 400 } })] })] : [])
        ]
      }
    ]
  })
  return Buffer.from(await Packer.toBuffer(doc))
}

async function pptx(name: string, size: number): Promise<Buffer> {
  const { default: PptxGenJS } = await import('pptxgenjs')
  const pres = new PptxGenJS()
  pres.addSlide().addText(mark(name), { x: 0.5, y: 0.5, w: 9, h: 1, fontSize: 32 })
  pres.addSlide().addText(sentence(30), { x: 0.5, y: 0.5, w: 9, h: 4, fontSize: 18 })
  if (size > 60 * KB) {
    // Pictures of at most 5 MB each, a slide each, until the size is there.
    let left = size - 40 * KB
    while (left > 16 * KB) {
      const part = Math.min(left, 5 * MB)
      pres.addSlide().addImage({ data: `image/png;base64,${noisePng(part).png.toString('base64')}`, x: 1, y: 0.5, w: 4.5, h: 4.5 })
      left -= part
    }
  }
  return Buffer.from((await pres.write({ outputType: 'nodebuffer' })) as Uint8Array)
}

async function pdf(name: string, size: number): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const first = doc.addPage([612, 792])
  first.drawText(mark(name), { x: 72, y: 700, size: 24, font })
  for (let i = 0; i < 20; i++) first.drawText(sentence(10), { x: 72, y: 650 - i * 22, size: 12, font })
  if (size > 30 * KB) {
    const img = await doc.embedPng(noisePng(size - 8 * KB).png)
    doc.addPage([612, 792]).drawImage(img, { x: 72, y: 200, width: 468, height: 468 })
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }))
}

function xlsx(name: string, size: number): Buffer {
  // Rows of words and numbers until the sheet's text is about four times the size (it compresses about so).
  const rows: string[] = []
  let text = 0
  for (let r = 1; text < size * 4 || r < 3; r++) {
    const cells = r === 1 ? [`<c r="A1" t="inlineStr"><is><t>${mark(name)}</t></is></c>`] : [`<c r="A${r}" t="inlineStr"><is><t>${sentence(3)}</t></is></c>`, `<c r="B${r}"><v>${Math.floor(rand() * 100000)}</v></c>`, `<c r="C${r}" t="inlineStr"><is><t>${randomBytes(6).toString('hex')}</t></is></c>`]
    const row = `<row r="${r}">${cells.join('')}</row>`
    rows.push(row)
    text += row.length
  }
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join('')}</sheetData></worksheet>`)
  }
  return Buffer.from(zipSync(files, { level: 6 }))
}

function txt(name: string, size: number): Buffer {
  const lines = [mark(name)]
  let n = lines[0]!.length
  while (n < size) {
    const l = sentence(12)
    lines.push(l)
    n += l.length + 1
  }
  return Buffer.from(lines.join('\n'))
}

const KINDS = { docx, pptx, pdf, xlsx, txt } as const
type Kind = keyof typeof KINDS
const MIX: Kind[] = ['docx', 'docx', 'docx', 'xlsx', 'xlsx', 'xlsx', 'pdf', 'pdf', 'pptx', 'txt']
const NOUNS = ['Roster', 'Schedule', 'Budget', 'Travel', 'Minutes', 'Agenda', 'Invoice', 'Report', 'Plan', 'Review', 'Notes', 'Summary']

/** Most files small, a quarter middling, one in twenty 1–3 MB (the deep levels small alone). */
function sizeOf(deep: boolean): number {
  const r = rand()
  if (deep || r < 0.7) return Math.floor(8 * KB + rand() * 90 * KB)
  if (r < 0.95) return Math.floor(100 * KB + rand() * 900 * KB)
  return Math.floor(1 * MB + rand() * 2 * MB)
}

interface Planned {
  path: string
  kind: Kind
  size: number
}

/** One level: `folders` folders (the first named `next` when the tree goes on) and `files` files. */
function plan(at: string, folders: string[], files: number, deep: boolean, out: Planned[], dirs: string[]): void {
  for (const f of folders) dirs.push(join(at, f))
  const used = new Set<string>()
  for (let i = 0; i < files; i++) {
    const kind = pick(MIX)
    let name = ''
    do name = `${pick(NOUNS)} ${2020 + Math.floor(rand() * 7)}-${String(1 + Math.floor(rand() * 12)).padStart(2, '0')} ${String(Math.floor(rand() * 1000)).padStart(3, '0')}.${kind}`
    while (used.has(name))
    used.add(name)
    out.push({ path: join(at, name), kind, size: sizeOf(deep) })
  }
}

export function planTree(): { dirs: string[]; files: Planned[] } {
  seed = 0x5eed1234
  const dirs: string[] = []
  const files: Planned[] = []
  const named: Planned[] = [
    { path: 'Big.docx', kind: 'docx', size: 5 * MB },
    { path: 'Deck.pptx', kind: 'pptx', size: 20 * MB },
    { path: 'Report.pdf', kind: 'pdf', size: 10 * MB }
  ]
  const others = Array.from({ length: 39 }, (_, i) => `Folder ${String(i + 1).padStart(2, '0')}`)
  plan('', ['A', ...others], 260 - named.length, false, files, dirs)
  files.push(...named)
  for (const f of others) for (let k = 1; k <= 2; k++) files.push({ path: join(f, `Note ${k}.txt`), kind: 'txt', size: 2 * KB })
  plan('A', ['B', ...Array.from({ length: 9 }, (_, i) => `A${i + 1}`)], 90, true, files, dirs)
  plan('A/B', ['C', ...Array.from({ length: 9 }, (_, i) => `B${i + 1}`)], 90, true, files, dirs)
  plan('A/B/C', [], 100, true, files, dirs)
  return { dirs, files }
}

async function main(): Promise<void> {
  const share = process.argv[2] ?? '/tmp/tc-pc-rig/jshare'
  const tree = planTree()
  const aside = join(share, '.Bench.making')
  rmSync(aside, { recursive: true, force: true })
  for (const d of tree.dirs) mkdirSync(join(aside, d), { recursive: true })
  let total = 0
  for (const [i, f] of tree.files.entries()) {
    const name = f.path.split('/').pop()!
    const data = await KINDS[f.kind](name, f.size)
    writeFileSync(join(aside, f.path), data)
    total += data.length
    if (i % 100 === 0 || f.size >= 5 * MB) console.log(`${i + 1}/${tree.files.length} ${f.path} ${(data.length / MB).toFixed(2)} MB`)
  }
  const bench = join(share, 'Bench')
  rmSync(bench, { recursive: true, force: true })
  renameSync(aside, bench)
  const sizes = Object.fromEntries(['Big.docx', 'Deck.pptx', 'Report.pdf'].map((n) => [n, statSync(join(bench, n)).size]))
  const manifest = { made: new Date().toISOString(), entries: { top: 300, levels: ['A', 'A/B', 'A/B/C'] }, dirs: tree.dirs.length, files: tree.files.length, bytes: total, named: sizes }
  writeFileSync(join(share, 'Bench.manifest.json'), JSON.stringify(manifest, null, 2))
  console.log(JSON.stringify(manifest))
}

if (import.meta.main) {
  if (!existsSync(process.argv[2] ?? '/tmp/tc-pc-rig/jshare')) mkdirSync(process.argv[2] ?? '/tmp/tc-pc-rig/jshare', { recursive: true })
  await main()
}
