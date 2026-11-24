import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configure } from 'aliax-core'
import type { RunningServer } from './index'
import { childBudget, oneShotBudget, statusBudget, type ChildBudget } from './spawnBudget'
import { setLagForTests } from './stalls'
import {
  connectProbes,
  localUrl,
  openClient,
  remoteSocketUrl,
  seedConnectHost,
  timeHello,
  type ProbeClient,
  type ProbeSeed,
  type Timed
} from '../../../scripts/lib/connectProbe'

/**
 * A window connecting to a host whose queues agents' work has filled: every
 * request it sends on connect and focus answers in PASS_MS. On the box
 * (2026-11-23, load 30 on 32 cores) `checkpoint.status` took 108 s and
 * `commands.list` 104 s, and the Mac's 4 s hello timed out.
 *
 * Starved here, in this process: every slot of the helper budgets held, a
 * write that never ends on the focused thread's checkpoint chain, the loop's
 * lag reading forced high (the bulk gate holds), and the bulk gate's running
 * slots taken by reads that never end. scripts/proof-box-load.ts is the same
 * probe under real CPU load.
 */
const PASS_MS = 500
/** How long a request may take before it is counted as a miss: a timed-out one reads as CAP_MS. */
const CAP_MS = 1_500

let root: string
let server: RunningServer
let seed: ProbeSeed
let key: string
let window: ProbeClient
const held: (() => void)[] = []
const warm = new Map<string, Timed>()
const fillers: Promise<Timed>[] = []

async function holdAll(budget: ChildBudget): Promise<void> {
  for (let i = 0; i < budget.concurrency; i++) held.push(await budget.acquire())
}

/** Waits until `check` holds (polled), or `ms` passes. */
async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
  return check()
}

const relatives = (t: Timed | undefined): string[] =>
  ((t?.frame?.result as { files?: { relative: string }[] } | null)?.files ?? []).map((f) => f.relative).sort()

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'tc-connect-load-'))
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
  seed = await seedConnectHost(server, root)
  key = (await server.remoteAuth.createKey({ name: 'connect-under-load', audience: 'client', caps: ['operate'], createdBy: 'local' })).token

  // Warm, on a quiet host: what each request answers before the load.
  window = await openClient(localUrl(server))
  for (const probe of connectProbes(seed)) warm.set(probe.name, await window.request(probe.method, probe.params, 10_000))

  // The bulk gate's two running slots, taken while the loop is quiet by
  // reads that wait on the helper budget (held next), and two more behind them.
  const filler = await openClient(localUrl(server))
  await holdAll(childBudget)
  for (const cwd of seed.fillerDirs.slice(0, 2)) fillers.push(filler.request('git.diffStats', { cwd }, 60_000))
  await until(() => childBudget.waiting >= 2, 2_000)
  setLagForTests({ meanMs: 400, maxMs: 2_000, ewmaMs: 400 })
  for (const cwd of seed.fillerDirs.slice(2)) fillers.push(filler.request('git.diffStats', { cwd }, 60_000))
  await holdAll(statusBudget)
  await holdAll(oneShotBudget)
  // A write on the focused thread's checkpoint chain that never ends: Undo of
  // its new file asks git (childBudget, held) from inside the chain.
  fillers.push(window.request('checkpoint.undo', { sessionId: seed.focused, relative: `new-${seed.focused}.ts` }, 60_000))
  await new Promise((r) => setTimeout(r, 100))
  // The window that measures is a fresh one: it has not focused anything yet.
  window.close()
}, 60_000)

afterAll(async () => {
  setLagForTests(null)
  for (const release of held.splice(0)) release()
  window?.close()
  await server?.close()
  if (root) rmSync(root, { recursive: true, force: true })
}, 30_000)

describe('a window connecting to a host whose queues are full', () => {
  it('the queues are really starved', async () => {
    expect(warm.get('checkpoint.status (focused)')?.frame?.ok).toBe(true)
    expect(relatives(warm.get('checkpoint.status (focused)'))).toEqual([`file1.ts`, `new-${seed.focused}.ts`].sort())
    expect(childBudget.running).toBe(childBudget.concurrency)
    expect(statusBudget.running).toBe(statusBudget.concurrency)
    expect(childBudget.waiting).toBeGreaterThanOrEqual(3)
    // Nothing behind the held budgets has answered.
    const settled = await Promise.race([Promise.race(fillers).then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 200))])
    expect(settled).toBe(false)
  })

  it('opens a socket and lists the threads in time', async () => {
    const started = performance.now()
    const me = await openClient(localUrl(server), CAP_MS)
    const list = await me.request('session.list', {}, CAP_MS)
    const ms = performance.now() - started
    me.close()
    expect(list.frame?.ok).toBe(true)
    expect(ms, `open + session.list took ${Math.round(ms)} ms`).toBeLessThan(PASS_MS)
  })

  it("answers the Mac's hello and its first list over the fixed port in time", async () => {
    const baseUrl = `http://127.0.0.1:${server.remote!.port}`
    const hello = await timeHello(baseUrl, key, CAP_MS)
    expect(hello.ok).toBe(true)
    expect(hello.ms, `/api/hello took ${Math.round(hello.ms)} ms`).toBeLessThan(PASS_MS)
    const started = performance.now()
    const remote = await openClient(await remoteSocketUrl(baseUrl, key), CAP_MS)
    const list = await remote.request('session.list', {}, CAP_MS)
    const ms = performance.now() - started
    remote.close()
    expect(list.frame?.ok).toBe(true)
    expect(ms, `ticket + open + session.list took ${Math.round(ms)} ms`).toBeLessThan(PASS_MS)
  })

  it('answers every connect and focus request in time, from what it already holds', async () => {
    const me = await openClient(localUrl(server), CAP_MS)
    const timings: Record<string, number> = {}
    const answers = new Map<string, Timed>()
    for (const probe of connectProbes(seed)) {
      const t = await me.request(probe.method, probe.params, CAP_MS)
      timings[probe.name] = Math.round(t.ms)
      answers.set(probe.name, t)
    }
    me.close()
    const slow = Object.entries(timings).filter(([name, ms]) => ms >= PASS_MS || !answers.get(name)?.frame?.ok)
    expect(slow, `over ${PASS_MS} ms or failed: ${JSON.stringify(timings)}`).toEqual([])
    // The review strips show what they showed before the load.
    expect(relatives(answers.get('checkpoint.status (focused)'))).toEqual(relatives(warm.get('checkpoint.status (focused)')))
    expect(relatives(answers.get('checkpoint.status (unfocused)'))).toEqual(relatives(warm.get('checkpoint.status (unfocused)')))
  }, 20_000)
})
