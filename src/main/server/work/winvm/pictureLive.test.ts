import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LOCAL_PRINCIPAL } from '@shared/capabilities'
import type { WinvmState } from '@shared/contract-work-winvm'
import { encodeAck, parseFrame, type Frame } from '@shared/video/nsl1'
import type { StreamClaim } from '../../remote/auth'
import { VideoRelay, type ViewerSocket } from '../../video/relay'
import { VideoRpc } from '../../video/rpc'
import { spsReorder, testVideoTools } from '../browser/box/testTools'
import { daemonEnv } from './machine/config'
import { qmp } from './machine/qmp'
import { windowArgs } from './machine/qemu'
import { VM_COMPUTER, VmPicture } from './picture'
import { pictureToolsAt, VmScreen } from './window'

/**
 * The Windows VM's picture, live, with no Windows: the box's own QEMU (no
 * disk, so its firmware draws and then waits) opens its GTK window on the
 * VM's display, and a viewer of `video.open { computer: 'vm:windows' }`
 * gets the engine's frames through the relay. While the machine draws,
 * frames arrive; paused, its screen is still and the stream falls silent.
 * Runs where both tools are installed in the userData the box tests use
 * (testTools.ts `testVideoTools`), and KVM or not.
 */
const video = testVideoTools()
const userData = video ? dirname(dirname(dirname(dirname(video.sys)))) : null
const tools = userData ? pictureToolsAt(userData) : null
const d = tools && tools.missing === null && existsSync('/usr/bin/qemu-system-x86_64') ? describe : describe.skip

class Viewer implements ViewerSocket {
  bufferedAmount = 0
  readonly frames: (Frame & { at: number })[] = []
  closed: number | null = null
  private say: ((data: Buffer, isBinary: boolean) => void) | null = null
  send(bytes: Uint8Array): void {
    const frame = parseFrame(bytes)
    this.frames.push({ ...frame, data: frame.data.slice(), at: Date.now() })
    this.say?.(Buffer.from(encodeAck(frame.generation, frame.sequence, 0)), true)
  }
  close(code: number): void {
    this.closed ??= code
  }
  on(event: 'message' | 'close', fn: never): void {
    if (event === 'message') this.say = fn
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

d('the Windows VM picture, live', () => {
  let root: string
  let screen: VmScreen
  let qemu: ChildProcess | null = null
  let picture: VmPicture
  const relay = new VideoRelay()
  const minted: StreamClaim[] = []
  const rpc = new VideoRpc(relay, { mintStreamTicket: (claim) => (minted.push(claim), { ticket: 't', expiresIn: 30 }) }, () => true)
  const state: WinvmState = { state: 'awake', step: null, error: null, cannot: null, sleepAfter: '30m', since: Date.now() }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'tc-vm-picture-'))
    symlinkSync(join(userData!, 'work-tools'), join(root, 'work-tools'))
    screen = new VmScreen({ root: join(root, 'winvm', 'picture'), tools: () => pictureToolsAt(root) })
    const shown = await screen.up()
    expect(shown).not.toBeNull()
    qemu = spawn('qemu-system-x86_64', ['-machine', 'q35,accel=kvm:tcg', '-nodefaults', '-m', '128M', '-vga', 'std', ...windowArgs(shown!.window), '-qmp', `unix:${join(root, 'qmp.sock')},server=on,wait=off`], {
      env: { ...daemonEnv(), ...shown!.env },
      stdio: 'ignore'
    })
    picture = new VmPicture({
      state: () => state,
      onState: () => () => {},
      setViewers: () => {},
      screen,
      relay,
      screenshot: async () => Buffer.alloc(0),
      jpeg: async () => ({ data: '', width: 1, height: 1 })
    })
    rpc.addSource(picture)
  }, 30_000)

  afterAll(async () => {
    picture?.close()
    qemu?.kill('SIGKILL')
    await screen?.down()
    rmSync(root, { recursive: true, force: true })
  })

  it('plays what QEMU draws, and falls silent while its screen is still', async () => {
    const answer = await rpc.open({ threadId: 'any', computer: VM_COMPUTER, maxEdge: 1280 }, { principal: LOCAL_PRINCIPAL, connection: {}, connectionId: '1' })
    if (!answer.ok) throw new Error(`video.open refused: ${answer.reason}`)
    expect({ width: answer.width, height: answer.height }).toEqual({ width: 1280, height: 800 })
    const viewer = new Viewer()
    expect(relay.attach(minted.at(-1)!, viewer)).toBe(true)
    // the firmware draws as it boots: frames arrive, the first a keyframe that says it reorders nothing
    const end = Date.now() + 15_000
    while (viewer.frames.length < 3 && Date.now() < end) await sleep(50)
    expect(viewer.frames.length).toBeGreaterThanOrEqual(3)
    expect(viewer.frames[0]!.keyframe).toBe(true)
    expect(spsReorder(viewer.frames[0]!.data)).toEqual({ restriction: true, reorder: 0 })
    // paused, nothing on its screen changes: once the last change is out, no frame comes
    await qmp(join(root, 'qmp.sock'), { execute: 'stop' })
    await sleep(1_500)
    const at = viewer.frames.length
    await sleep(3_000)
    expect(viewer.frames.length - at).toBe(0)
    // running again, its text cursor blinks: frames again
    await qmp(join(root, 'qmp.sock'), { execute: 'cont' })
    const again = Date.now() + 5_000
    while (viewer.frames.length === at && Date.now() < again) await sleep(50)
    expect(viewer.frames.length).toBeGreaterThan(at)
    expect(viewer.closed).toBeNull()
  }, 40_000)
})
