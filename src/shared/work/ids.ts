import { z } from 'zod'

/**
 * Work's names (docs/agents/work.md): hosts, sectors, pillars, who wrote
 * something, and the two values a workspace and a thread are stamped with.
 * Everything under src/shared/work is wire-safe: no node import, so the
 * renderer, the hosted page and the server all read the same types.
 */

/** The environment id the rail and the peer links already use. */
export type HostId = string

/** A LifeOS sector key (`purdue`, `cosmic`, …). LifeOS owns the list; TempCode carries the key as it is. */
export type SectorKey = string
export const SectorKeySchema = z.string().min(1).max(64)

/**
 * Every pillar, in the order its module mounts (`WORK_MODULES`). A pillar
 * owns `src/shared/contract-work-<id>.ts`, `src/main/server/work/<id>/`,
 * `src/renderer/src/work/<id>/` and `docs/agents/work-<id>.md`.
 */
export const PILLAR_IDS = [
  'outbox',
  'canvas',
  'lifeos',
  'routines',
  'rules',
  'mail',
  'tasks',
  'agenda',
  'docs',
  'history',
  'formats',
  'sheets',
  'office',
  'google',
  'guests',
  'pdf',
  'slides',
  'media',
  'frameio',
  'meetings',
  'forms',
  'dashboards',
  'browser',
  'projects',
  'winvm',
  'capture',
  'files',
  'prep',
  'money',
  'search',
  'review'
] as const
export type PillarId = (typeof PILLAR_IDS)[number]
export const PillarIdSchema = z.enum(PILLAR_IDS)
export const isPillarId = (value: string): value is PillarId => (PILLAR_IDS as readonly string[]).includes(value)

/** The plan milestone that builds each pillar's server module: what "not built" names. */
export const PILLAR_MILESTONE: Record<PillarId, number> = {
  outbox: 10,
  canvas: 9,
  lifeos: 7,
  routines: 32,
  rules: 39,
  mail: 23,
  tasks: 25,
  agenda: 25,
  docs: 20,
  history: 19,
  formats: 15,
  sheets: 27,
  office: 28,
  google: 30,
  guests: 31,
  pdf: 33,
  slides: 33,
  media: 34,
  frameio: 48,
  meetings: 35,
  forms: 36,
  dashboards: 36,
  browser: 37,
  /** the project tracking suite's own plan (plan-3OjTu0_U7Ed6), numbered past the Work plan's fifty */
  projects: 51,
  /** the Computers and Windows VM plan (plan-m1X24rQ6nikm), B3, numbered past the projects suite */
  winvm: 52,
  /** capture from anywhere, a feature after the plan (landed/F-capture.md), numbered past the Windows VM */
  capture: 53,
  /** the Files place (plan-jjspQsZklEYR), numbered past capture */
  files: 54,
  /** meeting prep and follow-up (plan-B6-Yq2vVy3SZ), numbered past the Files place */
  prep: 55,
  /** money, receipts to a ledger by job (plan-VWTDbboLt6UA), round 3's row 6 */
  money: 60,
  /** one search for everything in Work (plan-3lajhR4Inx-d), a feature of the third round */
  search: 62,
  /** the weekly review (plan-toGPPKaX6Q1P), numbered past the pillars that landed before it */
  review: 63
}

/**
 * Who wrote or did something: the owner, an agent thread on a host, a guest
 * by link id, a LifeOS client, or a named outside author (Word, Google).
 * Not `capabilities.ts`'s `Principal`, which is who a socket belongs to.
 */
export type Principal = 'owner' | `agent:${HostId}:${string}` | `guest:${string}` | `lifeos:${string}` | `external:${string}`
export const PrincipalSchema = z.custom<Principal>(
  (value) => typeof value === 'string' && (value === 'owner' || /^(agent:[^:]+:.+|guest:.+|lifeos:.+|external:.+)$/.test(value)),
  'a principal'
)
export const agentPrincipal = (host: HostId, threadId: string): Principal => `agent:${host}:${threadId}`

/** `workspaces.kind`: a code workspace is today's; a Work workspace is a job. */
export const WorkspaceKindSchema = z.enum(['code', 'work'])
export type WorkspaceKind = z.infer<typeof WorkspaceKindSchema>

/** `sessions.scope`, stamped once at create and kept across a move. */
export const SessionScopeSchema = z.enum(['code', 'work'])
export type SessionScope = z.infer<typeof SessionScopeSchema>

/** The home of Work Chats, beside today's `"~"` for Chats. */
export const WORK_HOME = '~work'

/** A row from before the column, or one a code path wrote, reads as code. */
export const workspaceKindOf = (workspace: { kind?: WorkspaceKind | null }): WorkspaceKind => (workspace.kind === 'work' ? 'work' : 'code')
export const sessionScopeOf = (session: { scope?: SessionScope | null }): SessionScope => (session.scope === 'work' ? 'work' : 'code')

/**
 * Stamped by the host on what an agent makes in LifeOS (`outbox.origin`,
 * `calendarOps.origin`, `sheetSuggestionCells.origin`). The thread id is the
 * key; `host` is a hint the canvas move hook rewrites when a thread moves.
 */
export interface LifeosOrigin {
  app: 'tempcode'
  threadId: string
  host: HostId
  workspaceId?: string
  routineRunId?: string
}
export const LifeosOriginSchema = z.object({
  app: z.literal('tempcode'),
  threadId: z.string(),
  host: z.string(),
  workspaceId: z.string().optional(),
  routineRunId: z.string().optional()
})

/** A handler's answer in the router's chain: today's shape (fsgit.ts). */
export type Handled = { handled: false } | { handled: true; result: unknown }
export const handled = (value: unknown): Handled => ({ handled: true, result: value ?? null })
export const NOT_HANDLED: Handled = { handled: false }

/** What the hold decides for one act: run it, hold it for his press, or refuse it. */
export type Verdict = 'run' | 'hold' | 'refuse'
export const VERDICTS: readonly Verdict[] = ['run', 'hold', 'refuse']

/**
 * A part of Work that exists as a mount and nothing else yet. The message
 * names the milestone that builds it, so a caller reads which thread to
 * wait for; nothing unbuilt ever answers as if it had worked.
 */
export class NotBuilt extends Error {
  readonly code = 'not-built' as const
  constructor(
    readonly what: string,
    readonly milestone: number
  ) {
    super(`not built: ${what} (milestone ${milestone})`)
    this.name = 'NotBuilt'
  }
}
/** What went wrong, in one line: the error's own word and, when it only wraps another, that one's too. */
export function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const cause = (err as { cause?: unknown }).cause
  return cause instanceof Error && cause.message && !err.message.includes(cause.message) ? `${err.message}: ${cause.message}` : err.message
}

/** A stub member: any call throws `NotBuilt`. */
export const notBuilt =
  (what: string, milestone: number) =>
  (..._args: unknown[]): never => {
    throw new NotBuilt(what, milestone)
  }
