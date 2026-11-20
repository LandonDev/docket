import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ClientRequest } from '@shared/contract'
import type { ComputerFramePush, ComputerPreviewStart, ComputerSessionRow } from '@shared/contract-computer'
import { PREVIEW_MAX_EDGE, PREVIEW_MIN_EDGE } from '@shared/contract-computer'
import { VIDEO_FPS, type VideoRefusal } from '@shared/contract-video'
import type { WinvmState } from '@shared/contract-work-winvm'
import { previewRefusal, type PreviewAccess, type Viewer } from '../../computer/preview'
import { PreviewGate } from '../../computer/previewGate'
import type { InputEvent } from '@shared/video/nsl1'
import type { StreamInfo, VideoRelay } from '../../video/relay'
import type { VideoAsk, VideoOpening, VideoSource } from '../../video/rpc'
import { EngineFeed } from '../browser/box/engineFeed'
import type { VmScreen } from './window'

/**
 * The Windows VM on the Computers page (docs/agents/live-video.md "The
 * Windows VM"): its row while it is awake, its live video for `video.open`
 * with `computer: 'vm:windows'`, and the 4 fps picture from QMP's
 * screenshots, which a strip tile shows where no stream is free and every
 * tile shows where the VM has no window.
 *
 * The row is the VM's own, never a session's: `threadId` is the thread that
 * holds the machine (the lease's), or `vm:windows` when none does, and then
 * the row is idle. Its title is that thread's, or "Windows VM" when he alone
 * uses it.
 */

/** The VM's name on the box, which outlives every thread that holds it. */
export const VM_COMPUTER = 'vm:windows'
export const VM_NAME = 'Windows VM'
/** A stream of the VM's display: its tag, and the group its driving is kept by. */
const isVm = (s: StreamInfo): boolean => s.tag === VM_COMPUTER
/** The 4 fps picture's ids, which never meet the box browser's (`preview_N`). */
const PREVIEW_PREFIX = 'vm-preview_'
const PICTURE_MS = 250

export interface VmPictureDeps {
  /** the keeper's state, or null while Work is off */
  state(): WinvmState | null
  /** its changes, and null when Work goes off */
  onState(fn: (state: WinvmState | null) => void): () => void
  /** how many watch its picture: while any do, it does not sleep */
  setViewers(n: number): void
  screen: Pick<VmScreen, 'env' | 'size' | 'missingTool' | 'adopt' | 'engines'>
  relay: Pick<VideoRelay, 'list' | 'onChange' | 'endWhere' | 'setDriver' | 'driving'>
  /** QMP's screenshot of the guest's screen, as PNG */
  screenshot(): Promise<Buffer>
  /** a PNG as a JPEG no longer than `maxEdge` on its long side, base64 */
  jpeg(png: Buffer, maxEdge: number): Promise<{ data: string; width: number; height: number }>
  /** the thread that holds the machine now (B5's lease); null when none does */
  holder?: () => string | null
  now?: () => number
  log?: (line: string) => void
}

export class VmPicture implements VideoSource {
  private readonly rowListeners = new Set<(rows: ComputerSessionRow[]) => void>()
  private readonly offs: (() => void)[] = []
  private awake = false
  /** viewers of its video now */
  private viewers = 0
  /** he drives it (his Take over, `computer.drive` on `vm:windows`) */
  private owner = false
  /** what Take over hands back by itself when the machine leaves `awake` under him (drive.ts here) */
  private handBack: (() => void) | null = null
  readonly previews: VmPreviews
  /** each drive or watch stream's feed by its stream id, for a paste */
  private readonly streams = new Map<string, EngineFeed>()

