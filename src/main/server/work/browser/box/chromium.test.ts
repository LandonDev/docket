import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BoxChromium, chromiumArgs, findChromium, treeRssMb } from './chromium'

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

  it.runIf(!!bin && process.platform === 'linux')('is stopped when it passes its memory cap', async () => {
    const b = new BoxChromium({ root: tmp(), bin: () => bin, capMb: 10, rssMb: () => 11, watchMs: 50 })
    const stopped = new Promise<string>((r) => b.onStop(r))
    await b.endpoint()
    expect(await stopped).toBe('memory')
    await b.stop()
  }, 30_000)
})
