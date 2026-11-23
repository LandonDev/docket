/**
 * Draws Money's made-up receipts (receipts.ts) into this folder:
 *
 *   bun src/main/server/work/money/fixtures/draw.ts
 *
 * Pictures with @napi-rs/canvas, PDFs with pdf-lib; a scan is a PDF whose one
 * page is only a picture. Run it again after changing a fixture's rows and
 * commit what it writes.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { FIXTURES, heightOf, LAYOUT, type Fixture } from './receipts'

const here = import.meta.dirname

function picture(f: Fixture, type: 'image/png' | 'image/jpeg'): Buffer {
  const canvas = createCanvas(LAYOUT.width, heightOf(f))
  const g = canvas.getContext('2d')
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, canvas.width, canvas.height)
  g.fillStyle = '#111111'
  g.textBaseline = 'top'
  f.rows.forEach(([label, figure], i) => {
    const y = LAYOUT.top + i * LAYOUT.line
    g.font = `${i === 0 ? 'bold ' : ''}${LAYOUT.size}px "DejaVu Sans", sans-serif`
    g.textAlign = 'left'
    g.fillText(label, LAYOUT.left, y)
    if (!figure) return
    g.textAlign = 'right'
    g.fillText(figure, LAYOUT.width - LAYOUT.left, y)
  })
  return type === 'image/png' ? canvas.toBuffer('image/png') : canvas.toBuffer('image/jpeg', 92)
}

async function textPdf(f: Fixture): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const page = doc.addPage([612, 792])
  f.rows.forEach(([label, figure], i) => {
    const y = 720 - i * 30
    page.drawText(label, { x: 72, y, size: 14, font: i === 0 ? bold : font })
    if (figure) page.drawText(figure, { x: 540 - font.widthOfTextAtSize(figure, 14), y, size: 14, font })
  })
  return doc.save()
}

async function scanPdf(f: Fixture): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const png = await doc.embedPng(picture(f, 'image/png'))
  const page = doc.addPage([LAYOUT.width, heightOf(f)])
  page.drawImage(png, { x: 0, y: 0, width: LAYOUT.width, height: heightOf(f) })
  return doc.save()
}

for (const f of FIXTURES) {
  const bytes = f.kind === 'pdf' ? await textPdf(f) : f.kind === 'scan' ? await scanPdf(f) : picture(f, f.file.endsWith('.png') ? 'image/png' : 'image/jpeg')
  writeFileSync(join(here, f.file), bytes)
  console.log(`${f.file}  ${bytes.length} bytes`)
}
