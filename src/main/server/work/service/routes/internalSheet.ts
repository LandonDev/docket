import { isAbsolute } from 'node:path'
import { LifeosBackend, TcsheetBackend } from '../../sheets/host/backends'
import { SheetHost } from '../../sheets/host/host'
import type { A1Cell, HostAsk, SheetRef, Which } from '../../sheets/host/wire'
import { RouteError, type InternalRoute, type RouteCtx } from './route'

/**
 * The internal sheet routes (docs/agents/work-sheets.md "Sheets the service
 * holds"), on the service's socket behind the secret. Two callers:
 *
 * - the LifeOS worker's tools (`read_sheet_range`, `write_sheet_range`,
 *   `suggest_sheet_cells`; M17.md): `/internal/sheet/read` and `/write`,
 *   with the caller's `fence`, which is held again against the sheet's sector;
 * - main's sheets pillar, for the canvas and the thread tools on a LifeOS
 *   sheet or a `.tcsheet`: `/internal/sheet/<op>` with the bodies of
 *   sheets/host/wire.ts.
 *
 * One host engine per service (sheets/host/host.ts). A LifeOS sheet is served
 * only by the host that serves LifeOS's documents (M18's rule, one service
 * per store); a `.tcsheet` by the host it is on.
 */

type Fence = { sectors: string[] | 'all' }
const SAFE = /^[A-Za-z0-9_-]{1,128}$/
const MAX_CELLS = 1000

let made: { host: SheetHost; ctx: RouteCtx } | null = null
/** The service's one sheet host, made on first use; the live route (sheet.ts) shares it. */
export function hostOf(ctx: RouteCtx): SheetHost {
  if (made?.ctx !== ctx) made = { host: new SheetHost((ref) => ('lifeos' in ref ? new LifeosBackend(ctx.convex, ref.lifeos) : new TcsheetBackend(ref.tcsheet))), ctx }
  return made.host
}

function refOf(body: Record<string, unknown>, ctx: RouteCtx): SheetRef {
  const s = body.sheet as { lifeos?: unknown; tcsheet?: unknown } | undefined
  if (s && typeof s.lifeos === 'string' && /^[A-Za-z0-9]{1,64}$/.test(s.lifeos)) {
    servingLifeos(ctx)
    return { lifeos: s.lifeos }
  }
  if (s && typeof s.tcsheet === 'string' && isAbsolute(s.tcsheet) && s.tcsheet.endsWith('.tcsheet')) return { tcsheet: s.tcsheet }
  throw new RouteError(400, 'sheet is a LifeOS id or an absolute .tcsheet path')
}

function servingLifeos(ctx: RouteCtx): void {
  const lifeos = ctx.config().lifeos
  if (!lifeos.here) throw new RouteError(409, lifeos.host ? `LifeOS sheets are served by ${lifeos.host}` : 'this instance serves no LifeOS sheets')
}

const num = (body: Record<string, unknown>, key: string): number => {
  const v = body[key]
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new RouteError(400, `${key} is missing`)
  return v
}
const text = (body: Record<string, unknown>, key: string, max = 300): string => {
  const v = body[key]
  if (typeof v !== 'string' || !v || v.length > max) throw new RouteError(400, `${key} is missing or too long`)
  return v
}

/** Cells as agents write them: `{at, v?, f?}`, at most 1,000. */
function cellsOf(body: Record<string, unknown>): A1Cell[] {
  const cells = body.cells
  if (!Array.isArray(cells) || !cells.length || cells.length > MAX_CELLS) throw new RouteError(400, `cells is 1 to ${MAX_CELLS} cells`)
  return cells.map((c: { at?: unknown; v?: unknown; f?: unknown }) => {
    if (!c || typeof c.at !== 'string' || c.at.length > 300) throw new RouteError(400, 'each cell has an A1 `at`')
    if (c.f !== undefined && (typeof c.f !== 'string' || c.f.length > 8000)) throw new RouteError(400, `${c.at}: f is a formula`)
    if (c.v !== undefined && c.v !== null && !['string', 'number', 'boolean'].includes(typeof c.v)) throw new RouteError(400, `${c.at}: v is a value`)
    return { at: c.at, ...(c.v !== undefined ? { v: c.v as A1Cell['v'] } : {}), ...(c.f !== undefined ? { f: c.f as string } : {}) }
  })
}

/** Who a worker's write is credited to: the thread that asked, or the bot key (M17, §8.1). */
function principalOf(body: Record<string, unknown>): string {
  const origin = body.origin as { host?: unknown; threadId?: unknown } | undefined
  if (origin && typeof origin === 'object') {
    if (typeof origin.host !== 'string' || typeof origin.threadId !== 'string' || !SAFE.test(origin.host) || !SAFE.test(origin.threadId)) throw new RouteError(400, 'origin is not a host and a thread')
    return `agent:${origin.host}:${origin.threadId}`
  }
  if (typeof body.botId !== 'string' || !SAFE.test(body.botId)) throw new RouteError(400, 'botId is missing')
  return `lifeos:bot:${body.botId}`
}

/** A LifeOS sheet through the worker's caller's fence: "not found" outside it, as LifeOS itself answers. */
async function lifeosIn(ctx: RouteCtx, body: Record<string, unknown>): Promise<SheetRef> {
  servingLifeos(ctx)
  const id = body.sheetId
  if (typeof id !== 'string' || !/^[A-Za-z0-9]{1,64}$/.test(id)) throw new RouteError(404, 'not found')
  const fence = body.fence as Fence | undefined
  if (!fence || (fence.sectors !== 'all' && !Array.isArray(fence.sectors))) throw new RouteError(400, 'fence is missing')
  const ref = { lifeos: id }
  const sector = await hostOf(ctx)
    .sectorOf(ref)
    .catch(() => {
      throw new RouteError(404, 'not found')
    })
  if (fence.sectors !== 'all' && (!sector || !fence.sectors.includes(sector))) throw new RouteError(404, 'not found')
  return ref
}

