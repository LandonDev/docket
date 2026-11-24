/**
 * The box under load, bounded: an isolated server (its own temp data dir and
 * database, ephemeral ports, no shim; never the live service) seeded with what
 * a window asks for on connect (scripts/lib/connectProbe.ts), timed while
 * busy loops hold a few of the box's cores.
 *
 *   heavy bun --preload ./scripts/lib/electron-stub.ts scripts/proof-box-load.ts --out /tmp/box-load-<label>.json
 *     [--cores 8] [--pass-ms 500] [--measure-s 15] [--no-burn] [--starve] [--cap-ms 8000]
 *
 * The rules that keep the owner's live app answering (two unpinned runs on
 * 2026-11-23 slowed it to 2.2 s; his Mac gives up at 4 s):
 *   - only through `heavy`, in the background, one at a time, and only while
 *     the box's 1-minute load is under 12;
 *   - the burners and the isolated server run under `taskset -c` on the last
 *     --cores N cores (default 8), with 2×N burners, never 2× the box;
 *   - the burn lasts at most BURN_MAX_MS (60 s) in all: a 10 s ramp, then
 *     --measure-s (15 s); each burner is also under `timeout -s KILL`;
 *   - a watchdog times `tc-local admission.get '{}'` (the live service's local
 *     socket, read-only) before the start and every 5 s while burning: over
 *     LIVE_MAX_MS (800 ms) it kills every burner at once, prints
 *     `ABORTED: live host answered in <ms>` and exits 2; a first reading over
 *     it refuses to start.
 *
 * --starve: inside the server's process, before any round, the queues agents'
 * work fills are filled as the guard test fills them
 * (src/main/server/connectUnderLoad.server.test.ts): every slot of the helper
 * budgets held, a write that never ends on the focused thread's checkpoint
 * chain, the loop's lag reading forced high, the bulk gate's slots taken.
 * A request with no answer counts as the cap (2 s under --starve).
 *
 * The server runs in a child process (this script with --serve), so the
 * client's own loop is not the server's. Phases: quiet (5 s), then the
 * burners start (none outlives this script even if it is killed hard), the
 * ramp passes, and for --measure-s the
 * connect and focus requests are timed over the local socket and over the
 * fixed-port listener (`/api/hello` with a minted key, a ticket, `/ws`), each
 * on a fresh socket too. Prints p50/p95/max per request and the load; writes
 * the JSON summary to --out; exits 1 when any max reaches --pass-ms. The
 * load reported is the box's loadavg (runnable tasks on the pinned cores
 * alone are not read), beside the burner count and the core list.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, loadavg, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const BURN_MAX_MS = 60_000
const RAMP_MS = 10_000
/** The live host's watchdog: its reading every WATCH_MS, and the most it may take. */
const WATCH_MS = 5_000
const LIVE_MAX_MS = 800
const TC_LOCAL = '/usr/local/bin/tc-local'
const QUIET_MS = 5_000
const CAP_MS = Number(arg('--cap-ms') ?? (process.argv.includes('--starve') ? 2_000 : 8_000))
/** One round of every request at most this often. */
const ROUND_MS = 250

if (process.argv.includes('--serve')) await serve()
else await main()

/** The isolated server: one READY line on stdout, then runs until stdin closes or a signal. */
async function serve(): Promise<void> {
  const { configure } = await import('aliax-core')
  const { startServer } = await import('../src/main/server/index')
  const { seedConnectHost } = await import('./lib/connectProbe')
  const root = mkdtempSync(join(tmpdir(), 'tc-box-load-'))
  process.env.TEMP_CODE_WARM_HARNESS = '0'
  configure({
    dataDir: join(root, 'aliax'),
    fetch: async (url) => {
      throw new Error(`unexpected fetch ${url}`)
    },
    secrets: { mode: 'chromiumKey', keychainItem: 'Test Safe Storage' },
    appName: 'temp-code-box-load'
  })
  const server = await startServer(join(root, 'app.db'), { claimShim: false, remotePort: 0, appPath: root })
  if (!server.remote || server.remote.port === 0) throw new Error('the remote listener did not bind')
  const seed = await seedConnectHost(server, root)
  const { token } = await server.remoteAuth.createKey({ name: 'box-load', audience: 'client', caps: ['operate'], createdBy: 'local' })
  const starved = process.argv.includes('--starve') ? await starve(server, seed) : null
  let closing = false
  const close = async (): Promise<void> => {
    if (closing) return
    closing = true
    await Promise.race([server.close().catch(() => {}), new Promise((r) => setTimeout(r, 5_000))])
    rmSync(root, { recursive: true, force: true })
    process.exit(0)
  }
  process.on('SIGTERM', close)
  process.on('SIGINT', close)
  process.stdin.on('end', close)
  process.stdin.resume()
  process.stdout.write(`PROBE-READY ${JSON.stringify({ port: server.port, remotePort: server.remote.port, key: token, seed, starved })}\n`)
}

