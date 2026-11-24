import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnLowered } from '../../childPriority'
import { adoptTree, killTree, treeSpawnOptions } from '../../procTree'
import { toolsRoot } from '../formats/tools'
import { DECK_PY } from './deckScript'

/**
 * The deck tool kept running, one a host (docs/agents/work-slides.md "Edits by
 * hand"): his edit of a 50-slide deck is answered in a fifth of a second,
 * where a run of the tool for each edit takes most of one. Python and
 * python-pptx are loaded once, and the tool keeps what an edit would work
 * out again for every slide it did not touch (deckScript.ts `serve`): a
 * part's canonical form, a rels file's rows, a slide's entry in the outline.
 * Each is kept under the bytes it was made from and nothing else, never a
 * path or a time, so a deck that changed under it is read afresh.
 *
 * One child: the python-pptx tool's own Python on DECK_PY with `serve`, the
 * script the one-shot run uses, so both give the same bytes. A job is the
 * tool's own arguments on one line of its stdin, and one line comes back.
 * One job at a time, in order. Jobs are short (an edit a fifth of a second,
 * a slide cut out for its picture a fiftieth), so the next waits its turn;
 * one that has waited WAIT_MS is answered `busy`, and its caller does the
 * job the old way. A job with no answer in JOB_MS kills the tree. A job
 * cancelled while it runs is answered at once and runs out, its answer
 * dropped: Python cannot be stopped mid-job, and a kill would cost the next
 * edit a start and all the tool keeps. A crash, a failed start and an error
 * that is not the tool's own word are the same to the caller:
 * DeckResidentUnavailable, and the old way (one run of the tool for an edit,
 * the whole deck for a picture). The tool's own refusal (DeckRefused) is its
 * answer either way.
 * Stopped after IDLE_MS with nothing to do, past MEMORY_CAP, and by `stop()`;
 * when the app dies its stdin ends and it ends itself.
 */

export const JOB_MS = 10_000
/** The longest a job waits behind others before its caller is told `busy`. */
export const WAIT_MS = 1_000
export const START_MS = 15_000
/** Longer than the resident LibreOffice's ten minutes: this one holds a tenth of the memory, and the first edit after a stop pays for the whole deck again. */
export const IDLE_MS = 30 * 60_000
export const STOP_MS = 5_000
/** The most memory the tool may have held (its peak, as it says itself) before it is stopped once the job in hand is done. */
export const MEMORY_CAP = 512 * 1024 ** 2
/** A script of another build left in the folder goes once it is this old. */
const SCRIPT_KEPT_MS = 24 * 60 * 60_000

/** Why the kept-running tool did not do the job: the caller runs the tool once, the old way. */
export class DeckResidentUnavailable extends Error {
  constructor(
    readonly reason: 'start' | 'busy' | 'timeout' | 'crash' | 'failed' | 'stopped',
    message: string
  ) {
    super(message)
    this.name = 'DeckResidentUnavailable'
  }
}

/** The tool's own word on a job it would not do, the sentence a one-shot run puts on stderr: never run again. */
export class DeckRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeckRefused'
  }
}

export interface DeckResidentState {
  phase: 'off' | 'starting' | 'idle' | 'busy'
  pid: number | null
  /** jobs waiting behind the one in hand */
  queued: number
}

export interface DeckResident {
  /** One job: the deck tool's own arguments (`step`, `apply`, `unstep` and the rest), every path absolute. Answers what the verb says, where it says anything (`solo`: the deck's slide count). */
  run(argv: string[], signal?: AbortSignal): Promise<unknown>
  /** Ends the process; a later job starts it again. The job in hand and those waiting reject as `stopped`. */
  stop(): Promise<void>
  state(): DeckResidentState
}

