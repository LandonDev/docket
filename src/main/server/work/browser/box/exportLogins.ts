/**
 * Run by him on his Mac, never by an agent (docs/agents/work-browser.md
 * "Logins"): exports Chrome's cookies for the sites named, so the box's
 * browser is signed in as his Chrome is. macOS asks him to let `security`
 * read "Chrome Safe Storage" from his Keychain; nothing else is read.
 *
 *   bun src/main/server/work/browser/box/exportLogins.ts [--profile Default] [--sites a.com,b.com] > logins.json
 *   scp logins.json box:/srv/agents/temp-code-data/work-browser/box/import/
 *
 * With no --sites it exports what Outlook on the web needs (OUTLOOK_SITES).
 * The box takes the file in the next time its browser is used and deletes it.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromeKey, cookieOfRow, OUTLOOK_SITES, onSites, type ChromeCookieRow } from './logins'

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : undefined
}

const profile = arg('profile') ?? 'Default'
const sites = arg('sites')?.split(',').map((s) => s.trim()).filter(Boolean) ?? OUTLOOK_SITES
const store = join(homedir(), 'Library/Application Support/Google/Chrome', profile, 'Cookies')
const dir = mkdtempSync(join(tmpdir(), 'tc-logins-'))
try {
  // Chrome holds its store open: read a copy.
  const copy = join(dir, 'Cookies')
  copyFileSync(store, copy)
  const sql = (q: string): unknown[] => JSON.parse(execFileSync('sqlite3', ['-json', copy, q], { encoding: 'utf8' }) || '[]') as unknown[]
  const version = Number((sql("SELECT value FROM meta WHERE key = 'version'")[0] as { value?: string } | undefined)?.value ?? 0)
  const password = execFileSync('security', ['find-generic-password', '-w', '-s', 'Chrome Safe Storage'], { encoding: 'utf8' }).trim()
  const key = chromeKey(password)
  const rows = sql('SELECT host_key, name, path, expires_utc, is_secure, is_httponly, samesite, hex(encrypted_value) AS ev, value FROM cookies') as ChromeCookieRow[]
  const cookies = rows.filter((r) => onSites(r.host_key, sites)).map((r) => cookieOfRow(r, key, version))
  process.stdout.write(`${JSON.stringify({ cookies })}\n`)
  process.stderr.write(`${cookies.length} cookies for ${sites.join(', ')}\n`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
