import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpSdkServerConfigWithInstance, Options } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { z } from 'zod'
import type { SessionMeta } from '@shared/events'
import type { WorkScope, WorkToolListing, WorkToolResult } from '@shared/work'
import { MacThreadTokens } from '../macTools'
import { bridgeMcpConfig, setAppBridge, setAppToolsRegistry, setAppWork, withWorkTools } from '../apptools'
import type { SessionRegistry } from '../sessions'
import type { WorkToolMount } from './ctx'
import type { WorkTool } from './modules'

vi.mock('electron', () => ({ nativeImage: {} }))

/**
 * One mount, three harnesses: a tool a module registers is listed to and run
 * from a Claude thread (its own `work` MCP server), and a Codex and a Muse
 * thread (the bridge, which both spawn from the same config). A code thread
 * of any harness gets nothing new.
 */

const bridgePath = join(import.meta.dirname, '..', '..', '..', '..', 'scripts', 'app-mcp-bridge.mjs')
const scope: WorkScope = { sessionId: 't-work', workspaceId: 'w1', sector: 'purdue', host: 'env_test', away: false, routineRunId: null, shared: () => false }
const ran: { session: string; name: string; args: unknown }[] = []
const tool: WorkTool = {
  name: 'mail_fake_search',
  description: 'Search mail in purdue',
  input: z.object({ query: z.string().describe('what to look for') }),
  readOnly: true,
  run: async () => ({ content: [] })
}
/** The mount as work/ctx.ts builds it, reduced to what the harness side asks of it. */
const mount: WorkToolMount = {
  of: (session) => (session.scope === 'work' ? { scope, tools: [tool] } : null),
  listing: (session) => (session.scope === 'work' ? [{ name: tool.name, description: tool.description, readOnly: true, inputSchema: z.toJSONSchema(tool.input) as Record<string, unknown> }] : []),
  call: async (session, name, args) => {
    if (name === 'mail_fake_fail') throw new Error('the store is down')
    ran.push({ session: session.id, name, args })
    return { content: [{ type: 'text', text: `found for ${(args as { query: string }).query}` }] }
  },
  tokenFor: (id) => `token-of-${id}`,
  checkToken: (id, token) => token === `token-of-${id}`
}
const sessions: Record<string, SessionMeta> = {
  't-work': { id: 't-work', provider: 'claude', scope: 'work' } as SessionMeta,
  't-code': { id: 't-code', provider: 'claude' } as SessionMeta
}

afterEach(() => {
  setAppWork(null)
  setAppBridge(null)
  ran.length = 0
})
const mounted = (): void => {
  setAppToolsRegistry({ get: (id: string) => sessions[id] ?? null } as unknown as SessionRegistry)
  setAppWork({ tools: mount })
}

describe('Claude', () => {
  const baseOptions = (): Options => ({ mcpServers: { app: { type: 'sdk', name: 'app' } as never }, allowedTools: ['mcp__app__app_list_threads'] })
  it("a code thread's options come back as they were, Work mounted or not", () => {
    const before = baseOptions()
    expect(withWorkTools(baseOptions(), sessions['t-code'])).toEqual(before)
    mounted()
    const options = baseOptions()
    expect(withWorkTools(options, sessions['t-code'])).toBe(options)
    expect(options).toEqual(before)
  })
  it('a Work thread gets the tool on a server named work, allowed by its wrapped name, and can run it', async () => {
    mounted()
    const options = withWorkTools(baseOptions(), sessions['t-work'])
    expect(Object.keys(options.mcpServers!)).toEqual(['app', 'work'])
    expect(options.allowedTools).toEqual(['mcp__app__app_list_threads', 'mcp__work__mail_fake_search'])
    const [a, b] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test', version: '1' })
    await (options.mcpServers!.work as McpSdkServerConfigWithInstance).instance.connect(a)
    await client.connect(b)
    const { tools } = await client.listTools()
    expect(tools.map((t) => [t.name, t.description, t.annotations?.readOnlyHint, Object.keys(t.inputSchema.properties ?? {})])).toEqual([
      ['mail_fake_search', 'Search mail in purdue', true, ['query']]
    ])
    const answer = await client.callTool({ name: 'mail_fake_search', arguments: { query: 'budget' } })
    expect(answer.content).toEqual([{ type: 'text', text: 'found for budget' }])
    expect(ran).toEqual([{ session: 't-work', name: 'mail_fake_search', args: { query: 'budget' } }])
    await client.close()
  })
})

