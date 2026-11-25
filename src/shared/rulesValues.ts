import { CATALOG, PROBED_PROVIDERS, REASONING_LEVELS, modelInfo, type ModelInfo, type ProviderId, type Reasoning } from './catalog'

/**
 * The orchestration rules as plain values: their shapes, the defaults, and every rule that reads them. No schema
 * and no zod: the window's first paint reads these (lib/tcserver/rules.ts, lib/reviewScope.ts) and must not carry a
 * validator it never runs (184 kB of the entry before this file was cut from src/shared/rules.ts, which keeps the
 * schemas and the parsers and exports all of this again). The schemas there are held to these shapes by the compiler.
 */

/** Per-model spawn policy, keyed `provider:modelId` in rules.models.
 *  A missing entry means OFF: a model the person never allowed is not
 *  spawned (a new static catalog model waits for them to turn it on). A
 *  probed row the copy lacks takes its default (`withProbedDefaults`), so
 *  Off is written as `approved: false`.
 *  `approved`: `true` for every thread, `'orchestrators'` only when an
 *  orchestration thread or an orchestrator agent (a master, from wave 1)
 *  spawns, `false` for none (CLAUDE.md "Master threads"). */
export interface ModelPolicy {
  approved: boolean | 'orchestrators'
  /** effort bounds, clamped to the model's ladder; absent = ladder end */
  minReasoning?: Reasoning
  maxReasoning?: Reasoning
}

export interface RoutingRule {
  id: string
  /** when this rule applies — shown to the orchestrator verbatim */
  task: string
  provider: ProviderId
  /** model id; '' = the provider's default */
  model: string
  reasoning: Reasoning
  enabled: boolean
}

export interface RulesConduct {
  /** strict: delegate everything; balanced: trivial glue itself; free */
  delegation: 'strict' | 'balanced' | 'free'
  /** may the orchestrator edit files itself? (enforced: tool denial) */
  selfEdit: boolean
  /** may it run shell commands itself? (enforced: tool denial) */
  selfShell: boolean
  /** verify subagent reports before relaying them */
  verifyResults: boolean
  /** rerun weak output on a smarter model without asking */
  escalate: boolean
  /** isolate writing subagents in git worktrees */
  useWorktrees: boolean
  /** subagents running at once; 0 = unlimited (enforced in spawn_agent) */
  maxParallel: number
  /** total subagents per thread; 0 = unlimited (enforced in spawn_agent) */
  maxAgents: number
}

export interface OrchestrationRules {
  conduct: RulesConduct
  /** subagent model policies by `provider:modelId`; {} = none approved */
  models: Record<string, ModelPolicy>
  routing: RoutingRule[]
}

/**
 * Per-thread tune, set when an orchestration thread is created: the
 * workspace/global rules stay the DEFAULT, each conduct setting can be
 * overridden for this one run, and free-text instructions ride along
 * into the orchestrator's prompt. Absent keys inherit.
 */
export interface ThreadRules {
  conduct?: Partial<RulesConduct>
  instructions?: string
}
export type ConductOverride = NonNullable<ThreadRules['conduct']>

// Defaults mirror the user's model policy (~/.claude/CLAUDE.md): gpt-5.5
// for bulk work (effectively free), taste ≥ 7 for anything user-facing
// with intelligence > taste > cost when axes conflict (→ fable-5),
// reviews by fable-5/opus-4.8 with gpt-5.5 as an optional independent
// second opinion. Never Haiku.
/** The approval a catalog model gets before anyone decides: Fable and
 *  Muse Wonder Full for orchestrators and masters only (CLAUDE.md "Master
 *  threads"), everything else for every thread. One rule for the defaults
 *  and for `explicitModels`, which writes probed rows out the same way. */
export function defaultApproval(provider: ProviderId, modelId: string): ModelPolicy['approved'] {
  if (provider === 'claude' && modelId.startsWith('claude-fable')) return 'orchestrators'
  if (provider === 'muse' && /-full\b/.test(modelId)) return 'orchestrators'
  return true
}

