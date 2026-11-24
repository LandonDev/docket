import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configure } from 'aliax-core'
import type { RunningServer } from './index'
import { remoteSocketUrl } from '../../../scripts/lib/connectProbe'

/**
 * A folded create on a real server (createSteps.ts): the hello names `create.steps`, and each step meets the caller's
 * key and the path fence as its own request would. A key that may not approve gets no bridge; a file outside the roots
 * does not open; the first message is the thread's first row all the same, in the one request.
 */
let root: string
let server: RunningServer
let key: string
let projectId: string

type Frame = { id?: string; ok?: boolean; result?: unknown; error?: string; push?: string; features?: string[] }

async function client(url: string): Promise<{ hello: Promise<Frame>; requests: () => number; request: (method: string, params: unknown) => Promise<Frame>; close: () => void }> {
  const ws = new WebSocket(url)
  let sayHello: (f: Frame) => void = () => undefined
  const hello = new Promise<Frame>((r) => (sayHello = r))
  const pending = new Map<string, (f: Frame) => void>()
  ws.addEventListener('message', (m) => {
    const frame = JSON.parse(String(m.data)) as Frame
    if (frame.push === 'hello') sayHello(frame)
    else if (!frame.push && frame.id) pending.get(frame.id)?.(frame)
  })
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new Error('socket error')), { once: true })
  })
  let next = 0
  return {
    hello,
    requests: () => next,
    request: (method, params) =>
      new Promise((r) => {
        const id = String(++next)
        pending.set(id, r)
        ws.send(JSON.stringify({ id, method, params }))
      }),
    close: () => ws.close()
  }
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'tc-create-steps-'))
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
  // No harness here: a send stores its row and holds the message for a boot that fails.
  ;(server.registry as unknown as { handleFor: () => Promise<never> }).handleFor = () => Promise.reject(new Error('no harness in this test'))
  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  const workspace = await server.registry.createWorkspace(repo, 'steps')
  projectId = (await server.registry.createProject(workspace.id, 'steps', 'local')).id
  key = (await server.remoteAuth.createKey({ name: 'create-steps', audience: 'client', caps: ['operate'], createdBy: 'local' })).token
}, 60_000)
afterAll(async () => {
  await server?.close()
  rmSync(root, { recursive: true, force: true })
})

describe('a folded create on a real host', () => {
  it("names create.steps in its hello, and runs each step under the caller's key and the fence", async () => {
    const remote = await client(await remoteSocketUrl(`http://127.0.0.1:${server.remote!.port}`, key))
    try {
      expect((await remote.hello).features).toContain('create.steps')
      const made = await remote.request('session.create', {
        id: 'folded-1',
        projectId,
        threadType: 'chat',
        firstMessage: 'What does this say?',
        bridge: { macPeer: 'mac-1' },
        items: [{ kind: 'document', source: { at: 'file', host: server.environmentId, path: '/etc/hosts' }, title: 'hosts' }]
      })
      expect(made.ok, made.error).toBe(true)
      expect(remote.requests()).toBe(1)
      const reply = made.result as { id: string; itemsFailed?: { title: string; error: string }[] }
      expect(reply.id).toBe('folded-1')
      // The fence refused the file to this key, as it refuses work.canvas.open; the message went all the same.
      expect(reply.itemsFailed).toEqual([{ title: 'hosts', error: 'forbidden: work.canvas.open is outside app-managed roots' }])
      const users = server.registry
        .eventsAfter('folded-1', 0)
        .flatMap((r) => (r.event.type === 'user-text' ? [r.event.text] : []))
      expect(users).toEqual(['What does this say?'])
      // An operate key may not set the bridge (approve): the thread has none.
      const bridge = await remote.request('macBridge.thread.get', { sessionId: 'folded-1' })
      expect((bridge.result as { macPeer: string | null }).macPeer).toBeNull()
    } finally {
      remote.close()
    }
  })
})
