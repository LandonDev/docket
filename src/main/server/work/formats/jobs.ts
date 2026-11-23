import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { basename, extname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { allows, type Capability } from '@shared/capabilities'
import type { Readiness, ToolsReport } from '@shared/contract-work-formats'
import type { HostId } from '@shared/work'
import type { CtxPart } from '../ctx'
import type { Caller, WorkModule } from '../modules'
import { runTool, Toolchain, toolsRoot, type RunOpts, type RunResult } from './tools'

/**
 * `ctx.convert`: one conversion job, run where the tool is
 * (docs/agents/work-formats.md, "Jobs"). Converters come from every
 * module's `convert` list, keyed by `(from, to)`. A job runs here when a
 * converter's tool is installed (work/formats/tools.ts), under the host's
 * cap on jobs and threads; otherwise it goes to a linked host that offers
 * the pair, with the file carried in the request and the output carried
 * back. A forwarded job is never forwarded again.
 *
 * A format's name may say who draws it after a plus (`pdf+word`: a PDF as
 * Word itself draws it); the file's extension is the part before it. A
 * converter that is not a tool on disk but an app that may be shut or a
 * machine that may sleep says so with `ready`, asked when the job comes. A
 * job his own press made (`pressOf`) may wake what sleeps; no other may. A
 * job on a shared library's file (`shared`) never leaves this host.
 */

/**
 * His press, on this host: the only thing that lets a job wake a machine
 * that sleeps (the Windows VM for "Check in Word"). It is an object this
 * module made and remembers, so nothing a thread or another host sends can
 * pass for one: a forwarded job carries none, and a JSON `pressed: true`
 * is not it.
 */
export interface Press {
  readonly pressed: true
}
const presses = new WeakSet<object>()

/**
 * A press, when the call is the owner's own: at a window of this host, or
 * from a paired device of his that could approve as it pressed (the rule
 * `userTextByOf` keeps for "the owner typed this"). Never a thread's, never
 * another host's on his behalf (`by.peer`), and never a key that cannot
 * approve: an agent's key through the MCP door holds `read` and `operate`
 * at most (`MCP_CEILING`), so it can run a job and can wake nothing.
 */
export function pressOf(by: Caller): Press | undefined {
  if (by.kind === 'model' || by.peer) return undefined
  if (by.kind === 'remote' && !allows(by.caps as readonly Capability[], 'approve')) return undefined
  const press: Press = Object.freeze({ pressed: true as const })
  presses.add(press)
  return press
}
const withoutPress = ({ pressed: _not, ...job }: ConvertJob): ConvertJob => job
/** Whether a job carries a press this host made. */
export const pressed = (job: { pressed?: unknown }): boolean => typeof job.pressed === 'object' && job.pressed !== null && presses.has(job.pressed)

/** One conversion: a file in one format to a file in another. */
export interface ConvertJob {
  /** the format's short name, as its extension: `docx`, `odt`, `pdf`, `pptx`, `md`, `html`, … */
  from: string
  to: string
  /** absolute path of the input on this host */
  input: string
  /** where the output goes; the job's own folder under work-tools/jobs/ when absent (swept after a day) */
  output?: string
  /** the converter's own switches */
  options?: Record<string, unknown>
  signal?: AbortSignal
  /** run on this host or fail: set on a job another host forwarded here */
  here?: boolean
  /** his press (`pressOf`): the job may wake a machine that sleeps. Dropped from a forwarded job. */
  pressed?: Press
  /** the input is a shared library's file (`sharedOf(source)`): the job runs here or fails, and is never carried to another host */
  shared?: boolean
}
export interface ConvertResult {
  /** absolute path of the output on this host */
  output: string
  /** the host that ran it: a forwarded job names the linked host */
  ranOn: HostId
  /** what the converter could not carry over, one line each */
  warnings: string[]
}

/** What a converter's run gets beside the job: the tools, its share of the cap, a scratch folder, and a way to run a child. */
export interface ConvertRun {
  tools: Toolchain
  /** threads granted to this job */
  threads: number
  /** a number no other running job holds, for a per-slot profile (LibreOffice's) */
  slot: number
  /** a scratch folder of the job's own, removed after it */
  tmp: string
  signal: AbortSignal
  run(cmd: string, args: string[], o?: RunOpts): Promise<RunResult>
}

/** One converter a module registers (`WorkModule.convert`), keyed by `(from, to)`. */
export interface Converter {
  from: string
  to: string
  /** the toolchain tool it needs (`scripts/work-tools/<pillar>.json`); a host without it forwards the job */
  needs?: string
  /** threads one job uses; else the tool's own `threads` from its manifest, else 1 */
  threads?: number
  /**
   * Whether it can run now, for a converter that is an app or a machine
   * and not a tool on disk: `ready`; `asleep` (it runs only for a job he
   * pressed, which wakes it); `not open` (an app he has shut: never
   * started unseen); `none` (not on this host at all). Asked when a job
   * comes, with the job, and for `work.formats.tools`, with null.
   */
  ready?(job: ConvertJob | null): Readiness | Promise<Readiness>
  /** writes `job.output`; returns what it could not carry over */
  run(job: ConvertJob & { output: string }, run: ConvertRun): Promise<{ warnings?: string[] }>
}

/** A host this one holds a link to: what `work.formats.tools` and `work.formats.convert` go over. */
export interface LinkedHost {
  id: HostId
  request<T = unknown>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T>
}

/** The largest file a job may carry to another host or back: the link is one WebSocket frame each way (100 MiB, base64 adds a third). */
export const FORWARD_MAX_BYTES = 64 * 1024 * 1024
const FORWARD_TIMEOUT_MS = 20 * 60_000
/** How long a converter may take to say whether it is ready: an app or a helper that does not answer is not there. */
export const READY_TIMEOUT_MS = 5_000
const OFFERS_TTL_MS = 60_000
const JOB_TTL_MS = 24 * 60 * 60_000

export type { ToolsReport }

export class NoConverterError extends Error {
  readonly code = 'no-converter' as const
}
/** The pair's converter is on a host in reach but cannot run now: the machine sleeps and nobody pressed, or the app is shut. */
export class NotReadyError extends Error {
  readonly code = 'not-ready' as const
  constructor(
    readonly state: 'asleep' | 'not open',
    message: string
  ) {
    super(message)
  }
}

const mbOf = (bytes: number): string => `${Math.round(bytes / 1048576)} MB`
const fmt = (s: string): string => s.toLowerCase().replace(/^\./, '')
/** A format's file extension: its name up to the plus (`pdf+word` is a `.pdf`). */
export const extOf = (format: string): string => fmt(format).split('+')[0]!
const pairKey = (from: string, to: string): string => `${fmt(from)}→${fmt(to)}`

/** Every module's converters by pair, in module order; a second converter for a pair is refused by name, the first stays. */
export function convertersOf(modules: readonly WorkModule[], log: (line: string) => void = (l) => console.error(`[work] ${l}`)): Map<string, Converter> {
  const out = new Map<string, Converter>()
  for (const module of modules) {
    for (const c of module.convert ?? []) {
      const key = pairKey(c.from, c.to)
      if (out.has(key)) {
        log(`${module.id}: a second converter for ${key} refused`)
        continue
      }
      out.set(key, c)
    }
  }
  return out
}

/** The default caps: a quarter of the cores in jobs (at most 4), half of them in threads. */
export function defaultCaps(cores = cpus().length): { jobs: number; threads: number } {
  return { jobs: Math.max(1, Math.min(4, Math.floor(cores / 4))), threads: Math.max(1, Math.floor(cores / 2)) }
}

interface Waiting {
  threads: number
  start: (grant: { slot: number }) => void
  signal?: AbortSignal
  cancel: (err: Error) => void
}

export interface JobRunnerOptions {
  host: HostId
  dataDir: string
  converters: Map<string, Converter>
  tools?: Toolchain
  caps?: { jobs: number; threads: number }
  /** the hosts this one is linked to now */
  links?: () => LinkedHost[]
  /** the largest file carried either way (FORWARD_MAX_BYTES) */
  forwardMax?: number
  /** how long a converter's `ready` may take (READY_TIMEOUT_MS) */
  readyTimeoutMs?: number
  log?: (line: string) => void
}

/** The queue, the registry and the route for one host. */
export class JobRunner {
  readonly tools: Toolchain
  readonly caps: { jobs: number; threads: number }
  private running = new Map<number, number>() // slot → threads
  private waiting: Waiting[] = []
  /** What each linked host converts, or that it did not say, as of `at` */
  private offers = new Map<HostId, { at: number; pairs: Map<string, Readiness> }>()
  private readonly log: (line: string) => void
  private readonly forwardMax: number

  constructor(private readonly o: JobRunnerOptions) {
    this.tools = o.tools ?? new Toolchain(o.dataDir)
    this.caps = o.caps ?? defaultCaps()
    this.log = o.log ?? ((line) => console.log(`[work] ${line}`))
    this.forwardMax = o.forwardMax ?? FORWARD_MAX_BYTES
  }

  /** The converter for a pair, whether or not its tool is here. */
  converter(from: string, to: string): Converter | null {
    return this.o.converters.get(pairKey(from, to)) ?? null
  }

  /** The converter for a pair when its tool is installed here. */
  local(from: string, to: string): Converter | null {
    const c = this.converter(from, to)
    return c && (!c.needs || this.tools.has(c.needs)) ? c : null
  }

  /** Whether a converter can run here now: its tool on disk, then its own word. A converter that throws is not here. */
  private async stateHere(c: Converter, job: ConvertJob | null): Promise<Readiness> {
    if (c.needs && !this.tools.has(c.needs)) return 'none'
    if (!c.ready) return 'ready'
    let timer: NodeJS.Timeout | undefined
    try {
      // Bounded: a helper that hangs must not hang every job of its pair, nor this host's whole report to its peers.
      return await Promise.race([
        Promise.resolve(c.ready(job)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('it did not answer')), this.o.readyTimeoutMs ?? READY_TIMEOUT_MS)
        })
      ])
    } catch (err) {
      this.log(`${pairKey(c.from, c.to)} could not say whether it is ready: ${err instanceof Error ? err.message : String(err)}`)
      return 'none'
    } finally {
      clearTimeout(timer)
    }
  }

  /** The pairs this host runs itself, each with its state when it is not simply ready. */
  async pairs(): Promise<ToolsReport['converts']> {
    // Asked together: one slow converter costs the report its own wait, not every converter's in a row.
    const all = [...this.o.converters.values()]
    const states = await Promise.all(all.map((c) => this.stateHere(c, null)))
    return all.flatMap((c, i) => {
      const state = states[i]!
      return state === 'none' ? [] : [{ from: fmt(c.from), to: fmt(c.to), ...(state !== 'ready' ? { state } : {}) }]
    })
  }

  /** The queue now: the caps, what runs and what waits. */
  queue(): ToolsReport['queue'] {
    return { cap: this.caps, running: this.running.size, queued: this.waiting.length }
  }

  async report(): Promise<ToolsReport> {
    const state = this.tools.state()
    return {
      host: this.o.host,
      platform: state.platform,
      tools: this.tools.list().map((t) => ({ name: t.name, pillar: t.pillar, version: t.version, licence: t.licence, ok: t.ok && this.tools.has(t.name), ...(t.bytes !== undefined ? { bytes: t.bytes } : {}), ...(t.error ? { error: t.error } : {}) })),
      converts: await this.pairs(),
      queue: this.queue()
    }
  }

  async convert(job: ConvertJob): Promise<ConvertResult> {
    const converter = this.converter(job.from, job.to)
    const pair = `${fmt(job.from)} to ${fmt(job.to)}`
    if (!converter) throw new NoConverterError(`no converter from ${pair}`)
    if (!existsSync(job.input)) throw new Error(`no file at ${job.input}`)
    // A press is this host's own object: one that came from anywhere else is not a press.
    const mine = pressed(job) ? job : withoutPress(job)
    const here = await this.stateHere(converter, mine)
    if (here === 'ready' || (here === 'asleep' && mine.pressed)) return this.runHere(converter, mine)
    const what = converter.needs && !this.tools.has(converter.needs) ? `${converter.needs} is not installed on ${this.o.host}` : `${this.o.host} cannot convert ${pair} now`
    const notReady = (): Error =>
      here === 'asleep'
        ? new NotReadyError('asleep', `the machine that converts ${pair} is asleep, and only his own press wakes it`)
        : here === 'not open'
          ? new NotReadyError('not open', `the app that converts ${pair} is not open on ${this.o.host}`)
          : new NoConverterError(what)
    if (job.here) throw notReady()
    if (job.shared) throw here === 'none' ? new NoConverterError(`${what}, and a shared library's file is never carried to another host`) : notReady()
    const far = await this.hostFor(job.from, job.to)
    if (far && 'request' in far) return this.forward(far, mine)
    if (here !== 'none') throw notReady()
    if (!far) throw new NoConverterError(`${what}, and no linked host converts ${pair}`)
    throw new NotReadyError(
      far.state,
      far.state === 'asleep'
        ? `the machine that converts ${pair} is asleep on ${far.host}, and only his own press at a window of that host wakes it`
        : `the app that converts ${pair} is not open on ${far.host}`
    )
  }

  /** Run one job here once the caps allow it. */
  private async runHere(converter: Converter, job: ConvertJob): Promise<ConvertResult> {
    const wanted = converter.threads ?? (converter.needs ? this.tools.state().tools[converter.needs]?.threads : undefined) ?? 1
    const threads = Math.min(Math.max(1, wanted), this.caps.threads)
    const { slot } = await this.admit(threads, job.signal)
    const id = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
    const dir = join(toolsRoot(this.o.dataDir), 'jobs', id)
    const tmp = join(dir, 'tmp')
    const output = job.output ?? join(dir, `${basename(job.input, extname(job.input))}.${extOf(job.to)}`)
    const abort = new AbortController()
    const onAbort = (): void => abort.abort()
    job.signal?.addEventListener('abort', onAbort, { once: true })
    // From here the slot is held: whatever throws, the finally gives it back.
    try {
      if (job.signal?.aborted) throw new Error('cancelled')
      mkdirSync(tmp, { recursive: true })
      const done = await converter.run(
        { ...job, output },
        { tools: this.tools, threads, slot, tmp, signal: abort.signal, run: (cmd, args, o = {}) => runTool(cmd, args, { ...o, signal: abort.signal }) }
      )
      if (abort.signal.aborted) throw new Error('cancelled')
      if (!existsSync(output)) throw new Error(`${pairKey(job.from, job.to)} left no output`)
      return { output, ranOn: this.o.host, warnings: done.warnings ?? [] }
    } finally {
      this.release(slot)
      job.signal?.removeEventListener('abort', onAbort)
      try {
        rmSync(tmp, { recursive: true, force: true })
        if (job.output) rmSync(dir, { recursive: true, force: true })
      } catch {
        /* the sweep takes what is left */
      }
    }
  }

  private admit(threads: number, signal?: AbortSignal): Promise<{ slot: number }> {
    if (signal?.aborted) return Promise.reject(new Error('cancelled'))
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const i = this.waiting.indexOf(w)
        if (i >= 0) {
          this.waiting.splice(i, 1)
          reject(new Error('cancelled'))
        }
      }
      // The listener goes once the job leaves the queue either way: a signal a thread reuses for many jobs collects none.
      const w: Waiting = {
        threads,
        signal,
        start: (grant) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(grant)
        },
        cancel: (err) => {
          signal?.removeEventListener('abort', onAbort)
          reject(err)
        }
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiting.push(w)
      this.pump()
    })
  }

  /** Start waiting jobs in order while the caps allow; the head waits for room rather than being passed. */
  private pump(): void {
    while (this.waiting.length) {
      const head = this.waiting[0]
      const used = [...this.running.values()].reduce((a, b) => a + b, 0)
      if (this.running.size >= this.caps.jobs || used + head.threads > this.caps.threads) return
      this.waiting.shift()
      let slot = 0
      while (this.running.has(slot)) slot++
      this.running.set(slot, head.threads)
      head.start({ slot })
    }
  }

  private release(slot: number): void {
    this.running.delete(slot)
    this.pump()
  }

  /** Cancel what waits (the switch went off or the host closes); running jobs end on their own signals. */
  cancelWaiting(why = 'Work turned off'): void {
    const waiting = this.waiting
    this.waiting = []
    for (const w of waiting) w.cancel(new Error(why))
  }

  // ── another host ──────────────────────────────────────────────────

  /**
   * The first linked host whose report offers the pair ready to run;
   * reports are kept a minute. A host that says the pair is asleep or not
   * open is passed over (a forwarded job carries no press, so it could
   * wake nothing there), and is what the answer names when none is ready.
   */
  private async hostFor(from: string, to: string): Promise<LinkedHost | { host: HostId; state: 'asleep' | 'not open' } | null> {
    const key = pairKey(from, to)
    let waiting: { host: HostId; state: 'asleep' | 'not open' } | null = null
    for (const link of this.o.links?.() ?? []) {
      let known = this.offers.get(link.id)
      if (!known || Date.now() - known.at > OFFERS_TTL_MS) {
        try {
          const report = await link.request<ToolsReport>('work.formats.tools', {}, { timeoutMs: 15_000 })
          known = { at: Date.now(), pairs: new Map(report.converts.map((p) => [pairKey(p.from, p.to), p.state ?? 'ready'])) }
          this.offers.set(link.id, known)
        } catch (err) {
          // Asked again after the same minute: a slow host does not cost every job its wait.
          this.offers.set(link.id, { at: Date.now(), pairs: new Map() })
          this.log(`${link.id} did not say what it converts: ${err instanceof Error ? err.message : String(err)}`)
          continue
        }
      }
      const state = known.pairs.get(key)
      if (state === 'ready') return link
      if (state === 'asleep' || (state === 'not open' && !waiting)) waiting = { host: link.id, state }
    }
    return waiting
  }

  private async forward(far: LinkedHost, job: ConvertJob): Promise<ConvertResult> {
    const size = statSync(job.input).size
    if (size > this.forwardMax) throw new Error(`${basename(job.input)} is ${mbOf(size)}; a job carried to another host takes at most ${mbOf(this.forwardMax)}`)
    this.log(`${pairKey(job.from, job.to)} goes to ${far.id}: it does not run here`)
    if (job.signal?.aborted) throw new Error('cancelled')
    // What goes over is the pair, the file and the converter's own switches: never the press, which is this host's alone.
    const options = forwardable(job.options)
    const asked = far.request<ForwardReply>(
      'work.formats.convert',
      { from: fmt(job.from), to: fmt(job.to), name: basename(job.input), data: readFileSync(job.input).toString('base64'), ...(options ? { options } : {}) },
      { timeoutMs: FORWARD_TIMEOUT_MS }
    )
    // A cancel stops the wait here; the far host finishes its run (its own timeout bounds it) and its answer is dropped.
    const reply = await (job.signal
      ? new Promise<ForwardReply>((resolve, reject) => {
          const onAbort = (): void => reject(new Error('cancelled'))
          job.signal!.addEventListener('abort', onAbort, { once: true })
          asked.then(resolve, reject).finally(() => job.signal!.removeEventListener('abort', onAbort))
        })
      : asked)
    let output = job.output
    if (!output) {
      const dir = join(toolsRoot(this.o.dataDir), 'jobs', `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`)
      mkdirSync(dir, { recursive: true })
      output = join(dir, `${basename(job.input, extname(job.input))}.${extOf(job.to)}`)
    }
    const bytes = Buffer.from(reply.data, 'base64')
    // The far host refuses an output past the cap itself; one that did not is refused here, in words, before it is kept.
    if (bytes.length > this.forwardMax) throw new Error(`the ${extOf(job.to)} that came back is ${mbOf(bytes.length)}; a job carried from another host takes at most ${mbOf(this.forwardMax)}`)
    writeFileSync(output, bytes)
    return { output, ranOn: reply.ranOn, warnings: reply.warnings }
  }

  /**
   * `work.formats.convert` on this side: the file arrives in the request,
   * runs here (never forwarded on), and goes back in the reply.
   */
  async serveForwarded(params: { from: string; to: string; name: string; data: string; options?: Record<string, unknown> }, signal?: AbortSignal): Promise<ForwardReply> {
    const bytes = Buffer.from(params.data, 'base64')
    if (bytes.length > this.forwardMax) throw new Error(`a forwarded job takes at most ${mbOf(this.forwardMax)}`)
    const dir = join(toolsRoot(this.o.dataDir), 'jobs', `in-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`)
    mkdirSync(dir, { recursive: true })
    try {
      // Names of our own: the far host's file name is its word, and the reply carries none.
      const input = join(dir, `input.${extOf(params.from)}`)
      writeFileSync(input, bytes)
      const output = join(dir, `output.${extOf(params.to)}`)
      // Built field by field: whatever else the request carried (a `pressed`, a `shared`) is not part of the job.
      const options = forwardable(params.options)
      const done = await this.convert({ from: params.from, to: params.to, input, output, here: true, ...(options ? { options } : {}), ...(signal ? { signal } : {}) })
      // The reply is one frame: an output past the cap would close the link, and everything else on it.
      const size = statSync(done.output).size
      if (size > this.forwardMax) throw new Error(`the ${extOf(params.to)} is ${mbOf(size)}; a job carried back to another host takes at most ${mbOf(this.forwardMax)}`)
      return { data: readFileSync(done.output).toString('base64'), ranOn: done.ranOn, warnings: done.warnings }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  /** Remove job folders older than a day. */
  sweep(now = Date.now()): void {
    const root = join(toolsRoot(this.o.dataDir), 'jobs')
    if (!existsSync(root)) return
    for (const name of readdirSync(root)) {
      const p = join(root, name)
      try {
        if (now - statSync(p).mtimeMs > JOB_TTL_MS) rmSync(p, { recursive: true, force: true })
      } catch {
        /* gone */
      }
    }
  }
}

export interface ForwardReply {
  data: string
  ranOn: HostId
  warnings: string[]
}

/** A job's switches as they cross a link: the converter's own, with no `pressed` among them (a converter reads the job's press, never an option). */
function forwardable(options: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!options) return undefined
  const { pressed: _dropped, ...rest } = options
  return rest
}

