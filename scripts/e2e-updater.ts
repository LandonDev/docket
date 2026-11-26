#!/usr/bin/env bun
/**
 * The real Squirrel.Mac update path, end to end, against a copy of the app
 * that can never touch the installed one.
 *
 *   bun run script:e2e-updater            # build both copies, then drive
 *   bun run script:e2e-updater --reuse    # keep the builds under ROOT, redrive
 *   bun run script:e2e-updater --busy     # restart while a thread is running
 *   bun run script:e2e-updater --still-running  # a second instance blocks ShipIt
 *   bun run script:e2e-updater --rename   # across the rename: TempCodeE2E 1.0.N-1 → DocketE2E 1.0.N
 *   bun run script:e2e-updater --rename=present  # the same with a DocketE2E.app already in the folder
 *   bun run script:e2e-updater --rename=hand     # the old copy renamed DocketE2E.app by hand first
 *   bun run script:e2e-updater --rename --next   # then DocketE2E 1.0.N → 1.0.N+1 from where that left it
 *   bun scripts/e2e-updater.ts --win            # the Windows update path, in the rig on the box
 *                                               # (scripts/e2e-updater-win.ts has its own account)
 *
 * --still-running keeps a second copy of the old app (same bundle, its own
 * userData) alive across the restart. ShipIt then waits for every instance to
 * quit before it begins (a first attempt never aborts, it waits); the run
 * starts the old app by hand, which must report the hand-over as waiting
 * ("The update is waiting for the app to quit."), quits the second copy,
 * retries from that state (which dismisses the waiting ShipIt and fetches
 * the zip again, whole) and expects that restart to install.
 *
 * --busy starts a real short Claude turn (Haiku 5.5) in the old copy before
 * asking for the restart. The renderer then treats the window as busy: it
 * hides it instead of closing when Electron's quitAndInstall closes windows,
 * which is the stall the fix is for; the fixed app asks the quit-while-busy
 * question once (answered here through TEMP_CODE_DIALOG_ANSWER=yes) and
 * goes on to install.
 *
 * What it does:
 *   1. Builds the tree twice with electron-builder, signed with the Developer
 *      ID identity but not notarized (Squirrel checks the signature, not the
 *      notarization): once at package.json 1.0.N-1 ("old") and once at 1.0.N
 *      ("new"). package.json is patched for the first build and restored
 *      byte for byte. Both carry bundle id dev.landon.tempcode.e2e, product
 *      name TempCodeE2E, and a `tempcodeHarness` block (src/main/harness.ts)
 *      naming their userData, CDP port and feed, so the app ShipIt relaunches
 *      without our environment comes up isolated too.
 *   2. Serves latest-mac.yml and the new zip from 127.0.0.1:9231.
 *   3. Installs the old copy at /private/tmp/tc-updater-e2e/TempCodeE2E.app,
 *      launches it, and over CDP (9230) drives check → download → restart.
 *   4. Asserts: the process quit, ShipIt swapped the bundle (Info.plist says
 *      1.0.N), the relaunched app answers 1.0.N over CDP, and
 *      ~/Library/Caches/dev.landon.tempcode.e2e.ShipIt/ShipIt_stderr.log
 *      shows a clean install. A restart that leaves the process alive is
 *      reported as a stall.
 *
 * --rename builds the old copy under the product name the app had (TempCodeE2E) and the new one
 * under the one it has (DocketE2E), with the same bundle id, and records what a person would
 * see after the update: every bundle in ROOT with its version, whether ShipIt relaunched the app
 * itself, which executable runs, and the name and default userData the app reports before and
 * after (harness.ts `harnessIdentity`; both must hold). A relaunch that does not come is
 * reported, and the run opens the updated bundle by hand so --next can go on from that state.
 * The facts are also written to ROOT/facts.json.
 *
 * Everything it writes lives under ROOT, the e2e ShipIt cache, the
 * temp-code-harness-updater cache and the launchd label with the e2e bundle
 * id; the installed app's paths are never read or written.
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  createReadStream,
  statSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { HARNESS_IDENTITY_FILE, type HarnessIdentity } from '../src/main/harness'
import {
  attach as attachTo,
  builtApp as builtAppAt,
  type Cdp,
  findIdentity,
  killAt,
  launchEnv,
  pack as packApp,
  pidsAt,
  plistVersionOf,
  portFree,
  prepareEnv,
  readPackage,
  sh,
  sleep,
  type Target,
  tryRun,
  waitForReleaseTrain
} from './lib/packagedApp'

// The Windows pass is its own driver, run on the box against the rig (scripts/e2e-updater-win.ts).
// It ends the process itself; nothing below runs.
if (process.argv.includes('--win')) await import('./e2e-updater-win')

const ROOT = '/private/tmp/tc-updater-e2e'
const APP_ID = 'dev.landon.tempcode.e2e'
const renameArg = process.argv.find((a) => a === '--rename' || a.startsWith('--rename='))
/** plain: the old bundle under its own name; present: a DocketE2E.app (the old build) already
 *  beside it; hand: the old bundle renamed DocketE2E.app, its executable still TempCodeE2E. */
