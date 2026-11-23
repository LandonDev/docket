import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import type { ReceiptLine } from '@shared/work/money'
import type { Converter } from '../formats/jobs'
import type { WorkCtx } from '../modules'

/**
 * Reading a receipt on his own machines (docs/agents/work-money.md "Reading
 * a receipt"). A picture is read by RapidOCR from the Docling tool folder,
 * as a converter of Money's own (`jpg`/`png` → `lines`): a host without the
 * tool forwards the job to one that has it (the box). A PDF is read through
 * the pdf pillar's converters, by `ctx.convert`: its text when it has any,
 * else its first page as a picture. Nothing here calls a model, and nothing
 * leaves his machines. A file that cannot be read gives no lines: the fields
 * then open empty beside the picture.
 */

/**
 * The reader's Python, run with the Docling venv. It ships as a string
 * because the app is bundled (as the pdf pillar's does); as `String.raw` it
 * holds no backtick and no dollar-brace.
 */
export const LINES_PY = String.raw`"""temp-code money: reads the text of one picture (src/main/server/work/money/reader.ts).
  lines <in.jpg|png> <out.json> <models dir>   [{"text", "box": [left, top, right, bottom], "score"}]
A refusal is one line on stderr starting "tc-error: " and exit 3."""
import json
import sys


def refuse(text):
    sys.stderr.write("tc-error: " + text + "\n")
    sys.exit(3)


def main():
    src, out, models = sys.argv[2], sys.argv[3], sys.argv[4]
    try:
        from rapidocr import RapidOCR, EngineType, ModelType, OCRVersion
    except Exception as err:
        refuse("the reader is not installed here: " + str(err))
    engine = RapidOCR(params={
        "Det.engine_type": EngineType.TORCH,
        "Rec.engine_type": EngineType.TORCH,
        "Cls.engine_type": EngineType.TORCH,
        "Det.model_path": models + "/PP-OCRv6_det_small.pth",
        "Rec.model_path": models + "/PP-OCRv6_rec_small.pth",
        "Cls.model_path": models + "/ch_ppocr_mobile_v2.0_cls_mobile.pth",
        "Rec.rec_keys_path": models + "/ppocrv6_dict.txt",
        "Det.ocr_version": OCRVersion.PPOCRV6,
        "Rec.ocr_version": OCRVersion.PPOCRV6,
        "Det.model_type": ModelType.SMALL,
        "Rec.model_type": ModelType.SMALL,
    })
    try:
        got = engine(src)
    except Exception as err:
        refuse("the picture could not be read: " + str(err))
    lines = []
    texts = got.txts or []
    boxes = got.boxes if got.boxes is not None else []
    scores = got.scores or []
    for i, text in enumerate(texts):
        if not str(text).strip():
            continue
        line = {"text": str(text)[:500]}
        if i < len(boxes):
            xs = [float(p[0]) for p in boxes[i]]
            ys = [float(p[1]) for p in boxes[i]]
            line["box"] = [min(xs), min(ys), max(xs), max(ys)]
        if i < len(scores):
            line["score"] = round(float(scores[i]), 4)
        lines.append(line)
        if len(lines) >= 2000:
            break
    with open(out, "w") as f:
        json.dump(lines, f)


if sys.argv[1] != "lines" or len(sys.argv) < 5:
    refuse("usage: lines <in> <out.json> <models dir>")
main()
`

const tailOf = (out: string): string => out.trim().split('\n').slice(-3).join(' ').slice(0, 400)