export const DEFAULT_RULES: OrchestrationRules = {
  conduct: {
    delegation: 'strict',
    selfEdit: false,
    selfShell: true,
    verifyResults: true,
    escalate: true,
    useWorktrees: true,
    maxParallel: 4,
    maxAgents: 0
  },
  // Every catalog model approved, Fable for orchestrators and masters only
  // (CLAUDE.md "Master threads"). A saved rules object replaces this whole
  // map (parseRules), so a database with its own entries keeps them.
  models: Object.fromEntries(
    (Object.keys(CATALOG) as ProviderId[]).flatMap((p) =>
      CATALOG[p].models.map((m): [string, ModelPolicy] => [
        `${p}:${m.id}`,
        { approved: defaultApproval(p, m.id) }
      ])
    )
  ),
  routing: [
    {
      id: 'trivial',
      task: 'Trivial or small tasks — tiny fixes, renames, one-file changes',
      provider: 'codex',
      model: 'gpt-5.5',
      reasoning: 'low',
      enabled: true
    },
    {
      id: 'bulk',
      task: 'Bulk or mechanical work with a clear spec — implementation, migrations, data analysis',
      provider: 'codex',
      model: 'gpt-5.5',
      reasoning: 'medium',
      enabled: true
    },
    {
      id: 'user-facing',
      task: 'User-facing work — UI, copy, API design',
      provider: 'claude',
      model: 'claude-fable-5',
      reasoning: 'medium',
      enabled: true
    },
    {
      id: 'hard',
      task: 'Hard problems — debugging, architecture, novel design',
      provider: 'claude',
      model: 'claude-fable-5',
      reasoning: 'high',
      enabled: true
    },
    {
      id: 'review',
      task: 'Reviews of plans or implementations',
      provider: 'claude',
      model: 'claude-opus-4-8',
      reasoning: 'high',
      enabled: true
    },
    {
      id: 'second-opinion',
      task: 'Independent second review opinion, when one is wanted',
      provider: 'codex',
      model: 'gpt-5.5',
      reasoning: 'high',
      enabled: true
    }
  ]
}

/** The effective rules: base (workspace → global → defaults) with this
 *  thread's conduct overrides laid on top. Routing always inherits. */
export function mergeThreadRules(
  base: OrchestrationRules,
  tune: ThreadRules | null | undefined
): OrchestrationRules {
  if (!tune?.conduct || Object.keys(tune.conduct).length === 0) return base
  return { ...base, conduct: { ...base.conduct, ...tune.conduct } }
}

/** Model label helper for prompt text ('' = provider default). */
export function ruleModel(r: RoutingRule): string {
  return r.model || CATALOG[r.provider].defaultModel
}

// ── model policy (approved subagent models + effort bounds) ──────────

export const modelKey = (provider: ProviderId, modelId: string): string =>
  `${provider}:${modelId}`

/** Who asks for the model: an orchestrator (an orchestration thread, an
 *  orchestrator agent, a master) or any other thread. */
export type PolicyRole = 'orchestrator' | 'thread'

/** The role a session spawns under. `master` is whether the session is
 *  its project's master thread (`projects.master_thread_id`), which the
 *  caller reads from the registry; shared code has none. A master is an
 *  orchestrator (wave 1, "Master role"). */
export function policyRoleOf(
  session: { agentType?: string | null; threadType?: string | null },
  master = false
): PolicyRole {
  return master || session.agentType === 'orchestrator' || session.threadType === 'orchestration'
    ? 'orchestrator'
    : 'thread'
}

/**
 * Rules saved while a missing entry meant approved: every catalog model
 * without an entry written out as approved, so the switch to "missing = off"
 * changes nothing the person saw. Run once per stored copy
 * (SessionRegistry.getOrchestrationRules).
 */
export function explicitModels(rules: OrchestrationRules): OrchestrationRules {
  const models = { ...rules.models }
  for (const p of Object.keys(CATALOG) as ProviderId[]) {
    for (const m of CATALOG[p].models) models[modelKey(p, m.id)] ??= { approved: defaultApproval(p, m.id) }
  }
  return { ...rules, models }
}

/**
 * The rules with every probed row (PROBED_PROVIDERS: the Muse Code rows
 * `model/list` answers at boot, the other probed CLIs') the copy never
 * decided given its default (`defaultApproval`). Probed rows arrive after a
 * copy was saved, so neither DEFAULT_RULES nor `explicitModels` could name
 * them. Applied where the rules are read, `rules.get` and `rulesFor`, never
 * written back: the page and spawn_agent see the same answer on this host,
 * the one copy on the box is left as the person saved it, and the next edit
 * on the page saves the rows it shows. A decision is kept: the page stores
 * Off as `approved: false`, so only a key the copy lacks takes a default.
 *
 * `elsewhere` is the probed rows of the other hosts this one reaches
 * (server/peerCatalogs.ts): the box serves no Muse Code rows, so without
 * the Mac's it would read an undecided Muse model as Off where the Mac
 * reads its default, and the two hosts would answer one copy differently.
 */