const rename = renameArg ? ((renameArg.split('=')[1] ?? 'plain') as 'plain' | 'present' | 'hand') : null
if (rename && !['plain', 'present', 'hand'].includes(rename)) throw new Error(`--rename=${rename}?`)
const next = process.argv.includes('--next')
const PRODUCT = 'DocketE2E'
const OLD_PRODUCT = rename ? 'TempCodeE2E' : PRODUCT
const DEBUG_PORT = 9230
const FEED_PORT = 9231
const FEED_URL = `http://127.0.0.1:${FEED_PORT}/`
const USER_DATA = join(ROOT, 'userData')
const APP = join(ROOT, `${rename === 'hand' ? PRODUCT : OLD_PRODUCT}.app`)
const EXE = join(APP, 'Contents', 'MacOS', OLD_PRODUCT)
const IDENTITY = join(USER_DATA, HARNESS_IDENTITY_FILE)
const FEED_DIR = join(ROOT, 'feed')
const SHIPIT_DIR = join(homedir(), 'Library', 'Caches', `${APP_ID}.ShipIt`)
const SHIPIT_LOG = join(SHIPIT_DIR, 'ShipIt_stderr.log')
const UPDATER_CACHE = join(homedir(), 'Library', 'Caches', 'temp-code-harness-updater')
const SHIPIT_LABEL = `${APP_ID}.ShipIt`
const reuse = process.argv.includes('--reuse')
const busy = process.argv.includes('--busy')
const stillRunning = process.argv.includes('--still-running')

prepareEnv()

let failures = 0
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const log = (msg: string): void =>
  console.log(`[e2e-updater ${new Date().toISOString().slice(11, 19)}] ${msg}`)
// ── Preflight ──────────────────────────────────────────────────────────────

const N = readPackage().n
const OLD = `1.0.${N - 1}`
const NEW = `1.0.${N}`
const NEXT = `1.0.${N + 1}`
const identity = await findIdentity()

log(`old ${OLD} → new ${NEW}, identity "${identity}", root ${ROOT}`)
/** The bundles in ROOT itself (the builds sit a level down). */
const bundles = (): string[] =>
  existsSync(ROOT) ? readdirSync(ROOT).filter((n) => n.endsWith('.app')).sort() : []
const killAll = async (): Promise<void> => {
  for (const name of bundles()) await killAt(join(ROOT, name))
}
await killAll()
await tryRun(['launchctl', 'remove', SHIPIT_LABEL])
rmSync(SHIPIT_DIR, { recursive: true, force: true })
rmSync(UPDATER_CACHE, { recursive: true, force: true })
if (!reuse) rmSync(ROOT, { recursive: true, force: true })
else {
  for (const name of bundles()) rmSync(join(ROOT, name), { recursive: true, force: true })
  rmSync(USER_DATA, { recursive: true, force: true })
  rmSync(join(ROOT, 'feed'), { recursive: true, force: true })
}
mkdirSync(ROOT, { recursive: true })
for (const port of [DEBUG_PORT, FEED_PORT]) {
  if (!(await portFree(port))) throw new Error(`port ${port} is in use`)
}

