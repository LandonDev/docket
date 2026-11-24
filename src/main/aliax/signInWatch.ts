import { homedir } from 'node:os'
import { join } from 'node:path'
import { accounts, adapter, museAuthPath, type ServiceId } from 'aliax-core'
import { watchOrPoll } from '../server/watchGuard'

export interface SignInWatchDeps {
  /** aliax-core's own watch of the CLIs' auth files (accounts.watchLiveCredentials). */
  watch: () => void
  /** The vault follows the live file (accounts.recaptureLive). */
  recapture: (serviceId: ServiceId) => Promise<void>
  files: readonly { serviceId: ServiceId; path: string }[]
  everyMs?: number
}

/**
 * Codex rotates its refresh token in place; the vault copy follows every
 * rotation or a later switch would present a revoked one (invariant 18).
 * A refused watch (ENOSPC with the box's watches spent, 2026-11-23: it ended
 * a deploy's trial at boot) never stops the boot: a timed check of the two
 * auth files takes its place (watchGuard.ts).
 */
export function watchSignIns(deps: SignInWatchDeps = hostSignIns()): 'watch' | 'poll' {
  return watchOrPoll(
    'the Codex and Muse sign-ins',
    deps.watch,
    deps.files.map((f) => ({ path: f.path, changed: () => void deps.recapture(f.serviceId).catch(() => {}) })),
    deps.everyMs
  )
}

function hostSignIns(): SignInWatchDeps {
  return {
    watch: () => accounts.watchLiveCredentials(),
    recapture: (serviceId) => accounts.recaptureLive(adapter(serviceId)),
    files: [
      { serviceId: 'codex', path: join(homedir(), '.codex', 'auth.json') },
      { serviceId: 'muse-code', path: museAuthPath() }
    ]
  }
}
