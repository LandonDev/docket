/**
 * Which code this launch runs (docs/agents/code-only-updates.md). The bundle
 * ships its own `out/`; a code-only update is a newer `out/` staged under
 * `<userData>/code/<commit>/`, outside the signed bundle. boot.ts asks
 * `pickCode` before it requires anything, and runs the staged tree only when
 * every rule here holds:
 *
 * - the build can take code at all: packaged, not Windows, and it carries a
 *   base stamp (`out/code-base.json`, written by the build);
 * - the tree's manifest names the same base as the bundle (Electron,
 *   node_modules, what ships beside `out/`, the native helpers, this boot
 *   code): the staged code runs on the bundle's own files for all of those;
 * - its release is newer than the bundle's, so a full release installed
 *   since wins and the tree is forgotten;
 * - every entry file hashes to what the manifest says.
 *
 * A staged tree runs only once the owner pressed Restart (`arm`): a quit, a
 * crash or a reboot leaves it waiting. Then it gets one trial. `pickCode`
 * writes `trying` before the tree is required. The app says `started` once
 * its own window mounted and its server answered, and the tree turns good
 * only when the launch has lived GOOD_AFTER_MS past that, or quits cleanly
 * (`settle`, called by boot.ts, never by the code on trial). A launch that
 * finds `trying` runs the bundle's code and names the tree as failed; a
 * throw while requiring it is recorded by `threw` and boot.ts starts the
 * app again, which then finds no tree. A marker that cannot be written
 * means the bundle's code. A tree that was good can stop being so (a file
 * gone, data it cannot read): every launch of it counts a strike that
 * `settle` clears, and GOOD_STRIKES launches in a row that never settled
 * drop it the same way.
 *
 * This file and boot.ts are the part a code-only update cannot change: they
 * run from the bundle, and their sources are one part of the base stamp. The
 * rest of the app reaches them through the `CodeBoot` object boot.ts leaves
 * on `globalThis.__tempcodeCode`, never by importing this file (boot.ts
 * shares no module with index.ts).
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'

/** The parts of the base stamp, in the order a difference is named. */
export const BASE_PARTS = ['electron', 'lock', 'beside', 'native', 'boot'] as const
export type BasePart = (typeof BASE_PARTS)[number]
/** What the code needs under it and cannot carry: the Electron version, and a sha256 for each other part. */
export type CodeBase = Record<BasePart, string>

const BASE_WORDS: Record<BasePart, string> = {
  electron: 'Electron changed',
  lock: 'node_modules changed',
  beside: 'the files beside the code changed',
  native: 'a native helper changed',
  boot: 'the boot code changed'
}

export interface CodeManifest {
  v: 1
  /** The commit `out/` was built from. */
  commit: string
  /** The release that commit became (release.json `n`, 1.0.N). */
  release: number
  /** The commit's subject, for the restart offer. */
  subject: string
  builtAt: number
  base: CodeBase
  /** The packed tree as it crosses the link. */
  tar: { bytes: number; sha256: string }
  /** sha256 by path under `out/` of every entry file: checked at every launch. */
  entries: Record<string, string>
}

export interface CodeState {
  v: 1
  /** The tree to run. `staged`: never run, and run only once `armed` (the owner pressed Restart);
   *  `trying`: a launch required it and has not settled as good. `strikes`: launches of a good
   *  tree in a row that never settled again. */
  current?: { commit: string; state: 'staged' | 'trying' | 'good'; strikes?: number; armed?: boolean }
  /** The process that last made this state its own. A second process that finds it alive changes nothing. */
  runner?: number
  /** The last tree that did not start; `told` once a launch has said so. */
  failed?: { commit: string; subject: string; why: string; told?: boolean }
}

/** What boot.ts leaves on `globalThis.__tempcodeCode` for the app. */
export interface CodeBoot {
  v: 1
  /** `<userData>/code`, or null when this build can never take code. */
  dir: string | null
  /** Why `dir` is null, as a plain line. */
  cannot: string | null
  bundle: { root: string; version: string; release: number | null; base: CodeBase | null }
  /** The staged code this process runs, or null: the bundle's. */
  running: CodeManifest | null
  /** A tree that did not start, to be said once in this launch. */
  fellBack: { commit: string; subject: string; why: string } | null
  /** The staged tree waiting for a restart, if any. */
  staged(): CodeManifest | null
  /** The last tree that did not start here: the same commit is not taken twice. */
  failed(): string | null
  /** Null when this boot would run a tree with this manifest, else the plain line why not. */
  refusal(manifest: unknown): string | null
  /** The complete tree under `<dir>/<commit>` waits for the owner's Restart. Throws the plain line when boot would not run it. */
  offer(commit: string): void
  /** The owner pressed Restart: the staged tree runs at the next launch. */
  arm(): void
  /** The app's own window mounted and its server answered it. The tree turns good once this launch
   *  has lived GOOD_AFTER_MS more, or quits cleanly: boot.ts decides that, not the code on trial. */
  started(): void
  /** Name no tree: the next launch runs the bundle's code. The switch turned off. */
  forget(): void
  /** Remove every tree but the running and the offered one; `keep` names other entries to leave. */
  sweep(keep?: readonly string[]): void
}

