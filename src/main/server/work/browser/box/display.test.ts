import { execFileSync, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BoxXDisplay, DISPLAY_HZ, DISPLAY_SCALE, PAGE_HEIGHT, PAGE_WIDTH, displayEnv, displayPixels, withoutDisplay, xauthorityEntry, xorgArgs, xorgConfig } from './display'
import { modeInfo, modeName, parseCrtc, parseResources } from './randr'
import { testVideoTools } from './testTools'
import { XClient } from './xclient'
import { videoToolsEnv, type VideoTools } from './videoSetting'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tc-box-display-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const TOOLS: VideoTools = { engine: '/t/pkg/relay-engine', xorg: '/t/sys/usr/lib/xorg/Xorg', xclip: '/t/sys/usr/bin/xclip', sys: '/t/sys', viewer: '/t/pkg/dist/viewer' }

describe('the display the box browser draws on', () => {
  it('is one mode of 1280×800 at 120 Hz on the dummy driver, with none of the host’s input devices', () => {
    const conf = xorgConfig()
    expect(conf).toContain('Driver "dummy"')
    expect(conf).toContain(`Virtual ${PAGE_WIDTH} ${PAGE_HEIGHT}`)
    expect(conf).toContain('Option "AutoAddDevices" "false"')
    expect(conf).toContain('Option "DontVTSwitch" "true"')
    const [, clock, hd, , , ht, vd, , , vt] = /Modeline "m" ([\d.]+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+)/.exec(conf)!.map(Number)
    expect([hd, vd]).toEqual([1280, 800])
    // the refresh rate a mode has is its pixel clock over its total size
    expect((clock * 1e6) / (ht * vt)).toBeCloseTo(DISPLAY_HZ, 1)
    expect(conf.match(/Modeline/g)).toHaveLength(1)
  })

  it('is the page’s 1280×800 times its scale, still at 120 Hz', () => {
    expect(displayPixels(1)).toEqual({ width: 1280, height: 800 })
    expect(displayPixels(2)).toEqual({ width: 2560, height: 1600 })
    expect(displayPixels(1.5)).toEqual({ width: 1920, height: 1200 })
    const conf = xorgConfig(2560, 1600)
    expect(conf).toContain('Virtual 2560 1600')
    expect(conf).toContain('DacSpeed 1000')
    const [, clock, hd, , , ht, vd, , , vt] = /Modeline "m" ([\d.]+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+) (\d+)/.exec(conf)!.map(Number)
    expect([hd, vd]).toEqual([2560, 1600])
    expect((clock * 1e6) / (ht * vt)).toBeCloseTo(DISPLAY_HZ, 1)
    // 2608 × 1610 × 120: about 504 MHz, which the dummy driver must take (the live test below reads its log)
    expect(Math.round(clock)).toBe(504)
  })

  it('takes no TCP, needs the cookie, and picks its own free number', () => {
    const args = xorgArgs({ config: '/d/xorg.conf', auth: '/d/Xauthority', log: '/d/Xorg.log', modules: '/t/modules' })
    expect(args.join(' ')).toContain('-nolisten tcp')
    expect(args.join(' ')).toContain('-auth /d/Xauthority')
    expect(args.join(' ')).toContain('-displayfd 3')
    expect(args.join(' ')).toContain('-modulepath /t/modules')
    // access control is never turned off, and no display number is forced
    expect(args).not.toContain('-ac')
    expect(args.some((a) => /^:\d+$/.test(a))).toBe(false)
  })

  it('writes a cookie that answers for any host name and any display number', () => {
    const cookie = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
    const entry = xauthorityEntry(cookie)
    // family wild, empty address, empty number, the protocol's name, then the 16 bytes
    expect(entry.subarray(0, 6)).toEqual(Buffer.from([0xff, 0xff, 0, 0, 0, 0]))
    expect(entry.readUInt16BE(6)).toBe(18)
    expect(entry.subarray(8, 26).toString()).toBe('MIT-MAGIC-COOKIE-1')
    expect(entry.readUInt16BE(26)).toBe(16)
    expect(entry.subarray(28)).toEqual(cookie)
  })

  it('hands a program its pair and nothing of the server’s own display', () => {
    const mine = { DISPLAY: ':99', XAUTHORITY: '/run/xvfb/auth', WAYLAND_DISPLAY: 'wayland-0', WAYLAND_SOCKET: '5', XDG_SESSION_TYPE: 'x11', HOME: '/home/agents', PATH: '/usr/bin' }
    const env = displayEnv({ DISPLAY: ':7', XAUTHORITY: '/d/Xauthority' }, mine)
    expect(env).toEqual({ DISPLAY: ':7', XAUTHORITY: '/d/Xauthority', HOME: '/home/agents', PATH: '/usr/bin' })
    expect(withoutDisplay(mine)).toEqual({ HOME: '/home/agents', PATH: '/usr/bin' })
    // the caller's own environment is left as it was
    expect(mine.DISPLAY).toBe(':99')
  })
})

