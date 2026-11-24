import { describe, expect, it } from 'vitest'
import type { AddonRow, AddonTool } from '@shared/contract-addons'
import { specDigest } from '../../addonStore'
import type { CallAsk, WorkCtx, WorkModule } from '../modules'
import { addonCallKind, makeAddonGate, sealAddonMatcher, type AddonCallPayload, type CatchDeps } from './catch'
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

  it('fits a call only on the arguments the grant itself names, never one named like an inherited property', () => {
    const held = payload()
    const grant = sealAddonMatcher({ addonId: 'ad1', tool: 'post', arguments: { text: 'hi' } }, held)
    expect(kind.matches!(grant, held)).toBe(true)
    expect(kind.matches!(grant, { ...held, arguments: { text: 'hi', constructor: 'x' } })).toBe(false)
    expect(kind.matches!({ ...grant, arguments: {} }, { ...held, arguments: { toString: 'x' } })).toBe(false)
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

/** A pillar's `callRefusal` (a mail chat's narrowing) is asked of every thread's call, before the LifeOS row runs. */
describe("a pillar's say on one thread's call", () => {
  const url = 'https://lifeos.test/mcp'
  const lifeos = { id: 'lifeos', name: 'LifeOS', enabled: true, workspaceId: null, spec: { transport: 'http', url, auth: 'fields', headers: ['Authorization'] } } as unknown as AddonRow
  const asked: CallAsk[] = []
  const pillar = { id: 'mail', ensure: () => {}, callRefusal: (_ctx: WorkCtx, call: CallAsk) => (asked.push(call), call.sessionId === 'narrow' && call.tool === 'archive_mail' ? 'Offer it instead.' : null) } as unknown as WorkModule
  const gate = makeAddonGate({
    addons: { workMarks: () => ({ role: 'lifeos' }), tools: () => ({ tools: [] }), toolHints: () => ({}) } as unknown as RuleAddons,
    sessions: { get: () => null },
    mcpUrl: () => url,
    isWorkScope: () => true,
    originOf: (threadId: string) => ({ app: 'tempcode', threadId, host: 'box' }),
    modules: () => [pillar],
    ctx: {} as WorkCtx,
    log: () => {}
  } as unknown as CatchDeps)

  it('refuses with its words before the LifeOS row runs, and lets the rest run as before', async () => {
    expect(await gate.decide({ row: lifeos, tool: 'archive_mail', args: {}, sessionId: 'narrow', work: true })).toEqual({ run: false, result: { content: [{ type: 'text', text: 'Offer it instead.' }], isError: true } })
    expect(asked.at(-1)).toEqual({ sessionId: 'narrow', via: 'addon', server: 'lifeos', tool: 'archive_mail' })
    expect(await gate.decide({ row: lifeos, tool: 'archive_mail', args: {}, sessionId: 'other', work: true })).toEqual({ run: true, args: {} })
    expect(await gate.decide({ row: lifeos, tool: 'draft_mail', args: {}, sessionId: 'narrow', work: true })).toEqual({ run: true, args: { origin: { app: 'tempcode', threadId: 'narrow', host: 'box' } } })
    expect(gate.peek({ row: lifeos, tool: 'archive_mail', sessionId: 'narrow', work: true })).toBe('refuse')
  })

  it("is not asked for the host's own call, which has no thread", async () => {
    asked.length = 0
    expect(await gate.decide({ row: lifeos, tool: 'archive_mail', args: {}, sessionId: null, work: true })).toEqual({ run: true, args: {} })
    expect(asked).toEqual([])
  })
})
