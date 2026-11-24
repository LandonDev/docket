/**
 * What a window asks a host on connect and on focus, against a real server:
 * the seed (a project on a scratch git repo, chats with a transcript, two
 * checkpoints with touched files, a master with a batch), the requests in
 * the order a window sends them, and a small client that times each one
 * over the local socket or the fixed-port listener.
 *
 * Shared by the guard test (src/main/server/connectUnderLoad.server.test.ts,
 * which starves the host's queues in-process) and the live load proof
 * (scripts/proof-box-load.ts, which starves the CPU).
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RunningServer } from '../../src/main/server/index'
import { CheckpointStore } from '../../src/main/server/checkpoint'
import type { AgentEvent } from '../../src/shared/events'
import { batchRowMidRun } from './ios-seeds'

export interface ProbeSeed {
  repo: string
  projectId: string
  /** The thread the window focuses: a transcript and a checkpoint. */
  focused: string
  /** A thread beside it with a checkpoint of its own, never focused. */
  unfocused: string
  masterId: string
  children: string[]
  /** Folders of the repo the queue fillers name, one key each. */
  fillerDirs: string[]
}

export type Probe = { name: string; method: string; params?: unknown }

/** No harness behind any thread: no boot, no send, no liveness sweep (as scripts/lib/soakHost.ts). */
export function stubHarness(server: RunningServer): void {
  const registry = server.registry
  const stub = (key: string, fn: unknown): void => {
    ;(registry as unknown as Record<string, unknown>)[key] = fn
  }
  stub('handleFor', () => Promise.reject(new Error('the probe host runs no harness')))
  stub('send', async () => {})
  stub('whisper', () => {})
  stub('sweepLiveness', () => [])
  const sweep = registry as unknown as { livenessTimer?: ReturnType<typeof setInterval> | null }
  if (sweep.livenessTimer) clearInterval(sweep.livenessTimer)
  sweep.livenessTimer = null
  const scheduler = registry.scheduler as unknown as { schedule: () => void; admit: () => string }
  scheduler.schedule = () => {}
  scheduler.admit = () => 'start'
}

const git = (repo: string, ...args: string[]): void => {
  execFileSync('git', ['-C', repo, '-c', 'user.name=probe', '-c', 'user.email=probe@example.com', ...args], { stdio: 'ignore' })
}

/** The seed, on `root` (the server's data dir: its checkpoints live in `<root>/checkpoints`). */
export async function seedConnectHost(server: RunningServer, root: string): Promise<ProbeSeed> {
  stubHarness(server)
  const registry = server.registry
  const repo = join(root, 'repo')
  const fillerDirs = ['a', 'b', 'c', 'd'].map((d) => join(repo, 'filler', d))
  for (const dir of fillerDirs) mkdirSync(dir, { recursive: true })
  writeFileSync(join(repo, 'README.md'), '# probe\n')
  for (let i = 0; i < 20; i++) writeFileSync(join(repo, `file${i}.ts`), `export const n${i} = ${i}\n`)
  for (const dir of fillerDirs) writeFileSync(join(dir, 'keep.txt'), 'kept\n')
  execFileSync('git', ['-C', repo, 'init', '-q'], { stdio: 'ignore' })
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'init')

  const workspace = await registry.createWorkspace(repo, 'probe')
  const project = await registry.createProject(workspace.id, 'probe', 'local')
  const base = { provider: 'claude', model: 'claude-opus-5-5', reasoning: 'high', agentType: 'implementer', permission: 'edits', projectId: project.id } as const

  const focused = 'probe-focused'
  const unfocused = 'probe-unfocused'
  await registry.create({ ...base, id: focused, threadType: 'chat', title: 'Fix the slow connect' })
  await registry.create({ ...base, id: unfocused, threadType: 'chat', title: 'Tidy the lane gate' })
  for (let i = 0; i < 3; i++) await registry.create({ ...base, id: `probe-chat-${i}`, threadType: 'chat', title: `Chat ${i}` })
  // A transcript of 60 turns, five rows each, for the tail.
  const append = (id: string, event: AgentEvent): void => registry.append(id, event)
  for (let turn = 0; turn < 60; turn++) {
    append(focused, { type: 'user-text', text: `Turn ${turn + 1}: read the lane and say what waits.` })
    append(focused, { type: 'assistant-text', text: 'The bulk lane holds while the loop lags. '.repeat(8), delta: false, msgId: `m${turn}`, blockIndex: 0 })
    append(focused, { type: 'tool-call', callId: `c${turn}`, name: 'Read', input: { file_path: `file${turn % 20}.ts` } })
    append(focused, { type: 'tool-result', callId: `c${turn}`, output: 'export {}\n', isError: false })
    append(focused, { type: 'turn-complete' })
  }
  append(unfocused, { type: 'user-text', text: 'Tidy it.' })
  append(unfocused, { type: 'turn-complete' })

  // A master with a batch of three children, as the board reads it.
  const masterId = 'probe-master'
  await registry.create({ ...base, id: masterId, threadType: 'chat', title: 'Ship the probe batch' })
  registry.setMaster(masterId, true)
  append(masterId, { type: 'user-text', text: 'Run the three threads.' })
  append(masterId, { type: 'turn-complete' })
  const children = [0, 1, 2].map((i) => `probe-child-${i}`)
  for (const id of children) {
    await registry.create({ ...base, id, threadType: 'implementation', title: id, masterId, startedBy: masterId })
    append(id, { type: 'user-text', text: 'Do the part.', newPass: true })
  }
  server.batches.seedRow(batchRowMidRun(masterId, { landed: [], pending: children }, Date.now()))

  // Two checkpoints with touched files: the baseline is the clean tree, then
  // each thread "edits" a tracked file and adds a new one.
  const checkpoints = new CheckpointStore(join(root, 'checkpoints'))
  for (const [id, n] of [
    [focused, 1],
    [unfocused, 2]
  ] as const) {
    await checkpoints.ensure(id, repo)
    writeFileSync(join(repo, `file${n}.ts`), `export const n${n} = ${n * 100}\n`)
    writeFileSync(join(repo, `new-${id}.ts`), 'export const fresh = true\n')
    await checkpoints.record(id, repo, [
      { relative: `file${n}.ts`, inHead: true },
      { relative: `new-${id}.ts`, inHead: false }
    ])
  }
  return { repo, projectId: project.id, focused, unfocused, masterId, children, fillerDirs }
}

