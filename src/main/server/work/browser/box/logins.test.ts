import { createCipheriv, createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Cdp } from './cdp'
import { BoxChromium, findChromium } from './chromium'
import { chromeKey, cookieOfRow, decryptCookie, importDir, onSites, parseExport, takeImports } from './logins'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })))

/** A value as Chrome on the Mac stores it. */
const encrypt = (value: string, key: Buffer, host: string, version: number): Buffer => {
  const c = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  const plain = Buffer.concat([version >= 24 ? createHash('sha256').update(host).digest() : Buffer.alloc(0), Buffer.from(value)])
  return Buffer.concat([Buffer.from('v10'), c.update(plain), c.final()])
}

describe('logins from his Mac', () => {
  const key = chromeKey('peanuts-from-keychain')

  it("reads Chrome's encrypted values, before and after the host hash", () => {
    expect(decryptCookie(encrypt('abc', key, '.login.microsoftonline.com', 23), key, '.login.microsoftonline.com', 23)).toBe('abc')
    expect(decryptCookie(encrypt('abc', key, '.login.microsoftonline.com', 24), key, '.login.microsoftonline.com', 24)).toBe('abc')
    // a value moved to another host's row does not pass
    expect(() => decryptCookie(encrypt('abc', key, 'evil.example', 24), key, '.login.microsoftonline.com', 24)).toThrow(/hash/)
  })

  it("turns a store row into DevTools' cookie, its expiry from Chrome's 1601 clock", () => {
    const row = { host_key: '.outlook.office.com', name: 'X-OWA-CANARY', path: '/', expires_utc: 13_400_000_000_000_000, is_secure: 1, is_httponly: 0, samesite: 0, ev: encrypt('v', key, '.outlook.office.com', 24).toString('hex'), value: '' }
    expect(cookieOfRow(row, key, 24)).toEqual({ name: 'X-OWA-CANARY', value: 'v', domain: '.outlook.office.com', path: '/', expires: 1_755_526_400, httpOnly: false, secure: true, sameSite: 'None' })
    expect(cookieOfRow({ ...row, expires_utc: 0, samesite: -1 }, key, 24)).not.toHaveProperty('sameSite')
  })

  it('takes a site and its subdomains, nothing else', () => {
    expect(onSites('.login.microsoftonline.com', ['login.microsoftonline.com'])).toBe(true)
    expect(onSites('a.outlook.office.com', ['outlook.office.com'])).toBe(true)
    expect(onSites('notoutlook.office.com', ['outlook.office.com'])).toBe(false)
    expect(() => parseExport('{"cookies":[{"name":"a"}]}')).toThrow()
  })

  const bin = findChromium()
  it.runIf(!!bin && process.platform === 'linux')('takes an export into the box profile and deletes the file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'm38-login-'))
    dirs.push(root)
    const browser = new BoxChromium({ root, bin: () => bin })
    const cdp = await Cdp.open(await browser.endpoint())
    try {
      expect(await takeImports(root, cdp, () => {})).toBe(0)
      mkdirSync(importDir(root), { recursive: true })
      const file = join(importDir(root), 'logins.json')
      writeFileSync(file, JSON.stringify({ cookies: [{ name: 'ESTSAUTHPERSISTENT', value: 'tok', domain: '.login.microsoftonline.com', path: '/', expires: 4_000_000_000, httpOnly: true, secure: true, sameSite: 'None' }] }))
      writeFileSync(join(importDir(root), 'broken.json'), '{')
      const lines: string[] = []
      expect(await takeImports(root, cdp, (l) => lines.push(l))).toBe(1)
      expect(existsSync(file)).toBe(false)
      expect(existsSync(join(importDir(root), 'broken.json'))).toBe(false)
      expect(lines.join('\n')).toMatch(/took 1 cookies for login\.microsoftonline\.com/)
      const { cookies } = await cdp.send<{ cookies: { name: string; value: string }[] }>('Storage.getCookies')
      expect(cookies.find((c) => c.name === 'ESTSAUTHPERSISTENT')?.value).toBe('tok')
    } finally {
      cdp.close()
      await browser.stop()
    }
  }, 30_000)
})
