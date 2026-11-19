import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { platformOf, Toolchain, ToolManifestSchema, type Platform } from '../../src/main/server/work/formats/tools'
import { install, loadManifests } from './installer'

/**
 * The installer against a fake download server: tarballs made here, served
 * by a fetch stand-in, so nothing leaves the machine. What it proves: a
 * tool lands under work-tools/<name>/<version>/ and is probed; a wrong
 * checksum or size installs nothing; a second pillar's manifest adds a tool
 * without touching another file; needs install first and a failed need
 * skips what is built on it; a second run downloads nothing.
 */
const platform = platformOf() as Platform
let root: string
let served: Map<string, Buffer>
let fetched: string[]
const fakeFetch = (async (url: string | URL | Request) => {
  const key = String(url)
  fetched.push(key)
  const body = served.get(key)
  if (!body) return new Response('missing', { status: 404 })
  return new Response(new Uint8Array(body))
}) as typeof fetch

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tc-work-tools-'))
  served = new Map()
  fetched = []
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** A tar.gz holding `tool-<v>/bin/<name>`, a script that prints "<name> <v>" (or `says`). */
function tarball(name: string, version: string, says = `${name} ${version}`): { url: string; sha256: string; size: number } {
  const src = join(root, 'src', `${name}-${version}`)
  mkdirSync(join(src, `tool-${version}`, 'bin'), { recursive: true })
  const script = join(src, `tool-${version}`, 'bin', name)
  writeFileSync(script, `#!/bin/sh\necho "${says} $@"\n`)
  chmodSync(script, 0o755)
  const file = join(root, 'src', `${name}-${version}-${createHash('sha256').update(says).digest('hex').slice(0, 6)}.tar.gz`)
  execFileSync('tar', ['-czf', file, '-C', src, `tool-${version}`])
  const body = readFileSync(file)
  const url = `https://downloads.test/${name}-${version}${says === `${name} ${version}` ? '' : '-broken'}.tar.gz`
  served.set(url, body)
  return { url, sha256: createHash('sha256').update(body).digest('hex'), size: body.length }
}

function manifest(dir: string, file: string, pillar: string, tools: object[]): void {
  mkdirSync(dir, { recursive: true })
  const m = { pillar, tools }
  ToolManifestSchema.parse(m)
  writeFileSync(join(dir, file), JSON.stringify(m))
}

const tool = (name: string, version: string, file: object, extra: object = {}): object => ({
  name,
  version,
  licence: 'MIT',
  licenceNote: 'a separate process',
  homepage: 'https://example.test/',
  platforms: { [platform]: { kind: 'archive', files: [{ ...file, strip: 1 }], bin: `bin/${name}` } },
  probe: { steps: [{ run: ['{bin}', '--version'], expect: `^${name} ${version.replace(/\./g, '\\.')}` }] },
  ...extra
})

const opts = (manifestsDir: string) => ({ dataDir: join(root, 'data'), manifestsDir, platform, fetch: fakeFetch, log: () => {} })

