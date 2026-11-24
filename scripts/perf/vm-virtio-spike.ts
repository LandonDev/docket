#!/usr/bin/env bun
/**
 * A scratch Windows VM held up for trying the display device by hand (virtio-vga with Red Hat's viogpudo), and
 * taken away again. It makes a fresh disk, moves it to virtio-vga as the keeper's Turn on will (`--device vga`
 * leaves it on std VGA), and then answers on a local port until it is told `down` or its minutes run out:
 *
 *   POST /admin        a PowerShell script as tcadmin; its output
 *   POST /desktop      a JSON argv run on tcuser's desktop, waited for; its output
 *   POST /qmp          a JSON QMP command; its answer
 *   GET  /shot?file=   QMP's picture of the guest as a PNG; its size and time
 *   GET  /move?x=&y=   the pointer through QMP, in the guest's pixels of `w` by `h`
 *   GET  /view         a viewer's stream opened (or its counts since the last call): frames, sizes, cursor records
 *   GET  /unview       the stream ended
 *   GET  /sleep        hibernate, QEMU waited out, the TPM kept;  GET /wake  a start and the desktop waited for
 *   GET  /restart?device=&size=WxH   a clean shutdown and a start on that device and size
 *   GET  /down         Windows shut down, everything removed, the script ends
 *
 * Scratch only (`scratchMachineRefusal`):
 *   WINVM_DIR=/tmp/vm-screen-rig-s WINVM_TPM_DIR=/tmp/win-vm-tpm-vmscreen-s WINVM_SSH_PORT=22242 \
 *     taskset -c 24-31 nice -n 10 bun scripts/perf/vm-virtio-spike.ts --driver <dir> [--size 1280x800] [--port 22342] [--minutes 50]
 */
import { writeMachineDevice } from '../../src/main/server/work/winvm/guestScreen'
import type { DisplayDevice } from '../../src/main/server/work/winvm/machine/qemu'
import { ADAPTERS_SCRIPT, moveToVirtio, otherRecords, scratchMachine, shutDown, sleep, type Scratch } from '../lib/winvmScratch'
import { parseSizes } from './vmScreenRows'

const arg = (name: string, d: string): string => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1]! : d
}
const DEVICE = arg('device', 'virtio') as DisplayDevice
const DRIVER = arg('driver', '')
const PORT = Number(arg('port', '22342'))
const MINUTES = Number(arg('minutes', '50'))
const DATA = arg('data', process.env.TEMP_CODE_USER_DATA ?? '/srv/agents/temp-code-data')
if (!DRIVER) throw new Error('--driver <the unpacked viogpudo folder>')

const log = (m: string) => console.log(`[vm-spike ${new Date().toISOString().slice(11, 19)}] ${m}`)
let size = parseSizes(arg('size', '1280x800'))[0]!
const s: Scratch = scratchMachine({ data: DATA, size, log })
let view: Awaited<ReturnType<Scratch['view']>> | null = null
let seen = { frames: 0, others: 0 }

async function up(): Promise<string> {
  const t0 = Date.now()
  await s.machine.start()
  await s.guest.ready(300_000)
  return `desktop in ${((Date.now() - t0) / 1000).toFixed(1)} s, window ${JSON.stringify(s.screen.size)}; ${(await s.guest.admin(ADAPTERS_SCRIPT)).trim().replace(/\r?\n/g, ' ; ')}`
}

async function down(): Promise<void> {
  await view?.end().catch(() => {})
  await shutDown(s, log).catch(() => {})
  await s.remove()
}

