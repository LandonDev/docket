import { once } from 'node:events'
import { createServer } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { BODY_OMIT_BYTES, RESUME_ROWS } from '../src/shared/wireBudgets'
import { judgeReconnect, parseSoakArgs, RECONNECT_RULE, type ReconnectWindow } from './lib/soakJudge'
import { owedAt, profileOf } from './lib/soakLoad'
import { RECONNECT_CUT_MS, RECONNECT_WINDOW_MS, reconnectHistory, reconnectLiveRows, reconnectRows, reconnectTasks, reconnectToolRows, type ReconnectWire } from './lib/soakReconnect'
import { watchReconnectSocket } from './lib/soakReconnectHost'

describe('the reconnect scene', () => {
  it('runs the same synthetic split scene in a report and the gate', () => {
    for (const gate of [false, true]) {
      expect(parseSoakArgs(['--scene', 'reconnect', ...(gate ? ['--gate'] : [])]))
        .toMatchObject({ scene: 'reconnect', host: 'synthetic', view: 'split', gate })
    }
    expect(() => parseSoakArgs(['--scene', 'reconnect', '--host', 'box'])).toThrow('synthetic host')
    expect(() => parseSoakArgs(['--scene', 'reconnect', '--view', 'board'])).toThrow('fixed split layout')
  })

  it('seeds long histories and both sides of the six-second resume row budget', () => {
    const history = [...reconnectHistory('thread')]
    expect(history.length).toBeGreaterThan(20_000)
    expect(history.reduce((n, event) => n + Buffer.byteLength(JSON.stringify(event)), 0)).toBeGreaterThan(3 * 1024 * 1024)
    const profile = profileOf('reconnect')
    expect(profile.children).toBe(6)
    const group = reconnectToolRows('live', 9999, true)
    expect(group.map((row) => row.type)).toEqual(['assistant-text', 'tool-call', 'tool-result'])
    expect(Buffer.byteLength(group[2].output)).toBeLessThan(BODY_OMIT_BYTES)
    const gaps = profile.streams.map((stream) => owedAt(stream, RECONNECT_CUT_MS) * group.length)
    expect(gaps[0]).toBeGreaterThan(RESUME_ROWS)
    expect(gaps[1]).toBeGreaterThan(RESUME_ROWS)
    expect(gaps[2]).toBeLessThan(RESUME_ROWS)
    expect(gaps[2]).toBeGreaterThan(0)
  })

  it('streams one message in order before its final text and Read', () => {
    const messages = Array.from({ length: 8 }, (_, n) => reconnectLiveRows('thread', n))
    const deltas = messages.slice(0, -1).flat().filter((row) => row.type === 'assistant-text')
    const [text, call, result] = messages.at(-1)!
    if (text?.type !== 'assistant-text' || call?.type !== 'tool-call' || result?.type !== 'tool-result') throw new Error('expected a finished message and Read')
    expect(deltas).toHaveLength(21)
    expect(deltas.every((row) => row.delta && row.msgId === text.msgId)).toBe(true)
    expect(deltas.map((row) => row.text).join('')).toBe(text.text)
    expect(text.delta).toBe(false)
    expect(call.callId).toBe(result.callId)
  })

  it('counts tasks by their start and applies the strict over-100 ms threshold', () => {
    const tasks = [{ at: 9, ms: 500 }, { at: 10, ms: 50 }, { at: 15, ms: 100 }, { at: 19, ms: 101 }, { at: 20, ms: 750 }]
    expect(reconnectTasks(tasks, 10, 20)).toEqual({
      tasks: tasks.slice(1, 4),
      stats: { count: 3, maxMs: 101, sumMs: 251, over100: 1 }
    })
    expect(reconnectTasks([], 10, 20).stats.maxMs).toBe(0)
  })

  it('detects missing, repeated and out-of-order cut rows by thread', () => {
    const before = { a: 41, b: 7, c: 13 }
    const through = { a: 43, b: 8, c: 13 }
    expect(reconnectRows(before, through, { a: [42, 43], b: [8], c: [] })).toEqual({ exact: true, expected: 3, observed: 3 })
    for (const a of [[], [43, 42], [42, 42], [42, 42, 43], [41, 43]]) {
      expect(reconnectRows(before, through, { a, b: [8], c: [] }).exact).toBe(false)
    }
  })

  it('checks both windows, the strict buffer limit and the restored live transcript', () => {
    const good: ReconnectWindow = {
      phase: 'cut', longTasks: { maxMs: 100 }, maxUnsentBytes: RECONNECT_RULE.maxUnsentBytes - 1,
      connections: 1, remote: true, rows: { exact: true }, loaded: 6, streaming: true
    }
    const relaunch = { ...good, phase: 'relaunch' as const }
    expect(judgeReconnect([good, relaunch]).ok).toBe(true)
    for (const failure of [
      { longTasks: { maxMs: 101 } }, { maxUnsentBytes: RECONNECT_RULE.maxUnsentBytes },
      { connections: 2 }, { connections: 0 }, { remote: false }, { rows: { exact: false } },
      { loaded: 1 }, { streaming: false }
    ]) {
      expect(judgeReconnect([{ ...good, ...failure }, relaunch]).ok).toBe(false)
      expect(judgeReconnect([good, { ...relaunch, ...failure }]).ok).toBe(false)
    }
  })

  it('owes no stream when the load paused at the reconnect (--still), and still judges the rest', () => {
    const quiet: ReconnectWindow = {
      phase: 'cut', longTasks: { maxMs: 100 }, maxUnsentBytes: 0,
      connections: 1, remote: true, rows: { exact: true }, loaded: 6, streaming: false
    }
    const relaunch = { ...quiet, phase: 'relaunch' as const }
    expect(judgeReconnect([quiet, relaunch]).ok).toBe(false)
    expect(judgeReconnect([quiet, relaunch], undefined, { still: true }).ok).toBe(true)
    expect(judgeReconnect([{ ...quiet, longTasks: { maxMs: 101 } }, relaunch], undefined, { still: true }).ok).toBe(false)
  })

  it('holds the bytes behind a slow link (--link) to the same limit as a socket', () => {
    const quiet: ReconnectWindow = {
      phase: 'cut', longTasks: { maxMs: 50 }, maxUnsentBytes: 0, linkHeldBytes: RECONNECT_RULE.maxUnsentBytes - 1,
      connections: 1, remote: true, rows: { exact: true }, loaded: 6, streaming: true
    }
    const relaunch = { ...quiet, phase: 'relaunch' as const }
    expect(judgeReconnect([quiet, relaunch]).ok).toBe(true)
    expect(judgeReconnect([{ ...quiet, linkHeldBytes: RECONNECT_RULE.maxUnsentBytes }, relaunch]).ok).toBe(false)
  })
})

