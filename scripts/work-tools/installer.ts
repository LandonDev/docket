import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, cpSync, lstatSync, rmdirSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  runTool,
  tailOf as tail,
  ToolchainStateSchema,
  type RunOpts,
  type RunResult,
  ToolManifestSchema,
  statePath,
  toolsRoot,
  type Platform,
  type ToolchainState,
  type ToolDef,
  type ToolManifest,
  type ToolPlatformEntry,
  type ToolState
} from '../../src/main/server/work/formats/tools'

/**
 * The toolchain installer (docs/agents/work-formats.md, "The toolchain").
 * Reads every `<pillar>.json` in the manifests folder, and for each tool
 * offered on this platform downloads its files, checks size and hash,
 * unpacks them under `<userData>/work-tools/<tool>/<version>/` with no root
 * and nothing registered with the system, probes it, and writes what it
 * found to `<userData>/work-tools/state.json`, which is all the host reads.
 * A pillar adds a tool by adding its own manifest; this file and the base
 * manifest never change for it.
 */

export interface PlannedTool extends ToolDef {
  pillar: string
  /** the manifest file it came from */
  file: string
}

/** Every manifest in `dir` (its `*.json`, not its folders), checked whole: a duplicate name, an unknown need or a cycle refuses the lot. */
export function loadManifests(dir: string): PlannedTool[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json') && statSync(join(dir, f)).isFile())
    .sort()
  const tools: PlannedTool[] = []
  const seen = new Map<string, string>()
  for (const file of files) {
    let manifest: ToolManifest
    try {
      manifest = ToolManifestSchema.parse(JSON.parse(readFileSync(join(dir, file), 'utf8')))
    } catch (err) {
      throw new Error(`${file}: not a tool manifest: ${err instanceof Error ? err.message : String(err)}`)
    }
    for (const tool of manifest.tools) {
      const prior = seen.get(tool.name)
      if (prior) throw new Error(`${file}: the tool ${tool.name} is already named by ${prior}`)
      seen.set(tool.name, file)
      tools.push({ ...tool, pillar: manifest.pillar, file })
    }
  }
  return order(tools)
}

/** Needs first; a need no manifest names, or a cycle, is refused. */
export function order(tools: PlannedTool[]): PlannedTool[] {
  const byName = new Map(tools.map((t) => [t.name, t]))
  const done = new Set<string>()
  const out: PlannedTool[] = []
  const visit = (t: PlannedTool, path: string[]): void => {
    if (done.has(t.name)) return
    if (path.includes(t.name)) throw new Error(`a cycle of needs: ${[...path, t.name].join(' → ')}`)
    for (const need of t.needs ?? []) {
      const dep = byName.get(need)
      if (!dep) throw new Error(`${t.file}: ${t.name} needs ${need}, which no manifest names`)
      visit(dep, [...path, t.name])
    }
    done.add(t.name)
    out.push(t)
  }
  for (const t of tools) visit(t, [])
  return out
}

export interface InstallOptions {
  dataDir: string
  manifestsDir: string
  platform: Platform
  /** only these tools (and what they need) */
  only?: string[]
  /** reinstall what is already in place */
  force?: boolean
  /** keep the downloads under work-tools/downloads/ */
  keepDownloads?: boolean
  /** run every child at the lowest CPU and disk priority (the box runs other work) */
  gentle?: boolean
  /** the JavaScript runtime the probes call `{node}` */
  nodeBin?: string
  fetch?: typeof fetch
  log?: (line: string) => void
  now?: () => number
}

