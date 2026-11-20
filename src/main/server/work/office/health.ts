import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { OFFICE_APPS, type OfficeApp, type OfficeAppState, type TeamsLibrary } from '@shared/contract-work-office'
import type { HealthFix, HealthRow } from '@shared/work'
import type { WorkCtx } from '../modules'
import { isIsolatedInstance } from '../service/config'
import { AddinKeys } from './addin/keys'
import { librariesOf, libraryId, rootsOf } from './files/library'
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
}

const NAME: Record<OfficeApp, string> = { excel: 'Excel', word: 'Word', powerpoint: 'PowerPoint', outlook: 'Outlook' }
const PAIR: HealthFix = { kind: 'page', label: 'Pair…', page: 'settings:work' }
const EDIT_LIST: HealthFix = { kind: 'page', label: 'Edit', page: 'settings:work' }

/** Our add-in's manifest id (addins/office/manifest.xml): a sideloaded copy carries it. */
export const ADDIN_ID = '4d4a9aee-3258-405a-bd8a-a18fc1d298b4'

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
  if (a.allowed === 'no') return { ...base, state: 'broken', line: `Allow TempCode to control ${name} in System Settings → Privacy & Security → Automation.` }
  if (a.allowed === 'ask') return { ...base, state: 'needs-you', line: `Answer the Mac's prompt to let TempCode control ${name}.` }
  if (outlook?.route?.error) return { ...base, state: 'broken', line: outlook.route.error }
  const as = outlook?.route?.accounts.length ? `signed in as ${listOf(outlook.route.accounts)}` : null
  return { ...base, state: 'working', line: [a.running ? 'Open' : 'Closed', as].filter(Boolean).join(', ') }
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
    state: 'broken',
    line: 'This folder is gone. Sync it again in Teams, or take it off the list.',
    fix: EDIT_LIST
  }))
  if (!libs.length) return rows
  const od = await p.oneDrive(signal)
  const base = { id: 'office.files.onedrive', pillar: 'office' as const, group: 'Files', title: 'OneDrive' }
  const count = `${libs.length} ${libs.length === 1 ? 'library' : 'libraries'}`
  const sync = libs.length === 1 ? 'does not sync' : 'do not sync'
  const tenants = [...new Set(libs.map((l) => l.tenant).filter((t): t is string => !!t))]
  if (!od.installed) return [{ ...base, state: 'broken', line: `OneDrive is not installed, so the ${count} here ${sync}.` }, ...rows]
  if (!od.running) return [{ ...base, state: 'broken', line: `Closed, so the ${count} here ${sync}. Open OneDrive.` }, ...rows]
  return [{ ...base, state: 'working', line: `Syncing ${count}${tenants.length ? ` for ${listOf(tenants)}` : ''}` }, ...rows]
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
  return rows
}

// ── reading this host ────────────────────────────────────────────────

/** The apps a sideloaded manifest of ours sits in on this Mac (work-office.md "Sideloading": each app's `wef` folder). */
export function sideloadedOn(home: string): OfficeApp[] {
  const BUNDLE = { excel: 'com.microsoft.Excel', word: 'com.microsoft.Word', powerpoint: 'com.microsoft.Powerpoint' } as const
  return (Object.keys(BUNDLE) as (keyof typeof BUNDLE)[]).filter((app) => {
    const wef = join(home, 'Library', 'Containers', BUNDLE[app], 'Data', 'Documents', 'wef')
    try {
      return readdirSync(wef).some((f) => f.toLowerCase().endsWith('.xml') && readFileSync(join(wef, f), 'utf8').includes(ADDIN_ID))
    } catch {
      return false
    }
  })
}

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
  const home = homedir()
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
      sideloaded: platform === 'darwin' ? sideloadedOn(home) : []
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
    gone: () => rootsOf(ctx.db).filter((r) => !r.off && !existsSync(r.folder)).map((r) => r.folder)
  }
}
