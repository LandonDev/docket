import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * ios/TempCode/project.yml is what xcodegen writes Info.plist from at every
 * build; these pins keep the iPhone Duo's contract (docs/IOS-DESIGN.md
 * "iPhone Duo"): the outer display's orientations, the 18.0 target, the
 * iPhone family alone, and no UIRequiresFullScreen (Apple honours it, and
 * it would only shrink the app without opting it out of resizing).
 */
const yml = readFileSync(resolve(import.meta.dirname, '../ios/TempCode/project.yml'), 'utf8')

describe('ios/TempCode/project.yml', () => {
  it('allows portrait and both landscapes, never upside down', () => {
    const block = yml.match(/UISupportedInterfaceOrientations:\n((?: {10}- .*\n)+)/)?.[1] ?? ''
    const listed = block.split('\n').filter(Boolean).map((l) => l.trim().replace(/^- /, ''))
    expect(listed).toEqual(['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'])
  })

  it('targets iOS 27.0 (one minimum with work-kit\'s LifeKit) and the iPhone family', () => {
    expect(yml).toMatch(/deploymentTarget:\n\s+iOS: "27\.0"/)
    expect(yml).toContain('IPHONEOS_DEPLOYMENT_TARGET: "27.0"')
    expect(yml).toContain('TARGETED_DEVICE_FAMILY: "1"')
  })

  it("builds no x86_64 simulator slice (convex-swift has none) and names the accent asset LifeKit's ink reads", () => {
    expect(yml).toContain('EXCLUDED_ARCHS[sdk=iphonesimulator*]: x86_64')
    expect(yml).toContain('ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME: AccentColor')
    // The catalog has no AppIcon set: naming one fails the asset compile.
    expect(yml).toContain('ASSETCATALOG_COMPILER_APPICON_NAME: ""')
  })

  it('links the shared tokens to the client package in the Live Activity', () => {
    const activity = yml.match(/^  TempCodeActivity:\n([\s\S]*?)(?=^  [A-Za-z].*:\n)/m)?.[1] ?? ''
    expect(activity).toContain('path: Sources/Design/Tokens.swift')
    expect(activity).toMatch(/dependencies:\n[\s\S]*?- package: TempCodeClient\n\s+product: TempCodeClient/)
  })

  it('never requires full screen', () => {
    expect(yml).not.toContain('UIRequiresFullScreen')
  })

  it('says why it asks for the microphone and speech recognition (the voice note), in the yml and the checked-in plist', () => {
    const plist = readFileSync(resolve(import.meta.dirname, '../ios/TempCode/Info.plist'), 'utf8')
    for (const key of ['NSMicrophoneUsageDescription', 'NSSpeechRecognitionUsageDescription']) {
      expect(yml).toMatch(new RegExp(`\\n\\s+${key}: \\S`))
      expect(plist).toContain(`<key>${key}</key>`)
    }
  })

  it('says why it asks for the camera (the receipt), in the yml and the checked-in plist', () => {
    const plist = readFileSync(resolve(import.meta.dirname, '../ios/TempCode/Info.plist'), 'utf8')
    expect(yml).toMatch(/\n\s+NSCameraUsageDescription: \S/)
    expect(plist).toContain('<key>NSCameraUsageDescription</key>')
  })

  it('builds Save to TempCode as a share extension in the app group, linking the client and the contract and never LifeKit', () => {
    const share = yml.match(/^  TempCodeShare:\n([\s\S]*?)(?=^  [A-Za-z].*:\n)/m)?.[1] ?? ''
    expect(share).toContain('type: app-extension')
    expect(share).toContain('NSExtensionPointIdentifier: com.apple.share-services')
    expect(share).toContain('PRODUCT_BUNDLE_IDENTIFIER: dev.landon.tempcode.ios.share')
    expect(share).toMatch(/com\.apple\.security\.application-groups:\n\s+- group\.dev\.landon\.tempcode/)
    // Ten files or pictures and three movies, and nothing else wakes it.
    expect(share).toContain('NSExtensionActivationSupportsFileWithMaxCount: 10')
    expect(share).toContain('NSExtensionActivationSupportsImageWithMaxCount: 10')
    expect(share).toContain('NSExtensionActivationSupportsMovieWithMaxCount: 3')
    expect(share).not.toMatch(/SupportsText|SupportsWebURL|SupportsWebPage/)
    const deps = share.match(/dependencies:\n((?: {6}.*\n)+)/)?.[1] ?? ''
    expect(deps).toContain('product: TempCodeClient')
    expect(deps).toContain('product: TempCodeContract')
    expect(share).not.toMatch(/product: LifeKit/)
    // Its isolation is the app's: the target sets none of its own.
    expect(share).not.toContain('SWIFT_DEFAULT_ACTOR_ISOLATION')
    // The app embeds it and the scheme builds it.
    expect(yml).toMatch(/- target: TempCodeNotificationService\n\s+- target: TempCodeShare/)
    expect(yml).toContain('TempCodeShare: all')
    // The checked-in plist and entitlements say the same.
    const plist = readFileSync(resolve(import.meta.dirname, '../ios/TempCode/ShareExtension/Info.plist'), 'utf8')
    expect(plist).toContain('<string>com.apple.share-services</string>')
    expect(plist).toContain('<key>NSExtensionActivationSupportsMovieWithMaxCount</key>')
    expect(readFileSync(resolve(import.meta.dirname, '../ios/TempCode/ShareExtension/ShareExtension.entitlements'), 'utf8')).toContain('<string>group.dev.landon.tempcode</string>')
  })

  it('keeps the launch screen the Duo prepare page asks for', () => {
    expect(yml).toContain('UILaunchScreen: {}')
  })
})