it('cuts live sockets, refuses upgrades, then measures each real send on the replacement', async () => {
  const server = createServer()
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: true })
  const pushed = '{"push":"events","rows":[]}'
  const page = `{"id":"1","ok":true,"result":{"rows":[{"text":"${'x'.repeat(4096)}"}],"moreBefore":true,"moreAfter":false,"reset":true,"subscribed":true}}`
  const queue = '{"id":"2","ok":true,"result":[]}'
  const other = '{"id":"3","ok":true,"result":{}}'
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on('message', (data) => {
      const { id } = JSON.parse(data.toString()) as { id: string }
      if (id === '1') ws.send(pushed)
      ws.send(({ '1': page, '2': queue, '3': other } as Record<string, string>)[id]!)
    })
  }))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no test socket')
  let seq = 40
  const observe = watchReconnectSocket(address.port, () => ({ thread: seq }))
  const dial = (): WebSocket => new WebSocket(`ws://127.0.0.1:${address.port}`)
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  try {
    const first = dial()
    await once(first, 'open')
    const closed = once(first, 'close')
    const cut = new Promise<ReconnectWire>((resolve) => observe.begin('cut', RECONNECT_CUT_MS, resolve))
    await closed
    await expect(once(dial(), 'open')).rejects.toThrow()
    seq += 198
    await vi.advanceTimersByTimeAsync(RECONNECT_CUT_MS)
    const second = dial()
    await once(second, 'open')
    const rows = new Promise<void>((resolve) => {
      let count = 0
      second.on('message', () => { if (++count === 4) resolve() })
    })
    second.send(JSON.stringify({ id: '1', method: 'session.events', params: { afterSeq: 40 } }))
    second.send(JSON.stringify({ id: '2', method: 'queue.list' }))
    second.send(JSON.stringify({ id: '3', method: 'projects.list' }))
    await rows
    await vi.advanceTimersByTimeAsync(RECONNECT_WINDOW_MS)
    const wire = await cut
    expect(wire).toMatchObject({
      connections: 1, refusedUpgrades: 1, remote: true,
      before: { thread: 40 }, through: { thread: 238 }, connected: { thread: 238 },
      answers: { events: 1, queue: 1, resets: 1, gaps: 0, tails: 0 },
      bytes: { events: Buffer.byteLength(page), pushes: Buffer.byteLength(pushed), other: Buffer.byteLength(queue + other) }
    })
    expect(wire.end - wire.connectedAt!).toBe(RECONNECT_WINDOW_MS)
    expect(wire.socketBytes).toBeGreaterThan(0)
    expect(wire.maxUnsentBytes).toBeGreaterThanOrEqual(Buffer.byteLength(page))

    const relaunch = new Promise<ReconnectWire>((resolve) => observe.begin('relaunch', 0, resolve))
    const replaced = once(second, 'close')
    second.close()
    await replaced
    await vi.advanceTimersByTimeAsync(500)
    seq += 12
    const third = dial()
    await once(third, 'open')
    await vi.advanceTimersByTimeAsync(RECONNECT_WINDOW_MS - 500)
    const reload = await relaunch
    expect(reload).toMatchObject({
      connections: 1, refusedUpgrades: 0, remote: true, before: { thread: 238 },
      through: { thread: 250 }, connected: { thread: 250 }
    })
    expect(reload.end - reload.start).toBe(RECONNECT_WINDOW_MS)
    expect(reload.connectedAt! - reload.start).toBe(500)
  } finally {
    observe.close()
    for (const ws of wss.clients) ws.terminate()
    wss.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    vi.useRealTimers()
  }
})
