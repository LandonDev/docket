import { describe, expect, it, vi } from 'vitest'
import { LOCAL_PRINCIPAL, type Capability, type Principal } from '@shared/capabilities'
import { ClientRequestSchema } from '@shared/contract'
import { REVEAL_INVALID, REVEAL_LOCKED, REVEAL_NO_WINDOW, type RevealTarget } from '@shared/contract-work-reveal'
import type { SessionMeta } from '@shared/events'
import { WORK_HOME } from '@shared/work/ids'
import { reachesOf } from './ctx'
import { reveal, REVEAL_ADMIN, REVEAL_NO_DESKTOP } from './reveal'

const key = (...caps: Capability[]): Principal => ({ kind: 'remote', keyId: 'phone', name: 'Phone', audience: 'client', caps })
const PRESS = key('read', 'approve')
const ADMIN = key('admin')
const UNAVAILABLE = 'That destination is unavailable on this computer.'
const jobs = [
  { id: 'w1', kind: 'work', sector: 'purdue', path: '/jobs/yes', git: false, name: 'Purdue', createdAt: 0 },
  { id: 'w2', kind: 'work', sector: 'cosmic', path: '/jobs/no', git: false, name: 'Cosmic', createdAt: 0 },
] as const

type Deps = Parameters<typeof reveal>[0]

function rig(opts: { scoped?: boolean; unavailable?: string; box?: boolean; off?: boolean; platform?: NodeJS.Platform } = {}) {
  const open = vi.fn<NonNullable<Deps['window']>['open']>().mockResolvedValue(undefined)
  const query = vi.fn(async (_fn: string, { id }: { id?: string }) => id === 'e1' ? { sector: 'purdue' } : id === 'elsewhere' ? { sector: 'cosmic' } : null)
  const send = vi.fn()
  const markRead = vi.fn()
  const deps: Deps = {
    platform: opts.platform ?? 'darwin',
    registry: {
      listWorkspaces: () => [...jobs],
      get: (id) => {
        const job = id === 's1' ? jobs[0] : id === 's2' ? jobs[1] : null
        return job ? { id, cwd: job.path, workspaceId: job.id } as SessionMeta : null
      },
      getProject: () => null,
    },
    ctx: {
      host: 'this-host',
      enabled: () => !opts.off,
      reaches: reachesOf({ roots: () => [jobs[0].path, ...opts.scoped ? [] : [jobs[1].path]], denied: () => [] }),
      canvas: {
        get: (id: string) => {
          const job = id === 'i2' ? jobs[1] : ['i1', 'far-item', 'thread-item'].includes(id) ? jobs[0] : null
          return job ? { id, workspaceId: job.id, sessionId: id === 'thread-item' ? 's1' : 'filespane_' + job.id, source: { at: 'file', path: job.path + '/sheet.xlsx', host: id === 'far-item' ? 'other-host' : 'this-host' } } : null
        },
      } as Deps['ctx']['canvas'],
      lifeos: { owner: () => ({ query, send, markRead }) } as unknown as Deps['ctx']['lifeos'],
    },
    window: opts.box ? undefined : { check: () => opts.unavailable ?? null, open },
    held: async (ref) => {
      if (ref.id === 'home') return { workspaceId: WORK_HOME, sessionId: null, sector: null }
      const job = ref.id === 'h1' ? jobs[0] : ref.id === 'h2' ? jobs[1] : null
      return job ? { workspaceId: job.id, sector: job.sector, sessionId: job.id === 'w1' ? 's1' : 's2' } : null
    },
    files: async (_by, workspaceId) => ({ rev: 1, tabs: [{ id: 'tab1', name: 'Sheet', kind: 'file', itemId: workspaceId === 'w1' ? 'i1' : 'i2' }] }),
  }
  return { deps, query, send, markRead, open, ask: (target: unknown, principal = PRESS) => reveal(deps, { target }, principal) }
}