  constructor(private readonly d: VmPictureDeps) {
    this.awake = d.state()?.state === 'awake'
    this.previews = new VmPreviews(d, () => this.awake)
    this.offs.push(
      d.onState((state) => {
        const awake = state?.state === 'awake'
        if (awake === this.awake) return
        this.awake = awake
        // asleep: what played of it ends, and its tile goes; a machine he drove is his no longer
        if (!awake) {
          if (this.owner) this.handBack?.()
          d.relay.endWhere(isVm, 'ended')
          this.previews.endAll()
        }
        this.rowsChanged()
      })
    )
    this.offs.push(
      d.relay.onChange(() => {
        const mine = d.relay.list().filter(isVm)
        for (const id of [...this.streams.keys()]) if (!mine.some((s) => s.id === id)) this.streams.delete(id)
        const live = mine.filter((s) => s.joined).length
        if (live !== this.viewers) d.setViewers((this.viewers = live))
      })
    )
  }

  /** The VM's row while it is awake: idle while no thread holds it, and with no Take over where it has no window. */
  rows(): ComputerSessionRow[] {
    const state = this.d.state()
    if (state?.state !== 'awake') return []
    // while he drives no thread holds it: the row is his, under the VM's own name
    const holder = this.owner ? null : (this.d.holder?.() ?? null)
    if (!this.d.screen.env) this.d.screen.adopt()
    return [
      {
        threadId: holder ?? VM_COMPUTER,
        since: Math.round(state.since),
        lastCallAt: Math.round(state.since),
        apps: [{ name: VM_NAME, bundleId: null, window: null }],
        running: null,
        tier: null,
        computer: VM_COMPUTER,
        ...(this.owner ? { driver: 'owner' as const } : holder ? {} : { idle: true as const }),
        ...(this.windowless() ? { pictureOnly: true as const } : {})
      }
    ]
  }

  /** The VM is awake with no window of its own: its picture is QMP's 4 fps one, and he cannot take over. */
  windowless(): boolean {
    if (this.d.state()?.state !== 'awake') return false
    if (!this.d.screen.env) this.d.screen.adopt()
    return !this.d.screen.env
  }

  onRows(fn: (rows: ComputerSessionRow[]) => void): () => void {
    this.rowListeners.add(fn)
    return () => void this.rowListeners.delete(fn)
  }

  /** The thread that holds the machine changed (B5's lease): the row's title follows it. */
  rowsChanged(): void {
    const rows = this.rows()
    for (const fn of [...this.rowListeners]) fn(rows)
  }

  /** He drives it now. */
  driving(): boolean {
    return this.owner
  }

  /**
   * His Take over or Hand back (drive.ts `vmWheel`): his streams take his input
   * from here, or every key and button he holds is let go and they are watch
   * streams again (the relay's `setDriver`). `handBack` is what ends his drive
   * by itself when the machine goes to sleep under him.
   */
  setDriving(on: boolean, handBack?: () => void): void {
    this.owner = on
    this.handBack = on ? (handBack ?? null) : null
    this.d.relay.setDriver(VM_COMPUTER, on)
    this.rowsChanged()
  }

  /** Stop on the VM's row: what a thread does there is the lease's to stop (B5); the machine itself is never stopped from here. */
  async stop(): Promise<boolean> {
    return false
  }

  /**
   * Live video of the VM's display, for an ask that names it. One engine for
   * each viewer, three at most; past that the answer is `busy` and the tile
   * shows the 4 fps picture.
   */
  async open(ask: VideoAsk): Promise<VideoOpening | null> {
    if (ask.computer !== VM_COMPUTER) return null
    if (this.d.state()?.state !== 'awake') return refuse('unsupported')
    if (!this.d.screen.env) this.d.screen.adopt()
    const size = this.d.screen.size
    if (!this.d.screen.env || !size) return refuse(this.d.screen.missingTool ? 'no-tools' : 'unsupported')
    let lease
    try {
      lease = await this.d.screen.engines.lease()
    } catch (err) {
      this.d.log?.(`winvm video: the engine did not start: ${(err as Error).message}`)
      return refuse('unsupported')
    }
    if (!lease) return refuse('busy')
    // a drive stream only while he drives: the relay passes input by what it was told, so it is told at every open
    this.d.relay.setDriver(VM_COMPUTER, this.owner)
    const scope = ask.drive && this.owner ? 'drive' : 'watch'
    // the feed gives its engine back when it closes; QEMU's own chords and typed characters never reach the guest
    const feed = new EngineFeed(lease, scope === 'drive', undefined, {}, 'vm')
    return {
      ok: true,
      feed,
      width: size.width,
      height: size.height,
      fps: VIDEO_FPS,
      scope,
      group: VM_COMPUTER,
      tag: VM_COMPUTER,
      opened: (stream) => this.streams.set(stream, feed)
    }
  }

