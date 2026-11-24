import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOCAL_PRINCIPAL, type Principal } from '@shared/capabilities'
import type { ClientRequest } from '@shared/contract'
import type { AddonRow, AddonSpec } from '@shared/contract-addons'
import type { WorkPush } from '@shared/contract-work'
import type { OutboxItem } from '@shared/contract-work-outbox'
import type { WorkspaceMeta } from '@shared/domain'
import type { SessionMeta } from '@shared/events'
import { AddonStore } from '../../addonStore'
import { runAddonChild, type AddonChild } from '../../addons/addonChild'
import { AddonHost } from '../../addons/addonHost'
import type { AddonHostLink, AddonWireMessage } from '../../addons/addonWire'
import { configureAddonScope } from '../../addons/scope'
import { wirePair } from '../../addons/testWire'
import { appAddonCall, type AddonToolDeps } from '../../addons/tools'
import { configureLifeosRow } from '../../addonStore'
import type { AwayService } from '../../away'
import { configureComputerHold } from '../../computer/run'
import { openDb, Store } from '../../db'
import type { Notifier } from '../../remote/notifier'
import type { Tell } from '@shared/work/tell'
import type { SessionRegistry } from '../../sessions'
import { startWork, type Work } from '../ctx'
import { lifeosSeamsFor } from '../lifeos/ctx'
import type { LifeosClient } from '../lifeos/ctx'
import type { WorkModule } from '../modules'
import { outboxHostOf, type OutboxHost } from './ctx'
import { outbox as outboxModule } from './index'

/**
 * The hold on a real host's parts, for its tests: the real add-on store and
 * add-on host with a real child and the fake MCP server behind it, Work's
 * own mount (`startWork`) with the outbox module, and a registry of threads
 * the test writes. What reaches the downstream server is read off the wire
 * to the child, so "never reached the server" is a fact, not an inference.
 */

const FAKE_SERVER = fileURLToPath(new URL('../../../../../scripts/lib/fakeMcpServer.ts', import.meta.url))
const RUN = process.versions.bun ? [] : ['--no-warnings']
/** The fake MCP server as an add-on; more arguments make it another server (another spec). */
export const fakeSpec = (...more: string[]): AddonSpec => ({ transport: 'stdio', command: process.execPath, args: [...RUN, FAKE_SERVER, '--stdio', ...more], env: ['FAKE_TOKEN'], auth: 'fields' })
export const FAKE_SPEC: AddonSpec = fakeSpec()
export const LIFEOS_MCP = 'https://lifeos-mcp.test/mcp'
export const LIFEOS_SPEC: AddonSpec = { transport: 'http', url: LIFEOS_MCP, headers: ['Authorization'], auth: 'fields' }
export const person = { kind: 'person' as const }

export const readKey: Principal = { kind: 'remote', keyId: 'k1', name: 'tablet', audience: 'client', caps: ['read', 'operate'] } as Principal
export const approveKey: Principal = { kind: 'remote', keyId: 'k2', name: 'phone', audience: 'client', caps: ['read', 'operate', 'approve'] } as Principal
export const adminKey: Principal = { kind: 'remote', keyId: 'k3', name: 'laptop', audience: 'client', caps: ['read', 'operate', 'approve', 'admin'] } as Principal

export async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** LifeOS as the hold calls it: an `outbox` of mail rows, the owner's functions over it, and live queries the test fires. */
export class FakeOutboxLifeos implements LifeosClient {
  rows = new Map<string, Record<string, unknown>>()
  calls: { fn: string; args: Record<string, unknown> }[] = []
  watchers: { fn: string; args: Record<string, unknown>; on: (v: unknown) => void }[] = []
  connected = true
  /** these functions fail as if LifeOS did not have them */
  missing = new Set<string>(['calendarOps:held', 'calendarOps:get', 'calendarOps:save', 'calendarOps:send', 'calendarOps:discard'])
  /** `calendarOps` rows (milestone 24) and the events they name */
  ops = new Map<string, Record<string, unknown>>()
  events = new Map<string, Record<string, unknown>>()
  /** fail the next call of this function with this message */
  failNext = new Map<string, string>()
  completed: { sessionId: string; reason: string }[] = []
  private n = 0

