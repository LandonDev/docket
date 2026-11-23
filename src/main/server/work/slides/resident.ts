import { spawn as nodeSpawn, execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LIBREOFFICE_PROFILE } from '../formats'
import { adoptTree, killTree, treeSpawnOptions } from '../../procTree'
import { RESIDENT_PY } from './residentScript'

/**
 * One LibreOffice kept running per host for decks (SLD3 in
 * .temp-code/plans/editors/slides.md): an edit's slide is drawn as a one-page
 * PDF in a fraction of a second, where starting LibreOffice for the whole deck
 * takes seconds.
 *
 * One child: LibreOffice's own bundled Python running RESIDENT_PY, which starts
 * soffice (the profile and options every LibreOffice job gets) with a UNO
 * listener on a pipe and drives it. Both are one process tree (procTree.ts),
 * killed as one. Started on the first job; one job at a time, in order; a job
 * with no answer in JOB_MS kills the tree and rejects with ResidentUnavailable,
 * as a crash does, so the caller draws the slide the old way and the next job
 * starts afresh. Stopped after IDLE_MS with nothing to do, past MEMORY_CAP, and
 * by `stop()`.
 *
 * The pipe: LibreOffice puts a pipe named N at `/tmp/OSL_PIPE_<uid>_N` and
 * reads no setting to move it. So the name is `tcr<random>/s` and
 * `/tmp/OSL_PIPE_<uid>_tcr<random>` is a link this module makes to a folder of
 * mode 0700 under `folder`: the socket itself lives there, and the path the
 * kernel is given stays short (macOS allows 104 bytes).
 */

export const JOB_MS = 10_000
export const START_MS = 30_000
export const IDLE_MS = 10 * 60_000
export const STOP_MS = 5_000
/** The tree's resident memory past which it is stopped once the job in hand is done. */
export const MEMORY_CAP = 1.5 * 1024 ** 3

/** Why the resident could not draw: the caller draws the slide the old way. */
export class ResidentUnavailable extends Error {
  constructor(
    readonly reason: 'unsupported' | 'start' | 'timeout' | 'crash' | 'failed' | 'stopped',
    message: string
  ) {
    super(message)
    this.name = 'ResidentUnavailable'
  }
}

export interface ResidentResult {
  /** the deck's slide count, hidden ones included */
  slides: number
  openMs: number
  exportMs: number
}

export interface ResidentState {
  phase: 'off' | 'starting' | 'idle' | 'busy' | 'unsupported'
  /** the driver's pid: the root of the tree */
  pid: number | null
  /** jobs waiting behind the one in hand */
  queued: number
}

export interface Resident {
  /** Writes a one-page PDF of slide `page` (from 1; hidden slides count) of the deck at `input` to `output`. */
  slide(input: string, page: number, output: string, signal?: AbortSignal): Promise<ResidentResult>
  /** Writes the whole deck as a PDF, hidden slides included. */
  deck(input: string, output: string, signal?: AbortSignal): Promise<ResidentResult>
  /** Ends the process; a later job starts it again. Rejects nothing but the jobs in hand and waiting. */
  stop(): Promise<void>
  state(): ResidentState
}

/** The bits of a child the resident uses: Node's ChildProcess has them, and so does a test's fake. */
export interface ResidentChild {
  pid?: number
  stdin: { write(s: string): unknown; end(): unknown; on?(event: 'error', fn: (err: Error) => void): unknown } | null
  stdout: NodeJS.EventEmitter | null
  stderr: NodeJS.EventEmitter | null
  on(event: 'exit', fn: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', fn: (err: Error) => void): unknown
}

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface ResidentDeps {
  /** The toolchain's soffice (`toolchain.bin('libreoffice')`), read at each start. */
  soffice: () => string | null
  /** The pillar's folder for it, e.g. `<dataDir>/work-slides/resident`: the profile, the script and the pipe's folder. */
  folder: string
  platform?: NodeJS.Platform
  spawn?: (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string }) => ResidentChild
  /** Ends the tree; procTree's killTree. */
  kill?: (pid: number, signal: NodeJS.Signals) => void
  /** Bytes the tree holds in memory. */
  rss?: (pid: number) => Promise<number>
  clock?: Clock
  /** Where LibreOffice puts its pipes (osl's PIPEDEFAULTPATH). */
  pipeRoot?: string
  uid?: number
  /** A file that exists (the script path, the bundled Python): fs by default. */
  exists?: (path: string) => boolean
  log?: (line: string) => void
}

