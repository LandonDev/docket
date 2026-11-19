import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('../binaries', () => ({ harnessEnv: async () => ({ ...process.env }) }))

const { museEnv, personGhConfigDir } = await import('./museHost')

/** The environment `muse serve` gets (plan-JBpcLz-eGMhp.md §4): the file backend for an account's dir only, and gh kept on the person's config. */

afterEach(() => vi.unstubAllEnvs())

it('an account\'s dir reads its login from the file there; the own dir and the CLI\'s own config do not', async () => {
  vi.stubEnv('TBH_CREDENTIAL_BACKEND', undefined as unknown as string)
  const account = await museEnv({ sessionId: 's1', configDir: '/data/muse-accounts/accounts/me/global', credentialFile: true })
  expect(account.XDG_CONFIG_HOME).toBe('/data/muse-accounts/accounts/me/global')
  expect(account.TBH_CREDENTIAL_BACKEND).toBe('file')
  const own = await museEnv({ sessionId: 's1', configDir: '/data/muse-accounts/own/global' })
  expect(own.TBH_CREDENTIAL_BACKEND).toBeUndefined()
  const cli = await museEnv({ sessionId: 's1', configDir: null })
  expect(cli.TBH_CREDENTIAL_BACKEND).toBeUndefined()
  expect(cli.GH_CONFIG_DIR).toBe(process.env.GH_CONFIG_DIR)
})

it('sets GH_CONFIG_DIR to the person\'s gh dir when unset, read before XDG_CONFIG_HOME moves, and keeps one already set', async () => {
  vi.stubEnv('GH_CONFIG_DIR', undefined as unknown as string)
  vi.stubEnv('XDG_CONFIG_HOME', '/home/me/.cfg')
  const env = await museEnv({ sessionId: 's1', configDir: '/data/muse-accounts/own/global' })
  expect(env.GH_CONFIG_DIR).toBe('/home/me/.cfg/gh')
  expect(env.XDG_CONFIG_HOME).toBe('/data/muse-accounts/own/global')
  vi.stubEnv('XDG_CONFIG_HOME', undefined as unknown as string)
  expect(personGhConfigDir({})).toBe(join(homedir(), '.config', 'gh'))
  vi.stubEnv('GH_CONFIG_DIR', '/elsewhere/gh')
  const kept = await museEnv({ sessionId: 's1', configDir: '/data/muse-accounts/own/global' })
  expect(kept.GH_CONFIG_DIR).toBe('/elsewhere/gh')
})

it('a Work thread gets its data dir as XDG_DATA_HOME and none of this process\'s MUSE_* or TBH_*; a code thread keeps them', async () => {
  vi.stubEnv('MUSE_ENABLE_SESSION_MCP', '1')
  vi.stubEnv('TBH_MANAGED_HOOKS_PATH', '/planted/hooks')
  vi.stubEnv('XDG_DATA_HOME', '/home/me/.local/share')
  const work = await museEnv({ sessionId: 's1', configDir: '/data/muse-work/config/accounts/me/global', credentialFile: true, dataDir: '/data/muse-work/data' })
  expect(work.XDG_DATA_HOME).toBe('/data/muse-work/data')
  expect(work.XDG_CONFIG_HOME).toBe('/data/muse-work/config/accounts/me/global')
  expect(Object.keys(work).filter((k) => /^(MUSE_|TBH_)/.test(k)).sort()).toEqual(['MUSE_CONTRIBUTOR_MODE', 'TBH_CREDENTIAL_BACKEND'])
  const code = await museEnv({ sessionId: 's1', configDir: '/data/muse-accounts/own/global' })
  expect(code.MUSE_ENABLE_SESSION_MCP).toBe('1')
  expect(code.TBH_MANAGED_HOOKS_PATH).toBe('/planted/hooks')
  expect(code.XDG_DATA_HOME).toBe('/home/me/.local/share')
})
