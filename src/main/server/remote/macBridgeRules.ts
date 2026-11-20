import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import type {
  MacBridgeRule,
  MacDecideRemember,
  MacRemember,
  MacRunRememberOffer
} from '@shared/contract-macbridge-rules'
import { insideRoots, plainWindowsPath, realSpelling } from './fence'

/**
 * The Mac bridge's remember rules (docs/box.md "The Mac bridge", "Remembered
 * approvals"; contract-macbridge-rules.ts). Pure matching plus an in-memory
 * book keyed by (host, thread); nothing here is ever written to disk.
 *
 * The safety floor, whatever is remembered: a command that names one of
 * ALWAYS_ASK's programs (anywhere in its argv or command text, so
 * `sh -c "sudo …"` and `env sudo …` count), `defaults write|delete|import|
 * rename`, a recursive `rm` of `/`, a top-level folder or the home
 * directory, or any credential path in CREDENTIAL_PATHS (in its argv,
 * command text or cwd) asks every time, and no rule is ever made from it.
 * Over-asking is the safe side: `echo sudo` asks too.
 *
 * On a Windows host (docs/agents/windows-host.md) WINDOWS_ALWAYS_ASK joins
 * the list, PowerShell with an encoded command or an execution policy asks,
 * a recursive delete (`rm -r`, `rd /s`, `Remove-Item -Recurse`, `del /s`)
 * of a drive, a top folder or the profile asks, and names and paths compare
 * case-blind with `\` read as `/` and `.exe` dropped.
 */

/** Programs that ask every time, under every rule. One place; docs/box.md lists them. */
export const ALWAYS_ASK = ['sudo', 'su', 'doas', 'security', 'osascript', 'launchctl'] as const
/** Windows programs that ask every time on a Windows host: the registry, services, tasks, trust, ACLs, boot and disks. */
export const WINDOWS_ALWAYS_ASK = [
  'runas',
  'reg',
  'regedit',
  'schtasks',
  'sc',
  'certutil',
  'cmdkey',
  'netsh',
  'icacls',
  'takeown',
  'bcdedit',
  'vssadmin',
  'diskpart',
  'format',
  'wmic',
  'set-executionpolicy',
  // PowerShell's own ways to the registry, tasks, services, ACLs and Defender, and hosts that run script text the card cannot show.
  'set-itemproperty',
  'new-itemproperty',
  'remove-itemproperty',
  'register-scheduledtask',
  'new-service',
  'set-service',
  'set-acl',
  'add-mppreference',
  'set-mppreference',
  'invoke-expression',
  'iex',
  'mshta',
  'rundll32',
  'regsvr32',
  'wscript',
  'cscript',
  'vaultcmd'
] as const
/** `defaults <verb>` that writes; `defaults read` is fine. */
const DEFAULTS_WRITES = new Set(['write', 'delete', 'import', 'rename'])
/** Path names that mark a credential: in a command's text or cwd they make it ask every time. */
export const CREDENTIAL_PATHS = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.aliax',
  'Library/Keychains',
  '.netrc',
  '.git-credentials',
  '.docker/config.json',
  '.kube/config',
  '.config/gh',
  '.npmrc',
  '.pypirc',
  '.claude/.credentials.json',
  '.codex/auth.json',
  'id_rsa',
  'id_ecdsa',
  'id_ed25519'
] as const
/** Windows' own credential stores, checked on a Windows host on top of CREDENTIAL_PATHS. */
export const WINDOWS_CREDENTIAL_PATHS = ['Microsoft/Credentials', 'Microsoft/Protect', 'Microsoft/Vault'] as const
/** Shells and wrappers that run whatever follows them: never offered, never matched, as a 'program'. */
const NOT_A_PROGRAM = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'csh',
  'tcsh',
  'env',
  'xargs',
  'nohup',
  'time',
  'exec',
  'command',
  'builtin',
  'eval',
  'nice',
  'timeout',
  'caffeinate',
  'arch',
  'script'
])
/** On a Windows host, its own shells, launchers and terminals too. */
const NOT_A_PROGRAM_WIN = new Set([
  ...NOT_A_PROGRAM,
  'cmd',
  'powershell',
  'pwsh',
  'start',
  'call',
  'wsl',
  'wt',
  'conhost',
  'mintty',
  'git-bash'
])

