import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

/** A box browser started again has a new pid: the service says so (`apps/changed`), so the host's sessions drop the old one (P2, 2026-11-24). */

const conns: { alive: boolean }[] = []
vi.mock('./cdp', () => ({
  Cdp: {
    open: async () => {
      const c = { alive: true, on: () => () => {}, onClose: () => {}, send: async () => ({}), close: () => {} }
      conns.push(c)
      return c
    }
  }
}))

const { BoxComputerService } = await import('./service')

describe('the box service after its browser restarts', () => {
  it('tells apps/changed with the new pid, and nothing on the first connection', async () => {
    let pid = 100
    const service = new BoxComputerService({ browser: { endpoint: async () => 'ws://127.0.0.1:1/x', pid: () => pid, touch: () => {} } })
    const input = new PassThrough()
    const output = new PassThrough()
    const frames: { method?: string; params?: { pid?: number; change?: string } }[] = []
    output.on('data', (b: Buffer) => b.toString().split('\n').filter(Boolean).forEach((l) => frames.push(JSON.parse(l))))
    void service.serve(input, output)
    const connect = () => (service as unknown as { connect(): Promise<unknown> }).connect()
    await connect()
    expect(frames).toEqual([])
    // the browser quit and was started again
    conns.at(-1)!.alive = false
    pid = 200
    await connect()
    await new Promise((r) => setImmediate(r))
    expect(frames).toEqual([{ jsonrpc: '2.0', method: 'apps/changed', params: { pid: 200, bundleId: 'org.chromium.Chromium', name: 'Chromium', change: 'launched' } }])
    input.end()
  })
})
