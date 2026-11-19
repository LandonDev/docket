import { describe, expect, it } from 'vitest'
import type { AddonRow, AddonTool } from '@shared/contract-addons'
import { specDigest } from '../../addonStore'
import { addonCallKind, sealAddonMatcher, type AddonCallPayload } from './catch'
import { ActStale } from './kinds'
import { toolDigest, type RuleAddons } from './rules'

/** A grant and a held call are for the tool as the server listed it then: a server that redefines the tool gets neither (milestone 50's hold review, finding 8). */
describe('an add-on call held for one definition of its tool', () => {
  const row = { id: 'ad1', name: 'Slack', enabled: true, spec: { transport: 'stdio', command: 'slack-mcp', args: [] } } as unknown as AddonRow
  let listed: AddonTool = { name: 'post', exposed: 'post', description: 'Posts a message in a channel.', inputSchema: { type: 'object' } }
  const addons = { get: () => row, list: () => [row], tools: () => ({ tools: [listed] }), toolHints: () => ({}), workMarks: () => null } as unknown as RuleAddons
  const ran: unknown[] = []
  const kind = addonCallKind({ addons, ungated: async (_id, _tool, args) => (ran.push(args), { content: [{ type: 'text', text: 'ok' }] }) })
  const payload = (): AddonCallPayload => ({ addonId: 'ad1', addon: 'Slack', tool: 'post', words: 'Post', arguments: { text: 'hi' }, specDigest: specDigest(row.spec), toolDigest: toolDigest(listed) })

  it('is granted only while the tool is listed as it was when the grant was made', () => {
    const held = payload()
    const grant = sealAddonMatcher({ addonId: 'ad1', tool: 'post' }, held)
    expect(grant.toolDigest).toBe(held.toolDigest)
    expect(kind.matches!(grant, held)).toBe(true)
    listed = { ...listed, description: 'Posts a message in a channel, and to everyone it names.' }
    expect(kind.matches!(grant, payload())).toBe(false)
    // a grant made before tool digests were sealed fits no call that carries one
    expect(kind.matches!({ addonId: 'ad1', tool: 'post', specDigest: held.specDigest }, held)).toBe(false)
  })

  it('is not carried out once the server lists the tool differently', async () => {
    listed = { name: 'post', exposed: 'post', description: 'Posts a message in a channel.', inputSchema: { type: 'object' } }
    const held = payload()
    await expect(kind.execute(held, {} as never)).resolves.toMatchObject({ summary: 'Post with Slack' })
    listed = { ...listed, inputSchema: { type: 'object', properties: { to: { type: 'string' } } } }
    await expect(kind.execute(held, {} as never)).rejects.toThrow(ActStale)
    // nor once the server stops listing it, nor when it was held with no definition to compare
    listed = { name: 'other', exposed: 'other', description: '', inputSchema: { type: 'object' } }
    await expect(kind.execute(held, {} as never)).rejects.toThrow('no longer lists this tool')
    listed = { name: 'post', exposed: 'post', description: 'Posts a message in a channel.', inputSchema: { type: 'object' } }
    await expect(kind.execute({ ...held, toolDigest: undefined }, {} as never)).rejects.toThrow(ActStale)
    expect(kind.matches!({ addonId: 'ad1', tool: 'post', specDigest: held.specDigest }, { ...held, toolDigest: undefined })).toBe(false)
    expect(ran).toHaveLength(1)
  })
})
