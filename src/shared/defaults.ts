import { z } from 'zod'
import { REASONING_LEVELS } from './catalog'

/**
 * "New threads start on": which copy of a project linked across hosts a new
 * thread starts in when nothing on screen decides it. `box` is a host that is
 * not a Mac (`startOnHostOf`, by platform), `mac` a Mac. The global value
 * rides the thread defaults (one copy, on the box); a project may override it
 * (`ProjectMeta.startOn`, `project.setStartOn`).
 */
export const StartOnSchema = z.enum(['box', 'mac'])
export type StartOn = z.infer<typeof StartOnSchema>
export const DEFAULT_START_ON: StartOn = 'box'

/**
 * Thread defaults — what a NEW thread starts with when the user doesn't
 * choose otherwise: provider, model ('' = the provider's default),
 * reasoning effort, and the security policy. Stored like the
 * orchestration rules: a global set plus whole-object per-workspace
 * overrides in the settings table; session.create resolves them
 * server-side so every entry point (strip, plan handoff, future CLI)
 * gets the same answer.
 */
export const ThreadDefaultsSchema = z.object({
  provider: z.enum(['claude', 'codex', 'cursor', 'grok', 'opencode', 'pi', 'omp', 'fx', 'muse']).default('claude'),
  /** model id; '' = the provider's catalog default */
  model: z.string().default(''),
  reasoning: z.enum(REASONING_LEVELS).default('medium'),
  /** security: safe = ask first, edits = auto-edits, auto = full access */
  permission: z.enum(['safe', 'edits', 'auto']).default('edits'),
  /** The host a new thread of a linked project starts on (`StartOnSchema`);
   *  only the global set's counts, absent = the box. */
  startOn: StartOnSchema.optional()
})
export type ThreadDefaults = z.infer<typeof ThreadDefaultsSchema>

export const DEFAULT_THREAD_DEFAULTS: ThreadDefaults = {
  provider: 'claude',
  model: '',
  reasoning: 'medium',
  permission: 'edits'
}

/** Parse stored JSON; anything invalid falls back to null (scope unset). */
export function parseDefaults(raw: string | null): ThreadDefaults | null {
  if (!raw) return null
  try {
    return ThreadDefaultsSchema.parse(JSON.parse(raw))
  } catch {
    return null
  }
}

const RANK = { safe: 0, edits: 1, auto: 2 } as const satisfies Record<ThreadDefaults['permission'], number>

/**
 * The one rule for a new thread's access on a host (`SessionRegistry.create`):
 * what was asked (his own pick, or the grant of the thread that starts it),
 * else his Thread defaults for the thread's workspace, never above `ceiling`
 * (a paired key without approve holds no more than `edits`, whatever the
 * default). No start path carries a fallback of its own; the window's draft
 * asks for nothing unless he picked (lib/session.ts `accessParams`).
 */
export function newThreadPermission(o: {
  asked?: ThreadDefaults['permission']
  defaults: ThreadDefaults
  ceiling?: ThreadDefaults['permission']
}): ThreadDefaults['permission'] {
  const want = o.asked ?? o.defaults.permission
  return o.ceiling && RANK[want] > RANK[o.ceiling] ? o.ceiling : want
}

/** The lesser of two accesses. */
export const lowerPermission = (a: ThreadDefaults['permission'], b: ThreadDefaults['permission']): ThreadDefaults['permission'] =>
  RANK[a] <= RANK[b] ? a : b
