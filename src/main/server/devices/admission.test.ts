import { describe, expect, it } from 'vitest'
import { admit, type AdmissionContext } from './admission'

const claude = (refresh: boolean) =>
  JSON.stringify({ keychain: JSON.stringify({ claudeAiOauth: { accessToken: 'fake', expiresAt: 9e12, ...(refresh ? { refreshToken: 'fake-r' } : {}) } }) })
const t = (o: { mode?: 'access' | 'handoff'; refresh?: boolean; accountId?: string; email?: string; static?: boolean; owner?: string | null } = {}) => ({
  service: 'claude-code' as const,
  mode: o.mode ?? ('access' as const),
  blob: claude(o.refresh ?? false),
  profile: { name: 'n', accountId: o.accountId ?? 'u1', email: o.email, static: o.static ?? false, owner: o.owner === undefined ? 'env_box' : o.owner, createdAt: 1 }
})
const peer = (path: AdmissionContext['path'], extra: Partial<AdmissionContext> = {}): AdmissionContext => ({ path, policy: 'peer', ...extra })

describe('admit', () => {
  it('lands only on the row of the same account id: an email that names another row is refused, never matched', () => {
    const onFile = [{ accountId: 'u2', email: 'a@x.com' }]
    expect(admit(t({ accountId: 'u1', email: 'A@x.com' }), peer('pull'), onFile)).toEqual({ ok: false, reason: 'email-match' })
    expect(admit(t({ accountId: 'u1', email: 'A@x.com' }), { path: 'push', policy: 'admin' }, onFile)).toEqual({ ok: false, reason: 'email-match' })
    expect(admit(t({ accountId: 'u2', email: 'a@x.com' }), peer('rotation'), onFile)).toEqual({ ok: true })
  })

  it('under the peer policy only a row on file takes a copy, on every receive path', () => {
    for (const path of ['pull', 'rotation', 'askOwner'] as const) expect(admit(t(), peer(path), [])).toEqual({ ok: false, reason: 'unknown-account' })
    expect(admit(t(), { path: 'push', policy: 'admin' }, [])).toEqual({ ok: true })
  })

  it('a holder never receives a refresh token: only a handoff, only on the giver\'s push or its own takeover', () => {
    const onFile = [{ accountId: 'u1' }]
    for (const path of ['pull', 'rotation', 'askOwner', 'export'] as const) {
      expect(admit(t({ refresh: true }), peer(path), onFile), path).toEqual({ ok: false, reason: 'refresh-token' })
      expect(admit(t({ mode: 'handoff', refresh: true }), peer(path), onFile), path).toEqual({ ok: false, reason: 'refresh-token' })
    }
    expect(admit(t({ mode: 'handoff', refresh: true }), { path: 'push', policy: 'admin' }, onFile)).toEqual({ ok: true })
    expect(admit(t({ mode: 'handoff', refresh: true }), { path: 'push', policy: 'peer' }, onFile)).toEqual({ ok: false, reason: 'refresh-token' })
    expect(admit(t({ mode: 'handoff', refresh: true }), peer('takeover'), onFile)).toEqual({ ok: true })
  })

  it('a given computer takes only what its manifest names: exact id, kind and owner', () => {
    const admitted = [
      { service: 'claude-code', account: 'u1', kind: 'static' as const },
      { service: 'claude-code', account: 'u2', kind: 'access' as const, owner: 'env_box' }
    ]
    const ctx = peer('pull', { admitted })
    const onFile = [{ accountId: 'u1' }, { accountId: 'u2' }, { accountId: 'u3' }]
    expect(admit(t({ accountId: 'u1', static: true, owner: null }), ctx, onFile)).toEqual({ ok: true })
    expect(admit(t({ accountId: 'u1', owner: 'env_box' }), ctx, onFile)).toEqual({ ok: false, reason: 'kind' })
    expect(admit(t({ accountId: 'u2', owner: 'env_box' }), ctx, onFile)).toEqual({ ok: true })
    expect(admit(t({ accountId: 'u2', owner: 'env_mac' }), ctx, onFile)).toEqual({ ok: false, reason: 'owner' })
    expect(admit(t({ accountId: 'u3' }), ctx, onFile)).toEqual({ ok: false, reason: 'not-admitted' })
    expect(admit(t({ accountId: 'u2', mode: 'handoff', refresh: true }), peer('takeover', { admitted }), onFile)).toEqual({ ok: false, reason: 'refresh-token' })
  })
})
