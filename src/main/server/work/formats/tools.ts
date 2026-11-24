import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { placeLowered } from '../../childPriority'

/**
 * The conversion toolchain on this host (docs/agents/work-formats.md, "The
 * toolchain"). `scripts/work-tools/install.ts` installs each tool a pillar's
 * manifest (`scripts/work-tools/<pillar>.json`) names under
 * `<userData>/work-tools/`, probes it, and writes what it found to
 * `state.json` there. The host only reads that file: it never downloads,
 * unpacks or probes, and a tool is usable when its probe passed and its
 * files are still on disk.
 */

/** The host's platform as the manifests name it. */
export const PLATFORMS = ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64', 'win32-x64'] as const
export type Platform = (typeof PLATFORMS)[number]
export const platformOf = (platform: string = process.platform, arch: string = process.arch): Platform | null => {
  const key = `${platform}-${arch}`
  return (PLATFORMS as readonly string[]).includes(key) ? (key as Platform) : null
}

// ── the manifest ──────────────────────────────────────────────────────

const TOOL_NAME = /^[a-z][a-z0-9-]{0,39}$/

/** One download. `sha256` (hex) or `integrity` (npm's `sha512-…` form): one of the two, always. */
const ToolFileSchema = z
  .object({
    url: z.url({ protocol: /^https$/ }),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/).optional(),
    /** bytes, as the publisher gives them: a download of another size is refused before its hash is taken */
    size: z.number().int().positive().optional(),
    /** where it goes inside the tool's folder (npm: the package's folder); never absolute, never `..` */
    into: z
      .string()
      .refine((p) => !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.split(/[\\/]/).includes('..'), 'stays inside the tool\'s folder')
      .optional(),
    /** leading folders to drop when unpacking */
    strip: z.number().int().min(0).optional(),
    /** keep the file as it is (a model, a font) */
    raw: z.boolean().optional()
  })
  .refine((f) => !!f.sha256 !== !!f.integrity, 'a file has a sha256 or an integrity, one of the two')

/** One probe or build step. Placeholders: `{bin}`, `{bin:<other bin or tool>}`, `{dir}`, `{tmp}`, `{tmpUrl}` (file URL), `{node}` (the installer's own runtime). */
const ProbeStepSchema = z.object({
  run: z.array(z.string()).min(1),
  env: z.record(z.string(), z.string()).optional(),
  /** a regular expression the output (stdout and stderr) must match */
  expect: z.string().optional(),
  /** a file the step must leave behind */
  expectFile: z.string().optional(),
  timeoutMs: z.number().int().positive().optional()
})

/**
 * How a tool lands on one platform.
 * - `archive`: each file unpacked (tar.gz, tar.xz, zip) into the tool's folder; an entry a later file also holds is replaced, not merged
 * - `debs`: a tarball of .deb packages, each extracted with `dpkg-deb -x` (no root, nothing registered)
 * - `dmg`: a disk image mounted read-only, its `.app` copied out
 * - `npm`: package tarballs, each into `node_modules/<name>`
 * - `venv`: a Python environment made by the tool `needs` names
 * - `pip`: packages added to the venv the tool `needs` names
 * - `build`: a tool compiled on the host against a library tree of its own. Each file is put in place (a
 *   `.deb` extracted with `dpkg-deb -x`, an archive unpacked, a raw file kept), then the `build` steps run
 *   in the tool's folder with the host's own compiler. Nothing is installed on the system and no root is used.
 */
