import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import { createInterface } from 'node:readline'
import type { Duplex } from 'node:stream'
import { version as appVersion } from '../../../../package.json'
import { adoptTree } from '../procTree'
import {
  COMPUTER_FEATURES,
  COMPUTER_METHODS,
  COMPUTER_PROTOCOL,
  ComputerNotificationSchema,
  HostNotificationSchema,
  RPC_ERROR,
  RpcErrorResponseSchema,
  SERVICE,
  VIDEO_STREAM,
  type ComputerAction,
  type ComputerError,
  type ComputerMethod,
  type ComputerNotification,
  type ComputerParams,
  type ComputerResult,
  type HostNotification
} from '@shared/computer/protocol'
import { hostErrorLine, type HostErrorKind } from '@shared/computer/hostErrors'
import { RecordReader, encodeRecord } from '@shared/computer/videoPipe'

/**
 * One live `tc-computer serve` (docs/computer-protocol.md §1 and "The host"):
 * newline JSON-RPC 2.0 on its stdio, every frame checked against the wire's
 * zod, requests with deadlines and `$/cancel`, notifications routed, the
 * exit classified by the shell's codes, and with TEMP_CODE_COMPUTER_TRACE=1
 * every frame logged. The supervisor (service.ts) decides when to spawn one.
 */

export interface ComputerConnectionOptions {
  bin: string
  /** <userData>/computer; the service writes shots under <dataDir>/shots/<session>/ */
  dataDir: string
  env?: NodeJS.ProcessEnv
  trace?: boolean
  log?: (line: string) => void
  spawn?: typeof nodeSpawn
  initTimeoutMs?: number
  /** a request ran past its deadline and was given up: the supervisor marks the process suspect */
  onTimeout?: (method: ComputerMethod) => void
  /** when a request started, for the supervisor's ping (test seam) */
  now?: () => number
  /** after a deadline's `$/cancel`, how long the answer may still come (test seam) */
  cancelGraceMs?: number
  /**
   * How the bytes pipe of live video is made (§30): `stdio` is the child's fourth descriptor, `named` a pipe the
   * service is told the name of and dials (Windows has no fourth descriptor to inherit). By the platform when left out.
   */
  videoPipe?: 'stdio' | 'named'
  /** where a `named` pipe listens (test seam); `\\.\pipe\tc-computer-video-<random>` on Windows */
  videoPipeName?: string
}

/** The name of the pipe the service dials, and the word it says first so no other process can stand in its place. */
export const VIDEO_PIPE_ENV = 'TC_COMPUTER_VIDEO_PIPE'
export const VIDEO_PIPE_TOKEN_ENV = 'TC_COMPUTER_VIDEO_TOKEN'
/** A service that names `video` has this long after `initialize` to be on its named pipe. */
const VIDEO_PIPE_JOIN_MS = 2_000

export type ComputerExitKind = 'clean' | 'grant-restart' | 'bad-command' | 'old-macos' | 'fault' | 'crash' | 'bad-output' | 'killed'
export interface ComputerExit {
  kind: ComputerExitKind
  code: number | null
  signal: NodeJS.Signals | null
  stderrTail: string[]
}

/** The service refused a request: a JSON-RPC error, `data` its ComputerError when it carries one. */
export class ComputerRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: ComputerError
  ) {
    super(message)
  }
}

/** The service never answered `initialize`; `exit` says how it ended when it did. */
export class ComputerStartError extends Error {
  constructor(
    message: string,
    readonly exit?: ComputerExit
  ) {
    super(message)
  }
}

/** A failure the host says itself (hostErrors.ts): nothing of it came from the service. */
export class ComputerHostError extends Error {
  constructor(
    readonly kind: HostErrorKind,
    readonly detail?: string
  ) {
    super(hostErrorLine(kind, detail))
  }
}