/** Install what the manifests name; the state written, and the tools offered here that did not install this time. One installer at a time per userData. */
export async function install(opts: InstallOptions): Promise<{ state: ToolchainState; failed: string[] }> {
  const log = opts.log ?? ((line: string) => console.log(line))
  const now = opts.now ?? Date.now
  const root = toolsRoot(opts.dataDir)
  mkdirSync(root, { recursive: true })
  const release = lock(root)
  const failed: string[] = []
  try {
    let tools = loadManifests(opts.manifestsDir)
    if (opts.only?.length) tools = withNeeds(tools, opts.only)
    const state = readState(opts.dataDir, opts.platform)
    state.platform = opts.platform
    for (const tool of tools) {
      const prior = state.tools[tool.name]
      const entry = tool.platforms[opts.platform]
      const base = { name: tool.name, pillar: tool.pillar, version: tool.version, licence: tool.licence, licenceNote: tool.licenceNote, ...(tool.threads ? { threads: tool.threads } : {}) }
      if (!entry) {
        state.tools[tool.name] = { ...base, ok: false, error: `not offered on ${opts.platform}`, at: now() }
        log(`${tool.name}: not offered on ${opts.platform}`)
        writeState(opts.dataDir, state, now)
        continue
      }
      const missing = (tool.needs ?? []).filter((n) => !state.tools[n]?.ok)
      if (missing.length) {
        state.tools[tool.name] = { ...base, ok: false, error: `needs ${missing.join(', ')}, which did not install`, at: now() }
        log(`${tool.name}: skipped, needs ${missing.join(', ')}`)
        failed.push(tool.name)
        writeState(opts.dataDir, state, now)
        continue
      }
      if (!opts.force && current(prior, tool, entry, state, root)) {
        log(`${tool.name} ${tool.version}: in place`)
        continue
      }
      log(`${tool.name} ${tool.version}: installing (${entry.kind})`)
      try {
        const t = await installOne(tool, entry, state, opts, log, now)
        state.tools[tool.name] = t
        // A pip tool's files are in its venv's folder: the venv and every pip tool in it are measured again, each for what is its own.
        if (entry.kind === 'pip') sizeVenv(state, tools, opts.platform, root, t.dir!)
        log(`${tool.name} ${tool.version}: ok, ${mb(state.tools[tool.name].bytes ?? 0)}${t.probed ? ` (${t.probed})` : ''}`)
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err)
        failed.push(tool.name)
        // A copy that worked before and is still on disk keeps working; the failure is noted on it.
        if (prior?.ok && prior.dir && prior.bin && existsSync(join(root, prior.dir, prior.bin))) {
          state.tools[tool.name] = { ...prior, error: `${tool.version} did not install: ${why}` }
          log(`${tool.name} ${tool.version}: failed, ${prior.version} stays: ${why}`)
        } else {
          state.tools[tool.name] = { ...base, ok: false, error: why, at: now() }
          log(`${tool.name}: failed: ${why}`)
        }
      }
      writeState(opts.dataDir, state, now)
    }
    // A run that installed nothing new still corrects a venv measured by an installer from before venvShares.
    const venvs = new Set(tools.flatMap((t) => (t.platforms[opts.platform]?.kind === 'pip' && state.tools[t.name]?.ok && state.tools[t.name].dir ? [state.tools[t.name].dir!] : [])))
    for (const dir of venvs) sizeVenv(state, tools, opts.platform, root, dir)
    writeState(opts.dataDir, state, now)
    return { state, failed }
  } finally {
    release()
  }
}

const mb = (bytes: number): string => `${Math.round(bytes / 1048576)} MB`

/** The named tools, what they need (so it is in place first) and what is built on them (so it is made again over a new copy). */
export function withNeeds(tools: PlannedTool[], only: string[]): PlannedTool[] {
  const byName = new Map(tools.map((t) => [t.name, t]))
  const want = new Set<string>()
  const add = (name: string): void => {
    const t = byName.get(name)
    if (!t) throw new Error(`no manifest names a tool ${name}`)
    if (want.has(name)) return
    want.add(name)
    for (const n of t.needs ?? []) add(n)
  }
  const dependents = new Set<string>(only)
  // `tools` is in needs order, so one pass reaches every tool built on another.
  for (const t of tools) if ((t.needs ?? []).some((n) => dependents.has(n))) dependents.add(t.name)
  for (const name of [...only, ...dependents]) add(name)
  return tools.filter((t) => want.has(t.name))
}

/** Already installed at this version, still on disk, and not older than anything it is built on. */
function current(prior: ToolState | undefined, tool: PlannedTool, entry: ToolPlatformEntry, state: ToolchainState, root: string): boolean {
  if (!prior?.ok || prior.version !== tool.version || !prior.dir || !prior.bin) return false
  if (prior.bin !== entry.bin) return false
  if (!existsSync(join(root, prior.dir, prior.bin))) return false
  return (tool.needs ?? []).every((n) => (state.tools[n]?.at ?? Infinity) <= prior.at)
}

