import { deflateSync } from 'node:zlib'

/**
 * The pages Files draws itself, with no tool and no font (docs/agents/work-files.md "Previews"): a text file's
 * head, a document's first lines and a sheet's first cells, as a page of grey word bars, the way a small
 * thumbnail reads text anyway. Our documents and sheets get these until their editor builds register a true
 * page render (`registerFilePreviewer`). Each is a PNG made in memory.
 */

type Rgb = readonly [number, number, number]
const PAPER: Rgb = [255, 255, 255]
const WORD: Rgb = [184, 188, 194]
const HEADING: Rgb = [107, 112, 120]
const RULE: Rgb = [225, 227, 230]
const BAND: Rgb = [243, 244, 246]
const FIGURE: Rgb = [140, 146, 154]

/** The widest page drawn: a wider ask gets this, and says so in its width. */
export const SKETCH_MAX_WIDTH = 1024

class Canvas {
  readonly px: Buffer
  constructor(
    readonly width: number,
    readonly height: number
  ) {
    this.px = Buffer.alloc(width * height * 3)
    this.fill(0, 0, width, height, PAPER)
  }
  fill(x: number, y: number, w: number, h: number, c: Rgb): void {
    const x0 = Math.max(0, Math.round(x))
    const y0 = Math.max(0, Math.round(y))
    const x1 = Math.min(this.width, Math.round(x + w))
    const y1 = Math.min(this.height, Math.round(y + h))
    for (let row = y0; row < y1; row++) {
      for (let col = x0; col < x1; col++) {
        const at = (row * this.width + col) * 3
        this.px[at] = c[0]
        this.px[at + 1] = c[1]
        this.px[at + 2] = c[2]
      }
    }
  }
  png(): Buffer {
    return encodePng(this.width, this.height, this.px)
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** An 8-bit RGB PNG of `rgb` (three bytes a pixel, row by row). */
export function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const rows = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) rgb.copy(rows, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

/** A PNG's size from its header, or null when the bytes are no PNG. */
export function pngSize(png: Uint8Array): { width: number; height: number } | null {
  const b = Buffer.from(png.buffer, png.byteOffset, png.byteLength)
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.toString('ascii', 12, 16) !== 'IHDR') return null
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

export interface Sketch {
  png: Buffer
  width: number
  height: number
}

/** Letter's shape: a page is this much taller than it is wide. */
const PAGE = 11 / 8.5

/**
 * Lines of text as a page: each word a bar its length, a line that starts with `#` (or the first line, with
 * `title`) a heading. Leading spaces keep their indent, so code reads as code.
 */
export function textPage(text: string, width: number, o: { title?: boolean } = {}): Sketch {
  const w = Math.max(64, Math.min(SKETCH_MAX_WIDTH, Math.round(width)))
  const h = Math.round(w * PAGE)
  const c = new Canvas(w, h)
  const margin = Math.round(w * 0.09)
  const line = Math.max(4, w / 30)
  const em = line * 0.5
  const perLine = Math.max(8, Math.floor((w - margin * 2) / em))
  let y = margin
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < lines.length && y + line <= h - margin; i++) {
    const raw = lines[i]!.replace(/\t/g, '  ')
    const heading = /^#{1,6}\s/.test(raw) || (o.title === true && i === 0 && raw.trim() !== '')
    const words = raw.replace(/^#{1,6}\s+/, '').trimEnd()
    if (!words.trim()) {
      y += line * 0.6
      continue
    }
    const scale = heading ? 1.35 : 1
    const indent = Math.min(perLine / 2, raw.length - raw.trimStart().length)
    let col = indent
    let rowY = y
    // A word that would run past the margin wraps to the next line, as a page would set it.
    for (const word of words.trim().split(/\s+/)) {
      const len = Math.min(word.length, perLine)
      if (col > indent && (col + len) * em * scale > w - margin * 2) {
        col = indent
        rowY += line * scale
        if (rowY + line * scale > h - margin) break
      }
      c.fill(margin + col * em * scale, rowY + line * scale * 0.3, len * em * scale, line * scale * 0.42, heading ? HEADING : WORD)
      col += len + 1
    }
    y = rowY + line * scale * (heading ? 1.3 : 1)
  }
  return { png: c.png(), width: w, height: h }
}

/** A sheet's first cells as a grid: a heading band, each cell's value a bar its length, numbers set right and darker. */
export function gridPage(cells: (string | number | null)[][], width: number): Sketch {
  const w = Math.max(64, Math.min(SKETCH_MAX_WIDTH, Math.round(width)))
  const h = Math.round(w * 0.75)
  const c = new Canvas(w, h)
  const cols = 6
  const colW = w / (cols + 0.4)
  const gutter = colW * 0.4
  const rowH = Math.max(6, w / 22)
  const rows = Math.floor((h - rowH) / rowH)
  c.fill(0, 0, w, rowH, BAND)
  c.fill(0, 0, gutter, h, BAND)
  for (let r = 0; r <= rows; r++) c.fill(0, rowH * (r + 1), w, 1, RULE)
  for (let k = 0; k <= cols; k++) c.fill(gutter + colW * k, 0, 1, h, RULE)
  const em = rowH * 0.32
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < cols; k++) {
      const v = cells[r]?.[k]
      if (v === null || v === undefined || v === '') continue
      const figure = typeof v === 'number' || /^-?[\d.,]+%?$/.test(String(v).trim())
      const len = Math.min(String(v).trim().length * em, colW - rowH * 0.6)
      const x = figure ? gutter + colW * (k + 1) - rowH * 0.3 - len : gutter + colW * k + rowH * 0.3
      c.fill(x, rowH * (r + 1) + rowH * 0.32, Math.max(em, len), rowH * 0.38, figure ? FIGURE : WORD)
    }
  }
  return { png: c.png(), width: w, height: h }
}
