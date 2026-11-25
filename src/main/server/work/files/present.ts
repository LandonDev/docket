import type { FileEntry } from '@shared/work/files'
import { guestsPresentIn } from '../guests/store'
import type { WorkCtx } from '../modules'
import { canonicalPath } from '../service/ctx'
import { COUNTED_MOST } from './waiting'

/**
 * The rows with `state: { is: 'present', who }` where a guest has the file open now (docs/agents/work-files.md "A
 * row's one state"): a document or sheet of ours on this host, by a live guest link, that shows no other state. Read
 * from what the guests pillar last heard of the Work service (within half a minute), never by asking anything.
 */
export function withPresent(ctx: Pick<WorkCtx, 'db' | 'host'>, entries: FileEntry[]): FileEntry[] {
  let out: FileEntry[] | null = null
  entries.slice(0, COUNTED_MOST).forEach((e, i) => {
    if (e.folder || e.state || e.ref?.at !== 'file' || e.ref.host !== ctx.host || !/\.tc(doc|sheet)$/i.test(e.ref.path)) return
    const who = guestsPresentIn(ctx.db, canonicalPath(e.ref.path))
    if (who) (out ??= entries.slice())[i] = { ...e, state: { is: 'present', who } }
  })
  return out ?? entries
}