/** The bits of a child the resident uses: Node's ChildProcess has them, and so does a test's fake. */
export interface DeckChild {
  pid?: number
  stdin: { write(s: string): unknown; end(): unknown; on?(event: 'error', fn: (err: Error) => void): unknown } | null
  stdout: NodeJS.EventEmitter | null
  stderr: NodeJS.EventEmitter | null
  on(event: 'exit', fn: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', fn: (err: Error) => void): unknown
}

export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface DeckResidentDeps {
  /** The python-pptx tool's Python (`toolchain.bin('python-pptx')`), read at each start. */
  python: () => string | null
  /** A folder of its own for the script, made 0700. */
  folder: string
  /**
   * The tool reads everything afresh as well as from what it kept, and a job where the two differ fails; and no
   * failure is `failed` here, so nothing is quietly run the old way: for the tests, and for chasing a fault.
   */
  check?: boolean
  spawn?: (cmd: string, args: string[], opts: { cwd: string }) => DeckChild
  /** Ends the tree; procTree's killTree. */
  kill?: (pid: number, signal: NodeJS.Signals) => void
  /** Whether the child may keep this process from ending: only while a job is in hand. */
  hold?: (child: DeckChild, on: boolean) => void
  clock?: Clock
  log?: (line: string) => void
}

// Never the reason the app stays up: a timer of the resident's does not hold the process open.
const realClock: Clock = { setTimeout: (fn, ms) => setTimeout(fn, ms).unref(), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) }

const abortError = (): Error => Object.assign(new Error('The job was cancelled.'), { name: 'AbortError' })

type Holdable = { ref?(): unknown; unref?(): unknown } | null | undefined
const realHold = (child: DeckChild, on: boolean): void => {
  for (const h of [child, child.stdin, child.stdout, child.stderr] as Holdable[]) (on ? h?.ref : h?.unref)?.call(h)
}

/** How a job ends: the tool's line, or the process gone, or no line in time, or its caller gone. */
type Ending = { by: 'answer'; msg: Record<string, unknown> } | { by: 'gone'; why: string } | { by: 'timeout' } | { by: 'abort' }

interface Live {
  child: DeckChild
  pid: number
  ready: Promise<void>
  exited: Promise<void>
  /** ends the job in hand */
  settle: ((ending: Ending) => void) | null
  /** killed, or being stopped: its end is ours, not a crash */
  dead: boolean
  gone: boolean
}

/**
 * The script in the resident's folder, written once under a name its own bytes give it: two builds that share a
 * data folder (the app, and a test run on its toolchain) never read each other's, and none reads half a file.
 */
export function scriptIn(folder: string): string {
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  chmodSync(folder, 0o700)
  const name = `deck-${createHash('sha256').update(DECK_PY).digest('hex').slice(0, 16)}.py`
  const script = join(folder, name)
  if (!existsSync(script)) {
    const part = `${script}.${process.pid}.part`
    writeFileSync(part, DECK_PY, { mode: 0o600 })
    renameSync(part, script)
  }
  for (const f of readdirSync(folder)) {
    if (f === name || !/^deck-[0-9a-f]{16}\.py(\.\d+\.part)?$/.test(f)) continue
    try {
      if (Date.now() - statSync(join(folder, f)).mtimeMs > SCRIPT_KEPT_MS) rmSync(join(folder, f), { force: true })
    } catch {
      /* gone */
    }
  }
  return script
}

