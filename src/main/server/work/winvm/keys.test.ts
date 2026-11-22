import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { evdevKeys } from './window'

/**
 * The display's key codes, against a real X server where the box has one (Xvfb and setxkbmap; skipped on a
 * host without them): afterwards the display names "evdev", with Page Up where the engine presses it. The
 * bundled Xorg, which starts on the old "xfree86" set, is checked by the live picture proof.
 */
const has = existsSync('/usr/bin/Xvfb') && existsSync('/usr/bin/setxkbmap') && existsSync('/usr/bin/xkbcomp')
let server: ChildProcess | null = null
afterAll(() => void server?.kill('SIGKILL'))

const start = (): Promise<string> =>
  new Promise((resolve, reject) => {
    server = spawn('/usr/bin/Xvfb', ['-displayfd', '3', '-screen', '0', '320x240x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] })
    let out = ''
    server.stdio[3]!.on('data', (d: Buffer) => {
      out += d.toString()
      if (out.includes('\n')) resolve(`:${out.trim()}`)
    })
    server.once('exit', () => reject(new Error('Xvfb did not start')))
  })

describe("the Windows VM display's key codes", () => {
  it.skipIf(!has)('leaves a display naming the evdev key codes, with Page Up and Left where the engine presses them', async () => {
    const DISPLAY = await start()
    const env = { PATH: '/usr/bin:/bin', DISPLAY }
    const code = (key: string): number => Number(new RegExp(`<${key}> = (\\d+);`).exec(execFileSync('xkbcomp', [DISPLAY, '-'], { env, stdio: ['ignore', 'pipe', 'ignore'] }).toString())?.[1])
    expect(await evdevKeys({ DISPLAY, XAUTHORITY: '' })).toBeNull()
    expect(execFileSync('setxkbmap', ['-print'], { env }).toString()).toMatch(/xkb_keycodes[^\n]*evdev/)
    // HID Page Up is evdev 104, Left 105: the engine presses them at those codes plus 8
    expect(code('PGUP')).toBe(112)
    expect(code('LEFT')).toBe(113)
    // in the old xfree86 set 112 is keypad "/", which is what reached the guest before
    expect(code('KPDV')).not.toBe(112)
  }, 20_000)

  it.skipIf(!has)('says why when the display cannot be reached, rather than throwing', async () => {
    expect(await evdevKeys({ DISPLAY: ':987', XAUTHORITY: '' })).toMatch(/\S/)
  })
})
