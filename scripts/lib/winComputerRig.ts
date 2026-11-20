/**
 * tc-computer.exe in the Windows rig, for the proofs (docs/computer-protocol.md
 * §29.6): the exe copied in and started on tcuser's desktop by the Task
 * Scheduler (run-in-session.sh) listening on a guest loopback port, an SSH
 * tunnel that carries that port to the box, what the desktop says (the
 * pointer and the front window), and QMP's screenshot and keys, which reach
 * the guest as the person's own input would.
 *
 * Live video's bytes pipe (§30) is a named pipe on the service's own machine,
 * and the host here is on the box. `startVideoService` starts `tc-computer
 * pipe-relay` beside the service: it makes the pipe the service dials and
 * carries it to a guest loopback port, which a second tunnel brings to the
 * box; `rigSpawn` joins that port to the host's own pipe, so the host's
 * ComputerConnection reads and writes records as on a Windows host.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { inflateSync } from 'node:zlib'
import { EventEmitter } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { connect, type Socket } from 'node:net'
import { basename, join, resolve, win32 } from 'node:path'
import { PassThrough } from 'node:stream'
import { qmp, screendump, sendKey } from '../../src/main/server/work/winvm/machine/qmp'
import { STANDARD_USER, rigConfig, rigPaths } from '../../src/main/server/work/winvm/machine/config'

export const repo = resolve(import.meta.dirname, '..', '..')
export const EXE = join(repo, 'native/tc-computer-win/target/x86_64-pc-windows-msvc/release/tc-computer.exe')
const rig = rigConfig()
const paths = rigPaths(rig)

export const vm = (cmd: string, ...args: string[]) => spawnSync(join(repo, 'scripts/win-vm', `${cmd}.sh`), args, { encoding: 'utf8', timeout: 180_000 })
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A PowerShell script run on tcuser's desktop, its stdout. */
export function inSession(ps: string, timeoutS = 60): string {
  // progress records would come out on stdout as CLIXML
  const encoded = Buffer.from(`$ProgressPreference = 'SilentlyContinue'\n${ps}`, 'utf16le').toString('base64')
  const r = vm('run-in-session', '--wait', '--timeout', String(timeoutS), 'powershell.exe', '-NoProfile', '-EncodedCommand', encoded)
  return r.stdout
}

/** What tcuser's desktop says: the pointer and the front window's title. Read by a PowerShell on the desktop, whose
 * console window takes the front while it runs: give the desktop 2.5 s to settle after it. */
export function desktopState(): { cursor: string; front: string } {
  for (let attempt = 0; attempt < 3; attempt++) {
    const read = probeDesktop()
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500)
    if (read.cursor !== '?') return read
  }
  return { cursor: '?', front: '?' }
}

function probeDesktop(): { cursor: string; front: string } {
  const out = inSession(
    [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type @"',
      'using System; using System.Runtime.InteropServices; using System.Text;',
      'public static class Fg { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
      '[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n); }',
      '"@',
      '$sb = New-Object System.Text.StringBuilder 512',
      '[void][Fg]::GetWindowText([Fg]::GetForegroundWindow(), $sb, 512)',
      '$p = [System.Windows.Forms.Cursor]::Position',
      'Write-Output ("cursor=" + $p.X + "," + $p.Y)',
      'Write-Output ("front=" + $sb.ToString())'
    ].join('\n')
  )
  return { cursor: /cursor=(\S+)/.exec(out)?.[1] ?? '?', front: /front=(.*)/.exec(out)?.[1]?.trim() ?? '?' }
}

/** The clipboard's text on tcuser's desktop, or sets it. */
export const getClipboard = (): string => inSession('Get-Clipboard -Raw').trim()
export const setClipboard = (text: string): void => void inSession(`Set-Clipboard -Value '${text.replace(/'/g, "''")}'`)

/** The whole guest screen as QEMU draws it (PNG), whatever the guest is doing. */
export const qmpShot = (file: string): Promise<unknown> => qmp(paths.qmp, screendump(file))
/** Keys pressed as hardware: the guest sees the person's own input. */
export const qmpKeys = (...keys: string[]): Promise<unknown> => qmp(paths.qmp, sendKey(...keys))

/** Copies the exe in, ends any old service, starts `serve --listen` on tcuser's desktop. */
export async function startService(guestPort: number): Promise<boolean> {
  if (vm('scp', EXE, 'guest:tc-computer.exe').status !== 0) return false
  vm('ssh', '--ps', 'Stop-Process -Name tc-computer -Force -ErrorAction SilentlyContinue')
  vm('ssh', '--ps', `Set-Content -Encoding ascii -Path "$env:USERPROFILE\\tc-serve.cmd" -Value "@echo off\`r\`nset TC_COMPUTER_PROOF=1\`r\`n""%USERPROFILE%\\tc-computer.exe"" serve --listen 127.0.0.1:${guestPort} 2> ""%USERPROFILE%\\tc-computer.log""\`r\`n"`)
  const ok = vm('run-in-session', '%USERPROFILE%\\tc-serve.cmd').status === 0
  await sleep(2000)
  return ok
}

