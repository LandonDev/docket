import { WebSocket } from 'ws'
import type { ClientRequest } from '@shared/contract'
import { handled, NOT_HANDLED, workText, type WorkToolResult } from '@shared/work'
import type { Caller, ToolCtx, WorkCtx, WorkTool } from '../../modules'
import { serviceOf } from '../../service/ctx'
import type { OfficeCarrier } from '../carrier'
import { workTools, type ToolDeps } from '../tools'
import { BEHIND, byAddress, fileOf, keyedArgs, openByAddress, readSynced, withKey, type OpenWait } from '../live/agents'
import { AddinHub } from './hub'
import { AddinKeys, ensureAddinTables } from './keys'

/**
 * The add-in's part of the office pillar (docs/agents/work-office.md "The
 * add-in"): main's link to the relay, pairing, and which tool calls the
 * add-in carries here rather than the desktop host the workspace may use.
 */

export { ensureAddinTables }

let hub: AddinHub | null = null
let keysOf: AddinKeys | null = null
/** This host's add-ins, while Work runs. */
export const addinHub = (): AddinHub | null => hub

const RETRY_MS = [1000, 2000, 5000, 10_000, 30_000]

/** The relay's address on this host and the secret it asks of main; null while the service is not up. */
const serviceTarget = (ctx: WorkCtx): { url: string; secret: string } | null => {
  const secret = serviceOf(ctx)?.internalSecret()
  try {
    return secret ? { url: ctx.service.url('/w/office/host'), secret } : null
  } catch {
    return null
  }
}

/**
 * Starts the link to this host's Work service relay and keeps it up while Work runs. A
 * change an add-in reports goes to `heard` (the Excel helper's re-read of that range).
 */
export function startAddin(ctx: WorkCtx, heard: (book: string, sheet: string, address: string) => void, target = () => serviceTarget(ctx)): () => void {
  const keys = (keysOf = new AddinKeys(ctx.db))
  const h = (hub = new AddinHub({ keys, heard, log: ctx.log }))
  let stopped = false
  let ws: WebSocket | null = null
  let tries = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const later = (): void => {
    if (stopped) return
    timer = setTimeout(connect, RETRY_MS[Math.min(tries++, RETRY_MS.length - 1)])
    timer.unref?.()
  }
  function connect(): void {
    if (stopped) return
    const t = target()
    if (!t) return later()
    const sock = (ws = new WebSocket(t.url, { headers: { Authorization: `Bearer ${t.secret}` }, maxPayload: 8 * 1024 * 1024 }))
    sock.on('open', () => {
      tries = 0
      h.attach({ send: (text) => sock.readyState === sock.OPEN && sock.send(text) })
    })
    sock.on('message', (data: Buffer) => h.receive(data.toString('utf8')))
    sock.on('error', () => undefined)
    sock.on('close', () => {
      if (ws !== sock) return
      ws = null
      h.detach()
      later()
    })
  }
  connect()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    ws?.close()
    ws = null
    h.detach()
    if (hub === h) hub = null
    if (keysOf === keys) keysOf = null
  }
}

/** `work.office.addin.*`: the pairing code and the paired add-ins, his alone. */
export async function addinHandle(req: ClientRequest, ctx: WorkCtx, by: Caller): ReturnType<NonNullable<import('../../modules').WorkModule['handle']>> {
  if (!req.method.startsWith('work.office.addin.')) return NOT_HANDLED
  if (by.kind === 'model') throw new Error('Only the owner pairs an Office add-in.')
  const keys = keysOf ?? new AddinKeys(ctx.db)
  switch (req.method) {
    case 'work.office.addin.pair':
      return handled(keys.mint())
    case 'work.office.addin.list': {
      const live = hub?.live() ?? new Set<string>()
      return handled({ keys: keys.list().map((k) => ({ ...k, live: live.has(k.id) })) })
    }
    case 'work.office.addin.remove': {
      const id = (req.params as { id: string }).id
      hub?.kick(id)
      return handled({ removed: keys.remove(id) })
    }
  }
  return NOT_HANDLED
}

type Here = ReturnType<ToolDeps['here']>

/**
 * Whether a tool call runs on this host: always where it has a desktop carrier (the
 * add-in rides along on it); where it has only the add-in, for a file open in one, and
 * `office_files` while any is. Everything else goes to the workspace's desktop host, as
 * if this host had no Office: mail and calendar, and a file no add-in has open.
 */
export function carriedHere(carrier: OfficeCarrier, tool: string, args: unknown, h: AddinHub | null = hub): boolean {
  if (carrier.kind !== 'addin') return true
  if (!h) return false
  if (tool === 'office_files') return h.anyFile()
  const f = fileOf(args)
  return !!f && !!h.sessionFor(f.app, f.key)
}

/** Where a tool call may run on this host's behalf: this host's own carrier, Office in the Windows VM it keeps, or the workspace's desktop host. */
export type Place = 'here' | 'vm' | 'away'

const FILE_TOOL = /^office_(files|range_|doc_|slides_)/
/** A file's key that is a path in the Windows VM: a drive and backslashes. */
const guestKey = (key: string): boolean => /^[A-Za-z]:\\/.test(key)

/**
 * The places a tool call is tried in, in order (docs/agents/work-office.md "Where a tool runs"). A host with
 * the apps themselves (the Mac, a Windows PC) runs everything here, as before, and so does a file open in our
 * add-in. A host whose carrier has no Excel, Word or PowerPoint (the box: Outlook on the web) keeps mail and
 * calendar, and sends a file's tool to the machine its key names: a `C:\…` path to Office in the Windows VM
 * (`vm`: this thread may use it and it has Office), a POSIX path to the desktop host, and a URL or a bare name
 * to the VM first, then the desktop. `office_files` lists every place.
 */
