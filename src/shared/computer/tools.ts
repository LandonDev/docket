/**
 * What the models see of computer use (docs/computer-protocol.md §9): four
 * tools on the app MCP server, the same on every harness. The verbs and
 * their parameter names inside `computer_act` and `computer_batch` are
 * Anthropic's native computer-use set, with `element` beside `coordinate`.
 * TypeScript only; never generated. The words are descriptions.ts's, in
 * two shapes; the schemas here carry them.
 */
import { z } from 'zod'
import { PermissionPolicySchema } from '../events'
import { fieldWords, hostWords, perVerbDescription, toolDescription, type ComputerPlatform, type FieldKey, type ToolShape, type WordsShape } from './descriptions'
import { COMPUTER_RESULT_TOOL } from './heldCalls'
import { parseKeyCombo } from './observation'
import { ConfirmSchema } from './policy'
import {
  ACTION_PARAMS,
  ActionClassSchema,
  COMPUTER_ACTION_NAMES,
  COMPUTER_ACTION_SHAPE,
  ElementIndexSchema,
  NO_INPUT_ACTIONS,
  SERVICE,
  TierSchema,
  refineAction,
  type ActionClass,
  type ActionParam,
  type ComputerAction,
  type ComputerActionName,
  type Tier
} from './protocol'

// ── the action table ────────────────────────────────────────────────────

/** What the tier verdict learns per app (§5.2); the wire's ActionClassSchema. */
export const ACTION_CLASSES = ActionClassSchema.options
export { ActionClassSchema, type ActionClass }

export interface ComputerActionSpec {
  params: (typeof ACTION_PARAMS)[ComputerActionName]
  /** the verdict class, or null for an action that sends no input or runs on AX alone */
  class: ActionClass | null
  /** one of Anthropic's 17 native members */
  native: boolean
  /** sends no input: its step's tier is null, and a batch waits nothing after it */
  noInput: boolean
  /** runs on the `ax` tier only */
  axOnly: boolean
}

const CLASS_OF: Partial<Record<ComputerActionName, ActionClass>> = {
  left_click: 'click',
  right_click: 'click',
  middle_click: 'click',
  double_click: 'click',
  triple_click: 'click',
  left_mouse_down: 'click',
  left_mouse_up: 'click',
  left_click_drag: 'drag',
  mouse_move: 'hover',
  scroll: 'scroll',
  key: 'key',
  hold_key: 'key',
  type: 'type',
  paste: 'type',
  /** the save panel's name goes in as text (§26.7) */
  save_as: 'type'
}
const AX_ONLY: readonly ComputerActionName[] = ['set_value', 'perform', 'select_text']

/**
 * Whether a step may have a route at `ax` (docs/computer-protocol.md §24.1): a `key` holding
 * Command or Control (its menu item), a plain `left_click`, `right_click` or `double_click`
 * (the element or the hit under it), a plain `scroll` (the bar or the page), a `paste` and a
 * `type` (the AX insert), and `save_as` (the panel's AX parts). Under a `session` verdict the host tries these at `ax` before the gate.
 */
export function mayRunAtAx(a: ComputerAction): boolean {
  switch (a.action) {
    case 'key':
      try {
        const { modifiers } = parseKeyCombo(a.text ?? '')
        return modifiers.includes('super') || modifiers.includes('ctrl')
      } catch {
        return false
      }
    case 'left_click':
    case 'right_click':
    case 'double_click':
      return !a.text && a.duration === undefined
    case 'scroll':
      return !a.text
    case 'paste':
    case 'type':
    // the panel opens and takes its name over AX; only its folder needs the app in front (§26.7)
    case 'save_as':
      return true
    default:
      return false
  }
}

/** Every action with its parameters and its class; `computer_act` and the per-verb set are both built from it. */
export const COMPUTER_ACTIONS: Readonly<Record<ComputerActionName, ComputerActionSpec>> = Object.fromEntries(
  COMPUTER_ACTION_NAMES.map((name, i) => [
    name,
    {
      params: ACTION_PARAMS[name],
      class: CLASS_OF[name] ?? null,
      native: i < 17,
      noInput: NO_INPUT_ACTIONS.includes(name),
      axOnly: AX_ONLY.includes(name)
    }
  ])
) as Record<ComputerActionName, ComputerActionSpec>

// ── the four tools ──────────────────────────────────────────────────────

export const COMPUTER_TOOL_NAMES = ['computer_apps', 'computer_observe', 'computer_act', 'computer_batch'] as const
export type ComputerToolName = (typeof COMPUTER_TOOL_NAMES)[number]

/** Actions in one `computer_batch` call. */
export const TOOL_BATCH_MAX_ACTIONS = 20

type FieldText = Readonly<Record<FieldKey, string>>

