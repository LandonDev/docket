import { existsSync, readFileSync } from 'node:fs'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { OutboxItem } from '@shared/contract-work-outbox'
import { configureComputerHold, type HeldComputerCall } from '../../computer/run'
import { computerHarness, type ComputerHarness } from '../../computer/runHarness'
import { canvas } from '../canvas/index'
import { loadWorkModules } from '../modules'
import { outbox as outboxModule } from '../outbox/index'
import { ActStale } from '../outbox/kinds'
import { cast, makeRig } from '../outbox/rig'
import { browser } from './index'
import { configureTeamsCarrier, postedPicturePath, teamsCarrier } from './teams'
import { chatsNamed, teamsCarrierOn, typingSteps, wireTeamsCarrier } from './teamsPost'

/**
 * The Teams carrier on the real computer host and the fake service
 * (computer/fakeService.mjs). The fake draws TextEdit; its answers are
 * dressed as Teams on their way into the host, as run.hold.test.ts dresses
 * them as Slack: the app reads as Microsoft Teams, [37] button "close" as
 * the chat "Esports staff", and the text area [3] as an empty message box.
 * Everything past the service (the book, the restage, the hold) is the
 * real code. No live Teams: the Mac was locked.
 */

interface Dress {
  /** [38] button "full screen" reads as a second chat of the same name */
  twin?: boolean
  /** the chat's name as Teams lists it */
  chat?: string
  /** what the message box already holds */
  draft?: string
}
const harnesses: ComputerHarness[] = []
let held: HeldComputerCall[] = []

/** A Work thread's computer session over the fake, its answers dressed as Teams. */
function teams(dress: Dress = {}, thread = 't1'): ComputerHarness {
  const h = computerHarness()
  harnesses.push(h)
  h.set(thread, { scope: 'work' })
  const service = h.service as unknown as { request: (m: string, p: unknown, o?: unknown) => Promise<unknown> }
  const request = service.request.bind(service)
  const text = (s: string): string => {
    let out = s.replace(/^app "TextEdit"/, 'app "Microsoft Teams"').replace(/button "close"/g, `button "${dress.chat ?? 'Esports staff'}"`)
    if (dress.twin) out = out.replace(/button "full screen"/g, `button "${dress.chat ?? 'Esports staff'}"`)
    return out.replace(/(\[3\] text area) = "(?:[^"\\]|\\.)*"/, dress.draft ? `$1 "Type a message" = ${JSON.stringify(dress.draft)}` : '$1 "Type a message"')
  }
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return text(v)
    if (Array.isArray(v)) return v.map(walk)
    if (!v || typeof v !== 'object') return v
    const o = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    if (o.pid === 16800 && o.name === 'TextEdit') Object.assign(o, { name: 'Microsoft Teams', bundleId: 'com.microsoft.teams2' })
    return o
  }
  // what the host asks of "Microsoft Teams" goes to the fake's TextEdit
  const toFake = (v: unknown): unknown => JSON.parse(JSON.stringify(v ?? null).replaceAll('Microsoft Teams', 'TextEdit').replaceAll('com.microsoft.teams2', 'com.apple.TextEdit'))
  service.request = async (m, p, o) => walk(await request(m, toFake(p), o))
  return h
}
const acts = (h: ComputerHarness) => h.requests().filter((r) => r.method === 'action.run' || r.method === 'action.batch')

afterEach(async () => {
  configureComputerHold(null)
  configureTeamsCarrier(null)
  held = []
  for (const h of harnesses.splice(0)) await h.close()
})
const recordHolds = (): void => configureComputerHold({ hold: (call) => (held.push(call), 'Held') })

