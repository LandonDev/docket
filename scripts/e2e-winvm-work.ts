#!/usr/bin/env bun
/**
 * B10's whole job on the Windows VM (plan-m1X24rQ6nikm, docs/agents/work-winvm.md): an ISOLATED instance of the
 * BUILT tree on the box, its keeper on the STANDING machine, and ONE real Work thread on Claude Opus 5.5 at low
 * effort that types a line into Notepad and saves it with Ctrl+S, then fills a small form in Edge and submits it.
 *
 *   1. Setup by the keeper's own `work.winvm.setup` (a fresh standing disk), Work on, a Work workspace with
 *      "Computer use on the Windows VM" on (`work.workspace.set { windowsVm: true }`).
 *   2. The form is served from the box for this run only, on a port the guest reaches at 10.0.2.2 once the
 *      guest's `tc-block-host-tcp` rule is narrowed to every other port (restored at the end).
 *   3. Checks: the submit held in the Outbox as a `computer.act`, Send pressed by the script, exactly one post;
 *      the saved file read as the admin; a viewer's `vm:windows` stream through the relay (frames counted and
 *      acked); his Take over (`computer.drive` owner, a drive stream) typing a line into Notepad, then Hand back.
 *
 * The thread runs on the box's own Claude login, copied into the instance's own config dir and sent direct
 * (`TEMP_CODE_DIRECT_PROVIDERS=claude`): an isolated instance does not own the gateway's marker. Warm harnesses
 * are off, so the one thread is the only model process. Everything this run made is taken away at its end:
 * the thread stopped, the VM put to sleep and its disk deleted (so the owner's Set up starts clean), the
 * instance killed and its root removed. Run it after `electron-vite build`, under the standing machine's lock:
 *
 *   mkdir -p /srv/agents/win-vm/standing && flock -o -n /srv/agents/win-vm/standing/.lock \
 *     env -u ELECTRON_RUN_AS_NODE bun scripts/e2e-winvm-work.ts [--out <dir>]
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { encodeAck, encodeInput, parseFrame, type InputEvent } from '../src/shared/video/nsl1'
import { encodePowerShell, psQuote } from '../src/main/server/work/winvm/machine/guest'
import { qmp, screendump } from '../src/main/server/work/winvm/machine/qmp'
import { SshGuest } from '../src/main/server/work/winvm/sshGuest'
import { StandingMachine } from '../src/main/server/work/winvm/standing'

const REPO = resolve(import.meta.dir, '..')
const flag = process.argv.indexOf('--out')
const OUT = resolve(flag > 0 ? process.argv[flag + 1]! : join(REPO, '..', '..', '..', '.temp-code/plans/landed/computers-vm/b10'))
/**
 * The VM's service. Built from this tree into its own resources/native, as the box's deploy builds it, so the
 * instance finds it the way the installed box does (serviceBin.ts, from inside its lazy chunk): a run that named the
 * file in TEMP_CODE_WINVM_EXE skipped that lookup and missed a broken one. TEMP_CODE_WINVM_EXE still names another
 * file when the person running this asks for it.
 */
const NAMED = process.env.TEMP_CODE_WINVM_EXE ?? ''
let EXE = NAMED'
const TOOLS = process.env.E2E_WORK_TOOLS ?? '/srv/agents/temp-code-data/work-tools'
const REAL_HOME = process.env.HOME ?? '/srv/agents/home'
const MODEL = 'claude-opus-5-5'
const LINE = 'B10 proof line 4711 typed by the agent'
const FILE = 'b10-proof.txt'
const GUEST_FILE = `C:\\Users\\tcuser\\Documents\\${FILE}`
const HIS_LINE = 'his take over line'
const SETTLED = ['idle', 'done', 'error', 'stopped', 'watching']
/** a held act he can press: `held`, or `live` (its window still shows what was held) */
const PRESSABLE = ['held', 'live']