/** A stand-in for the server: `say` writes on its fd 3, `die` ends it. */
function fakeServer() {
  const calls: { cmd: string; args: string[]; env: NodeJS.ProcessEnv; stdio: unknown }[] = []
  const made: (ChildProcess & { say(text: string): void; die(): void; signals: string[] })[] = []
  const spawn = ((cmd: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: unknown }) => {
    calls.push({ cmd, args, env: options.env, stdio: options.stdio })
    const fd3 = new PassThrough()
    const child = new EventEmitter() as ChildProcess & { say(text: string): void; die(): void; signals: string[] }
    Object.assign(child, { pid: 4242, exitCode: null, signalCode: null, stdio: [null, null, null, fd3], signals: [] as string[] })
    child.say = (text) => void fd3.write(text)
    child.die = () => {
      ;(child as { exitCode: number | null }).exitCode = 0
      child.emit('exit', 0, null)
    }
    child.kill = ((signal: string) => {
      child.signals.push(signal)
      setImmediate(() => child.die())
      return true
    }) as never
    made.push(child)
    return child
  }) as never
  return { spawn, calls, made }
}

describe('BoxXDisplay', () => {
  it('starts the server with its own libraries and no display of this process, and answers the pair it chose', async () => {
    const before = { DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY }
    process.env.DISPLAY = ':99'
    process.env.XAUTHORITY = '/run/the-servers-own'
    try {
      const fake = fakeServer()
      const display = new BoxXDisplay({ root, tools: TOOLS, spawn: fake.spawn })
      const starting = display.start()
      await new Promise((r) => setImmediate(r))
      expect(display.env).toBeNull()
      fake.made[0].say('37\n')
      expect(await starting).toEqual({ DISPLAY: ':37', XAUTHORITY: join(root, 'display', 'Xauthority') })
      expect(display.env).toEqual({ DISPLAY: ':37', XAUTHORITY: join(root, 'display', 'Xauthority') })
      const call = fake.calls[0]
      expect(call.cmd).toBe(TOOLS.xorg)
      expect(call.env.DISPLAY).toBeUndefined()
      expect(call.env.XAUTHORITY).toBeUndefined()
      expect(call.env.LD_LIBRARY_PATH).toBe(videoToolsEnv(TOOLS).LD_LIBRARY_PATH)
      expect(call.args).toContain(join(root, 'display', 'xorg.conf'))
      // the cookie is a file only this user reads, in a folder only this user opens
      expect(statSync(join(root, 'display', 'Xauthority')).mode & 0o777).toBe(0o600)
      expect(statSync(join(root, 'display')).mode & 0o777).toBe(0o700)
      expect(readFileSync(join(root, 'display', 'Xauthority')).length).toBe(44)
      // a second start is the same server
      expect(await display.start()).toEqual({ DISPLAY: ':37', XAUTHORITY: join(root, 'display', 'Xauthority') })
      expect(fake.calls).toHaveLength(1)
      await display.stop()
      expect(fake.made[0].signals).toEqual(['SIGTERM'])
      expect(display.env).toBeNull()
      expect(existsSync(join(root, 'display', 'Xauthority'))).toBe(false)
    } finally {
      for (const [k, v] of Object.entries(before)) v === undefined ? delete process.env[k] : (process.env[k] = v)
    }
  })

  it('a new server gets a new cookie', async () => {
    const fake = fakeServer()
    const display = new BoxXDisplay({ root, tools: TOOLS, spawn: fake.spawn })
    const one = display.start()
    await new Promise((r) => setImmediate(r))
    const first = readFileSync(join(root, 'display', 'Xauthority'))
    fake.made[0].say('5\n')
    await one
    await display.stop()
    const two = display.start()
    await new Promise((r) => setImmediate(r))
    expect(readFileSync(join(root, 'display', 'Xauthority')).equals(first)).toBe(false)
    fake.made[1].say('5\n')
    await two
    await display.stop()
  })

  it('fails, with nothing left running and no cookie, when the server exits or never says its number', async () => {
    const fake = fakeServer()
    const display = new BoxXDisplay({ root, tools: TOOLS, spawn: fake.spawn, startMs: 40 })
    const dying = display.start()
    await new Promise((r) => setImmediate(r))
    fake.made[0].die()
    await expect(dying).rejects.toThrow('exited as it started')
    expect(display.running).toBe(false)
    const silent = display.start()
    await expect(silent).rejects.toThrow('did not come up in time')
    expect(fake.made[1].signals).toEqual(['SIGTERM'])
    expect(existsSync(join(root, 'display', 'Xauthority'))).toBe(false)
  })

  it('forgets its pair when the server dies under it', async () => {
    const fake = fakeServer()
    const display = new BoxXDisplay({ root, tools: TOOLS, spawn: fake.spawn })
    const starting = display.start()
    await new Promise((r) => setImmediate(r))
    fake.made[0].say('12\n')
    await starting
    fake.made[0].die()
    expect(display.env).toBeNull()
    expect(display.running).toBe(false)
  })
})

