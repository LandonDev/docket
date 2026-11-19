import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { configureComputerHold, configureOwnerDrives, HELD_STALE, HELD_UNAVAILABLE, HELD_UNPLACED, HELD_UNREAD, type HeldComputerCall } from './run'
import type { ComputerToolOutcome } from './result'
import { computerHarness, type ComputerHarness } from './runHarness'
import { IDLE_CLOSE_MS } from './sessions'
import { ManualClock } from './testFake'

// The hold on a Work thread's acts (run.ts "the hold on a Work thread's acts", shared/computer/outward.ts).
//
// The fake service names no control for an outward act: TextEdit's tree (fixtures/observations/full.txt) has
// [37] button "close", [21] checkbox "bold" and the focused text area [3], and no app is a chat app. So a test that
// needs a Send button, or a chat app, rewrites the fake's answers on their way into the host (`showing`): [37] reads
// as button "Send", and TextEdit as Slack. Everything past the service, the book, the classifier and the hold, is
// the real code.

const harnesses: ComputerHarness[] = []
const make = (opts: Parameters<typeof computerHarness>[0] = {}): ComputerHarness => {
  const h = computerHarness(opts)
  harnesses.push(h)
  return h
}

/** A hold that records each call and answers the line the model reads. */
let held: HeldComputerCall[] = []
const useHold = (): void => {
  held = []
  configureComputerHold({ hold: (call) => (held.push(call), `Held as item ${held.length}`) })
}

afterEach(async () => {
  configureComputerHold(null)
  configureOwnerDrives(null)
  held = []
  for (const h of harnesses.splice(0)) await h.close()
})

const SEND = 37
const PLAIN = 21

interface Showing {
  /** [37] button "close" reads as button "Send" */
  send?: boolean
  /** [35] menu button "list style" reads as menu button "Send" */
  menuSend?: boolean
  /** TextEdit reads as Slack, a chat app (outward.ts CHAT_APP_BUNDLES) */
  chat?: boolean
  /** the text area's value as every read says it */
  value?: string
  /** the host's own fresh read (geometry, no picture: the press's read and the judge's) numbers every element this much higher */
  shift?: number
  /** a line only the host's own fresh reads (geometry) hold, under the window: the model never sees it */
  unseen?: string
  /** [37] button "close" reads as button "Send" in the host's own fresh reads only: the same number, renamed since the thread's read */
  renamed?: boolean
}
/** Rewrites what the fake answers before the host reads it; change the returned object to change later answers. */
const showing = (h: ComputerHarness, show: Showing): Showing => {
  const service = h.service as unknown as { request: (m: string, p: unknown, o?: unknown) => Promise<unknown> }
  const request = service.request.bind(service)
  const text = (s: string, own: boolean): string => {
    let out = s
    if (own && show.shift) out = out.replace(/\[(\d+)\]/g, (_, n: string) => `[${Number(n) + show.shift!}]`)
    if (own && show.unseen && /^\[1\] window/m.test(out)) out = `${out}\n  ${show.unseen}`
    if (own && show.renamed) out = out.replace(/button "close"/g, 'button "Send"')
    if (show.send) out = out.replace(/button "close"/g, 'button "Send"')
    if (show.menuSend) out = out.replace(/menu button "list style"/g, 'menu button "Send"')
    if (show.chat) out = out.replace(/^app "TextEdit"/, 'app "Slack"')
    if (show.value !== undefined) out = out.replace(/(\[3\] text area = )"(?:[^"\\]|\\.)*"/, `$1${JSON.stringify(show.value)}`)
    return out
  }
  const walk = (v: unknown, own: boolean): unknown => {
    if (typeof v === 'string') return text(v, own)
    if (Array.isArray(v)) return v.map((x) => walk(x, own))
    if (!v || typeof v !== 'object') return v
    const o = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, own)]))
    if (show.chat && o.pid === 16800 && o.name === 'TextEdit') Object.assign(o, { name: 'Slack', bundleId: 'com.tinyspeck.slackmacgap' })
    return o
  }
  service.request = async (m, p, o) => {
    const params = p as { geometry?: boolean; screenshot?: string }
    return walk(await request(m, p, o), m === 'state.get' && params.geometry === true && params.screenshot === 'never')
  }
  return show
}