const freePort = (): Promise<number> =>
  new Promise((ok) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number }
      srv.close(() => ok(port))
    })
  })
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const stamp = (): string => `${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s`
const results: string[] = []
const numbers: Record<string, unknown> = {}
let failures = 0
const log = (m: string): void => console.log(`[b10 ${stamp()}] ${m}`)
function check(label: string, ok: boolean, detail = ''): boolean {
  const line = `${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail.slice(0, 500)}` : ''}`
  results.push(line)
  log(line)
  if (!ok) failures++
  return ok
}
function note(line: string): void {
  results.push(`NOTE ${line}`)
  log(line)
}
async function until(ms: number, test: () => Promise<boolean> | boolean, every = 1000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await Promise.resolve(test()).catch(() => false)) return true
    await sleep(every)
  }
  return false
}

// ---------------------------------------------------------------- the isolated instance

class Instance {
  readonly root = realpathSync(mkdtempSync('/tmp/e2e-winvm-work-'))
  readonly data = join(this.root, 'data')
  readonly home = join(this.root, 'home')
  readonly work = join(this.home, 'work')
  readonly logFile = join(this.root, 'instance.log')
  port = 0
  remotePort = 0
  private proc: ChildProcess | null = null

  async start(): Promise<void> {
    // the box is headless: his viewers are remote clients on the fixed-port listener, as the Mac app and the phone are
    this.remotePort = await freePort()
    for (const d of [this.data, this.home, this.work, join(this.root, 'tmp'), join(this.home, '.claude'), join(this.home, '.local', 'bin')]) mkdirSync(d, { recursive: true })
    this.linkTools()
    // The box's Claude login, copied (never pointed at): a long-lived token with no refresh, so nothing writes back.
    copyFileSync(join(REAL_HOME, '.claude', '.credentials.json'), join(this.home, '.claude', '.credentials.json'))
    chmodSync(join(this.home, '.claude', '.credentials.json'), 0o600)
    symlinkSync(join(REAL_HOME, '.local', 'bin', 'claude'), join(this.home, '.local', 'bin', 'claude'))
    const runtime = process.env.XDG_RUNTIME_DIR
    const env: Record<string, string> = {
      ...Object.fromEntries(Object.entries(process.env as Record<string, string>).filter(([k]) => !/^(TEMP_CODE_|CLAUDE|ANTHROPIC_|CODEX_)/.test(k) && k !== 'ELECTRON_RUN_AS_NODE' && !(k === 'XDG_RUNTIME_DIR' && runtime && !runtime.endsWith(`/${process.getuid?.()}`)))),
      PATH: `${join(this.home, '.local', 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: this.home,
      TMPDIR: join(this.root, 'tmp'),
      TEMP_CODE_USER_DATA: this.data,
      TEMP_CODE_HEADLESS: '1',
      TEMP_CODE_REMOTE_PORT: String(this.remotePort),
      TEMP_CODE_ALIAX_DATA_DIR: join(this.data, 'aliax'),
      TEMP_CODE_CLAIM_SHIM: '0',
      TEMP_CODE_WARM_HARNESS: '0',
      TEMP_CODE_DIRECT_PROVIDERS: 'claude',
      TEMP_CODE_WORK_ROOT: this.work,
      ...(NAMED ? { TEMP_CODE_WINVM_EXE: NAMED } : {}),
      CLAUDE_CONFIG_DIR: join(this.home, '.claude'),
      CODEX_HOME: join(this.home, '.codex'),
      AGENT_CLI_CREDENTIAL_STORE: 'file',
      ALIAX_CREDENTIAL_BACKEND: 'file',
      NODE_ENV: 'production',
      SHELL: '/bin/bash',
      ELECTRON_DISABLE_SANDBOX: '1'
    }
    const electron = join(REPO, 'node_modules', '.bin', 'electron')
    const argv = ['xvfb-run', '-a', '-s', '-screen 0 1280x800x24 -nolisten tcp', 'dbus-run-session', '--', electron, '.']
    this.proc = spawn(argv[0]!, argv.slice(1), { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    this.proc.stdout?.on('data', (c: Buffer) => appendFileSync(this.logFile, c))
    this.proc.stderr?.on('data', (c: Buffer) => appendFileSync(this.logFile, c))
    const up = await until(180_000, () => existsSync(join(this.data, 'server.json')), 500)
    if (!up) throw new Error(`the instance did not start: ${this.tail()}`)
    this.port = (JSON.parse(readFileSync(join(this.data, 'server.json'), 'utf8')) as { port: number }).port
    check('the isolated instance is up', await until(60_000, () => this.call('work.get').then(() => true), 1000), `port ${this.port}, root ${this.root}`)
  }

  tail(n = 2000): string {
    return existsSync(this.logFile) ? readFileSync(this.logFile, 'utf8').slice(-n) : ''
  }

  private linkTools(): void {
    if (!existsSync(join(TOOLS, 'state.json'))) return
    const mine = join(this.data, 'work-tools')
    mkdirSync(mine, { recursive: true })
    for (const name of readdirSync(TOOLS)) {
      if (['jobs', 'run', 'downloads'].includes(name)) mkdirSync(join(mine, name), { recursive: true })
      else if (name === 'state.json') writeFileSync(join(mine, name), readFileSync(join(TOOLS, name)))
      else symlinkSync(join(TOOLS, name), join(mine, name))
    }
  }

  /** One request on the instance's local socket (the implicit admin). */
  call<T>(method: string, params: unknown = {}, timeoutMs = 120_000): Promise<T> {
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}/`)
    const id = `b10-${Math.random().toString(36).slice(2)}`
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

  /** Every process of this instance, found by its userData in the environ or its root in the command line. */
  pids(): number[] {
    const marker = `TEMP_CODE_USER_DATA=${this.data}`
    const out: number[] = []
    for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
      if (Number(pid) === process.pid) continue
      try {
        const environ = readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
        const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
        if (environ.includes(marker) || cmd.includes(this.root)) out.push(Number(pid))
      } catch {
        /* gone, or not ours */
      }
    }
    return out
  }

  /** Model processes this instance started: claude or codex children. */
  models(): string[] {
    return this.pids().flatMap((pid) => {
      try {
        const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
        const exe = cmd[0] ?? ''
        return /(^|\/)(claude|codex)$|\/claude\/versions\//.test(exe) ? [`${pid} ${cmd.slice(0, 3).join(' ')}`] : []
      } catch {
        return []
      }
    })
  }

  kill(): void {
    for (let i = 0; i < 3; i++) {
      for (const pid of this.pids()) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* gone */
        }
      }
      try {
        if (this.proc?.pid) process.kill(-this.proc.pid, 'SIGKILL')
      } catch {
        /* gone */
      }
    }
  }
}

/**
 * His device on the box's listener: a client key minted for this run (revoked with the instance), a 30 s ticket at
 * `/api/ticket`, then `/ws?ticket=…` that stays open. A headless host's own socket is no desktop, so it may not watch.
 */
class Client {
  private ws!: WebSocket
  private n = 0
  private waiting = new Map<string, { ok: (v: unknown) => void; fail: (e: Error) => void }>()
  constructor(private readonly port: number) {}
  async open(key: string): Promise<void> {
    const r = await fetch(`http://127.0.0.1:${this.port}/api/ticket`, { method: 'POST', headers: { Authorization: `Bearer ${key}` } })
    if (!r.ok) throw new Error(`/api/ticket answered ${r.status}`)
    const { ticket } = (await r.json()) as { ticket: string }
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws?ticket=${encodeURIComponent(ticket)}`)
    await new Promise((ok, fail) => ((this.ws.onopen = ok), (this.ws.onerror = fail)))
    this.ws.onmessage = (ev) => {
      const f = JSON.parse(String(ev.data)) as { id?: string; ok?: boolean; result?: unknown; error?: string }
      const w = f.id ? this.waiting.get(f.id) : undefined
      if (!w) return
      this.waiting.delete(f.id!)
      if (f.ok) w.ok(f.result)
      else w.fail(new Error(f.error))
    }
  }
  call<T>(method: string, params: unknown): Promise<T> {
    const id = `c${++this.n}`
    return new Promise<T>((ok, fail) => {
      this.waiting.set(id, { ok: ok as (v: unknown) => void, fail })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => this.waiting.has(id) && (this.waiting.delete(id), fail(new Error(`no answer to ${method}`))), 60_000)
    })
  }
  close(): void {
    try {
      this.ws.close()
    } catch {
      /* gone */
    }
  }
}

type Opened = { ok: true; stream: string; ticket: string; width: number; height: number; fps: number } | { ok: false; reason: string }

/** A viewer of `vm:windows`: its own socket on `/video/<stream>`, every frame counted and acked as a viewer that draws at once. */
class Viewer {
  frames: { at: number; bytes: number; key: boolean; w: number; h: number }[] = []
  closes: string[] = []
  generation = 0
  stream = ''
  private sock: WebSocket | null = null
  private stopped = false
  constructor(
    private readonly client: Client,
    private readonly port: number,
    private readonly drive = false
  ) {}
  async open(): Promise<Opened> {
    const answer = await this.client.call<Opened>('video.open', { threadId: this.drive ? 'his' : 'b10-viewer', computer: 'vm:windows', maxEdge: 1280, ...(this.drive ? { drive: true } : {}) })
    if (!answer.ok) return answer
    this.stream = answer.stream
    const sock = new WebSocket(`ws://127.0.0.1:${this.port}/video/${answer.stream}?ticket=${encodeURIComponent(answer.ticket)}`, ['nsl1'])
    sock.binaryType = 'arraybuffer'
    sock.onmessage = (ev) => {
      if (typeof ev.data === 'string') return
      const f = parseFrame(new Uint8Array(ev.data as ArrayBuffer))
      this.generation = f.generation
      this.frames.push({ at: Date.now(), bytes: (ev.data as ArrayBuffer).byteLength, key: f.keyframe, w: f.width, h: f.height })
      sock.send(encodeAck(f.generation, f.sequence, 0))
    }
    sock.onclose = (ev) => {
      this.closes.push(`${ev.code}${ev.reason ? ` ${ev.reason}` : ''}`)
      if (!this.stopped && !this.drive && this.closes.length < 8) setTimeout(() => void this.open().catch(() => {}), 1000)
    }
    this.sock = sock
    return answer
  }
  input(event: InputEvent): void {
    this.sock?.send(encodeInput(event, this.generation))
  }
  async keys(...keys: number[]): Promise<void> {
    for (const key of keys) this.input({ type: 'keyDown', key })
    for (const key of [...keys].reverse()) this.input({ type: 'keyUp', key })
    await sleep(120)
  }
  /** Lower-case letters and spaces, as HID usages. */
  async type(text: string): Promise<void> {
    for (const ch of text) await this.keys(ch === ' ' ? 44 : 4 + ch.charCodeAt(0) - 97)
  }
  async close(): Promise<void> {
    this.stopped = true
    this.sock?.close()
    if (this.stream) await this.client.call('video.close', { stream: this.stream }).catch(() => null)
  }
}