export interface RunSpec {
  argv?: string[]
  command?: string
  /** The real cwd. */
  cwd: string
}

const strip = (word: string): string => word.slice(word.lastIndexOf('/') + 1)
/** A word as cmd.exe and PowerShell read it: their escapes (`r^eg`, ``r`eg``) dropped. */
const unescapeWin = (word: string): string => word.replace(/[\^`]/g, '')
/** A program's name as Windows reads it: unescaped, after either slash, case-blind, without .exe and its kin. */
const stripWin = (raw: string): string => {
  const word = unescapeWin(raw)
  return word
    .slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1)
    .toLowerCase()
    .replace(/\.(exe|com|cmd|bat|ps1)$/, '')
}
const nameOf = (platform: NodeJS.Platform): ((word: string) => string) => (platform === 'win32' ? stripWin : strip)

/**
 * A shell line's words, quotes removed, and whether it is more than one
 * simple command: an unquoted ; & | < > ( ) or newline, or a $( … ) or
 * backtick substitution outside single quotes.
 */
export function shellWords(line: string): { words: string[]; compound: boolean } {
  const words: string[] = []
  let word = ''
  let inWord = false
  let compound = false
  let quote: "'" | '"' | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote === "'") {
      if (c === "'") quote = null
      else word += c
      continue
    }
    if (c === '\\' && i + 1 < line.length) {
      word += line[++i]
      inWord = true
      continue
    }
    if (c === '`' || (c === '$' && line[i + 1] === '(')) compound = true
    if (quote === '"') {
      if (c === '"') quote = null
      else word += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      inWord = true
      continue
    }
    if (/\s/.test(c)) {
      if (c === '\n') compound = true
      if (inWord) words.push(word)
      word = ''
      inWord = false
      continue
    }
    if (';&|<>()'.includes(c)) {
      compound = true
      if (inWord) words.push(word)
      word = ''
      inWord = false
      continue
    }
    word += c
    inWord = true
  }
  if (inWord) words.push(word)
  return { words, compound }
}

/** The program a 'program' rule names for a command, or null where none would be safe to name. */
export function programOf(
  spec: { argv?: string[]; command?: string },
  platform: NodeJS.Platform = process.platform
): string | null {
  let first: string | undefined
  if (spec.argv) first = spec.argv[0]
  else if (spec.command !== undefined) {
    const { words, compound } = shellWords(spec.command)
    if (compound) return null
    first = words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))
  }
  const name = first ? nameOf(platform)(first) : ''
  if (!name || (platform === 'win32' ? NOT_A_PROGRAM_WIN : NOT_A_PROGRAM).has(name)) return null
  return name
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const credentialResOf = (names: readonly string[], flags: string) =>
  names.map(
    (name) => [name, new RegExp(`(^|[^A-Za-z0-9_.-])${escape(name)}(?=$|[^A-Za-z0-9_-])`, flags)] as const
  )
const CREDENTIAL_RES = credentialResOf(CREDENTIAL_PATHS, '')
const CREDENTIAL_RES_WIN = credentialResOf([...CREDENTIAL_PATHS, ...WINDOWS_CREDENTIAL_PATHS], 'i')

/** Home by its real spelling, read on this machine only (a test of another platform's paths keeps it as given). */
const realHomeOf = (home: string, platform: NodeJS.Platform): string =>
  platform === process.platform ? realSpelling(home) : home

