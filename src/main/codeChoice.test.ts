import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BASE_FILE,
  CODE_DIR,
  GOOD_AFTER_MS,
  MAX_ENTRIES,
  MANIFEST_FILE,
  STATE_FILE,
  bakedUserData,
  baseDifference,
  brokenEntry,
  fullReleaseLine,
  manifestRefusal,
  mirrorBundle,
  parseManifest,
  parseState,
  pickCode,
  readState,
  releaseOf,
  sameProgramAlive,
  sha256File,
  writeState,
  type CodeBase,
  type CodeManifest,
  type PickInput
} from './codeChoice'

const BASE: CodeBase = { electron: '39.8.10', lock: 'l'.repeat(64), beside: 'b'.repeat(64), native: 'n'.repeat(64), boot: 'o'.repeat(64) }
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

let root: string
let bundle: string
let userData: string
let dir: string

/** A bundle's app folder at 1.0.<release> with `base` as its stamp. */
function makeBundle(release = 10, base: CodeBase | null = BASE): void {
  rmSync(bundle, { recursive: true, force: true })
  mkdirSync(join(bundle, 'out', 'main'), { recursive: true })
  mkdirSync(join(bundle, 'node_modules', 'dep'), { recursive: true })
  mkdirSync(join(bundle, 'resources'), { recursive: true })
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'temp-code', version: `1.0.${release}`, main: './out/main/boot.js' }))
  writeFileSync(join(bundle, 'out', 'main', 'index.js'), '// the bundle\n')
  writeFileSync(join(bundle, 'resources', 'icon.png'), 'png')
  if (base) writeFileSync(join(bundle, 'out', BASE_FILE), JSON.stringify({ v: 1, ...base }))
}

/** A staged tree under <dir>/<commit>, whole, with its manifest. */
function makeTree(commit: string, patch: Partial<CodeManifest> = {}): CodeManifest {
  const out = join(dir, commit, 'out')
  mkdirSync(join(out, 'main'), { recursive: true })
  writeFileSync(join(out, 'main', 'index.js'), `// staged ${commit}\n`)
  const manifest: CodeManifest = {
    v: 1,
    commit,
    release: 11,
    subject: 'A fix',
    builtAt: 1,
    base: BASE,
    tar: { bytes: 10, sha256: 'c'.repeat(64) },
    entries: { 'main/index.js': sha256File(join(out, 'main', 'index.js'))! },
    ...patch
  }
  writeFileSync(join(dir, commit, MANIFEST_FILE), JSON.stringify(manifest))
  return manifest
}

const input = (patch: Partial<PickInput> = {}): PickInput => ({
  packaged: true,
  platform: 'darwin',
  bundleRoot: bundle,
  userData,
  pid: 100,
  alive: () => false,
  ...patch
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tc-code-choice-'))
  bundle = join(root, 'bundle')
  userData = join(root, 'userData')
  dir = join(userData, CODE_DIR)
  mkdirSync(dir, { recursive: true })
  makeBundle()
})

afterEach(() => {
  try {
    chmodSync(dir, 0o755)
  } catch {
    // gone
  }
  rmSync(root, { recursive: true, force: true })
})