  /** A draft a thread's key made, as `bot.mail.draft` leaves it. */
  /** what LifeOS keeps under a reply's body, by draft id (`outboxQuotes`) */
  quotes = new Map<string, string>()
  draft(over: { to?: string[]; cc?: string[]; subject?: string; text?: string; threadId?: string; host?: string; sector?: string; status?: string; accountId?: string; routineRunId?: string; workspaceId?: string; at?: number } = {}): string {
    const id = `ob_${++this.n}`
    const at = over.at ?? Date.now()
    this.rows.set(id, {
      _id: id,
      _creationTime: at,
      status: over.status ?? 'draft',
      sector: over.sector ?? 'purdue',
      editedAt: at,
      message: {
        kind: 'mail',
        accountId: over.accountId ?? 'acct_purdue',
        to: (over.to ?? ['dana@purdue.edu']).map((address) => ({ address })),
        cc: (over.cc ?? []).map((address) => ({ address })),
        bcc: [],
        subject: over.subject ?? 'Re: budget',
        html: `<p>${over.text ?? 'Attached.'}</p>`,
        text: over.text ?? 'Attached.',
        from: { address: 'landon@purdue.edu' }
      },
      origin: { app: 'tempcode', threadId: over.threadId ?? 't-work', host: over.host ?? 'env_box', ...(over.workspaceId ? { workspaceId: over.workspaceId } : {}), ...(over.routineRunId ? { routineRunId: over.routineRunId } : {}) }
    })
    return id
  }

  /** A calendar act a thread's key drafted, as `bot.agenda.draftCalendarOp` leaves it. */
  calendarOp(over: { kind?: string; eventId?: string; account?: string; host?: string; threadId?: string; status?: string; plain?: boolean; payload?: Record<string, unknown>; calendarId?: string } = {}): string {
    const id = `op_${++this.n}`
    const at = Date.now()
    this.ops.set(id, {
      _id: id,
      _creationTime: at,
      sector: 'purdue',
      kind: over.kind ?? 'accept',
      status: over.status ?? 'draft',
      route: 'google',
      account: over.account ?? 'landon@purdue.edu',
      editedAt: at,
      payload: over.payload ?? {},
      ...(over.eventId ? { eventId: over.eventId } : {}),
      ...(over.calendarId ? { calendarId: over.calendarId } : {}),
      ...(over.plain ? { plain: true } : {}),
      origin: { app: 'tempcode', threadId: over.threadId ?? 't-work', host: over.host ?? 'env_box' }
    })
    return id
  }

  /** What `outboxHeld.held({host})` answers now. */
  held(host: string): Record<string, unknown>[] {
    // As outboxHeld:held: drafts, failed sends, and mail he scheduled.
    return [...this.rows.values()].filter((r) => (r.status === 'draft' || r.status === 'failed' || (r.status === 'queued' && r.scheduled === true)) && (r.origin as { host?: string } | undefined)?.host === host)
  }

  /** Fire the live queries, as Convex does when a row changes. */
  fire(): void {
    for (const w of this.watchers) {
      if (this.missing.has(w.fn)) continue
      if (w.fn === 'outboxHeld:held') w.on(this.held(String(w.args.host)))
      if (w.fn === 'calendarOps:held') w.on([...this.ops.values()].filter((r) => (r.status === 'draft' || r.status === 'failed') && (r.origin as { host?: string }).host === w.args.host))
      if (w.fn === 'calendarOps:list') w.on([...this.ops.values()])
    }
  }

