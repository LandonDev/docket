import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeAck, encodeFrame, encodeInput, parseInput } from '@shared/video/nsl1'
import type { VideoCloseReason } from '@shared/contract-video'
import { BoxEngines, ENGINE_MAX, engineArgs, freePort, type EngineLease } from './engine'
import { EngineFeed, type NeverSent, engineUrl } from './engineFeed'
import type { VideoTools } from './videoSetting'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tc-box-engine-'))
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

const TOOLS = (): VideoTools => ({ engine: '/t/pkg/relay-engine', xorg: '/t/sys/usr/lib/xorg/Xorg', xclip: '/t/sys/usr/bin/xclip', sys: '/t/sys', viewer: join(root, 'viewer') })
const DISPLAY = { DISPLAY: ':7', XAUTHORITY: '/d/Xauthority' }

type FakeChild = ChildProcess & { say(line: string): void; die(code?: number): void; signals: string[] }
function fakeEngines(ready = true) {
  const calls: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[] = []
  const made: FakeChild[] = []
  const spawn = ((cmd: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    calls.push({ cmd, args, env: options.env })
    const child = new EventEmitter() as FakeChild
    const stdout = new PassThrough()
    Object.assign(child, { pid: 5000 + made.length, exitCode: null, signalCode: null, stdout, stderr: new PassThrough(), signals: [] as string[] })
    child.say = (line) => void stdout.write(`${line}\n`)
    child.die = (code = 0) => {
      if (child.exitCode !== null) return
      ;(child as { exitCode: number | null }).exitCode = code
      child.emit('exit', code, null)
    }
    child.kill = ((signal: string) => {
      child.signals.push(signal)
      setImmediate(() => child.die())
      return true
    }) as never
    made.push(child)
    if (ready) setImmediate(() => child.say(`{"ready":true,"pid":${child.pid},"port":1}`))
    return child
  }) as never
  let port = 41000
  return { spawn, calls, made, port: async () => port++ }
}

describe('the engine’s flags', () => {
  it('captures the display it is handed, on loopback alone, at 120, behind a token file', () => {
    const args = engineArgs({ port: 4100, tokenFile: '/e/token-1', viewer: '/t/viewer' }).join(' ')
    expect(args).toContain('--backend x11')
    expect(args).toContain('--bind 127.0.0.1')
    expect(args).toContain('--port 4100')
    expect(args).toContain('--fps 120')
    expect(args).toContain('--bitrate-min 1000000 --bitrate-start 8000000 --bitrate-max 20000000')
    expect(args).toContain('--token-file /e/token-1')
    expect(args).toContain('--behind-tls-proxy')
    expect(args).toContain('--viewer-dir /t/viewer')
    // never open to another machine, never without its token
    expect(args).not.toContain('--insecure-local')
    expect(args).not.toContain('0.0.0.0')
  })
  it('a watcher’s address owns no input; a driver’s does', () => {
    expect(engineUrl(4100, false)).toBe('ws://127.0.0.1:4100/stream?view=1')
    expect(engineUrl(4100, true)).toBe('ws://127.0.0.1:4100/stream')
  })
  it('finds a port on loopback', async () => {
    expect(await freePort()).toBeGreaterThan(1024)
  })
})