export function withProbedDefaults(
  rules: OrchestrationRules,
  elsewhere: readonly ProbedRow[] = []
): OrchestrationRules {
  let models: OrchestrationRules['models'] | null = null
  const rows = [...PROBED_PROVIDERS.flatMap((p) => CATALOG[p].models.map((m) => ({ provider: p, id: m.id }))), ...elsewhere]
  for (const { provider, id } of rows) {
    const key = modelKey(provider, id)
    if (rules.models[key] || models?.[key]) continue
    ;(models ??= { ...rules.models })[key] = { approved: defaultApproval(provider, id) }
  }
  return models ? { ...rules, models } : rules
}

/** A probed provider's model, by its provider and id. */
export interface ProbedRow {
  provider: ProviderId
  id: string
}

export function modelApproved(
  rules: OrchestrationRules,
  provider: ProviderId,
  modelId: string,
  role: PolicyRole = 'thread'
): boolean {
  const approved = rules.models[modelKey(provider, modelId)]?.approved ?? false
  if (approved === 'orchestrators') return role === 'orchestrator'
  return approved
}

/** The effort ladder the policy leaves open for a model — its catalog
 *  ladder sliced to [minReasoning, maxReasoning]. Bounds off the ladder
 *  (or crossed) are ignored rather than emptying it. */
export function approvedLadder(
  rules: OrchestrationRules,
  provider: ProviderId,
  modelId: string
): Reasoning[] {
  return sliceLadder(rules, provider, modelId, modelInfo(provider, modelId)?.reasoning ?? [])
}

/** `approvedLadder` over a ladder the caller holds: the renderer reads a
 *  probed row's ladder from the host's catalog, which its own copy of
 *  CATALOG never has. */
export function sliceLadder(
  rules: OrchestrationRules,
  provider: ProviderId,
  modelId: string,
  ladder: Reasoning[]
): Reasoning[] {
  const p = rules.models[modelKey(provider, modelId)]
  if (!p || ladder.length === 0) return ladder
  let lo = p.minReasoning ? ladder.indexOf(p.minReasoning) : 0
  let hi = p.maxReasoning ? ladder.indexOf(p.maxReasoning) : ladder.length - 1
  if (lo < 0) lo = 0
  if (hi < 0) hi = ladder.length - 1
  return lo <= hi ? ladder.slice(lo, hi + 1) : ladder
}

/** The rung of `ladder` nearest `requested` in REASONING_LEVELS order, the
 *  lower on a tie (`minimal` on a ladder from `low` → `low`); null for a
 *  word that is no rung. */
function nearestRung(ladder: Reasoning[], requested: string): Reasoning | null {
  const at = REASONING_LEVELS.indexOf(requested as Reasoning)
  if (at < 0 || ladder.length === 0) return null
  let best: Reasoning | null = null
  for (const r of ladder) {
    const d = Math.abs(REASONING_LEVELS.indexOf(r) - at)
    if (best === null || d < Math.abs(REASONING_LEVELS.indexOf(best) - at)) best = r
  }
  return best
}

/** Requested effort fitted to the approved ladder: kept when inside,
 *  moved to the model's nearest rung when the model lacks it (a thread
 *  moved off a ladder with `minimal` lands on `low`), clamped to the
 *  nearer bound when the model serves it outside the approved range,
 *  else the default (itself fitted). `info` is the row of the host that
 *  runs it, this one's by default (another host's for a spawn there,
 *  server/peerCatalogs.ts). */
export function fitReasoning(
  rules: OrchestrationRules,
  provider: ProviderId,
  modelId: string,
  requested: string | undefined,
  info: ModelInfo | undefined = modelInfo(provider, modelId)
): Reasoning {
  const full = info?.reasoning ?? []
  const ladder = sliceLadder(rules, provider, modelId, full)
  if (ladder.length === 0) return 'medium'
  if (requested && ladder.includes(requested as Reasoning)) return requested as Reasoning
  const want = requested ? nearestRung(full, requested) : null
  const pick = want ?? info?.defaultReasoning ?? ladder[0]
  const ix = full.indexOf(pick)
  if (ix >= 0 && ix < full.indexOf(ladder[0])) return ladder[0]
  if (ix > full.indexOf(ladder[ladder.length - 1])) return ladder[ladder.length - 1]
  return ladder.includes(pick) ? pick : ladder[0]
}