describe('work.reveal', () => {
  it.each<[RevealTarget, object]>([
    [{ thread: 's1' }, {}],
    [{ view: 'agenda', workspaceId: 'w1', at: 'e1' }, { workspace: { id: 'w1', path: '/jobs/yes' } }],
    [{ place: 'review', at: '1795478400000' }, {}],
    [{ item: 'i1' }, { workspace: { id: 'w1', path: '/jobs/yes' }, item: { tab: 'tab1', itemId: 'i1' } }],
    [{ item: 'thread-item' }, { item: { owner: 's1' } }],
    [{ held: { at: 'host', id: 'h1' }, thread: 's1' }, {}],
    [{ held: { at: 'lifeos', table: 'outbox', id: 'home' } }, {}],
    [{ settings: 'general' }, {}],
  ])('opens exactly %j and writes no read marks or sends', async (target, extra) => {
    const h = rig()
    await expect(h.ask(target)).resolves.toEqual({ opened: true })
    expect(h.open.mock.calls).toEqual([[{ target, ...extra }, undefined]])
    expect(h.send).not.toHaveBeenCalled()
    expect(h.markRead).not.toHaveBeenCalled()
  })

  it.each([key('operate'), key('read'), key('device', 'admin', 'operate')])('refuses a key without approve', async (principal) => {
    const h = rig()
    await expect(h.ask({ thread: 's1' }, principal)).rejects.toThrow('forbidden: work.reveal needs approve')
    expect(h.open).not.toHaveBeenCalled()
  })

  it.each([
    { thread: 's2' },
    { view: 'files', workspaceId: 'w2' },
    { item: 'i2' },
    { held: { at: 'lifeos', table: 'outbox', id: 'h2' } },
    { place: 'today' },
  ])('will not use the desktop to show a job outside the caller’s roots: %j', async (target) => {
    const h = rig({ scoped: true })
    await expect(h.ask(target)).rejects.toThrow(UNAVAILABLE)
    expect(h.open).not.toHaveBeenCalled()
  })

  it.each([
    { thread: 'unknown' },
    { view: 'agenda', workspaceId: 'unknown' },
    { view: 'agenda', workspaceId: 'w1', at: 'unknown' },
    { view: 'agenda', workspaceId: 'w1', at: 'elsewhere' },
    { item: 'unknown' },
    { item: 'far-item' },
    { held: { at: 'host', id: 'unknown' } },
    { held: { at: 'host', id: 'h1' }, thread: 's2' },
  ])('refuses an unresolved or mismatched ID: %j', async (target) => {
    const h = rig()
    await expect(h.ask(target)).rejects.toThrow(UNAVAILABLE)
    expect(h.open).not.toHaveBeenCalled()
  })

  it.each([
    { settings: 'unknown' },
    { view: 'unknown', workspaceId: 'w1' },
    { place: 'unknown' },
    { thread: 's1', extra: 'x' },
    { thread: 's1', host: 'other-host' },
    { thread: 's1', place: 'today' },
    { thread: 'https://example.test' },
    { thread: 'file:secret' },
    { item: '/jobs/yes/sheet.xlsx' },
    { item: 'C:\\Work\\sheet.xlsx' },
    { item: { at: 'file', path: '/jobs/yes/sheet.xlsx' } },
    { held: { at: 'host', id: 'h1', path: '/jobs/yes/sheet.xlsx' } },
    { held: { at: 'lifeos', table: 'outbox', id: 'h1', host: 'foreign' } },
    { place: 'today', at: '123' },
    { place: 'review', at: 'garbage' },
    { place: 'review', thread: 's1', at: '123' },
    { view: 'prep', workspaceId: 'w1' },
    { view: 'files', workspaceId: 'w1', at: 'garbage' },
    { view: 'files' },
    {},
  ])('refuses a target outside the strict contract: %j', async (target) => {
    const h = rig()
    expect(ClientRequestSchema.safeParse({ id: '1', method: 'work.reveal', params: { target } }).success).toBe(false)
    await expect(h.ask(target)).rejects.toThrow(REVEAL_INVALID)
    expect(h.open).not.toHaveBeenCalled()
  })

  it('rejects extra params outside target too', async () => {
    const h = rig()
    await expect(reveal(h.deps, { target: { thread: 's1' }, host: 'foreign' }, PRESS)).rejects.toThrow(REVEAL_INVALID)
    expect(h.open).not.toHaveBeenCalled()
  })

  it.each([REVEAL_LOCKED, REVEAL_NO_WINDOW])('returns the window’s refusal: %s', async (unavailable) => {
    const h = rig({ unavailable })
    await expect(h.ask({ thread: 's1' })).rejects.toThrow(unavailable)
    expect(h.open).not.toHaveBeenCalled()
  })

  it('refuses a reveal directly to the box in words', async () => {
    const h = rig({ box: true })
    await expect(h.ask({ thread: 's1' })).rejects.toThrow(REVEAL_NO_DESKTOP)
    expect(h.open).not.toHaveBeenCalled()
  })

  it('requires real admin for administrative Settings pages', async () => {
    const h = rig()
    const target = { settings: 'connections' }
    await expect(h.ask(target)).rejects.toThrow(REVEAL_ADMIN)
    await expect(h.ask(target, key('device', 'approve', 'admin'))).rejects.toThrow(REVEAL_ADMIN)
    expect(h.open).not.toHaveBeenCalled()
    await expect(h.ask(target, ADMIN)).resolves.toEqual({ opened: true })
  })

  it('keeps owner LifeOS views from a device key that cannot read them', async () => {
    const h = rig()
    const device = key('device', 'approve')
    await expect(h.ask({ view: 'agenda', workspaceId: 'w1', at: 'e1' }, device)).rejects.toThrow(UNAVAILABLE)
    await expect(h.ask({ place: 'today' }, device)).rejects.toThrow(UNAVAILABLE)
    expect(h.query).not.toHaveBeenCalled()
    expect(h.open).not.toHaveBeenCalled()
    await expect(h.ask({ view: 'files', workspaceId: 'w1' }, device)).resolves.toEqual({ opened: true })
  })

  it('refuses LifeOS-held refs before reading the Outbox for a given computer', async () => {
    const h = rig()
    const held = vi.spyOn(h.deps, 'held')
    const device = key('device', 'approve')
    await expect(h.ask({ held: { at: 'lifeos', table: 'outbox', id: 'h1' } }, device)).rejects.toThrow(UNAVAILABLE)
    expect(held).not.toHaveBeenCalled()
    expect(h.open).not.toHaveBeenCalled()
    await expect(h.ask({ held: { at: 'host', id: 'h1' } }, device)).resolves.toEqual({ opened: true })
  })

  it.each([
    { at: 'mail', threadId: 'm1', messageId: 'message', partId: 'part', name: 'Sheet' },
    { at: 'lifeos', table: 'sheets', id: 'row' },
  ] as const)('refuses a given computer before reading a %j canvas source', async (source) => {
    const h = rig()
    const item = h.deps.ctx.canvas.get('thread-item')!
    vi.spyOn(h.deps.ctx.canvas, 'get').mockReturnValue({ ...item, source })
    await expect(h.ask({ item: item.id }, key('device', 'approve'))).rejects.toThrow(UNAVAILABLE)
    expect(h.query).not.toHaveBeenCalled()
    expect(h.open).not.toHaveBeenCalled()
    await expect(h.ask({ item: item.id })).resolves.toEqual({ opened: true })
  })

  it('opens the Mac-only Computer use Settings page only on a Mac', async () => {
    const windows = rig({ platform: 'win32' })
    await expect(windows.ask({ settings: 'computer' }, ADMIN)).rejects.toThrow(UNAVAILABLE)
    expect(windows.open).not.toHaveBeenCalled()
    await expect(rig().ask({ settings: 'computer' }, ADMIN)).resolves.toEqual({ opened: true })
  })

  it('opens Handoff destinations under the local read rules and still requires that IDs exist', async () => {
    const h = rig({ scoped: true })
    await expect(h.ask({ thread: 's2' }, LOCAL_PRINCIPAL)).resolves.toEqual({ opened: true })
    await expect(h.ask({ thread: 'missing' }, LOCAL_PRINCIPAL)).rejects.toThrow(UNAVAILABLE)
    expect(h.open).toHaveBeenCalledTimes(1)
  })

  it('refuses Work views when Work is off', async () => {
    const h = rig({ off: true })
    await expect(h.ask({ view: 'files', workspaceId: 'w1' })).rejects.toThrow('Work is off on this host')
    expect(h.open).not.toHaveBeenCalled()
  })

  it('does not dispatch after the caller disconnects during a read', async () => {
    const h = rig()
    const controller = new AbortController()
    const reply = reveal(h.deps, { target: { item: 'i1' } }, PRESS, controller.signal)
    controller.abort()
    await expect(reply).rejects.toThrow('The connection closed before the destination opened.')
    expect(h.open).not.toHaveBeenCalled()
  })
})
