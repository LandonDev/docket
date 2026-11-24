import type { OfficeStatus } from '@shared/contract-work-office'
import { pressesFor } from '../files/policy'
import { agentPrincipal, handled, NOT_HANDLED, type Principal, type TriggerSource } from '@shared/work'
import { errorText } from '@shared/work/ids'
import { FenceError } from '../../remote/fence'
import type { Caller, WorkCtx, WorkModule } from '../modules'
import { ensureSuggestionTables, SuggestionStore } from '../sheets/suggestions'
import type { OfficeCarrier } from './carrier'
import { ensureExcelTables, ExcelHelper } from './excel'
import { unfollowAll } from './grid'
import { officeActs } from './held'
import { addinHandle, addinHub, addinTools, ensureAddinTables, startAddin } from './addin'
import { withAddin } from './addin/carrier'
import { comCarrier, type ComCarrier } from './com/carrier'
import { macCarrier } from './mac'
import { owaCarrier } from './owa'
import { ensureRouteTables, OutlookRoute } from './route'
import { officeTool, runHere, type Env } from './tools'
import { dropCopies, dropItemCopies, filesHandle, type FilesDeps } from './files/handle'
import { isGuestPath, missingLibraries, readVmBehind, storedStatus } from './vm/files'
import { stopVmOffice, vmAllowed, vmAwake, vmHasOffice, vmHereOf, vmState } from './vm/office'
import { onWinvmState, winvmKeeper } from '../winvm'
import { ensureFilesTables, librariesOf, libraryOf, setCopyAllowed } from './files/library'
import { teamsTools } from './files/tools'
import { officeProbe, officeRows } from './health'
import { officeConverters, type RenderDeps, type RenderPlace } from './render'
import { canPresent, presentDeck, type PresentDeps } from './present'

/**
 * The office pillar's server module (docs/agents/work-office.md): one Office
 * tool set for agents, carried out by the Office apps on the host that has
 * them (the Mac by osascript, Windows by COM); Excel as the truth behind a workbook's grid;
 * LifeOS's Outlook-account mail and calendar acts carried by this host's
 * Outlook after his press. Sends are held acts (held.ts).
 */

const desktopCarrier = (): OfficeCarrier | null =>
  process.platform === 'darwin' ? macCarrier() : process.platform === 'win32' ? comCarrier() : process.platform === 'linux' ? owaCarrier() : null
/** One desktop carrier for the process: the tools reach it through the add-in's wrapper, a render directly (one helper on a PC, not two). */
let desktop: OfficeCarrier | null | undefined
const desktopOnce = (): OfficeCarrier | null => (desktop === undefined ? (desktop = desktopCarrier()) : desktop)
let carrierFor: () => OfficeCarrier | null = () => withAddin(desktopOnce(), addinHub)
/** tc-office on a PC, for what is not Office (the Recycle Bin of a library's delete, files/trash.ts); null on any other host. */
export const desktopHelper = (): Pick<ComCarrier, 'call'> | null => (process.platform === 'win32' ? (desktopOnce() as ComCarrier | null) : null)
/** A test hands its own carrier (a `FakeOffice`); null: this host has none. */
export const setCarrier = (fn: () => OfficeCarrier | null): void => {
  carrierFor = fn
  made = new WeakMap()
}

interface Here {
  carrier: OfficeCarrier
  excel: ExcelHelper
  suggestions: SuggestionStore
  route: OutlookRoute
}
let made = new WeakMap<WorkCtx['db'], Here | null>()

/** This host's carrier and what rides on it, made once per database; null where no Office runs. */
export function hereOf(ctx: WorkCtx): Here | null {
  if (made.has(ctx.db)) return made.get(ctx.db)!
  const carrier = carrierFor()
  const suggestions = new SuggestionStore(ctx.db)
  const here = carrier && {
    carrier,
    suggestions,
    excel: new ExcelHelper(carrier, ctx.db, suggestions),
    route: new OutlookRoute({ db: ctx.db, lifeos: () => ctx.lifeos.owner(), carrier, host: ctx.host, log: ctx.log })
  }
  made.set(ctx.db, here)
  return here
}

