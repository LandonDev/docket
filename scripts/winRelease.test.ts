import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import {
  packagesIn,
  binaryKind,
  lockIntegrity,
  packedAppProblems,
  parseFeed,
  platformOfPackage,
  STAGE_DIR,
  tarballUrl,
  WIN_CLI_PACKAGE,
  WIN_CONFIG,
  winFilesProblems,
  winReleaseFiles,
  type PackedApp
} from './lib/winRelease'

const REPO = resolve(__dirname, '..')
const read = (file: string): string => readFileSync(resolve(REPO, file), 'utf8')

/** A PE header: MZ, the PE offset at 0x3c, then "PE\0\0" and the machine. */
function pe(machine: number): Uint8Array {
  const head = new Uint8Array(0x100)
  head.set([0x4d, 0x5a])
  head[0x3c] = 0x80
  head.set([0x50, 0x45, 0, 0, machine & 0xff, machine >> 8], 0x80)
  return head
}
const MACH_O = new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0])
const ELF = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0])

const good: PackedApp = {
  packages: ['@anthropic-ai/claude-agent-sdk', WIN_CLI_PACKAGE, '@muse-code/sdk', 'node-pty'],
  cliHead: pe(0x8664),
  cliVersion: '0.3.280',
  sdkVersion: '0.3.280',
  sdkWants: '0.3.280',
  muse: {},
  ptyPrebuild: true,
  foreignBinaries: []
}

describe('the Windows release file list', () => {
  it('is the installer, its blockmap, the zip and the feed file', () => {
    expect(winReleaseFiles('1.0.412')).toEqual({
      installer: 'temp-code-1.0.412-setup.exe',
      blockmap: 'temp-code-1.0.412-setup.exe.blockmap',
      zip: 'TempCode-1.0.412-win-x64.zip',
      feed: 'latest.yml'
    })
  })

  it('names what electron-builder.yml makes', () => {
    const config = load(read('electron-builder.yml')) as {
      productName: string
      win: { artifactName: string; target: { target: string; arch: string }[] }
      nsis: { artifactName: string }
    }
    const name = (JSON.parse(read('package.json')) as { name: string }).name
    const fill = (pattern: string, ext: string): string =>
      pattern
        .replace('${productName}', config.productName)
        .replace('${name}', name)
        .replace('${version}', '1.0.412')
        .replace('${arch}', 'x64')
        .replace('${ext}', ext)
    const files = winReleaseFiles('1.0.412')
    expect(fill(config.nsis.artifactName, 'exe')).toBe(files.installer)
    expect(fill(config.win.artifactName, 'zip')).toBe(files.zip)
    expect(config.win.target).toEqual([
      { target: 'nsis', arch: 'x64' },
      { target: 'zip', arch: 'x64' }
    ])
  })

  it('is what release-publish.sh uploads with --win, and only with it', () => {
    const script = read('scripts/release-publish.sh')
    const files = winReleaseFiles('$VERSION')
    for (const name of Object.values(files)) expect(script).toContain(`dist/${name}`)
    // Off by default: the Windows pass and its upload both sit behind the flag.
    expect(script).toMatch(/^WIN=\$\{TEMP_CODE_WIN:-0\}$/m)
    const guarded = [...script.matchAll(/^if \[ "\$WIN" = 1 \]; then\n([\s\S]*?)^fi$/gm)].map((m) => m[1]).join('\n')
    expect(guarded).toContain(`electron-builder --win --x64 --publish never --config ${WIN_CONFIG}`)
    expect(guarded).toContain('win-stage.ts stage')
    expect(guarded).toContain('win-stage.ts check-app')
    expect(guarded).toContain('win-stage.ts check-files')
    expect(guarded).toContain('dist/latest.yml')
    const unguarded = script
      .replace(/^if \[ "\$WIN" = 1 \]; then\n[\s\S]*?^fi$/gm, '')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
    expect(unguarded).not.toContain('--win --x64')
    expect(unguarded).not.toContain('win-stage.ts')
    expect(unguarded).not.toContain('setup.exe')
  })

  it('refuses a missing or empty file and a feed that names another build', () => {
    const files = winReleaseFiles('1.0.412')
    const present = {
      [files.installer]: { size: 900, sha512: 'abc' },
      [files.blockmap]: { size: 10 },
      [files.zip]: { size: 950 },
      [files.feed]: { size: 300 }
    }
    const feed = `version: 1.0.412\nfiles:\n  - url: ${files.installer}\n    sha512: abc\n    size: 900\npath: ${files.installer}\nsha512: abc\nreleaseDate: '2026-11-19T00:00:00.000Z'\n`
    expect(winFilesProblems('1.0.412', present, feed)).toEqual([])
    expect(winFilesProblems('1.0.412', { ...present, [files.zip]: undefined }, feed)).toEqual([`${files.zip} is missing`])
    expect(winFilesProblems('1.0.412', { ...present, [files.blockmap]: { size: 0 } }, feed)).toEqual([`${files.blockmap} is empty`])
    expect(winFilesProblems('1.0.413', {}, null)).toHaveLength(4)
    expect(winFilesProblems('1.0.412', present, feed.replace('version: 1.0.412', 'version: 1.0.411'))).toEqual(['latest.yml says version 1.0.411, not 1.0.412'])
    expect(winFilesProblems('1.0.412', { ...present, [files.installer]: { size: 901, sha512: 'xyz' } }, feed)).toEqual([
      'latest.yml gives the installer 900 bytes; it has 901',
      'latest.yml carries another checksum than the installer has'
    ])
    expect(parseFeed(feed)).toEqual({ version: '1.0.412', path: files.installer, sha512: 'abc', size: 900 })
  })
})