/** The wire's action fields, each described in one word shape; optional as the wire has them. */
function describedActionShape(w: FieldText): typeof COMPUTER_ACTION_SHAPE {
  return Object.fromEntries(
    Object.entries(COMPUTER_ACTION_SHAPE).map(([k, s]) => [k, (s as z.ZodType).describe(w[k as FieldKey])])
  ) as typeof COMPUTER_ACTION_SHAPE
}

/** `open` goes into the app `launch` names; `confirm` flags an open, never a bare launch. */
function refineApps(v: { launch?: string; open?: string[]; confirm?: unknown }, ctx: z.RefinementCtx): void {
  if (v.open && !v.launch) ctx.addIssue({ code: 'custom', path: ['open'], message: 'open needs launch, the app to open it in' })
  if (v.confirm && !v.open) ctx.addIssue({ code: 'custom', path: ['confirm'], message: 'confirm goes with open' })
}

/** The four tools' inputs with one word shape's field descriptions; the rules are the same in every shape. */
function toolInputs(w: FieldText) {
  const target = {
    app: z.string().min(1).describe(w.app),
    window: z.string().min(1).optional().describe(w.window),
    screenshot: z.boolean().optional().describe(w.screenshot)
  }
  const actionShape = describedActionShape(w)
  const confirm = (text: string) =>
    z
      .object({ kind: ConfirmSchema.shape.kind.describe(w['confirm.kind']), what: ConfirmSchema.shape.what.describe(w['confirm.what']) })
      .optional()
      .describe(text)
  return {
    apps: z
      .object({
        launch: z.string().min(1).optional().describe(w.launch),
        open: z.array(z.string().min(1)).min(1).max(SERVICE.openItemsMax).optional().describe(w.open),
        // the kinds are explained on computer_act's confirm; the list pays for each copy on every turn
        confirm: z
          .object({ kind: ConfirmSchema.shape.kind.describe(w['apps.confirm.kind']), what: ConfirmSchema.shape.what.describe(w['confirm.what']) })
          .optional()
          .describe(w['apps.confirm'])
      })
      .superRefine(refineApps),
    observe: z.object({
      app: target.app,
      window: target.window,
      full: z.boolean().optional().describe(w.full),
      element: ElementIndexSchema.optional().describe(w['observe.element']),
      screenshot: target.screenshot,
      menus: z.boolean().optional().describe(w.menus)
    }),
    /** The action's own fields beside the target's: one flat object, no `oneOf`. */
    act: z.object({ ...target, ...actionShape, confirm: confirm(w.confirm) }).superRefine(refineAction),
    // §27.12: a step's fields are computer_act's, described there once; the step names only its action
    batch: z.object({
      ...target,
      actions: z
        .array(z.object({ ...COMPUTER_ACTION_SHAPE, action: actionShape.action }).superRefine(refineAction))
        .min(1)
        .max(TOOL_BATCH_MAX_ACTIONS)
        .describe(w.actions),
      confirm: confirm(w['batch.confirm'])
    }),
    result: z.object({ id: z.string().min(1).max(16).describe(w['result.id']), cancel: z.boolean().optional().describe(w['result.cancel']) }),
    target,
    confirm: confirm(w.confirm)
  }
}

const INPUTS = { anthropic: toolInputs(fieldWords('anthropic')), cua: toolInputs(fieldWords('cua')) } as const
type Inputs = ReturnType<typeof toolInputs>

/** One word shape's field words on a platform: a Windows PC's are made on first use. */
const platformFields = (shape: WordsShape, platform: ComputerPlatform): FieldText =>
  platform === 'mac' ? fieldWords(shape) : (Object.fromEntries(Object.entries(fieldWords(shape)).map(([k, v]) => [k, hostWords(v, platform)])) as FieldText)
const windowsInputs: Partial<Record<WordsShape, Inputs>> = {}
const inputsFor = (shape: WordsShape, platform: ComputerPlatform): Inputs =>
  platform === 'mac' ? INPUTS[shape] : (windowsInputs[shape] ??= toolInputs(platformFields(shape, platform)))

export const ComputerAppsInputSchema = INPUTS.anthropic.apps
export const ComputerObserveInputSchema = INPUTS.anthropic.observe
export const ComputerActInputSchema = INPUTS.anthropic.act
export const ComputerBatchInputSchema = INPUTS.anthropic.batch

export type ComputerAppsInput = z.infer<typeof ComputerAppsInputSchema>
export type ComputerObserveInput = z.infer<typeof ComputerObserveInputSchema>
export type ComputerActInput = z.infer<typeof ComputerActInputSchema>
export type ComputerBatchInput = z.infer<typeof ComputerBatchInputSchema>