const NO_OFFICE = 'Office is not on this host.'

/** A file in Excel changed by someone else: a routine's `file` trigger on a workbook (architecture §11.1). */
const excelChanges = (ctx: () => WorkCtx | null): TriggerSource => ({
  on: 'file',
  at: 'microsoft',
  words: (t) => (t.on === 'file' && t.source.at === 'microsoft' ? `When someone changes ${t.source.name}` : 'When the file changes'),
  arm(t, fire) {
    const c = ctx()
    const here = c && hereOf(c)
    if (t.on !== 'file' || t.source.at !== 'microsoft' || t.source.app !== 'excel' || !here || t.source.host !== c.host) return () => {}
    const book = t.source.ref.kind === 'path' ? t.source.ref.path : t.source.ref.url
    const name = t.source.name
    return here.excel.source(book, 'owner').subscribe((change) => {
      if (change.kind === 'cells' && change.by === 'excel') fire(`${name} changed in Excel${change.shifted ? ' (rows moved)' : ''}`)
    })
  }
})

let started: WorkCtx | null = null

/**
 * Office as a renderer here (render.ts): his Mac's apps, a Windows PC's, or the box's Windows VM. Read at each job:
 * nothing renders while Work is off, and the VM's state is the keeper's of the moment.
 */
const renderDeps: RenderDeps = {
  place: (): RenderPlace | null => (!started ? null : process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : process.platform === 'linux' && vmState() ? 'vm' : null),
  carrier: (place) => (!started ? null : place === 'vm' ? vmHereOf(started).carrier : desktopOnce()),
  vm: {
    state: vmState,
    office: () => (started ? (storedStatus(started.db)?.status.office ?? null) : null),
    wake: vmAwake,
    touch: () => winvmKeeper()?.touch()
  },
  log: (line) => started?.log(line)
}

/** Presenting in PowerPoint (present.ts): this host's own PowerPoint, or the Windows VM's for a file in its OneDrive. */
const presentDeps = (ctx: WorkCtx): PresentDeps => ({
  place: (path) => (path !== null && isGuestPath(path) && process.platform !== 'win32' ? (vmState() ? 'vm' : null) : process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : null),
  // the desktop carrier itself, as a render takes it: the add-in carries no slideshow
  carrier: (place) => (place === 'vm' ? vmHereOf(ctx).carrier : desktopOnce()),
  vmOffice: () => vmHasOffice(ctx),
  wake: vmAwake
})

/** What the Teams files need of the pillar: this host's carrier, Office in the Windows VM for a file there, and his address as Outlook here knows it. */
const filesDeps = (ctx: WorkCtx): FilesDeps => ({
  carrier: () => hereOf(ctx)?.carrier ?? null,
  vmOpenOffice: (app, path) => vmHereOf(ctx).carrier.open(app, { kind: 'path', path }),
  ownAccount: () => made.get(ctx.db)?.route.state.accounts[0] ?? null
})

/** How often an awake VM that still needs him (signed out, or a wanted library not there yet) is read again: his approval then shows, and its libraries are asked for, with no screen open. */
const VM_WATCH_MS = 60_000

/**
 * Keeps what is known of OneDrive and Office in the Windows VM current while the machine is awake: read at
 * each wake, then every minute while something is still missing, else every ten. Never wakes it.
 */
function watchVm(ctx: WorkCtx): () => void {
  let last = 0
  const read = (): void => {
    if (vmState()?.state !== 'awake') return
    const stored = storedStatus(ctx.db)
    const wanting = !stored || !stored.status.onedrive.account || missingLibraries(ctx.db, stored).length > 0 || !stored.status.office.installed || stored.status.office.licensed !== true
    if (Date.now() - last < (wanting ? VM_WATCH_MS : 10 * VM_WATCH_MS) - 1000) return
    last = Date.now()
    // A read that changes what was kept is pushed: his approval shows in an open Files view with no press.
    void readVmBehind(ctx, { wake: false })
  }
  const off = onWinvmState((state) => {
    if (state?.state !== 'awake') return
    last = 0
    // its helper's door is made ready by the first call: give the desktop a moment after a resume
    setTimeout(read, 5000).unref?.()
  })
  const timer = setInterval(read, VM_WATCH_MS)
  timer.unref?.()
  return () => {
    off()
    clearInterval(timer)
  }
}