describe('the staged Claude CLI', () => {
  it('is the package the installed SDK asks for, with a checksum in bun.lock', () => {
    const sdk = JSON.parse(read('node_modules/@anthropic-ai/claude-agent-sdk/package.json')) as { optionalDependencies: Record<string, string> }
    const wants = sdk.optionalDependencies[WIN_CLI_PACKAGE]
    expect(wants).toMatch(/^\d+\.\d+\.\d+$/)
    expect(lockIntegrity(read('bun.lock'), WIN_CLI_PACKAGE, wants)).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/)
    expect(tarballUrl(WIN_CLI_PACKAGE, wants)).toBe(`https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-win32-x64/-/claude-agent-sdk-win32-x64-${wants}.tgz`)
  })

  it('reads one checksum per package version and none for a stranger', () => {
    const lock = [
      '    "@a/cli-win32-x64": ["@a/cli-win32-x64@1.2.3", "", { "os": "win32", "cpu": "x64" }, "sha512-AAAA+/=="],',
      '    "@a/cli-win32-arm64": ["@a/cli-win32-arm64@1.2.3", "", { "os": "win32", "cpu": "arm64" }, "sha512-BBBB=="],'
    ].join('\n')
    expect(lockIntegrity(lock, '@a/cli-win32-x64', '1.2.3')).toBe('sha512-AAAA+/==')
    expect(lockIntegrity(lock, '@a/cli-win32-arm64', '1.2.3')).toBe('sha512-BBBB==')
    expect(lockIntegrity(lock, '@a/cli-win32-x64', '9.9.9')).toBeNull()
  })

  it('is laid into the Windows pack alone: the Mac build never sees the stage', () => {
    const config = load(read('electron-builder.yml')) as {
      files: unknown[]
      extends?: unknown
      mac: { files?: unknown; target: unknown }
      win: { files?: unknown; signtoolOptions: { sign: string } }
      nsis: { oneClick: boolean; perMachine: boolean; include: string }
    }
    const win = load(read(WIN_CONFIG)) as { extends: string; files: (string | { from: string; to: string })[] }
    // The Windows config is the Mac's plus file rules, and nothing else.
    expect(Object.keys(win).sort()).toEqual(['extends', 'files'])
    expect(win.extends).toBe('./electron-builder.yml')
    expect(win.files).toContainEqual({ from: STAGE_DIR, to: 'node_modules' })
    // Every other rule is an exclusion: a platform's string patterns must only ever take away.
    for (const rule of win.files) if (typeof rule === 'string') expect(rule.startsWith('!')).toBe(true)
    // The main config names no stage and no platform file rules: a string under `win.files` would
    // become a second file set and undo the exclusions above it.
    expect(JSON.stringify(config.files)).not.toContain('win-stage')
    expect(config.extends).toBeUndefined()
    expect(config.mac.files).toBeUndefined()
    expect(config.win.files).toBeUndefined()
    // The Mac's targets are what they were: a zip and a dmg for Apple silicon.
    expect(config.mac.target).toEqual([
      { target: 'zip', arch: 'arm64' },
      { target: 'dmg', arch: 'arm64' }
    ])
    // Per user, one click, no admin; the folder is named by the include; the sign hook is there and signs nothing.
    expect(config.nsis).toMatchObject({ oneClick: true, perMachine: false, include: 'build/installer.nsh' })
    expect(read(config.nsis.include)).toContain('${PRODUCT_FILENAME}')
    expect(config.win.signtoolOptions.sign).toBe('./build/sign-win.mjs')
  })

  it("the Windows rules take out another platform's binaries by name", () => {
    const win = load(read(WIN_CONFIG)) as { files: (string | object)[] }
    const rules = win.files.filter((rule): rule is string => typeof rule === 'string').join('\n')
    expect(rules).toContain('*-{darwin,linux}-{x64,arm64}')
    expect(rules).toContain('claude-agent-sdk-win32-*')
    expect(rules).toContain('resources/native/{appshot-helper,tc-computer,tc-computer.stamp}')
  })

  it('the signing hook is empty: it resolves and touches nothing', async () => {
    const hook = (await import('../build/sign-win.mjs')) as { default: (configuration: { path: string }) => Promise<void> }
    await expect(hook.default({ path: '/nonexistent/TempCode.exe' })).resolves.toBeUndefined()
  })
})

