/**
 * What the PC rig proofs share (scripts/e2e-pc-j-drive.ts, scripts/e2e-pc-setup-rig.ts): the rig as tcuser
 * (docs/agents/windows-vm.md), stand-in instances of the BUILT tree on this box, CDP into a window, and keys typed
 * through QMP where only a native dialog listens. Nothing here touches the box's live service, its data, a real
 * HOME or vault, or the installed app.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, openSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { rigConfig, rigPaths, STANDARD_USER } from '../../src/main/server/work/winvm/machine/config'
import { qmp, sendKey } from '../../src/main/server/work/winvm/machine/qmp'
import { Cdp, pageTarget } from './packagedApp'
import { appOf, findAppExePs } from './winAppNames'

/** The tree whose built out/ a stand-in runs: this one, or RIG_REPO's. */
export const REPO = process.env.RIG_REPO ?? resolve(import.meta.dir, '..', '..')
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
export const rig = rigConfig()
export const paths = rigPaths(rig)
export const GUEST_HOME = `C:\\Users\\${STANDARD_USER}`
export const GUEST_LOCAL = `${GUEST_HOME}\\AppData\\Local`

// ── a record of the run: checks, times, pictures ───────────────────────────

export class Record {
  failures = 0
  readonly lines: string[] = []
  private readonly t0 = Date.now()
  private shotNo = 0
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true })
  }
  private at(): string {
    const s = Math.round((Date.now() - this.t0) / 1000)
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  }
  log(msg: string): void {
    const line = `[${this.at()}] ${msg}`
    console.log(line)
    this.lines.push(line)
  }
  check(name: string, ok: boolean, detail = ''): boolean {
    this.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail.slice(0, 400)}` : ''}`)
    if (!ok) this.failures++
    return ok
  }
  /** The guest's screen over QMP, named in order. */
  async shot(name: string): Promise<string> {
    const file = join(this.dir, `${String(++this.shotNo).padStart(2, '0')}-${name}.png`)
    const r = await vm('shot', [file], 30_000)
    this.log(r.code === 0 ? `picture ${file}` : `picture failed: ${r.out.slice(0, 160)}`)
    return file
  }
  save(file = 'run.log'): void {
    writeFileSync(join(this.dir, file), this.lines.join('\n') + '\n')
  }
}

// ── the rig ────────────────────────────────────────────────────────────────

export async function run(cmd: string[], timeoutMs = 120_000, stdin?: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(cmd, { cwd: REPO, stdout: 'pipe', stderr: 'pipe', stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin) })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  clearTimeout(timer)
  return { code, out: `${out}${err}`.trim() }
}
export const vm = (script: string, args: string[], timeoutMs?: number): Promise<{ code: number; out: string }> => run([join(resolve(import.meta.dir, '..', '..'), 'scripts', 'win-vm', `${script}.sh`), ...args], timeoutMs)
/** PowerShell as tcuser (or the admin with `admin`), on stdin. */
export const ps = (script: string, timeoutMs?: number, admin = false): Promise<{ code: number; out: string }> => vm('ssh', [...(admin ? ['-a'] : []), '--ps', script], timeoutMs)
/** A program on tcuser's desktop (session 1); with `wait`, its output and exit code. */
/** The installed app in the guest under either name (winAppNames.ts): its folder, exe and name. */
export async function installedApp(): Promise<ReturnType<typeof appOf>> {
  const exe = (await ps(findAppExePs(GUEST_LOCAL))).out.trim()
  if (!exe) throw new Error(`the app is not installed under ${GUEST_LOCAL}\\Programs`)
  return appOf(exe)
}

export const inSession = (argv: string[], wait = false, timeoutS = 120): Promise<{ code: number; out: string }> =>
  vm('run-in-session', [...(wait ? ['--wait', '--timeout', String(timeoutS)] : []), ...argv], (timeoutS + 60) * 1000)

