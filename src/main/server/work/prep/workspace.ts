import type { SectorKey } from '@shared/work'
import type { WorkCtx } from '../modules'

export const sectorWord = (sector: SectorKey): string => sector.charAt(0).toUpperCase() + sector.slice(1)

/** A Work workspace and its sector, from the frame's own row. */
export function workspaceSector(ctx: Pick<WorkCtx, 'db'>, workspaceId: string): SectorKey {
  const row = ctx.db.prepare('SELECT kind, sector FROM workspaces WHERE id = ?').get(workspaceId) as { kind: string | null; sector: string | null } | undefined
  if (!row || row.kind !== 'work' || !row.sector) throw new Error('A meeting’s page is for a Work workspace linked to a LifeOS sector.')
  return row.sector as SectorKey
}

/** This host's Work workspaces that are linked to a sector: one per sector (the first made wins if there are ever two). */
export function linkedWorkspaces(ctx: Pick<WorkCtx, 'db'>): Map<SectorKey, string> {
  const rows = ctx.db.prepare("SELECT id, sector FROM workspaces WHERE kind = 'work' AND sector IS NOT NULL ORDER BY created_at, id").all() as { id: string; sector: string }[]
  const bySector = new Map<SectorKey, string>()
  for (const row of rows) if (!bySector.has(row.sector)) bySector.set(row.sector, row.id)
  return bySector
}