export function createDeckResident(deps: DeckResidentDeps): DeckResident {
  const clock = deps.clock ?? realClock
  const kill = deps.kill ?? ((pid, sig) => void killTree(pid, sig))
  const hold = deps.hold ?? realHold
  const log = deps.log ?? (() => {})
  const spawn =
    deps.spawn ??
    // The deck tool runs below the server (childPriority.ts).
    ((cmd: string, args: string[], opts: { cwd: string }) => adoptTree(spawnLowered('tool')(cmd, args, { ...opts, stdio: ['pipe', 'pipe', 'pipe'], ...treeSpawnOptions() })))

  let live: Live | null = null
  let busy = false
  /** The jobs waiting their turn, in order. */
  const line: Array<{ go(): void; giveUp(err: Error): void }> = []
  let starting = false
  let idleTimer: unknown = null
  let nextId = 1

  const clearIdle = (): void => {
    if (idleTimer !== null) clock.clearTimeout(idleTimer)
    idleTimer = null
  }

  /** Kills the tree and forgets it: the job in hand is the caller's to reject. */
  const end = (l: Live, why: string): void => {
    if (live === l) live = null
    if (l.dead) return
    l.dead = true
    log(`[slides] the deck tool kept running ends: ${why}`)
    if (l.gone) return
    try {
      kill(l.pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }

  const start = (): Live => {
    const python = deps.python()
    if (!python) throw new DeckResidentUnavailable('start', 'python-pptx is not installed here.')
    let child: DeckChild
    try {
      // -I, as the one-shot run: no user site, no PYTHON* of ours, the script's folder not on the path.
      child = spawn(python, ['-I', scriptIn(deps.folder), 'serve', ...(deps.check ? ['check'] : [])], { cwd: deps.folder })
    } catch (err) {
      throw new DeckResidentUnavailable('start', `The deck tool did not start: ${(err as Error).message}`)
    }
    let readyOk!: () => void
    let readyFail!: (e: Error) => void
    let exitedDone!: () => void
    const l: Live = {
      child,
      pid: child.pid ?? 0,
      ready: new Promise<void>((res, rej) => {
        readyOk = res
        readyFail = rej
      }),
      exited: new Promise<void>((res) => (exitedDone = res)),
      settle: null,
      dead: false,
      gone: false
    }
    l.ready.catch(() => {})
    let buf = ''
    let stderr = ''
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
          if (msg.ready !== true) continue
          isReady = true
          readyOk()
        } else l.settle?.({ by: 'answer', msg })
      }
    })
    // A write after the tool died is an EPIPE on its stdin: the exit handler tells the job, and the app must not throw.
    child.stdin?.on?.('error', () => {})
    child.stderr?.on('data', (d: Buffer | string) => {
      stderr = (stderr + d.toString()).slice(-2000)
    })
    const gone = (why: string): void => {
      if (l.gone) return
      l.gone = true
      const ours = l.dead
      end(l, why)
      readyFail(new DeckResidentUnavailable('start', `The deck tool did not start: ${why}`))
      l.settle?.({ by: 'gone', why: ours ? 'killed' : why })
      exitedDone()
    }
    child.on('exit', (code, sig) => gone(`exit ${code ?? sig}${stderr ? `: ${stderr.trim().split('\n').slice(-2).join(' / ')}` : ''}`))
    child.on('error', (err) => gone(err.message))
    log(`[slides] the deck tool starts, to be kept running (pid ${l.pid})`)
    return l
  }

  /** Waits for `l` to say it is ready, killing it past START_MS. */
  const whenReady = (l: Live): Promise<void> => {
    let timer: unknown = null
    return Promise.race([
      l.ready,
      new Promise<void>((_, rej) => {
        timer = clock.setTimeout(() => rej(new DeckResidentUnavailable('start', `The deck tool was not ready within ${START_MS / 1000} s.`)), START_MS)
      })
    ]).finally(() => clock.clearTimeout(timer))
  }

  /** Asks the tool to end (its stdin closed), and kills the tree if it is not gone in STOP_MS. */
  const stopLive = async (l: Live, why: string): Promise<void> => {
    if (live === l) live = null
    if (l.dead) return
    l.dead = true
    log(`[slides] the deck tool kept running stops: ${why}`)
    try {
      l.child.stdin?.end()
    } catch {
      /* gone */
    }
    let timer: unknown = null
    await Promise.race([l.exited, new Promise<void>((res) => (timer = clock.setTimeout(res, STOP_MS)))])
    clock.clearTimeout(timer)
    if (l.gone) return
    try {
      kill(l.pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }

  /** The live process, started and ready. */
  const ready = async (): Promise<Live> => {
    if (live) return live
    starting = true
    const l = (live = start())
    try {
      await whenReady(l)
      return l
    } catch (err) {
      end(l, 'it did not start')
      throw err
    } finally {
      starting = false
    }
  }

  /** Takes its turn: at once (null) when nothing is in hand, else behind the others for WAIT_MS at most. */
  const turn = (signal?: AbortSignal): Promise<void> | null => {
    if (!busy) {
      busy = true
      return null
    }
    return new Promise<void>((resolve, reject) => {
      const leaveLine = (): void => {
        clock.clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        const at = line.indexOf(waiter)
        if (at >= 0) line.splice(at, 1)
      }
      const waiter = {
        go: (): void => (leaveLine(), resolve()),
        giveUp: (err: Error): void => (leaveLine(), reject(err))
      }
      const onAbort = (): void => waiter.giveUp(abortError())
      const timer = clock.setTimeout(() => waiter.giveUp(new DeckResidentUnavailable('busy', `The deck tool kept running was busy for ${WAIT_MS / 1000} s.`)), WAIT_MS)
      signal?.addEventListener('abort', onAbort, { once: true })
      line.push(waiter)
    })
  }

  /**
   * One job on the live process. `early` tells the caller before the job is over: a cancelled job is answered at
   * once, and the turn is kept until the tool is done with it.
   */
  const job = async (argv: string[], signal: AbortSignal | undefined, early: (err: Error) => void): Promise<unknown> => {
    const l = await ready()
    if (l.dead) throw new DeckResidentUnavailable('crash', 'The deck tool stopped before the job.')
    // Cancelled while it started: nothing was sent, so the process stays for the next job.
    if (signal?.aborted) throw abortError()
    const id = nextId++
    let wake: (e: Ending) => void = () => {}
    const next = (): Promise<Ending> => new Promise<Ending>((resolve) => (wake = resolve))
    l.settle = (e) => {
      if (e.by !== 'answer' || e.msg.id === id) wake(e)
    }
    const timer = clock.setTimeout(() => wake({ by: 'timeout' }), JOB_MS)
    const onAbort = (): void => wake({ by: 'abort' })
    signal?.addEventListener('abort', onAbort, { once: true })
    hold(l.child, true)
    try {
      let ending = next()
      l.child.stdin?.write(`${JSON.stringify({ id, argv })}\n`)
      let last = await ending
      if (last.by === 'abort') {
        // Python cannot be stopped mid-job, and a kill would cost the next edit a start and all the tool keeps:
        // the caller is answered now, the job runs out (within its ten seconds) and what it says is dropped.
        early(abortError())
        ending = next()
        last = await ending
      }
      if (last.by === 'timeout') {
        end(l, `job ${id} had no answer in ${JOB_MS / 1000} s`)
        throw new DeckResidentUnavailable('timeout', `The deck tool gave no answer within ${JOB_MS / 1000} s.`)
      }
      if (last.by === 'abort') throw abortError()
      if (last.by === 'gone') {
        if (last.why === 'stopped') throw new DeckResidentUnavailable('stopped', 'The deck tool was stopped during the job.')
        throw new DeckResidentUnavailable('crash', `The deck tool stopped during the job (${last.why}).`)
      }
      const { msg } = last
      if (typeof msg.peak === 'number' && msg.peak > MEMORY_CAP) void stopLive(l, `it held ${Math.round(msg.peak / 1024 ** 2)} MiB, past the cap`)
      if (typeof msg.refused === 'string') throw new DeckRefused(msg.refused)
      if (msg.ok === true) return msg.said
      const why = `The deck tool kept running could not do it: ${String(msg.error ?? 'no answer')}`
      throw deps.check ? new Error(why) : new DeckResidentUnavailable('failed', why)
    } finally {
      clock.clearTimeout(timer)
      l.settle = null
      signal?.removeEventListener('abort', onAbort)
      if (live === l) hold(l.child, false)
    }
  }

  /** A job from its turn in the line to the turn handed on. Settles the caller once: a cancelled job is told early, and what comes after is dropped. */
  const work = async (argv: string[], signal: AbortSignal | undefined, resolve: (said: unknown) => void, reject: (err: Error) => void): Promise<void> => {
    try {
      const wait = turn(signal)
      if (wait) await wait
    } catch (err) {
      return reject(err as Error)
    }
    clearIdle()
    try {
      resolve(await job(argv, signal, reject))
    } catch (err) {
      reject(err as Error)
    } finally {
      // The turn goes to the next in line, which keeps the resident busy; with nobody waiting it is idle.
      const next = line[0]
      if (next) next.go()
      else busy = false
      const l = live
      if (l && !busy) {
        idleTimer = clock.setTimeout(() => {
          idleTimer = null
          if (live === l && !busy) void stopLive(l, `idle for ${IDLE_MS / 60_000} minutes`)
        }, IDLE_MS)
      }
    }
  }

  return {
    run(argv, signal) {
      if (signal?.aborted) return Promise.reject(abortError())
      return new Promise<unknown>((resolve, reject) => void work(argv, signal, resolve, reject))
    },
    async stop() {
      clearIdle()
      for (const waiter of [...line]) waiter.giveUp(new DeckResidentUnavailable('stopped', 'The deck tool was stopped.'))
      const l = live
      if (!l) return
      if (busy) {
        end(l, 'stopped during a job')
        l.settle?.({ by: 'gone', why: 'stopped' })
        return
      }
      await stopLive(l, 'asked to stop')
    },
    state() {
      return { phase: starting ? 'starting' : busy ? 'busy' : live ? 'idle' : 'off', pid: live?.pid ?? null, queued: line.length }
    }
  }
}

// One a host for the life of the process, as the resident LibreOffice (index.ts `residentOf`).
const residents = new Map<string, DeckResident>()

/**
 * The host's data folder, said by the module when Work starts (index.ts `start`) and taken back when it stops. A
 * converter has no context and may not take the folder from the job runner's toolchain (pillarReach.test.ts), so
 * deck.ts asks here: null, and every edit is one run of the tool.
 */
let home: string | null = null
export const setDeckToolHome = (dataDir: string | null): void => void (home = dataDir)
export const deckToolHome = (): string | null => home

/** The host's own, by its data folder; its script lives beside the toolchain's other run files. */
export function deckResidentOf(dataDir: string, python: () => string | null, log: (line: string) => void = (l) => console.error(l)): DeckResident {
  let resident = residents.get(dataDir)
  // TEMP_CODE_DECK_CHECK=1: every job is also read afresh and a difference fails it (`check`).
  if (!resident) residents.set(dataDir, (resident = createDeckResident({ python, folder: join(toolsRoot(dataDir), 'run', 'deck-tool'), log, check: process.env.TEMP_CODE_DECK_CHECK === '1' })))
  return resident
}

/**
 * A copy of the deck at `input` that holds slide `page` (from 1, hidden slides counted) alone, numbered as it was,
 * written to `output` by the host's kept-running tool; answers the deck's slide count. For a slide's picture:
 * LibreOffice opens one slide where it would open the whole deck (`slides/index.ts`'s renderer). Any failure
 * throws, and the caller draws from the whole deck as before.
 */
export async function soloDeck(dataDir: string, python: () => string | null, input: string, page: number, output: string, signal?: AbortSignal): Promise<number> {
  if (process.env.TEMP_CODE_DECK_TOOL === 'once') throw new DeckResidentUnavailable('stopped', 'The deck tool is not kept running here.')
  const said = (await deckResidentOf(dataDir, python).run(['solo', input, String(page), output], signal)) as { slides?: unknown } | undefined
  if (typeof said?.slides !== 'number') throw new DeckResidentUnavailable('failed', 'The deck tool did not say how many slides the deck has.')
  return said.slides
}

/**
 * One slide's picture, drawn from a copy that holds it alone: `draw` (the LibreOffice kept running) opens one
 * slide where it would open the deck. The copy lies beside `output` for the length of the draw. Where it cannot
 * be made or drawn, `draw` is given the whole deck, as before. Answers the deck's slide count, as `draw` does.
 *
 * OFF unless `TEMP_CODE_DECK_TOOL=alone`: the copy's picture has not yet been held against the slide's picture in
 * its deck, pixel for pixel (deckResident.test.ts has the test, behind the gate; its first form printed a wrong
 * slide number). Until that test has passed, every slide is drawn from the whole deck.
 */
export async function slideAlone(
  dataDir: string,
  python: () => string | null,
  draw: (deck: string, page: number, output: string, signal?: AbortSignal) => Promise<number>,
  input: string,
  page: number,
  output: string,
  signal?: AbortSignal
): Promise<number> {
  if (process.env.TEMP_CODE_DECK_TOOL !== 'alone') return draw(input, page, output, signal)
  const alone = `${output}.solo.pptx`
  try {
    const count = await soloDeck(dataDir, python, input, page, alone, signal)
    // A copy LibreOffice counts more or fewer than one slide in is not the slide: the whole deck decides.
    if ((await draw(alone, 1, output, signal)) !== 1) throw new Error('the copy is not one slide')
    return count
  } catch (err) {
    if (signal?.aborted) throw err
  } finally {
    rmSync(alone, { force: true })
  }
  return draw(input, page, output, signal)
}

/** Ends the host's kept-running tool, if it has one: when Work is turned off there. */
export function stopDeckResident(dataDir: string): Promise<void> {
  return residents.get(dataDir)?.stop() ?? Promise.resolve()
}
