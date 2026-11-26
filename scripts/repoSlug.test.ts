import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The repo is LandonDev/docket (renamed from LandonDev/temp-code, which GitHub sends on). Every
 * place that publishes to it, reads its feed or fetches from it names the new slug, so a release
 * made today carries it in app-update.yml and no read rides the redirect.
 */
const read = (path: string): string => readFileSync(join(__dirname, '..', path), 'utf8')

describe('the repo slug', () => {
  it('is LandonDev/docket wherever a release is published, read or fetched', () => {
    expect(read('electron-builder.yml')).toMatch(/^publish:\n  provider: github\n  owner: LandonDev\n  repo: docket$/m)
    for (const [file, line] of [
      ['scripts/release-publish.sh', 'REPO="LandonDev/docket"'],
      ['scripts/release-publish.sh', 'for want in "provider: github" "owner: LandonDev" "repo: docket"; do'],
      ['scripts/release-publish-win.sh', 'REPO="LandonDev/docket"'],
      ['scripts/box/box-update-lib.sh', 'BOX_UPDATE_REPO=${BOX_UPDATE_REPO:-LandonDev/docket}'],
      ['scripts/box/box-update.sh', 'repo=https://github.com/LandonDev/docket'],
      ['src/main/deployDrift.ts', 'https://raw.githubusercontent.com/LandonDev/docket/master/release.json'],
      ['src/main/server/hostJobs.ts', 'https://github.com/LandonDev/docket/releases/latest/download/latest-mac.yml'],
      ['src/renderer/src/lib/updater.ts', 'https://github.com/LandonDev/docket/releases/latest'],
      ['ios/TempCodeClient/Sources/TempCodeClient/Client/HostExtras.swift', 'https://raw.githubusercontent.com/LandonDev/docket/master/release.json']
    ]) expect(read(file!), file).toContain(line)
  })

  it('names the old slug nowhere a release goes or is read', () => {
    for (const file of ['electron-builder.yml', 'scripts/release-publish.sh', 'scripts/release-publish-win.sh', 'scripts/box/box-update-lib.sh', 'scripts/box/box-update.sh', 'scripts/lib/winRelease.ts', 'src/main/deployDrift.ts', 'src/main/server/hostJobs.ts', 'src/renderer/src/lib/updater.ts'])
      expect(read(file), file).not.toMatch(/LandonDev\/temp-code|repo: temp-code/i)
  })
})