describe('BoxEngines', () => {
  const pool = (fake: ReturnType<typeof fakeEngines>, over: Partial<ConstructorParameters<typeof BoxEngines>[0]> = {}) =>
    new BoxEngines({ root, tools: TOOLS, display: () => DISPLAY, spawn: fake.spawn, port: fake.port, ...over })

  it('starts an engine on the first viewer, on the browser’s display and no other, its token in a file only this user reads', async () => {
    const before = process.env.DISPLAY
    process.env.DISPLAY = ':99'
    try {
      const fake = fakeEngines()
      const engines = pool(fake)
      expect(engines.count).toBe(0)
      const lease = (await engines.lease())!
      expect(engines.count).toBe(1)
      expect(lease.port).toBe(41000)
      expect(lease.token).toMatch(/^[0-9a-f]{64}$/)
      const call = fake.calls[0]
      expect(call.cmd).toBe('/t/pkg/relay-engine')
      expect(call.env.DISPLAY).toBe(':7')
      expect(call.env.XAUTHORITY).toBe('/d/Xauthority')
      expect(call.env.LD_LIBRARY_PATH).toBe('/t/sys/usr/lib/x86_64-linux-gnu')
      const tokenFile = call.args[call.args.indexOf('--token-file') + 1]
      expect(readFileSync(tokenFile, 'utf8')).toBe(lease.token)
      expect(statSync(tokenFile).mode & 0o777).toBe(0o600)
      // the token is in the file, never on the command line
      expect(call.args.join(' ')).not.toContain(lease.token)
      // the viewer folder the engine insists on exists
      expect(existsSync(join(root, 'viewer'))).toBe(true)
      await engines.stopAll()
      expect(existsSync(tokenFile)).toBe(false)
    } finally {
      if (before === undefined) delete process.env.DISPLAY
      else process.env.DISPLAY = before
    }
  })

  it('gives each viewer an engine of its own, four at most, and a fifth none', async () => {
    const fake = fakeEngines()
    const engines = pool(fake)
    const leases: EngineLease[] = []
    for (let i = 0; i < ENGINE_MAX; i++) leases.push((await engines.lease())!)
    expect(new Set(leases.map((l) => l.port)).size).toBe(4)
    expect(new Set(leases.map((l) => l.token)).size).toBe(4)
    expect(await engines.lease()).toBeNull()
    leases[2].release()
    expect((await engines.lease())!.port).toBe(leases[2].port)
    expect(fake.calls).toHaveLength(4)
    await engines.stopAll()
  })

  it('keeps an engine sixty seconds after its viewer left, hands it warm to the next, then stops it', async () => {
    const fake = fakeEngines()
    const engines = pool(fake, { idleMs: 60_000 })
    const first = (await engines.lease())!
    vi.useFakeTimers()
    first.release()
    first.release()
    vi.advanceTimersByTime(59_000)
    const second = (await engines.lease())!
    expect(second.port).toBe(first.port)
    expect(fake.calls).toHaveLength(1)
    // held again: the clock that would stop it is gone
    vi.advanceTimersByTime(120_000)
    expect(fake.made[0].signals).toEqual([])
    second.release()
    vi.advanceTimersByTime(60_000)
    expect(fake.made[0].signals).toEqual(['SIGTERM'])
    vi.useRealTimers()
    await new Promise((r) => setImmediate(r))
    expect(engines.count).toBe(0)
  })

  it('tells a viewer whose engine exits, and starts the next one only after a pause', async () => {
    const fake = fakeEngines()
    let now = 1_000_000
    const engines = pool(fake, { now: () => now })
    const lease = (await engines.lease())!
    const exits: string[] = []
    lease.onExit(() => exits.push('gone'))
    fake.made[0].die(1)
    expect(exits).toEqual(['gone'])
    expect(engines.count).toBe(0)
    // the first restart waits half a second from the crash
    const started = Date.now()
    await engines.lease()
    expect(Date.now() - started).toBeGreaterThanOrEqual(450)
    // a quiet two minutes forgets the crash
    fake.made[1].die(1)
    now += 121_000
    const again = Date.now()
    await engines.lease()
    expect(Date.now() - again).toBeLessThan(300)
    await engines.stopAll()
  })

  it('fails with the engine’s own last words when it does not come up, and leaves nothing behind', async () => {
    const fake = fakeEngines(false)
    const engines = pool(fake, { startMs: 50 })
    const dying = engines.lease()
    await new Promise((r) => setImmediate(r))
    ;(fake.made[0].stderr as PassThrough).write('x264 [info]: something\nCapture startup failed: no display\n')
    await new Promise((r) => setImmediate(r))
    fake.made[0].die(1)
    await expect(dying).rejects.toThrow('the engine exited as it started (1): Capture startup failed: no display')
    expect(engines.count).toBe(0)
    const tokens = join(root, 'engine')
    expect(existsSync(join(tokens, 'token-1'))).toBe(false)
    await expect(pool(fakeEngines(false), { startMs: 30 }).lease()).rejects.toThrow('did not come up in time')
  })

  it('starts nothing when the browser is not on its display', async () => {
    const fake = fakeEngines()
    await expect(pool(fake, { display: () => null }).lease()).rejects.toThrow('not on its display')
    await expect(pool(fake, { tools: () => null }).lease()).rejects.toThrow('not on its display')
    expect(fake.calls).toEqual([])
  })
})

/** The engine's end of a socket, as a WebSocket the feed can hold. */
class FakeEngineSocket extends EventTarget {
  binaryType = 'blob'
  readyState = 1
  readonly sent: Uint8Array[] = []
  constructor(
    readonly url: string,
    readonly protocols: string[]
  ) {
    super()
  }
  send(bytes: Uint8Array): void {
    this.sent.push(bytes)
  }
  close(): void {
    this.readyState = 3
  }
  frame(bytes: Uint8Array): void {
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    this.dispatchEvent(Object.assign(new Event('message'), { data: copy }))
  }
  drop(): void {
    this.readyState = 3
    this.dispatchEvent(new Event('close'))
  }
}

