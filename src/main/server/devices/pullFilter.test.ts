import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configure, vault } from 'aliax-core'
import type { ServerPush } from '@shared/contract'
import type { Grant } from '@shared/devices/envelope'
import { AccountSync } from '../remote/accountSync'

// No Keychain in tests.
vi.mock('aliax-core/keychain', () => ({
  readPassword: async () => {
    throw new Error('no keychain in tests')
  },
  writePassword: async () => {}
}))

const HOUR = 3_600_000
/** A fake Claude grant with a refresh token, as the box holds one it refreshes. */
const blob = (account: string, exp = Date.now() + 2 * HOUR): string =>
  JSON.stringify({ keychain: JSON.stringify({ claudeAiOauth: { accessToken: `fake-${account}`, refreshToken: `fake-refresh-${account}`, expiresAt: exp } }), oauthAccount: { accountUuid: account } })

let dataDir = ''
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'tc-pull-filter-'))
  process.env.CODEX_HOME = join(dataDir, 'codex-home')
})
afterEach(() => {
  delete process.env.CODEX_HOME
  rmSync(dataDir, { recursive: true, force: true })
})

function box(gates: Record<string, readonly Grant[] | null>) {
  const rows = new Map<string, string>()
  const sync = new AccountSync({
    environmentId: 'env_box',
    store: { getSetting: (k) => rows.get(k) ?? null, setSetting: (k, v) => (v === null ? rows.delete(k) : rows.set(k, v)) },
    peers: { get: () => undefined as never, all: () => [] },
    nudge: () => {},
    log: () => {},
    liveAccountId: async () => null,
    admittedFor: (envId) => (envId in gates ? gates[envId] : undefined)
  })
  configure({
    dataDir,
    fetch: async (url) => {
      throw new Error(`unexpected fetch ${url}`)
    },
    secrets: { mode: 'fileKey', path: join(dataDir, 'vault.key') },
    environmentId: 'env_box',
    hooks: { onSecretSaved: sync.onSecretSaved, askOwner: sync.askOwner }
  })
  for (const account of ['u1', 'u2']) {
    vault.upsertProfile('claude-code', { name: account, accountId: account, createdAt: 1, owner: 'env_box' })
    vault.saveSecret('claude-code', account, blob(account))
  }
  return sync
}

const admitU1: Grant[] = [{ service: 'claude-code', account: 'u1', kind: 'access', owner: 'env_box' }]

describe('the box filters a given computer\'s pull by its newest verified manifest', () => {
  it('gives the admitted access copy and lists only that account; any other host gets the whole answer', async () => {
    const sync = box({ env_pc: admitU1 })
    try {
      const pc = await sync.handlePull('env_pc', {})
      expect(pc.transfers.map((t) => [t.profile.accountId, t.mode])).toEqual([['u1', 'access']])
      expect(pc.listed!.map((l) => l.accountId)).toEqual(['u1'])
      const mac = await sync.handlePull('env_mac', {})
      expect(mac.transfers.map((t) => t.profile.accountId).sort()).toEqual(['u1', 'u2'])
      expect(mac.listed!.map((l) => l.accountId).sort()).toEqual(['u1', 'u2'])
    } finally {
      sync.close()
    }
  })

  it('refuses what the manifest does not name, as another kind, or from another owner', async () => {
    const sync = box({
      env_static: [{ service: 'claude-code', account: 'u1', kind: 'static' }],
      env_owner: [{ service: 'claude-code', account: 'u1', kind: 'access', owner: 'env_mac' }],
      env_other: [{ service: 'claude-code', account: 'u9', kind: 'access', owner: 'env_box' }]
    })
    try {
      for (const env of ['env_static', 'env_owner', 'env_other']) expect((await sync.handlePull(env, {})).transfers).toEqual([])
      expect((await sync.handlePull('env_other', {})).listed).toEqual([])
    } finally {
      sync.close()
    }
  })

  it('a stopped, removing or manifest-less computer gets nothing at all', async () => {
    const sync = box({ env_pc: null })
    try {
      expect(await sync.handlePull('env_pc', {})).toEqual({ transfers: [], listed: [], tombstones: [] })
    } finally {
      sync.close()
    }
  })

  it('rotation and removal pushes to a given computer\'s socket follow the same filter', async () => {
    const sync = box({ env_pc: admitU1, env_off: null })
    const heard: Record<string, ServerPush[]> = { env_pc: [], env_off: [], env_mac: [] }
    for (const env of Object.keys(heard)) sync.subscribe((p) => heard[env].push(p), env)
    try {
      const broadcast = (sync as unknown as { broadcast(service: string, name: string): Promise<void> }).broadcast.bind(sync)
      await broadcast('claude-code', 'u1')
      await broadcast('claude-code', 'u2')
      const accounts = (env: string) => heard[env].flatMap((p) => (p.push === 'account' ? [p.transfer.profile.accountId] : []))
      expect(accounts('env_pc')).toEqual(['u1'])
      expect(accounts('env_off')).toEqual([])
      expect(accounts('env_mac')).toEqual(['u1', 'u2'])
      await sync.deleteProfile('claude-code', 'u2')
      await sync.deleteProfile('claude-code', 'u1')
      const removed = (env: string) => heard[env].flatMap((p) => (p.push === 'accounts-removed' ? p.removed.map((r) => r.accountId) : []))
      expect(removed('env_pc')).toEqual(['u1'])
      expect(removed('env_off')).toEqual([])
      expect(removed('env_mac')).toEqual(['u2', 'u1'])
      // and the tombstones a pull carries
      expect((await sync.handlePull('env_pc', {})).tombstones!.map((t) => t.accountId)).toEqual(['u1'])
    } finally {
      sync.close()
    }
  })
})