describe('the Teams carrier', () => {
  it('opens the one chat named exactly so, types the reply into the empty box and sends it with Return, as the press: nothing is held again', async () => {
    recordHolds()
    const h = teams()
    const { picture } = await teamsCarrierOn(h.sessions).post({ chat: 'Esports staff', text: 'In by Friday.' }, { sessionId: 't1' })
    const [click, send] = acts(h)
    expect(acts(h)).toHaveLength(2)
    expect(JSON.stringify(click!.params)).toContain('"element":37')
    expect(JSON.stringify(send!.params)).toContain('In by Friday.')
    expect(JSON.stringify(send!.params)).toContain('"Return"')
    // the Return in the chat's message box would be a live hold for the model; on his press it goes
    expect(held).toEqual([])
    // one picture of the window after it went
    expect(picture).toMatchObject({ mimeType: 'image/jpeg', width: 1280, height: 1072 })
    expect(picture!.data.length).toBeGreaterThan(0)
  })

  it('posts nothing when Teams lists no chat of that exact name, or two', async () => {
    for (const [dress, why] of [
      [{ chat: 'Esports staff (Purdue)' }, /no chat named “Esports staff”/],
      [{ twin: true }, /more than one chat named “Esports staff”/]
    ] as const) {
      const h = teams(dress)
      const post = teamsCarrierOn(h.sessions).post({ chat: 'Esports staff', text: 'x' }, { sessionId: 't1' })
      await expect(post).rejects.toThrow(why)
      await expect(post).rejects.toBeInstanceOf(ActStale)
      expect(acts(h)).toEqual([])
    }
  })

  it('posts nothing over a draft of his in the box: the chat opens, nothing is typed', async () => {
    const h = teams({ draft: 'half a thought' })
    await expect(teamsCarrierOn(h.sessions).post({ chat: 'Esports staff', text: 'x' }, { sessionId: 't1' })).rejects.toThrow('The message box already holds a draft. Nothing was posted.')
    expect(acts(h)).toHaveLength(1)
    expect(JSON.stringify(acts(h)[0]!.params)).not.toContain('Return')
  })

  it('posts nothing for a reply with no thread', async () => {
    const h = teams()
    await expect(teamsCarrierOn(h.sessions).post({ chat: 'Esports staff', text: 'x' }, { sessionId: null })).rejects.toBeInstanceOf(ActStale)
    expect(acts(h)).toEqual([])
  })

  it('is set by the wiring index.ts calls, so a reply can be held at all', () => {
    expect(teamsCarrier()).toBeNull()
    wireTeamsCarrier(teams().sessions)
    expect(teamsCarrier()).not.toBeNull()
  })
})

describe('a held Teams reply, end to end', () => {
  beforeAll(async () => {
    await loadWorkModules()
  })
  it('a Work thread holds it, nothing reaches Teams until his press, then it posts once and its picture is kept', async () => {
    const h = teams({}, 't-work')
    wireTeamsCarrier(h.sessions)
    const rig = await makeRig({ modules: [outboxModule, canvas, browser] })
    try {
      cast(rig)
      await rig.work.tools.call({ id: 't-work', scope: 'work' }, 'teams_reply', { chat: 'Esports staff', text: 'In by Friday.' }, new AbortController().signal)
      const [item] = await rig.waiting()
      expect(item).toMatchObject({ kind: 'teams.post', state: 'held' })
      expect(acts(h)).toEqual([])
      expect(await rig.rpc<OutboxItem>('work.outbox.send', { ref: item!.ref })).toMatchObject({ state: 'sent', result: { ref: { chat: 'Esports staff', picture: { mimeType: 'image/jpeg' } } } })
      expect(acts(h)).toHaveLength(2)
      await rig.rpc('work.outbox.send', { ref: item!.ref })
      expect(acts(h)).toHaveLength(2)
      const path = postedPicturePath(rig.dir, item!.ref.at === 'host' ? item!.ref.id : '', 'image/jpeg')
      expect(existsSync(path) && readFileSync(path).length).toBeGreaterThan(0)
    } finally {
      await rig.close()
    }
  })
})

describe('its pieces', () => {
  it('breaks a line with Shift-Return and sends with Return, every step into the box', () => {
    expect(typingSteps('One\nTwo', 3)).toEqual([
      { action: 'type', element: 3, text: 'One' },
      { action: 'key', element: 3, text: 'shift+Return' },
      { action: 'type', element: 3, text: 'Two' },
      { action: 'key', element: 3, text: 'Return' }
    ])
  })
  it('counts a row and the text inside it as one chat', () => {
    const el = (index: number, role: string, name: string, parent: number | null) => [index, { index, role, name, parent, states: [], actions: [] }] as const
    const screen = { app: { bundleId: null, name: 'Microsoft Teams' }, focused: null, elements: new Map([el(1, 'window', 'Esports staff', null), el(2, 'row', 'Esports staff', 1), el(3, 'static text', 'Esports staff', 2), el(4, 'row', 'Esports', 1)]) }
    expect(chatsNamed(screen, 'Esports staff').map((e) => e.index)).toEqual([2])
  })
})
