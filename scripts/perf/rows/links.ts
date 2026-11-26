/**
 * Far links (L07 to L09): `desk` as the third machine, its own shaped hop to box (`pair.deskLink`, his tunnel's
 * shape with its own late chunks). With Work off the call that goes window → box → desk is the Mac bridge's own:
 * a box thread with the bridge pointed at desk asks `mac.listDir` of a folder desk shares with box
 * (src/main/server/macTools.ts; desk answers in remote/macBridge.ts). The thread's token is the HMAC the pair's seed
 * makes (TEMP_CODE_MAC_TOKEN_SEED, isolated instances alone). Box refuses it from a window (`mac.listDir is
 * local-only`, as of Nov 26), so the driver asks box over loopback and the sample says one shaped leg (`legs: 1`);
 * the window's own ask is tried first, so a box that takes it there is timed with both legs.
 * L10 (a code-only offer) and L11 (search with one slow host) are written `off` in budgets.ts with the reason.
 */
import { createHmac } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Instance } from '../../journeys/lib/shape'
import { percentile } from '../lib/frames'
import { PRESSES, type PerfCtx, type Row } from '../lib/row'
import type { Counts } from '../lib/probe'
import type { LinkSample } from './link'
import { boxHostOf } from './send'

export const FAR_FOLDER_ENTRIES = 300
const CALLS = 10
const none = (): Counts => ({ t: {}, tAll: 0, c: 0, up: 0, down: 0 })
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The thread token the box's Mac bridge checks (macTools.ts MacThreadTokens), from the pair's seed. */
export const bridgeToken = (seed: string, sessionId: string): string =>
  createHmac('sha256', Buffer.from(seed, 'hex')).update(`mac-bridge:${sessionId}`).digest('base64url')

interface Bridge {
  sessionId: string
  token: string
  /** a folder desk shares with box: one small file */
  small: string
  /** and one of FAR_FOLDER_ENTRIES files */
  big: string
}

const bridges = new WeakMap<object, Bridge>()

/** Once a run: the shared folder on desk, read+run for box, and a box thread with the bridge on desk. */
async function bridge(ctx: PerfCtx): Promise<Bridge> {
  const kept = bridges.get(ctx.pair)
  if (kept) return kept
  const desk = ctx.pair.desk
  if (!desk) throw new Error('The far rows need desk (`needs: { desk: true }`)')
  const shared = join(desk.home, 'Perf shared')
  const small = join(shared, 'small')
  const big = join(shared, 'Bench')
  mkdirSync(small, { recursive: true })
  if (!existsSync(join(small, 'note.txt'))) writeFileSync(join(small, 'note.txt'), 'A dummy line.\n')
  mkdirSync(big, { recursive: true })
  for (let i = 1; i <= FAR_FOLDER_ENTRIES; i++) {
    const file = join(big, `practice-${String(i).padStart(3, '0')}.txt`)
    if (!existsSync(file)) writeFileSync(file, 'A dummy line.\n')
  }
  await ctx.pair.rpc(desk, 'macBridge.policy.set', { environmentId: ctx.pair.box.host, policy: 'read+run' })
  await ctx.pair.rpc(desk, 'macBridge.shared.set', { environmentId: ctx.pair.box.host, folders: [shared] })
  const workspaceId = ctx.seeded?.workspaceId ?? ctx.workspace.id
  const { id } = await ctx.pair.rpc<{ id: string }>(ctx.pair.box, 'session.create', { workspaceId, title: 'Perf bridge', provider: 'claude', permission: 'auto', threadType: 'chat' })
  await ctx.pair.rpc(ctx.pair.box, 'macBridge.thread.set', { sessionId: id, macPeer: desk.host })
  const made = { sessionId: id, token: bridgeToken(ctx.pair.seed, id), small, big }
  bridges.set(ctx.pair, made)
  return made
}

type Listing = { entries: unknown[] }

/** One `mac.listDir` of `path` through box, from the window when the box takes it there: its time, entries and legs. */
async function listFar(ctx: PerfCtx, b: Bridge, path: string): Promise<{ ms: number; entries: number; legs: 1 | 2; error?: string }> {
  const params = { sessionId: b.sessionId, token: b.token, path }
  const fromWindow = await ctx.page.eval<{ ms: number; entries: number } | { error: string }>(`(async () => {
    const t = performance.now();
    try {
      const r = await window.__docket.registry.linkOf(${boxHostOf(ctx)}).request('mac.listDir', ${JSON.stringify(params)});
      return { ms: performance.now() - t, entries: (r?.entries ?? []).length };
    } catch (error) { return { error: String(error?.message ?? error) }; }
  })()`)
  if (!('error' in fromWindow)) return { ...fromWindow, legs: 2 }
  const started = performance.now()
  try {
    const r = await ctx.pair.rpc<Listing>(ctx.pair.box, 'mac.listDir', params, 30_000)
    return { ms: performance.now() - started, entries: r.entries.length, legs: 1, error: `the window may not ask it: ${fromWindow.error}` }
  } catch (error) {
    return { ms: performance.now() - started, entries: 0, legs: 1, error: String((error as Error)?.message ?? error) }
  }
}

