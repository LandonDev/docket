import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { dirname, join, relative, sep } from 'node:path'
import { isSharedMuseEntry, museAccountDirName } from '@shared/museSettings'
import { copiedNames, JUNCTIONS, linkEntry, linkTargetOf, renameRetry, syncCopy } from './skills/links'
import { scopeKeyOf, type ScopeKey, type SkillPointers } from './skills/pointers'

/**
 * Where a Muse thread's `muse serve` reads its config from: a dir under the
 * app's data handed to the process as `XDG_CONFIG_HOME`
 * (harness/museHost.ts), one per (account, skills scope):
 *
 *   <root>/accounts/<account>/<scope>/muse/   a thread routed to that account
 *   <root>/own/<scope>/muse/                  a thread on the CLI's own login
 *
 * `accounts/` and `own/` are fixed names, so no account's dir can collide
 * with the own dir. An account dir holds `auth.json` written from the
 * vault's copy (0600, by rename, skipped when identical) and the digest of
 * what was written (`.auth-seed`); the own dir links the person's own
 * `auth.json` when there is one. In both, `skills` links the store's folder
 * for the scope through its pointer (skills/pointers.ts), which Muse reads
 * at every call, so a store write reaches a running thread on its next
 * call; every other shared entry of the person's `~/.config/muse`
 * (settings.json, hooks, trust.json) is a link, so their own settings apply
 * everywhere. With no store configured the account dir is the old
 * `<root>/<account>/muse/` with every shared entry linked, the person's
 * skills too, and a thread on no account runs on the CLI's own config.
 *
 * `recapture` reads an account's copies back: the CLI never rewrote one
 * during a turn in the spike, but `muse usage` rotates the access token in
 * place, and a copy that moved on is the one worth keeping.
 */
export interface MuseDirDeps {
  /** `<userData>/muse-accounts`. */
  root: string
  /** The vault's blob for an account of the muse-code service, null when none. */
  readBlob: (account: string) => string | null
  /** Save a blob the CLI rewrote back into the vault. */
  saveBlob?: (account: string, blob: string) => void
  /** The vault's muse-code accounts, to name the old layout's dirs at migration. */
  accounts?: () => string[]
  /** The person's own config dir; `~/.config/muse` by default. */
  userConfigDir?: string
  log?: (line: string) => void
}

export const MUSE_ACCOUNTS = 'accounts'
export const MUSE_OWN = 'own'
const AUTH = 'auth.json'
const SEED = '.auth-seed'

let deps: MuseDirDeps | null = null

export function configureMuseDirs(next: MuseDirDeps | null): void {
  deps = next
}

/** The person's `muse` config dir: `$XDG_CONFIG_HOME/muse`, else `~/.config/muse`. */
export function userMuseConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  return join(xdg && xdg.trim() ? xdg : join(homedir(), '.config'), 'muse')
}

/** The old layout's dir of an account (no store): `<root>/<account>`. */
export function museAccountDir(root: string, account: string): string {
  return join(root, museAccountDirName(account))
}

/** Every account's dirs, one per scope, live under this. */
export function museAccountRoot(root: string, account: string): string {
  return join(root, MUSE_ACCOUNTS, museAccountDirName(account))
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
const authText = (blob: string): string => (blob.endsWith('\n') ? blob : `${blob}\n`)

/**
 * The config dir for a thread, made or refreshed: the account's dir of the
 * scope when the vault holds the account, else the own dir of the scope.
 * Null with no store and no account (the CLI's own config), or unconfigured.
 */
export function museConfigDirFor(account: string | null, scope: ScopeKey = 'global', skillsPointer: string | null = null): string | null {
  if (!deps) return null
  const blob = account ? deps.readBlob(account) : null
  const userDir = deps.userConfigDir ?? userMuseConfigDir()
  if (skillsPointer === null) {
    // No store: the old account dir, every shared entry linked; nothing for a thread on no account.
    if (!account || !blob) return null
    const dir = museAccountDir(deps.root, account)
    const museDir = join(dir, 'muse')
    mkdirSync(museDir, { recursive: true, mode: 0o700 })
    writeAuth(museDir, blob)
    linkShared(museDir, userDir, null)
    return dir
  }
  const dir = account && blob ? join(museAccountRoot(deps.root, account), scope) : join(deps.root, MUSE_OWN, scope)
  const museDir = join(dir, 'muse')
  mkdirSync(museDir, { recursive: true, mode: 0o700 })
  if (account && blob) writeAuth(museDir, blob)
  else linkOwnAuth(museDir, userDir)
  linkShared(museDir, userDir, join(skillsPointer, 'skills'))
  return dir
}

/** Which kind of dir museConfigDirFor answered under the store's layout: an account's (its login the file there), the own one, or neither (the old layout, the CLI's own). */
export function museDirKind(dir: string | null): 'account' | 'own' | null {
  if (!deps || !dir) return null
  const rel = relative(deps.root, dir).split(sep)
  if (rel[0] === MUSE_ACCOUNTS && rel.length === 3) return 'account'
  if (rel[0] === MUSE_OWN && rel.length === 2) return 'own'
  return null
}

function writeAuth(museDir: string, blob: string): void {
  const path = join(museDir, AUTH)
  const text = authText(blob)
  let same = false
  try {
    const st = lstatSync(path)
    same = !st.isSymbolicLink() && readFileSync(path, 'utf8') === text
    if (st.isSymbolicLink()) unlinkSync(path)
  } catch {
    // absent: written below
  }
  if (!same) {
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, text, { mode: 0o600 })
    renameRetry(tmp, path)
  }
  writeSeed(museDir, sha256(text))
}