  private async run<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ fn, args })
    if (!this.connected) throw new Error('LifeOS is unreachable')
    if (this.missing.has(fn)) throw new Error(`Could not find public function for '${fn}'`)
    const fail = this.failNext.get(fn)
    if (fail) {
      this.failNext.delete(fn)
      throw new Error(fail)
    }
    const row = typeof args.id === 'string' ? this.rows.get(args.id) : undefined
    switch (fn) {
      case 'compose:get':
        return (row ? { row, ...(this.quotes.has(String(row._id)) ? { quote: this.quotes.get(String(row._id)) } : {}), urls: {} } : null) as T
      case 'compose:send': {
        if (!row) throw new Error('not found')
        if (row.status !== 'draft') throw new Error('This mail is no longer a draft.')
        Object.assign(row, { status: 'queued', message: args.message, cause: args.cause, sentFrom: 'tempcode', ...(args.sendAt !== undefined ? { sendAt: args.sendAt, scheduled: true, sendZone: args.sendZone } : {}) })
        this.fire()
        return args.id as T
      }
      case 'compose:reschedule': {
        if (!row || row.status !== 'queued' || !row.scheduled) throw new Error('This mail is no longer scheduled.')
        Object.assign(row, { sendAt: args.sendAt, sendZone: args.sendZone })
        this.fire()
        return null as T
      }
      case 'compose:cancel': {
        if (!row || row.status !== 'queued') return false as T
        Object.assign(row, { status: 'draft', sendAt: undefined, scheduled: undefined, sendZone: undefined })
        this.fire()
        return true as T
      }
      case 'compose:sendNow': {
        if (!row || row.status !== 'queued' || !row.scheduled) throw new Error('This mail is no longer scheduled.')
        const sendAt = Date.now() + 10_000
        Object.assign(row, { sendAt, scheduled: undefined, sendZone: undefined })
        this.fire()
        return sendAt as T
      }
      case 'compose:retry': {
        if (!row || row.status !== 'failed') throw new Error('this mail has not failed')
        Object.assign(row, { status: 'queued', error: undefined })
        this.fire()
        return null as T
      }
      case 'compose:save': {
        if (!row) throw new Error('not found')
        Object.assign(row, { message: args.message, editedAt: Number(row.editedAt) + 1 })
        this.fire()
        return args.id as T
      }
      case 'calendarOps:get': {
        const op = this.ops.get(String(args.id))
        if (!op) throw new Error('not found')
        return op as T
      }
      case 'calendarOps:send': {
        const op = this.ops.get(String(args.id))
        if (!op || (op.status !== 'draft' && op.status !== 'failed')) throw new Error('this calendar act is already on its way')
        if (args.editedAt !== undefined && op.editedAt !== args.editedAt) throw new Error('this calendar act changed since it was shown')
        Object.assign(op, { status: 'queued', cause: args.cause, sentFrom: 'tempcode', sentAt: args.editedAt })
        this.fire()
        return null as T
      }
      case 'calendarOps:save': {
        const op = this.ops.get(String(args.id))
        if (!op) throw new Error('not found')
        Object.assign(op, { kind: args.kind, payload: args.payload, editedAt: Number(op.editedAt) + 1 })
        this.fire()
        return args.id as T
      }
      case 'calendarOps:discard': {
        this.ops.delete(String(args.id))
        this.fire()
        return true as T
      }
      case 'events:get': {
        const event = this.events.get(String(args.id))
        if (!event) throw new Error('not found')
        return event as T
      }
      case 'sources:list':
        return [{ _id: 'src_gcal', kind: 'gcal', channel: 'landon@purdue.edu' }] as T
      case 'compose:discard': {
        this.rows.delete(String(args.id))
        this.fire()
        return { quote: null } as T
      }
    }
    throw new Error(`no function ${fn}`)
  }
  query = <T>(fn: string, args?: Record<string, unknown>): Promise<T> => this.run<T>(fn, args)
  mutation = <T>(fn: string, args?: Record<string, unknown>): Promise<T> => this.run<T>(fn, args)
  action = <T>(fn: string, args?: Record<string, unknown>): Promise<T> => this.run<T>(fn, args)
}

export interface Rig {
  dir: string
  work: Work
  host: OutboxHost
  addons: AddonStore
  addonHost: AddonHost
  lifeos: FakeOutboxLifeos
  /** every `call` main sent the add-on child: what reached the downstream server */
  downstream: { addonId: string; tool: string; arguments: Record<string, unknown> }[]
  pushes: WorkPush[]
  /** lines the app whispered to a thread, and the notices that woke one */
  whispers: { sessionId: string; text: string }[]
  woke: { sessionId: string; text: string }[]
  notices: { sessionId: string; body: string; ref: unknown }[]
  /** what the Outbox told through `ctx.tell`, and the keys it said are done */
  tells: Tell[]
  told: { done: string[] }
  logs: string[]
  away: { enabled: boolean }
  sessions: Map<string, SessionMeta>
  workspaces: Map<string, WorkspaceMeta>
  cards: { sessionId: string; toolName: string; decide: (allow: boolean) => void }[]
  /** a Work workspace, a code workspace, and a thread in each */
  workspace(id: string, extra?: Partial<WorkspaceMeta>): WorkspaceMeta
  thread(id: string, extra?: Partial<SessionMeta>): SessionMeta
  /** an add-on on the fake MCP server, ready, with its tools listed */
  addon(name: string, workspaceId: string | null, opts?: { forWork?: boolean; args?: string[] }): Promise<AddonRow>
  /** the row the host makes for LifeOS */
  lifeosAddon(workspaceId: string, spec?: AddonSpec): AddonRow
  /** Claude's lane: an exposed tool's handler (addons/exposure.ts) */
  claudeCall(sessionId: string, addonId: string, tool: string, args: Record<string, unknown>): ReturnType<AddonHost['call']>
  /** the bridge's lane: `addon_call` (addons/tools.ts), Codex and Muse */
  bridgeCall(sessionId: string, exposed: string, args: Record<string, unknown>): ReturnType<typeof appAddonCall>
  rpc<T>(method: string, params?: unknown, principal?: Principal): Promise<T>
  waiting(): Promise<OutboxItem[]>
  /** `keep`: leave the database, for a boot on it again (a restart) */
  close(opts?: { keep?: boolean }): Promise<void>
}

