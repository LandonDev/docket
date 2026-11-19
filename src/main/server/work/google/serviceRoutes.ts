import * as Y from 'yjs'
import { fileDocName } from 'work-kit/collab-server'
import { documentForExport } from 'work-kit/formats/tcdoc'
import { isAbsolute } from 'node:path'
import { fenceOf } from '../service/routes/internal'
import { RouteError, type InternalRoute } from '../service/routes/route'

/**
 * The google pillar's internal route on the Work service
 * (docs/agents/work-google.md "Docs"): a Google Doc's mirror as its blocks
 * stand now, without waiting branches, which main compares with what it last
 * read from Google to write his edits there. Loaded by the service's entry:
 * it imports nothing of the database, Electron or `@shared/work`.
 */
function filePathOf(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || !isAbsolute(value) || !value.toLowerCase().endsWith('.tcdoc')) throw new RouteError(400, 'file is not a .tcdoc path')
  if (value.split(/[\\/]/).slice(1).some((p) => p === '' || p === '.' || p === '..')) throw new RouteError(400, 'file is not a plain path')
  return value
}

export const googleRoutes: InternalRoute[] = [
  {
    path: '/internal/google/blocks',
    milestone: 30,
    async run(body, ctx) {
      const fence = fenceOf(body)
      if (fence.sectors !== 'all' || fence.botId !== undefined || fence.client !== undefined || fence.draftOnly) throw new RouteError(403, "this route is main's")
      const path = filePathOf(body.file)
      let state: Uint8Array = new Uint8Array()
      await ctx.collab.edit(fileDocName(path), 'owner', (doc) => void (state = Y.encodeStateAsUpdate(doc)), { path })
      const doc = new Y.Doc()
      Y.applyUpdate(doc, state)
      const { blocks } = documentForExport(doc, { branches: [], threads: [] })
      doc.destroy()
      return { blocks }
    }
  }
]