/** home and every directory above it (a drive's root on Windows, case-blind there). */
export function coversHome(dir: string, home: string, platform: NodeJS.Platform = process.platform): boolean {
  const win = platform === 'win32'
  const sep = win ? win32.sep : posix.sep
  const d = win ? dir.toLowerCase() : dir
  const h = win ? home.toLowerCase() : home
  if (d === sep || d === h || (win && /^[a-z]:\\?$/.test(d))) return true
  return h.startsWith(d.endsWith(sep) ? d : d + sep)
}

/**
 * A box path as this host reads it, before its real spelling: `~` and `~/…`
 * (on Windows `~\…` too) under home, else absolute. A Windows host takes only
 * a drive path (`C:\…` or `C:/…`): never a UNC share or device path, a stream
 * name, a drive-relative `C:foo` or a root with no drive (the box's `/srv/…`,
 * fence.ts plainWindowsPath).
 */
export function hostPath(path: string, home: string, platform: NodeJS.Platform = process.platform): string {
  const p = platform === 'win32' ? win32 : posix
  const tilde = path.startsWith('~/') || (platform === 'win32' && path.startsWith('~\\'))
  const expanded = path === '~' ? home : tilde ? p.join(home, path.slice(2)) : path
  if (platform === 'win32' && !(/^[A-Za-z]:[\\/]/.test(expanded) && plainWindowsPath(expanded)))
    throw new Error(`paths on this Windows host must be drive paths (C:\\…) or start with ~\\: ${path}`)
  if (!p.isAbsolute(expanded))
    throw new Error(`paths on the Mac must be absolute or start with ~/: ${path}`)
  const resolved = p.resolve(expanded)
  // Windows opens `APPDAT~1` and `AppData.` as AppData: a spelling the deny lists would not know.
  if (platform === 'win32' && resolved.split('\\').slice(1).some(oddWindowsName))
    throw new Error(`refused: a short (8.3) name or a name ending in a dot or space: ${path}`)
  return resolved
}

/** A path segment Windows reads as another name: an 8.3 short name (`APPDAT~1`), or one ending in a dot or a space. */
function oddWindowsName(segment: string): boolean {
  return /^[^~]{1,6}~\d/.test(segment) || /[. ]$/.test(segment)
}

/** The flag before the line a shell runs: cmd's /c and /k, bash's -c, PowerShell's -Command and its prefixes, any dash. */
const SHELL_LINE_FLAG = /^[-/\u2013\u2014\u2015](c|k|co|com|comm|comma|comman|command)$/i

/** cmd.exe or PowerShell making the program from variables (`set p=re & call %p%g`, `r%x%g`): no card could show what runs. */
function builtFromVariables(names: string[], words: string[]): boolean {
  const expands = (w: string): boolean => /%[^%\s]+%|![^!\s]+!/.test(w)
  if (words.some((w) => /[A-Za-z0-9_.]%[^%\s]+%|%[^%\s]+%[A-Za-z0-9_.]|[A-Za-z0-9_]![^!\s]+!|![^!\s]+![A-Za-z0-9_]/.test(w))) return true
  return (names.includes('call') || names.includes('set')) && words.some(expands)
}

/** `powershell -EncodedCommand` (any prefix PowerShell takes, and -ec) or an execution policy: what it runs cannot be read off the card. */
function opaquePowerShell(names: string[], words: string[]): boolean {
  if (!names.some((n) => n === 'powershell' || n === 'pwsh')) return false
  return words.some((w) => {
    // PowerShell takes an en dash, an em dash or a horizontal bar for the dash, and `-Flag:value`.
    const flag = /^[-/\u2013\u2014\u2015]+([A-Za-z]+)(?::.*)?$/.exec(w)?.[1]?.toLowerCase()
    if (!flag) return false
    return flag === 'ec' || flag === 'e' || (flag.length >= 2 && ('encodedcommand'.startsWith(flag) || 'executionpolicy'.startsWith(flag)))
  })
}

