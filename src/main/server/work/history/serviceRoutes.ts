import { isAbsolute } from 'node:path'
import { fileDocName, versionBy, type CollabFile, type VersionRow } from 'work-kit/collab-server'
import { docIn, fenceOf, servingHere, str } from '../service/routes/internal'
import { RouteError, type InternalRoute, type RouteCtx } from '../service/routes/route'

/**
 * History's internal routes on the Work service (docs/agents/work-history.md):
 * the Unix socket, behind the secret, like routes/internal.ts. Main's
 * `work.history.*` methods call them through `ctx.service.internal`. A
 * document is a LifeOS row (`docId` and the caller's `fence`, held again
 * here) or a `.tcdoc` (`file`, a path main already put through its own path
 * fence; only an unfenced caller may name one). Every act here is the
 * owner's: acts of agents come through `/internal/doc/write`.
 *
 * This file is loaded by the service's entry: it may import nothing of the
 * database, the store, Electron or `@shared/work` (service/boundary.test.ts).
 */

interface Target {
  name: string
  file?: CollabFile
  shared: boolean
}

/** A `.tcdoc`'s path as the token rules take it: absolute, plain, no `.` or `..` segment. */
function filePath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || !isAbsolute(value) || !value.toLowerCase().endsWith('.tcdoc')) throw new RouteError(400, 'file is not a .tcdoc path')
  const parts = value.split(/[\\/]/).slice(1)
  if (parts.some((p) => p === '' || p === '.' || p === '..')) throw new RouteError(400, 'file is not a plain path')
  return value
}

async function targetOf(body: Record<string, unknown>, ctx: RouteCtx): Promise<Target> {
  const fence = fenceOf(body)
  // History's acts are the owner's: main calls with an unfenced fence. The LifeOS worker holds the same
  // secret but always names its bot key; a bot's call here (a draft-only key accepting its own branch) is refused.
  if (fence.botId !== undefined || fence.client !== undefined || fence.draftOnly) throw new RouteError(403, "history is the owner's: a bot key cannot ask it")
  if (body.file !== undefined) {
    if (fence.sectors !== 'all') throw new RouteError(404, 'not found')
    const path = filePath(body.file)
    return { name: fileDocName(path), file: { path }, shared: body.shared === true }
  }
  servingHere(ctx)
  const docId = str(body, 'docId', 64)
  const row = await docIn(ctx, docId, fence)
  return { name: docId, shared: !!row.shared }
}

const side = (body: Record<string, unknown>, key: string): string => {
  const v = body[key]
  if (v === 'live') return v
  return str(body, key, 64)
}

/** A version as the wire carries it: who wrote, not which client ids. */
export function wireVersion(row: VersionRow): { id: string; at: number; cause: VersionRow['cause']; label?: string; by: string[]; restoredFrom?: string; kept: VersionRow['kept'] } {
  return {
    id: row.id,
    at: row.at,
    cause: row.cause,
    ...(row.label ? { label: row.label } : {}),
    by: versionBy(row),
    ...(row.restoredFrom ? { restoredFrom: row.restoredFrom } : {}),
    kept: row.kept
  }
}

/** Rows to act on: block ids, or all of them. */
function which(body: Record<string, unknown>): string[] | 'all' {
  const v = body.which
  if (v === 'all') return v
  if (!Array.isArray(v) || v.length === 0 || v.length > 1000 || !v.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 64)) throw new RouteError(400, 'which is "all" or a list of block ids')
  return v as string[]
}

/** The history's own words for a refusal reach the caller as a 4xx. */
async function refusing<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof RouteError) throw err
    const message = (err as Error).message
    if (/^not found$|no longer be read|not in this branch|that branch is|not this doc's/.test(message)) throw new RouteError(message === 'not found' ? 404 : 409, message)
    throw err
  }
}

const opts = (t: Target) => (t.file ? { file: t.file } : {})

export const historyRoutes: InternalRoute[] = [
  {
    path: '/internal/history/list',
    milestone: 19,
    async run(body, ctx) {
      const t = await targetOf(body, ctx)
      return refusing(async () => ({ versions: (await ctx.history.list(t.name, t.file)).map(wireVersion), shared: t.shared }))
    }
  },
  {
    path: '/internal/history/compare',
    milestone: 19,
    async run(body, ctx) {
      const t = await targetOf(body, ctx)
      return refusing(async () => ({ diff: await ctx.history.compare(t.name, side(body, 'from'), side(body, 'to'), t.file) }))
    }
  },
  {
    path: '/internal/history/cut',
    milestone: 19,
    async run(body, ctx) {
      const t = await targetOf(body, ctx)
      const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 200) : undefined
      return refusing(async () => wireVersion(await ctx.history.cut(t.name, 'named', { force: true, ...(label ? { label } : {}), ...opts(t) })))
    }
  },
  {
    path: '/internal/history/restore',
    milestone: 19,
    async run(body, ctx) {
      const t = await targetOf(body, ctx)
      const versionId = str(body, 'versionId', 64)
      return refusing(() => ctx.history.restore(t.name, versionId, { principal: 'owner', shared: t.shared, ...opts(t) }))
    }
  },
  {
    path: '/internal/history/branches',
    milestone: 19,
    async run(body, ctx) {
      const t = await targetOf(body, ctx)
      return refusing(async () => ({ branches: await ctx.history.branches(t.name, t.file) }))
    }
  },
  {
    path: '/internal/history/decide',
    milestone: 19,
    async run(body, ctx) {
      const t = await targetOf(body, ctx)
      const branchId = str(body, 'branchId', 64)
      const rows = which(body)
      if (typeof body.accept !== 'boolean') throw new RouteError(400, 'accept is true or false')
      return refusing(async () => (body.accept ? ctx.history.accept(t.name, branchId, rows, t.file) : ctx.history.reject(t.name, branchId, rows, t.file)))
    }
  }
]
