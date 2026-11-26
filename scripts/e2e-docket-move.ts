/**
 * The move to Docket's names (docs/agents/docket-data-move.md), for real, on
 * Linux: the built app run as an installed one, on a scratch HOME and XDG.
 *
 *   bun scripts/e2e-docket-move.ts [--old <build dir>] [--keep]
 *
 * An installed build is any Electron whose binary is not named `electron`
 * (app.isPackaged), so each build runs from a hard-linked copy of its own
 * Electron named `docket`, with resources/app a link to the build. The older
 * build (the deployed one by default: code from before the move) lays down the
 * old layout: ~/.config/temp-code with temp-code.db, a workspace on a scratch
 * repo holding its own .temp-code/, a worktree project under
 * ~/.temp-code/worktrees and two threads. Then this tree's build starts on it
 * and must move the folders and the database, leave links at the old names,
 * keep every thread and the worktree, and take a new thread; started again it
 * changes nothing; the older build started after it still sees every thread
 * through the links and writes to docket.db; and this build back again sees
 * the older build's thread. Last, the box's shape: an unpackaged build on an
 * override folder renames only the database.
 *
 * Each launch is headless under Xvfb with its own debug and remote ports, a
 * marker in its environment, and is stopped by its process group, then by the
 * marker. Needs `out/main` (electron-vite build). No account is used: threads
 * are created, never sent.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..')
const argv = process.argv.slice(2)
const KEEP = argv.includes('--keep')
const OLD = realpathSync(argv.includes('--old') ? argv[argv.indexOf('--old') + 1] : '/srv/agents/temp-code-builds/current')
let failures = 0
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const log = (m: string): void => console.log(`      ${m}`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

for (const build of [REPO, OLD]) {
  if (!existsSync(join(build, 'out', 'main', 'boot.js'))) {
    console.error(`${build}/out/main is missing: run electron-vite build first`)
    process.exit(2)
  }
}

const root = realpathSync(mkdtempSync(join(tmpdir(), 'docket-move-e2e-')))
const MARK = `docket-move-e2e:${root}`
const home = join(root, 'home')
const config = join(home, '.config')
const tmp = join(root, 'tmp')
const runtime = join(root, 'run')
const repo = join(root, 'work', 'repo')
const logFile = join(root, 'instance.log')
for (const d of [home, config, tmp, runtime, repo]) mkdirSync(d, { recursive: true, mode: 0o700 })
const oldData = join(config, 'temp-code')
const newData = join(config, 'Docket')
const sha = (dir: string): string => spawnSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim()

/** A build's own Electron, hard-linked under another name so it runs as an installed app. */
function installed(label: string, build: string): string {
  const dir = join(root, 'apps', label)
  mkdirSync(join(root, 'apps'), { recursive: true })
  const r = spawnSync('cp', ['-al', join(build, 'node_modules', 'electron', 'dist'), dir])
  if (r.status !== 0) throw Error(`cp -al: ${r.stderr}`)
  renameSync(join(dir, 'electron'), join(dir, 'docket'))
  symlinkSync(build, join(dir, 'resources', 'app'))
  return join(dir, 'docket')
}

const freePort = (): Promise<number> =>
  new Promise((ok, fail) => {
    const s = createServer()
    s.once('error', fail)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => ok(port))
    })
  })

interface Launch {
  child: ChildProcess
  data: string
  label: string
}
let current: Launch | undefined