/** A recursive delete on Windows: `rm -r` (Git Bash), `rd /s` and `rmdir /s`, `del /s`, `Remove-Item -Recurse` and its aliases. */
function windowsRecursiveDelete(names: string[], words: string[]): boolean {
  const lower = words.map((w) => w.toLowerCase().replace(/^[\u2013\u2014\u2015]/, '-'))
  if (names.includes('rm') && lower.some((w) => /^-[a-z]*r/.test(w) || w === '--recursive')) return true
  // cmd.exe takes switches run together: `/S/Q`.
  if (names.some((n) => ['rd', 'rmdir', 'del', 'erase'].includes(n)) && lower.some((w) => /^\/[a-z?](\/[a-z?])*$/.test(w) && w.split('/').includes('s'))) return true
  return names.some((n) => ['remove-item', 'ri', 'rm', 'del', 'erase', 'rmdir', 'rd'].includes(n)) && lower.some((w) => {
    const flag = w.replace(/:.*$/, '')
    return flag.length >= 2 && '-recurse'.startsWith(flag)
  })
}

/** Whether a word names a whole drive, a top folder or the profile (Windows spellings). */
function windowsWide(word: string, cwd: string, home: string, realHome: string, msys: boolean): boolean {
  let t = word.replace(/[\\/]\*?$/, '').toLowerCase()
  // Git Bash spells C:\ as /c (here already \c): only where its rm runs, since cmd.exe's switches look the same.
  if (msys) t = t.replace(/^\\([a-z])(?=\\|$)/, '$1:')
  if (t === '' || /^[a-z]:$/.test(t) || /^[a-z]:[\\/][^\\/]*$/.test(t)) return true // \, C:\, C:\Users, C:\Windows
  const profile = ['~', '$home', '${home}', '$userprofile', '${userprofile}', '%userprofile%', '%homedrive%%homepath%', '$env:userprofile']
  if ([...profile, home.toLowerCase(), realHome.toLowerCase()].includes(t)) return true
  return ['.', '*', '..'].includes(t) && coversHome(cwd, realHome, 'win32')
}

/**
 * Apps whose scripting reaches no one: a Work thread's `osascript` that
 * drives only these runs under full access and Away (workFloor). Not here:
 * Mail, Messages, Outlook, Calendar (invites), the browsers, Finder (it
 * opens anything), System Events (keys into any app), and every app whose
 * plain edit can reach someone through a shared list, album or document
 * (Notes, Reminders, Photos, Pages, Numbers, Keynote).
 */
export const WORK_LOCAL_SCRIPT_APPS = ['Contacts', 'TextEdit', 'Preview'] as const

/** Script words that reach past the app they name: a shell, a URL, a network volume or a printer, a loaded script or framework, raw Apple Events, the ObjC bridge, code built at run time. */
const OSA_LEAVES_AS =
  /do\s+shell\s+script|open\s+location|mount\s+volume|\bprint\b|\/Volumes\/|(run|load|store)\s+script|\buse\s+(script|framework)\b|«|<<\s*event|using\s+terms\s+from|application\s+id\b|\|/i
const OSA_LEAVES_JS =
  /\/Volumes\/|\b(print|doShellScript|openLocation|mountVolume|runScript|loadScript|storeScript|includeStandardAdditions|currentApplication|ObjC|Library|eval|Function|constructor|__proto__|this|globalThis|Reflect|Proxy|import|require|NS[A-Z]\w*)\b|\$(?=\s*(?:[.(\[;,)]|$))/
/** JXA text with its \u escapes read as the characters they stand for: an identifier may be spelled with them. */
const unescapeJs = (text: string): string =>
  text.replace(/\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})/g, (whole, braced?: string, four?: string) => {
    const code = parseInt(braced ?? four ?? '', 16)
    return code <= 0x10ffff ? String.fromCodePoint(code) : whole
  })
