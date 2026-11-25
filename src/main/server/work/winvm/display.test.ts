import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { COMPUTER_METHODS } from '@shared/computer/protocol'
import { guestSizeFor } from '@shared/video/guestSize'
import type { StreamInfo } from '../../video/relay'
import { askedMode, VmDisplay } from './display'
import type { GuestModeAsk, GuestModeSet } from './door'
import { readGuestScreen } from './guestScreen'
import type { VmWindow } from './machine/qemu'

/** The guest follows the viewer: the five steps over a fake door, display and engines. */

let run: string
beforeEach(() => (run = mkdtempSync(join(tmpdir(), 'vm-display-'))))
afterEach(() => rmSync(run, { recursive: true, force: true }))

const ADAPTER = 'Red Hat VirtIO GPU DOD controller'
const at = (s: VmWindow): string => `${s.width}x${s.height}`
const deferred = <T = void>() => {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}
const tick = () => new Promise((r) => setTimeout(r, 5))

function rig(o: { size?: VmWindow; fail?: Partial<Record<'grow' | 'set' | 'shrink', boolean>>; window?: 'follows' | 'stuck'; leaseMs?: number; set?: (m: GuestModeAsk) => Promise<Omit<GuestModeSet, 'adapter'>> } = {}) {
  const log: string[] = []
  let screen: VmWindow | null = o.size ?? { width: 1280, height: 800 }
  let window: VmWindow = { ...screen }
  /** engines by the display's size at their start; `warm` ones nobody holds */
  const engines: { id: number; size: string; held: boolean; stopped: boolean }[] = []
  let ids = 0
  let setting = 0
  let most = 0
  const fake = {
    run,
    guest: () => ({
      get: async () => ({ ...window, scale: 100, adapter: ADAPTER }),
      set: async (mode: GuestModeAsk): Promise<GuestModeSet> => {
        most = Math.max(most, ++setting)
        try {
          log.push(`set ${at(mode)}`)
          await tick()
          if (o.fail?.set) throw new Error('the escape was refused')
          const took = { ...(o.set ? await o.set(mode) : { ...mode, taken: true }), adapter: ADAPTER }
          if (o.window !== 'stuck') window = { width: took.width, height: took.height }
          return took
        } finally {
          setting--
        }
      }
    }),
    screen: {
      get size() {
        return screen
      },
      resize: async (size: VmWindow) => {
        const grow = size.width > screen!.width || size.height > screen!.height
        log.push(`x ${at(size)}`)
        if (o.fail?.[grow ? 'grow' : 'shrink']) throw new Error('RandR refused')
        screen = size
      },
      windowSize: async () => window,
      engines: {
        lease: async () => {
          await new Promise((r) => setTimeout(r, o.leaseMs ?? 5))
          const warm = engines.find((e) => !e.held && !e.stopped)
          const e = warm ?? { id: ++ids, size: at(screen!), held: false, stopped: false }
          if (!warm) engines.push(e)
          e.held = true
          return { port: e.id, token: e.size, pid: null, onExit: () => {}, release: () => void (e.held = false) }
        },
        stopAll: async () => {
          log.push('stop engines')
          for (const e of engines) e.stopped = true
        }
      }
    },
    relay: { endWhere: (match: (s: StreamInfo) => boolean, reason: string) => (log.push(`end ${reason}`), match({ tag: 'vm:windows' } as StreamInfo) ? 1 : 0) },
    isVm: (s: StreamInfo) => s.tag === 'vm:windows',
    windowWaitMs: 60
  }
  const display = new VmDisplay(fake)
  return { display, log, engines, screen: () => screen, most: () => most }
}

describe('a size change', () => {
  it('grows the screen, sets the guest, waits for the window, ends the streams resized, stops every engine', async () => {
    const r = rig()
    expect(await r.display.set({ width: 3456, height: 2234, scale: 200 })).toEqual({ width: 3456, height: 2234, scale: 200, adapter: ADAPTER, taken: true })
    expect(r.log).toEqual(['x 3456x2234', 'set 3456x2234', 'end resized', 'stop engines'])
    expect(readGuestScreen(run)).toEqual({ width: 3456, height: 2234 })
  })

  it('shrinks the screen last, once the engines have stopped', async () => {
    const r = rig({ size: { width: 3456, height: 2234 } })
    await r.display.set({ width: 1920, height: 1200, scale: 175 })
    expect(r.log).toEqual(['set 1920x1200', 'end resized', 'stop engines', 'x 1920x1200'])
  })

  it('wider and shorter: the screen grows to hold both first, and takes the new size exactly last', async () => {
    const r = rig({ size: { width: 2560, height: 1600 } })
    await r.display.set({ width: 3840, height: 1080, scale: 100 })
    expect(r.log).toEqual(['x 3840x1600', 'set 3840x1080', 'end resized', 'stop engines', 'x 3840x1080'])
    expect(r.screen()).toEqual({ width: 3840, height: 1080 })
  })


  it('asks nothing again for the mode it has', async () => {
    const r = rig()
    await r.display.set({ width: 2560, height: 1600, scale: 200 })
    r.log.length = 0
    await r.display.set({ width: 2560, height: 1600, scale: 200 })
    expect(r.log).toEqual([])
  })

  it('a wake on virtio follows the guest without asking it: grow, end, stop, shrink', async () => {
    const r = rig({ size: { width: 1280, height: 800 } })
    await r.display.follow({ width: 2560, height: 1600 })
    expect(r.log).toEqual(['x 2560x1600', 'end resized', 'stop engines'])
    await r.display.follow({ width: 2560, height: 1600 })
    expect(r.log).toHaveLength(3)
  })
})

