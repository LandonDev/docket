import { describe, expect, it } from 'vitest'
import type { ToolRule } from '@shared/addons'
import type { AddonRow, AddonTool } from '@shared/contract-addons'
import { specDigest } from '../../addonStore'
import { standingRule, toolDigest, type RuleAddons } from './rules'
import type { HeldStore, StoredRule } from './store'

/** A rule stands only for the tool as it was set for: Runs needs the tool listed with that digest (milestone 50's fourth hold pass, finding 27). */
describe('a rule for a tool the server no longer lists', () => {
  const row = { id: 'ad1', name: 'Slack', enabled: true, spec: { transport: 'stdio', command: 'slack-mcp', args: [] } } as unknown as AddonRow
  const post: AddonTool = { name: 'post', exposed: 'post', description: 'Posts a message in a channel.', inputSchema: { type: 'object' } }
  let listed: AddonTool[] = [post]
  const addons = { get: () => row, list: () => [row], tools: () => ({ tools: listed }), toolHints: () => ({}), workMarks: () => null } as unknown as RuleAddons
  const storeWith = (rule: ToolRule): HeldStore => {
    const stored: StoredRule = { addonId: 'ad1', tool: 'post', rule, hints: {}, specDigest: specDigest(row.spec), toolDigest: toolDigest(post), setBy: 'owner', setAt: 1 }
    return { rule: () => stored } as unknown as HeldStore
  }

  it('lets Runs stand only while the tool is listed as it was set for', () => {
    listed = [post]
    expect(standingRule(storeWith('runs'), addons, row, 'post')?.rule).toBe('runs')
    listed = []
    expect(standingRule(storeWith('runs'), addons, row, 'post')).toBeNull()
    listed = [{ ...post, description: 'Posts to everyone it names.' }]
    expect(standingRule(storeWith('runs'), addons, row, 'post')).toBeNull()
  })

  it('keeps Held and Off for an unlisted tool: they only tighten', () => {
    listed = []
    expect(standingRule(storeWith('off'), addons, row, 'post')?.rule).toBe('off')
    expect(standingRule(storeWith('held'), addons, row, 'post')?.rule).toBe('held')
  })
})
