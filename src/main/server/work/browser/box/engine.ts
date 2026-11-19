import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { VIDEO_FPS } from '@shared/contract-video'
import { displayEnv, type BoxDisplay } from './display'
import { videoToolsEnv, type VideoTools } from './videoSetting'

/**
 * screen-relay's engine on the box (docs/agents/live-video.md "The box"): an
 * unmodified `relay-engine` process that captures the browser's private
 * display by damage, encodes it with x264 and serves it as NSL1 on a loopback
 * port, behind a token it reads from a 0600 file. Only our relay reaches it.
 *
 * The published 0.1.2 engine takes one WebSocket client. So there is one
 * engine for each viewer, four at most: each keeps its own encoder, whose
 * bitrate follows that viewer's own link, and the relay stays a pipe. An
 * engine is started when a viewer needs one and none is free, and stopped 60
 * seconds after its viewer left; a viewer that comes in that time takes it
 * warm. A still page costs an engine nothing: it captures by damage.
 */

/** Viewers of the box's display at once: the engine's own limit in later versions, kept here. */
export const ENGINE_MAX = 4
/** An engine nobody is on stops after this. */
export const ENGINE_IDLE_MS = 60_000
const START_MS = 10_000
const STOP_MS = 3_000
/** After a crash the next start waits, twice as long each time, up to this; a quiet two minutes forgets the crashes. */
const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000]
const BACKOFF_FORGET_MS = 120_000

/** The engine's flags: the display it is handed, loopback only, the link read from the acks (`--behind-tls-proxy`: our relay sits in between). */
export function engineArgs(o: { port: number; tokenFile: string; viewer: string }): string[] {
  return [
    '--backend',
    'x11',
    '--bind',
    '127.0.0.1',
    '--port',
    String(o.port),
    '--fps',
    String(VIDEO_FPS),
    '--bitrate-min',
    '1000000',
    '--bitrate-start',
    '8000000',
    '--bitrate-max',
    '20000000',
    '--token-file',
    o.tokenFile,
    '--behind-tls-proxy',
    // the folder must exist; nothing of it is ever served by us
    '--viewer-dir',
    o.viewer
  ]
}

/** A port nothing listens on now, on loopback. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}

/** One engine a viewer holds until it lets go. */
export interface EngineLease {
  port: number
  token: string
  /** the engine process exited under the viewer */
  onExit(fn: () => void): void
  /** the viewer is gone: the engine waits for the next one, then stops */
  release(): void
}

export interface BoxEnginesOptions {
  /** <dataDir>/work-browser/box: the token files live in `engine/` under it */
  root: string
  /** the tools and the display of the running headed browser; null ends every lease */
  tools: () => VideoTools | null
  display: () => BoxDisplay | null
  spawn?: typeof nodeSpawn
  port?: () => Promise<number>
  idleMs?: number
  max?: number
  startMs?: number
  now?: () => number
  log?: (line: string) => void
}

interface Engine {
  id: number
  child: ChildProcess
  port: number
  token: string
  tokenFile: string
  leased: boolean
  idle: NodeJS.Timeout | null
  exits: Set<() => void>
}

export class BoxEngines {
  private readonly engines = new Set<Engine>()
  private next = 1
  private crashes = 0
  private lastCrash = 0
  /** engines being started: they count against the limit before they are ready */
  private starting = 0

