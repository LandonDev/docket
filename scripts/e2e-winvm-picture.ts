/**
 * The Windows VM's picture measured on the standing instance (docs/agents/live-video.md "The Windows VM"):
 * the keeper's own machine code (StandingMachine with its VmScreen) boots a fresh standing disk with QEMU's
 * window on the VM's display, and a viewer of `video.open { computer: 'vm:windows' }` counts the frames that
 * reach it through the app's relay, acking each as a viewer that draws at once would. Two scenes: a maximized
 * window redrawn every 10 ms, and a window dragged in a circle by QMP's absolute pointer (~110 moves a second);
 * then a still desktop. Sizes interleaved, one cold boot each (A, B, A, B), the engine pinned to its own cores,
 * the load average beside every run (MASTER-NOTES "Measuring on a busy box").
 *
 *   flock -o -n /srv/agents/win-vm/standing.lock bun scripts/e2e-winvm-picture.ts [--sizes 1280x800,1920x1200] [--boots 4] [--runs 3] [--secs 10]
 *
 * It refuses a standing machine that already has a disk (another thread's), and deletes the disk it made.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { loadavg, tmpdir } from 'node:os'
import { PNG } from 'pngjs'
import { join } from 'node:path'
import { LOCAL_PRINCIPAL } from '../src/shared/capabilities'
import type { WinvmState } from '../src/shared/contract-work-winvm'
import { encodeAck, parseFrame } from '../src/shared/video/nsl1'
import type { StreamClaim } from '../src/main/server/remote/auth'
import { VideoRelay, type ViewerSocket } from '../src/main/server/video/relay'
import { VideoRpc } from '../src/main/server/video/rpc'
import { psQuote } from '../src/main/server/work/winvm/machine/guest'
import { Qmp } from '../src/main/server/work/winvm/machine/qmp'
import { VM_COMPUTER, VmPicture } from '../src/main/server/work/winvm/picture'
import { SshGuest } from '../src/main/server/work/winvm/sshGuest'
import { StandingMachine } from '../src/main/server/work/winvm/standing'
import { pictureToolsAt, VmScreen } from '../src/main/server/work/winvm/window'

const arg = (name: string, d: string): string => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1]! : d
}
const SIZES = arg('sizes', '1280x800,1920x1200').split(',').map((s) => s.split('x').map(Number) as [number, number])
const BOOTS = Number(arg('boots', String(SIZES.length * 2)))
const RUNS = Number(arg('runs', '3'))
const SECS = Number(arg('secs', '10'))
const ENGINE_CORES = arg('engine-cores', '24-27')
const DATA = arg('data', process.env.TEMP_CODE_USER_DATA ?? '/srv/agents/temp-code-data')
const OUT = arg('out', '/tmp/winvm-picture/measure')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const log = (m: string) => console.log(`[winvm-picture ${new Date().toISOString().slice(11, 19)}] ${m}`)
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2
}

class Viewer implements ViewerSocket {
  bufferedAmount = 0
  frames: { at: number; bytes: number; key: boolean }[] = []
  private say: ((data: Buffer, isBinary: boolean) => void) | null = null
  send(bytes: Uint8Array): void {
    const f = parseFrame(bytes)
    this.frames.push({ at: Date.now(), bytes: bytes.byteLength, key: f.keyframe })
    this.say?.(Buffer.from(encodeAck(f.generation, f.sequence, 0)), true)
  }
  close(): void {}
  on(event: 'message' | 'close', fn: never): void {
    if (event === 'message') this.say = fn
  }
}

/** A window of our own on tcuser's desktop: `redraw` maximized and repainted every 10 ms, `drag` a still one at a known place, DPI aware so its place is in the screen's pixels. */
function scene(kind: 'redraw' | 'drag', w: number, h: number): string {
  const common = [
    'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
    `Add-Type -Namespace TcPic -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint p);'`,
    '[void][TcPic.U]::SetProcessDPIAware()',
    '[void][TcPic.U]::timeBeginPeriod(1)',
    '$f = New-Object System.Windows.Forms.Form'
  ]
  if (kind === 'drag')
    return [
      ...common,
      "$f.Text = 'tc drag'",
      "$f.StartPosition = 'Manual'",
      `$f.Location = New-Object System.Drawing.Point(${Math.round(w * 0.25)}, ${Math.round(h * 0.25)})`,
      `$f.Size = New-Object System.Drawing.Size(${Math.round(w * 0.5)}, ${Math.round(h * 0.5)})`,
      '$f.BackColor = [System.Drawing.Color]::Magenta',
      '$f.TopMost = $true',
      '[System.Windows.Forms.Application]::Run($f)'
    ].join('\n')
  return [
    ...common,
    "$f.Text = 'tc redraw'",
    "$f.WindowState = 'Maximized'",
    '[System.Windows.Forms.Control].GetProperty(\'DoubleBuffered\', [Reflection.BindingFlags]\'NonPublic,Instance\').SetValue($f, $true, $null)',
    "$font = New-Object System.Drawing.Font('Segoe UI', 40)",
    '$script:n = 0',
    '$f.Add_Paint({ param($s, $e)',
    '  $W = $f.ClientSize.Width; $H = $f.ClientSize.Height',
    '  $e.Graphics.Clear([System.Drawing.Color]::FromArgb(255, ($script:n * 7) % 256, ($script:n * 3) % 256, 200))',
    '  $e.Graphics.FillRectangle([System.Drawing.Brushes]::SteelBlue, ($script:n * 13) % ($W - 80), 0, 80, $H)',
    '  for ($i = 0; $i -lt 12; $i++) { $e.Graphics.DrawString("frame $($script:n) row $i", $font, [System.Drawing.Brushes]::Black, (($script:n * 5 + $i * 90) % $W), $i * 60) } })',
    '$t = New-Object System.Windows.Forms.Timer',
    '$t.Interval = 10',
    '$t.Add_Tick({ $script:n++; $f.Invalidate() })',
    '$t.Start()',
    '[System.Windows.Forms.Application]::Run($f)'
  ].join('\n')
}

