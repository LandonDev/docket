import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { WinvmState } from '@shared/contract-work-winvm'
import type { DisplayDevice, VmWindow } from './machine/qemu'

/**
 * The size Windows itself draws at, kept beside the standing disk. The guest's display driver (Microsoft
 * Basic Display Adapter) takes the firmware's mode at a cold boot and keeps it through every hibernate:
 * QEMU started at another size after the Screen size setting changed reads the guest's 1280×800 frame
 * buffer at 1920×1200's stride, and the picture is a scramble (the box, 2026-11-22). So a start resumes the
 * guest at the size it slept at, and the setting is taken only by a Windows that starts afresh in a run
 * whose QEMU has that size: a new disk, whose first start reads no file.
 */

/** What the guest's admin answers: the first display adapter's mode, `<width>x<height>`. */
export const GUEST_SCREEN_SCRIPT =
  "Get-CimInstance Win32_VideoController | Select-Object -First 1 | ForEach-Object { '{0}x{1}' -f $_.CurrentHorizontalResolution, $_.CurrentVerticalResolution }"

export function parseGuestScreen(out: string): VmWindow | null {
  const m = /(\d{3,5})x(\d{3,5})/.exec(out)
  if (!m) return null
  const [width, height] = [Number(m[1]), Number(m[2])]
  return width > 0 && height > 0 ? { width, height } : null
}

/** In the machine's run folder: a new disk (`makeDisk`) clears it with the rest. */
export const guestScreenFile = (run: string): string => join(run, 'screen.json')

export function readGuestScreen(run: string): VmWindow | null {
  try {
    const v = JSON.parse(readFileSync(guestScreenFile(run), 'utf8')) as Partial<VmWindow>
    return typeof v.width === 'number' && typeof v.height === 'number' ? { width: v.width, height: v.height } : null
  } catch {
    return null
  }
}

/** Windows' scale in percent, where the size's writer kept it (live resize); null where it did not. */
export function readGuestScale(run: string): number | null {
  try {
    const scale = (JSON.parse(readFileSync(guestScreenFile(run), 'utf8')) as { scale?: unknown }).scale
    return typeof scale === 'number' && scale >= 100 && scale <= 500 ? scale : null
  } catch {
    return null
  }
}

/** The guest's size, and Windows' scale where live resize set it (readGuestScale). */
export function writeGuestScreen(run: string, size: VmWindow & { scale?: number }): void {
  mkdirSync(dirname(guestScreenFile(run)), { recursive: true })
  writeFileSync(guestScreenFile(run), JSON.stringify(size) + '\n')
}

/**
 * The display device the guest last ran on, beside its size. It is written BEFORE QEMU starts on a device and
 * never after, and every start reads it: a Windows hibernated on one device is never resumed on the other. A
 * machine with no file is `vga` (every disk from before the file existed).
 */
export const machineFile = (run: string): string => join(run, 'machine.json')

export function readMachineDevice(run: string): DisplayDevice {
  try {
    return (JSON.parse(readFileSync(machineFile(run), 'utf8')) as { device?: unknown }).device === 'virtio' ? 'virtio' : 'vga'
  } catch {
    return 'vga'
  }
}

export function writeMachineDevice(run: string, device: DisplayDevice): void {
  mkdirSync(run, { recursive: true })
  writeFileSync(machineFile(run), JSON.stringify({ device }) + '\n')
}

const same = (a: VmWindow | null, b: VmWindow | null): boolean => !!a && !!b && a.width === b.width && a.height === b.height

export interface GuestScreenWatch {
  onState: (fn: (s: WinvmState | null) => void) => () => void
  keeper: () => { admin(script: string): Promise<string>; sleep(): Promise<unknown>; wake(): Promise<unknown> } | null
  /** the size QEMU's display has in this run; null with no window */
  shown: () => VmWindow | null
  /** the machine's run folder */
  run: string
  /** nobody uses the machine now: no thread holds it and he does not drive */
  free: () => boolean
  /** the device the guest runs on (`machine.json`); `vga` when not given */
  device?: () => DisplayDevice
  /** on virtio: the box's display set to the guest's size, live (display.ts `VmDisplay.follow`) */
  follow?: (size: VmWindow) => Promise<void>
  log?: (line: string) => void
}

/**
 * After every wake: the guest's own size read and kept. On virtio-gpu QEMU's window follows the guest's mode by
 * itself, so a display of another size is set to the guest's, live. On std VGA a display of another size (a start
 * before this file existed, or the setting changed under a hibernated guest) leaves the picture unreadable until the
 * next start, so a machine nobody uses is put to sleep and woken once, at the size the guest has.
 */
export function watchGuestScreen(o: GuestScreenWatch): () => void {
  let busy = false
  return o.onState((s) => {
    if (s?.state !== 'awake' || busy) return
    const keeper = o.keeper()
    if (!keeper) return
    busy = true
    void (async () => {
      try {
        const guest = parseGuestScreen(await keeper.admin(GUEST_SCREEN_SCRIPT))
        if (!guest) return
        writeGuestScreen(o.run, guest)
        const shown = o.shown()
        if (!shown || same(shown, guest)) return
        o.log?.(`winvm: the guest draws at ${guest.width}×${guest.height}, its display is ${shown.width}×${shown.height}`)
        if (o.device?.() === 'virtio' && o.follow) return await o.follow(guest)
        if (!o.free()) return
        o.log?.('winvm: waking it again at the guest’s own size')
        await keeper.sleep()
        await keeper.wake()
      } catch (e) {
        o.log?.(`winvm: reading the guest's screen failed: ${(e as Error).message}`)
      } finally {
        busy = false
      }
    })()
  })
}
