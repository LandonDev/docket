import { spawn as nodeSpawn } from 'node:child_process'
import { VIDEO_FPS, type VideoRefusal } from '@shared/contract-video'
import type { StreamInfo, VideoRelay } from '../../../video/relay'
import type { VideoAsk, VideoOpening, VideoSource } from '../../../video/rpc'
import type { BoxChromium } from './chromium'
import { DISPLAY_HEIGHT, DISPLAY_WIDTH, displayEnv } from './display'
import type { BoxEngines } from './engine'
import { EngineFeed } from './engineFeed'
import type { BoxStage } from './stage'
import { videoToolsEnv } from './videoSetting'

/**
 * The box's browser as a source of live video (docs/agents/live-video.md
 * "The box"). `video.open` names a thread; the stream is of the page that
 * thread's pane shows, which outlives the thread's computer session: Take
 * over stops the agent's session, and he goes on watching the page he then
 * drives.
 *
 * One page of the box is in video at a time, since the engine captures the
 * whole display. The thread on screen asks with `take` and gets the display;
 * the page that lost it closes with `moved`. A caller that does not ask to
 * take it is answered `busy`.
 */

/** A box stream's tag: the page it shows. */
export const boxTag = (targetId: string): string => `box:${targetId}`
const isBox = (s: StreamInfo): boolean => !!s.tag?.startsWith('box:')

/** While a viewer is connected the browser is in use, as it is while he drives, for at most this long. */
export const VIEWER_USE_MS = 2 * 3_600_000
/** His pasted text stays on the display's clipboard this long after the paste was sent, then it is gone. */
export const PASTE_CLEAR_MS = 1_500
/** The usage codes of the two keys a paste presses: left Control and V. */
const KEY_CONTROL = 224
const KEY_V = 25

export interface BoxVideoDeps {
  browser: Pick<BoxChromium, 'running' | 'display' | 'tools'>
  stage: BoxStage
  engines: BoxEngines
  relay: VideoRelay
  /** the page a thread's pane shows now: its live session's, else the last one its pane used; null when the box holds none for it */
  pageOf(thread: string): string | null
  /** the thread whose pane shows a thread's browser (a subagent's acts show in its root's) */
  paneOf(thread: string): string
  /** he drives this pane now */
  drives(pane: string): boolean
  /** the address a page is at, or null when it is gone */
  urlOf(targetId: string): Promise<string | null>
  /** an address no agent may open, read or act on: no stream of it either */
  closed(url: string): boolean
  /** `work.browser.video` is on */
  setting(): boolean
  /** the tools are installed on this host */
  installed(): boolean
  spawn?: typeof nodeSpawn
  now?: () => number
  log?: (line: string) => void
}

