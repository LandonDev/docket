import { errorText, type HealthRow } from '@shared/work'
import type { HealthSource, WorkCtx } from '../modules'
import { isIsolatedInstance } from '../service/config'
import { serviceOf } from '../service/ctx'
import type { ServiceState } from '../service/supervisor'
import { DEFAULT_ORIGIN } from './links'

/**
 * The Work service's connections (docs/agents/work-service.md,
 * work-guests.md): whether this host's service answers on its own port, and,
 * on the host that serves guest links (the box), whether the tunnel brings
 * a guest to it: one GET each to the hosted pages and to a guest page. A
 * public answer counts only when it carries the service's own headers, so a
 * tunnel that answers with something else reads as broken.
 */

/** How long one GET may take. */
export const PROBE_MS = 5_000

export interface GuestsHealthDeps {
  service?: { state(): ServiceState; port(): number | null } | null
  fetch?: typeof fetch
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** whether this host can fork the service at all (Electron) */
  canFork?: boolean
}

/** The origin a guest reaches this host on, or null when this host serves no guest links. */
export function guestOrigin(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  if (env.TEMP_CODE_WORK_PUBLIC_ORIGIN) return env.TEMP_CODE_WORK_PUBLIC_ORIGIN.replace(/\/$/, '')
  return platform === 'linux' && !isIsolatedInstance(env) ? DEFAULT_ORIGIN : null
}

/** Any HTTP answer from the service: true; else why not. */
async function get(fetcher: typeof fetch, url: string, signal: AbortSignal, ours: boolean): Promise<true | string> {
  try {
    const res = await fetcher(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(PROBE_MS)]) })
    void res.body?.cancel().catch(() => {})
    if (!ours) return true
    // Every answer of the service carries these (service/routes/route.ts BASE_HEADERS).
    if (res.status === 200 && res.headers.get('x-frame-options') === 'DENY') return true
    return `The tunnel answered ${res.status}, not the Work service`
  } catch (err) {
    return `No answer: ${errorText(err)}`
  }
}

export async function guestsRows(ctx: Pick<WorkCtx, 'enabled'>, signal: AbortSignal, d: GuestsHealthDeps = {}): Promise<HealthRow[]> {
  if (!ctx.enabled()) return []
  const service = d.service
  if (!service) return []
  const fetcher = d.fetch ?? fetch
  const row = { id: 'guests.service', pillar: 'guests', group: 'Work service', title: 'Work service' } as const
  const state = service.state()
  const port = service.port()
  if (state === 'off' && !(d.canFork ?? !!process.versions.electron)) return []
  if (state !== 'running' || port === null) {
    const line = state === 'starting' ? 'Still starting' : state === 'waiting' ? 'It stopped; it restarts by itself' : 'Not running'
    return [{ ...row, state: 'broken', line }]
  }
  const local = await get(fetcher, `http://127.0.0.1:${port}/w/hosted/`, signal, false)
  if (local !== true) return [{ ...row, state: 'broken', line: `Does not answer on port ${port}` }]
  const rows: HealthRow[] = [{ ...row, state: 'working', line: `Answers on port ${port}` }]
  const origin = guestOrigin(d.env, d.platform)
  if (!origin) return rows
  const where = new URL(origin).host
  const [hosted, guest] = await Promise.all([get(fetcher, `${origin}/w/hosted/`, signal, true), get(fetcher, `${origin}/g/health-check`, signal, true)])
  const pub = (id: string, title: string, r: true | string): HealthRow => ({ id, pillar: 'guests', group: 'Work service', title, state: r === true ? 'working' : 'broken', line: r === true ? `Reached at ${where}` : r })
  rows.push(pub('guests.hosted', 'Hosted pages', hosted), pub('guests.links', 'Guest links', guest))
  return rows
}

export const guestsHealth: HealthSource = {
  check: (ctx, signal) => guestsRows(ctx, signal, { service: serviceOf(ctx) ?? null })
}
