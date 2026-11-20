import { existsSync, readFileSync } from 'node:fs'
import { cutValue } from '@shared/computer/observation'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { OutboxItem } from '@shared/contract-work-outbox'
import { configureComputerHold, type HeldComputerCall } from '../../computer/run'
import { computerHarness, type ComputerHarness } from '../../computer/runHarness'
import { canvas } from '../canvas/index'
import { loadWorkModules } from '../modules'
import { outbox as outboxModule } from '../outbox/index'
import { ActNotSent, ActStale } from '../outbox/kinds'
import { cast, makeRig } from '../outbox/rig'
import { browser } from './index'
import { configureTeamsCarrier, postedPicturePath, teamsCarrier } from './teams'
import { chatOpen, chatsNamed, teamsCarrierOn, typingSteps, wireTeamsCarrier } from './teamsPost'

/**
 * The Teams carrier on the real computer host and the fake service
 * (computer/fakeService.mjs). The fake draws TextEdit; its answers are
 * dressed as Teams on their way into the host, as run.hold.test.ts dresses
 * them as Slack: the app reads as Microsoft Teams, [37] button "close" as
 * the chat "Esports staff", [39] button "minimize" as the open chat's header
 * (a heading of its name), and the text area [3] as an empty message box.
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
  /** the chat Teams shows open, by its header; the listed chat when unset */
  open?: string
  /** a long post the chat shows, as a read-only text area [90]: cut in a window's read, whole in its own element read */
  last?: string
  /** what that post becomes from the host's `at`-th read of the whole window with frames (a press's read) on */
  lastAfter?: { at: number; text: string }
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
  let pressReads = 0
  let last = dress.last
  const lastLine = (whole: boolean): string => `[90] text area "Last post" = ${JSON.stringify(whole ? last! : cutValue(last!))} read-only`
  const withLast = (s: string, element: number | undefined): string => {
    if (last === undefined) return s
    if (element === 90) return s.replace('[90] group "Part"', lastLine(true))
    return element === undefined && /^\[1\] window/m.test(s) ? `${s}\n  ${lastLine(false)}` : s
  }
  const text = (s: string): string => {
    let out = s.replace(/^app "TextEdit"/, 'app "Microsoft Teams"').replace(/button "close"/g, `button "${dress.chat ?? 'Esports staff'}"`)
    out = out.replace(/button "minimize"/g, `heading "${dress.open ?? dress.chat ?? 'Esports staff'}"`)
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
  service.request = async (m, p, o) => {
    const params = (p ?? {}) as { geometry?: boolean; element?: number; mode?: string }
    if (m === 'state.get' && params.geometry === true && params.element === undefined && ++pressReads === dress.lastAfter?.at) last = dress.lastAfter.text
    const answer = await request(m, toFake(p), o)
    const dressed = m === 'state.get' ? JSON.parse(JSON.stringify(answer), (k, v) => (k === 'text' && typeof v === 'string' ? withLast(v, params.element) : v)) : answer
    return walk(dressed)
  }
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

  it("posts nothing when the click lands but Teams still shows another chat open: nothing is typed into Mallory's box", async () => {
    const h = teams({ open: 'Mallory' })
    const post = teamsCarrierOn(h.sessions).post({ chat: 'Esports staff', text: 'the wire details' }, { sessionId: 't1' })
    await expect(post).rejects.toThrow('Teams does not show the chat “Esports staff” open. Nothing was posted.')
    await expect(post).rejects.toBeInstanceOf(ActNotSent)
    expect(acts(h)).toHaveLength(1)
    expect(JSON.stringify(acts(h)[0]!.params)).not.toContain('the wire details')
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

describe('a long post in the chat', () => {
  const last = `Dana: ${'here is the plan for the spring LAN, room by room. '.repeat(6)}Bring the cables.`
  const reply = `Thanks Dana. ${'All set on my side for the spring LAN. '.repeat(5)}See you Friday.`

  it('is bound whole: a post over 160 characters goes on a press with nothing changed', async () => {
    expect(last.length).toBeGreaterThan(160)
    expect(reply.length).toBeGreaterThan(160)
    const h = teams({ last })
    await teamsCarrierOn(h.sessions).post({ chat: 'Esports staff', text: reply }, { sessionId: 't1' })
    expect(acts(h)).toHaveLength(2)
    expect(JSON.stringify(acts(h)[1]!.params)).toContain(reply)
    // the carrier read the long post whole, as the press does
    expect(h.requests().filter((r) => r.method === 'state.get' && r.params.element === 90).length).toBeGreaterThanOrEqual(2)
  })

  it('makes the post stale when the long post changes past what a line shows, and nothing is typed', async () => {
    // the same length, so the line a read prints is the same: only the whole value tells them apart
    const changed = last.replace('Bring the cables.', 'Bring the dollar.')
    expect(cutValue(changed)).toBe(cutValue(last))
    // the second press read is the one before the reply is typed
    const h = teams({ last, lastAfter: { at: 2, text: changed } })
    const post = teamsCarrierOn(h.sessions).post({ chat: 'Esports staff', text: reply }, { sessionId: 't1' })
    await expect(post).rejects.toThrow('Teams changed before the reply went. Nothing was posted.')
    await expect(post).rejects.toBeInstanceOf(ActStale)
    expect(acts(h)).toHaveLength(1)
    expect(JSON.stringify(acts(h))).not.toContain(reply)
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
  it("knows the open chat by its header or the window's title, never by a name that only starts the same", () => {
    const el = (index: number, role: string, name: string, parent: number | null) => [index, { index, role, name, parent, states: [], actions: [] }] as const
    const of = (...els: ReturnType<typeof el>[]) => ({ app: { bundleId: null, name: 'Microsoft Teams' }, focused: null, elements: new Map(els) })
    expect(chatOpen(of(el(1, 'window', 'Microsoft Teams', null), el(2, 'heading', 'Esports staff', 1)), 'Esports staff')).toBe(true)
    expect(chatOpen(of(el(1, 'window', 'Chat | Esports staff | Microsoft Teams', null)), 'Esports staff')).toBe(true)
    expect(chatOpen(of(el(1, 'window', 'Chat | Mallory | Microsoft Teams', null), el(2, 'row', 'Esports staff', 1)), 'Esports staff')).toBe(false)
    expect(chatOpen(of(el(1, 'window', 'Chat | Esports staff (Purdue) | Microsoft Teams', null)), 'Esports staff')).toBe(false)
  })

  it('counts a row and the text inside it as one chat', () => {
    const el = (index: number, role: string, name: string, parent: number | null) => [index, { index, role, name, parent, states: [], actions: [] }] as const
    const screen = { app: { bundleId: null, name: 'Microsoft Teams' }, focused: null, elements: new Map([el(1, 'window', 'Esports staff', null), el(2, 'row', 'Esports staff', 1), el(3, 'static text', 'Esports staff', 2), el(4, 'row', 'Esports', 1)]) }
    expect(chatsNamed(screen, 'Esports staff').map((e) => e.index)).toEqual([2])
  })
})