/** The rig's memory rule: the agents slice's programs under 45 GiB. */
export function anonGiB(): number {
  const stat = readFileSync('/sys/fs/cgroup/agents.slice/memory.stat', 'utf8')
  return Math.floor(Number(/^anon (\d+)/m.exec(stat)?.[1] ?? 0) / 2 ** 30)
}

/** Local forwards into the guest as tcuser over SSH (CDP and the app's server listen on the guest's own loopback). */
export function tunnel(forwards: string[]): ChildProcess {
  return spawn(
    'ssh',
    [
      '-N', ...forwards.flatMap((f) => ['-L', f]),
      '-i', paths.key, '-p', String(rig.sshPort),
      '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15',
      '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${paths.knownHosts}`,
      `${STANDARD_USER}@127.0.0.1`
    ],
    { stdio: 'ignore' }
  )
}

/** Lets the guest reach these box ports at 10.0.2.2, for this run only (a fresh up.sh starts blocked again). */
export async function openHostPorts(ports: number[]): Promise<{ code: number; out: string }> {
  const sorted = [...new Set(ports)].sort((a, b) => a - b)
  const ranges: string[] = []
  let from = 1
  for (const p of sorted) {
    if (p > from) ranges.push(p - 1 > from ? `${from}-${p - 1}` : String(from))
    from = p + 1
  }
  if (from <= 65535) ranges.push(from < 65535 ? `${from}-65535` : '65535')
  return ps(`Set-NetFirewallRule -Name tc-block-host-tcp -RemotePort ${ranges.map((r) => `'${r}'`).join(',')}`, 60_000, true)
}

// ── QMP keys, for a native dialog no page script reaches ───────────────────

const SHIFTED: Record<string, string> = { ':': 'semicolon', '_': 'minus', '"': 'apostrophe', '?': 'slash', '>': 'dot', '<': 'comma' }
const PLAIN: Record<string, string> = { ' ': 'spc', '\\': 'backslash', '.': 'dot', '-': 'minus', '/': 'slash', ',': 'comma', ';': 'semicolon', "'": 'apostrophe', '=': 'equal' }
export function qcodesOf(ch: string): string[] {
  if (/[a-z0-9]/.test(ch)) return [ch]
  if (/[A-Z]/.test(ch)) return ['shift', ch.toLowerCase()]
  if (PLAIN[ch]) return [PLAIN[ch]!]
  if (SHIFTED[ch]) return ['shift', SHIFTED[ch]!]
  throw new Error(`no key for ${JSON.stringify(ch)}`)
}
export async function typeText(text: string): Promise<void> {
  for (const ch of text) {
    await qmp(paths.qmp, sendKey(...qcodesOf(ch)))
    await sleep(40)
  }
}
export const pressKeys = (...keys: string[]): Promise<unknown> => qmp(paths.qmp, sendKey(...keys))

// ── stand-ins on the box ───────────────────────────────────────────────────

export const freePort = (): Promise<number> =>
  new Promise((ok) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => ok(port))
    })
  })

export interface StandIn {
  name: string
  root: string
  home: string
  data: string
  log: string
  remote: number
  debug: number | null
  env: Record<string, string>
  proc?: ChildProcess
}

/** An isolated instance of the built tree: its own HOME, userData, key-file vault and remote port. */
export function standIn(root: string, name: string, remote: number, opts: { headless: boolean; debug?: number; env?: Record<string, string> }): StandIn {
  const base = join(root, name)
  const s: StandIn = { name, root: base, home: join(base, 'home'), data: join(base, 'data'), log: join(root, `${name}.log`), remote, debug: opts.debug ?? null, env: opts.env ?? {} }
  for (const d of [s.home, s.data, join(base, 'tmp'), join(s.home, '.claude'), join(s.home, '.codex'), join(base, 'work'), join(base, 'winvm-none')]) mkdirSync(d, { recursive: true })
  return s
}

