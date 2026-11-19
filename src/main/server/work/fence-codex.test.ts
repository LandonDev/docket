import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionMeta } from '@shared/events'
import type { DriverCtx, DriverHandle } from '../drivers/types'

/**
 * The Codex driver's spawn for a Work thread, over a fake `codex
 * app-server`: the home it runs under, the argv, and what thread/start and
 * thread/resume carry. A code thread's are what they were.
 * work/fence.proof.test.ts runs the real CLI under the same.
 */

type Frame = { id?: number; method?: string; params?: Record<string, unknown> }
class FakeProc extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin: Writable
  killed = false
  starts: { method: string; params: Record<string, unknown>; homeConfig: string | null }[] = []
  constructor(
    public argv: string[],
    public env: NodeJS.ProcessEnv
  ) {
    super()
    this.stdin = new Writable({
      write: (chunk, _enc, cb) => {
        for (const line of String(chunk).split('\n')) {
          if (!line) continue
          const frame = JSON.parse(line) as Frame
          if (frame.id === undefined) continue
          if (frame.method === 'thread/start' || frame.method === 'thread/resume') {
            // what the home's config.toml holds at the moment the thread starts: codex reads it then
            const config = env.CODEX_HOME && existsSync(join(env.CODEX_HOME, 'config.toml')) ? readFileSync(join(env.CODEX_HOME, 'config.toml'), 'utf8') : null
            this.starts.push({ method: frame.method, params: frame.params ?? {}, homeConfig: config })
            this.out({ id: frame.id, result: { thread: { id: 't1' } } })
            // the one server a fenced thread mounts; a code thread's fake mounts the same, which is no concern of this test
            this.out({ method: 'mcpServer/startupStatus/updated', params: { name: 'app', status: 'ready' } })
          } else this.out({ id: frame.id, result: {} })
        }
        cb()
      }
    })
  }
  out(frame: Record<string, unknown>): void {
    this.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n')
  }
  kill(): void {
    this.killed = true
  }
}
const spawned: FakeProc[] = []
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: (file: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    const proc = new FakeProc([file, ...args], opts.env)
    spawned.push(proc)
    return proc
  }
}))
vi.mock('../drivers/binaries', () => ({ resolveBinary: async () => '/fake/codex', harnessEnv: async () => ({ CODEX_SQLITE_HOME: '/the/persons/sqlite' }) }))
vi.mock('../endpoint', () => ({ routedEndpointFor: async () => ({ url: null, account: 'acct-1' }) }))
vi.mock('../apptools', () => ({ bridgeMcpConfig: () => ({ command: 'node', args: ['bridge.mjs'] }) }))
vi.mock('../gatewayObserve', () => ({ observeCodexSnapshot: () => undefined }))

const { codexDriver, codexWarm, CODEX_WORK_CONFIG, CODEX_WORK_OFF, codexWorkArgs, setCodexWorkHome } = await import('../drivers/codex')
const { WORK_STANDING_RULE } = await import('./preamble')

let tmp: string
let workHome: string
const handles: DriverHandle[] = []
const saved = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME, WARM: process.env.TEMP_CODE_WARM_HARNESS }
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'tc-work-codex-')))
  workHome = join(tmp, 'work-home')
  mkdirSync(join(tmp, 'person'))
  mkdirSync(join(tmp, 'folder'))
  writeFileSync(join(tmp, 'person', 'auth.json'), '{}')
  process.env.HOME = join(tmp, 'home')
  process.env.CODEX_HOME = join(tmp, 'person')
  process.env.TEMP_CODE_WARM_HARNESS = '0'
  setCodexWorkHome(workHome)
  spawned.length = 0
})
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.dispose()
  codexWarm.retire()
  for (const proc of spawned) proc.emit('exit', 0)
  setCodexWorkHome(null)
  for (const [key, value] of Object.entries({ HOME: saved.HOME, CODEX_HOME: saved.CODEX_HOME, TEMP_CODE_WARM_HARNESS: saved.WARM })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(tmp, { recursive: true, force: true })
})

const session = (over: Partial<SessionMeta> = {}): SessionMeta =>
  ({ id: 'cx-1', provider: 'codex', cwd: join(tmp, 'folder'), model: 'gpt-6.1-sol', reasoning: 'high', permission: 'auto', nativeId: null, threadType: 'chat', workspaceId: null, projectId: null, ...over }) as SessionMeta
async function start(over: Partial<SessionMeta> = {}): Promise<FakeProc> {
  const ctx: DriverCtx = { session: session(over), emit: () => {}, setNativeId: () => {}, requestApproval: async () => false }
  handles.push(await codexDriver.start(ctx))
  return spawned.at(-1)!
}

it('a code thread runs under the person\'s home, with no Work switch on its argv or in its thread config', async () => {
  const proc = await start()
  expect(proc.env.CODEX_HOME).toBeUndefined()
  expect(proc.env.CODEX_SQLITE_HOME).toBe('/the/persons/sqlite')
  expect(proc.argv.join(' ')).not.toContain('features.')
  const [first] = proc.starts
  expect(first.method).toBe('thread/start')
  expect(first.params).not.toHaveProperty('developerInstructions')
  const config = first.params.config as Record<string, unknown>
  expect(config).not.toHaveProperty('projects')
  expect(config).not.toHaveProperty('project_root_markers')
  expect(config.features).toEqual({ default_mode_request_user_input: true, multi_agent: false, multi_agent_v2: false })
  expect(existsSync(workHome)).toBe(false)
})