async function startScene(guest: SshGuest, kind: 'redraw' | 'drag', w: number, h: number): Promise<void> {
  const file = `C:\\Users\\Public\\tc-${kind}.ps1`
  await guest.admin(`[IO.File]::WriteAllText(${psQuote(file)}, ${psQuote(scene(kind, w, h))})`)
  await guest.onDesktop(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', file], false)
  await sleep(6000)
}

async function endScenes(guest: SshGuest): Promise<void> {
  await guest.admin(`Get-Process powershell -IncludeUserName -ErrorAction SilentlyContinue | Where-Object UserName -like '*\\tcuser' | Stop-Process -Force`).catch(() => '')
  await sleep(1500)
}

/** Drags the scene window's title bar round a circle with QMP's absolute pointer, until `until`. */
async function drag(qmpSock: string, w: number, h: number, grab: { x: number; y: number }, until: number): Promise<number> {
  const q = await Qmp.open(qmpSock)
  const abs = (x: number, y: number) => [
    { type: 'abs', data: { axis: 'x', value: Math.round((x / w) * 32767) } },
    { type: 'abs', data: { axis: 'y', value: Math.round((y / h) * 32767) } }
  ]
  const ev = (events: unknown[]) => q.run({ execute: 'input-send-event', arguments: { events } })
  let n = 0
  try {
    await ev(abs(grab.x, grab.y))
    await sleep(150)
    await ev([{ type: 'btn', data: { down: true, button: 'left' } }])
    await sleep(150)
    const t0 = Date.now()
    while (Date.now() < until) {
      const a = (Date.now() - t0) / 600
      await ev(abs(grab.x + w * 0.15 * Math.cos(a) - w * 0.15, grab.y + h * 0.15 * Math.sin(a)))
      n++
      await sleep(8)
    }
    // the window goes back where it was, so the next run grabs its title bar again
    await ev(abs(grab.x, grab.y))
    await sleep(100)
    await ev([{ type: 'btn', data: { down: false, button: 'left' } }])
  } finally {
    q.destroy()
  }
  return n
}

/** The scene window's title bar, from QMP's picture: just above the box of its magenta client area (a colour no wallpaper has), at its middle. */
async function titleBar(qmpSock: string, file: string): Promise<{ x: number; y: number }> {
  const q = await Qmp.open(qmpSock)
  try {
    await q.run({ execute: 'screendump', arguments: { filename: file, format: 'png' } })
  } finally {
    q.destroy()
  }
  const png = PNG.sync.read(readFileSync(file))
  let [x0, y0, x1] = [Infinity, Infinity, -1]
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4
      if (png.data[i]! > 250 && png.data[i + 1]! < 5 && png.data[i + 2]! > 250) {
        if (y < y0) y0 = y
        if (x < x0) x0 = x
        if (x > x1) x1 = x
      }
    }
  if (!Number.isFinite(y0)) throw new Error('the scene window is not on the screen')
  return { x: Math.round((x0 + x1) / 2), y: y0 - Math.round(png.height / 80) }
}