export function launch(s: StandIn, headless: boolean): void {
  const passed = Object.fromEntries(
    Object.entries(process.env as Record<string, string>).filter(([k]) => !k.startsWith('TEMP_CODE_') && !k.startsWith('CLAUDE') && k !== 'ANTHROPIC_BASE_URL' && k !== 'ELECTRON_RUN_AS_NODE')
  )
  const env: Record<string, string> = {
    ...passed,
    HOME: s.home,
    TMPDIR: join(s.root, 'tmp'),
    TEMP_CODE_USER_DATA: s.data,
    ...(headless ? { TEMP_CODE_HEADLESS: '1' } : {}),
    TEMP_CODE_REMOTE_PORT: String(s.remote),
    TEMP_CODE_ALIAX_DATA_DIR: join(s.data, 'aliax'),
    TEMP_CODE_WORK_ROOT: join(s.root, 'work'),
    // An empty folder for the Windows VM's files: an isolated instance must never see, wake or hibernate the real standing VM.
    WINVM_DIR: join(s.root, 'winvm-none'),
    TEMP_CODE_CLAIM_SHIM: '0',
    TEMP_CODE_GATEWAY_ROLE: 'owner',
    CLAUDE_CONFIG_DIR: join(s.home, '.claude'),
    CODEX_HOME: join(s.home, '.codex'),
    AGENT_CLI_CREDENTIAL_STORE: 'file',
    NODE_ENV: 'production',
    SHELL: '/bin/bash',
    ...(s.debug ? { TEMP_CODE_DEBUG_PORT: String(s.debug) } : {}),
    ...s.env
  }
  const electron = join(REPO, 'node_modules', '.bin', 'electron')
  const argv = ['xvfb-run', '-a', '-s', `-screen 0 1440x900x24 -nolisten tcp${process.env.RIG_FBDIR ? ` -fbdir ${process.env.RIG_FBDIR}` : ''}`, 'dbus-run-session', '--', electron, ...(process.env.RIG_INSPECT ? [`--inspect=${process.env.RIG_INSPECT}`] : []), '.']
  rmSync(join(s.data, 'server.json'), { force: true })
  rmSync(join(s.data, 'rig-port.json'), { force: true })
  appendFileSync(s.log, `\n===== launch ${new Date().toISOString()}\n`)
  // Straight to the log file, never a pipe: a stand-in outlives the script that starts it, and a console write into a
  // closed pipe is an uncaught EPIPE that Electron answers with a modal dialog, freezing the main process.
  const out = openSync(s.log, 'a')
  const proc = spawn(argv[0]!, argv.slice(1), { cwd: REPO, env, stdio: ['ignore', out, out], detached: true })
  closeSync(out)
  proc.unref()
  s.proc = proc
}

export async function until(label: string, ms: number, test: () => Promise<boolean> | boolean, every = 500): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await Promise.resolve(test()).catch(() => false)) return true
    await sleep(every)
  }
  console.log(`      timed out: ${label}`)
  return false
}
/** Up: a headless instance writes server.json; a windowed one's port is read from its window over CDP, kept in rig-port.json. */
export const isUp = (s: StandIn): Promise<boolean> =>
  until(`${s.name} up`, 150_000, async () => {
    if (existsSync(join(s.data, 'server.json'))) return true
    if (!s.debug) return false
    const w = await Window.attach(s.debug, 3_000)
    const port = await w.eval<number | null>('window.api.getServerPort()').finally(() => w.close())
    if (!port) return false
    writeFileSync(join(s.data, 'rig-port.json'), JSON.stringify({ port }))
    return true
  }, 1_000)

