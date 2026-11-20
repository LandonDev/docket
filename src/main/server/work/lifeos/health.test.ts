import { describe, expect, it } from 'vitest'
import type { LifeosState, LifeosStatus } from '@shared/contract-work-lifeos'
import { WORK_HOME } from '@shared/work'
import type { LifeosClient } from './ctx'
import { lifeosRows, signInRow, SOURCE_STALE_MS, sourceRow, type LifeosSource } from './health'
import { lifeos } from './index'

const NOW = new Date('2026-11-20T15:00:00').getTime()
const JWT = 'eyJhbGciOiJIUzI1.eyJzdWIiOiJsYW5kb24.c2lnbmF0dXJlc2ln'

function owner(answers: Record<string, unknown>, calls: string[] = []): LifeosClient {
  const query = async <T,>(fn: string): Promise<T> => {
    calls.push(fn)
    const a = answers[fn]
    if (a instanceof Error) throw a
    return a as T
  }
  return { query, mutation: query, action: query } as LifeosClient
}

const source = (extra: Partial<LifeosSource>): LifeosSource => ({ _id: 's1', kind: 'email', account: 'me@purdue.edu', label: 'Purdue mail', sector: 'purdue', enabled: true, status: 'ok', lastSyncAt: NOW - 60_000, ...extra })

const status = (lifeos: LifeosState, keys: LifeosStatus['keys'] = []): LifeosStatus => ({ lifeos, keys })

describe('the LifeOS sign-in row', () => {
  it('carries the button the Settings row had, in each state', () => {
    expect(signInRow({ state: 'connected', ownerId: 'landon', since: NOW }, NOW)).toMatchObject({ id: 'lifeos.signin', group: 'LifeOS', title: 'LifeOS', state: 'working', line: 'Signed in', fix: { kind: 'run', label: 'Sign out', method: 'work.lifeos.signOut' } })
    expect(signInRow({ state: 'pairing', code: 'ABCD-1234', expiresAt: NOW + 60_000 }, NOW)).toMatchObject({ state: 'needs-you', fix: { kind: 'page', label: 'Show code…', page: 'lifeos-sign-in' } })
    expect(signInRow({ state: 'signed-out' }, NOW)).toMatchObject({ state: 'needs-you', fix: { kind: 'page', label: 'Sign in…', page: 'lifeos-sign-in' } })
    expect(signInRow({ state: 'refused', error: 'revoked' }, NOW)).toMatchObject({ state: 'needs-you', fix: { label: 'Sign in…', page: 'lifeos-sign-in' } })
    const down = signInRow({ state: 'unreachable', since: NOW - 3_600_000, error: 'fetch failed' }, NOW)!
    expect(down).toMatchObject({ state: 'broken', line: 'No answer since 14:00; it keeps trying' })
    expect(down.fix).toBeUndefined()
    expect(signInRow({ state: 'connecting' }, NOW)).toMatchObject({ state: 'broken' })
    expect(signInRow({ state: 'off' }, NOW)).toBeNull()
  })

  it('never shows the pairing code', () => {
    expect(JSON.stringify(signInRow({ state: 'pairing', code: 'ABCD-1234', expiresAt: NOW }, NOW))).not.toContain('ABCD-1234')
  })
})

describe('a mail or calendar source', () => {
  it('works while it synced lately, and says when', () => {
    expect(sourceRow(source({}), NOW)).toMatchObject({ id: 'lifeos.source:s1', group: 'Mail and calendar', title: 'Purdue mail', sector: 'purdue', state: 'working', line: 'Synced 14:59' })
  })

  it('is broken on an error, after a long quiet, or never synced', () => {
    expect(sourceRow(source({ status: 'error', error: 'IMAP login failed' }), NOW)).toMatchObject({ state: 'broken', line: 'IMAP login failed' })
    expect(sourceRow(source({ lastSyncAt: NOW - SOURCE_STALE_MS - 60_000 }), NOW)).toMatchObject({ state: 'broken', line: 'No sync since 08:59' })
    expect(sourceRow(source({ lastSyncAt: new Date('2026-11-17T08:00:00').getTime() }), NOW)).toMatchObject({ line: 'No sync since 17 Nov' })
    expect(sourceRow(source({ lastSyncAt: undefined, status: 'idle' }), NOW)).toMatchObject({ state: 'broken', line: 'Never synced' })
  })

  it('leaves out a source that is off, and kinds that are not mail or calendar', () => {
    expect(sourceRow(source({ enabled: false }), NOW)).toBeNull()
    expect(sourceRow(source({ kind: 'slack' }), NOW)).toBeNull()
    expect(sourceRow(source({ kind: 'gcal' }), NOW)).not.toBeNull()
    expect(sourceRow(source({ kind: 'ics', label: '', accountName: 'School' }), NOW)).toMatchObject({ title: 'School' })
  })
})

