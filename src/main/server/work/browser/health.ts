import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import type { HealthRow, Lapse } from '@shared/work'
import type { WorkCtx } from '../modules'
import { rigConfig, rigPaths } from '../winvm/machine/config'
import { qemuPid } from '../winvm/machine/daemons'
import { pictureToolsAt } from '../winvm/window'
import { boxBrowser } from './box'
import { findChromium } from './box/chromium'
import { browserVideoSetting, videoToolsAt } from './box/videoSetting'

/**
 * The browser pillar's rows for Connections (docs/agents/work-connections.md):
 * the box's browser, its live video, the sites Work uses
 * there by whether a sign-in cookie exists (its name and site, never its
 * value, never a page), and the standing Windows VM with its evaluation's
 * end. Nothing here starts the browser or the VM: it reads the wired
 * browser's state, the profile's cookie store, files and /proc.
 */

/** One sign-in cookie, as the check reads it: no value is ever read. */
export interface SignInCookie {
  host: string
  name: string
  /** Chromium's time, microseconds since 1601; 0 for a session cookie */
  expires: number
}

export interface StandingVm {
  /** when the base image was built (base/READY), epoch ms; null when the file does not say */
  builtAt: number | null
  disk: boolean
  running: boolean
}

/** What a check reads; a test hands its own. */
export interface BrowserProbe {
  platform: NodeJS.Platform
  /** the box browser as wired at boot; null where it was not */
  box(): { running: boolean; headed: boolean; profile: string; root: string } | null
  chromium(): boolean
  videoOn(): boolean
  videoTools(): boolean
  /** the sign-in cookies in a profile, or null when its store cannot be read */
  cookies(profile: string): SignInCookie[] | null
  /** the Outlook on the web address the office carrier last saw signed in (owa.json beside the profile) */
  owaAccount(root: string): string | null
  /** the standing Windows VM; null where this host has no VM (no base image) */
  vm(): StandingVm | null
  /** the tool the VM's live picture lacks (winvm/window.ts), by name; null when both are installed */
  vmPictureTool(): string | null
  now(): number
}

/** The sites Work drives in the box's browser, each by the hosts and names of its sign-in cookies. */
export const SITES = [
  {
    id: 'outlook',
    title: 'Outlook on the web',
    // Entra's session (ESTSAUTH*) for a work or school account, the Microsoft account's for a personal one.
    hosts: ['login.microsoftonline.com', 'login.live.com'],
    names: /^(ESTSAUTH|ESTSAUTHPERSISTENT|ESTSAUTHLIGHT|MSPAuth|__Host-MSAAUTHP?)$/
  }
] as const

const DAY = 86_400_000
/** Windows 11 Enterprise Evaluation runs 90 days from its install (docs/agents/windows-vm.md "When the evaluation lapses"). */
export const EVALUATION_DAYS = 90
/**
 * The evaluation's end when base/READY gives no build time: the image built on 2026-11-19 ends
 * 2027-02-17. Taken as 23:59 that day in US Eastern (04:59 UTC the next day), since the app shows
 * dates in his local time and midnight UTC would read as the 16th there.
 */
export const EVALUATION_END_FALLBACK = Date.UTC(2027, 1, 18, 4, 59)
const NOTICE_DAYS = 14

export const evaluationEnd = (vm: StandingVm): number => (vm.builtAt !== null ? vm.builtAt + EVALUATION_DAYS * DAY : EVALUATION_END_FALLBACK)

/** Chromium's cookie time (µs since 1601) in epoch ms. */
const chromiumMs = (us: number): number => us / 1000 - 11_644_473_600_000

const listed = (cookie: SignInCookie, site: (typeof SITES)[number]): boolean => {
  const host = cookie.host.replace(/^\./, '').toLowerCase()
  return site.hosts.some((h) => host === h || host.endsWith(`.${h}`)) && site.names.test(cookie.name)
}

function boxRows(p: BrowserProbe): HealthRow[] {
  const box = p.box()
  if (!box) return p.chromium() ? [] : [{ id: 'browser.box', pillar: 'browser', group: 'Browser', title: 'Box browser', state: 'broken', line: 'No Chromium on this host, so its threads have no browser.' }]
  const rows: HealthRow[] = [{ id: 'browser.box', pillar: 'browser', group: 'Browser', title: 'Box browser', state: 'working', line: box.running ? 'Running' : 'Starts when a thread needs it' }]
  const video = { id: 'browser.video', pillar: 'browser' as const, group: 'Browser', title: 'Live video' }
  if (box.running && box.headed) rows.push({ ...video, state: 'working', line: 'On' })
  else if (!p.videoOn()) rows.push({ ...video, state: 'working', line: 'Turned off: you can watch the browser but not drive it' })
  else if (!p.videoTools()) rows.push({ ...video, state: 'needs-you', line: 'No live video until the screen relay is installed: bun scripts/work-tools/install.ts --only screen-relay' })
  else rows.push({ ...video, state: 'working', line: box.running ? 'Off until the browser starts again' : 'On' })
  const cookies = p.cookies(box.profile)
  for (const site of SITES) {
    const base = { id: `browser.site:${site.id}`, pillar: 'browser' as const, group: 'Browser', title: site.title }
    const live = cookies?.some((c) => listed(c, site) && (c.expires === 0 || chromiumMs(c.expires) > p.now()))
    const who = site.id === 'outlook' ? p.owaAccount(box.root) : null
    // An unreadable store (none yet, or held by the browser) leaves the marker to answer.
    if (live || (cookies === null && who)) rows.push({ ...base, state: 'working', line: who ? `Signed in as ${who}` : 'Signed in', ...(who ? { personal: true as const } : {}) })
    else rows.push({ ...base, state: 'needs-you', line: "Not signed in. Copy your Mac's logins to the box, or sign in from a thread's browser." })
  }
  return rows
}