/** How long each method may take before the host gives it up. */
export const COMPUTER_DEADLINES = {
  initialize: 10_000,
  shutdown: 5_000,
  'permissions.get': 5_000,
  'permissions.request': 5_000,
  'apps.list': 15_000,
  'apps.launch': 15_000,
  'session.open': 5_000,
  'session.close': 5_000,
  'state.get': 30_000,
  'action.run': 60_000,
  'action.batch': 60_000,
  'capture.screenshot': 30_000,
  'capture.stream.start': 5_000,
  'capture.stream.stop': 5_000,
  'capture.video.start': 5_000,
  'capture.video.stop': 5_000,
  'input.probe': 10_000,
  'input.restoreSession': 10_000,
  'clipboard.state': 5_000,
  'clipboard.read': 5_000,
  'clipboard.write': 5_000,
  'escape.watch': 5_000
} as const satisfies Record<ComputerMethod, number>

/** After a deadline's `$/cancel`, how long the answer may still come. */
export const CANCEL_GRACE_MS = 3_000
/** An action batch never waits longer than this, whatever its durations. */
export const BATCH_DEADLINE_MAX_MS = 600_000

const durationMs = (a: Pick<ComputerAction, 'duration'>): number => Math.round((a.duration ?? 0) * 1000)

/** A method's deadline: an action adds its own `duration` (a wait, a held key, a long click). */
export function deadlineFor(method: ComputerMethod, params: unknown): number {
  const base: number = COMPUTER_DEADLINES[method]
  const p = (params ?? {}) as { action?: ComputerAction; actions?: ComputerAction[] }
  if (method === 'action.run' && p.action) return base + durationMs(p.action)
  if (method === 'action.batch' && p.actions) return Math.min(BATCH_DEADLINE_MAX_MS, base + p.actions.reduce((n, a) => n + durationMs(a), 0))
  return base
}

const EXIT_CODES: Record<number, ComputerExitKind> = { 0: 'clean', 75: 'grant-restart', 64: 'bad-command', 69: 'old-macos', 70: 'fault' }
export function exitKindOf(code: number | null, signal: NodeJS.Signals | null): ComputerExitKind {
  if (signal || code === null) return 'crash'
  return EXIT_CODES[code] ?? 'crash'
}

const TRACE_LINE_MAX = 2_000
const TRACE_DATA_MAX = 1_024

/** A frame as the trace prints it: any `data` string over 1 KiB as `<base64 N bytes>`, the line cut at 2,000 characters. */
export function traceFrame(raw: string): string {
  let text = raw
  try {
    text = JSON.stringify(JSON.parse(raw), (key, value) =>
      key === 'data' && typeof value === 'string' && value.length > TRACE_DATA_MAX ? `<base64 ${Math.floor((value.length * 3) / 4)} bytes>` : value
    )
  } catch {
    // not JSON: printed as it came
  }
  return text.length > TRACE_LINE_MAX ? `${text.slice(0, TRACE_LINE_MAX)}…(+${text.length - TRACE_LINE_MAX})` : text
}

const stamp = (): string => new Date().toISOString().slice(11, 23)

interface Pending {
  method: ComputerMethod
  startedAt: number
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | null
}

const STDERR_TAIL = 20

export class ComputerConnection {
  readonly pid: number
  readonly exited: Promise<ComputerExit>
  private initResult: ComputerResult<'initialize'> | null = null
  private nextId = 0
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Set<(n: ComputerNotification) => void>()
  private readonly stderrTail: string[] = []
  private exit: ComputerExit | null = null
  private killedAs: ComputerExitKind | null = null
  /** the bytes pipe (§30), when the service was started with one or has dialed its named one; null for an in-process service */
  private pipe: Duplex | null
  /** the named pipe's listener, while the service may still dial it */
  private pipeServer: Server | null = null
  private pipeJoined: (() => void) | null = null
  private readonly records = new RecordReader()
  private readonly recordListeners = new Set<(stream: number, message: Uint8Array) => void>()