describe('the manifest and the base stamp', () => {
  it('reads a whole manifest and refuses a broken one', () => {
    const good = makeTree(A)
    expect(parseManifest(good)).toEqual(good)
    expect(parseManifest({ ...good, commit: 'abc' })).toBeNull()
    expect(parseManifest({ ...good, release: 0 })).toBeNull()
    expect(parseManifest({ ...good, base: { ...BASE, lock: '' } })).toBeNull()
    expect(parseManifest({ ...good, tar: { bytes: 10, sha256: 'x' } })).toBeNull()
    expect(parseManifest({ ...good, entries: {} })).toBeNull()
    expect(parseManifest({ ...good, entries: { ...good.entries, '../escape.js': 'c'.repeat(64) } })).toBeNull()
    expect(parseManifest({ ...good, entries: { ...good.entries, '/abs.js': 'c'.repeat(64) } })).toBeNull()
    expect(parseManifest(null)).toBeNull()
    const many = Object.fromEntries(Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => [`main/f${i}.js`, 'c'.repeat(64)]))
    expect(parseManifest({ ...good, entries: { ...good.entries, ...many } })).toBeNull()
  })

  it('names the first part that differs', () => {
    expect(baseDifference(BASE, { ...BASE })).toBeNull()
    expect(baseDifference(BASE, { ...BASE, lock: 'x' })).toBe('lock')
    expect(baseDifference(BASE, { ...BASE, electron: '40.0.0', lock: 'x' })).toBe('electron')
    expect(fullReleaseLine('lock')).toBe('needs a full release: node_modules changed')
    expect(fullReleaseLine('electron')).toBe('needs a full release: Electron changed')
    expect(fullReleaseLine('native')).toBe('needs a full release: a native helper changed')
  })

  it('refuses a manifest on another base, an older release, and a build with no stamp', () => {
    const m = makeTree(A)
    const me = { release: 10, base: BASE, version: '1.0.10' }
    expect(manifestRefusal(m, me)).toBeNull()
    expect(manifestRefusal({ ...m, base: { ...BASE, lock: 'x'.repeat(64) } }, me)).toBe('needs a full release: node_modules changed')
    expect(manifestRefusal({ ...m, base: { ...BASE, boot: 'x'.repeat(64) } }, me)).toBe('needs a full release: the boot code changed')
    expect(manifestRefusal({ ...m, release: 10 }, me)).toBe('this build is 1.0.10 already')
    expect(manifestRefusal(m, { ...me, base: null })).toBe('needs a full release: this build cannot take code')
    expect(manifestRefusal({ nope: true }, me)).toBe('not a code manifest')
  })

  it('reads a release number from 1.0.N alone', () => {
    expect(releaseOf('1.0.371')).toBe(371)
    expect(releaseOf('2.0.1')).toBeNull()
    expect(releaseOf(undefined)).toBeNull()
  })

  it('drops what it cannot read from a state', () => {
    expect(parseState(null)).toEqual({ v: 1 })
    expect(parseState({ v: 1, current: { commit: A, state: 'good' }, runner: 7 })).toEqual({ v: 1, current: { commit: A, state: 'good' }, runner: 7 })
    expect(parseState({ v: 1, current: { commit: A, state: 'good', strikes: 2 } })).toEqual({ v: 1, current: { commit: A, state: 'good', strikes: 2 } })
    expect(parseState({ v: 1, current: { commit: A, state: 'staged', strikes: 2 } })).toEqual({ v: 1, current: { commit: A, state: 'staged' } })
    expect(parseState({ v: 1, current: { commit: A, state: 'staged', armed: true } })).toEqual({ v: 1, current: { commit: A, state: 'staged', armed: true } })
    expect(parseState({ v: 1, current: { commit: A, state: 'good', armed: true } })).toEqual({ v: 1, current: { commit: A, state: 'good' } })
    expect(parseState({ v: 1, current: { commit: A, state: 'good', strikes: -1 } })).toEqual({ v: 1, current: { commit: A, state: 'good' } })
    expect(parseState({ v: 1, current: { commit: 'zz', state: 'good' }, runner: -1, failed: { commit: 'no' } })).toEqual({ v: 1 })
    expect(parseState({ v: 2, current: { commit: A, state: 'good' } })).toEqual({ v: 1 })
  })

  it('finds the userData an isolated copy carries', () => {
    expect(bakedUserData(bundle)).toBeNull()
    writeFileSync(join(bundle, 'package.json'), JSON.stringify({ version: '1.0.10', tempcodeHarness: { TEMP_CODE_USER_DATA: ' /tmp/x ' } }))
    expect(bakedUserData(bundle)).toBe('/tmp/x')
  })
})

describe('a build that can never take code', () => {
  it('a dev build, a Windows build and a build with no stamp run the bundle and touch nothing', () => {
    makeTree(A)
    writeState(dir, { v: 1, current: { commit: A, state: 'staged', armed: true } })
    for (const [patch, line] of [
      [{ packaged: false }, 'not a packaged build'],
      [{ platform: 'win32' as const }, 'not on Windows']
    ] as const) {
      const pick = pickCode(input(patch))
      expect(pick.out).toBe(join(bundle, 'out'))
      expect(pick.boot.dir).toBeNull()
      expect(pick.boot.cannot).toBe(line)
      expect(pick.boot.refusal(makeTree(A))).toBe(`needs a full release: ${line}`)
      expect(() => pick.boot.offer(A)).toThrow(line)
    }
    makeBundle(10, null)
    const pick = pickCode(input())
    expect(pick.boot.cannot).toBe('this build has no base stamp')
    expect(pick.boot.running).toBeNull()
    expect(readState(dir).current).toEqual({ commit: A, state: 'staged', armed: true })
  })
})