describe('EngineFeed', () => {
  function rig(drive: boolean, rules: NeverSent = 'browser') {
    const exits: (() => void)[] = []
    let released = 0
    const lease: EngineLease = { port: 4100, token: 'f'.repeat(64), pid: null, onExit: (fn) => void exits.push(fn), release: () => void released++ }
    let socket!: FakeEngineSocket
    const told = { input: 0, close: 0 }
    const feed = new EngineFeed(lease, drive, (url, protocols) => (socket = new FakeEngineSocket(url, protocols)) as unknown as WebSocket, { input: () => void told.input++, close: () => void told.close++ }, rules)
    const frames: Uint8Array[] = []
    const ends: VideoCloseReason[] = []
    feed.start({ frame: (b) => frames.push(b), end: (r) => ends.push(r) })
    return { feed, socket: () => socket, frames, ends, exits, released: () => released, told }
  }
  const FRAME = (generation: number, sequence: number): Uint8Array => encodeFrame({ generation, sequence, keyframe: sequence === 1, width: 1280, height: 800, timestamp: 1, data: Uint8Array.of(1, 2, 3) })

  it('offers the token as a subprotocol, never in the address, and asks for a watcher’s socket', () => {
    const r = rig(false)
    expect(r.socket().url).toBe('ws://127.0.0.1:4100/stream?view=1')
    expect(r.socket().protocols).toEqual(['nsl1', `bearer.${'f'.repeat(64)}`])
    expect(r.socket().url).not.toContain('f'.repeat(8))
    expect(r.socket().binaryType).toBe('arraybuffer')
  })

  it('passes frames up and acks down as they are', () => {
    const r = rig(false)
    r.socket().frame(FRAME(3, 1))
    r.socket().frame(FRAME(3, 2))
    expect(r.frames.map((b) => [...b])).toEqual([[...FRAME(3, 1)], [...FRAME(3, 2)]])
    const ack = encodeAck(3, 1, 4)
    r.feed.ack(ack)
    expect([...r.socket().sent[0]]).toEqual([...ack])
  })

  it('a watcher’s feed sends no input, his or this host’s', () => {
    const r = rig(false)
    r.socket().frame(FRAME(3, 1))
    r.feed.input(encodeInput({ type: 'keyDown', key: 4 }, 3))
    expect(r.feed.type({ type: 'releaseAll' })).toBe(false)
    expect(r.socket().sent).toEqual([])
    expect(r.told.input).toBe(0)
  })

  it('a driver’s feed is the engine’s input socket: his records pass, and this host’s are numbered for the connection', () => {
    const r = rig(true)
    expect(r.socket().url).toBe('ws://127.0.0.1:4100/stream')
    // before the first frame the connection has no number: nothing made here can be sent
    expect(r.feed.type({ type: 'releaseAll' })).toBe(false)
    r.socket().frame(FRAME(9, 1))
    const his = encodeInput({ type: 'pointerMove', x: 0.5, y: 0.5 }, 9)
    r.feed.input(his)
    expect(r.feed.type({ type: 'keyDown', key: 224 })).toBe(true)
    expect([...r.socket().sent[0]]).toEqual([...his])
    expect(new DataView(r.socket().sent[1].buffer).getUint32(8)).toBe(9)
    expect(parseInput(r.socket().sent[1])).toMatchObject({ type: 'keyDown', key: 224 })
    // only his own input is told of: a menu that opens after it is his
    expect(r.told.input).toBe(1)
  })

  it('passes the engine only what it takes: it drops a connection that sends anything else', () => {
    const r = rig(true)
    // before the first frame the connection has no number: nothing can be right
    r.feed.ack(encodeAck(1, 1))
    r.feed.input(encodeInput({ type: 'keyDown', key: 4 }, 1))
    expect(r.socket().sent).toEqual([])
    r.socket().frame(FRAME(9, 1))
    // another connection's number, an ack of a third size, an input with a sequence: none reaches the engine
    r.feed.ack(encodeAck(8, 1))
    r.feed.input(encodeInput({ type: 'keyDown', key: 4 }, 8))
    r.feed.input(encodeInput({ type: 'keyDown', key: 4 }, 9, 3))
    r.feed.ack(Uint8Array.from([...encodeAck(9, 1, 2), 0, 0]))
    r.feed.input(encodeAck(9, 1))
    expect(r.socket().sent).toEqual([])
    r.feed.ack(encodeAck(9, 1))
    r.feed.ack(encodeAck(9, 1, 2))
    r.feed.input(encodeInput({ type: 'keyDown', key: 4 }, 9))
    expect(r.socket().sent).toHaveLength(3)
  })

  it('never passes the chords that would close, quit or leave the shared browser, whoever sends them', () => {
    const r = rig(true)
    r.socket().frame(FRAME(9, 1))
    const send = (event: Parameters<typeof encodeInput>[0]): void => r.feed.input(encodeInput(event, 9))
    const keys = (): string[] => r.socket().sent.map((b) => parseInput(b)).map((e) => ('key' in e ? `${e.type === 'keyDown' ? '+' : '-'}${e.key}` : e.type))
    // Ctrl held by its own record, the letters with no modifier said: the engine would still press Ctrl+W
    send({ type: 'keyDown', key: 224 })
    for (const key of [26, 20, 17, 23]) send({ type: 'keyDown', key })
    send({ type: 'keyDown', key: 4 })
    send({ type: 'keyUp', key: 224 })
    // with Ctrl let go, W is a letter again
    send({ type: 'keyDown', key: 26 })
    expect(keys()).toEqual(['+224', '+4', '-224', '+26'])
    // Ctrl+Shift+I, by the right-hand keys; Ctrl+I alone is the page's
    r.socket().sent.length = 0
    send({ type: 'keyDown', key: 228 })
    send({ type: 'keyDown', key: 12 })
    send({ type: 'keyDown', key: 229 })
    send({ type: 'keyDown', key: 12 })
    expect(keys()).toEqual(['+228', '+12', '+229'])
    // a record that only says Ctrl is held is refused the same way
    r.socket().sent.length = 0
    send({ type: 'releaseAll' })
    send({ type: 'keyDown', key: 26, modifiers: 1 })
    expect(keys()).toEqual(['releaseAll'])
  })

  it("on the Windows VM passes every chord of the guest's, and never QEMU's own window's or a typed character", () => {
    const r = rig(true, 'vm')
    r.socket().frame(FRAME(9, 1))
    const send = (event: Parameters<typeof encodeInput>[0]): void => r.feed.input(encodeInput(event, 9))
    const keys = (): string[] => r.socket().sent.map((b) => parseInput(b)).map((e) => ('key' in e ? `${e.type === 'keyDown' ? '+' : '-'}${e.key}` : e.type))
    // Ctrl+W, Q, N, T and Ctrl+Shift+I are his in the guest
    send({ type: 'keyDown', key: 224 })
    for (const key of [26, 20, 17, 23]) send({ type: 'keyDown', key })
    send({ type: 'keyDown', key: 225 })
    send({ type: 'keyDown', key: 12 })
    expect(keys()).toEqual(['+224', '+26', '+20', '+17', '+23', '+225', '+12'])
    // with Alt as well, QEMU's window would take Q (quit), F, G, M, U, the zoom keys and 1 to 9; Delete is the guest's
    r.socket().sent.length = 0
    send({ type: 'releaseAll' })
    send({ type: 'keyDown', key: 224 })
    send({ type: 'keyDown', key: 226 })
    for (const key of [20, 9, 10, 16, 24, 39, 45, 46, 30, 38]) send({ type: 'keyDown', key })
    send({ type: 'keyDown', key: 76 })
    expect(keys()).toEqual(['releaseAll', '+224', '+226', '+76'])
    // a record that only says Ctrl and Alt are held, by the right-hand Alt, is refused the same way
    r.socket().sent.length = 0
    send({ type: 'releaseAll' })
    send({ type: 'keyDown', key: 20, modifiers: 0x11 | 0x40 })
    send({ type: 'keyDown', key: 20 })
    expect(keys()).toEqual(['releaseAll', '+20'])
    // a typed character never: QEMU reads keycodes, and the engine's spare one lands as the wrong key
    r.socket().sent.length = 0
    send({ type: 'text', codepoint: 0xe9 })
    expect(r.socket().sent).toEqual([])
  })

  it('lets go of what he holds with a record numbered for its own connection', () => {
    const r = rig(true)
    r.feed.release()
    expect(r.socket().sent).toEqual([])
    r.socket().frame(FRAME(7, 1))
    r.feed.release()
    expect(parseInput(r.socket().sent[0])).toEqual({ type: 'releaseAll' })
    expect(new DataView(r.socket().sent[0].buffer).getUint32(8)).toBe(7)
    // a watcher's feed holds nothing to let go
    const w = rig(false)
    w.socket().frame(FRAME(7, 1))
    w.feed.release()
    expect(w.socket().sent).toEqual([])
  })

  it('says slow when the engine closes the stream, and error when the engine itself exits', () => {
    const slow = rig(false)
    slow.socket().drop()
    expect(slow.ends).toEqual(['slow'])
    const dead = rig(false)
    dead.exits[0]()
    expect(dead.ends).toEqual(['error'])
  })

  it('lets its engine go once, and says nothing after it was closed', () => {
    const r = rig(false)
    r.feed.close()
    r.feed.close()
    expect(r.released()).toBe(1)
    expect(r.socket().readyState).toBe(3)
    r.socket().frame(FRAME(1, 1))
    r.socket().drop()
    r.feed.ack(encodeAck(1, 1))
    expect(r.frames).toEqual([])
    expect(r.ends).toEqual([])
    expect(r.socket().sent).toEqual([])
  })
})
