import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetWatchFailuresForTests, watchFailures } from '../server/watchGuard'
import { watchSignIns } from './signInWatch'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  resetWatchFailuresForTests()
  vi.useRealTimers()
})

describe('watchSignIns', () => {
  it('a refused watch at boot is no throw: the auth files are checked on a timer and the vault follows a change', async () => {
    resetWatchFailuresForTests({ log: () => {} })
    vi.useFakeTimers()
    const dir = mkdtempSync(join(tmpdir(), 'tc-sign-ins-'))
    dirs.push(dir)
    const codex = join(dir, 'codex-auth.json')
    writeFileSync(codex, '{}')
    const recapture = vi.fn(async () => {})
    const watch = () => {
      throw Object.assign(new Error("ENOSPC: System limit for number of file watchers reached, watch '/home/.codex'"), { code: 'ENOSPC' })
    }
    expect(watchSignIns({ watch, recapture, everyMs: 1_000, files: [{ serviceId: 'codex', path: codex }, { serviceId: 'muse-code', path: join(dir, 'none.json') }] })).toBe('poll')
    expect(watchFailures()).toMatchObject([{ what: 'the Codex and Muse sign-ins', error: 'ENOSPC' }])
    utimesSync(codex, new Date(), new Date(Date.now() + 5_000))
    vi.advanceTimersByTime(1_000)
    expect(recapture).toHaveBeenCalledWith('codex')
  })

  it('a watch that starts is all there is', () => {
    const watch = vi.fn()
    expect(watchSignIns({ watch, recapture: vi.fn(), files: [] })).toBe('watch')
  })
})
