import { errorLine } from '@shared/computer/errorWords'
import { hostErrorLine } from '@shared/computer/hostErrors'
import type { ConfirmNeed } from '@shared/computer/policy'
import { parseKeyCombo } from '@shared/computer/observation'
import {
  NO_INPUT_ACTIONS,
  type AppInfo,
  type ComputerAction,
  type ComputerError,
  type ComputerResult,
  type FrontReport
} from '@shared/computer/protocol'
import type { ElementBook } from './elements'

/**
 * What the host enforces of the confirmations policy, whatever the model
 * flagged (docs/computer-protocol.md "The model's words"): the app a call
 * acts on, pinned by pid before any request, so the app checked is the app
 * acted on; the apps no call may touch; and the password rule. Where text
 * with no target goes is the service's to judge (§27.7).
 */

/** The installed app's bundle id: no instance reads or acts on any TempCode window. */
export const TEMPCODE_BUNDLE_ID = 'dev.landon.tempcode'
/** The same on Windows, where the service names an app by its exe, lower-cased (§29.2). */
export const TEMPCODE_WINDOWS_EXE = 'tempcode.exe'

/** Windows' password and consent prompts, as the service names their apps. */
export const WINDOWS_PROMPT_EXES: readonly string[] = ['consent.exe', 'credentialuibroker.exe', 'logonui.exe']

/**
 * macOS's password and Touch ID prompts: the person answers them. Not regular
 * apps, so apps.list never names them and the pinned target cannot reach them
 * by name; this list is the second line.
 * Read from their bundles on macOS 27.2 (26B5112a):
 * `com.apple.SecurityAgent`: /System/Library/Frameworks/Security.framework/Versions/A/MachServices/SecurityAgent.bundle.
 * `com.apple.LocalAuthentication.UIAgent`: /System/Library/Frameworks/LocalAuthentication.framework/Support/coreautha.bundle.
 */
export const REFUSED_ACT_BUNDLES: readonly string[] = ['com.apple.SecurityAgent', 'com.apple.LocalAuthentication.UIAgent']

/** Every `apps.launch` names these as `refuse`: the service checks the resolved app before it launches or opens anything (§23.2). */
export const REFUSED_LAUNCH_BUNDLES: readonly string[] = [TEMPCODE_BUNDLE_ID, ...REFUSED_ACT_BUNDLES]

/** The same on a Windows host, by exe (§29.2). */
export const REFUSED_LAUNCH_EXES: readonly string[] = [TEMPCODE_WINDOWS_EXE, ...WINDOWS_PROMPT_EXES]

/**
 * What a thread may not launch in the Windows VM besides (docs/agents/work-outbox.md "The Windows VM"): every
 * console, shell and script host, and the tools that run or install what they are given. Threads get no command
 * line there; a console he opened himself is still held on any act (`consoleRead`).
 */
export const VM_REFUSED_LAUNCH_EXES: readonly string[] = [
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'powershell_ise.exe',
  'windowsterminal.exe',
  'wt.exe',
  'openconsole.exe',
  'conhost.exe',
  'wsl.exe',
  'bash.exe',
  'mshta.exe',
  'wscript.exe',
  'cscript.exe',
  'regedit.exe',
  'reg.exe',
  'rundll32.exe',
  'regsvr32.exe',
  'msiexec.exe',
  'schtasks.exe',
  'taskschd.msc',
  'mmc.exe',
  'certutil.exe',
  'bitsadmin.exe'
]

/**
 * The apps a thread may launch in the Windows VM, by the name a person gives them or their file, and no other: a
 * list of what may be launched can be complete, a list of what may not cannot (MSBuild with a project file, ftp's
 * `!`, a help file). A launch is a bare name here, never a path, a link or a file: Windows opens whatever it is
 * handed. What is running already may still be read and acted in; the hold judges each act.
 */