export const CODE_DIR = 'code'
/** A good tree is dropped after this many launches in a row that never reached their window. One could be a quit in the first second. */
export const GOOD_STRIKES = 2
/** How long a launch must live past `started` before its tree is good. A crash in its first minute (the resume of cut threads, a first query) is a failed start. */
export const GOOD_AFTER_MS = 60_000
/** A manifest names at most this many entry files: boot hashes each at every launch. */
export const MAX_ENTRIES = 500
/** boot.ts starts the app again with this argument after a staged tree threw: that launch runs the bundle's code whatever the state says. */
export const BUNDLE_CODE_FLAG = '--tempcode-bundle-code'
export const STATE_FILE = 'state.json'
export const MANIFEST_FILE = 'code-manifest.json'
export const BASE_FILE = 'code-base.json'
/** The entry file boot.ts requires. */
export const INDEX_ENTRY = 'main/index.js'

const SHA1 = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
/** A path under `out/`: plain segments, no `..`, no leading slash. */
const ENTRY_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[\w.\-/]+$/

export function parseBase(raw: unknown): CodeBase | null {
  if (!raw || typeof raw !== 'object') return null
  const out = {} as CodeBase
  for (const part of BASE_PARTS) {
    const value = (raw as Record<string, unknown>)[part]
    if (typeof value !== 'string' || !value || value.length > 128) return null
    out[part] = value
  }
  return out
}

/** The first part that differs, or null when the two are one base. */
export function baseDifference(a: CodeBase, b: CodeBase): BasePart | null {
  return BASE_PARTS.find((part) => a[part] !== b[part]) ?? null
}

/** "needs a full release: node_modules changed". */
export function fullReleaseLine(part: BasePart): string {
  return `needs a full release: ${BASE_WORDS[part]}`
}

export function parseManifest(raw: unknown): CodeManifest | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  const base = parseBase(m.base)
  const tar = m.tar as { bytes?: unknown; sha256?: unknown } | undefined
  if (m.v !== 1 || typeof m.commit !== 'string' || !SHA1.test(m.commit)) return null
  if (typeof m.release !== 'number' || !Number.isInteger(m.release) || m.release < 1) return null
  if (typeof m.subject !== 'string' || typeof m.builtAt !== 'number' || !base) return null
  if (!tar || typeof tar.bytes !== 'number' || !(tar.bytes > 0) || typeof tar.sha256 !== 'string' || !SHA256.test(tar.sha256)) return null
  if (!m.entries || typeof m.entries !== 'object') return null
  const entries: Record<string, string> = {}
  if (Object.keys(m.entries as object).length > MAX_ENTRIES) return null
  for (const [path, sha] of Object.entries(m.entries as Record<string, unknown>)) {
    if (!ENTRY_PATH.test(path) || typeof sha !== 'string' || !SHA256.test(sha)) return null
    entries[path] = sha
  }
  if (!entries[INDEX_ENTRY]) return null
  return { v: 1, commit: m.commit, release: m.release, subject: m.subject.slice(0, 2000), builtAt: m.builtAt, base, tar: { bytes: tar.bytes, sha256: tar.sha256 }, entries }
}

