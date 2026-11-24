import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { access, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { win32 } from 'node:path'
import { LIFEOS_URL } from '@shared/pagePolicy'
import { redact } from '../../work/lifeos/transport'
import { enrollWords } from './enrollWords'

/**
 * The LifeOS step on a Windows computer being set up (plan §6): download
 * LifeOS's installer from its own feed, install it per user, find it by its
 * uninstall entry, hand it the one-time `desktop` code by the enroll file and
 * wait for its answer.
 *
 * - The feed is electron-updater's `latest.yml` on LifeOS's GitHub releases.
 *   Every hop of a redirect must stay on GitHub's release hosts over https;
 *   the installer must match the feed's sha512. The installers are unsigned,
 *   so GitHub's TLS and his GitHub account are the trust here, as for
 *   TempCode's own Windows updater.
 * - `/S` installs per user, with no admin. LifeOS is found from its entry
 *   under HKCU's Uninstall key, read with `reg.exe` (no PowerShell: a
 *   Purdue PC may run Constrained Language), and only an entry with LifeOS's
 *   name and publisher in a folder under `%LOCALAPPDATA%\Programs` counts.
 *   One already there skips the download and the install; it updates itself.
 * - The enroll file is written whole under another name and renamed into
 *   place, so LifeOS never reads half of it; a second launch of LifeOS makes
 *   a running one read it at once.
 *
 * Every side effect is a dep, so the tests run anywhere. The code is never
 * logged or put in a reason.
 */

export type LifeosStep = 'download' | 'install' | 'sign-in' | 'reader'
export interface StepReport {
  step: LifeosStep
  state: 'working' | 'done' | 'failed'
  reason?: string
}
/** `signedIn`: LifeOS took this setup's sign-in (not one it held already), so its reader is setup's to turn off. */
export type InstallOutcome = { ok: true; signedIn?: boolean } | { ok: false; step: LifeosStep; reason: string }

export interface InstallDeps {
  fetch: (url: string, init: { redirect: 'manual'; signal: AbortSignal }) => Promise<Response>
  fs: {
    readFile(path: string): Promise<string>
    writeFile(path: string, data: string | Uint8Array): Promise<void>
    rename(from: string, to: string): Promise<void>
    rm(path: string): Promise<void>
    mkdir(path: string): Promise<void>
    exists(path: string): Promise<boolean>
    /** The path with every link and junction followed (fs.realpath). */
    realpath?(path: string): Promise<string>
  }
  /** Runs a program to its end: its exit code. */
  run(file: string, args: string[]): Promise<number>
  /** Starts a program and leaves it running. */
  launch(file: string): void
  /** What `reg.exe query <key> /s` prints; rejects when the key is missing. */
  regQuery(key: string): Promise<string>
  env: Record<string, string | undefined>
  /** A stand-in feed for the rig proof (TEMP_CODE_LIFEOS_FEED, under the harness marker alone): every hop stays on its one origin. */
  feed?: string
  now(): number
  sleep(ms: number): Promise<void>
}

export const LIFEOS_FEED = 'https://github.com/LandonDev/lifeos-releases/releases/latest/download/'
export const RELEASE_HOSTS: ReadonlySet<string> = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'])
export const UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
/** LifeOS's own entry: electron-builder writes `<productName> <version>` and the package's author. */
const DISPLAY_NAME = /^LifeOS(?: \d+\.\d+\.\d+\S*)?$/
export const LIFEOS_PUBLISHER = 'Landon Hale'
/**
 * The first LifeOS release that takes setup's enroll file and answers it (LifeOS 5dfb592, with 132f18c's
 * attempt; 0.1.9 has neither). An older one installed is replaced from the checked feed, never handed a code (F24).
 */
export const MIN_ENROLL_VERSION = '0.1.10'

/** Whether a dotted version is at least `min`; an unreadable one is not. */
export function versionAtLeast(version: string | null | undefined, min: string): boolean {
  const parts = (v: string): number[] | null => (/^\d+(\.\d+)*$/.test(v) ? v.split('.').map(Number) : null)
  const a = version ? parts(version.trim()) : null
  const b = parts(min)!
  if (!a) return false
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return true
}
export const RESULT_WAIT_MS = 2 * 60_000
const POLL_MS = 1_000
const MAX_HOPS = 5
const MAX_BYTES = 512 * 1024 * 1024
const ATTEMPT = /^[A-Za-z0-9_-]{1,64}$/

class StepFailed extends Error {}

// ── the feed ──────────────────────────────────────────────────────────────

/** `latest.yml`'s top-level `path` and `sha512` (base64 of 64 bytes). */
export function parseFeed(text: string): { path: string; sha512: string } {
  const top = (key: string): string | undefined => new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, 'm').exec(text)?.[1]?.replace(/^(['"])(.*)\1$/, '$2')
  const path = top('path')
  const sha512 = top('sha512')
  if (!path || !/^[A-Za-z0-9][A-Za-z0-9._ -]*\.exe$/.test(path)) throw new StepFailed("LifeOS's feed names no installer")
  if (!sha512 || Buffer.from(sha512, 'base64').length !== 64) throw new StepFailed("LifeOS's feed gives no checksum")
  return { path, sha512 }
}

/** Whether a hop may be fetched: https on GitHub's release hosts, or the stand-in feed's one origin. */
function allowedHop(at: URL, feed: string | undefined): boolean {
  if (at.username || at.password) return false
  if (feed) return at.origin === new URL(feed).origin
  return at.protocol === 'https:' && !at.port && RELEASE_HOSTS.has(at.hostname)
}

/** A GET that follows redirects only over https on GitHub's release hosts. */
async function fetchFromGitHub(url: string, deps: InstallDeps, timeoutMs: number): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs)
  let at = new URL(url)
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (!allowedHop(at, deps.feed)) throw new StepFailed(`The download was sent to ${at.host || at.protocol}, which is not GitHub's`)
    const res = await deps.fetch(at.href, { redirect: 'manual', signal })
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) throw new StepFailed('GitHub sent a redirect with no address')
      at = new URL(location, at)
      continue
    }
    if (!res.ok) throw new StepFailed(`GitHub answered ${res.status}`)
    return res
  }
  throw new StepFailed('GitHub sent too many redirects')
}

