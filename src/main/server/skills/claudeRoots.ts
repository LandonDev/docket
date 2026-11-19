import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { RESERVED_SKILL_NAME } from '@shared/skills'
import { SCOPE_DIR } from './materialize'
import { scopeKeyOf, type ScopeKey, type SkillPointers } from './pointers'
import { COPY_STAMPS, copiedNames, JUNCTIONS, linkTargetOf, swapDirLink, syncCopy } from './links'

/**
 * Claude Code reads the skills store, and only the store (CLAUDE.md "Skills:
 * one store, materialized per host"): each scope has a config dir the app owns,
 * handed to the CLI as CLAUDE_CONFIG_DIR.
 *
 *   <userData>/harness/claude-config/<scope>/
 *     skills/<name>   → <scope pointer>/skills/<name>, one link per store skill
 *     skills/synced   → the person's skills/synced (the CLI's account-synced bucket)
 *     .claude.json    → the person's
 *     <every other entry of the person's dir> → the person's entry
 *
 * The CLI so lists the store's skills under their own names, the project's
 * .claude/skills and its synced bucket, and never the person's
 * ~/.claude/skills or ~/.agents/skills. Transcripts and memory land in the
 * person's projects/ through its link; what the CLI makes for itself
 * (sessions/, backups/, lock files) stays in the scope's dir. The sign-in
 * rides the gateway: a routed thread holds `CLAUDE_CODE_OAUTH_TOKEN=routed`,
 * which the gateway replaces with the thread's account.
 *
 * A Work thread (docs/agents/work.md "The fence") runs under a root of its
 * own, beside the scope's:
 *
 *   <userData>/harness/claude-config-work/<scope>/
 *     skills/<name>      → the store's, as above
 *     projects           → the person's (transcripts and memory)
 *     CLAUDE.md          → the person's (their standing instructions)
 *     .credentials.json  → the person's (the sign-in of a thread no gateway routes)
 *     settings.json      the app's own file: account connectors off
 *
 * and nothing else of the person's: no .claude.json (their MCP servers), no
 * settings.json (their plugins, hooks and env), no plugins/, agents/ or
 * commands/. The list is what is linked, so an entry the person's dir gains
 * later is not in a Work root until someone adds it here.
 *
 * On Windows (`copies`) a directory link is a junction and a file "link" is a
 * copy kept in step both ways (links.ts syncCopy): a standard user may make
 * neither a file symlink nor a directory one, and the CLI replaces its files
 * by rename, which would part a hard link from the person's file.
 */

export const CLAUDE_ROOTS = 'claude-config'
/** Where the Work roots live, one per skills scope. */
export const CLAUDE_WORK_ROOTS = 'claude-config-work'
/** Every entry of the person's dir a Work root links. */
export const CLAUDE_WORK_LINKS: readonly string[] = ['projects', 'CLAUDE.md', '.credentials.json']
/**
 * Entries a Work root never keeps, link or not: each is a place the CLI reads
 * instructions or tools from at the user tier, and nothing but an agent's
 * shell would have put it there.
 */
export const CLAUDE_WORK_DROP: readonly string[] = ['agents', 'commands', 'rules', 'output-styles', 'plugins', 'workflows', 'hooks', 'settings.local.json', 'managed-settings.json']
/**
 * The files of the person's dir a root keeps as copies on Windows: the CLI's
 * settings, sign-in, state and standing instructions. Anything else (history,
 * logs) is the root's own there: a copy of a file two roots append to would
 * keep only one root's lines.
 */
export const CLAUDE_COPIED_FILES: readonly string[] = ['.claude.json', 'settings.json', '.credentials.json', 'CLAUDE.md']
/** A Work root's own settings.json: the CLI reads it as the user's, and it turns the account's connectors off. */
export const CLAUDE_WORK_SETTINGS = { disableClaudeAiConnectors: true } as const
/** The placeholder the gateway replaces with the thread's account. */
export const ROUTED_OAUTH = 'routed'
/** The name Claude Code keeps under skills/ for its account-synced skills (skillProblem refuses it for a new skill). */
export const SYNCED_SKILLS = RESERVED_SKILL_NAME
const CLAUDE_JSON = '.claude.json'
/** linkTo's tmp name, left behind only by a process that died between its two calls. */
const LEFTOVER_RE = /\.lnk-\d+$/