export class BoxVideo implements VideoSource {
  /** the feed and the start of each open stream, by its id */
  private readonly feeds = new Map<string, { feed: EngineFeed; since: number }>()
  /** feeds handed to the RPC whose streams are not open yet, by the page each will show: a second open must see them */
  private readonly granted = new Map<EngineFeed, string>()
  /** every xclip that holds the clipboard now */
  private readonly clipboards = new Set<{ kill(): void }>()
  private clearing: NodeJS.Timeout | null = null
  private readonly offs: (() => void)[] = []
  /** one open at a time: which page has the display is decided and acted on before the next is asked */
  private opening: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: BoxVideoDeps) {
    this.offs.push(deps.relay.onChange(() => this.changed()))
    // The watched page went to an address that is closed to agents, or closed: what he is shown of it ends.
    this.offs.push(deps.stage.onEnd((targetId) => void deps.relay.endWhere((s) => s.tag === boxTag(targetId), 'ended')))
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  open(ask: VideoAsk): Promise<VideoOpening | null> {
    const run = this.opening.then(
      () => this.openOne(ask),
      () => this.openOne(ask)
    )
    this.opening = run.catch(() => {})
    return run
  }

  private async openOne(ask: VideoAsk): Promise<VideoOpening | null> {
    const { deps } = this
    const target = deps.pageOf(ask.thread)
    // not a page of this browser: another source may know the thread
    if (!target) return null
    const display = deps.browser.display
    if (!deps.browser.running || !display) return this.refuse(!deps.setting() ? 'off' : !deps.installed() ? 'no-tools' : 'unsupported')
    const url = await deps.urlOf(target)
    if (url === null) return null
    if (deps.closed(url)) return this.refuse('refused')
    const tag = boxTag(target)
    // another page has the display: one with a stream, or one a stream is being opened for
    const elsewhere = (): boolean => deps.relay.list().some((s) => isBox(s) && s.tag !== tag) || [...this.granted.values()].some((t) => t !== tag)
    if (elsewhere() && !ask.take) return this.refuse('busy')
    const pane = deps.paneOf(ask.thread)
    const driving = deps.drives(pane)
    // the relay passes input by what it was told, so it is told at every open: a host that restarted while he drove knows again
    deps.relay.setDriver(pane, driving)
    let lease
    try {
      lease = await deps.engines.lease()
    } catch (err) {
      deps.log?.(`box video: the engine did not start: ${(err as Error).message}`)
      return this.refuse('unsupported')
    }
    if (!lease) return this.refuse('busy')
    // only now, with an engine in hand, does the page that had the display lose it
    deps.relay.endWhere((s) => isBox(s) && s.tag !== tag, 'moved')
    for (const [other, t] of [...this.granted]) if (t !== tag) other.close()
    try {
      await deps.stage.watch(target)
      if (driving) await deps.stage.drive(target)
    } catch (err) {
      lease.release()
      deps.log?.(`box video: the page could not be shown: ${(err as Error).message}`)
      return this.refuse('unsupported')
    }
    const scope = ask.drive && driving ? 'drive' : 'watch'
    const feed: EngineFeed = new EngineFeed(lease, scope === 'drive', undefined, { close: () => void this.granted.delete(feed), input: () => deps.stage.touched() })
    this.granted.set(feed, tag)
    return {
      ok: true,
      feed,
      width: DISPLAY_WIDTH,
      height: DISPLAY_HEIGHT,
      fps: VIDEO_FPS,
      scope,
      group: pane,
      tag,
      opened: (stream) => {
        this.granted.delete(feed)
        this.feeds.set(stream, { feed, since: this.now() })
      }
    }
  }

  /**
   * His paste: the text is put on the display's clipboard and Ctrl+V is
   * pressed, since text typed key by key can lose characters on X. The text
   * goes to xclip on its stdin, never on a command line, and the clipboard is
   * emptied a moment after, so nothing he pasted is there for an agent to
   * paste again.
   */
  async paste(stream: StreamInfo, text: string): Promise<void> {
    const { deps } = this
    const entry = this.feeds.get(stream.id)
    const display = deps.browser.display
    const tools = deps.browser.tools
    if (!entry || !display || !tools) throw new Error('This stream takes no paste')
    this.clearClipboard()
    const child = (deps.spawn ?? nodeSpawn)(tools.xclip, ['-selection', 'clipboard', '-in', '-quiet'], { env: { ...displayEnv(display), ...videoToolsEnv(tools) }, stdio: ['pipe', 'ignore', 'ignore'] })
    // held from the start, so a hand back that comes while the text is still being written empties it too
    this.clipboards.add(child)
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.stdin?.once('error', reject)
      // xclip reads to the end of its input, then holds the clipboard for as long as it runs (`-quiet` keeps it in this process, so ending it empties the clipboard)
      child.stdin?.end(text, () => resolve())
    })
    // a beat for xclip to own the clipboard before the browser asks for it
    await new Promise((r) => setTimeout(r, 60))
    // he may have handed back in that beat: then nothing of his is pressed, and nothing of his stays
    if (!stream.group || !deps.relay.driving(stream.group)) {
      this.clearClipboard()
      throw new Error('forbidden: video.paste needs a stream you are driving')
    }
    const pressed =
      entry.feed.type({ type: 'keyDown', key: KEY_CONTROL }) &&
      entry.feed.type({ type: 'keyDown', key: KEY_V }) &&
      entry.feed.type({ type: 'keyUp', key: KEY_V }) &&
      entry.feed.type({ type: 'keyUp', key: KEY_CONTROL })
    this.clearing = setTimeout(() => this.clearClipboard(), PASTE_CLEAR_MS)
    this.clearing.unref?.()
    if (!pressed) throw new Error('The page is not ready for a paste yet')
  }

  /** A held act of this pane waits in the Outbox: what he judges is its kept picture, so the live one ends. He still sees a page he drives himself. */
  held(pane: string): void {
    if (this.deps.drives(pane)) return
    this.deps.relay.endWhere((s) => isBox(s) && s.group === pane, 'held')
  }

  /**
   * He took over a pane (its page shows the browser's toolbar and takes his
   * input) or handed it back (full screen again, and every key he held let
   * go). Called on the drive push, never per input record.
   */
  async driver(pane: string, owner: boolean): Promise<void> {
    const { deps } = this
    deps.relay.setDriver(pane, owner)
    if (!owner) this.wipeClipboard()
    if (!deps.browser.running || !deps.browser.display) return
    const target = deps.pageOf(pane)
    try {
      // only the page he is shown changes face: a pane he took over from elsewhere shows its toolbar once its stream is opened
      if (owner && target && deps.stage.watching === target) await deps.stage.drive(target)
      else if (!owner && (!target || deps.stage.driving === target)) await deps.stage.drive(null)
    } catch (err) {
      deps.log?.(`box video: the page did not change for the driver: ${(err as Error).message}`)
    }
  }

  /** The browser stopped: its streams end, and nothing of the display is left to show. */
  stopped(): void {
    this.clearClipboard()
    this.deps.relay.endWhere(isBox, 'ended')
  }

  /** A viewer is connected now, and has been for less than two hours: the browser is in use. */
  inUse(): boolean {
    const now = this.now()
    const live = new Set(this.deps.relay.list().filter((s) => isBox(s) && s.joined).map((s) => s.id))
    for (const [id, { since }] of this.feeds) if (live.has(id) && now - since < VIEWER_USE_MS) return true
    return false
  }

  close(): void {
    for (const off of this.offs.splice(0)) off()
    this.clearClipboard()
  }

  private refuse(reason: VideoRefusal): VideoOpening {
    return { ok: false, reason }
  }

  /**
   * He handed back. What he pasted is let go, and so is what he copied in the
   * page, which the browser holds: an empty xclip takes the clipboard from
   * it, and is ended a moment after, so nothing of his is there for an agent
   * to paste.
   */
  private wipeClipboard(): void {
    this.clearClipboard()
    const display = this.deps.browser.display
    const tools = this.deps.browser.tools
    if (!display || !tools) return
    try {
      const child = (this.deps.spawn ?? nodeSpawn)(tools.xclip, ['-selection', 'clipboard', '-in', '-quiet'], { env: { ...displayEnv(display), ...videoToolsEnv(tools) }, stdio: ['pipe', 'ignore', 'ignore'] })
      child.once('error', () => undefined)
      child.stdin?.once('error', () => undefined)
      child.stdin?.end()
      this.clipboards.add(child)
      this.clearing = setTimeout(() => this.clearClipboard(), PASTE_CLEAR_MS)
      this.clearing.unref?.()
    } catch (err) {
      this.deps.log?.(`box video: the clipboard was not emptied: ${(err as Error).message}`)
    }
  }

  /** Threads were removed: the pages they used are shown to nobody from here on. */
  removed(threads: readonly string[]): void {
    this.deps.relay.endWhere((s) => isBox(s) && threads.includes(s.thread), 'ended')
  }

  private clearClipboard(): void {
    if (this.clearing) clearTimeout(this.clearing)
    this.clearing = null
    for (const child of this.clipboards) child.kill()
    this.clipboards.clear()
  }

  /** A stream opened, joined or went: forget the gone ones, and with the last gone nothing is watched. */
  private changed(): void {
    const live = this.deps.relay.list().filter(isBox)
    const ids = new Set(live.map((s) => s.id))
    for (const id of this.feeds.keys()) if (!ids.has(id)) this.feeds.delete(id)
    if (!live.length && this.deps.stage.watching) void this.deps.stage.watch(null)
  }
}