/**
 * `computer_result` (heldCalls.ts): the result of a bridged call that answered
 * "Held", by its id, or `cancel: true` to cancel it. Only the bridge lists it;
 * it is none of the four tools, and the host routes it before them.
 */
export const ComputerResultInputSchema = INPUTS.anthropic.result
export type ComputerResultInput = z.infer<typeof ComputerResultInputSchema>

/** After computer_apps' description alone on a thread whose calls cross the Mac bridge (computer/bridge.ts, §27.12). */
export const COMPUTER_BRIDGE_NOTE = " The computer tools act on the user's Mac, where the apps run; this thread runs on another host."

export { COMPUTER_SEARCH_HINT, hostWords, localComputerPlatform, type ComputerPlatform, type ToolShape, type WordsShape } from './descriptions'

/** The anthropic shape's four descriptions. */
export const COMPUTER_TOOL_DESCRIPTIONS: Readonly<Record<ComputerToolName, string>> = Object.fromEntries(
  COMPUTER_TOOL_NAMES.map((n) => [n, toolDescription('anthropic', 'act', n)])
) as Record<ComputerToolName, string>

export interface ComputerToolSpec {
  name: string
  description: string
  input: z.ZodType
}

const specs = new Map<string, readonly ComputerToolSpec[]>()

/**
 * The tools a thread gets, in its word shape: the four, or with `per-verb`
 * computer_apps, computer_observe, computer_batch and one tool per action in
 * computer_act's place. `result` adds computer_result last, for the bridge
 * (codex and Muse); Claude's list never has it.
 */
export function computerToolSpecs(
  shape: WordsShape = 'anthropic',
  tools: ToolShape = 'act',
  opts: { result?: boolean; platform?: ComputerPlatform } = {}
): readonly ComputerToolSpec[] {
  const platform = opts.platform ?? 'mac'
  const key = `${shape}/${tools}${opts.result ? '/result' : ''}${platform === 'mac' ? '' : `/${platform}`}`
  const kept = specs.get(key)
  if (kept) return kept
  const i = inputsFor(shape, platform)
  const d = (n: ComputerToolName | typeof COMPUTER_RESULT_TOOL): string => hostWords(toolDescription(shape, tools, n), platform)
  const apps = { name: 'computer_apps', description: d('computer_apps'), input: i.apps }
  const observe = { name: 'computer_observe', description: d('computer_observe'), input: i.observe }
  const batch = { name: 'computer_batch', description: d('computer_batch'), input: i.batch }
  const result = opts.result ? [{ name: COMPUTER_RESULT_TOOL, description: d(COMPUTER_RESULT_TOOL), input: i.result }] : []
  const made = Object.freeze(
    tools === 'act'
      ? [apps, observe, { name: 'computer_act', description: d('computer_act'), input: i.act }, batch, ...result]
      : [apps, observe, batch, ...perVerbTools(shape, platform), ...result]
  )
  specs.set(key, made)
  return made
}

export const COMPUTER_TOOLS: readonly ComputerToolSpec[] = computerToolSpecs('anthropic', 'act')

/** zod writes these bounds on every integer; they say nothing to a model and cost every Mac thread its tokens. */
function dropSafeBounds(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(dropSafeBounds)
  if (!node || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node)) {
    if ((k === 'minimum' && v === Number.MIN_SAFE_INTEGER) || (k === 'maximum' && v === Number.MAX_SAFE_INTEGER)) continue
    out[k] = dropSafeBounds(v)
  }
  return out
}

/** A tool's input as the JSON Schema an MCP `tools/list` carries (the bridge's `inputSchema`). */
export function computerToolJsonSchema(input: z.ZodType): Record<string, unknown> {
  const { $schema: _schema, ...schema } = z.toJSONSchema(input, { io: 'input' }) as Record<string, unknown>
  return dropSafeBounds(schema) as Record<string, unknown>
}

/**
 * The one-tool-per-verb variant (§9): `computer_left_click`, `computer_type`, …,
 * each with `app`, `window`, `screenshot` and that verb's own parameters,
 * required ones required, and `confirm` on every action that sends input.
 * The host runs each as computer_act with its action.
 */
export function perVerbTools(shape: WordsShape = 'anthropic', platform: ComputerPlatform = 'mac'): ComputerToolSpec[] {
  const w = platformFields(shape, platform)
  const { target, confirm } = inputsFor(shape, platform)
  return COMPUTER_ACTION_NAMES.map((action) => {
    const { required, optional } = ACTION_PARAMS[action]
    const fields: Record<string, z.ZodType> = { ...target }
    for (const p of optional) fields[p] = COMPUTER_ACTION_SHAPE[p].describe(w[p])
    for (const p of required) fields[p] = (COMPUTER_ACTION_SHAPE[p] as z.ZodOptional<z.ZodType>).unwrap().describe(w[p])
    if (!NO_INPUT_ACTIONS.includes(action)) fields.confirm = confirm
    const input = z
      .object(fields)
      .superRefine((v, ctx) => refineAction({ ...(v as Partial<Record<ActionParam, unknown>>), action }, ctx))
    return { name: `computer_${action}`, description: hostWords(perVerbDescription(shape, action), platform), input }
  })
}