const PlatformEntrySchema = z.object({
  kind: z.enum(['archive', 'debs', 'dmg', 'npm', 'venv', 'pip', 'build']),
  files: z.array(ToolFileSchema).default([]),
  /** dmg: the app bundle to copy out */
  app: z.string().optional(),
  /**
   * pip: the whole closure, one line each, `name==version --hash=sha256:…` (every wheel's hash;
   * scripts/work-tools/pip-lock.ts writes them), or a wheel PyPI does not carry named by its https
   * address, `name @ https://….whl --hash=sha256:…` (the CPU builds of torch, milestone 21)
   */
  packages: z
    .array(
      z
        .string()
        .regex(/^(?:[A-Za-z0-9._-]+==[^\s]+|[A-Za-z0-9._-]+ @ https:\/\/[^\s]+\.whl)( --hash=sha256:[0-9a-f]{64})+$/, 'a pip line pins a version (or an https wheel) and its hashes')
    )
    .optional(),
  /** the tool's main program or module, inside its folder */
  bin: z.string(),
  /** its other programs by name (ffmpeg's `ffprobe`) */
  bins: z.record(z.string(), z.string()).optional(),
  /** files that must exist inside the folder (LibreOffice's Carlito and Caladea) */
  check: z.array(z.string()).optional(),
  /** build: the steps that make the tool, run after its files are in place and before the check and the probe */
  build: z.array(ProbeStepSchema).optional()
})

export const ToolSchema = z.object({
  name: z.string().regex(TOOL_NAME),
  version: z.string().min(1),
  /** SPDX where there is one */
  licence: z.string().min(1),
  /** how it may be used: GPL and AGPL tools run only as separate, unmodified processes, never linked into our code */
  licenceNote: z.string().min(1),
  homepage: z.url(),
  /** tools this one is built on, installed first */
  needs: z.array(z.string().regex(TOOL_NAME)).optional(),
  /** threads one job with this tool may use; the runner admits jobs within the host's cap */
  threads: z.number().int().positive().optional(),
  platforms: z.partialRecord(z.enum(PLATFORMS), PlatformEntrySchema),
  probe: z.object({
    /** files written into the probe's temp folder first */
    write: z.record(z.string(), z.string()).optional(),
    steps: z.array(ProbeStepSchema).min(1)
  })
})
export type ToolDef = z.infer<typeof ToolSchema>
export type ToolPlatformEntry = z.infer<typeof PlatformEntrySchema>

/** `scripts/work-tools/<pillar>.json`: `base.json` is the toolchain's own; every other file is one pillar's. */
export const ToolManifestSchema = z.object({
  pillar: z.string().regex(/^[a-z][a-z0-9-]*$/),
  tools: z.array(ToolSchema).min(1)
})
export type ToolManifest = z.infer<typeof ToolManifestSchema>

// ── what the installer found ─────────────────────────────────────────

export const ToolStateSchema = z.object({
  name: z.string(),
  pillar: z.string(),
  version: z.string(),
  licence: z.string(),
  licenceNote: z.string(),
  /** the probe passed and the files were in place when it ran */
  ok: z.boolean(),
  /** the folder under work-tools/, relative; absent when the tool is not offered on this platform */
  dir: z.string().optional(),
  bin: z.string().optional(),
  bins: z.record(z.string(), z.string()).optional(),
  threads: z.number().int().positive().optional(),
  /** bytes on disk */
  bytes: z.number().optional(),
  /** the probe's first line of output */
  probed: z.string().optional(),
  /** why it is not usable: not offered here, a checksum, a probe */
  error: z.string().optional(),
  at: z.number()
})
export type ToolState = z.infer<typeof ToolStateSchema>

export const ToolchainStateSchema = z.object({
  platform: z.string(),
  at: z.number(),
  tools: z.record(z.string(), ToolStateSchema)
})
export type ToolchainState = z.infer<typeof ToolchainStateSchema>

export const toolsRoot = (dataDir: string): string => join(dataDir, 'work-tools')
export const statePath = (dataDir: string): string => join(toolsRoot(dataDir), 'state.json')

/** What the host reads of the toolchain: one reader per host, re-read when the installer rewrites the file. */
export class Toolchain {
  private cache: { mtimeMs: number; state: ToolchainState } | null = null

  constructor(readonly dataDir: string) {}