describe('the choice', () => {
  it('runs the bundle when nothing is staged', () => {
    const pick = pickCode(input())
    expect(pick.out).toBe(join(bundle, 'out'))
    expect(pick.trial).toBe(false)
    expect(pick.boot.running).toBeNull()
    expect(pick.boot.bundle).toEqual({ root: bundle, version: '1.0.10', release: 10, base: BASE })
    expect(existsSync(join(dir, STATE_FILE))).toBe(false)
  })

  it('runs a staged tree on trial: the marker is on disk before the tree is, and the bundle is mirrored', () => {
    const manifest = makeTree(A)
    writeState(dir, { v: 1, current: { commit: A, state: 'staged', armed: true } })
    const pick = pickCode(input())
    expect(pick.out).toBe(join(dir, A, 'out'))
    expect(pick.trial).toBe(true)
    expect(pick.boot.running).toEqual(manifest)
    expect(readState(dir)).toEqual({ v: 1, current: { commit: A, state: 'trying' }, runner: 100 })
    for (const name of ['node_modules', 'package.json', 'resources']) {
      expect(lstatSync(join(dir, A, name)).isSymbolicLink()).toBe(true)
      expect(readlinkSync(join(dir, A, name))).toBe(join(bundle, name))
    }
    // a package and a resource resolve to the bundle's own files
    expect(existsSync(join(dir, A, 'node_modules', 'dep'))).toBe(true)
    expect(readFileSync(join(dir, A, 'resources', 'icon.png'), 'utf8')).toBe('png')
    expect(existsSync(join(dir, A, 'out', 'code-base.json'))).toBe(false)
  })

  it('a staged tree waits for the owner’s Restart: a launch of any other kind runs the bundle', () => {
    makeTree(A)
    const boot = pickCode(input()).boot
    boot.offer(A)
    // a quit and an open, a crash, a reboot: the tree is still only offered
    const next = pickCode(input({ pid: 200 }))
    expect(next.out).toBe(join(bundle, 'out'))
    expect(next.trial).toBe(false)
    expect(next.boot.staged()?.commit).toBe(A)
    expect(readState(dir).current).toEqual({ commit: A, state: 'staged' })
    next.boot.arm()
    expect(readState(dir).current).toEqual({ commit: A, state: 'staged', armed: true })
    const run = pickCode(input({ pid: 300 }))
    expect(run.out).toBe(join(dir, A, 'out'))
    expect(run.trial).toBe(true)
  })

  it('a waiting tree a full release overtook is dropped, never offered again', () => {
    makeTree(A)
    pickCode(input()).boot.offer(A)
    makeBundle(11)
    const next = pickCode(input({ pid: 200 }))
    expect(next.out).toBe(join(bundle, 'out'))
    expect(next.boot.staged()).toBeNull()
    expect(readState(dir)).toEqual({ v: 1, runner: 200 })
  })

  it('arm does nothing when no tree is staged', () => {
    const boot = pickCode(input()).boot
    boot.arm()
    expect(existsSync(join(dir, STATE_FILE))).toBe(false)
    makeTree(A)
    writeState(dir, { v: 1, current: { commit: A, state: 'good' } })
    pickCode(input()).boot.arm()
    expect(readState(dir).current?.armed).toBeUndefined()
  })

  it('a trial turns good only when boot settles it: after the launch lived its minute past started', () => {
    makeTree(A)
    writeState(dir, { v: 1, current: { commit: A, state: 'staged', armed: true } })
    const timers: { fn: () => void; ms: number }[] = []
    const pick = pickCode(input({ later: (fn, ms) => void timers.push({ fn, ms }) }))
    // boot cannot be talked into good before the app started
    pick.settle()
    expect(readState(dir).current).toEqual({ commit: A, state: 'trying' })
    pick.boot.started()
    pick.boot.started()
    expect(timers.map((t) => t.ms)).toEqual([GOOD_AFTER_MS])
    // started alone changes nothing: a crash now is a failed start
    expect(readState(dir).current).toEqual({ commit: A, state: 'trying' })
    timers[0].fn()
    expect(readState(dir).current).toEqual({ commit: A, state: 'good' })
  })

  it('a started launch that quits cleanly inside its minute is good too', () => {
    makeTree(A)
    writeState(dir, { v: 1, current: { commit: A, state: 'staged', armed: true } })
    const pick = pickCode(input({ later: () => {} }))
    pick.boot.started()
    pick.settle() // boot.ts on will-quit
    expect(readState(dir).current).toEqual({ commit: A, state: 'good' })
  })

  it('a launch that started and then died inside its minute is a failed start', () => {
    makeTree(A)
    writeState(dir, { v: 1, current: { commit: A, state: 'staged', armed: true } })
    pickCode(input({ later: () => {} })).boot.started() // the process dies: no timer, no will-quit
    const next = pickCode(input({ pid: 200 }))
    expect(next.out).toBe(join(bundle, 'out'))
    expect(next.boot.fellBack?.why).toBe('did not start')
  })

  it('keeps a tree that settled as good, with no second trial', () => {
    makeTree(A)
    writeState(dir, { v: 1, current: { commit: A, state: 'staged', armed: true } })
    const first = pickCode(input())
    first.boot.started()
    first.settle()
    expect(readState(dir).current).toEqual({ commit: A, state: 'good' })
    const next = pickCode(input({ pid: 200 }))
    expect(next.out).toBe(join(dir, A, 'out'))
    expect(next.trial).toBe(false)
    expect(next.boot.fellBack).toBeNull()
    // every launch of a good tree is a strike until it settles again
    expect(readState(dir)).toEqual({ v: 1, current: { commit: A, state: 'good', strikes: 1 }, runner: 200 })
    next.boot.started()
    next.settle()
    expect(readState(dir)).toEqual({ v: 1, current: { commit: A, state: 'good' }, runner: 200 })
  })

  it('a good tree whose strike cannot be written does not run', () => {
    makeTree(A)
    writeState(dir, { v: 1, current: { commit: A, state: 'good' } })
    mirrorBundle(join(dir, A), bundle)
    chmodSync(dir, 0o555)
    const pick = pickCode(input())
    chmodSync(dir, 0o755)
    expect(pick.out).toBe(join(bundle, 'out'))
    expect(pick.boot.running).toBeNull()
  })

  it('drops a good tree that stopped starting: two launches in a row that never settled', () => {
    makeTree(A)
    writeState(dir, { v: 1, current: { commit: A, state: 'good' } })
    // one launch that never settled (a quit in its first second): a strike, and the tree still runs
    expect(pickCode(input({ pid: 200 })).out).toBe(join(dir, A, 'out'))
    const second = pickCode(input({ pid: 300 }))
    expect(second.out).toBe(join(dir, A, 'out'))
    expect(readState(dir).current).toEqual({ commit: A, state: 'good', strikes: 2 })
    const third = pickCode(input({ pid: 400 }))
    expect(third.out).toBe(join(bundle, 'out'))
    expect(third.boot.fellBack).toEqual({ commit: A, subject: 'A fix', why: 'stopped starting' })
    expect(readState(dir)).toEqual({ v: 1, runner: 400, failed: { commit: A, subject: 'A fix', why: 'stopped starting', told: true } })
  })

  it('a launch that settles clears the strikes', () => {
    makeTree(A)
    writeState(dir, { v: 1, current: { commit: A, state: 'good', strikes: 1 } })
    const pick = pickCode(input({ pid: 200 }))
    expect(readState(dir).current).toEqual({ commit: A, state: 'good', strikes: 2 })
    pick.boot.started()
    pick.settle()
    expect(pickCode(input({ pid: 300 })).out).toBe(join(dir, A, 'out'))
    expect(readState(dir).current).toEqual({ commit: A, state: 'good', strikes: 1 })
  })

  it('falls back when the last launch tried a tree and never said good, and says so once', () => {
    makeTree(A)
    writeState(dir, { v: 1, current: { commit: A, state: 'staged', armed: true } })
    pickCode(input()) // the trial: crashed, hung or was killed before it settled
    const next = pickCode(input({ pid: 200 }))
    expect(next.out).toBe(join(bundle, 'out'))
    expect(next.boot.running).toBeNull()
    expect(next.boot.fellBack).toEqual({ commit: A, subject: 'A fix', why: 'did not start' })
    expect(readState(dir)).toEqual({ v: 1, runner: 200, failed: { commit: A, subject: 'A fix', why: 'did not start', told: true } })
    expect(next.boot.failed()).toBe(A)
    const third = pickCode(input({ pid: 300 }))
    expect(third.out).toBe(join(bundle, 'out'))
    expect(third.boot.fellBack).toBeNull()
    expect(third.boot.failed()).toBe(A)
  })

  it('records a throw at require, and the next launch runs the bundle and says so once', () => {
    makeTree(A)
    writeState(dir, { v: 1, current: { commit: A, state: 'staged', armed: true } })
    const pick = pickCode(input())
    pick.threw(new Error('Cannot find module ./chunks/x.js\nRequire stack: …'))
    expect(readState(dir)).toEqual({ v: 1, runner: 100, failed: { commit: A, subject: 'A fix', why: 'threw: Cannot find module ./chunks/x.js' } })
    const next = pickCode(input({ pid: 200, bundleOnly: true }))
    expect(next.out).toBe(join(bundle, 'out'))
    expect(next.boot.fellBack).toEqual({ commit: A, subject: 'A fix', why: 'threw: Cannot find module ./chunks/x.js' })
    expect(pickCode(input({ pid: 300 })).boot.fellBack).toBeNull()
  })

  it('a good tree that throws later is dropped the same way', () => {
    makeTree(A)
    writeState(dir, { v: 1, current: { commit: A, state: 'good' } })
    const pick = pickCode(input())
    expect(pick.trial).toBe(false)
    pick.threw(new SyntaxError('Unexpected token'))
    expect(readState(dir).current).toBeUndefined()
    expect(pickCode(input({ pid: 200 })).out).toBe(join(bundle, 'out'))
  })

  it('the bundle-only launch runs the bundle whatever the state says', () => {
    makeTree(A)
    writeState(dir, { v: 1, current: { commit: A, state: 'good' } })
    const pick = pickCode(input({ bundleOnly: true }))
    expect(pick.out).toBe(join(bundle, 'out'))
    expect(pick.boot.running).toBeNull()
    expect(readState(dir).current).toEqual({ commit: A, state: 'good' })
  })

  it('starts no trial whose marker cannot be written', () => {
    makeTree(A)
    writeState(dir, { v: 1, current: { commit: A, state: 'staged', armed: true } })
    // the links are made, then the folder turns read-only before the marker
    mirrorBundle(join(dir, A), bundle)
    chmodSync(dir, 0o555)
    const lines: string[] = []
    const pick = pickCode(input({ log: (line) => lines.push(line) }))
    chmodSync(dir, 0o755)
    expect(pick.out).toBe(join(bundle, 'out'))
    expect(pick.boot.running).toBeNull()
    expect(pick.trial).toBe(false)
    expect(readState(dir).current).toEqual({ commit: A, state: 'staged', armed: true })
    expect(lines.join('\n')).toMatch(/running the bundle's/)
  })

  it('a full release wins: a bundle as new as the tree, or on another base, drops it', () => {
    makeTree(A)
    writeState(dir, { v: 1, current: { commit: A, state: 'good' } })
    makeBundle(11)
    let pick = pickCode(input())
    expect(pick.out).toBe(join(bundle, 'out'))
    expect(pick.boot.fellBack).toBeNull()
    expect(readState(dir)).toEqual({ v: 1, runner: 100 })

    makeBundle(10, { ...BASE, lock: 'x'.repeat(64) })
    writeState(dir, { v: 1, current: { commit: A, state: 'good' } })
    pick = pickCode(input())
    expect(pick.out).toBe(join(bundle, 'out'))
    expect(readState(dir).current).toBeUndefined()
    // the sweep then removes the tree itself
    pick.boot.sweep()
    expect(existsSync(join(dir, A))).toBe(false)
  })

  it('drops a tree whose entry file is not the one its manifest names', () => {
    const manifest = makeTree(A)
    writeState(dir, { v: 1, current: { commit: A, state: 'good' } })
    writeFileSync(join(dir, A, 'out', 'main', 'index.js'), '// changed on disk\n')
    expect(brokenEntry(join(dir, A, 'out'), manifest)).toBe('main/index.js')
    const pick = pickCode(input())
    expect(pick.out).toBe(join(bundle, 'out'))
    expect(readState(dir).current).toBeUndefined()
  })

  it('drops a tree with no manifest, or one that names another commit', () => {
    mkdirSync(join(dir, A, 'out', 'main'), { recursive: true })
    writeState(dir, { v: 1, current: { commit: A, state: 'staged', armed: true } })
    expect(pickCode(input()).out).toBe(join(bundle, 'out'))
    makeTree(B)
    mkdirSync(join(dir, A), { recursive: true })
    writeFileSync(join(dir, A, MANIFEST_FILE), readFileSync(join(dir, B, MANIFEST_FILE)))
    writeState(dir, { v: 1, current: { commit: A, state: 'staged', armed: true } })
    expect(pickCode(input()).out).toBe(join(bundle, 'out'))
  })

  it('a second process beside a live one runs the bundle and changes nothing', () => {
    makeTree(A)
    makeTree(B)
    writeState(dir, { v: 1, current: { commit: B, state: 'staged', armed: true }, runner: 100 })
    let firstAlive = true
    const pick = pickCode(input({ pid: 200, alive: (pid) => pid === 100 && firstAlive }))
    expect(pick.out).toBe(join(bundle, 'out'))
    expect(pick.trial).toBe(false)
    expect(readState(dir)).toEqual({ v: 1, current: { commit: B, state: 'staged', armed: true }, runner: 100 })
    expect(() => pick.boot.offer(A)).toThrow('another process holds the staged code')
    pick.boot.arm()
    pick.boot.forget()
    pick.boot.sweep()
    expect(existsSync(join(dir, A))).toBe(true)
    expect(readState(dir)).toEqual({ v: 1, current: { commit: B, state: 'staged', armed: true }, runner: 100 })
    // the first process quit and this one holds the lock now: it may write again
    firstAlive = false
    pick.boot.offer(A)
    expect(readState(dir)).toEqual({ v: 1, current: { commit: A, state: 'staged' }, runner: 200 })
  })

  it('a state it cannot read is no state: the bundle runs', () => {
    makeTree(A)
    writeFileSync(join(dir, STATE_FILE), '{ not json')
    expect(pickCode(input()).out).toBe(join(bundle, 'out'))
  })
})

describe('what the app asks of boot', () => {
  it('offers a whole tree, and refuses one boot would not run', () => {
    const boot = pickCode(input()).boot
    expect(boot.staged()).toBeNull()
    const manifest = makeTree(A)
    boot.offer(A)
    expect(readState(dir)).toEqual({ v: 1, current: { commit: A, state: 'staged' }, runner: 100 })
    expect(boot.staged()).toEqual(manifest)

    makeTree(B, { base: { ...BASE, native: 'x'.repeat(64) } })
    expect(() => boot.offer(B)).toThrow('needs a full release: a native helper changed')
    expect(() => boot.offer('c'.repeat(40))).toThrow('no manifest')
    expect(() => boot.offer('../x')).toThrow('not a commit')
    expect(readState(dir).current).toEqual({ commit: A, state: 'staged' })
  })

  it('a newer offer takes the place of an older one, and the running tree stays until the sweep after it', () => {
    makeTree(A)
    writeState(dir, { v: 1, current: { commit: A, state: 'good' } })
    const boot = pickCode(input()).boot
    makeTree(B, { release: 12 })
    boot.offer(B)
    expect(readState(dir).current).toEqual({ commit: B, state: 'staged' })
    mkdirSync(join(dir, 'c'.repeat(40)))
    mkdirSync(join(dir, 'incoming'))
    boot.sweep(['incoming'])
    expect(existsSync(join(dir, A))).toBe(true)
    expect(existsSync(join(dir, B))).toBe(true)
    expect(existsSync(join(dir, 'incoming'))).toBe(true)
    expect(existsSync(join(dir, 'c'.repeat(40)))).toBe(false)
    expect(existsSync(join(dir, STATE_FILE))).toBe(true)
  })

  it('forget names no tree: the next launch runs the bundle, and the sweep after it removes the tree', () => {
    makeTree(A)
    writeState(dir, { v: 1, current: { commit: A, state: 'good' } })
    const pick = pickCode(input())
    expect(pick.boot.running?.commit).toBe(A)
    pick.boot.forget()
    expect(readState(dir)).toEqual({ v: 1, runner: 100 })
    // this process still runs the tree: the sweep leaves it
    pick.boot.sweep()
    expect(existsSync(join(dir, A))).toBe(true)
    const next = pickCode(input({ pid: 200 }))
    expect(next.out).toBe(join(bundle, 'out'))
    expect(next.boot.fellBack).toBeNull()
    next.boot.sweep()
    expect(existsSync(join(dir, A))).toBe(false)
  })

  it('settle only ever turns this launch’s own tree good', () => {
    makeTree(A)
    writeState(dir, { v: 1, current: { commit: A, state: 'staged', armed: true } })
    const pick = pickCode(input())
    makeTree(B, { release: 12 })
    pick.boot.offer(B)
    pick.boot.started()
    pick.settle()
    expect(readState(dir).current).toEqual({ commit: B, state: 'staged' })
  })
})

describe('the mirror', () => {
  it('links every entry of the bundle but out, again after the bundle moved', () => {
    makeTree(A)
    mirrorBundle(join(dir, A), bundle)
    const moved = join(root, 'moved')
    mkdirSync(join(moved, 'node_modules'), { recursive: true })
    writeFileSync(join(moved, 'package.json'), '{}')
    mkdirSync(join(moved, 'out'))
    mirrorBundle(join(dir, A), moved)
    expect(readlinkSync(join(dir, A, 'node_modules'))).toBe(join(moved, 'node_modules'))
    expect(readlinkSync(join(dir, A, 'package.json'))).toBe(join(moved, 'package.json'))
    // the moved bundle has no resources: the old link is gone
    expect(() => lstatSync(join(dir, A, 'resources'))).toThrow()
    expect(lstatSync(join(dir, A, 'out')).isDirectory()).toBe(true)
    expect(existsSync(join(dir, A, MANIFEST_FILE))).toBe(true)
  })

  it('refuses a tree that holds a file of its own in a link’s place', () => {
    makeTree(A)
    writeFileSync(join(dir, A, 'package.json'), '{}')
    expect(() => mirrorBundle(join(dir, A), bundle)).toThrow('package.json in the staged tree is not a link')
    writeState(dir, { v: 1, current: { commit: A, state: 'staged', armed: true } })
    const pick = pickCode(input())
    expect(pick.out).toBe(join(bundle, 'out'))
    expect(readState(dir).current).toEqual({ commit: A, state: 'staged', armed: true })
  })

  it('a stray file under a name the bundle does not have is left alone', () => {
    makeTree(A)
    writeFileSync(join(dir, A, 'notes.txt'), 'stray')
    mirrorBundle(join(dir, A), bundle)
    expect(readFileSync(join(dir, A, 'notes.txt'), 'utf8')).toBe('stray')
    expect(readlinkSync(join(dir, A, 'node_modules'))).toBe(join(bundle, 'node_modules'))
  })

  it('a link left dangling by a replaced bundle is made again', () => {
    makeTree(A)
    symlinkSync(join(root, 'gone', 'node_modules'), join(dir, A, 'node_modules'))
    mirrorBundle(join(dir, A), bundle)
    expect(readlinkSync(join(dir, A, 'node_modules'))).toBe(join(bundle, 'node_modules'))
  })
})

describe('sameProgramAlive', () => {
  it('knows this process, and a pid that is gone', () => {
    const exe = process.platform === 'linux' ? readlinkSync('/proc/self/exe') : process.execPath
    expect(sameProgramAlive(process.pid, exe)).toBe(true)
    expect(sameProgramAlive(process.pid, '/not/this/program')).toBe(false)
    expect(sameProgramAlive(2 ** 22 + 12345, exe)).toBe(false)
  })
})
