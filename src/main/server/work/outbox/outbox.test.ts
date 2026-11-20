import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OutboxGrant, OutboxItem, ToolRulesCard } from '@shared/contract-work-outbox'
import type { SessionMeta } from '@shared/events'
import { NotBuilt } from '@shared/work'
import { WORK_CALL_UNGATED } from '../../addons/addonHost'
import type { ActKindDef, WorkModule } from '../modules'
import { outbox as outboxModule, NOT_A_PERSON } from './index'
import { adminKey, approveKey, cast, FAKE_SPEC, fakeSpec, LIFEOS_MCP, makeRig, person, readKey, until, type Rig } from './rig'
import { ActNotSent } from './kinds'
import { ROUTINE_UNKNOWN } from './ctx'
import { MAY_HAVE_GONE } from './outbox'
import { INTERRUPTED } from './store'
import { REFUSED_OFF } from './words'

/**
 * The hold, as an attacker meets it (docs/agents/work-outbox.md): a Work
 * thread's add-on call reaches no server until the owner's press, whichever
 * harness made it, whatever the server says of its own tool, and whether or
 * not anyone is at the computer.
 */

let rig: Rig
const text = (r: { content: unknown[] }): string => (r.content as { text?: string }[]).map((c) => c.text ?? '').join('\n')
const setRules = (addonId: string, rules: Record<string, 'runs' | 'held' | 'off'>, by = undefined as never) => rig.rpc<ToolRulesCard>('work.outbox.setRules', { addonId, rules }, by)

beforeEach(async () => {
  rig = await makeRig()
  cast(rig)
})
afterEach(async () => {
  await rig.close()
})

