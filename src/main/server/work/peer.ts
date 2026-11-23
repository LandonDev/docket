import { METHOD_CAPABILITY, type Capability } from '@shared/capabilities'
import { ClientRequestSchema, type ClientRequest } from '@shared/contract'
import { CROSS_HOST_CALL_MS, CROSS_HOST_OFFER, workAskArgs, type CrossHostCaller, type ThreadWork, type WorkCallResult, type WorkProbeResult } from '@shared/contract-crosshost'
import type { MacBridgePolicy } from '@shared/contract-macbridge'
import type { SessionMeta } from '@shared/events'
import { filesPaneWorkspace, isPillarId, NotBuilt, PILLAR_MILESTONE, sessionScopeOf, workspaceKindOf, type HostId, type PillarId, type WorkScope } from '@shared/work'
import { HostLinks, type HostTransport } from '../remote/hostLinks'
import type { LinkRequest } from '../remote/peerCalls'
import { setMovingTo } from '../sessionMove'
import { workRoot } from '../workRoot'
import type { CtxPart } from './ctx'
import { WORK_MODULES, type Caller, type WorkCtx, type WorkModule } from './modules'
import { scopeFactsOf, WORK_OFF, workHomeOf, workHomeOfSession } from './scope'

/**
 * `ctx.peer(host)`: a Work tool's route to the same module on another host
 * (docs/agents/work.md "Across hosts"). The office module on the box writes
 * a range through Excel on the Mac with
 * `ctx.peer(mac).call('office', 'rangeWrite', args)`: the Mac runs its own
 * module's `handle` for `work.office.rangeWrite`.
 *
 * Two gates, one on each host:
 *  - here, the workspace's own setting: the host must be in the workspace's
 *    `mayUseDesktop` ("May use this Mac"). The workspace is the calling
 *    thread's, so `peer` is called on a tool's own `ctx` (`ctx.peer(host)`),
 *    which carries its scope; called any other way it is refused.
 *  - there, that host's bridge policy for this one (Settings → Hosts): off
 *    refuses every call, read allows a method a read key may call, read+run
 *    and full allow one an operate key may. Nothing a peer sends carries the
 *    owner's press, so a method that needs `approve`, `admin` or this
 *    machine's own window is refused whatever the policy.
 *
 * The call rides `thread.start` (contract-crosshost.ts): the one method a
 * host from before Work refuses when it carries Work's envelope, and the one
 * both directions of a host link already carry.
 *
 * This part also answers a move: whether another host would keep a Work
 * thread a Work thread (SessionRegistry.workMove).
 */

/** The capabilities a peer's call holds under a host's bridge policy for it. Never `approve` or `admin`: the press is the owner's. */
export function peerCaps(policy: MacBridgePolicy): Capability[] {
  if (policy === 'off') return []
  return policy === 'read' ? ['read'] : ['read', 'operate']
}

export interface ServePeerDeps {
  ctx: Pick<WorkCtx, 'enabled'> & WorkCtx
  modules: readonly WorkModule[]
  /** This host's bridge policy for the calling host. */
  policyOf(from: string): MacBridgePolicy
  /** The capability a method needs; undefined: no such method. */
  capabilityOf?(method: string): Capability | 'local' | undefined
  /** The request as the contract reads it, or a refusal in words. */
  parse?(method: string, params: unknown): ClientRequest | string
}

const contractRequest = (method: string, params: unknown): ClientRequest | string => {
  const parsed = ClientRequestSchema.safeParse({ id: 'peer', method, params })
  return parsed.success ? parsed.data : `the arguments do not fit ${method}: ${parsed.error.issues[0]?.message ?? 'invalid'}`
}

