import { createHash } from 'node:crypto'
import { unzipSync } from 'fflate'
import type { WorkCtx } from '../modules'

/**
 * SharePoint's own touch (docs/agents/work-files.md "Saved is not uploaded"). An Office file OneDrive uploads into a
 * Teams library is written again by SharePoint about half a second later, and comes back down: its columns and content
 * type as custom XML, its properties, a `[trash]` of its own, and the relationships and content types naming them
 * (seen 2026-11-24: a .docx of 12,524 bytes came back as 21,001, its document part byte for byte the same). By version
 * or by its bytes' hash that is a change made there, and a save would stop on it. The body is every part but those: a
 * file whose body is as we last read or wrote it was changed by no one, and our save goes over it.
 */

/** The parts SharePoint writes into an Office file it takes in; anything anyone edits lies outside them. */
const SERVICE_PARTS = /^(\[Content_Types\]\.xml|docProps\/.*|customXml\/.*|\[trash\]\/.*|(.*\/)?_rels\/[^/]+\.rels)$/

/** A hash of a file's body: an Office file's parts but SharePoint's, sorted by name; any other file's every byte. */
export function bodyOf(data: Uint8Array): string {
  if (data[0] === 0x50 && data[1] === 0x4b) {
    try {
      const parts = unzipSync(data, { filter: (f) => !SERVICE_PARTS.test(f.name) })
      const h = createHash('sha256')
      for (const name of Object.keys(parts).sort()) h.update(name).update('\0').update(parts[name]!).update('\0')
      return `parts:${h.digest('hex')}`
    } catch {
      // not a package after all: its bytes are its body
    }
  }
  return createHash('sha256').update(data).digest('hex')
}

type FileAt = { workspace_id: string; host: string; path: string }

/** The body of a file of another computer as we just read or wrote it. */
export function keepBody(ctx: Pick<WorkCtx, 'db'>, r: FileAt, data: Uint8Array): void {
  ctx.db.prepare(`INSERT INTO work_files_bodies (workspace_id, host, path, body) VALUES (?, ?, ?, ?) ON CONFLICT (workspace_id, host, path) DO UPDATE SET body = excluded.body`).run(r.workspace_id, r.host, r.path, bodyOf(data))
}

/** Whether a file found changed there has the body we last read or wrote: SharePoint's touch alone, no one's edit. */
export function sameBody(ctx: Pick<WorkCtx, 'db'>, r: FileAt, data: Uint8Array): boolean {
  const kept = ctx.db.prepare(`SELECT body FROM work_files_bodies WHERE workspace_id = ? AND host = ? AND path = ?`).get(r.workspace_id, r.host, r.path) as { body: string } | undefined
  return !!kept && kept.body === bodyOf(data)
}