/** The named pipe the rig's service dials for video, made by the relay. */
export const PROOF_VIDEO_PIPE = '\\\\.\\pipe\\tc-proof-video'

/**
 * As `startService`, with live video: `pipe-relay` makes PROOF_VIDEO_PIPE and listens on `relayPort`, then the
 * service starts told that pipe and `token` (the variables the host would set), so it dials the relay before it
 * answers initialize. The relay's log is `%USERPROFILE%\tc-relay.log`.
 */
export async function startVideoService(guestPort: number, relayPort: number, token: string): Promise<boolean> {
  if (vm('scp', EXE, 'guest:tc-computer.exe').status !== 0) return false
  vm('ssh', '--ps', 'Stop-Process -Name tc-computer -Force -ErrorAction SilentlyContinue')
  const exe = '"%USERPROFILE%\\tc-computer.exe"'
  const cmd = [
    '@echo off',
    'set TC_COMPUTER_PROOF=1',
    `start "" /b cmd /c "${exe} pipe-relay ${PROOF_VIDEO_PIPE} --listen 127.0.0.1:${relayPort} 2> "%USERPROFILE%\\tc-relay.log""`,
    `set TC_COMPUTER_VIDEO_PIPE=${PROOF_VIDEO_PIPE}`,
    `set TC_COMPUTER_VIDEO_TOKEN=${token}`,
    `${exe} serve --listen 127.0.0.1:${guestPort} 2> "%USERPROFILE%\\tc-computer.log"`,
    ''
  ].join('\r\n')
  const local = join(tmpdir(), `tc-serve-video-${process.pid}.cmd`)
  writeFileSync(local, cmd)
  if (vm('scp', local, 'guest:tc-serve-video.cmd').status !== 0) return false
  const ok = vm('run-in-session', '%USERPROFILE%\\tc-serve-video.cmd').status === 0
  await sleep(2000)
  return ok
}

/** An SSH forward of the guest's loopback port to the box's. */
export async function tunnel(localPort: number, guestPort: number): Promise<ChildProcess> {
  const t = spawn(
    'ssh',
    [
      '-N', '-L', `${localPort}:127.0.0.1:${guestPort}`,
      '-i', paths.key, '-p', String(rig.sshPort),
      '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
      '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${paths.knownHosts}`,
      `${STANDARD_USER}@127.0.0.1`
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] }
  )
  await sleep(2500)
  return t
}

export const socketTo = (port: number): Promise<Socket> =>
  new Promise((ok, no) => {
    const s = connect(port, '127.0.0.1', () => ok(s))
    s.once('error', no)
  })

/**
 * A `spawn` for the host's ComputerService whose child is the rig's service over the tunnel. The host's
 * data dir is a box path: `initialize` carries `guestDataDir` in its place, and every shot the service
 * writes there is copied to the same place under the box's dir, its path rewritten, before the frame
 * reaches the host, as if the service had written it on this machine.
 */
export function rigSpawn(port: number, guestDataDir: string, hostDataDir: string, video?: { port: number; token: string }) {
  return ((_bin: string, _args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; pid: number; exitCode: number | null; signalCode: null; kill(): boolean }
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = process.pid
    child.exitCode = null
    child.signalCode = null
    let sock: Socket | null = null
    const ready = socketTo(port).then((s) => (sock = s))
    let queue: Promise<void> = Promise.resolve()
    let inBuf = ''
    child.stdin.on('data', (b: Buffer) => {
      inBuf += b.toString()
      let nl: number
      while ((nl = inBuf.indexOf('\n')) >= 0) {
        const line = inBuf.slice(0, nl)
        inBuf = inBuf.slice(nl + 1)
        const f = JSON.parse(line) as { method?: string; params?: { dataDir?: string } }
        if (f.method === 'initialize' && f.params) f.params.dataDir = guestDataDir
        void ready.then((s) => s.write(JSON.stringify(f) + '\n'))
      }
    })
    let outBuf = ''
    void ready.then((s) => {
      s.on('data', (b: Buffer) => {
        outBuf += b.toString()
        let nl: number
        while ((nl = outBuf.indexOf('\n')) >= 0) {
          const line = outBuf.slice(0, nl)
          outBuf = outBuf.slice(nl + 1)
          queue = queue.then(() => {
            child.stdout.write(fetchShots(line, guestDataDir, hostDataDir) + '\n')
          })
        }
      })
      s.on('close', () => {
        child.exitCode = 0
        child.stdout.end()
        setImmediate(() => child.emit('exit', 0, null))
      })
    })
    const piped = video ? joinVideoPipe(video, opts?.env ?? {}) : null
    child.kill = () => {
      sock?.destroy()
      piped?.()
      return true
    }
    // the connection starts once its child says it spawned
    void ready.then(() => child.emit('spawn'), (e: Error) => child.emit('error', e))
    return child
  }) as unknown as typeof spawn
}

