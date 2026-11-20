import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_PRINCIPAL } from '@shared/capabilities'
import type { ClientRequest } from '@shared/contract'
import type { SessionMeta } from '@shared/events'
import { lapseLine, lapseStage, rowsForSector, type HealthReport, type HealthRow, type Lapse, type WorkScope } from '@shared/work'
import { openDb, Store } from '../db'
import type { Peers } from '../remote/peers'
import type { SessionRegistry } from '../sessions'
import type { WorkPartDeps } from './ctx'
import { checkHost, cleanRow, HEALTH_CHECK_MS, healthText, lapsesOf } from './health'
import type { WorkCtx, WorkModule } from './modules'

const scopes = new Map<string, WorkScope>()
vi.mock('./scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./scope')>()),
  scopePart: (_ctx: WorkCtx, _deps: WorkPartDeps) => ({
    scopeOf: (id: string) => scopes.get(id) ?? null,
    mentionReach: () => null,
    createWorkspace: async () => {
      throw new Error('not in this test')
    },
    admitSession: () => {}
  })
}))
const { startWork } = await import('./ctx')

const DAY = 86_400_000
const row = (over: Partial<HealthRow> = {}): HealthRow => ({ id: 'mail.thing', pillar: 'mail', group: 'Mail', title: 'Thing', state: 'working', ...over })
const ctx = { host: 'env_box', log: () => {} } as unknown as WorkCtx
const never = new AbortController().signal

