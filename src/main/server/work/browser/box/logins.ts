import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Cdp } from './cdp'

/**
 * Logins for the box's browser (docs/agents/work-browser.md "Logins"): the
 * box never sees a password. Either he exports a site's cookies from Chrome
 * on his Mac (exportLogins.ts, which he runs and which asks his Keychain)
 * and copies the file into the box profile's `import/` folder, which the
 * browser takes in and deletes the next time it is used; or a page that
 * wants him is asked for with `browser_needs_you`, and he signs in there
 * himself.
 */

/** One cookie as DevTools takes it (`Storage.setCookies`), and as Playwright's storage state writes it. */
export interface LoginCookie {
  name: string
  value: string
  domain: string
  path: string
  /** unix seconds; -1 for a session cookie */
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
}

export interface LoginExport {
  cookies: LoginCookie[]
}

export const importDir = (root: string): string => join(root, 'import')

/**
 * Takes in every export waiting in the import folder, then deletes it:
 * the file holds his sessions and stays no longer than it must. A file
 * that does not parse is deleted too, and said.
 */
export async function takeImports(root: string, cdp: Cdp, log: (line: string) => void): Promise<number> {
  const dir = importDir(root)
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'))
  } catch {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return 0
  }
  let taken = 0
  for (const name of names) {
    const path = join(dir, name)
    try {
      const cookies = parseExport(readFileSync(path, 'utf8'))
      await cdp.send('Storage.setCookies', { cookies })
      taken += cookies.length
      log(`logins: took ${cookies.length} cookies for ${[...new Set(cookies.map((c) => c.domain.replace(/^\./, '')))].join(', ')}`)
    } catch (err) {
      log(`logins: ${name} was not taken: ${(err as Error).message}`)
    } finally {
      rmSync(path, { force: true })
    }
  }
  return taken
}

/** An export's cookies, checked: each needs a name, a domain and a path. */
export function parseExport(text: string): LoginCookie[] {
  const raw = JSON.parse(text) as { cookies?: unknown }
  if (!Array.isArray(raw.cookies)) throw new Error('no cookies in the file')
  return raw.cookies.map((c: Partial<LoginCookie>) => {
    if (!c.name || typeof c.value !== 'string' || !c.domain) throw new Error('a cookie lacks its name, value or domain')
    return {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      expires: typeof c.expires === 'number' ? c.expires : -1,
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
      ...(c.sameSite ? { sameSite: c.sameSite } : {})
    }
  })
}

// ── the Mac's side: reading Chrome's cookie store ──────────────────────

/** The key Chrome on the Mac encrypts cookies with, from its Keychain password ("Chrome Safe Storage"). */
export const chromeKey = (password: string): Buffer => pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')

/**
 * A cookie's value from Chrome's store: `v10` and AES-128-CBC under the
 * Keychain key; from store version 24 on, the plain text starts with the
 * SHA-256 of the cookie's host, which is checked and dropped.
 */
export function decryptCookie(encrypted: Buffer, key: Buffer, host: string, storeVersion: number): string {
  if (!encrypted.length) return ''
  if (encrypted.subarray(0, 3).toString() !== 'v10') throw new Error('not a v10 cookie')
  const d = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  let plain = Buffer.concat([d.update(encrypted.subarray(3)), d.final()])
  if (storeVersion >= 24) {
    const hash = createHash('sha256').update(host).digest()
    if (!plain.subarray(0, 32).equals(hash)) throw new Error(`a cookie of ${host} does not carry its host's hash`)
    plain = plain.subarray(32)
  }
  return plain.toString('utf8')
}

/** One row of Chrome's `cookies` table, as `sqlite3 -json` gives it. */
export interface ChromeCookieRow {
  host_key: string
  name: string
  path: string
  expires_utc: number
  is_secure: number
  is_httponly: number
  samesite: number
  ev: string
  value: string
}

const SAME_SITE: Record<number, LoginCookie['sameSite']> = { 0: 'None', 1: 'Lax', 2: 'Strict' }

export function cookieOfRow(row: ChromeCookieRow, key: Buffer, storeVersion: number): LoginCookie {
  const value = row.value || decryptCookie(Buffer.from(row.ev, 'hex'), key, row.host_key, storeVersion)
  // Chrome counts microseconds from 1601; 0 is a session cookie.
  const expires = row.expires_utc ? Math.round(row.expires_utc / 1e6 - 11_644_473_600) : -1
  const sameSite = SAME_SITE[row.samesite]
  return { name: row.name, value, domain: row.host_key, path: row.path, expires, httpOnly: !!row.is_httponly, secure: !!row.is_secure, ...(sameSite ? { sameSite } : {}) }
}

/** A site and every subdomain of it: `outlook.office.com` takes `.outlook.office.com` and `x.outlook.office.com`. */
export const onSites = (host: string, sites: readonly string[]): boolean => {
  const h = host.replace(/^\./, '').toLowerCase()
  return sites.some((s) => h === s.toLowerCase() || h.endsWith(`.${s.toLowerCase()}`))
}

/** The sites an Outlook on the web sign-in needs. */
export const OUTLOOK_SITES = ['outlook.office.com', 'outlook.office365.com', 'outlook.cloud.microsoft', 'login.microsoftonline.com', 'login.live.com', 'office.com', 'microsoft365.com']
