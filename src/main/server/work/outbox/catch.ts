import { z } from 'zod'
import { addonTitle } from '@shared/addonNames'
import { suggestedRule, toolWords, type ToolHints } from '@shared/addons'
import type { AddonRow } from '@shared/contract-addons'
import type { HeldWhy } from '@shared/contract-work-outbox'
import type { SessionMeta } from '@shared/events'
import { errorText, type LifeosOrigin, type Verdict } from '@shared/work'
import { canonical, specDigest } from '../../addonStore'
import type { AddonGate, GateAnswer, GatedCall } from '../../addons/addonHost'
import type { AddonCallResult } from '../../addons/addonWire'
import { errorResult } from '../../addons/downstream'
import type { ActKindDef, WorkModule } from '../modules'
import { ActNotSent, ActStale } from './kinds'
import { textOf, type Outbox } from './outbox'
import { isLifeosRow, standingRule, type RuleAddons } from './rules'
import type { HeldStore } from './store'
import { grantedLine, heldLine, REFUSED_NO_HOLD, REFUSED_OFF } from './words'

/**
 * The catch on every add-on call (docs/agents/work-outbox.md). Installed
 * as `AddonHost`'s gate, the one funnel Claude's exposed tools and the
 * bridge's `addon_call` both pass, so no harness reaches a downstream
 * server around it.
 *
 *  - A code thread's call runs, as before Work.
 *  - A Work thread's call runs only when the owner set that tool to Runs.
 *    Set to Off it is refused. Anything else, a tool nobody reviewed
 *    included, is held: the row is written, the model is told so in the
 *    tool's own answer, and the turn goes on. Nothing reaches the server
 *    until his press.
 *  - The LifeOS add-on is never held here: its key cannot send and LifeOS
 *    holds its own drafts. The host stamps where a draft came from into its
 *    arguments, over anything the model put there, for every thread that
 *    calls it (a code thread of a linked workspace too).
 *  - The host's own call with no thread behind it (a watch) runs only a
 *    tool set to Runs.
 *
 * A server's hints decide none of this.
 */

/** LifeOS tools that take the origin of what they make. A tool whose listed input has an `origin` field takes it too. */
export const LIFEOS_ORIGIN_TOOLS = ['draft_mail', 'update_mail_draft', 'draft_calendar_op'] as const

export const AddonCallPayloadSchema = z.object({
  addonId: z.string(),
  /** the add-on's name when the call was held */
  addon: z.string(),
  tool: z.string(),
  /** the tool in words: its server's title, else its name spelled out */
  words: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  /** the server the call was held for: carried out on no other */
  specDigest: z.string(),
  /** what the server said of the tool, for the view; never decisive */
  hints: z.record(z.string(), z.unknown()).optional()
})
export type AddonCallPayload = z.infer<typeof AddonCallPayloadSchema>

/**
 * What a grant fixes for an add-on call: the server, the tool, and the arguments that must be the same. A grant that
 * names arguments fits a call only when every other argument it carries is one he left `free`: a `bcc` the grant never
 * named does not ride it. With no `arguments` it fits any call of the tool. The host adds `specDigest` itself.
 */
export const AddonCallMatcherSchema = z.object({
  addonId: z.string(),
  tool: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  /** arguments that may hold anything, or be left out */
  free: z.array(z.string()).optional(),
  specDigest: z.string().optional()
})
export type AddonCallMatcher = z.infer<typeof AddonCallMatcherSchema>

const firstText = (args: Record<string, unknown>): string | null => {
  for (const value of Object.values(args)) if (typeof value === 'string' && value.trim()) return value.replace(/\s+/g, ' ').trim()
  return null
}
const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/** An add-on call in the owner's words: "Send message with Slack: “Standup moved to 10”". Never a raw tool name. */
export function addonCallWords(p: Pick<AddonCallPayload, 'words' | 'addon' | 'arguments' | 'hints'>): { summary: string; verb: string } {
  const detail = firstText(p.arguments)
  const read = suggestedRule(p.hints as ToolHints | undefined) === 'runs'
  return { summary: `${p.words} with ${addonTitle(p.addon)}${detail ? `: “${cut(detail, 80)}”` : ''}`, verb: read ? 'Run' : 'Send' }
}