// ── the peer payloads (the Bridge path) ─────────────────────────────────

const toolCall = <T extends ComputerToolName, S extends z.ZodType>(tool: T, args: S) =>
  z.object({ tool: z.literal(tool), args, threadId: z.string().min(1), permission: PermissionPolicySchema })

/** A box thread's tool call crossing the Mac bridge. */
export const ComputerToolCallSchema = z.discriminatedUnion('tool', [
  toolCall('computer_apps', ComputerAppsInputSchema),
  toolCall('computer_observe', ComputerObserveInputSchema),
  toolCall('computer_act', ComputerActInputSchema),
  toolCall('computer_batch', ComputerBatchInputSchema)
])
export type ComputerToolCall = z.infer<typeof ComputerToolCallSchema>

/** What comes back: the text without its `screenshot` lines, and the pictures, which the box writes under the thread's attachment dir. */
export const ComputerToolResultSchema = z.object({
  text: z.string(),
  images: z.array(
    z.object({
      /** `step 2` or `observation` */
      label: z.string(),
      /** base64 */
      data: z.string(),
      mimeType: z.string(),
      width: z.number().int().positive(),
      height: z.number().int().positive()
    })
  )
})
export type ComputerToolResult = z.infer<typeof ComputerToolResultSchema>

// ── the tier verdict (§5.2) ─────────────────────────────────────────────

const ClassCountsSchema = z.object({
  click: z.number().int().nonnegative().optional(),
  drag: z.number().int().nonnegative().optional(),
  hover: z.number().int().nonnegative().optional(),
  scroll: z.number().int().nonnegative().optional(),
  key: z.number().int().nonnegative().optional(),
  type: z.number().int().nonnegative().optional()
})

/** Per app: the lowest tier that worked for each class. */
export const TierVerdictSchema = z.object({
  bundleId: z.string().min(1),
  /** the app's own name, the newest seen; absent on a verdict saved before names were kept */
  name: z.string().optional(),
  classes: z.object({
    click: TierSchema.optional(),
    drag: TierSchema.optional(),
    hover: TierSchema.optional(),
    scroll: TierSchema.optional(),
    key: TierSchema.optional(),
    type: TierSchema.optional()
  }),
  /** steps in a row with effect 'none' (or 'uncommitted') at `process` */
  misses: ClassCountsSchema,
  /** steps in a row with effect 'none' or 'uncommitted' at `front` (§26, decision 11) */
  frontMisses: ClassCountsSchema.optional(),
  /**
   * This app's background windows have been seen not key: a process-tier keys
   * step answered `key_window_unavailable`, or a probe found the key window
   * elsewhere. A record, not a ban: the host keeps `process` and retries such
   * a step at the next tier.
   */
  needsKeyWindow: z.boolean().optional(),
  /**
   * Steps in a row with effect 'none' on a learned fallback route (LEARNED_VIAS, §24.1); at
   * VERDICT_MISSES_TO_RAISE the host names the route in `ignored`, so the service runs it last.
   */
  viaMisses: z
    .object({
      hit: z.number().int().nonnegative().optional(),
      caret: z.number().int().nonnegative().optional(),
      'scroll-page': z.number().int().nonnegative().optional(),
      'scroll-into-view': z.number().int().nonnegative().optional()
    })
    .optional(),
  /** when the host last ran `input.probe` on this app, epoch ms: a probe runs once per app */
  probedAt: z.number().int().optional(),
  /** epoch ms */
  updatedAt: z.number().int()
})
export type TierVerdict = z.infer<typeof TierVerdictSchema>

/** The tier a class with no verdict starts at. */
export const DEFAULT_TIER: Tier = 'process'
/** `effect: 'none'` (or `uncommitted`) this many times in a row at a class's tier, then `changed` at the next tier up, raises the verdict. */
export const VERDICT_MISSES_TO_RAISE = 2
/** Where the host keeps an app's verdict. */
export const tierVerdictSetting = (bundleId: string): string => `computer.tiers.${bundleId}`

export * from './stepLines'

/**
 * The text that leads a computer call's pictures when codex gets them as a
 * steer into its running turn (drivers/codex.ts). Worded here first; the
 * Computer model instructions thread owns it from now on.
 */
export const COMPUTER_PICTURES_TEXT = 'The screenshots your last computer call took, in the order its screenshot lines name them.'
