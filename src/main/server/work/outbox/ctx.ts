import { z } from 'zod'
import type { OutboxItem } from '@shared/contract-work-outbox'
import { errorText, WORK_HOME, workspaceKindOf, type ActKind, type HeldItem, type LifeosOrigin } from '@shared/work'
import { configureLifeosRow } from '../../addonStore'
import { configureComputerHold, HELD_STALE, type HeldComputerCall } from '../../computer/run'
import type { ComputerToolOutcome } from '../../computer/result'
import type { CtxPart } from '../ctx'
import { lifeosAddress, lifeosSeamsFor } from '../lifeos/ctx'
import { WORK_MODULES, type ActKindDef, type WorkCtx } from '../modules'
import { scopeFactsOf, workAddonScope, WORK_ORPHAN } from '../scope'
import { addonCallKind, makeAddonGate, sealAddonMatcher } from './catch'
import { ActKinds, ActStale } from './kinds'
import { calendarOpKind, LifeosHeldItems, mailSendKind } from './lifeosHeld'
import { EarnedStore } from './earned'
import { Outbox } from './outbox'
import { isLifeosSpec, type RuleAddons } from './rules'
import { HeldStore, HELD_TABLE, LIVE_LOST } from './store'
import { heldKey, syncTells, tellHeld, type TellsDeps } from './tells'
import { heldLine } from './words'

/**
 * `ctx.held`, and the hold's wiring into the host (docs/agents/work-outbox.md).
 * Made once at boot, Work on or off, since a Work row keeps its fence with
 * the switch off: the catch on every add-on call, the hold on a Work
 * thread's computer acts and the guard on the LifeOS add-on row are all
 * installed here and read the row, never the switch. Only the watch on
 * LifeOS's held items runs while Work is on.
 */

/** A computer act the host kept for the owner's press: what he is shown, and what must still hold when he presses. */
export const ComputerActPayloadSchema = z.object({
  tool: z.string(),
  /** the call as the model made it; carried out exactly */
  args: z.record(z.string(), z.unknown()),
  app: z.object({ name: z.string(), bundleId: z.string().nullable() }),
  window: z.string().nullable(),
  /** `screen`: the host read the act as outward; `flag`: the model flagged it */
  why: z.enum(['screen', 'flag']),
  /** the act's own word, as the control says it */
  label: z.string(),
  /** the whole call in his words */
  title: z.string(),
  /** what the host read: which step, and what it lands on */
  read: z.object({ step: z.number(), why: z.string(), label: z.string(), on: z.string(), grantable: z.literal(false).optional() }).nullable(),
  /** the window as it was read; the file stays on this host and a screen gets its bytes from `work.outbox.get` */
  picture: z.object({ path: z.string().optional(), mimeType: z.string(), width: z.number(), height: z.number(), data: z.string().optional() }).nullable(),
  mark: z.string(),
  targets: z.array(z.object({ step: z.number(), param: z.enum(['element', 'start_element', 'focus', 'point']), sig: z.string(), ordinal: z.number(), count: z.number() }))
})
export type ComputerActPayload = z.infer<typeof ComputerActPayloadSchema>

/** What the outbox module's handlers reach (work/outbox/index.ts). */
export interface OutboxHost {
  outbox: Outbox
  store: HeldStore
  earned: EarnedStore
  addons: RuleAddons | null
  setForWork(addonId: string, forWork: boolean): boolean
  mcpUrl(): string
  isWorkScope(workspaceId: string): boolean
  /** drop what the hold keeps in memory for threads that are gone */
  forget(sessionIds: readonly string[]): void
}
const hosts = new WeakMap<WorkCtx, OutboxHost>()
export const outboxHostOf = (ctx: WorkCtx): OutboxHost | undefined => hosts.get(ctx)

/** A burst of Outbox changes brings what it tells up to date once. */
export const TELL_SYNC_MS = 250

/** The run a thread acts for when this host cannot follow its line to the end: no routine has it, so no grant fits it. */
export const ROUTINE_UNKNOWN = 'unknown-run'

const outcomeText = (out: ComputerToolOutcome): string => [...out.steps, ...(out.body ? [out.body] : [])].join('\n')