export function parseState(raw: unknown): CodeState {
  const state: CodeState = { v: 1 }
  if (!raw || typeof raw !== 'object' || (raw as { v?: unknown }).v !== 1) return state
  const s = raw as { current?: { commit?: unknown; state?: unknown; strikes?: unknown; armed?: unknown }; runner?: unknown; failed?: { commit?: unknown; subject?: unknown; why?: unknown; told?: unknown } }
  const cur = s.current
  if (cur && typeof cur.commit === 'string' && SHA1.test(cur.commit) && (cur.state === 'staged' || cur.state === 'trying' || cur.state === 'good')) {
    const strikes = typeof cur.strikes === 'number' && Number.isInteger(cur.strikes) && cur.strikes > 0 ? cur.strikes : 0
    state.current = {
      commit: cur.commit,
      state: cur.state,
      ...(cur.state === 'good' && strikes ? { strikes } : {}),
      ...(cur.state === 'staged' && cur.armed === true ? { armed: true } : {})
    }
  }
  if (typeof s.runner === 'number' && Number.isInteger(s.runner) && s.runner > 0) state.runner = s.runner
  const failed = s.failed
  if (failed && typeof failed.commit === 'string' && SHA1.test(failed.commit)) {
    state.failed = {
      commit: failed.commit,
      subject: typeof failed.subject === 'string' ? failed.subject : '',
      why: typeof failed.why === 'string' ? failed.why : 'did not start',
      ...(failed.told === true ? { told: true } : {})
    }
  }
  return state
}

/** The userData an isolated packaged copy carries in its own package.json (harness.ts `tempcodeHarness`): index.ts applies the same key after boot. */
export function bakedUserData(bundleRoot: string): string | null {
  const pkg = readJson(join(bundleRoot, 'package.json')) as { tempcodeHarness?: { TEMP_CODE_USER_DATA?: unknown } } | null
  const value = pkg?.tempcodeHarness?.TEMP_CODE_USER_DATA
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** `1.0.N` → N, else null. */
export function releaseOf(version: unknown): number | null {
  const m = typeof version === 'string' ? /^1\.0\.(\d+)$/.exec(version) : null
  return m ? Number(m[1]) : null
}

/** Why a bundle at `release` with `base` would not run a tree with this manifest, or null. */
export function manifestRefusal(manifest: unknown, bundle: { release: number | null; base: CodeBase | null; version: string }): string | null {
  if (!bundle.base || bundle.release === null) return 'needs a full release: this build cannot take code'
  const m = parseManifest(manifest)
  if (!m) return 'not a code manifest'
  const part = baseDifference(m.base, bundle.base)
  if (part) return fullReleaseLine(part)
  if (m.release <= bundle.release) return `this build is ${bundle.version} already`
  return null
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export function sha256File(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

/** The entry file that does not hash to the manifest's word, or null. */
export function brokenEntry(out: string, manifest: CodeManifest): string | null {
  for (const [path, sha] of Object.entries(manifest.entries)) if (sha256File(join(out, path)) !== sha) return path
  return null
}

/** Written whole or not at all: a temp file, flushed, then renamed over the state. */
export function writeState(dir: string, state: CodeState): void {
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `${STATE_FILE}.${process.pid}.tmp`)
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, JSON.stringify(state, null, 2) + '\n')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, join(dir, STATE_FILE))
}

export const readState = (dir: string): CodeState => parseState(readJson(join(dir, STATE_FILE)))

/**
 * The staged tree's folder made to look like the bundle's app folder with
 * `out/` swapped: every other entry of the bundle (package.json,
 * node_modules, resources, scripts) is a link to the bundle's own. Node
 * resolves a package through `node_modules` to its real file in the bundle,
 * and a path counted up from the code (server/appRoot.ts) finds
 * `resources/` there. Made again at every launch: the bundle may have moved
 * or been replaced. Throws when a link cannot be made, or when the tree
 * holds a file of its own under a name the bundle has; a stray file under
 * any other name is left where it is.
 */
export function mirrorBundle(tree: string, bundleRoot: string): void {
  const want = new Set(readdirSync(bundleRoot).filter((name) => name !== 'out' && name !== MANIFEST_FILE))
  for (const name of readdirSync(tree)) {
    if (name === 'out' || name === MANIFEST_FILE) continue
    const path = join(tree, name)
    if (!lstatSync(path).isSymbolicLink()) {
      if (want.has(name)) throw new Error(`${name} in the staged tree is not a link`)
      continue
    }
    if (want.has(name) && readlinkSync(path) === join(bundleRoot, name)) want.delete(name)
    else unlinkSync(path)
  }
  for (const name of want) symlinkSync(join(bundleRoot, name), join(tree, name))
}

/** Whether `pid` is a live process running this same program. Unknown counts as alive: the safe answer changes nothing. */
export function sameProgramAlive(pid: number, execPath: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    process.kill(pid, 0)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') return false
  }
  try {
    if (platform === 'linux') return readlinkSync(`/proc/${pid}/exe`) === execPath
    const comm = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 2_000 }).trim()
    return comm === execPath
  } catch {
    return true
  }
}

