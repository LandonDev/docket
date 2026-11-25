import type { DisplayMode } from '@shared/computer/protocol'
import type { VideoSizeParams } from '@shared/contract-video'
import { GUEST_CAPS, GUEST_MIN_POINTS, GUEST_SCALES, guestSizeFor, type GuestCaps } from '@shared/video/guestSize'
import type { StreamInfo, VideoRelay } from '../../video/relay'
import type { EngineLease } from '../browser/box/engine'
import type { GuestDisplay } from './door'
import { writeGuestScreen } from './guestScreen'
import type { VmWindow } from './machine/qemu'

/**
 * The guest follows the viewer (docs/agents/work-winvm.md "The picture"): on virtio-gpu, a new size is set inside
 * Windows through the door's `display.set`, and the box's side follows it, one change at a time, in this order:
 *
 *   1. the X screen grows by RandR where the new size is larger, so QEMU's window has room to grow into
 *   2. `display.set`; as soon as it answers, `run/screen.json` says the size the guest took
 *   3. QEMU's window is waited for at that size (it follows the guest's mode by itself)
 *   4. the VM's streams end `resized` and every VM engine stops, the warm ones too (an engine fixes its size at its
 *      start), and no new lease is given until step 5 is done
 *   5. the X screen shrinks to the size where it is smaller, and leases open again
 *
 * A failure leaves the size that is true and says why: before step 2 nothing changed (a grown screen shrinks back);
 * after it the guest's size is the file's and the rest follow it as far as they can.
 */

export const WINDOW_WAIT_MS = 5_000
const WINDOW_POLL_MS = 50

export interface VmDisplayDeps {
  /** the machine's run folder: `screen.json` */
  run: string
  /** the guest's own side, through the door */
  guest: () => GuestDisplay
  /** the VM's X display and QEMU's window on it (window.ts `VmScreen`) */
  screen: {
    readonly size: VmWindow | null
    resize(size: VmWindow): Promise<void>
    /** QEMU's window's size now, or null when it has none */
    windowSize(): Promise<VmWindow | null>
    engines: { lease(): Promise<EngineLease | null>; stopAll(): Promise<void> }
  }
  relay: Pick<VideoRelay, 'endWhere'>
  /** the VM's streams */
  isVm: (s: StreamInfo) => boolean
  windowWaitMs?: number
  log?: (line: string) => void
}