describe('what kind of binary a file is', () => {
  it('tells a 64-bit Windows executable from an ARM one, a Mach-O and an ELF', () => {
    expect(binaryKind(pe(0x8664))).toBe('pe-x64')
    expect(binaryKind(pe(0xaa64))).toBe('pe-arm64')
    expect(binaryKind(pe(0x014c))).toBe('pe-other')
    expect(binaryKind(MACH_O)).toBe('mach-o')
    expect(binaryKind(ELF)).toBe('elf')
    expect(binaryKind(new Uint8Array([0x23, 0x21, 0x2f]))).toBe('other')
    expect(binaryKind(new Uint8Array())).toBe('other')
  })

  it('reads a package name for the platform it was built for', () => {
    expect(platformOfPackage('@anthropic-ai/claude-agent-sdk-darwin-arm64')).toBe('darwin')
    expect(platformOfPackage('@anthropic-ai/claude-agent-sdk-linux-x64-musl')).toBe('linux')
    expect(platformOfPackage(WIN_CLI_PACKAGE)).toBe('win32')
    expect(platformOfPackage('@anthropic-ai/claude-agent-sdk')).toBeNull()
    expect(platformOfPackage('node-pty')).toBeNull()
  })
})

describe('the release check on a packed Windows app', () => {
  it('passes an app with the win32 CLI the SDK asks for', () => {
    expect(packedAppProblems(good)).toEqual([])
  })

  it('fails without the CLI, which is what a build made on a Mac carries unless it is staged', () => {
    const problems = packedAppProblems({ ...good, cliHead: null, cliVersion: null, packages: ['@anthropic-ai/claude-agent-sdk', '@anthropic-ai/claude-agent-sdk-darwin-arm64'] })
    expect(problems[0]).toContain('claude.exe is missing')
    expect(problems).toContain('@anthropic-ai/claude-agent-sdk-darwin-arm64 is a darwin package in a Windows build')
  })

  it('fails on the wrong machine, the wrong version and a linux package beside it', () => {
    expect(packedAppProblems({ ...good, cliHead: MACH_O })[0]).toContain('not a 64-bit Windows executable (mach-o)')
    expect(packedAppProblems({ ...good, cliHead: pe(0xaa64) })[0]).toContain('pe-arm64')
    expect(packedAppProblems({ ...good, cliVersion: '0.3.279' })).toEqual(['the staged Claude CLI is 0.3.279; @anthropic-ai/claude-agent-sdk 0.3.280 wants 0.3.280'])
    expect(packedAppProblems({ ...good, packages: [...good.packages, '@anthropic-ai/claude-agent-sdk-linux-x64'] })).toEqual([
      '@anthropic-ai/claude-agent-sdk-linux-x64 is a linux package in a Windows build'
    ])
  })

  it("fails the day Muse's SDK ships a binary of its own, so someone stages it", () => {
    expect(packedAppProblems({ ...good, muse: { optionalDependencies: { '@muse-code/sdk-win32-x64': '1.0.0' } } })).toHaveLength(1)
    expect(packedAppProblems({ ...good, muse: { bin: { muse: 'bin/muse' } } })).toHaveLength(1)
    // An app that does not carry the SDK at all has nothing to stage.
    expect(packedAppProblems({ ...good, muse: null })).toEqual([])
  })

  it("fails without node-pty's Windows prebuild and with a Mac helper left in resources/native", () => {
    expect(packedAppProblems({ ...good, ptyPrebuild: false })).toEqual(['node-pty has no win32-x64 prebuild in the app'])
    expect(packedAppProblems({ ...good, foreignBinaries: ['resources/native/tc-computer'] })).toEqual(['resources/native/tc-computer is not a Windows binary'])
  })

  it('the installed Muse SDK is plain JavaScript today', () => {
    const muse = JSON.parse(read('node_modules/@muse-code/sdk/package.json')) as { optionalDependencies?: Record<string, string>; bin?: unknown }
    expect(Object.keys(muse.optionalDependencies ?? {})).toEqual([])
    expect(muse.bin).toBeUndefined()
  })
})

describe('packagesIn', () => {
  it('lists nested packages too, so a platform binary a level down fails the check', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-packages-'))
    try {
      for (const p of ['node-pty', '@scope/a/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64', '.bin']) mkdirSync(join(dir, p), { recursive: true })
      expect(packagesIn(dir).sort()).toEqual(['@anthropic-ai/claude-agent-sdk-darwin-arm64', '@scope/a', 'node-pty'])
      expect(packagesIn(join(dir, 'missing'))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
