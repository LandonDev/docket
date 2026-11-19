import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { lifeosAddress, LIFEOS_URL, pagePolicyOf, sourcesOf, withLifeosConnect } from './pagePolicy'

const INDEX = readFileSync(resolve(__dirname, '../renderer/index.html'), 'utf8')

describe("the renderer's page policy", () => {
  it('never lets a picture load from anywhere on the web: img-src holds no https:, no http:, no wildcard', () => {
    const img = sourcesOf(pagePolicyOf(INDEX) ?? '', 'img-src')
    expect(img.length).toBeGreaterThan(0)
    for (const source of img) {
      expect(source, source).not.toMatch(/^(https?:|\*|https?:\/\/\*)$/)
      // A named host is allowed (an avatar's); a bare scheme that reaches every host is not.
      if (/^https?:/.test(source)) expect(source, source).toMatch(/^https:\/\/[a-z0-9.-]+$/)
    }
    expect(img).not.toContain('https:')
  })

  it('keeps it that way once LifeOS is written in: only connect-src changes', () => {
    const before = pagePolicyOf(INDEX) ?? ''
    const after = pagePolicyOf(withLifeosConnect(INDEX, LIFEOS_URL)) ?? ''
    expect(sourcesOf(after, 'connect-src')).toEqual([...sourcesOf(before, 'connect-src'), 'https://lifeos.landonhale.com'])
    for (const directive of ['default-src', 'script-src', 'img-src', 'style-src', 'frame-src', 'media-src', 'font-src', 'worker-src', 'object-src', 'base-uri']) {
      expect(sourcesOf(after, directive), directive).toEqual(sourcesOf(before, directive))
    }
    expect(sourcesOf(after, 'img-src')).not.toContain('https://lifeos.landonhale.com')
  })
})

describe('withLifeosConnect', () => {
  const page = (policy: string) => `<meta http-equiv="Content-Security-Policy" content="${policy}" />`

  it('writes the origin alone, whatever path or port the address carries', () => {
    expect(pagePolicyOf(withLifeosConnect(page("default-src 'self'; connect-src 'self' ws:"), 'http://127.0.0.1:3220/api/x?y=1'))).toBe(
      "default-src 'self'; connect-src 'self' ws: http://127.0.0.1:3220"
    )
  })

  it('adds a connect-src when the page has none, and is safe to run twice', () => {
    const once = withLifeosConnect(page("default-src 'self'"), LIFEOS_URL)
    expect(pagePolicyOf(once)).toBe("default-src 'self'; connect-src 'self' https://lifeos.landonhale.com")
    expect(withLifeosConnect(once, LIFEOS_URL)).toBe(once)
  })

  it('leaves the page alone for an address that is no http(s) origin', () => {
    const html = page("default-src 'self'; connect-src 'self'")
    for (const bad of ['', 'not a url', 'file:///etc/passwd', 'javascript:alert(1)', '*', 'https:']) expect(withLifeosConnect(html, bad)).toBe(html)
  })

  it('touches nothing but the policy meta', () => {
    const html = `<html><head>${page("connect-src 'self'")}<title>connect-src</title></head></html>`
    expect(withLifeosConnect(html, LIFEOS_URL)).toBe(html.replace("connect-src 'self'\"", "connect-src 'self' https://lifeos.landonhale.com\""))
  })
})

describe('lifeosAddress', () => {
  it("is the owner's own LifeOS unless an isolated instance names another", () => {
    expect(lifeosAddress({}).url).toBe(LIFEOS_URL)
    expect(lifeosAddress({ TEMP_CODE_LIFEOS_URL: 'http://127.0.0.1:3220' }).url).toBe(LIFEOS_URL)
    expect(lifeosAddress({ TEMP_CODE_USER_DATA: '/tmp/x', TEMP_CODE_LIFEOS_URL: 'http://127.0.0.1:3220' }).url).toBe('http://127.0.0.1:3220')
  })
})