/** The installer, checked against the feed, written to `file`. */
async function download(file: string, deps: InstallDeps): Promise<void> {
  const base = deps.feed ?? LIFEOS_FEED
  const feed = parseFeed(await (await fetchFromGitHub(`${base}latest.yml`, deps, 30_000)).text())
  const res = await fetchFromGitHub(`${base}${encodeURIComponent(feed.path)}`, deps, 15 * 60_000)
  if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) throw new StepFailed("The installer is too large to be LifeOS's")
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.length > MAX_BYTES) throw new StepFailed("The installer is too large to be LifeOS's")
  if (createHash('sha512').update(bytes).digest('base64') !== feed.sha512) throw new StepFailed('The installer did not match its checksum')
  await deps.fs.writeFile(file, bytes)
}

// ── the uninstall entry ───────────────────────────────────────────────────

/** `reg.exe query … /s`: each key's values by name. */
export function parseRegQuery(out: string): Map<string, Record<string, string>> {
  const keys = new Map<string, Record<string, string>>()
  let current: Record<string, string> | null = null
  for (const line of out.split(/\r?\n/)) {
    if (/^HKEY_/.test(line)) keys.set(line.trim(), (current = {}))
    else if (current) {
      const value = /^ {4}(.+?) {4}(REG_[A-Z_]+)(?: {4}(.*))?$/.exec(line)
      if (value) current[value[1]!] = value[3] ?? ''
    }
  }
  return keys
}

export type Found = { state: 'absent' } | { state: 'found'; exe: string; version: string | null } | { state: 'refused'; reason: string }

/** The folder an entry names: `InstallLocation`, else the folder of its uninstaller (electron-builder keeps `InstallLocation` under its own key, not the uninstall entry). */
function folderOf(entry: Record<string, string>): string | null {
  if (entry.InstallLocation?.trim()) return entry.InstallLocation.trim()
  const uninstaller = /^"([^"]+)"/.exec(entry.UninstallString ?? '')?.[1]
  return uninstaller ? win32.dirname(uninstaller) : null
}

const under = (root: string, path: string): boolean => {
  const rel = win32.relative(win32.normalize(root).toLowerCase(), win32.normalize(path).toLowerCase())
  return !!rel && !rel.startsWith('..') && !win32.isAbsolute(rel)
}

/** LifeOS as its per-user uninstall entry places it; an entry with its name that is not its own is refused, never run. */
export async function findLifeos(deps: Pick<InstallDeps, 'regQuery' | 'env' | 'fs'>): Promise<Found> {
  const local = deps.env.LOCALAPPDATA
  if (!local) return { state: 'refused', reason: 'This computer names no local app data folder' }
  let out: string
  try {
    out = await deps.regQuery(UNINSTALL_KEY)
  } catch {
    return { state: 'absent' }
  }
  let refused: string | null = null
  for (const entry of parseRegQuery(out).values()) {
    if (!DISPLAY_NAME.test(entry.DisplayName ?? '')) continue
    const folder = folderOf(entry)
    if (entry.Publisher !== LIFEOS_PUBLISHER) refused ??= `An app named LifeOS from ${redact(entry.Publisher || 'no publisher').slice(0, 80)} is installed; it is not LifeOS's`
    else if (!folder || !under(win32.join(local, 'Programs'), folder)) refused ??= "An app named LifeOS is installed outside this user's programs folder; it is not used"
    else {
      const exe = win32.join(folder, 'LifeOS.exe')
      if (await deps.fs.exists(exe)) {
        // The program run is the one the folder really holds: a link or junction out of the programs folder is refused (F24).
        const real = deps.fs.realpath ? await deps.fs.realpath(exe).catch(() => null) : exe
        if (real && under(win32.join(local, 'Programs'), real)) return { state: 'found', exe: real, version: entry.DisplayVersion?.trim() || null }
        refused ??= "LifeOS's program leads outside this user's programs folder; it is not used"
        continue
      }
      refused ??= "LifeOS's entry names a folder with no LifeOS.exe"
    }
  }
  return refused ? { state: 'refused', reason: refused } : { state: 'absent' }
}