describe('a failure leaves the size that is true and says why', () => {
  it('at the grow: nothing changed, the guest is not asked', async () => {
    const r = rig({ fail: { grow: true } })
    await expect(r.display.set({ width: 2560, height: 1600, scale: 200 })).rejects.toThrow('the display could not grow to 2560×1600: RandR refused')
    expect(r.log).toEqual(['x 2560x1600'])
    expect(readGuestScreen(run)).toBeNull()
  })

  it('at the guest: the grown screen shrinks back and no stream ends', async () => {
    const r = rig({ fail: { set: true } })
    await expect(r.display.set({ width: 2560, height: 1600, scale: 200 })).rejects.toThrow('Windows did not take 2560×1600: the escape was refused')
    expect(r.log).toEqual(['x 2560x1600', 'set 2560x1600', 'x 1280x800'])
    expect(r.screen()).toEqual({ width: 1280, height: 800 })
    expect(readGuestScreen(run)).toBeNull()
  })

  it('a size the driver refused (taken: false) is a failure of step 2: the box keeps the size that is true, and says why', async () => {
    const r = rig({ set: async () => ({ width: 1280, height: 800, scale: 100, taken: false }) })
    await expect(r.display.set({ width: 3456, height: 2234, scale: 200 })).rejects.toThrow('Windows did not take 3456×2234 at 200%: it is 1280×800 at 100%')
    // grown for it, shrunk back; no stream ended, no engine stopped
    expect(r.log).toEqual(['x 3456x2234', 'set 3456x2234', 'x 1280x800'])
    expect(r.screen()).toEqual({ width: 1280, height: 800 })
    expect(readGuestScreen(run)).toEqual({ width: 1280, height: 800 })
    // asked again, it is asked again: a refusal is never kept as the mode it has
    await expect(r.display.set({ width: 3456, height: 2234, scale: 200 })).rejects.toThrow('did not take')
  })

  it('a size that took at a scale Windows refused: the box follows the new size, then says the scale did not take', async () => {
    const r = rig({ set: async (m) => ({ ...m, scale: 150, taken: false }) })
    await expect(r.display.set({ width: 2560, height: 1600, scale: 200 })).rejects.toThrow('Windows did not take 2560×1600 at 200%: it is 2560×1600 at 150%')
    expect(r.log).toEqual(['x 2560x1600', 'set 2560x1600', 'end resized', 'stop engines'])
    expect(r.screen()).toEqual({ width: 2560, height: 1600 })
    expect(readGuestScreen(run)).toEqual({ width: 2560, height: 1600 })
  })

  it("at QEMU's window: the guest's size is kept, the engines restart at it, and it says so", async () => {
    const r = rig({ size: { width: 2560, height: 1600 }, window: 'stuck' })
    await expect(r.display.set({ width: 1920, height: 1200, scale: 175 })).rejects.toThrow("QEMU's window did not reach 1920×1200")
    expect(r.log).toEqual(['set 1920x1200', 'end resized', 'stop engines', 'x 1920x1200'])
    expect(readGuestScreen(run)).toEqual({ width: 1920, height: 1200 })
  })

  it('at the shrink: the screen stays larger, the guest is right, and leases open again', async () => {
    const r = rig({ size: { width: 2560, height: 1600 }, fail: { shrink: true } })
    await expect(r.display.set({ width: 1920, height: 1200, scale: 175 })).rejects.toThrow('the display did not shrink to 1920×1200: RandR refused')
    expect(r.screen()).toEqual({ width: 2560, height: 1600 })
    expect(readGuestScreen(run)).toEqual({ width: 1920, height: 1200 })
    expect(await r.display.lease()).not.toBeNull()
  })

  it("a stop of the service after display.set answered leaves screen.json saying the guest's size", async () => {
    const r = rig()
    const answered = deferred<GuestModeAsk>()
    const seen: (VmWindow | null)[] = []
    const display = new VmDisplay({
      run,
      guest: () => ({ get: async () => ({ width: 1280, height: 800, scale: 100, adapter: ADAPTER }), set: async (m) => (answered.resolve(m), { ...m, adapter: ADAPTER, taken: true }) }),
      // the service is stopped while the box waits for QEMU's window: what the file says then is what the next start reads
      screen: { size: { width: 1280, height: 800 }, resize: async () => {}, windowSize: () => (seen.push(readGuestScreen(run)), new Promise(() => {})), engines: { lease: async () => null, stopAll: async () => {} } },
      relay: { endWhere: () => 0 },
      isVm: () => true
    })
    void display.set({ width: 2560, height: 1600, scale: 200 })
    await answered.promise
    await tick()
    expect(seen[0]).toEqual({ width: 2560, height: 1600 })
    expect(r.log).toEqual([])
  })
})

