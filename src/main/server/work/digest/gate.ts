import type { RoutineRun } from '@shared/contract-work-routines'
import type { SessionMeta } from '@shared/events'
import { errorText } from '@shared/work/ids'
import type { Tell } from '@shared/work/tell'
import type { NoticeGate, ThreadNotice } from '../../remote/notifier'
import type { Caller, WorkCtx, WorkModule } from '../modules'
import { ROUTINE_ASKS_WAIT } from './rule'

/**
 * The thread notifier's gate (docs/agents/work-digest.md): a Work thread that
 * started on its own, not on his press, does not ring his phone when it
 * ends, fails or goes quiet. Each becomes a tell, which waits for the day's
 * digest (group `results`), and the thread's row in the rail still says
 * what it always did.
 *
 * "On its own" is a root Work thread with a routine's run (`routineRunId`)
 * that he did not start with Run now, or one a pillar marked with
 * `ctx.tell.quiet`. A question or an approval from it still reaches him at
 * once, with Allow and Deny, unless `ROUTINE_ASKS_WAIT` says otherwise; a
 * held item's notice is the Outbox's own tell. A thread he has typed in is
 * his own from then on, whatever started it. When the cause of a run
 * cannot be learned the notice goes through: nothing he needs goes quiet on
 * a doubt. With Work off the gate keeps nothing.
 */

/** What the routines engine writes as the cause of a run he started himself (routines/engine.ts `runNow`). */
export const RUN_NOW_CAUSE = 'Run now'

export interface GateDeps {
  enabled(): boolean
  /** a pillar marked the thread with `ctx.tell.quiet` */
  isQuiet(sessionId: string): boolean
  /** the job the thread is in; null: a Work Chat */
  workspaceOf(sessionId: string): string | null
  /** he typed in the thread himself: it is his own from then on */
  ownerWrote(sessionId: string): boolean
  /** whether he started this run himself; null: it cannot be learned */
  pressed(runId: string, workspaceId: string | null): Promise<boolean | null>
  tell(t: Tell): void
  log(line: string): void
}

const KIND: Record<'finished' | 'failed' | 'stuck', string> = { finished: 'routines.done', failed: 'routines.failed', stuck: 'routines.stuck' }

export function makeGate(deps: GateDeps): NoticeGate {
  const take = (notice: ThreadNotice, session: SessionMeta, kind: string): true => {
    deps.tell({ kind, workspaceId: deps.workspaceOf(session.id), title: notice.title, detail: notice.body, key: `thread:${session.id}`, open: { thread: session.id } })
    return true
  }
  return (notice, session) => {
    if (!deps.enabled()) return false
    // Roots only, and only Work's: a code thread, or a subagent, is never the digest's.
    if (session.scope !== 'work' || session.parentId) return false
    // A held act is told by the Outbox itself.
    if (notice.held) return false
    const quiet = deps.isQuiet(session.id)
    const runId = session.routineRunId ?? null
    if (!quiet && !runId) return false
    const kind = notice.event === 'needs_you' ? (ROUTINE_ASKS_WAIT ? 'routines.asks' : null) : KIND[notice.event]
    if (!kind) return false
    // A thread he took over by hand answers him as any thread does.
    if (deps.ownerWrote(session.id)) return false
    if (quiet) return take(notice, session, kind)
    // A run he started with Run now is his own press, and answers him as any thread does.
    return deps.pressed(runId!, deps.workspaceOf(session.id)).then(
      (pressed) => (pressed === false ? take(notice, session, kind) : false),
      (err: unknown) => {
        deps.log(`digest: a run's cause could not be read, so its notice goes: ${errorText(err)}`)
        return false
      }
    )
  }
}

const LOCAL: Caller = { kind: 'local', caps: ['read'] }
const KNOWN_MAX = 500

/**
 * Whether a run was his own press, read through the routines module's own
 * methods as this host's caller (never its tables): the routines of the
 * thread's workspace, then each one's runs until the run is found. A run's
 * cause never changes, so each is asked once.
 */
export function runPressed(ctx: WorkCtx, modules: () => readonly WorkModule[]): GateDeps['pressed'] {
  const known = new Map<string, boolean>()
  return async (runId, workspaceId) => {
    const had = known.get(runId)
    if (had !== undefined) return had
    const routines = modules().find((m) => m.id === 'routines')
    if (!routines?.handle) return null
    const call = async <T>(method: string, params: unknown): Promise<T | null> => {
      const answer = await routines.handle!({ id: 'digest', method, params } as never, ctx, LOCAL)
      return answer.handled ? (answer.result as T) : null
    }
    if (known.size > KNOWN_MAX) known.clear()
    const listed = await call<{ routines: { id: string }[] }>('work.routines.list', workspaceId ? { workspaceId } : {})
    for (const routine of listed?.routines ?? []) {
      const runs = await call<{ runs: RoutineRun[] }>('work.routines.runs', { id: routine.id, limit: 50 })
      for (const run of runs?.runs ?? []) known.set(run.id, run.cause === RUN_NOW_CAUSE)
      const found = known.get(runId)
      if (found !== undefined) return found
    }
    return null
  }
}
