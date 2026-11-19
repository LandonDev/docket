import type { OfficeStatus } from '@shared/contract-work-office'
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
import { comCarrier } from './com/carrier'
import { macCarrier } from './mac'
import { owaCarrier } from './owa'
import { ensureRouteTables, OutlookRoute } from './route'
import { officeTool, runHere, type Env } from './tools'

/**
 * The office pillar's server module (docs/agents/work-office.md): one Office
 * tool set for agents, carried out by the Office apps on the host that has
 * them (the Mac by osascript, Windows by COM); Excel as the truth behind a workbook's grid;
 * LifeOS's Outlook-account mail and calendar acts carried by this host's
 * Outlook after his press. Sends are held acts (held.ts).
 */

const desktopCarrier = (): OfficeCarrier | null =>
  process.platform === 'darwin' ? macCarrier() : process.platform === 'win32' ? comCarrier() : process.platform === 'linux' ? owaCarrier() : null
let carrierFor: () => OfficeCarrier | null = () => withAddin(desktopCarrier(), addinHub)
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

export const office: WorkModule = {
  id: 'office',
  ensure(db) {
    ensureSuggestionTables(db)
    ensureExcelTables(db)
    ensureRouteTables(db)
    ensureAddinTables(db)
  },
  async handle(req, ctx, by) {
    if (!req.method.startsWith('work.office.')) return NOT_HANDLED
    if (req.method.startsWith('work.office.addin.')) return addinHandle(req, ctx, by)
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
        if (by.kind === 'remote' && key !== null && !/^https?:\/\//i.test(key) && !ctx.reaches(by, key)) throw new FenceError(req.method)
        const write = req.method === 'work.office.write' ? req.params : null
        const env: Env = { ctx, ...here, by: peerPrincipal(write?.by, by, ctx.host), sessionId: by.kind === 'model' ? (by.sessionId ?? null) : null, asked: write?.asked ?? false }
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
    }
    return NOT_HANDLED
  },
  tools: () => addinTools(hereOf),
  acts: officeActs({ carrier: () => (started ? (hereOf(started)?.carrier ?? null) : null) }),
  triggers: [excelChanges(() => started)],
  preamble: () =>
    'Office files open on the Mac or a Windows PC are reached with the `office_*` tools (`office_files` lists them). A workbook range is read with `office_range_read` and written with `office_range_write`, passing the hash you read as `base`. Mail sends, replies, forwards, invitations and answers to invitations are held for the owner\'s press; say so plainly when you make one.',
  start(ctx) {
    started = ctx
    const here = hereOf(ctx)
    let stopRoute: (() => void) | null = null
    let timer: ReturnType<typeof setInterval> | null = null
    // The route runs while LifeOS is connected and Outlook is here; it says nothing new until either changes.
    let said = ''
    const heard = (book: string, sheet: string, address: string) => void hereOf(ctx)?.excel.heard(book, sheet, address)
    const stopAddin = startAddin(ctx, heard)
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
      stopChanges?.()
      if (timer) clearInterval(timer)
      stopRoute?.()
      here?.excel.stop()
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
