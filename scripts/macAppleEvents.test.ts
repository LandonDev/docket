import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Office scripting on the Mac (docs/agents/work-office.md) and the terminal restart after an
// account switch send Apple Events. Under the hardened runtime macOS refuses them without a
// prompt (-1743) unless the bundle carries both the usage string and the automation entitlement.
const root = resolve(__dirname, '..')

describe('the macOS build may send Apple Events', () => {
  it('names Office in the usage string under mac.extendInfo', () => {
    const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
    const mac = yml.slice(yml.indexOf('\nmac:'), yml.indexOf('\ndmg:'))
    const line = mac.split('\n').find((l) => l.includes('NSAppleEventsUsageDescription:'))
    expect(line).toBeDefined()
    for (const app of ['Excel', 'Word', 'PowerPoint', 'Outlook']) expect(line).toContain(app)
  })

  it('carries the automation entitlement, which the helpers inherit', () => {
    const plist = readFileSync(join(root, 'build/entitlements.mac.plist'), 'utf8')
    expect(plist).toMatch(/<key>com\.apple\.security\.automation\.apple-events<\/key>\s*<true\/>/)
    const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
    expect(yml).toContain('  entitlements: build/entitlements.mac.plist')
    expect(yml).toContain('  entitlementsInherit: build/entitlements.mac.plist')
  })
})
