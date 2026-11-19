/**
 * The simulator proof against a local server: boots scripts/ios-client-
 * test-server.ts, hands its pairing link to scripts/ios-sim-proof.sh through
 * the process environment, and stops the server. A rehearsal of the box run
 * (same script, a link from `tc-local remote.pairings.create` there).
 *
 *   bun scripts/ios-sim-proof-local.ts
 */
import { spawn, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { bundleNodeScript } from './lib/bundle-node-script'
import { seedWork, verifyWork, type WorkSeedReady } from './lib/ios-work-seeds'

const repo = resolve(import.meta.dir, '..')
const out = resolve(repo, 'scripts/.out/ios-client-test-server.mjs')
const bundleError = await bundleNodeScript(repo, 'scripts/ios-client-test-server.ts', out, { server: true })
if (bundleError) {
  console.error(bundleError)
  process.exit(1)
}
// The server's helper children run from a process of their own (scripts/lib/ios-test-exec-broker.ts).
const broker = resolve(repo, 'scripts/.out/ios-test-exec-broker.mjs')
const brokerError = await bundleNodeScript(repo, 'scripts/lib/ios-test-exec-broker.ts', broker)
if (brokerError) {
  console.error(brokerError)
  process.exit(1)
}

// The perf set reads what its fixtures and the control panel write: 16,000 seeded rows more, and no CLI behind any thread.
const perf = process.env.TC_PROOF_SET === 'perf'
const server = spawn('node', [out], { cwd: repo, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, TC_TEST_EXEC_BROKER: broker, ...(perf ? { TC_TEST_PERF_SEEDS: '1', TC_TEST_NO_HARNESS: '1' } : {}), ...(process.env.TC_PROOF_SET === 'work' ? { TC_TEST_ADDONS: '1' } : {}) } })
const ready = await new Promise<{ baseUrl: string; controlUrl: string; pairingLink: string; pairingLinkOperate: string; adminPairing?: string; second?: { pairingLink: string } }>((ok, bad) => {
  let buffer = ''
  const timer = setTimeout(() => bad(new Error('the test server did not come up in 120 s')), 120_000)
  server.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const line = buffer.split('\n').find((l) => l.startsWith('{') && l.includes('"ready":true'))
    if (!line) return
    clearTimeout(timer)
    ok(JSON.parse(line))
  })
  server.on('exit', (code) => bad(new Error(`the test server exited with ${code}`)))
}).catch((err) => {
  console.error(String(err))
  server.kill('SIGTERM')
  process.exit(1)
})
console.log(`ios-sim-proof-local: server on ${ready.baseUrl}`)
// Milestone 46's work set: Work on, two Work workspaces, an add-on's held mail, a post and a failed send.
const work = process.env.TC_PROOF_SET === 'work'
if (work) {
  const ids = await seedWork(ready as unknown as WorkSeedReady, repo)
  console.log(`ios-sim-proof-local: work seeded (${ids.purdue}, ${ids.unify})`)
}
const proof = spawnSync('sh', [resolve(repo, 'scripts/ios-sim-proof.sh')], {
  cwd: repo,
  stdio: 'inherit',
  env: {
    ...process.env,
    TC_TEST_PAIR_LINK: ready.pairingLink,
    // The steering shots pair with a key that may act; the control panel tells the script what landed.
    TC_TEST_PAIR_LINK_OPERATE: ready.pairingLinkOperate,
    // The host detail's admin reads (the host-extras set): deploy, its log, the sync lines.
    TC_TEST_PAIR_LINK_ADMIN: ready.adminPairing ?? '',
    // The features set's linked project: the second host, paired after every other shot.
    TC_TEST_PAIR_LINK_SECOND: ready.second?.pairingLink ?? '',
    TC_TEST_CONTROL_URL: ready.controlUrl,
    TC_TEST_PAIR_NAME: 'Local test server',
    TC_TEST_THREAD: process.env.TC_TEST_THREAD ?? 'Thread A',
    TC_TEST_SEARCH: process.env.TC_TEST_SEARCH ?? 'hello',
    // The last shot wants the host gone: the proof asks the control server to quit.
    TC_PROOF_KILL_CMD: `curl -s -X POST ${ready.controlUrl}/quit`
  }
})
if (work) {
  // What the phone's presses did, read back on the host (the server is still up unless the set quit it).
  const lines = await verifyWork(ready as unknown as WorkSeedReady).catch((err: unknown) => [`FAIL could not read the host back: ${String(err)}`])
  const dir = process.env.TC_PROOF_DIR ?? '/tmp/tc-ios-proof'
  writeFileSync(resolve(dir, 'work-report.txt'), lines.join('\n') + '\n')
  console.log(lines.join('\n'))
}
server.kill('SIGTERM')
process.exit(proof.status ?? 1)