function writeSeed(museDir: string, digest: string): void {
  const path = join(museDir, SEED)
  try {
    if (readFileSync(path, 'utf8') === digest) return
  } catch {
    // absent
  }
  writeFileSync(path, digest, { mode: 0o600 })
}

/** The own dir's auth.json: a link to the person's, so the CLI's own login and its rotations stay theirs; none when they have none. */
function linkOwnAuth(museDir: string, userDir: string): void {
  const path = join(museDir, AUTH)
  const target = join(userDir, AUTH)
  // Windows: a copy kept in step both ways (skills/links.ts syncCopy), the CLI's rotations copied back.
  if (JUNCTIONS) {
    syncCopy(path, target)
    return
  }
  const st = lstatOrNull(path)
  if (!existsSync(target)) {
    if (st?.isSymbolicLink()) unlinkSync(path)
    return
  }
  if (st?.isSymbolicLink() && readlinkSync(path) === target) return
  if (st) rmSync(path, { force: true })
  symlinkSync(target, path)
}

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

/** One symlink per shared entry of the real dir (`skills` the store's when given), stale links removed. */
function linkShared(museDir: string, userDir: string, storeSkills: string | null): void {
  const wanted = new Map<string, string>()
  if (existsSync(userDir)) {
    for (const name of readdirSync(userDir)) {
      if (!isSharedMuseEntry(name) || (storeSkills !== null && name === 'skills')) continue
      wanted.set(name, join(userDir, name))
    }
  }
  if (storeSkills !== null) wanted.set('skills', storeSkills)
  for (const [name, target] of wanted) {
    const link = join(museDir, name)
    const st = lstatOrNull(link)
    if (st?.isSymbolicLink() && linkTargetOf(readlinkSync(link)) === target) continue
    // Windows: a shared file is a copy in step, synced in place.
    if (JUNCTIONS && st?.isFile() && !statSync(target, { throwIfNoEntry: false })?.isDirectory()) {
      syncCopy(link, target)
      continue
    }
    if (st) rmSync(link, { recursive: true, force: true })
    linkEntry(target, link)
  }
  const copied = new Set(JUNCTIONS ? copiedNames(museDir) : [])
  for (const name of readdirSync(museDir)) {
    if (!isSharedMuseEntry(name) || name === SEED || wanted.has(name)) continue
    if (lstatOrNull(join(museDir, name))?.isSymbolicLink() || copied.has(name)) rmSync(join(museDir, name), { force: true })
  }
}

