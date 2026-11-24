import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { guardWatch, noteWatchFailure, resetWatchFailuresForTests, watchFailures, watchOrPoll } from './watchGuard'

const enospc = (): never => {
  throw Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), { code: 'ENOSPC' })
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  resetWatchFailuresForTests()
  vi.useRealTimers()
})

describe('guardWatch', () => {
  it('a refused watch is one log line and a row, never a throw', () => {
    const lines: string[] = []
    resetWatchFailuresForTests({ log: (line) => lines.push(line) })
    expect(guardWatch('the Codex sign-in', 'a check every 30 s covers it', enospc)).toBeNull()
    expect(lines).toEqual(['[watch] cannot watch the Codex sign-in (ENOSPC); a check every 30 s covers it'])
    expect(watchFailures()).toMatchObject([{ what: 'the Codex sign-in', error: 'ENOSPC', fallback: 'a check every 30 s covers it' }])
  })

  it('a watch that starts is handed back and counts nothing', () => {
    resetWatchFailuresForTests({ log: () => {} })
    expect(guardWatch('x', 'y', () => 42)).toBe(42)
    expect(watchFailures()).toEqual([])
  })

  it('keeps the last fifty', () => {
    resetWatchFailuresForTests({ log: () => {} })
    for (let i = 0; i < 60; i++) noteWatchFailure(`w${i}`, 'f', new Error('EMFILE'))
    expect(watchFailures()).toHaveLength(50)
    expect(watchFailures()[0].what).toBe('w10')
  })
})

describe('watchOrPoll', () => {
  it('falls back to a timed check of each file and tells when one changes', () => {
    resetWatchFailuresForTests({ log: () => {} })
    vi.useFakeTimers()
    const dir = mkdtempSync(join(tmpdir(), 'tc-watch-guard-'))
    dirs.push(dir)
    const file = join(dir, 'auth.json')
    writeFileSync(file, '{}')
    const changed = vi.fn()
    expect(watchOrPoll('the sign-ins', enospc, [{ path: file, changed }, { path: join(dir, 'missing.json'), changed: vi.fn() }], 1_000)).toBe('poll')
    vi.advanceTimersByTime(1_000)
    expect(changed).not.toHaveBeenCalled()
    utimesSync(file, new Date(), new Date(Date.now() + 5_000))
    vi.advanceTimersByTime(1_000)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(watchFailures()).toHaveLength(1)
  })

  it('a watch that starts sets up no check', () => {
    const watch = vi.fn()
    expect(watchOrPoll('the sign-ins', watch, [{ path: '/nowhere', changed: vi.fn() }])).toBe('watch')
    expect(watch).toHaveBeenCalledTimes(1)
  })
})