/** A Work call from another host, run here: this host's own module, under this host's bridge policy for the caller. */
export async function servePeerWork(deps: ServePeerDeps, from: string, call: Extract<ThreadWork, { kind: 'call' }>): Promise<unknown> {
  if (!deps.ctx.enabled()) throw new Error(WORK_OFF)
  if (!isPillarId(call.module) || !/^[A-Za-z][A-Za-z0-9]*$/.test(call.verb)) throw new Error(`unknown Work method: ${call.module}.${call.verb}`)
  const method = `work.${call.module}.${call.verb}`
  const need = (deps.capabilityOf ?? ((m: string) => (METHOD_CAPABILITY as Record<string, Capability | 'local' | undefined>)[m]))(method)
  if (!need) throw new Error(`unknown Work method: ${method}`)
  const policy = deps.policyOf(from)
  const caps = peerCaps(policy)
  if (policy === 'off') throw new Error(`this host's bridge is off for that host (Settings → Hosts): ${method} was not run`)
  if (need === 'local' || !caps.includes(need))
    throw new Error(
      need === 'read' || need === 'operate'
        ? `this host's bridge policy for that host is "${policy}", and ${method} needs ${need} (Settings → Hosts)`
        : `${method} needs ${need}, which no call from another host carries`
    )
  const module = deps.modules.find((m) => m.id === call.module)
  const req = (deps.parse ?? contractRequest)(method, call.args)
  if (typeof req === 'string') throw new Error(req)
  const by: Caller = { kind: 'remote', caps, peer: from }
  const answer = module?.handle ? await module.handle(req, deps.ctx, by) : { handled: false as const }
  if (!answer.handled) throw new NotBuilt(method, PILLAR_MILESTONE[call.module as PillarId])
  return answer.result
}

/** An error as one short line: a schema refusal arrives as pages of JSON. */
export const oneLine = (err: unknown): string => {
  const text = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim()
  return text.length > 160 ? `${text.slice(0, 160)}…` : text
}

/** What a move needs to know of the destination, in words when it would not keep the thread a Work thread. */
export async function moveRefusal(ask: (work: Extract<ThreadWork, { kind: 'probe' }>) => Promise<WorkProbeResult>, home: ReturnType<typeof workHomeOf>, hostName: string): Promise<string | null> {
  let answer: WorkProbeResult
  try {
    answer = await ask({ kind: 'probe', ...home })
  } catch (err) {
    // A build from before Work reads the probe as a thread start with no message and refuses it.
    return `${hostName} does not answer for Work (${oneLine(err)}): it runs a build from before Work, or is out of reach. It would take the thread as a code thread.`
  }
  if (!answer?.work || typeof answer.work.enabled !== 'boolean') return `${hostName} runs a build from before Work; it would take the thread as a code thread.`
  if (!answer.work.enabled) return `Work is off on ${hostName}.`
  if (!answer.work.home) return answer.work.why ? `${hostName}: ${answer.work.why}.` : `${hostName} has no Work workspace for this thread.`
  return null
}

/** A host's own read of another host's module (`hostReadOf`). */
export interface HostRead {
  /** every other host with a live link to this one, whichever side dialed */
  hosts(): string[]
  read<T>(host: string, module: PillarId, verb: string, args: unknown): Promise<T>
}
const hostReads = new WeakMap<WorkCtx, HostRead>()
export const hostReadOf = (ctx: WorkCtx): HostRead | undefined => hostReads.get(ctx)

