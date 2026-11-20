import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rigConfig, rigPaths } from './machine/config'
import { qemuCommand } from './machine/daemons'
import { qemuArgs, windowArgs } from './machine/qemu'
import { pictureToolsAt, VmScreen, windowEnv, WINDOW_TOOL, type PictureTools } from './window'

/** QEMU's window on the VM's own display: its arguments, its environment, and when the machine runs with none. */

const cfg = rigConfig({ WINVM_DIR: '/w' }, 1000, 'standing')
const paths = rigPaths(cfg)
const m = { disk: paths.runDisk, vars: paths.runVars }

describe("QEMU's window", () => {
  it('has none unless it is given one', () => {
    const a = qemuArgs(cfg, paths, m)
    expect(a.join(' ')).toContain('-display none')
  })

  it('is GTK with nothing around the screen, and a close never stops the machine', () => {
    const a = qemuArgs(cfg, paths, { ...m, window: { width: 1280, height: 800 } }).join(' ')
    expect(a).not.toContain('-display none')
    expect(a).toContain('-display gtk,show-menubar=off,show-tabs=off,zoom-to-fit=off,window-close=off')
    // the image's own 1280×800 is the std VGA as it always was: a hibernated guest wakes on the hardware it slept on
    expect(a).toContain('-vga std')
    expect(a).not.toContain('VGA.xres')
  })

  it('tells the same VGA its EDID mode for another size', () => {
    expect(windowArgs({ width: 1920, height: 1200 })).toEqual(['-display', 'gtk,show-menubar=off,show-tabs=off,zoom-to-fit=off,window-close=off', '-global', 'VGA.xres=1920', '-global', 'VGA.yres=1200'])
  })

  it('reaches QEMU through env, with the stop signals blocked, inside sg where the group is missing', () => {
    const env = { DISPLAY: ':3', LD_LIBRARY_PATH: '/t/libs' }
    const [cmd, args] = qemuCommand(cfg, paths, m, { blockStop: true, env }, true)
    expect(cmd).toBe('perl')
    const after = args.slice(2)
    expect(after.slice(0, 4)).toEqual(['env', 'DISPLAY=:3', 'LD_LIBRARY_PATH=/t/libs', 'qemu-system-x86_64'])
    const [sg, sgArgs] = qemuCommand(cfg, paths, m, { blockStop: true, env }, false)
    expect(sg).toBe('sg')
    // sg is setuid: the loader would drop LD_LIBRARY_PATH from its children, so it rides in the command
    expect(sgArgs[2]).toMatch(/^'perl' '-e' .* 'env' 'DISPLAY=:3' 'LD_LIBRARY_PATH=\/t\/libs' 'qemu-system-x86_64'/)
    expect(qemuCommand(cfg, paths, m, {}, true)[0]).toBe('qemu-system-x86_64')
  })

  it('is started with the display, the modules and their libraries alone', () => {
    expect(windowEnv({ DISPLAY: ':4', XAUTHORITY: '/a' }, { modules: '/t/mods', libs: '/t/libs' })).toEqual({
      DISPLAY: ':4',
      XAUTHORITY: '/a',
      QEMU_MODULE_DIR: '/t/mods',
      LD_LIBRARY_PATH: '/t/libs',
      GDK_BACKEND: 'x11',
      NO_AT_BRIDGE: '1'
    })
  })
})

describe("the VM's screen", () => {
  let root: string
  beforeEach(() => (root = mkdtempSync(join(tmpdir(), 'tc-vm-screen-'))))
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const both: PictureTools = { window: { modules: '/m', libs: '/l' }, video: { engine: '/e', xorg: '/nonexistent/Xorg', xclip: '/c', sys: '/s', viewer: '/v' }, missing: null }

  it('names the first tool missing', () => {
    expect(pictureToolsAt(root)).toEqual({ missing: WINDOW_TOOL })
  })

  it('runs the machine with no window where a tool is missing, and says which', async () => {
    const screen = new VmScreen({ root, tools: () => ({ missing: 'screen-relay' }) })
    expect(await screen.up()).toBeNull()
    expect(screen.missing).toBe('screen-relay')
    expect(screen.missingTool).toBe('screen-relay')
    expect(screen.env).toBeNull()
  })

  it("runs with no window when QEMU refuses the modules (another QEMU build)", async () => {
    const screen = new VmScreen({ root, tools: () => both, loads: async () => 'QEMU did not load its window: undefined symbol' })
    expect(await screen.up()).toBeNull()
    expect(screen.missing).toMatch(/did not load its window/)
    expect(screen.missingTool).toBeNull()
  })

  it('runs with no window when the display will not start', async () => {
    const screen = new VmScreen({ root, tools: () => both, loads: async () => null })
    expect(await screen.up()).toBeNull()
    expect(screen.missing).toMatch(/the display did not start/)
  })

  it('once QEMU would not open its window, starts with none until a host starts again', async () => {
    let asked = 0
    const screen = new VmScreen({ root, tools: () => both, loads: async () => (asked++, null) })
    await screen.broke('QEMU did not start with its window: gtk initialization failed')
    expect(await screen.up()).toBeNull()
    expect(asked).toBe(0)
    expect(screen.missing).toMatch(/gtk initialization failed/)
  })

  it('takes back no display when none was kept', () => {
    const screen = new VmScreen({ root, tools: () => both })
    screen.adopt()
    expect(screen.env).toBeNull()
    expect(screen.pid).toBeNull()
  })
})
