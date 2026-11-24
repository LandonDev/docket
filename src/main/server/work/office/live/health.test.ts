import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClientRequestSchema } from '@shared/contract'
import { fixAllowed, HEALTH_RUN_METHODS } from '@shared/work/health'
import { liveHandle } from './handle'
import { LIVE_SIGN_OUT, liveRow, liveTenants } from './health'

const NOW = Date.UTC(2026, 10, 23, 12)
const DAY = 86_400_000

describe('the live sessions in Connections', () => {
  it('is signed in while Entra\'s persistent cookie is in date, with Sign out and its end', () => {
    const row = liveRow('purdue0', [{ name: 'ESTSAUTHPERSISTENT', expirationDate: (NOW + 30 * DAY) / 1000 }, { name: 'buid', expirationDate: (NOW + 400 * DAY) / 1000 }], NOW)
    expect(row).toMatchObject({ id: 'office.live:purdue0', pillar: 'office', group: 'Office', state: 'working', line: 'Signed in', until: NOW + 30 * DAY, personal: true })
    expect(row.fix).toEqual({ kind: 'run', label: 'Sign out', method: LIVE_SIGN_OUT, params: { tenant: 'purdue0' } })
    expect(fixAllowed(row.fix!)).toBe(true)
  })

  it('needs him once the cookie lapses, or when there is none', () => {
    expect(liveRow('purdue0', [{ name: 'ESTSAUTHPERSISTENT', expirationDate: (NOW - DAY) / 1000 }], NOW)).toMatchObject({ state: 'needs-you' })
    expect(liveRow('purdue0', [{ name: 'buid' }], NOW)).toMatchObject({ state: 'needs-you' })
    expect(liveRow('purdue0', [], NOW).fix).toBeUndefined()
  })

  it('takes a session cookie with no end as signed in, with no end said', () => {
    const row = liveRow('purdue0', [{ name: 'ESTSAUTH' }], NOW)
    expect(row.state).toBe('working')
    expect(row).not.toHaveProperty('until')
  })

  it('lists the tenants with a live session on this computer, and nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-live-health-'))
    try {
      expect(liveTenants(dir)).toEqual([])
      for (const n of ['office-live-purdue0', 'office-live-contoso', 'microsoft', 'office-live-', 'office-live-BAD']) mkdirSync(join(dir, 'Partitions', n), { recursive: true })
      expect(liveTenants(dir).sort()).toEqual(['contoso', 'purdue0'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is a fix a row may carry', () => {
    expect(HEALTH_RUN_METHODS).toContain(LIVE_SIGN_OUT)
  })
})

describe('signing out', () => {
  const ask = (by: Record<string, unknown>) =>
    liveHandle(ClientRequestSchema.parse({ id: '1', method: LIVE_SIGN_OUT, params: { tenant: 'purdue0' } }), {} as never, { caps: ['operate'], ...by } as never, () => null)

  it('is refused to a remote key, another host and a thread', async () => {
    await expect(ask({ kind: 'remote' })).rejects.toThrow('from a window on this computer')
    await expect(ask({ kind: 'local', peer: 'box' })).rejects.toThrow('from a window on this computer')
    await expect(ask({ kind: 'model' })).rejects.toThrow('from a window on this computer')
  })

  it('refuses a tenant that is not one', () => {
    expect(() => ClientRequestSchema.parse({ id: '1', method: LIVE_SIGN_OUT, params: { tenant: '../microsoft' } })).toThrow()
  })
})
