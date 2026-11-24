#!/usr/bin/env bun
/**
 * The Windows VM's picture measured on a SCRATCH machine (docs/agents/live-video.md "The Windows VM"): the
 * standing machine's own code boots a fresh disk with QEMU's window on a display of its own, and a viewer of
 * `video.open { computer: 'vm:windows' }` records the frames that reach it through the app's relay, acking each
 * as a viewer that draws at once would. Per size, one cold boot each, turn about (A, B, A, B):
 *
 *   - the still desktop; a window dragged in a circle by QMP's pointer; a maximized window redrawn every 10 ms:
 *     frames a second, the gaps, the bit rate, the engine's and QEMU's cores;
 *   - an act timed to the frame that shows it: a pointer move after a quiet moment and after gaps of 30 ms to
 *     2 s, and a key that turns the whole screen another colour; capture to viewer per frame;
 *   - one QMP screendump's time and size.
 *
 * It records and never asserts a time: a loaded box would fail it. `--device virtio` moves the fresh disk to
 * virtio-vga first (`--driver` names the unpacked `viogpudo\w11\amd64` folder of virtio-win). It runs only on a
 * machine that is not the owner's (`scratchMachineRefusal`), and deletes the disk it made:
 *
 *   WINVM_DIR=/tmp/vm-screen-rig-a WINVM_TPM_DIR=/tmp/win-vm-tpm-vmscreen-a WINVM_SSH_PORT=22241 \
 *     taskset -c 24-31 nice -n 10 bun scripts/perf/vm-screen-bench.ts --sizes 1280x800,2560x1600 \
 *     [--device vga|virtio] [--driver <dir>] [--boots 2] [--runs 3] [--secs 10] [--out <dir>]
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { psQuote } from '../../src/main/server/work/winvm/machine/guest'
import type { DisplayDevice } from '../../src/main/server/work/winvm/machine/qemu'
import { ADAPTERS_SCRIPT, cpuTicks, GUEST_DRIVER_DIR, moveToVirtio, nowUs, otherRecords, scratchMachine, shutDown, sleep, type BenchViewer, type Scratch } from '../lib/winvmScratch'
import { actRow, coresUsed, parseSizes, quantile, rateRow, type ActRow, type RateRow } from './vmScreenRows'

const arg = (name: string, d: string): string => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1]! : d
}
const SIZES = parseSizes(arg('sizes', '1280x800,2560x1600'))
const DEVICE = arg('device', 'vga') as DisplayDevice
const DRIVER = arg('driver', '')
const BOOTS = Number(arg('boots', String(SIZES.length)))
const RUNS = Number(arg('runs', '3'))
const SECS = Number(arg('secs', '10'))
/** The bench's own cores; the product's engines take 26 to 31. */
const ENGINE_CORES = arg('engine-cores', '24-31')
const DATA = arg('data', process.env.TEMP_CODE_USER_DATA ?? '/srv/agents/temp-code-data')
const OUT = arg('out', '/tmp/vm-screen-bench')
if (DEVICE !== 'vga' && DEVICE !== 'virtio') throw new Error('--device vga or virtio')
if (DEVICE === 'virtio' && !DRIVER) throw new Error('--device virtio needs --driver <the unpacked viogpudo folder>')

const log = (m: string) => console.log(`[vm-bench ${new Date().toISOString().slice(11, 19)}] ${m}`)

