import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { configure } from 'aliax-core'
import { WebSocket } from 'ws'
import type { RunningServer } from './index'

/**
 * The app bridge's token on a real server: an app.* call answers only for the
 * thread whose own token it carries, and the real bridge script never lets a
 * tool argument name another thread.
 */
const bridgePath = join(import.meta.dirname, '..', '..', '..', 'scripts', 'app-mcp-bridge.mjs')
let root: string
let server: RunningServer
let bridgeEnv: (sessionId: string) => Record<string, string>

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'tc-app-bridge-server-'))
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
  // the server sets the bridge up only when its script is where the app is
  mkdirSync(join(root, 'scripts'))
  writeFileSync(join(root, 'scripts', 'app-mcp-bridge.mjs'), '')
  const { startServer } = await import('./index')
  const { bridgeMcpConfig } = await import('./apptools')
  server = await startServer(join(root, 'app.db'), { claimShim: false, remotePort: 0, appPath: root })
  bridgeEnv = (sessionId) => (bridgeMcpConfig(sessionId) as { env: Record<string, string> }).env
}, 60_000)
afterAll(async () => {
  await server.close()
  rmSync(root, { recursive: true, force: true })
})

type Frame = { ok: boolean; result?: unknown; error?: string }
async function local(): Promise<{ request: (method: string, params?: unknown) => Promise<Frame>; close: () => void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`)
  await once(ws, 'open')
  let next = 1
  const pending = new Map<string, (frame: Frame) => void>()
  ws.on('message', (d) => {
    const frame = JSON.parse(String(d))
    if (!frame.push) pending.get(frame.id)?.(frame)
  })
  return {
    request: (method, params) =>
      new Promise((r) => {
        const id = String(next++)
        pending.set(id, r)
        ws.send(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }))
      }),
    close: () => ws.close()
  }
}

async function thread(title: string): Promise<string> {
  const me = await local()
  const made = await me.request('session.create', { provider: 'codex', model: 'gpt-6.1-sol', cwd: root, title })
  me.close()
  expect(made.ok, made.error).toBe(true)
  return (made.result as { id: string }).id
}

describe('the app bridge token on a running host', () => {
  it("answers an app.* call only with the named thread's own token", async () => {
    const a = await thread('A')
    const b = await thread('B')
    const tokenA = bridgeEnv(a).TEMP_CODE_APP_TOKEN
    expect(tokenA).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(bridgeEnv(b).TEMP_CODE_APP_TOKEN).not.toBe(tokenA)
    const me = await local()
    expect(await me.request('app.listThreads', { sessionId: a, appToken: tokenA })).toMatchObject({ ok: true })
    // A's token naming B: B's notes, B's threads, B's agents are never A's to reach
    for (const [method, params] of [
      ['app.listThreads', {}],
      ['app.updateNotes', { section: 'State', content: 'written as B' }],
      ['app.listAgents', {}]
    ] as const) {
      expect(await me.request(method, { ...params, sessionId: b, appToken: tokenA })).toEqual({
        id: expect.any(String),
        ok: false,
        error: `forbidden: ${method} needs the calling thread's own app token`
      })
    }
    expect(await me.request('app.listThreads', { sessionId: a })).toMatchObject({ ok: false, error: "forbidden: app.listThreads needs the calling thread's own app token" })
    expect(await me.request('app.listThreads', { sessionId: a, appToken: 'guess' })).toMatchObject({ ok: false })
    // every other method is as it was
    expect(await me.request('session.list', {})).toMatchObject({ ok: true })
    me.close()
  })

  it('the real bridge answers as its own thread, whatever a tool argument names', async () => {
    const a = await thread('Bridge A')
    const b = await thread('Bridge B')
    const child = spawn(process.execPath, [bridgePath], { env: { ...process.env, ...bridgeEnv(a) }, stdio: ['pipe', 'pipe', 'pipe'] })
    const replies = new Map<number, (reply: { result: { content: { text: string }[]; isError?: boolean } }) => void>()
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      const reply = JSON.parse(line)
      replies.get(reply.id)?.(reply)
    })
    onTestFinished(async () => {
      const exited = once(child, 'exit')
      child.kill()
      await exited
      lines.close()
    })
    let id = 0
    const call = (name: string, args: Record<string, unknown>) =>
      new Promise<{ result: { content: { text: string }[]; isError?: boolean } }>((resolve) => {
        replies.set(++id, resolve)
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n')
      })
    const named = await call('update_notes', { section: 'State', content: 'as B', sessionId: b })
    expect(named.result).toEqual({
      content: [{ type: 'text', text: 'refused: update_notes has no argument "sessionId". It takes section, mode, content.' }],
      isError: true
    })
    const token = await call('app_list_threads', { appToken: bridgeEnv(b).TEMP_CODE_APP_TOKEN })
    expect(token.result.isError).toBe(true)
    // its own call reaches the app as its own thread: the decision is A's, and B has none
    expect((await call('note_decision', { decision: 'chose the left road' })).result).toEqual({ content: [{ type: 'text', text: 'noted' }] })
    const me = await local()
    expect(await me.request('app.noteDecision', { sessionId: a, appToken: bridgeEnv(a).TEMP_CODE_APP_TOKEN, decision: 'chose the left road' })).toMatchObject({ result: 'already noted' })
    expect(await me.request('app.noteDecision', { sessionId: b, appToken: bridgeEnv(b).TEMP_CODE_APP_TOKEN, decision: 'chose the left road' })).toMatchObject({ result: 'noted' })
    me.close()
  })
})
