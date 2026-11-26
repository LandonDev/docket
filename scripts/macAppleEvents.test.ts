import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

// Office scripting on the Mac (docs/agents/work-office.md) and the terminal restart after an
// account switch send Apple Events. Under the hardened runtime macOS refuses them without a
// prompt (-1743) unless the bundle carries both the usage string and the automation entitlement.
const root = resolve(__dirname, '..')

describe('the macOS build may send Apple Events', () => {
  it('keeps all five usage strings and the Handoff activity in the Info.plist map', () => {
    const config = load(readFileSync(join(root, 'electron-builder.yml'), 'utf8')) as { mac: { extendInfo: Record<string, unknown> } }
    const info = config.mac.extendInfo
    expect(Array.isArray(info)).toBe(false)
    expect(info).toMatchObject({
      NSCameraUsageDescription: "Application requests access to the device's camera.",
      NSMicrophoneUsageDescription: "Application requests access to the device's microphone.",
      NSDocumentsFolderUsageDescription: "Application requests access to the user's Documents folder.",
      NSDownloadsFolderUsageDescription: "Application requests access to the user's Downloads folder.",
      // The first Print… asks for Preview: the reason names it, never Office alone.
      NSAppleEventsUsageDescription: 'Docket drives Excel, Word, PowerPoint and Outlook for your agents, asks Preview to print what you print, and restarts your terminal sessions after switching accounts.',
      NSUserActivityTypes: ['dev.landon.tempcode.open']
    })
  })

  it('carries the automation entitlement, which the helpers inherit', () => {
    const plist = readFileSync(join(root, 'build/entitlements.mac.plist'), 'utf8')
    expect(plist).toMatch(/<key>com\.apple\.security\.automation\.apple-events<\/key>\s*<true\/>/)
    const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
    expect(yml).toContain('  entitlements: build/entitlements.mac.plist')
    expect(yml).toContain('  entitlementsInherit: build/entitlements.mac.plist')
  })
})
