import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

  it("records what each tool in a venv holds, so the sizes add up to the folder: a pip tool its packages, a package two tools share once, the venv the rest", async () => {
    // A stand-in python: `-m venv <dir>` makes a venv of itself with 1000 bytes of pip; `-m pip install -r <file>` lays each
    // `name==version` line down as a package of 1000 bytes a letter of its name, with the RECORD pip writes.
    const fake = [
      '#!/bin/sh',
      'self="$0"',
      'if [ "$1" = "--version" ]; then echo "Python 3.12.0"; exit 0; fi',
      '[ "$1" = "-I" ] && shift',
      'if [ "$1 $2" = "-m venv" ]; then d="$3"; mkdir -p "$d/bin" "$d/lib/python3.12/site-packages"; cp "$self" "$d/bin/python"; chmod +x "$d/bin/python"; echo "home = x" > "$d/pyvenv.cfg"; head -c 1000 /dev/zero > "$d/lib/python3.12/site-packages/pip.py"; exit 0; fi',
      'if [ "$1 $2" = "-m pip" ]; then',
      '  for a; do req="$a"; done',
      '  sp="$(dirname "$self")/../lib/python3.12/site-packages"',
      '  while read -r line; do',
      '    spec="${line%% *}"; name="${spec%%==*}"; ver="${spec##*==}"; mod=$(echo "$name" | tr "A-Z-" "a-z_")',
      '    mkdir -p "$sp/$mod" "$sp/$mod-$ver.dist-info"; size=$(( ${#name} * 1000 ))',
      '    head -c $size /dev/zero > "$sp/$mod/__init__.py"',
      '    printf "%s/__init__.py,sha256=x,%s\\n%s-%s.dist-info/RECORD,,\\n" "$mod" "$size" "$mod" "$ver" > "$sp/$mod-$ver.dist-info/RECORD"',
      '  done < "$req"',
      '  exit 0',
      'fi',
      'exit 1'
    ].join('\n')
    const src = join(root, 'src', 'python-3.12.0')
    mkdirSync(join(src, 'tool-3.12.0', 'bin'), { recursive: true })
    writeFileSync(join(src, 'tool-3.12.0', 'bin', 'python'), `${fake}\n`)
    chmodSync(join(src, 'tool-3.12.0', 'bin', 'python'), 0o755)
    const file = join(root, 'src', 'python.tar.gz')
    execFileSync('tar', ['-czf', file, '-C', src, 'tool-3.12.0'])
    const body = readFileSync(file)
    served.set('https://downloads.test/python.tar.gz', body)
    const python = { url: 'https://downloads.test/python.tar.gz', sha256: createHash('sha256').update(body).digest('hex'), size: body.length }
    const probe = { steps: [{ run: ['{bin}', '--version'], expect: '^Python 3\\.12' }] }
    const hash = `--hash=sha256:${'a'.repeat(64)}`
    const pip = (name: string, packages: string[]) => ({ ...(tool(name, '1.0.0', python, { needs: ['venv'], probe }) as Record<string, unknown>), platforms: { [platform]: { kind: 'pip', packages: packages.map((p) => `${p} ${hash}`), bin: 'bin/python' } } })
    const dir = join(root, 'manifests')
    manifest(dir, 'base.json', 'toolchain', [
      { ...(tool('python', '3.12.0', python, { probe }) as Record<string, unknown>), platforms: { [platform]: { kind: 'archive', files: [{ ...python, strip: 1 }], bin: 'bin/python' } } },
      { ...(tool('venv', '3.12.0', python, { needs: ['python'], probe }) as Record<string, unknown>), platforms: { [platform]: { kind: 'venv', bin: 'bin/python' } } }
    ])
    // two pillars' pip tools in the one venv, sharing Pillow
    manifest(dir, 'pdf.json', 'pdf', [pip('pdf-tools', ['pdfplumber==0.11.10', 'Pillow==12.0.0'])])
    manifest(dir, 'slides.json', 'slides', [pip('slides-tools', ['python-pptx==1.0.2', 'pillow==12.0.0'])])
    const { state, failed } = await install(opts(dir))
    expect(failed).toEqual([])
    const record = (name: string): number => name.length * 1000
    expect(state.tools['pdf-tools'].bytes).toBe(record('pdfplumber') + record('Pillow') + recordRows('pdfplumber', '0.11.10') + recordRows('pillow', '12.0.0'))
    // Pillow is the pdf tools' (first in manifest order); the slides tools hold only python-pptx
    expect(state.tools['slides-tools'].bytes).toBe(record('python-pptx') + recordRows('python_pptx', '1.0.2'))
    // the venv is the rest of its folder: its own python, pyvenv.cfg and pip
    const venvDir = join(root, 'data', 'work-tools', state.tools.venv.dir!)
    const folder = walkSize(venvDir)
    expect(state.tools.venv.bytes).toBe(folder - state.tools['pdf-tools'].bytes! - state.tools['slides-tools'].bytes!)
    expect(state.tools.venv.bytes).toBeGreaterThan(1000)

    // a record from an installer before this one (a pip tool at 0 bytes) is put right by the next run, which installs nothing
    const stateFile = join(root, 'data', 'work-tools', 'state.json')
    const old = JSON.parse(readFileSync(stateFile, 'utf8'))
    old.tools['pdf-tools'].bytes = 0
    old.tools.venv.bytes = 1
    writeFileSync(stateFile, JSON.stringify(old))
    fetched = []
    const again = await install(opts(dir))
    expect(fetched).toEqual([])
    expect(again.state.tools['pdf-tools'].bytes).toBe(state.tools['pdf-tools'].bytes)
    expect(again.state.tools.venv.bytes).toBe(state.tools.venv.bytes)
  })

  // A tool compiled on the host (the `build` kind): its packages and sources put in place, then its own steps.
  const buildTool = (name: string, files: object[], steps: object[]): object => ({
    name,
    version: '1.0.0',
    licence: 'MIT',
    licenceNote: 'a separate process',
    homepage: 'https://example.test/',
    platforms: { [platform]: { kind: 'build', files, bin: 'out/greet', check: ['sys/usr/share/greeting'], build: steps } },
    probe: { steps: [{ run: ['{bin}'], expect: '^hello from the tree, built in place$' }] }
  })
  /** A source tarball whose `make.sh <dir>` writes out/greet from the greeting a package left under sys/. */
  function sources(name: string): { url: string; sha256: string; size: number } {
    const src = join(root, 'src', name)
    mkdirSync(join(src, 'pkg'), { recursive: true })
    writeFileSync(join(src, 'pkg', 'make.sh'), '#!/bin/sh\nset -e\nmkdir -p "$1/out"\nprintf \'#!/bin/sh\\necho "%s, built in %s"\\n\' "$(cat "$1/sys/usr/share/greeting")" "$2" > "$1/out/greet"\nchmod +x "$1/out/greet"\n')
    const file = join(root, 'src', `${name}.tar.gz`)
    execFileSync('tar', ['-czf', file, '-C', src, 'pkg'])
    const body = readFileSync(file)
    const url = `https://downloads.test/${name}.tar.gz`
    served.set(url, body)
    return { url, sha256: createHash('sha256').update(body).digest('hex'), size: body.length }
  }
  /** A .deb holding usr/share/greeting, made with dpkg-deb. */
  function deb(name: string): { url: string; sha256: string; size: number } {
    const tree = join(root, 'src', `${name}-deb`)
    mkdirSync(join(tree, 'DEBIAN'), { recursive: true })
    mkdirSync(join(tree, 'usr', 'share'), { recursive: true })
    writeFileSync(join(tree, 'DEBIAN', 'control'), `Package: ${name}\nVersion: 1.0\nArchitecture: all\nMaintainer: nobody <nobody@example.test>\nDescription: a test package\n`)
    writeFileSync(join(tree, 'usr', 'share', 'greeting'), 'hello from the tree')
    const file = join(root, 'src', `${name}_1.0_all.deb`)
    execFileSync('dpkg-deb', ['--root-owner-group', '-b', tree, file], { stdio: 'ignore' })
    const body = readFileSync(file)
    const url = `https://downloads.test/pool/${name}_1.0_all.deb`
    served.set(url, body)
    return { url, sha256: createHash('sha256').update(body).digest('hex'), size: body.length }
  }
  const hasDpkg = (() => {
    try {
      execFileSync('dpkg-deb', ['--version'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })()

  it.skipIf(!hasDpkg)('builds a tool on the host: its packages unpacked beside its sources with no root, its steps run where it will live', async () => {
    const dir = join(root, 'manifests')
    const steps = [{ run: ['sh', '{dir}/pkg/make.sh', '{dir}', 'place'], expectFile: '{dir}/out/greet' }]
    manifest(dir, 'p.json', 'pillar', [buildTool('built', [{ ...deb('greeting'), into: 'sys' }, sources('built')], steps)])
    const { state, failed } = await install(opts(dir))
    expect(failed).toEqual([])
    expect(state.tools.built).toMatchObject({ ok: true, dir: join('built', '1.0.0'), bin: 'out/greet', probed: 'hello from the tree, built in place' })
    const home = join(root, 'data', 'work-tools', 'built', '1.0.0')
    // the package's files and nothing of its control data; the sources beside them; the downloads gone
    expect(readFileSync(join(home, 'sys', 'usr', 'share', 'greeting'), 'utf8')).toBe('hello from the tree')
    expect(existsSync(join(home, 'sys', 'DEBIAN'))).toBe(false)
    expect(existsSync(join(home, 'pkg', 'make.sh'))).toBe(true)
    expect(readdirSync(join(root, 'data', 'work-tools', 'downloads'))).toEqual([])
    // the step ran in the tool's own folder, the one it stays in
    expect(readFileSync(join(home, 'out', 'greet'), 'utf8')).toContain('built in place')
    fetched = []
    await install(opts(dir))
    expect(fetched).toEqual([])
  })

  it.skipIf(!hasDpkg)('a build step that fails, or leaves nothing, installs nothing', async () => {
    const dir = join(root, 'manifests')
    // made once: a package built twice differs by its timestamps, and the address would serve only the last
    const files = [{ ...deb('greeting'), into: 'sys' }, sources('built')]
    manifest(dir, 'p.json', 'pillar', [
      buildTool('broken', files, [{ run: ['sh', '-c', 'echo no compiler here >&2; exit 3'] }]),
      buildTool('empty', files, [{ run: ['true'], expectFile: '{dir}/out/greet' }]),
      buildTool('stepless', files, [])
    ])
    const { state, failed } = await install(opts(dir))
    expect(failed.sort()).toEqual(['broken', 'empty', 'stepless'])
    expect(state.tools.broken.error).toMatch(/^build: sh exited 3: no compiler here/)
    expect(state.tools.empty.error).toMatch(/^build: true left no greet/)
    expect(state.tools.stepless.error).toMatch(/names its build steps/)
    for (const name of ['broken', 'empty', 'stepless']) expect(existsSync(join(root, 'data', 'work-tools', name, '1.0.0'))).toBe(false)
  })

  it('the browser pillar names the engine, pinned by hash, built with no root on the box alone', () => {
    const tool = loadManifests(join(import.meta.dirname)).find((t) => t.name === 'screen-relay')!
    expect(tool).toMatchObject({ pillar: 'browser', file: 'browser.json', version: '0.1.2' })
    expect(Object.keys(tool.platforms)).toEqual(['linux-x64'])
    const entry = tool.platforms['linux-x64']!
    expect(entry.kind).toBe('build')
    // the engine's own sources are the published package, by npm's integrity; every package by its sha256 and size, from a dated snapshot
    const pkg = entry.files.filter((f) => f.url.startsWith('https://registry.npmjs.org/'))
    expect(pkg).toEqual([expect.objectContaining({ url: 'https://registry.npmjs.org/screen-relay/-/screen-relay-0.1.2.tgz', into: 'pkg', strip: 1, integrity: expect.stringMatching(/^sha512-/) })])
    const debs = entry.files.filter((f) => !pkg.includes(f))
    expect(debs.length).toBeGreaterThan(30)
    for (const f of debs) {
      expect(f.url).toMatch(/^https:\/\/snapshot\.ubuntu\.com\/ubuntu\/\d{8}T\d{6}Z\/pool\/(main|universe)\/.+\.deb$/)
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(f.size).toBeGreaterThan(0)
      expect(f.into).toBe('sys')
    }
    for (const name of ['libx264-164', 'libx264-dev', 'libwebsockets19t64', 'xserver-xorg-core', 'xserver-xorg-video-dummy', 'libxcvt0', 'xclip']) expect(debs.some((f) => f.url.includes(`/${name}_`)), name).toBe(true)
    // x264 and xclip are GPL: separate processes, never linked, and never in the app
    expect(tool.licence).toContain('GPL-2.0-or-later')
    expect(tool.licenceNote).toMatch(/separate, unmodified process/)
    expect(tool.licenceNote).toMatch(/none is linked into our code, bundled, or shipped in the app/)
    // the build uses the host's compiler against the tree, with a library path that follows the folder
    expect(entry.build?.[0].run.join(' ')).toContain('ORIGIN/../sys/usr/lib/x86_64-linux-gnu')
    expect(tool.probe.steps[0].expect).toBe('Compiled backends: .*x11')
  })

  it("the Windows VM's pillar names QEMU's window modules, pinned by hash, for the box's own QEMU build", () => {
    const tool = loadManifests(join(import.meta.dirname)).find((t) => t.name === 'qemu-window')!
    expect(tool).toMatchObject({ pillar: 'winvm', file: 'winvm.json', version: '8.2.2+ds-0ubuntu1.18' })
    expect(Object.keys(tool.platforms)).toEqual(['linux-x64'])
    const entry = tool.platforms['linux-x64']!
    expect(entry.kind).toBe('build')
    // ui-gtk loads only beside ui-opengl, and VTE beside both; every package of the one build, by sha256 and size, from a dated snapshot
    const names = entry.files.map((f) => /\/([^/_]+)_[^/]+\.deb$/.exec(f.url)?.[1])
    expect(names).toEqual(['qemu-system-gui', 'qemu-system-modules-opengl', 'libvte-2.91-0', 'libvte-2.91-common'])
    for (const f of entry.files) {
      expect(f.url).toMatch(/^https:\/\/snapshot\.ubuntu\.com\/ubuntu\/\d{8}T\d{6}Z\/pool\/main\/.+\.deb$/)
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(f.size).toBeGreaterThan(0)
      expect(f.into).toBe('sys')
    }
    for (const f of entry.files.slice(0, 2)) expect(f.url).toContain(`_${tool.version}_amd64.deb`)
    // QEMU_MODULE_DIR is a folder of the two window modules alone, and the module is the tool's bin
    expect(entry.bin).toBe('mods/ui-gtk.so')
    expect(entry.check).toContain('mods/ui-opengl.so')
    expect(entry.build?.[0].run.join(' ')).toContain('ui-opengl.so')
    // the probe proves the module loads: with no display GTK itself refuses, where a missing module would say gtk is not available
    expect(tool.probe.steps[0].expect).toBe('gtk initialization failed')
    expect(tool.probe.steps[0].run.join(' ')).toMatch(/unset DISPLAY/)
    expect(tool.licenceNote).toMatch(/separate, unmodified process/)
    expect(tool.licenceNote).toMatch(/none is linked into our code, bundled, or shipped in the app/)
  })

  it('refuses a pip line with no hashes and a file that would land outside its folder', () => {
    const pip = (packages: string[]) => ({ pillar: 'p', tools: [{ ...(tool('pp', '1.0.0', { url: 'https://x.test/a.tgz', sha256: 'a'.repeat(64) }) as Record<string, unknown>), platforms: { [platform]: { kind: 'pip', packages, bin: 'bin/python' } } }] })
    expect(ToolManifestSchema.safeParse(pip(['python-pptx==1.0.2'])).success).toBe(false)
    expect(ToolManifestSchema.safeParse(pip([`python-pptx==1.0.2 --hash=sha256:${'a'.repeat(64)}`])).success).toBe(true)
    // A wheel PyPI does not carry, by its https address and hash (torch's CPU build); never a plain http one or one with no hash.
    expect(ToolManifestSchema.safeParse(pip([`torch @ https://download.pytorch.org/whl/cpu/torch-2.14.1%2Bcpu-cp312-cp312-manylinux_2_28_x86_64.whl --hash=sha256:${'a'.repeat(64)}`])).success).toBe(true)
    expect(ToolManifestSchema.safeParse(pip([`torch @ http://example.org/torch.whl --hash=sha256:${'a'.repeat(64)}`])).success).toBe(false)
    expect(ToolManifestSchema.safeParse(pip(['torch @ https://example.org/torch.whl'])).success).toBe(false)
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

/** The bytes of the RECORD the stand-in python writes for one package. */
function recordRows(mod: string, version: string): number {
  const m = mod.toLowerCase().replace(/-/g, '_')
  return Buffer.byteLength(`${m}/__init__.py,sha256=x,${m.length * 1000}\n${m}-${version}.dist-info/RECORD,,\n`)
}

function walkSize(dir: string): number {
  let n = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? walkSize(join(dir, e.name)) : statSync(join(dir, e.name)).size
  return n
}
