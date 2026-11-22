import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { OFFICE_APPS, type OfficeApp, type OfficeAppState, type TeamsLibrary, type VmOfficeStatus } from '@shared/contract-work-office'
import type { HealthFix, HealthRow } from '@shared/work'
import type { WorkCtx } from '../modules'
import { isIsolatedInstance } from '../service/config'
import { AddinKeys } from './addin/keys'
import { librariesOf, libraryId, rootsOf } from './files/library'
import { missingLibraries, vmLibraries, vmOfficeStatus } from './vm/files'
import { vmState } from './vm/office'
import { macCarrier } from './mac'

/**
 * The office pillar's rows for Connections (docs/agents/work-connections.md):
 * each Office app on a Mac or Windows host, our add-in, and
 * the OneDrive folders Teams files reads. Everything is read as it lies:
 * a bundle or an .exe on disk, `pgrep` or one `tasklist`, the Outlook
 * setting in its defaults, the route's last word, this host's tables. No
 * app is started, asked over Apple Events or COM, or changed.
 */

/** What a check reads, each part without starting or changing anything; a test hands its own. */
export interface OfficeProbe {
  platform: NodeJS.Platform
  host: string
  /** each Office app on this host: on disk, running, whether TempCode may drive it (what the last call found) */
  apps(signal: AbortSignal): Promise<OfficeAppState[]>
  /** why Outlook here cannot carry mail (New Outlook), or null */
  outlookProblem(signal: AbortSignal): Promise<string | null>
  /** the Outlook addresses the route last reported and its last error; null while it never ran */
  route(): { accounts: string[]; error: string | null } | null
  addin(): { paired: number; holds: boolean; sideloaded: OfficeApp[] }
  oneDrive(signal: AbortSignal): Promise<{ installed: boolean; running: boolean }>
  libraries(): TeamsLibrary[]
  /** folders he added to Teams files that are no longer on disk */
  gone(): string[]
  /**
   * OneDrive and Office in the Windows VM this host keeps, as last read while it was awake, with how many
   * Teams libraries it syncs and how many it was asked for and does not hold yet; null where this host
   * keeps no VM, it is not set up, or it has never been read. Never wakes it.
   */
  vm?(): (VmOfficeStatus & { libraries: number; coming: number }) | null
}

const NAME: Record<OfficeApp, string> = { excel: 'Excel', word: 'Word', powerpoint: 'PowerPoint', outlook: 'Outlook' }
const PAIR: HealthFix = { kind: 'page', label: 'Pair…', page: 'settings:work' }
const EDIT_LIST: HealthFix = { kind: 'page', label: 'Edit', page: 'settings:work' }
/** His sign-in in the Windows VM: the page walks OneDrive's sign-in to his phone's number and opens the Computers page on the VM. */
const VM_SIGN_IN: HealthFix = { kind: 'page', label: 'Sign in…', page: 'windows-vm-sign-in' }


const listOf = (names: readonly string[]): string => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

const NEW_OUTLOOK_LINE: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "New Outlook cannot be scripted, so Work cannot send mail with it. Turn off New Outlook in Outlook's menu.",
  win32: 'New Outlook cannot be scripted, so Work cannot send mail with it. Turn off the New Outlook switch in Outlook.'
}

function appRow(a: OfficeAppState, platform: NodeJS.Platform, outlook: { problem: string | null; route: { accounts: string[]; error: string | null } | null } | null): HealthRow {
  const name = NAME[a.app]
  const base = { id: `office.app:${a.app}`, pillar: 'office' as const, group: 'Office', title: name }
  if (outlook?.problem) return { ...base, state: 'needs-you', line: NEW_OUTLOOK_LINE[platform] ?? outlook.problem }
  if (a.waiting) return { ...base, state: 'needs-you', line: `On the Mac, press Allow where macOS asks whether ${name} may access files managed by OneDrive.` }
  if (a.allowed === 'no') return { ...base, state: 'broken', line: `Allow TempCode to control ${name} in System Settings → Privacy & Security → Automation.` }
  if (a.allowed === 'ask') return { ...base, state: 'needs-you', line: `Answer the Mac's prompt to let TempCode control ${name}.` }
  if (outlook?.route?.error) return { ...base, state: 'broken', line: outlook.route.error }
  const as = outlook?.route?.accounts.length ? `signed in as ${listOf(outlook.route.accounts)}` : null
  return { ...base, state: 'working', line: [a.running ? 'Open' : 'Closed', as].filter(Boolean).join(', '), ...(as ? { personal: true as const } : {}) }
}

