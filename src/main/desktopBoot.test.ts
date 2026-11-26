import { describe, expect, it } from 'vitest'
import { bootDesktop, deferred, type DesktopBoot } from './desktopBoot'

/** The boot as a list of what ran, with the server's start held open until the test lets it end. */
function harness(o: { headless?: boolean; guard?: boolean } = {}) {
  const steps: string[] = []
  const server = deferred<string>()
  const firstUp = deferred<void>()
  let windowAtServerStart: Promise<void> | null = null
  const later = async (name: string): Promise<void> => {
    await Promise.resolve()
    steps.push(name)
  }
  const boot: DesktopBoot<string> = {
    headless: o.headless ?? false,
    guard: () => (steps.push('guard'), o.guard ?? true),
    beforeReady: () => void steps.push('schemes'),
    ready: () => later('ready'),
    prepare: () => void steps.push('handlers'),
    migrateLocalStorage: () => later('localStorage migrated'),
    registerOfficeLive: () => void steps.push('officeLive'),
    readMirror: () => void steps.push('mirror read'),
    openWindows: () => {
      steps.push('window made')
      return firstUp.promise
    },
    startServer: (windowUp) => {
      steps.push('server-start')
      windowAtServerStart = windowUp
      return server.promise.then((s) => (steps.push('server-start ended'), s))
    },
    serverFailed: (err) => void steps.push(`server failed: ${(err as Error).message}`),
    serverUp: (s) => void steps.push(`server up ${s}`)
  }
  return { steps, server, firstUp, boot, windowUp: () => windowAtServerStart }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('the desktop boot order', () => {
  it('makes the window before the server starts, after the walls, the migration and the Office fence', async () => {
    const h = harness()
    const done = bootDesktop(h.boot)
    await flush()
    // the server is still starting, and the window already exists
    expect(h.steps).toEqual(['guard', 'schemes', 'ready', 'handlers', 'localStorage migrated', 'officeLive', 'mirror read', 'window made', 'server-start'])
    h.server.resolve('S')
    expect(await done).toBe('S')
    expect(h.steps.slice(-2)).toEqual(['server-start ended', 'server up S'])
  })

  it('hands the server the first window being up, so Work loads only after it (load.ts)', async () => {
    const h = harness()
    void bootDesktop(h.boot)
    await flush()
    let up = false
    void h.windowUp()!.then(() => (up = true))
    await flush()
    expect(up).toBe(false)
    h.firstUp.resolve()
    await flush()
    expect(up).toBe(true)
    h.server.resolve('S')
  })

  it('a refused guard (a dev build without TEMP_CODE_USER_DATA, a second instance) makes nothing at all', async () => {
    const h = harness({ guard: false })
    expect(await bootDesktop(h.boot)).toBeNull()
    expect(h.steps).toEqual(['guard'])
  })

  it('a headless host makes no window and starts its server after its handlers', async () => {
    const h = harness({ headless: true })
    const done = bootDesktop(h.boot)
    await flush()
    expect(h.steps).toEqual(['guard', 'schemes', 'ready', 'handlers', 'server-start'])
    h.server.resolve('S')
    await done
  })

  it('a server that does not start settles what waits for it and ends the boot, never reaching serverUp', async () => {
    const h = harness()
    const done = bootDesktop(h.boot)
    await flush()
    h.server.reject(new Error('database disk image is malformed'))
    await expect(done).rejects.toThrow('database disk image is malformed')
    expect(h.steps.slice(-2)).toEqual(['server-start', 'server failed: database disk image is malformed'])
    expect(h.steps.some((s) => s.startsWith('server up'))).toBe(false)
  })
})

describe('the deferred the handlers wait on', () => {
  it('a rejection reaches every waiter and none is left unhandled', async () => {
    const d = deferred<number>()
    const waiters = [d.promise.then(() => 'ok'), d.promise.then(() => 'ok')]
    d.reject(new Error('no server'))
    for (const w of waiters) await expect(w).rejects.toThrow('no server')
  })
})

