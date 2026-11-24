import { describe, expect, it } from 'vitest'
import type { StoredProfile } from 'aliax-core/vault'
import { openLetter, type Letter } from '@shared/devices/envelope'
import { generateDeviceKeys } from '@shared/devices/keys'
import { GiverDevices, boxHolds, givenBlob, grantsFor, type ManifestSource } from './giverDevices'

const staticClaude = JSON.stringify({ keychain: JSON.stringify({ claudeAiOauth: { accessToken: 'fake-static', expiresAt: 9e12 } }), tokenKind: 'static' })
const refreshingClaude = JSON.stringify({ keychain: JSON.stringify({ claudeAiOauth: { accessToken: 'fake', refreshToken: 'fake-r', expiresAt: 9e12 } }) })

function source(rows: Partial<Record<string, Array<StoredProfile & { blob?: string }>>>): ManifestSource {
  return {
    profiles: (s) => (rows[s] ?? []) as StoredProfile[],
    readSecret: (s, n) => (rows[s] ?? []).find((p) => p.name === n)?.blob ?? null
  }
}

const vaultRows = source({
  'claude-code': [
    { name: 'one', accountId: 'u1', createdAt: 1, static: true, blob: staticClaude },
    { name: 'mine', accountId: 'u2', createdAt: 1, blob: refreshingClaude },
    { name: 'odd', accountId: 'u3', createdAt: 1, static: true, blob: refreshingClaude }
  ],
  codex: [
    { name: 'cx', accountId: 'c1', createdAt: 1, owner: 'env_box', blob: '{}' },
    { name: 'cx-mac', accountId: 'c2', createdAt: 1, blob: '{}' }
  ],
  meta: [{ name: 'key', accountId: '1607', createdAt: 1, blob: '{"key":"fake"}' }],
  cursor: [{ name: 'cur', accountId: 'x', createdAt: 1, static: true, blob: '{}' }]
})

describe('grantsFor', () => {
  it('gives static grants with their secret and box-owned Codex as an admission; withholds what this Mac refreshes', () => {
    const g = grantsFor(vaultRows, 'env_box')
    expect(g.accounts.map((a) => [a.service, a.account, a.kind, a.owner ?? null, !!a.secret])).toEqual([
      ['claude-code', 'u1', 'static', null, true],
      ['codex', 'c1', 'access', 'env_box', false],
      ['meta', '1607', 'static', null, true]
    ])
    expect(g.withheld).toEqual([
      { service: 'claude-code', account: 'u2' },
      { service: 'claude-code', account: 'u3' },
      { service: 'codex', account: 'c2' }
    ])
    expect(Object.keys(g.meta)).toEqual(['claude-code:u1', 'codex:c1', 'meta:1607'])
  })
})

describe('a given static blob', () => {
  it("carries the Claude token and whose it is, never the owner's desktop session cookies (F05)", () => {
    const withSession = JSON.stringify({ keychain: JSON.stringify({ claudeAiOauth: { accessToken: 'fake-static', expiresAt: 9e12 } }), oauthAccount: { accountUuid: 'u1' }, appSession: [{ name: 'sessionKey', value: 'fake-cookie' }], tokenKind: 'static', extra: 'x' })
    const rows = source({ 'claude-code': [{ name: 'one', accountId: 'u1', createdAt: 1, static: true, blob: withSession }] })
    const [given] = grantsFor(rows, 'env_box').accounts
    expect(given.secret).not.toContain('fake-cookie')
    expect(JSON.parse(given.secret!)).toEqual({ keychain: JSON.parse(withSession).keychain, oauthAccount: { accountUuid: 'u1' }, tokenKind: 'static' })
    expect(givenBlob('meta', '{"key":"fake"}')).toBe('{"key":"fake"}')
  })
})

describe('boxHolds', () => {
  it('lists the static grants and the ones the box refreshes, from the rows alone', () => {
    let reads = 0
    const rows = { profiles: vaultRows.profiles, readSecret: () => (reads++, null) }
    expect(boxHolds(rows, 'env_box')).toEqual([
      { service: 'claude-code', account: 'u1' },
      { service: 'claude-code', account: 'u3' },
      { service: 'codex', account: 'c1' },
      { service: 'meta', account: '1607' }
    ])
    expect(reads).toBe(0)
  })
})

