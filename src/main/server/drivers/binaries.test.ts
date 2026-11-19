import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const fake = { path: null as string | null }

vi.mock('./harness/child', async () => ({
  ...(await vi.importActual<typeof import('./harness/child')>('./harness/child')),
  resolveMuseBinary: async () => {
    if (!fake.path) throw new Error('muse not found on the login-shell PATH')
    return { path: fake.path }
  }
}))

const { checkProvider, harnessEnv } = await import('./binaries')

describe('the doctor row for Muse Code', () => {
  // A sh script as the launcher: POSIX hosts only.
  it.skipIf(process.platform === 'win32')('names the version the launcher prints when the binary is installed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-doctor-'))
    const bin = join(dir, 'muse')
    writeFileSync(bin, '#!/bin/sh\necho "Muse Code 1.4.14 (1.4.14-R7309.1)"\n')
    chmodSync(bin, 0o755)
    fake.path = bin
    const report = await checkProvider('muse')
    expect(report).toEqual({ found: true, path: bin, version: 'Muse Code 1.4.14 (1.4.14-R7309.1)' })
  })

  it('reports the finder\'s words when the binary is absent', async () => {
    fake.path = null
    const report = await checkProvider('muse')
    expect(report.found).toBe(false)
    expect(report.error).toMatch(/muse not found/)
  })
})

describe('the environment a harness child gets', () => {
  it("carries no proof's token seed, which would let the child make any thread's token", async () => {
    vi.stubEnv('TEMP_CODE_APP_TOKEN_SEED', 'ab'.repeat(32))
    vi.stubEnv('TEMP_CODE_MAC_TOKEN_SEED', 'cd'.repeat(32))
    vi.stubEnv('TEMP_CODE_USER_DATA', '/tmp/tc-test')
    try {
      const env = await harnessEnv()
      expect(Object.keys(env).filter((k) => k.endsWith('_TOKEN_SEED'))).toEqual([])
      expect(env.TEMP_CODE_USER_DATA).toBe('/tmp/tc-test')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('finding a binary on win32', () => {
  it('tries the name with each PATHEXT extension, in its order; the name alone elsewhere', async () => {
    const { binaryCandidates } = await import('./binaries')
    expect(binaryCandidates('/d', 'codex', 'linux')).toEqual([join('/d', 'codex')])
    expect(binaryCandidates('/d', 'codex', 'win32', '.COM;.EXE;.CMD')).toEqual(['codex.com', 'codex.exe', 'codex.cmd'].map((n) => join('/d', n)))
    expect(binaryCandidates('/d', 'node.exe', 'win32', '.EXE')).toEqual([join('/d', 'node.exe')])
  })

  it("resolves npm's codex.cmd to the codex.exe its platform package carries", async () => {
    const { npmShimExe } = await import('./binaries')
    const { mkdirSync } = await import('node:fs')
    const npm = mkdtempSync(join(tmpdir(), 'tc-npm-'))
    const shim = join(npm, 'codex.cmd')
    writeFileSync(shim, '@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n')
    expect(await npmShimExe(shim, 'codex')).toBeNull()
    const bin = join(npm, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'codex.exe'), '')
    expect(await npmShimExe(shim, 'codex')).toBe(join(bin, 'codex.exe'))
    // opencode's platform package keeps its program under bin/
    writeFileSync(join(npm, 'opencode.cmd'), '"%_prog%"  "%dp0%\\node_modules\\opencode-ai\\bin\\opencode" %*')
    const ocBin = join(npm, 'node_modules', 'opencode-ai', 'node_modules', 'opencode-windows-x64', 'bin')
    mkdirSync(ocBin, { recursive: true })
    writeFileSync(join(ocBin, 'opencode.exe'), '')
    expect(await npmShimExe(join(npm, 'opencode.cmd'), 'opencode')).toBe(join(ocBin, 'opencode.exe'))
    const other = join(npm, 'npx.cmd')
    writeFileSync(other, '"%_prog%" "%dp0%\\node_modules\\npm\\bin\\npx-cli.js" %*')
    expect(await npmShimExe(other, 'npx')).toBeNull()
  })
})

describe('withGitBash', () => {
  it("names a per-user Git for Windows' bash to Claude Code on Windows, keeps a set path, and touches nothing elsewhere", async () => {
    const { withGitBash } = await import('./binaries')
    const bash = 'C:\\Users\\tc\\AppData\\Local\\Programs\\Git\\bin\\bash.exe'
    const has = (path: string): boolean => path === bash
    expect(withGitBash({ LOCALAPPDATA: 'C:\\Users\\tc\\AppData\\Local' }, 'win32', has).CLAUDE_CODE_GIT_BASH_PATH).toBe(bash)
    const set = 'D:\\Git\\bin\\bash.exe'
    expect(withGitBash({ CLAUDE_CODE_GIT_BASH_PATH: set, LOCALAPPDATA: 'C:\\Users\\tc\\AppData\\Local' }, 'win32', (p) => p === set || has(p)).CLAUDE_CODE_GIT_BASH_PATH).toBe(set)
    expect(withGitBash({}, 'win32', () => false).CLAUDE_CODE_GIT_BASH_PATH).toBeUndefined()
    expect(withGitBash({ LOCALAPPDATA: 'x' }, 'linux', () => true).CLAUDE_CODE_GIT_BASH_PATH).toBeUndefined()
  })
})
