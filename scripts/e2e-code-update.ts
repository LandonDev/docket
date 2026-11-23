#!/usr/bin/env bun
/**
 * A code-only update, end to end, in a signed packaged copy of the app that
 * can never touch the installed one (docs/agents/code-only-updates.md).
 *
 *   bun scripts/e2e-code-update.ts            # build, pack, sign, then drive
 *   bun scripts/e2e-code-update.ts --reuse    # keep the build under ROOT, redrive
 *
 * What it does:
 *   1. Builds the tree once and packs it with electron-builder, signed with
 *      the Developer ID identity and not notarized, as bundle id
 *      dev.landon.tempcode.e2ecode, product TempCodeCodeE2E, with a
 *      `tempcodeHarness` block naming its userData, its CDP port (9232) and
 *      `TEMP_CODE_CODE_HOST=self`: the copy takes code-only updates from its
 *      own server over a loopback socket (src/main/server/codeHarness.ts),
 *      so one process plays the host that offers a pack and the Mac that
 *      takes it. Everything else is the shipped path: `code.announce`,
 *      `code.latest`, `code.chunk`, the size and sha256 check, the unpack,
 *      boot's own check, the restart, boot.js's choice and its trial.
 *   2. Makes three packs from copies of the built `out/`, each changed by
 *      hand: GOOD (every entry leaves a mark: main, the gateway's utility
 *      process, the preload, the renderer's page), THROWS (its index throws
 *      while it loads) and DIES (its index exits the process while it
 *      loads, so the trial never says good).
 *   3. Drives the copy over CDP and its loopback socket:
 *      - GOOD is offered, staged and shown as "Restart to update". A quit
 *        and a fresh launch leave it waiting: only the Restart runs it.
 *        After the Restart the marks say every entry came from the staged
 *        tree, the bundle's node_modules and resources are found through
 *        the links, the version is the bundle's plus the commit, and the
 *        trial turns good a minute after the window mounted and was
 *        answered.
 *      - THROWS is offered and restarted into: the app comes back by itself
 *        on the bundle's code, says so once, and refuses the same commit.
 *      - DIES is offered and restarted into, from that fallback launch: the
 *        process ends; the next launch runs the bundle's code and says so
 *        once.
 *      - The choice turned off names no tree.
 *
 * Everything it writes lives under ROOT. The installed app, its data and its
 * caches are never read or written.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CODE_DIR, MANIFEST_FILE, STATE_FILE, type CodeState } from '../src/main/codeChoice'
import { fellBackLine, versionLine, type CodeUpdateStatus } from '../src/shared/codeUpdate'
import { packCode } from './lib/codePack'
import {
  attach as attachTo,
  builtApp as builtAppAt,
  type Cdp,
  findIdentity,
  killAt,
  launchEnv,
  pack as packApp,
  pidsAt,
  portFree,
  prepareEnv,
  readPackage,
  REPO,
  sh,
  sleep,
  waitForReleaseTrain
} from './lib/packagedApp'

const ROOT = '/private/tmp/tc-code-update-e2e'
const APP_ID = 'dev.landon.tempcode.e2ecode'
const PRODUCT = 'TempCodeCodeE2E'
const DEBUG_PORT = 9232
const USER_DATA = join(ROOT, 'userData')
const APP = join(ROOT, `${PRODUCT}.app`)
const EXE = join(APP, 'Contents', 'MacOS', PRODUCT)
const BUNDLE_ROOT = join(APP, 'Contents', 'Resources', 'app')
const CODE = join(USER_DATA, CODE_DIR)
const BUILD = join(ROOT, 'build')
const reuse = process.argv.includes('--reuse')

const GOOD = 'b'.repeat(40)
const THROWS = 'c'.repeat(40)
const DIES = 'd'.repeat(40)

prepareEnv()

let failures = 0
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const log = (msg: string): void => console.log(`[e2e-code-update ${new Date().toISOString().slice(11, 19)}] ${msg}`)

type Status = { current: string; phase: string; code?: CodeUpdateStatus }

// ── Preflight ──────────────────────────────────────────────────────────────

const N = readPackage().n
const VERSION = `1.0.${N}`
const identity = await findIdentity()
log(`bundle ${VERSION}, identity "${identity}", root ${ROOT}`)
await killAt(APP)
if (!reuse) rmSync(ROOT, { recursive: true, force: true })
else for (const dir of [APP, USER_DATA, join(ROOT, 'trees'), join(ROOT, 'packs')]) rmSync(dir, { recursive: true, force: true })
mkdirSync(ROOT, { recursive: true })
if (!(await portFree(DEBUG_PORT))) throw new Error(`port ${DEBUG_PORT} is in use`)
await waitForReleaseTrain(log)

// ── Build and pack the bundle ──────────────────────────────────────────────

if (!reuse) {
  log('electron-vite build')
  const at = Date.now()
  await sh(['bunx', 'electron-vite', 'build'], { quiet: true })
  log(`built in ${((Date.now() - at) / 1000).toFixed(0)} s`)
  await packApp({
    version: VERSION,
    which: 'bundle',
    outDir: BUILD,
    appId: APP_ID,
    product: PRODUCT,
    identity,
    check,
    log,
    harness: { TEMP_CODE_USER_DATA: USER_DATA, TEMP_CODE_DEBUG_PORT: DEBUG_PORT, TEMP_CODE_CODE_HOST: 'self' }
  })
} else if (!existsSync(builtAppAt(BUILD, PRODUCT))) throw new Error(`--reuse: ${builtAppAt(BUILD, PRODUCT)} missing`)

check('the build wrote its base stamp', existsSync(join(REPO, 'out', 'code-base.json')), readFileSync(join(REPO, 'out', 'code-base.json'), 'utf8').replace(/\s+/g, ' ').slice(0, 200))
check('boot.js requires no shared chunk', !/require\(["']\.\/chunks\//.test(readFileSync(join(REPO, 'out', 'main', 'boot.js'), 'utf8')))
await sh(['ditto', builtAppAt(BUILD, PRODUCT), APP])
check('the bundle carries the base stamp', existsSync(join(BUNDLE_ROOT, 'out', 'code-base.json')))
mkdirSync(USER_DATA, { recursive: true })

// ── The three packs ────────────────────────────────────────────────────────

const mark = (name: string): string =>
  `\n;try{require('node:fs').writeFileSync(require('node:path').join(process.env.TEMP_CODE_USER_DATA,'proof-${name}.txt'),'GOOD '+__filename)}catch{}\n`

function makePack(label: string, commit: string, release: number, subject: string, change: (out: string) => void): string {
  const tree = join(ROOT, 'trees', label)
  mkdirSync(tree, { recursive: true })
  cpSync(join(REPO, 'out'), join(tree, 'out'), { recursive: true })
  change(join(tree, 'out'))
  const { dir, manifest } = packCode({ root: tree, commit, release, subject, to: join(ROOT, 'packs', label), trustOut: true })
  log(`pack ${label}: ${commit.slice(0, 7)} as 1.0.${release}, ${manifest.tar.bytes} bytes`)
  return dir
}
const edit = (path: string, change: (text: string) => string): void => writeFileSync(path, change(readFileSync(path, 'utf8')))

const packs = {
  good: makePack('good', GOOD, N + 1, 'The proof’s good code. Every entry leaves a mark.', (out) => {
    edit(join(out, 'main', 'index.js'), (t) => t + mark('main'))
    edit(join(out, 'main', 'gateway.js'), (t) => t + mark('gateway'))
    edit(join(out, 'preload', 'index.js'), (t) => `${t}\n;try{require('electron').contextBridge.exposeInMainWorld('__tcCodeProof','GOOD')}catch{}\n`)
    edit(join(out, 'renderer', 'index.html'), (t) => t.replace('<head>', '<head><meta name="tc-code-proof" content="GOOD">'))
  }),
  throws: makePack('throws', THROWS, N + 2, 'The proof’s code that throws while it loads.', (out) => {
    edit(join(out, 'main', 'index.js'), (t) => `throw new Error('proof: this tree throws while it loads');\n${t}`)
  }),
  dies: makePack('dies', DIES, N + 3, 'The proof’s code that ends the process while it loads.', (out) => {
    edit(join(out, 'main', 'index.js'), (t) => `process.exit(7);\n${t}`)
  })
}

// ── Driving ────────────────────────────────────────────────────────────────

const env = launchEnv()
let launches = 0
function launch(): ReturnType<typeof Bun.spawn> {
  const file = Bun.file(join(ROOT, `app-${++launches}.log`))
  return Bun.spawn([EXE], { env, stdout: file, stderr: file })
}
const attach = (timeoutMs = 120_000): Promise<Cdp> => attachTo(DEBUG_PORT, timeoutMs)
const statusOf = (cdp: Cdp): Promise<Status> => cdp.eval<Status>('window.api.updates.get()')
const state = (): CodeState => {
  try {
    return JSON.parse(readFileSync(join(CODE, STATE_FILE), 'utf8')) as CodeState
  } catch {
    return { v: 1 }
  }
}
const proof = (name: string): string => {
  try {
    return readFileSync(join(USER_DATA, `proof-${name}.txt`), 'utf8')
  } catch {
    return ''
  }
}

/** One request on the app's own loopback socket, the way tc-local asks a host. */
async function rpc<T>(cdp: Cdp, method: string, params: unknown): Promise<T> {
  const port = await cdp.eval<number | null>('window.api.getServerPort()')
  if (!port) throw new Error('the app has no server port')
  return new Promise<T>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
    const timer = setTimeout(() => reject(new Error(`${method}: no answer in 60 s`)), 60_000)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 'e2e', method, params })))
    ws.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data)) as { id?: string; ok?: boolean; result?: T; error?: string }
      if (frame.id !== 'e2e') return
      clearTimeout(timer)
      ws.close()
      if (frame.ok) resolve(frame.result as T)
      else reject(new Error(frame.error ?? method))
    })
    ws.addEventListener('error', () => reject(new Error(`${method}: socket error`)))
  })
}