// ── the step ──────────────────────────────────────────────────────────────

/**
 * The folder LifeOS reads its enroll file from, by the backend it was built
 * for: `lifeos` for the real one, else `lifeos-<host>`, as LifeOS's own
 * `enrollDir` names it (apps/desktop/src/main/enroll.ts).
 */
export function enrollFolderName(backend: string): string {
  const bare = (u: string): string => u.replace(/\/+$/, '')
  return bare(backend) === bare(LIFEOS_URL) ? 'lifeos' : `lifeos-${new URL(backend).host.replace(/[^\w.-]/g, '-')}`
}

export interface InstallInput {
  /** the one-time `desktop` code */
  code: string
  owner: string
  /** whether LifeOS should also read Outlook and Teams here */
  reader: boolean
  /** TempCode's id for this try; made when not given */
  attempt?: string
  /** the LifeOS backend the desktop must be on */
  backend?: string
}

export async function installLifeos(input: InstallInput, deps: InstallDeps, onStep: (report: StepReport) => void): Promise<InstallOutcome> {
  const attempt = input.attempt ?? randomBytes(12).toString('base64url')
  if (!ATTEMPT.test(attempt)) throw new Error('an attempt id is 1 to 64 letters, digits, - or _')
  const report = (step: LifeosStep, state: StepReport['state'], reason?: string): void => onStep(reason === undefined ? { step, state } : { step, state, reason })
  const fail = (step: LifeosStep, reason: string): InstallOutcome => {
    report(step, 'failed', reason)
    if (step !== 'reader' && input.reader) report('reader', 'failed', 'Waits for LifeOS to sign in')
    return { ok: false, step, reason }
  }
  const local = deps.env.LOCALAPPDATA
  if (!local) return fail('download', 'This computer names no local app data folder')

  let found = await findLifeos(deps)
  if (found.state === 'refused') return fail('install', found.reason)
  // Only a release that answers the enroll file is handed a code; an older one is installed over from the feed (F24).
  if (found.state === 'found' && versionAtLeast(found.version, MIN_ENROLL_VERSION)) {
    report('download', 'done', 'Already installed')
    report('install', 'done', 'Already installed')
  } else {
    const file = win32.join(deps.env.TEMP || win32.join(local, 'Temp'), `tempcode-lifeos-${attempt}.exe`)
    try {
      report('download', 'working')
      try {
        await download(file, deps)
      } catch (err) {
        return fail('download', err instanceof StepFailed ? err.message : 'The download did not finish')
      }
      report('download', 'done')
      report('install', 'working')
      const code = await deps.run(file, ['/S']).catch(() => -1)
      if (code !== 0) return fail('install', code === -1 ? 'The installer did not start' : `The installer stopped with code ${code}`)
    } finally {
      await deps.fs.rm(file).catch(() => {})
    }
    found = await findLifeos(deps)
    if (found.state === 'refused') return fail('install', found.reason)
    if (found.state === 'absent') return fail('install', 'The installer ran, but LifeOS is not where it installs')
    if (!versionAtLeast(found.version, MIN_ENROLL_VERSION)) return fail('install', `LifeOS ${found.version ?? ''} cannot take a sign-in from setup yet; a newer LifeOS release is needed`.replace('  ', ' '))
    report('install', 'done')
  }

  report('sign-in', 'working')
  if (input.reader) report('reader', 'working')
  const backend = input.backend ?? LIFEOS_URL
  const dir = win32.join(local, enrollFolderName(backend))
  const enrollFile = win32.join(dir, `enroll-${attempt}.json`)
  try {
    await deps.fs.mkdir(dir)
    const temp = win32.join(dir, `.enroll-${attempt}.json.tmp`)
    await deps.fs.writeFile(temp, JSON.stringify({ attempt, code: input.code, backend, owner: input.owner, reader: input.reader }))
    await deps.fs.rename(temp, enrollFile)
  } catch {
    return fail('sign-in', 'The sign-in could not be left for LifeOS')
  }
  try {
    deps.launch(found.exe)
  } catch {
    await deps.fs.rm(enrollFile).catch(() => {})
    return fail('sign-in', 'LifeOS did not start')
  }

  const result = await waitForResult(win32.join(dir, `enroll-${attempt}.result.json`), attempt, deps)
  if (!result) {
    // A code left behind is no use to anyone: it goes, so a later start of LifeOS does not take it.
    await deps.fs.rm(enrollFile).catch(() => {})
    return fail('sign-in', 'LifeOS did not answer in two minutes')
  }
  if (result.ok) {
    report('sign-in', 'done')
    if (input.reader) report('reader', 'done')
    return { ok: true, signedIn: true }
  }
  if (result.error === 'already signed in') {
    // His own session stays, and LifeOS leaves his reader as he set it.
    report('sign-in', 'done', 'Already signed in')
    if (input.reader) report('reader', 'done', 'Left as set in LifeOS')
    return { ok: true }
  }
  return fail('sign-in', enrollWords(result.error ?? 'error'))
}