interface Row extends Partial<RateRow>, Partial<ActRow> {
  device: DisplayDevice
  /** the size asked for, and the size the guest drew at */
  size: string
  guest: string
  boot: number
  scene: string
  run?: number
  engineCores?: number
  qemuCores?: number
  load: number
  note?: string
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
    "[System.Windows.Forms.Control].GetProperty('DoubleBuffered', [Reflection.BindingFlags]'NonPublic,Instance').SetValue($f, $true, $null)",
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

/** A maximized window that turns another colour at each key down: one full-screen change a key. */
function keyScene(): string {
  return [
    'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
    '$f = New-Object System.Windows.Forms.Form',
    "$f.Text = 'tc keys'",
    "$f.WindowState = 'Maximized'",
    '$f.KeyPreview = $true',
    '$f.TopMost = $true',
    '$script:n = 0',
    '$f.BackColor = [System.Drawing.Color]::FromArgb(255, 30, 30, 30)',
    '$f.Add_KeyDown({ $script:n++; if ($script:n % 2) { $f.BackColor = [System.Drawing.Color]::FromArgb(255, 235, 235, 235) } else { $f.BackColor = [System.Drawing.Color]::FromArgb(255, 30, 30, 30) } })',
    '$f.Add_Shown({ $f.Activate() })',
    '[System.Windows.Forms.Application]::Run($f)'
  ].join('\n')
}

async function startScript(s: Scratch, name: string, script: string): Promise<void> {
  const file = `C:\\Users\\Public\\tc-${name}.ps1`
  await s.guest.admin(`[IO.File]::WriteAllText(${psQuote(file)}, ${psQuote(script)})`)
  await s.guest.onDesktop(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', file], false)
  await sleep(6000)
}

async function endScenes(s: Scratch): Promise<void> {
  await s.guest.admin(`Get-Process powershell -IncludeUserName -ErrorAction SilentlyContinue | Where-Object UserName -like '*\\tcuser' | Stop-Process -Force`).catch(() => '')
  await sleep(1500)
}

/** QMP's absolute pointer and keys on one connection: straight into the guest, with no X pointer moved. */
async function hands(s: Scratch, w: number, h: number) {
  const { Qmp } = await import('../../src/main/server/work/winvm/machine/qmp')
  const q = await Qmp.open(s.machine.p.qmp)
  const ev = (events: unknown[]) => q.run({ execute: 'input-send-event', arguments: { events } })
  return {
    move: (x: number, y: number) =>
      ev([
        { type: 'abs', data: { axis: 'x', value: Math.round((x / w) * 32767) } },
        { type: 'abs', data: { axis: 'y', value: Math.round((y / h) * 32767) } }
      ]),
    button: (down: boolean) => ev([{ type: 'btn', data: { down, button: 'left' } }]),
    key: (down: boolean) => ev([{ type: 'key', data: { down, key: { type: 'qcode', data: 'a' } } }]),
    close: () => q.destroy()
  }
}
type Hands = Awaited<ReturnType<typeof hands>>

/** QMP's picture of the guest's screen, its size, and how long the dump took. */
async function dump(s: Scratch, file: string): Promise<{ ms: number; bytes: number; width: number; height: number }> {
  const t0 = performance.now()
  await s.qmp('screendump', { filename: file, format: 'png' })
  const ms = performance.now() - t0
  const png = readFileSync(file)
  return { ms, bytes: statSync(file).size, width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

/** The scene window's title bar, from QMP's picture: just above the box of its magenta client area (a colour no wallpaper has), at its middle. */
async function titleBar(s: Scratch, file: string): Promise<{ x: number; y: number }> {
  await dump(s, file)
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

/** Drags the scene window's title bar round a circle until `until`; answers the moves sent. */
async function drag(hand: Hands, w: number, h: number, grab: { x: number; y: number }, until: number): Promise<number> {
  let n = 0
  await hand.move(grab.x, grab.y)
  await sleep(150)
  await hand.button(true)
  await sleep(150)
  const t0 = Date.now()
  while (Date.now() < until) {
    const a = (Date.now() - t0) / 600
    await hand.move(grab.x + w * 0.15 * Math.cos(a) - w * 0.15, grab.y + h * 0.15 * Math.sin(a))
    n++
    await sleep(8)
  }
  // the window goes back where it was, so the next run grabs its title bar again
  await hand.move(grab.x, grab.y)
  await sleep(100)
  await hand.button(false)
  return n
}

/** One stream for `secs` seconds while `during` runs: the rate and the cores. */
async function rate(s: Scratch, secs: number, during?: (until: number) => Promise<unknown>): Promise<RateRow & { engineCores: number; qemuCores: number; note?: string }> {
  const v = await s.view(ENGINE_CORES)
  try {
    // a second to settle: the first keyframe and the engine's start
    await sleep(1000)
    const qemu = s.machine.pid()
    const [start, e0, q0] = [nowUs(), v.engines.reduce((a, p) => a + cpuTicks(p), 0), qemu ? cpuTicks(qemu) : 0]
    const until = Date.now() + secs * 1000
    const extra = during ? await during(until) : undefined
    if (Date.now() < until) await sleep(until - Date.now())
    const [end, e1, q1] = [nowUs(), v.engines.reduce((a, p) => a + cpuTicks(p), 0), qemu ? cpuTicks(qemu) : 0]
    const real = (end - start) / 1e6
    return { ...rateRow(v.viewer.frames, start, end), engineCores: coresUsed(e0, e1, real), qemuCores: coresUsed(q0, q1, real), ...(extra === undefined ? {} : { note: `moves ${extra}` }) }
  } finally {
    await v.end()
  }
}

/** One act after a quiet moment, `n` times, each timed to the frames that follow it. */
async function acts(viewer: BenchViewer, n: number, act: (i: number) => Promise<unknown>, quietMs = 400, windowMs = 450): Promise<ActRow> {
  const sent: number[] = []
  for (let i = 0; i < n; i++) {
    const waitEnd = Date.now() + 4000
    while (Date.now() < waitEnd) {
      const last = viewer.frames.at(-1)
      if (!last || nowUs() - last.us > quietMs * 1000) break
      await sleep(20)
    }
    sent.push(nowUs())
    await act(i)
    await sleep(windowMs)
  }
  return actRow(viewer.frames, sent, windowMs)
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  const s = scratchMachine({ data: DATA, size: SIZES[0]!, log })
  const rows: Row[] = []
  const save = () => writeFileSync(join(OUT, 'bench.json'), JSON.stringify({ device: DEVICE, at: new Date().toISOString(), rows }, null, 1))
  try {
    log('making a fresh scratch disk')
    await s.machine.makeDisk()
    if (DEVICE === 'virtio') {
      s.setSize([1280, 800])
      await s.machine.start()
      await s.guest.ready(300_000)
      await moveToVirtio(s, DRIVER, log)
    }
    for (let boot = 0; boot < BOOTS; boot++) {
      const [w, h] = SIZES[boot % SIZES.length]!
      const size = `${w}x${h}`
      s.setSize([w, h])
      const t0 = Date.now()
      await s.machine.start()
      await s.guest.ready(300_000)
      log(`boot ${boot + 1}: ${size} on ${DEVICE}, desktop in ${((Date.now() - t0) / 1000).toFixed(1)} s, window ${JSON.stringify(s.screen.size)}`)
      if (!s.screen.env) throw new Error(`no window: ${s.screen.missing}`)
      log(`adapters: ${(await s.guest.admin(ADAPTERS_SCRIPT)).trim().replace(/\r?\n/g, ' ; ')}`)
      let first = await dump(s, join(OUT, `boot${boot + 1}-${size}.png`))
      if (DEVICE === 'virtio' && (first.width !== w || first.height !== h)) {
        // the EDID's mode was not taken at the boot: the size is set from inside, as the door's verb will
        log(`the guest draws ${first.width}x${first.height}; asking for ${size} from inside`)
        log((await s.guest.onDesktop([`${GUEST_DRIVER_DIR}\\viogpures.exe`, String(w), String(h)], true).catch((e: Error) => e.message)).trim())
        await sleep(3000)
        first = await dump(s, join(OUT, `boot${boot + 1}-${size}.png`))
      }
      const guest = `${first.width}x${first.height}`
      log(`the guest draws ${guest}`)
      const row = (scene: string, more: Partial<Row>): Row => {
        const r: Row = { device: DEVICE, size, guest, boot: boot + 1, scene, load: loadavg()[0]!, ...more }
        rows.push(r)
        save()
        return r
      }
      await sleep(20_000) // a fresh boot's own work settles
      const dumps = [first.ms]
      for (let i = 0; i < 4; i++) dumps.push((await dump(s, join(OUT, `dump-${size}.png`))).ms)
      row('qmp screendump', { note: `ms p50 ${quantile(dumps, 0.5).toFixed(0)} max ${Math.max(...dumps).toFixed(0)}, ${first.bytes} bytes` })
      log(`QMP screendump: p50 ${quantile(dumps, 0.5).toFixed(0)} ms, ${first.bytes} bytes`)

      const still = await rate(s, 5)
      row('still desktop', { run: 1, ...still })
      log(`still desktop: ${still.fps.toFixed(1)} fps`)

      const hand = await hands(s, w, h)
      try {
        // ---- an act after a quiet moment, timed to the frame that shows it ----
        let v = await s.view(ENGINE_CORES)
        await sleep(1500)
        const before = otherRecords.length
        const pointer = await acts(v.viewer, 30, (i) => hand.move(w * 0.5 + (i % 2 ? 60 : -60), h * 0.4 + (i % 3) * 20))
        const cursorRecords = otherRecords.slice(before).filter((r) => r.type === 6).length
        row('pointer after 400 ms quiet', { ...pointer, note: `cursor records ${cursorRecords}` })
        log(`${size} pointer after quiet: first frame p50 ${pointer.firstP50.toFixed(1)} p95 ${pointer.firstP95.toFixed(1)} ms, ${pointer.seen}/${pointer.n} seen, capture to viewer p50 ${pointer.captureP50.toFixed(1)} ms, cursor records ${cursorRecords}`)
        for (const gap of [30, 60, 120, 250, 500, 1000, 2000]) {
          const sent: number[] = []
          for (let rep = 0; rep < 6; rep++) {
            const until = Date.now() + 600
            let k = 0
            while (Date.now() < until) {
              await hand.move(w * 0.3 + (k++ % 40) * 6, h * 0.5)
              await sleep(8)
            }
            await sleep(gap)
            sent.push(nowUs())
            await hand.move(w * 0.7, h * 0.3 + rep * 10)
            await sleep(350)
          }
          const r = actRow(v.viewer.frames, sent, 350)
          row(`gap ${gap} ms then one move`, r)
          log(`${size} gap ${gap} ms then one move: first frame p50 ${r.firstP50.toFixed(1)} ms (min ${r.firstMin.toFixed(1)} max ${r.firstMax.toFixed(1)}, ${r.seen}/${r.n})`)
        }
        {
          // the pointer moving without a stop: the frames a second the pointer alone makes
          const [start, until] = [nowUs(), Date.now() + 5000]
          let k = 0
          while (Date.now() < until) {
            await hand.move(w * 0.3 + (k % 80) * 5, h * 0.5 + Math.sin(k / 9) * 60)
            k++
            await sleep(8)
          }
          const r = rateRow(v.viewer.frames, start, nowUs())
          row('pointer moving 5 s', { ...r, note: `moves ${k}` })
          log(`${size} pointer moving: ${r.fps.toFixed(1)} fps, gap p50 ${r.gapP50.toFixed(1)} p95 ${r.gapP95.toFixed(1)} ms, capture to viewer p50 ${r.captureP50.toFixed(1)} p95 ${r.captureP95.toFixed(1)} ms`)
        }
        await v.end()

        // a key: a maximized window that changes colour at each key down, clicked so it holds the keyboard
        await startScript(s, 'keys', keyScene())
        await hand.move(w * 0.5, h * 0.5)
        await hand.button(true)
        await hand.button(false)
        await sleep(800)
        v = await s.view(ENGINE_CORES)
        await sleep(1500)
        const key = await acts(v.viewer, 30, async () => {
          await hand.key(true)
          setTimeout(() => void hand.key(false).catch(() => {}), 40)
        })
        row('key to a full-screen change', key)
        log(`${size} key: first frame p50 ${key.firstP50.toFixed(1)} p95 ${key.firstP95.toFixed(1)} ms, burst ends ${key.lastP50.toFixed(1)} ms, capture to viewer p50 ${key.captureP50.toFixed(1)} ms, frame ${key.bytesP50} bytes, ${key.seen}/${key.n}`)
        {
          // keys at the keyboard's repeat: frames a second of full-screen change
          const start = nowUs()
          for (let i = 0; i < 100; i++) {
            await hand.key(true)
            await hand.key(false)
            await sleep(25)
          }
          const r = rateRow(v.viewer.frames, start, nowUs())
          row('100 keys 25 ms apart', r)
          log(`${size} 100 keys: ${r.fps.toFixed(1)} fps, ${r.mbit.toFixed(1)} Mbit/s`)
        }
        await v.end()
        await endScenes(s)

        for (const kind of ['drag', 'redraw'] as const) {
          await startScript(s, kind, scene(kind, w, h))
          // where the window really is: Windows scales a large screen, so it is found in QMP's picture
          const grab = kind === 'drag' ? await titleBar(s, join(OUT, `drag-${size}-boot${boot + 1}.png`)) : null
          for (let run = 1; run <= RUNS; run++) {
            const r = await rate(s, SECS, grab ? (until) => drag(hand, w, h, grab, until) : undefined)
            row(kind, { run, ...r })
            log(`${size} ${kind} run ${run}: ${r.fps.toFixed(1)} fps, gap p50 ${r.gapP50.toFixed(0)} p95 ${r.gapP95.toFixed(0)} ms, ${r.mbit.toFixed(1)} Mbit/s, engine ${r.engineCores.toFixed(2)} QEMU ${r.qemuCores.toFixed(2)} cores, load ${loadavg()[0]!.toFixed(1)}`)
            await sleep(1000)
          }
          await endScenes(s)
        }
      } finally {
        hand.close()
        save()
      }
      log('shutting Windows down')
      await shutDown(s, log)
    }
  } finally {
    await s.remove()
    save()
  }
  for (const [w, h] of SIZES)
    for (const sc of ['still desktop', 'drag', 'redraw']) {
      const xs = rows.filter((r) => r.size === `${w}x${h}` && r.scene === sc)
      if (xs.length) console.log(`${w}x${h} ${sc}: median ${quantile(xs.map((r) => r.fps!), 0.5).toFixed(1)} fps over ${xs.length} runs, engine ${quantile(xs.map((r) => r.engineCores!), 0.5).toFixed(2)} QEMU ${quantile(xs.map((r) => r.qemuCores!), 0.5).toFixed(2)} cores`)
    }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  }
)