// ---------------------------------------------------------------- the guest

const machine = new StandingMachine('standing')
const guest = new SshGuest(machine.c, machine.p)

/** Every Notepad window's edit controls' text on tcuser's desktop, read through Win32 (WM_GETTEXT). */
const READ_NOTEPAD = [
  'Add-Type @"',
  'using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;',
  'public static class N {',
  '  public delegate bool EnumProc(IntPtr h, IntPtr l);',
  '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);',
  '  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, int m, IntPtr w, StringBuilder l, int f, int t, out IntPtr r);',
  '  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, int m, IntPtr w, IntPtr l, int f, int t, out IntPtr r);',
  '  public static string Read() {',
  '    var all = new List<string>();',
  '    EnumWindows((top, l0) => { var tc = new StringBuilder(256); GetClassName(top, tc, 256); if (tc.ToString() != "Notepad") return true;',
  '      EnumChildWindows(top, (h, l) => { var c = new StringBuilder(256); GetClassName(h, c, 256);',
  '        if (c.ToString().StartsWith("RichEdit")) { IntPtr r; SendMessageTimeout(h, 0x0E, IntPtr.Zero, IntPtr.Zero, 3, 2000, out r); int n = (int)r; var s = new StringBuilder(n + 1); SendMessageTimeout(h, 0x0D, (IntPtr)(n + 1), s, 3, 2000, out r); all.Add(s.ToString().Replace("\\r", " ").Replace("\\n", " ")); }',
  '        return true; }, IntPtr.Zero); return true; }, IntPtr.Zero);',
  '    return "edits=" + all.Count + "\\ntext=" + String.Join(" | ", all);',
  '  }',
  '}',
  '"@',
  '[N]::Read()'
].join('\n')