/** LifeOS's answer for this attempt; a file under this name for another attempt is not it. */
async function waitForResult(path: string, attempt: string, deps: InstallDeps): Promise<{ ok: boolean; error?: string } | null> {
  const end = deps.now() + RESULT_WAIT_MS
  for (;;) {
    if (await deps.fs.exists(path)) {
      // Half written reads as null: read again on the next poll.
      const parsed = await deps.fs
        .readFile(path)
        .then((text) => JSON.parse(text) as { attempt?: unknown; ok?: unknown; error?: unknown } | null)
        .catch(() => null)
      if (parsed && parsed.attempt === attempt && typeof parsed.ok === 'boolean') {
        await deps.fs.rm(path).catch(() => {})
        return { ok: parsed.ok, ...(typeof parsed.error === 'string' ? { error: parsed.error } : {}) }
      }
    }
    if (deps.now() >= end) return null
    await deps.sleep(POLL_MS)
  }
}

// ── the real computer ─────────────────────────────────────────────────────

/**
 * Remove's reader step (devices/given.ts `lifeosReaderOff`): LifeOS's Outlook and Teams reader off,
 * `read: false` in `%APPDATA%\\lifeos\\purdue.json` (and the old `enabled` flag, which meant read and
 * send), every other field kept. Sending needs reading, so the sender stops with it. No file: nothing
 * to turn off. Written whole under another name and renamed into place.
 */
export async function lifeosReaderOff(deps: Pick<InstallDeps, 'fs' | 'env'>, backend: string = LIFEOS_URL): Promise<boolean> {
  const roaming = deps.env.APPDATA
  if (!roaming) throw new Error('APPDATA is not set')
  // LifeOS keeps its data in the folder named for the backend it was built for, as its enroll folder is.
  const path = win32.join(roaming, enrollFolderName(backend), 'purdue.json')
  if (!(await deps.fs.exists(path))) return false
  let stored: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(await deps.fs.readFile(path)) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>
  } catch {
    // an unreadable file is replaced by one that reads nothing
  }
  const next = { ...stored, read: false, ...('enabled' in stored ? { enabled: false } : {}) }
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  await deps.fs.writeFile(tmp, JSON.stringify(next))
  await deps.fs.rename(tmp, path)
  return true
}

/** The deps on a real Windows computer. */
export function windowsInstallDeps(env: Record<string, string | undefined> = process.env): InstallDeps {
  const reg = win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe')
  return {
    fetch: (url, init) => fetch(url, init),
    fs: {
      readFile: (path) => readFile(path, 'utf8'),
      writeFile: (path, data) => writeFile(path, data),
      rename: (from, to) => rename(from, to),
      rm: (path) => rm(path, { force: true }),
      mkdir: async (path) => void (await mkdir(path, { recursive: true })),
      exists: (path) =>
        access(path).then(
          () => true,
          () => false
        ),
      realpath: (path) => realpath(path)
    },
    run: (file, args) =>
      new Promise((resolve) => {
        const child = execFile(file, args, { windowsHide: true, timeout: 10 * 60_000 }, () => {})
        child.on('exit', (code) => resolve(code ?? -1))
        child.on('error', () => resolve(-1))
      }),
    launch(file) {
      const child = spawn(file, [], { detached: true, stdio: 'ignore', windowsHide: false })
      child.on('error', () => {})
      child.unref()
    },
    regQuery: (key) =>
      new Promise((resolve, reject) => execFile(reg, ['query', key, '/s'], { windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)))),
    env,
    ...(env.TEMP_CODE_USER_DATA && env.TEMP_CODE_LIFEOS_FEED ? { feed: env.TEMP_CODE_LIFEOS_FEED.replace(/\/*$/, '/') } : {}),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  }
}
