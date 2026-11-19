import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configure } from 'aliax-core'
import { WebSocket } from 'ws'
import type { Capability } from '@shared/capabilities'
import { VIDEO_CLOSE, type VideoOpenAnswer } from '@shared/contract-video'
import { encodeAck, encodeInput, parseFrame } from '@shared/video/nsl1'
import type { RunningServer } from '../index'
import { findChromium } from '../work/browser/box/chromium'
import { FakeFeed } from './feed'
import type { VideoSource } from './rpc'

/**
 * Live video through two real servers on temp databases: one with no desktop
 * (the box) reached over keys on its fixed port, one with a desktop reached on
 * its own socket. A fake feed stands for the source; the contract, `mayWatch`,
 * the ticket and the `/video/<stream>` upgrade are the real ones.
 */
let root: string
let box: RunningServer
let desk: RunningServer
/** the feed of each stream a server's test source opened, newest last */
const feeds = new Map<RunningServer, FakeFeed[]>()

function testSource(server: RunningServer): VideoSource {
  feeds.set(server, [])
  return {
    open: async (ask) => {
      if (ask.thread !== 'live') return null
      const feed = new FakeFeed()
      feeds.get(server)!.push(feed)
      return { ok: true, feed, width: 1280, height: 800, fps: 120, scope: ask.drive ? 'drive' : 'watch', group: 'pane' }
    }
  }
}
const lastFeed = (server: RunningServer): FakeFeed => feeds.get(server)!.at(-1)!

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'tc-video-server-'))
  configure({
    dataDir: join(root, 'aliax'),
    fetch: async () => {
      throw new Error('no network in tests')
    },
    secrets: { mode: 'chromiumKey', keychainItem: 'Test Safe Storage' },
    appName: 'temp-code-test'
  })
  mkdirSync(join(root, 'out', 'renderer'), { recursive: true })
  writeFileSync(join(root, 'out', 'renderer', 'index.html'), '<!doctype html><html><body></body></html>')
  const { startServer } = await import('../index')
  mkdirSync(join(root, 'box'))
  mkdirSync(join(root, 'desk'))
  box = await startServer(join(root, 'box', 'app.db'), { claimShim: false, remotePort: 0, appPath: root, desktop: false })
  desk = await startServer(join(root, 'desk', 'app.db'), { claimShim: false, remotePort: 0, appPath: root, desktop: true })
  box.video.rpc.addSource(testSource(box))
  desk.video.rpc.addSource(testSource(desk))
}, 120_000)
afterAll(async () => {
  await box?.close()
  await desk?.close()
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

interface Rpc {
  ws: WebSocket
  request: <T = unknown>(method: string, params?: unknown) => Promise<{ ok: boolean; result?: T; error?: string }>
}
function open(url: string): Promise<Rpc> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let next = 1
    const pending = new Map<string, (frame: { ok: boolean; result?: unknown; error?: string }) => void>()
    ws.on('message', (d) => {
      const frame = JSON.parse(String(d))
      if (!frame.push) pending.get(frame.id)?.(frame)
    })
    ws.on('error', reject)
    ws.on('open', () =>
      resolve({
        ws,
        request: (method, params) =>
          new Promise((r) => {
            const id = String(next++)
            pending.set(id, r as never)
            ws.send(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }))
          })
      })
    )
  })
}
const local = (server: RunningServer): Promise<Rpc> => open(`ws://127.0.0.1:${server.port}`)
async function keyed(server: RunningServer, caps: Capability[], audience: 'client' | 'mcp' = 'client'): Promise<{ rpc: Rpc; keyId: string }> {
  const { token, key } = await server.remoteAuth.createKey({ name: `key-${caps.join('-')}`, audience, caps, createdBy: 'local' })
  const ticket = await new Promise<string>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: server.remote!.port, path: '/api/ticket', method: 'POST', headers: { Authorization: `Bearer ${token}` } }, (res) => {
      let text = ''
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve(JSON.parse(text).ticket))
    })
    req.on('error', reject)
    req.end()
  })
  return { rpc: await open(`ws://127.0.0.1:${server.remote!.port}/ws?ticket=${ticket}`), keyId: key.id }
}