describe.skipIf(process.platform === 'win32')('the toolchain installer', () => {
  it('installs, probes and records a tool, and a second run downloads nothing', async () => {
    const dir = join(root, 'manifests')
    manifest(dir, 'base.json', 'toolchain', [tool('hello', '1.0.0', tarball('hello', '1.0.0'))])
    const { state } = await install(opts(dir))
    expect(state.tools.hello).toMatchObject({ ok: true, version: '1.0.0', pillar: 'toolchain', licence: 'MIT', dir: join('hello', '1.0.0'), bin: 'bin/hello' })
    expect(state.tools.hello.probed).toBe('hello 1.0.0 --version')
    expect(state.tools.hello.bytes).toBeGreaterThan(0)
    const chain = new Toolchain(join(root, 'data'))
    expect(chain.bin('hello')).toBe(join(root, 'data', 'work-tools', 'hello', '1.0.0', 'bin', 'hello'))
    // the download is gone once unpacked
    expect(existsSync(join(root, 'data', 'work-tools', 'downloads'))).toBe(true)
    expect(execFileSync('ls', [join(root, 'data', 'work-tools', 'downloads')]).toString().trim()).toBe('')

    fetched = []
    await install(opts(dir))
    expect(fetched).toEqual([])
  })

  it('refuses a wrong checksum or size and leaves nothing installed', async () => {
    const dir = join(root, 'manifests')
    const good = tarball('bad', '1.0.0')
    manifest(dir, 'base.json', 'toolchain', [tool('bad', '1.0.0', { ...good, sha256: '0'.repeat(64) }), tool('big', '1.0.0', { ...tarball('big', '1.0.0'), size: 5 })])
    const { state } = await install(opts(dir))
    expect(state.tools.bad).toMatchObject({ ok: false })
    expect(state.tools.bad.error).toMatch(/checksum mismatch/)
    expect(state.tools.big.error).toMatch(/larger than the 5 bytes/)
    expect(existsSync(join(root, 'data', 'work-tools', 'bad', '1.0.0'))).toBe(false)
    expect(new Toolchain(join(root, 'data')).has('bad')).toBe(false)
  })

  it("adds a second pillar's tool from its own manifest, the base untouched", async () => {
    const dir = join(root, 'manifests')
    manifest(dir, 'base.json', 'toolchain', [tool('hello', '1.0.0', tarball('hello', '1.0.0'))])
    const before = readFileSync(join(dir, 'base.json'), 'utf8')
    await install(opts(dir))
    manifest(dir, 'media.json', 'media', [tool('shine', '2.1.0', tarball('shine', '2.1.0'), { needs: ['hello'], threads: 4 })])
    fetched = []
    const { state } = await install(opts(dir))
    expect(state.tools.shine).toMatchObject({ ok: true, pillar: 'media', threads: 4 })
    expect(fetched).toEqual(['https://downloads.test/shine-2.1.0.tar.gz'])
    expect(readFileSync(join(dir, 'base.json'), 'utf8')).toBe(before)
    expect(new Toolchain(join(root, 'data')).list().map((t) => t.name)).toEqual(['hello', 'shine'])
  })

  it('installs needs first, and skips a tool whose need failed', async () => {
    const dir = join(root, 'manifests')
    manifest(dir, 'a.json', 'a', [tool('upper', '1.0.0', tarball('upper', '1.0.0'), { needs: ['lower'] })])
    manifest(dir, 'b.json', 'b', [tool('lower', '1.0.0', { ...tarball('lower', '1.0.0'), sha256: 'f'.repeat(64) })])
    expect(loadManifests(dir).map((t) => t.name)).toEqual(['lower', 'upper'])
    const { state } = await install(opts(dir))
    expect(state.tools.lower.ok).toBe(false)
    expect(state.tools.upper).toMatchObject({ ok: false, error: 'needs lower, which did not install' })
  })

  it('records a tool not offered on this platform without downloading it', async () => {
    const dir = join(root, 'manifests')
    const other: Platform = platform === 'linux-x64' ? 'darwin-arm64' : 'linux-x64'
    manifest(dir, 'base.json', 'toolchain', [{ ...(tool('elsewhere', '1.0.0', tarball('elsewhere', '1.0.0')) as Record<string, unknown>), platforms: { [other]: { kind: 'archive', files: [], bin: 'x' } } }])
    const { state } = await install(opts(dir))
    expect(state.tools.elsewhere).toMatchObject({ ok: false, error: `not offered on ${platform}` })
    expect(fetched).toEqual([])
  })

  it('fails a tool whose probe does not show what it expects', async () => {
    const dir = join(root, 'manifests')
    const t = tool('liar', '1.0.0', tarball('liar', '1.0.0')) as { probe: { steps: { expect: string }[] } }
    t.probe.steps[0].expect = '^liar 9'
    manifest(dir, 'base.json', 'toolchain', [t])
    const { state } = await install(opts(dir))
    expect(state.tools.liar.ok).toBe(false)
    expect(state.tools.liar.error).toMatch(/not \/\^liar 9\//)
    expect(new Toolchain(join(root, 'data')).bin('liar')).toBeNull()
  })

  it('keeps a working copy when a forced reinstall of it fails its probe', async () => {
    const dir = join(root, 'manifests')
    manifest(dir, 'base.json', 'toolchain', [tool('keep', '1.0.0', tarball('keep', '1.0.0'))])
    await install(opts(dir))
    manifest(dir, 'base.json', 'toolchain', [tool('keep', '1.0.0', tarball('keep', '1.0.0', 'broken'))])
    const { state, failed } = await install({ ...opts(dir), force: true })
    expect(failed).toEqual(['keep'])
    expect(state.tools.keep).toMatchObject({ ok: true, version: '1.0.0' })
    expect(state.tools.keep.error).toMatch(/^1\.0\.0 did not install: probe/)
    const bin = new Toolchain(join(root, 'data')).bin('keep')!
    expect(execFileSync(bin).toString()).toBe('keep 1.0.0 \n')
    // the download stays for the next try; no partial or aside folder is left
    expect(readdirSync(join(root, 'data', 'work-tools', 'keep'))).toEqual(['1.0.0'])
    expect(execFileSync('ls', [join(root, 'data', 'work-tools', 'downloads')]).toString().trim()).not.toBe('')
  })

  it('keeps the version that works when an upgrade fails its probe', async () => {
    const dir = join(root, 'manifests')
    manifest(dir, 'base.json', 'toolchain', [tool('up', '1.0.0', tarball('up', '1.0.0'))])
    await install(opts(dir))
    manifest(dir, 'base.json', 'toolchain', [tool('up', '2.0.0', tarball('up', '2.0.0', 'up 1.9'))])
    const { state, failed } = await install(opts(dir))
    expect(failed).toEqual(['up'])
    expect(state.tools.up).toMatchObject({ ok: true, version: '1.0.0', dir: join('up', '1.0.0') })
    expect(state.tools.up.error).toMatch(/^2\.0\.0 did not install/)
    expect(existsSync(join(root, 'data', 'work-tools', 'up', '2.0.0'))).toBe(false)
    expect(new Toolchain(join(root, 'data')).has('up')).toBe(true)
  })

  it('--only a tool also makes again what is built on it', async () => {
    const dir = join(root, 'manifests')
    manifest(dir, 'base.json', 'toolchain', [tool('ground', '1.0.0', tarball('ground', '1.0.0')), tool('house', '1.0.0', tarball('house', '1.0.0'), { needs: ['ground'] }), tool('apart', '1.0.0', tarball('apart', '1.0.0'))])
    await install(opts(dir))
    fetched = []
    await install({ ...opts(dir), only: ['ground'], force: true })
    expect(fetched).toEqual(['https://downloads.test/ground-1.0.0.tar.gz', 'https://downloads.test/house-1.0.0.tar.gz'])
  })

  it('refuses a pip line with no hashes and a file that would land outside its folder', () => {
    const pip = (packages: string[]) => ({ pillar: 'p', tools: [{ ...(tool('pp', '1.0.0', { url: 'https://x.test/a.tgz', sha256: 'a'.repeat(64) }) as Record<string, unknown>), platforms: { [platform]: { kind: 'pip', packages, bin: 'bin/python' } } }] })
    expect(ToolManifestSchema.safeParse(pip(['python-pptx==1.0.2'])).success).toBe(false)
    expect(ToolManifestSchema.safeParse(pip([`python-pptx==1.0.2 --hash=sha256:${'a'.repeat(64)}`])).success).toBe(true)
    const into = (where: string) => ({ pillar: 'p', tools: [tool('t', '1.0.0', { url: 'https://x.test/a.tgz', sha256: 'a'.repeat(64), into: where })] })
    expect(ToolManifestSchema.safeParse(into('../escape')).success).toBe(false)
    expect(ToolManifestSchema.safeParse(into('/abs')).success).toBe(false)
    expect(ToolManifestSchema.safeParse(into('node_modules/x')).success).toBe(true)
  })

  it('refuses two manifests naming one tool, a need no manifest names, and a cycle', () => {
    const dup = join(root, 'dup')
    manifest(dup, 'a.json', 'a', [tool('same', '1.0.0', { url: 'https://x.test/a.tgz', sha256: 'a'.repeat(64) })])
    manifest(dup, 'b.json', 'b', [tool('same', '1.0.0', { url: 'https://x.test/a.tgz', sha256: 'a'.repeat(64) })])
    expect(() => loadManifests(dup)).toThrow(/already named by a\.json/)
    const lost = join(root, 'lost')
    manifest(lost, 'a.json', 'a', [tool('x', '1.0.0', { url: 'https://x.test/a.tgz', sha256: 'a'.repeat(64) }, { needs: ['nowhere'] })])
    expect(() => loadManifests(lost)).toThrow(/needs nowhere, which no manifest names/)
    const loop = join(root, 'loop')
    manifest(loop, 'a.json', 'a', [
      tool('p', '1.0.0', { url: 'https://x.test/a.tgz', sha256: 'a'.repeat(64) }, { needs: ['q'] }),
      tool('q', '1.0.0', { url: 'https://x.test/a.tgz', sha256: 'a'.repeat(64) }, { needs: ['p'] })
    ])
    expect(() => loadManifests(loop)).toThrow(/a cycle of needs/)
  })

  it("the base manifest names every tool the plan asks for, and every pillar's manifest beside it is sound", () => {
    // loadManifests parses each *.json against ToolManifestSchema and refuses a name two manifests share or a need none names
    const tools = loadManifests(join(import.meta.dirname))
    const base = tools.filter((t) => t.file === 'base.json')
    expect(base.map((t) => t.name)).toEqual(['libreoffice', 'python', 'venv', 'ffmpeg', 'ironcalc'])
    expect(base.every((t) => t.pillar === 'toolchain')).toBe(true)
    // the box and the Mac get every base tool
    for (const p of ['linux-x64', 'darwin-arm64'] as const) expect(base.every((t) => t.platforms[p])).toBe(true)
    // a pillar's tools come from its own file, never the base's
    for (const t of tools.filter((t) => t.file !== 'base.json')) expect(t.pillar).not.toBe('toolchain')
    for (const t of tools) {
      expect(t.licence.length).toBeGreaterThan(2)
      expect(t.licenceNote.length).toBeGreaterThan(10)
      for (const entry of Object.values(t.platforms)) for (const f of entry?.files ?? []) expect(f.url.startsWith('https://')).toBe(true)
    }
    // GPL and AGPL tools are separate processes, never loaded in process
    for (const t of tools.filter((t) => /GPL/.test(t.licence))) expect(t.licenceNote).toMatch(/separate/)
  })
})