// ── the context part ─────────────────────────────────────────────────

/** The host's runner, by its database: `work.formats.*` (index.ts) answers from the same queue `ctx.convert` fills. */
const runners = new WeakMap<DatabaseSync, Promise<JobRunner>>()
export const runnerOf = (ctx: { db: DatabaseSync }): Promise<JobRunner> | null => runners.get(ctx.db) ?? null

export const convertPart: CtxPart<'convert'> = (ctx, deps) => {
  // modules.ts lists the formats module, which reads this file: the list is read once every module has loaded, never at import.
  let runner: Promise<JobRunner> | null = null
  const get = (): Promise<JobRunner> => {
    runner ??= import('../modules').then(
      ({ WORK_MODULES }) =>
        new JobRunner({
          host: ctx.host,
          dataDir: deps.dataDir,
          converters: convertersOf(WORK_MODULES),
          links: () =>
            (deps.peers?.all() ?? [])
              .filter((l) => l.connected)
              .map((l) => ({ id: l.id, request: <T,>(method: string, params?: unknown, opts?: { timeoutMs?: number }) => l.request<T>(method, params, opts) })),
          log: (line) => ctx.log(line)
        })
    )
    runners.set(ctx.db, runner)
    return runner
  }
  deps.whileOn(() => {
    let timer: NodeJS.Timeout | null = null
    let stopped = false
    void get().then((r) => {
      if (stopped) return
      r.sweep()
      timer = setInterval(() => r.sweep(), 60 * 60_000)
      timer.unref()
    })
    return () => {
      stopped = true
      if (timer) clearInterval(timer)
      void get().then((r) => r.cancelWaiting())
    }
  })
  return {
    convert: async (job) => {
      if (!ctx.enabled()) throw new Error('Work is off on this host')
      return (await get()).convert(job)
    }
  }
}