/** One row for our add-in, on the host that holds the add-ins (the tunnel's) or a Mac it is sideloaded on; left out elsewhere. Each add-in's own state stays in Settings. */
function addinRow(a: ReturnType<OfficeProbe['addin']>): HealthRow | null {
  if (!a.holds && !a.paired && !a.sideloaded.length) return null
  const base = { id: 'office.addin', pillar: 'office' as const, group: 'Office', title: 'Office add-in' }
  const side = a.sideloaded.length ? `sideloaded in ${listOf(a.sideloaded.map((x) => NAME[x]))}` : null
  if (a.paired) return { ...base, state: 'working', line: ['Paired', side].filter(Boolean).join(', ') }
  if (!a.holds) return { ...base, state: 'working', line: cap(side!) }
  return { ...base, state: 'needs-you', line: side ? `${cap(side)}, not paired` : 'Not paired', fix: PAIR }
}

/** OneDrive, which keeps the Teams folders in step, and each folder he added that is gone. Left out where nothing is synced. */
async function filesRows(p: OfficeProbe, signal: AbortSignal): Promise<HealthRow[]> {
  const libs = p.libraries()
  const rows: HealthRow[] = p.gone().map((folder) => ({
    id: `office.files.folder:${libraryId(p.host, folder)}`,
    pillar: 'office',
    group: 'Files',
    title: basename(folder) || folder,
    personal: true,
    state: 'broken',
    line: 'This folder is gone. Sync it again in Teams, or take it off the list.',
    fix: EDIT_LIST
  }))
  if (!libs.length) return rows
  const od = await p.oneDrive(signal)
  const base = { id: 'office.files.onedrive', pillar: 'office' as const, group: 'Files', title: 'OneDrive', personal: true as const }
  const count = `${libs.length} ${libs.length === 1 ? 'library' : 'libraries'}`
  const sync = libs.length === 1 ? 'does not sync' : 'do not sync'
  const tenants = [...new Set(libs.map((l) => l.tenant).filter((t): t is string => !!t))]
  if (!od.installed) return [{ ...base, state: 'broken', line: `OneDrive is not installed, so the ${count} here ${sync}.` }, ...rows]
  if (!od.running) return [{ ...base, state: 'broken', line: `Closed, so the ${count} here ${sync}. Open OneDrive.` }, ...rows]
  return [{ ...base, state: 'working', line: `Syncing ${count}${tenants.length ? ` for ${listOf(tenants)}` : ''}` }, ...rows]
}

/** OneDrive and Office in the Windows VM: one row each, with the one press that is his where a sign-in is missing. Left out until the VM has been read. */
export function vmRows(vm: ReturnType<NonNullable<OfficeProbe['vm']>>): HealthRow[] {
  if (!vm || vm.at === null) return []
  const rows: HealthRow[] = []
  const od = { id: 'office.vm.onedrive', pillar: 'office' as const, group: 'Files', title: 'OneDrive on the Windows VM', personal: true as const }
  const libs = `${vm.libraries} Teams ${vm.libraries === 1 ? 'library' : 'libraries'}`
  if (vm.onedrive.state === 'ok') rows.push({ ...od, state: 'working', line: `Signed in as ${vm.onedrive.account}, ${libs}` })
  else if (vm.onedrive.state === 'no-libraries') rows.push({ ...od, state: 'working', line: vm.coming ? `Signed in as ${vm.onedrive.account}, its libraries are on their way` : `Signed in as ${vm.onedrive.account}, no Teams library synced` })
  else if (vm.onedrive.state === 'signed-out') rows.push({ ...od, state: 'needs-you', line: 'Signed out', fix: VM_SIGN_IN })
  else if (vm.onedrive.state === 'no-onedrive') rows.push({ ...od, state: 'broken', line: 'OneDrive is not installed in the Windows VM.' })
  if (vm.office?.installed) {
    const base = { id: 'office.vm.office', pillar: 'office' as const, group: 'Office', title: 'Office on the Windows VM' }
    const apps = listOf(vm.office.apps.filter((a) => a !== 'outlook').map((a) => NAME[a]))
    if (vm.office.licensed === true) rows.push({ ...base, state: 'working', line: `${apps}${vm.office.account ? `, signed in as ${vm.office.account}` : ''}`, ...(vm.office.account ? { personal: true as const } : {}) })
    else rows.push({ ...base, state: 'needs-you', line: `${apps} are installed. Sign in to finish.`, fix: VM_SIGN_IN })
  }
  return rows
}

export async function officeRows(p: OfficeProbe, signal: AbortSignal): Promise<HealthRow[]> {
  const desktop = p.platform === 'darwin' || p.platform === 'win32'
  const rows: HealthRow[] = []
  if (desktop) {
    const [apps, problem] = await Promise.all([p.apps(signal), p.outlookProblem(signal)])
    const route = p.route()
    for (const a of apps) if (a.installed) rows.push(appRow(a, p.platform, a.app === 'outlook' ? { problem, route } : null))
  }
  const addin = addinRow(p.addin())
  if (addin) rows.push(addin)
  if (desktop) rows.push(...(await filesRows(p, signal)))
  rows.push(...vmRows(p.vm?.() ?? null))
  return rows
}

// ── reading this host ────────────────────────────────────────────────

const WIN_EXE: Record<OfficeApp, string> = { excel: 'excel.exe', word: 'winword.exe', powerpoint: 'powerpnt.exe', outlook: 'outlook.exe' }

