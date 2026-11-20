import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_PRINCIPAL } from '@shared/capabilities'
import { VIDEO_CLOSE } from '@shared/contract-video'
import type { StreamClaim } from '../../../remote/auth'
import { VideoRelay, type ViewerSocket } from '../../../video/relay'
import { VideoRpc, type VideoAsk } from '../../../video/rpc'
import type { EngineLease } from './engine'
import { BoxVideo, PASTE_CLEAR_MS, VIEWER_USE_MS, boxTag, type BoxVideoDeps } from './video'

afterEach(() => vi.useRealTimers())

class FakeSocket implements ViewerSocket {
  bufferedAmount = 0
  closed: { code: number; reason: string } | null = null
  private readonly closers: (() => void)[] = []
  send(): void {}
  close(code: number, reason: string): void {
    if (this.closed) return
    this.closed = { code, reason }
    for (const fn of this.closers) fn()
  }
  on(event: 'message' | 'close', fn: never): void {
    if (event === 'close') this.closers.push(fn)
  }
}

/** The box with two panes: `a` shows page A, `b` shows page B; `sub` is a subagent of pane a. */
function rig(over: Partial<BoxVideoDeps> = {}) {
  const relay = new VideoRelay()
  const state = { running: true, headed: true, setting: true, installed: true, owner: new Set<string>(), urls: new Map([['A', 'https://concur.example/report'], ['B', 'https://arbiter.example/']]), now: 1_000_000 }
  const stage = {
    watching: null as string | null,
    driving: null as string | null,
    watched: [] as (string | null)[],
    driven: [] as (string | null)[],
    closedListeners: new Set<(id: string) => void>(),
    async watch(id: string | null) {
      this.watching = id
      this.watched.push(id)
    },
    async drive(id: string | null) {
      this.driving = id
      this.driven.push(id)
    },
    onEnd(fn: (id: string) => void) {
      this.closedListeners.add(fn)
      return () => this.closedListeners.delete(fn)
    },
    touches: 0,
    touched() {
      this.touches++
    }
  }
  const leases: (EngineLease & { released: number })[] = []
  const engines = {
    full: false,
    broken: false,
    async lease() {
      if (this.broken) throw new Error('no engine')
      if (this.full) return null
      const lease = { port: 4100 + leases.length, token: 'f'.repeat(64), pid: null, onExit: () => {}, release: () => void lease.released++, released: 0 }
      leases.push(lease)
      return lease
    }
  }
  const spawned: { cmd: string; args: string[]; env: NodeJS.ProcessEnv; stdin: string; killed: boolean }[] = []
  const spawn = ((cmd: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    const entry = { cmd, args, env: options.env, stdin: '', killed: false }
    spawned.push(entry)
    const child = new EventEmitter() as never as { stdin: PassThrough; kill(): boolean }
    child.stdin = new PassThrough()
    child.stdin.on('data', (c: Buffer) => (entry.stdin += c.toString()))
    child.kill = () => (entry.killed = true)
    return child
  }) as never
  const tools = { engine: '/t/engine', xorg: '/t/xorg', xclip: '/t/xclip', sys: '/t/sys', viewer: '/t/viewer' }
  const pages: Record<string, string> = { a: 'A', sub: 'A', b: 'B' }
  const deps: BoxVideoDeps = {
    browser: {
      get running() {
        return state.running
      },
      get display() {
        return state.running && state.headed ? { DISPLAY: ':7', XAUTHORITY: '/d/Xauthority' } : null
      },
      get tools() {
        return state.running && state.headed ? tools : null
      }
    },
    stage: stage as never,
    engines: engines as never,
    relay,
    pageOf: (thread) => pages[thread] ?? null,
    paneOf: (thread) => (thread === 'sub' ? 'a' : thread),
    drives: (pane) => state.owner.has(pane),
    urlOf: async (id) => state.urls.get(id) ?? null,
    closed: (url) => url.includes('outlook.office.com'),
    setting: () => state.setting,
    installed: () => state.installed,
    spawn,
    now: () => state.now,
    ...over
  }
  const video = new BoxVideo(deps)
  const minted: StreamClaim[] = []
  const rpc = new VideoRpc(relay, { mintStreamTicket: (claim) => (minted.push(claim), { ticket: 't', expiresIn: 30 }) }, () => true)
  rpc.addSource(video)
  const me = { principal: LOCAL_PRINCIPAL, connection: {}, connectionId: '1' }
  const ask = (threadId: string, more: { take?: boolean; drive?: boolean } = {}) => rpc.open({ threadId, maxEdge: 1280, ...more }, me)
  /** the viewer's socket joins the newest stream */
  const join = (): FakeSocket => {
    const socket = new FakeSocket()
    expect(relay.attach(minted.at(-1)!, socket)).toBe(true)
    return socket
  }
  const open = (thread: string, more: Partial<VideoAsk> = {}) => video.open({ thread, maxEdge: 1280, take: false, drive: false, principal: LOCAL_PRINCIPAL, local: true, ...more })
  return { relay, state, stage, engines, leases, spawned, video, rpc, me, ask, join, open, minted }
}