interface Viewer {
  ws: WebSocket
  frames: Uint8Array[]
  closed: Promise<{ code: number; reason: string }>
}
/** A viewer's socket on a stream: resolves once it is open, rejects with the HTTP status of a refused upgrade. */
function view(port: number, stream: string, ticket: string | null, protocols: string[] = ['nsl1']): Promise<Viewer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/video/${stream}${ticket === null ? '' : `?ticket=${ticket}`}`, protocols)
    const frames: Uint8Array[] = []
    ws.on('message', (data, isBinary) => {
      if (isBinary) frames.push(data as Buffer)
    })
    const closed = new Promise<{ code: number; reason: string }>((r) => ws.on('close', (code, reason) => r({ code, reason: String(reason) })))
    ws.on('unexpected-response', (_req, res) => reject(new Error(`refused ${res.statusCode}`)))
    ws.on('error', (err) => reject(err))
    ws.on('open', () => resolve({ ws, frames, closed }))
  })
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const until = async (what: () => boolean, ms = 3_000): Promise<void> => {
  const end = Date.now() + ms
  while (!what()) {
    if (Date.now() > end) throw new Error('timed out')
    await sleep(10)
  }
}
const ASK = { threadId: 'live', maxEdge: 1280 }

describe('live video on a host with no desktop, over keys', () => {
  it('a key with approve opens a stream, joins it with the ticket, gets frames, and its acks reach the source', async () => {
    const { rpc } = await keyed(box, ['approve'])
    const answer = (await rpc.request<VideoOpenAnswer>('video.open', ASK)).result!
    expect(answer).toMatchObject({ ok: true, width: 1280, height: 800, fps: 120 })
    if (!answer.ok) throw new Error()
    const feed = lastFeed(box)
    expect(feed.started).toBe(false)
    const viewer = await view(box.remote!.port, answer.stream, answer.ticket)
    expect(viewer.ws.protocol).toBe('nsl1')
    // no deflate was agreed: the payload is H.264
    expect(viewer.ws.extensions).toBe('')
    await until(() => feed.started)
    feed.push({ size: 5_000 })
    feed.push({ size: 300 })
    await until(() => viewer.frames.length === 2)
    expect(viewer.frames.map((b) => parseFrame(b).sequence)).toEqual([1, 2])
    expect(viewer.frames[0].byteLength).toBe(20 + 12 + 5_000)
    viewer.ws.send(encodeAck(1, 1, 2.5))
    viewer.ws.send(encodeAck(1, 2))
    // a watch stream: his input goes nowhere
    viewer.ws.send(encodeInput({ type: 'keyDown', key: 4 }, 1))
    await until(() => feed.acks.length === 2)
    expect(feed.acked()).toEqual([1, 2])
    expect(feed.inputs).toEqual([])
    // the caller's own close ends it
    await rpc.request('video.close', { stream: answer.stream })
    expect(await viewer.closed).toEqual({ code: VIDEO_CLOSE.ended, reason: 'ended' })
    expect(feed.closed).toBe(true)
    rpc.ws.close()
  })

  it('never gives a stream to an mcp key, a key without approve, or this host’s own socket', async () => {
    const reader = await keyed(box, ['operate'])
    expect(await reader.rpc.request('video.open', ASK)).toMatchObject({ ok: false, error: 'forbidden: video.open needs approve' })
    expect(await reader.rpc.request('video.paste', { stream: 'abcdefgh', text: 'x' })).toMatchObject({ ok: false, error: 'forbidden: video.paste needs approve' })
    reader.rpc.ws.close()
    // an mcp key holds no socket here at all and can never hold approve; a stream ticket minted in its name still opens nothing
    const bot = await box.remoteAuth.createKey({ name: 'bot', audience: 'mcp', caps: ['operate'], createdBy: 'local' })
    const stream = box.video.relay.open({ thread: 'live', scope: 'watch', holder: { keyId: bot.key.id }, connection: {}, feed: new FakeFeed() })
    const ticket = box.remoteAuth.mintStreamTicket({ stream, scope: 'watch', holder: { keyId: bot.key.id } }).ticket
    await expect(view(box.remote!.port, stream, ticket)).rejects.toThrow('refused 401')
    // the box's own socket: any process of its user reaches it as admin, so it gets no stream
    const me = await local(box)
    expect((await me.request('video.open', ASK)).result).toEqual({ ok: false, reason: 'refused' })
    me.ws.close()
  })

  it('says unsupported for a thread no source knows', async () => {
    const { rpc } = await keyed(box, ['approve'])
    expect((await rpc.request('video.open', { threadId: 'elsewhere', maxEdge: 1280 })).result).toEqual({ ok: false, reason: 'unsupported' })
    expect(await rpc.request('video.open', { threadId: 'live', maxEdge: 64 })).toMatchObject({ ok: false })
    rpc.ws.close()
  })

  it('closes a stream with revoked when its key is revoked, and with ended when the socket that asked goes', async () => {
    const { rpc, keyId } = await keyed(box, ['approve'])
    const a = (await rpc.request<{ stream: string; ticket: string }>('video.open', ASK)).result!
    const viewer = await view(box.remote!.port, a.stream, a.ticket)
    const waiting = (await rpc.request<{ stream: string; ticket: string }>('video.open', ASK)).result!
    box.remoteAuth.revokeKey(keyId)
    expect(await viewer.closed).toEqual({ code: VIDEO_CLOSE.revoked, reason: 'revoked' })
    await expect(view(box.remote!.port, waiting.stream, waiting.ticket)).rejects.toThrow('refused 401')

    const other = await keyed(box, ['approve'])
    const b = (await other.rpc.request<{ stream: string; ticket: string }>('video.open', ASK)).result!
    const second = await view(box.remote!.port, b.stream, b.ticket)
    other.rpc.ws.close()
    expect(await second.closed).toEqual({ code: VIDEO_CLOSE.ended, reason: 'ended' })
  })

  it('passes a drive stream’s input only while he is the driver', async () => {
    const { rpc } = await keyed(box, ['approve'])
    const a = (await rpc.request<{ stream: string; ticket: string }>('video.open', { ...ASK, drive: true })).result!
    const feed = lastFeed(box)
    const viewer = await view(box.remote!.port, a.stream, a.ticket)
    await until(() => feed.started)
    viewer.ws.send(encodeInput({ type: 'keyDown', key: 4 }, 1))
    viewer.ws.send(encodeAck(1, 1))
    await until(() => feed.acks.length === 1)
    expect(feed.inputs).toEqual([])
    box.video.relay.setDriver('pane', true)
    viewer.ws.send(encodeInput({ type: 'keyDown', key: 5 }, 1))
    await until(() => feed.inputs.length === 1)
    box.video.relay.setDriver('pane', false)
    // as he handed back the source was told to let go of what he held, and nothing of his passes after
    expect(feed.released).toBe(1)
    viewer.ws.send(encodeInput({ type: 'keyDown', key: 6 }, 1))
    viewer.ws.send(encodeAck(1, 2))
    await until(() => feed.acks.length === 2)
    expect(feed.inputs).toHaveLength(1)
    viewer.ws.close()
    rpc.ws.close()
  })
})

// On the second server's fixed port: a refused ticket counts against the caller's address (ten in ten
// minutes lock it out), and the tests above spend some of the first server's.
describe('the upgrade of a stream’s socket', () => {
  it('refuses a missing, wrong, spent or misplaced ticket, and a socket that does not speak nsl1', async () => {
    const { rpc } = await keyed(desk, ['approve'])
    const ask = async (): Promise<{ stream: string; ticket: string }> => (await rpc.request<{ stream: string; ticket: string }>('video.open', ASK)).result!
    const a = await ask()
    await expect(view(desk.remote!.port, a.stream, null)).rejects.toThrow('refused 401')
    await expect(view(desk.remote!.port, a.stream, 'not-a-ticket')).rejects.toThrow('refused 401')
    // the ticket of another stream opens neither, and is spent by the try
    const b = await ask()
    await expect(view(desk.remote!.port, a.stream, b.ticket)).rejects.toThrow('refused 401')
    await expect(view(desk.remote!.port, b.stream, b.ticket)).rejects.toThrow('refused 401')
    // a socket ticket is not a stream ticket
    const socketTicket = desk.remoteAuth.mintTicket({ kind: 'remote', keyId: 'x', name: 'x', audience: 'client', caps: ['admin'] }).ticket
    await expect(view(desk.remote!.port, a.stream, socketTicket)).rejects.toThrow('refused 401')
    // no nsl1 on offer: refused before the ticket is read, so the ticket still opens the stream
    await expect(view(desk.remote!.port, a.stream, a.ticket, [])).rejects.toThrow('refused 400')
    // a key's ticket is the fixed port's alone: this host's own socket server refuses it
    const c = await ask()
    await expect(view(desk.port, c.stream, c.ticket)).rejects.toThrow('refused 403')
    const viewer = await view(desk.remote!.port, a.stream, a.ticket)
    // single use: the same ticket again, and a second socket on a joined stream
    await expect(view(desk.remote!.port, a.stream, a.ticket)).rejects.toThrow('refused 401')
    const again = desk.remoteAuth.mintStreamTicket({ stream: a.stream, scope: 'watch', holder: { keyId: 'x' } }).ticket
    await expect(view(desk.remote!.port, a.stream, again)).rejects.toThrow('refused 401')
    await expect(view(desk.remote!.port, 'no/such', 'x')).rejects.toThrow('refused 404')
    viewer.ws.close()
    rpc.ws.close()
  })
})

describe('the JPEG preview of the box’s browser, under the same rule', () => {
  const START = { threadId: 'no-such-thread', maxEdge: 512 }
  it('a key without approve and this host’s own socket are refused', async () => {
    const reader = await keyed(box, ['operate'])
    expect(await reader.rpc.request('computer.preview.start', START)).toMatchObject({ ok: false, error: 'forbidden: computer.preview.start needs approve' })
    reader.rpc.ws.close()
    const me = await local(box)
    expect(await me.request('computer.preview.start', START)).toMatchObject({ ok: false, error: "forbidden: computer.preview.start is not served on this host's own socket" })
    me.ws.close()
  })

  // Only a Linux host with a Chromium wires the box's browser (index.ts): there the previews are the browser's.
  const onBox = process.platform === 'linux' && findChromium() ? it : it.skip
  onBox('a key with approve is answered by the box’s browser: no page for that thread, and nothing forbidden', async () => {
    const { rpc } = await keyed(box, ['approve'])
    let answer = await rpc.request('computer.preview.start', START)
    // the browser's wiring loads apart, a moment after boot
    for (let i = 0; i < 200 && /local-only|not available/.test(answer.error ?? ''); i++) {
      await sleep(25)
      answer = await rpc.request('computer.preview.start', START)
    }
    expect(answer.ok).toBe(false)
    expect(answer.error).toMatch(/No computer window/)
    rpc.ws.close()
  })

  const offBox = process.platform === 'linux' && findChromium() ? it.skip : it
  offBox("a host whose previews are a person's windows refuses every key", async () => {
    const { rpc } = await keyed(box, ['admin'])
    expect(await rpc.request('computer.preview.start', START)).toMatchObject({ ok: false, error: 'forbidden: computer.preview.start is local-only' })
    rpc.ws.close()
  })
})

describe('live video on a desktop, on its own socket', () => {
  it('opens a stream for its own socket, plays it on the local server, and ends it when that socket goes', async () => {
    const me = await local(desk)
    const answer = (await me.request<VideoOpenAnswer>('video.open', { ...ASK, drive: true })).result!
    if (!answer.ok) throw new Error(JSON.stringify(answer))
    const feed = lastFeed(desk)
    // a desktop's ticket is its own server's alone
    const elsewhere = (await me.request<{ stream: string; ticket: string }>('video.open', ASK)).result!
    await expect(view(desk.remote!.port, elsewhere.stream, elsewhere.ticket)).rejects.toThrow('refused 403')
    const viewer = await view(desk.port, answer.stream, answer.ticket)
    await until(() => feed.started)
    feed.push()
    await until(() => viewer.frames.length === 1)
    desk.video.relay.setDriver('pane', true)
    viewer.ws.send(encodeInput({ type: 'buttonDown', button: 1, x: 0.5, y: 0.5 }, 1))
    await until(() => feed.inputs.length === 1)
    // the socket that asked goes: its stream goes with it
    me.ws.close()
    expect(await viewer.closed).toEqual({ code: VIDEO_CLOSE.ended, reason: 'ended' })
  })

  it('"Watch from my other devices" is off, and only this desktop’s own socket sets it: no key can', async () => {
    const me = await local(desk)
    expect((await me.request<{ videoRemote: boolean }>('computer.settings.get', {})).result?.videoRemote).toBe(false)
    const admin = await keyed(desk, ['admin'])
    expect(await admin.rpc.request('computer.settings.set', { videoRemote: true })).toMatchObject({ ok: false, error: 'forbidden: computer.settings.set is local-only' })
    expect((await me.request<{ videoRemote: boolean }>('computer.settings.get', {})).result?.videoRemote).toBe(false)
    expect((await me.request<{ videoRemote: boolean }>('computer.settings.set', { videoRemote: true })).result?.videoRemote).toBe(true)
    expect((await me.request<{ videoRemote: boolean }>('computer.settings.set', { videoRemote: false })).result?.videoRemote).toBe(false)
    admin.rpc.ws.close()
    me.ws.close()
  })

  it('another socket of the same desktop closes nothing of it', async () => {
    const me = await local(desk)
    const other = await local(desk)
    const a = (await me.request<{ stream: string; ticket: string }>('video.open', ASK)).result!
    const viewer = await view(desk.port, a.stream, a.ticket)
    await other.request('video.close', { stream: a.stream })
    await sleep(50)
    expect(viewer.ws.readyState).toBe(WebSocket.OPEN)
    await me.request('video.close', { stream: a.stream })
    expect((await viewer.closed).code).toBe(VIDEO_CLOSE.ended)
    me.ws.close()
    other.ws.close()
  })
})