/** One headless launch, its environment written whole: nothing of this shell's (its TEMP_CODE_USER_DATA least of all). */
async function launch(label: string, exe: string, o: { data: string; override?: string; app?: string }): Promise<Launch> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_RUNTIME_DIR: runtime,
    TMPDIR: tmp,
    SHELL: '/bin/bash',
    LANG: 'C.UTF-8',
    NODE_ENV: 'production',
    WINVM_DIR: join(root, 'no-vm'),
    AGENT_CLI_CREDENTIAL_STORE: 'file',
    TEMP_CODE_HEADLESS: '1',
    TEMP_CODE_CLAIM_SHIM: '0',
    TEMP_CODE_WARM_HARNESS: '0',
    TEMP_CODE_DEBUG_PORT: String(await freePort()),
    TEMP_CODE_REMOTE_PORT: String(await freePort()),
    DOCKET_MOVE_E2E: MARK
  }
  if (o.override) env.TEMP_CODE_USER_DATA = o.override
  rmSync(join(o.data, 'server.json'), { force: true })
  appendFileSync(logFile, `\n===== ${label} (${exe})\n`)
  const args = ['-a', '-s', '-screen 0 1280x800x24 -nolisten tcp', 'dbus-run-session', '--', exe, '--no-sandbox', ...(o.app ? [o.app] : [])]
  const child = spawn('xvfb-run', args, { cwd: o.app ?? root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  child.stdout?.on('data', (c: Buffer) => appendFileSync(logFile, c))
  child.stderr?.on('data', (c: Buffer) => appendFileSync(logFile, c))
  current = { child, data: o.data, label }
  log(`${label}: pid ${child.pid}, debug ${env.TEMP_CODE_DEBUG_PORT}, remote ${env.TEMP_CODE_REMOTE_PORT}`)
  // Up once its socket answers: a server.json alone may be one an earlier launch left in a folder that moved.
  const answers = async (): Promise<boolean> => existsSync(join(o.data, 'server.json')) && (await rpc('session.list').then(() => true))
  const up = await until(`${label} up`, 180_000, async () => child.exitCode !== null || (await answers()))
  if (!up || child.exitCode !== null) throw Error(`${label} never came up (exit ${child.exitCode}); see ${logFile}`)
  return current
}

/** SIGTERM to the launch's process group, SIGKILL after 20 s, then any process still carrying the marker. */
async function stop(l: Launch | undefined): Promise<void> {
  if (!l) return
  if (l.child.exitCode === null) {
    const exited = new Promise<void>((ok) => l.child.once('exit', () => ok()))
    try {
      process.kill(-l.child.pid!, 'SIGTERM')
    } catch {
      l.child.kill('SIGTERM')
    }
    if (!(await Promise.race([exited.then(() => true), sleep(20_000).then(() => false)]))) {
      try {
        process.kill(-l.child.pid!, 'SIGKILL')
      } catch {
        // gone
      }
      await exited
    }
  }
  for (const pid of marked()) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // gone
    }
  }
  rmSync(join(l.data, 'server.json'), { force: true })
  if (current === l) current = undefined
}

/** Pids whose environment carries this run's marker: what a group signal missed. */
function marked(): number[] {
  const pids: number[] = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue
    try {
      if (readFileSync(`/proc/${name}/environ`, 'latin1').split('\0').includes(`DOCKET_MOVE_E2E=${MARK}`)) pids.push(Number(name))
    } catch {
      // not ours to read, or gone
    }
  }
  return pids
}

const until = async (label: string, ms: number, test: () => Promise<boolean> | boolean): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await Promise.resolve(test()).catch(() => false)) return true
    await sleep(500)
  }
  log(`timed out: ${label}`)
  return false
}

/** One request on the running launch's local socket (the implicit admin). */
async function rpc<T = unknown>(method: string, params: unknown = {}): Promise<T> {
  const { port } = JSON.parse(readFileSync(join(current!.data, 'server.json'), 'utf8')) as { port: number }
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
  return new Promise<T>((ok, fail) => {
    const timer = setTimeout(() => {
      ws.close()
      fail(new Error(`no answer to ${method}`))
    }, 60_000)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 'e2e', method, params })))
    ws.addEventListener('message', (ev) => {
      const frame = JSON.parse(String(ev.data)) as { id?: string; ok?: boolean; result?: T; error?: string }
      if (frame.id !== 'e2e') return
      clearTimeout(timer)
      ws.close()
      if (frame.ok) ok(frame.result as T)
      else fail(new Error(`${method}: ${frame.error}`))
    })
    ws.addEventListener('error', () => fail(new Error(`${method}: socket error`)))
  })
}