  /**
   * His paste into the VM he drives: his text on the guest's clipboard and Ctrl+V pressed, through the VM's
   * service (B9's `vmPaste`, set by `configureVmPaste`). Until that is there, a paste is refused in words.
   */
  async paste(stream: StreamInfo, text: string): Promise<void> {
    const feed = this.streams.get(stream.id)
    if (!feed || !this.owner) throw new Error('forbidden: video.paste needs a stream you are driving')
    if (!vmPaste) throw new Error(NO_VM_PASTE)
    await vmPaste(text, (event) => feed.type(event))
  }

  close(): void {
    for (const off of this.offs.splice(0)) off()
    this.previews.endAll()
  }
}

const refuse = (reason: VideoRefusal): VideoOpening => ({ ok: false, reason })

export const NO_VM_PASTE = 'Paste into the Windows VM is not here yet: it comes with its clipboard.'

/**
 * B9's paste into the guest (work/winvm, `vmPaste`): his text on the guest's clipboard, then Ctrl+V, typed on the
 * drive stream with `type`. Null until B9 sets it.
 */
export type VmPaste = (text: string, type: (event: InputEvent) => boolean) => Promise<void>
let vmPaste: VmPaste | null = null
export function configureVmPaste(fn: VmPaste | null): void {
  vmPaste = fn
}

interface Watcher {
  id: string
  viewer: Viewer
  maxEdge: number
}

/**
 * The 4 fps picture of the VM: QMP's screenshot of the guest's screen, as a
 * JPEG, to every watcher through one gate, so a watcher that does not draw
 * holds the next shot back. It runs only while someone watches.
 */
export class VmPreviews {
  private readonly watchers = new Map<string, Watcher>()
  private next = 0
  private seq = 0
  private timer: NodeJS.Timeout | null = null
  /** the gate let the last frame go: the next may be shot */
  private free = true
  private shooting = false
  private size = { width: 0, height: 0 }
  private readonly gate: PreviewGate<ComputerFramePush>

  constructor(
    private readonly d: Pick<VmPictureDeps, 'screenshot' | 'jpeg' | 'log' | 'now'>,
    private readonly awake: () => boolean
  ) {
    this.gate = new PreviewGate(
      () => (d.now ?? Date.now)(),
      () => void (this.free = true)
    )
  }

  /** The request is the VM's: a start for its name, an ack or a stop of one of its ids. */
  owns(req: ClientRequest): boolean {
    if (req.method === 'computer.preview.start') return req.params.threadId === VM_COMPUTER
    if (req.method === 'computer.preview.ack' || req.method === 'computer.preview.stop') return req.params.preview.startsWith(PREVIEW_PREFIX)
    return false
  }

  /** `computer.preview.*` for the VM; `access` as for the box's browser (`mayWatch`). */
  async handle(req: ClientRequest, viewer: Viewer, access: PreviewAccess): Promise<{ handled: boolean; result?: unknown }> {
    if (!this.owns(req)) return { handled: false }
    const refusal = previewRefusal({ ...access, box: true }, req.method)
    if (refusal) throw new Error(refusal)
    switch (req.method) {
      case 'computer.preview.start':
        return { handled: true, result: await this.start(viewer, req.params.maxEdge) }
      case 'computer.preview.ack':
        if (this.find(viewer.connection, req.params.preview)) this.gate.ack(req.params.preview, req.params.seq)
        break
      case 'computer.preview.stop':
        if (this.find(viewer.connection, req.params.preview)) this.remove(req.params.preview)
        break
    }
    return { handled: true, result: null }
  }

