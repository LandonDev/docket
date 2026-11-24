import { createHash } from 'node:crypto'

/**
 * What setup gave this computer and Remove may take back (F16): TempCode's own Work sign-in, by the
 * digest of the token it saved, and LifeOS's Outlook and Teams reader, when setup's sign-in turned it
 * on. A session or a reader that was here before, or came later by hand, is not named, and Remove
 * leaves it.
 */
export const SETUP_GAVE = 'devices.setup.gave'

export interface Gave {
  /** sha256 hex of the Work device token setup saved. */
  work?: string
  /** LifeOS's reader, turned on by setup's own LifeOS sign-in. */
  reader?: boolean
}

type Settings = { getSetting(key: string): string | null; setSetting(key: string, value: string | null): void }

export const tokenDigest = (token: string): string => createHash('sha256').update(token).digest('hex')

export function gaveOf(store: Settings): Gave {
  try {
    const raw = store.getSetting(SETUP_GAVE)
    return raw ? (JSON.parse(raw) as Gave) : {}
  } catch {
    return {}
  }
}

export function noteGave(store: Settings, patch: Gave): void {
  store.setSetting(SETUP_GAVE, JSON.stringify({ ...gaveOf(store), ...patch }))
}

/**
 * Remove's Work step: sign out through the running session only when the token held now is the one
 * setup saved. Answers whether it signed out.
 */
export async function clearGivenWork(deps: { store: Settings; current: () => string | null; signOut: () => Promise<void> }): Promise<boolean> {
  const gave = gaveOf(deps.store).work
  const token = deps.current()
  if (!gave || !token || tokenDigest(token) !== gave) return false
  await deps.signOut()
  return true
}
