import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import type { Readiness } from '@shared/contract-work-formats'
import type { SheetPreviewAnswer } from '@shared/contract-work-sheets'
import type { CanvasItem } from '@shared/work'
import { madeFromShared } from '../docs/target'
import { NoConverterError, NotReadyError, pressOf, runnerOf } from '../formats/jobs'
import type { Caller, WorkCtx } from '../modules'
import { heldOf, type Sheets } from './held'
import { bookOf } from './preview'
import { sheetDrops } from './previewFacts'

/**
 * "Check in Excel" (docs/agents/work-sheets.md "Check in Excel"): Excel's own
 * PDF of the workbook, beside LibreOffice's in Preview. It is the office
 * pillar's render (`xlsx → pdf+excel`, office/render.ts) asked through the
 * conversion runner, so every rule is that pillar's and the runner's: a pair
 * is offered by a carrier only once proven there (`RENDER_PROVEN`: the box's
 * Windows VM today, no Mac and no PC), the VM is woken only by a job that
 * carries his press, and Excel draws a copy in the job's own folder, never the
 * file itself.
 *
 * What this file adds is the sheet's side: which workbooks may go (never one
 * others can open, never a macro workbook, which the pair does not take),
 * the workbook as it stands now, and the picture kept by its content hash
 * beside Preview's other renders, read by range at its rev.
 */

/** Whether Excel can draw this workbook now, as Preview's `office()` asks it. */
export interface ExcelReach {
  app: 'excel'
  state: Readiness
}

/** Excel's picture of the workbook, or why none came: Excel went out of reach between the look and the press. */
export type ExcelCheck = (Omit<Extract<SheetPreviewAnswer, { kind: 'paged' }>, 'drawnBy'> & { drawnBy: 'excel' }) | { notInReach: Exclude<Readiness, 'ready'> }

/** The words for a press that was not his own. */
export const NEEDS_PRESS = 'Check in Excel needs your own press.'

type Ask = (shared: boolean) => Promise<Readiness>

/** The runner's own answer for the pair on this host, or `none` where no runner is up (Work off). */
const askRunner =
  (ctx: WorkCtx): Ask =>
  async (shared) =>
    (await (await runnerOf(ctx))?.readiness('xlsx', 'pdf+excel', shared)) ?? 'none'

/**
 * Whether this workbook may go to Excel at all, before anyone asks whether Excel is there.
 * - A workbook Excel or Google holds is drawn there, not here.
 * - A file others can open is never handed to Excel from here: the renderer may be another computer than the
 *   file's own (the box's Windows VM), as the document's Check in Word rules (formats/preview.ts).
 * - A macro workbook is not the pair's to take: Excel refuses macros under an .xlsx name.
 */
function mayGo(ctx: WorkCtx, item: CanvasItem): boolean {
  const held = heldOf(item, ctx.dataDir)
  if (held.at === 'excel' || held.at === 'google') return false
  if (madeFromShared(ctx, item.source)) return false
  return !(held.at === 'package' && held.path.toLowerCase().endsWith('.xlsm'))
}

/**
 * `work.sheets.previewOffice`: is Excel in reach of a press on this workbook, from the caller that asks? Never
 * wakes anything, never starts an app. A caller whose press would not be his own (a thread, another host of his,
 * a key that cannot approve) is told `none`, so no window offers a press that would be refused.
 */
export async function excelReach(s: Sheets, item: CanvasItem, by: Caller, ask: Ask = askRunner(s.ctx)): Promise<ExcelReach> {
  if (!pressOf(by) || !mayGo(s.ctx, item)) return { app: 'excel', state: 'none' }
  return { app: 'excel', state: await ask(false).catch((): Readiness => 'none') }
}

const revOf = (hash: string): string => createHash('sha256').update('pdf+excel\u0000').update(hash).digest('hex').slice(0, 32)

async function pagesIn(path: string): Promise<number> {
  const pdf = readFileSync(path)
  try {
    return (await PDFDocument.load(pdf, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false })).getPageCount()
  } catch {
    return Math.max(1, pdf.toString('latin1').match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0)
  }
}

/**
 * `work.sheets.preview` with `by: 'office'`: his press on "Check in Excel". The workbook as it stands now goes
 * to Excel as a copy and comes back as Excel's PDF of every sheet, kept by the workbook's content hash: a second
 * press on the same workbook answers the kept picture and asks Excel nothing. A machine asleep is woken by this
 * press alone; an Excel that is shut, or none, answers `notInReach` before the workbook is read, and LibreOffice's
 * picture stays.
 */
export async function checkInExcel(s: Sheets, item: CanvasItem, by: Caller, signal?: AbortSignal, ask: Ask = askRunner(s.ctx)): Promise<ExcelCheck> {
  const ctx = s.ctx
  // His press, made on this host: never a thread's, never another host's on his behalf (formats/jobs.ts).
  const press = pressOf(by)
  if (!press) throw new Error(NEEDS_PRESS)
  // Asked afresh: what the window was told when Preview opened may be minutes old.
  const { state } = await excelReach(s, item, by, ask)
  if (state === 'none' || state === 'not open') return { notInReach: state }
  const book = await bookOf(s, item)
  try {
    const rev = revOf(book.hash)
    // The file itself, as Excel reads it: what the Excel format keeps, and nothing a picture adds.
    const drops = sheetDrops('xlsx', book.facts, { package: book.package, left: book.left })
    const answer = (meta: { rev: string; size: number; pages?: number }): ExcelCheck => ({ kind: 'paged', rev: meta.rev, size: meta.size, pages: meta.pages ?? 1, drawnBy: 'excel', drops })
    const kept = book.store.get(rev)
    if (kept) return answer(kept)
    const input = join(book.scratch, `${randomUUID()}.xlsx`)
    const output = join(book.scratch, `${randomUUID()}.pdf`)
    writeFileSync(input, book.bytes, { mode: 0o600 })
    try {
      // `shared: false` is said, not found from the scratch path: `mayGo` has already kept every shared workbook here.
      await ctx.convert({ from: 'xlsx', to: 'pdf+excel', input, output, pressed: press, shared: false, ...(signal ? { signal } : {}) })
    } catch (err) {
      if (err instanceof NotReadyError) return { notInReach: err.state }
      if (err instanceof NoConverterError) return { notInReach: 'none' }
      throw err
    }
    return answer(book.store.put({ rev, ext: 'pdf', key: book.key, size: statSync(output).size, pages: await pagesIn(output) }, output))
  } finally {
    rmSync(book.scratch, { recursive: true, force: true })
  }
}
