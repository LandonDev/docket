import { suggestedRule, toolWords, type ToolHints, type ToolRule } from '@shared/addons'
import type { AddonRow, AddonSpec, AddonTool } from '@shared/contract-addons'
import type { ToolRuleRow, ToolRulesCard } from '@shared/contract-work-outbox'
import { sha256Hex } from '@shared/sha256'
import { canonical, specDigest, type AddonWorkMarks } from '../../addonStore'
import type { HeldStore, StoredRule } from './store'

/**
 * The rule the owner set for each add-on tool (docs/agents/work-outbox.md):
 * Runs, Held or Off. A tool with no rule is Held. A server's own hints
 * (`readOnlyHint` and the rest) are shown on the card and suggest a class
 * there; they never decide.
 *
 * A rule stands only for the server and the tool it was set for: it is
 * kept with the add-on's spec digest and with a digest of the tool as it
 * was listed (its description and its input schema). Point the add-on at
 * another server, or let the server redefine the tool, and the rule no
 * longer stands, so the tool is Held again until he looks at it.
 */

/** What the rules read of the add-on registry. */
export interface RuleAddons {
  get(id: string): AddonRow | null
  list(): AddonRow[]
  tools(id: string): { tools: AddonTool[] } | null
  toolHints(id: string): Record<string, ToolHints>
  workMarks(id: string): AddonWorkMarks | null
}

/** A tool as it was listed, as one string: what a rule was set for. */
export const toolDigest = (tool: Pick<AddonTool, 'description' | 'inputSchema'>): string => sha256Hex(canonical({ description: tool.description, inputSchema: tool.inputSchema }))

/**
 * Whether a stored rule still stands for the add-on as it is and the tool as it is listed now. A tool this host does
 * not list (the server is down, or dropped it) keeps a Held or Off rule set under the same spec, which only tightens;
 * Runs stands only for the tool listed as it was set for, so a call to an unlisted tool is held, and a watch's refused.
 */
export function stands(rule: StoredRule, row: AddonRow, tool: AddonTool | null): boolean {
  if (rule.specDigest !== specDigest(row.spec)) return false
  if (tool === null) return rule.rule !== 'runs'
  return rule.toolDigest === toolDigest(tool)
}

/** The rule that stands for one tool, or null: none was set, or the one that was set was for another server or another definition of the tool. */
export function standingRule(store: HeldStore, addons: RuleAddons, row: AddonRow, tool: string): StoredRule | null {
  const rule = store.rule(row.id, tool)
  if (!rule) return null
  const listed = addons.tools(row.id)?.tools.find((t) => t.name === tool) ?? null
  return stands(rule, row, listed) ? rule : null
}

/** The spec the host writes for LifeOS: its MCP address, the one header, typed values (work/lifeos/keys.ts `sound`). */
export const isLifeosSpec = (spec: AddonSpec, mcpUrl: string): boolean =>
  spec.transport === 'http' && spec.url === mcpUrl && spec.auth === 'fields' && spec.headers.length === 1 && spec.headers[0] === 'Authorization'

/**
 * Whether a row is this host's LifeOS add-on: marked so, and pointed at
 * LifeOS. The mark alone is not enough. A row someone pointed elsewhere
 * keeps its mark until the store or the LifeOS pass catches up, and a call
 * through it must be held like any other add-on's in that time.
 */
export const isLifeosRow = (addons: RuleAddons, row: AddonRow, mcpUrl: string): boolean => addons.workMarks(row.id)?.role === 'lifeos' && isLifeosSpec(row.spec, mcpUrl)

/** The one card for an add-on: its tools, what its server says of each, the class that suggests, and the rule that stands. */
export function rulesCard(store: HeldStore, addons: RuleAddons, row: AddonRow, mcpUrl: string): ToolRulesCard {
  const hints = addons.toolHints(row.id)
  const listed = addons.tools(row.id)?.tools ?? []
  const lifeos = isLifeosRow(addons, row, mcpUrl)
  const stored = new Map(store.rules(row.id).map((r) => [r.tool, r]))
  const tools: ToolRuleRow[] = listed.map((tool) => {
    const own = { ...(tool.readOnly !== undefined ? { readOnly: tool.readOnly } : {}), ...hints[tool.name] }
    const rule = stored.get(tool.name)
    const standing = rule && stands(rule, row, tool) ? rule : null
    return {
      tool: tool.name,
      words: own.title?.trim() || toolWords(tool.name),
      description: tool.description,
      hints: own,
      suggested: suggestedRule(own),
      rule: standing?.rule ?? null,
      changed: !!rule && !standing
    }
  })
  return {
    addonId: row.id,
    name: row.name,
    workspaceId: row.workspaceId,
    forWork: addons.workMarks(row.id)?.forWork ?? false,
    lifeos,
    // LifeOS's tools are not his to class: its key cannot send and LifeOS holds its own drafts.
    unreviewed: lifeos ? 0 : tools.filter((t) => t.rule === null).length,
    tools
  }
}

/** The owner's answer to the card: each named tool's rule, bound to the add-on and the tool as they stand now. A tool this host does not list is refused: nobody has seen it. */
export function setRules(store: HeldStore, addons: RuleAddons, row: AddonRow, rules: Record<string, ToolRule>, setBy: string): void {
  const listed = new Map((addons.tools(row.id)?.tools ?? []).map((t) => [t.name, t]))
  const hints = addons.toolHints(row.id)
  const missing = Object.keys(rules).filter((name) => !listed.has(name))
  if (missing.length) throw new Error(`refused: ${row.name} lists no tool named ${missing.join(', ')} on this host; a rule is set for a tool that is listed`)
  const digest = specDigest(row.spec)
  for (const [name, rule] of Object.entries(rules)) {
    const tool = listed.get(name)!
    store.setRule({ addonId: row.id, tool: name, rule, hints: { ...(tool.readOnly !== undefined ? { readOnly: tool.readOnly } : {}), ...hints[name] }, specDigest: digest, toolDigest: toolDigest(tool), setBy })
  }
}
