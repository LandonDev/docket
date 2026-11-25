#!/usr/bin/env bun
/**
 * The guest follows the viewer, proven on a scratch machine (docs/agents/work-winvm.md "The picture"): a fresh
 * disk moved to virtio-vga as the keeper's Turn on will (scripts/lib/winvmScratch.ts `moveToVirtio`), a drive
 * stream of it through the host's own `VideoRpc`, `VmPicture` and `VmDisplay`, and three sizes asked by
 * `video.size` in turn. For each: the guest's answer, the code the stream closed with (4108 `resized`), the
 * stream opened again at once, every frame of it at the asked size, and the time from the ask to its first frame
 * at that size. One JSON of rows out; it records and never asserts a time.
 *
 * Until the door's `display.set` is in the guest's tc-computer.exe (M3c), Windows' side is `viogpures.exe` from
 * the driver folder (`GUEST_DRIVER_DIR`), copied to Program Files so tcuser may run it on his desktop; it sets the
 * size and not the scale, so the scale stays Windows' own.
 *
 * Scratch only (`scratchMachineRefusal`), and only with the master's yes for a VM:
 *   WINVM_DIR=/dev/shm/vm-screen-rig-r WINVM_TPM_DIR=/tmp/win-vm-tpm-vmscreen-r WINVM_SSH_PORT=22243 \
 *     taskset -c 24-31 ionice -c 3 nice -n 19 bun scripts/e2e-winvm-resize.ts --driver <dir> [--sizes 1920x1200,2560x1600,3456x2234] [--out rows.json]
 */
import { writeFileSync } from 'node:fs'
import { LOCAL_PRINCIPAL } from '../src/shared/capabilities'
import type { WinvmState } from '../src/shared/contract-work-winvm'
import type { StreamClaim } from '../src/main/server/remote/auth'
import { VideoRelay, type StreamInfo } from '../src/main/server/video/relay'
import { VideoRpc } from '../src/main/server/video/rpc'
import { VmDisplay } from '../src/main/server/work/winvm/display'
import type { GuestDisplay } from '../src/main/server/work/winvm/door'
import { GUEST_SCREEN_SCRIPT, parseGuestScreen, readMachineDevice } from '../src/main/server/work/winvm/guestScreen'
import { psQuote } from '../src/main/server/work/winvm/machine/guest'
import { VM_COMPUTER, VmPicture } from '../src/main/server/work/winvm/picture'
import { BenchViewer, GUEST_DRIVER_DIR, moveToVirtio, nowUs, scratchMachine, shutDown, sleep, type Scratch } from './lib/winvmScratch'
import { RESIZE_SIZES, fitAsk, resizeRow, type ResizeRow, type Size } from './lib/winvmResize'
import { parseSizes } from './perf/vmScreenRows'

const arg = (name: string, d: string): string => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1]! : d
}
const DRIVER = arg('driver', '')
const DATA = arg('data', process.env.TEMP_CODE_USER_DATA ?? '/srv/agents/temp-code-data')
const OUT = arg('out', '')
const SIZES: Size[] = process.argv.includes('--sizes') ? parseSizes(arg('sizes', '')).map(([width, height]) => ({ width, height })) : RESIZE_SIZES
/** The longest a reopened stream is watched for a frame at the new size. */
const FRAME_WAIT_MS = 10_000
if (!DRIVER) throw new Error('--driver <the unpacked viogpudo folder>')

const log = (m: string) => console.log(`[e2e-winvm-resize ${new Date().toISOString().slice(11, 19)}] ${m}`)
const STAND_IN_DIR = 'C:\\Program Files\\tc-viogpu'
const STAND_IN = `${STAND_IN_DIR}\\viogpures.exe`

/** A viewer that also keeps the code its stream closed with. */
class ResizeViewer extends BenchViewer {
  closedWith: number | null = null
  override close(code?: number): void {
    this.closedWith = code ?? null
  }
}

async function up(s: Scratch): Promise<void> {
  await s.machine.start()
  await s.guest.ready(300_000)
}