export function placesOf(carrier: OfficeCarrier | null, tool: string, args: unknown, vm: boolean, h: AddinHub | null = hub): Place[] {
  if (carrier && carrier.kind !== 'addin' && carrier.kind !== 'owa') return ['here']
  if (!FILE_TOOL.test(tool)) return carrier && carrier.kind !== 'addin' ? ['here'] : ['away']
  if (tool === 'office_files') return [...(carrier && h?.anyFile() ? (['here'] as const) : []), ...(vm ? (['vm'] as const) : []), 'away']
  const f = fileOf(args)
  if (carrier && f && h?.sessionFor(f.app, f.key)) return ['here']
  if (f && guestKey(f.key)) return vm ? ['vm'] : ['away']
  if (f && f.key.startsWith('/')) return ['away']
  return vm ? ['vm', 'away'] : ['away']
}

/** Office in the Windows VM, for a thread: whether it may use it and it has Office, the wake before a call, and the carrier and Excel helper there. */
export interface VmOffice {
  offered(ctx: ToolCtx): boolean
  awake(): Promise<void>
  here(ctx: WorkCtx): NonNullable<Here>
  /** how long Word there may take to open a file by its address (a test's short wait) */
  open?: OpenWait
}

/** A file read from its synced copy, where no Office could read it live (live/agents.ts `readSynced`). */
type Synced = (ctx: ToolCtx, url: string, vm: boolean) => Promise<{ text: string; truncated: boolean } | null>
/** A test's own synced read and add-in hub. */
export interface AddinToolsOptions {
  synced?: Synced
  hub?: () => AddinHub | null
}
const READS = new Set(['office_doc_read', 'office_slides_read'])

const failed = (r: WorkToolResult): boolean => r.isError === true
const textOf = (r: WorkToolResult): string => r.content.map((c) => ('text' in c ? c.text : '')).join('')
/** No desktop to ask: the VM's own answer says more than that. */
const NO_DESKTOP = /may use no desktop/

/** The office tools, each call run where `placesOf` says: here, in the Windows VM, or on the desktop host. */
export function addinTools(here: (ctx: WorkCtx) => Here, vm?: VmOffice, o: AddinToolsOptions = {}): WorkTool[] {
  const fromCopy: Synced = o.synced ?? ((ctx, url, offered) => readSynced(ctx, () => here(ctx)?.carrier ?? null, url, offered))
  const hubNow = o.hub ?? (() => hub)
  const local = workTools({ here })
  const away = workTools({ here: () => null })
  const inVm = vm ? workTools({ here: (ctx) => vm.here(ctx), vm: true }) : null
  return local.map((t, i) => ({
    ...t,
    async run(args, ctx: ToolCtx) {
      const h = here(ctx)
      const offered = !!vm && !!inVm && vm.offered(ctx)
      const f = fileOf(args)
      const run = async (place: Place): Promise<WorkToolResult> => {
        // A file named by any form of its address goes by the key the Office that has it open gives it, so a held
        // change keeps the key its press finds again (live/agents.ts).
        if (place === 'here') return t.run(h && byAddress(f) ? await keyedArgs(h.carrier, args) : args, ctx)
        if (place === 'away') return away[i]!.run(args, ctx)
        try {
          await vm!.awake()
        } catch (err) {
          return { ...workText(`The Windows VM could not be reached: ${err instanceof Error ? err.message : String(err)}`), isError: true }
        }
        if (!byAddress(f)) return inVm![i]!.run(args, ctx)
        // A live file no add-in has open: Word in the VM opens it by its address and co-authors it.
        let key: string
        try {
          key = await openByAddress(vm!.here(ctx).carrier, f, vm!.open)
        } catch (err) {
          return { ...workText(`It did not open in the Windows VM: ${err instanceof Error ? err.message : String(err)}`), isError: true }
        }
        return inVm![i]!.run(withKey(args, f, key), ctx)
      }
      const places = placesOf(h?.carrier ?? null, t.name, args, offered, hubNow())
      if (t.name === 'office_files' && places.length > 1) {
        // Every place's open files, each under the computer it is on; a place that cannot be asked is left out.
        const NAMES: Record<Place, string> = { here: 'our Office add-in', vm: 'the Windows VM', away: 'the desktop' }
        const got = await Promise.all(places.map(async (p) => ({ p, r: await run(p) })))
        const ok = got.filter((g) => !failed(g.r))
        if (ok.length === 1) return ok[0]!.r
        if (!ok.length) return got.find((g) => g.p === 'vm')?.r ?? got[0]!.r
        return workText(JSON.stringify({ computers: ok.map((g) => ({ on: NAMES[g.p], ...(JSON.parse(textOf(g.r)) as object) })) }, null, 1))
      }
      let first: WorkToolResult | null = null
      let last: WorkToolResult | null = null
      for (const place of places) {
        const r = await run(place)
        if (!failed(r)) return r
        // The more telling refusal: the first place's, unless it only says the file is not open there.
        first ??= r
        if (place === 'vm' && places.includes('away')) continue
        if (place === 'away' && first !== r && !NO_DESKTOP.test(textOf(r))) {
          last = { ...workText(`In the Windows VM: ${textOf(first)} On the desktop: ${textOf(r)}`), isError: true }
          break
        }
      }
      // No Office could read a live file: its synced copy can, and the answer says it may be behind.
      if (READS.has(t.name) && byAddress(f)) {
        const copy = await fromCopy(ctx, f.key, offered).catch(() => null)
        if (copy) return workText(`${BEHIND}\n\n${copy.text}${copy.truncated ? '\n\n(cut: the file goes on)' : ''}`)
      }
      return last ?? first!
    }
  }))
}