/** The guard test's starvation, in this (the server's) process; answers what it holds. */
async function starve(server: import('../src/main/server/index').RunningServer, seed: import('./lib/connectProbe').ProbeSeed): Promise<Record<string, number>> {
  const { childBudget, oneShotBudget, statusBudget } = await import('../src/main/server/spawnBudget')
  const { setLagForTests } = await import('../src/main/server/stalls')
  const { connectProbes, localUrl, openClient } = await import('./lib/connectProbe')
  type Budget = typeof childBudget
  const hold = async (budget: Budget): Promise<void> => {
    for (let i = 0; i < budget.concurrency; i++) await budget.acquire()
  }
  const until = async (check: () => boolean, ms: number): Promise<void> => {
    const end = Date.now() + ms
    while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
  }
  // Warm first, on a quiet host: what a host that ran for a while already holds.
  const window = await openClient(localUrl(server))
  for (const probe of connectProbes(seed)) await window.request(probe.method, probe.params, 10_000)
  const filler = await openClient(localUrl(server))
  await hold(childBudget)
  // The bulk gate's running slots, taken while the loop is quiet, by reads waiting on the held budget; two more behind them.
  for (const cwd of seed.fillerDirs.slice(0, 2)) void filler.request('git.diffStats', { cwd }, 3_600_000)
  await until(() => childBudget.waiting >= 2, 2_000)
  setLagForTests({ meanMs: 400, maxMs: 2_000, ewmaMs: 400 })
  for (const cwd of seed.fillerDirs.slice(2)) void filler.request('git.diffStats', { cwd }, 3_600_000)
  await hold(statusBudget)
  await hold(oneShotBudget)
  // A write on the focused thread's checkpoint chain that never ends: Undo asks git, which waits on the held budget.
  void window.request('checkpoint.undo', { sessionId: seed.focused, relative: `new-${seed.focused}.ts` }, 3_600_000)
  await new Promise((r) => setTimeout(r, 100))
  return { childRunning: childBudget.running, childWaiting: childBudget.waiting, statusRunning: statusBudget.running, oneShotRunning: oneShotBudget.running }
}

type Ready = { port: number; remotePort: number; key: string; seed: import('./lib/connectProbe').ProbeSeed; starved: Record<string, number> | null }
type Sample = { ms: number; ok: boolean; timedOut: boolean }

