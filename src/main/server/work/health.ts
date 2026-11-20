import { z } from 'zod'
import { errorText, fixAllowed, HEALTH_ORDER, lapseLine, rowsForSector, workText, type HealthReport, type HealthRow, type Lapse, type PillarId, type SectorKey } from '@shared/work'
import type { WorkCtx, WorkModule, WorkTool } from './modules'

/**
 * Connections, the frame's side (docs/agents/work-connections.md): this
 * host's rows gathered from every pillar's `health`, the things that
 * lapse, and the `work_connections` tool a thread reads them with. A
 * pillar answers only for itself; nothing here checks anything on its own.
 */

/** How long one pillar's check may take before its row says it did not answer. */
export const HEALTH_CHECK_MS = 10_000
const LINE_MAX = 200

/** Whatever looks like a secret in a line, blanked: a JWT, a bearer token, a LifeOS token or key, a token or code in a query. Every row and fault goes through it, whichever pillar wrote it. */
export const redactLine = (text: string): string =>
  text
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[jwt]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [secret]')
    .replace(/\blo[bp]?_[A-Za-z0-9_-]{8,}/g, '[secret]')
    .replace(/\b(access_token|refresh_token|id_token|token|code|key|secret|password|sig)=[^&\s]+/gi, '$1=[secret]')