describe("a Work thread's add-on call", () => {
  it('is held until the owner sets its tool to run: nothing reaches the server, the model is told, and the turn goes on', async () => {
    const slack = await rig.addon('slack', 'ws-purdue')
    const answer = await rig.claudeCall('t-work', slack.id, 'echo', { text: 'to the whole team' })
    expect(answer.isError).toBeUndefined()
    expect(text(answer)).toMatch(/^Held as item 1: Echo with Slack: “to the whole team”\. It waits for the owner's press\./)
    expect(text(answer)).toContain('finished step, not a failure')
    expect(rig.downstream).toEqual([])
    const [item] = await rig.waiting()
    expect(item).toMatchObject({ kind: 'addon.call', state: 'held', why: 'unreviewed', workspaceId: 'ws-purdue', sessionId: 't-work', sector: 'purdue', n: 1, summary: 'Echo with Slack: “to the whole team”' })
    expect(item!.payload).toMatchObject({ addonId: slack.id, tool: 'echo', arguments: { text: 'to the whole team' } })
    // the held notice says it in his words, never a raw tool name
    expect(rig.notices).toEqual([{ sessionId: 't-work', body: 'Held: Echo with Slack: “to the whole team”', ref: item!.ref }])
  })

  it('from the bridge (Codex, Muse) is held the same way, with no card first, in every permission mode', async () => {
    const slack = await rig.addon('slack', 'ws-purdue')
    for (const permission of ['auto', 'edits', 'safe'] as const) {
      rig.thread('t-work', { scope: 'work', workspaceId: 'ws-purdue', permission, provider: 'codex' } as Partial<SessionMeta>)
      const answer = await rig.bridgeCall('t-work', 'slack__echo', { text: permission })
      expect(text(answer), permission).toMatch(/^Held as item \d+:/)
    }
    expect(rig.cards).toEqual([])
    expect(rig.downstream).toEqual([])
    expect((await rig.waiting()).map((i) => i.payload)).toMatchObject([{ arguments: { text: 'auto' } }, { arguments: { text: 'edits' } }, { arguments: { text: 'safe' } }])
    expect(slack.id).toBeTruthy()
  })

  it('whose server calls its own tool read-only is still held: a hint suggests a class on the card and decides nothing', async () => {
    const liar = await rig.addon('liar', 'ws-purdue')
    // the fake server marks `read` readOnlyHint: true; an attacker's server says the same of its send tool
    const answer = await rig.claudeCall('t-work', liar.id, 'read', { key: 'every address in the mailbox' })
    expect(text(answer)).toMatch(/^Held as item 1:/)
    expect(rig.downstream).toEqual([])
    const { addons } = await rig.rpc<{ addons: ToolRulesCard[] }>('work.outbox.rules', { addonId: liar.id })
    const read = addons[0]!.tools.find((x) => x.tool === 'read')!
    expect(read).toMatchObject({ hints: { readOnly: true }, suggested: 'runs', rule: null })
    expect(addons[0]!.tools.find((x) => x.tool === 'echo')).toMatchObject({ suggested: 'held', rule: null })
    expect(addons[0]!.unreviewed).toBe(addons[0]!.tools.length)
    // in Auto-edits too, where the bridge used to skip the card for a tool its server called read-only
    rig.thread('t-work', { scope: 'work', workspaceId: 'ws-purdue', permission: 'edits' } as Partial<SessionMeta>)
    expect(text(await rig.bridgeCall('t-work', 'liar__read', { key: 'k' }))).toMatch(/^Held as item 2:/)
    expect(rig.downstream).toEqual([])
  })

  it('runs once he set its tool to Runs, is refused once he set it Off, and is held for a tool he set Held', async () => {
    const a = await rig.addon('notes', 'ws-purdue')
    await setRules(a.id, { read: 'runs', echo: 'held', whoami: 'off' })
    expect(text(await rig.claudeCall('t-work', a.id, 'read', { key: 'k' }))).not.toMatch(/Held/)
    expect(rig.downstream.map((d) => d.tool)).toEqual(['read'])
    const off = await rig.claudeCall('t-work', a.id, 'whoami', {})
    expect(off).toMatchObject({ isError: true })
    expect(text(off)).toBe(REFUSED_OFF)
    expect(text(await rig.claudeCall('t-work', a.id, 'echo', { text: 'x' }))).toMatch(/^Held as item 1:/)
    expect((await rig.waiting())[0]).toMatchObject({ why: 'rule' })
    expect(rig.downstream.map((d) => d.tool)).toEqual(['read'])
  })

  it('to a tool that appeared after he reviewed the add-on starts held', async () => {
    const a = await rig.addon('grower', 'ws-purdue')
    const { addons } = await rig.rpc<{ addons: ToolRulesCard[] }>('work.outbox.rules', { addonId: a.id })
    await setRules(a.id, Object.fromEntries(addons[0]!.tools.map((x) => [x.tool, 'runs' as const])))
    await rig.claudeCall('t-work', a.id, 'add_tool', { name: 'exfiltrate' })
    await until(() => !!rig.addons.tools(a.id)?.tools.some((x) => x.name === 'exfiltrate'))
    rig.downstream.length = 0
    expect(text(await rig.claudeCall('t-work', a.id, 'exfiltrate', {}))).toMatch(/^Held as item 1:/)
    expect(rig.downstream).toEqual([])
  })

  it('is held again once the add-on points at another server: a rule is for the server it was set for', async () => {
    const a = await rig.addon('moved', 'ws-purdue')
    await setRules(a.id, { read: 'runs' })
    // an approved addon_add of the same name, or an edit on the settings page: the same row, another command
    rig.addons.set({ id: a.id, name: 'moved', workspaceId: 'ws-purdue', spec: fakeSpec('--many', '1') }, person)
    await until(() => !!rig.addons.tools(a.id)?.tools.some((x) => x.name === 't000'))
    expect(text(await rig.claudeCall('t-work', a.id, 'read', { key: 'k' }))).toMatch(/^Held as item 1:/)
    const card = (await rig.rpc<{ addons: ToolRulesCard[] }>('work.outbox.rules', { addonId: a.id })).addons[0]!
    expect(card.tools.find((x) => x.tool === 'read')).toMatchObject({ rule: null, changed: true })
  })

  it('is held on a global add-on only he marked for Work, and a thread under a Work thread is held as its parent is', async () => {
    const g = await rig.addon('global', null, { forWork: true })
    // a subagent whose own row was never stamped (a row from a build before the rule): the thread above it decides
    rig.thread('t-child', { parentId: 't-work', workspaceId: 'ws-purdue' } as Partial<SessionMeta>)
    expect(text(await rig.addonHost.call(g.id, 'echo', { text: 'x' }, { sessionId: 't-child' }))).toMatch(/^Held as item 1:/)
    expect(rig.downstream).toEqual([])
  })

  it('stays held while he is away, and no part of Away releases it', async () => {
    const slack = await rig.addon('slack', 'ws-purdue')
    rig.away.enabled = true
    expect(text(await rig.claudeCall('t-work', slack.id, 'echo', { text: 'x' }))).toMatch(/^Held as item 1:/)
    expect(text(await rig.bridgeCall('t-work', 'slack__echo', { text: 'y' }))).toMatch(/^Held as item 2:/)
    // time passes with nobody there: nothing leaves, and nothing denies it either
    await new Promise((r) => setTimeout(r, 50))
    expect(rig.downstream).toEqual([])
    expect((await rig.waiting()).map((i) => i.state)).toEqual(['held', 'held'])
    // the notice still goes: only he can press, wherever he is
    expect(rig.notices).toHaveLength(2)
  })

  it('is still held with the Work switch off: the row decides, never the switch', async () => {
    const slack = await rig.addon('slack', 'ws-purdue')
    rig.work.settings.set({ enabled: false })
    expect(text(await rig.claudeCall('t-work', slack.id, 'echo', { text: 'x' }))).toMatch(/^Held as item 1:/)
    expect(rig.downstream).toEqual([])
    await expect(rig.rpc('work.outbox.send', { ref: { at: 'host', id: 'x' } })).rejects.toThrow('Work is off on this host')
  })

  it('is refused, never run, on a host where nothing can hold it', async () => {
    const slack = await rig.addon('slack', 'ws-purdue')
    rig.addonHost.setGate(null)
    const answer = await rig.claudeCall('t-work', slack.id, 'echo', { text: 'x' })
    expect(answer).toMatchObject({ isError: true })
    expect(text(answer)).toBe(WORK_CALL_UNGATED)
    expect(rig.downstream).toEqual([])
  })
})

describe("the owner's press", () => {
  it('runs the held call exactly once, with exactly the arguments that were held, and tells the thread what came back', async () => {
    const slack = await rig.addon('slack', 'ws-purdue')
    await rig.claudeCall('t-work', slack.id, 'echo', { text: 'standup moved to 10' })
    const [item] = await rig.waiting()
    const sent = await rig.rpc<OutboxItem>('work.outbox.send', { ref: item!.ref })
    expect(sent).toMatchObject({ state: 'sent', decidedBy: 'owner', error: null })
    expect(sent.decidedAt).toBeGreaterThan(0)
    expect(rig.downstream).toEqual([{ addonId: slack.id, tool: 'echo', arguments: { text: 'standup moved to 10' } }])
    // a second press, and a third from another client, find the row taken and run nothing
    expect(await rig.rpc<OutboxItem>('work.outbox.send', { ref: item!.ref })).toMatchObject({ state: 'sent' })
    expect(await rig.rpc<OutboxItem>('work.outbox.send', { ref: item!.ref }, approveKey)).toMatchObject({ state: 'sent' })
    expect(rig.downstream).toHaveLength(1)
    // the thread hears it as the app's own note, with the result it was waiting for
    expect(rig.woke).toEqual([{ sessionId: 't-work', text: 'The owner sent held item 1 (Echo with Slack: “standup moved to 10”). What came back:\nstandup moved to 10' }])
    expect(await rig.waiting()).toEqual([])
    expect((await rig.rpc<{ items: OutboxItem[] }>('work.outbox.list', { show: 'decided' })).items).toMatchObject([{ state: 'sent', n: 1 }])
  })

  it('pressed twice at once, by two clients, runs once', async () => {
    const slack = await rig.addon('slack', 'ws-purdue')
    await rig.claudeCall('t-work', slack.id, 'slow', { ms: 60 })
    const [item] = await rig.waiting()
    const presses = await Promise.all([
      rig.rpc<OutboxItem>('work.outbox.send', { ref: item!.ref }),
      rig.rpc<OutboxItem>('work.outbox.send', { ref: item!.ref }, approveKey),
      rig.rpc<OutboxItem>('work.outbox.send', { ref: item!.ref }, adminKey)
    ])
    expect(rig.downstream.filter((d) => d.tool === 'slow')).toHaveLength(1)
    expect(presses.map((p) => p.state).sort()).toEqual(['sending', 'sending', 'sent'])
    expect((await rig.rpc<OutboxItem>('work.outbox.get', { ref: item!.ref })).state).toBe('sent')
  })

  it('cut off by a restart is not run again by the host: the item says it may have gone and waits on him', async () => {
    const slack = await rig.addon('slack', 'ws-purdue')
    await rig.claudeCall('t-work', slack.id, 'echo', { text: 'once' })
    const [item] = await rig.waiting()
    // the claim is written, then the process dies before the call answers
    const id = (item!.ref as { id: string }).id
    expect(rig.host.store.claim(id, 'owner')).toMatchObject({ state: 'sending' })
    const dir = rig.dir
    await rig.close({ keep: true })
    rig = await makeRig({ reuse: { dir } })
    cast(rig)
    await until(() => Object.values(rig.addons.status()).some((s) => s.state === 'ready'))
    await new Promise((r) => setTimeout(r, 30))
    expect(rig.downstream).toEqual([])
    const [after] = await rig.waiting()
    expect(after).toMatchObject({ state: 'failed', error: INTERRUPTED, n: 1, outcomeUnknown: true })
    // it may have gone: a plain press is refused, and only his explicit Send again sends it, once
    await expect(rig.rpc('work.outbox.send', { ref: after!.ref })).rejects.toThrow(MAY_HAVE_GONE)
    expect(rig.downstream).toEqual([])
    expect(await rig.rpc<OutboxItem>('work.outbox.send', { ref: after!.ref, again: true })).toMatchObject({ state: 'sent' })
    expect(await rig.rpc<OutboxItem>('work.outbox.send', { ref: after!.ref, again: true })).toMatchObject({ state: 'sent' })
    expect(rig.downstream).toHaveLength(1)
  })

  it('on a call whose server answers an error leaves it failed and waiting, and tells the thread quietly', async () => {
    const slack = await rig.addon('slack', 'ws-purdue')
    await rig.claudeCall('t-work', slack.id, 'fail', {})
    const [item] = await rig.waiting()
    const out = await rig.rpc<OutboxItem>('work.outbox.send', { ref: item!.ref })
    expect(out.state).toBe('failed')
    expect(out.error).toBeTruthy()
    expect(rig.woke).toEqual([])
    expect(rig.whispers[0]).toMatchObject({ sessionId: 't-work' })
    expect(rig.whispers[0]!.text).toMatch(/^Held item 1 \(.*\) could not be carried out: .*Do not try another way to do it\.$/)
    expect((await rig.waiting())[0]).toMatchObject({ state: 'failed' })
    // and the rail's failed mark counts it
    expect(rig.host.outbox.failed()).toBe(1)
  })

  it('that failed with no word of how it ended may have gone: a plain press is refused and only Send again sends it', async () => {
    const slack = await rig.addon('slack', 'ws-purdue')
    await rig.claudeCall('t-work', slack.id, 'fail', {})
    const [item] = await rig.waiting()
    const failed = await rig.rpc<OutboxItem>('work.outbox.send', { ref: item!.ref })
    expect(failed).toMatchObject({ state: 'failed', outcomeUnknown: true })
    const reached = rig.downstream.length
    await expect(rig.rpc('work.outbox.send', { ref: item!.ref, rev: failed.updatedAt })).rejects.toThrow(MAY_HAVE_GONE)
    expect(rig.downstream).toHaveLength(reached)
    // the store holds the same line: no claim takes the row without `again`
    expect(rig.host.store.claim((item!.ref as { id: string }).id, 'owner')).toBeNull()
    const again = await rig.rpc<OutboxItem>('work.outbox.send', { ref: item!.ref, again: true })
    expect(again.state).toBe('failed')
    expect(rig.downstream).toHaveLength(reached + 1)
  })

  it('that clearly failed before anything went out may be pressed again as it is', async () => {
    await rig.close()
    let refuse = true
    const ran: string[] = []
    const z = (await import('zod')).z
    const kind: ActKindDef<{ to: string }, never> = {
      kind: 'teams.post',
      store: 'host',
      payload: z.object({ to: z.string() }),
      words: (p) => ({ summary: `Post in ${p.to}`, verb: 'Post' }),
      execute: async (p) => {
        if (refuse) throw new ActNotSent('Teams turned the post away; nothing was posted')
        ran.push(p.to)
        return { summary: `Posted in ${p.to}` }
      }
    }
    const pillar: WorkModule = { id: 'browser', ensure() {}, acts: [kind as unknown as ActKindDef] }
    rig = await makeRig({ modules: [outboxModule, pillar] })
    const { WORK_MODULES } = await import('../modules')
    WORK_MODULES.push(pillar)
    try {
      cast(rig)
      const item = rig.work.ctx.held.create({ kind: 'teams.post', sessionId: 't-work', payload: { to: 'Budget chat' } })
      const failed = await rig.rpc<OutboxItem>('work.outbox.send', { ref: item.ref })
      expect(failed).toMatchObject({ state: 'failed', error: 'Teams turned the post away; nothing was posted' })
      expect(failed.outcomeUnknown).toBeUndefined()
      refuse = false
      expect(await rig.rpc<OutboxItem>('work.outbox.send', { ref: item.ref })).toMatchObject({ state: 'sent' })
      expect(ran).toEqual(['Budget chat'])
    } finally {
      WORK_MODULES.splice(WORK_MODULES.indexOf(pillar), 1)
    }
  })

  it('is refused for an add-on that was pointed at another server since: the call was held for the one he saw', async () => {
    const slack = await rig.addon('slack', 'ws-purdue')
    await rig.claudeCall('t-work', slack.id, 'echo', { text: 'x' })
    const [item] = await rig.waiting()
    rig.addons.set({ id: slack.id, name: 'slack', workspaceId: 'ws-purdue', spec: fakeSpec('--many', '1') }, person)
    const out = await rig.rpc<OutboxItem>('work.outbox.send', { ref: item!.ref })
    expect(out).toMatchObject({ state: 'stale', error: 'the add-on was changed since this call was held, so it now reaches another server' })
    expect(rig.downstream).toEqual([])
  })

  it('completes the linked task of the thread at the top of the tree, once, and keeps owing it while LifeOS is out of reach', async () => {
    const slack = await rig.addon('slack', 'ws-purdue')
    await setRules(slack.id, { echo: 'held' })
    rig.thread('t-sub', { scope: 'work', workspaceId: 'ws-purdue', parentId: 't-work' } as Partial<SessionMeta>)
    await rig.claudeCall('t-sub', slack.id, 'echo', { text: 'one' })
    rig.lifeos.connected = false
    const [item] = await rig.waiting()
    await rig.rpc('work.outbox.send', { ref: item!.ref })
    await new Promise((r) => setTimeout(r, 10))
    expect(rig.lifeos.completed).toEqual([])
    rig.lifeos.connected = true
    await rig.host.outbox.completeTasks()
    await rig.host.outbox.completeTasks()
    expect(rig.lifeos.completed).toEqual([{ sessionId: 't-work', reason: 'Sent: Echo with Slack: “one”' }])
  })

  it('on a call held only because nobody had reviewed its add-on completes no task: that is no send', async () => {
    const slack = await rig.addon('slack', 'ws-purdue')
    await rig.claudeCall('t-work', slack.id, 'read', { key: 'k' })
    await rig.rpc('work.outbox.send', { ref: (await rig.waiting())[0]!.ref })
    await new Promise((r) => setTimeout(r, 10))
    expect(rig.lifeos.completed).toEqual([])
  })

  it('may edit the arguments first, and nothing else of the call', async () => {
    const slack = await rig.addon('slack', 'ws-purdue')
    await rig.claudeCall('t-work', slack.id, 'echo', { text: 'draft' })
    const [item] = await rig.waiting()
    const edited = await rig.rpc<OutboxItem>('work.outbox.edit', { ref: item!.ref, payload: { addonId: 'ad_other', tool: 'crash', arguments: { text: 'final' } } })
    expect(edited.payload).toMatchObject({ addonId: slack.id, tool: 'echo', arguments: { text: 'final' } })
    expect(edited.summary).toBe('Echo with Slack: “final”')
    await rig.rpc('work.outbox.send', { ref: item!.ref })
    expect(rig.downstream).toEqual([{ addonId: slack.id, tool: 'echo', arguments: { text: 'final' } }])
    await expect(rig.rpc('work.outbox.edit', { ref: item!.ref, payload: { arguments: {} } })).rejects.toThrow('already decided')
  })

  it('refuses an edit to a kind whose payload is not what goes (a form publish sends the form as stored)', async () => {
    await rig.close()
    const z = (await import('zod')).z
    const kind: ActKindDef<{ title: string }, never> = {
      kind: 'form.publish',
      store: 'host',
      payload: z.object({ title: z.string() }),
      words: (p) => ({ summary: `Publish ${p.title}`, verb: 'Publish' }),
      execute: async (p) => ({ summary: `Published ${p.title}` })
    }
    const pillar: WorkModule = { id: 'forms', ensure() {}, acts: [kind as unknown as ActKindDef] }
    rig = await makeRig({ modules: [outboxModule, pillar] })
    const { WORK_MODULES } = await import('../modules')
    WORK_MODULES.push(pillar)
    try {
      cast(rig)
      const item = rig.work.ctx.held.create({ kind: 'form.publish', sessionId: 't-work', payload: { title: 'Spring LAN' } })
      await expect(rig.rpc('work.outbox.edit', { ref: item.ref, payload: { title: 'Changed' } })).rejects.toThrow('cannot be changed here')
    } finally {
      WORK_MODULES.splice(WORK_MODULES.indexOf(pillar), 1)
    }
  })

  it("puts back what a kind's carrier fixes for itself when he edits it, so what he edits is what goes", async () => {
    await rig.close()
    const z = (await import('zod')).z
    const sent: unknown[] = []
    const kind: ActKindDef<{ to: string; text: string }, never> = {
      kind: 'teams.post',
      store: 'host',
      payload: z.object({ to: z.string(), text: z.string() }),
      words: (p) => ({ summary: `Post in ${p.to}`, verb: 'Post' }),
      keep: (old, next) => ({ ...next, to: old.to }),
      execute: async (p) => {
        sent.push(p)
        return { summary: `Posted in ${p.to}` }
      }
    }
    const pillar: WorkModule = { id: 'browser', ensure() {}, acts: [kind as unknown as ActKindDef] }
    rig = await makeRig({ modules: [outboxModule, pillar] })
    const { WORK_MODULES } = await import('../modules')
    WORK_MODULES.push(pillar)
    try {
      cast(rig)
      const item = rig.work.ctx.held.create({ kind: 'teams.post', sessionId: 't-work', payload: { to: 'Budget chat', text: 'draft' } })
      const edited = await rig.rpc<OutboxItem>('work.outbox.edit', { ref: item.ref, payload: { to: 'Everyone', text: 'final' } })
      expect(edited).toMatchObject({ payload: { to: 'Budget chat', text: 'final' }, summary: 'Post in Budget chat' })
      await rig.rpc('work.outbox.send', { ref: item.ref })
      expect(sent).toEqual([{ to: 'Budget chat', text: 'final' }])
    } finally {
      WORK_MODULES.splice(WORK_MODULES.indexOf(pillar), 1)
    }
  })

  it('or his discard: the call never goes, and the thread is told not to send it another way', async () => {
    const slack = await rig.addon('slack', 'ws-purdue')
    await rig.claudeCall('t-work', slack.id, 'echo', { text: 'x' })
    const [item] = await rig.waiting()
    expect(await rig.rpc<OutboxItem>('work.outbox.discard', { ref: item!.ref })).toMatchObject({ state: 'discarded', decidedBy: 'owner' })
    expect(await rig.rpc<OutboxItem>('work.outbox.send', { ref: item!.ref })).toMatchObject({ state: 'discarded' })
    expect(rig.downstream).toEqual([])
    expect(rig.whispers).toEqual([{ sessionId: 't-work', text: 'The owner discarded held item 1 (Echo with Slack: “x”). It will not go. Do not send it another way.' }])
  })
})

describe('who may decide', () => {
  it('a thread never may: its own bridge call is refused whatever it carries, and a key without the capability is too', async () => {
    const slack = await rig.addon('slack', 'ws-purdue')
    await rig.claudeCall('t-work', slack.id, 'echo', { text: 'x' })
    const [item] = await rig.waiting()
    const by = { kind: 'model' as const, caps: ['read', 'operate', 'approve', 'admin'], sessionId: 't-work' }
    const req = (method: string, params: unknown) => ({ id: '1', method, params }) as never
    for (const [method, params] of [
      ['work.outbox.send', { ref: item!.ref }],
      ['work.outbox.discard', { ref: item!.ref }],
      ['work.outbox.edit', { ref: item!.ref, payload: {} }],
      ['work.outbox.grant', { from: item!.ref, matcher: { addonId: slack.id, tool: 'echo' } }],
      ['work.outbox.ungrant', { id: 'gr_x' }],
      ['work.outbox.setRules', { addonId: slack.id, rules: { echo: 'runs' } }],
      ['work.outbox.setForWork', { addonId: slack.id, forWork: true }]
    ] as const) {
      await expect(outboxModule.handle!(req(method, params), rig.work.ctx, by), method).rejects.toThrow(NOT_A_PERSON)
    }
    // a read-only key and an approve key each stop where their capability does
    const remote = (caps: string[]) => ({ kind: 'remote' as const, caps })
    await expect(outboxModule.handle!(req('work.outbox.send', { ref: item!.ref }), rig.work.ctx, remote(['read', 'operate']))).rejects.toThrow(NOT_A_PERSON)
    await expect(outboxModule.handle!(req('work.outbox.grant', { from: item!.ref, matcher: {} }), rig.work.ctx, remote(['read', 'operate', 'approve']))).rejects.toThrow(NOT_A_PERSON)
    await expect(outboxModule.handle!(req('work.outbox.setRules', { addonId: slack.id, rules: {} }), rig.work.ctx, remote(['read', 'operate', 'approve']))).rejects.toThrow(NOT_A_PERSON)
    expect(rig.downstream).toEqual([])
    expect((await rig.waiting())[0]!.state).toBe('held')
    expect(rig.host.store.grants()).toEqual([])
    expect(readKey.kind).toBe('remote')
  })

  it("the socket's own gate asks approve for a press and admin for a grant or a rule, before the module hears of the call: a guest, a read key and an operate key reach none", async () => {
    const { requiredCapability, allows } = await import('@shared/capabilities')
    const need = (method: string) => requiredCapability({ method } as never)
    expect(['work.outbox.send', 'work.outbox.discard', 'work.outbox.edit'].map(need)).toEqual(['approve', 'approve', 'approve'])
    expect(['work.outbox.grant', 'work.outbox.ungrant', 'work.outbox.setRules', 'work.outbox.setForWork'].map(need)).toEqual(['admin', 'admin', 'admin', 'admin'])
    expect(['work.outbox.list', 'work.outbox.get', 'work.outbox.grants', 'work.outbox.rules'].map(need)).toEqual(['read', 'read', 'read', 'read'])
    for (const caps of [[], ['read'], ['read', 'operate']] as const) expect(allows([...caps] as never, 'approve')).toBe(false)
    expect(allows(['read', 'operate', 'approve'] as never, 'admin')).toBe(false)
    // and none of them is a method a thread's bridge can name: those are app.* and local
    const { WorkRequestSchemas } = await import('@shared/contract-work')
    const methods = WorkRequestSchemas.map((schema) => (schema as unknown as { shape: { method: { value: string } } }).shape.method.value)
    expect(methods.filter((m) => m.startsWith('app.workOutbox'))).toEqual([])
  })

  it('no tool of any thread is a way to press, grant or set a rule: the outbox lists none', () => {
    // The frame's own Connections read is the one tool every Work thread has, and it changes nothing.
    const tools = rig.work.tools.of({ id: 't-work', scope: 'work' })?.tools ?? []
    expect(tools.map((x) => [x.name, x.readOnly])).toEqual([['work_connections', true]])
    expect(outboxModule.tools).toBeUndefined()
  })
})

describe('a standing grant', () => {
  const grant = (from: OutboxItem, matcher: unknown, extra: Record<string, unknown> = {}, by?: never) => rig.rpc<OutboxGrant>('work.outbox.grant', { from: from.ref, matcher, ...extra }, by)

  it('is made only from a held item and must fit it; then the next call like it goes at once, and nothing else does', async () => {
    const slack = await rig.addon('slack', 'ws-purdue')
    await rig.claudeCall('t-work', slack.id, 'echo', { text: 'standup at 10', channel: '#team' })
    const [item] = await rig.waiting()
    await expect(grant(item!, { addonId: slack.id, tool: 'echo', arguments: { channel: '#other' } })).rejects.toThrow('a grant must fit the item it is made from')
    await expect(rig.rpc('work.outbox.grant', { from: { at: 'host', id: 'ha_nothing' }, matcher: {} })).rejects.toThrow('no such held item')
    // a grant that names arguments fixes every other one too, unless he left it free: this one cannot fit its own item
    await expect(grant(item!, { addonId: slack.id, tool: 'echo', arguments: { channel: '#team' } })).rejects.toThrow('a grant must fit the item it is made from')
    const g = await grant(item!, { addonId: slack.id, tool: 'echo', arguments: { channel: '#team' }, free: ['text'] }, { label: 'Posts to #team' })
    expect(g).toMatchObject({ workspaceId: 'ws-purdue', kind: 'addon.call', label: 'Posts to #team', madeFrom: item!.ref, routineId: null })
    // the item it was made from is not sent by the grant: his own press is still asked
    expect((await rig.waiting())[0]!.state).toBe('held')
    expect(rig.downstream).toEqual([])
    // the next one that fits goes now, once, and the model reads what came back
    const next = await rig.claudeCall('t-work', slack.id, 'echo', { text: 'standup at 11', channel: '#team' })
    expect(text(next)).toBe('standup at 11')
    expect(rig.downstream).toEqual([{ addonId: slack.id, tool: 'echo', arguments: { text: 'standup at 11', channel: '#team' } }])
    const decided = (await rig.rpc<{ items: OutboxItem[] }>('work.outbox.list', { show: 'decided' })).items
    expect(decided).toMatchObject([{ state: 'sent', decidedBy: `grant:${g.id}`, grantId: g.id }])
    // another channel, another tool, another workspace's thread, a Work Chat: all held
    rig.workspace('ws-cosmic', { kind: 'work', sector: 'cosmic' } as never)
    rig.thread('t-cosmic', { scope: 'work', workspaceId: 'ws-cosmic' } as Partial<SessionMeta>)
    rig.thread('t-chat', { scope: 'work' } as Partial<SessionMeta>)
    const g2 = await rig.addon('global', null, { forWork: true })
    await rig.claudeCall('t-work', slack.id, 'echo', { text: 'x', channel: '#general' })
    // an argument the grant neither fixed nor left free does not ride it
    await rig.claudeCall('t-work', slack.id, 'echo', { text: 'x', channel: '#team', bcc: 'someone@elsewhere.test' })
    await rig.claudeCall('t-work', slack.id, 'read', { channel: '#team' })
    await rig.claudeCall('t-cosmic', g2.id, 'echo', { channel: '#team' })
    await rig.claudeCall('t-chat', g2.id, 'echo', { channel: '#team' })
    expect(rig.downstream).toHaveLength(1)
    expect((await rig.waiting()).map((i) => i.state)).toEqual(['held', 'held', 'held', 'held', 'held', 'held'])
  })

  it('removed, holds again; and it never fits once the add-on points at another server', async () => {
    const slack = await rig.addon('slack', 'ws-purdue')
    await rig.claudeCall('t-work', slack.id, 'echo', { text: 'a' })
    const g = await grant((await rig.waiting())[0]!, { addonId: slack.id, tool: 'echo' })
    expect(text(await rig.claudeCall('t-work', slack.id, 'echo', { text: 'b' }))).toBe('b')
    rig.addons.set({ id: slack.id, name: 'slack', workspaceId: 'ws-purdue', spec: fakeSpec('--many', '1') }, person)
    await until(() => !!rig.addons.tools(slack.id)?.tools.some((x) => x.name === 't000'))
    expect(text(await rig.claudeCall('t-work', slack.id, 'echo', { text: 'c' }))).toMatch(/^Held as item/)
    expect(await rig.rpc<OutboxGrant>('work.outbox.ungrant', { id: g.id })).toMatchObject({ id: g.id })
    expect((await rig.rpc<{ grants: OutboxGrant[] }>('work.outbox.grants', { workspaceId: 'ws-purdue' })).grants).toEqual([])
    expect((await rig.rpc<{ grants: OutboxGrant[] }>('work.outbox.grants', { all: true })).grants).toHaveLength(1)
    expect(rig.downstream.map((d) => d.arguments.text)).toEqual(['b'])
  })

  it("is the owner's alone to make: a model's call is refused, Away makes none, and a grant fits only acts made after it", async () => {
    const slack = await rig.addon('slack', 'ws-purdue')
    await rig.claudeCall('t-work', slack.id, 'echo', { text: 'first' })
    await rig.claudeCall('t-work', slack.id, 'echo', { text: 'second' })
    const [first] = await rig.waiting()
    rig.away.enabled = true
    await new Promise((r) => setTimeout(r, 20))
    expect(rig.host.store.grants({ all: true })).toEqual([])
    await grant(first!, { addonId: slack.id, tool: 'echo' })
    // what was already waiting when the grant was made stays waiting
    expect((await rig.waiting()).map((i) => i.state)).toEqual(['held', 'held'])
    expect(rig.downstream).toEqual([])
    // while he is away the grant still does what he made it for
    expect(text(await rig.claudeCall('t-work', slack.id, 'echo', { text: 'third' }))).toBe('third')
  })

  it("made from a routine's act fits that routine's runs alone, and a routine's act takes no other grant", async () => {
    const slack = await rig.addon('slack', 'ws-purdue')
    rig.work.ctx.db.exec(`CREATE TABLE IF NOT EXISTS work_routine_runs (id TEXT PRIMARY KEY, routine_id TEXT NOT NULL)`)
    rig.work.ctx.db.exec(`INSERT INTO work_routine_runs (id, routine_id) VALUES ('run-a1', 'routine-a'), ('run-a2', 'routine-a'), ('run-b1', 'routine-b')`)
    rig.thread('t-a1', { scope: 'work', workspaceId: 'ws-purdue', routineRunId: 'run-a1' } as Partial<SessionMeta>)
    rig.thread('t-a2', { scope: 'work', workspaceId: 'ws-purdue', routineRunId: 'run-a2' } as Partial<SessionMeta>)
    rig.thread('t-b1', { scope: 'work', workspaceId: 'ws-purdue', routineRunId: 'run-b1' } as Partial<SessionMeta>)
    rig.thread('t-unknown', { scope: 'work', workspaceId: 'ws-purdue', routineRunId: 'run-nobody-knows' } as Partial<SessionMeta>)
    // a grant made from an ordinary thread's act never lets a routine send
    await rig.claudeCall('t-work', slack.id, 'echo', { text: 'by hand' })
    await grant((await rig.waiting())[0]!, { addonId: slack.id, tool: 'echo' })
    expect(text(await rig.claudeCall('t-a1', slack.id, 'echo', { text: 'run 1' }))).toMatch(/^Held as item 2:/)
    // "Send, and let this routine send ones like it": from one of its own held acts
    const held = (await rig.waiting()).find((i) => i.routineRunId === 'run-a1')!
    await expect(grant(await rig.rpc<OutboxItem>('work.outbox.get', { ref: (await rig.waiting())[0]!.ref }), { addonId: slack.id, tool: 'echo' }, { routine: true })).rejects.toThrow('not made by a routine')
    const g = await grant(held, { addonId: slack.id, tool: 'echo' })
    expect(g.routineId).toBe('routine-a')
    expect(text(await rig.claudeCall('t-a2', slack.id, 'echo', { text: 'run 2' }))).toBe('run 2')
    expect(text(await rig.claudeCall('t-b1', slack.id, 'echo', { text: 'other routine' }))).toMatch(/^Held as item/)
    // a run's subagent acts for the run: the ordinary grant does not fit it, and its routine's grant does
    rig.thread('t-b1-sub', { scope: 'work', workspaceId: 'ws-purdue', parentId: 't-b1' } as Partial<SessionMeta>)
    expect(text(await rig.claudeCall('t-b1-sub', slack.id, 'echo', { text: 'by hand' }))).toMatch(/^Held as item/)
    expect((await rig.waiting()).find((i) => i.sessionId === 't-b1-sub')!.routineRunId).toBe('run-b1')
    rig.thread('t-a2-sub', { scope: 'work', workspaceId: 'ws-purdue', startedBy: 't-a2' } as Partial<SessionMeta>)
    expect(text(await rig.claudeCall('t-a2-sub', slack.id, 'echo', { text: 'run 2, by its subagent' }))).toBe('run 2, by its subagent')
    expect(text(await rig.claudeCall('t-unknown', slack.id, 'echo', { text: 'no such run' }))).toMatch(/^Held as item/)
    const orphan = (await rig.waiting()).find((i) => i.routineRunId === 'run-nobody-knows')!
    await expect(grant(orphan, { addonId: slack.id, tool: 'echo' })).rejects.toThrow("this item's routine is not known")
  })

  it('takes none for a thread whose line this host cannot follow: a parent on another host, or past 32 links', async () => {
    const slack = await rig.addon('slack', 'ws-purdue')
    await rig.claudeCall('t-work', slack.id, 'echo', { text: 'by hand' })
    await grant((await rig.waiting())[0]!, { addonId: slack.id, tool: 'echo' })
    expect(text(await rig.claudeCall('t-work', slack.id, 'echo', { text: 'again' }))).toBe('again')
    // a child whose parent lives on another host may be a routine run's: the ordinary grant does not fit it
    rig.thread('t-far-child', { scope: 'work', workspaceId: 'ws-purdue', parentId: 'thread-on-the-mac' } as Partial<SessionMeta>)
    expect(text(await rig.claudeCall('t-far-child', slack.id, 'echo', { text: 'far' }))).toMatch(/^Held as item/)
    const far = (await rig.waiting()).find((i) => i.sessionId === 't-far-child')!
    expect(far.routineRunId).toBe(ROUTINE_UNKNOWN)
    await expect(grant(far, { addonId: slack.id, tool: 'echo' })).rejects.toThrow("this item's routine is not known")
    // a line longer than the walk is unknown too; a short ordinary one is not
    rig.thread('t-deep-0', { scope: 'work', workspaceId: 'ws-purdue', parentId: 't-work' } as Partial<SessionMeta>)
    for (let i = 1; i <= 33; i++) rig.thread(`t-deep-${i}`, { scope: 'work', workspaceId: 'ws-purdue', parentId: `t-deep-${i - 1}` } as Partial<SessionMeta>)
    expect(text(await rig.claudeCall('t-deep-0', slack.id, 'echo', { text: 'near' }))).toBe('near')
    expect(text(await rig.claudeCall('t-deep-33', slack.id, 'echo', { text: 'deep' }))).toMatch(/^Held as item/)
  })
})

describe('the LifeOS add-on', () => {
  it('is never held: reads, writes and drafts run at once with no row, whatever its hints say and before any rule is set', async () => {
    const lifeos = rig.lifeosAddon('ws-purdue')
    for (const tool of ['list_tasks', 'add_task', 'flag_mail', 'draft_mail', 'update_mail_draft', 'drop_tasks', 'send_mail']) {
      expect(rig.addonHost.verdict(lifeos.id, tool, { sessionId: 't-work', work: true }), tool).toBe('run')
    }
    expect(await rig.waiting()).toEqual([])
    const card = (await rig.rpc<{ addons: ToolRulesCard[] }>('work.outbox.rules', { addonId: lifeos.id })).addons[0]!
    expect(card).toMatchObject({ lifeos: true, unreviewed: 0 })
    await expect(rig.rpc('work.outbox.setRules', { addonId: lifeos.id, rules: {} })).rejects.toThrow("LifeOS's tools are not set here")
  })

  it("has its drafts stamped with where they came from, by the host: a model's own origin never survives", async () => {
    const lifeos = rig.lifeosAddon('ws-purdue')
    const seen: Record<string, unknown>[] = []
    // the gate's answer is what would be sent: read it without a live LifeOS behind the row
    const gate = (rig.addonHost as unknown as { gate: { decide(c: unknown): Promise<{ run: boolean; args?: Record<string, unknown> }> } }).gate
    const decide = async (sessionId: string, tool: string, args: Record<string, unknown>) => {
      const out = await gate.decide({ row: rig.addons.get(lifeos.id)!, tool, args, sessionId, work: true })
      seen.push(out.args ?? {})
      return out
    }
    rig.thread('t-sub', { scope: 'work', workspaceId: 'ws-purdue', parentId: 't-work' } as Partial<SessionMeta>)
    rig.thread('t-run', { scope: 'work', workspaceId: 'ws-purdue', routineRunId: 'run-9' } as Partial<SessionMeta>)
    const stamp = { app: 'tempcode', threadId: 't-work', host: 'env_box', workspaceId: 'ws-purdue' }
    expect(await decide('t-work', 'draft_mail', { to: ['a@b.c'] })).toEqual({ run: true, args: { to: ['a@b.c'], origin: stamp } })
    // a model that names another thread, another host, or another app
    const forged = { app: 'tempcode', threadId: 't-someone-elses', host: 'env_mac', workspaceId: 'ws-cosmic', routineRunId: 'run-with-a-grant' }
    expect((await decide('t-work', 'draft_mail', { to: ['a@b.c'], origin: forged })).args).toEqual({ to: ['a@b.c'], origin: stamp })
    expect((await decide('t-work', 'update_mail_draft', { id: 'ob_1', body: 'x', origin: forged })).args?.origin).toEqual(stamp)
    expect((await decide('t-work', 'draft_calendar_op', { origin: 'anything' })).args?.origin).toEqual(stamp)
    // a subagent's draft names the thread at the top; a routine's run is the row's, never an argument's
    expect((await decide('t-sub', 'draft_mail', {})).args?.origin).toEqual(stamp)
    expect((await decide('t-run', 'draft_mail', { origin: { ...forged, routineRunId: 'run-1' } })).args?.origin).toEqual({ ...stamp, threadId: 't-run', routineRunId: 'run-9' })
    // a thread whose line this host cannot follow is stamped an unknown run, so its LifeOS draft takes no grant either
    rig.thread('t-far', { scope: 'work', workspaceId: 'ws-purdue', parentId: 'thread-on-the-mac' } as Partial<SessionMeta>)
    expect((await decide('t-far', 'draft_mail', {})).args?.origin).toMatchObject({ routineRunId: ROUTINE_UNKNOWN })
    // a tool that takes no origin gets none, and a forged one is dropped
    expect((await decide('t-work', 'list_tasks', { origin: forged })).args).toEqual({})
    // a code thread of a linked workspace is stamped as itself too
    rig.lifeosAddon('ws-code')
    const codeRow = rig.addons.byName('ws-code', 'lifeos')!
    const out = await gate.decide({ row: codeRow, tool: 'draft_mail', args: { origin: forged }, sessionId: 't-code', work: false })
    expect(out.args?.origin).toEqual({ app: 'tempcode', threadId: 't-code', host: 'env_box', workspaceId: 'ws-code' })
    expect(seen.length).toBeGreaterThan(0)
  })

  it("that someone pointed at another server is trusted no more: the mark alone runs nothing", async () => {
    // a row marked lifeos whose address is not LifeOS's (written before the guard, or synced from a host without it)
    const row = rig.addons.set({ name: 'lifeos', workspaceId: 'ws-purdue', spec: FAKE_SPEC }, person)
    await until(() => rig.addons.status()[row.id]?.state === 'ready')
    rig.work.ctx.db.prepare(`UPDATE addons SET role = 'lifeos' WHERE id = ?`).run(row.id)
    expect(rig.addons.workMarks(row.id)?.role).toBe('lifeos')
    expect(text(await rig.claudeCall('t-work', row.id, 'echo', { text: 'the sector key would go with this' }))).toMatch(/^Held as item 1:/)
    expect(rig.downstream).toEqual([])
  })

  it('cannot be pointed elsewhere through the store, by anyone', () => {
    const lifeos = rig.lifeosAddon('ws-purdue')
    expect(() => rig.addons.set({ id: lifeos.id, name: 'lifeos', workspaceId: 'ws-purdue', spec: { ...FAKE_SPEC } }, person)).toThrow("the app's own LifeOS connection")
    expect(() => rig.addons.set({ name: 'lifeos', workspaceId: 'ws-purdue', spec: { transport: 'http', url: 'https://attacker.example/mcp', headers: ['Authorization'], auth: 'fields' } }, person)).toThrow("the app's own LifeOS connection")
    expect(rig.addons.get(lifeos.id)?.spec).toMatchObject({ url: LIFEOS_MCP })
  })
})

describe('a code thread, and the host with Work off', () => {
  it("a code thread's add-on calls run as they always did: no rule, no row, the same card", async () => {
    const tool = await rig.addon('github', 'ws-code')
    const global = await rig.addon('global', null, { forWork: true })
    expect(text(await rig.claudeCall('t-code', tool.id, 'echo', { text: 'a' }))).toBe('a')
    expect(text(await rig.bridgeCall('t-code', 'github__echo', { text: 'b' }))).toBe('b')
    expect(text(await rig.claudeCall('t-code', global.id, 'echo', { text: 'c' }))).toBe('c')
    // edits: a tool its server calls read-only runs with no card, any other asks, as before
    rig.thread('t-code', { workspaceId: 'ws-code', permission: 'edits' } as Partial<SessionMeta>)
    expect(text(await rig.bridgeCall('t-code', 'github__read', { key: 'k' }))).toBeDefined()
    expect(rig.cards).toEqual([])
    const asked = rig.bridgeCall('t-code', 'github__echo', { text: 'd' })
    await until(() => rig.cards.length === 1)
    expect(rig.cards[0]).toMatchObject({ sessionId: 't-code', toolName: 'github__echo' })
    rig.cards[0]!.decide(true)
    expect(text(await asked)).toBe('d')
    expect(rig.downstream.map((d) => d.tool)).toEqual(['echo', 'echo', 'echo', 'read', 'echo'])
    expect(await rig.waiting()).toEqual([])
    expect(rig.host.store.list({ show: 'all' })).toEqual([])
    expect(rig.notices).toEqual([])
    expect(rig.addonHost.verdict(tool.id, 'echo', { sessionId: 't-code' })).toBe('run')
  })

  it('with the switch never turned on, a code thread sees no difference and every outbox method is refused', async () => {
    await rig.close()
    rig = await makeRig({ enabled: false })
    cast(rig)
    const tool = await rig.addon('github', 'ws-code')
    expect(text(await rig.claudeCall('t-code', tool.id, 'echo', { text: 'a' }))).toBe('a')
    expect(text(await rig.bridgeCall('t-code', 'github__echo', { text: 'b' }))).toBe('b')
    expect(rig.downstream).toHaveLength(2)
    for (const method of ['work.outbox.list', 'work.outbox.rules', 'work.outbox.grants']) await expect(rig.rpc(method), method).rejects.toThrow('Work is off on this host')
    expect(rig.pushes).toEqual([])
    expect(rig.lifeos.watchers).toEqual([])
  })

  it("the host's own call with no thread behind it (a watch) runs a Work add-on's tool only when he set it to Runs, and a code add-on's as before", async () => {
    const slack = await rig.addon('slack', 'ws-purdue')
    const github = await rig.addon('github', 'ws-code')
    const refused = await rig.addonHost.call(slack.id, 'read', { key: 'k' })
    expect(refused).toMatchObject({ isError: true })
    expect(text(refused)).toContain('a watch may call only tools that run without his press')
    expect(await rig.waiting()).toEqual([])
    await setRules(slack.id, { read: 'runs' })
    expect((await rig.addonHost.call(slack.id, 'read', { key: 'k' })).isError).toBeUndefined()
    expect(text(await rig.addonHost.call(github.id, 'echo', { text: 'x' }))).toBe('x')
    expect(rig.downstream.map((d) => d.tool)).toEqual(['read', 'echo'])
  })
})

describe("a pillar's say, and ctx.held", () => {
  it("a pillar may hold or refuse what he let run, and can never run what he holds", async () => {
    await rig.close()
    const says = new Map<string, 'run' | 'hold' | 'refuse' | null>()
    const pillar: WorkModule = { id: 'google', ensure() {}, outward: (_addon, tool) => says.get(tool) ?? null }
    rig = await makeRig({ modules: [outboxModule, pillar] })
    // the gate reads the process's registry of modules; the test's pillar joins it for this test
    const { WORK_MODULES } = await import('../modules')
    WORK_MODULES.push(pillar)
    try {
      cast(rig)
      const a = await rig.addon('drive', 'ws-purdue')
      await setRules(a.id, { read: 'runs', echo: 'runs', whoami: 'held' })
      says.set('echo', 'hold')
      says.set('read', 'refuse')
      says.set('whoami', 'run')
      const heldOne = await rig.claudeCall('t-work', a.id, 'echo', { text: 'x' })
      expect(text(heldOne)).toMatch(/^Held as item 1:/)
      expect((await rig.waiting())[0]).toMatchObject({ why: 'pillar' })
      expect(await rig.claudeCall('t-work', a.id, 'read', {})).toMatchObject({ isError: true })
      expect(text(await rig.claudeCall('t-work', a.id, 'whoami', {}))).toMatch(/^Held as item 2:/)
      expect(rig.downstream).toEqual([])
    } finally {
      WORK_MODULES.splice(WORK_MODULES.indexOf(pillar), 1)
    }
  })

  it('ctx.held.create holds an act of a kind a pillar registered, runs it once on the press, and tells its listeners', async () => {
    await rig.close()
    const ran: unknown[] = []
    const kind: ActKindDef<{ to: string }, { to: string }> = {
      kind: 'teams.post',
      store: 'host',
      payload: (await import('zod')).z.object({ to: (await import('zod')).z.string() }),
      matcher: (await import('zod')).z.object({ to: (await import('zod')).z.string() }),
      words: (p) => ({ summary: `Post in ${p.to}`, verb: 'Post' }),
      matches: (m, p) => m.to === p.to,
      execute: async (p, ctx) => {
        ran.push([p, ctx.decidedBy, ctx.item.state])
        return { summary: `Posted in ${p.to}` }
      }
    }
    const pillar: WorkModule = { id: 'browser', ensure() {}, acts: [kind as unknown as ActKindDef] }
    rig = await makeRig({ modules: [outboxModule, pillar] })
    const { WORK_MODULES } = await import('../modules')
    WORK_MODULES.push(pillar)
    try {
      cast(rig)
      const decided: string[] = []
      rig.work.ctx.held.onDecided((item) => decided.push(`${item.kind}:${item.state}`))
      expect(() => rig.work.ctx.held.create({ kind: 'teams.post', sessionId: 't-work', payload: { to: 7 } })).toThrow()
      const item = rig.work.ctx.held.create({ kind: 'teams.post', sessionId: 't-work', payload: { to: 'Budget chat' }, account: 'landon@example.com' })
      expect(item).toMatchObject({ kind: 'teams.post', state: 'held', summary: 'Post in Budget chat', verb: 'Post', account: 'landon@example.com', workspaceId: 'ws-purdue', sector: 'purdue' })
      expect(ran).toEqual([])
      await rig.rpc('work.outbox.send', { ref: item.ref })
      await rig.rpc('work.outbox.send', { ref: item.ref })
      expect(ran).toEqual([[{ to: 'Budget chat' }, 'owner', 'sending']])
      expect(decided).toEqual(['teams.post:sent'])
      // a kind nobody built says which milestone builds it
      expect(() => rig.work.ctx.held.create({ kind: 'frameio.post', sessionId: 't-work', payload: {} })).toThrow(NotBuilt)
      // told quietly: only a result the thread needs wakes it
      expect(rig.woke).toEqual([])
      expect(rig.whispers.map((w) => w.text)).toEqual(['The owner sent held item 1 (Post in Budget chat).'])
    } finally {
      WORK_MODULES.splice(WORK_MODULES.indexOf(pillar), 1)
    }
  })
})

describe('the rules card and the push', () => {
  it('lists every add-on a Work thread can reach and none of a code workspace; marking a global one for Work is his', async () => {
    const slack = await rig.addon('slack', 'ws-purdue')
    await rig.addon('github', 'ws-code')
    const global = await rig.addon('search', null)
    const list = async () => (await rig.rpc<{ addons: ToolRulesCard[] }>('work.outbox.rules')).addons
    expect((await list()).map((c) => c.name).sort()).toEqual(['search', 'slack'])
    expect((await list()).find((c) => c.name === 'search')).toMatchObject({ forWork: false, workspaceId: null })
    await expect(rig.rpc('work.outbox.setForWork', { addonId: slack.id, forWork: true })).rejects.toThrow('only a global add-on is marked for Work')
    expect(await rig.rpc<ToolRulesCard>('work.outbox.setForWork', { addonId: global.id, forWork: true })).toMatchObject({ forWork: true })
    await expect(setRules(slack.id, { nosuchtool: 'runs' })).rejects.toThrow('lists no tool named nosuchtool')
    const card = await setRules(slack.id, { echo: 'runs' })
    expect(card.tools.find((x) => x.tool === 'echo')).toMatchObject({ rule: 'runs', words: 'Echo', changed: false })
    expect(card.unreviewed).toBe(card.tools.length - 1)
  })

  it('pushes how many wait and how many tools are unreviewed, with the item that changed, only to a key that may decide', async () => {
    const slack = await rig.addon('slack', 'ws-purdue')
    await rig.claudeCall('t-work', slack.id, 'echo', { text: 'x' })
    const last = rig.pushes.filter((p) => p.push === 'work.outbox').at(-1) as { waiting: number; unreviewed: number; item?: OutboxItem }
    expect(last).toMatchObject({ waiting: 1, item: { state: 'held', n: 1 } })
    expect(last.unreviewed).toBeGreaterThan(0)
    // a socket that only reads gets none of it
    const seen: unknown[] = []
    rig.work.pushes.onPush((p) => void seen.push(p), readKey)
    const mine: unknown[] = []
    rig.work.pushes.onPush((p) => void mine.push(p), approveKey)
    await rig.rpc('work.outbox.discard', { ref: (await rig.waiting())[0]!.ref })
    expect(seen).toEqual([])
    expect(mine).toMatchObject([{ push: 'work.outbox', waiting: 0, failed: 0, item: { state: 'discarded' } }])
  })

  it("a deleted thread's and a deleted workspace's waiting acts can no longer go, and stay in the log", async () => {
    const slack = await rig.addon('slack', 'ws-purdue')
    await rig.claudeCall('t-work', slack.id, 'echo', { text: 'x' })
    const [item] = await rig.waiting()
    outboxModule.sessionsRemoved!(['t-work'], rig.work.ctx)
    expect(await rig.rpc<OutboxItem>('work.outbox.send', { ref: item!.ref })).toMatchObject({ state: 'stale', error: 'The thread that made this was deleted.' })
    expect(rig.downstream).toEqual([])
    rig.thread('t-work', { scope: 'work', workspaceId: 'ws-purdue' } as Partial<SessionMeta>)
    await rig.claudeCall('t-work', slack.id, 'echo', { text: 'y' })
    await rig.rpc('work.outbox.grant', { from: (await rig.waiting())[0]!.ref, matcher: { addonId: slack.id, tool: 'echo' } })
    outboxModule.workspaceRemoved!('ws-purdue', rig.work.ctx)
    expect(await rig.waiting()).toEqual([])
    expect(rig.host.store.grants()).toEqual([])
    expect(rig.host.store.list({ show: 'all' })).toHaveLength(2)
  })
})