function vmRows(p: BrowserProbe): HealthRow[] {
  const vm = p.vm()
  if (!vm) return []
  const machine = { id: 'browser.winvm.machine', pillar: 'browser' as const, group: 'Windows VM', title: 'Standing machine' }
  const rows: HealthRow[] = [
    !vm.disk
      ? { ...machine, state: 'needs-you', line: 'Not set up. Settings → Work → Windows VM → Set up.' }
      : vm.running
        ? { ...machine, state: 'working', line: 'Awake' }
        : // the keeper puts it to sleep when idle and wakes it at a thread's first call: asleep is its rest, not a fault
          { ...machine, state: 'working', line: 'Asleep. It wakes at a thread\'s first call.' }
  ]
  // without its tools the VM runs with no window: the 4 fps picture, and no Take over
  const tool = p.vmPictureTool()
  const picture = { id: 'browser.winvm.picture', pillar: 'browser' as const, group: 'Windows VM', title: 'Live picture' }
  rows.push(tool ? { ...picture, state: 'needs-you', line: `No live picture or Take over until ${tool} is installed: bun scripts/work-tools/install.ts --only ${tool}` } : { ...picture, state: 'working', line: 'On' })
  const until = evaluationEnd(vm)
  const left = until - p.now()
  const evaluation = { id: 'browser.winvm.evaluation', pillar: 'browser' as const, group: 'Windows VM', title: 'Windows evaluation', until }
  if (left <= 0) rows.push({ ...evaluation, state: 'broken', line: 'Rebuild the Windows image: docs/agents/windows-vm.md says how.' })
  else if (left <= NOTICE_DAYS * DAY) rows.push({ ...evaluation, state: 'needs-you', line: 'Rebuild the Windows image before it ends: docs/agents/windows-vm.md says how.' })
  else rows.push({ ...evaluation, state: 'working' })
  return rows
}

export function browserRows(p: BrowserProbe): HealthRow[] {
  if (p.platform !== 'linux') return []
  return [...boxRows(p), ...vmRows(p)]
}

/** The evaluation's end, from base/READY alone. */
export function browserLapses(p: Pick<BrowserProbe, 'platform' | 'vm'>): Lapse[] {
  const vm = p.platform === 'linux' ? p.vm() : null
  return vm ? [{ id: 'browser.winvm.evaluation', pillar: 'browser', title: 'Windows evaluation', until: evaluationEnd(vm) }] : []
}

// ── reading this host ────────────────────────────────────────────────

/**
 * The sign-in cookies in Chromium's store: host, name and expiry only, never `value` or
 * `encrypted_value`. Always opened immutable, which takes no lock and writes nothing, so the live
 * browser's own cookie writes never meet a busy store; a read torn by one costs one wrong answer.
 * Null when there is no store or it cannot be read.
 */
export function signInCookies(store: string): SignInCookie[] | null {
  if (!existsSync(store)) return null
  const hosts = [...new Set(SITES.flatMap((s) => s.hosts))]
  const where = hosts.map(() => '(host_key = ? OR host_key LIKE ?)').join(' OR ')
  const args = hosts.flatMap((h) => [h, `%.${h}`])
  const read = (db: DatabaseSync): SignInCookie[] => {
    try {
      const q = db.prepare(`SELECT host_key, name, expires_utc FROM cookies WHERE ${where}`)
      // Chromium's times (µs since 1601) pass 2^53: read as BigInt, or the read throws.
      q.setReadBigInts(true)
      return (q.all(...args) as { host_key: string; name: string; expires_utc: number | bigint }[]).map((r) => ({ host: r.host_key, name: r.name, expires: Number(r.expires_utc) }))
    } finally {
      db.close()
    }
  }
  try {
    const url = pathToFileURL(store)
    url.searchParams.set('immutable', '1')
    return read(new DatabaseSync(url, { readOnly: true }))
  } catch {
    return null
  }
}

/** The standing machine as its files and /proc say: base/READY, its disk, its QEMU's pid file. */
export function standingVm(env: NodeJS.ProcessEnv = process.env): StandingVm | null {
  const c = rigConfig(env, process.getuid?.() ?? 0, 'standing')
  const p = rigPaths(c)
  if (!existsSync(p.baseReady) && !existsSync(p.baseDisk)) return null
  let builtAt: number | null = null
  try {
    const at = Date.parse((JSON.parse(readFileSync(p.baseReady, 'utf8')) as { builtAt?: string }).builtAt ?? '')
    builtAt = Number.isFinite(at) ? at : null
  } catch {
    builtAt = null
  }
  return { builtAt, disk: existsSync(p.runDisk), running: qemuPid(c, p) !== null }
}

export function browserProbe(ctx: WorkCtx, env: NodeJS.ProcessEnv = process.env): BrowserProbe {
  return {
    platform: process.platform,
    box() {
      const h = boxBrowser()
      return h && { running: h.browser.running, headed: h.browser.display !== null, profile: h.browser.profile, root: h.root }
    },
    chromium: () => findChromium(env) !== null,
    videoOn: () => browserVideoSetting(ctx.db),
    videoTools: () => videoToolsAt(ctx.dataDir) !== null,
    cookies: (profile) => signInCookies(join(profile, 'Default', 'Cookies')),
    owaAccount(root) {
      try {
        const account = (JSON.parse(readFileSync(join(root, 'owa.json'), 'utf8')) as { account?: unknown }).account
        return typeof account === 'string' && account ? account : null
      } catch {
        return null
      }
    },
    vm: () => standingVm(env),
    vmPictureTool: () => pictureToolsAt(ctx.dataDir).missing,
    now: Date.now
  }
}