let busy: Promise<unknown> = Promise.resolve()
const routes: Record<string, (q: URLSearchParams, body: string) => Promise<unknown>> = {
  '/admin': (_q, body) => s.guest.admin(body, 300_000),
  '/desktop': (_q, body) => s.guest.onDesktop(JSON.parse(body) as string[], true, 120),
  '/qmp': (_q, body) => {
    const c = JSON.parse(body) as { execute: string; arguments?: Record<string, unknown> }
    return s.qmp(c.execute, c.arguments)
  },
  '/shot': async (q) => {
    const file = q.get('file') ?? '/tmp/vm-spike-shot.png'
    const t0 = performance.now()
    await s.qmp('screendump', { filename: file, format: 'png' })
    const png = await Bun.file(file).arrayBuffer()
    const v = new DataView(png)
    return { file, ms: Math.round(performance.now() - t0), bytes: png.byteLength, width: v.getUint32(16), height: v.getUint32(20) }
  },
  '/move': async (q) => {
    const [w, h] = [Number(q.get('w') ?? size[0]), Number(q.get('h') ?? size[1])]
    await s.qmp('input-send-event', {
      events: [
        { type: 'abs', data: { axis: 'x', value: Math.round((Number(q.get('x')) / w) * 32767) } },
        { type: 'abs', data: { axis: 'y', value: Math.round((Number(q.get('y')) / h) * 32767) } }
      ]
    })
    return 'moved'
  },
  '/view': async () => {
    if (!view) {
      view = await s.view(arg('engine-cores', '24-31'))
      seen = { frames: 0, others: otherRecords.length }
      await sleep(1500)
    }
    const frames = view.viewer.frames.slice(seen.frames)
    const others = otherRecords.slice(seen.others)
    seen = { frames: view.viewer.frames.length, others: otherRecords.length }
    const last = view.viewer.frames.at(-1)
    return { frames: frames.length, keyframes: frames.filter((f) => f.key).length, size: last ? `${last.w}x${last.h}` : null, bytes: frames.reduce((a, f) => a + f.bytes, 0), others: others.map((o) => `type ${o.type}, ${o.bytes} bytes`) }
  },
  '/unview': async () => {
    await view?.end()
    view = null
    return 'ended'
  },
  '/sleep': async () => {
    await view?.end()
    view = null
    const t0 = Date.now()
    await s.guest.hibernate()
    if (!(await s.machine.stopped(180_000))) throw new Error('Windows did not hibernate in 3 minutes')
    await s.machine.keepTpm()
    return `asleep in ${((Date.now() - t0) / 1000).toFixed(1)} s`
  },
  '/wake': () => up(),
  '/restart': async (q) => {
    await view?.end()
    view = null
    const device = (q.get('device') ?? DEVICE) as DisplayDevice
    if (q.get('size')) size = parseSizes(q.get('size')!)[0]!
    s.setSize(size)
    await shutDown(s, log, device)
    return up()
  }
}

async function main(): Promise<void> {
  log('making a fresh scratch disk')
  await s.machine.makeDisk()
  s.setSize([1280, 800])
  log(await up())
  if (DEVICE === 'virtio') {
    await moveToVirtio(s, DRIVER, log)
    s.setSize(size)
    log(await up())
  } else writeMachineDevice(s.machine.p.run, 'vga')
  const end = setTimeout(() => void down().then(() => process.exit(0)), MINUTES * 60_000)
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: PORT,
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/down') {
        clearTimeout(end)
        void busy.then(down).then(() => process.exit(0))
        return new Response('going down\n')
      }
      const route = routes[url.pathname]
      if (!route) return new Response('no such route\n', { status: 404 })
      const body = await req.text()
      // one at a time: QMP serves one client, and a size change must not meet a sleep
      const run = busy.then(() => route(url.searchParams, body))
      busy = run.catch(() => {})
      try {
        const out = await run
        return new Response((typeof out === 'string' ? out : JSON.stringify(out, null, 1)) + '\n')
      } catch (e) {
        return new Response(`FAILED: ${(e as Error).message}\n`, { status: 500 })
      }
    }
  })
  log(`ready on http://127.0.0.1:${server.port} for ${MINUTES} minutes`)
}

main().catch(async (e) => {
  console.error(e)
  await down().catch(() => {})
  process.exit(1)
})
