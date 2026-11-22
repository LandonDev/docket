import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LOCAL_PRINCIPAL } from '@shared/capabilities'
import type { WinvmState } from '@shared/contract-work-winvm'
import { encodeAck, encodeInput, parseFrame, type InputEvent } from '@shared/video/nsl1'
import { configureComputerDrive, driveComputer } from '../../computer/drive'
import type { StreamClaim } from '../../remote/auth'
import { VideoRelay, type ViewerSocket } from '../../video/relay'
import { VideoRpc } from '../../video/rpc'
import { testVideoTools } from '../browser/box/testTools'
import { vmWheel } from './drive'
import { VmLease } from './lease'
import { encodePowerShell } from './machine/guest'
import { VM_COMPUTER, VmPicture } from './picture'
import { SshGuest } from './sshGuest'
import { StandingMachine } from './standing'
import { pictureToolsAt, VmScreen } from './window'

/**
 * His Take over of the Windows VM, live, on the STANDING machine with a fresh disk: QEMU's window on the VM's
 * display, the real engine, the relay and the `vm` hook. His click and keys go engine → X → QEMU → Windows and land
 * in Notepad; Ctrl+N and Ctrl+W (the browser's never-sent chords) reach the guest; QEMU's own Ctrl+Alt+Q never does;
 * Hand back lets go of a key he held. The disk is deleted after. Runs only with TC_WINVM_STANDING=1 where both tools
 * are installed, and only when the standing machine has no disk (another thread's).
 */

const video = testVideoTools()
const userData = video ? dirname(dirname(dirname(dirname(video.sys)))) : null
const tools = userData ? pictureToolsAt(userData) : null
const d = process.env.TC_WINVM_STANDING === '1' && tools?.missing === null ? describe : describe.skip

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** A driver's viewer: acks every frame, and sends his input numbered for the engine's connection. */
class Driver implements ViewerSocket {
  bufferedAmount = 0
  generation = 0
  frames = 0
  private say: ((data: Buffer, isBinary: boolean) => void) | null = null
  send(bytes: Uint8Array): void {
    const f = parseFrame(bytes)
    this.generation = f.generation
    this.frames++
    this.say?.(Buffer.from(encodeAck(f.generation, f.sequence, 0)), true)
  }
  close(): void {}
  on(event: 'message' | 'close', fn: never): void {
    if (event === 'message') this.say = fn
  }
  input(event: InputEvent): void {
    this.say?.(Buffer.from(encodeInput(event, this.generation)), true)
  }
  /** a chord: down in order, up in reverse */
  async keys(...keys: number[]): Promise<void> {
    for (const key of keys) this.input({ type: 'keyDown', key })
    for (const key of [...keys].reverse()) this.input({ type: 'keyUp', key })
    await sleep(150)
  }
  async type(text: string): Promise<void> {
    for (const ch of text) await this.keys(4 + ch.charCodeAt(0) - 97)
  }
}

/** Notepad's edit controls on tcuser's desktop: how many (one a tab) and the text of the one shown. */
const READ = [
  'Add-Type @"',
  'using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;',
  'public static class N {',
  '  public delegate bool EnumProc(IntPtr h, IntPtr l);',
  '  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);',
  '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, StringBuilder l);',
  '  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);',
  '  public static string Read(IntPtr top) {',
  '    int count = 0; string shown = "";',
  '    EnumChildWindows(top, (h, l) => { var c = new StringBuilder(256); GetClassName(h, c, 256);',
  '      if (c.ToString().StartsWith("RichEdit")) { count++; if (IsWindowVisible(h)) { int n = (int)SendMessage(h, 0x0E, IntPtr.Zero, IntPtr.Zero); var s = new StringBuilder(n + 1); SendMessage(h, 0x0D, (IntPtr)(n + 1), s); shown = s.ToString(); } }',
  '      return true; }, IntPtr.Zero);',
  '    return "edits=" + count + "\\ntext=" + shown;',
  '  }',
  '}',
  '"@',
  '$p = Get-Process notepad -ErrorAction SilentlyContinue | Where-Object MainWindowHandle -ne 0 | Select-Object -First 1',
  'if (-not $p) { "edits=none"; exit 0 }',
  '[N]::Read($p.MainWindowHandle)'
].join('\n')