export const heldPart: CtxPart<'held'> = (ctx, deps) => {
  const facts = scopeFactsOf(deps.registry)
  const store = new HeldStore(deps.db)
  const earned = new EarnedStore(deps.db)
  const kinds = new ActKinds(() => WORK_MODULES)
  const mcpUrl = (): string => lifeosSeamsFor.current?.address?.mcpUrl ?? lifeosAddress().mcpUrl
  const isWorkScope = (workspaceId: string): boolean =>
    workspaceId === WORK_HOME || workspaceId === WORK_ORPHAN || facts.workspaces().some((w) => w.id === workspaceId && workspaceKindOf(w) === 'work')
  const rootOf = (sessionId: string): string => {
    let at = deps.registry.get(sessionId)
    for (let hops = 0; at?.parentId && hops < 32; hops++) at = deps.registry.get(at.parentId)
    return at?.id ?? sessionId
  }
  /**
   * The routine run a thread acts for: its own, or the nearest above it by
   * parent or starter. A run's subagent acts for the run. A thread whose line
   * this host cannot follow to its end (a parent on another host, or more than
   * 32 links) acts for an unknown run, which takes no grant (milestone 50's
   * hold review, finding 5).
   */
  const routineRunOf = (sessionId: string): string | null => {
    let at = deps.registry.get(sessionId)
    for (let hops = 0; at; hops++) {
      if (at.routineRunId) return at.routineRunId
      const up = at.parentId ?? at.startedBy
      if (!up) return null
      if (hops >= 32) return ROUTINE_UNKNOWN
      at = deps.registry.get(up)
      if (!at) return ROUTINE_UNKNOWN
    }
    return null
  }

  // What a stop left behind: a row that was being sent is never sent again by the host, and a live act's screen went with the process.
  try {
    if (deps.db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(HELD_TABLE)) {
      const { interrupted, lost } = store.recover()
      if (interrupted || lost) ctx.log(`outbox: ${interrupted} send(s) were cut off by a stop and wait on the owner; ${lost} live act(s) went stale`)
    }
  } catch (err) {
    ctx.log(`outbox: could not put right what a stop left: ${errorText(err)}`)
  }

  // What the Outbox tells him goes through `ctx.tell` (tells.ts): the digest's rule decides whether a held item
  // interrupts (it has a clock) or waits. The thread's notifier is no longer called from here.
  const tells: TellsDeps = { ctx, kindOf: (kind) => kinds.get(kind as ActKind) ?? undefined, workspaces: () => facts.workspaces() }
  const notify = (item: OutboxItem): void => {
    try {
      tellHeld(tells, item)
    } catch (err) {
      ctx.log(`outbox: the held item was not told: ${errorText(err)}`)
    }
  }
  const outbox = new Outbox({
    ctx,
    store,
    kinds,
    scopeKeyOf(sessionId) {
      const session = deps.registry.get(sessionId)
      const key = session ? workAddonScope(facts, session) : null
      return key && key !== WORK_ORPHAN ? key : null
    },
    // The routines pillar keeps its runs (milestone 32); until it does, no run is known and a routine's act takes no grant.
    routineOf(runId) {
      try {
        const row = deps.db.prepare(`SELECT routine_id FROM work_routine_runs WHERE id = ?`).get(runId) as { routine_id?: string } | undefined
        return row?.routine_id ?? null
      } catch {
        return null
      }
    },
    rootOf,
    routineRunOf,
    whisper: (sessionId, text) => deps.registry.whisper(sessionId, text),
    notify,
    earned
  })
  outbox.seals.set('addon.call', sealAddonMatcher as never)
  // An item that reached its end is no longer waiting: its row goes at once. Whatever else moved (a failed send, an
  // offer, an item decided on another device) is brought up to date a moment later, once for a burst of changes.
  outbox.onDecided((item) => {
    if (item.state !== 'failed') ctx.tell.done(heldKey(item.ref))
  })
  let syncing: ReturnType<typeof setTimeout> | null = null
  outbox.onChange(() => {
    if (syncing) return
    syncing = setTimeout(() => {
      syncing = null
      syncTells(tells, {
        waiting: () => outbox.list({ show: 'waiting', limit: 500 }).items,
        offers: () => outbox.offers(),
        lifeosLoaded: () => outbox.lifeos?.loadedTables?.() ?? null
      })
    }, TELL_SYNC_MS)
    syncing.unref?.()
  })

  // ── the catch on every add-on call ──────────────────────────────────
  const addons: RuleAddons | null = deps.addons ?? null
  if (addons && deps.addonHost) {
    // An unknown run is stamped as it is, so a LifeOS draft from such a thread takes no grant either (milestone 50's hold re-review, 13).
    const origin = (sessionId: string): LifeosOrigin | null => {
      const root = deps.registry.get(rootOf(sessionId))
      if (!root) return null
      const scope = ctx.scopeOf(root.id)
      const workspaceId = scope?.workspaceId ?? (root.projectId ? deps.registry.getProject(root.projectId)?.workspaceId : null) ?? root.workspaceId ?? null
      return { app: 'tempcode', threadId: root.id, host: ctx.host, ...(workspaceId ? { workspaceId } : {}), ...(routineRunOf(sessionId) ? { routineRunId: routineRunOf(sessionId)! } : {}) }
    }
    const gate = makeAddonGate({ outbox, store, addons, sessions: deps.registry, mcpUrl, isWorkScope, originOf: origin, modules: () => WORK_MODULES, log: ctx.log })
    const door = deps.addonHost.setGate(gate)
    kinds.register(addonCallKind({ addons, ungated: (addonId, tool, args) => door.ungated(addonId, tool, args) }))
  }
  // The row that holds a LifeOS key keeps LifeOS's address, whoever writes it.
  configureLifeosRow((spec) => isLifeosSpec(spec, mcpUrl()))

  // ── the hold on a Work thread's computer acts ───────────────────────
  /** How to carry out each live act, by its row: the thread's own computer session, which a restart does not keep. */
  const carries = new Map<string, HeldComputerCall['carryOut']>()
  const computerAct: ActKindDef<ComputerActPayload, never> = {
    kind: 'computer.act',
    store: 'host',
    payload: ComputerActPayloadSchema,
    words: (p) => ({ summary: p.title, verb: p.label }),
    async execute(_p, act) {
      const id = act.item.ref.at === 'host' ? act.item.ref.id : ''
      const carry = carries.get(id)
      if (!carry) throw new ActStale(LIVE_LOST)
      const out = await carry()
      if (out.stale) throw new ActStale(`${HELD_STALE}. Nothing was sent.`)
      if (out.isError) throw new Error(out.body ?? 'the computer call failed')
      return { summary: act.item.summary, ref: { text: outcomeText(out) } }
    },
    wayBack: () => null
  }
  kinds.register(computerAct)
  kinds.register(mailSendKind)
  kinds.register(calendarOpKind)
  configureComputerHold({
    hold(call) {
      const payload: ComputerActPayload = {
        tool: call.tool,
        args: call.args,
        app: call.app,
        window: call.window,
        why: call.why,
        label: call.label,
        title: call.title,
        read: call.read,
        picture: call.picture,
        mark: call.mark,
        targets: call.targets
      }
      const { row } = outbox.hold({ kind: 'computer.act', sessionId: call.threadId, payload, why: call.why, origin: 'computer', state: 'live' })
      carries.set(row.id, call.carryOut)
      return heldLine(row)
    }
  })
  // A row that reached its end keeps no way to run again.
  store.onChange((row) => {
    if (row.state === 'sent' || row.state === 'discarded' || row.state === 'stale') carries.delete(row.id)
  })

  // ── LifeOS's own held items, while Work is on ───────────────────────
  const lifeos = new LifeosHeldItems({ ctx, outbox, session: (id) => deps.registry.get(id) ?? null })
  deps.whileOn(() => {
    outbox.lifeos = lifeos
    const stop = lifeos.start()
    // Tasks a send owed while LifeOS was out of reach.
    void outbox.completeTasks()
    return () => {
      stop()
      outbox.lifeos = null
    }
  })

  hosts.set(ctx, {
    outbox,
    store,
    earned,
    addons,
    setForWork: (addonId, forWork) => deps.addons?.setWorkMarks(addonId, { forWork }) ?? false,
    mcpUrl,
    isWorkScope,
    forget(sessionIds) {
      for (const id of sessionIds) for (const row of store.liveOf(id)) carries.delete(row.id)
    }
  })

  return {
    held: {
      // Holds the act, or carries it out now when a standing grant of the owner's fits; the item says which by its state.
      create: (act): HeldItem => outbox.wire(outbox.hold({ kind: act.kind, sessionId: act.sessionId, payload: act.payload, account: act.account ?? null }).row),
      onDecided: (fn) => outbox.onDecided(fn)
    }
  }
}