async function readNotepad(): Promise<{ edits: string; text: string }> {
  const out = await guest.onDesktop(['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(READ_NOTEPAD)], true, 90)
  return { edits: /edits=(\S+)/.exec(out)?.[1] ?? '?', text: /text=(.*)/.exec(out)?.[1]?.trim() ?? '' }
}

async function shot(name: string): Promise<boolean> {
  const file = join(OUT, name)
  try {
    await qmp(machine.p.qmp, screendump(file))
    return existsSync(file)
  } catch (e) {
    note(`no QMP picture ${name}: ${(e as Error).message}`)
    return false
  }
}

// ---------------------------------------------------------------- the form, served for this run only

const posts: { at: number; body: string }[] = []
const gets: { at: number; path: string }[] = []
const FORM = `<!doctype html><html><head><meta charset="utf-8"><title>B10 sign-up</title>
<style>body{font:18px Segoe UI,sans-serif;margin:40px}label{display:block;margin:14px 0 4px}input,textarea{font:18px Segoe UI,sans-serif;width:420px}button{margin-top:18px;font:18px Segoe UI,sans-serif;padding:6px 18px}</style></head>
<body><h1>B10 sign-up</h1><form method="post" action="/submit">
<label for="name">Name</label><input id="name" name="name" required>
<label for="team">Team</label><input id="team" name="team" required>
<label for="note">Note</label><textarea id="note" name="note" rows="3"></textarea>
<br><button type="submit">Submit</button></form></body></html>`
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (req.method === 'POST' && url.pathname === '/submit') {
      posts.push({ at: Date.now(), body: await req.text() })
      log(`the form posted (${posts.length}): ${posts.at(-1)!.body}`)
      return new Response('<!doctype html><title>Thanks</title><h1>Thanks, it is in.</h1>', { headers: { 'content-type': 'text/html' } })
    }
    if (url.pathname === '/ping') return new Response('pong')
    gets.push({ at: Date.now(), path: url.pathname })
    return new Response(FORM, { headers: { 'content-type': 'text/html' } })
  }
})
const PORT = server.port!
const FORM_URL = `http://10.0.2.2:${PORT}/`

// ---------------------------------------------------------------- the run

const inst = new Instance()
let mine = false
let firewallNarrowed = false
let sessionId: string | null = null

