import { describe, expect, it } from 'vitest'
import { chatSearch, messageSearch } from '../../messages/search'
import type { WorkModule } from '../../modules'
import { OWN_SOURCES } from '../index'
import { listSources, runSearch } from '../run'
import { COSMIC, everywhere, makeRig, onlyPurdue, PURDUE, window } from '../testkit'

/**
 * Pillars that list their own sources: Messages' real ones, asked through
 * the frame with made-up chat rows in a LifeOS in memory. This pillar's own
 * sources and the mention bridge stand down for their kinds, and the frame
 * holds their hits to the reach like any other's.
 */

const messages: WorkModule = { id: 'messages', ensure() {}, search: [messageSearch, chatSearch] }
const chats = (rig: ReturnType<typeof makeRig>): void => {
  rig.rows['chats:search'] = (a: Record<string, unknown>) =>
    a.sector === 'purdue'
      ? [{ chatId: 'c1', messageId: 'r1', chat: '#esports-staff', who: 'Dana Kim', text: 'the pizza budget is approved', at: 50, source: 'slack', sector: 'purdue' }]
      : a.sector === 'cosmic'
        ? [{ chatId: 'c2', messageId: 'r2', chat: 'Sam Ortiz', who: 'Sam Ortiz', text: 'pizza friday?', at: 90, source: 'discord', sector: 'cosmic' }, { chatId: 'c9', messageId: 'r9', chat: 'Elsewhere', who: 'X', text: 'pizza', at: 95, source: 'slack', sector: 'ref' }]
        : []
  rig.rows['chats:find'] = () => []
}

describe("Messages' own sources, through the frame", () => {
  it('are the one provider of their kinds: no source of this pillar and no mention source is asked for them', () => {
    const listed = listSources([{ ...messages, mentions: [{ kind: 'chat', lifeos: true, search: async () => [] }] }], OWN_SOURCES)
    const of = (kind: string) => listed.filter((l) => l.source.kind === kind).map((l) => l.id)
    expect(of('message')).toEqual(['messages.message'])
    expect(of('chat')).toEqual(['messages.chat'])
    expect(OWN_SOURCES.some((s) => s.kind === 'message' || s.kind === 'money')).toBe(false)
  })
  it('find a message in each job in reach, opened in the Messages view on its conversation at the message', async () => {
    const rig = makeRig()
    chats(rig)
    const answer = await runSearch(rig.ctx, { modules: [messages], own: [], reach: everywhere, text: 'pizza', by: window })
    const group = answer.groups.find((g) => g.source === 'messages.message')!
    expect(group.label).toBe('Messages')
    expect(group.hits.map((h) => [h.key, h.workspaceId, h.open])).toEqual([
      ['lifeos:rawMessages:r1', PURDUE, { to: 'view', view: 'messages', with: { chat: 'c1', message: 'r1' } }],
      ['lifeos:rawMessages:r2', COSMIC, { to: 'view', view: 'messages', with: { chat: 'c2', message: 'r2' } }]
    ])
    // a row LifeOS answered from a sector with no job here never comes back
    expect(JSON.stringify(answer)).not.toContain('Elsewhere')
  })
  it('stay inside one job, and are not asked while LifeOS is not connected', async () => {
    const rig = makeRig()
    chats(rig)
    const one = await runSearch(rig.ctx, { modules: [messages], own: [], reach: onlyPurdue, text: 'pizza', by: window })
    expect(one.groups.flatMap((g) => g.hits.map((h) => h.workspaceId))).toEqual([PURDUE])
    rig.lifeosDown()
    const down = await runSearch(rig.ctx, { modules: [messages], own: [], reach: everywhere, text: 'pizza', by: window })
    expect(down.groups).toEqual([])
    expect(down.quiet).toEqual([{ cause: 'lifeos', line: 'This host is not signed in to LifeOS' }])
  })
})
