import { z } from 'zod'
import { REASONING_LEVELS } from './catalog'
import type { ModelPolicy, OrchestrationRules, RoutingRule, ThreadRules } from './rulesValues'

// The shapes, the defaults and every rule that reads them are plain values in rulesValues.ts, so a reader that only
// needs those (the window's first paint) carries no zod. This file is the schemas and the parsers over them.
export * from './rulesValues'

/**
 * Structured orchestration rules — objective settings, not prose. Two
 * halves: CONDUCT bounds what the orchestrator itself may do (enforced in
 * code where possible: tool denial, spawn caps), ROUTING is an ordered
 * table mapping kinds of work to an exact provider/model/effort. The
 * ability to spawn any model from any provider is app mechanics, baked
 * into the prompt — these rules only decide what gets picked.
 */

const ReasoningEnum = z.enum(REASONING_LEVELS)

/** Per-model spawn policy, keyed `provider:modelId` in rules.models.
 *  A missing entry means OFF: a model the person never allowed is not
 *  spawned (a new static catalog model waits for them to turn it on). A
 *  probed row the copy lacks takes its default (`withProbedDefaults`), so
 *  Off is written as `approved: false`.
 *  `approved`: `true` for every thread, `'orchestrators'` only when an
 *  orchestration thread or an orchestrator agent (a master, from wave 1)
 *  spawns, `false` for none (CLAUDE.md "Master threads"). */
export const ModelPolicySchema = z.object({
  approved: z.union([z.boolean(), z.literal('orchestrators')]).default(true),
  /** effort bounds, clamped to the model's ladder; absent = ladder end */
  minReasoning: ReasoningEnum.optional(),
  maxReasoning: ReasoningEnum.optional()
})

export const RoutingRuleSchema = z.object({
  id: z.string(),
  /** when this rule applies — shown to the orchestrator verbatim */
  task: z.string(),
  provider: z.enum(['claude', 'codex', 'cursor', 'grok', 'opencode', 'pi', 'omp', 'fx', 'muse']),
  /** model id; '' = the provider's default */
  model: z.string().default(''),
  reasoning: ReasoningEnum.default('medium'),
  enabled: z.boolean().default(true)
})

export const OrchestrationRulesSchema = z.object({
  conduct: z.object({
    /** strict: delegate everything; balanced: trivial glue itself; free */
    delegation: z.enum(['strict', 'balanced', 'free']).default('strict'),
    /** may the orchestrator edit files itself? (enforced: tool denial) */
    selfEdit: z.boolean().default(false),
    /** may it run shell commands itself? (enforced: tool denial) */
    selfShell: z.boolean().default(true),
    /** verify subagent reports before relaying them */
    verifyResults: z.boolean().default(true),
    /** rerun weak output on a smarter model without asking */
    escalate: z.boolean().default(true),
    /** isolate writing subagents in git worktrees */
    useWorktrees: z.boolean().default(true),
    /** subagents running at once; 0 = unlimited (enforced in spawn_agent) */
    maxParallel: z.number().int().min(0).max(128).default(4),
    /** total subagents per thread; 0 = unlimited (enforced in spawn_agent) */
    maxAgents: z.number().int().min(0).max(200).default(0)
  }),
  /** subagent model policies by `provider:modelId`; {} = none approved */
  models: z.record(z.string(), ModelPolicySchema).default({}),
  routing: z.array(RoutingRuleSchema)
})

/**
 * Per-thread tune, set when an orchestration thread is created: the
 * workspace/global rules stay the DEFAULT, each conduct setting can be
 * overridden for this one run, and free-text instructions ride along
 * into the orchestrator's prompt. Absent keys inherit.
 */
export const ThreadRulesSchema = z.object({
  // Spelled out rather than derived from OrchestrationRulesSchema: that
  // schema's .default()s would fill every missing key at parse time,
  // turning "inherit" into a frozen copy of today's defaults.
  conduct: z
    .object({
      delegation: z.enum(['strict', 'balanced', 'free']).optional(),
      selfEdit: z.boolean().optional(),
      selfShell: z.boolean().optional(),
      verifyResults: z.boolean().optional(),
      escalate: z.boolean().optional(),
      useWorktrees: z.boolean().optional(),
      maxParallel: z.number().int().min(0).max(128).optional(),
      maxAgents: z.number().int().min(0).max(200).optional()
    })
    .optional(),
  instructions: z.string().optional()
})

/** Parse a stored per-thread tune; invalid or empty → null. */
export function parseThreadRules(raw: string | null): ThreadRules | null {
  if (!raw) return null
  try {
    const t = ThreadRulesSchema.parse(JSON.parse(raw))
    const hasConduct = t.conduct && Object.keys(t.conduct).length > 0
    return hasConduct || t.instructions?.trim() ? t : null
  } catch {
    return null
  }
}

/** Parse stored JSON; anything invalid falls back to the defaults. */
export function parseRules(raw: string | null): OrchestrationRules | null {
  if (!raw) return null
  try {
    return OrchestrationRulesSchema.parse(JSON.parse(raw))
  } catch {
    return null
  }
}

// The schemas and the plain shapes are one thing: a field added to either without the other fails here.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const _shapes: [
  Same<z.infer<typeof ModelPolicySchema>, ModelPolicy>,
  Same<z.infer<typeof RoutingRuleSchema>, RoutingRule>,
  Same<z.infer<typeof OrchestrationRulesSchema>, OrchestrationRules>,
  Same<z.infer<typeof ThreadRulesSchema>, ThreadRules>
] = [true, true, true, true]
void _shapes
