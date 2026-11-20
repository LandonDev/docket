import { existsSync, readFileSync } from 'node:fs'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BROWSER_CAPS, type BrowserState, type BrowserVideo } from '@shared/contract-work-browser'
import type { OutboxItem } from '@shared/contract-work-outbox'
import type { CanvasItem } from '@shared/work'
import { awayVerdict } from '@shared/away'
import { CONFIRM_KIND_INFO } from '@shared/computer/policy'
import { ownerDrivesLine } from '../../computer/run'
import { configureDriveSessions } from '../../computer/drive'
import { canvas } from '../canvas/index'
import { outbox as outboxModule } from '../outbox/index'
import { approveKey, cast, makeRig, readKey, type Rig } from '../outbox/rig'
import { ActStale } from '../outbox/kinds'
import { loadWorkModules } from '../modules'
import { browser, HANDED_BACK, NOT_A_PERSON, NOT_A_PERSON_SETS, NOT_WORK, OWNER_DRIVES } from './index'
import { configureTeamsCarrier, postedPicturePath, TEAMS_UNAVAILABLE, type TeamsCarrier, type TeamsPost } from './teams'

/**
 * The browser pillar on a real database, with the outbox and the canvas
 * mounted beside it (docs/agents/work-browser.md): who drives, a page that
 * needs him, the sources of a page's values, and a Teams reply held until
 * his press and posted once.
 */

let rig: Rig
const posted: { post: TeamsPost; sessionId: string | null }[] = []
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const carrier = (o: { fail?: 'stale' | 'error' } = {}): TeamsCarrier => ({
  async post(post, { sessionId }) {
    if (o.fail === 'stale') throw new ActStale('Teams has no chat named that. Nothing was posted.')
    if (o.fail === 'error') throw new Error('Teams stopped answering')
    posted.push({ post, sessionId })
    return { picture: { data: PNG, mimeType: 'image/png', width: 640, height: 400 } }
  }
})
const text = (r: { content: unknown[] }): string => (r.content as { text?: string }[]).map((c) => c.text ?? '').join('\n')
const tool = (name: string, args: unknown, id = 't-work') => rig.work.tools.call({ id, scope: 'work' }, name, args, new AbortController().signal)
const state = (sessionId = 't-work') => rig.rpc<BrowserState>('work.browser.state', { sessionId })
const drive = (driver: 'agent' | 'owner', by?: Parameters<Rig['rpc']>[2]) => rig.rpc<BrowserState>('work.browser.drive', { sessionId: 't-work', driver }, by)
const browserPushes = () => rig.pushes.filter((p) => p.push === 'work.browser').map((p) => (p as { state: BrowserState }).state)

// The outbox finds a pillar's act kinds in the loaded module list, as at boot.
beforeAll(async () => {
  await loadWorkModules()
})
beforeEach(async () => {
  posted.length = 0
  rig = await makeRig({ modules: [outboxModule, canvas, browser] })
  cast(rig)
})
afterEach(async () => {
  configureTeamsCarrier(null)
  await rig.close()
})