  private constructor(
    private readonly child: ChildProcess,
    private readonly opts: ComputerConnectionOptions
  ) {
    this.pid = child.pid ?? 0
    this.exited = new Promise<ComputerExit>((resolve) => {
      child.on('exit', (code, signal) => {
        const kind = this.killedAs ?? exitKindOf(code, signal)
        this.exit = { kind, code, signal, stderrTail: [...this.stderrTail] }
        for (const [, p] of this.pending) {
          if (p.timer) clearTimeout(p.timer)
          p.reject(new ComputerHostError('service_restarted'))
        }
        this.pending.clear()
        resolve(this.exit)
      })
    })
    child.stdin?.on('error', () => undefined)
    // (an in-process service is no child process: it has three streams and no `stdio` at all)
    this.pipe = null
    const inherited = ((child.stdio as ChildProcess['stdio'] | undefined)?.[VIDEO_STREAM.pipeFd] as Duplex | null | undefined) ?? null
    if (inherited) this.usePipe(inherited)
    child.once('exit', () => this.closePipeServer())
    createInterface({ input: child.stdout! }).on('line', (line) => this.onLine(line))
    createInterface({ input: child.stderr! }).on('line', (line) => {
      this.stderrTail.push(line)
      if (this.stderrTail.length > STDERR_TAIL) this.stderrTail.shift()
      this.log(line)
    })
  }

  private usePipe(pipe: Duplex): void {
    this.pipe = pipe
    pipe.on('error', () => undefined)
    pipe.on('data', (chunk: Buffer) => this.received(chunk))
  }

  private closePipeServer(): void {
    this.pipeServer?.close()
    this.pipeServer = null
  }

  /**
   * The named pipe's listener. Whoever dials must say the token first: the name of a pipe can be read by any
   * process of the machine, the token only by the service it was handed to. The first that says it is the pipe;
   * every other socket is dropped, and the listener closes.
   */
  private listenPipe(server: Server, token: string): void {
    this.pipeServer = server
    const word = Buffer.from(token, 'latin1')
    server.on('connection', (socket: Socket) => {
      let got: Buffer = Buffer.alloc(0)
      const drop = (): void => void socket.destroy()
      const timer = setTimeout(drop, VIDEO_PIPE_JOIN_MS)
      socket.on('error', () => undefined)
      const onData = (chunk: Buffer): void => {
        got = Buffer.concat([got, chunk])
        if (got.length < word.length) return
        clearTimeout(timer)
        socket.off('data', onData)
        if (this.pipe || !timingSafeEqual(got.subarray(0, word.length), word)) return drop()
        this.usePipe(socket)
        this.closePipeServer()
        // what it sent after the token is the pipe's first bytes
        if (got.length > word.length) this.received(got.subarray(word.length))
        this.pipeJoined?.()
      }
      socket.on('data', onData)
    })
    server.on('error', (err) => this.log(`the video pipe did not listen: ${err.message}`))
  }

