import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkCtx } from '../modules'
import { configureFrameio, memoryTokens, type StoredTokens } from './auth'
import { frameioRows } from './health'
import { frameio } from './index'
import { ensureFrameioTables, saveItem, setSetting } from './live'

const NOW = Date.UTC(2026, 10, 20, 12)
const ACCESS = 'eyJhbGciOiJSUzI1NiJ9.access-token-value'
const REFRESH = 'refresh-token-value-123'

let restore: (() => void) | null = null
afterEach(() => {
  restore?.()
  restore = null
})

function ctxWith(tokens: StoredTokens | null): WorkCtx {
  restore = configureFrameio({ tokens: memoryTokens(tokens) })
  const db = new DatabaseSync(':memory:')
  ensureFrameioTables(db)
  return { db } as unknown as WorkCtx
}

const tokens = (extra: Partial<StoredTokens> = {}): StoredTokens => ({
  v: 1,
  clientId: 'adobe-client',
  redirectUri: 'http://127.0.0.1:7697/frameio/callback',
  access: ACCESS,
  refresh: REFRESH,
  expiresAt: NOW + 3_600_000,
  user: { id: 'u1', name: 'Landon', email: 'landon@hypixel.net' },
  hooks: { h1: 'webhook-signing-secret' },
  ...extra
})

describe('the Frame.io connection', () => {
  it('signed in with a refresh token: working, as whom, with no known end', () => {
    const ctx = ctxWith(tokens())
    const rows = frameioRows(ctx, NOW)
    expect(rows).toEqual([{ id: 'frameio.signin', pillar: 'frameio', group: 'Frame.io', title: 'Frame.io', state: 'working', line: 'Signed in as landon@hypixel.net' }])
    expect(frameio.health!.lapses!(ctx)).toEqual([])
  })

  it('signed in with nothing to renew it: the token’s end is the row’s and a lapse', () => {
    const ctx = ctxWith(tokens({ refresh: undefined, user: { id: 'u1', name: 'Landon' } }))
    expect(frameioRows(ctx, NOW)).toMatchObject([{ state: 'working', line: 'Signed in as Landon', until: NOW + 3_600_000 }])
    expect(frameio.health!.lapses!(ctx)).toEqual([{ id: 'frameio.signin', pillar: 'frameio', title: 'Frame.io sign-in', until: NOW + 3_600_000 }])
  })

  it('a sign-in that ran out needs him, with the sign-in button', () => {
    const ctx = ctxWith(tokens({ refresh: undefined, expiresAt: NOW - 1 }))
    expect(frameioRows(ctx, NOW)).toMatchObject([{ state: 'needs-you', line: 'The sign-in ran out. Sign in again.', fix: { kind: 'page', label: 'Sign in…', page: 'settings:work' }, until: NOW - 1 }])
  })

  it('signed out after using it: needs him', () => {
    const ctx = ctxWith(null)
    setSetting(ctx.db, 'publicUrl', 'https://hooks.example.com')
    expect(frameioRows(ctx, NOW)).toMatchObject([{ id: 'frameio.signin', state: 'needs-you', line: 'Not signed in on this host', fix: { page: 'settings:work' } }])
    const other = ctxWith(null)
    saveItem(other.db, { itemId: 'i1', sessionId: 's1', account: 'a', stackId: null, fileIds: ['f'] })
    expect(frameioRows(other, NOW)).toMatchObject([{ state: 'needs-you' }])
  })

  it('never set up on this host: no row', () => {
    const ctx = ctxWith(null)
    expect(frameioRows(ctx, NOW)).toEqual([])
    expect(frameio.health!.lapses!(ctx)).toEqual([])
  })

  it('no row carries a token or a webhook secret', () => {
    for (const t of [tokens(), tokens({ refresh: undefined, expiresAt: NOW - 1 })]) {
      const text = JSON.stringify(frameioRows(ctxWith(t), NOW))
      for (const secret of [ACCESS, REFRESH, 'webhook-signing-secret', 'adobe-client']) expect(text).not.toContain(secret)
      restore?.()
    }
  })
})