function rig(opts: { failPosts?: { n: number }; bindings?: () => unknown[] } = {}) {
  const settings = new Map<string, string>()
  const giver = generateDeviceKeys()
  const pc = generateDeviceKeys()
  const posted: Letter[] = []
  const calls: string[] = []
  let removals = 0
  const box = {
    envId: 'env_box',
    request: async <T,>(method: string, params?: unknown): Promise<T> => {
      calls.push(method)
      if (method === 'devices.post' && opts.failPosts && opts.failPosts.n > 0) {
        opts.failPosts.n--
        throw new Error('the box link dropped')
      }
      if (method === 'devices.list') return { bindings: opts.bindings?.() ?? [] } as T
      if (method === 'devices.post') posted.push((params as { letter: Letter }).letter)
      if (method === 'devices.remove') return { removalId: `rm${++removals}` } as T
      return { ok: true } as T
    }
  }
  const devices = new GiverDevices({
    store: { getSetting: (k) => settings.get(k) ?? null, setSetting: (k, v) => (v === null ? settings.delete(k) : settings.set(k, v)) },
    keys: () => giver,
    source: vaultRows,
    box: () => box,
    now: () => 1_000,
    log: () => {}
  })
  devices.add({ envId: 'env_pc', name: 'Purdue laptop', identity: { signPublic: pc.signPublic, sealPublic: pc.sealPublic }, generation: 1, accounts: true })
  const open = (letter: Letter, lastSeq: number) =>
    openLetter(letter, { envId: 'env_pc', sealPublic: pc.sealPublic, sealPrivate: pc.sealPrivate, generation: 1, giver: giver.signPublic, lastSeq })
  return { devices, posted, calls, open }
}