async function until<T>(what: string, ms: number, read: () => Promise<T | null | undefined | false> | T | null | undefined | false): Promise<T | null> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = await Promise.resolve(read()).catch(() => null)
    if (value) return value
    await sleep(500)
  }
  log(`timed out waiting for ${what}`)
  return null
}

/** Announce a pack to the copy's own server and wait until it is staged; the ms it took. */
async function offer(cdp: Cdp, label: string, dir: string, commit: string): Promise<number> {
  const at = Date.now()
  const head = await rpc<{ commit: string; bytes: number }>(cdp, 'code.announce', { dir })
  check(`${label}: the host takes the pack`, head.commit === commit, JSON.stringify(head))
  // The link's own word in the real app; here picking the stand-in host again asks it at once.
  await rpc(cdp, 'code.settings.set', { host: 'harness' })
  const ready = await until(`${label} staged`, 180_000, async () => {
    const s = await statusOf(cdp)
    return s.code?.offer?.commit === commit && s.code.offer.phase === 'ready' ? s : null
  })
  const ms = Date.now() - at
  check(`${label}: staged and offered as a restart`, !!ready, ready ? `${ms} ms from the announce; "${ready.code?.offer?.subject}"` : JSON.stringify(await statusOf(cdp)))
  check(`${label}: the state names the tree as staged`, state().current?.commit === commit && state().current?.state === 'staged', JSON.stringify(state()))
  return ms
}

