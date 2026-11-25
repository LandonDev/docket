/**
 * Input to picture on the Windows VM, as his device sees it (docs/agents/live-video.md "The Windows VM"): a client
 * key on the box's listener, Take over (`computer.drive`), a drive stream of `vm:windows`, then pointer moves only (no
 * button, no key). Records frames and cursor changes after each move, plus the socket's round trip and the
 * relay's capture delay. Hand back at the end, the stream closed.
 *
 *   bun scripts/measure-vm-input-delay.ts --key-file <file holding { token }> [--port 7677] [--samples 30] [--out <json>]
 *
 * The key file is the answer of `remote.keys.create` (client, read operate approve); the token is never printed.
 * Refuses to run while a thread drives the VM: Take over would stop it.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { MESSAGE_TYPES, encodeAck, encodeInput, encodePing, messageType, parseCursor, parseFrame, parsePong } from '../src/shared/video/nsl1'

const arg = (name: string, fallback?: string): string => {
  const i = process.argv.indexOf(`--${name}`)
  const v = i >= 0 ? process.argv[i + 1] : fallback
  if (v === undefined) throw new Error(`--${name} is needed`)
  return v
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const load = (): string => readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' ')

class Client {
  private ws!: WebSocket
  private n = 0
  private waiting = new Map<string, { ok: (v: unknown) => void; fail: (e: Error) => void }>()
  constructor(private readonly port: number, private readonly token: string) {}
  async open(): Promise<void> {
    const r = await fetch(`http://127.0.0.1:${this.port}/api/ticket`, { method: 'POST', headers: { Authorization: `Bearer ${this.token}` } })
    if (!r.ok) throw new Error(`/api/ticket answered ${r.status}`)
    const { ticket } = (await r.json()) as { ticket: string }
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws?ticket=${encodeURIComponent(ticket)}`)
    await new Promise((ok, fail) => ((this.ws.onopen = ok), (this.ws.onerror = fail)))
    this.ws.onmessage = (ev) => {
      const f = JSON.parse(String(ev.data)) as { id?: string; ok?: boolean; result?: unknown; error?: string }
      const w = f.id ? this.waiting.get(f.id) : undefined
      if (!w) return
      this.waiting.delete(f.id!)
      if (f.ok) w.ok(f.result)
      else w.fail(new Error(f.error))
    }
  }
  call<T>(method: string, params: unknown): Promise<T> {
    const id = `m${++this.n}`
    return new Promise<T>((ok, fail) => {
      this.waiting.set(id, { ok: ok as (v: unknown) => void, fail })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => this.waiting.has(id) && (this.waiting.delete(id), fail(new Error(`no answer to ${method}`))), 90_000)
    })
  }
  close(): void {
    this.ws.close()
  }
}

const quantile = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]
}

export function parseMeasurementRecord(data: unknown) {
  if (!(data instanceof ArrayBuffer)) return null
  switch (messageType(data)) {
    case MESSAGE_TYPES.frame: return { type: 'frame' as const, frame: parseFrame(data) }
    case MESSAGE_TYPES.cursor: return { type: 'cursor' as const, shape: parseCursor(data) }
    case MESSAGE_TYPES.pong: return { type: 'pong' as const, ...parsePong(data) }
    default: return null
  }
}

async function main(): Promise<void> {
  const port = Number(arg('port', '7677'))
  const samples = Number(arg('samples', '30'))
  const token = (JSON.parse(readFileSync(arg('key-file'), 'utf8')) as { token: string }).token
  const client = new Client(port, token)
  await client.open()
  const rows = (await client.call<{ sessions: { computer?: string; idle?: boolean; driver?: string }[] }>('computer.sessions', {})).sessions
  if (rows.some((r) => r.computer === 'vm:windows' && !r.idle && r.driver !== 'owner')) throw new Error('a thread drives the Windows VM now: Take over would stop it')
  const loads: string[] = [load()]
  const t0 = Date.now()
  await client.call('computer.drive', { computer: 'vm:windows', driver: 'owner' })
  const tookOver = Date.now() - t0
  let result: Record<string, unknown> = {}
  let sock: WebSocket | undefined
  let probe: ReturnType<typeof setInterval> | undefined
  try {
    const opened = await client.call<{ ok: boolean; stream: string; ticket: string; width: number; height: number; reason?: string }>('video.open', { threadId: 'vm:windows', computer: 'vm:windows', maxEdge: 1280, drive: true, accepts: ['cursor', 'pong'] })
    if (!opened.ok) throw new Error(`video.open refused: ${opened.reason}`)
    const socket = sock = new WebSocket(`ws://127.0.0.1:${port}/video/${opened.stream}?ticket=${encodeURIComponent(opened.ticket)}`, ['nsl1'])
    socket.binaryType = 'arraybuffer'
    let generation = 0
    const frames: { at: number; bytes: number; key: boolean }[] = []
    const cursors: { at: number; width: number; height: number; hotX: number; hotY: number }[] = []
    const pongs: { roundTripMs: number; captureMs?: number }[] = []
    let ping: { sequence: number; at: number } | undefined
    let pingSequence = 0
    const sendPing = () => {
      if (socket.readyState !== WebSocket.OPEN) return
      ping = { sequence: ++pingSequence, at: performance.now() }
      socket.send(encodePing(ping.sequence))
    }
    const openedAt = Date.now()
    const openedPerf = performance.now()
    socket.onmessage = (ev) => {
      const record = parseMeasurementRecord(ev.data)
      const at = performance.now()
      if (record?.type === 'frame') {
        const f = record.frame
        generation = f.generation
        frames.push({ at, bytes: (ev.data as ArrayBuffer).byteLength, key: f.keyframe })
        socket.send(encodeAck(f.generation, f.sequence, 0))
      } else if (record?.type === 'cursor') {
        const { width, height, hotX, hotY } = record.shape
        cursors.push({ at, width, height, hotX, hotY })
      } else if (record?.type === 'pong' && ping?.sequence === record.sequence) {
        pongs.push({ roundTripMs: at - ping.at, captureMs: record.captureMs })
        ping = undefined
      }
    }
    await new Promise((ok, fail) => ((socket.onopen = ok), (socket.onerror = fail)))
    sendPing()
    probe = setInterval(sendPing, 1000)
    while (!frames.length && Date.now() - openedAt < 10_000) await sleep(20)
    if (!generation) throw new Error('the stream sent no frame')
    const firstFrameMs = frames.length ? Math.round(frames[0].at - openedPerf) : null
    const quiet = async (ms: number) => {
      for (let i = 0; i < 100; i++) {
        const last = frames.at(-1)?.at ?? 0
        if (performance.now() - last >= ms) return
        await sleep(ms / 4)
      }
    }
    await quiet(500)
    const delays: number[] = []
    /** every frame's arrival after each record, in ms: the first may be X's own pointer moving, the later ones Windows' */
    const bursts: number[][] = []
    const missed: number[] = []
    const cursorBursts: number[][] = []
    // the pointer along a short path over the desktop's right half, a new place each time; no button is ever pressed
    for (let i = 0; i < samples; i++) {
      const x = 0.55 + (i % 10) * 0.03
      const y = 0.35 + Math.floor(i / 10) * 0.08
      const before = frames.length
      const beforeCursor = cursors.length
      const sent = performance.now()
      socket.send(encodeInput({ type: 'pointerMove', x, y }, generation))
      while (frames.length === before && performance.now() - sent < 2000) await sleep(1)
      if (frames.length > before) delays.push(frames[before].at - sent)
      else missed.push(i)
      await quiet(400)
      cursorBursts.push(cursors.slice(beforeCursor).map((c) => Math.round(c.at - sent)))
      bursts.push(frames.slice(before).map((f) => Math.round(f.at - sent)))
      if (i % 10 === 9) loads.push(load())
    }
    const ms = (v: number) => Math.round(v * 10) / 10
    result = {
      at: new Date().toISOString(),
      samples: delays.length,
      missed: missed.length,
      medianMs: ms(quantile(delays, 0.5)),
      p95Ms: ms(quantile(delays, 0.95)),
      minMs: ms(Math.min(...delays)),
      maxMs: ms(Math.max(...delays)),
      takeOverMs: tookOver,
      firstFrameMs,
      size: `${opened.width}x${opened.height}`,
      load: loads,
      lastFrameMedianMs: ms(quantile(bursts.filter((b) => b.length).map((b) => b.at(-1)!), 0.5)),
      lastFrameP95Ms: ms(quantile(bursts.filter((b) => b.length).map((b) => b.at(-1)!), 0.95)),
      framesPerMoveMedian: quantile(bursts.map((b) => b.length), 0.5),
      delays: delays.map(ms),
      bursts,
      cursorRecords: cursors.map((c) => ({ ...c, at: ms(c.at - openedPerf) })),
      cursorBursts,
      roundTripMs: pongs.length ? ms(quantile(pongs.map((p) => p.roundTripMs), 0.5)) : null,
      captureToRelayMs: pongs.findLast((p) => p.captureMs !== undefined)?.captureMs ?? null
    }
  } finally {
    clearInterval(probe)
    sock?.close()
    await client.call('computer.drive', { computer: 'vm:windows', driver: 'agent' }).catch((e) => console.error(`hand back failed: ${String(e)}`))
    client.close()
  }
  console.log(JSON.stringify(result, null, 2))
  const out = process.argv.includes('--out') ? arg('out') : null
  if (out) writeFileSync(out, JSON.stringify(result, null, 2) + '\n')
  process.exit(0)
}
if (import.meta.main) await main()