  constructor(private readonly opts: BoxEnginesOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)()
  }

  /** How many engine processes run now. */
  get count(): number {
    return this.engines.size
  }

  /**
   * An engine for one viewer: a free one that is still warm, else a new one.
   * Null when `max` are in use. Throws when the engine will not start.
   */
  async lease(): Promise<EngineLease | null> {
    let engine = [...this.engines].find((e) => !e.leased) ?? null
    if (!engine) {
      if (this.engines.size + this.starting >= (this.opts.max ?? ENGINE_MAX)) return null
      this.starting++
      try {
        engine = await this.start()
      } finally {
        this.starting--
      }
    }
    engine.leased = true
    if (engine.idle) clearTimeout(engine.idle)
    engine.idle = null
    const held = engine
    let released = false
    return {
      port: held.port,
      token: held.token,
      onExit: (fn) => void held.exits.add(fn),
      release: () => {
        if (released) return
        released = true
        held.exits.clear()
        if (!this.engines.has(held)) return
        held.leased = false
        held.idle = setTimeout(() => void this.stop(held), this.opts.idleMs ?? ENGINE_IDLE_MS)
        held.idle.unref?.()
      }
    }
  }

  /** Every engine stops: the browser is going, or the host is closing. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.engines].map((e) => this.stop(e)))
  }

  private async start(): Promise<Engine> {
    const tools = this.opts.tools()
    const display = this.opts.display()
    if (!tools || !display) throw new Error('the box browser is not on its display')
    await this.backoff()
    const dir = join(this.opts.root, 'engine')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const id = this.next++
    const token = randomBytes(32).toString('hex')
    const tokenFile = join(dir, `token-${id}`)
    writeFileSync(tokenFile, token, { mode: 0o600 })
    const port = await (this.opts.port ?? freePort)()
    if (!existsSync(tools.viewer)) mkdirSync(tools.viewer, { recursive: true })
    const child = (this.opts.spawn ?? nodeSpawn)(tools.engine, engineArgs({ port, tokenFile, viewer: tools.viewer }), {
      // its own display and libraries, and nothing of this process's display
      env: { ...displayEnv(display), ...videoToolsEnv(tools) },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const engine: Engine = { id, child, port, token, tokenFile, leased: false, idle: null, exits: new Set() }
    let said = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      // the engine and its libraries write notices here; only the last of them is kept, for a start that fails
      said = (said + chunk.toString('utf8')).slice(-600)
    })
    try {
      await ready(child, this.opts.startMs ?? START_MS)
    } catch (err) {
      child.kill('SIGKILL')
      rmSync(tokenFile, { force: true })
      this.crashed()
      const tail = said.trim().split('\n').pop() ?? ''
      throw new Error(`${(err as Error).message}${tail ? `: ${tail}` : ''}`)
    }
    this.engines.add(engine)
    child.once('exit', () => {
      if (!this.engines.delete(engine)) return
      if (engine.idle) clearTimeout(engine.idle)
      rmSync(engine.tokenFile, { force: true })
      this.crashed()
      this.opts.log?.(`box engine ${id}: exited${engine.leased ? ' under its viewer' : ''}`)
      for (const fn of [...engine.exits]) fn()
    })
    this.opts.log?.(`box engine ${id}: started on 127.0.0.1:${port} (pid ${child.pid})`)
    return engine
  }

  private async stop(engine: Engine): Promise<void> {
    if (!this.engines.delete(engine)) return
    if (engine.idle) clearTimeout(engine.idle)
    engine.idle = null
    const { child } = engine
    const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>((r) => child.once('exit', () => r()))
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), STOP_MS)
    await exited
    clearTimeout(timer)
    rmSync(engine.tokenFile, { force: true })
    this.opts.log?.(`box engine ${engine.id}: stopped`)
    for (const fn of [...engine.exits]) fn()
  }

  private crashed(): void {
    this.crashes++
    this.lastCrash = this.now()
  }

  /** Waits out the pause a run of crashes earned. */
  private async backoff(): Promise<void> {
    if (!this.crashes) return
    const since = this.now() - this.lastCrash
    if (since > BACKOFF_FORGET_MS) {
      this.crashes = 0
      return
    }
    const wait = BACKOFF_MS[Math.min(this.crashes, BACKOFF_MS.length) - 1] - since
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  }
}

/** The engine's own word that it is listening: one JSON line on stdout. */
function ready(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let out = ''
    const done = (err: Error | null): void => {
      clearTimeout(timer)
      child.off('exit', onExit)
      child.off('error', onError)
      child.stdout?.off('data', onData)
      if (err) reject(err)
      else resolve()
    }
    const onData = (chunk: Buffer): void => {
      out += chunk.toString('utf8')
      for (const line of out.split('\n')) {
        try {
          if ((JSON.parse(line) as { ready?: boolean }).ready === true) return done(null)
        } catch {
          // not the line yet
        }
      }
    }
    const onExit = (code: number | null): void => done(new Error(`the engine exited as it started (${code ?? 'killed'})`))
    const onError = (err: Error): void => done(new Error(`the engine did not start: ${err.message}`))
    const timer = setTimeout(() => done(new Error('the engine did not come up in time')), timeoutMs)
    child.stdout?.on('data', onData)
    child.once('exit', onExit)
    child.once('error', onError)
  })
}

/** The engine's own picture of the display, as a PNG: what a viewer of its stream is shown. For the proofs. */
export async function engineScreenshot(lease: Pick<EngineLease, 'port' | 'token'>): Promise<Buffer> {
  const res = await fetch(`http://127.0.0.1:${lease.port}/screenshot.png`, { headers: { Authorization: `Bearer ${lease.token}` } })
  if (!res.ok) throw new Error(`the engine answered ${res.status} to a screenshot`)
  return Buffer.from(await res.arrayBuffer())
}