/** The person's Claude config dir: $CLAUDE_CONFIG_DIR of this process, else ~/.claude (sessionMove.ts claudeConfigDir). */
export function personClaudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

/** Where the person's .claude.json lives: <personClaudeDir>/.claude.json when CLAUDE_CONFIG_DIR is set, else ~/.claude.json. */
export function personClaudeJson(): string {
  return process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, CLAUDE_JSON) : join(homedir(), CLAUDE_JSON)
}

export interface ClaudeRootDeps {
  /** <userData>/harness */
  root: string
  scope: ScopeKey
  /** The scope's pointer (pointers.ts): <root>/claude/scope/<scope>. */
  pointer: string
  personDir?: string
  personJson?: string
  log?: (line: string) => void
  /** Junctions and file copies in place of symlinks (win32). */
  copies?: boolean
}

const defaultLog = (line: string): void => console.log(`[skills] ${line}`)

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

function readLink(path: string): string | null {
  try {
    return readlinkSync(path)
  } catch {
    return null
  }
}

/**
 * `path` is a link to `target`, made or re-pointed; a real entry in its place
 * is left alone (false). With `copies` a directory's link is a junction and a
 * file's is a copy kept in step (true while it is one).
 */
function linkTo(path: string, target: string, copies = JUNCTIONS, log: (line: string) => void = defaultLog): boolean {
  const st = lstatOrNull(path)
  if (copies && !isDir(target) && !st?.isSymbolicLink()) {
    if (st && !st.isFile()) return false
    syncCopy(path, target, log)
    return true
  }
  if (st && !st.isSymbolicLink()) return false
  if (st && linkTargetOf(readLink(path)) === target) return true
  const tmp = `${path}.lnk-${process.pid}`
  rmSync(tmp, { force: true })
  if (copies) {
    symlinkSync(target, tmp, 'junction')
    swapDirLink(tmp, path, true)
  } else {
    symlinkSync(target, tmp)
    renameSync(tmp, path)
  }
  return true
}

/** <root>/claude-config/<scope>/, made or refreshed, about thirty readdir and lstat calls. */
export function ensureClaudeRoot(deps: ClaudeRootDeps): string {
  const personDir = deps.personDir ?? personClaudeDir()
  const personJson = deps.personJson ?? personClaudeJson()
  const log = deps.log ?? defaultLog
  const copies = deps.copies ?? JUNCTIONS
  const dir = join(deps.root, CLAUDE_ROOTS, deps.scope)
  mkdirSync(dir, { recursive: true })
  // Transcripts and memory always land in the person's dir: its projects/ is made first when missing.
  mkdirSync(join(personDir, 'projects'), { recursive: true })

  // .claude.json: the person's. A regular file here means the CLI replaced the link by a rename (a copy is one by design).
  const json = join(dir, CLAUDE_JSON)
  const jst = lstatOrNull(json)
  if (!copies && jst && !jst.isSymbolicLink()) {
    renameSync(json, `${json}.diverged`)
    log(`${json} was a file of its own (the CLI replaced the link); set aside as ${CLAUDE_JSON}.diverged and linked again`)
  }
  linkTo(json, personJson, copies, log)

  // Every other entry of the person's dir, linked by its name (on Windows its directories, and the files CLAUDE_COPIED_FILES names).
  const theirs = new Set<string>()
  for (const name of readdirSync(personDir)) {
    if (name === 'skills' || name === CLAUDE_JSON || name === COPY_STAMPS) continue
    theirs.add(name)
    if (copies && !CLAUDE_COPIED_FILES.includes(name) && !isDir(join(personDir, name))) continue
    linkTo(join(dir, name), join(personDir, name), copies, log)
  }
  // A link to an entry the person's dir no longer has goes; what the CLI made here stays.
  const copied = new Set(copies ? copiedNames(dir) : [])
  for (const name of readdirSync(dir)) {
    if (name === 'skills' || name === CLAUDE_JSON || name === COPY_STAMPS || theirs.has(name)) continue
    const path = join(dir, name)
    if (LEFTOVER_RE.test(name) && lstatOrNull(path)?.isSymbolicLink()) {
      rmSync(path, { force: true })
      continue
    }
    if (copied.has(name)) {
      // A copy of a file the person's dir no longer has: syncCopy removes it once it was in step, else copies it back.
      syncCopy(path, join(personDir, name), log)
      continue
    }
    const target = lstatOrNull(path)?.isSymbolicLink() ? linkTargetOf(readLink(path)) : null
    if (target !== null && target === join(personDir, name)) rmSync(path, { force: true })
  }

  relinkClaudeSkills(dir, deps.pointer, personDir, log, copies)
  return dir
}