async function installOne(tool: PlannedTool, entry: ToolPlatformEntry, state: ToolchainState, opts: InstallOptions, log: (line: string) => void, now: () => number): Promise<ToolState> {
  const root = toolsRoot(opts.dataDir)
  const base = { name: tool.name, pillar: tool.pillar, version: tool.version, licence: tool.licence, licenceNote: tool.licenceNote, ...(tool.threads ? { threads: tool.threads } : {}) }
  const run = (cmd: string, args: string[], o: RunOpts = {}): Promise<RunResult> => runTool(cmd, args, { ...o, gentle: opts.gentle })
  const needDir = (n: string): string => {
    const t = state.tools[n]
    if (!t?.ok || !t.dir) throw new Error(`needs ${n}`)
    return join(root, t.dir)
  }
  const needBin = (n: string): string => {
    const t = state.tools[n]
    if (!t?.ok || !t.dir || !t.bin) throw new Error(`needs ${n}`)
    return join(root, t.dir, t.bin)
  }

  // pip: packages into a venv this tool needs; the folder is the venv's.
  if (entry.kind === 'pip') {
    const venv = (tool.needs ?? []).find((n) => state.tools[n]?.ok && existsSync(join(needDir(n), 'pyvenv.cfg')))
    if (!venv) throw new Error('a pip tool needs a venv tool')
    if (!entry.packages?.length) throw new Error('a pip tool names its packages')
    const python = needBin(venv)
    // Every line pins a version and its wheels' hashes, and the lines are the whole closure: pip checks each file and fetches nothing else.
    const requirements = join(root, `.requirements-${tool.name}-${randomBytes(4).toString('hex')}.txt`)
    writeFileSync(requirements, `${entry.packages.join('\n')}\n`)
    let r: RunResult
    try {
      r = await run(python, ['-I', '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--require-hashes', '--only-binary=:all:', '--no-deps', '-r', requirements], { timeoutMs: 60 * 60_000 })
    } finally {
      rmSync(requirements, { force: true })
    }
    if (r.code !== 0) throw new Error(`pip install failed: ${tail(r.out)}`)
    const dir = state.tools[venv].dir!
    const result = await probed(tool, entry, join(root, dir), state, opts, run)
    if (!result.ok) throw new Error(result.error)
    return { ...base, ...result, dir, bin: entry.bin, ...(entry.bins ? { bins: entry.bins } : {}), bytes: 0, at: now() }
  }

  const toolDir = join(root, tool.name)
  const final = join(toolDir, tool.version)
  mkdirSync(toolDir, { recursive: true })
  const partial = join(toolDir, `.partial-${tool.version}-${randomBytes(4).toString('hex')}`)
  mkdirSync(partial, { recursive: true })
  const downloads = join(root, 'downloads')
  const fetched: string[] = []
  // The copy this one replaces stays aside until the new one passes its check and probe, and comes back if it does not.
  let aside: string | null = null
  let placed = false
  try {
    for (const file of entry.files) fetched.push(await download(file, downloads, opts.fetch ?? fetch, log))
    switch (entry.kind) {
      case 'archive':
      case 'npm':
        for (const [i, file] of entry.files.entries()) {
          const into = join(partial, file.into ?? '')
          if (file.raw) {
            mkdirSync(into, { recursive: true })
            cpSync(fetched[i], join(into, nameOf(file.url)))
          } else await unpack(fetched[i], into, file.strip ?? (entry.kind === 'npm' ? 1 : 0), run)
        }
        break
      case 'debs':
        for (const bundle of fetched) await unpackDebs(bundle, partial, run)
        break
      case 'build':
        // Packages first, in the order named, then the sources: a later file replaces what an earlier one left.
        for (const [i, file] of entry.files.entries()) {
          const into = join(partial, file.into ?? '')
          mkdirSync(into, { recursive: true })
          if (nameOf(file.url).endsWith('.deb')) await extractDeb(fetched[i], into, run, await hasDpkgDeb(run))
          else if (file.raw) cpSync(fetched[i], join(into, nameOf(file.url)))
          else await unpack(fetched[i], into, file.strip ?? 0, run)
        }
        break
      case 'dmg':
        if (!entry.app) throw new Error('a dmg tool names its app')
        for (const image of fetched) await copyFromDmg(image, entry.app, partial, run)
        break
      case 'venv':
        // made in place below: a venv names its own folder inside, so it cannot be moved after
        break
    }
    if (existsSync(final)) {
      aside = `${final}.old-${randomBytes(4).toString('hex')}`
      renameSync(final, aside)
    }
    renameSync(partial, final)
    placed = true
    if (entry.kind === 'venv') {
      const python = (tool.needs ?? []).map(needBin)[0]
      if (!python) throw new Error('a venv tool needs a python tool')
      const r = await run(python, ['-I', '-m', 'venv', final], { timeoutMs: 10 * 60_000 })
      if (r.code !== 0) throw new Error(`python -m venv failed: ${tail(r.out)}`)
    }
    // A build runs where the tool will live, so a path it compiles in stays true.
    if (entry.kind === 'build') {
      if (!entry.build?.length) throw new Error('a build tool names its build steps')
      const built = await probed({ name: tool.name, probe: { steps: entry.build } }, entry, final, state, opts, run, 'build')
      if (!built.ok) throw new Error(built.error)
    }
    for (const rel of entry.check ?? []) if (!existsSync(join(final, rel))) throw new Error(`missing ${rel}`)
    const result = await probed(tool, entry, final, state, opts, run)
    if (!result.ok) throw new Error(result.error)
    placed = false
    // In: nothing below may take the new copy away again. The copy it replaced, other versions and the downloads go.
    const replaced = aside
    aside = null
    if (replaced) rmSync(replaced, { recursive: true, force: true })
    for (const other of readdirSync(toolDir)) if (other !== tool.version) rmSync(join(toolDir, other), { recursive: true, force: true })
    if (!opts.keepDownloads) for (const f of fetched) rmSync(f, { force: true })
    return { ...base, ...result, dir: relative(root, final), bin: entry.bin, ...(entry.bins ? { bins: entry.bins } : {}), bytes: await bytesOf(final), at: now() }
  } catch (err) {
    if (placed) rmSync(final, { recursive: true, force: true })
    if (aside) renameSync(aside, final)
    throw err
  } finally {
    rmSync(partial, { recursive: true, force: true })
  }
}