describe('the box browser as a source of video', () => {
  it('opens a stream of the page a thread’s pane shows: 1280×800 at 120, watched and raised, on an engine of its own', async () => {
    const r = rig()
    const answer = await r.ask('a')
    expect(answer).toMatchObject({ ok: true, width: 1280, height: 800, fps: 120 })
    expect(r.stage.watching).toBe('A')
    expect(r.leases).toHaveLength(1)
    expect(r.relay.list()).toMatchObject([{ thread: 'a', scope: 'watch', group: 'a', tag: boxTag('A') }])
    // a subagent's thread shows its root's pane, and so the same page
    expect(await r.ask('sub')).toMatchObject({ ok: true })
    expect(r.relay.list().map((s) => [s.thread, s.group, s.tag])).toEqual([
      ['a', 'a', 'box:A'],
      ['sub', 'a', 'box:A']
    ])
  })

  it('is not asked about a thread that has no page here: another source may know it', async () => {
    const r = rig()
    expect(await r.open('elsewhere')).toBeNull()
    expect(await r.ask('elsewhere')).toEqual({ ok: false, reason: 'unsupported' })
    // a page that closed since
    r.state.urls.delete('A')
    expect(await r.open('a')).toBeNull()
    expect(r.leases).toEqual([])
  })

  it('says why there is no video: the setting is off, the tools are missing, or the display did not start', async () => {
    const r = rig()
    r.state.headed = false
    expect(await r.ask('a')).toEqual({ ok: false, reason: 'unsupported' })
    r.state.installed = false
    expect(await r.ask('a')).toEqual({ ok: false, reason: 'no-tools' })
    r.state.setting = false
    expect(await r.ask('a')).toEqual({ ok: false, reason: 'off' })
    r.state.running = false
    expect(await r.ask('a')).toEqual({ ok: false, reason: 'off' })
    expect(r.leases).toEqual([])
    expect(r.stage.watched).toEqual([])
  })

  it('refuses a page that is closed to agents, before anything is watched', async () => {
    const r = rig()
    r.state.urls.set('A', 'https://outlook.office.com/mail/')
    expect(await r.ask('a')).toEqual({ ok: false, reason: 'refused' })
    expect(r.stage.watched).toEqual([])
    expect(r.leases).toEqual([])
  })

  it('shows one page at a time: a second is busy unless it takes the display, and the page that lost it closes with moved', async () => {
    const r = rig()
    await r.ask('a')
    const first = r.join()
    // a tile that does not ask to take it
    expect(await r.ask('b')).toEqual({ ok: false, reason: 'busy' })
    expect(r.stage.watching).toBe('A')
    expect(first.closed).toBeNull()
    // the thread on screen takes it
    expect(await r.ask('b', { take: true })).toMatchObject({ ok: true })
    expect(first.closed).toEqual({ code: VIDEO_CLOSE.moved, reason: 'moved' })
    expect(r.stage.watching).toBe('B')
    expect(r.relay.list().map((s) => s.tag)).toEqual(['box:B'])
    // another viewer of the same page is no taking at all
    expect(await r.ask('b')).toMatchObject({ ok: true })
  })

  it('decides one open at a time: two pages asked for at once do not both get the display', async () => {
    const r = rig()
    const [a, b] = await Promise.all([r.ask('a'), r.ask('b')])
    expect(a).toMatchObject({ ok: true })
    expect(b).toEqual({ ok: false, reason: 'busy' })
    expect(r.stage.watching).toBe('A')
    expect(r.leases).toHaveLength(1)
    // nor two that both take it: the second takes it from the first, and the first's feed is let go
    const r2 = rig()
    const [c, d] = await Promise.all([r2.ask('a', { take: true }), r2.ask('b', { take: true })])
    expect([c.ok, d.ok]).toEqual([true, true])
    expect(r2.stage.watching).toBe('B')
    expect(r2.relay.list().map((s) => s.tag)).toEqual(['box:B'])
    expect(r2.leases.map((l) => l.released)).toEqual([1, 0])
  })

  it('takes the display from a page only with an engine in hand: with none, the page that had it keeps its stream', async () => {
    const r = rig()
    await r.ask('a')
    const first = r.join()
    r.engines.full = true
    expect(await r.ask('b', { take: true })).toEqual({ ok: false, reason: 'busy' })
    r.engines.full = false
    r.engines.broken = true
    expect(await r.ask('b', { take: true })).toEqual({ ok: false, reason: 'unsupported' })
    expect(first.closed).toBeNull()
    expect(r.stage.watching).toBe('A')
    expect(r.relay.list().map((s) => s.tag)).toEqual(['box:A'])
  })

  it('changes a page’s face for the driver only when that page is the one he is shown', async () => {
    const r = rig()
    await r.ask('a')
    // he took over pane b from its own place: its page is not on the display, so nothing of the display changes
    r.state.owner.add('b')
    await r.video.driver('b', true)
    expect(r.stage.driven).toEqual([])
    expect(r.relay.driving('b')).toBe(true)
    // its stream, once opened, shows the toolbar
    await r.ask('b', { take: true, drive: true })
    expect(r.stage.driving).toBe('B')
    // pane a handed back meanwhile changes nothing of what is shown
    await r.video.driver('a', false)
    expect(r.stage.driving).toBe('B')
  })

  it('is busy when every engine has a viewer, and says unsupported when the engine will not start', async () => {
    const r = rig()
    r.engines.full = true
    expect(await r.ask('a')).toEqual({ ok: false, reason: 'busy' })
    r.engines.full = false
    r.engines.broken = true
    expect(await r.ask('a')).toEqual({ ok: false, reason: 'unsupported' })
    expect(r.relay.list()).toEqual([])
  })

  it('lets its engine go when the stream ends, and watches nothing once the last viewer has left', async () => {
    const r = rig()
    await r.ask('a')
    const socket = r.join()
    await r.ask('sub')
    const second = r.join()
    socket.close(1000, '')
    expect(r.leases[0].released).toBe(1)
    expect(r.stage.watching).toBe('A')
    second.close(1000, '')
    expect(r.leases[1].released).toBe(1)
    expect(r.stage.watching).toBeNull()
  })

  it('gives a drive stream only when it is asked for and he is the driver, and shows him the toolbar', async () => {
    const r = rig()
    // asked, but the agent drives: a watch stream
    await r.ask('a', { drive: true })
    expect(r.relay.list()[0].scope).toBe('watch')
    expect(r.relay.driving('a')).toBe(false)
    expect(r.stage.driven).toEqual([])
    // he took over
    r.state.owner.add('a')
    await r.video.driver('a', true)
    expect(r.stage.driving).toBe('A')
    expect(r.relay.driving('a')).toBe(true)
    await r.ask('a', { drive: true })
    await r.ask('a')
    expect(r.relay.list().map((s) => s.scope)).toEqual(['watch', 'drive', 'watch'])
    // he drives pane a, not pane b
    await r.ask('b', { drive: true, take: true })
    expect(r.relay.list().map((s) => [s.group, s.scope])).toEqual([['b', 'watch']])
  })

  it('a host that restarted while he drove learns it again at the next open', async () => {
    const r = rig()
    r.state.owner.add('a')
    await r.ask('a', { drive: true })
    expect(r.relay.driving('a')).toBe(true)
    expect(r.relay.list()[0].scope).toBe('drive')
    expect(r.stage.driving).toBe('A')
  })

  it('returns the page to full screen and stops his input when he hands back', async () => {
    const r = rig()
    r.state.owner.add('a')
    await r.ask('a', { drive: true })
    r.join()
    r.state.owner.delete('a')
    await r.video.driver('a', false)
    expect(r.stage.driving).toBeNull()
    expect(r.relay.driving('a')).toBe(false)
    expect(r.relay.list()[0].scope).toBe('watch')
  })

  it('ends the live picture of a pane whose act is held, unless he is driving that page himself', async () => {
    const r = rig()
    await r.ask('a')
    const watching = r.join()
    r.video.held('b')
    expect(watching.closed).toBeNull()
    r.video.held('a')
    expect(watching.closed).toEqual({ code: VIDEO_CLOSE.held, reason: 'held' })
    r.state.owner.add('a')
    await r.ask('a', { drive: true })
    const driving = r.join()
    r.video.held('a')
    expect(driving.closed).toBeNull()
  })

  it('ends the stream when the watched page goes to an address that is closed to agents', async () => {
    const r = rig()
    await r.ask('a')
    const socket = r.join()
    for (const fn of r.stage.closedListeners) fn('B')
    expect(socket.closed).toBeNull()
    for (const fn of r.stage.closedListeners) fn('A')
    expect(socket.closed).toEqual({ code: VIDEO_CLOSE.ended, reason: 'ended' })
  })

  it('ends every stream when the browser stops', async () => {
    const r = rig()
    await r.ask('a')
    const socket = r.join()
    r.video.stopped()
    expect(socket.closed).toEqual({ code: VIDEO_CLOSE.ended, reason: 'ended' })
    expect(r.relay.list()).toEqual([])
  })

  it('counts a connected viewer as use of the browser, for two hours and no longer', async () => {
    const r = rig()
    expect(r.video.inUse()).toBe(false)
    await r.ask('a')
    // asked for, but nobody joined: not use yet
    expect(r.video.inUse()).toBe(false)
    const socket = r.join()
    expect(r.video.inUse()).toBe(true)
    r.state.now += VIEWER_USE_MS - 1
    expect(r.video.inUse()).toBe(true)
    r.state.now += 1
    expect(r.video.inUse()).toBe(false)
    socket.close(1000, '')
    expect(r.video.inUse()).toBe(false)
  })

  it('pastes through the display’s clipboard: the text on xclip’s stdin and never its command line, and gone a moment after', async () => {
    const r = rig()
    r.state.owner.add('a')
    const answer = await r.ask('a', { drive: true })
    if (!answer.ok) throw new Error()
    r.join()
    vi.useFakeTimers()
    // the page has drawn nothing yet, so the engine's connection has no number to send keys under
    const pasting = r.rpc.paste({ stream: answer.stream, text: 'hunter2 ünïcode' }, r.me)
    const refused = expect(pasting).rejects.toThrow('not ready for a paste')
    await vi.advanceTimersByTimeAsync(100)
    await refused
    const xclip = r.spawned[0]
    expect(xclip.cmd).toBe('/t/xclip')
    expect(xclip.args).toEqual(['-selection', 'clipboard', '-in', '-quiet'])
    expect(xclip.stdin).toBe('hunter2 ünïcode')
    expect(xclip.args.join(' ')).not.toContain('hunter2')
    expect(xclip.env.DISPLAY).toBe(':7')
    expect(xclip.env.XAUTHORITY).toBe('/d/Xauthority')
    // the clipboard is emptied even though the paste could not be pressed
    expect(xclip.killed).toBe(false)
    await vi.advanceTimersByTimeAsync(PASTE_CLEAR_MS)
    expect(xclip.killed).toBe(true)
  })

  it('presses no paste for a driver who handed back while the text was on its way to the clipboard', async () => {
    const r = rig()
    r.state.owner.add('a')
    const answer = await r.ask('a', { drive: true })
    if (!answer.ok) throw new Error()
    r.join()
    const stream = r.relay.list()[0]
    vi.useFakeTimers()
    const pasting = r.video.paste(stream, 'hunter2')
    const refused = expect(pasting).rejects.toThrow('needs a stream you are driving')
    // he hands back before the keys are pressed
    r.state.owner.delete('a')
    await r.video.driver('a', false)
    await vi.advanceTimersByTimeAsync(100)
    await refused
    expect(r.spawned.every((x) => x.killed)).toBe(true)
  })

  it('empties the clipboard at once when he hands back, and when the browser stops', async () => {
    const r = rig()
    r.state.owner.add('a')
    const answer = await r.ask('a', { drive: true })
    if (!answer.ok) throw new Error()
    r.join()
    await r.rpc.paste({ stream: answer.stream, text: 'secret' }, r.me).catch(() => {})
    expect(r.spawned[0].killed).toBe(false)
    r.state.owner.delete('a')
    await r.video.driver('a', false)
    expect(r.spawned[0].killed).toBe(true)
  })
})
