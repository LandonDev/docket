import type { Principal as SocketPrincipal } from '@shared/capabilities'
import type { ClientRequest } from '@shared/contract'
import { errorText, handled, NOT_HANDLED, type Handled } from '@shared/work/ids'
import { isWorkMethod } from '@shared/work/wire'
import type { Work, WorkDeps } from './ctx'

/**
 * The one door the host uses to bring Work up (docs/agents/work.md). This
 * file imports no pillar, no part of the context and not the mount itself:
 * each is loaded here, behind a guard, so that nothing in Work's code, or
 * in a package a pillar depends on, can stop the host from booting. A
 * pillar that fails to load is left out alone (work/modules.ts); if the
 * mount itself cannot load or start, the host gets an inert Work that
 * answers why, and everything that is not Work runs as it always did.
 */
export interface WorkLoader {
  /** Starts Work with the host's handles. Never throws. */
  start(deps: WorkDeps): Work
}

export async function loadWork(): Promise<WorkLoader> {
  try {
    const [{ loadWorkModules }, { startWork }] = await Promise.all([import('./modules'), import('./ctx')])
    await loadWorkModules()
    return {
      start(deps) {
        try {
          return startWork(deps)
        } catch (err) {
          return inertWork(fault('did not start', err))
        }
      }
    }
  } catch (err) {
    const why = fault('did not load', err)
    return { start: () => inertWork(why) }
  }
}

const fault = (what: string, err: unknown): string => {
  const why = `work: Work ${what} on this host: ${errorText(err)}`
  console.error(`[work] ${why}`)
  return why
}

/**
 * Work that could not be brought up: off, and unable to be turned on. The
 * switch reads off (nothing of Work runs), every other Work method answers
 * the fault, no thread is listed a tool, and a method that is not Work's
 * comes back unhandled like any other.
 */
export function inertWork(why: string): Work {
  const refuse = (): never => {
    throw new Error(why)
  }
  const failing = new Proxy(refuse, { get: () => refuse }) as never
  return {
    ctx: failing,
    settings: failing,
    createWorkspace: refuse,
    admitSession: refuse,
    async handle(req: ClientRequest, _principal: SocketPrincipal): Promise<Handled> {
      if (!isWorkMethod(req.method)) return NOT_HANDLED
      if (req.method === 'work.get') return handled({ enabled: false })
      // a bridge that asks for its tools hears none, as while Work is off
      if (req.method === 'app.workTools') return handled({ tools: [] })
      return refuse()
    },
    pushes: { onPush: () => () => {} },
    tools: { of: () => null, listing: () => [], call: refuse, tokenFor: () => '', checkToken: () => false },
    close() {}
  }
}
