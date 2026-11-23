import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ExportAnswer } from '@shared/contract-work-formats'
import type { CanvasSource } from '@shared/work'
import { canvasSourcePath } from '@shared/work'
import { namesFor } from '../docs'
import { importsRoot } from '../files/imports'
import { sharedOf } from '../files/policy'
import { lifeosRow, serviceTarget, targetOf, titleOf } from '../docs/target'
import { readThreads } from '../docs/threads'
import type { Caller, WorkCtx } from '../modules'
import { ServedElsewhere } from '../service/ctx'
import { droppedWords, safeName, scratchDir } from './importer'
import { printToPdf } from './print'

/**
 * A document out as a file (docs/agents/work-formats.md "Import and export"):
 * the Work service writes Word from the live text with its pending branches
 * as tracked changes and its threads as comments (formats/serviceRoutes.ts),
 * or markdown; OpenDocument and RTF are that Word file through LibreOffice.
 * HTML is the window's own; PDF is the window's print page printed here.
 */

const METHOD = 'work.formats.export'

/**
 * Whether a document is, or was made from, a file others can open: a source
 * `sharedOf` says is shared, or the `.tcdoc` the importer wrote under
 * `work-files/imports` for a file in a library (it writes there for no
 * other). What is made of such a document (a converted copy, a preview's
 * render) never leaves this host.
 */
export function madeFromShared(ctx: Pick<WorkCtx, 'db' | 'host' | 'dataDir'>, source: CanvasSource): boolean {
  if (sharedOf(ctx, source)) return true
  const path = canvasSourcePath(source)
  if (!path) return false
  const inside = relative(importsRoot(ctx.dataDir), path)
  return !!inside && !inside.startsWith('..') && !isAbsolute(inside)
}

export async function exportDoc(ctx: WorkCtx, by: Caller, params: { source: CanvasSource; format: 'docx' | 'odt' | 'rtf' | 'md' }): Promise<ExportAnswer> {
  const t = await targetOf(ctx, by, METHOD, params.source)
  const title = titleOf(t, await lifeosRow(ctx, t))
  const threads = await readThreads(ctx, t)
  const names = namesFor(ctx, threads.flatMap((r) => r.comments.map((c) => c.authorMemberId)))
  const kind = params.format === 'md' ? 'md' : 'docx'
  let got: { data?: string; text?: string; dropped?: Record<string, number> }
  try {
    got = (await ctx.service.internal('/internal/formats/export', { ...serviceTarget(t, false, 'all'), format: kind, threads, names, title })) as typeof got
  } catch (err) {
    if (err instanceof ServedElsewhere) throw new Error(`served elsewhere: ${err.host}`)
    throw err
  }
  const warnings = droppedWords(got.dropped ?? {})
  const name = `${safeName(title)}.${params.format}`
  if (kind === 'md') return { name, data: Buffer.from(got.text ?? '', 'utf8').toString('base64'), warnings }
  if (params.format === 'docx') return { name, data: got.data ?? '', warnings }
  // OpenDocument and RTF: the same Word file, through LibreOffice.
  const input = join(scratchDir(ctx), `${randomUUID()}.docx`)
  writeFileSync(input, Buffer.from(got.data ?? '', 'base64'))
  try {
    // The scratch copy says nothing of where its words came from: the job is told, so a shared document's never leaves this host.
    const done = await ctx.convert({ from: 'docx', to: params.format, input, shared: madeFromShared(ctx, params.source) })
    try {
      const data = readFileSync(done.output).toString('base64')
      return { name, data, warnings: [...warnings, ...done.warnings] }
    } finally {
      rmSync(done.output, { force: true })
    }
  } finally {
    rmSync(input, { force: true })
  }
}

export async function printPage(ctx: WorkCtx, params: { name: string; html: string; paper?: 'A4' | 'Letter' }): Promise<ExportAnswer> {
  const { pdf, warnings } = await printToPdf(params.html, { paper: params.paper ?? 'A4', dir: scratchDir(ctx) })
  const stem = safeName(params.name).replace(/\.pdf$/i, '')
  return { name: `${stem}.pdf`, data: Buffer.from(pdf).toString('base64'), warnings }
}
