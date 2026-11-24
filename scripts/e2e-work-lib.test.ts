import { EventEmitter, once } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { createServer } from 'node:http'
import { PassThrough } from 'node:stream'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attach, ownsProofRecord, proofPrefix, proofRpc, Run, sessionIds, watchProofChild, withinDeadline } from './e2e-work-lib'
import { proofPeerLink, slideParagraphs } from './lib/proofPeerLink'
import { WorkProofChildren } from './lib/workProofChildren'
import { VmProofWire } from './lib/vmProofWire'

const late = () => new Promise<never>(() => {})

afterEach(() => vi.useRealTimers())

describe('the Work proof runner', () => {
  it('bounds an unanswered step and aborts the request it started', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const result = expect(withinDeadline('read the file', 100, (s) => {
      signal = s
      return late()
    })).rejects.toThrow('read the file timed out after 100 ms')
    await vi.advanceTimersByTimeAsync(100)
    await result
    expect(signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gives a child failure precedence over a stuck request', async () => {
    const child = new EventEmitter()
    const death = new AbortController()
    const exited = watchProofChild(child, 'the instance').then((error) => death.abort(error))
    const answer = withinDeadline('attach to the window', 60_000, late, death.signal)
    const rejected = expect(answer).rejects.toThrow('the instance exited (SIGTERM)')
    child.emit('exit', null, 'SIGTERM')
    await exited
    await rejected
  })

  it('reports spawn failure and distinguishes a normal quit', async () => {
    const child = new EventEmitter()
    const failure = watchProofChild(child, 'the instance')
    child.emit('error', new Error('missing electron'))
    expect((await failure)?.message).toBe('the instance could not start: missing electron')

    const restarted = new EventEmitter()
    const done = watchProofChild(restarted, 'the instance')
    restarted.emit('exit', 0, null)
    expect(await done).toBeNull()
  })

  it('ends cleanup that stalls and still runs the next cleanup', async () => {
    vi.useFakeTimers()
    const run = new Run('unit-cleanup')
    const next = vi.fn(async () => 'done')
    const note = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      run.later('second cleanup', next)
      run.later('stuck cleanup', late)
      const stopped = run.stop()
      await vi.advanceTimersByTimeAsync(30_000)
      await stopped
      expect(run.failed).toBe(1)
      expect(run.results.join('\n')).toContain('stuck cleanup timed out')
      expect(next).toHaveBeenCalledOnce()
    } finally {
      const { rmSync } = await import('node:fs')
      rmSync(run.root, { recursive: true, force: true })
      note.mockRestore()
    }
  })

  it('ends both halves of a paired wait when one proof host exits early', async () => {
    const children = new WorkProofChildren()
    const first = new EventEmitter()
    const second = new EventEmitter()
    children.track(first as unknown as ChildProcess, 'box')
    children.track(second as unknown as ChildProcess, 'mac')
    const result = expect(children.until('wait for mac', 60_000, late, () => {})).rejects.toThrow('box exited during the proof')
    first.emit('exit', 0, null)
    await result
    await expect(children.stop()).rejects.toThrow('box exited during the proof')
  })

  it('looks up a known draft before cleanup, preserves a sent draft and reports a cleanup failure', async () => {
    const run = new Run('unit-draft')
    const query = vi.spyOn(run, 'query').mockImplementation(async (_key, args) =>
      ({ row: { status: args?.id === 'sent' ? 'sent' : 'draft' } }) as never)
    const mutation = vi.spyOn(run, 'mutation').mockRejectedValue(new Error('test transport dropped'))
    const note = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      run.cleanupDraft('sent')
      run.cleanupDraft('draft')
      await run.stop()
      expect(query).toHaveBeenCalledTimes(2)
      expect(mutation).toHaveBeenCalledExactlyOnceWith('compose:discard', { id: 'draft' })
      expect(run.failed).toBe(1)
      expect(run.results.join('\n')).toContain('test transport dropped')
    } finally {
      const { rmSync } = await import('node:fs')
      rmSync(run.root, { recursive: true, force: true })
      note.mockRestore()
    }
  })

  it('matches VM helper replies by ID and rejects pending requests when the wire closes', async () => {
    const responses = new PassThrough()
    const requests = new PassThrough()
    const wire = new VmProofWire(responses, requests)
    try {
      responses.write('{"event":"ready"}\n')
      await wire.waitReady(1000)
      const first = wire.call('first')
      const second = wire.call('second')
      await Promise.resolve()
      responses.write('{"id":2,"ok":true,"value":"second"}\n{"id":1,"ok":true,"value":"first"}\n')
      await expect(second).resolves.toMatchObject({ value: 'second' })
      await expect(first).resolves.toMatchObject({ value: 'first' })
      const pending = expect(wire.call('lost')).rejects.toThrow('closed its wire')
      responses.end()
      await pending
    } finally {
      wire.close()
      requests.destroy()
      responses.destroy()
    }
  })

  it('matches a complete own-run prefix and leaves a sibling run alone', () => {
    const prefix = proofPrefix('run-a')
    expect(ownsProofRecord(prefix, 'E2E-49 run-a draft')).toBe(true)
    expect(ownsProofRecord(prefix, 'E2E-49 run-ab draft')).toBe(false)
    expect(ownsProofRecord(prefix, 'E2E-49 draft')).toBe(false)
    expect(ownsProofRecord(prefix, undefined)).toBe(false)
  })

  it('checks real session IDs, and requires a valid session list even when empty', () => {
    expect(sessionIds([{ id: 't2' }, { id: 't1' }])).toEqual(['t1', 't2'])
    expect(sessionIds([])).toEqual([])
    for (const malformed of [null, {}, [{ id: '' }], { sessions: [] }]) {
      expect(() => sessionIds(malformed)).toThrow('session.list returned no session list')
    }
  })

  it('reads a paragraph across text runs without joining two paragraphs', () => {
    expect(slideParagraphs('<a:p><a:r><a:t>First &amp; </a:t></a:r><a:r><a:t>last</a:t></a:r></a:p><a:p><a:r><a:t>Next</a:t></a:r></a:p>')).toEqual(['First & last', 'Next'])
  })
})