d('his Take over of the Windows VM, live', () => {
  const root = mkdtempSync(join(tmpdir(), 'tc-vm-drive-'))
  symlinkSync(join(userData ?? '/nonexistent', 'work-tools'), join(root, 'work-tools'))
  const screen = new VmScreen({ root: join(root, 'winvm', 'picture'), tools: () => pictureToolsAt(root) })
  const machine = new StandingMachine('standing', process.env, screen)
  const guest = new SshGuest(machine.c, machine.p)
  const relay = new VideoRelay()
  const minted: StreamClaim[] = []
  const rpc = new VideoRpc(relay, { mintStreamTicket: (c) => (minted.push(c), { ticket: 't', expiresIn: 30 }) }, () => true)
  const state: WinvmState = { state: 'awake', step: null, error: null, cannot: null, sleepAfter: 'never', since: Date.now() }
  const picture = new VmPicture({ state: () => state, onState: () => () => {}, setViewers: () => {}, screen, relay, screenshot: async () => Buffer.alloc(0), jpeg: async () => ({ data: '', width: 1, height: 1 }) })
  const lease = new VmLease({ pane: (id) => id, title: (id) => id, wake: () => {} })
  const me = { principal: LOCAL_PRINCIPAL, connection: {}, connectionId: '1' }
  const read = async (): Promise<{ edits: string; text: string }> => {
    const out = await guest.onDesktop(['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(READ)], true, 90)
    return { edits: /edits=(\S+)/.exec(out)?.[1] ?? '?', text: /text=(.*)/.exec(out)?.[1]?.trim() ?? '' }
  }
  /** Take over, and his drive stream joined */
  const take = async (): Promise<Driver> => {
    await driveComputer('vm:windows', 'owner')
    const answer = await rpc.open({ threadId: 'his', computer: VM_COMPUTER, maxEdge: 1280, drive: true }, me)
    if (!answer.ok) throw new Error(`video.open refused: ${answer.reason}`)
    const driver = new Driver()
    expect(relay.attach(minted.at(-1)!, driver)).toBe(true)
    const end = Date.now() + 10_000
    while (!driver.generation && Date.now() < end) await sleep(50)
    return driver
  }

  beforeAll(async () => {
    if (machine.running() || machine.hasDisk()) throw new Error('the standing machine is in use or has a disk; this run starts from none')
    rpc.addSource(picture)
    configureComputerDrive('vm', vmWheel({ picture, lease, keeper: () => ({ state: () => state, setDriving: () => {}, wake: async () => state }), sessions: () => [] }))
    await machine.makeDisk()
    await machine.start()
    await guest.ready(300_000)
    expect(screen.env).not.toBeNull()
    await guest.onDesktop(['powershell.exe', '-NoProfile', '-WindowStyle', 'Hidden', '-Command', 'Start-Process notepad -WindowStyle Maximized'], false)
    await sleep(8000)
  }, 420_000)

  afterAll(async () => {
    configureComputerDrive('vm', null)
    picture.close()
    if (machine.running()) {
      await guest.admin('shutdown /s /f /t 0').catch(() => {})
      if (!(await machine.stopped(120_000))) await machine.forceStop()
      await machine.keepTpm().catch(() => {})
    }
    await screen.down()
    if (!machine.running()) {
      rmSync(machine.c.dir, { recursive: true, force: true })
      rmSync(machine.c.tpmDir, { recursive: true, force: true })
    }
    rmSync(root, { recursive: true, force: true })
  }, 240_000)

  it('lands his click and keys in Notepad, passes Ctrl+N and Ctrl+W to the guest, keeps Ctrl+Alt+Q from QEMU, and lets go at Hand back', async () => {
    let driver = await take()
    expect(lease.owns()).toBe(true)
    // a click in the maximized Notepad's page, then his keys
    driver.input({ type: 'pointerMove', x: 0.5, y: 0.5 })
    driver.input({ type: 'buttonDown', button: 1, x: 0.5, y: 0.5 })
    driver.input({ type: 'buttonUp', button: 1, x: 0.5, y: 0.5 })
    await sleep(300)
    await driver.type('hello')
    await sleep(500)
    expect(await read()).toEqual({ edits: '1', text: 'hello' })
    // Ctrl+N opens a tab and Ctrl+W closes it: the guest's, never kept as the browser's are
    await driver.keys(224, 17)
    await sleep(1500)
    const two = await read()
    expect(two.edits).toBe('2')
    await driver.keys(224, 26)
    await sleep(1500)
    expect(await read()).toEqual({ edits: '1', text: 'hello' })
    // QEMU's own Ctrl+Alt+Q would quit it: never sent, and the machine runs on
    await driver.keys(224, 226, 20)
    await sleep(2000)
    expect(machine.running()).toBe(true)
    // Shift held at Hand back is let go: his next 'a' is a small one, and the watch stream he had takes no keys
    driver.input({ type: 'keyDown', key: 225 })
    await sleep(200)
    await driveComputer('vm:windows', 'agent')
    expect(lease.owns()).toBe(false)
    await driver.type('z')
    driver = await take()
    await driver.type('a')
    await sleep(500)
    expect((await read()).text).toBe('helloa')
    await driveComputer('vm:windows', 'agent')
  }, 300_000)
})