const nameOf = (url: string): string => basename(decodeURIComponent(basename(new URL(url).pathname))).replace(/^\.+/, '') || 'download'

/** Download one file into `dir`, refusing a wrong size or hash; a file already there with the right hash is kept. */
export async function download(file: ToolPlatformEntry['files'][number], dir: string, fetchFn: typeof fetch, log: (line: string) => void): Promise<string> {
  mkdirSync(dir, { recursive: true })
  const digest = file.sha256 ?? file.integrity!
  const target = join(dir, `${createHash('sha256').update(digest).digest('hex').slice(0, 12)}-${nameOf(file.url)}`)
  if (existsSync(target) && (await hashOf(target, file)) === digest) return target
  log(`  downloading ${file.url}${file.size ? ` (${mb(file.size)})` : ''}`)
  const res = await fetchFn(file.url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`${file.url}: HTTP ${res.status}`)
  const partial = `${target}.partial`
  const hash = createHash(file.sha256 ? 'sha256' : 'sha512')
  const out = createWriteStream(partial)
  let bytes = 0
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.byteLength
      if (file.size && bytes > file.size) throw new Error(`${file.url}: larger than the ${file.size} bytes the manifest names`)
      hash.update(chunk)
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()))
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
  } catch (err) {
    // The file is opened lazily: wait for the stream to close before removing it.
    await new Promise<void>((resolve) => {
      out.once('close', () => resolve())
      out.once('error', () => resolve())
      out.destroy()
    })
    rmSync(partial, { force: true })
    throw err
  }
  if (file.size && bytes !== file.size) {
    rmSync(partial, { force: true })
    throw new Error(`${file.url}: ${bytes} bytes, the manifest names ${file.size}`)
  }
  const got = file.sha256 ? hash.digest('hex') : `sha512-${hash.digest('base64')}`
  if (got !== digest) {
    rmSync(partial, { force: true })
    throw new Error(`${file.url}: checksum mismatch (got ${got})`)
  }
  renameSync(partial, target)
  return target
}

async function hashOf(path: string, file: { sha256?: string }): Promise<string> {
  const { createReadStream } = await import('node:fs')
  const hash = createHash(file.sha256 ? 'sha256' : 'sha512')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return file.sha256 ? hash.digest('hex') : `sha512-${hash.digest('base64')}`
}

type Run = (cmd: string, args: string[], o?: RunOpts) => Promise<RunResult>

