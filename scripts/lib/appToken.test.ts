import { expect, it } from 'vitest'
import { MacThreadTokens } from '../../src/main/server/macTools'
import { appTokenFor, E2E_APP_TOKEN_SEED, withAppToken } from './appToken'

it("makes the token the app makes under the same seed, and adds it to app.* calls only", () => {
  const app = MacThreadTokens.fromEnv({ TEMP_CODE_USER_DATA: '/tmp/x', TEMP_CODE_APP_TOKEN_SEED: E2E_APP_TOKEN_SEED }, 'app-bridge', 'TEMP_CODE_APP_TOKEN_SEED')
  expect(appTokenFor('s1')).toBe(app.tokenFor('s1'))
  expect(app.check('s1', appTokenFor('s1'))).toBe(true)
  expect(withAppToken('app.listThreads', { sessionId: 's1' })).toEqual({ sessionId: 's1', appToken: app.tokenFor('s1') })
  expect(withAppToken('session.send', { sessionId: 's1' })).toEqual({ sessionId: 's1' })
  // without TEMP_CODE_USER_DATA the seed is not honoured
  expect(MacThreadTokens.fromEnv({ TEMP_CODE_APP_TOKEN_SEED: E2E_APP_TOKEN_SEED }, 'app-bridge', 'TEMP_CODE_APP_TOKEN_SEED').tokenFor('s1')).not.toBe(appTokenFor('s1'))
})