/** `modules`: the outbox and whatever fake pillars the test adds. `reuse`: boot again on the same database, as after a restart. */
export async function makeRig(opts: { modules?: WorkModule[]; reuse?: { dir: string }; enabled?: boolean } = {}): Promise<Rig> {
  const dir = opts.reuse?.dir ?? mkdtempSync(join(tmpdir(), 'tc-work-outbox-'))
  const db = openDb(join(dir, 'test.db'))
  const store = new Store(db)
  const addons = new AddonStore(db)
  const downstream: Rig['downstream'] = []
  const childs: AddonChild[] = []
  const spawnChild = (): AddonHostLink => {
    const [main, other] = wirePair<AddonWireMessage>()
    const post = main.post
    main.post = (m) => {
      const call = (m as { call?: { m?: string; addonId?: string; tool?: string; arguments?: Record<string, unknown> } }).call
      if (m.t === 'ask' && call?.m === 'call') downstream.push({ addonId: call.addonId!, tool: call.tool!, arguments: call.arguments ?? {} })
      post(m)
    }
    childs.push(runAddonChild(other, { watchMainMs: 0, exit: () => {} }))
    return { wire: main, kill: () => {}, onExit: () => {} }
  }
  const addonHost = new AddonHost({
    store: addons,
    spawnChild,
    grants: { read: async (id) => ({ v: 1, mintedBy: 'app', addonId: id, fields: { FAKE_TOKEN: 'grant-secret', Authorization: 'Bearer lob_test' } }) },
    platform: () => 'linux',
    baseEnv: async () => ({ PATH: process.env.PATH ?? '' }),
    cwd: () => tmpdir()
  })
  const sessions = new Map<string, SessionMeta>()
  const workspaces = new Map<string, WorkspaceMeta>(store.listWorkspaces().map((w) => [w.id, w]))
  const whispers: Rig['whispers'] = []
  const woke: Rig['woke'] = []
  const notices: Rig['notices'] = []
  const tells: Tell[] = []
  const told: Rig['told'] = { done: [] }
  const logs: string[] = []
  const pushes: WorkPush[] = []
  const cards: Rig['cards'] = []
  const away = { enabled: false }
  const removed: ((ids: string[]) => void)[] = []
  const gone: ((id: string) => void)[] = []
  const registry = {
    get: (id: string) => sessions.get(id) ?? null,
    getProject: () => null,
    listWorkspaces: () => [...workspaces.values()],
    eventsAfter: () => [],
    whisper: (sessionId: string, text: string) => void whispers.push({ sessionId, text }),
    deliverAgentReport: (sessionId: string, report: { text: string }) => void woke.push({ sessionId, text: report.text }),
    onRemoved: (fn: (ids: string[]) => void) => (removed.push(fn), () => {}),
    onWorkspaceDeleted: (fn: (id: string) => void) => (gone.push(fn), () => {}),
    onCatalog: () => () => {},
    requestApproval: (sessionId: string, req: { toolName: string }) => new Promise<boolean>((resolve) => void cards.push({ sessionId, toolName: req.toolName, decide: resolve }))
  }
  const notifier = { held: (sessionId: string, body: string, ref: unknown) => void notices.push({ sessionId, body, ref }) } as unknown as Notifier
  const lifeos = new FakeOutboxLifeos()
  lifeosSeamsFor.current = { address: { url: 'https://lifeos.test', mcpUrl: LIFEOS_MCP } }
  const work = startWork(
    {
      db,
      store,
      registry: registry as unknown as SessionRegistry,
      environmentId: 'env_box',
      dataDir: dir,
      addons,
      addonHost,
      away: away as unknown as AwayService,
      notifier: () => notifier,
      log: (line) => void logs.push(line)
    },
    opts.modules ?? [outboxModule]
  )
  // LifeOS as the hold calls it, in the context's place: the connection itself is the lifeos part's and has its own tests.
  work.ctx.lifeos = {
    connected: () => lifeos.connected,
    owner: () => lifeos,
    jwt: async () => 'jwt',
    subscribe: (fn, args, on) => {
      const w = { fn, args: (args ?? {}) as Record<string, unknown>, on: on as (v: unknown) => void }
      lifeos.watchers.push(w)
      queueMicrotask(() => lifeos.connected && !lifeos.missing.has(fn) && w.fn === 'outboxHeld:held' && w.on(lifeos.held(String(w.args.host))))
      return () => void lifeos.watchers.splice(lifeos.watchers.indexOf(w), 1)
    }
  }
  work.ctx.links = {
    link: async () => {},
    forThread: async () => [],
    completeFor: async (sessionId, reason) => {
      if (!lifeos.connected) throw new Error('LifeOS is unreachable')
      lifeos.completed.push({ sessionId, reason })
    }
  }
  // What the Outbox tells, in the context's place: the digest's ledger has its own tests.
  work.ctx.tell = Object.assign((t: Tell) => void tells.push(t), {
    done: (key: string) => void told.done.push(key),
    only: () => {},
    quiet: () => {}
  })
  work.pushes.onPush((p) => void pushes.push(p))
  await addonHost.start()
  if (opts.enabled !== false) work.settings.set({ enabled: true })
  const host = outboxHostOf(work.ctx)!

  const toolDeps: AddonToolDeps = {
    sessions: registry as unknown as AddonToolDeps['sessions'],
    store: addons,
    host: addonHost,
    rpc: { handle: async () => ({}) },
    environmentId: 'env_box',
    workspaceName: (id) => workspaces.get(id)?.name ?? null
  }
  const rig: Rig = {
    dir,
    work,
    host,
    addons,
    addonHost,
    lifeos,
    downstream,
    pushes,
    whispers,
    woke,
    notices,
    tells,
    told,
    logs,
    away,
    sessions,
    workspaces,
    cards,
    workspace(id, extra = {}) {
      const w = { id, name: id, path: join(dir, id), git: false, createdAt: Date.now(), ...extra } as WorkspaceMeta
      workspaces.set(id, w)
      return w
    },
    thread(id, extra = {}) {
      const s = { id, title: id, status: 'idle', permission: 'auto', provider: 'claude', archived: false, ...extra } as unknown as SessionMeta
      sessions.set(id, s)
      return s
    },
    async addon(name, workspaceId, o = {}) {
      const row = addons.set({ name, workspaceId, spec: o.args ? fakeSpec(...o.args) : FAKE_SPEC }, person)
      if (o.forWork) addons.setWorkMarks(row.id, { forWork: true })
      await until(() => addons.status()[row.id]?.state === 'ready')
      return row
    },
    lifeosAddon(workspaceId, spec = LIFEOS_SPEC) {
      const row = addons.set({ name: 'lifeos', workspaceId, spec, enabled: false }, person)
      addons.setWorkMarks(row.id, { role: 'lifeos' })
      return addons.get(row.id)!
    },
    claudeCall: (sessionId, addonId, tool, args) => addonHost.call(addonId, tool, args, { sessionId, work: sessions.get(sessionId)?.scope === 'work' }),
    bridgeCall: (sessionId, exposed, args) => appAddonCall(toolDeps, sessions.get(sessionId)!, { tool: exposed, arguments: args }),
    async rpc<T>(method: string, params?: unknown, principal: Principal = LOCAL_PRINCIPAL): Promise<T> {
      const answer = await work.handle({ id: '1', method, params } as ClientRequest, principal)
      if (!answer.handled) throw new Error(`${method} not handled`)
      return answer.result as T
    },
    waiting: async () => (await rig.rpc<{ items: OutboxItem[] }>('work.outbox.list')).items,
    async close(o = {}) {
      work.close()
      await addonHost.stop()
      await Promise.all(childs.map((c) => c.stop()))
      configureAddonScope(null)
      configureLifeosRow(null)
      configureComputerHold(null)
      lifeosSeamsFor.current = null
      db.close()
      if (!o.keep) rmSync(dir, { recursive: true, force: true })
    }
  }
  return rig
}

/** The usual cast: a Work workspace for Purdue with a Work thread, a code workspace with a code thread. */
export function cast(rig: Rig): { work: SessionMeta; code: SessionMeta } {
  rig.workspace('ws-purdue', { kind: 'work', sector: 'purdue' } as Partial<WorkspaceMeta>)
  rig.workspace('ws-code')
  return {
    work: rig.thread('t-work', { scope: 'work', workspaceId: 'ws-purdue' } as Partial<SessionMeta>),
    code: rig.thread('t-code', { workspaceId: 'ws-code' } as Partial<SessionMeta>)
  }
}