/** A copy worth saving: it parses and still holds a credential (a logout is not a rotation). */
function holdsCredential(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { providers?: { meta?: { access_token?: unknown; api_key?: unknown } } }
    return !!(parsed.providers?.meta?.access_token || parsed.providers?.meta?.api_key)
  } catch {
    return false
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * An account's copies back into the vault when the CLI changed one: only a
 * scope whose copy differs from its own seed counts (the CLI rotated it
 * there), the newest such copy is saved, and every copy looked at is seeded
 * with what it holds now, so it counts again only after another rotation.
 * Every other scope re-seeds from the vault at its next spawn.
 */
export function recaptureMuseDir(account: string | null): boolean {
  if (!account || !deps?.saveBlob) return false
  const stored = deps.readBlob(account)
  if (!stored) return false
  const candidates: { museDir: string; text: string; mtime: number }[] = []
  // A code thread's scope dirs and a Work thread's (museWorkDirs) both hold copies of the account's login.
  const scopeDirs: string[] = []
  for (const accountRoot of [museAccountRoot(deps.root, account), join(museWorkRoot(deps.root), 'config', MUSE_ACCOUNTS, museAccountDirName(account))]) {
    try {
      for (const scope of readdirSync(accountRoot)) scopeDirs.push(join(accountRoot, scope))
    } catch {
      // no scope dirs yet
    }
  }
  for (const scopeDir of scopeDirs) {
    const museDir = join(scopeDir, 'muse')
    const text = readText(join(museDir, AUTH))
    if (text === null || sha256(text) === readText(join(museDir, SEED))) continue
    let mtime = 0
    try {
      mtime = statSync(join(museDir, AUTH)).mtimeMs
    } catch {
      continue
    }
    candidates.push({ museDir, text, mtime })
  }
  // The old layout (no store): against its seed, or the vault for a copy written before seeds.
  const old = join(museAccountDir(deps.root, account), 'muse')
  const oldText = readText(join(old, AUTH))
  const oldSeed = readText(join(old, SEED))
  if (oldText !== null && (oldSeed !== null ? sha256(oldText) !== oldSeed : oldText.trim() !== stored.trim())) {
    try {
      candidates.push({ museDir: old, text: oldText, mtime: statSync(join(old, AUTH)).mtimeMs })
    } catch {
      // gone
    }
  }
  for (const c of candidates) writeSeed(c.museDir, sha256(c.text))
  const best = candidates.filter((c) => holdsCredential(c.text) && c.text.trim() !== stored.trim()).sort((a, b) => b.mtime - a.mtime)[0]
  if (!best) return false
  deps.saveBlob(account, best.text)
  deps.log?.(`[muse] account ${account}: auth.json changed on disk; saved back to the vault`)
  return true
}

// ── the Work fence (docs/agents/work-scope.md "Muse Code") ─────────────────

/**
 * A Work thread loads no MCP server but the app's own bridge. Muse 1.4.24
 * reads servers from its config dir's `settings.json` (and hooks there),
 * from plugins installed in its data dir and approved in that settings
 * file, and from a `.mcp.json` at the session's `workspaceRoot` and every
 * folder up to its git root, re-read at each session load. So a Work
 * thread's `muse serve` gets, made again before every serve (start and
 * resume), under `<userData>/muse-work/`:
 *
 *   config/<accounts/<acct>|own>/<scope>/   XDG_CONFIG_HOME: `muse/` holds
 *       auth.json (the account's copy, or a link to the person's own),
 *       settings.json `{"schema_version":1}` and `skills` → the store's
 *       scope; every other entry is removed, nothing of the person's linked.
 *   data/                                    XDG_DATA_HOME: kept, so
 *       `session/resume` finds its sessions; `muse/plugins` and
 *       `muse/skills` removed (MUSE_WORK_DATA_DROP).
 *   roots/<thread>/                          the primary root and the
 *       process cwd: removed, made empty and `git init`ed, so the
 *       `.mcp.json` walk stops at it. The thread's folder rides
 *       `workspaceRoots`, whose extra entries Muse reads no `.mcp.json` from.
 *
 * Every write replaces what is there and never goes through a link an
 * agent planted: a dir on the way that is a link is removed and made real.
 */
export interface MuseWorkDirs {
  configDir: string
  dataDir: string
  /** The primary root: `workspaceRoot`, the first `workspaceRoots` entry and the process cwd. */
  root: string
  /** The config dir is an account's (`TBH_CREDENTIAL_BACKEND=file`). */
  credentialFile: boolean
}

/** The Work config dir's whole settings.json. */
export const MUSE_WORK_SETTINGS = '{"schema_version":1}\n'

/**
 * What a Work serve removes from the shared data dir's `muse/`: installed
 * plugins (servers and hooks) and data-home skills (instructions every Work
 * thread of every workspace would read). Muse extracts its bundled skills
 * into `skills/bundled` again at each serve. `sessions/` stays, for resume.
 */
export const MUSE_WORK_DATA_DROP = ['plugins', 'skills'] as const

/** `<userData>/muse-work`, beside `<userData>/muse-accounts`. */
export const museWorkRoot = (accountsRoot: string): string => join(dirname(accountsRoot), 'muse-work')

/** A thread id as one path segment: as it is when it is plain, else its digest. */
const rootName = (threadId: string): string => (/^[A-Za-z0-9_-]{1,128}$/.test(threadId) ? threadId : sha256(threadId).slice(0, 32))

/** `base/…parts` as real directories: any part that is a link or a file is removed first, so nothing below is reached through a link. */
function realDir(base: string, ...parts: string[]): string {
  let dir = base
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const part of parts) {
    dir = join(dir, part)
    const st = lstatOrNull(dir)
    if (st && !st.isDirectory()) rmSync(dir, { force: true })
    if (!st || !st.isDirectory()) mkdirSync(dir, { mode: 0o700 })
  }
  return dir
}