/**
 * Windows' Office as it lies: each app's .exe where Click-to-Run or an MSI puts it, running by the
 * process list. New Outlook (`olk.exe`) has no COM: on disk or running with classic Outlook closed,
 * it counts as Outlook here, with the problem said. COM asks no consent, so `allowed` stays unknown.
 */
export function windowsOffice(env: NodeJS.ProcessEnv, found: (path: string) => boolean, running: ReadonlySet<string>): { apps: OfficeAppState[]; newOutlook: boolean } {
  const dirs = [env.ProgramFiles, env['ProgramFiles(x86)']].filter((d): d is string => !!d).flatMap((pf) => [join(pf, 'Microsoft Office', 'root', 'Office16'), join(pf, 'Microsoft Office', 'Office16')])
  const has = (exe: string): boolean => dirs.some((d) => found(join(d, exe.toUpperCase())))
  const olk = running.has('olk.exe') || (!!env.LOCALAPPDATA && found(join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'olk.exe')))
  const classic = has(WIN_EXE.outlook)
  const newOutlook = olk && (!classic || (running.has('olk.exe') && !running.has(WIN_EXE.outlook)))
  const apps = OFFICE_APPS.map((app): OfficeAppState => {
    const installed = has(WIN_EXE[app]) || (app === 'outlook' && newOutlook)
    return { app, installed, running: installed && running.has(WIN_EXE[app]), allowed: 'unknown' }
  })
  return { apps, newOutlook }
}

/** `tasklist`'s image names, lower case; empty when it does not answer. */
export const parseTasklist = (out: string): Set<string> => new Set(out.split(/\r?\n/).map((l) => /^"([^"]+)"/.exec(l)?.[1]?.toLowerCase()).filter((n): n is string => !!n))

const tasklist = (signal: AbortSignal): Promise<Set<string>> =>
  new Promise((resolve) => execFile('tasklist', ['/FO', 'CSV', '/NH'], { signal, windowsHide: true, timeout: 8000 }, (err, out) => resolve(err ? new Set() : parseTasklist(String(out)))))
const pgrep = (name: string, signal: AbortSignal): Promise<boolean> => new Promise((resolve) => execFile('/usr/bin/pgrep', ['-x', name], { signal, timeout: 5000 }, (err) => resolve(!err)))

/**
 * This host's probe. `route` is the Outlook route's state as the running module holds it (null
 * while it was never made): Connections never makes one to ask.
 */
export function officeProbe(ctx: WorkCtx, route: () => { accounts: string[]; error: string | null } | null, env: NodeJS.ProcessEnv = process.env): OfficeProbe {
  const platform = process.platform
  let win: Promise<{ apps: OfficeAppState[]; newOutlook: boolean }> | null = null
  let procs: Promise<Set<string>> | null = null
  const tasks = (signal: AbortSignal) => (procs ??= tasklist(signal))
  const windows = (signal: AbortSignal) => (win ??= tasks(signal).then((running) => windowsOffice(env, existsSync, running)))
  // A fresh Mac carrier reads the bundles, pgrep and the shared "allowed" map; it starts nothing.
  const mac = platform === 'darwin' ? macCarrier() : null
  return {
    platform,
    host: ctx.host,
    apps: async (signal) => (mac ? mac.apps() : platform === 'win32' ? (await windows(signal)).apps : []),
    outlookProblem: async (signal) => (mac ? mac.outlookProblem!() : platform === 'win32' && (await windows(signal)).newOutlook ? 'New Outlook' : null),
    route,
    addin: () => ({
      paired: new AddinKeys(ctx.db).list().length,
      holds: platform === 'linux' && !isIsolatedInstance(env),
      // Whether it is sideloaded lives in each Office app's own container, and reading another app's container raises macOS's
      // "access data from other apps" prompt: a check never does that, so it says only paired or not.
      sideloaded: []
    }),
    async oneDrive(signal) {
      if (platform === 'darwin') {
        const installed = existsSync('/Applications/OneDrive.app')
        return { installed, running: installed && (await pgrep('OneDrive', signal)) }
      }
      const exe = [env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Microsoft', 'OneDrive', 'OneDrive.exe'), env.ProgramFiles && join(env.ProgramFiles, 'Microsoft OneDrive', 'OneDrive.exe')]
      const installed = exe.some((p) => !!p && existsSync(p))
      return { installed, running: installed && (await tasks(signal)).has('onedrive.exe') }
    },
    libraries: () => librariesOf(ctx.db, ctx.host),
    gone: () => rootsOf(ctx.db).filter((r) => !r.off && !existsSync(r.folder)).map((r) => r.folder),
    vm: () => {
      const state = vmState()
      if (!state || state.cannot || state.state === 'none' || state.state === 'setting-up') return null
      return { ...vmOfficeStatus(ctx.db, state), libraries: vmLibraries(ctx.db, ctx.host).filter((l) => l.kind !== 'mine').length, coming: missingLibraries(ctx.db).length }
    }
  }
}
