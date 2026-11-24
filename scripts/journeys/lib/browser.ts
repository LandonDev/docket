import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { freePort } from '../../e2e-work-lib'
import { Window } from './window'
import { isolatedEnvironment, type Pair } from './shape'

/** One disposable browser and cookie jar per visit. */
export async function browser(pair: Pair, profile: string, url: URL, width = 390): Promise<{ page: Window; stop(): Promise<void> }> {
  const { chromePath } = await import('../../ui-preview')
  const chrome = chromePath({})
  if (!chrome) throw new Error('No Playwright Chromium on the box')
  const port = await freePort()
  pair.trackPort(port)
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  const proc = spawn(chrome, [
    '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--no-proxy-server',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port, '--user-data-dir=' + profile,
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ' + url.hostname, 'about:blank'
  ], { env: { ...isolatedEnvironment(process.env), HOME: profile, TMPDIR: profile }, stdio: 'ignore' })
  const exited = new Promise<void>((resolve) => {
    proc.once('exit', () => resolve())
    proc.once('error', () => resolve())
  })
  let page: Window | undefined
  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    page?.close()
    const timeout = setTimeout(() => proc.kill('SIGKILL'), 2500)
    proc.kill('SIGTERM')
    try {
      await exited
    } finally {
      clearTimeout(timeout)
      rmSync(profile, { recursive: true, force: true })
    }
  }
  pair.later(stop)
  page = await Window.attach(port, pair.abort.signal, (url) => url === 'about:blank', width)
  await page.navigate(url.href)
  return { page, stop }
}

export async function phone(pair: Pair, profile: string, kind: 'owner' | 'read') {
  const base = new URL('http://127.0.0.1:' + pair.box.remote)
  const { pairing, code } = await pair.rpc<{ pairing: { id: string }; code: string }>(pair.box, 'remote.pairings.create', {
    name: 'Journey clicker ' + kind, audience: 'client',
    caps: kind === 'read' ? ['read'] : ['operate']
  })
  if (!pairing?.id || !code) throw new Error('The clicker pairing did not return its id and code')
  const visit = await browser(pair, profile, new URL('/pair#' + code, base), 1280)
  const { page } = visit
  await page.until('the paired phone to open /ui', 25_000, async () => {
    if (await page.eval<boolean>('location.pathname.startsWith("/ui")')) return true
    const button = await page.centre('button', 'Pair')
    if (button) await page.click(button)
    return false
  })
  return visit
}
