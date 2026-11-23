import { isAbsolute } from 'node:path'
import * as Y from 'yjs'
import { fileDocName, type CollabFile } from 'work-kit/collab-server'
import { inlinePieces, type BlockDiff } from 'work-kit/formats/diff'
import { writeDocx } from 'work-kit/formats/docx'
import { writeMarkdown } from 'work-kit/formats/markdown'
import { defaultName, documentForExport, readStoredSidecar } from 'work-kit/formats/tcdoc'
import { isAgentBranch } from '../history/privateBranches'
import { docIn, fenceOf, servingHere, str } from '../service/routes/internal'
import { RouteError, type InternalRoute, type RouteCtx } from '../service/routes/route'

/**
 * The formats pillar's internal route on the Work service
 * (docs/agents/work-formats.md "Import and export"): a live document written
 * out as it stands, its people's pending branches as Word's tracked changes
 * (an agent's stay out: `EXPORT_HOLDS_AGENT_SUGGESTIONS`) and its comment
 * threads as Word's comments. Main calls it after its own checks (the
 * path fence, the sector) and hands over the thread rows and the names it
 * keeps. Loaded by the service's entry: it imports nothing of the database,
 * the store, Electron or `@shared/work` (service/boundary.test.ts).
 */

interface Target {
  name: string
  file?: CollabFile
}

function filePath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || !isAbsolute(value) || !value.toLowerCase().endsWith('.tcdoc')) throw new RouteError(400, 'file is not a .tcdoc path')
  if (value.split(/[\\/]/).slice(1).some((p) => p === '' || p === '.' || p === '..')) throw new RouteError(400, 'file is not a plain path')
  return value
}

async function targetOf(body: Record<string, unknown>, ctx: RouteCtx): Promise<Target> {
  const fence = fenceOf(body)
  if (fence.botId !== undefined || fence.client !== undefined || fence.draftOnly) throw new RouteError(403, "these routes are main's")
  if (body.file !== undefined) {
    if (fence.sectors !== 'all') throw new RouteError(404, 'not found')
    const path = filePath(body.file)
    return { name: fileDocName(path), file: { path } }
  }
  servingHere(ctx)
  const docId = str(body, 'docId', 64)
  await docIn(ctx, docId, fence)
  return { name: docId }
}

const FORMATS = ['docx', 'md'] as const

/**
 * The owner's ruling of 2026-11-23: "Make sure agent suggests mode doesn't let any agent changes let
 * anyone else on the team see them (synced edits) until they are approved and the file is actually
 * edited." An exported file is what leaves him, so an agent's pending suggestion (`agent:`,
 * `lifeos:bot:`) never goes into one, on any document, shared or not; the answer counts what stayed
 * out (`held`). A person's (a Word author's `external:`, a guest's, his own restore) still goes as a
 * tracked change. Set false to write agents' as tracked changes again.
 */
export const EXPORT_HOLDS_AGENT_SUGGESTIONS = true

/** A branch's changes as the canvas counts them (renderer work/docs/review.ts `reviewOf`): a changed line's words one a piece, anything else one a row. */
export function changesOf(diff: BlockDiff): number {
  let n = 0
  for (const row of diff.rows) {
    const words = row.kind === 'changed' && !row.cells && row.inline && !row.right?.table && !row.typeChange && !row.props && !row.format
    n += words ? Math.max(1, inlinePieces(row.inline!).length) : 1
  }
  return n
}

export const formatsRoutes: InternalRoute[] = [
  {
    path: '/internal/formats/previewOffice',
    milestone: 21,
    async run(body, ctx) {
      await targetOf(body, ctx)
      return {}
    }
  },
  {
    path: '/internal/formats/export',
    milestone: 21,
    async run(body, ctx) {
      const t = await targetOf(body, ctx)
      const format = body.format
      if (!FORMATS.includes(format as never)) throw new RouteError(400, 'format is docx or md')
      const threads = Array.isArray(body.threads) ? body.threads : []
      const names = body.names && typeof body.names === 'object' ? (body.names as Record<string, string>) : {}
      // The live state as it stands now, read inside an edit that changes nothing.
      let state: Uint8Array = new Uint8Array()
      await ctx.collab.edit(t.name, 'owner', (doc) => void (state = Y.encodeStateAsUpdate(doc)), t.file)
      const doc = new Y.Doc()
      Y.applyUpdate(doc, state)
      // Markdown has no tracked changes: every suggestion stays out of it, and none is read.
      const pending = format === 'docx' ? await ctx.history.branches(t.name, t.file) : []
      const held = EXPORT_HOLDS_AGENT_SUGGESTIONS ? pending.filter(isAgentBranch) : []
      const branches = pending.filter((b) => !held.includes(b))
      const out = documentForExport(doc, { branches, threads: threads as never, sidecar: t.file ? await readStoredSidecar(t.file.path) : {}, nameOf: (p) => names[p] ?? defaultName(p) })
      doc.destroy()
      if (format === 'md') return { text: writeMarkdown(out.blocks, out.sidecar), dropped: out.dropped }
      const title = typeof body.title === 'string' ? body.title.slice(0, 200) : undefined
      const bytes = await writeDocx(out.blocks, out.sidecar, title ? { title } : {})
      return { data: Buffer.from(bytes).toString('base64'), dropped: out.dropped, held: held.reduce((n, b) => n + changesOf(b.diff), 0) }
    }
  }
]