  /** The installer's last word, or an empty toolchain when it never ran or wrote something unreadable. */
  state(): ToolchainState {
    const file = statePath(this.dataDir)
    let mtimeMs: number
    try {
      mtimeMs = statSync(file).mtimeMs
    } catch {
      return { platform: platformOf() ?? `${process.platform}-${process.arch}`, at: 0, tools: {} }
    }
    if (this.cache?.mtimeMs === mtimeMs) return this.cache.state
    let state: ToolchainState
    try {
      state = ToolchainStateSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
    } catch (err) {
      console.error('[work] the toolchain state is unreadable:', err)
      state = { platform: platformOf() ?? `${process.platform}-${process.arch}`, at: 0, tools: {} }
    }
    this.cache = { mtimeMs, state }
    return state
  }

  /** Every tool the installer has a word on, usable or not. */
  list(): ToolState[] {
    return Object.values(this.state().tools).sort((a, b) => a.name.localeCompare(b.name))
  }

  /** A tool's main program (or another of its programs by name), when its probe passed and it is still on disk. */
  bin(tool: string, program?: string): string | null {
    const t = this.state().tools[tool]
    if (!t?.ok || !t.dir) return null
    const rel = program && program !== tool ? t.bins?.[program] : t.bin
    if (!rel) return null
    const abs = join(toolsRoot(this.dataDir), t.dir, rel)
    return existsSync(abs) ? abs : null
  }

  has(tool: string): boolean {
    return this.bin(tool) !== null
  }

  /** The tool's folder, when it is usable. */
  dir(tool: string): string | null {
    const t = this.state().tools[tool]
    return t?.ok && t.dir && this.has(tool) ? join(toolsRoot(this.dataDir), t.dir) : null
  }
}

// ── running a tool ───────────────────────────────────────────────────

export interface RunOpts {
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  input?: string
  /** nice 19 and, on Linux, idle disk priority: the box runs other work */
  gentle?: boolean
  signal?: AbortSignal
}
export interface RunResult {
  code: number
  /** stdout and stderr together, the last half megabyte when it runs long */
  out: string
}

/** One child of a tool, killed with its process group on the timeout or the signal; never rejects. */
export function runTool(cmd: string, args: string[], o: RunOpts = {}): Promise<RunResult> {
  let file = cmd
  let argv = args
  if (o.gentle && process.platform !== 'win32') {
    argv = process.platform === 'linux' && existsSync('/usr/bin/ionice') ? ['-n', '19', '/usr/bin/ionice', '-c', '3', cmd, ...args] : ['-n', '19', cmd, ...args]
    file = 'nice'
  }
  return new Promise((resolve) => {
    if (o.signal?.aborted) return resolve({ code: 130, out: 'cancelled' })
    const child = spawn(file, argv, {
      cwd: o.cwd,
      env: { ...process.env, ...o.env },
      stdio: [o.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    })
    // A gentle tool already runs lower than childPriority.ts's kinds (nice 19, idle I/O); it joins the jobs cgroup with them.
    if (o.gentle) placeLowered(child.pid)
    let out = ''
    const take = (d: Buffer): void => {
      out += d.toString()
      if (out.length > 1_000_000) out = out.slice(-500_000)
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    if (o.input !== undefined) child.stdin?.end(o.input)
    const kill = (why: string): void => {
      out += `\n(${why})`
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        /* gone */
      }
    }
    const timer = setTimeout(() => kill(`timed out after ${Math.round((o.timeoutMs ?? 0) / 1000)} s`), o.timeoutMs ?? 30 * 60_000)
    const onAbort = (): void => kill('cancelled')
    o.signal?.addEventListener('abort', onAbort, { once: true })
    const done = (r: RunResult): void => {
      clearTimeout(timer)
      o.signal?.removeEventListener('abort', onAbort)
      resolve(r)
    }
    child.on('error', (err) => done({ code: 127, out: `${out}${err.message}` }))
    child.on('close', (code) => done({ code: code ?? (o.signal?.aborted ? 130 : 1), out }))
  })
}

/** The last lines of a tool's output, for an error line. */
export const tailOf = (out: string): string => out.trim().split('\n').slice(-3).join(' / ').slice(0, 400)