describe('the rows of a host', () => {
  it('signed out: the one sign-in row, and LifeOS is never asked', async () => {
    const calls: string[] = []
    const rows = await lifeosRows({ status: status({ state: 'signed-out' }, [{ workspaceId: 'w', sectors: ['cosmic'], state: 'waiting' }]), owner: owner({}, calls), workspaceName: () => 'W', now: NOW })
    expect(rows.map((r) => r.id)).toEqual(['lifeos.signin'])
    expect(calls).toEqual([])
  })

  it('Work off: no rows', async () => {
    expect(await lifeosRows({ status: status({ state: 'off' }), owner: owner({}), workspaceName: () => undefined, now: NOW })).toEqual([])
  })

  it('signed in: a failed key, then each source', async () => {
    const calls: string[] = []
    const rows = await lifeosRows({
      status: status({ state: 'connected', ownerId: 'landon', since: NOW }, [
        { workspaceId: 'w1', sectors: ['cosmic'], state: 'failed', error: `LifeOS refused ${JWT}` },
        { workspaceId: WORK_HOME, sectors: ['cosmic', 'purdue'], state: 'failed' },
        { workspaceId: 'w2', sectors: ['purdue'], state: 'ready', addonId: 'ad_1' }
      ]),
      owner: owner({ 'health:ping': { ok: true }, 'sources:list': [source({}), source({ _id: 's2', kind: 'gcal', status: 'error', error: 'token revoked' }), source({ _id: 's3', kind: 'slack' })] }, calls),
      workspaceName: (id) => (id === 'w1' ? 'Cosmic' : undefined),
      now: NOW
    })
    expect(rows.map((r) => [r.id, r.state])).toEqual([
      ['lifeos.signin', 'working'],
      ['lifeos.key:w1', 'broken'],
      [`lifeos.key:${WORK_HOME}`, 'broken'],
      ['lifeos.source:s1', 'working'],
      ['lifeos.source:s2', 'broken']
    ])
    expect(rows[1]).toMatchObject({ title: 'Cosmic key', sector: 'cosmic' })
    expect(rows[2]).toMatchObject({ title: 'Work Chats key' })
    expect(rows[2]!.sector).toBeUndefined()
    expect(calls.sort()).toEqual(['health:ping', 'sources:list'])
    // No token reaches a row, even one an error carried.
    expect(JSON.stringify(rows)).not.toContain(JWT)
  })

  it('LifeOS not answering: one broken row, and no source rows that hang on it', async () => {
    const rows = await lifeosRows({ status: status({ state: 'connected', ownerId: 'landon', since: NOW }), owner: owner({ 'health:ping': new Error(`timed out ${JWT}`), 'sources:list': [source({})] }), workspaceName: () => undefined, now: NOW })
    expect(rows.map((r) => [r.id, r.state])).toEqual([
      ['lifeos.signin', 'working'],
      ['lifeos.answers', 'broken']
    ])
    expect(JSON.stringify(rows)).not.toContain(JWT)
  })

  it('the module answers for itself, and nothing on a ctx with no LifeOS host', async () => {
    expect(lifeos.health).toBeDefined()
    expect(lifeos.health!.lapses).toBeUndefined()
    expect(await lifeos.health!.check({} as never, new AbortController().signal)).toEqual([])
  })
})