/** LibreOffice's bundled Python beside its soffice: `program/python` on Linux, `Contents/Resources/python` in the macOS app. */
export function bundledPython(soffice: string, platform: NodeJS.Platform): string | null {
  if (platform === 'linux') return join(dirname(soffice), 'python')
  if (platform === 'darwin') return join(dirname(soffice), '..', 'Resources', 'python')
  return null
}

/** The argv of the resident soffice: the formats pillar's options for every job, a profile of its own, and the listener. */
export function sofficeArgs(soffice: string, profile: string, pipe: string): string[] {
  return [soffice, `-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--norestore', '--nologo', '--nodefault', '--nofirststartwizard', '--nolockcheck', `--accept=pipe,name=${pipe};urp;StarOffice.ComponentContext`]
}

/** The resident memory of every process in `pgid`'s group, in bytes (`ps`, on Linux and macOS). */
export function groupRss(pgid: number): Promise<number> {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pgid=,rss='], { maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve(0)
      resolve(sumGroupRss(out, pgid))
    })
  })
}

/** `ps -o pgid=,rss=` rows (rss in KiB) summed for one group. */
export function sumGroupRss(out: string, pgid: number): number {
  let kib = 0
  for (const line of out.split('\n')) {
    const [g, r] = line.trim().split(/\s+/)
    if (Number(g) === pgid) kib += Number(r) || 0
  }
  return kib * 1024
}

// Never the reason the app stays up: a timer of the resident's does not hold the process open.
const realClock: Clock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms).unref(), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) }

const abortError = (): Error => Object.assign(new Error('The job was cancelled.'), { name: 'AbortError' })

interface Job {
  id: number
  input: string
  output: string
  page: number | null
  signal?: AbortSignal
  resolve(r: ResidentResult): void
  reject(e: Error): void
  onAbort?: () => void
}

interface Live {
  child: ResidentChild
  pid: number
  link: string
  pipeDir: string
  ready: Promise<void>
  exited: Promise<void>
  /** the answer to the job in hand, by its id */
  waiting: Map<number, (msg: Record<string, unknown>) => void>
  /** killed, or being stopped: its end is ours, not a crash */
  dead: boolean
  gone: boolean
  stderr: string
}

export function createResident(deps: ResidentDeps): Resident {
  const platform = deps.platform ?? process.platform
  const clock = deps.clock ?? realClock
  const kill = deps.kill ?? ((pid, sig) => void killTree(pid, sig))
  const rss = deps.rss ?? groupRss
  const exists = deps.exists ?? existsSync
  const log = deps.log ?? (() => {})
  const pipeRoot = deps.pipeRoot ?? '/tmp'
  const uid = deps.uid ?? process.getuid?.() ?? 0
  const spawn =
    deps.spawn ??
    ((cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string }) =>
      adoptTree(nodeSpawn(cmd, args, { ...opts, stdio: ['pipe', 'pipe', 'pipe'], ...treeSpawnOptions(platform) }), platform))
  // Windows: no LibreOffice in the toolchain there, and its pipes are named another way; never proven, so never tried.
  const supported = platform === 'linux' || platform === 'darwin'

  const queue: Job[] = []
  let current: Job | null = null
  let live: Live | null = null
  let starting = false
  let idleTimer: unknown = null
  let nextId = 1
  let pumping = false
  /** The old tree still ending (a stop asked gently): the next start waits for it, so two never share the profile. */
  let closing: Promise<void> | null = null

  const clearIdle = (): void => {
    if (idleTimer !== null) clock.clearTimeout(idleTimer)
    idleTimer = null
  }

  /** Kills the tree and forgets it: a job in hand is the caller's to reject. */
  const end = (l: Live, why: string): void => {
    if (live === l) live = null
    if (!l.dead) {
      l.dead = true
      log(`[slides] the resident LibreOffice ends: ${why}`)
      if (!l.gone) {
        try {
          kill(l.pid, 'SIGKILL')
        } catch {
          /* gone */
        }
      }
    }
    cleanPipe(l)
  }

  const cleanPipe = (l: Live): void => {
    try {
      if (lstatSync(l.link).isSymbolicLink() && readlinkSync(l.link) === l.pipeDir) unlinkSync(l.link)
    } catch {
      /* gone */
    }
    rmSync(l.pipeDir, { recursive: true, force: true })
  }

  const start = (): Live => {
    const soffice = deps.soffice()
    if (!soffice) throw new ResidentUnavailable('start', 'LibreOffice is not installed here.')
    const python = bundledPython(soffice, platform)
    if (!python || !exists(python)) throw new ResidentUnavailable('start', "LibreOffice's own Python is not beside its soffice.")
    mkdirSync(deps.folder, { recursive: true, mode: 0o700 })
    chmodSync(deps.folder, 0o700)
    // A pipe folder left by a run that died with the app: nothing listens there now. Its link under the pipe root
    // goes with it: only links of ours (by name and by where they point) are touched.
    for (const f of readdirSync(deps.folder)) if (f.startsWith('pipe-')) rmSync(join(deps.folder, f), { recursive: true, force: true })
    try {
      for (const f of readdirSync(pipeRoot)) {
        if (!f.startsWith(`OSL_PIPE_${uid}_tcr`)) continue
        const link = join(pipeRoot, f)
        try {
          if (lstatSync(link).isSymbolicLink() && readlinkSync(link).startsWith(join(deps.folder, 'pipe-'))) unlinkSync(link)
        } catch {
          /* gone, or not ours to read */
        }
      }
    } catch {
      /* no pipe root to sweep */
    }
    const profile = join(deps.folder, 'profile')
    const seeded = join(profile, 'user', 'registrymodifications.xcu')
    if (!exists(seeded)) {
      mkdirSync(join(profile, 'user'), { recursive: true })
      writeFileSync(seeded, LIBREOFFICE_PROFILE)
    }
    const script = join(deps.folder, 'resident.py')
    writeFileSync(script, RESIDENT_PY, { mode: 0o600 })
    const tag = `tcr${randomBytes(12).toString('hex')}`
    const pipeDir = join(deps.folder, `pipe-${tag}`)
    mkdirSync(pipeDir, { mode: 0o700 })
    chmodSync(pipeDir, 0o700)
    const link = join(pipeRoot, `OSL_PIPE_${uid}_${tag}`)
    // symlink fails when the name is taken: the random name is ours alone, and never someone else's link followed.
    symlinkSync(pipeDir, link)
    const pipe = `${tag}/s`
    const env: NodeJS.ProcessEnv = {}
    // The bundled Python's own wrapper sets its paths; one of ours must not reach it.
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('PYTHON') && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
    env.PYTHONDONTWRITEBYTECODE = '1'
    env.PYTHONUNBUFFERED = '1'
    let child: ResidentChild
    try {
      // -s: no user site; -P: not the script's folder first on the path (Python 3.11 and later; LibreOffice 26.8 ships 3.13).
      child = spawn(python, ['-s', '-P', script, JSON.stringify(sofficeArgs(soffice, profile, pipe)), pipe, String(START_MS / 1000)], { env, cwd: deps.folder })
    } catch (err) {
      rmSync(pipeDir, { recursive: true, force: true })
      try {
        unlinkSync(link)
      } catch {
        /* gone */
      }
      throw new ResidentUnavailable('start', `The resident LibreOffice did not start: ${(err as Error).message}`)
    }
    let readyOk!: () => void
    let readyFail!: (e: Error) => void
    let exitedDone!: () => void
    const l: Live = {
      child,
      pid: child.pid ?? 0,
      link,
      pipeDir,
      ready: new Promise<void>((res, rej) => {
        readyOk = res
        readyFail = rej
      }),
      exited: new Promise<void>((res) => (exitedDone = res)),
      waiting: new Map(),
      dead: false,
      gone: false,
      stderr: ''
    }
    l.ready.catch(() => {})
    let buf = ''
    let isReady = false
    child.stdout?.on('data', (d: Buffer | string) => {
      buf += d.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        if (!isReady) {
          if (msg.ready === true) {
            isReady = true
            readyOk()
          } else readyFail(new ResidentUnavailable('start', `The resident LibreOffice did not start: ${String(msg.error ?? 'no answer')}`))
          continue
        }
        const fn = typeof msg.id === 'number' ? l.waiting.get(msg.id) : undefined
        if (fn) {
          l.waiting.delete(msg.id as number)
          fn(msg)
        }
      }
    })
    // A write after the driver died is an EPIPE on its stdin: the exit handler tells the job, and the app must not throw.
    child.stdin?.on?.('error', () => {})
    child.stderr?.on('data', (d: Buffer | string) => {
      l.stderr = (l.stderr + d.toString()).slice(-2000)
    })
    const gone = (why: string): void => {
      if (l.gone) return
      l.gone = true
      const was = l.dead
      end(l, why)
      readyFail(new ResidentUnavailable(isReady ? 'crash' : 'start', `The resident LibreOffice ${isReady ? 'stopped' : 'did not start'}: ${why}`))
      for (const fn of l.waiting.values()) fn({ crashed: was ? 'killed' : why })
      l.waiting.clear()
      exitedDone()
    }
    child.on('exit', (code, sig) => gone(`exit ${code ?? sig}${l.stderr ? `: ${l.stderr.trim().split('\n').slice(-2).join(' / ')}` : ''}`))
    child.on('error', (err) => gone(err.message))
    log(`[slides] the resident LibreOffice starts (pid ${l.pid})`)
    return l
  }

  /** Waits for `l` to listen, killing it past START_MS. */
  const whenReady = (l: Live): Promise<void> => {
    let timer: unknown = null
    return Promise.race([
      l.ready,
      new Promise<void>((_, rej) => {
        timer = clock.setTimeout(() => {
          end(l, 'it did not listen in time')
          rej(new ResidentUnavailable('start', `The resident LibreOffice did not listen within ${START_MS / 1000} s.`))
        }, START_MS)
      })
    ]).finally(() => clock.clearTimeout(timer))
  }

  /** Answers the job's result, or null when its caller was already answered (a job cancelled while it ran). */
  const run = async (job: Job): Promise<ResidentResult | null> => {
    if (closing) await closing
    if (!live) {
      starting = true
      try {
        let l: Live
        try {
          l = start()
        } catch (err) {
          throw err instanceof ResidentUnavailable ? err : new ResidentUnavailable('start', `The resident LibreOffice did not start: ${(err as Error).message}`)
        }
        live = l
        try {
          await whenReady(l)
        } catch (err) {
          end(l, 'it did not start')
          throw err
        }
      } finally {
        starting = false
      }
    } else await live.ready
    const l = live
    if (!l || l.dead) throw new ResidentUnavailable('crash', 'The resident LibreOffice stopped before the job.')
    // Cancelled while it started: nothing was sent, so the process stays for the next job.
    if (job.signal?.aborted) throw abortError()
    const part = `${job.output}.part-${job.id}.pdf`
    const answer = new Promise<Record<string, unknown>>((resolve) => l.waiting.set(job.id, resolve))
    let timer: unknown = null
    const timedOut = new Promise<Record<string, unknown>>((resolve) => {
      timer = clock.setTimeout(() => resolve({ timedOut: true }), JOB_MS)
    })
    let aborted: (() => void) | null = null
    const abortedP = new Promise<Record<string, unknown>>((resolve) => {
      aborted = () => resolve({ aborted: true })
      job.signal?.addEventListener('abort', aborted, { once: true })
    })
    try {
      l.child.stdin?.write(`${JSON.stringify({ id: job.id, input: job.input, output: part, page: job.page })}\n`)
      let msg = await Promise.race([answer, timedOut, abortedP])
      let told = false
      if (msg.aborted) {
        // UNO cannot cancel a job in hand, and killing LibreOffice would cost the next job a start: its caller is
        // answered now, the job runs out (within its ten seconds) and its picture is dropped.
        job.reject(abortError())
        told = true
        msg = await Promise.race([answer, timedOut])
      }
      if (msg.timedOut) {
        end(l, `job ${job.id} had no answer in ${JOB_MS / 1000} s`)
        if (told) return null
        throw new ResidentUnavailable('timeout', `LibreOffice did not draw it within ${JOB_MS / 1000} s.`)
      }
      if (told) return null
      if (msg.crashed === 'stopped') throw new ResidentUnavailable('stopped', 'The resident LibreOffice was stopped during the job.')
      if (msg.crashed) throw new ResidentUnavailable('crash', `The resident LibreOffice stopped during the job (${String(msg.crashed)}).`)
      if (msg.ok !== true) throw new ResidentUnavailable('failed', `LibreOffice could not draw it: ${String(msg.error ?? 'no answer')}`)
      renameSync(part, job.output)
      return { slides: Number(msg.slides), openMs: Math.round(Number(msg.open) * 1000), exportMs: Math.round(Number(msg.export) * 1000) }
    } finally {
      clock.clearTimeout(timer)
      l.waiting.delete(job.id)
      if (aborted) job.signal?.removeEventListener('abort', aborted)
      rmSync(part, { force: true })
    }
  }

  const checkMemory = async (l: Live): Promise<void> => {
    if (l.dead || !l.pid) return
    const bytes = await rss(l.pid).catch(() => 0)
    if (bytes > MEMORY_CAP && live === l && !current) await stopLive(l, `it holds ${Math.round(bytes / 1024 ** 2)} MiB, past the cap`)
  }

  const pump = async (): Promise<void> => {
    if (pumping) return
    pumping = true
    try {
      while (queue.length) {
        clearIdle()
        const job = queue.shift()!
        if (job.onAbort) job.signal?.removeEventListener('abort', job.onAbort)
        current = job
        try {
          const done = await run(job)
          if (done) job.resolve(done)
        } catch (err) {
          const e = err instanceof ResidentUnavailable || (err as Error).name === 'AbortError' ? (err as Error) : new ResidentUnavailable('failed', (err as Error).message)
          job.reject(e)
          // A start that failed fails the same way for every job behind it: they draw the old way now.
          if (e instanceof ResidentUnavailable && e.reason === 'start') for (const j of queue.splice(0)) settleQueued(j, e)
        } finally {
          current = null
        }
        if (live) await checkMemory(live)
      }
    } finally {
      pumping = false
    }
    if (live && !queue.length) {
      const l = live
      idleTimer = clock.setTimeout(() => {
        idleTimer = null
        if (live === l && !current && !queue.length) void stopLive(l, `idle for ${IDLE_MS / 60_000} minutes`)
      }, IDLE_MS)
    }
  }

  const settleQueued = (j: Job, e: Error): void => {
    if (j.onAbort) j.signal?.removeEventListener('abort', j.onAbort)
    j.reject(e)
  }

  /** Asks the driver to end soffice (stdin closed), and kills the tree if it is not gone in STOP_MS. */
  const stopLive = (l: Live, why: string): Promise<void> => {
    const done = stopNow(l, why)
    const mine: Promise<void> = (closing = done.finally(() => {
      if (closing === mine) closing = null
    }))
    return mine
  }
  const stopNow = async (l: Live, why: string): Promise<void> => {
    if (live === l) live = null
    if (l.dead) return
    l.dead = true
    log(`[slides] the resident LibreOffice stops: ${why}`)
    try {
      l.child.stdin?.end()
    } catch {
      /* gone */
    }
    let timer: unknown = null
    await Promise.race([l.exited, new Promise<void>((res) => (timer = clock.setTimeout(res, STOP_MS)))])
    clock.clearTimeout(timer)
    // What the driver left (or the driver itself, when soffice would not end) goes with the group.
    if (!l.gone) {
      try {
        kill(l.pid, 'SIGKILL')
      } catch {
        /* gone */
      }
    }
    cleanPipe(l)
  }

  const enqueue = (input: string, page: number | null, output: string, signal?: AbortSignal): Promise<ResidentResult> => {
    if (!supported) return Promise.reject(new ResidentUnavailable('unsupported', 'The resident LibreOffice runs on Linux and macOS only.'))
    if (signal?.aborted) return Promise.reject(abortError())
    return new Promise<ResidentResult>((resolve, reject) => {
      const job: Job = { id: nextId++, input, output, page, signal, resolve, reject }
      if (signal) {
        job.onAbort = () => {
          const at = queue.indexOf(job)
          if (at >= 0) {
            queue.splice(at, 1)
            reject(abortError())
          }
        }
        signal.addEventListener('abort', job.onAbort, { once: true })
      }
      queue.push(job)
      void pump()
    })
  }

  return {
    slide(input, page, output, signal) {
      if (!Number.isInteger(page) || page < 1) return Promise.reject(new RangeError('A slide is a whole number from 1.'))
      return enqueue(input, page, output, signal)
    },
    deck(input, output, signal) {
      return enqueue(input, null, output, signal)
    },
    async stop() {
      clearIdle()
      const stopped = new ResidentUnavailable('stopped', 'The resident LibreOffice was stopped.')
      for (const j of queue.splice(0)) settleQueued(j, stopped)
      const l = live
      if (!l) return
      if (current) {
        // The job in hand cannot be cancelled over UNO: kill, and its call rejects as stopped.
        end(l, 'stopped during a job')
        for (const fn of l.waiting.values()) fn({ crashed: 'stopped' })
        l.waiting.clear()
        return
      }
      await stopLive(l, 'asked to stop')
    },
    state() {
      if (!supported) return { phase: 'unsupported', pid: null, queued: 0 }
      const phase = starting ? 'starting' : current ? 'busy' : live ? 'idle' : 'off'
      return { phase, pid: live?.pid ?? null, queued: queue.length }
    }
  }
}