it('a Work thread runs under the Work home, put back before the thread starts, with the switches off three ways and the folder untrusted', async () => {
  // an agent left a server and a trust entry in the home since the last start
  mkdirSync(workHome, { recursive: true })
  writeFileSync(join(workHome, 'config.toml'), '[mcp_servers.evil]\ncommand = "x"\n[projects."/x"]\ntrust_level = "trusted"\n')
  writeFileSync(join(workHome, 'hooks.json'), '{}')
  const proc = await start({ scope: 'work' })
  expect(proc.env.CODEX_HOME).toBe(workHome)
  expect(proc.env.CODEX_SQLITE_HOME).toBeUndefined()
  expect(proc.argv.slice(proc.argv.indexOf('/fake/codex') + 1, -1)).toEqual(expect.arrayContaining(codexWorkArgs()))
  expect(proc.argv.at(-1)).toBe('app-server')
  expect(readlinkSync(join(workHome, 'auth.json'))).toBe(join(tmp, 'person', 'auth.json'))
  expect(existsSync(join(workHome, 'hooks.json'))).toBe(false)

  const [first] = proc.starts
  expect(first.method).toBe('thread/start')
  // the home held the app's config and nothing else at the moment codex read it
  expect(first.homeConfig).toBe(CODEX_WORK_CONFIG)
  expect(first.params.developerInstructions).toBe(WORK_STANDING_RULE)
  const config = first.params.config as { features: Record<string, unknown>; projects: Record<string, unknown>; project_root_markers: unknown; mcp_servers: Record<string, unknown> }
  for (const feature of CODEX_WORK_OFF) expect(config.features[feature], feature).toBe(false)
  expect(config.features.multi_agent).toBe(false)
  expect(config.project_root_markers).toEqual([])
  expect(config.projects).toEqual({ [join(tmp, 'folder')]: { trust_level: 'untrusted' } })
  // the one server it names is the app's bridge
  expect(Object.keys(config.mcp_servers)).toEqual(['app'])
})

it('a Work subagent, which has no type of its own, is fenced the same; a resumed Work thread carries the fence again', async () => {
  const child = await start({ id: 'cx-2', scope: 'work', threadType: null, parentId: 'p' })
  expect(child.env.CODEX_HOME).toBe(workHome)
  expect((child.starts[0].params.config as { projects: unknown }).projects).toEqual({ [join(tmp, 'folder')]: { trust_level: 'untrusted' } })
  // tampered between turns, then resumed
  writeFileSync(join(workHome, 'config.toml'), '[mcp_servers.evil]\ncommand = "x"\n')
  const resumed = await start({ id: 'cx-3', scope: 'work', nativeId: 'native-1' })
  expect(resumed.starts[0].method).toBe('thread/resume')
  expect(resumed.starts[0].homeConfig).toBe(CODEX_WORK_CONFIG)
  expect(resumed.starts[0].params.developerInstructions).toBe(WORK_STANDING_RULE)
  expect((resumed.starts[0].params.config as { project_root_markers: unknown }).project_root_markers).toEqual([])
})

it('a Work thread never adopts an app-server kept warm since before its home was put back', async () => {
  process.env.TEMP_CODE_WARM_HARNESS = '1'
  const adopt = vi.spyOn(codexWarm, 'adopt')
  await start({ id: 'cx-4', scope: 'work' })
  expect(adopt).not.toHaveBeenCalled()
  await start({ id: 'cx-5' })
  expect(adopt).toHaveBeenCalledTimes(1)
  adopt.mockRestore()
})

it('a Work thread whose app-server names any MCP server but the app\'s is stopped before a turn, and takes no message after', async () => {
  const errors: string[] = []
  const ctx: DriverCtx = { session: session({ id: 'cx-6', scope: 'work' }), emit: (e) => void (e.type === 'error' && errors.push(e.message)), setNativeId: () => {}, requestApproval: async () => false }
  const handle = await codexDriver.start(ctx)
  handles.push(handle)
  const proc = spawned.at(-1)!
  // the app's own bridge mounting is as it should be
  proc.out({ method: 'mcpServer/startupStatus/updated', params: { name: 'app', status: 'starting' } })
  proc.out({ method: 'mcpServer/startupStatus/updated', params: { name: 'app', status: 'ready' } })
  await new Promise((r) => setTimeout(r, 10))
  expect(proc.killed).toBe(false)
  // a server from a home that was changed after the app put it back
  proc.out({ method: 'mcpServer/startupStatus/updated', params: { name: 'lifeos', status: 'starting' } })
  await new Promise((r) => setTimeout(r, 10))
  expect(proc.killed).toBe(true)
  expect(errors.join(' ')).toMatch(/Work fence: Codex started an MCP server that is not this app's \("lifeos"\)/)
  await expect(handle.send('carry on')).rejects.toThrow(/Work fence/)
  // a code thread mounts what its person configured, as before
  const code = await start({ id: 'cx-7' })
  code.out({ method: 'mcpServer/startupStatus/updated', params: { name: 'lifeos', status: 'starting' } })
  await new Promise((r) => setTimeout(r, 10))
  expect(code.killed).toBe(false)
})

it('a Work thread is not started where its home cannot be kept', async () => {
  setCodexWorkHome(null)
  await expect(start({ scope: 'work' })).rejects.toThrow(/no data folder/)
  expect(spawned).toEqual([])
})
