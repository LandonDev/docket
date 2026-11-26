import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configure } from 'aliax-core'
import type { RunningServer } from './index'
import { CANCEL_REFUSED } from './lane'
import { setLagForTests } from './stalls'

/**
 * `request.cancel` on a real server (lane.ts, index.ts): the loop's lag is
 * read high, so the bulk gate holds every search. A cancel names only a read
 * its own socket sent; another socket's id is refused and changes nothing;
 * a cancelled read's answer never goes out, while a socket that joined the
 * same read still gets it.
 */
type Frame = { id?: string; ok?: boolean; result?: unknown; error?: string; push?: string }

let root: string
let repo: string
let server: RunningServer

async function socket(): Promise<{ send: (frame: object) => void; frames: Frame[]; answer: (id: string, ms?: number) => Promise<Frame | null>; close: () => void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`)
  const frames: Frame[] = []
  const hello = Promise.withResolvers<void>()
  ws.onmessage = (m) => {
    const frame = JSON.parse(String(m.data)) as Frame
    if (frame.push === 'hello') hello.resolve()
    if (!frame.push) frames.push(frame)
  }
  ws.onerror = () => hello.reject(new Error('socket error'))
  await hello.promise
  const answer = async (id: string, ms = 5_000): Promise<Frame | null> => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      const frame = frames.find((f) => f.id === id)
      if (frame) return frame
      await new Promise((r) => setTimeout(r, 20))
    }
    return null
  }
  return { send: (frame) => ws.send(JSON.stringify(frame)), frames, answer, close: () => ws.close() }
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'tc-request-cancel-'))
  repo = join(root, 'repo')
  mkdirSync(repo)
  writeFileSync(join(repo, 'a.txt'), 'the needle is here\n')
  process.env.TEMP_CODE_WARM_HARNESS = '0'
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
  setLagForTests(null)
  await server?.close()
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('request.cancel', () => {
  it("drops its own socket's waiting read unanswered, refuses another socket's id, and leaves a joined asker its answer", async () => {
    const a = await socket()
    const b = await socket()
    const search = { method: 'search.project', params: { options: { cwd: repo, query: 'needle' } } }
    setLagForTests({ meanMs: 400, maxMs: 2_000, ewmaMs: 400 })
    try {
      a.send({ id: 'a1', ...search })
      b.send({ id: 'b1', ...search })
      // B names A's request id: refused, nothing changed.
      b.send({ id: 'b2', method: 'request.cancel', params: { id: 'a1' } })
      expect(await b.answer('b2')).toEqual({ id: 'b2', ok: false, error: CANCEL_REFUSED })
      // A names its own: dropped.
      a.send({ id: 'a2', method: 'request.cancel', params: { id: 'a1' } })
      expect(await a.answer('a2')).toEqual({ id: 'a2', ok: true, result: { cancelled: true } })
      // An id the socket never sent, and a read outside the bulk lane, are refused.
      a.send({ id: 'a3', method: 'request.cancel', params: { id: 'nothing' } })
      expect((await a.answer('a3'))?.error).toBe(CANCEL_REFUSED)
    } finally {
      setLagForTests(null)
    }
    // B joined the same read: it still runs, and B hears it.
    const joined = await b.answer('b1')
    expect(joined?.ok).toBe(true)
    expect((joined?.result as { matches: { relative: string }[] }).matches.map((m) => m.relative)).toEqual(['a.txt'])
    // A's answer is never sent.
    await new Promise((r) => setTimeout(r, 300))
    expect(a.frames.some((f) => f.id === 'a1')).toBe(false)
    a.close()
    b.close()
  }, 30_000)
})
