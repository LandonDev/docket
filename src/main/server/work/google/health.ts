import type { HealthRow, SectorKey } from '@shared/work'
import type { HealthSource, WorkCtx } from '../modules'
import { clientIdOf } from './picker'

/**
 * The google pillar's connections (docs/agents/work-google.md): LifeOS's
 * Google client id on this host, which the Picker needs, and each Google
 * account's Drive consent as LifeOS holds it (`calendarOps:accounts`). One
 * query. Google applies only where LifeOS answers and holds a Google
 * account: a host signed out of LifeOS shows LifeOS's row, not these.
 */

/** A LifeOS `calendarAccounts` row, as much as a row needs. */
interface GoogleAccountRow {
  account?: string
  sector?: SectorKey
  files?: boolean
}

/** The Picker opens in this machine's own browser: only a desktop can pick (the box has no browser to show it in). */
export const canPickHere = (platform: NodeJS.Platform = process.platform): boolean => platform === 'darwin' || platform === 'win32'

export async function googleRows(ctx: Pick<WorkCtx, 'db' | 'lifeos'>, o: { canPick?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<HealthRow[]> {
  if (!ctx.lifeos.connected()) return []
  const accounts = ((await ctx.lifeos.owner().query<GoogleAccountRow[]>('calendarOps:accounts', {})) ?? []).filter((r): r is GoogleAccountRow & { account: string } => typeof r.account === 'string')
  if (!accounts.length) return []
  const rows: HealthRow[] = []
  if (o.canPick ?? canPickHere()) {
    const row = { id: 'google.clientId', pillar: 'google', group: 'Google', title: 'Google Picker' } as const
    rows.push(
      clientIdOf(ctx.db, o.env)
        ? { ...row, state: 'working', line: "Knows LifeOS's Google client" }
        : // No screen sets it yet: work.google.setup, or the variable, on this computer.
          { ...row, state: 'needs-you', line: "Give this computer LifeOS's Google client id (TEMP_CODE_GOOGLE_CLIENT_ID) to pick files" }
    )
  }
  for (const a of accounts) {
    // Read from LifeOS, so every host answers the same: shared. With no sector it names an account of his: personal.
    const row = { id: `google.consent:${a.account.toLowerCase()}`, pillar: 'google', group: 'Google', title: a.account, shared: true, ...(a.sector ? { sector: a.sector } : { personal: true as const }) } as const
    rows.push(a.files ? { ...row, state: 'working', line: 'Drive files allowed' } : { ...row, state: 'needs-you', line: "Reconnect it in LifeOS and tick every box on Google's page" })
  }
  return rows
}

export const googleHealth: HealthSource = {
  check: (ctx) => googleRows(ctx)
}