describe('checkHost', () => {
  it("gathers every pillar's rows, each held to its own pillar and one line", async () => {
    const modules = [
      { id: 'lifeos', health: { check: async () => [row({ id: 'lifeos.signin', pillar: 'mail', group: 'LifeOS', title: 'Sign-in', line: 'Signed in\n  as  him' })] } },
      { id: 'office', health: { check: async () => [row({ id: 'office.excel', group: 'Office', title: 'Excel', state: 'needs-you' })] } },
      { id: 'tasks' }
    ] as unknown as WorkModule[]
    const report = await checkHost(ctx, modules, new Map(), never, () => 42)
    expect(report).toEqual({
      host: 'env_box',
      at: 42,
      rows: [
        { id: 'lifeos.signin', pillar: 'lifeos', group: 'LifeOS', title: 'Sign-in', state: 'working', line: 'Signed in as him' },
        { id: 'office.excel', pillar: 'office', group: 'Office', title: 'Excel', state: 'needs-you' }
      ]
    })
  })

  it('turns a check that throws into one broken row and keeps the others', async () => {
    const modules = [
      { id: 'google', health: { check: async () => Promise.reject(new Error('quota')) } },
      { id: 'office', health: { check: async () => [row({ id: 'office.word' })] } }
    ] as unknown as WorkModule[]
    const { rows } = await checkHost(ctx, modules, new Map(), never)
    expect(rows.map((r) => [r.id, r.state, r.group, r.line])).toEqual([
      ['google.check', 'broken', 'Google', 'Did not answer: quota'],
      ['office.word', 'working', 'Mail', undefined]
    ])
  })

  it('gives up on a check that does not answer in time, and tells its signal', async () => {
    vi.useFakeTimers()
    try {
      let heard = false
      const modules = [
        {
          id: 'browser',
          health: {
            check: (_c: WorkCtx, signal: AbortSignal) =>
              new Promise<HealthRow[]>(() => signal.addEventListener('abort', () => (heard = true)))
          }
        }
      ] as unknown as WorkModule[]
      const pending = checkHost(ctx, modules, new Map(), never)
      await vi.advanceTimersByTimeAsync(HEALTH_CHECK_MS + 1)
      const { rows } = await pending
      expect(rows).toEqual([expect.objectContaining({ id: 'browser.check', state: 'broken', line: `Did not answer: no answer in ${HEALTH_CHECK_MS / 1000} s` })])
      expect(heard).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lists a pillar that did not load as broken', async () => {
    const { rows } = await checkHost(ctx, [], new Map([['frameio', 'work: frameio did not load: no module']]), never)
    expect(rows).toEqual([expect.objectContaining({ id: 'frameio.check', group: 'Frame.io', state: 'broken', line: 'work: frameio did not load: no module' })])
  })
})

describe('cleanRow', () => {
  it('drops what a row did not declare, reads an unknown state as broken and cuts a long line', () => {
    const dirty = { ...row({ line: 'x'.repeat(500) }), state: 'fine', secret: 'tok_123' } as unknown as HealthRow
    const clean = cleanRow(dirty, 'mail')
    expect(clean).not.toHaveProperty('secret')
    expect(clean.state).toBe('broken')
    expect(clean.line).toHaveLength(200)
  })
})

describe('lapses', () => {
  it('answers every pillar’s lapses soonest first, and leaves out one that throws', () => {
    const log = vi.fn()
    const modules = [
      { id: 'browser', health: { check: async () => [], lapses: (): Lapse[] => [{ id: 'browser.vm', pillar: 'mail', title: 'Windows evaluation', until: 300 }] } },
      { id: 'frameio', health: { check: async () => [], lapses: (): Lapse[] => [{ id: 'frameio.token', pillar: 'frameio', title: 'Frame.io', until: 100 }] } },
      {
        id: 'google',
        health: {
          check: async () => [],
          lapses: () => {
            throw new Error('bad file')
          }
        }
      }
    ] as unknown as WorkModule[]
    expect(lapsesOf({ ...ctx, log } as WorkCtx, modules).map((l) => [l.id, l.pillar, l.until])).toEqual([
      ['frameio.token', 'frameio', 100],
      ['browser.vm', 'browser', 300]
    ])
    expect(log).toHaveBeenCalledWith('google lapses: bad file')
  })

  it('is due 14 days before and again the day before, and stays due once past', () => {
    const now = Date.UTC(2027, 0, 1)
    expect(lapseStage(now + 20 * DAY, now)).toBeNull()
    expect(lapseStage(now + 14 * DAY, now)).toBe(0)
    expect(lapseStage(now + 3 * DAY, now)).toBe(0)
    expect(lapseStage(now + DAY / 2, now)).toBe(1)
    expect(lapseStage(now - DAY, now)).toBe(1)
  })

  it('reads in his words', () => {
    const now = Date.UTC(2026, 10, 20, 12)
    expect(lapseLine(Date.UTC(2027, 1, 17, 12), now)).toBe('Ends on 17 Feb 2027')
    expect(lapseLine(Date.UTC(2026, 11, 3, 12), now)).toBe('Ends on 3 Dec')
    expect(lapseLine(now + DAY / 2, now)).toBe('Ends tomorrow')
    expect(lapseLine(now - DAY, now)).toBe('Ended on 19 Nov')
  })
})

describe('healthText', () => {
  const report: HealthReport = {
    host: 'env_box',
    at: 0,
    rows: [
      row({ id: 'lifeos.source:a', group: 'Mail and calendar', title: 'cosmic mail', sector: 'cosmic' }),
      row({ id: 'lifeos.source:b', group: 'Mail and calendar', title: 'purdue mail', sector: 'purdue', state: 'broken', line: 'Token expired' }),
      row({ id: 'office.outlook', group: 'Office', title: 'Outlook', state: 'needs-you', line: 'New Outlook cannot be scripted', fix: { kind: 'page', label: 'Sign in…', page: 'lifeos-sign-in' } })
    ]
  }

  it("shows a thread its own sector's rows and none of another's, worst first", () => {
    const text = healthText([{ name: 'This host', report }], 'purdue')
    expect(text).not.toContain('cosmic mail')
    expect(text.split('\n')).toEqual([
      'This host',
      '- Mail and calendar / purdue mail: BROKEN. Token expired',
      '- Office / Outlook: NEEDS HIM. New Outlook cannot be scripted. fix: Sign in… (in the app)'
    ])
    expect(healthText([{ name: 'This host', report }], 'all')).toContain('cosmic mail')
    expect(rowsForSector(report.rows, null).map((r) => r.id)).toEqual(['office.outlook'])
  })

  it('says a host that is not linked now is offline, not broken', () => {
    expect(healthText([{ name: 'The Mac', offline: true }, { name: 'PC', error: 'Work is off on this host' }], 'all')).toBe(
      'The Mac: offline (not checked; offline is not broken)\nPC: did not answer: Work is off on this host'
    )
  })
})

describe('the mount', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let work: ReturnType<typeof startWork>
  const sessions = new Map<string, SessionMeta>()
  const registry = { get: (id: string) => sessions.get(id) ?? null } as unknown as SessionRegistry
  const req = (method: string): ClientRequest => ({ id: '1', method, params: {} }) as ClientRequest
  const peers = {
    all: () => [
      { connected: true, env: { name: 'The Mac' }, request: async (method: string) => ({ host: 'env_mac', at: 1, rows: [row({ id: `${method}.far` })] }) },
      { connected: false, env: { name: 'PC' }, request: async () => Promise.reject(new Error('not connected')) }
    ]
  } as unknown as Peers
  const module = { id: 'office', ensure: () => {}, health: { check: async () => [row({ id: 'office.excel', title: 'Excel' })], lapses: () => [{ id: 'office.x', pillar: 'office', title: 'X', until: 5 }] } } as unknown as WorkModule

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tc-work-health-'))
    db = openDb(join(dir, 'test.db'))
    work = startWork({ db, store: new Store(db), registry, environmentId: 'env_box', dataDir: dir, peers, log: () => {} }, [module])
  })
  afterEach(() => {
    work.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses both reads while Work is off', async () => {
    await expect(work.handle(req('work.health'), LOCAL_PRINCIPAL)).rejects.toThrow('Work is off on this host')
    await expect(work.handle(req('work.lapses'), LOCAL_PRINCIPAL)).rejects.toThrow('Work is off on this host')
  })

  it("answers this host's rows and lapses with Work on", async () => {
    await work.handle({ id: '1', method: 'work.set', params: { enabled: true } } as ClientRequest, LOCAL_PRINCIPAL)
    const health = await work.handle(req('work.health'), LOCAL_PRINCIPAL)
    expect(health.handled && (health.result as HealthReport).rows.map((r) => r.id)).toEqual(['office.excel'])
    const lapses = await work.handle(req('work.lapses'), LOCAL_PRINCIPAL)
    expect(lapses.handled && lapses.result).toEqual([{ id: 'office.x', pillar: 'office', title: 'X', until: 5 }])
  })

  it('lists work_connections to every Work thread, read-only, reading this host and each linked one', async () => {
    await work.handle({ id: '1', method: 'work.set', params: { enabled: true } } as ClientRequest, LOCAL_PRINCIPAL)
    const meta = { id: 't1', provider: 'claude', scope: 'work' } as SessionMeta
    sessions.set('t1', meta)
    scopes.set('t1', { sessionId: 't1', workspaceId: null, sector: null, host: 'env_box', away: false, routineRunId: null, shared: () => false })
    const listed = work.tools.listing(meta).find((t) => t.name === 'work_connections')
    expect(listed?.readOnly).toBe(true)
    const result = await work.tools.call(meta, 'work_connections', {}, never)
    const text = result.content[0]!.type === 'text' ? result.content[0]!.text : ''
    expect(text.split('\n')).toEqual(['This host', '- Mail / Excel: working', 'The Mac', '- Mail / Thing: working', 'PC: offline (not checked; offline is not broken)'])
  })
})