await waitForReleaseTrain(log)

// ── Build ──────────────────────────────────────────────────────────────────

type Which = 'old' | 'new' | 'next'
const builds: Which[] = next ? ['old', 'new', 'next'] : ['old', 'new']
const outDir = (which: Which): string => join(ROOT, `build-${which}`)
const productOf = (which: Which): string => (which === 'old' ? OLD_PRODUCT : PRODUCT)
const builtApp = (which: Which): string => builtAppAt(outDir(which), productOf(which))
const zipOf = (version: string): string => `${PRODUCT}-${version}-arm64.zip`
const zipName = zipOf(NEW)
const versionOf = { old: OLD, new: NEW, next: NEXT }

async function pack(version: string, which: Which): Promise<void> {
  await packApp({
    version,
    which,
    outDir: outDir(which),
    appId: APP_ID,
    product: productOf(which),
    identity,
    check,
    log,
    harness: {
      TEMP_CODE_USER_DATA: USER_DATA,
      TEMP_CODE_DEBUG_PORT: DEBUG_PORT,
      TEMP_CODE_UPDATE_FEED: FEED_URL
    }
  })
}

if (!reuse) {
  log('bun run build (typecheck + electron-vite)')
  await sh(['bun', 'run', 'build'], { quiet: true })
  for (const which of builds) {
    await pack(versionOf[which], which)
    // Only the zips the feed serves are needed; the old one is 300 MB of disk for nothing.
    if (which === 'old') rmSync(join(outDir(which), `${OLD_PRODUCT}-${OLD}-arm64.zip`), { force: true })
  }
} else {
  for (const which of builds) {
    if (!existsSync(builtApp(which))) throw new Error(`--reuse: ${builtApp(which)} missing`)
  }
}

// ── Feed ───────────────────────────────────────────────────────────────────

/** Puts a build's zip on the feed and names it latest. Hard links: the disk is short on the Mac. */
async function offer(which: Which): Promise<number> {
  const version = versionOf[which]
  const name = zipOf(version)
  const built = join(outDir(which), name)
  if (!existsSync(built)) throw new Error(`${built} missing`)
  mkdirSync(FEED_DIR, { recursive: true })
  const feedZip = join(FEED_DIR, name)
  if (!existsSync(feedZip)) await sh(['ln', built, feedZip])
  const sha512 = await new Promise<string>((res, rej) => {
    const h = createHash('sha512')
    createReadStream(feedZip)
      .on('data', (d) => h.update(d))
      .on('end', () => res(h.digest('base64')))
      .on('error', rej)
  })
  const size = statSync(feedZip).size
  writeFileSync(
    join(FEED_DIR, 'latest-mac.yml'),
    [
      `version: ${version}`,
      'files:',
      `  - url: ${name}`,
      `    sha512: ${sha512}`,
      `    size: ${size}`,
      `path: ${name}`,
      `sha512: ${sha512}`,
      `releaseDate: '${new Date().toISOString()}'`,
      ''
    ].join('\n')
  )
  return size
}
const size = await offer('new')
const server = Bun.serve({
  port: FEED_PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const name = decodeURIComponent(new URL(req.url).pathname).split('/').pop() ?? ''
    const file = Bun.file(join(FEED_DIR, name))
    if (!name || !(await file.exists())) return new Response('not found', { status: 404 })
    log(`feed: ${req.method} ${name}`)
    feedLog.push(name)
    return new Response(file)
  }
})
log(`feed at ${FEED_URL} serving ${zipName} (${size} bytes)`)

// ── Install the old copy and launch it ─────────────────────────────────────