const tools = testVideoTools()

/** The opening of an X connection, by hand: 1 when the server lets the client in, else its reason. */
function xHello(display: string, cookie: Buffer | null): Promise<{ ok: boolean; reason: string }> {
  const pad = (b: Buffer): Buffer => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)])
  return new Promise((resolve, reject) => {
    const socket = connect(`/tmp/.X11-unix/X${display.slice(1)}`)
    const name = cookie ? Buffer.from('MIT-MAGIC-COOKIE-1') : Buffer.alloc(0)
    const data = cookie ?? Buffer.alloc(0)
    const head = Buffer.alloc(12)
    head.write('l', 0)
    head.writeUInt16LE(11, 2)
    head.writeUInt16LE(name.length, 6)
    head.writeUInt16LE(data.length, 8)
    socket.on('connect', () => socket.write(Buffer.concat([head, pad(name), pad(data)])))
    socket.on('data', (d) => {
      socket.destroy()
      resolve({ ok: d[0] === 1, reason: d[0] === 0 ? d.subarray(8, 8 + d[1]).toString().trim() : '' })
    })
    socket.on('error', reject)
  })
}

describe('a size change by RandR', () => {
  it('makes a mode with the config’s own small blanking, -hsync +vsync, named by its size', () => {
    const b = modeInfo({ width: 2560, height: 1600 }, 120, 11)
    expect(b.length).toBe(32)
    expect([b.readUInt16LE(4), b.readUInt16LE(6)]).toEqual([2560, 1600])
    // the same clock as xorgConfig's modeline: 2608 × 1610 × 120
    expect(b.readUInt32LE(8)).toBe(2608 * 1610 * 120)
    expect([b.readUInt16LE(12), b.readUInt16LE(14), b.readUInt16LE(16)]).toEqual([2568, 2584, 2608])
    expect([b.readUInt16LE(20), b.readUInt16LE(22), b.readUInt16LE(24)]).toEqual([1603, 1609, 1610])
    expect(b.readUInt16LE(26)).toBe(11)
    expect(b.readUInt32LE(28)).toBe(6)
    expect(modeName({ width: 2560, height: 1600 })).toBe('tc2560x1600')
  })

  it('reads the screen’s CRTCs and its modes by name, and a CRTC’s mode and outputs', () => {
    const names = Buffer.from('mtc2560x1600')
    const r = Buffer.alloc(32 + 2 * 4 + 1 * 4 + 2 * 32 + names.length)
    r.writeUInt32LE(77, 12)
    r.writeUInt16LE(2, 16)
    r.writeUInt16LE(1, 18)
    r.writeUInt16LE(2, 20)
    r.writeUInt32LE(0x40, 32)
    r.writeUInt32LE(0x41, 36)
    r.writeUInt32LE(0x50, 40)
    r.writeUInt32LE(0x60, 44)
    r.writeUInt16LE(1, 44 + 26)
    r.writeUInt32LE(0x61, 76)
    r.writeUInt16LE(11, 76 + 26)
    names.copy(r, 108)
    expect(parseResources(r)).toEqual({ configTime: 77, crtcs: [0x40, 0x41], modes: new Map([['m', 0x60], ['tc2560x1600', 0x61]]) })
    const c = Buffer.alloc(40)
    c.writeUInt16LE(1280, 16)
    c.writeUInt16LE(800, 18)
    c.writeUInt32LE(0x60, 20)
    c.writeUInt16LE(2, 28)
    c.writeUInt32LE(0x50, 32)
    c.writeUInt32LE(0x51, 36)
    expect(parseCrtc(c)).toEqual({ mode: 0x60, width: 1280, height: 800, outputs: [0x50, 0x51] })
  })

  it('is never asked of the box’s browser: only the display itself and RandR name it', () => {
    const dir = 'src/main/server/work/browser/box'
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts') && n !== 'display.ts' && n !== 'randr.ts')) {
      expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(/\.resize\(|resizeDisplay|setScreenSize/)
    }
  })

  it('refuses a display that is not running', async () => {
    await expect(new BoxXDisplay({ root, tools: TOOLS }).resize({ width: 1920, height: 1200 })).rejects.toThrow('not running')
  })
})

