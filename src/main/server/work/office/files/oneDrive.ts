import { execFile, execFileSync } from 'node:child_process'
import { win32 } from 'node:path'

export interface WindowsOneDriveMount {
  path: string
  type: 'mine' | 'team'
  web: string | null
}

export function oneDriveNamespace(value: string): string | null {
  if (!/^https:\/\//i.test(value) || /[\x00-\x1f\x7f\\]/.test(value)) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null
    const parts = url.pathname.split('/').map((part) => {
      try {
        return decodeURIComponent(part)
      } catch {
        return part
      }
    })
    if (parts.some((part) => /^:[a-z]:$|^forms$|\.aspx$/i.test(part))) return null
    url.pathname = parts.map(encodeURIComponent).join('/')
    return url.href.replace(/\/+$/, '')
  } catch {
    return null
  }
}

const PROVIDERS = 'Software\\SyncEngines\\Providers\\OneDrive'
const PROVIDER = /^(?:HKEY_CURRENT_USER|HKCU)\\Software\\SyncEngines\\Providers\\OneDrive\\[^\\]+$/i

/** The same provider rows that Guest.Mounts reads in the VM. Each key owns its three values. */
export function parseOneDriveRegistry(output: string): WindowsOneDriveMount[] {
  const mounts: WindowsOneDriveMount[] = []
  let values: Map<string, string> | undefined
  const finish = () => {
    const path = values?.get('mountpoint')
    const type = values?.get('librarytype')?.toLowerCase()
    if (!path || !/^[a-z]:[\\/]/i.test(path) || type === 'personal') return
    const mount = win32.normalize(path).replace(/\\+$/, '')
    if (mount.length <= 2) return
    const web = oneDriveNamespace(values?.get('urlnamespace') ?? '')
    mounts.push({ path: mount, type: type === 'mysite' ? 'mine' : 'team', web })
  }
  for (const line of output.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (/^(?:HKEY_CURRENT_USER|HKCU)\\/i.test(line)) {
      finish()
      values = PROVIDER.test(line.trimEnd()) ? new Map() : undefined
    } else {
      const value = /^\s+(MountPoint|LibraryType|UrlNamespace)\s+REG_SZ\s+(.+?)\s*$/i.exec(line)
      if (value) values?.set(value[1]!.toLowerCase(), value[2]!)
    }
  }
  finish()
  return mounts
}

/** How long OneDrive's folders as last read answer before they are read again, behind the answer. */
export const ONEDRIVE_FRESH_MS = 60_000
let cached: { at: number; mounts: WindowsOneDriveMount[] } | undefined
let reading = false

const REG_ARGS = ['query', `HKCU\\${PROVIDERS}`, '/s']
const regExe = (): string => win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe')
const parsed = (out: Buffer): WindowsOneDriveMount[] => parseOneDriveRegistry(out.toString(out.includes(0) ? 'utf16le' : 'utf8'))

/** A test runs the registry read in its place: `sync` as the first read, `later` as each one behind the answer. */
export const oneDriveSeams: { sync?: () => Buffer; later?: () => Promise<Buffer>; now?: () => number } = {}

/**
 * The folders OneDrive syncs here, from the registry. A process start costs a few hundred milliseconds and every
 * Files call asks, so only the first read waits for `reg.exe`; after that the answer kept is given at once and,
 * once a minute old, read again behind it.
 */
export function readWindowsOneDrive(): readonly WindowsOneDriveMount[] {
  if (process.platform !== 'win32' && !oneDriveSeams.sync) return []
  const now = (oneDriveSeams.now ?? Date.now)()
  if (cached) {
    if (now - cached.at >= ONEDRIVE_FRESH_MS && !reading) {
      reading = true
      const later = oneDriveSeams.later ?? (() => new Promise<Buffer>((done, fail) => execFile(regExe(), REG_ARGS, { windowsHide: true, timeout: 5_000, maxBuffer: 1024 * 1024, encoding: 'buffer' }, (err, out) => (err ? fail(err) : done(out)))))
      void later()
        .then((out) => (cached = { at: (oneDriveSeams.now ?? Date.now)(), mounts: parsed(out) }))
        // The key may be missing, or OneDrive may not be available: what was read stands a minute more.
        .catch(() => cached && (cached = { ...cached, at: (oneDriveSeams.now ?? Date.now)() }))
        .finally(() => (reading = false))
    }
    return cached.mounts
  }
  let mounts: WindowsOneDriveMount[] = []
  try {
    const out = oneDriveSeams.sync ? oneDriveSeams.sync() : execFileSync(regExe(), REG_ARGS, { windowsHide: true, timeout: 1_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
    mounts = parsed(out)
  } catch {
    // The key may be missing, or OneDrive may not be available.
  }
  cached = { at: now, mounts }
  return mounts
}

/** OneDrive's folders are read again at the next ask (a test, or his press on Refresh). */
export const forgetOneDrive = (): void => void (cached = undefined)