  /** Spawn `tc-computer serve` and run `initialize`; a service that refuses or dies first throws. */
  static async start(opts: ComputerConnectionOptions): Promise<ComputerConnection> {
    const spawn = opts.spawn ?? nodeSpawn
    // on Windows the service joins the app's job object, so it ends with the app (procTree.ts)
    // The fourth entry is the bytes pipe of live video (§30): a service that does not know it leaves it alone. Windows
    // has no fourth descriptor to hand down, so there the service is told the name of a pipe to dial (§29.7).
    const named = (opts.videoPipe ?? (process.platform === 'win32' ? 'named' : 'stdio')) === 'named'
    const stdio: ('pipe')[] = named ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe', 'pipe']
    const pipeName = named ? (opts.videoPipeName ?? `\\\\.\\pipe\\tc-computer-video-${randomBytes(16).toString('hex')}`) : null
    const token = named ? randomBytes(32).toString('hex') : null
    const server = pipeName ? createServer() : null
    if (server && pipeName) await new Promise<void>((resolve) => server.once('error', () => resolve()).listen(pipeName, () => resolve()))
    const env = { ...(opts.env ?? process.env), ...(server?.listening && pipeName && token ? { [VIDEO_PIPE_ENV]: pipeName, [VIDEO_PIPE_TOKEN_ENV]: token } : {}) }
    const child = adoptTree(spawn(opts.bin, ['serve'], { stdio, env }))
    const conn = new ComputerConnection(child, opts)
    if (server?.listening && token) conn.listenPipe(server, token)
    else server?.close()
    const spawned = new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', (e) => reject(e))
    })
    try {
      await spawned
      const init = await conn.request(
        'initialize',
        { protocol: COMPUTER_PROTOCOL, client: { name: 'temp-code', version: appVersion }, dataDir: opts.dataDir, features: [...COMPUTER_FEATURES] },
        { timeoutMs: opts.initTimeoutMs ?? COMPUTER_DEADLINES.initialize }
      )
      if (init.protocol !== COMPUTER_PROTOCOL) throw new ComputerRpcError(RPC_ERROR.computer, `the service speaks protocol ${init.protocol}, not ${COMPUTER_PROTOCOL}`)
      conn.initResult = init
      // a service that says it speaks video over a named pipe has dialed it, or is about to: it is waited for a moment,
      // so the first ask for video does not find the pipe a beat behind the answer
      if (conn.pipeServer && !conn.pipe && init.features?.includes('video')) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, VIDEO_PIPE_JOIN_MS)
          conn.pipeJoined = () => (clearTimeout(timer), resolve())
        })
        conn.pipeJoined = null
      }
      // one that does not will never dial
      if (!conn.pipe) conn.closePipeServer()
      return conn
    } catch (error) {
      conn.kill()
      if (error instanceof ComputerHostError && error.kind === 'service_restarted') {
        const exit = await conn.exited
        const tail = exit.stderrTail.filter((l) => l.trim()).slice(-1)[0]
        throw new ComputerStartError(`tc-computer exited before it answered initialize (${exit.kind}${exit.code !== null ? ` ${exit.code}` : ''})${tail ? `: ${tail}` : ''}`, exit)
      }
      throw new ComputerStartError((error as Error).message)
    }
  }

  get init(): ComputerResult<'initialize'> {
    return this.initResult!
  }

  /** What the service speaks beyond protocol 1 (§26, decision 14): an older service lists nothing, and the host sends it nothing new. */
  get features(): ReadonlySet<string> {
    return new Set(this.initResult?.features ?? [])
  }

  get epoch(): string {
    return this.initResult?.epoch ?? ''
  }

  /** The service can be asked for video: it said so at initialize, and there is a pipe for its bytes. */
  get video(): boolean {
    return this.pipe !== null && this.features.has('video')
  }

  /** One NSL1 message to a stream of the service (an ack), on the bytes pipe. Nothing when there is no pipe or the service is gone. */
  sendBytes(stream: number, message: Uint8Array): void {
    if (!this.pipe || this.exit || this.pipe.destroyed) return
    this.pipe.write(encodeRecord(stream, message))
  }

  /** Every record the service writes on the bytes pipe: the stream's number and one NSL1 message. */
  onBytes(fn: (stream: number, message: Uint8Array) => void): () => void {
    this.recordListeners.add(fn)
    return () => this.recordListeners.delete(fn)
  }

  private received(chunk: Buffer): void {
    let records
    try {
      records = this.records.push(chunk)
    } catch (err) {
      // the pipe has lost its place and cannot find it again: the service is restarted, as for a line that is not JSON
      this.log(`the bytes pipe failed: ${(err as Error).message}`)
      return this.kill('bad-output')
    }
    for (const r of records) for (const fn of this.recordListeners) fn(r.stream, r.message)
  }

  get alive(): boolean {
    return this.exit === null
  }

  request<M extends ComputerMethod>(
    method: M,
    params: ComputerParams<M>,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<ComputerResult<M>> {
    const checked = COMPUTER_METHODS[method].params.safeParse(params)
    if (!checked.success)
      return Promise.reject(new ComputerRpcError(RPC_ERROR.invalidParams, `invalid params for ${method}: ${checked.error.issues[0]?.message ?? 'refused'}`))
    if (this.exit) return Promise.reject(new ComputerHostError('service_restarted'))
    // given up before it was sent (a Stop while the session opened): never written, so it cannot act
    if (opts.signal?.aborted) return Promise.reject(new ComputerHostError('cancelled'))
    const id = ++this.nextId
    return new Promise<ComputerResult<M>>((resolve, reject) => {
      const p: Pending = { method, startedAt: (this.opts.now ?? Date.now)(), resolve: resolve as (v: unknown) => void, reject, timer: null }
      this.pending.set(id, p)
      const deadline = opts.timeoutMs ?? deadlineFor(method, params)
      p.timer = setTimeout(() => {
        this.cancel(id)
        p.timer = setTimeout(() => {
          if (!this.pending.delete(id)) return
          this.opts.onTimeout?.(method)
          reject(new ComputerRpcError(RPC_ERROR.computer, `${method} did not answer in ${Math.round(deadline / 1000)} s`, { kind: 'timeout', message: `${method} did not answer in time` }))
        }, this.opts.cancelGraceMs ?? CANCEL_GRACE_MS)
      }, deadline)
      if (opts.signal) {
        if (opts.signal.aborted) queueMicrotask(() => this.cancel(id))
        else opts.signal.addEventListener('abort', () => this.cancel(id), { once: true })
      }
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(n: HostNotification): void {
    const checked = HostNotificationSchema.parse(n)
    if (!this.exit) this.write({ jsonrpc: '2.0', ...checked })
  }

  onNotification(fn: (n: ComputerNotification) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  inFlight(): { method: ComputerMethod; startedAt: number }[] {
    return [...this.pending.values()].map((p) => ({ method: p.method, startedAt: p.startedAt }))
  }

  /** `shutdown`, then stdin closed, then SIGKILL if the process is still there after the shell's 2 s and one more. */
  async shutdown(): Promise<void> {
    if (this.exit) return
    const killer = setTimeout(() => this.kill(), SERVICE.shutdownExitMs + 1_000)
    try {
      await this.request('shutdown', {}, { timeoutMs: SERVICE.shutdownExitMs }).catch(() => undefined)
      this.child.stdin?.end()
      await this.exited
    } finally {
      clearTimeout(killer)
    }
  }

  kill(as: ComputerExitKind = 'killed'): void {
    if (this.exit) return
    this.killedAs ??= as
    this.child.kill('SIGKILL')
  }

  private cancel(id: number): void {
    if (this.pending.has(id)) this.notify({ method: '$/cancel', params: { id } })
  }

  private write(frame: object): void {
    const line = JSON.stringify(frame)
    if (this.opts.trace) this.log(`${stamp()} → ${traceFrame(line)}`)
    this.child.stdin?.write(line + '\n')
  }

  private log(line: string): void {
    ;(this.opts.log ?? console.log)(`[computer] ${line}`)
  }

  private onLine(line: string): void {
    if (this.opts.trace) this.log(`${stamp()} ← ${traceFrame(line)}`)
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(line) as Record<string, unknown>
    } catch {
      frame = {}
    }
    if (!frame || typeof frame !== 'object' || frame.jsonrpc !== '2.0') {
      this.log(`not a JSON-RPC frame on stdout, killing the service: ${traceFrame(line).slice(0, 200)}`)
      this.kill('bad-output')
      return
    }
    if ('id' in frame && ('result' in frame || 'error' in frame)) return this.onResponse(frame)
    if (typeof frame.method === 'string' && !('id' in frame)) return this.onNotify(frame)
    this.log(`ignored a frame that is neither a response nor a notification: ${traceFrame(line).slice(0, 200)}`)
  }

  private onResponse(frame: Record<string, unknown>): void {
    const id = frame.id as number
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    if (p.timer) clearTimeout(p.timer)
    if ('error' in frame) {
      const parsed = RpcErrorResponseSchema.safeParse(frame)
      if (!parsed.success) return p.reject(new ComputerRpcError(RPC_ERROR.internalError, `${p.method} answered an error frame the wire does not allow`))
      const { code, message, data } = parsed.data.error
      return p.reject(new ComputerRpcError(code, message, data))
    }
    const result = COMPUTER_METHODS[p.method].result.safeParse(frame.result)
    if (!result.success) {
      this.log(`warn: ${p.method}'s result failed its schema: ${result.error.issues[0]?.path.join('.')} ${result.error.issues[0]?.message}`)
      return p.reject(new ComputerRpcError(RPC_ERROR.internalError, `${p.method} answered a result the wire does not allow`))
    }
    p.resolve(result.data)
  }

  private onNotify(frame: Record<string, unknown>): void {
    const parsed = ComputerNotificationSchema.safeParse({ method: frame.method, params: frame.params })
    if (!parsed.success) {
      const known = ComputerNotificationSchema.options.some((o) => o.shape.method.value === frame.method)
      if (known) this.log(`warn: a ${String(frame.method)} notification failed its schema`)
      return
    }
    if (parsed.data.method === 'log') this.log(`${parsed.data.params.level} ${parsed.data.params.message}`)
    for (const fn of this.listeners) fn(parsed.data)
  }
}
