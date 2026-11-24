import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { HealthRow } from '@shared/work/health'

/**
 * Settings → Connections for live Office files (docs/agents/work-office-live.md "Signing in"): one row per tenant
 * session on this computer (`persist:office-live-<tenant>`, src/main/officeLive.ts). It is signed in while Entra's
 * persistent cookie is there and in date, and needs him once it lapses; Sign out clears that session alone. Only
 * the cookie's name and end are read, never its value. A host with no window (the box) has no such session.
 */

export const LIVE_SIGN_OUT = 'work.office.live.signOut'
export const TENANT = /^[a-z0-9][a-z0-9-]{0,62}$/

/** A cookie as Electron's store answers it: `expirationDate` in seconds. */
export interface LiveCookie {
  name: string
  expirationDate?: number
}

const ENTRA = /^(ESTSAUTHPERSISTENT|ESTSAUTH)$/

/** The row for one tenant's session. */
export function liveRow(tenant: string, cookies: readonly LiveCookie[], now: number): HealthRow {
  const ends = cookies.filter((c) => ENTRA.test(c.name)).map((c) => (c.expirationDate ? c.expirationDate * 1000 : Infinity))
  const until = ends.length ? Math.max(...ends) : 0
  const base = { id: `office.live:${tenant}`, pillar: 'office', group: 'Office', title: `Office for the web, ${tenant}`, personal: true } as const
  if (until > now)
    return {
      ...base,
      state: 'working',
      line: 'Signed in',
      ...(Number.isFinite(until) ? { until } : {}),
      fix: { kind: 'run', label: 'Sign out', method: LIVE_SIGN_OUT, params: { tenant } }
    }
  return { ...base, state: 'needs-you', line: 'Sign in again the next time you open a file live' }
}

/** The tenants with a live session on this computer, from `Partitions/office-live-*`. */
export function liveTenants(userData: string): string[] {
  try {
    return readdirSync(join(userData, 'Partitions'))
      .map((n) => /^office-live-(.+)$/.exec(n)?.[1] ?? '')
      .filter((t) => TENANT.test(t))
  } catch {
    return []
  }
}

type Electron = typeof import('electron')
const electron = (): Promise<Electron | null> => import('electron').then((e) => (e.app?.isReady?.() ? e : null)).catch(() => null)

/** This computer's rows: none where there is no window. */
export async function liveRows(now = Date.now()): Promise<HealthRow[]> {
  const e = await electron()
  if (!e?.session) return []
  return Promise.all(
    liveTenants(e.app.getPath('userData')).map(async (tenant) => {
      const cookies = await e.session.fromPartition(`persist:office-live-${tenant}`).cookies.get({ domain: 'login.microsoftonline.com' }).catch(() => [])
      return liveRow(tenant, cookies, now)
    })
  )
}

/** Signs this computer out of one tenant's Office for the web: its cookies, storage and cache go. */
export async function signOutLive(tenant: string): Promise<void> {
  if (!TENANT.test(tenant)) throw new Error('No such Office for the web session.')
  const e = await electron()
  if (!e?.session) throw new Error('This computer has no Office for the web session.')
  const ses = e.session.fromPartition(`persist:office-live-${tenant}`)
  await ses.clearStorageData()
  await ses.clearCache()
}