type Meta = { id: string; title: string; cwd: string }
type DataMove = { userData: string; db: string; did: string[]; held: string[] }
const titles = async (): Promise<string[]> => (await rpc<Meta[]>('session.list')).map((m) => m.title).sort()
const dataMove = async (): Promise<DataMove | undefined> => (await rpc<{ dataMove?: DataMove }>('doctor.get')).dataMove
const create = async (title: string, params: Record<string, unknown>): Promise<Meta> =>
  rpc<Meta>('session.create', { title, threadType: 'chat', ...params })
const linksTo = (path: string, target: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink() && readlinkSync(path) === target
  } catch {
    return false
  }
}
const realFile = (path: string): boolean => {
  try {
    return lstatSync(path).isFile()
  } catch {
    return false
  }
}
const git = (dir: string, ...args: string[]): { ok: boolean; out: string } => {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home } })
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`.trim() }
}
const listing = (dir: string): string =>
  readdirSync(dir)
    .filter((n) => n.includes('.db'))
    .sort()
    .map((n) => (lstatSync(join(dir, n)).isSymbolicLink() ? `${n}→${readlinkSync(join(dir, n))}` : n))
    .join(' ')

const cleanup = async (): Promise<void> => {
  await stop(current)
  if (!KEEP) rmSync(root, { recursive: true, force: true })
  else log(`kept ${root}`)
}
process.on('SIGINT', () => void cleanup().then(() => process.exit(130)))

try {
  log(`scratch ${root}`)
  log(`older build ${OLD} (${sha(OLD)}), this build ${REPO} (${sha(REPO)})`)
  const oldExe = installed('older', OLD)
  const newExe = installed('this', REPO)

  // A scratch repo with a project folder of its own, as the owner's repos have.
  git(repo, 'init', '-q', '-b', 'main')
  mkdirSync(join(repo, '.temp-code'))
  writeFileSync(join(repo, '.temp-code', 'notes.md'), 'the project folder\n')
  writeFileSync(join(repo, 'README.md'), 'scratch\n')
  git(repo, 'add', '.')
  git(repo, '-c', 'user.email=e2e@e2e', '-c', 'user.name=e2e', 'commit', '-q', '-m', 'one')

  // A. The older build lays down the old layout.
  let run = await launch('older build, first start', oldExe, { data: oldData })
  check('the older build runs as an installed app on ~/.config/temp-code', realFile(join(oldData, 'temp-code.db')), listing(oldData))
  const workspace = await rpc<{ id: string }>('workspace.create', { path: repo })
  const project = await rpc<{ id: string; cwd: string }>('project.create', { workspaceId: workspace.id, name: 'wt', mode: 'worktree' })
  check('its worktree project lives under ~/.temp-code/worktrees', project.cwd.startsWith(join(home, '.temp-code', 'worktrees')), project.cwd)
  await create('seeded-chat', { cwd: repo, workspaceId: workspace.id })
  await create('seeded-project', { projectId: project.id })
  const seeded = await titles()
  check('two threads seeded', seeded.join(',') === 'seeded-chat,seeded-project', seeded.join(','))
  await stop(run)
  check('the old layout stands', lstatSync(oldData).isDirectory() && !existsSync(newData) && lstatSync(join(home, '.temp-code')).isDirectory())

  // B. This build moves it.
  run = await launch('this build, first start', newExe, { data: newData })
  check('~/.config/temp-code is a link to Docket', linksTo(oldData, 'Docket'))
  check('Docket is the real folder', lstatSync(newData).isDirectory() && !lstatSync(newData).isSymbolicLink())
  check('docket.db is the real database, temp-code.db a link to it', realFile(join(newData, 'docket.db')) && linksTo(join(newData, 'temp-code.db'), 'docket.db'), listing(newData))
  check('~/.temp-code is a link to .docket', linksTo(join(home, '.temp-code'), '.docket') && lstatSync(join(home, '.docket')).isDirectory())
  check("the repo's own .temp-code stays a real folder", lstatSync(join(repo, '.temp-code')).isDirectory() && !lstatSync(join(repo, '.temp-code')).isSymbolicLink())
  let move = await dataMove()
  check('doctor.get names the moved folder and database', move?.userData === newData && move.db === 'docket.db', JSON.stringify(move))
  check('doctor.get says what moved, and holds nothing back', (move?.did.length ?? 0) >= 3 && move?.held.length === 0, JSON.stringify(move))
  for (const line of move?.did ?? []) log(`did: ${line}`)
  check('both threads are still there', (await titles()).join(',') === 'seeded-chat,seeded-project')
  const projects = await rpc<{ id: string; cwd: string }[]>('project.list')
  const cwd = projects.find((p) => p.id === project.id)?.cwd ?? ''
  check('the project keeps its stored path', cwd === project.cwd, cwd)
  check('git works in the worktree by its stored path', git(cwd, 'status', '--short').ok, git(cwd, 'status', '--short').out)
  // git keeps the path the worktree was made at, now through the link; prune must not take it for gone.
  git(repo, 'worktree', 'prune')
  check('git still lists the worktree after a prune', git(repo, 'worktree', 'list').out.includes(cwd), git(repo, 'worktree', 'list').out)
  await create('after-move', { cwd: repo, workspaceId: workspace.id })
  check('a new thread is created after the move', (await titles()).includes('after-move'))
  await stop(run)

  // C. Started again, it changes nothing.
  run = await launch('this build, second start', newExe, { data: newData })
  move = await dataMove()
  check('the second start moves nothing', move?.did.length === 0 && move.held.length === 0 && move.db === 'docket.db', JSON.stringify(move))
  check('all three threads are there', (await titles()).join(',') === 'after-move,seeded-chat,seeded-project')
  await stop(run)

  // D. The older build on the same home works through the links.
  run = await launch('older build after the move', oldExe, { data: oldData })
  check('the older build sees all three threads', (await titles()).join(',') === 'after-move,seeded-chat,seeded-project')
  await create('older-after', { cwd: repo, workspaceId: workspace.id })
  check('the older build creates a thread', (await titles()).includes('older-after'))
  check('it writes to docket.db: no temp-code.db WAL of its own', !existsSync(join(newData, 'temp-code.db-wal')) && !existsSync(join(newData, 'temp-code.db-shm')), listing(newData))
  check('the links are left as they were', linksTo(oldData, 'Docket') && linksTo(join(newData, 'temp-code.db'), 'docket.db'))
  await stop(run)

  // E. This build again sees the older build's thread.
  run = await launch('this build after the older one', newExe, { data: newData })
  check("this build sees the older build's thread", (await titles()).includes('older-after'), (await titles()).join(','))
  check('and moves nothing', (await dataMove())?.did.length === 0)
  await stop(run)

  // F. The box's shape: an unpackaged build on an override folder renames the database alone.
  const boxData = join(root, 'box-data')
  mkdirSync(boxData)
  run = await launch('older build, box shape', join(OLD, 'node_modules', 'electron', 'dist', 'electron'), { data: boxData, override: boxData, app: OLD })
  await create('box-thread', { cwd: repo })
  await stop(run)
  const boxLink = join(root, 'box-link')
  symlinkSync('box-data', boxLink)
  run = await launch('this build, box shape', join(REPO, 'node_modules', 'electron', 'dist', 'electron'), { data: boxLink, override: boxLink, app: REPO })
  move = await dataMove()
  check('on an override the folder stays where it is named', move?.userData === boxLink && lstatSync(boxLink).isSymbolicLink() && !existsSync(join(root, 'Docket')), JSON.stringify(move))
  check('and the database takes its new name', move?.db === 'docket.db' && realFile(join(boxData, 'docket.db')) && linksTo(join(boxData, 'temp-code.db'), 'docket.db'), listing(boxData))
  check('its thread is there', (await titles()).includes('box-thread'))
  await stop(run)
} catch (err) {
  check('the run finished', false, err instanceof Error ? err.message : String(err))
  log(`last lines of ${logFile}:`)
  try {
    for (const line of readFileSync(logFile, 'utf8').trim().split('\n').slice(-30)) log(line)
  } catch {
    // no log
  }
} finally {
  await cleanup()
  const left = marked()
  check('no process of this run is left', left.length === 0, left.join(','))
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed')
process.exit(failures ? 1 : 0)
