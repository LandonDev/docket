import { WebSocket } from 'ws'
import type { ClientRequest } from '@shared/contract'
import { handled, NOT_HANDLED } from '@shared/work'
import type { Caller, WorkCtx, WorkTool } from '../../modules'
import { serviceOf } from '../../service/ctx'
import type { OfficeCarrier } from '../carrier'
import { workTools, type ToolDeps } from '../tools'
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

/** The file a tool's arguments name, if any. */
const fileOf = (args: unknown): { app: 'excel' | 'word' | 'powerpoint'; key: string } | null => {
  const a = (args ?? {}) as Record<string, unknown>
  if (typeof a.workbook === 'string') return { app: 'excel', key: a.workbook }
  if (typeof a.document === 'string') return { app: 'word', key: a.document }
  if (typeof a.deck === 'string') return { app: 'powerpoint', key: a.deck }
  return null
}

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

/** The office tools, each call run here or on the desktop host by `carriedHere`. */
export function addinTools(here: (ctx: WorkCtx) => Here): WorkTool[] {
  const local = workTools({ here })
  const away = workTools({ here: () => null })
  return local.map((t, i) => ({
    ...t,
    run(args, ctx) {
      const h = here(ctx)
      return h && carriedHere(h.carrier, t.name, args) ? t.run(args, ctx) : away[i]!.run(args, ctx)
    }
  }))
}