/** Unpack a tar or zip into `dest`, dropping `strip` leading folders (each must be the only entry at its level). */
export async function unpack(archive: string, dest: string, strip: number, run: Run): Promise<void> {
  const tmp = `${dest}.unpack-${randomBytes(4).toString('hex')}`
  mkdirSync(tmp, { recursive: true })
  try {
    const name = archive.toLowerCase()
    let r: RunResult
    if (name.endsWith('.zip')) {
      r =
        process.platform === 'linux'
          ? await run('unzip', ['-q', '-o', archive, '-d', tmp])
          : process.platform === 'darwin'
            ? await run('ditto', ['-x', '-k', archive, tmp])
            : await run('tar', ['-xf', archive, '-C', tmp])
    } else if (/\.(tar|tgz|tar\.gz|tar\.xz|txz|tar\.zst|tar\.bz2)$/.test(name)) {
      r = await run('tar', ['-xf', archive, '-C', tmp])
    } else throw new Error(`${basename(archive)}: not an archive this installer knows (tar, zip); mark it raw`)
    if (r.code !== 0) throw new Error(`unpacking ${basename(archive)} failed: ${tail(r.out)}`)
    let from = tmp
    for (let i = 0; i < strip; i++) {
      const entries = readdirSync(from)
      if (entries.length !== 1 || !lstatSync(join(from, entries[0])).isDirectory()) throw new Error(`${basename(archive)}: cannot strip ${strip} folders, found ${entries.length} entries`)
      from = join(from, entries[0])
    }
    mkdirSync(dest, { recursive: true })
    for (const entry of readdirSync(from)) {
      const to = join(dest, entry)
      if (existsSync(to)) rmSync(to, { recursive: true, force: true })
      renameSync(join(from, entry), to)
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** A tarball of .deb packages: each extracted into `dest` with dpkg-deb, or ar and tar where dpkg-deb is missing. */
async function unpackDebs(bundle: string, dest: string, run: Run): Promise<void> {
  const tmp = `${dest}.debs-${randomBytes(4).toString('hex')}`
  mkdirSync(tmp, { recursive: true })
  try {
    const r = await run('tar', ['-xf', bundle, '-C', tmp])
    if (r.code !== 0) throw new Error(`unpacking ${basename(bundle)} failed: ${tail(r.out)}`)
    const debs = walk(tmp).filter((f) => f.endsWith('.deb'))
    if (!debs.length) throw new Error(`${basename(bundle)} holds no .deb`)
    const hasDpkg = await hasDpkgDeb(run)
    for (const deb of debs) await extractDeb(deb, dest, run, hasDpkg)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

const hasDpkgDeb = async (run: Run): Promise<boolean> => (await run('dpkg-deb', ['--version']).catch(() => ({ code: 1, out: '' }))).code === 0

/** One .deb extracted into `dest` with dpkg-deb, or ar and tar where dpkg-deb is missing: its files only, nothing registered. */
async function extractDeb(deb: string, dest: string, run: Run, hasDpkg: boolean): Promise<void> {
  if (hasDpkg) {
    const x = await run('dpkg-deb', ['-x', deb, dest])
    if (x.code !== 0) throw new Error(`dpkg-deb -x ${basename(deb)} failed: ${tail(x.out)}`)
    return
  }
  const parts = `${dest}.ar-${randomBytes(4).toString('hex')}`
  mkdirSync(parts, { recursive: true })
  try {
    const a = await run('ar', ['x', deb], { cwd: parts })
    const data = readdirSync(parts).find((f) => f.startsWith('data.tar'))
    if (a.code !== 0 || !data) throw new Error(`ar x ${basename(deb)} failed: ${tail(a.out)}`)
    const t = await run('tar', ['-xf', join(parts, data), '-C', dest])
    if (t.code !== 0) throw new Error(`unpacking ${basename(deb)} failed: ${tail(t.out)}`)
  } finally {
    rmSync(parts, { recursive: true, force: true })
  }
}

/** Mount a disk image read-only where Finder does not see it, copy its app out, and detach. */
async function copyFromDmg(image: string, app: string, dest: string, run: Run): Promise<void> {
  const mount = `${dest}.mnt-${randomBytes(4).toString('hex')}`
  mkdirSync(mount, { recursive: true })
  // A licence agreement in the image waits on stdin; Y accepts it.
  const a = await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, image], { input: 'Y\n', timeoutMs: 10 * 60_000 })
  if (a.code !== 0) {
    rmSync(mount, { recursive: true, force: true })
    throw new Error(`hdiutil attach failed: ${tail(a.out)}`)
  }
  try {
    if (!existsSync(join(mount, app))) throw new Error(`${basename(image)} holds no ${app}`)
    const c = await run('ditto', [join(mount, app), join(dest, app)], { timeoutMs: 30 * 60_000 })
    if (c.code !== 0) throw new Error(`copying ${app} failed: ${tail(c.out)}`)
  } finally {
    const d = await run('hdiutil', ['detach', mount, '-force'], { timeoutMs: 120_000 })
    // Only an empty mount point goes: a volume still mounted there is left, never removed through.
    if (d.code === 0) rmdirSync(mount)
  }
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

/**
 * What each tool in one venv holds on disk, so the toolchain's sizes add
 * up to the folder: each pip tool the files pip recorded for its packages
 * (every `<name>-<version>.dist-info/RECORD` in the venv's site-packages),
 * a file two tools both list counted once, for the first in manifest
 * order; the venv tool what is left of its folder (the interpreter's
 * links, pip, setuptools). By apparent size, file by file, so the parts
 * and the whole are one measure.
 */
export function venvShares(venvDir: string, pipTools: ReadonlyArray<{ name: string; packages: readonly string[] }>): { tools: Map<string, number>; venv: number } {
  const all = walk(venvDir)
  const size = (f: string): number => {
    try {
      return lstatSync(f).size
    } catch {
      return 0
    }
  }
  const total = all.reduce((n, f) => n + size(f), 0)
  const records = new Map<string, string[]>()
  for (const f of all) {
    if (basename(f) !== 'RECORD' || !basename(dirname(f)).endsWith('.dist-info')) continue
    const site = dirname(dirname(f))
    const files = readFileSync(f, 'utf8')
      .split(/\r?\n/)
      .flatMap((line) => (line ? [join(site, csvFirst(line))] : []))
    records.set(packageKey(basename(dirname(f)).replace(/\.dist-info$/, '').split('-')[0]), files)
  }
  const counted = new Set<string>()
  const tools = new Map<string, number>()
  for (const tool of pipTools) {
    let bytes = 0
    for (const line of tool.packages) {
      for (const file of records.get(packageKey(line.split(/[\s=<>!~;[]/)[0])) ?? []) {
        if (counted.has(file)) continue
        counted.add(file)
        bytes += size(file)
      }
    }
    tools.set(tool.name, bytes)
  }
  return { tools, venv: Math.max(0, total - [...tools.values()].reduce((n, b) => n + b, 0)) }
}

/** A distribution's name as pip compares them (PEP 503): `Python_PPTX` and `python-pptx` are one. */
const packageKey = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, '-')

/** The first field of a RECORD row, which is quoted when the path holds a comma. */
function csvFirst(line: string): string {
  if (!line.startsWith('"')) return line.split(',')[0]
  let out = ''
  for (let i = 1; i < line.length; i++) {
    if (line[i] === '"' && line[i + 1] === '"') {
      out += '"'
      i++
    } else if (line[i] === '"') break
    else out += line[i]
  }
  return out
}

/** Measures one venv again after a pip install: the sizes of the venv tool and of every pip tool installed into it (`venvShares`). */
function sizeVenv(state: ToolchainState, tools: readonly PlannedTool[], platform: Platform, root: string, dir: string): void {
  const inIt = tools.filter((t) => state.tools[t.name]?.ok && state.tools[t.name].dir === dir)
  const pip = inIt.flatMap((t) => {
    const e = t.platforms[platform]
    return e?.kind === 'pip' ? [{ name: t.name, packages: e.packages ?? [] }] : []
  })
  const shares = venvShares(join(root, dir), pip)
  for (const t of inIt) {
    const bytes = t.platforms[platform]?.kind === 'venv' ? shares.venv : shares.tools.get(t.name)
    if (bytes !== undefined) state.tools[t.name] = { ...state.tools[t.name], bytes }
  }
}

async function bytesOf(dir: string): Promise<number> {
  if (process.platform !== 'win32') {
    const r = await runTool('du', ['-sk', dir])
    const kb = Number(r.out.trim().split(/\s+/)[0])
    if (r.code === 0 && Number.isFinite(kb)) return kb * 1024
  }
  let total = 0
  for (const f of walk(dir)) total += lstatSync(f).size
  return total
}

/** Run the tool's probe (or, as `build`, the steps that make it) in a fresh temp folder: every step must exit 0 and show what it expects. */
export async function probed(
  tool: Pick<ToolDef, 'name' | 'probe'>,
  entry: ToolPlatformEntry,
  dir: string,
  state: ToolchainState,
  opts: Pick<InstallOptions, 'dataDir' | 'nodeBin'>,
  run: Run,
  what: 'probe' | 'build' = 'probe'
): Promise<{ ok: boolean; probed?: string; error?: string }> {
  const tmp = join(toolsRoot(opts.dataDir), `.${what}-${tool.name}-${randomBytes(4).toString('hex')}`)
  mkdirSync(tmp, { recursive: true })
  try {
    for (const [name, text] of Object.entries(tool.probe.write ?? {})) writeFileSync(join(tmp, name), text)
    const fill = (s: string): string =>
      s.replace(/\{(bin(?::[a-z0-9-]+)?|dir|tmp|tmpUrl|node)\}/g, (_m, key: string) => {
        if (key === 'dir') return dir
        if (key === 'tmp') return tmp
        if (key === 'tmpUrl') return pathToFileURL(tmp).href
        if (key === 'node') return opts.nodeBin ?? process.execPath
        if (key === 'bin') return join(dir, entry.bin)
        const other = key.slice(4)
        if (entry.bins?.[other]) return join(dir, entry.bins[other])
        const t = state.tools[other]
        if (!t?.ok || !t.dir || !t.bin) throw new Error(`the ${what} names ${other}, which is not installed`)
        return join(toolsRoot(opts.dataDir), t.dir, t.bin)
      })
    let first: string | undefined
    for (const step of tool.probe.steps) {
      const [cmd, ...args] = step.run.map(fill)
      const env = Object.fromEntries(Object.entries(step.env ?? {}).map(([k, v]) => [k, fill(v)]))
      const r = await run(cmd, args, { env, timeoutMs: step.timeoutMs ?? 60_000, cwd: what === 'build' ? dir : tmp })
      if (r.code !== 0) return { ok: false, error: `${what}: ${basename(cmd)} exited ${r.code}: ${tail(r.out)}` }
      if (step.expect && !new RegExp(step.expect, 'm').test(r.out)) return { ok: false, error: `${what}: ${basename(cmd)} said ${JSON.stringify(tail(r.out))}, not /${step.expect}/` }
      if (step.expectFile) {
        const f = fill(step.expectFile)
        if (!existsSync(f) || statSync(f).size === 0) return { ok: false, error: `${what}: ${basename(cmd)} left no ${basename(f)}: ${tail(r.out)}` }
      }
      first ??= r.out.split('\n').map((l) => l.trim()).find(Boolean)
    }
    return { ok: true, ...(first ? { probed: first.slice(0, 200) } : {}) }
  } catch (err) {
    return { ok: false, error: `${what}: ${err instanceof Error ? err.message : String(err)}` }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// ── state ────────────────────────────────────────────────────────────

export function readState(dataDir: string, platform: Platform): ToolchainState {
  try {
    return ToolchainStateSchema.parse(JSON.parse(readFileSync(statePath(dataDir), 'utf8')))
  } catch {
    return { platform, at: 0, tools: {} }
  }
}

function writeState(dataDir: string, state: ToolchainState, now: () => number): void {
  state.at = now()
  const file = statePath(dataDir)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(tmp, file)
}

/** One installer per userData: a lock folder holding the owner's pid; a lock whose owner is gone is taken over. */
function lock(root: string): () => void {
  const dir = join(root, '.install.lock')
  const pidFile = join(dir, 'pid')
  try {
    mkdirSync(dir)
  } catch {
    let pid = NaN
    let since = 0
    try {
      since = statSync(dir).mtimeMs
      pid = Number(existsSync(pidFile) ? readFileSync(pidFile, 'utf8') : NaN)
    } catch {
      // let go of just now: take it
      mkdirSync(dir)
      writeFileSync(pidFile, String(process.pid))
      return () => rmSync(dir, { recursive: true, force: true })
    }
    // No pid yet: another installer is between its mkdir and its write, unless the lock is old.
    let alive = !(pid > 0) && Date.now() - since < 60_000
    try {
      if (pid > 0) {
        process.kill(pid, 0)
        alive = true
      }
    } catch (err) {
      // EPERM: alive, someone else's
      alive = (err as NodeJS.ErrnoException).code === 'EPERM'
    }
    if (alive) throw new Error(`another installer (pid ${pid}) is running on ${dirname(root)}`)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir)
  }
  writeFileSync(pidFile, String(process.pid))
  return () => rmSync(dir, { recursive: true, force: true })
}