await sh(['ditto', builtApp('old'), APP])
// A copy at the name the update would move to: the old build, so its version tells whether ShipIt wrote into it.
if (rename === 'present') await sh(['ditto', builtApp('old'), join(ROOT, `${PRODUCT}.app`)])
mkdirSync(USER_DATA, { recursive: true })
const appLog = join(ROOT, 'old-app.log')
const env = launchEnv(busy ? { TEMP_CODE_DIALOG_ANSWER: 'yes' } : {})
const oldProc = launchOld('old-app.log')
log(`launched ${OLD} as pid ${oldProc.pid}; log ${appLog}`)

type Status = {
  current: string
  latest: string | null
  phase: string
  percent?: number
  error?: string
  installFailure?: { version: string; reason: string }
}

function launchOld(
  logName: string,
  extraEnv: Record<string, string> = {}
): ReturnType<typeof Bun.spawn> {
  const file = Bun.file(join(ROOT, logName))
  return Bun.spawn([EXE], { env: { ...env, ...extraEnv }, stdout: file, stderr: file })
}

async function driveToReady(cdp: Cdp): Promise<Status> {
  const started = await cdp.eval<Status>('window.api.updates.apply()')
  check(
    'apply starts the download',
    started.phase === 'downloading' || started.phase === 'ready',
    JSON.stringify(started)
  )
  let status = started
  const downloadUntil = Date.now() + 300_000
  while (status.phase !== 'ready' && status.phase !== 'error' && Date.now() < downloadUntil) {
    await sleep(1000)
    status = await cdp.eval<Status>('window.api.updates.get()')
  }
  check('download reaches ready', status.phase === 'ready', JSON.stringify(status))
  if (status.phase !== 'ready') throw new Error('download did not reach ready')
  return status
}

async function waitExit(proc: ReturnType<typeof Bun.spawn>, ms: number): Promise<boolean> {
  return Promise.race([proc.exited.then(() => true), sleep(ms).then(() => false)])
}

const attach = (timeoutMs: number): Promise<Cdp> => attachTo(DEBUG_PORT, timeoutMs)

let relaunched: Cdp | null = null
const feedLog: string[] = []

const facts: Record<string, unknown> = { rename: rename ?? 'none', next, from: OLD, to: NEW }
const fact = (key: string, value: unknown): void => {
  facts[key] = value
  console.log(`FACT ${key}: ${JSON.stringify(value)}`)
}
const readIdentity = (): HarnessIdentity | null => {
  try {
    return JSON.parse(readFileSync(IDENTITY, 'utf8')) as HarnessIdentity
  } catch {
    return null
  }
}
/** Every bundle in ROOT with the version its Info.plist says. */
async function folder(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const name of bundles()) out[name] = await plistVersionOf(join(ROOT, name))
  return out
}
async function executableOf(app: string): Promise<string> {
  const plist = join(app, 'Contents', 'Info.plist')
  return (await sh(['plutil', '-extract', 'CFBundleExecutable', 'raw', plist], { quiet: true })).trim()
}
async function runningCount(): Promise<number> {
  let n = 0
  for (const name of bundles()) n += (await pidsAt(join(ROOT, name))).length
  return n
}
/** The identity the old app wrote at boot; taken away so the next boot's is its own. */
let identityBefore: HarnessIdentity | null = null
async function noteIdentityBefore(label: string): Promise<void> {
  for (let i = 0; i < 20 && !readIdentity(); i++) await sleep(500)
  identityBefore = readIdentity()
  fact(`${label}.identity`, identityBefore)
  rmSync(IDENTITY, { force: true })
}

/** After the app quit: ShipIt copies the staged bundle, verifies the copy
 *  against the running app's designated requirement, swaps Contents and
 *  relaunches. Lines of the ShipIt log written before `since` are an earlier
 *  attempt's and are not held against this one. Answers the app it attached
 *  to: ShipIt's relaunch, or, when that never came, the updated bundle opened
 *  by hand. */
