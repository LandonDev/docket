import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { query, type Options } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { SessionMeta } from '@shared/events'
import type { WorkScope } from '@shared/work'
import { openDb, Store } from '../db'
import type { DriverHandle } from '../drivers/types'
import type { SessionRegistry } from '../sessions'
import type { WorkModule } from './modules'

vi.mock('electron', () => ({ nativeImage: {} }))
vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: vi.fn()
}))
vi.mock('../drivers/binaries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../drivers/binaries')>()),
  resolveClaude: async () => ({ path: null })
}))
vi.mock('../endpoint', () => ({ routedEndpointFor: async () => ({ url: null }) }))
// The mount alone: here every thread that asks has a scope, so only the row's own `scope` keeps a code thread out.
vi.mock('./scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./scope')>()),
  scopePart: () => ({
    scopeOf: (id: string): WorkScope => ({ sessionId: id, workspaceId: 'w1', sector: 'purdue', host: 'env_test', away: false, routineRunId: null, shared: () => false }),
    createWorkspace: async () => {
      throw new Error('not in this test')
    },
    admitSession: () => {}
  })
}))

const { claudeDriver, WORK_DENIED_TOOLS } = await import('../drivers/claude')
const { setAppWork } = await import('../apptools')
const { startWork } = await import('./ctx')

/**
 * The Claude driver's spawn with the real Work mount in place: Work on, a
 * module that registers a tool for every scope it is asked about. A code
 * thread's servers and allowed tools are what they are with no Work at all;
 * a Work thread gains the one `work` server.
 */

const mail: WorkModule = {
  id: 'mail',
  ensure() {},
  tools: () => [{ name: 'mail_fake_search', description: 'Search', input: z.object({ query: z.string() }), readOnly: true, run: async () => ({ content: [] }) }]
}

let dir: string
let db: ReturnType<typeof openDb>
let work: ReturnType<typeof startWork>
const handles: DriverHandle[] = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-work-claude-'))
  db = openDb(join(dir, 'test.db'))
  work = startWork({ db, store: new Store(db), registry: { get: () => null } as unknown as SessionRegistry, environmentId: 'env_test', dataDir: dir, log: () => {} }, [mail])
})
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.dispose()
  setAppWork(null)
  work.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const session = (over: Partial<SessionMeta> = {}): SessionMeta =>
  ({ id: 'cw-1', provider: 'claude', cwd: '/repo', model: 'claude-opus-5-5', reasoning: 'high', permission: 'edits', context1m: false, nativeId: null, threadType: 'chat', ...over }) as SessionMeta

async function spawnOptions(over: Partial<SessionMeta> = {}): Promise<Options> {
  vi.mocked(query).mockImplementation(({ prompt }) => (async function* () {
    if (typeof prompt !== 'string') for await (const _message of prompt) { /* No CLI output. */ }
  })() as ReturnType<typeof query>)
  const handle = await claudeDriver.start({ session: session(over), emit: () => {}, setNativeId: () => {}, requestApproval: async () => false })
  handles.push(handle)
  return vi.mocked(query).mock.calls.at(-1)![0].options!
}
/** What a thread can call: its servers and the tools allowed without a prompt. */
const toolSurface = (options: Options) => ({
  servers: Object.keys(options.mcpServers ?? {}).sort(),
  allowed: [...(options.allowedTools ?? [])].sort(),
  disallowed: [...(options.disallowedTools ?? [])].sort()
})

it("a code thread's tool surface is the same with no Work, with Work mounted and off, and with Work on and a module's tools registered", async () => {
  for (const over of [{}, { id: 'cw-2', agentType: 'orchestrator' as const }, { id: 'cw-3', threadType: 'planning' as const }, { id: 'cw-4', scope: 'code' as const }]) {
    setAppWork(null)
    const today = toolSurface(await spawnOptions(over))
    setAppWork({ tools: work.tools })
    work.settings.set({ enabled: false })
    expect(toolSurface(await spawnOptions(over)), `off ${JSON.stringify(over)}`).toEqual(today)
    work.settings.set({ enabled: true })
    expect(toolSurface(await spawnOptions(over)), `on ${JSON.stringify(over)}`).toEqual(today)
    expect(today.servers).not.toContain('work')
    expect(today.allowed.some((t) => t.startsWith('mcp__work__'))).toBe(false)
  }
})

it('a Work thread gains the work server and its tool only while Work is on; its fence stands on or off, since the row decides', async () => {
  setAppWork(null)
  const code = toolSurface(await spawnOptions())
  const fenced = [...code.disallowed, ...WORK_DENIED_TOOLS].sort()
  setAppWork({ tools: work.tools })
  // off: the row says Work, the switch says no. No Work tool, and still no way out.
  const off = await spawnOptions({ id: 'cw-5', scope: 'work' })
  expect(toolSurface(off)).toEqual({ ...code, disallowed: fenced })
  expect(off.strictMcpConfig).toBe(true)
  work.settings.set({ enabled: true })
  const on = toolSurface(await spawnOptions({ id: 'cw-5', scope: 'work' }))
  expect(on.servers).toEqual([...code.servers, 'work'].sort())
  expect(on.allowed).toEqual([...code.allowed, 'mcp__work__mail_fake_search'].sort())
  expect(on.disallowed).toEqual(fenced)
})