const localApp = (name: string): boolean => (WORK_LOCAL_SCRIPT_APPS as readonly string[]).includes(name)

/**
 * Whether an `osascript` run, as argv with `-e` text, drives only
 * WORK_LOCAL_SCRIPT_APPS, each named as a plain string. Anything else asks:
 * a script file or stdin, `-i`, an unknown option or language, an app named
 * any other way. It reads an honest script; one written to get round it is
 * the shell's, which full access already leaves unfenced (work-scope.md
 * "What the fence does not do").
 */
export function osaStaysLocal(argv: readonly string[]): boolean {
  // Apple's own osascript by its path: any other file of that name, or one PATH finds first, is just another program
  if (argv[0] !== '/usr/bin/osascript') return false
  let lang = 'AppleScript'
  const texts: string[] = []
  let i = 1
  for (; i < argv.length && argv[i].startsWith('-'); i += 2) {
    const value = argv[i + 1]
    if (value === undefined) return false
    if (argv[i] === '-e') texts.push(value)
    else if (argv[i] === '-l') lang = value
    else if (argv[i] !== '-s') return false
  }
  if (texts.length === 0) return false
  const raw = texts.join('\n')
  if (lang === 'JavaScript') {
    const text = unescapeJs(raw)
    if (OSA_LEAVES_JS.test(text)) return false
    return [...text.matchAll(/\bApplication\b/g)].every((m) => {
      const named = /^\s*\(\s*(['"])([^'"\\]*)\1\s*\)/.exec(text.slice(m.index + m[0].length))
      return !!named && localApp(named[2])
    })
  }
  if (lang !== 'AppleScript' || OSA_LEAVES_AS.test(raw)) return false
  return [...raw.matchAll(/\b(application|app)\b/gi)].every((m) => {
    const named = /^\s*"([^"\\]*)"/.exec(raw.slice(m.index + m[0].length))
    return !!named && localApp(named[1])
  })
}

/**
 * The floor for a Work thread's command (contract-macbridge.ts
 * `workMustAsk`): the always-ask floor, save an `osascript` that stays
 * local (osaStaysLocal), which is judged as if it were not on the list.
 */
export function workFloor(
  spec: RunSpec,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform
): string | null {
  const reason = alwaysAsks(spec, home, platform)
  if (reason !== 'osascript' || platform === 'win32' || !spec.argv || !osaStaysLocal(spec.argv)) return reason
  return alwaysAsks(spec, home, platform, ['osascript'])
}

/** Why a command asks every time whatever is remembered, or null; `except` names list programs a caller has judged already. */
export function alwaysAsks(
  spec: RunSpec,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  except: readonly string[] = []
): string | null {
  const win = platform === 'win32'
  const pieces = spec.argv ?? (spec.command !== undefined ? [spec.command] : [])
  // On Windows `\` is a path's separator, never an escape, and cmd's `^` and PowerShell's backtick are dropped;
  // the line a shell is handed (`cmd /c "…"`, `powershell -Command "…"`, `bash -c "…"`) is read once more.
  const split = (p: string): string[] => shellWords(win ? unescapeWin(p).replace(/\\/g, '/') : p).words
  const lineOf = (ws: string[]): string[] =>
    ws.flatMap((w, i) => (i > 0 && SHELL_LINE_FLAG.test(ws[i - 1]) ? [w, ...split(w)] : [w]))
  const words = pieces.flatMap((p) => [p, ...(win ? lineOf(split(p)) : split(p))])
  const names = words.map(nameOf(platform))
  for (const program of ALWAYS_ASK) if (!except.includes(program) && names.includes(program)) return program
  if (win) {
    for (const program of WINDOWS_ALWAYS_ASK) if (names.includes(program)) return program
    if (opaquePowerShell(names, words)) return 'PowerShell with an encoded command or an execution policy'
    if (builtFromVariables(names, words)) return 'a command built from variables'
    if (windowsRecursiveDelete(names, words)) {
      const realHome = realHomeOf(home, platform)
      const msys = names.includes('rm')
      if (words.some((w) => windowsWide(w.replace(/\//g, '\\'), spec.cwd, home, realHome, msys)))
        return 'a recursive delete of a drive, a top folder or the profile'
    }
    const text = unescapeWin([...pieces, spec.cwd].join('\n')).replace(/\\/g, '/')
    if (/(^|[^a-z])(hkcu|hklm|hkcr|hku|hkcc):|registry::/i.test(text)) return 'the registry through PowerShell'
    if (/\/[^/\s~]{1,6}~\d/.test(text)) return 'a short (8.3) path name'
    for (const [name, re] of CREDENTIAL_RES_WIN) if (re.test(text)) return `names a credential path (${name})`
    return null
  }
  for (let i = 0; i < names.length - 1; i++)
    if (names[i] === 'defaults' && DEFAULTS_WRITES.has(words[i + 1]))
      return `defaults ${words[i + 1]}`
  if (names.includes('rm') && words.some((w) => /^-[A-Za-z]*[rR]/.test(w) || w === '--recursive')) {
    const realHome = realSpelling(home)
    const wide = words.some((w) => {
      const t = w.replace(/\/\*?$/, '') || '/'
      if (['~', '$HOME', '${HOME}', home, realHome].includes(t)) return true
      if (/^\/[^/]*$/.test(t)) return true // '/', '/*', '/Users', '/System'
      return ['.', '*', '..'].includes(t) && coversHome(spec.cwd, realHome)
    })
    if (wide) return 'rm -r of / or the home directory'
  }
  const text = [...pieces, spec.cwd].join('\n')
  for (const [name, re] of CREDENTIAL_RES)
    if (re.test(text)) return `names a credential path (${name})`
  return null
}

/** What a run card offers to remember beyond exact and thread. */
export function runOffer(
  spec: RunSpec,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform
): MacRunRememberOffer {
  const reason = alwaysAsks(spec, home, platform)
  if (reason) return { alwaysAsk: reason }
  const program = programOf(spec, platform)
  const folder = coversHome(spec.cwd, realHomeOf(home, platform), platform) ? null : spec.cwd
  return { ...(folder ? { folder } : {}), ...(program ? { program } : {}) }
}

/** The kind a decide's remember makes for a command: true is the old "this exact command". */
export function runRememberKind(remember: MacDecideRemember | undefined): MacRemember | null {
  if (remember === true) return 'exact'
  if (!remember) return null
  return remember
}

/** Whether a decide's remember asks for a read's folder (true, or 'folder'). */
export const readRemembers = (remember: MacDecideRemember | undefined): boolean =>
  remember === true || remember === 'folder'

export const exactKey = (spec: RunSpec): string =>
  JSON.stringify([spec.argv ?? null, spec.command ?? null, spec.cwd])

/** Whether one rule covers a command (the always-ask floor is checked by the caller). */
export function ruleCovers(rule: MacBridgeRule, spec: RunSpec): boolean {
  switch (rule.kind) {
    case 'exact':
      return (
        exactKey({
          ...(rule.argv ? { argv: rule.argv } : { command: rule.command }),
          cwd: rule.cwd ?? ''
        }) === exactKey(spec)
      )
    case 'folder':
      return !!rule.folder && insideRoots(spec.cwd, [rule.folder])
    case 'program':
      return !!rule.program && programOf(spec) === rule.program
    case 'thread':
      return true
    default:
      return false
  }
}

export interface RuleThread {
  environmentId: string
  hostName: string
  sessionId: string
  threadTitle: string
}

/** Narrowest first: the rule a command is credited to. */
const ORDER: Record<MacBridgeRule['kind'], number> = {
  exact: 0,
  folder: 1,
  program: 2,
  thread: 3,
  'read-folder': 4
}

/** Every remembered rule on this Mac, in memory only. */
export class MacBridgeRuleBook {
  private rules: MacBridgeRule[] = []

  constructor(private readonly home: string = homedir()) {}

  private same(a: RuleThread, b: { environmentId: string; sessionId: string }): boolean {
    return a.environmentId === b.environmentId && a.sessionId === b.sessionId
  }

  private add(rule: Omit<MacBridgeRule, 'id' | 'createdAt' | 'uses'>): MacBridgeRule {
    const twin = this.rules.find(
      (r) =>
        this.same(r, rule) &&
        r.kind === rule.kind &&
        r.folder === rule.folder &&
        r.program === rule.program &&
        JSON.stringify([r.argv, r.command, r.cwd]) ===
          JSON.stringify([rule.argv, rule.command, rule.cwd])
    )
    if (twin) return twin
    const made: MacBridgeRule = {
      ...rule,
      id: `mbr_${randomBytes(6).toString('base64url')}`,
      createdAt: Date.now(),
      uses: 0
    }
    this.rules.push(made)
    return made
  }

  /** "Allow this folder for this thread" on a read. */
  addRead(thread: RuleThread, folder: string): MacBridgeRule {
    return this.add({ ...thread, kind: 'read-folder', folder })
  }

  /** A command allowed with remember; null when that kind is not on offer for it. */
  addRun(thread: RuleThread, kind: MacRemember, spec: RunSpec): MacBridgeRule | null {
    const offer = runOffer(spec, this.home)
    if (offer.alwaysAsk) return null
    if (kind === 'exact')
      return this.add({
        ...thread,
        kind,
        ...(spec.argv ? { argv: spec.argv } : { command: spec.command }),
        cwd: spec.cwd
      })
    if (kind === 'folder')
      return offer.folder ? this.add({ ...thread, kind, folder: offer.folder }) : null
    if (kind === 'program')
      return offer.program ? this.add({ ...thread, kind, program: offer.program }) : null
    return this.add({ ...thread, kind: 'thread' })
  }

  /** The thread's read folders, for readVerdict's remembered list. */
  readFolders(envId: string, sessionId: string): string[] {
    return this.rules
      .filter((r) => r.kind === 'read-folder' && this.same(r, { environmentId: envId, sessionId }))
      .map((r) => r.folder as string)
  }

  /** A read went through on a remembered folder: credit the rule. */
  creditRead(envId: string, sessionId: string, real: string): void {
    const rule = this.rules.find(
      (r) =>
        r.kind === 'read-folder' &&
        this.same(r, { environmentId: envId, sessionId }) &&
        insideRoots(real, [r.folder as string])
    )
    if (rule) rule.uses++
  }

  /** The rule that lets a command start without a prompt, or null (always so for an always-ask command). */
  runAllowed(envId: string, sessionId: string, spec: RunSpec): MacBridgeRule | null {
    if (alwaysAsks(spec, this.home)) return null
    const rule = this.rules
      .filter((r) => r.kind !== 'read-folder' && this.same(r, { environmentId: envId, sessionId }))
      .sort((a, b) => ORDER[a.kind] - ORDER[b.kind])
      .find((r) => ruleCovers(r, spec))
    if (rule) rule.uses++
    return rule ?? null
  }

  list(sessionId?: string): MacBridgeRule[] {
    return this.rules
      .filter((r) => sessionId === undefined || r.sessionId === sessionId)
      .map((r) => ({ ...r }))
  }

  /** Forget one rule of a thread, or all of them; answers what is left for it. */
  forget(sessionId: string, ruleId?: string): MacBridgeRule[] {
    this.rules = this.rules.filter(
      (r) => r.sessionId !== sessionId || (ruleId !== undefined && r.id !== ruleId)
    )
    return this.list(sessionId)
  }

  clear(): void {
    this.rules = []
  }
}