const acts = (h: ComputerHarness): number => h.requests().filter((r) => r.method === 'action.run' || r.method === 'action.batch').length
const methods = (h: ComputerHarness): string[] => h.requests().map((r) => r.method)
const until = async (pred: () => boolean): Promise<void> => {
  const end = Date.now() + 5_000
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** A thread of the given scope and permission over TextEdit, with Send on the screen, read once. */
const thread = async (
  scope: 'work' | 'code',
  permission: 'safe' | 'edits' | 'auto' = 'auto',
  show: Showing = { send: true },
  opts: Parameters<typeof computerHarness>[0] = {},
  read = true
) => {
  const h = make(opts)
  h.set('t1', { permission, ...(scope === 'work' ? { scope: 'work' as const } : {}) })
  const shown = showing(h, show)
  const app = show.chat ? 'Slack' : 'TextEdit'
  if (read) await h.run('computer_observe', { app })
  return { h, shown, app }
}
const click = (h: ComputerHarness, element: number, extra: Record<string, unknown> = {}, app = 'TextEdit'): Promise<ComputerToolOutcome> =>
  h.run('computer_act', { app, action: 'left_click', element, ...extra })

describe('a Work thread under full access', () => {
  it('holds an unflagged click on Send: the hold gets the call once, nothing is sent, the model reads the line and no card is asked', async () => {
    useHold()
    const { h } = await thread('work')
    const o = await click(h, SEND)
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({ threadId: 't1', tool: 'computer_act', why: 'screen', label: 'Send', app: { name: 'TextEdit', bundleId: 'com.apple.TextEdit' } })
    expect(held[0].read).toMatchObject({ step: 0, why: 'control', label: 'Send', on: 'button "Send"' })
    expect(held[0].targets).toEqual([expect.objectContaining({ step: 0, param: 'element', sig: 'button:Send < window:Untitled', ordinal: 0, count: 1 })])
    expect(held[0].picture?.path && existsSync(held[0].picture.path)).toBe(true)
    expect(acts(h)).toBe(0)
    expect(o).toMatchObject({ isError: false, body: 'Held as item 1', steps: [] })
    expect(h.cards).toHaveLength(0)
  })

  it('runs a click on an element with no outward name, and does not call the hold', async () => {
    useHold()
    const { h } = await thread('work')
    const o = await click(h, PLAIN)
    expect(o.isError).toBe(false)
    expect(acts(h)).toBe(1)
    expect(held).toHaveLength(0)
    expect(h.cards).toHaveLength(0)
  })

  it('holds an act the model flagged on a plain element, as a flag, with no card', async () => {
    useHold()
    const { h } = await thread('work')
    const o = await click(h, PLAIN, { confirm: { kind: 'send', what: 'the note to Dana' } })
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({ why: 'flag', label: 'Send', read: null })
    expect(o).toMatchObject({ isError: false, body: 'Held as item 1' })
    expect(acts(h)).toBe(0)
    expect(h.cards).toHaveLength(0)
  })

  it('holds a pick in the Message menu named Send from its path alone, with the fake unchanged', async () => {
    useHold()
    const h = make()
    h.set('t1', { permission: 'auto', scope: 'work' })
    const o = await h.run('computer_act', { app: 'TextEdit', action: 'left_click', menu: 'Message › Send' })
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({ why: 'screen', label: 'Send', read: { why: 'menu', on: 'menu item "Send"' } })
    expect(o).toMatchObject({ isError: false, body: 'Held as item 1' })
    expect(acts(h)).toBe(0)
  })

  it('runs a pick in the Edit menu named Delete, which only changes what is in front of the person', async () => {
    useHold()
    const h = make()
    h.set('t1', { permission: 'auto', scope: 'work' })
    await h.run('computer_act', { app: 'TextEdit', action: 'left_click', menu: 'Edit › Delete' })
    expect(held).toHaveLength(0)
    expect(acts(h)).toBe(1)
  })
})

describe('a code thread is as it was', () => {
  it('runs the click on Send under full access with no card and never calls the hold', async () => {
    useHold()
    const { h } = await thread('code')
    const o = await click(h, SEND)
    expect(o.isError).toBe(false)
    expect(acts(h)).toBe(1)
    expect(held).toHaveLength(0)
    expect(h.cards).toHaveLength(0)
  })

  it('asks the card for an act the model flagged, under full access, and the hold is not called', async () => {
    useHold()
    const { h } = await thread('code')
    const act = click(h, PLAIN, { confirm: { kind: 'send', what: 'the note to Dana' } })
    await until(() => h.cards.length === 1)
    expect(acts(h)).toBe(0)
    h.cards[0].decide(true)
    expect((await act).isError).toBe(false)
    expect(acts(h)).toBe(1)
    expect(held).toHaveLength(0)
  })
})

describe('a Work thread asking first', () => {
  it('asks the card for a plain act and runs it on Allow', async () => {
    useHold()
    const { h } = await thread('work', 'safe')
    const act = click(h, PLAIN)
    await until(() => h.cards.length === 1)
    expect(acts(h)).toBe(0)
    h.cards[0].decide(true)
    expect((await act).isError).toBe(false)
    expect(acts(h)).toBe(1)
    expect(held).toHaveLength(0)
  })

  it('refuses a plain act on Deny and sends nothing', async () => {
    useHold()
    const { h } = await thread('work', 'safe')
    const act = click(h, PLAIN)
    await until(() => h.cards.length === 1)
    h.cards[0].decide(false)
    expect(await act).toMatchObject({ isError: true, refused: 'denied' })
    expect(acts(h)).toBe(0)
    expect(held).toHaveLength(0)
  })

  it('holds an outward act and asks no card', async () => {
    useHold()
    const { h } = await thread('work', 'safe')
    const o = await click(h, SEND)
    expect(o).toMatchObject({ isError: false, body: 'Held as item 1' })
    expect(held).toHaveLength(1)
    expect(h.cards).toHaveLength(0)
    expect(acts(h)).toBe(0)
  })
})

describe('Return in a chat app', () => {
  it('holds Return with the focus in the message box of a Work thread that has not read the app', async () => {
    useHold()
    const { h, app } = await thread('work', 'auto', { chat: true }, {}, false)
    const o = await h.run('computer_act', { app, action: 'key', text: 'Return' })
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({ why: 'screen', label: 'Send', app: { name: 'Slack', bundleId: 'com.tinyspeck.slackmacgap' }, read: { why: 'key', on: 'Return in text area' } })
    expect(held[0].targets).toEqual([expect.objectContaining({ param: 'focus', sig: 'text area: < scroll area: < window:Untitled' })])
    expect(o).toMatchObject({ isError: false, body: 'Held as item 1' })
    expect(acts(h)).toBe(0)
  })

  it('holds Return in the message box of a Work thread that read the app first', async () => {
    useHold()
    const { h, app } = await thread('work', 'auto', { chat: true })
    const o = await h.run('computer_act', { app, action: 'key', text: 'Return' })
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({ why: 'screen', label: 'Send', read: { why: 'key' } })
    expect(o).toMatchObject({ isError: false, body: 'Held as item 1' })
    expect(acts(h)).toBe(0)
  })

  it('holds a typed line break into the message box of a Work thread that read the app', async () => {
    useHold()
    const { h, app } = await thread('work', 'auto', { chat: true })
    const o = await h.run('computer_act', { app, action: 'type', text: 'see you then\n' })
    expect(held.map((c) => [c.why, c.label, c.read?.why])).toEqual([['screen', 'Send', 'typed']])
    expect(o.isError).toBe(false)
    expect(acts(h)).toBe(0)
  })

  it('holds perform confirm on the message field of a Work thread', async () => {
    useHold()
    const { h, app } = await thread('work', 'auto', { chat: true })
    const o = await h.run('computer_act', { app, action: 'perform', name: 'confirm', element: 3 })
    expect(held.map((c) => [c.why, c.label, c.read?.why])).toEqual([['screen', 'Send', 'key']])
    expect(o.isError).toBe(false)
    expect(acts(h)).toBe(0)
  })

  it('holds the send chord super+Return in a Work thread', async () => {
    useHold()
    const { h, app } = await thread('work', 'auto', { chat: true })
    await h.run('computer_act', { app, action: 'key', text: 'super+Return' })
    expect(held.map((c) => c.read?.why)).toEqual(['chord'])
    expect(acts(h)).toBe(0)
  })

  it('runs Return in the same app in a code thread', async () => {
    useHold()
    const { h, app } = await thread('code', 'auto', { chat: true })
    const o = await h.run('computer_act', { app, action: 'key', text: 'Return' })
    expect(o.isError).toBe(false)
    expect(acts(h)).toBe(1)
    expect(held).toHaveLength(0)
  })
})

describe('a control of two words in the book', () => {
  it('holds a click by element on a menu button named Send that the book read', async () => {
    useHold()
    const { h } = await thread('work', 'auto', { menuSend: true })
    const o = await click(h, 35)
    expect(held).toHaveLength(1)
    expect(held[0].read).toMatchObject({ why: 'control', label: 'Send', on: 'menu button "Send"' })
    expect(o).toMatchObject({ isError: false, body: 'Held as item 1' })
    expect(acts(h)).toBe(0)
  })
})

describe('carrying out a held call', () => {
  it('runs exactly the held click once, with no second judging and no card, even where the thread asks first', async () => {
    useHold()
    const { h } = await thread('work', 'safe')
    await click(h, SEND)
    expect(acts(h)).toBe(0)
    const out = await held[0].carryOut()
    expect(out.isError).toBe(false)
    expect(out.stale).toBeUndefined()
    const sent = h.requests().filter((r) => r.method === 'action.run' || r.method === 'action.batch')
    expect(sent).toHaveLength(1)
    expect(sent[0].params.action).toMatchObject({ action: 'left_click', element: SEND })
    expect(held).toHaveLength(1)
    expect(h.cards).toHaveLength(0)
  })

  it('answers stale and sends nothing when the text area changed since the hold', async () => {
    useHold()
    const { h, shown } = await thread('work')
    await click(h, SEND)
    shown.value = 'Hello from the probe, edited'
    const out = await held[0].carryOut()
    expect(out).toMatchObject({ stale: true, isError: true, body: HELD_STALE })
    expect(acts(h)).toBe(0)
  })

  it('answers stale and sends nothing when the focus a held key goes to moved, with the fake unchanged', async () => {
    useHold()
    const h = make()
    h.set('t1', { permission: 'auto', scope: 'work' })
    await h.run('computer_observe', { app: 'Splitty' })
    // held on the flag: the key goes to the focus, the list [3]
    await h.run('computer_act', { app: 'Splitty', action: 'key', text: 'x', confirm: { kind: 'send', what: 'x' } })
    expect(held[0].targets).toEqual([expect.objectContaining({ param: 'focus', sig: 'list:Files < window:Splitty' })])
    // Return in Splitty is no outward act: it runs and moves the focus to the rename field [8]
    expect((await h.run('computer_act', { app: 'Splitty', action: 'key', text: 'Return' })).isError).toBe(false)
    expect(acts(h)).toBe(1)
    const out = await held[0].carryOut()
    expect(out).toMatchObject({ stale: true, body: HELD_STALE })
    expect(acts(h)).toBe(1)
  })
})

describe('nowhere to hold', () => {
  it('refuses an outward click with HELD_UNAVAILABLE when no hold is configured, and runs no act', async () => {
    configureComputerHold(null)
    const { h } = await thread('work')
    const o = await click(h, SEND)
    expect(o).toMatchObject({ isError: true, body: HELD_UNAVAILABLE })
    expect(acts(h)).toBe(0)
    // refused before the picture read: no read with a picture goes to the service for it
    expect(h.requests().filter((r) => r.method === 'state.get' && r.params.screenshot === 'always')).toHaveLength(0)
  })

  it("refuses a bridged Work call's outward click with HELD_UNAVAILABLE on a thread the registry does not mark Work, and runs its plain click", async () => {
    useHold()
    const { h } = await thread('code')
    const out = await h.sessions.run({ threadId: 't1', work: true }, 'computer_act', { app: 'TextEdit', action: 'left_click', element: SEND })
    expect(out).toMatchObject({ isError: true, body: HELD_UNAVAILABLE })
    expect(held).toHaveLength(0)
    expect(acts(h)).toBe(0)
    expect(h.requests().filter((r) => r.method === 'state.get' && r.params.screenshot === 'always')).toHaveLength(0)
    const plain = await h.sessions.run({ threadId: 't1', work: true }, 'computer_act', { app: 'TextEdit', action: 'left_click', element: PLAIN })
    expect(plain.isError).toBe(false)
    expect(acts(h)).toBe(1)
  })

  it('refuses a bridged call the model flagged with HELD_UNAVAILABLE, with no card', async () => {
    useHold()
    const { h } = await thread('code')
    const out = await h.sessions.run({ threadId: 't1', work: true }, 'computer_act', { app: 'TextEdit', action: 'left_click', element: PLAIN, confirm: { kind: 'send', what: 'x' } })
    expect(out).toMatchObject({ isError: true, body: HELD_UNAVAILABLE })
    expect(h.cards).toHaveLength(0)
    expect(acts(h)).toBe(0)
  })
})

describe('Away', () => {
  it('still holds an outward act of a Work thread and never runs it', async () => {
    useHold()
    const { h } = await thread('work', 'safe')
    h.setAway(true)
    const o = await click(h, SEND)
    expect(o).toMatchObject({ isError: false, body: 'Held as item 1' })
    expect(held).toHaveLength(1)
    expect(acts(h)).toBe(0)
  })

  it('lets a code thread run the same click on its card as before', async () => {
    useHold()
    const { h } = await thread('code', 'safe')
    h.setAway(true)
    const o = await click(h, SEND)
    expect(o.isError).toBe(false)
    expect(acts(h)).toBe(1)
    expect(held).toHaveLength(0)
  })
})

describe('what a Work thread asks of the service', () => {
  it('sends the same requests for an observe as a code thread does', async () => {
    const work = (await thread('work')).h
    const code = (await thread('code')).h
    await work.run('computer_observe', { app: 'TextEdit' })
    await code.run('computer_observe', { app: 'TextEdit' })
    expect(methods(work)).toEqual(methods(code))
  })

  it('sends one fresh full read before a click by element, and only in a Work thread: the number may name another control now', async () => {
    useHold()
    const work = (await thread('work')).h
    const code = (await thread('code')).h
    const before = { work: methods(work).length, code: methods(code).length }
    await click(work, PLAIN)
    await click(code, PLAIN)
    expect(methods(work).slice(before.work)).toEqual(['state.get', ...methods(code).slice(before.code)])
    expect(work.requests()[before.work]!.params).toMatchObject({ mode: 'full', geometry: true, screenshot: 'never' })
  })

  it('sends one fresh full read with frames before a click by position', async () => {
    useHold()
    const work = (await thread('work')).h
    const code = (await thread('code')).h
    const before = { work: work.requests().length, code: code.requests().length }
    for (const h of [work, code]) expect((await h.run('computer_act', { app: 'TextEdit', action: 'left_click', coordinate: [300, 300] })).isError).toBe(false)
    const w = work.requests().slice(before.work)
    const c = code.requests().slice(before.code)
    expect(c.map((r) => r.method)).not.toContain('state.get')
    expect(w.map((r) => r.method)).toEqual(['state.get', ...c.map((r) => r.method)])
    expect(w[0].params).toMatchObject({ mode: 'full', geometry: true, screenshot: 'never' })
    expect(held).toHaveLength(0)
  })
  for (const [what, act] of [
    ['Return to the focus', { action: 'key', text: 'Return' }],
    ['a typed line break to the focus', { action: 'type', text: 'one\ntwo' }]
  ] as const) {
    it(`sends one fresh full read with frames before ${what}, to the focus or to an element by its number`, async () => {
      useHold()
      const work = (await thread('work', 'auto', {})).h
      const code = (await thread('code', 'auto', {})).h
      const before = { work: work.requests().length, code: code.requests().length }
      for (const h of [work, code]) expect((await h.run('computer_act', { app: 'TextEdit', ...act })).isError).toBe(false)
      const w = work.requests().slice(before.work)
      const c = code.requests().slice(before.code)
      expect(w.map((r) => r.method)).toEqual(['state.get', ...c.map((r) => r.method)])
      expect(w[0].params).toMatchObject({ mode: 'full', geometry: true, screenshot: 'never' })
      // to an element by its number it is read afresh too: the number may name another control now
      const named = { work: work.requests().length, code: code.requests().length }
      for (const h of [work, code]) await h.run('computer_act', { app: 'TextEdit', ...act, element: 3 })
      expect(work.requests().slice(named.work).map((r) => r.method)).toEqual(['state.get', ...code.requests().slice(named.code).map((r) => r.method)])
      expect(held).toHaveLength(0)
    })
  }
})

describe('the journal', () => {
  it("does not show a held call's step as one that ran", async () => {
    useHold()
    const { h } = await thread('work', 'auto', { send: true }, { history: { pictures: () => false } })
    await click(h, SEND)
    await h.sessions.drained('t1')
    const call = (await h.history!.read(['t1']))[0].calls.at(-1)!
    expect(call.steps).toHaveLength(1)
    expect(call.steps[0].state).not.toBe('ok')
    expect(call.steps[0]).toMatchObject({ verb: 'Click' })
  })
})

describe('the press after the session closed', () => {
  it('carries out a press after the ten-minute idle close, reading the window afresh and clicking once', async () => {
    useHold()
    const clock = new ManualClock()
    const { h } = await thread('work', 'auto', { send: true }, { clock })
    await click(h, SEND)
    await clock.advance(IDLE_CLOSE_MS)
    await until(() => h.requests().some((r) => r.method === 'session.close'))
    // the fake logs the request before the host has its answer and clears the thread's reads
    await new Promise((r) => setTimeout(r, 100))
    const out = await held[0].carryOut()
    expect(out.isError).toBe(false)
    expect(out.stale).toBeUndefined()
    const log = methods(h)
    expect(acts(h)).toBe(1)
    expect(log.indexOf('action.run')).toBeGreaterThan(log.indexOf('session.close'))
    expect(h.requests().find((r) => r.method === 'action.run')!.params.action).toMatchObject({ action: 'left_click', element: SEND })
  })

  it('carries out a press after Stop, and the Stop still answers the thread its own next call', async () => {
    useHold()
    const { h } = await thread('work')
    await click(h, SEND)
    await h.sessions.stop('t1')
    expect((await h.run('computer_observe', { app: 'TextEdit' })).refused).toBe('stopped')
    const pressed = await held[0].carryOut()
    expect(pressed.isError).toBe(false)
    expect(acts(h)).toBe(1)
    expect((await h.run('computer_observe', { app: 'TextEdit' })).refused).toBe('stopped')
    expect((await click(h, PLAIN)).refused).toBe('stopped')
    expect(acts(h)).toBe(1)
  })
})

describe('the press finds its targets again', () => {
  it('answers stale and sends nothing when the Send button is gone from the read the press takes', async () => {
    useHold()
    const { h, shown } = await thread('work')
    await click(h, SEND)
    shown.send = false
    const out = await held[0].carryOut()
    expect(out).toMatchObject({ stale: true, body: HELD_STALE })
    expect(acts(h)).toBe(0)
  })

  it('clicks the new index when the service numbered the window anew', async () => {
    useHold()
    const { h, shown } = await thread('work')
    await click(h, SEND)
    shown.shift = 100
    const out = await held[0].carryOut()
    expect(out.isError).toBe(false)
    const sent = h.requests().filter((r) => r.method === 'action.run')
    expect(sent).toHaveLength(1)
    expect(sent[0].params.action).toMatchObject({ action: 'left_click', element: SEND + 100 })
  })
})

describe('a flagged open', () => {
  const open = { launch: 'Preview', open: ['/tmp/a.pdf'], confirm: { kind: 'send' as const, what: 'the signed form' } }

  it('holds a flagged open in a Work thread, and its carryOut opens once', async () => {
    useHold()
    const h = make()
    h.set('t1', { permission: 'auto', scope: 'work' })
    const o = await h.run('computer_apps', open)
    expect(o).toMatchObject({ isError: false, body: 'Held as item 1' })
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({ tool: 'computer_apps', why: 'flag', label: 'Send', mark: '', targets: [], picture: null, read: null })
    expect(h.requests().filter((r) => r.method === 'apps.launch')).toHaveLength(0)
    expect(h.cards).toHaveLength(0)
    const out = await held[0].carryOut()
    expect(out.isError).toBe(false)
    expect(h.requests().filter((r) => r.method === 'apps.launch').map((r) => r.params.open)).toEqual([['/tmp/a.pdf']])
    expect(held).toHaveLength(1)
    expect(h.cards).toHaveLength(0)
  })

  it('refuses a flagged open with HELD_UNAVAILABLE when no hold is configured', async () => {
    configureComputerHold(null)
    const h = make()
    h.set('t1', { permission: 'auto', scope: 'work' })
    expect(await h.run('computer_apps', open)).toMatchObject({ isError: true, body: HELD_UNAVAILABLE })
    expect(h.requests().filter((r) => r.method === 'apps.launch')).toHaveLength(0)
  })
})

describe('the attacker under full access', () => {
  it('holds a targetless click after an earlier call left the pointer on Send', async () => {
    useHold()
    const { h } = await thread('work')
    expect((await h.run('computer_act', { app: 'TextEdit', action: 'mouse_move', element: SEND })).isError).toBe(false)
    await h.run('computer_act', { app: 'TextEdit', action: 'left_click' })
    expect(held.map((c) => c.read?.why)).toEqual(['position'])
    expect(acts(h)).toBe(1)
  })

  it('answers stale and sends nothing when a later call moved the pointer a held targetless click lands on off Send', async () => {
    useHold()
    const { h } = await thread('work')
    await h.run('computer_act', { app: 'TextEdit', action: 'mouse_move', element: SEND })
    await h.run('computer_act', { app: 'TextEdit', action: 'left_click' })
    expect(held[0].targets).toEqual([expect.objectContaining({ step: 0, param: 'point', sig: expect.stringMatching(/^button:Send < /) })])
    await h.run('computer_act', { app: 'TextEdit', action: 'mouse_move', element: PLAIN })
    expect(acts(h)).toBe(2)
    expect(await held[0].carryOut()).toMatchObject({ stale: true, body: HELD_STALE })
    expect(acts(h)).toBe(2)
  })

  it('clicks once on the press when the pointer is still on Send', async () => {
    useHold()
    const { h } = await thread('work')
    await h.run('computer_act', { app: 'TextEdit', action: 'mouse_move', element: SEND })
    await h.run('computer_act', { app: 'TextEdit', action: 'left_click' })
    const out = await held[0].carryOut()
    expect(out.isError).toBe(false)
    expect(out.stale).toBeUndefined()
    expect(acts(h)).toBe(2)
  })

  it('refuses to hold a flagged click with no target while nobody knows where the pointer is, and runs nothing', async () => {
    useHold()
    const { h } = await thread('work')
    const o = await h.run('computer_act', { app: 'TextEdit', action: 'left_click', confirm: { kind: 'send', what: 'the note to Dana' } })
    expect(o).toMatchObject({ isError: true, body: HELD_UNPLACED })
    expect(held).toHaveLength(0)
    expect(acts(h)).toBe(0)
  })

  it('refuses an unflagged click with no target after a menu pick left the pointer unknown, though it was last put on Send', async () => {
    useHold()
    const { h } = await thread('work')
    await h.run('computer_act', { app: 'TextEdit', action: 'mouse_move', element: SEND })
    await h.run('computer_act', { app: 'TextEdit', action: 'left_click', menu: 'Edit › Delete' })
    expect(acts(h)).toBe(2)
    expect(await h.run('computer_act', { app: 'TextEdit', action: 'left_click' })).toMatchObject({ isError: true, body: HELD_UNPLACED })
    expect(held).toHaveLength(0)
    expect(acts(h)).toBe(2)
  })

  it('runs the same click with no target in a code thread', async () => {
    useHold()
    const { h } = await thread('code')
    expect((await h.run('computer_act', { app: 'TextEdit', action: 'left_click' })).isError).toBe(false)
    expect(acts(h)).toBe(1)
  })

  it('reads the window afresh before judging a click by name: an icon that appeared inside a Send since the read is held', async () => {
    useHold()
    // only the host's own fresh reads hold the new Send and its icon; the book the thread read has neither
    const { h } = await thread('work', 'auto', { send: false, unseen: '[48] button "Send to Dana"\n    [49] image "paperplane"' })
    const before = h.requests().length
    const o = await h.run('computer_act', { app: 'TextEdit', action: 'left_click', named: 'paperplane' })
    expect(o.isError).toBe(false)
    expect(h.requests()[before]).toMatchObject({ method: 'state.get', params: { mode: 'full', geometry: true } })
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({ why: 'screen', label: 'Send' })
    expect(held[0].targets).toEqual([expect.objectContaining({ param: 'point', sig: expect.stringMatching(/^image:paperplane < button:Send to Dana < /) })])
    expect(acts(h)).toBe(0)
  })

  it('holds a space typed into Send found by its name, and refuses a key to a name the window does not hold', async () => {
    useHold()
    const { h } = await thread('work')
    expect((await h.run('computer_act', { app: 'TextEdit', action: 'type', named: 'Send', text: ' ' })).isError).toBe(false)
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({ why: 'screen', label: 'Send' })
    expect(await h.run('computer_act', { app: 'TextEdit', action: 'type', named: 'Nowhere', text: 'hi' })).toMatchObject({ isError: true, body: HELD_UNPLACED })
    expect(held).toHaveLength(1)
    expect(acts(h)).toBe(0)
  })

  it('holds a click by element on a number the thread read as "close" that names a Send now', async () => {
    useHold()
    const { h } = await thread('work', 'auto', { renamed: true })
    const o = await click(h, SEND)
    expect(o.isError).toBe(false)
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({ why: 'screen', label: 'Send' })
    expect(acts(h)).toBe(0)
  })

  it('holds a mouse down after an earlier call left the pointer on Send', async () => {
    useHold()
    const { h } = await thread('work')
    await h.run('computer_act', { app: 'TextEdit', action: 'mouse_move', element: SEND })
    await h.run('computer_act', { app: 'TextEdit', action: 'left_mouse_down' })
    expect(held).toHaveLength(1)
    expect(acts(h)).toBe(1)
  })

  it('holds a batch whose second step clicks Send', async () => {
    useHold()
    const { h } = await thread('work')
    await h.run('computer_batch', { app: 'TextEdit', actions: [{ action: 'left_click', element: PLAIN }, { action: 'left_click', element: SEND }] })
    expect(held.map((c) => c.read?.step)).toEqual([1])
    expect(acts(h)).toBe(0)
  })

  it('holds a drag that starts and ends on Send', async () => {
    useHold()
    const { h } = await thread('work')
    await h.run('computer_act', { app: 'TextEdit', action: 'left_click_drag', start_element: SEND, element: SEND })
    expect(held).toHaveLength(1)
    expect(acts(h)).toBe(0)
  })

  it('holds Space and a typed space with the focus put on Send', async () => {
    useHold()
    const { h } = await thread('work')
    await h.run('computer_act', { app: 'TextEdit', action: 'key', text: 'space', element: SEND })
    await h.run('computer_act', { app: 'TextEdit', action: 'type', text: ' ', element: SEND })
    expect(held.map((c) => c.read?.why)).toEqual(['key', 'typed'])
    expect(acts(h)).toBe(0)
  })

  it("holds a click by element on an index the book lacks: the host reads the window afresh before it judges, so a Send only its own read numbered is still a Send", async () => {
    useHold()
    const { h } = await thread('work', 'auto', { send: false, unseen: '[48] button "Send"' })
    // a space to the focus takes the host's fresh read, which numbers the new Send; the model is never shown it
    expect((await h.run('computer_act', { app: 'TextEdit', action: 'key', text: 'space' })).isError).toBe(false)
    expect(h.requests().some((r) => r.method === 'state.get' && r.params.geometry === true)).toBe(true)
    // the model guesses the index (they run in order): nothing acts on a control the host has not read
    const before = h.requests().filter((r) => r.method === 'action.run').length
    const o = await click(h, 48)
    expect(o.isError).toBe(false)
    expect(held).toHaveLength(1)
    expect(held[0]).toMatchObject({ why: 'screen', label: 'Send' })
    expect(h.requests().filter((r) => r.method === 'action.run')).toHaveLength(before)
  })

  it("refuses, and runs nothing, when the host's own fresh read fails: a call is never judged against a stale book or an empty screen", async () => {
    useHold()
    const { h } = await thread('work')
    const service = h.service as unknown as { request: (m: string, p: unknown, o?: unknown) => Promise<unknown> }
    const request = service.request.bind(service)
    service.request = async (m, p, o) => {
      if (m === 'state.get' && (p as { geometry?: boolean }).geometry === true) throw new Error('timed out reading the window')
      return request(m, p, o)
    }
    // Return to the focus and a click by position each need that read
    const keyed = await h.run('computer_act', { app: 'TextEdit', action: 'key', text: 'Return' })
    const pointed = await h.run('computer_act', { app: 'TextEdit', action: 'left_click', coordinate: [500, 300] })
    expect(keyed).toMatchObject({ isError: true, body: HELD_UNREAD })
    expect(pointed).toMatchObject({ isError: true, body: HELD_UNREAD })
    expect(held).toHaveLength(0)
    expect(acts(h)).toBe(0)
  })

  it('refuses to hold a call whose target the window does not have: a press never runs a raw index or point on whatever took its place', async () => {
    useHold()
    const { h } = await thread('work')
    const o = await click(h, 240, { confirm: { kind: 'send', what: 'the note to Dana' } })
    expect(o).toMatchObject({ isError: true, body: HELD_UNPLACED })
    expect(held).toHaveLength(0)
    expect(acts(h)).toBe(0)
  })

  it('KNOWN LIMIT: an unflagged open of a web address runs with no hold and no card, as following any link does (a page that acts on being fetched is past the hold)', async () => {
    useHold()
    const h = make()
    h.set('t1', { permission: 'auto', scope: 'work' })
    const o = await h.run('computer_apps', { launch: 'Preview', open: ['https://news.example.test/unsubscribe?u=1'] })
    expect(o.isError).toBe(false)
    expect(held).toHaveLength(0)
    expect(h.cards).toHaveLength(0)
    expect(h.requests().filter((r) => r.method === 'apps.launch')).toHaveLength(1)
  })
})

describe('Take over', () => {
  it("refuses the thread's own calls while he drives, on every turn, still carries out his press, and runs again once he hands back", async () => {
    useHold()
    const { h } = await thread('work')
    await click(h, SEND)
    expect(held).toHaveLength(1)
    let driver: 'owner' | 'agent' = 'owner'
    configureOwnerDrives((id) => (id === 't1' && driver === 'owner' ? 'He is driving.' : null))
    expect(await click(h, PLAIN)).toMatchObject({ isError: true, body: 'He is driving.', steps: [] })
    // a later turn (his message, a decided act waking the thread) is refused the same: nothing reaches the service
    const before = h.requests().length
    expect(await h.run('computer_observe', { app: 'TextEdit' })).toMatchObject({ isError: true, body: 'He is driving.' })
    expect(h.requests()).toHaveLength(before)
    expect(acts(h)).toBe(0)
    const pressed = await held[0].carryOut()
    expect(pressed.isError).toBe(false)
    expect(acts(h)).toBe(1)
    driver = 'agent'
    expect((await click(h, PLAIN)).isError).toBe(false)
    expect(acts(h)).toBe(2)
  })
})

describe('Take over, when Work cannot answer', () => {
  it('a gate that throws refuses nothing: a code thread keeps its computer use', async () => {
    configureOwnerDrives(() => {
      throw new Error('the canvas part did not start')
    })
    const { h } = await thread('code')
    expect((await click(h, PLAIN)).isError).toBe(false)
    expect(acts(h)).toBe(1)
  })
})
