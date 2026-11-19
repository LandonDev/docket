import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_PRINCIPAL } from '@shared/capabilities'
import type { ClientRequest } from '@shared/contract'
import type { WorkDeps } from './ctx'

/**
 * Work's own mount failing to load, or to start, never stops the host: it
 * gets an inert Work that reads off, answers why, lists no tool and leaves
 * every method that is not Work's to the rest of the router.
 */

const req = (method: string, params?: unknown): ClientRequest => ({ id: '1', method, params }) as ClientRequest
const deps = {} as WorkDeps
let said: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.resetModules()
  said = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.doUnmock('./ctx')
  vi.doUnmock('./modules')
  vi.restoreAllMocks()
})

async function inertFrom(mock: () => void): Promise<import('./ctx').Work> {
  mock()
  const { loadWork } = await import('./load')
  const loader = await loadWork()
  return loader.start(deps)
}

describe('an inert Work', () => {
  it('stands in when the mount cannot be loaded', async () => {
    const work = await inertFrom(() =>
      vi.doMock('./ctx', () => {
        throw new Error('a part needs a library this machine lacks')
      })
    )
    const why = /^work: Work did not load on this host: .*a part needs a library this machine lacks/
    expect(String(said.mock.calls[0][0])).toMatch(/^\[work\] work: Work did not load on this host: /)
    // off, and unable to be turned on
    expect(await work.handle(req('work.get'), LOCAL_PRINCIPAL)).toEqual({ handled: true, result: { enabled: false } })
    await expect(work.handle(req('work.set', { enabled: true }), LOCAL_PRINCIPAL)).rejects.toThrow(why)
    await expect(work.handle(req('work.mail.list', {}), LOCAL_PRINCIPAL)).rejects.toThrow(why)
    // a bridge hears no tool and no thread is listed one
    expect(await work.handle(req('app.workTools', { sessionId: 's', token: 't' }), LOCAL_PRINCIPAL)).toEqual({ handled: true, result: { tools: [] } })
    expect(work.tools.of({ id: 's', scope: 'work' })).toBeNull()
    expect(work.tools.listing({ id: 's', scope: 'work' })).toEqual([])
    expect(work.tools.checkToken('s', '')).toBe(false)
    // what is not Work's is left to the rest of the router, and a code create never reaches these
    expect(await work.handle(req('session.list', {}), LOCAL_PRINCIPAL)).toEqual({ handled: false })
    expect(() => work.admitSession({ scope: 'work' } as never, { kind: 'local', caps: [] })).toThrow(why)
    expect(() => work.createWorkspace({ name: 'Purdue' }, { kind: 'local', caps: [] })).toThrow(why)
    expect(() => work.settings.enabled()).toThrow(why)
    const off = work.pushes.onPush(() => {})
    expect(() => off()).not.toThrow()
    expect(() => work.close()).not.toThrow()
  })

  it('stands in when the registry cannot be loaded', async () => {
    const work = await inertFrom(() =>
      vi.doMock('./modules', () => {
        throw new Error('bad registry')
      })
    )
    await expect(work.handle(req('work.set', { enabled: true }), LOCAL_PRINCIPAL)).rejects.toThrow(/^work: Work did not load on this host: /)
  })

  it('stands in when the mount loads and then throws as it starts', async () => {
    const work = await inertFrom(() =>
      vi.doMock('./ctx', () => ({
        startWork: () => {
          throw new Error('the settings table is gone')
        }
      }))
    )
    await expect(work.handle(req('work.set', { enabled: true }), LOCAL_PRINCIPAL)).rejects.toThrow('work: Work did not start on this host: the settings table is gone')
    expect(await work.handle(req('work.get'), LOCAL_PRINCIPAL)).toEqual({ handled: true, result: { enabled: false } })
  })
})
