import { describe, expect, it } from 'vitest'
import { LOCAL_PRINCIPAL } from '@shared/capabilities'
import type { ClientRequest } from '@shared/contract'
import type { ComputerClickPush, ComputerFramePush, ComputerPreviewPush } from '@shared/contract-computer'
import type { WinvmState } from '@shared/contract-work-winvm'
import type { EngineLease } from '../browser/box/engine'
import { VideoRelay, type ViewerSocket } from '../../video/relay'
import { VideoRpc } from '../../video/rpc'
import { joinRows } from './host'
import { configureVmPaste, NO_VM_PASTE, VM_COMPUTER, VmPicture, type VmPictureDeps } from './picture'

type Push = ComputerFramePush | ComputerClickPush | ComputerPreviewPush

/** The Windows VM's row, its video source and its 4 fps picture, over a fake keeper and screen. */

const awake = (since = 1_000): WinvmState => ({ state: 'awake', step: null, error: null, cannot: null, sleepAfter: '30m', since })
const asleep: WinvmState = { ...awake(), state: 'asleep' }

function fakeLease(): EngineLease & { released: number } {
  const l = { port: 1, token: 't', pid: null, released: 0, onExit: () => {}, release: () => void l.released++ }
  return l
}

function setup(o: { state?: WinvmState | null; display?: boolean; missingTool?: string | null; leases?: number; holder?: string | null } = {}) {
  let state: WinvmState | null = o.state === undefined ? awake() : o.state
  const listeners = new Set<(s: WinvmState | null) => void>()
  const viewers: number[] = []
  const leases: ReturnType<typeof fakeLease>[] = []
  let left = o.leases ?? 3
  let shots = 0
  const display = o.display ?? true
  let holder = o.holder ?? null
  const relay = new VideoRelay()
  const deps: VmPictureDeps = {
    state: () => state,
    onState: (fn) => (listeners.add(fn), () => void listeners.delete(fn)),
    setViewers: (n) => void viewers.push(n),
    screen: {
      env: display ? { DISPLAY: ':7', XAUTHORITY: '/x' } : null,
      size: display ? { width: 1280, height: 800 } : null,
      missingTool: o.missingTool ?? null,
      adopt: () => {},
      engines: {
        lease: async () => {
          if (left <= 0) return null
          left--
          const l = fakeLease()
          leases.push(l)
          return l
        }
      } as never
    },
    relay,
    screenshot: async () => {
      shots++
      return Buffer.from('png')
    },
    jpeg: async (_png, edge) => ({ data: 'anBn', width: Math.min(edge, 1280), height: Math.round(Math.min(edge, 1280) * 0.625) }),
    holder: () => holder
  }
  const picture = new VmPicture(deps)
  const set = (s: WinvmState | null): void => {
    state = s
    for (const fn of listeners) fn(s)
  }
  return { picture, relay, viewers, leases, set, shots: () => shots, hold: (h: string | null) => (holder = h) }
}

const ask = (o: { computer?: string; thread?: string } = {}) => ({ thread: o.thread ?? VM_COMPUTER, computer: o.computer ?? VM_COMPUTER, maxEdge: 1280, take: false, drive: false, principal: LOCAL_PRINCIPAL, local: true })

describe("the Windows VM's row", () => {
  it('is listed while the VM is awake, idle and titled by its own name when no thread holds it', () => {
    const { picture } = setup()
    expect(picture.rows()).toEqual([
      { threadId: VM_COMPUTER, since: 1_000, lastCallAt: 1_000, apps: [{ name: 'Windows VM', bundleId: null, window: null }], running: null, tier: null, computer: VM_COMPUTER, idle: true }
    ])
    expect(setup({ state: asleep }).picture.rows()).toEqual([])
    expect(setup({ state: null }).picture.rows()).toEqual([])
  })

  it('names the thread that holds it, and is not idle then', () => {
    const t = setup({ holder: 'thread-1' })
    expect(t.picture.rows()[0]).toMatchObject({ threadId: 'thread-1', computer: VM_COMPUTER })
    expect(t.picture.rows()[0]!.idle).toBeUndefined()
  })

  it('offers no Take over where the VM has no window', () => {
    expect(setup({ display: false, missingTool: 'qemu-window' }).picture.rows()[0]).toMatchObject({ pictureOnly: true })
    expect(setup().picture.rows()[0]!.pictureOnly).toBeUndefined()
  })

  it('tells the rows when it wakes and sleeps', () => {
    const t = setup({ state: asleep })
    const seen: number[] = []
    t.picture.onRows((rows) => seen.push(rows.length))
    t.set(awake())
    t.set(asleep)
    expect(seen).toEqual([1, 0])
  })

  it("yields to the sessions of the threads that drive it, and marks every row picture-only with no window", async () => {
    const t = setup()
    const session = { threadId: 'b', since: 1, lastCallAt: 1, apps: [], running: null, tier: null, computer: VM_COMPUTER }
    let driven = [session]
    const sessions = { rows: () => driven, onRows: () => () => true, stop: async (id: string) => id === 'b' }
    const rows = joinRows(sessions, t.picture)
    expect(rows.rows().map((r) => r.threadId)).toEqual(['b'])
    expect(await rows.stop('b')).toBe(true)
    driven = []
    expect(rows.rows().map((r) => r.threadId)).toEqual([VM_COMPUTER])
    expect(await rows.stop(VM_COMPUTER)).toBe(false)
    const bare = setup({ display: false, missingTool: 'qemu-window' })
    expect(joinRows({ ...sessions, rows: () => [session] }, bare.picture).rows()[0]).toMatchObject({ threadId: 'b', pictureOnly: true })
  })
})