describe('GiverDevices', () => {
  it('sends activate then a manifest the computer opens, its seq one more each time, the lease 30 days', async () => {
    const r = rig()
    await r.devices.activate('env_pc', { box: { envId: 'env_box', origin: 'https://box' } })
    await r.devices.manifest('env_pc')
    expect(r.posted.map((l) => [l.header.kind, l.header.seq])).toEqual([['activate', 1], ['manifest', 2]])
    const opened = r.open(r.posted[1], 1)
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    expect(opened.header.leaseUntil).toBe(1_000 + 30 * 86_400_000)
    expect(opened.body.accounts.map((a) => a.account)).toEqual(['u1', 'c1', '1607'])
    // a replay of the older one is refused by the computer
    expect(r.open(r.posted[1], 2)).toEqual({ ok: false, reason: 'stale-seq' })
  })

  it('Stop sends a stop letter and no manifest goes while stopped; Start sends a fresh one', async () => {
    const r = rig()
    await r.devices.stop('env_pc')
    await r.devices.manifestAll()
    expect(r.posted.map((l) => l.header.kind)).toEqual(['stop'])
    await r.devices.start('env_pc')
    expect(r.posted.map((l) => l.header.kind)).toEqual(['stop', 'manifest'])
  })

  it('Remove asks the box first, then posts the remove letter naming the removal, and revokes LifeOS', async () => {
    const r = rig()
    const revoked: string[] = []
    r.devices.add({ envId: 'env_pc', name: 'Purdue laptop', identity: { signPublic: 's', sealPublic: r.posted[0]?.header.toKey ?? generateDeviceKeys().sealPublic }, generation: 1, accounts: true, enrollments: ['enr1'] })
    const id = await r.devices.remove('env_pc', async (e) => void revoked.push(e))
    expect(id).toBe('rm1')
    expect(r.calls).toEqual(['devices.remove', 'devices.post'])
    expect(r.posted[0].header.kind).toBe('remove')
    expect(revoked).toEqual(['enr1'])
    expect(r.devices.list()[0]).toMatchObject({ state: 'removing', removalId: 'rm1' })
    await r.devices.manifest('env_pc')
    expect(r.posted).toHaveLength(1)
  })

  it("a LifeOS revoke that fails stays owed past the box's retire and goes at the next Work sign-in", async () => {
    const r = rig()
    r.devices.add({ envId: 'env_pc', name: 'Purdue laptop', identity: r.devices.list()[0].identity, generation: 1, accounts: true, enrollments: ['enr1'] })
    await r.devices.remove('env_pc', async () => {
      throw new Error('forbidden')
    })
    expect(r.devices.owedRevokes()).toEqual([{ enrollment: 'enr1', name: 'Purdue laptop' }])
    // The box retires it (its receipt): the row goes, the owed revoke does not.
    r.devices.rows([{ envId: 'env_pc', state: 'retired' } as never])
    expect(r.devices.list()).toEqual([])
    const revoked: string[] = []
    expect(await r.devices.revokeOwed(async (e) => void revoked.push(e))).toBe(1)
    expect(revoked).toEqual(['enr1'])
    expect(r.devices.owedRevokes()).toEqual([])
  })

  it('a stop or remove letter whose post failed goes again when the box link comes back, and on Retry', async () => {
    const failPosts = { n: 1 }
    const r = rig({ failPosts })
    expect(await r.devices.stop('env_pc')).toBe(false)
    expect(r.posted).toEqual([])
    await r.devices.manifestAll()
    expect(r.posted.map((l) => [l.header.kind, l.header.seq])).toEqual([['stop', 1]])
    expect(r.devices.list()[0].unsent).toBeUndefined()
    failPosts.n = 1
    await r.devices.remove('env_pc')
    expect(r.posted).toHaveLength(1)
    await r.devices.retry('env_pc')
    expect(r.posted.map((l) => [l.header.kind, l.header.seq])).toEqual([['stop', 1], ['remove', 2]])
    expect(r.devices.list()[0].unsent).toBeUndefined()
  })

  it("the first manifest goes once the box says the activate letter was acked, though the ack's push was lost", async () => {
    let binding: unknown = { envId: 'env_pc', kind: 'activate', seq: 1, ack: null }
    const r = rig({ bindings: () => [binding] })
    r.devices.firstManifestAfterAck('env_pc')
    await r.devices.activate('env_pc', { box: { envId: 'env_box', origin: 'https://box' } })
    await r.devices.manifestAll()
    expect(r.posted.map((l) => l.header.kind)).toEqual(['activate'])
    binding = { envId: 'env_pc', kind: 'activate', seq: 1, ack: { seq: 1 } }
    await r.devices.retry('env_pc')
    expect(r.posted.map((l) => l.header.kind)).toEqual(['activate', 'manifest'])
    expect(r.devices.list()[0].awaitingActivate).toBe(false)
  })

  it('an activate letter whose post failed goes again, sealed as it was', async () => {
    const r = rig({ failPosts: { n: 1 } })
    r.devices.firstManifestAfterAck('env_pc')
    expect(await r.devices.activate('env_pc', { box: { envId: 'env_box', origin: 'https://box' } })).toBe(false)
    await r.devices.retry('env_pc')
    expect(r.posted.map((l) => [l.header.kind, l.header.seq])).toEqual([['activate', 1]])
  })

  it("a computer the box retired is handed on to leave this host's workspaces", () => {
    const settings = new Map<string, string>()
    const gone: string[] = []
    const devices = new GiverDevices({ store: { getSetting: (k) => settings.get(k) ?? null, setSetting: (k, v) => (v === null ? settings.delete(k) : settings.set(k, v)) }, keys: () => generateDeviceKeys(), source: vaultRows, box: () => null, forgotten: (e) => void gone.push(e), log: () => {} })
    devices.add({ envId: 'env_pc', name: 'PC', identity: { signPublic: 's', sealPublic: 'p' }, generation: 1, accounts: true })
    devices.rows([{ envId: 'env_pc', state: 'retired' } as never])
    expect(gone).toEqual(['env_pc'])
  })

  it("Remove owes the LifeOS revokes before it asks the box, so a lost reply keeps them (F06)", async () => {
    const r = rig({ failPosts: { n: 0 } })
    r.devices.add({ envId: 'env_pc', name: 'PC', identity: r.devices.list()[0].identity, generation: 1, accounts: true, enrollments: ['enr9'] })
    const lost = r.devices as unknown as { deps: { box: () => unknown } }
    const box = lost.deps.box
    lost.deps.box = () => ({ envId: 'env_box', request: async () => Promise.reject(new Error('the reply was lost')) })
    await expect(r.devices.remove('env_pc')).rejects.toThrow(/lost/)
    lost.deps.box = box
    expect(r.devices.owedRevokes()).toEqual([{ enrollment: 'enr9', name: 'PC' }])
  })

  it('Stop with no box link records the sealed letter with the state, and it goes when the link comes back (F09)', async () => {
    const r = rig()
    const d = r.devices as unknown as { deps: { box: () => unknown } }
    const box = d.deps.box
    d.deps.box = () => null
    expect(await r.devices.stop('env_pc')).toBe(false)
    expect(r.devices.list()[0]).toMatchObject({ state: 'stopped', seq: 1 })
    expect(r.devices.list()[0].unsent?.header).toMatchObject({ kind: 'stop', seq: 1 })
    d.deps.box = box
    await r.devices.manifestAll()
    expect(r.posted.map((l) => [l.header.kind, l.header.seq])).toEqual([['stop', 1]])
    expect(r.devices.list()[0].unsent).toBeUndefined()
  })

  it('a computer set up without accounts gets an empty manifest', async () => {
    const r = rig()
    r.devices.add({ envId: 'env_pc', name: 'PC', identity: r.devices.list()[0].identity, generation: 1, accounts: false })
    await r.devices.manifest('env_pc')
    const opened = r.open(r.posted[0], 0)
    expect(opened.ok && opened.body.accounts).toEqual([])
  })
})