interface Meta {
  id: string
  status: string
  title?: string
}
interface HeldRow {
  ref: { at: 'host'; id: string }
  kind: string
  state: string
  summary: string
  sessionId: string | null
  payload: unknown
}
const metaOf = async (id: string): Promise<Meta | undefined> => (await inst.call<Meta[]>('session.list', {})).find((m) => m.id === id)
const heldActs = async (): Promise<HeldRow[]> => ((await inst.call<{ items: HeldRow[] }>('work.outbox.list', {})).items ?? []).filter((i) => i.kind === 'computer.act')

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  if (!existsSync(join(REPO, 'out', 'main', 'index.js'))) throw new Error('no build: run electron-vite build first')
  if (!EXE) {
    const into = join(REPO, 'resources', 'native')
    execFileSync('bun', [join(REPO, 'scripts', 'build-tc-computer-win.ts'), '--into', into], { cwd: REPO, stdio: 'inherit' })
    EXE = join(into, 'tc-computer.exe')
  }
  if (!existsSync(EXE)) throw new Error(`no tc-computer.exe at ${EXE}`)
  if (machine.running() || machine.hasDisk()) throw new Error('the standing machine is running or has a disk: another thread holds it')
  mine = true
  numbers.formPort = PORT

  await inst.start()
  await inst.call('work.set', { enabled: true })
  const ws = await inst.call<{ id: string }>('workspace.create', { kind: 'work', sector: 'life', name: 'B10 Windows VM' })
  const set = await inst.call<{ windowsVm?: boolean }>('work.workspace.set', { workspaceId: ws.id, patch: { windowsVm: true } })
  check('a Work workspace with "Computer use on the Windows VM" on', set.windowsVm === true, JSON.stringify(set))

  // 1. setup by the keeper
  const setupAt = Date.now()
  const first = await inst.call<{ state: string }>('work.winvm.setup', {})
  log(`setup asked: ${first.state}`)
  let lastStep = ''
  let state = { state: '', step: null as string | null, error: null as string | null }
  await until(
    40 * 60_000,
    async () => {
      state = await inst.call('work.winvm.state', {})
      const line = `${state.state}${state.step ? ` (${state.step})` : ''}${state.error ? ` error: ${state.error}` : ''}`
      if (line !== lastStep) log(`keeper: ${line} at ${((Date.now() - setupAt) / 1000).toFixed(0)} s`)
      lastStep = line
      return state.state === 'awake' || (state.state !== 'setting-up' && !!state.error)
    },
    3000
  )
  numbers.setupSeconds = Math.round((Date.now() - setupAt) / 1000)
  if (state.error && machine.running()) {
    // what the guest says, then one wake: it starts the logon task and knocks again
    const why = await guest
      .admin(
        [
          "'door: ' + ((Get-Process tc-computer -IncludeUserName -ErrorAction SilentlyContinue | ForEach-Object { \"$($_.Id) $($_.UserName)\" }) -join ', ')",
          "'listen: ' + ((Get-NetTCPConnection -LocalPort 47800 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.LocalAddress }) -join ', ')",
          "$t = Get-ScheduledTask -TaskPath '\\TempCode\\' -ErrorAction SilentlyContinue; $t | ForEach-Object { 'task: ' + $_.TaskName + ' ' + $_.State + ' last ' + ($_ | Get-ScheduledTaskInfo).LastTaskResult }",
          "'logon: ' + ((Get-CimInstance Win32_ComputerSystem).UserName)"
        ].join('\n')
      )
      .catch((e) => String(e))
    note(`setup's door did not answer; the guest says: ${why.replace(/\r?\n/g, '; ')}`)
    const woke = await inst.call<{ state: string; error: string | null }>('work.winvm.wake', {}, 300_000).catch((e) => ({ state: 'error', error: (e as Error).message }))
    note(`one wake after it: ${woke.state}${woke.error ? `, ${woke.error}` : ''}`)
    state = await inst.call('work.winvm.state', {})
    numbers.setupDoorRetried = true
  }
  if (numbers.setupDoorRetried) {
    check('the keeper set the VM up (work.winvm.setup) and it is awake', false, `${numbers.setupSeconds} s: setup ended "The service in the Windows VM did not answer."`)
    if (!check('one work.winvm.wake after it opens the door', state.state === 'awake' && !state.error, JSON.stringify(state))) throw new Error('setup failed')
  } else if (!check('the keeper set the VM up (work.winvm.setup) and it is awake', state.state === 'awake' && !state.error, `${numbers.setupSeconds} s, ${JSON.stringify(state)}`)) throw new Error('setup failed')

  // 2. the guest reaches this run's port alone; Edge opens with no first-run pages
  await guest.admin(`Set-NetFirewallRule -Name 'tc-block-host-tcp' -RemotePort @('1-${PORT - 1}', '${PORT + 1}-65535')`)
  firewallNarrowed = true
  await guest.admin(
    [
      `$k = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge'`,
      'New-Item -Path $k -Force | Out-Null',
      'foreach ($v in @(@("HideFirstRunExperience", 1), @("BrowserSignin", 0), @("SyncDisabled", 1), @("DefaultBrowserSettingEnabled", 0), @("AutoImportAtFirstRun", 4), @("AutomaticHttpsDefault", 0))) { New-ItemProperty -Path $k -Name $v[0] -Value $v[1] -PropertyType DWord -Force | Out-Null }'
    ].join('\n')
  )
  const ping = await guest.admin(`(Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 'http://10.0.2.2:${PORT}/ping').Content`).catch((e) => String(e))
  check(`the guest reaches the form at 10.0.2.2:${PORT} (tc-block-host-tcp narrowed to every other port)`, ping.trim() === 'pong', ping.trim().slice(0, 200))
  const other = await guest.admin(`try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 'http://10.0.2.2:${inst.port}/').StatusCode } catch { 'blocked' }`).catch((e) => String(e))
  check("another box port stays blocked to the guest (the instance's own)", other.trim() === 'blocked', other.trim().slice(0, 200))

  // 3. a viewer of vm:windows through the relay, for the thread's whole turn
  const key = await inst.call<{ token: string }>('remote.keys.create', { name: 'B10 viewer', audience: 'client', caps: ['read', 'operate', 'approve', 'admin'] })
  const client = new Client(inst.remotePort)
  await client.open(key.token)
  const viewer = new Viewer(client, inst.remotePort)
  const opened = await viewer.open()
  check('video.open { computer: vm:windows } answers a stream', opened.ok, JSON.stringify(opened).replace(/"ticket":"[^"]+"/, '"ticket":"…"'))
  const viewFrom = Date.now()

  // 4. ONE real Work thread on Opus 5.5 at low effort
  const brief = [
    'Use the Windows VM (the windows_* tools) for two small jobs, in order.',
    `1. Open Notepad, type exactly this line: ${LINE}`,
    `   Then press Ctrl+S. In the Save as dialog, put ${GUEST_FILE} in the File name box and press the Enter key; make sure the save finished.`,
    `2. Open Microsoft Edge at ${FORM_URL}: launch it as "msedge.exe" with that address in open.`,
    '   Fill the form: Name "Ada Lovelace", Team "Analytical Engines", Note "Proof run B10".',
    '   Then click Submit. This is a test of the hold: the host keeps that click for my press in the Outbox, and that is expected.',
    '   Once the click is held, do nothing more in the VM, and stop with one short line saying what is held.'
  ].join('\n')
  const createdAt = Date.now()
  const s = await inst.call<{ id: string; scope?: string; model?: string; reasoning?: string }>('session.create', {
    provider: 'claude',
    model: MODEL,
    reasoning: 'low',
    workspaceId: ws.id,
    threadType: 'chat',
    permission: 'auto',
    title: 'B10 Notepad and a form',
    firstMessage: brief
  })
  sessionId = s.id
  check(`one Work thread on ${MODEL} at low effort`, s.scope === 'work' && s.model === MODEL && s.reasoning === 'low', JSON.stringify({ id: s.id, scope: s.scope, model: s.model, reasoning: s.reasoning }))

  // the thread works: wait for the held submit or the turn's end
  let held: HeldRow | undefined
  let settledAt = 0
  let maxModels = 0
  const modelLines = new Set<string>()
  let lastStatus = ''
  const falseHolds = new Map<string, string>()
  await until(
    25 * 60_000,
    async () => {
      for (const m of inst.models()) modelLines.add(m.split(' ')[0]!)
      maxModels = Math.max(maxModels, inst.models().length)
      const meta = await metaOf(s.id)
      if (meta && meta.status !== lastStatus) log(`thread: ${meta.status}`)
      lastStatus = meta?.status ?? lastStatus
      const acts = await heldActs()
      // a held act that is no send (Notepad's save read as "Forward"): he presses it at once, as he would at the
      // Outbox, while its window is still in front, so the save happens; the false hold is a FAIL line below
      for (const o of acts.filter((i) => PRESSABLE.includes(i.state) && !/submit/i.test(i.summary) && !falseHolds.has(i.ref.id))) {
        falseHolds.set(o.ref.id, o.summary)
        const full = await inst.call<{ payload: { picture?: { mimeType: string; data?: string } | null } }>('work.outbox.get', { ref: o.ref }).catch(() => null)
        const pic = full?.payload?.picture
        const r = await inst.call<{ state?: string; error?: string | null }>('work.outbox.send', { ref: o.ref }).catch((e) => ({ state: `error ${(e as Error).message}`, error: null }))
        note(`pressed Send at once on the false hold ${o.ref.id} (${o.summary}): ${r.state}${r.error ? `, ${r.error}` : ''}`)
        if (pic?.data) writeFileSync(join(OUT, `outbox-false-hold-${falseHolds.size}.${pic.mimeType.includes('png') ? 'png' : 'jpg'}`), Buffer.from(pic.data, 'base64'))
      }
      if (!held) {
        held = acts.find((i) => PRESSABLE.includes(i.state) && /submit/i.test(i.summary))
        if (held) {
          numbers.secondsToHeld = Math.round((Date.now() - createdAt) / 1000)
          log(`held: ${held.summary}`)
          await shot('frame-at-hold.png')
        }
      }
      if (meta && SETTLED.includes(meta.status) && Date.now() - createdAt > 10_000) {
        settledAt ||= Date.now()
        return true
      }
      return false
    },
    500
  )
  numbers.turnSeconds = settledAt ? Math.round((settledAt - createdAt) / 1000) : null
  const all = await heldActs().catch(() => [] as HeldRow[])
  for (const i of all) note(`outbox: item ${i.ref.id} ${i.state}: ${i.summary}`)
  // the submit is the one to press; another held act of the thread (a false hold) is noted, and left
  held = all.find((i) => PRESSABLE.includes(i.state) && /submit/i.test(i.summary))
  // another held act of the thread is no send (Notepad's save): a false hold, said so, and pressed as he would
  const others = all.filter((i) => PRESSABLE.includes(i.state) && i !== held)
  check("Notepad's save ran without a hold (only the submit is held)", others.length === 0 && falseHolds.size === 0, [...falseHolds.values(), ...others.map((i) => i.summary)].join('; '))
  for (const [n, o] of others.entries()) {
    const full = await inst.call<{ payload: { picture?: { mimeType: string; data?: string } | null } }>('work.outbox.get', { ref: o.ref }).catch(() => null)
    const pic = full?.payload?.picture
    if (pic?.data) writeFileSync(join(OUT, `outbox-false-hold-${n + 1}.${pic.mimeType.includes('png') ? 'png' : 'jpg'}`), Buffer.from(pic.data, 'base64'))
    const r = await inst.call<{ state?: string; error?: string | null; result?: unknown }>('work.outbox.send', { ref: o.ref }).catch((e) => ({ state: `error ${(e as Error).message}`, error: null, result: null }))
    note(`pressed Send on the false hold ${o.ref.id}: ${r.state}${r.error ? `, ${r.error}` : ''}${r.result ? `, ${JSON.stringify(r.result).slice(0, 200)}` : ''}`)
    await sleep(4000)
    await shot(`frame-after-false-hold-press-${n + 1}.png`)
  }
  const holdLines = inst.tail(400_000).split('\n').filter((l) => /could not be held|held|outbox/i.test(l) && !/^\[boot\]/.test(l))
  if (holdLines.length) writeFileSync(join(OUT, 'instance-hold-lines.txt'), holdLines.slice(-80).join('\n') + '\n')
  const events = await inst.call<{ type: string; costUsd?: number; inputTokens?: number; outputTokens?: number; name?: string; text?: string; delta?: boolean; input?: unknown; partial?: boolean }[] | { events: unknown[] }>('session.events', { sessionId: s.id })
  const evs = (Array.isArray(events) ? events : ((events as { events: unknown[] }).events ?? [])) as { type: string; costUsd?: number; inputTokens?: number; outputTokens?: number; name?: string; text?: string; delta?: boolean; input?: unknown; partial?: boolean; event?: unknown }[]
  const flat = evs.map((e) => ((e as { event?: unknown }).event ?? e) as (typeof evs)[number])
  const turns = flat.filter((e) => e.type === 'turn-complete')
  numbers.costUsd = turns.reduce((a, e) => a + (e.costUsd ?? 0), 0) || null
  numbers.tokens = { input: turns.reduce((a, e) => a + (e.inputTokens ?? 0), 0), output: turns.reduce((a, e) => a + (e.outputTokens ?? 0), 0) }
  const calls = flat.filter((e) => e.type === 'tool-call' && !e.partial).map((e) => `${e.name} ${String(JSON.stringify(e.input) ?? '').slice(0, 160)}`)
  numbers.toolCalls = calls.length
  writeFileSync(join(OUT, 'thread-tool-calls.txt'), calls.join('\n') + '\n')
  const said = flat.filter((e) => e.type === 'assistant-text' && !e.delta).map((e) => e.text).join('\n')
  writeFileSync(join(OUT, 'thread-said.txt'), said + '\n')
  check('the thread ended its turn', settledAt > 0, `status ${lastStatus}, ${numbers.turnSeconds} s, ${calls.length} tool calls, cost ${numbers.costUsd ?? 'not shown'}`)
  numbers.modelProcessesSeen = modelLines.size
  check('exactly one model process ran in the instance (the thread\'s Claude)', modelLines.size === 1 && maxModels <= 1, `${modelLines.size} seen, at most ${maxModels} at once`)

  // 5. the submit held, the press, one post
  if (check('the submit is held in the Outbox as a computer.act', !!held && posts.length === 0, held ? `${held.summary}, state ${held.state} (posts before the press: ${posts.length})` : `none held; posts ${posts.length}; GETs ${gets.length}`)) {
    const full = await inst.call<{ payload: { picture?: { mimeType: string; data?: string; width: number; height: number } | null } }>('work.outbox.get', { ref: held!.ref })
    const pic = full.payload?.picture
    if (pic?.data) {
      const ext = pic.mimeType.includes('png') ? 'png' : 'jpg'
      writeFileSync(join(OUT, `outbox-held-picture.${ext}`), Buffer.from(pic.data, 'base64'))
    }
    check("the held act keeps its picture", !!pic?.data, pic ? `${pic.mimeType} ${pic.width}×${pic.height}` : 'none')
    const pressedAt = Date.now()
    const sent = await inst.call<{ state?: string }>('work.outbox.send', { ref: held!.ref }).catch((e) => ({ state: `error ${(e as Error).message}` }))
    log(`Send pressed: ${JSON.stringify(sent).slice(0, 300)}`)
    await until(90_000, () => posts.length > 0, 500)
    numbers.secondsPressToPost = posts.length ? Math.round((posts[0]!.at - pressedAt) / 100) / 10 : null
    await sleep(15_000)
    const after = (await inst.call<{ items: HeldRow[] }>('work.outbox.list', { show: 'all' }).catch(() => ({ items: [] as HeldRow[] }))).items.find((i) => i.ref.id === held!.ref.id)
    check('Send pressed: the form posted exactly once', posts.length === 1, `${posts.length} posts${posts[0] ? `: ${posts[0].body}` : ''}; item ${after?.state ?? '?'}; ${numbers.secondsPressToPost ?? '-'} s after the press`)
    check('the post carries what the thread filled', /name=Ada(\+|%20)Lovelace/.test(posts[0]?.body ?? '') && /team=Analytical/.test(posts[0]?.body ?? ''), posts[0]?.body ?? '')
    await shot('frame-after-send.png')
  }

  // 6. the saved file
  const saved = await guest.admin(`if (Test-Path -LiteralPath ${psQuote(GUEST_FILE)}) { 'text=' + [IO.File]::ReadAllText(${psQuote(GUEST_FILE)}) } else { 'missing'; Get-ChildItem 'C:\\Users\\tcuser\\Documents' | Select-Object -ExpandProperty Name }`).catch((e) => String(e))
  check(`Notepad saved ${GUEST_FILE} with the line (read as the admin)`, saved.trim() === `text=${LINE}`, saved.trim().slice(0, 300))

  // 7. the viewer's stream
  const viewSecs = (Date.now() - viewFrom) / 1000
  await viewer.close()
  const fr = viewer.frames
  const perSec = new Map<number, number>()
  for (const f of fr) perSec.set(Math.floor(f.at / 1000), (perSec.get(Math.floor(f.at / 1000)) ?? 0) + 1)
  numbers.viewer = {
    seconds: Math.round(viewSecs),
    frames: fr.length,
    keyframes: fr.filter((f) => f.key).length,
    averageFps: Math.round((fr.length / viewSecs) * 10) / 10,
    busiestSecondFps: Math.max(0, ...perSec.values()),
    secondsWithFrames: perSec.size,
    size: fr[0] ? `${fr[0].w}×${fr[0].h}` : null,
    mbit: Math.round(((fr.reduce((a, f) => a + f.bytes, 0) * 8) / viewSecs / 1e6) * 100) / 100,
    closes: viewer.closes
  }
  check('a viewer\'s vm:windows stream played through the relay, every frame acked', fr.length > 30 && fr.some((f) => f.key), JSON.stringify(numbers.viewer))

  // 8. his Take over: a fresh Notepad in front, a drive stream, a line typed, Hand back
  await guest.admin("Get-Process msedge, notepad -ErrorAction SilentlyContinue | Stop-Process -Force").catch(() => '')
  await sleep(2000)
  await guest.onDesktop(['powershell.exe', '-NoProfile', '-WindowStyle', 'Hidden', '-Command', 'Start-Process notepad -WindowStyle Maximized'], false)
  await sleep(8000)
  const takeAt = Date.now()
  const took = await client.call('computer.drive', { computer: 'vm:windows', driver: 'owner' }).then(
    () => null,
    (e) => (e as Error).message
  )
  check('Take over: computer.drive { vm:windows, owner }', took === null, took ?? '')
  const driver = new Viewer(client, inst.remotePort, true)
  const dOpened = await driver.open()
  check('a drive stream opens while he drives', dOpened.ok, dOpened.ok ? `${dOpened.width}×${dOpened.height}` : dOpened.reason)
  await until(15_000, () => driver.generation > 0, 100)
  numbers.takeOverFirstFrameMs = driver.frames[0] ? driver.frames[0].at - takeAt : null
  driver.input({ type: 'pointerMove', x: 0.5, y: 0.5 })
  driver.input({ type: 'buttonDown', button: 1, x: 0.5, y: 0.5 })
  driver.input({ type: 'buttonUp', button: 1, x: 0.5, y: 0.5 })
  await sleep(400)
  await driver.type(HIS_LINE)
  await sleep(1500)
  await shot('frame-take-over.png')
  const read = await readNotepad().catch((e) => ({ edits: '?', text: String(e) }))
  check('his keys typed a line into Notepad through the drive stream', read.text.includes(HIS_LINE), `edits ${read.edits}: ${read.text.slice(0, 200)}`)
  await driver.close()
  const back = await client.call('computer.drive', { computer: 'vm:windows', driver: 'agent' }).then(
    () => null,
    (e) => (e as Error).message
  )
  check('Hand back: computer.drive { vm:windows, agent }', back === null, back ?? '')
  client.close()
}