/** Errors the host throws are the caller's to read (a range that does not parse, a stale edit): 400 with the words. */
const said = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof RouteError) throw err
    throw new RouteError(400, err instanceof Error ? err.message : String(err))
  }
}

const which = (v: unknown): Which => {
  if (v === 'all') return 'all'
  const w = v as { ids?: unknown; changeSet?: unknown } | undefined
  if (w && Array.isArray(w.ids) && w.ids.every((i) => typeof i === 'string')) return { ids: w.ids as string[] }
  if (w && typeof w.changeSet === 'string') return { changeSet: w.changeSet }
  throw new RouteError(400, 'which is ids, a change set or all')
}

/** Main's calls: one route per op of sheets/host/wire.ts. */
const OPS: Record<HostAsk['op'], (body: Record<string, unknown>, ctx: RouteCtx) => Promise<unknown>> = {
  open: (b, ctx) => hostOf(ctx).open(refOf(b, ctx)),
  snapshot: (b, ctx) => hostOf(ctx).snapshot(refOf(b, ctx), num(b, 'rev'), num(b, 'offset'), Math.min(Math.max(num(b, 'length'), 1), 4 * 1024 * 1024)),
  since: (b, ctx) => hostOf(ctx).since(refOf(b, ctx), num(b, 'rev')),
  apply: (b, ctx) => {
    if (!Array.isArray(b.mutations) || !b.mutations.length) throw new RouteError(400, 'mutations is missing')
    return hostOf(ctx).apply(refOf(b, ctx), num(b, 'baseRev'), b.mutations as never, text(b, 'by'))
  },
  range: (b, ctx) => hostOf(ctx).range(refOf(b, ctx), text(b, 'range')),
  cells: (b, ctx) => hostOf(ctx).cells(refOf(b, ctx), cellsOf(b), text(b, 'by'), b.suggest === true, typeof b.reason === 'string' ? b.reason.slice(0, 300) : undefined),
  review: (b, ctx) => hostOf(ctx).review(refOf(b, ctx), which(b.which), b.verdict === 'accept' ? 'accept' : 'reject'),
  history: (b, ctx) => hostOf(ctx).history(refOf(b, ctx)),
  compare: (b, ctx) => hostOf(ctx).compare(refOf(b, ctx), num(b, 'from'), num(b, 'to'), Math.min(num(b, 'max'), 50_000)),
  restore: (b, ctx) => hostOf(ctx).restore(refOf(b, ctx), num(b, 'rev'), text(b, 'by')),
  async create(b, ctx) {
    const title = text(b, 'title', 200)
    const at = b.at as { tcsheet?: unknown; lifeos?: { sector?: unknown; projectId?: unknown } } | undefined
    if (at && typeof at.tcsheet === 'string' && isAbsolute(at.tcsheet) && at.tcsheet.endsWith('.tcsheet')) {
      TcsheetBackend.create(at.tcsheet, title)
      return { sheet: { tcsheet: at.tcsheet } }
    }
    if (at?.lifeos && typeof at.lifeos.sector === 'string') {
      servingLifeos(ctx)
      const id = (await ctx.convex('mutation', 'sheets:create', { ...(typeof at.lifeos.projectId === 'string' ? { projectId: at.lifeos.projectId } : { sector: at.lifeos.sector }), title })) as string
      return { sheet: { lifeos: id } }
    }
    throw new RouteError(400, 'at is a .tcsheet path or a LifeOS sector')
  }
}

export const internalSheetRoutes: InternalRoute[] = [
  {
    path: '/internal/sheet/read',
    milestone: 27,
    async run(body, ctx) {
      const ref = await lifeosIn(ctx, body)
      const range = text(body, 'range')
      const got = await said(() => hostOf(ctx).range(ref, range))
      return { range: got.sheet ? `${got.sheet}!${range.split('!').pop()}` : range, cells: got.cells }
    }
  },
  {
    path: '/internal/sheet/write',
    milestone: 27,
    async run(body, ctx) {
      const because = body.because
      if (because !== 'asked' && because !== 'routine' && because !== 'own') throw new RouteError(400, 'because is asked, routine or own')
      const by = principalOf(body)
      const ref = await lifeosIn(ctx, body)
      const cells = cellsOf(body)
      const host = hostOf(ctx)
      const { shared } = await host.open(ref)
      // An agent's own idea on a shared sheet waits as a suggestion; what the owner asked for or a routine was granted is written (the owner's rule).
      const suggest = body.suggest === true || (because === 'own' && shared)
      const origin = body.origin && typeof body.origin === 'object' ? body.origin : undefined
      const got = await said(() => host.cells(ref, cells, by, suggest, undefined, origin))
      return suggest ? { mode: 'suggest', changeSetId: got.changeSetId } : { mode: 'direct', rev: got.rev }
    }
  },
  ...(Object.keys(OPS) as HostAsk['op'][]).map(
    (op): InternalRoute => ({
      path: `/internal/sheet/${op}`,
      milestone: 27,
      run: (body, ctx) => said(() => OPS[op](body, ctx))
    })
  )
]
