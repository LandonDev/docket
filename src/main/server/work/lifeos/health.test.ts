import { describe, expect, it } from 'vitest'
import type { LifeosState, LifeosStatus } from '@shared/contract-work-lifeos'
import { WORK_HOME } from '@shared/work'
import type { LifeosClient } from './ctx'
import { lifeosRows, signInRow, SOURCE_SILENT_MS, sourceRow, sourceTitle, type LifeosSource } from './health'
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
    // Signed in but not answering keeps Sign out, so a host stuck on a wrong address can sign in again.
    expect(down).toMatchObject({ state: 'broken', line: 'No answer since 2:00 PM; it keeps trying', fix: { kind: 'run', label: 'Sign out', method: 'work.lifeos.signOut' } })
    expect(signInRow({ state: 'connecting' }, NOW)).toMatchObject({ state: 'broken', fix: { label: 'Sign out' } })
    expect(signInRow({ state: 'off' }, NOW)).toBeNull()
  })

  it('never shows the pairing code', () => {
    expect(JSON.stringify(signInRow({ state: 'pairing', code: 'ABCD-1234', expiresAt: NOW }, NOW))).not.toContain('ABCD-1234')
  })
})

describe('a mail or calendar source', () => {
  const H = 3_600_000
  // Shapes as LifeOS's sources:list answers them on 2026-11-20, the worker last started at 3:12 AM.
  const gcal = (extra: Partial<LifeosSource> = {}): LifeosSource => ({ _id: 'g1', kind: 'gcal', account: 'landon@cosmic.games', label: 'landon@cosmic.games', sector: 'cosmic', enabled: true, status: 'ok', lastSyncAt: new Date('2026-11-20T03:12:00').getTime(), reportedAt: new Date('2026-11-20T03:12:00').getTime(), ...extra })
  const mail = (extra: Partial<LifeosSource> = {}): LifeosSource => ({ _id: 'm1', kind: 'email', account: 'landon@cosmic.games', label: 'Cosmic', sector: 'cosmic', enabled: true, status: 'ok', lastSyncAt: NOW - 40_000, reportedAt: NOW - 40_000, ...extra })

  it('works while mail checked in lately, and says when', () => {
    expect(sourceRow(mail(), NOW)).toMatchObject({ id: 'lifeos.source:m1', group: 'Mail and calendar', title: 'Cosmic mail', sector: 'cosmic', shared: true, state: 'working', line: 'Synced 2:59 PM' })
    // With no sector it names his account: a thread of a sector reads its state alone.
    expect(sourceRow(mail({ sector: undefined }), NOW)).toMatchObject({ shared: true, personal: true })
  })

  it('reads an ok Google calendar as working however old its times: it reports only on a change, so they say when the worker started', () => {
    expect(sourceRow(gcal(), NOW)).toMatchObject({ title: 'landon@cosmic.games calendar', state: 'working', line: 'Syncing' })
    expect(sourceRow(gcal({ label: 'Hypixel Calendar', lastSyncAt: NOW - 9 * H, reportedAt: NOW - 9 * H }), NOW)).toMatchObject({ title: 'Hypixel Calendar', state: 'working' })
    expect(sourceRow(gcal({ lastSyncAt: NOW - 30 * 24 * H, reportedAt: undefined }), NOW)).toMatchObject({ state: 'working' })
    expect(sourceRow(gcal({ status: 'error', error: 'invalid_grant' }), NOW)).toMatchObject({ state: 'broken', line: 'invalid_grant' })
  })

  it('reads silence only for a kind that checks in on every poll: mail after ten minutes, a feed after a day', () => {
    expect(sourceRow(mail({ reportedAt: NOW - 9 * 60_000 }), NOW)).toMatchObject({ state: 'working' })
    expect(sourceRow(mail({ reportedAt: NOW - SOURCE_SILENT_MS.email! - 60_000 }), NOW)).toMatchObject({ state: 'broken', line: 'No sync since 2:49 PM' })
    const ics = (reportedAt: number): LifeosSource => ({ _id: 'f1', kind: 'ics', account: 'ics', label: 'School', enabled: true, status: 'ok', lastSyncAt: reportedAt, reportedAt })
    expect(sourceRow(ics(NOW - 9 * H), NOW)).toMatchObject({ title: 'School calendar', state: 'working' })
    expect(sourceRow(ics(new Date('2026-11-18T08:00:00').getTime()), NOW)).toMatchObject({ state: 'broken', line: 'No sync since Nov 18' })
  })

  it('is broken on an error or never synced, and needs him when LifeOS stopped reading it', () => {
    expect(sourceRow(mail({ status: 'error', error: 'IMAP login failed' }), NOW)).toMatchObject({ state: 'broken', line: 'IMAP login failed' })
    expect(sourceRow(mail({ lastSyncAt: undefined, reportedAt: undefined, status: 'idle' }), NOW)).toMatchObject({ state: 'broken', line: 'Never synced' })
    expect(sourceRow(mail({ status: 'idle', error: 'disconnected' }), NOW)).toMatchObject({ state: 'needs-you', line: 'Stopped in LifeOS: disconnected' })
  })

  it('says what each is in a word, so a mail account and its calendar never read as one thing twice', () => {
    expect([sourceTitle(mail()), sourceTitle(gcal())]).toEqual(['Cosmic mail', 'landon@cosmic.games calendar'])
    expect(sourceTitle({ kind: 'email', label: 'Purdue Mail', account: 'x' })).toBe('Purdue Mail')
    expect(sourceTitle({ kind: 'ics', label: '', accountName: 'School', account: 'ics' })).toBe('School calendar')
  })

  it('leaves out a source that is off, and kinds that are not mail or calendar', () => {
    expect(sourceRow(mail({ enabled: false }), NOW)).toBeNull()
    for (const kind of ['slack', 'discord', 'imessage', 'linear', 'teams']) expect(sourceRow(mail({ kind }), NOW)).toBeNull()
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