/**
 * The host's named pipe (its name and token in the env the connection spawned with) joined to the relay's tunnel:
 * what comes from the relay is the service's token, checked and dropped, then its records; the host gets its own
 * token, then those records, and its acks go back the other way. Returns a close.
 */
function joinVideoPipe(video: { port: number; token: string }, env: NodeJS.ProcessEnv): () => void {
  const name = env.TC_COMPUTER_VIDEO_PIPE
  const token = env.TC_COMPUTER_VIDEO_TOKEN
  if (!name || !token) return () => undefined
  const host = connect(name)
  const relay = connect(video.port, '127.0.0.1')
  host.on('error', () => relay.destroy())
  relay.on('error', () => host.destroy())
  host.once('connect', () => host.write(token))
  let head: Buffer = Buffer.alloc(0)
  let through = false
  relay.on('data', (b: Buffer) => {
    if (through) return void host.write(b)
    head = Buffer.concat([head, b])
    if (head.length < video.token.length) return
    if (head.subarray(0, video.token.length).toString('latin1') !== video.token) return void relay.destroy(new Error('the service said another token'))
    through = true
    if (head.length > video.token.length) host.write(head.subarray(video.token.length))
  })
  host.on('data', (b: Buffer) => relay.write(b))
  host.on('close', () => relay.destroy())
  relay.on('close', () => host.destroy())
  return () => {
    host.destroy()
    relay.destroy()
  }
}

/** Every `"path":"<guest data dir>\…"` in a frame copied to the box and rewritten to the box's copy. */
function fetchShots(line: string, guestDir: string, hostDir: string): string {
  if (!line.includes('"path"')) return line
  const f = JSON.parse(line) as unknown
  const walk = (v: unknown): void => {
    if (!v || typeof v !== 'object') return
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'path' && typeof x === 'string' && x.toLowerCase().startsWith(guestDir.toLowerCase())) {
        const rel = win32.relative(guestDir, x).split('\\')
        const local = join(hostDir, ...rel)
        mkdirSync(join(local, '..'), { recursive: true })
        const guestRel = `guest:${x.replace(/^C:\\Users\\tcuser\\/i, '').replace(/\\/g, '/')}`
        vm('scp', guestRel, local)
        ;(v as Record<string, unknown>)[k] = local
      } else walk(x)
    }
  }
  walk(f)
  return JSON.stringify(f)
}

export const shotName = (p: string): string => basename(p)

/** An 8-bit RGB or RGBA PNG, not interlaced (QEMU's screendump and WIC's both are), as RGB rows. */
export function readPng(bytes: Buffer): { width: number; height: number; rgb: Uint8Array } {
  let at = 8
  let width = 0
  let height = 0
  let channels = 3
  const idat: Buffer[] = []
  while (at < bytes.length) {
    const len = bytes.readUInt32BE(at)
    const type = bytes.toString('latin1', at + 4, at + 8)
    const data = bytes.subarray(at + 8, at + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8 || data[12] !== 0 || (data[9] !== 2 && data[9] !== 6)) throw new Error(`a PNG this reader does not take (depth ${data[8]}, colour ${data[9]}, interlace ${data[12]})`)
      channels = data[9] === 6 ? 4 : 3
    } else if (type === 'IDAT') idat.push(data)
    at += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = new Uint8Array(width * height * 3)
  let prev = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = new Uint8Array(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      const p = a + b - c
      const pred = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? (Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c) : 0
      line[i] = (line[i] + pred) & 255
    }
    for (let x = 0; x < width; x++) for (let k = 0; k < 3; k++) out[(y * width + x) * 3 + k] = line[x * channels + k]
    prev = line
  }
  return { width, height, rgb: out }
}

/**
 * How far a window's shot is from the same place on the screen: the mean difference per channel, and the
 * share of pixels off by more than 32 in any channel (a caret's blink, a cursor). The shot must be at scale 1.
 */
export function compareToScreen(shot: ReturnType<typeof readPng>, screen: ReturnType<typeof readPng>, at: { x: number; y: number }): { mean: number; off: number } {
  let sum = 0
  let off = 0
  let n = 0
  for (let y = 0; y < shot.height; y++) {
    const sy = y + at.y
    if (sy < 0 || sy >= screen.height) continue
    for (let x = 0; x < shot.width; x++) {
      const sx = x + at.x
      if (sx < 0 || sx >= screen.width) continue
      let worst = 0
      for (let k = 0; k < 3; k++) {
        const d = Math.abs(shot.rgb[(y * shot.width + x) * 3 + k] - screen.rgb[(sy * screen.width + sx) * 3 + k])
        sum += d
        worst = Math.max(worst, d)
      }
      if (worst > 32) off++
      n++
    }
  }
  return { mean: n ? sum / (n * 3) : 255, off: n ? off / n : 1 }
}