/**
 * <root>/claude-config-work/<scope>/, made or refreshed: the allowlist's
 * links, the app's own settings.json, the store's skills. A link to anything
 * else of the person's (a root an older rule made) goes; what the CLI wrote
 * here for itself stays.
 */
export function ensureClaudeWorkRoot(deps: ClaudeRootDeps): string {
  const personDir = deps.personDir ?? personClaudeDir()
  const log = deps.log ?? defaultLog
  const copies = deps.copies ?? JUNCTIONS
  const dir = join(deps.root, CLAUDE_WORK_ROOTS, deps.scope)
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(personDir, 'projects'), { recursive: true })
  for (const name of CLAUDE_WORK_LINKS) {
    const path = join(dir, name)
    // The person's standing instructions are the person's file, never one written in its place here (a copy in step is theirs).
    if (name === 'CLAUDE.md' && lstatOrNull(path) && !lstatOrNull(path)!.isSymbolicLink() && !(copies && copiedNames(dir).includes(name))) {
      rmSync(path, { recursive: true, force: true })
      log(`${path} was a file of its own; removed and linked to the person's`)
    }
    if (lstatOrNull(join(personDir, name))) {
      if (!linkTo(path, join(personDir, name), copies, log)) log(`${path} is a file of its own, not the person's ${name}`)
    } else if (lstatOrNull(path)?.isSymbolicLink()) rmSync(path, { force: true })
    else if (copies && copiedNames(dir).includes(name)) syncCopy(path, join(personDir, name), log)
  }
  for (const name of readdirSync(dir)) {
    if (name === 'skills' || name === COPY_STAMPS || CLAUDE_WORK_LINKS.includes(name)) continue
    const path = join(dir, name)
    if (CLAUDE_WORK_DROP.includes(name)) {
      rmSync(path, { recursive: true, force: true })
      log(`${path} removed: a Work root holds no ${name}`)
      continue
    }
    // Nothing else here may point out of the root: a link is the person's entry under another name.
    if (lstatOrNull(path)?.isSymbolicLink()) {
      rmSync(path, { force: true })
      log(`${path} was a link; a Work root links only ${CLAUDE_WORK_LINKS.join(', ')}`)
    }
  }
  const settings = join(dir, 'settings.json')
  const want = `${JSON.stringify(CLAUDE_WORK_SETTINGS, null, 2)}\n`
  let have: string | null = null
  try {
    have = readFileSync(settings, 'utf8')
  } catch {
    // not written yet
  }
  if (have !== want) {
    // Written in place of whatever is there: a link here would send the write into the person's own file.
    rmSync(settings, { recursive: true, force: true })
    writeFileSync(settings, want)
  }
  relinkClaudeSkills(dir, deps.pointer, personDir, log, copies)
  // Only the store's skills: a folder written into skills/ by hand is not one.
  for (const name of readdirSync(join(dir, 'skills'))) {
    const path = join(dir, 'skills', name)
    if (!lstatOrNull(path)?.isSymbolicLink()) rmSync(path, { recursive: true, force: true })
  }
  return dir
}

/** Store rows named `synced` already said once (a peer's put never meets skillProblem). */
const syncedSaid = new Set<string>()

/**
 * Re-link `<scope root>/skills/` to the pointer's current skill names: one
 * link per skill through the pointer (an edited skill is reached at once; a
 * skill added or removed needs this), plus the person's synced bucket. A
 * scope with no root yet is left alone: its first spawn makes it.
 */