describe.skipIf(!tools)('the real server, from the installed tools', () => {
  it('changes size live by RandR, larger and smaller and back, each a size it held before taken again', async () => {
    const display = new BoxXDisplay({ root, tools: tools!, size: { width: 1280, height: 800 } })
    const pair = await display.start()
    const screen = async (): Promise<{ width: number; height: number }> => {
      const x = await XClient.open(pair)
      try {
        const { width, height } = await x.geometry(x.root)
        return { width, height }
      } finally {
        x.close()
      }
    }
    try {
      for (const size of [
        { width: 3456, height: 2234 },
        { width: 4000, height: 2250 },
        // wider and shorter at once
        { width: 1920, height: 1200 },
        { width: 2560, height: 1600 },
        { width: 1280, height: 800 },
        { width: 3456, height: 2234 }
      ]) {
        await display.resize(size)
        expect(await screen()).toEqual(size)
        expect(display.size).toEqual(size)
      }
    } finally {
      await display.stop()
    }
  }, 30_000)


  it('ends a server its folder’s last owner left behind before it starts another', async () => {
    const orphan = new BoxXDisplay({ root, tools: tools! })
    await orphan.start()
    const left = orphan.pid!
    // a host that was killed never stopped its display: a new owner of the folder finds the pid
    const next = new BoxXDisplay({ root, tools: tools! })
    await next.start()
    try {
      for (let i = 0; i < 100; i++) {
        try {
          process.kill(left, 0)
        } catch {
          break
        }
        await new Promise((r) => setTimeout(r, 30))
      }
      expect(() => process.kill(left, 0)).toThrow()
      expect(next.running).toBe(true)
    } finally {
      await next.stop()
      await orphan.stop()
    }
  }, 30_000)


  it('comes up on a free number at 120 Hz, serves a client that holds the cookie, refuses one that does not, and stops clean', async () => {
    const display = new BoxXDisplay({ root, tools: tools! })
    const pair = await display.start()
    try {
      expect(pair.DISPLAY).toMatch(/^:\d+$/)
      const file = readFileSync(pair.XAUTHORITY)
      const cookie = file.subarray(file.length - 16)
      expect(await xHello(pair.DISPLAY, cookie)).toEqual({ ok: true, reason: '' })
      expect(await xHello(pair.DISPLAY, null)).toEqual({ ok: false, reason: 'Authorization required, but no authorization protocol specified' })
      expect(await xHello(pair.DISPLAY, Buffer.alloc(16, 7))).toEqual({ ok: false, reason: 'Invalid MIT-MAGIC-COOKIE-1 key' })
      // it was told to take no TCP, and it listens on none (another program may hold X's usual port, so the server's own sockets are read)
      expect(readFileSync(`/proc/${display.pid}/cmdline`, 'utf8').split('\0').join(' ')).toContain('-nolisten tcp')
      expect(execFileSync('ss', ['-H', '-ltnp']).toString()).not.toContain(`pid=${display.pid},`)
      // the log says the mode it runs
      const log = readFileSync(join(root, 'display', 'Xorg.log'), 'utf8')
      // at the scale it ships with
      const { width, height } = displayPixels(DISPLAY_SCALE)
      expect(log).toContain(`Virtual size is ${width}x${height}`)
      expect(log).toMatch(/Modeline "m"x120\.0/)
    } finally {
      const pid = display.pid!
      await display.stop()
      expect(() => process.kill(pid, 0)).toThrow()
    }
  }, 30_000)

  it.each([
    [2, '2560x1600'],
    [1.5, '1920x1200']
  ])('takes the larger mode at scale %s: %s at 120 Hz, by its own log', async (scale, size) => {
    const display = new BoxXDisplay({ root, tools: tools!, scale })
    await display.start()
    try {
      const log = readFileSync(join(root, 'display', 'Xorg.log'), 'utf8')
      expect(log).toContain(`Virtual size is ${size}`)
      expect(log).toMatch(/Modeline "m"x120\.0/)
      // the driver's 300 MHz cap would refuse it and fall back to a mode of its own
      expect(log).not.toContain('Not using mode "m"')
      expect(log).toContain('using initial mode m +0+0')
    } finally {
      await display.stop()
    }
  }, 30_000)
})