export interface PickInput {
  packaged: boolean
  platform: NodeJS.Platform
  /** The bundle's app folder (app.getAppPath()). */
  bundleRoot: string
  userData: string
  pid: number
  /** Whether another live process of this program holds `pid` (sameProgramAlive). */
  alive: (pid: number) => boolean
  /** This launch was started to run the bundle's code after a staged tree threw (BUNDLE_CODE_FLAG): no tree is looked at. */
  bundleOnly?: boolean
  /** Run `fn` after `ms` (a timer that does not hold the process open): how a started launch settles as good. */
  later?: (fn: () => void, ms: number) => void
  log?: (line: string) => void
}

export interface Pick {
  /** The `out/` this launch runs. */
  out: string
  /** True when this launch is the tree's first: a throw at require is told to `threw`. */
  trial: boolean
  boot: CodeBoot
  /** A throw while requiring the staged index: record it. The caller then starts the app again. */
  threw(err: unknown): void
  /** The launch lived GOOD_AFTER_MS past `started`, or quits cleanly: the running tree is good and its strikes are gone. */
  settle(): void
}

/** Decide, write the trial marker, and build the object the app talks to. Never throws. */
export function pickCode(input: PickInput): Pick {
  const log = input.log ?? (() => {})
  const bundleOut = join(input.bundleRoot, 'out')
  const pkg = readJson(join(input.bundleRoot, 'package.json')) as { version?: unknown } | null
  const version = typeof pkg?.version === 'string' ? pkg.version : ''
  const bundle = { root: input.bundleRoot, version, release: releaseOf(version), base: parseBase(readJson(join(bundleOut, BASE_FILE))) }
  const cannot = !input.packaged
    ? 'not a packaged build'
    : input.platform === 'win32'
      ? 'not on Windows'
      : bundle.release === null || !bundle.base
        ? 'this build has no base stamp'
        : null
  const dir = cannot ? null : join(input.userData, CODE_DIR)
  let running: CodeManifest | null = null
  let fellBack: CodeBoot['fellBack'] = null
  let trial = false
  /** Set by `started`; `settle` does nothing before it. */
  let startedOnce = false
  /** A second process beside a live one changes nothing on disk. Asked again at every write: the
   *  first may have quit since, and this one then holds the single-instance lock. */
  const passive = (): boolean => {
    if (!dir) return true
    const runner = readState(dir).runner
    return !!runner && runner !== input.pid && input.alive(runner)
  }

  const manifestOf = (commit: string): CodeManifest | null => (dir ? parseManifest(readJson(join(dir, commit, MANIFEST_FILE))) : null)
  /** Why boot would not run the tree under `<dir>/<commit>`, or null. */
  const treeRefusal = (commit: string): string | null => {
    const manifest = manifestOf(commit)
    if (!manifest || manifest.commit !== commit) return 'no manifest'
    const refusal = manifestRefusal(manifest, bundle)
    if (refusal) return refusal
    const broken = brokenEntry(join(dir!, commit, 'out'), manifest)
    return broken ? `${broken} is not the file the manifest names` : null
  }

  if (dir) {
    try {
      const state = readState(dir)
      const cur = state.current
      const second = passive()
      if (second) {
        log(`code: process ${state.runner} holds the staged code; running the bundle's`)
      } else if (cur && !input.bundleOnly) {
        const refusal = treeRefusal(cur.commit)
        if (refusal) {
          // A full release installed since, or a tree that is no longer whole: forgotten without a word.
          log(`code: ${cur.commit.slice(0, 7)} dropped: ${refusal}`)
          writeState(dir, { ...state, current: undefined, runner: input.pid })
        } else if (cur.state === 'staged' && !cur.armed) {
          // Offered, and the owner has not pressed Restart: it waits.
        } else if (cur.state === 'trying' || (cur.strikes ?? 0) >= GOOD_STRIKES) {
          const manifest = manifestOf(cur.commit)!
          const why = cur.state === 'trying' ? 'did not start' : 'stopped starting'
          log(`code: ${cur.commit.slice(0, 7)} ${why}; running the bundle's`)
          fellBack = { commit: cur.commit, subject: manifest.subject, why }
          writeState(dir, { v: 1, runner: input.pid, failed: { ...fellBack, told: true } })
        } else {
          const manifest = manifestOf(cur.commit)!
          mirrorBundle(join(dir, cur.commit), input.bundleRoot)
          // The marker first: a tree whose marker is not on disk is not run. For a good tree it
          // is a strike, gone again once this launch settles.
          if (cur.state === 'staged') writeState(dir, { ...state, current: { commit: cur.commit, state: 'trying' }, runner: input.pid })
          else writeState(dir, { ...state, current: { commit: cur.commit, state: 'good', strikes: (cur.strikes ?? 0) + 1 }, runner: input.pid })
          running = manifest
          trial = cur.state === 'staged'
          log(`code: running ${cur.commit.slice(0, 7)} (1.0.${manifest.release}) over bundle ${bundle.version}${trial ? ', on trial' : ''}`)
        }
      }
      // A throw at require was recorded by the process that saw it: said by the next launch, once.
      if (!second && !fellBack) {
        const after = readState(dir)
        if (after.failed && !after.failed.told) {
          fellBack = { commit: after.failed.commit, subject: after.failed.subject, why: after.failed.why }
          try {
            writeState(dir, { ...after, failed: { ...after.failed, told: true } })
          } catch {
            // said again at the next launch
          }
        }
      }
    } catch (err) {
      running = null
      trial = false
      log(`code: ${err instanceof Error ? err.message : String(err)}; running the bundle's`)
      // A marker may be on disk from the half-made trial: leave it, the next launch reads it as a failed start.
    }
  }

  const settle = (): void => {
    if (!dir || !running || !startedOnce) return
    try {
      if (passive()) return
      const state = readState(dir)
      const cur = state.current
      if (cur?.commit === running.commit && (cur.state === 'trying' || (cur.state === 'good' && cur.strikes))) {
        writeState(dir, { ...state, current: { commit: running.commit, state: 'good' }, runner: input.pid })
        if (cur.state === 'trying') log(`code: ${running.commit.slice(0, 7)} is good`)
      }
    } catch {
      // not settled: the next launch counts it against the tree
    }
  }

  const out = running && dir ? join(dir, running.commit, 'out') : bundleOut
  const boot: CodeBoot = {
    v: 1,
    dir,
    cannot,
    bundle,
    running,
    fellBack,
    staged() {
      if (!dir) return null
      const cur = readState(dir).current
      return cur && cur.state === 'staged' ? manifestOf(cur.commit) : null
    },
    failed() {
      return dir ? (readState(dir).failed?.commit ?? null) : null
    },
    refusal(manifest) {
      return cannot ? `needs a full release: ${cannot}` : manifestRefusal(manifest, bundle)
    },
    offer(commit) {
      if (!dir) throw new Error(`needs a full release: ${cannot}`)
      if (passive()) throw new Error('another process holds the staged code')
      if (!SHA1.test(commit)) throw new Error('not a commit')
      const refusal = treeRefusal(commit)
      if (refusal) throw new Error(refusal)
      writeState(dir, { ...readState(dir), current: { commit, state: 'staged' }, runner: input.pid })
    },
    arm() {
      if (!dir || passive()) return
      try {
        const state = readState(dir)
        if (state.current?.state === 'staged') writeState(dir, { ...state, current: { ...state.current, armed: true }, runner: input.pid })
      } catch {
        // not armed: the restart goes on and the tree waits for the next press
      }
    },
    started() {
      if (!running || startedOnce) return
      startedOnce = true
      input.later?.(settle, GOOD_AFTER_MS)
    },
    forget() {
      if (!dir || passive()) return
      const state = readState(dir)
      if (state.current) writeState(dir, { ...state, current: undefined, runner: input.pid })
    },
    sweep(keep = []) {
      if (!dir || passive()) return
      const state = readState(dir)
      const spare = new Set<string>([STATE_FILE, ...keep])
      if (state.current) spare.add(state.current.commit)
      if (running) spare.add(running.commit)
      let names: string[] = []
      try {
        names = readdirSync(dir)
      } catch {
        return
      }
      for (const name of names) {
        if (spare.has(name)) continue
        try {
          rmSync(join(dir, name), { recursive: true, force: true })
        } catch {
          // left for the next sweep
        }
      }
    }
  }
  return {
    out,
    trial,
    boot,
    settle,
    threw(err) {
      if (!dir || !running) return
      const why = `threw: ${(err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 300)}`
      log(`code: ${running.commit.slice(0, 7)} ${why}`)
      try {
        writeState(dir, { v: 1, runner: input.pid, failed: { commit: running.commit, subject: running.subject, why } })
      } catch {
        // the marker still says `trying`: the next launch reads that as a failed start
      }
    }
  }
}