  async start(viewer: Viewer, maxEdge: number): Promise<ComputerPreviewStart> {
    if (!this.awake()) throw new Error('No computer window to preview')
    if (!Number.isInteger(maxEdge) || maxEdge < PREVIEW_MIN_EDGE || maxEdge > PREVIEW_MAX_EDGE) throw new Error('Invalid preview size')
    const id = `${PREVIEW_PREFIX}${++this.next}`
    this.watchers.set(id, { id, viewer, maxEdge })
    this.gate.add(id, (f) => viewer.send({ ...f, preview: id }))
    if (!this.size.width) await this.shoot()
    // frames go to it once its answer is on the socket: a frame naming an id the client does not know is never drawn
    setTimeout(() => this.gate.ready(id), 0)
    this.run()
    return { preview: id, app: VM_NAME, window: null, target: VM_COMPUTER, width: this.size.width, height: this.size.height }
  }

  dropConnection(connection: object): void {
    for (const w of [...this.watchers.values()]) if (w.viewer.connection === connection) this.remove(w.id)
  }

  /** The VM went to sleep (or Work off): every watcher is told its picture ended. */
  endAll(): void {
    for (const w of [...this.watchers.values()]) {
      w.viewer.send({ push: 'computer-preview', preview: w.id, state: 'ended', reason: 'closed' })
      this.remove(w.id)
    }
  }

  private find(connection: object, id: string): Watcher | undefined {
    const w = this.watchers.get(id)
    return w?.viewer.connection === connection ? w : undefined
  }

  private remove(id: string): void {
    this.watchers.delete(id)
    this.gate.remove(id)
    if (!this.watchers.size) this.halt()
  }

  private run(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.shoot(), PICTURE_MS)
    this.timer.unref?.()
  }

  private halt(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.free = true
    this.size = { width: 0, height: 0 }
  }

  /** One shot, when the last went and none is under way. */
  private async shoot(): Promise<void> {
    if (!this.free || this.shooting || !this.watchers.size || !this.awake()) return
    this.shooting = true
    try {
      const edge = Math.max(...[...this.watchers.values()].map((w) => w.maxEdge))
      const { data, width, height } = await this.d.jpeg(await this.d.screenshot(), edge)
      if (!this.watchers.size) return
      this.size = { width, height }
      this.free = false
      this.gate.frame({ push: 'computer-frame', preview: '', seq: ++this.seq, width, height, data })
    } catch (err) {
      this.d.log?.(`winvm picture: ${(err as Error).message}`)
    } finally {
      this.shooting = false
    }
  }
}

/** QMP's screenshot of the machine, through a file QEMU writes beside the picture's own (`dir`). */
export function qmpScreenshot(dir: string, shot: (file: string) => Promise<void>): () => Promise<Buffer> {
  let n = 0
  return async () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, `shot-${++n % 4}.png`)
    try {
      await shot(file)
      return readFileSync(file)
    } finally {
      rmSync(file, { force: true })
    }
  }
}

/** Electron's own encoder, in the server's process. */
export async function electronJpeg(png: Buffer, maxEdge: number): Promise<{ data: string; width: number; height: number }> {
  const { nativeImage } = await import('electron')
  let img = nativeImage.createFromBuffer(png)
  const { width, height } = img.getSize()
  if (!width || !height) throw new Error('the screenshot is empty')
  const k = Math.min(1, maxEdge / Math.max(width, height))
  if (k < 1) img = img.resize({ width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), quality: 'good' })
  return { data: img.toJPEG(70).toString('base64'), ...img.getSize() }
}