/** Press the restart and wait until every process of the copy that ran before is gone. */
async function restart(cdp: Cdp, before: number[]): Promise<void> {
  await cdp.eval('window.api.updates.apply()').catch(() => undefined)
  cdp.close()
  const gone = await until('the old process to quit', 60_000, async () => {
    const now = await pidsAt(APP)
    return before.every((pid) => !now.includes(pid))
  })
  check('the restart quit the running app', !!gone)
}

async function drive(): Promise<void> {
  // 1. The bundle's own code.
  launch()
  let cdp = await attach()
  const booted = await statusOf(cdp)
  check('the copy boots on its bundle', booted.current === VERSION && !booted.code?.running, JSON.stringify(booted))
  const settings = await rpc<{ host: string | null; hosts: { id: string }[]; cannot: string | null }>(cdp, 'code.settings.get', {})
  check('the copy can take code, and its only host is chosen by default', settings.host === 'harness' && settings.hosts.length === 1 && settings.cannot === null, JSON.stringify(settings))

  // 2. GOOD: offered, staged, restarted into, running.
  const stagedMs = await offer(cdp, 'good', packs.good, GOOD)
  // The status is main's; the row repaints a push later.
  const said = await until('the row to say Restart to update', 10_000, async () => /Restart to update/.test(await cdp.eval<string>('document.body.innerText')))
  const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null)) as { data?: string } | null
  if (shot?.data) writeFileSync(join(ROOT, 'offer.png'), Buffer.from(shot.data, 'base64'))
  check('good: the window says Restart to update', !!said)

  // A quit and a fresh launch: the tree waits, the bundle's code runs, the offer is still there.
  cdp.close()
  await killAt(APP)
  launch()
  cdp = await attach()
  const waiting = await statusOf(cdp)
  check('good: a launch without the Restart runs the bundle’s code', !waiting.code?.running && proof('main') === '', JSON.stringify(waiting.code))
  check('good: the offer is still there after that launch', waiting.code?.offer?.commit === GOOD && waiting.code.offer.phase === 'ready' && state().current?.state === 'staged', JSON.stringify(state()))

  await restart(cdp, await pidsAt(APP))
  cdp = await attach()
  const running = await statusOf(cdp)
  check('good: the restarted app runs the staged commit', running.code?.running?.commit === GOOD, JSON.stringify(running.code))
  check('good: the version is the bundle’s plus the commit', versionLine(running.current, running.code?.running?.commit) === `${VERSION} + ${GOOD.slice(0, 7)}`, running.current)
  const staged = join(CODE, GOOD, 'out')
  check('good: main ran from the staged tree', proof('main') === `GOOD ${join(staged, 'main', 'index.js')}`, proof('main'))
  const gateway = await until('the gateway mark', 30_000, () => proof('gateway'))
  check('good: the gateway’s utility process ran from the staged tree', gateway === `GOOD ${join(staged, 'main', 'gateway.js')}`, gateway ?? '')
  check('good: the preload came from the staged tree', (await cdp.eval<string>('String(window.__tcCodeProof)')) === 'GOOD')
  check('good: the page came from the staged tree', (await cdp.eval<string>(`document.querySelector('meta[name="tc-code-proof"]')?.content ?? ''`)) === 'GOOD')
  const link = (name: string): string => {
    try {
      return lstatSync(join(CODE, GOOD, name)).isSymbolicLink() ? readlinkSync(join(CODE, GOOD, name)) : 'not a link'
    } catch {
      return 'missing'
    }
  }
  check('good: node_modules, resources and package.json are links to the bundle’s', ['node_modules', 'resources', 'package.json'].every((n) => link(n) === join(BUNDLE_ROOT, n)), ['node_modules', 'resources', 'package.json'].map(link).join(' | '))
  check('good: a native helper is found through the link', existsSync(join(CODE, GOOD, 'resources', 'native', 'tc-computer')) || existsSync(join(CODE, GOOD, 'resources', 'native', 'appshot-helper')))
  check('good: the tree is still on trial right after its window came up', state().current?.state === 'trying', JSON.stringify(state()))
  const good = await until('the trial to turn good', 150_000, () => (state().current?.state === 'good' ? state() : null))
  check('good: boot turned the trial good a minute after the window mounted and was answered', good?.current?.commit === GOOD, JSON.stringify(state()))
  check('good: the manifest lies beside the tree', existsSync(join(CODE, GOOD, MANIFEST_FILE)))

  // 3. THROWS: the app comes back by itself on the bundle's code.
  for (const name of ['main', 'gateway']) rmSync(join(USER_DATA, `proof-${name}.txt`), { force: true })
  await offer(cdp, 'throws', packs.throws, THROWS)
  await restart(cdp, await pidsAt(APP))
  cdp = await attach(180_000)
  const after = await statusOf(cdp)
  check('throws: the app came back on the bundle’s code', after.current === VERSION && !after.code?.running, JSON.stringify(after.code))
  check('throws: it says so once', after.code?.notice === fellBackLine(THROWS, VERSION), String(after.code?.notice))
  check('throws: no staged code ran in this launch', proof('main') === '', proof('main'))
  check('throws: the state names the failed tree and no current one', !state().current && state().failed?.commit === THROWS && /^threw: proof: this tree throws/.test(state().failed?.why ?? ''), JSON.stringify(state()))
  const swept = await until('the failed tree to be removed', 30_000, () => !existsSync(join(CODE, THROWS)))
  check('throws: the failed tree is removed', !!swept)
  await rpc(cdp, 'code.announce', { dir: packs.throws })
  await rpc(cdp, 'code.settings.set', { host: 'harness' })
  const refused = await until('the refusal', 30_000, async () => ((await statusOf(cdp)).code?.notice ?? '').includes('did not start here'))
  check('throws: the same commit is not taken twice', !!refused && !state().current, String((await statusOf(cdp)).code?.notice))

  // 4. DIES: the process ends in its trial; the next launch runs the bundle's code. The Restart here
  // starts from the launch boot made with --tempcode-bundle-code, which must not ride along.
  await offer(cdp, 'dies', packs.dies, DIES)
  await restart(cdp, await pidsAt(APP))
  const dead = await until('the dying tree to end the process', 60_000, async () => state().current?.state === 'trying' && (await pidsAt(APP)).length === 0)
  check('dies: the trial started and the process ended', !!dead && state().current?.commit === DIES, JSON.stringify(state()))
  launch()
  cdp = await attach(180_000)
  const last = await statusOf(cdp)
  check('dies: the next launch runs the bundle’s code', last.current === VERSION && !last.code?.running, JSON.stringify(last.code))
  check('dies: it says so once', last.code?.notice === fellBackLine(DIES, VERSION), String(last.code?.notice))
  check('dies: the state names the failed tree and no current one', !state().current && state().failed?.commit === DIES, JSON.stringify(state()))
  check('dies: the app answers', (await cdp.eval<string>('window.api.app.version()')) === VERSION)

  // 5. The choice.
  const off = await rpc<{ host: string | null }>(cdp, 'code.settings.set', { host: null })
  check('the choice turns off', off.host === null && !state().current)
  cdp.close()
  console.log(`MEASURED good pack: announce to "Restart to update" in ${stagedMs} ms (loopback)`)
}

try {
  await drive()
} catch (err) {
  check('the run finished', false, err instanceof Error ? (err.stack ?? err.message) : String(err))
} finally {
  await killAt(APP)
}
console.log(failures === 0 ? 'E2E CODE UPDATE: PASS' : `E2E CODE UPDATE: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