describe("the Windows VM's video", () => {
  it('answers only an ask that names it, whatever the thread', async () => {
    const t = setup()
    expect(await t.picture.open({ ...ask(), computer: undefined } as never)).toBeNull()
    expect(await t.picture.open(ask({ computer: 'browser:x' }))).toBeNull()
    const opening = await t.picture.open(ask({ thread: 'any-thread' }))
    expect(opening).toMatchObject({ ok: true, width: 1280, height: 800, scope: 'watch', group: VM_COMPUTER, tag: VM_COMPUTER })
  })

  it('refuses while it sleeps, without its tools, and past three viewers', async () => {
    expect(await setup({ state: asleep }).picture.open(ask())).toEqual({ ok: false, reason: 'unsupported' })
    expect(await setup({ display: false, missingTool: 'screen-relay' }).picture.open(ask())).toEqual({ ok: false, reason: 'no-tools' })
    expect(await setup({ display: false }).picture.open(ask())).toEqual({ ok: false, reason: 'unsupported' })
    const t = setup({ leases: 3 })
    for (let i = 0; i < 3; i++) expect((await t.picture.open(ask()))?.ok).toBe(true)
    expect(await t.picture.open(ask())).toEqual({ ok: false, reason: 'busy' })
  })

  it('gives its engine back when the stream ends', async () => {
    const t = setup()
    const opening = await t.picture.open(ask())
    if (!opening?.ok) throw new Error('not opened')
    opening.feed.close()
    expect(t.leases[0]!.released).toBe(1)
  })

  it('is opened through the RPC by `computer`, holds the VM awake while watched, and ends when it sleeps', async () => {
    const t = setup()
    const rpc = new VideoRpc(t.relay, { mintStreamTicket: () => ({ ticket: 'k', expiresIn: 30 }) }, () => true)
    rpc.addSource(t.picture)
    const connection = {}
    const caller = { principal: { kind: 'remote' as const, keyId: 'k1', name: 'phone', audience: 'client' as const, caps: ['read' as const, 'operate' as const, 'approve' as const] }, connection, connectionId: '1' }
    expect(await rpc.open({ threadId: 'x', maxEdge: 1280 }, caller)).toEqual({ ok: false, reason: 'unsupported' })
    const answer = await rpc.open({ threadId: 'x', computer: VM_COMPUTER, maxEdge: 1280 }, caller)
    if (!answer.ok) throw new Error(answer.reason)
    const closed: number[] = []
    const socket: ViewerSocket = { bufferedAmount: 0, send: () => {}, close: (code) => void closed.push(code), on: () => {} }
    expect(t.relay.attach({ stream: answer.stream, scope: 'watch', holder: { keyId: 'k1' } }, socket)).toBe(true)
    expect(t.viewers.at(-1)).toBe(1)
    t.set(asleep)
    expect(closed).toHaveLength(1)
    expect(t.viewers.at(-1)).toBe(0)
  })
})