describe('one change at a time', () => {
  it('two asks at once: the second waits for the first, and the guest is never asked twice at once', async () => {
    const r = rig()
    const [a, b] = await Promise.all([r.display.set({ width: 2560, height: 1600, scale: 200 }), r.display.set({ width: 1920, height: 1200, scale: 175 })])
    expect([a.width, b.width]).toEqual([2560, 1920])
    expect(r.most()).toBe(1)
    expect(r.log).toEqual(['x 2560x1600', 'set 2560x1600', 'end resized', 'stop engines', 'set 1920x1200', 'end resized', 'stop engines', 'x 1920x1200'])
    expect(readGuestScreen(run)).toEqual({ width: 1920, height: 1200 })
  })

  it('a lease asked during a change waits for its end, and gets an engine of the new size', async () => {
    const gate = deferred()
    const r = rig({ set: async (m) => (await gate.promise, { ...m, taken: true }) })
    const change = r.display.set({ width: 2560, height: 1600, scale: 200 })
    await tick()
    let leased: string | null = null
    const lease = r.display.lease().then((l) => (leased = l!.token))
    await tick()
    expect(leased).toBeNull()
    gate.resolve()
    await change
    await lease
    expect(leased).toBe('2560x1600')
  })

  it('hands out no warm engine of the old size', async () => {
    const r = rig()
    const before = (await r.display.lease())!
    before.release()
    await r.display.set({ width: 2560, height: 1600, scale: 200 })
    const after = (await r.display.lease())!
    expect(after.token).toBe('2560x1600')
    expect(after.port).not.toBe(before.port)
  })

  it('a lease that was starting as a change began gives its engine back and takes one of the new size', async () => {
    // its engine is still starting when the change stops every engine
    const r = rig({ leaseMs: 40 })
    const lease = r.display.lease()
    await r.display.set({ width: 2560, height: 1600, scale: 200 })
    const got = (await lease)!
    // the first engine started under the change and was stopped by it: the lease holds the next
    expect(r.engines.map((e) => e.stopped)).toEqual([true, false])
    expect(got.port).toBe(2)
  })
})

describe('the mode an ask means', () => {
  it('Fit is guestSizeFor with the caps', () => {
    expect(askedMode({ stream: 's', mode: 'fit', width: 1728, height: 1117, scale: 2, detail: 'sharp' })).toEqual(guestSizeFor({ width: 1728, height: 1117 }, 2, 'sharp'))
    expect(askedMode({ stream: 's', mode: 'fit', width: 1728, height: 1117, scale: 2, detail: 'sharp' }, { maxPixels: 4_096_000, maxWidth: 4096, maxHeight: 2400 }).scale).toBeLessThan(200)
  })

  it("is always within what display.set takes: even pixels in GUEST_DISPLAY's bounds, a Windows DPI step", () => {
    const params = COMPUTER_METHODS['display.set'].params
    for (const [width, height] of [[640, 400], [1024, 640], [1728, 1117], [3200, 1800], [3840, 1620], [5000, 600], [600, 1400]])
      for (const scale of [1, 1.5, 2, 3])
        for (const detail of ['sharp', 'faster'] as const) {
          const m = askedMode({ stream: 's', mode: 'fit', width, height, scale, detail })
          expect(params.safeParse(m).success, `${width}x${height} @${scale} ${detail}: ${JSON.stringify(m)}`).toBe(true)
        }
    for (const s of [{ width: 1280, height: 800 }, { width: 1920, height: 1200 }, { width: 2560, height: 1600 }])
      for (const detail of ['sharp', 'faster'] as const) expect(params.safeParse(askedMode({ stream: 's', mode: 'fixed', ...s, detail })).success).toBe(true)
  })

  it('a fixed size is Sharp at the largest scale that keeps 1024×640 points, or 100% Faster', () => {
    const fixed = (width: number, height: number, detail: 'sharp' | 'faster') => askedMode({ stream: 's', mode: 'fixed', width, height, detail })
    expect(fixed(2560, 1600, 'sharp')).toEqual({ width: 2560, height: 1600, scale: 200 })
    expect(fixed(1920, 1200, 'sharp')).toEqual({ width: 1920, height: 1200, scale: 175 })
    expect(fixed(1280, 800, 'sharp')).toEqual({ width: 1280, height: 800, scale: 125 })
    expect(fixed(2560, 1600, 'faster')).toEqual({ width: 2560, height: 1600, scale: 100 })
  })
})
