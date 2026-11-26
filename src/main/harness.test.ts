import { describe, expect, it } from 'vitest'
import { applyHarness, harnessIdentity, pickHarness } from './harness'

describe('harness overrides', () => {
  it('keeps only the known keys, numbers as strings', () => {
    expect(
      pickHarness({
        TEMP_CODE_USER_DATA: '/tmp/x/userData',
        TEMP_CODE_DEBUG_PORT: 9230,
        TEMP_CODE_UPDATE_FEED: ' http://127.0.0.1:9231/ ',
        OTHER: 'no'
      })
    ).toEqual({
      TEMP_CODE_USER_DATA: '/tmp/x/userData',
      TEMP_CODE_DEBUG_PORT: '9230',
      TEMP_CODE_UPDATE_FEED: 'http://127.0.0.1:9231/'
    })
    expect(pickHarness(undefined)).toEqual({})
    expect(pickHarness('nope')).toEqual({})
  })

  it('fills the environment without overriding what is already set', () => {
    const env: NodeJS.ProcessEnv = { TEMP_CODE_USER_DATA: '/env/userData' }
    applyHarness(env, { TEMP_CODE_USER_DATA: '/baked/userData', TEMP_CODE_DEBUG_PORT: '9230' })
    expect(env).toEqual({ TEMP_CODE_USER_DATA: '/env/userData', TEMP_CODE_DEBUG_PORT: '9230' })
  })
})

describe('harness identity', () => {
  const self = { name: 'temp-code', defaultUserData: '/Users/x/Library/Application Support/temp-code', execPath: '/tmp/a/DocketE2E.app/Contents/MacOS/DocketE2E', version: '1.0.5', pid: 7 }
  const baked = { TEMP_CODE_USER_DATA: '/tmp/a/userData' }

  it('is written beside the baked userData of a packaged copy', () => {
    expect(harnessIdentity(true, baked, { TEMP_CODE_USER_DATA: '/tmp/a/userData' }, self)).toEqual({
      path: '/tmp/a/userData/harness-identity.json',
      record: self
    })
  })

  it('is never written by an installed app, a dev run or an instance pointed elsewhere', () => {
    expect(harnessIdentity(true, {}, {}, self)).toBeNull()
    expect(harnessIdentity(false, baked, { TEMP_CODE_USER_DATA: '/tmp/a/userData' }, self)).toBeNull()
    expect(harnessIdentity(true, baked, { TEMP_CODE_USER_DATA: '/tmp/a/userData2' }, self)).toBeNull()
  })
})