async function finishInstall(since: number, version = NEW, label = 'update'): Promise<Cdp | null> {
  const swapUntil = Date.now() + 180_000
  let target = ''
  while (Date.now() < swapUntil) {
    const seen = await folder()
    target = Object.keys(seen).find((n) => seen[n] === version) ?? ''
    if (target) break
    await sleep(1000)
  }
  check(
    `a bundle on disk is ${version}`,
    target !== '',
    `${target || 'none'} ${((Date.now() - since) / 1000).toFixed(0)}s after restart`
  )
  // ShipIt moves the bundle and then relaunches; give it a moment to finish both.
  await sleep(3000)
  const after = await folder()
  fact(`${label}.folder`, after)
  check(`one app in the folder after the ${label}`, Object.keys(after).length === 1, JSON.stringify(after))

  let cdp = await attach(120_000).catch(() => null)
  fact(`${label}.relaunchedBySelf`, cdp !== null)
  check('ShipIt relaunched the app', cdp !== null)
  if (!cdp && target) {
    const exe = join(ROOT, target, 'Contents', 'MacOS', await executableOf(join(ROOT, target)))
    log(`no relaunch; opening ${exe} by hand`)
    const file = Bun.file(join(ROOT, `${label}-by-hand.log`))
    Bun.spawn([exe], { env, stdout: file, stderr: file })
    cdp = await attach(90_000).catch((e) => {
      check(`the updated bundle opens by hand`, false, e.message)
      return null
    })
  }
  if (cdp) {
    const answered = await cdp.eval<string>('window.api.app.version()')
    check(`relaunched app answers ${version}`, answered === version, answered)
    const status2 = await cdp.eval<Status>('window.api.updates.get()')
    check(
      'relaunched app reports no pending update and no failure',
      status2.current === version && status2.phase !== 'error' && !status2.installFailure,
      JSON.stringify(status2)
    )
    const attemptFile = join(USER_DATA, 'update-attempt.json')
    check('the attempt record was cleared after the install', !existsSync(attemptFile))
    for (let i = 0; i < 20 && !readIdentity(); i++) await sleep(500)
    const identity = readIdentity()
    fact(`${label}.identityAfter`, identity)
    check(
      'app.getName() and the default userData are unchanged',
      !!identity &&
        !!identityBefore &&
        identity.name === identityBefore.name &&
        identity.defaultUserData === identityBefore.defaultUserData,
      `${identityBefore?.name} → ${identity?.name}; ${identityBefore?.defaultUserData} → ${identity?.defaultUserData}`
    )
    fact(`${label}.processes`, await runningCount())
    identityBefore = identity
    rmSync(IDENTITY, { force: true })
  }

  const shipItLog = existsSync(SHIPIT_LOG) ? readFileSync(SHIPIT_LOG, 'utf8') : ''
  const recent = shipItLog.split('\n').filter((l) => {
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3}) /.exec(l)
    return m
      ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]).getTime() >= since - 5000
      : false
  })
  const bad = recent.filter((l) =>
    /Installation error|did not pass validation|App Still Running|Installation cancelled|Too many attempts/.test(
      l
    )
  )
  check(
    'ShipIt log shows a clean install',
    recent.length > 0 && bad.length === 0,
    bad.length ? bad.join(' | ').slice(0, 600) : `${recent.length} lines`
  )
  console.log('---- ShipIt_stderr.log')
  console.log(shipItLog.trim())
  console.log('----')
  return cdp
}

/** --next: one more update, DocketE2E 1.0.N → 1.0.N+1, from the state the first update left. */
async function nextUpdate(cdp: Cdp): Promise<void> {
  await offer('next')
  const checked = await cdp.eval<Status>('window.api.updates.check()')
  check(`check sees ${NEXT} on the feed`, checked.latest === NEXT && checked.phase !== 'error', JSON.stringify(checked))
  await driveToReady(cdp)
  await sleep(2000)
  log('apply again: restart to update (next)')
  const at = Date.now()
  await cdp.eval<Status>('window.api.updates.apply()').catch((e) => log(`apply (restart) threw: ${e.message}`))
  cdp.close()
  let gone = false
  for (const until = Date.now() + 60_000; Date.now() < until; await sleep(500)) {
    if ((await runningCount()) === 0) {
      gone = true
      break
    }
  }
  check('restart quits the app (next)', gone)
  relaunched = await finishInstall(at, NEXT, 'next')
}