describe('the live browser', () => {
  it('opens one browser item in the pane, says the site, and opens the same item again', async () => {
    expect(text(await tool('browser_open', { url: 'https://arbitersports.com/availability', name: 'Arbiter', title: 'My availability' }))).toBe(
      'The browser is open beside the thread on arbitersports.com.'
    )
    await tool('browser_open', { url: 'https://arbitersports.com/availability', name: 'Arbiter', title: 'My availability' })
    const { items } = await rig.rpc<{ items: CanvasItem[] }>('work.canvas.list', { sessionId: 't-work' })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'browser', title: 'My availability', source: { at: 'browser', host: 'env_box', sessionId: 't-work' } })
    expect(await state()).toMatchObject({ driver: 'agent', needs: null, site: { url: 'https://arbitersports.com/availability', name: 'Arbiter' }, sources: [] })
  })

  it("a subagent's browser shows in its root thread's pane, and handing back wakes the subagent that was driving", async () => {
    rig.thread('t-sub', { scope: 'work', workspaceId: 'ws-purdue', parentId: 't-work' } as never)
    await tool('browser_open', { url: 'https://example.test/form?code=one-time#x', name: 'Example', title: 'Form' }, 't-sub')
    expect((await rig.rpc<{ items: CanvasItem[] }>('work.canvas.list', { sessionId: 't-work' })).items.map((i) => i.kind)).toEqual(['browser'])
    // a sign-in link's code reaches no client
    expect((await state('t-work')).site).toEqual({ url: 'https://example.test/form', name: 'Example' })
    await tool('browser_needs_you', { needs: 'Example wants you to sign in' }, 't-sub')
    await drive('owner')
    await drive('agent')
    expect(rig.woke).toEqual([{ sessionId: 't-sub', text: HANDED_BACK }])
  })

  it('takes over only a Work thread', async () => {
    rig.thread('t-plain', { workspaceId: 'ws-code' } as never)
    await expect(rig.rpc('work.browser.drive', { sessionId: 't-plain', driver: 'owner' })).rejects.toThrow(NOT_WORK)
  })

  it('takes over and hands back: a person drives, the thread is woken once he hands back, and every client hears it', async () => {
    await tool('browser_open', { url: 'https://arbitersports.com', name: 'Arbiter', title: 'My availability' })
    rig.pushes.length = 0
    expect(await drive('owner')).toMatchObject({ driver: 'owner' })
    // the agent opening a page while he drives is told to wait
    expect(text(await tool('browser_open', { url: 'https://arbitersports.com', name: 'Arbiter', title: 'My availability' }))).toBe(OWNER_DRIVES)
    expect((await state()).driver).toBe('owner')
    expect(rig.woke).toEqual([])
    expect(await drive('agent', approveKey)).toMatchObject({ driver: 'agent' })
    expect(rig.woke).toEqual([{ sessionId: 't-work', text: HANDED_BACK }])
    // a second hand back wakes nothing: the agent already drives
    await drive('agent')
    expect(rig.woke).toHaveLength(1)
    expect(browserPushes().map((s) => s.driver)).toEqual(['owner', 'owner', 'agent', 'agent'])
  })

  it("refuses the pane's computer calls, a subagent's too, on any turn while he drives, until he hands back", async () => {
    rig.thread('t-sub', { scope: 'work', workspaceId: 'ws-purdue', parentId: 't-work' } as never)
    await tool('browser_open', { url: 'https://arbitersports.com', name: 'Arbiter', title: 'My availability' })
    expect(ownerDrivesLine('t-work')).toBeNull()
    await drive('owner')
    expect(ownerDrivesLine('t-work')).toBe(OWNER_DRIVES)
    expect(ownerDrivesLine('t-sub')).toBe(OWNER_DRIVES)
    await drive('agent')
    expect(ownerDrivesLine('t-work')).toBeNull()
    expect(ownerDrivesLine('t-sub')).toBeNull()
  })

  it("Take over under its old name answers the state as before, and stops the pane's sessions, a subagent's too, once he holds the wheel", async () => {
    rig.thread('t-sub', { scope: 'work', workspaceId: 'ws-purdue', parentId: 't-work' } as never)
    rig.thread('t-other', { scope: 'work', workspaceId: 'ws-purdue' } as never)
    await tool('browser_open', { url: 'https://arbitersports.com', name: 'Arbiter', title: 'My availability' })
    const stopped: { id: string; driver: string }[] = []
    const rows = ['t-work', 't-sub', 't-other'].map((threadId) => ({ threadId, apps: [], lastCallAt: 1, running: null }))
    configureDriveSessions({ sessions: () => ({ sessions: rows as never }), stop: async (id) => (stopped.push({ id, driver: (await state()).driver }), { stopped: true }) })
    try {
      expect(await drive('owner')).toMatchObject({ driver: 'owner', site: { name: 'Arbiter' } })
      expect(stopped).toEqual([
        { id: 't-work', driver: 'owner' },
        { id: 't-sub', driver: 'owner' }
      ])
      stopped.length = 0
      expect(await drive('agent')).toMatchObject({ driver: 'agent' })
      expect(stopped).toEqual([])
    } finally {
      configureDriveSessions(null)
    }
  })

  it('the agent can neither take over nor hand itself back: a model caller is refused', async () => {
    const by = { kind: 'model' as const, caps: ['read', 'operate', 'approve', 'admin'], sessionId: 't-work' }
    for (const driver of ['owner', 'agent'] as const) {
      await expect(browser.handle!({ id: '1', method: 'work.browser.drive', params: { sessionId: 't-work', driver } } as never, rig.work.ctx, by)).rejects.toThrow(NOT_A_PERSON)
    }
    expect(rig.woke).toEqual([])
  })

  it('a page that needs him is the one ask: taking over answers it, and a new site starts clean', async () => {
    await tool('browser_open', { url: 'https://arbitersports.com', name: 'Arbiter', title: 'Sign in' })
    expect(text(await tool('browser_needs_you', { needs: 'Arbiter wants you to sign in' }))).toMatch(/^The browser asks him to take over/)
    expect(await state()).toMatchObject({ driver: 'agent', needs: 'Arbiter wants you to sign in' })
    expect(await drive('owner')).toMatchObject({ driver: 'owner', needs: null })
    await drive('agent')
    await tool('browser_needs_you', { needs: 'Concur wants a code from your phone' })
    await tool('browser_open', { url: 'https://concur.example', name: 'Concur', title: 'Report' })
    expect((await state()).needs).toBeNull()
  })

  it('keeps where each value came from by field, a field named again takes the newer source, and another site drops them', async () => {
    await tool('browser_open', { url: 'https://concur.example/report', name: 'Concur', title: 'Report' })
    await tool('browser_sources', { values: [{ field: 'Hotel', source: 'Hilton folio.pdf, page 1' }, { field: 'Mileage', source: 'From Maps' }] })
    expect(text(await tool('browser_sources', { values: [{ field: 'Mileage', source: '412 miles at $0.447, from Maps' }] }))).toBe('Noted 2 sources.')
    expect((await state()).sources).toEqual([
      { field: 'Hotel', source: 'Hilton folio.pdf, page 1' },
      { field: 'Mileage', source: '412 miles at $0.447, from Maps' }
    ])
    // another page of the same site keeps them; another site drops them
    await tool('browser_open', { url: 'https://concur.example/report/submit', name: 'Concur', title: 'Submit' })
    expect((await state()).sources).toHaveLength(2)
    await tool('browser_open', { url: 'https://arbitersports.com', name: 'Arbiter', title: 'My availability' })
    expect((await state()).sources).toEqual([])
  })

  it("a deleted thread's browser goes with it", async () => {
    await tool('browser_open', { url: 'https://arbitersports.com', name: 'Arbiter', title: 'My availability' })
    await drive('owner')
    browser.sessionsRemoved!(['t-work'], rig.work.ctx)
    expect(await state()).toMatchObject({ driver: 'agent', site: null, since: 0 })
  })

  it('the video setting is on until an admin turns it off, and is no model’s nor a lesser key’s to set', async () => {
    expect(await rig.rpc<BrowserVideo>('work.browser.video', {})).toEqual({ on: true, tools: false })
    expect(await rig.rpc<BrowserVideo>('work.browser.video', { on: false })).toEqual({ on: false, tools: false })
    expect(await rig.rpc<BrowserVideo>('work.browser.video', {})).toEqual({ on: false, tools: false })
    // the socket's gate holds a key to the method's row before the pillar is asked
    expect(BROWSER_CAPS['work.browser.video']).toBe('admin')
    await expect(browser.handle!({ id: '1', method: 'work.browser.video', params: { on: true } } as never, rig.work.ctx, { kind: 'model', sessionId: 't-work' } as never)).rejects.toThrow(NOT_A_PERSON_SETS)
    expect(await rig.rpc<BrowserVideo>('work.browser.video', { on: true })).toEqual({ on: true, tools: false })
  })

  it('a read key reads who drives', async () => {
    await expect(rig.rpc<BrowserState>('work.browser.state', { sessionId: 't-work' }, readKey)).resolves.toMatchObject({ driver: 'agent' })
  })
})