describe("the Windows VM's 4 fps picture", () => {
  const start = (maxEdge = 640): ClientRequest => ({ id: '1', method: 'computer.preview.start', params: { threadId: VM_COMPUTER, maxEdge } }) as ClientRequest
  const access = { principal: LOCAL_PRINCIPAL, desktop: true, box: false }
  const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  it('takes only its own requests, with ids that never meet the box browser previews', async () => {
    const t = setup()
    const sent: unknown[] = []
    const viewer = { connection: {}, send: (f: unknown) => void sent.push(f) }
    expect(t.picture.previews.owns({ id: '1', method: 'computer.preview.start', params: { threadId: 'thread', maxEdge: 640 } } as ClientRequest)).toBe(false)
    expect(t.picture.previews.owns({ id: '1', method: 'computer.preview.ack', params: { preview: 'preview_1', seq: 1 } } as ClientRequest)).toBe(false)
    const started = await t.picture.previews.handle(start(), viewer, access)
    expect(started.result).toMatchObject({ preview: 'vm-preview_1', app: 'Windows VM', window: null, width: 640, height: 400 })
    t.picture.previews.dropConnection(viewer.connection)
  })

  it('sends QMP shots as frames while watched, and none once the watcher stops', async () => {
    const t = setup()
    const sent: Push[] = []
    const viewer = { connection: {}, send: (f: Push) => void sent.push(f) }
    await t.picture.previews.handle(start(), viewer, access)
    await tick(700)
    const frames = sent.filter((f): f is ComputerFramePush => f.push === 'computer-frame')
    expect(frames.length).toBeGreaterThanOrEqual(1)
    expect(frames[0]).toMatchObject({ preview: 'vm-preview_1', width: 640, height: 400, data: 'anBn' })
    for (const f of frames) await t.picture.previews.handle({ id: '2', method: 'computer.preview.ack', params: { preview: f.preview, seq: f.seq } } as ClientRequest, viewer, access)
    await t.picture.previews.handle({ id: '3', method: 'computer.preview.stop', params: { preview: 'vm-preview_1' } } as ClientRequest, viewer, access)
    const after = t.shots()
    await tick(600)
    expect(t.shots()).toBe(after)
  })

  it('ends every watcher when the VM sleeps, and refuses a start then', async () => {
    const t = setup()
    const sent: Push[] = []
    await t.picture.previews.handle(start(), { connection: {}, send: (f: Push) => void sent.push(f) }, access)
    t.set(asleep)
    expect(sent.at(-1)).toEqual({ push: 'computer-preview', preview: 'vm-preview_1', state: 'ended', reason: 'closed' })
    await expect(t.picture.previews.handle(start(), { connection: {}, send: () => {} }, access)).rejects.toThrow(/No computer window/)
  })

  it('goes where the box browser goes (mayWatch): never to the box host own socket', async () => {
    const t = setup()
    await expect(t.picture.previews.handle(start(), { connection: {}, send: () => {} }, { principal: LOCAL_PRINCIPAL, desktop: false, box: false })).rejects.toThrow(/forbidden/)
  })
})

describe("his Take over, on the VM's video", () => {
  const drive = { ...ask(), drive: true }

  it('gives a drive stream only while he drives, and a watch stream to every other ask', async () => {
    const t = setup()
    expect(await t.picture.open(drive)).toMatchObject({ ok: true, scope: 'watch' })
    t.picture.setDriving(true)
    expect(t.relay.driving(VM_COMPUTER)).toBe(true)
    expect(await t.picture.open(drive)).toMatchObject({ ok: true, scope: 'drive', group: VM_COMPUTER })
    expect(await t.picture.open(ask())).toMatchObject({ ok: true, scope: 'watch' })
    t.picture.setDriving(false)
    expect(t.relay.driving(VM_COMPUTER)).toBe(false)
  })

  it('lists his row while he drives, under the VM name, with nothing idle about it', () => {
    const t = setup({ holder: 'thread-1' })
    t.picture.setDriving(true)
    expect(t.picture.rows()[0]).toMatchObject({ threadId: VM_COMPUTER, driver: 'owner', computer: VM_COMPUTER })
    expect(t.picture.rows()[0]!.idle).toBeUndefined()
    // with threads' sessions still listed as he takes it, his row is the one shown
    const rows = joinRows({ rows: () => [{ threadId: 'thread-1', since: 1, lastCallAt: 1, apps: [], running: null, tier: null, computer: VM_COMPUTER }], onRows: () => () => true, stop: async () => true }, t.picture)
    expect(rows.rows().map((r) => [r.threadId, r.driver])).toEqual([[VM_COMPUTER, 'owner']])
  })

  it('hands back by itself when the VM goes to sleep under him', () => {
    const t = setup()
    let back = 0
    t.picture.setDriving(true, () => void back++)
    t.set(asleep)
    expect(back).toBe(1)
  })

  it('takes his paste through the VM clipboard where B9 set it, and says it is not there yet otherwise', async () => {
    const t = setup()
    t.picture.setDriving(true)
    const rpc = new VideoRpc(t.relay, { mintStreamTicket: () => ({ ticket: 'k', expiresIn: 30 }) }, () => true)
    rpc.addSource(t.picture)
    const connection = {}
    const caller = { principal: LOCAL_PRINCIPAL, connection, connectionId: '1' }
    const answer = await rpc.open({ threadId: 'x', computer: VM_COMPUTER, maxEdge: 1280, drive: true }, caller)
    if (!answer.ok) throw new Error(answer.reason)
    await expect(rpc.paste({ stream: answer.stream, text: 'hi' }, caller)).rejects.toThrow(NO_VM_PASTE)
    const pasted: string[] = []
    configureVmPaste(async (text) => void pasted.push(text))
    await rpc.paste({ stream: answer.stream, text: 'hi' }, caller)
    expect(pasted).toEqual(['hi'])
    configureVmPaste(null)
  })
})