export interface CatchDeps {
  outbox: Outbox
  store: HeldStore
  addons: RuleAddons
  sessions: { get(id: string): SessionMeta | null | undefined }
  /** the LifeOS MCP address a sound LifeOS row points at */
  mcpUrl(): string
  /** whether a scope key is a Work workspace's or Work Chats' */
  isWorkScope(workspaceId: string): boolean
  /** where a thread's LifeOS drafts say they came from: the host's own stamp */
  originOf(sessionId: string): LifeosOrigin | null
  modules(): readonly WorkModule[]
  log(line: string): void
}

interface Judged {
  verdict: Verdict
  why: HeldWhy
  lifeos: boolean
}

export function makeAddonGate(deps: CatchDeps): AddonGate {
  /** Whether the call is a Work thread's: by the caller's own word, by its row, or by any thread above it. */
  const workCaller = (call: Pick<GatedCall, 'sessionId' | 'work'>): boolean => {
    if (call.work) return true
    let at = call.sessionId ? deps.sessions.get(call.sessionId) : null
    for (let hops = 0; at && hops < 32; hops++) {
      if (at.scope === 'work') return true
      at = at.parentId ? deps.sessions.get(at.parentId) : null
    }
    return false
  }
  /** Whether a Work thread could reach the row at all: only then does the host's own call need the owner's Runs. */
  const worksRow = (row: AddonRow): boolean => (row.workspaceId === null ? (deps.addons.workMarks(row.id)?.forWork ?? false) : deps.isWorkScope(row.workspaceId))

  const judge = (call: Omit<GatedCall, 'args'>, args: Record<string, unknown> | undefined): Judged => {
    const run: Judged = { verdict: 'run', why: 'rule', lifeos: false }
    // The app's own LifeOS row, pointed at LifeOS: never held, whoever calls, and every thread's drafts are stamped.
    if (isLifeosRow(deps.addons, call.row, deps.mcpUrl())) return { ...run, lifeos: true }
    const host = call.sessionId === null
    if (host ? !worksRow(call.row) : !workCaller(call)) return run
    const rule = standingRule(deps.store, deps.addons, call.row, call.tool)
    let verdict: Verdict = !rule ? 'hold' : rule.rule === 'runs' ? 'run' : rule.rule === 'off' ? 'refuse' : 'hold'
    let why: HeldWhy = rule ? 'rule' : 'unreviewed'
    // A pillar's say on an add-on's tool only ever tightens: it can hold or refuse what he let run, never run what he holds.
    for (const module of deps.modules()) {
      if (!module.outward) continue
      let say: Verdict | null = null
      try {
        say = module.outward(call.row, call.tool, args ?? {})
      } catch (err) {
        deps.log(`outbox: ${module.id}'s say on ${call.row.name}/${call.tool} failed, so the call is held: ${errorText(err)}`)
        say = 'hold'
      }
      if (say === 'refuse') verdict = 'refuse'
      else if (say === 'hold' && verdict === 'run') {
        verdict = 'hold'
        why = 'pillar'
      }
    }
    return { verdict, why, lifeos: false }
  }

  /** A LifeOS call's arguments with the host's own origin in them. A value the model supplied never survives. */
  const stamped = (call: GatedCall): Record<string, unknown> => {
    const listed = deps.addons.tools(call.row.id)?.tools.find((t) => t.name === call.tool)
    const takes = (LIFEOS_ORIGIN_TOOLS as readonly string[]).includes(call.tool) || 'origin' in ((listed?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {})
    const { origin: _theirs, ...rest } = call.args
    const origin = takes && call.sessionId ? deps.originOf(call.sessionId) : null
    return origin ? { ...rest, origin } : rest
  }

  const held = async (call: GatedCall, why: HeldWhy): Promise<GateAnswer> => {
    // Nobody to hold it for: the host's own call (a watch) may use only a tool set to Runs.
    if (call.sessionId === null) return { run: false, result: errorResult('refused: the owner has not set this tool to Runs; a watch may call only tools that run without his press') }
    const listed = deps.addons.tools(call.row.id)?.tools.find((t) => t.name === call.tool)
    const hints = { ...(listed?.readOnly !== undefined ? { readOnly: listed.readOnly } : {}), ...deps.addons.toolHints(call.row.id)[call.tool] }
    const payload: AddonCallPayload = {
      addonId: call.row.id,
      addon: call.row.name,
      tool: call.tool,
      words: hints.title?.trim() || toolWords(call.tool),
      arguments: call.args,
      specDigest: specDigest(call.row.spec),
      ...(Object.keys(hints).length ? { hints } : {})
    }
    try {
      const made = deps.outbox.hold({ kind: 'addon.call', sessionId: call.sessionId, payload, why, origin: `addon:${call.row.id}/${call.tool}`, inline: true })
      if (!made.released) return { run: false, result: { content: [{ type: 'text', text: heldLine(made.row) }] } }
      // A standing grant of the owner's fit: the call went now, once, and the model reads what came back.
      const end = await made.released
      if (end.state !== 'sent') return { run: false, result: errorResult(`${grantedLine(end, made.grant!.label)} It failed: ${end.error ?? 'no reason given'}`) }
      const ref = end.result?.ref as { content?: unknown[]; structuredContent?: unknown } | undefined
      return { run: false, result: { content: ref?.content ?? [{ type: 'text', text: textOf(end.result) ?? grantedLine(end, made.grant!.label) }], ...(ref?.structuredContent !== undefined ? { structuredContent: ref.structuredContent } : {}) } }
    } catch (err) {
      // The hold itself failed. Nothing is sent on the strength of a row that was never written.
      deps.log(`outbox: could not hold ${call.row.name}/${call.tool}: ${errorText(err)}`)
      return { run: false, result: errorResult(REFUSED_NO_HOLD) }
    }
  }

  return {
    peek: (call) => judge(call, undefined).verdict,
    async decide(call) {
      const judged = judge(call, call.args)
      if (judged.verdict === 'run') return judged.lifeos ? { run: true, args: stamped(call) } : { run: true }
      if (judged.verdict === 'refuse') return { run: false, result: errorResult(REFUSED_OFF) }
      return held(call, judged.why)
    }
  }
}

/** `addon.call`: the first act kind. Carried out on the server it was held for, through the one door past the gate. */
export function addonCallKind(deps: { addons: RuleAddons; ungated(addonId: string, tool: string, args: Record<string, unknown>): Promise<AddonCallResult> }): ActKindDef<AddonCallPayload, AddonCallMatcher> {
  return {
    kind: 'addon.call',
    store: 'host',
    payload: AddonCallPayloadSchema,
    matcher: AddonCallMatcherSchema,
    words: addonCallWords,
    matches(m, p) {
      // A grant is for one server: without the digest of the server it was made for, it fits nothing.
      if (m.addonId !== p.addonId || m.tool !== p.tool || !m.specDigest || m.specDigest !== p.specDigest) return false
      if (!m.arguments) return true
      const fixed = m.arguments
      if (!Object.keys(p.arguments).every((key) => key in fixed || m.free?.includes(key))) return false
      return Object.entries(fixed).every(([key, value]) => key in p.arguments && canonical(p.arguments[key]) === canonical(value))
    },
    async execute(p) {
      const row = deps.addons.get(p.addonId)
      if (!row) throw new ActStale('the add-on was removed')
      if (specDigest(row.spec) !== p.specDigest) throw new ActStale('the add-on was changed since this call was held, so it now reaches another server')
      if (!row.enabled) throw new ActNotSent(`${row.name} is turned off`)
      const result = await deps.ungated(p.addonId, p.tool, p.arguments)
      const text = textOf({ summary: '', ref: result })
      if (result.isError) throw new Error(text?.trim() || `${row.name} answered with an error`)
      return { summary: `${p.words} with ${addonTitle(p.addon)}`, ref: { content: result.content, ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}) } }
    }
  }
}

/** What the host adds to a grant's matcher before it is kept: the server the held call was for. */
export const sealAddonMatcher = (matcher: AddonCallMatcher, payload: AddonCallPayload): AddonCallMatcher => ({ ...matcher, specDigest: payload.specDigest })
