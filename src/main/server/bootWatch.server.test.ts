import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { configure } from 'aliax-core'
import { WebSocket } from 'ws'
import type { RunningServer } from './index'

/**
 * A boot on a host whose inotify watches are spent: every fs.watch throws
 * ENOSPC, as on the box on 2026-11-23 when a deploy's trial could not start.
 * The server still opens its socket and its remote port, answers, and
 * doctor.get names each refused watch.
 */
const { refused, enospc } = vi.hoisted(() => {
  const refused = { calls: 0 }
  const enospc = (): never => {
    refused.calls++
    throw Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), { code: 'ENOSPC' })
  }
  return { refused, enospc }
})
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return { ...real, default: { ...real, watch: enospc }, watch: enospc }
})
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>()
  return { ...real, default: { ...real, watch: enospc }, watch: enospc }
})

let root: string
let server: RunningServer

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'tc-boot-watch-'))
  process.env.TEMP_CODE_WARM_HARNESS = '0'
  mkdirSync(join(root, 'aliax'), { recursive: true })
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
  const { startServer } = await import('./index')
  server = await startServer(join(root, 'app.db'), { claimShim: false, remotePort: 0, appPath: root })
}, 60_000)

afterAll(async () => {
  await server?.close()
  rmSync(root, { recursive: true, force: true })
})

async function ask(method: string, params?: unknown): Promise<{ ok: boolean; result?: unknown }> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`)
  await once(ws, 'open')
  ws.send(JSON.stringify({ id: '1', method, ...(params === undefined ? {} : { params }) }))
  for (;;) {
    const [data] = (await once(ws, 'message')) as [Buffer]
    const frame = JSON.parse(String(data)) as { id?: string; ok: boolean; result?: unknown }
    if (frame.id === '1') {
      ws.close()
      return frame
    }
  }
}

describe('a boot with every watch refused', () => {
  it('opens its socket and its remote port and answers', async () => {
    expect((await ask('session.list')).ok).toBe(true)
    const health = await fetch(`http://127.0.0.1:${server.remote!.port}/healthz`)
    expect(await health.text()).toBe('ok')
  })

  it('names each refused watch in doctor.get, with what covers it', async () => {
    expect(refused.calls).toBeGreaterThan(0)
    const doctor = (await ask('doctor.get')).result as { watchFailures?: { what: string; error: string; fallback: string }[] }
    expect(doctor.watchFailures?.length).toBeGreaterThan(0)
    for (const f of doctor.watchFailures ?? []) {
      expect(f.error).toBe('ENOSPC')
      expect(f.fallback).not.toBe('')
    }
  })
})
