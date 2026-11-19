import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BoxChromium, HEADED_BLOCKED, chromiumArgs, findChromium, headedPrefs, mergePrefs, treeRssMb, writeHeadedPrefs } from './chromium'

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'm38-chr-'))
  dirs.push(d)
  return d
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })))

describe('the box browser', () => {
  it('finds the newest Playwright Chromium when none is named or on PATH', () => {
    const home = tmp()
    for (const rev of ['1200', '1248']) {
      mkdirSync(join(home, '.cache/ms-playwright', `chromium-${rev}`, 'chrome-linux64'), { recursive: true })
      writeFileSync(join(home, '.cache/ms-playwright', `chromium-${rev}`, 'chrome-linux64', 'chrome'), '')
    }
    expect(findChromium({ HOME: home, PATH: '' })).toBe(join(home, '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome'))
    expect(findChromium({ HOME: home, PATH: '', TEMP_CODE_BOX_CHROMIUM: '/nope' })).toBeNull()
    expect(findChromium({ HOME: tmp(), PATH: '' })).toBeNull()
  })

  it('keeps DevTools on loopback, its own profile, headless, and the sandbox on', () => {
    const args = chromiumArgs('/p')
    expect(args).toContain('--remote-debugging-address=127.0.0.1')
    expect(args).toContain('--user-data-dir=/p')
    expect(args).toContain('--headless=new')
    expect(args.some((a) => /no-sandbox/.test(a))).toBe(false)
  })

  it('headed, it draws on a display: a covered window keeps painting, nothing offers to restore pages, and the sandbox stays on', () => {
    const args = chromiumArgs('/p', { testing: false })
    expect(args.some((a) => a.startsWith('--headless'))).toBe(false)
    expect(args).toContain('--window-position=0,0')
    expect(args).toContain('--window-size=1280,800')
    expect(args).toContain('--disable-backgrounding-occluded-windows')
    expect(args).toContain('--hide-crash-restore-bubble')
    expect(args).toContain('--remote-debugging-address=127.0.0.1')
    expect(args.some((a) => /no-sandbox/.test(a))).toBe(false)
    // only a Chrome for Testing build gets the switch that hides its bar
    expect(args.some((a) => a.startsWith('--test-type'))).toBe(false)
    expect(chromiumArgs('/p', { testing: true })).toContain('--test-type=gpu')
    expect(chromiumArgs('/p').some((a) => a.startsWith('--test-type'))).toBe(false)
  })

  it('headed, the profile saves no password, fills nothing, refuses every prompt and keeps what else it held', () => {
    const prefs = headedPrefs('/box/downloads')
    expect(prefs).toMatchObject({
      credentials_enable_service: false,
      credentials_enable_autosignin: false,
      autofill: { profile_enabled: false, credit_card_enabled: false },
      download: { prompt_for_download: false, default_directory: '/box/downloads' },
      signin: { allowed: false },
      profile: { exit_type: 'Normal', exited_cleanly: true }
    })
    const blocked = (prefs.profile as { default_content_setting_values: Record<string, number> }).default_content_setting_values
    for (const name of ['notifications', 'geolocation', 'media_stream_mic', 'media_stream_camera', 'clipboard']) expect(blocked[name]).toBe(2)
    expect(Object.keys(blocked).sort()).toEqual([...HEADED_BLOCKED].sort())

    // what the profile already holds beside those stays: his sign-ins live in other files, and its own state is kept
    const profile = tmp()
    mkdirSync(join(profile, 'Default'), { recursive: true })
    writeFileSync(
      join(profile, 'Default', 'Preferences'),
      JSON.stringify({ credentials_enable_service: true, profile: { name: 'Person 1', exit_type: 'Crashed', default_content_setting_values: { notifications: 1, cookies: 1 } }, intl: { accept_languages: 'en-US' } })
    )
    writeHeadedPrefs(profile, join(profile, 'downloads'))
    const written = JSON.parse(readFileSync(join(profile, 'Default', 'Preferences'), 'utf8'))
    expect(written.credentials_enable_service).toBe(false)
    expect(written.profile.name).toBe('Person 1')
    expect(written.profile.exit_type).toBe('Normal')
    expect(written.profile.default_content_setting_values).toMatchObject({ notifications: 2, cookies: 1 })
    expect(written.intl).toEqual({ accept_languages: 'en-US' })
    expect(statSync(join(profile, 'Default', 'Preferences')).mode & 0o777).toBe(0o600)
    // a file cut short by a kill is replaced, not a reason to fail
    writeFileSync(join(profile, 'Default', 'Preferences'), '{"credentials_enable_ser')
    writeHeadedPrefs(profile, join(profile, 'downloads'))
    expect(JSON.parse(readFileSync(join(profile, 'Default', 'Preferences'), 'utf8')).credentials_enable_service).toBe(false)
    expect(mergePrefs({ a: { b: 1, c: 2 }, d: [1] }, { a: { b: 9 }, d: [2], e: 3 })).toEqual({ a: { b: 9, c: 2 }, d: [2], e: 3 })
  })

  /** A browser that never runs: it writes the DevTools file a real one would, and remembers what it was started with. */
  function fakeBrowser() {
    const calls: { args: string[]; env?: NodeJS.ProcessEnv }[] = []
    const spawn = ((_cmd: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      calls.push({ args, env: options.env })
      const profile = args.find((a) => a.startsWith('--user-data-dir='))!.slice('--user-data-dir='.length)
      writeFileSync(join(profile, 'DevToolsActivePort'), '9\n/devtools/browser/x\n')
      const child = new EventEmitter() as never as { pid: number; exitCode: number | null; signalCode: string | null; kill(): boolean; emit(e: string): void }
      Object.assign(child, { pid: 2 ** 22 - 7, exitCode: null, signalCode: null })
      child.kill = () => {
        child.exitCode = 0
        child.emit('exit')
        return true
      }
      return child
    }) as never
    return { calls, spawn }
  }
  const TOOLS = { engine: '/t/pkg/relay-engine', xorg: '/t/xorg', xclip: '/t/xclip', sys: '/t/sys', viewer: '/t/viewer' }
  const fakeDisplay = (fail = false) => {
    const state = { started: 0, stopped: 0 }
    const pair = { DISPLAY: ':41', XAUTHORITY: '/d/Xauthority' }
    let up = false
    return {
      state,
      make: () => ({
        start: async () => {
          if (fail) throw new Error('no X here')
          state.started++
          up = true
          return pair
        },
        stop: async () => {
          state.stopped++
          up = false
        },
        get env() {
          return up ? pair : null
        }
      })
    }
  }

  it('with the tools and the setting on, starts headed on its own display and is handed nothing of the host’s', async () => {
    const before = { DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY }
    process.env.DISPLAY = ':99'
    process.env.XAUTHORITY = '/run/the-servers-own'
    try {
      const fake = fakeBrowser()
      const display = fakeDisplay()
      const root = tmp()
      const b = new BoxChromium({ root, bin: () => '/bin/chromium', spawn: fake.spawn, video: () => TOOLS, makeDisplay: display.make, testing: async () => true })
      await b.endpoint()
      expect(b.display).toEqual({ DISPLAY: ':41', XAUTHORITY: '/d/Xauthority' })
      expect(b.tools).toBe(TOOLS)
      const call = fake.calls[0]
      expect(call.env?.DISPLAY).toBe(':41')
      expect(call.env?.XAUTHORITY).toBe('/d/Xauthority')
      expect(Object.values(call.env ?? {})).not.toContain(':99')
      expect(Object.values(call.env ?? {})).not.toContain('/run/the-servers-own')
      expect(call.args).not.toContain('--headless=new')
      expect(call.args).toContain('--test-type=gpu')
      // the profile was written before the browser read it
      expect(JSON.parse(readFileSync(join(b.profile, 'Default', 'Preferences'), 'utf8')).credentials_enable_service).toBe(false)
      // the display lives exactly as long as the browser
      await b.stop()
      expect(display.state).toEqual({ started: 1, stopped: 1 })
      expect(b.display).toBeNull()
      expect(b.tools).toBeNull()
    } finally {
      for (const [k, v] of Object.entries(before)) v === undefined ? delete process.env[k] : (process.env[k] = v)
    }
  })

  it('without the tools, with the setting off, or when its display will not start, it starts headless exactly as before', async () => {
    for (const how of ['no tools', 'the display fails'] as const) {
      const fake = fakeBrowser()
      const display = fakeDisplay(how === 'the display fails')
      const logs: string[] = []
      const b = new BoxChromium({ root: tmp(), bin: () => '/bin/chromium', spawn: fake.spawn, video: () => (how === 'no tools' ? null : TOOLS), makeDisplay: display.make, log: (l) => logs.push(l) })
      await b.endpoint()
      expect(b.display, how).toBeNull()
      expect(fake.calls[0].args, how).toEqual(chromiumArgs(b.profile))
      // a headless browser inherits what it always did: no environment is made for it
      expect(fake.calls[0].env, how).toBeUndefined()
      expect(existsSync(join(b.profile, 'Default', 'Preferences')), how).toBe(false)
      if (how === 'the display fails') expect(logs.join('\n')).toContain('its display did not start (no X here); it runs headless')
      await b.stop()
    }
  })

  it('adds up a process tree from /proc', () => {
    const proc = tmp()
    const add = (pid: number, ppid: number, kb: number) => {
      mkdirSync(join(proc, String(pid)))
      writeFileSync(join(proc, String(pid), 'status'), `Name:\tx\nPPid:\t${ppid}\nVmRSS:\t${kb} kB\n`)
    }
    add(10, 1, 1024)
    add(11, 10, 2048)
    add(12, 11, 1024)
    add(13, 1, 99_999)
    expect(treeRssMb(10, proc)).toBe(4)
  })

  const bin = findChromium()
  it.runIf(!!bin && process.platform === 'linux')('starts once, stops when idle, and starts again on use', async () => {
    const root = tmp()
    const b = new BoxChromium({ root, bin: () => bin, idleMs: 300 })
    const stops: string[] = []
    b.onStop((why) => stops.push(why))
    const [a, c] = await Promise.all([b.endpoint(), b.endpoint()])
    expect(a).toBe(c)
    expect(a).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//)
    expect(readFileSync(join(b.profile, 'DevToolsActivePort'), 'utf8')).toContain('/devtools/browser/')
    await new Promise((r) => setTimeout(r, 600))
    expect(b.running).toBe(false)
    expect(stops).toEqual(['idle'])
    expect(await b.endpoint()).not.toBe(a)
    await b.stop()
  }, 30_000)

  it.runIf(!!bin && process.platform === 'linux')('never launches after a stop that overtook its start', async () => {
    const b = new BoxChromium({ root: tmp(), bin: () => bin })
    const starting = b.endpoint()
    void b.stop()
    await expect(starting).rejects.toThrow(/stopped as it started/)
    expect(b.running).toBe(false)
  }, 30_000)

  it.runIf(!!bin && process.platform === 'linux')('is stopped when it passes its memory cap', async () => {
    const b = new BoxChromium({ root: tmp(), bin: () => bin, capMb: 10, rssMb: () => 11, watchMs: 50 })
    const stopped = new Promise<string>((r) => b.onStop(r))
    await b.endpoint()
    expect(await stopped).toBe('memory')
    await b.stop()
  }, 30_000)
})