/** Ten calls a press; a press's `usable` is their p95, `first` their p50. */
async function calls(ctx: PerfCtx, path: (b: Bridge) => string, n = CALLS): Promise<LinkSample[]> {
  const b = await bridge(ctx)
  const samples: LinkSample[] = []
  for (let i = 0; i < PRESSES; i++) {
    ctx.counter.take()
    ctx.pair.deskLink?.reset()
    const runs: Awaited<ReturnType<typeof listFar>>[] = []
    for (let k = 0; k < n; k++) runs.push(await listFar(ctx, b, path(b)))
    const ms = runs.map((r) => r.ms)
    const desk = ctx.pair.deskLink?.reset()
    const error = runs.find((r) => r.error)?.error
    samples.push({
      first: Math.round(percentile(ms, 50) ?? 0), usable: Math.round(percentile(ms, 95) ?? 0), longest: 0, counts: ctx.counter.take(), after: none(),
      link: { calls: n, p50: Math.round(percentile(ms, 50) ?? 0), p95: Math.round(percentile(ms, 95) ?? 0), max: Math.round(Math.max(...ms)), legs: runs[0]!.legs, entries: runs[0]!.entries, deskWireDown: desk?.down ?? null, deskTurns: desk?.turns ?? null },
      ...(error ? { error } : {})
    })
  }
  return samples
}

/** L07: a small call through box to desk: a folder of one file listed, ten times a press. */
const peerCall: Row = {
  id: 'peer-call',
  family: 'code',
  needs: { desk: true },
  title: "A small call through the box to a third machine: the Mac bridge's listing of a one-file folder on desk",
  run: (ctx) => calls(ctx, (b) => b.small)
}

/** L09's folder half: desk's folder of 300 entries listed through box (the bridge's listing, not Work's Files). */
const farFolder: Row = {
  id: 'far-folder',
  family: 'code',
  needs: { desk: true },
  title: "A folder of 300 entries on the third machine listed through the box (the Mac bridge's mac.listDir)",
  run: (ctx) => calls(ctx, (b) => b.big, 3)
}

const registered = async (ctx: PerfCtx, desk: Instance): Promise<boolean> => {
  const rows = await ctx.pair.rpc<{ environmentId: string; registered: boolean }[]>(desk, 'macBridge.policy.get')
  return rows.some((row) => row.environmentId === ctx.pair.box.host && row.registered)
}

/**
 * L08: desk's link to box cut 3 s, then given back: `usable` is the link back to desk registered with box again
 * (desk's own `macBridge.policy.get`, as the pair's link waits for it, asked every 50 ms), `link.firstCall` the
 * first small call through box after it.
 */
const peerRelink: Row = {
  id: 'peer-relink',
  family: 'code',
  needs: { desk: true },
  title: 'The third machine’s link to the box cut 3 s and back: to registered again, then the first small call',
  run: async (ctx) => {
    const desk = ctx.pair.desk
    const link = ctx.pair.deskLink
    if (!desk || !link) throw new Error('The relink row needs desk behind its shaped hop (--link)')
    const b = await bridge(ctx)
    const samples: LinkSample[] = []
    try {
      for (let i = 0; i < PRESSES; i++) {
        link.cut(true)
        await ctx.page.until('desk to lose box', 60_000, async () => !await registered(ctx, desk))
        await sleep(3000)
        link.reset()
        const started = performance.now()
        link.cut(false)
        let back: number | null = null
        const end = Date.now() + 60_000
        while (Date.now() < end) {
          if (await registered(ctx, desk)) {
            back = performance.now() - started
            break
          }
          await sleep(50)
        }
        const call = back === null ? null : await listFar(ctx, b, b.small)
        const wire = link.reset()
        samples.push({
          first: null, usable: back === null ? null : Math.round(back), longest: 0, counts: none(), after: none(),
          link: { registered: back === null ? null : Math.round(back), firstCall: call ? Math.round(call.ms) : null, legs: call?.legs ?? null, deskWireDown: wire.down, deskTurns: wire.turns },
          ...(back === null ? { error: 'desk never registered again within 60 s' } : call?.error ? { error: call.error } : {})
        })
        if (back === null) break
      }
    } finally {
      link.cut(false)
    }
    return samples
  }
}

export const FAR_ROWS: Row[] = [peerCall, farFolder, peerRelink]
