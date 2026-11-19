import type { InternalRoute, RouteCtx } from './route'
import { RouteError } from './route'
import { internalSheetRoutes } from './internalSheet'
import { notServedWords } from '../config'

/**
 * The internal routes (architecture §8.1, M17.md "The loopback routes"): on
 * the service's Unix socket only, behind the shared secret, never on the TCP
 * port. The LifeOS worker calls them for its document tools; the host calls
 * them through `ctx.service.internal`. Every body carries the caller's
 * `fence`: the worker judged the item already, but the service acts as the
 * owner, so it holds the fence again.
 */

export type Fence = { botId?: string; sectors: string[] | 'all'; client?: string; draftOnly?: boolean }
type DocRow = { _id: string; sector: string; seq: number; shared?: boolean; markdown?: string; plain?: string }

export const str = (body: Record<string, unknown>, key: string, max = 300): string => {
  const v = body[key]
  if (typeof v !== 'string' || v.length === 0 || v.length > max) throw new RouteError(400, `${key} is missing or too long`)
  return v
}

const SAFE = /^[A-Za-z0-9_-]{1,128}$/

export function fenceOf(body: Record<string, unknown>): Fence {
  const f = body.fence as Fence | undefined
  if (!f || typeof f !== 'object' || (f.sectors !== 'all' && !(Array.isArray(f.sectors) && f.sectors.every((s) => typeof s === 'string'))))
    throw new RouteError(400, 'fence is missing')
  return f
}

export const inFence = (fence: Fence, sector: string): boolean => fence.sectors === 'all' || fence.sectors.includes(sector)

/** Who a write is credited to: the thread that asked, or the bot key (§8.1). */
export function principalOf(body: Record<string, unknown>): string {
  const origin = body.origin as { host?: unknown; threadId?: unknown } | undefined
  if (origin && typeof origin === 'object') {
    if (typeof origin.host !== 'string' || typeof origin.threadId !== 'string' || !SAFE.test(origin.host) || !SAFE.test(origin.threadId))
      throw new RouteError(400, 'origin is not a host and a thread')
    return `agent:${origin.host}:${origin.threadId}`
  }
  const botId = body.botId
  if (typeof botId !== 'string' || !SAFE.test(botId)) throw new RouteError(400, 'botId is missing')
  return `lifeos:bot:${botId}`
}

/** The row, through the owner's eyes, and only if the caller's fence holds its sector; else "not found". */
export async function docIn(ctx: RouteCtx, docId: string, fence: Fence): Promise<DocRow> {
  if (!/^[A-Za-z0-9]{1,64}$/.test(docId)) throw new RouteError(404, 'not found')
  const row = (await ctx.convex('query', 'docs:get', { id: docId }).catch((err: Error) => {
    if (/not found|ArgumentValidationError|Invalid argument/i.test(err.message)) return null
    throw err
  })) as DocRow | null
  if (!row || !inFence(fence, row.sector)) throw new RouteError(404, 'not found')
  return row
}

/** On a host that does not serve LifeOS's documents, every write is refused with the host that does. */
export function servingHere(ctx: RouteCtx): void {
  const lifeos = ctx.config().lifeos
  if (!lifeos.here) throw new RouteError(409, notServedWords(lifeos.host))
}

const commentBody = (text: string): string => JSON.stringify([{ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] }])

export const internalDocRoutes: InternalRoute[] = [
  {
    path: '/internal/doc/read',
    milestone: 18,
    async run(body, ctx) {
      const docId = str(body, 'docId', 64)
      const row = await docIn(ctx, docId, fenceOf(body))
      const lifeos = ctx.config().lifeos
      // Not served here: the stored state, as LifeOS last kept it.
      if (!lifeos.here) return { markdown: row.markdown ?? '', plain: row.plain ?? '', seq: row.seq, stored: true }
      const live = await ctx.collab.read(docId)
      return { markdown: live.markdown, plain: live.plain, seq: row.seq }
    }
  },
  {
    path: '/internal/doc/write',
    milestone: 18,
    async run(body, ctx) {
      servingHere(ctx)
      const docId = str(body, 'docId', 64)
      const markdown = body.markdown
      if (typeof markdown !== 'string' || markdown.length > 900_000) throw new RouteError(400, 'markdown is missing or too long')
      const because = body.because
      if (because !== 'asked' && because !== 'routine' && because !== 'own') throw new RouteError(400, 'because is asked, routine or own')
      const principal = principalOf(body)
      const row = await docIn(ctx, docId, fenceOf(body))
      // "asked" must be the owner's words, found in his thread (§6.7), and "routine" a routine's grant: only main
      // can check either, and its agents write through /internal/docs/write (work/docs). This route's caller's
      // word for them (a bot key, or an origin it names) is not a verdict, so on a shared document its write waits as suggestions.
      // Direct and one version, or, for an agent's own idea on a shared document, into its branch (§8.4, milestone 19).
      const done = await ctx.history.write(docId, principal, markdown, { because: 'own', shared: !!row.shared })
      return done.mode === 'branch' ? done : { mode: 'direct', ...(done.versionId ? { versionId: done.versionId } : {}) }
    }
  },
  {
    path: '/internal/doc/create',
    milestone: 18,
    async run(body, ctx) {
      servingHere(ctx)
      const fence = fenceOf(body)
      const title = str(body, 'title', 500)
      const markdown = typeof body.markdown === 'string' ? body.markdown : ''
      if (markdown.length > 900_000) throw new RouteError(400, 'markdown is too long')
      const principal = principalOf(body)
      const projectId = typeof body.projectId === 'string' ? body.projectId : undefined
      const sector = typeof body.sector === 'string' ? body.sector : undefined
      if (!projectId && !sector) throw new RouteError(400, 'a sector or a project is needed')
      if (sector && !inFence(fence, sector)) throw new RouteError(404, 'not found')
      // No seed: the first state is the creator's own write, so history credits it to them.
      const docId = (await ctx.convex('mutation', 'docs:create', { ...(projectId ? { projectId } : { sector }), title })) as string
      try {
        await docIn(ctx, docId, fence)
      } catch (err) {
        // A project in a sector the fence does not hold: take the empty row back.
        await ctx.convex('mutation', 'docs:remove', { id: docId }).catch(() => {})
        throw err
      }
      await ctx.collab.writeMarkdown(docId, principal, markdown)
      await ctx.collab.flush()
      return { docId }
    }
  },
  {
    path: '/internal/doc/comment',
    milestone: 18,
    async run(body, ctx) {
      servingHere(ctx)
      const docId = str(body, 'docId', 64)
      const anchorText = str(body, 'anchorText', 2000)
      const text = str(body, 'body', 20_000)
      const principal = principalOf(body)
      await docIn(ctx, docId, fenceOf(body))
      // Found first where the mark goes, so no thread is made that cannot be anchored.
      if (!(await ctx.collab.hasQuote(docId, anchorText))) throw new RouteError(400, 'those words are not in the document')
      const { threadId } = (await ctx.convex('mutation', 'docs:createThread', { docId, body: commentBody(text), quote: anchorText, author: principal })) as { threadId: string }
      const marked = await ctx.collab.markThread(docId, principal, anchorText, threadId)
      if (!marked) ctx.log(`${docId}: thread ${threadId} was made but its words could not be marked`)
      return { threadId }
    }
  },
  ...internalSheetRoutes
]