const oneLine = (text: string | undefined, max = LINE_MAX): string | undefined => {
  if (text === undefined) return undefined
  const flat = redactLine(text.replace(/\s+/g, ' ').trim())
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** A fix as the wire carries it: only one `fixAllowed` admits, its label one short line. */
function cleanFix(fix: HealthRow['fix']): HealthRow['fix'] | undefined {
  if (!fix || !fixAllowed(fix)) return undefined
  const label = oneLine(fix.label, 30)!
  if (fix.kind === 'run') return { kind: 'run', label, method: fix.method }
  if (fix.kind === 'open') return { kind: 'open', label, url: fix.url.slice(0, 500) }
  return { kind: 'page', label, page: fix.page }
}

/** A pillar's rows as the wire carries them: one line each, redacted, its own pillar named, nothing it did not declare, a fix only from the allowed list. */
export function cleanRow(row: HealthRow, pillar: PillarId): HealthRow {
  const fix = cleanFix(row.fix)
  return {
    id: oneLine(row.id, 120)!,
    pillar,
    group: oneLine(row.group, 60)!,
    title: oneLine(row.title, 120)!,
    state: row.state === 'working' || row.state === 'needs-you' ? row.state : 'broken',
    ...(row.line ? { line: oneLine(row.line) } : {}),
    ...(fix ? { fix } : {}),
    ...(typeof row.until === 'number' && Number.isFinite(row.until) ? { until: row.until } : {}),
    ...(row.sector ? { sector: row.sector } : {}),
    ...(row.shared ? { shared: true as const } : {}),
    ...(row.personal ? { personal: true as const } : {})
  }
}

/** The group a pillar's fault sits under: what the pillar is to him. */
const FAULT_GROUP: Partial<Record<PillarId, string>> = { lifeos: 'LifeOS', google: 'Google', office: 'Office', browser: 'Browser', formats: 'Tools', frameio: 'Frame.io', guests: 'Work service' }

function faultRow(pillar: PillarId, line: string): HealthRow {
  return { id: `${pillar}.check`, pillar, group: FAULT_GROUP[pillar] ?? 'Work', title: `The ${pillar} check`, state: 'broken', line: oneLine(line) }
}

/**
 * This host's rows: every pillar's check at once, each held to
 * `HEALTH_CHECK_MS`, then a broken row for each pillar that did not load.
 * A check that throws or runs out of time is one broken row, never a
 * failed answer: the rest still show.
 */
export async function checkHost(ctx: WorkCtx, modules: readonly WorkModule[], faults: ReadonlyMap<PillarId, string>, signal: AbortSignal, now = Date.now): Promise<HealthReport> {
  const answers = await Promise.all(
    modules
      .filter((m) => m.health)
      .map(async (module): Promise<HealthRow[]> => {
        const stop = new AbortController()
        const timer = setTimeout(() => stop.abort(), HEALTH_CHECK_MS)
        const both = AbortSignal.any([signal, stop.signal])
        try {
          if (both.aborted) throw new Error('cancelled')
          const late = new Promise<never>((_, reject) => both.addEventListener('abort', () => reject(new Error(signal.aborted ? 'cancelled' : `no answer in ${HEALTH_CHECK_MS / 1000} s`)), { once: true }))
          const rows = await Promise.race([module.health!.check(ctx, both), late])
          return rows.map((row) => cleanRow(row, module.id))
        } catch (err) {
          return [faultRow(module.id, `Did not answer: ${errorText(err)}`)]
        } finally {
          clearTimeout(timer)
          // Settled: the joined signal lets go of its listeners now, not when the caller's socket closes.
          stop.abort()
        }
      })
  )
  const rows = answers.flat()
  for (const [pillar, why] of faults) rows.push(faultRow(pillar, why))
  return { host: ctx.host, at: now(), rows }
}

/** What lapses on this host, soonest first: each pillar's own answer, from what it holds. One that throws is left out and logged. */
export function lapsesOf(ctx: WorkCtx, modules: readonly WorkModule[]): Lapse[] {
  const out: Lapse[] = []
  for (const module of modules) {
    try {
      for (const lapse of module.health?.lapses?.(ctx) ?? []) {
        if (Number.isFinite(lapse.until)) out.push({ id: lapse.id, pillar: module.id, title: oneLine(lapse.title, 120)!, until: lapse.until })
      }
    } catch (err) {
      ctx.log(`${module.id} lapses: ${errorText(err)}`)
    }
  }
  return out.sort((a, b) => a.until - b.until)
}

/** One host as the tool reads it: its rows, or why it gave none. */
export type HostHealth = { name: string; report: HealthReport } | { name: string; offline: true } | { name: string; error: string }

const STATE_WORD: Record<HealthRow['state'], string> = { working: 'working', broken: 'BROKEN', 'needs-you': 'NEEDS HIM' }

/** The rows as a thread reads them: per host, worst first, a thread of one sector seeing no other sector's rows. */
export function healthText(hosts: readonly HostHealth[], sector: SectorKey | null | 'all', now = Date.now()): string {
  const out: string[] = []
  for (const host of hosts) {
    if ('offline' in host) {
      out.push(`${host.name}: offline (not checked; offline is not broken)`)
      continue
    }
    if ('error' in host) {
      out.push(`${host.name}: did not answer: ${oneLine(host.error)}`)
      continue
    }
    const rows = rowsForSector(host.report.rows, sector).sort((a, b) => HEALTH_ORDER[a.state] - HEALTH_ORDER[b.state])
    out.push(`${host.name}${rows.length ? '' : ': no connections to check'}`)
    for (const row of rows) {
      const parts = [row.line, row.until ? lapseLine(row.until, now) : undefined, row.fix && row.fix.kind !== 'page' ? `fix: ${row.fix.label}` : row.fix ? `fix: ${row.fix.label} (in the app)` : undefined].filter(Boolean)
      out.push(`- ${row.group} / ${row.title}: ${STATE_WORD[row.state]}${parts.length ? `. ${parts.join('. ')}` : ''}`)
    }
  }
  return out.join('\n')
}

/**
 * `work_connections`: the rows Connections shows, for this host and every
 * host it is linked to, so a thread can tell him why something failed
 * rather than guess. Read-only: reading runs the same cheap checks as
 * opening the page, and fixes nothing; every fix is his press.
 */
export function connectionsTool(read: (signal: AbortSignal) => Promise<HostHealth[]>): WorkTool {
  return {
    name: 'work_connections',
    description:
      "Which of Work's sign-ins and helpers work on each of his hosts (LifeOS, mail and calendar sources, Google, Office, the add-in, files sync, the browser, the Work service, tools, the Windows VM, Frame.io): working, broken or needs him, with the one-line reason and the fix he can press in Settings → Connections. Read it before guessing why a Work tool failed. Changes nothing.",
    input: z.object({}),
    readOnly: true,
    run: async (_args, ctx) => workText(healthText(await read(ctx.signal), ctx.scope.workspaceId ? ctx.scope.sector : 'all'))
  }
}
