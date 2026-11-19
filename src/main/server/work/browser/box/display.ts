import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { videoToolsEnv, type VideoTools } from './videoSetting'

/**
 * The private X display the box's browser draws on when its picture is video
 * (docs/agents/live-video.md "The box"): a rootless X.Org server with the
 * dummy video driver, one mode of 1280×800 at 120 Hz. Chromium reads the
 * refresh rate when it starts, so the display is 120 Hz for the browser's
 * whole life and lives exactly as long as the browser does.
 *
 * Nothing but the browser and the engine may draw on it or read it: it takes
 * no TCP, and a client needs the cookie in an `XAUTHORITY` file kept 0600
 * under the browser's own folder.
 */

export const DISPLAY_WIDTH = 1280
export const DISPLAY_HEIGHT = 800
export const DISPLAY_HZ = 120
const START_MS = 10_000
const STOP_MS = 3_000

/** What a program needs to reach the display, and nothing else of this host's X. */
export interface BoxDisplay {
  DISPLAY: string
  XAUTHORITY: string
}

/**
 * The server's configuration: the dummy driver, one mode, no input devices of
 * the host's (the engine's input arrives through XTEST), no VT switching.
 * The modeline's blanking is small, so the pixel clock stays low: the clock
 * is the total size times the rate.
 */
export function xorgConfig(width = DISPLAY_WIDTH, height = DISPLAY_HEIGHT, hz = DISPLAY_HZ): string {
  const hTotal = width + 48
  const vTotal = height + 10
  const clock = ((hTotal * vTotal * hz) / 1e6).toFixed(3)
  return [
    'Section "ServerFlags"',
    ' Option "AutoAddDevices" "false"',
    ' Option "AutoEnableDevices" "false"',
    ' Option "DontVTSwitch" "true"',
    ' Option "DontZap" "true"',
    'EndSection',
    'Section "Device"',
    ' Identifier "dummy"',
    ' Driver "dummy"',
    ' VideoRam 256000',
    'EndSection',
    'Section "Monitor"',
    ' Identifier "mon"',
    ' HorizSync 5.0 - 2000.0',
    ' VertRefresh 5.0 - 300.0',
    ` Modeline "m" ${clock} ${width} ${width + 8} ${width + 24} ${hTotal} ${height} ${height + 3} ${height + 9} ${vTotal} -hsync +vsync`,
    'EndSection',
    'Section "Screen"',
    ' Identifier "scr"',
    ' Device "dummy"',
    ' Monitor "mon"',
    ' DefaultDepth 24',
    ' SubSection "Display"',
    '  Depth 24',
    '  Modes "m"',
    `  Virtual ${width} ${height}`,
    ' EndSubSection',
    'EndSection',
    ''
  ].join('\n')
}

/**
 * One entry of an Xauthority file: an MIT-MAGIC-COOKIE-1 that answers for any
 * host name and any display number (the family is the wildcard and the number
 * is empty), so it holds whichever number the server picks.
 */
export function xauthorityEntry(cookie: Buffer): Buffer {
  const field = (bytes: Buffer): Buffer => {
    const length = Buffer.alloc(2)
    length.writeUInt16BE(bytes.length)
    return Buffer.concat([length, bytes])
  }
  const family = Buffer.from([0xff, 0xff])
  return Buffer.concat([family, field(Buffer.alloc(0)), field(Buffer.alloc(0)), field(Buffer.from('MIT-MAGIC-COOKIE-1')), field(cookie)])
}

/**
 * The server's arguments. It picks the first free display number itself and
 * writes it to fd 3 (`-displayfd`); it listens on no TCP port; and with
 * `-auth` it refuses a client that does not hold the cookie (there is no
 * `-ac`).
 */
export function xorgArgs(files: { config: string; auth: string; log: string; modules: string }): string[] {
  return ['-displayfd', '3', '-noreset', '-nolisten', 'tcp', '-auth', files.auth, '-config', files.config, '-modulepath', files.modules, '-logfile', files.log]
}

/**
 * The environment a program on the display runs with. The box's own server
 * runs under a display of its own (xvfb-run): nothing of that one is passed
 * on, so the browser and the engine can reach this display and no other.
 */
export function displayEnv(display: BoxDisplay, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...withoutDisplay(base), DISPLAY: display.DISPLAY, XAUTHORITY: display.XAUTHORITY }
}