/** relay-engine processes started by this process: pinned to their own cores. */
function pinEngines(): number[] {
  const pids: number[] = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
      const comm = /\((.*)\)/.exec(stat)?.[1]
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      if (comm === 'relay-engine' && ppid === process.pid) pids.push(Number(name))
    } catch {
      // gone
    }
  }
  for (const pid of pids) execFileSync('taskset', ['-a', '-p', '-c', ENGINE_CORES, String(pid)], { stdio: 'ignore' })
  return pids
}

const cpuTicks = (pid: number): number => {
  try {
    const f = readFileSync(`/proc/${pid}/stat`, 'utf8').slice(readFileSync(`/proc/${pid}/stat`, 'utf8').lastIndexOf(')') + 2).split(' ')
    return Number(f[11]) + Number(f[12])
  } catch {
    return 0
  }
}

interface Row {
  size: string
  boot: number
  scene: string
  run: number
  fps: number
  gapP50: number
  gapP95: number
  mbit: number
  engineCores: number
  qemuCores: number
  load: number
  extra?: string
}

async function measure(picture: VmPicture, rpc: VideoRpc, relay: VideoRelay, minted: StreamClaim[], secs: number, during?: (until: number) => Promise<unknown>, qemuPid?: number | null) {
  const answer = await rpc.open({ threadId: 'measure', computer: VM_COMPUTER, maxEdge: 3840 }, { principal: LOCAL_PRINCIPAL, connection: {}, connectionId: '1' })
  if (!answer.ok) throw new Error(`video.open refused: ${answer.reason}`)
  const viewer = new Viewer()
  if (!relay.attach(minted.at(-1)!, viewer)) throw new Error('the viewer did not join')
  await sleep(300)
  const engines = pinEngines()
  // a second to settle: the first keyframe and the engine's start
  await sleep(1000)
  const start = Date.now()
  const end = start + secs * 1000
  const e0 = engines.reduce((s, p) => s + cpuTicks(p), 0)
  const q0 = qemuPid ? cpuTicks(qemuPid) : 0
  const extra = during ? await during(end) : await sleep(end - Date.now())
  if (Date.now() < end) await sleep(end - Date.now())
  const e1 = engines.reduce((s, p) => s + cpuTicks(p), 0)
  const q1 = qemuPid ? cpuTicks(qemuPid) : 0
  const frames = viewer.frames.filter((f) => f.at >= start && f.at < end)
  const gaps = frames.slice(1).map((f, i) => f.at - frames[i]!.at).sort((a, b) => a - b)
  const pct = (p: number) => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))]! : 0)
  relay.endWhere((s) => s.tag === VM_COMPUTER, 'ended')
  await sleep(300)
  const tick = 100 * secs
  return {
    fps: frames.length / secs,
    gapP50: pct(0.5),
    gapP95: pct(0.95),
    mbit: (frames.reduce((s, f) => s + f.bytes, 0) * 8) / secs / 1e6,
    engineCores: (e1 - e0) / tick,
    qemuCores: (q1 - q0) / tick,
    extra
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  const tools = pictureToolsAt(DATA)
  if (tools.missing !== null) throw new Error(`${tools.missing} is not installed under ${DATA}`)
  const probe = new StandingMachine('standing')
  if (probe.cannot()) throw new Error(probe.cannot()!)
  if (probe.hasDisk() || probe.running()) throw new Error('the standing machine has a disk already: another thread is using it')
  const root = mkdtempSync(join(tmpdir(), 'tc-winvm-measure-'))
  symlinkSync(join(DATA, 'work-tools'), join(root, 'work-tools'))
  const rows: Row[] = []
  let size: [number, number] = SIZES[0]!
  const screen = new VmScreen({ root: join(root, 'winvm', 'picture'), tools: () => pictureToolsAt(root), size: () => ({ width: size[0], height: size[1] }), log })
  const machine = new StandingMachine('standing', process.env, screen, log)
  const guest = new SshGuest(machine.c, machine.p)
  const relay = new VideoRelay()
  const minted: StreamClaim[] = []
  const rpc = new VideoRpc(relay, { mintStreamTicket: (c) => (minted.push(c), { ticket: 't', expiresIn: 30 }) }, () => true)
  const state: WinvmState = { state: 'awake', step: null, error: null, cannot: null, sleepAfter: '30m', since: Date.now() }
  const picture = new VmPicture({ state: () => state, onState: () => () => {}, setViewers: () => {}, screen, relay, screenshot: async () => Buffer.alloc(0), jpeg: async () => ({ data: '', width: 1, height: 1 }) })
  rpc.addSource(picture)
  try {
    log('making a fresh standing disk')
    await machine.makeDisk()
    for (let boot = 0; boot < BOOTS; boot++) {
      size = SIZES[boot % SIZES.length]!
      const [w, h] = size
      const label = `${w}x${h}`
      const t0 = Date.now()
      await machine.start()
      await guest.ready(300_000)
      log(`boot ${boot + 1}: ${label}, desktop in ${((Date.now() - t0) / 1000).toFixed(1)} s, window ${JSON.stringify(screen.size)}`)
      if (!screen.env) throw new Error(`no window: ${screen.missing}`)
      const shot = join(OUT, `boot${boot + 1}-${label}.png`)
      const q = await Qmp.open(machine.p.qmp)
      await q.run({ execute: 'screendump', arguments: { filename: shot, format: 'png' } })
      q.destroy()
      const png = readFileSync(shot)
      const guestSize = `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`
      log(`the guest draws ${guestSize}`)
      await sleep(20_000) // a fresh boot's own work settles
      const qemu = machine.pid()
      // the still desktop first
      const idle = await measure(picture, rpc, relay, minted, 5, undefined, qemu)
      rows.push({ size: label, boot: boot + 1, scene: 'still desktop', run: 1, ...idle, load: loadavg()[0]!, extra: guestSize })
      log(`still desktop: ${idle.fps.toFixed(1)} fps`)
      for (const kind of ['drag', 'redraw'] as const) {
        await startScene(guest, kind, w, h)
        // where the window really is: Windows scales a large screen (150% at 1920×1200), so it is found in QMP's picture
        const grab = kind === 'drag' ? await titleBar(machine.p.qmp, join(OUT, `drag-${label}-boot${boot + 1}.png`)) : null
        if (grab) log(`the window's title bar is at ${grab.x},${grab.y}`)
        for (let run = 1; run <= RUNS; run++) {
          const r = await measure(picture, rpc, relay, minted, SECS, kind === 'drag' ? (until) => drag(machine.p.qmp, w, h, grab!, until) : undefined, qemu)
          const row: Row = { size: label, boot: boot + 1, scene: kind, run, ...r, load: loadavg()[0]!, extra: r.extra === undefined ? undefined : `moves ${r.extra}` }
          rows.push(row)
          log(`${label} ${kind} run ${run}: ${r.fps.toFixed(1)} fps, gap p50 ${r.gapP50} p95 ${r.gapP95} ms, ${r.mbit.toFixed(1)} Mbit/s, engine ${r.engineCores.toFixed(2)} QEMU ${r.qemuCores.toFixed(2)} cores, load ${row.load.toFixed(1)}`)
          await sleep(1000)
        }
        if (grab) {
          // the window really moves under the drag: dragged a tenth of the screen and let go, it is found there
          const q = await Qmp.open(machine.p.qmp)
          const abs = (x: number, y: number) => [
            { type: 'abs', data: { axis: 'x', value: Math.round((x / w) * 32767) } },
            { type: 'abs', data: { axis: 'y', value: Math.round((y / h) * 32767) } }
          ]
          const ev = (events: unknown[]) => q.run({ execute: 'input-send-event', arguments: { events } })
          await ev(abs(grab.x, grab.y))
          await sleep(150)
          await ev([{ type: 'btn', data: { down: true, button: 'left' } }])
          for (let i = 1; i <= 20; i++) {
            await ev(abs(grab.x - (w * 0.1 * i) / 20, grab.y + (h * 0.1 * i) / 20))
            await sleep(16)
          }
          await ev([{ type: 'btn', data: { down: false, button: 'left' } }])
          q.destroy()
          await sleep(500)
          const after = await titleBar(machine.p.qmp, join(OUT, `drag-moved-${label}-boot${boot + 1}.png`))
          const moved = `${after.x - grab.x},${after.y - grab.y}`
          log(`the window moved by ${moved} (asked ${-Math.round(w * 0.1)},${Math.round(h * 0.1)})`)
          rows.push({ size: label, boot: boot + 1, scene: 'drag check', run: 1, fps: 0, gapP50: 0, gapP95: 0, mbit: 0, engineCores: 0, qemuCores: 0, load: loadavg()[0]!, extra: moved })
        }
        await endScenes(guest)
      }
      writeFileSync(join(OUT, 'rows.json'), JSON.stringify(rows, null, 1))
      log('shutting Windows down')
      await guest.admin('shutdown /s /t 0').catch(() => '')
      if (!(await machine.stopped(120_000))) await machine.forceStop()
      await machine.keepTpm().catch(() => {})
    }
  } finally {
    await machine.forceStop().catch(() => {})
    await screen.down()
    picture.close()
    rmSync(machine.c.dir, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
    log(`removed the standing disk (${machine.c.dir})`)
  }
  writeFileSync(join(OUT, 'rows.json'), JSON.stringify(rows, null, 1))
  for (const sz of SIZES.map(([w, h]) => `${w}x${h}`))
    for (const sc of ['drag', 'redraw', 'still desktop']) {
      const xs = rows.filter((r) => r.size === sz && r.scene === sc)
      if (!xs.length) continue
      const f = xs.map((r) => r.fps)
      console.log(`${sz} ${sc}: median ${median(f).toFixed(1)} fps (${Math.min(...f).toFixed(1)} to ${Math.max(...f).toFixed(1)}, ${xs.length} runs), ${median(xs.map((r) => r.mbit)).toFixed(1)} Mbit/s, engine ${median(xs.map((r) => r.engineCores)).toFixed(2)} QEMU ${median(xs.map((r) => r.qemuCores)).toFixed(2)} cores, load ${Math.min(...xs.map((r) => r.load)).toFixed(0)} to ${Math.max(...xs.map((r) => r.load)).toFixed(0)}`)
    }
  if (!existsSync(OUT)) return
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  }
)