export const VM_LAUNCH_APPS: readonly string[] = [
  'microsoft edge', 'edge', 'msedge.exe',
  'notepad', 'notepad.exe',
  'file explorer', 'explorer', 'explorer.exe',
  'word', 'microsoft word', 'winword.exe',
  'excel', 'microsoft excel', 'excel.exe',
  'powerpoint', 'microsoft powerpoint', 'powerpnt.exe',
  'outlook', 'microsoft outlook', 'outlook.exe',
  'onenote', 'microsoft onenote', 'onenote.exe',
  'teams', 'microsoft teams', 'ms-teams.exe', 'msteams.exe',
  'calculator', 'calculatorapp.exe', 'calc.exe',
  'paint', 'mspaint.exe',
  'photos', 'photos.exe',
  'snipping tool', 'snippingtool.exe',
  'adobe acrobat', 'adobe acrobat reader', 'acrobat reader', 'acrobat.exe', 'acrord32.exe'
]

/** What a launch in the VM may not hold: a path, a drive or a link's colon, a quote, an 8.3 name's tilde, a trailing dot or space. */
const NOT_A_BARE_NAME = /[\\/:"~]|[. ]$/

/** The same apps as a person names them, which the service also matches (§29.2). */
const VM_REFUSED_LAUNCH_NAMES: readonly string[] = ['command prompt', 'powershell', 'windows powershell', 'terminal', 'windows terminal', 'registry editor', 'task scheduler', 'windows script host']

/** What `apps.launch` refuses on this host's service: the Mac's bundle ids, or a Windows PC's exes, and the VM's command lines. */
export const refusedLaunchList = (platform: NodeJS.Platform = process.platform, vm = false): string[] =>
  vm ? [...REFUSED_LAUNCH_EXES, ...VM_REFUSED_LAUNCH_EXES] : platform === 'win32' ? [...REFUSED_LAUNCH_EXES] : [...REFUSED_LAUNCH_BUNDLES]

/**
 * An item the VM would run, however it is written: its `%` escapes decoded, its query cut off, and an item Windows
 * would read as another name refused outright (a trailing dot or space it drops, an 8.3 name's `~`, a stream's `::`).
 */
function vmRunnableItem(item: string): boolean {
  let path = item.split(/[?#]/)[0] ?? item
  try {
    path = decodeURIComponent(path)
  } catch {
    return true
  }
  return /[. ]$/.test(path) || path.includes('~') || path.includes('::') || VM_RUNNABLE.test(path)
}

/** Files Windows runs when they are opened: an item a launch opens in the VM may not be one, whatever app it is handed to. */
const VM_RUNNABLE = /\.(bat|cmd|com|exe|scr|pif|cpl|msc|msi|msp|ps1|psm1|psd1|ps1xml|vb|vbs|vbe|js|jse|wsf|wsh|wsc|sct|hta|chm|lnk|url|scf|settingcontent-ms|reg|inf|application|appref-ms|appx|msix|jar|dll)$/i

export interface PinnedApp {
  pid: number
  bundleId: string | null
  name: string
}

export type LaunchResult = ComputerResult<'apps.launch'>

/** The service's two app methods, as the resolver needs them. */
export interface AppsSource {
  list(): Promise<AppInfo[]>
  /** answers the pid and what the front guard saw, or throws with the service's error data */
  launch(app: string): Promise<LaunchResult>
  sleep(ms: number): Promise<void>
}

/** How long a launched app has to show in apps.list. */
export const LAUNCH_REGISTER_MS = 2000
const REGISTER_POLL_MS = 100

/** The app pinned, and when the resolver launched it and it came forward, the guard's report (§23.5). */
export type Resolved = { app: PinnedApp; front?: FrontReport } | { line: string }

const pinned = (a: AppInfo): PinnedApp => ({ pid: a.pid, bundleId: a.bundleId, name: a.name })
const lower = (s: string): string => s.toLowerCase()

/**
 * Turns a call's `app` into a pid, in the service's own match order: a
 * running app by bundle id, then by name; else `apps.launch`, which matches
 * installed apps and never brings one forward, then the pid it answered in a
 * fresh list; else, when launch found nothing, a unique prefix of a running
 * app's name. The list is cached until `apps/changed`.
 */
export class TargetResolver {
  private cached: AppInfo[] | null = null

  invalidate(): void {
    this.cached = null
  }

  /** The app in front as the cached list last said, other than `besides`; null when nothing is cached. */
  activeName(besides?: number): string | null {
    return this.cached?.find((a) => a.active && a.pid !== besides)?.name ?? null
  }

  async resolve(query: string, src: AppsSource, errorData: (e: unknown) => ComputerError | null): Promise<Resolved> {
    const q = lower(query)
    const running = (this.cached ??= await src.list())
    const exact = running.find((a) => a.bundleId !== null && lower(a.bundleId) === q) ?? running.find((a) => lower(a.name) === q)
    if (exact) return { app: pinned(exact) }

    let launchError: ComputerError | null = null
    try {
      const { pid, front } = await src.launch(query)
      for (let waited = 0; ; waited += REGISTER_POLL_MS) {
        this.cached = await src.list()
        const found = this.cached.find((a) => a.pid === pid)
        if (found) return front?.raised ? { app: pinned(found), front } : { app: pinned(found) }
        if (waited >= LAUNCH_REGISTER_MS) return { line: hostErrorLine('refused_app', 'unchecked') }
        await src.sleep(REGISTER_POLL_MS)
      }
    } catch (e) {
      launchError = errorData(e)
      if (launchError?.kind !== 'app_not_found') throw e
    }

    const prefixed = (this.cached ?? running).filter((a) => lower(a.name).startsWith(q))
    if (prefixed.length === 1) return { app: pinned(prefixed[0]) }
    const candidates = prefixed.length ? prefixed.map((a) => a.name) : (launchError.candidates ?? [])
    return { line: errorLine({ ...launchError, candidates }, { app: query }) }
  }
}

/** Why a call may not touch this app, or null. Reads are refused only for TempCode itself. */
export function refusedTarget(app: { pid: number; bundleId: string | null }, use: 'read' | 'act', ownPid = process.pid): string | null {
  const id = app.bundleId?.toLowerCase() ?? null
  if (app.pid === ownPid || app.bundleId === TEMPCODE_BUNDLE_ID || id === TEMPCODE_WINDOWS_EXE) return hostErrorLine('refused_app', 'tempcode')
  if (use === 'act' && id && (WINDOWS_PROMPT_EXES.includes(id) || REFUSED_ACT_BUNDLES.some((b) => b.toLowerCase() === id))) return hostErrorLine('refused_app', promptsOf(id))
  return null
}

const promptsOf = (id: string): 'prompts' | 'windows-prompts' => (WINDOWS_PROMPT_EXES.includes(id) ? 'windows-prompts' : 'prompts')

/**
 * computer_apps { launch }: a query naming TempCode or a refused prompt is refused before the service hears it; in
 * the Windows VM (`vm`), a command line or a script host too, by its file or the name a person gives it.
 */
export function refusedLaunch(query: string, vm = false): string | null {
  // by the file's own name too, however the app was named: `C:\\Windows\\System32\\consent.exe`, `consent`
  const base = lower(query).split(/[\\/]/).pop() ?? ''
  const exe = base.endsWith('.exe') || base.endsWith('.msc') ? base : `${base}.exe`
  if (vm && (VM_REFUSED_LAUNCH_EXES.includes(exe) || VM_REFUSED_LAUNCH_EXES.includes(base) || VM_REFUSED_LAUNCH_NAMES.includes(lower(query).trim()))) return hostErrorLine('refused_app', 'console')
  if (vm && (NOT_A_BARE_NAME.test(query) || !VM_LAUNCH_APPS.includes(lower(query)))) return hostErrorLine('refused_app', 'vm-apps')
  if (exe !== lower(query) && (exe === TEMPCODE_WINDOWS_EXE || WINDOWS_PROMPT_EXES.includes(exe))) return refusedLaunch(exe)
  const q = lower(query)
  if (q === TEMPCODE_BUNDLE_ID || q === 'tempcode' || q === TEMPCODE_WINDOWS_EXE) return hostErrorLine('refused_app', 'tempcode')
  if (WINDOWS_PROMPT_EXES.includes(q) || REFUSED_ACT_BUNDLES.some((b) => lower(b) === q)) return hostErrorLine('refused_app', promptsOf(q))
  return null
}

/** `C:\\…` or `C:/…`: an absolute path on a Windows host. */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/

/** Only these open, never the system's default handler for anything else (§23.2). */
const OPEN_SCHEMES = /^(https?|file):/i

/**
 * computer_apps { open }: an item that is not a web page, a file URL or an absolute path is refused before the card;
 * in the Windows VM (`vm`), a file Windows would run too, a web page's or a path's (an `open` item is the launched
 * app's argument there, §29.2).
 */
export function refusedOpenItem(item: string, vm = false): string | null {
  if (vm && vmRunnableItem(item)) return errorLine({ kind: 'open_refused', message: '', reason: 'executable' }, { open: [item] })
  if (OPEN_SCHEMES.test(item) || item.startsWith('/') || WINDOWS_ABSOLUTE.test(item)) return null
  return errorLine({ kind: 'open_refused', message: '', reason: 'scheme' }, { open: [item] })
}

const TEXT_STEPS: readonly ComputerAction['action'][] = ['type', 'paste']

/** A key with no super or ctrl writes into the field it reaches; a combo that does not parse counts as one. */
function keyWrites(text: string | undefined): boolean {
  try {
    const { modifiers } = parseKeyCombo(text ?? '')
    return !modifiers.includes('super') && !modifiers.includes('ctrl')
  } catch {
    return true
  }
}

/** The steps that put text into a field: type, paste, set_value, and a key or hold_key that writes (keyWrites). */
const writes = (a: ComputerAction): boolean =>
  TEXT_STEPS.includes(a.action) || a.action === 'set_value' || ((a.action === 'key' || a.action === 'hold_key') && keyWrites(a.text))

const isPasswordLine = (book: ElementBook, index: number): boolean => {
  const brief = book.brief(index)
  return !!brief && (brief.line === 'password' || brief.line.startsWith('password '))
}

/**
 * The host's own card: a step that writes (a type, paste or set_value, a key
 * or hold_key with no super or ctrl) whose destination is a password field
 * asks in every mode. The destination is the step's element, else the latest
 * read's focused element; with neither, a window that shows a password field
 * asks too. The service judges two destinations the host cannot see, and
 * refuses a password field at either (§27.7a): a `named` target, and blind
 * text after another step of the call sent input, which goes to the live
 * focus (§27.7). Its `what` is empty: the card's steps say where, and never
 * what is typed.
 */
export function passwordTarget(actions: readonly ComputerAction[], book: ElementBook | undefined): ConfirmNeed | null {
  if (!book) return null
  let inputBefore = false
  for (const a of actions) {
    const blindTextAfterInput = inputBefore && TEXT_STEPS.includes(a.action) && a.element === undefined
    if (!NO_INPUT_ACTIONS.includes(a.action)) inputBefore = true
    if (!writes(a) || a.named !== undefined || blindTextAfterInput) continue
    const at = a.element ?? book.focused
    if (at !== null && at !== undefined ? isPasswordLine(book, at) : book.hasRole('password')) return { kind: 'password', what: '' }
  }
  return null
}

/**
 * In the Windows VM the Windows key is his: Win+R opens the Run box, Win+X a menu with the Terminal, and Start's
 * search runs what is typed. A key or a held key with it, or Ctrl+Esc, is refused before the card.
 */
export function refusedVmKey(steps: readonly ComputerAction[]): string | null {
  for (const a of steps) {
    if (a.action !== 'key' && a.action !== 'hold_key') continue
    let modifiers: string[] = []
    try {
      const combo = parseKeyCombo(a.text ?? '')
      modifiers = [...combo.modifiers, combo.key?.toLowerCase() ?? '']
    } catch {
      modifiers = (a.text ?? '').toLowerCase().split('+')
    }
    if (modifiers.some((m) => ['super', 'win', 'windows', 'meta', 'cmd', 'command'].includes(m))) return hostErrorLine('refused_app', 'vm-win-key')
    // Ctrl+Esc opens Start as the Windows key does
    if (modifiers.includes('ctrl') && ['escape', 'esc'].includes(modifiers.at(-1) ?? '')) return hostErrorLine('refused_app', 'vm-win-key')
  }
  return null
}
