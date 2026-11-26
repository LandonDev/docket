import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { configure } from 'aliax-core'
import type { RunningServer } from '../index'

/** Work's code is asked for only once `workAfter` settles (index.ts: the first window up, while Work is off here). */
const loads = vi.hoisted(() => ({ n: 0 }))
vi.mock('./load', async (original) => {
  const real = await original<typeof import('./load')>()
  return {
    ...real,
    loadWork: () => {
      loads.n++
      return real.loadWork()
    }
  }
})

let root: string
let server: RunningServer | null = null
afterAll(async () => {
  await server?.close()
  rmSync(root, { recursive: true, force: true })
})

describe('the server boot with Work off here', () => {
  it('opens the database and builds the host while Work waits, and loads Work once the window is up', async () => {
    root = mkdtempSync(join(tmpdir(), 'tc-work-after-'))
    configure({
      dataDir: join(root, 'aliax'),
      fetch: async () => {
        throw new Error('no network in tests')
      },
      secrets: { mode: 'chromiumKey', keychainItem: 'Test Safe Storage' },
      appName: 'temp-code-test'
    })
    mkdirSync(join(root, 'out', 'renderer'), { recursive: true })
    writeFileSync(join(root, 'out', 'renderer', 'index.html'), '<!doctype html><html><body></body></html>')
    const { startServer } = await import('../index')
    let windowUp!: () => void
    const workAfter = new Promise<void>((resolve) => (windowUp = resolve))
    let started = false
    const booting = startServer(join(root, 'app.db'), { claimShim: false, remotePort: 0, appPath: root, workAfter }).then((s) => {
      started = true
      return s
    })
    // the host's own boot runs up to Work's gate meanwhile; the count, not the wait, is what is held
    await new Promise((r) => setTimeout(r, 300))
    expect(loads.n).toBe(0)
    expect(started).toBe(false)
    windowUp()
    server = await booting
    expect(loads.n).toBe(1)
  }, 60_000)
})