describe('the agent never types a password', () => {
  it('a Work thread asks him a card that cannot be approved ahead for text into a password field, and under Away it is denied', () => {
    expect(CONFIRM_KIND_INFO.password).toMatchObject({ preApprovable: false })
    expect(awayVerdict({ what: 'computer', password: true }, 'work')).toBe('deny')
  })
})

describe('a Teams reply', () => {
  const reply = { chat: 'Esports staff', text: 'Thanks, I will have the travel report in by Friday.' }

  it('is refused where nothing can post it (the box, a host without computer use): nothing is held', async () => {
    const answer = await tool('teams_reply', reply)
    expect(answer.isError).toBe(true)
    expect(text(answer)).toBe(TEAMS_UNAVAILABLE)
    expect(await rig.waiting()).toEqual([])
  })

  it('is held, posted only on his press, once, and its picture is kept for Sent', async () => {
    configureTeamsCarrier(carrier())
    expect(text(await tool('teams_reply', reply))).toMatch(/^Held: Post in Teams to Esports staff: “Thanks, I will have the travel report in by Friday\.”\. It waits/)
    const [item] = await rig.waiting()
    expect(item).toMatchObject({ kind: 'teams.post', state: 'held', verb: 'Post', sessionId: 't-work', payload: reply })
    expect(posted).toEqual([])
    // under Away nothing is released
    rig.away.enabled = true
    expect(posted).toEqual([])
    const sent = await rig.rpc<OutboxItem & { result?: { ref?: { picture?: { path: string } } } }>('work.outbox.send', { ref: item!.ref })
    expect(sent.state).toBe('sent')
    expect(posted).toEqual([{ post: reply, sessionId: 't-work' }])
    // a second press, from another client, posts nothing more
    expect(await rig.rpc<OutboxItem>('work.outbox.send', { ref: item!.ref }, approveKey)).toMatchObject({ state: 'sent' })
    expect(posted).toHaveLength(1)
    const full = await rig.rpc<OutboxItem>('work.outbox.get', { ref: item!.ref })
    expect(full.result).toEqual({ summary: 'Posted in Teams to Esports staff', ref: { chat: 'Esports staff', picture: { mimeType: 'image/png', width: 640, height: 400 } } })
    // the file stays on this host: no client, a read key's list included, is told where it is
    expect(JSON.stringify(await rig.rpc('work.outbox.list', { show: 'all' }, readKey))).not.toContain(rig.dir)
    const path = postedPicturePath(rig.dir, item!.ref.at === 'host' ? item!.ref.id : '', 'image/png')
    expect(existsSync(path)).toBe(true)
    expect(new Uint8Array(readFileSync(path))).toEqual(PNG)
  })

  it('takes no grant: a second reply to the same chat waits for its own press', async () => {
    configureTeamsCarrier(carrier())
    await tool('teams_reply', reply)
    const [item] = await rig.waiting()
    await expect(rig.rpc('work.outbox.grant', { from: item!.ref, matcher: { chat: 'Esports staff' } })).rejects.toThrow()
    await rig.rpc('work.outbox.send', { ref: item!.ref })
    await tool('teams_reply', { ...reply, text: 'One more thing.' })
    expect((await rig.waiting()).map((i) => i.state)).toEqual(['held'])
    expect(posted).toHaveLength(1)
  })

  it('reads stale when nothing was posted, and failed when it may have gone', async () => {
    configureTeamsCarrier(carrier({ fail: 'stale' }))
    await tool('teams_reply', reply)
    const [a] = await rig.waiting()
    expect(await rig.rpc<OutboxItem>('work.outbox.send', { ref: a!.ref })).toMatchObject({ state: 'stale' })
    configureTeamsCarrier(carrier({ fail: 'error' }))
    await tool('teams_reply', reply)
    const [b] = await rig.waiting()
    expect(await rig.rpc<OutboxItem>('work.outbox.send', { ref: b!.ref })).toMatchObject({ state: 'failed' })
  })

  it('held on a host that then loses its carrier reads stale at the press: nothing was posted', async () => {
    configureTeamsCarrier(carrier())
    await tool('teams_reply', reply)
    const [item] = await rig.waiting()
    configureTeamsCarrier(null)
    expect(await rig.rpc<OutboxItem>('work.outbox.send', { ref: item!.ref })).toMatchObject({ state: 'stale' })
    expect(posted).toEqual([])
  })
})
