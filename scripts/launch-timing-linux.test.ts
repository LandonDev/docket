import { describe, expect, it } from 'vitest'
import { bootMarkOf, launchEnvironment } from './launch-timing-linux'

const SHELL = { PATH: '/usr/bin', LANG: 'C.UTF-8', HOME: '/srv/agents/home', TEMP_CODE_USER_DATA: '/srv/agents/docket-data', ANTHROPIC_API_KEY: 'k', ELECTRON_RUN_AS_NODE: '1' }

describe('launch timing on a scrubbed copy', () => {
  it("keeps nothing of the shell's but PATH and the locale, and points every way out at nothing", () => {
    const env = launchEnvironment(SHELL, { root: '/tmp/tc-launch-linux/d01', userData: '/srv/agents/tmp/perf2-db', port: 9242, copy: true })
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      LANG: 'C.UTF-8',
      HOME: '/tmp/tc-launch-linux/d01/home',
      TEMP_CODE_USER_DATA: '/srv/agents/tmp/perf2-db',
      TEMP_CODE_REMOTE_PORT: '0',
      TEMP_CODE_FAKE_PROVIDERS: 'http://127.0.0.1:9',
      TEMP_CODE_LIFEOS_URL: 'http://127.0.0.1:0',
      WINVM_DIR: '/tmp/tc-launch-linux/d01/no-vm',
      TEMP_CODE_ALIAX_DATA_DIR: '/tmp/tc-launch-linux/d01/aliax'
    })
  })

  it('without a copy keeps the shell as before', () => {
    const env = launchEnvironment(SHELL, { root: '/tmp/tc-launch-linux/run', userData: '/tmp/tc-launch-linux/run/userData', port: 9242, copy: false })
    expect(env.ANTHROPIC_API_KEY).toBe('k')
    expect(env.WINVM_DIR).toBe('/tmp/tc-launch-linux/run/userData/no-vm')
  })

  it('prints of a [boot] line its time and label alone', () => {
    expect(bootMarkOf('[boot] 812 server:listening port=7677 /srv/agents/tmp/perf2-db')).toBe('812 server:listening')
    expect(bootMarkOf('[boot] 2301 fold-backfill progress 200/412')).toBe('2301 fold-backfill progress 200/412')
    expect(bootMarkOf('[boot] 940 first-session-list 412 sessions')).toBe('940 first-session-list 412')
    expect(bootMarkOf("[boot] 1500 turn-index done Landon's notes")).toBe('1500 turn-index done')
    expect(bootMarkOf('[boot] data: moved temp-code.db to docket.db')).toBeNull()
    expect(bootMarkOf('[boot] index 1234ms')).toBeNull()
  })
})