/** Why a Work thread cannot run on Muse here, or null. */
export function museWorkRefusal(): string | null {
  return deps ? null : "this host has no data folder for a Work thread's Muse dirs"
}

/** The Work dirs for a thread, put back as the fence keeps them (above). Throws when the host has none. */
export function museWorkDirs(threadId: string, account: string | null, scope: ScopeKey = 'global', skillsPointer: string | null = null): MuseWorkDirs {
  if (!deps) throw new Error(museWorkRefusal()!)
  const work = museWorkRoot(deps.root)
  const blob = account ? deps.readBlob(account) : null
  const owner = account && blob ? [MUSE_ACCOUNTS, museAccountDirName(account)] : [MUSE_OWN]
  const museDir = realDir(work, 'config', ...owner, scope, 'muse')
  for (const name of readdirSync(museDir)) if (name !== AUTH) rmSync(join(museDir, name), { recursive: true, force: true })
  if (account && blob) writeAuth(museDir, blob)
  else linkOwnAuth(museDir, deps.userConfigDir ?? userMuseConfigDir())
  // 'wx': made new, so a link planted since the sweep fails the spawn rather than take the write.
  writeFileSync(join(museDir, 'settings.json'), MUSE_WORK_SETTINGS, { flag: 'wx', mode: 0o600 })
  if (skillsPointer !== null) linkEntry(join(skillsPointer, 'skills'), join(museDir, 'skills'))
  const dataDir = realDir(work, 'data')
  const dataMuse = realDir(work, 'data', 'muse')
  for (const name of MUSE_WORK_DATA_DROP) rmSync(join(dataMuse, name), { recursive: true, force: true })
  const root = join(realDir(work, 'roots'), rootName(threadId))
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { mode: 0o700 })
  // No templates (the person's init.templateDir) and none of this process's GIT_* (a GIT_DIR would put the repo elsewhere).
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))
  execFileSync('git', ['init', '-q', '--template=', root], { env, stdio: 'ignore' })
  return { configDir: dirname(museDir), dataDir, root: realpathSync(root), credentialFile: !!(account && blob) }
}

/** The account dirs under the new layout (one per account, each holding a dir per scope). */
export function museAccountDirs(): string[] {
  if (!deps) return []
  try {
    return readdirSync(join(deps.root, MUSE_ACCOUNTS))
  } catch {
    return []
  }
}

/** Boot: each old `<root>/<account>/muse/` dir is recaptured into the vault, then removed. */
export function migrateMuseDirs(): void {
  if (!deps || !existsSync(deps.root)) return
  const byDir = new Map((deps.accounts?.() ?? []).map((a) => [museAccountDirName(a), a]))
  for (const name of readdirSync(deps.root)) {
    const museDir = join(deps.root, name, 'muse')
    if (!lstatOrNull(museDir)?.isDirectory()) continue
    const account = byDir.get(name)
    const text = readText(join(museDir, AUTH))
    const stored = account ? deps.readBlob(account) : null
    if (account && text !== null && stored && text.trim() !== stored.trim() && holdsCredential(text) && deps.saveBlob) {
      deps.saveBlob(account, text)
      deps.log?.(`[muse] account ${account}: auth.json changed on disk; saved back to the vault`)
    }
    // Links are removed, never followed: nothing of the person's goes.
    rmSync(name === MUSE_ACCOUNTS || name === MUSE_OWN ? museDir : join(deps.root, name), { recursive: true, force: true })
    deps.log?.(`[muse] ${name}: the old config dir removed (one per account and scope now)`)
  }
}

// ── the driver's seam ───────────────────────────────────────────────────

export interface MuseSkillsConfig {
  /** The workspace a thread reads skills for (views.ts workspaceOfThread of the thread itself). */
  scopeOf: (session: { workspaceId: string | null; projectId: string | null; cwd: string }) => string | null
  pointers: Pick<SkillPointers, 'path'>
}

let skills: MuseSkillsConfig | null = null

export function configureMuseSkills(cfg: MuseSkillsConfig | null): void {
  skills = cfg
}

/** A Muse thread's skills scope and the pointer its `skills` links; null with no store. */
export function museSkillsFor(session: { workspaceId: string | null; projectId: string | null; cwd: string }): { scope: ScopeKey; pointer: string } | null {
  if (!skills) return null
  const workspaceId = skills.scopeOf(session)
  return { scope: scopeKeyOf(workspaceId), pointer: skills.pointers.path('muse', workspaceId) }
}