async function main(): Promise<void> {
  const out = arg('--out')
  if (!out) {
    console.error('usage: proof-box-load.ts --out <summary.json> [--pass-ms 500] [--measure-s 20]')
    process.exit(2)
  }
  const passMs = Number(arg('--pass-ms') ?? 500)
  const measureMs = Math.min(Number(arg('--measure-s') ?? 15) * 1000, BURN_MAX_MS - RAMP_MS - 5_000)
  const { connectProbes, openClient, remoteSocketUrl, timeHello } = await import('./lib/connectProbe')
  const total = availableParallelism()
  const cores = Math.max(1, Math.min(Number(arg('--cores') ?? 8), total))
  // The last N cores, as taskset reads them.
  const coreList = cores === 1 ? String(total - 1) : `${total - cores}-${total - 1}`
  const pinned = (command: string, args: string[]): [string, string[]] => ['taskset', ['-c', coreList, command, ...args]]
  // --no-burn: the same rounds with no load, to check the script itself.
  const burnerCount = process.argv.includes('--no-burn') ? 0 : cores * 2

  // ── the live host's watchdog ────────────────────────────────────────────
  const live: { at: string; ms: number }[] = []
  const liveCheck = (at: string): Promise<number> =>
    new Promise((resolve) => {
      const started = performance.now()
      execFile(TC_LOCAL, ['admission.get', '{}'], { timeout: 5_000 }, (error) => {
        const ms = Math.round(performance.now() - started)
        // An error that is not slowness (no socket) reads as over the mark: no load without a reading.
        const reading = error && ms < LIVE_MAX_MS ? LIVE_MAX_MS + 1 : ms
        live.push({ at, ms: reading })
        resolve(reading)
      })
    })

  // ── the burners, and everything that stops them ─────────────────────────
  const burners: ChildProcess[] = []
  let serverChild: ChildProcess | null = null
  let hardKill: ReturnType<typeof setTimeout> | null = null
  let burnStoppedAt = 0
  const stopBurners = (): void => {
    if (hardKill) clearTimeout(hardKill)
    hardKill = null
    for (const b of burners.splice(0)) {
      try {
        process.kill(-b.pid!, 'SIGKILL')
      } catch {
        try {
          b.kill('SIGKILL')
        } catch {
          /* gone */
        }
      }
    }
    if (!burnStoppedAt) burnStoppedAt = Date.now()
  }
  const stopAll = (): void => {
    stopBurners()
    if (serverChild?.pid && serverChild.exitCode === null) serverChild.kill('SIGKILL')
  }
  const abort = (ms: number, before: boolean): never => {
    stopAll()
    const line = `ABORTED: live host answered in ${ms} ms${before ? ' before the start' : ''}`
    console.log(line)
    writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), aborted: line, live, cores, coreList, burners: burnerCount }, null, 2) + '\n')
    process.exit(2)
  }
  process.on('exit', stopAll)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
    process.on(signal, () => {
      stopAll()
      process.exit(130)
    })

  const first = await liveCheck('before-start')
  if (first > LIVE_MAX_MS) abort(first, true)

  // ── the server, on the pinned cores ─────────────────────────────────────
  const log = createWriteStream(`${out}.server.log`)
  const [serveCmd, serveArgs] = pinned(process.execPath, ['--preload', join(HERE, 'lib', 'electron-stub.ts'), fileURLToPath(import.meta.url), '--serve', ...(process.argv.includes('--starve') ? ['--starve'] : [])])
  serverChild = spawn(serveCmd, serveArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TEMP_CODE_REMOTE_PORT: '0' }
  })
  serverChild.stderr!.pipe(log)
  const ready = await new Promise<Ready>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the server did not come up in 120 s')), 120_000)
    createInterface({ input: serverChild!.stdout! }).on('line', (line) => {
      if (line.startsWith('PROBE-READY ')) {
        clearTimeout(timer)
        resolve(JSON.parse(line.slice('PROBE-READY '.length)) as Ready)
      } else log.write(line + '\n')
    })
    serverChild!.on('exit', (code) => reject(new Error(`the server exited (${code}) before it was ready; see ${out}.server.log`)))
  })
  const local = `ws://127.0.0.1:${ready.port}`
  const baseUrl = `http://127.0.0.1:${ready.remotePort}`
  const probes = connectProbes(ready.seed)

  // ── one round: every request, local and remote ──────────────────────────
  const samples = new Map<string, Sample[]>()
  const record = (name: string, s: Sample): void => {
    const list = samples.get(name) ?? []
    list.push(s)
    samples.set(name, list)
  }
  const localClient = await openClient(local)
  const remoteClient = await openClient(await remoteSocketUrl(baseUrl, ready.key))
  const round = async (phase: string): Promise<void> => {
    // A window's connect: a fresh socket and its first list.
    let started = performance.now()
    try {
      const fresh = await openClient(local, CAP_MS)
      const list = await fresh.request('session.list', {}, CAP_MS)
      fresh.close()
      record(`${phase} local: open + session.list`, { ms: performance.now() - started, ok: !!list.frame?.ok, timedOut: !list.frame })
    } catch {
      record(`${phase} local: open + session.list`, { ms: CAP_MS, ok: false, timedOut: true })
    }
    const hello = await timeHello(baseUrl, ready.key, CAP_MS)
    record(`${phase} remote: /api/hello`, { ms: hello.ms, ok: hello.ok, timedOut: !hello.ok && hello.ms >= CAP_MS })
    started = performance.now()
    try {
      const fresh = await openClient(await remoteSocketUrl(baseUrl, ready.key), CAP_MS)
      const list = await fresh.request('session.list', {}, CAP_MS)
      fresh.close()
      record(`${phase} remote: ticket + open + session.list`, { ms: performance.now() - started, ok: !!list.frame?.ok, timedOut: !list.frame })
    } catch {
      record(`${phase} remote: ticket + open + session.list`, { ms: CAP_MS, ok: false, timedOut: true })
    }
    for (const [side, client] of [
      ['local', localClient],
      ['remote', remoteClient]
    ] as const) {
      for (const probe of probes) {
        const t = await client.request(probe.method, probe.params, CAP_MS)
        record(`${phase} ${side}: ${probe.name}`, { ms: t.ms, ok: !!t.frame?.ok, timedOut: !t.frame })
      }
    }
  }
  const runFor = async (phase: string, ms: number, stop = () => false): Promise<number> => {
    const end = Date.now() + ms
    let rounds = 0
    while (Date.now() < end && !stop()) {
      const began = Date.now()
      await round(phase)
      rounds++
      // Paced as windows ask, not as fast as the socket answers: a tight loop would make the lag it measures.
      const rest = began + ROUND_MS - Date.now()
      if (rest > 0) await new Promise((r) => setTimeout(r, rest))
    }
    return rounds
  }

  const loads: { at: string; t: number; load1: number }[] = []
  const sampleLoad = (at: string): number => {
    const load1 = loadavg()[0]
    loads.push({ at, t: Date.now(), load1 })
    return load1
  }

  // ── quiet, then the load ────────────────────────────────────────────────
  sampleLoad('start')
  await round('warm')
  const quietRounds = await runFor('quiet', QUIET_MS)
  const second = await liveCheck('before-burn')
  if (second > LIVE_MAX_MS) abort(second, true)
  const burnStartedAt = Date.now()
  for (let i = 0; i < burnerCount; i++) {
    const [cmd, args] = pinned('timeout', ['-s', 'KILL', String(Math.ceil(BURN_MAX_MS / 1000) + 5), 'sh', '-c', 'while :; do :; done'])
    burners.push(spawn(cmd, args, { detached: true, stdio: 'ignore' }))
  }
  hardKill = setTimeout(stopBurners, BURN_MAX_MS)
  let watching = false
  const watchdog = setInterval(() => {
    if (watching || burnStoppedAt) return
    watching = true
    void liveCheck('burning').then((ms) => {
      watching = false
      if (ms > LIVE_MAX_MS) abort(ms, false)
    })
  }, WATCH_MS)
  console.log(`${burnerCount} burners on cores ${coreList} (${cores} of ${total}); ramp ${RAMP_MS / 1000} s, then ${measureMs / 1000} s measured`)
  if (burnerCount > 0) await new Promise((r) => setTimeout(r, RAMP_MS))
  const loadAtMeasure = sampleLoad('measure-start')
  const loadTimer = setInterval(() => sampleLoad('measuring'), 2_000)
  const loadedRounds = await runFor('load', measureMs, () => burnStoppedAt > 0)
  clearInterval(loadTimer)
  const loadAtEnd = sampleLoad('measure-end')
  stopBurners()
  clearInterval(watchdog)
  localClient.close()
  remoteClient.close()
  serverChild.stdin!.end()
  await new Promise((r) => setTimeout(r, 1_000))
  if (serverChild.exitCode === null) serverChild.kill('SIGKILL')

  // ── the summary ─────────────────────────────────────────────────────────
  const pct = (sorted: number[], p: number): number => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0
  const requests = [...samples].map(([name, list]) => {
    const ms = list.map((s) => s.ms).sort((a, b) => a - b)
    return {
      name,
      n: list.length,
      p50: Math.round(pct(ms, 0.5)),
      p95: Math.round(pct(ms, 0.95)),
      max: Math.round(ms[ms.length - 1] ?? 0),
      timeouts: list.filter((s) => s.timedOut).length,
      failures: list.filter((s) => !s.ok && !s.timedOut).length
    }
  })
  const judged = requests.filter((r) => r.name.startsWith('load '))
  const over = judged.filter((r) => r.max >= passMs || r.timeouts > 0 || r.failures > 0).map((r) => r.name)
  const summary = {
    at: new Date().toISOString(),
    cores,
    coreList,
    burners: burnerCount,
    live: { max: Math.max(...live.map((l) => l.ms)), readings: live },
    burnedMs: (burnStoppedAt || Date.now()) - burnStartedAt,
    capMs: CAP_MS,
    starved: ready.starved,
    passMs,
    rounds: { quiet: quietRounds, load: loadedRounds },
    load: { start: loads[0]?.load1, atMeasure: loadAtMeasure, max: Math.max(...loads.map((l) => l.load1)), end: loadAtEnd },
    loads,
    requests,
    over,
    pass: over.length === 0
  }
  writeFileSync(out, JSON.stringify(summary, null, 2) + '\n')
  const pad = (s: string | number, n: number): string => String(s).padStart(n)
  console.log(`box load: start ${summary.load.start?.toFixed(1)}, at measure ${loadAtMeasure.toFixed(1)}, max ${summary.load.max.toFixed(1)}, end ${loadAtEnd.toFixed(1)}; ${burnerCount} burners on cores ${coreList}; live host at most ${summary.live.max} ms`)
  console.log(`${'request'.padEnd(52)}${pad('n', 4)}${pad('p50', 7)}${pad('p95', 7)}${pad('max', 7)}${pad('t/o', 5)}`)
  for (const r of requests) console.log(`${r.name.padEnd(52)}${pad(r.n, 4)}${pad(r.p50, 7)}${pad(r.p95, 7)}${pad(r.max, 7)}${pad(r.timeouts, 5)}`)
  console.log(summary.pass ? `PASS: every request under load answered in ${passMs} ms` : `FAIL (${passMs} ms): ${over.join(', ')}`)
  console.log(`summary: ${out}`)
  process.exit(summary.pass ? 0 : 1)
}