const linesConverter = (from: string): Converter => ({
  from,
  to: 'lines',
  needs: 'docling-models',
  threads: 2,
  async run(job, run) {
    const python = run.tools.bin('docling-venv')
    // The models' folder is the one that holds the file the manifest names as their bin (RapidOcr/ppocrv6_dict.txt).
    const dict = run.tools.bin('docling-models')
    if (!python || !dict) throw new Error('The reader is not installed here.')
    const script = join(run.tmp, 'tc_money_lines.py')
    writeFileSync(script, LINES_PY)
    const r = await run.run(python, ['-I', script, 'lines', job.input, job.output, dirname(dict)], {
      timeoutMs: 3 * 60_000,
      cwd: run.tmp,
      env: { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', OMP_NUM_THREADS: String(Math.max(2, run.threads)) }
    })
    if (r.code === 0) return {}
    throw new Error(/tc-error: (.+)/.exec(r.out)?.[1]?.trim() ?? `The picture could not be read: ${tailOf(r.out) || `exit ${r.code}`}`)
  }
})

export const MONEY_CONVERTERS: Converter[] = ['jpg', 'png'].map(linesConverter)

/** What Money files: a picture or a PDF, by the file's extension. */
export const RECEIPT_EXTS = ['jpg', 'jpeg', 'png', 'heic', 'heif', 'tif', 'tiff', 'webp', 'gif', 'bmp', 'pdf'] as const
export const extOf = (name: string): string => extname(name).slice(1).toLowerCase()
export const isReceiptFile = (name: string): boolean => (RECEIPT_EXTS as readonly string[]).includes(extOf(name))

/** Pictures Chromium cannot show and the reader cannot open: made a JPEG first, by the media pillar's converter. */
const TO_JPG = new Set(['heic', 'heif', 'tif', 'tiff'])
const READ_AS = new Map([
  ['jpg', 'jpg'],
  ['jpeg', 'jpg'],
  ['png', 'png']
])

type Ctx = Pick<WorkCtx, 'convert'>

/** A picture in a form the window shows and the reader opens: itself, or its JPEG. Null for one that cannot be made so here. */
export async function shownPicture(ctx: Ctx, path: string, signal?: AbortSignal): Promise<{ path: string; ext: string } | null> {
  const ext = extOf(path)
  if (!TO_JPG.has(ext)) return ext === 'pdf' ? null : { path, ext }
  const made = await ctx.convert({ from: ext, to: 'jpg', input: path, signal })
  return { path: made.output, ext: 'jpg' }
}

async function pictureLines(ctx: Ctx, path: string, signal?: AbortSignal): Promise<ReceiptLine[]> {
  const shown = await shownPicture(ctx, path, signal)
  const from = shown ? READ_AS.get(shown.ext) : undefined
  // A picture the reader has no way into (a GIF, a WebP): no lines, and he reads the picture himself.
  if (!shown || !from) return []
  const done = await ctx.convert({ from, to: 'lines', input: shown.path, signal })
  return JSON.parse(readFileSync(done.output, 'utf8')) as ReceiptLine[]
}

/** The part of the pdf pillar's extract Money reads (pdf/extract.ts `PdfExtract`): each block's page, place (shares of the page) and text. */
interface Extract {
  blocks: { page: number; bbox: [number, number, number, number]; text: string }[]
}

/** A PDF's text blocks as lines, top to bottom across its pages: a block of several lines is cut into its lines, each with its share of the block's height. */
export function linesOfExtract(x: Extract): ReceiptLine[] {
  const lines: ReceiptLine[] = []
  for (const block of x.blocks) {
    const texts = block.text.split('\n').filter((t) => t.trim())
    const [left, top, right, bottom] = block.bbox
    const each = (bottom - top) / Math.max(1, texts.length)
    texts.forEach((text, i) => {
      // A page stands one whole unit under the page before it.
      const at = block.page - 1 + top + i * each
      lines.push({ text: text.trim().slice(0, 500), box: [left, at, right, at + each] })
    })
  }
  return lines
}

/** The width a scan's first page is drawn at before it is read. */
const SCAN_WIDTH = 2000

async function pdfLines(ctx: Ctx, path: string, signal?: AbortSignal): Promise<ReceiptLine[]> {
  // The first two pages at most: a page list would be refused for a file with fewer ("Page 2 is not in this file").
  const read = await ctx.convert({ from: 'pdf', to: 'extract', input: path, options: { maxPages: 2, tables: false }, signal })
  const lines = linesOfExtract(JSON.parse(readFileSync(read.output, 'utf8')) as Extract)
  if (lines.length) return lines
  // No text layer: a scan. Its first page is read as a picture.
  const drawn = await ctx.convert({ from: 'pdf', to: 'png', input: path, options: { page: 1, width: SCAN_WIDTH }, signal })
  return pictureLines(ctx, drawn.output, signal)
}

/** The lines of a receipt's file. Throws when the file could not be read at all; the caller files it with empty fields. */
export function readReceipt(ctx: Ctx, path: string, signal?: AbortSignal): Promise<ReceiptLine[]> {
  return extOf(path) === 'pdf' ? pdfLines(ctx, path, signal) : pictureLines(ctx, path, signal)
}

/** A PDF's first page as a picture the window can show. */
export async function pdfPicture(ctx: Ctx, path: string, signal?: AbortSignal): Promise<string> {
  return (await ctx.convert({ from: 'pdf', to: 'png', input: path, options: { page: 1, width: 1200 }, signal })).output
}