/** One request on a local socket (the implicit admin). */
export function rpcAt<T = any>(port: number, method: string, params: unknown = {}, timeoutMs = 120_000): Promise<T> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
  const id = `rig-${Math.random().toString(36).slice(2)}`
  return new Promise<T>((ok, fail) => {
    const timer = setTimeout(() => (ws.close(), fail(new Error(`no answer to ${method}`))), timeoutMs)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id, method, params })))
    ws.addEventListener('message', (ev) => {
      const frame = JSON.parse(String(ev.data)) as { id?: string; ok?: boolean; result?: T; error?: string }
      if (frame.id !== id) return
      clearTimeout(timer)
      ws.close()
      if (frame.ok) ok(frame.result as T)
      else fail(new Error(`${method}: ${frame.error}`))
    })
    ws.addEventListener('error', () => (clearTimeout(timer), fail(new Error(`socket error on ${method}`))))
  })
}
export const rpc = <T = any>(s: StandIn, method: string, params: unknown = {}, timeoutMs?: number): Promise<T> =>
  rpcAt<T>((JSON.parse(readFileSync(join(s.data, existsSync(join(s.data, 'server.json')) ? 'server.json' : 'rig-port.json'), 'utf8')) as { port: number }).port, method, params, timeoutMs)

/** Every process a stand-in started (xvfb and electron children outlive their group), by its userData mark. */
export async function stop(s: StandIn): Promise<void> {
  const pid = s.proc?.pid
  if (pid) {
    for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
      try {
        process.kill(-pid, sig)
      } catch {
        /* gone */
      }
      await sleep(1500)
    }
  }
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      if (readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0').includes(`TEMP_CODE_USER_DATA=${s.data}`)) process.kill(Number(entry), 'SIGKILL')
    } catch {
      /* gone, or not ours */
    }
  }
}

// ── a window over CDP ──────────────────────────────────────────────────────

export class Window {
  private constructor(readonly cdp: Cdp) {}
  static async attach(port: number, timeoutMs = 180_000): Promise<Window> {
    const page = await pageTarget(port, timeoutMs)
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl!)
    await cdp.send('Runtime.enable')
    return new Window(cdp)
  }
  eval<T = unknown>(expr: string): Promise<T> {
    return this.cdp.eval<T>(expr)
  }
  /** The page's visible text. */
  text(): Promise<string> {
    return this.eval<string>('document.body.innerText')
  }
  has(text: string | RegExp): Promise<boolean> {
    return this.text().then((t) => (typeof text === 'string' ? t.includes(text) : text.test(t)))
  }
  /**
   * Presses the visible control whose own text (or aria-label) is exactly `label`, or matches it, with a real mouse
   * press at its center through Chromium's input pipeline. The innermost match wins, the last one in the page on a tie.
   */
  async click(label: string | RegExp, within = 'button, a, [role=button], [role=menuitem], [role=tab], [role=option], [role=row], [role=link], li, label, summary'): Promise<boolean> {
    const pattern = typeof label === 'string' ? `^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$` : label.source
    const at = await this.eval<{ x: number; y: number } | null>(`(() => {
      const re = new RegExp(${JSON.stringify(pattern)})
      const els = [...document.querySelectorAll(${JSON.stringify(within)})].filter((e) => {
        const r = e.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && re.test((e.innerText || e.getAttribute('aria-label') || '').trim())
      })
      const inner = els.filter((e) => !els.some((o) => o !== e && e.contains(o)))
      const el = inner[inner.length - 1]
      if (!el) return null
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })()`)
    if (!at) return false
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'] as const)
      await this.cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 })
    return true
  }
  /** Real keys typed into whatever has focus. */
  async type(text: string): Promise<void> {
    await this.cdp.send('Input.insertText', { text })
  }
  async key(key: 'Enter' | 'Escape'): Promise<void> {
    const code = key === 'Enter' ? 13 : 27
    for (const type of ['keyDown', 'keyUp'] as const) await this.cdp.send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: code })
  }
  /** Types into the focused field, or the field matched by `selector`, as a paste would. */
  async fill(selector: string, value: string): Promise<boolean> {
    return this.eval<boolean>(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return false
      el.focus()
      const setter = Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set
      setter.call(el, ${JSON.stringify(value)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
  }
  async png(file: string): Promise<void> {
    const r = (await this.cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
    writeFileSync(file, Buffer.from(r.data, 'base64'))
  }
  close(): void {
    this.cdp.close()
  }
}
