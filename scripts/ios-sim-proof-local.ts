/**
 * The simulator proof against a local server: boots scripts/ios-client-
 * test-server.ts, hands its pairing link to scripts/ios-sim-proof.sh through
 * the process environment, and stops the server. A rehearsal of the box run
 * (same script, a link from `tc-local remote.pairings.create` there).
 *
 *   bun scripts/ios-sim-proof-local.ts
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { bundleNodeScript } from './lib/bundle-node-script'
import { seedWorkPerfEditor } from './lib/ios-work-perf-seeds'
import { seedFilesM3, seedFoldHeld, seedM2, seedM5, seedOutbox2, seedSearchM4, verifyOutbox2, seedReader, seedReview, seedToday, seedVideo, seedWork, seedWorkItems, verifyFilesAsk, verifyMoney, verifyReview, verifyShare, shareProven, verifyWork, verifyWorkItems, type WorkSeedReady } from './lib/ios-work-seeds'

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

// The work set's server: its add-on, no relayed hosts, and an isolated instance's own Work root and data dir,
// so the Work workspaces it makes land under the proof's folder, not in ~/work, and its Work service takes a
// free port, not the installed app's. No CLI behind any thread (TC_TEST_NO_HARNESS): the set starts no turn,
// and the harnesses would hold gigabytes.
function workEnv(): Record<string, string> {
  const base = process.env.TC_PROOF_DIR ?? '/tmp/tc-ios-proof'
  const data = resolve(base, 'work-userdata')
  const root = resolve(base, 'work-root')
  mkdirSync(data, { recursive: true })
  mkdirSync(root, { recursive: true })
  return { TC_TEST_ADDONS: '1', TC_TEST_NO_RELAY: '1', TC_TEST_NO_HARNESS: '1', WINVM_DIR: `${data}/no-vm`, TEMP_CODE_USER_DATA: data, TEMP_CODE_WORK_ROOT: root }
}
// The work set runs the Work service in the server's process (history and a form's answers call it); the seeds
// read the same switch. TC_TEST_WORK_SERVICE=0 runs without it, as before milestone 49.
// The work-perf set measures launches onto Today, so its host has Work on with the m1 seeds (below).
const workPerf = process.env.TC_PROOF_SET === 'work-perf'
if (process.env.TC_PROOF_SET === 'work' || process.env.TC_PROOF_SET === 'video' || workPerf) process.env.TC_TEST_WORK_SERVICE ??= '1'
// The perf set reads what its fixtures and the control panel write: 16,000 seeded rows more, and no CLI behind any thread.
// The work-perf set launches over the same host, so its launches list as much as the perf set's.
const perf = process.env.TC_PROOF_SET === 'perf' || process.env.TC_PROOF_SET === 'work-perf'
// The digest set seeds between its shots (scripts/lib/ios-digest-seed.ts), on a server with Work's own dirs too.
const digest = process.env.TC_PROOF_SET === 'digest'
const server = spawn('node', [out], { cwd: repo, stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, TC_TEST_EXEC_BROKER: broker, ...(perf ? { TC_TEST_PERF_SEEDS: '1', TC_TEST_NO_HARNESS: '1' } : {}), ...(process.env.TC_PROOF_SET === 'work' || process.env.TC_PROOF_SET === 'video' || digest || workPerf ? workEnv() : {}) } })
const ready = await new Promise<{ baseUrl: string; controlUrl: string; environmentId: string; adminKey?: string; pairingLink: string; pairingLinkOperate: string; adminPairing?: string; second?: { pairingLink: string } }>((ok, bad) => {
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
// Milestone 47's: one item of every kind the phone draws, open in a third Purdue thread.
const work = process.env.TC_PROOF_SET === 'work'
const proofDir = process.env.TC_PROOF_DIR ?? '/tmp/tc-ios-proof'
let items: { sessionId: string; lines: string[] } | null = null
let reader: { sessionId: string; lines: string[] } | null = null
let review: { lines: string[] } | null = null
// What the proof parts m2 to m5 seeded (scripts/lib/ios-work-seeds.ts), each step OK or NOT RUN, for work-report.txt.
const partLines: string[] = []
let unify: string | null = null
let purdue: string | null = null
if (work && process.env.TC_WORK_ONLY === 'outbox2') {
  // Outbox 2 on the phone (M6): milestone 46's rows and the roster thread's request, nothing heavier.
  const ids = await seedWork(ready as unknown as WorkSeedReady, repo)
  unify = ids.unify
  purdue = ids.purdue
  const asked = await seedOutbox2(ready as unknown as WorkSeedReady, ids)
  console.log(`ios-sim-proof-local: outbox2 seeded (${asked.sessionId}, ${asked.requestId})`)
} else if ((work && process.env.TC_WORK_ONLY === 'm1') || workPerf) {
  // m1, and the work-perf set: a relayed host here would be this server under another id, its Work listed again,
  // and an asleep or unreachable one never lists, so workEnv() seeds none (TC_TEST_NO_RELAY).
  const ids = await seedWork(ready as unknown as WorkSeedReady, repo)
  await seedToday(ready as unknown as WorkSeedReady, ids)
  console.log('ios-sim-proof-local: Today seeded')
  // The work-perf set's editor run: a document of its own to open over the reader route.
  if (workPerf) console.log((await seedWorkPerfEditor(ready as unknown as WorkSeedReady & { environmentId: string }, ids.purdue)).join('\n'))
} else if (work) {
  const ids = await seedWork(ready as unknown as WorkSeedReady, repo)
  unify = ids.unify
  purdue = ids.purdue
  console.log(`ios-sim-proof-local: work seeded (${ids.purdue}, ${ids.unify})`)
  const part = process.env.TC_WORK_ONLY ?? ''
  // Today's seeds hold Review's week and the Unpaid deposit, which m5 shoots too.
  if (!part || part === 'm5') {
    await seedToday(ready as unknown as WorkSeedReady, ids)
    console.log('ios-sim-proof-local: Today seeded')
  }
  // The proof parts m2 to m5, each under its own TC_WORK_ONLY or the whole set.
  const withEnv = ready as unknown as WorkSeedReady & { environmentId: string }
  if (!part || part === 'm2') partLines.push(...(await seedM2(withEnv)).lines)
  if (!part || part === 'm3') partLines.push(...(await seedFilesM3(withEnv, ids.purdue)).lines)
  if (!part || part === 'm4') partLines.push(...(await seedSearchM4(withEnv, ids)).lines)
  if (!part || part === 'm5') partLines.push(...(await seedM5(withEnv, ids.purdue)).lines)
  if (partLines.length) console.log(partLines.join('\n'))
  // The Work fold cycle (TC_WORK_ONLY=fold): held posts enough that the Outbox scrolls beside its open item.
  if (process.env.TC_WORK_ONLY === 'fold') await seedFoldHeld(ready as unknown as WorkSeedReady, ids)
  items = await seedWorkItems(ready as unknown as WorkSeedReady & { environmentId: string }, ids.purdue)
  console.log(items.lines.join('\n'))
  // The reader's thread (the phone-files plan): a deck with notes, a longer PDF and a picture.
  reader = await seedReader(ready as unknown as WorkSeedReady & { environmentId: string }, ids.purdue).catch((err: unknown) => ({ sessionId: '', lines: [`FAIL reader seeds: ${String(err)}`] }))
  console.log(reader.lines.join('\n'))
  // The reader's review (PF2): a memo with a comment thread and a waiting branch, a budget with a waiting change set.
  if (reader.sessionId) {
    review = await seedReview(ready as unknown as WorkSeedReady & { environmentId: string }, ids.purdue, reader.sessionId).catch((err: unknown) => ({ lines: [`FAIL review seeds: ${String(err)}`] }))
    console.log(review.lines.join('\n'))
  }
}
// The video set: Work on, and a Work thread whose browser item plays the box engine's recorded stream.
if (process.env.TC_PROOF_SET === 'video') {
  const ids = await seedWork(ready as unknown as WorkSeedReady, repo)
  const video = await seedVideo(ready as unknown as WorkSeedReady & { environmentId: string }, ids.purdue)
  console.log(`ios-sim-proof-local: video seeded (${video.sessionId})`)
}
/** What the run requires and the read-back did not prove: any one makes the run fail, whatever the shots did. */
const unproven: string[] = []
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
    TC_PROOF_KILL_CMD: `curl -s -X POST ${ready.controlUrl}/quit`,
    // The digest set's seeds: the server and its admin key in the environment alone, the ids and the day in a file.
    ...(digest
      ? {
          TC_DIGEST_BASE_URL: ready.baseUrl,
          TC_DIGEST_CONTROL_URL: ready.controlUrl,
          TC_DIGEST_ADMIN_KEY: ready.adminKey ?? '',
          TC_DIGEST_ENVIRONMENT_ID: ready.environmentId,
          TC_DIGEST_STATE: resolve(proofDir, 'digest-state.json')
        }
      : {})
  }
})
if (work && process.env.TC_WORK_ONLY !== 'm1') {
  // What the phone's presses did, read back on the host (the server is still up unless the set quit it).
  // TC_WORK_ONLY=m47 skipped milestone 46's presses, and TC_WORK_ONLY=capture (the voice note's shots alone)
  // every press, so their read-back would only say they did not happen. TC_WORK_ONLY=money is the receipt alone;
  // TC_WORK_ONLY=reader shoots neither part.
  const only = process.env.TC_WORK_ONLY
  // TC_WORK_ONLY=fold presses nothing: it folds the screens and its checker reads the app's reports.
  // The parts m2 to m5 make none of milestone 46's or 47's presses; m3 makes the reader's, Files' and share's, m5 the receipt's.
  const part = only === 'm2' || only === 'm3' || only === 'm4' || only === 'm5'
  const skipped = only === 'm47' || only === 'capture' || only === 'money' || only === 'reader' || only === 'share' || only === 'files' || only === 'outbox2' || only === 'fold' || part
  const lines = skipped ? [] : await verifyWork(ready as unknown as WorkSeedReady).catch((err: unknown) => [`FAIL could not read the host back: ${String(err)}`])
  lines.push(...partLines)
  if (items && only !== 'capture' && only !== 'money' && only !== 'reader' && only !== 'share' && only !== 'files' && only !== 'fold' && !part) {
    lines.push(...items.lines)
    lines.push(...(await verifyWorkItems(ready as unknown as WorkSeedReady, items.sessionId).catch((err: unknown) => [`FAIL could not read the items back: ${String(err)}`])))
  }
  // The receipt's one Save (work_money), in the full set and in TC_WORK_ONLY=money.
  if (unify && (only === undefined || only === '' || only === 'money' || only === 'm5')) {
    lines.push(...(await verifyMoney(ready as unknown as WorkSeedReady, unify).catch((err: unknown) => [`FAIL could not read the receipt back: ${String(err)}`])))
  }
  if (reader) lines.push(...reader.lines)
  // TC_WORK_ONLY=share makes none of the reader's presses either.
  if (review && reader?.sessionId && only !== 'capture' && only !== 'money' && only !== 'share' && only !== 'files' && only !== 'fold' && only !== 'm2' && only !== 'm4' && only !== 'm5') {
    lines.push(...review.lines)
    lines.push(...(await verifyReview(ready as unknown as WorkSeedReady, reader.sessionId).catch((err: unknown) => [`FAIL could not read the review back: ${String(err)}`])))
  }
  // Save to TempCode's real save (the full set and TC_WORK_ONLY=share): no job checked first, then Purdue Esports by name.
  // The run fails unless both held and the file was read back by its hash (`shareProven`): a missing report, a
  // refusal or a mismatch is never green.
  if (only === undefined || only === '' || only === 'share' || only === 'm3') {
    const shared = existsSync(resolve(proofDir, 'share-report.json')) ? (JSON.parse(readFileSync(resolve(proofDir, 'share-report.json'), 'utf8')) as Parameters<typeof verifyShare>[2]) : null
    const said = purdue ? await verifyShare(ready as unknown as WorkSeedReady, purdue, shared).catch((err: unknown) => [`FAIL could not read the share back: ${String(err)}`]) : ['FAIL share: no Purdue Esports was seeded']
    lines.push(...said)
    if (!shareProven(said)) unproven.push('the Share save')
  }
  // Outbox 2 (TC_WORK_ONLY=outbox2): the request's Send from the phone ran exactly the ticked rows.
  if (only === 'outbox2') lines.push(...(await verifyOutbox2(ready as unknown as WorkSeedReady).catch((err: unknown) => [`FAIL could not read the request back: ${String(err)}`])))
  // Ask from a file open in Files (the full set and TC_WORK_ONLY=files): a new thread holds the PDF.
  if (purdue && reader?.sessionId && (only === undefined || only === '' || only === 'files' || only === 'm3')) {
    lines.push(...(await verifyFilesAsk(ready as unknown as WorkSeedReady & { environmentId: string }, purdue, reader.sessionId).catch((err: unknown) => [`FAIL could not read the Files ask back: ${String(err)}`])))
  }
  writeFileSync(resolve(proofDir, 'work-report.txt'), lines.join('\n') + '\n')
  console.log(lines.join('\n'))
}
server.kill('SIGTERM')
if (unproven.length > 0) console.error(`ios-sim-proof-local: not proven: ${unproven.join(', ')}`)
process.exit(unproven.length > 0 ? 1 : (proof.status ?? 1))