export const peerPart: CtxPart<'peer'> = (ctx, deps) => {
  const facts = scopeFactsOf(deps.registry)
  // How another host is reached, whichever way the socket runs: the transport the thread.* calls use.
  const linkTo = (id: string): LinkRequest | null => {
    const link = deps.peers?.get(id)
    return link?.connected ? (method, params, opts) => link.request(method, params, opts) : null
  }
  const links: HostTransport | null = deps.peerCalls ? new HostLinks({ calls: deps.peerCalls, offer: CROSS_HOST_OFFER, link: linkTo, linkIds: () => deps.peers?.all().map((l) => l.id) ?? [] }) : null
  const callerOf = (session: Pick<SessionMeta, 'id' | 'title' | 'permission'>): CrossHostCaller => ({ environmentId: deps.environmentId, sessionId: session.id, title: (session.title ?? '').slice(0, 300), permission: session.permission })
  const ask = async <T>(host: string, caller: CrossHostCaller, work: Extract<ThreadWork, { kind: 'probe' | 'call' }>): Promise<T> => {
    if (!links) throw new Error('this host has no links to other hosts')
    const refusal = links.refusal(host)
    if (refusal) throw new Error(refusal)
    return links.call<T>(host, 'thread.start', { caller, args: workAskArgs(work, workRoot(deps.store).root) }, CROSS_HOST_CALL_MS)
  }

  // A host's own read of another host's module, for the frame's parts (the digest's count across hosts): no thread
  // and no workspace is behind it, so it never passes for a thread's use of a desktop. The far host answers it under
  // its bridge policy for this one, as any call, and only a method a read key may call.
  hostReads.set(ctx, {
    hosts: () => (links?.reachable() ?? []).map((r) => r.id).filter((id) => id !== deps.environmentId),
    async read<T>(host: string, module: PillarId, verb: string, args: unknown): Promise<T> {
      const answer = await ask<WorkCallResult>(host, { environmentId: deps.environmentId, sessionId: 'work', title: 'Work', permission: 'safe' }, { kind: 'call', module, verb, args })
      if (!answer || typeof answer !== 'object' || !('work' in answer)) throw new Error('that host runs a build from before Work')
      return answer.work.result as T
    }
  })

  // The far side: a Work call another host sends is answered here.
  deps.crossHostThreads?.serveWork((from, call) => servePeerWork({ ctx, modules: WORK_MODULES, policyOf: (id) => deps.macBridge?.policyOf(id) ?? 'off' }, from, call))

  // A move: the destination says it keeps Work threads, or the thread stays (sessions.ts freezeForMove).
  deps.registry.workMove = {
    refusal: async (to, root) => {
      const home = workHomeOfSession(facts, root)
      if (home === 'orphan') return 'it has no Work workspace on this host to match on the other'
      return moveRefusal((work) => ask<WorkProbeResult>(to, callerOf(root), work), workHomeOf(home === 'chat' ? null : home), deps.peers?.get(to)?.env.name ?? to)
    },
    thaw: (ids) => setMovingTo(deps.db, ids, null, null)
  }

  return {
    peer(this: unknown, host: HostId) {
      // Called as `ctx.peer(host)` on a tool's ctx, `this` is that ctx, with the calling thread's scope and the call's signal.
      const scope = (this as { scope?: WorkScope } | undefined)?.scope
      const signal = (this as { signal?: AbortSignal } | undefined)?.signal
      return {
        async call(module: PillarId, verb: string, args: unknown): Promise<unknown> {
          if (!ctx.enabled()) throw new Error(WORK_OFF)
          if (!scope) throw new Error("ctx.peer is called on a tool's own ctx (ctx.peer(host)), which names the thread and its workspace")
          if (host === deps.environmentId) throw new Error('ctx.peer names another host; call the module here directly')
          // A workspace's Files pane is no thread: his own window's press there calls for it (a file copied for a tab), under the same two gates.
          const pane = filesPaneWorkspace(scope.sessionId)
          const paneOk = pane !== null && pane === scope.workspaceId && facts.workspaces().some((w) => w.id === pane && workspaceKindOf(w) === 'work')
          const session = paneOk ? null : deps.registry.get(scope.sessionId)
          if (!paneOk && (!session || sessionScopeOf(session) !== 'work')) throw new Error(`thread ${scope.sessionId} is not a Work thread`)
          // The workspace's own say: "May use this Mac".
          const allowed = scope.workspaceId ? ctx.settings.workspace(scope.workspaceId).mayUseDesktop : []
          if (!allowed.includes(host))
            throw new Error(
              scope.workspaceId
                ? `this workspace may not use that host's desktop (its Work settings name ${allowed.length ? allowed.join(', ') : 'no host'})`
                : 'a Work Chat may use no other host\'s desktop: only a workspace can be given one'
            )
          // The harness cancelled the tool, or Work was turned off: the call stops waiting (the far host's own deadline ends its side).
          if (signal?.aborted) throw new Error('cancelled')
          const cancelled = new Promise<never>((_, reject) => signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
          const caller: CrossHostCaller = session ? callerOf(session) : { environmentId: deps.environmentId, sessionId: scope.sessionId, title: 'Files', permission: 'safe' }
          const answer = await Promise.race([ask<WorkCallResult>(host, caller, { kind: 'call', module, verb, args }), cancelled])
          if (!answer || typeof answer !== 'object' || !('work' in answer)) throw new Error('that host runs a build from before Work')
          return answer.work.result
        }
      }
    }
  }
}