async function main(s: Scratch): Promise<ResizeRow[]> {
  log('making a fresh scratch disk, on std VGA at 1280×800')
  await s.machine.makeDisk()
  await up(s)
  log('moving it to virtio-vga')
  await moveToVirtio(s, DRIVER, log)
  await up(s)
  await s.guest.admin([`New-Item -ItemType Directory -Force ${psQuote(STAND_IN_DIR)} | Out-Null`, `Copy-Item -Force ${psQuote(`${GUEST_DRIVER_DIR}\\viogpures.exe`)} ${psQuote(STAND_IN)}`].join('\n'))

  // Windows' side of the door, until its own verb lands: the size set on tcuser's desktop, and read back
  const guest: GuestDisplay = {
    get: async () => {
      const size = parseGuestScreen(await s.guest.admin(GUEST_SCREEN_SCRIPT))
      if (!size) throw new Error('the guest named no mode')
      return { ...size, scale: 100 }
    },
    set: async (mode) => {
      await s.guest.onDesktop([STAND_IN, String(mode.width), String(mode.height)], true, 60)
      return guest.get()
    }
  }
  const relay = new VideoRelay()
  const minted: StreamClaim[] = []
  const rpc = new VideoRpc(relay, { mintStreamTicket: (c) => (minted.push(c), { ticket: 't', expiresIn: 30 }) }, () => true)
  const state: WinvmState = { state: 'awake', step: null, error: null, cannot: null, sleepAfter: '30m', since: Date.now() }
  const isVm = (st: StreamInfo): boolean => st.tag === VM_COMPUTER
  const display = new VmDisplay({ run: s.machine.p.run, guest: () => guest, screen: s.screen, relay, isVm, log })
  const picture = new VmPicture({
    state: () => state,
    onState: () => () => {},
    setViewers: () => {},
    screen: s.screen,
    relay,
    screenshot: async () => Buffer.alloc(0),
    jpeg: async () => ({ data: '', width: 1, height: 1 }),
    display,
    device: () => readMachineDevice(s.machine.p.run)
  })
  rpc.addSource(picture)
  // he drives: only his drive stream may size
  picture.setDriving(true)
  const caller = { principal: LOCAL_PRINCIPAL, connection: {}, connectionId: '1' }
  const open = async (): Promise<{ stream: string; viewer: ResizeViewer }> => {
    const answer = await rpc.open({ threadId: VM_COMPUTER, computer: VM_COMPUTER, maxEdge: 4096, drive: true }, caller)
    if (!answer.ok) throw new Error(`video.open refused: ${answer.reason}`)
    const viewer = new ResizeViewer()
    if (!relay.attach(minted.at(-1)!, viewer)) throw new Error('the viewer did not join')
    return { stream: answer.stream, viewer }
  }

  let now = await open()
  await sleep(1500)
  const rows: ResizeRow[] = []
  for (const size of SIZES) {
    const askUs = nowUs()
    const took = await rpc
      .size({ stream: now.stream, mode: 'fit', ...fitAsk(size), detail: 'sharp' }, caller)
      .then((a) => (a.ok ? `${a.width}x${a.height} at ${a.scale}%` : a.reason), (e: Error) => `error: ${e.message}`)
    const closed = now.viewer.closedWith
    // the viewer opens a resized stream again at once
    now = await open()
    const end = Date.now() + FRAME_WAIT_MS
    while (!now.viewer.frames.some((f) => f.w === size.width && f.h === size.height) && Date.now() < end) await sleep(20)
    // a little more of the stream, for its frames' sizes
    await sleep(1000)
    const row = resizeRow({ asked: size, took, askUs, closed, frames: now.viewer.frames })
    log(JSON.stringify(row))
    rows.push(row)
  }
  relay.endWhere(isVm, 'ended')
  picture.close()
  return rows
}

const s = scratchMachine({ data: DATA, size: [1280, 800], log })
main(s)
  .then((rows) => {
    const out = JSON.stringify({ at: new Date().toISOString(), rows }, null, 1)
    if (OUT) writeFileSync(OUT, out + '\n')
    console.log(out)
  })
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(async () => {
    await shutDown(s, log).catch(() => {})
    await s.remove()
  })
