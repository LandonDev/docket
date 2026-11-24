import type { DatabaseSync } from 'node:sqlite'
import type { HealthRow } from '@shared/work/health'
import { BOX_SIGN_IN } from '../browser/health'

/**
 * The Microsoft Forms row in Settings → Connections (docs/agents/work-connections.md): one on a host whose box browser
 * carries Forms (`msCarrier()`), none elsewhere. Signed in as whom the most recent read of a form saw; Needs you when a
 * read met Microsoft's sign-in (answers/read.ts `signInNeeded`), with the box browser's own fix.
 */
export interface FormsProbe {
  /** a carrier is wired on this host (the box browser) */
  carrier: boolean
  /** the last read met Microsoft's sign-in */
  signIn: boolean
}

export function formsRows(db: DatabaseSync, p: FormsProbe): HealthRow[] {
  if (!p.carrier) return []
  const base = { id: 'msforms.signIn', pillar: 'msforms', group: 'Browser', title: 'Microsoft Forms' } as const
  if (p.signIn) return [{ ...base, state: 'needs-you', line: BOX_SIGN_IN }]
  let who: string | null = null
  try {
    const row = db.prepare('SELECT signed_in_as FROM work_msforms WHERE signed_in_as IS NOT NULL ORDER BY read_at DESC LIMIT 1').get() as { signed_in_as: string } | undefined
    who = row?.signed_in_as ?? null
  } catch {
    // (no forms table yet: no form was read)
  }
  return [who ? { ...base, state: 'working', line: `Signed in as ${who}`, personal: true } : { ...base, state: 'working', line: 'No form read yet' }]
}