describe('Codex and Muse', () => {
  type RpcRequest = { id: string; method: string; params: Record<string, unknown> }
  type McpReply = { id: number; result: { tools: (WorkToolListing & { annotations?: { readOnlyHint?: boolean } })[]; content: WorkToolResult['content']; isError?: boolean } }

  /** The real bridge script, spawned with the env the drivers give it, against a stand-in app server. */
  async function startBridge(env: Record<string, string>, answer: (request: RpcRequest) => unknown) {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(server, 'listening')
    const requests: RpcRequest[] = []
    server.on('connection', (ws: WebSocket) => {
      ws.on('message', (data) => {
        const request = JSON.parse(String(data)) as RpcRequest
        requests.push(request)
        let frame: unknown
        try {
          frame = { id: request.id, ok: true, result: answer(request) }
        } catch (err) {
          frame = { id: request.id, ok: false, error: (err as Error).message }
        }
        ws.send(JSON.stringify(frame))
      })
    })
    const child = spawn(process.execPath, [bridgePath], {
      env: { ...process.env, TEMP_CODE_MAC_TOKEN: '', TEMP_CODE_ADDONS: '', TEMP_CODE_COMPUTER_TOKEN: '', TEMP_CODE_WORK_TOKEN: '', TEMP_CODE_APP_TOKEN: 'app-token', ...env, TEMP_CODE_PORT: String((server.address() as { port: number }).port) },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const replies = new Map<number, (reply: McpReply) => void>()
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      const reply = JSON.parse(line) as McpReply
      replies.get(reply.id)?.(reply)
      replies.delete(reply.id)
    })
    onTestFinished(async () => {
      const exited = once(child, 'exit')
      child.kill()
      await exited
      lines.close()
      for (const ws of server.clients) ws.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    const request = (id: number, method: string, params: Record<string, unknown> = {}) =>
      new Promise<McpReply>((resolve) => {
        replies.set(id, resolve)
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })
    const notify = (method: string, params: Record<string, unknown>): void => void child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
    return { request, notify, requests }
  }

  /** What the stand-in app answers: the mount, behind the same token check work/ctx.ts makes. */
  const app = (request: RpcRequest): unknown => {
    const { sessionId, token } = request.params as { sessionId: string; token: string }
    if (request.method === 'app.workTools') {
      if (!mount.checkToken(sessionId, token)) throw new Error("forbidden: not this thread's Work token")
      return { tools: mount.listing(sessions[sessionId]) }
    }
    if (request.method === 'app.workCall') {
      if (!mount.checkToken(sessionId, token)) throw new Error("forbidden: not this thread's Work token")
      ran.push({ session: sessionId, name: request.params.tool as string, args: request.params.args })
      return { content: [{ type: 'text', text: `found for ${(request.params.args as { query: string }).query}` }] }
    }
    return 'ok'
  }

  const appTokens = new MacThreadTokens(null, 'app-bridge')
  const bridgeEnv = (sessionId: string, opts?: { computerImages?: 'parts' | 'none' }): Record<string, string> => {
    setAppBridge({ port: 1, scriptPath: bridgePath, command: process.execPath, env: {}, tokens: appTokens })
    return (bridgeMcpConfig(sessionId, opts) as { env: Record<string, string> }).env
  }

  it('a code thread\'s bridge config is the same with Work mounted as without, for both harnesses', () => {
    const codexBefore = bridgeEnv('t-code')
    const museBefore = bridgeEnv('t-code', { computerImages: 'parts' })
    mounted()
    expect(bridgeEnv('t-code')).toEqual(codexBefore)
    expect(bridgeEnv('t-code', { computerImages: 'parts' })).toEqual(museBefore)
    expect(codexBefore).not.toHaveProperty('TEMP_CODE_WORK_TOKEN')
  })

  it("a Work thread's bridge config carries its own token, for both harnesses", () => {
    mounted()
    expect(bridgeEnv('t-work').TEMP_CODE_WORK_TOKEN).toBe('token-of-t-work')
    expect(bridgeEnv('t-work', { computerImages: 'parts' }).TEMP_CODE_WORK_TOKEN).toBe('token-of-t-work')
  })

  it('without the token the bridge asks the app nothing new and lists what it listed before', async () => {
    const plain = await startBridge({ TEMP_CODE_SESSION: 't-code' }, app)
    const list = await plain.request(1, 'tools/list')
    expect(plain.requests).toEqual([])
    expect(list.result.tools.some((t) => t.name === 'mail_fake_search')).toBe(false)
    const denied = await plain.request(2, 'tools/call', { name: 'mail_fake_search', arguments: { query: 'q' } })
    expect(denied.result.isError).toBe(true)
    expect(plain.requests).toEqual([])
    // and its list is exactly the list of a bridge that never heard of Work
    const { listedTools } = (await import(bridgePath)) as { listedTools: () => { name: string }[] }
    expect(list.result.tools.map((t) => t.name)).toEqual(listedTools().map((t) => t.name))
  })

  it('with the token the bridge lists the tool once and runs it through app.workCall', async () => {
    mounted()
    const bridge = await startBridge({ TEMP_CODE_SESSION: 't-work', TEMP_CODE_WORK_TOKEN: bridgeEnv('t-work').TEMP_CODE_WORK_TOKEN }, app)
    const [first, second] = await Promise.all([bridge.request(1, 'tools/list'), bridge.request(2, 'tools/list')])
    const listed = first.result.tools.find((t) => t.name === 'mail_fake_search')!
    expect(listed).toEqual({
      name: 'mail_fake_search',
      description: 'Search mail in purdue',
      inputSchema: expect.objectContaining({ type: 'object', required: ['query'] }),
      annotations: { readOnlyHint: true }
    })
    expect(second.result.tools.map((t) => t.name)).toEqual(first.result.tools.map((t) => t.name))
    expect(bridge.requests.map((r) => r.method)).toEqual(['app.workTools'])
    const answer = await bridge.request(3, 'tools/call', { name: 'mail_fake_search', arguments: { query: 'budget' } })
    expect(answer.result.content).toEqual([{ type: 'text', text: 'found for budget' }])
    expect(answer.result.isError).toBeUndefined()
    expect(bridge.requests.at(-1)).toMatchObject({ method: 'app.workCall', params: { sessionId: 't-work', token: 'token-of-t-work', call: 3, tool: 'mail_fake_search', args: { query: 'budget' } } })
    expect(ran).toEqual([{ session: 't-work', name: 'mail_fake_search', args: { query: 'budget' } }])
  })

  it('a list that failed is asked again, so one bad moment does not hide the tools for the thread\'s life', async () => {
    let fail = true
    const bridge = await startBridge({ TEMP_CODE_SESSION: 't-work', TEMP_CODE_WORK_TOKEN: 'token-of-t-work' }, (request) => {
      if (request.method === 'app.workTools' && fail) throw new Error('the host is restarting')
      return app(request)
    })
    expect((await bridge.request(1, 'tools/list')).result.tools.some((t) => t.name === 'mail_fake_search')).toBe(false)
    fail = false
    expect((await bridge.request(2, 'tools/list')).result.tools.some((t) => t.name === 'mail_fake_search')).toBe(true)
    await bridge.request(3, 'tools/list')
    expect(bridge.requests.map((r) => r.method)).toEqual(['app.workTools', 'app.workTools'])
  })

  it("a harness's cancel of a running Work tool reaches the app with the same call id and the thread's token", async () => {
    let release: () => void = () => {}
    const waiting = new Promise<void>((resolve) => (release = resolve))
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(server, 'listening')
    const requests: RpcRequest[] = []
    server.on('connection', (ws: WebSocket) => {
      ws.on('message', (data) => {
        const request = JSON.parse(String(data)) as RpcRequest
        requests.push(request)
        if (request.method === 'app.workTools') ws.send(JSON.stringify({ id: request.id, ok: true, result: { tools: mount.listing(sessions['t-work']) } }))
        // the call stays open until the cancel arrives
        if (request.method === 'app.workCall') void waiting.then(() => ws.send(JSON.stringify({ id: request.id, ok: true, result: { content: [{ type: 'text', text: 'cancelled' }], isError: true } })))
        if (request.method === 'app.workCancel') {
          ws.send(JSON.stringify({ id: request.id, ok: true, result: null }))
          release()
        }
      })
    })
    const child = spawn(process.execPath, [bridgePath], {
      env: { ...process.env, TEMP_CODE_MAC_TOKEN: '', TEMP_CODE_ADDONS: '', TEMP_CODE_COMPUTER_TOKEN: '', TEMP_CODE_SESSION: 't-work', TEMP_CODE_WORK_TOKEN: 'token-of-t-work', TEMP_CODE_APP_TOKEN: 'app-token', TEMP_CODE_PORT: String((server.address() as { port: number }).port) },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const lines = createInterface({ input: child.stdout })
    const replies: McpReply[] = []
    lines.on('line', (line) => replies.push(JSON.parse(line) as McpReply))
    onTestFinished(async () => {
      const exited = once(child, 'exit')
      child.kill()
      await exited
      lines.close()
      for (const ws of server.clients) ws.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    const send = (msg: Record<string, unknown>): void => void child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
    send({ id: 41, method: 'tools/call', params: { name: 'mail_fake_search', arguments: { query: 'slow' } } })
    await vi.waitFor(() => expect(requests.some((r) => r.method === 'app.workCall')).toBe(true))
    send({ method: 'notifications/cancelled', params: { requestId: 41 } })
    await vi.waitFor(() => expect(replies.some((r) => r.id === 41)).toBe(true))
    expect(requests.find((r) => r.method === 'app.workCancel')).toMatchObject({ params: { sessionId: 't-work', token: 'token-of-t-work', call: 41 } })
    expect(replies.find((r) => r.id === 41)!.result.isError).toBe(true)
    // a cancel of a call that is not a running Work tool asks the app nothing
    send({ method: 'notifications/cancelled', params: { requestId: 99 } })
    send({ id: 42, method: 'ping' })
    await vi.waitFor(() => expect(replies.some((r) => r.id === 42)).toBe(true))
    expect(requests.filter((r) => r.method === 'app.workCancel')).toHaveLength(1)
  })

  it("a bridge holding another thread's token lists nothing of Work", async () => {
    const bridge = await startBridge({ TEMP_CODE_SESSION: 't-work', TEMP_CODE_WORK_TOKEN: 'token-of-t-other' }, app)
    const list = await bridge.request(1, 'tools/list')
    expect(list.result.tools.some((t) => t.name === 'mail_fake_search')).toBe(false)
    expect(bridge.requests.map((r) => r.method)).toEqual(['app.workTools'])
  })
})