/** The connect-and-focus requests, in the order a window sends them. */
export function connectProbes(seed: ProbeSeed): Probe[] {
  return [
    { name: 'session.list', method: 'session.list', params: {} },
    { name: 'session.focus', method: 'session.focus', params: { sessionId: seed.focused, shown: seed.focused } },
    { name: 'session.events (tail)', method: 'session.events', params: { sessionId: seed.focused, afterSeq: 0, tail: 300, subscribe: true } },
    { name: 'checkpoint.status (focused)', method: 'checkpoint.status', params: { sessionId: seed.focused } },
    { name: 'commands.list', method: 'commands.list', params: { provider: 'claude', cwd: seed.repo } },
    { name: 'batch.board', method: 'batch.board', params: { masterId: seed.masterId } },
    { name: 'batch.get', method: 'batch.get', params: { masterId: seed.masterId } },
    { name: 'checkpoint.status (unfocused)', method: 'checkpoint.status', params: { sessionId: seed.unfocused } }
  ]
}

export type Frame = { id?: string; ok?: boolean; result?: unknown; error?: string; push?: string }
export type Timed = { ms: number; frame: Frame | null }

export interface ProbeClient {
  /** One request; `frame` is null when no answer came within `capMs` (`ms` is then the cap). */
  request(method: string, params: unknown, capMs: number): Promise<Timed>
  close(): void
}

/** A contract socket at `url` (the global WebSocket: node 22 and bun both have it). */
export async function openClient(url: string, capMs = 10_000): Promise<ProbeClient> {
  const ws = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no open from ${url.replace(/\?.*/, '')} in ${capMs} ms`)), capMs)
    ws.addEventListener('open', () => (clearTimeout(timer), resolve()), { once: true })
    ws.addEventListener('error', () => (clearTimeout(timer), reject(new Error(`socket error on ${url.replace(/\?.*/, '')}`))), { once: true })
  })
  let next = 1
  const pending = new Map<string, (frame: Frame) => void>()
  ws.addEventListener('message', (message) => {
    const frame = JSON.parse(String(message.data)) as Frame
    if (!frame.push && frame.id) pending.get(frame.id)?.(frame)
  })
  return {
    request(method, params, capMs) {
      const id = String(next++)
      const started = performance.now()
      return new Promise<Timed>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          resolve({ ms: capMs, frame: null })
        }, capMs)
        pending.set(id, (frame) => {
          clearTimeout(timer)
          pending.delete(id)
          resolve({ ms: performance.now() - started, frame })
        })
        ws.send(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }))
      })
    },
    close: () => ws.close()
  }
}

export const localUrl = (server: Pick<RunningServer, 'port'>): string => `ws://127.0.0.1:${server.port}`

/** The fixed port as a paired desktop reaches it: a ticket for the key, then `/ws?ticket=…`. */
export async function remoteSocketUrl(baseUrl: string, key: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/ticket`, { method: 'POST', headers: { authorization: `Bearer ${key}` } })
  if (!res.ok) throw new Error(`/api/ticket answered ${res.status}`)
  const { ticket } = (await res.json()) as { ticket: string }
  return `${baseUrl.replace(/^http/, 'ws')}/ws?ticket=${ticket}`
}

/** `/api/hello` as the Mac's fetchHello asks it (environments.ts); null on no answer within `capMs`. */
export async function timeHello(baseUrl: string, key: string, capMs: number): Promise<{ ms: number; ok: boolean }> {
  const started = performance.now()
  try {
    const res = await fetch(`${baseUrl}/api/hello`, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(capMs)
    })
    const body = (await res.json()) as { key?: unknown }
    return { ms: performance.now() - started, ok: res.ok && !!body.key }
  } catch {
    return { ms: capMs, ok: false }
  }
}