/** An environment with no display in it: neither X's nor Wayland's. */
export function withoutDisplay(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const key of ['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'WAYLAND_SOCKET', 'XDG_SESSION_TYPE']) delete env[key]
  return env
}

export interface BoxXDisplayOptions {
  /** <dataDir>/work-browser/box: the cookie, the config and the log live in `display/` under it */
  root: string
  tools: VideoTools
  spawn?: typeof nodeSpawn
  log?: (line: string) => void
  startMs?: number
}

export class BoxXDisplay {
  private child: ChildProcess | null = null
  private pair: BoxDisplay | null = null

  constructor(private readonly opts: BoxXDisplayOptions) {}

  get dir(): string {
    return join(this.opts.root, 'display')
  }
  /** The pair, while the server runs. */
  get env(): BoxDisplay | null {
    return this.running ? this.pair : null
  }
  get running(): boolean {
    return !!this.child && this.child.exitCode === null && this.child.signalCode === null
  }
  get pid(): number | null {
    return this.running ? (this.child?.pid ?? null) : null
  }

  /** Starts the server and answers its pair once it takes clients. Throws when it does not come up; nothing is left running then. */
  async start(): Promise<BoxDisplay> {
    if (this.running && this.pair) return this.pair
    const { tools } = this.opts
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const files = {
      config: join(this.dir, 'xorg.conf'),
      auth: join(this.dir, 'Xauthority'),
      log: join(this.dir, 'Xorg.log'),
      modules: join(tools.sys, 'usr', 'lib', 'xorg', 'modules')
    }
    this.sweep()
    // A new cookie for every server: one that leaked from the last is worth nothing.
    writeFileSync(files.auth, xauthorityEntry(randomBytes(16)), { mode: 0o600 })
    writeFileSync(files.config, xorgConfig(), { mode: 0o600 })
    const child = (this.opts.spawn ?? nodeSpawn)(tools.xorg, xorgArgs(files), {
      // The server needs nothing of this process's X, and gets none of it.
      env: { ...withoutDisplay(), ...videoToolsEnv(tools) },
      stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
      detached: true
    })
    this.child = child
    if (child.pid) writeFileSync(join(this.dir, 'pid'), String(child.pid))
    child.once('exit', () => {
      if (this.child !== child) return
      this.child = null
      this.pair = null
    })
    try {
      const number = await displayNumber(child, this.opts.startMs ?? START_MS)
      this.pair = { DISPLAY: `:${number}`, XAUTHORITY: files.auth }
    } catch (err) {
      await this.stop()
      throw err
    }
    this.opts.log?.(`box display: ${this.pair.DISPLAY} at ${DISPLAY_WIDTH}×${DISPLAY_HEIGHT}, ${DISPLAY_HZ} Hz (pid ${child.pid})`)
    return this.pair
  }

  /** Stops the server and removes its cookie; resolves when it has exited. */
  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    this.pair = null
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((r) => child.once('exit', () => r()))
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), STOP_MS)
      await exited
      clearTimeout(timer)
    }
    rmSync(join(this.dir, 'Xauthority'), { force: true })
    rmSync(join(this.dir, 'pid'), { force: true })
  }

  /** A server this folder's last owner left behind (a host that was killed, not stopped) is ended before a new one starts. */
  private sweep(): void {
    try {
      const pid = Number(readFileSync(join(this.dir, 'pid'), 'utf8'))
      if (!(pid > 1)) return
      // only a process that was started on this folder's config: a pid can be reused
      if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes(join(this.dir, 'xorg.conf'))) process.kill(pid, 'SIGTERM')
    } catch {
      // no pid kept, or the process is gone
    }
  }
}

/** The number the server writes to its fd 3 once it accepts clients. */
function displayNumber(child: ChildProcess, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const pipe = child.stdio[3] as Readable | null | undefined
    if (!pipe) return reject(new Error('the display has no pipe to say its number on'))
    let text = ''
    const done = (err: Error | null, n?: number): void => {
      clearTimeout(timer)
      child.off('exit', onExit)
      child.off('error', onError)
      pipe.off('data', onData)
      if (err) reject(err)
      else resolve(n!)
    }
    const onData = (chunk: Buffer): void => {
      text += chunk.toString('utf8')
      const m = /^(\d+)\n/.exec(text)
      if (m) done(null, Number(m[1]))
    }
    const onExit = (): void => done(new Error('the display exited as it started'))
    const onError = (err: Error): void => done(new Error(`the display did not start: ${err.message}`))
    const timer = setTimeout(() => done(new Error('the display did not come up in time')), timeoutMs)
    pipe.on('data', onData)
    child.once('exit', onExit)
    child.once('error', onError)
  })
}