export const office: WorkModule = {
  id: 'office',
  ensure(db) {
    ensureSuggestionTables(db)
    ensureExcelTables(db)
    ensureRouteTables(db)
    ensureAddinTables(db)
    ensureFilesTables(db)
  },
  async handle(req, ctx, by, signal) {
    if (!req.method.startsWith('work.office.')) return NOT_HANDLED
    if (req.method.startsWith('work.office.addin.')) return addinHandle(req, ctx, by)
    if (req.method.startsWith('work.office.files') || req.method.startsWith('work.office.vm')) return filesHandle(req, ctx, by, filesDeps(ctx), signal)
    const here = hereOf(ctx)
    switch (req.method) {
      case 'work.office.status': {
        const status: OfficeStatus = { carrier: here?.carrier.kind ?? null, apps: here ? await here.carrier.apps() : [], route: here ? { ...here.route.state } : { accounts: [], beatAt: null, error: null } }
        return handled(status)
      }
      case 'work.office.read':
      case 'work.office.write': {
        if (!here) throw new Error(NO_OFFICE)
        const t = officeTool(req.params.tool)
        if (req.method === 'work.office.read' && !t.readOnly) throw new Error(`${t.name} changes things: it goes through work.office.write.`)
        // A remote caller reaches a file by path only where it could name the file itself (the listener's fence).
        const key = fileKeyOf(req.params.args)
        // Another host of his reaches a file in this host's Teams libraries too (the Teams files' own fence).
        if (by.kind === 'remote' && key !== null && !/^https?:\/\//i.test(key) && !ctx.reaches(by, key) && !(by.peer && libraryOf(librariesOf(ctx.db, ctx.host), key))) throw new FenceError(req.method)
        const write = req.method === 'work.office.write' ? req.params : null
        // "He asked for this" from a key stands for his press only where the key may approve (files/policy.ts
        // `pressesFor`); from an operate key a change to a file others open is held here, as a thread's would be.
        // Another host of his sends what its own thread's words said (office/tools.ts), judged there.
        const asked = (write?.asked ?? false) && (by.kind !== 'remote' || !!by.peer || pressesFor(by))
        const env: Env = { ctx, ...here, by: peerPrincipal(write?.by, by, ctx.host), sessionId: by.kind === 'model' ? (by.sessionId ?? null) : null, asked }
        return handled(await runHere(t, req.params.args, env))
      }
      case 'work.office.switch': {
        const s = req.params.source
        if (s.at !== 'microsoft') throw new Error('Only a Microsoft file opens in its Office app.')
        if (s.host !== ctx.host) throw new Error('That file opens on the host it lives on.')
        if (s.ref.kind === 'path' && !ctx.reaches(by, s.ref.path)) throw new FenceError(req.method)
        if (!here) throw new Error(NO_OFFICE)
        await here.carrier.open(s.app, s.ref)
        return handled({ opened: true as const })
      }
      case 'work.office.present': {
        const { source, check } = req.params
        if (check) return handled({ can: await canPresent(ctx, by, source, presentDeps(ctx)) })
        await presentDeck(ctx, by, source, presentDeps(ctx))
        return handled({ presented: true as const })
      }
    }
    return NOT_HANDLED
  },
  // Connections: read as it lies; the route's state only if the running module already made it.
  health: {
    check: (ctx, signal) => officeRows(officeProbe(ctx, () => made.get(ctx.db)?.route.state ?? null), signal)
  },
  // A new Work workspace may copy Teams files from his desktops from the start; he can turn it off.
  workspaceCreated(id, ctx) {
    setCopyAllowed(ctx.db, id, true)
  },
  // A deleted thread's copies of Teams files go with it.
  sessionsRemoved(ids, ctx) {
    dropCopies(ctx, { sessions: ids })
  },
  // A closed Files tab's copy goes with it.
  itemsRemoved(items, ctx) {
    dropItemCopies(ctx, items)
  },
  // A removed workspace's copies go: its threads' and its Files pane's.
  workspaceRemoved(id, ctx) {
    dropCopies(ctx, { workspaceId: id })
  },
  tools: () => [
    ...addinTools(hereOf, { offered: (ctx) => vmAllowed(ctx, ctx.scope) && vmHasOffice(ctx), awake: vmAwake, here: vmHereOf }),
    // read at each call: the tools are listed before, and after, the module's start
    ...teamsTools({
      carrier: () => (started ? (hereOf(started)?.carrier ?? null) : null),
      vmOpenOffice: (app, path) => (started ? filesDeps(started).vmOpenOffice!(app, path) : Promise.reject(new Error(NO_OFFICE)))
    })
  ],
  acts: officeActs({
    carrier: () => (started ? (hereOf(started)?.carrier ?? null) : null),
    // his press on a change held in the VM's Office goes back there, woken first
    vm: async (ctx) => (await vmAwake(), vmHereOf(ctx).carrier)
  }),
  // Office as a renderer: docx → pdf+word and the rest, each offered by a carrier only once proven there (render.ts).
  convert: officeConverters(renderDeps),
  triggers: [excelChanges(() => started)],
  preamble: () =>
    'Office files open on the Mac, a Windows PC or this host\'s Windows VM are reached with the `office_*` tools (`office_files` lists them, each with the computer it is on). A workbook range is read with `office_range_read` and written with `office_range_write`, passing the hash you read as `base`. Mail sends, replies, forwards, invitations and answers to invitations are held for the owner\'s press; say so plainly when you make one. ' +
    'Teams and SharePoint files synced on his Mac or in the Windows VM are reached with the `teams_*` tools (`teams_libraries` first); `teams_open` shows one to him and answers the key the office tools change it by.',
  start(ctx) {
    started = ctx
    const here = hereOf(ctx)
    let stopRoute: (() => void) | null = null
    let timer: ReturnType<typeof setInterval> | null = null
    // The route runs while LifeOS is connected and Outlook is here; it says nothing new until either changes.
    let said = ''
    // A change with no sheet is a co-author's merge somewhere in the book: read every watched block again now.
    const heard = (book: string, sheet: string, address: string) => void (sheet ? hereOf(ctx)?.excel.heard(book, sheet, address) : hereOf(ctx)?.excel.pass())
    const stopAddin = startAddin(ctx, heard)
    const stopVmWatch = watchVm(ctx)
    // Windows' Excel tells of each change itself; elsewhere the safety pass and the add-in find them.
    const stopChanges = here?.carrier.changes?.(heard)
    const check = () => {
      void (async () => {
        const outlook = here && (await here.carrier.apps().catch(() => [])).find((a) => a.app === 'outlook')
        const on = !!(outlook?.installed && ctx.lifeos.connected())
        if (on && !stopRoute) stopRoute = here!.route.start()
        if (!on && stopRoute) {
          stopRoute()
          stopRoute = null
        }
        const now = here?.route.state.error ?? ''
        if (now && now !== said) ctx.log(`office route: ${now}`)
        said = now
      })().catch((err) => ctx.log(`office: ${errorText(err)}`))
    }
    if (here) {
      check()
      timer = setInterval(check, 5 * 60_000)
      timer.unref?.()
    }
    return () => {
      stopAddin()
      stopVmWatch()
      stopVmOffice(ctx)
      stopChanges?.()
      if (timer) clearInterval(timer)
      stopRoute?.()
      here?.excel.stop()
      here?.carrier.stop?.()
      unfollowAll()
      started = null
    }
  },
}

/** The file a tool's arguments name, if any. */
const fileKeyOf = (args: unknown): string | null => {
  const a = (args ?? {}) as Record<string, unknown>
  const key = a.workbook ?? a.document ?? a.deck
  return typeof key === 'string' ? key : null
}

/** Who writes, for a call from another host: the thread it named, else that host. */
const peerPrincipal = (named: string | undefined, by: Caller, host: string): Principal =>
  named ? (named as Principal) : by.kind === 'model' && by.sessionId ? agentPrincipal(host, by.sessionId) : by.kind === 'local' ? 'owner' : 'external:another host'