describe('proof sockets', () => {
  async function fixture() {
    const server = createServer((_req, res) => res.end(JSON.stringify([
      { type: 'page', url: 'file:///index.html', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/debug` }
    ])))
    const sockets = new WebSocketServer({ server })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    return {
      port,
      sockets,
      async close() {
        for (const ws of sockets.clients) ws.terminate()
        await new Promise<void>((done) => sockets.close(() => done()))
        await new Promise<void>((done) => server.close(() => done()))
      }
    }
  }

  it('rejects a failed RPC, a closed socket, and a silent request', async () => {
    const rig = await fixture()
    rig.sockets.on('connection', (socket) => socket.on('message', (raw) => {
      const { id, method } = JSON.parse(String(raw)) as { id: string; method: string }
      if (method === 'fail') socket.send(JSON.stringify({ id, ok: false, error: 'bad request' }))
      if (method === 'close') socket.close()
    }))
    try {
      await expect(proofRpc(rig.port, 'fail', {}, 1000)).rejects.toThrow('fail: bad request')
      await expect(proofRpc(rig.port, 'close', {}, 1000)).rejects.toThrow('socket closed while asking close')
      await expect(proofRpc(rig.port, 'silent', {}, 50)).rejects.toThrow('silent timed out')
    } finally {
      await rig.close()
    }
  })

  it('bounds non-eval CDP asks and rejects each pending ask on close', async () => {
    const rig = await fixture()
    const cdp = await attach(rig.port, 2000)
    try {
      await expect(cdp.send('Page.enable', {}, 50)).rejects.toThrow('the page did not answer Page.enable')
      const pending = expect(cdp.send('Page.captureScreenshot', {}, 2000)).rejects.toThrow('the debug socket closed')
      cdp.close()
      await pending
    } finally {
      cdp.close()
      await rig.close()
    }
  })

  it('drops only the native peer, keeps window requests live, then accepts a new peer', async () => {
    const box = await fixture()
    box.sockets.on('connection', (socket) => socket.on('message', (raw) => {
      const { id } = JSON.parse(String(raw)) as { id: string }
      socket.send(JSON.stringify({ id, ok: true, result: 'box answered' }))
    }))
    const link = await proofPeerLink(box.port)
    const window = new (await import('ws')).WebSocket(`ws://127.0.0.1:${link.port}/`, { origin: 'null' })
    const peer = new WebSocket(`ws://127.0.0.1:${link.port}/`)
    try {
      await Promise.all([once(window, 'open'), new Promise<void>((resolve) => peer.onopen = () => resolve())])
      const dropped = new Promise<void>((resolve) => peer.onclose = () => resolve())
      link.unplug()
      await dropped
      const answer = once(window, 'message')
      window.send('{"id":"from-window"}')
      expect(JSON.parse(String((await answer)[0]))).toMatchObject({ result: 'box answered' })
      await expect(proofRpc(link.port, 'peer', {}, 1000)).rejects.toThrow()
      link.plugIn()
      await expect(proofRpc(link.port, 'peer', {}, 1000)).resolves.toBe('box answered')
    } finally {
      window.terminate()
      peer.close()
      await link.close()
      await box.close()
    }
  })
})

describe('the Work proof catalogue', () => {
  const root = resolve(__dirname, '..')
  const markdown = readFileSync(resolve(root, 'docs/agents/work-proofs.md'), 'utf8')
  const { scripts } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  const rows = [...markdown.matchAll(/^\| `(scripts\/[\w.-]+\.ts)` \| `((?:E2E_REAL_LIFEOS=1 )?bun run (script:[\w-]+))` \| ([^|]+) \| ([^|]+) \|/gm)]

  it('names each proof once and gives it a command, a time and its real reach', () => {
    expect(rows.length).toBeGreaterThan(40)
    expect(new Set(rows.map((row) => row[1])).size).toBe(rows.length)
    for (const [, path, command, alias, time, reach] of rows) {
      expect(readFileSync(resolve(root, path!), 'utf8').length, path).toBeGreaterThan(0)
      expect(scripts[alias!], alias).toContain(path)
      expect(time).toContain('min')
      expect(reach?.trim()).toBeTruthy()
      if (command?.startsWith('E2E_REAL_LIFEOS=1')) expect(reach).toContain('LifeOS')
    }
  })
})