const same = (a: VmWindow | null, b: VmWindow): boolean => !!a && a.width === b.width && a.height === b.height
const words = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export class VmDisplay {
  /** the change under way; a lease waits for it */
  private busy: Promise<unknown> = Promise.resolve()
  private changing = false
  /** leases asked before a change began: step 4 waits for them, so none hands out an engine of the old size after it */
  private readonly leasing = new Set<Promise<unknown>>()
  /** the mode the guest last answered */
  private mode: DisplayMode | null = null
  /** counts the engine stops of step 4: a lease that spans one gives its engine back and asks again */
  private generation = 0

  constructor(private readonly d: VmDisplayDeps) {}

  /** The guest at `ask`, then the box after it. Answers the mode the guest took; throws with why when a step failed. */
  set(ask: DisplayMode): Promise<DisplayMode> {
    return this.serial(async () => {
      if (this.mode && this.mode.width === ask.width && this.mode.height === ask.height && this.mode.scale === ask.scale && same(this.d.screen.size, ask)) return this.mode
      const took = await this.change(ask, async () => {
        const took = await this.d.guest().set(ask)
        // the file says the guest's size before anything else can fail: a stop of the service from here leaves it true
        writeGuestScreen(this.d.run, { width: took.width, height: took.height })
        this.mode = took
        return took
      })
      return took!
    })
  }

  /** The box follows a size the guest already has (a wake on virtio): steps 1, 4 and 5. */
  follow(size: VmWindow): Promise<void> {
    return this.serial(async () => {
      if (same(this.d.screen.size, size)) return
      await this.change(size, null)
    })
  }

  /** An engine for a viewer: never during a change, and never one started at the size before it. */
  async lease(): Promise<EngineLease | null> {
    for (;;) {
      while (this.changing) await this.busy
      const generation = this.generation
      const asked = this.d.screen.engines.lease()
      this.leasing.add(asked)
      let got: EngineLease | null
      try {
        got = await asked
      } finally {
        this.leasing.delete(asked)
      }
      if (generation === this.generation) return got
      got?.release()
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      this.changing = true
      try {
        return await fn()
      } finally {
        this.changing = false
      }
    }
    const next = this.busy.then(run, run)
    this.busy = next.catch(() => {})
    return next
  }

  /** The five steps; `guest` is step 2, or null when the guest has the size already. */
  private async change(target: VmWindow, guest: (() => Promise<DisplayMode>) | null): Promise<DisplayMode | null> {
    const { screen } = this.d
    const before = screen.size
    if (!before) throw new Error('the Windows VM has no window')
    const room = (s: VmWindow): VmWindow => ({ width: Math.max(before.width, s.width), height: Math.max(before.height, s.height) })
    // 1
    const grown = room(target)
    if (!same(before, grown)) {
      try {
        await screen.resize(grown)
      } catch (e) {
        throw new Error(`the display could not grow to ${grown.width}×${grown.height}: ${words(e)}`)
      }
    }
    // 2
    let took: DisplayMode | null = null
    if (guest) {
      try {
        took = await guest()
      } catch (e) {
        if (!same(before, grown)) await screen.resize(before).catch((e2) => this.d.log?.(`winvm: the display did not shrink back: ${words(e2)}`))
        throw new Error(`Windows did not take ${target.width}×${target.height}: ${words(e)}`)
      }
      // viogpudo may keep another size than the ask: the box follows what it took
      if (!same(grown, room(took))) await screen.resize(room(took)).catch(() => {})
    }
    const size: VmWindow = took ? { width: took.width, height: took.height } : target
    let why: string | null = null
    // 3
    if (took && !(await this.windowAt(size))) why = `QEMU's window did not reach ${size.width}×${size.height}`
    // 4
    this.generation++
    await Promise.allSettled([...this.leasing])
    this.d.relay.endWhere(this.d.isVm, 'resized')
    await screen.engines.stopAll()
    // 5
    if (!same(screen.size, size)) {
      try {
        await screen.resize(size)
      } catch (e) {
        why ??= `the display did not shrink to ${size.width}×${size.height}: ${words(e)}`
      }
    }
    this.d.log?.(`winvm: the guest is ${size.width}×${size.height}${took ? ` at ${took.scale}%` : ''}${why ? `; ${why}` : ''}`)
    if (why) throw new Error(why)
    return took
  }

  private async windowAt(size: VmWindow): Promise<boolean> {
    const end = Date.now() + (this.d.windowWaitMs ?? WINDOW_WAIT_MS)
    for (;;) {
      if (same(await this.d.screen.windowSize().catch(() => null), size)) return true
      if (Date.now() >= end) return false
      await new Promise((r) => setTimeout(r, WINDOW_POLL_MS))
    }
  }
}

/**
 * The mode a size ask means (`video.size`): Fit by `guestSizeFor` with the host's caps; a fixed size at the largest
 * scale that keeps 1024×640 points (Sharp), or 100% (Faster).
 */
export function askedMode(ask: VideoSizeParams, caps: GuestCaps = GUEST_CAPS): DisplayMode {
  if (ask.mode === 'fit') return guestSizeFor({ width: ask.width, height: ask.height }, ask.scale, ask.detail, caps)
  const scale = ask.detail === 'faster' ? 100 : (GUEST_SCALES.find((s) => (ask.width * 100) / s >= GUEST_MIN_POINTS.width && (ask.height * 100) / s >= GUEST_MIN_POINTS.height) ?? 100)
  return { width: ask.width, height: ask.height, scale }
}
