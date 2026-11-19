import { z } from 'zod'
import type { MethodCapability } from '../capabilities'
import { isPillarId, PILLAR_IDS, type PillarId } from './ids'

/**
 * What a pillar's contract file (`src/shared/contract-work-<pillar>.ts`) is
 * written with. The file exports four things, and `contract-work.ts`
 * mounts them once:
 *
 *   export const MailRequestSchemas = [request('work.mail.list', z.object({ … }))] as const
 *   export type MailPush = { push: 'work.mail'; … }
 *   export const MAIL_CAPS = { 'work.mail.list': 'read' } satisfies CapsOf<typeof MailRequestSchemas>
 *   export const MAIL_RELAY = {} satisfies RelayOf<typeof MailRequestSchemas>
 *
 * Names: a method is `work.<pillar>.<verb>`, with the capability a key
 * needs for it, or `local` for one only this machine's own window may
 * call. A push is `work.<pillar>` or `work.<pillar>.<what>`. No param is
 * named `path` or `cwd`: a file is named inside a `CanvasSource`, which the
 * fence reads.
 *
 * What a thread calls is a tool (`WorkModule.tools`), which every harness
 * reaches through the one mount. A bridge method of a pillar's own
 * (`app.work<Pillar><Verb>`, capability `local`) is for the rare call that
 * is not a tool; it takes `sessionId` and `token`, the router checks the
 * token is that thread's, and the bridge script sends it only once a
 * foundation follow-up teaches it to.
 */
export const request = <M extends string, P extends z.ZodType>(method: M, params: P) => z.object({ id: z.string(), method: z.literal(method), params })

/** The method names of a request list. */
export type MethodsOf<S extends readonly z.ZodType[]> = z.infer<S[number]> extends infer R ? (R extends { method: infer M extends string } ? M : never) : never
/** One capability row per method: a missing or an extra row fails typecheck. */
export type CapsOf<S extends readonly z.ZodType[]> = Record<MethodsOf<S>, MethodCapability>
/**
 * Where a relayed lane sends a method, when the default is wrong. A method a
 * key can hold is carried to the host the lane names (the phone reaching a
 * workspace on the Mac through the box). `'screen'`: carried only while that
 * host is unlocked. `'never'`: not carried; the rows are this host's own.
 */
export type RelayOf<S extends readonly z.ZodType[]> = Partial<Record<MethodsOf<S>, 'screen' | 'never'>>

const capital = (id: string): string => id[0].toUpperCase() + id.slice(1)

/** The pillar a Work method belongs to, or null for the core's own (`work.get`, `app.workTools`, …) and for any other method. */
export function pillarOfMethod(method: string): PillarId | null {
  if (method.startsWith('work.')) {
    const id = method.split('.')[1] ?? ''
    return method.split('.').length >= 3 && isPillarId(id) ? id : null
  }
  if (method.startsWith('app.work')) {
    const rest = method.slice('app.work'.length)
    // longest id first, so a pillar whose name starts another's is never taken for it
    for (const id of [...PILLAR_IDS].sort((a, b) => b.length - a.length)) {
      const name = capital(id)
      if (rest.startsWith(name) && /^[A-Z]/.test(rest.slice(name.length))) return id
    }
  }
  return null
}

/** What is wrong with a method a pillar's contract declares, or null. */
export function pillarMethodProblem(pillar: PillarId, method: string, cap: MethodCapability | undefined, params: readonly string[] = ['sessionId', 'token']): string | null {
  if (pillarOfMethod(method) !== pillar) return `${method}: a ${pillar} method is work.${pillar}.<verb> or app.work${capital(pillar)}<Verb>`
  if (cap === undefined) return `${method}: no capability row`
  if (method.startsWith('app.')) {
    if (cap !== 'local') return `${method}: a bridge method is local`
    if (!params.includes('sessionId') || !params.includes('token')) return `${method}: a bridge method takes sessionId and token`
  }
  return null
}

/** Whether a method is Work's at all: the core's or a pillar's. */
export const isWorkMethod = (method: string): boolean => method === 'work.get' || method === 'work.set' || method.startsWith('work.') || method.startsWith('app.work')
