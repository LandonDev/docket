import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WinvmState } from '@shared/contract-work-winvm'
import { GUEST_SCREEN_SCRIPT, parseGuestScreen, readGuestScreen, watchGuestScreen, writeGuestScreen } from './guestScreen'
import type { VmWindow } from './machine/qemu'

/** The size a resumed Windows keeps: read after each wake, kept beside the disk, and the display put right once. */

let run: string
beforeEach(() => (run = mkdtempSync(join(tmpdir(), 'guest-screen-'))))
afterEach(() => rmSync(run, { recursive: true, force: true }))

const awake = { state: 'awake', step: null, error: null, cannot: null, sleepAfter: 'never', since: 0 } as WinvmState
const settle = () => new Promise((r) => setTimeout(r, 10))

function rig(o: { guest: string; shown: VmWindow | null; free?: boolean }) {
  let fn: ((s: WinvmState | null) => void) | null = null
  const calls: string[] = []
  const keeper = {
    admin: async (script: string) => (calls.push(script === GUEST_SCREEN_SCRIPT ? 'admin' : script), o.guest),
    sleep: async () => void calls.push('sleep'),
    wake: async () => void calls.push('wake')
  }
  const stop = watchGuestScreen({ onState: (f) => ((fn = f), () => (fn = null)), keeper: () => keeper, shown: () => o.shown, run, free: () => o.free ?? true })
  return { calls, tell: (s: WinvmState | null) => fn?.(s), stop }
}

describe("the guest's own screen", () => {
  it("is read from the adapter's words and kept in the run folder", () => {
    expect(parseGuestScreen('1280x800\r\n')).toEqual({ width: 1280, height: 800 })
    expect(parseGuestScreen('')).toBeNull()
    expect(readGuestScreen(run)).toBeNull()
    writeGuestScreen(run, { width: 1920, height: 1200 })
    expect(readGuestScreen(run)).toEqual({ width: 1920, height: 1200 })
  })

  it('is learned at a wake; a display that matches it is left alone', async () => {
    const r = rig({ guest: '1280x800', shown: { width: 1280, height: 800 } })
    r.tell({ ...awake, state: 'waking' })
    await settle()
    expect(r.calls).toEqual([])
    r.tell(awake)
    await settle()
    expect(r.calls).toEqual(['admin'])
    expect(readGuestScreen(run)).toEqual({ width: 1280, height: 800 })
  })

  it('puts a scrambled display right with one sleep and wake when nobody uses the machine', async () => {
    const r = rig({ guest: '1280x800', shown: { width: 1920, height: 1200 } })
    r.tell(awake)
    await settle()
    expect(r.calls).toEqual(['admin', 'sleep', 'wake'])
    // the next start reads it: QEMU and its display at the guest's size
    expect(readGuestScreen(run)).toEqual({ width: 1280, height: 800 })
  })

  it('only records it while a thread holds the machine or he drives: the next wake is right', async () => {
    const r = rig({ guest: '1280x800', shown: { width: 1920, height: 1200 }, free: false })
    r.tell(awake)
    await settle()
    expect(r.calls).toEqual(['admin'])
    expect(readGuestScreen(run)).toEqual({ width: 1280, height: 800 })
  })
})