async function drive(): Promise<void> {
  try {
    const cdp = await attach(90_000)
    await noteIdentityBefore('old')
    fact('old.folder', await folder())
    const booted = await cdp.eval<Status>('window.api.updates.get()')
    check(`old app reports current ${OLD}`, booted.current === OLD, JSON.stringify(booted))

    const checked = await cdp.eval<Status>('window.api.updates.check()')
    check(
      `check sees ${NEW} on the feed`,
      checked.latest === NEW && checked.phase !== 'error',
      JSON.stringify(checked)
    )

    await driveToReady(cdp)
    // Squirrel fetches the zip from electron-updater's proxy and stages it
    // before electron-updater reports ready; a staged update dir proves it.
    await sleep(2000)
    const staged = existsSync(SHIPIT_DIR)
      ? (await sh(['ls', SHIPIT_DIR], { quiet: true })).trim().split('\n')
      : []
    check(
      'Squirrel staged the update',
      staged.some((n) => n.startsWith('update.')),
      staged.join(', ')
    )

    if (stillRunning) {
      // Same bundle, other userData: counts as a running instance of the target.
      const second = launchOld('second-app.log', {
        TEMP_CODE_USER_DATA: join(ROOT, 'userData2'),
        TEMP_CODE_DEBUG_PORT: '9232'
      })
      log(`second instance pid ${second.pid}`)
      await sleep(8000)
      log('apply again: restart to update (second instance alive)')
      await cdp
        .eval<Status>('window.api.updates.apply()')
        .catch((e) => log(`apply (restart) threw: ${e.message}`))
      check('restart quits the app', await waitExit(oldProc, 60_000))
      // A first-attempt ShipIt logs the request and then waits for every
      // instance to quit; the second copy keeps it waiting.
      const requestUntil = Date.now() + 30_000
      let shipItText = ''
      while (Date.now() < requestUntil) {
        shipItText = existsSync(SHIPIT_LOG) ? readFileSync(SHIPIT_LOG, 'utf8') : ''
        if (/Detected this as an install request/.test(shipItText)) break
        await sleep(1000)
      }
      await sleep(10_000)
      shipItText = existsSync(SHIPIT_LOG) ? readFileSync(SHIPIT_LOG, 'utf8') : ''
      check(
        'ShipIt took the request and is waiting on the running instance',
        /Detected this as an install request/.test(shipItText) &&
          !/Beginning installation|Installation error/.test(shipItText),
        shipItText.trim().split('\n').slice(-3).join(' | ').slice(0, 300)
      )
      const plistAfter = await plistVersionOf(APP)
      check(`bundle on disk is still ${OLD}`, plistAfter === OLD, plistAfter)
      await sleep(3000)
      check(
        'nothing relaunched',
        (await pidsAt(APP)).length === 1,
        `${(await pidsAt(APP)).length} process(es) at ${APP}`
      )

      const again = launchOld('old-app-2.log')
      log(`relaunched the old app by hand as pid ${again.pid}`)
      const cdp2 = await attach(90_000)
      const after = await cdp2.eval<Status>('window.api.updates.get()')
      check(
        'the relaunched app reports the hand-over as waiting',
        after.installFailure?.version === NEW &&
          /waiting for the app to quit/i.test(after.installFailure?.reason ?? ''),
        JSON.stringify(after)
      )
      second.kill('SIGTERM')
      await waitExit(second, 15_000)
      log('second instance gone; retrying from the waiting state')
      const retried = await driveToReady(cdp2)
      check('retry cleared the failure', !retried.installFailure, JSON.stringify(retried))
      const feedHits = feedLog.filter((l) => l.includes(zipName)).length
      check('retry downloaded the zip again', feedHits >= 2, `${feedHits} zip fetches`)
      // The retry removed the launchd job: the waiting ShipIt must be gone,
      // not respawning against a missing state file.
      await sleep(3000)
      const jobs = await sh(['launchctl', 'list'], { quiet: true }).catch(() => '')
      const loop = (existsSync(SHIPIT_LOG) ? readFileSync(SHIPIT_LOG, 'utf8') : '').includes(
        'Could not read update request'
      )
      check(
        'the waiting ShipIt was dismissed cleanly',
        !jobs.includes(SHIPIT_LABEL) && !loop,
        loop
          ? 'ShipIt respawn loop in the log'
          : jobs.includes(SHIPIT_LABEL)
            ? 'job still loaded'
            : ''
      )
      log('apply again: restart to update (retry)')
      const restartAt2 = Date.now()
      await cdp2
        .eval<Status>('window.api.updates.apply()')
        .catch((e) => log(`apply (restart) threw: ${e.message}`))
      check('restart quits the app', await waitExit(again, 60_000))
      relaunched = await finishInstall(restartAt2)
      return
    }

    if (busy) {
      const cwd = join(ROOT, 'busy-cwd')
      mkdirSync(cwd, { recursive: true })
      const created = await cdp.eval<{ id: string }>(
        `window.__docket.registry.primary().request('session.create', ${JSON.stringify({ provider: 'claude', model: 'claude-haiku-5-5', reasoning: 'low', cwd, title: 'e2e busy' })})`
      )
      await cdp.eval(
        `window.__docket.registry.primary().request('session.send', ${JSON.stringify({ sessionId: created.id, text: 'Write a 2500-word essay on the history of the typewriter. Do not stop early and do not ask questions.' })})`
      )
      let row: { status?: string } | undefined
      const busyUntil = Date.now() + 60_000
      while (Date.now() < busyUntil) {
        const rows = await cdp.eval<Array<{ id: string; status?: string }>>(
          `window.__docket.registry.primary().request('session.list')`
        )
        row = rows.find((r) => r.id === created.id)
        if (row?.status === 'running') break
        await sleep(500)
      }
      check(
        'a thread is running before the restart',
        row?.status === 'running',
        JSON.stringify(row)
      )
      await sleep(1500)
    }

    log(`apply again: restart to update${busy ? ' (busy)' : ''}`)
    const restartAt = Date.now()
    await cdp
      .eval<Status>('window.api.updates.apply()')
      .catch((e) => log(`apply (restart) threw: ${e.message}`))
    const exited = await waitExit(oldProc, 60_000)
    if (!exited) {
      const pages = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)
        .then((r) => r.json() as Promise<Target[]>)
        .catch(() => [] as Target[])
      const visible = await cdp.eval<string>('document.visibilityState').catch(() => 'unknown')
      check(
        'restart quits the app',
        false,
        `pid ${oldProc.pid} still alive 60s after restart; renderer ${visible}; pages ${pages.length}; this is the stall`
      )
      cdp.close()
      oldProc.kill('SIGTERM')
      await Promise.race([oldProc.exited, sleep(10_000)])
      if (!(await runningCount())) log('old app killed')
      throw new Error('stall')
    }
    check(
      'restart quits the app',
      true,
      `exited ${((Date.now() - restartAt) / 1000).toFixed(1)}s after apply`
    )
    relaunched = await finishInstall(restartAt)
    if (next && relaunched) await nextUpdate(relaunched)
  } catch (e) {
    if ((e as Error).message !== 'stall') check('e2e run', false, (e as Error).message)
  } finally {
    relaunched?.close()
    await killAll()
    await tryRun(['launchctl', 'remove', SHIPIT_LABEL])
    server.stop(true)
  }
}
await drive()

writeFileSync(join(ROOT, 'facts.json'), JSON.stringify(facts, null, 2))
log(`artifacts under ${ROOT}; old app log ${appLog}; ShipIt log ${SHIPIT_LOG}`)
console.log(failures === 0 ? 'E2E UPDATER: PASS' : `E2E UPDATER: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