export function relinkClaudeSkills(rootDir: string, pointer: string, personDir = personClaudeDir(), log: (line: string) => void = defaultLog, copies = JUNCTIONS): void {
  if (!existsSync(rootDir)) return
  const skillsDir = join(rootDir, 'skills')
  const st = lstatOrNull(skillsDir)
  if (st && !st.isDirectory()) rmSync(skillsDir, { force: true })
  mkdirSync(skillsDir, { recursive: true })
  const wanted = new Map<string, string>()
  let names: string[] = []
  try {
    names = readdirSync(join(pointer, 'skills'))
  } catch {
    // the pointer names nothing yet: no store skills
  }
  for (const name of names) {
    if (name === SYNCED_SKILLS) {
      if (!syncedSaid.has(rootDir)) log(`a store skill named ${SYNCED_SKILLS} is not linked for Claude Code: that name is its own skills folder`)
      syncedSaid.add(rootDir)
      continue
    }
    wanted.set(name, join(pointer, 'skills', name))
  }
  const synced = join(personDir, 'skills', SYNCED_SKILLS)
  if (isDir(synced)) wanted.set(SYNCED_SKILLS, synced)
  for (const [name, target] of wanted) linkTo(join(skillsDir, name), target, copies)
  for (const name of readdirSync(skillsDir)) {
    if (wanted.has(name)) continue
    const path = join(skillsDir, name)
    if (lstatOrNull(path)?.isSymbolicLink()) rmSync(path, { force: true })
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// ── the driver's seam ───────────────────────────────────────────────────

export interface ClaudeSkillRootsConfig {
  /** The workspace a thread reads skills for (views.ts workspaceOfThread of the thread itself). */
  scopeOf: (session: { workspaceId: string | null; projectId: string | null; cwd: string }) => string | null
  pointers: Pick<SkillPointers, 'path' | 'current' | 'onMoved'>
  /** <userData>/harness */
  root: string
  log?: (line: string) => void
}

let configured: (ClaudeSkillRootsConfig & { off: () => void }) | null = null

/** Point every Claude thread at its scope's owned root; null is today's spawn exactly (tests, a host without the store). */
export function configureClaudeSkillRoots(cfg: ClaudeSkillRootsConfig | null): void {
  configured?.off()
  configured = null
  if (!cfg) return
  // A move re-links the scope's root before any thread reloads: a skill added or removed in the store needs a link.
  const off = cfg.pointers.onMoved((provider, scope) => {
    if (provider !== 'claude') return
    try {
      for (const base of [CLAUDE_ROOTS, CLAUDE_WORK_ROOTS]) relinkClaudeSkills(join(cfg.root, base, scope), join(cfg.root, 'claude', SCOPE_DIR, scope), undefined, cfg.log)
    } catch (err) {
      ;(cfg.log ?? defaultLog)(`claude ${scope}: relink failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
  configured = { ...cfg, off }
}

/** <userData>/harness, where the app keeps each harness's own roots; null when unconfigured. */
export function harnessRoot(): string | null {
  return configured?.root ?? null
}

export interface ClaudeSkillRoot {
  /** CLAUDE_CONFIG_DIR for the CLI */
  dir: string
  workspaceId: string | null
  /** A Work root: nothing of the person's but the allowlist. */
  work?: true
}

/** The owned root a thread's CLI runs under, made or refreshed now; null when unconfigured. A Work thread gets its scope's Work root. */
export function claudeSkillRootFor(session: { workspaceId: string | null; projectId: string | null; cwd: string; scope?: 'code' | 'work' }): ClaudeSkillRoot | null {
  if (!configured) return null
  const workspaceId = configured.scopeOf(session)
  const pointer = configured.pointers.path('claude', workspaceId)
  const deps = { root: configured.root, scope: scopeKeyOf(workspaceId), pointer, log: configured.log }
  if (session.scope === 'work') return { dir: ensureClaudeWorkRoot(deps), workspaceId, work: true }
  return { dir: ensureClaudeRoot(deps), workspaceId }
}

/** The generation a scope's pointer names now; null when unconfigured. */
export function claudeSkillsGeneration(workspaceId: string | null): string | null {
  return configured ? configured.pointers.current('claude', workspaceId).generation : null
}

/** The generation the scope of an owned root (a spec's CLAUDE_CONFIG_DIR) names now; null for any other dir. */
export function claudeGenerationOfRoot(configDir: string | undefined): string | null {
  if (!configured || !configDir) return null
  const scope = basename(configDir)
  if (join(configured.root, CLAUDE_ROOTS, scope) !== configDir && join(configured.root, CLAUDE_WORK_ROOTS, scope) !== configDir) return null
  return claudeSkillsGeneration(scope === 'global' ? null : scope.startsWith('ws-') ? scope.slice(3) : null)
}