async function cleanup(): Promise<void> {
  log('cleanup')
  if (sessionId) {
    await inst.call('session.interrupt', { sessionId }).catch(() => null)
    const m = await metaOf(sessionId).catch(() => undefined)
    note(`the thread is ${m?.status ?? 'gone'} after the stop`)
  }
  if (firewallNarrowed && machine.running()) {
    const r = await guest.admin(`Set-NetFirewallRule -Name 'tc-block-host-tcp' -RemotePort Any; (Get-NetFirewallRule -Name 'tc-block-host-tcp' | Get-NetFirewallPortFilter).RemotePort`).catch((e) => String(e))
    check('the firewall rule is back as it was (RemotePort Any)', r.trim() === 'Any', r.trim().slice(0, 200))
  }
  if (mine && machine.running()) {
    // the keeper's own sleep: QEMU exits, its window's display ends, the TPM is kept
    const slept = await inst.call<{ state: string }>('work.winvm.sleep', {}, 300_000).catch((e) => ({ state: `error ${(e as Error).message}` }))
    log(`keeper sleep: ${slept.state}`)
    if (machine.running()) {
      await guest.admin('shutdown /s /f /t 0').catch(() => '')
      if (!(await machine.stopped(180_000))) await machine.forceStop()
    }
  }
  if (sessionId) await inst.call('session.delete', { sessionId }).catch(() => null)
  inst.kill()
  await sleep(2000)
  inst.kill()
  if (mine) {
    await machine.forceStop().catch(() => {}) // only the TPM daemon, if QEMU has gone
    rmSync(machine.c.dir, { recursive: true, force: true })
    rmSync(machine.c.tpmDir, { recursive: true, force: true })
  }
  server.stop(true)
  if (process.env.E2E_KEEP !== '1') rmSync(inst.root, { recursive: true, force: true })
  const left = inst.pids()
  check('nothing of the run is left running', left.length === 0 && !machine.running(), left.length ? `pids ${left.join(' ')}` : machine.running() ? 'QEMU runs' : '')
  if (mine) check('the standing machine is stopped and its folder and TPM state deleted', !existsSync(machine.c.dir) && !existsSync(machine.c.tpmDir))
}

let error: unknown = null
try {
  await main()
} catch (e) {
  error = e
  check('the job ran to its end', false, e instanceof Error ? (e.stack ?? e.message) : String(e))
  log(inst.tail(3000))
}
try {
  await cleanup()
} catch (e) {
  check('cleanup ran', false, e instanceof Error ? e.message : String(e))
}
const summary = failures ? `${failures} FAILED` : 'ALL PASS'
numbers.totalSeconds = Math.round((Date.now() - t0) / 1000)
writeFileSync(join(OUT, 'numbers.json'), JSON.stringify(numbers, null, 2) + '\n')
writeFileSync(
  join(OUT, 'results.md'),
  [`# B10: the whole job on the Windows VM`, '', `Run ${new Date(t0).toISOString()}, ${numbers.totalSeconds} s, \`scripts/e2e-winvm-work.ts\`. ${summary}.`, '', ...results.map((r) => `- ${r}`), '', '```json', JSON.stringify(numbers, null, 2), '```', ''].join('\n')
)
log(summary)
process.exit(failures || error ? 1 : 0)
