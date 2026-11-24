import { basename } from 'node:path'
import type { WorkCtx } from '../modules'
import { sharedKey, sharedOf } from '../files/policy'
import type { OfficeCarrier } from './carrier'
import { librariesOf, libraryOf } from './files/library'

/**
 * Whether others can open a file an Office tool names by its key, the one test every Office write takes
 * (docs/agents/work-office.md "The rule for a file others can open"): Files' `sharedOf`, which holds the
 * spelling rules (`sharedKey`: a URL, a network share, a mounted disk, a folder named OneDrive on any host, a
 * Windows path in the VM included), asked first of the key as it is. A key no open file answers to is shared:
 * what cannot be found cannot be shown to be his own.
 */
export function fileShared(ctx: Pick<WorkCtx, 'db' | 'host' | 'dataDir'>, key: string | null, app: 'excel' | 'word' | 'powerpoint'): boolean {
  if (key === null || sharedKey(key)) return true
  const ref = /^https?:\/\//i.test(key) ? ({ kind: 'url', url: key } as const) : ({ kind: 'path', path: key } as const)
  if (sharedOf(ctx, { at: 'microsoft', host: ctx.host, app, name: basename(key.replace(/\\/g, '/')), ref })) return true
  // A Teams folder he added himself, by the office pillar's own list.
  return libraryOf(librariesOf(ctx.db, ctx.host), key) !== null
}

export { sharedKey }

/**
 * The open file a write names, as the carrier keys it: its key (either separator), else the one open file of that
 * name, since a carrier also takes a bare name. Null when none or several answer to it, or the app cannot be asked.
 */
export async function fileKey(env: { carrier: Pick<OfficeCarrier, 'workbooks' | 'documents' | 'presentations'> }, kind: 'workbook' | 'document' | 'deck', name: string): Promise<string | null> {
  let open: { key: string; name: string }[]
  try {
    open = kind === 'workbook' ? await env.carrier.workbooks() : kind === 'document' ? await env.carrier.documents() : await env.carrier.presentations()
  } catch {
    return null
  }
  // either separator, and /tmp for /private/tmp (Word's keys are the resolved form)
  const slash = (s: string): string => s.replace(/\\/g, '/').replace(/^\/private(?=\/(tmp|var|etc)\/)/, '')
  const byKey = open.filter((f) => f.key === name || slash(f.key) === slash(name))
  if (byKey.length === 1) return byKey[0]!.key
  const byName = open.filter((f) => f.name === name)
  return byName.length === 1 ? byName[0]!.key : null
}
