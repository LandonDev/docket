import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ALLOWED_OTHERWISE, NOTICES_FILE, allowed, copyrightLines, shippedPackages } from './third-party-notices'

/**
 * THIRD-PARTY-NOTICES.md names every package the app ships, and each one's
 * licence is permissive or has a written reason (the master's licence
 * ruling: GPL, AGPL and LGPL code never ships; such tools run only as
 * separate processes). Versions are not compared: the shared node_modules
 * moves under sibling checkouts, and a patch release keeps its licence.
 */
describe('third-party notices', () => {
  const pkgs = shippedPackages()
  const text = readFileSync(NOTICES_FILE, 'utf8')

  it('ships only allowed licences', () => {
    const bad = pkgs.filter((p) => !allowed(p.licence) && !(p.name in ALLOWED_OTHERWISE)).map((p) => `${p.name}@${p.version}: ${p.licence}`)
    expect(bad, 'a shipped package has a licence outside the rule: replace it, or run it as a separate process').toEqual([])
  })

  it('names every shipped package', () => {
    const missing = [...new Set(pkgs.map((p) => p.name))].filter((n) => !text.includes(`| ${n} |`))
    expect(missing, 'THIRD-PARTY-NOTICES.md is stale: run bun scripts/third-party-notices.ts').toEqual([])
  })

  it('names every tool run beside the app', () => {
    for (const id of ['libreoffice', 'ffmpeg', 'onlyoffice', 'pymupdf4llm', 'screen-relay']) expect(text).toContain(`| ${id} |`)
  })

  it('says what we carry of screen-relay, and that its engine and x264 never ship', () => {
    expect(text).toContain('src/shared/video/nsl1.ts')
    expect(text).toMatch(/screen-relay[^\n]*Apache-2\.0/)
    expect(text).toMatch(/x264 \(GPL-2\.0-or-later\)/)
  })

  it('reads an SPDX expression as the licence asks', () => {
    expect(allowed('MIT')).toBe(true)
    expect(allowed('(MIT OR GPL-3.0-or-later)')).toBe(true)
    expect(allowed('MIT AND Zlib')).toBe(true)
    expect(allowed('MIT AND GPL-3.0-only')).toBe(false)
    expect(allowed('AGPL-3.0-only')).toBe(false)
    expect(allowed('LGPL-3.0-or-later')).toBe(false)
    expect(allowed('UNKNOWN')).toBe(false)
  })

  it('keeps a licence file’s copyright lines and drops its boilerplate', () => {
    const mit = 'MIT License\n\nCopyright (c) 2021 Jane Doe\nCopyright (c) 2021 Jane Doe\n\nThe above copyright notice and this permission notice shall be included'
    expect(copyrightLines(mit)).toEqual(['Copyright (c) 2021 Jane Doe'])
    expect(copyrightLines('Copyright [yyyy] [name of copyright owner]')).toEqual([])
    expect(copyrightLines(null)).toEqual([])
  })
})
