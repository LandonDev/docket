import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeAck, parseFrame } from '@shared/video/nsl1'
import { InitializeResultSchema, type ComputerNotification } from '@shared/computer/protocol'
import { ComputerConnection, ComputerHostError, ComputerRpcError, ComputerStartError, deadlineFor, exitKindOf, traceFrame, type ComputerConnectionOptions } from './connection'
import { fakeServiceBin } from './testFake'

const live: ComputerConnection[] = []
afterEach(async () => {
  for (const c of live.splice(0)) c.kill()
})

const dataDir = (): string => mkdtempSync(join(tmpdir(), 'tc-computer-conn-'))
async function start(env: Record<string, string> = {}, over: Partial<ComputerConnectionOptions> = {}): Promise<ComputerConnection> {
  const lines: string[] = []
  const conn = await ComputerConnection.start({ bin: fakeServiceBin(), dataDir: dataDir(), env: { ...process.env, ...env }, log: (l) => lines.push(l), ...over })
  live.push(conn)
  return conn
}
const target = (app: string) => ({ session: 's1', app: { app } })

/** A one-off service: `body` answers each parsed request `req` by calling `send(frame)`. */
function scripted(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tc-computer-script-'))
  const script = join(dir, 'svc.mjs')
  writeFileSync(
    script,
    `import { createInterface } from 'node:readline'
const send = (f) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...f }) + '\\n')
const init = ${JSON.stringify(JSON.parse(readFileSync(join(__dirname, 'fixtures/wire/initialize.response.json'), 'utf8')).result)}
createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line)
  if (req.method === 'initialize') return send({ id: req.id, result: init })
  ${body}
})
`
  )
  const bin = join(dir, 'tc-computer')
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`)
  chmodSync(bin, 0o755)
  return bin
}

describe('ComputerConnection', () => {
  it('initializes over the fake, with a fresh epoch per process', async () => {
    const a = await start()
    const b = await start()
    expect(InitializeResultSchema.parse(a.init).protocol).toBe(1)
    expect(a.epoch).toMatch(/^e-/)
    expect(a.epoch).not.toBe(b.epoch)
    expect(a.pid).toBeGreaterThan(0)
  })

  it('answers out of order, and a cancel gets the action its normal result', async () => {
    const c = await start()
    await c.request('session.open', { session: 's1' })
    const abort = new AbortController()
    const slow = c.request('action.run', { ...target('Slow'), action: { action: 'key', text: 'a' }, tiers: ['ax', 'process'] }, { signal: abort.signal })
    const perms = await c.request('permissions.get', {})
    expect(perms.accessibility).toBe(true)
    abort.abort()
    const result = await slow
    expect(result.step).toMatchObject({ status: 'failed', error: { kind: 'cancelled' } })
    expect(result.observationError?.kind).toBe('cancelled')
  })

  it('a request given up before it was sent is never written', async () => {
    const log = join(dataDir(), 'requests.log')
    const c = await start({ FAKE_LOG: log })
    const abort = new AbortController()
    abort.abort()
    const err = await c.request('permissions.get', {}, { signal: abort.signal }).catch((e) => e)
    expect(err).toBeInstanceOf(ComputerHostError)
    expect(err.kind).toBe('cancelled')
    await c.request('apps.list', {})
    expect(readFileSync(log, 'utf8')).not.toContain('permissions.get')
  })

  it('an error frame is a ComputerRpcError carrying its ComputerError', async () => {
    const c = await start()
    const err = await c.request('apps.launch', { app: 'Nope' }).catch((e) => e)
    expect(err).toBeInstanceOf(ComputerRpcError)
    expect(err.code).toBe(-32000)
    expect(err.data.kind).toBe('app_not_found')
    expect(err.data.candidates.length).toBeGreaterThan(0)
  })

  it('refuses bad params before writing them', async () => {
    const log = join(dataDir(), 'requests.log')
    const c = await start({ FAKE_LOG: log })
    const err = await c.request('state.get', { session: '', app: { app: 'TextEdit' } }).catch((e) => e)
    expect(err).toBeInstanceOf(ComputerRpcError)
    expect(err.code).toBe(-32602)
    await c.request('permissions.get', {})
    expect(readFileSync(log, 'utf8')).not.toContain('state.get')
  })

  it('a result failing its schema rejects that request alone', async () => {
    const bin = scripted(`
  if (req.method === 'apps.list') return send({ id: req.id, result: { apps: 'nope' } })
  if (req.method === 'permissions.get') return send({ id: req.id, result: { accessibility: true, screenRecording: false } })`)
    const lines: string[] = []
    const c = await ComputerConnection.start({ bin, dataDir: dataDir(), log: (l) => lines.push(l) })
    live.push(c)
    const err = await c.request('apps.list', {}).catch((e) => e)
    expect(err).toBeInstanceOf(ComputerRpcError)
    expect(err.code).toBe(-32603)
    expect((await c.request('permissions.get', {})).screenRecording).toBe(false)
    expect(c.alive).toBe(true)
    expect(lines.some((l) => l.includes("apps.list's result failed its schema"))).toBe(true)
  })

  it('a line that is no JSON-RPC frame kills the service as bad-output', async () => {
    const c = await start({ FAKE_GARBAGE: '1' })
    expect((await c.exited).kind).toBe('bad-output')
  })

  it('a deadline cancels, then rejects as a timeout and tells the supervisor', async () => {
    const log = join(dataDir(), 'requests.log')
    const timedOut: string[] = []
    const c = await start({ FAKE_NO_PONG: '1', FAKE_LOG: log }, { cancelGraceMs: 30, onTimeout: (m) => timedOut.push(m) })
    const err = await c.request('permissions.get', {}, { timeoutMs: 30 }).catch((e) => e)
    expect(err).toBeInstanceOf(ComputerRpcError)
    expect(err.data.kind).toBe('timeout')
    expect(timedOut).toEqual(['permissions.get'])
    expect(readFileSync(log, 'utf8')).toContain('"$/cancel"')
  })

  it('classifies the exit codes', async () => {
    expect([0, 75, 64, 69, 70, 1].map((c) => exitKindOf(c, null))).toEqual(['clean', 'grant-restart', 'bad-command', 'old-macos', 'fault', 'crash'])
    expect(exitKindOf(null, 'SIGSEGV')).toBe('crash')
    const grant = await start({ FAKE_EXIT_75_AFTER: '1' })
    expect((await grant.exited).kind).toBe('grant-restart')
    const signalled = await start()
    process.kill(signalled.pid, 'SIGTERM')
    expect((await signalled.exited).kind).toBe('crash')
    const ours = await start()
    ours.kill()
    expect((await ours.exited).kind).toBe('killed')
  })

  it('a start that dies before initialize carries its exit', async () => {
    const bin = scripted('')
    writeFileSync(bin, '#!/bin/sh\necho "usage: tc-computer serve" >&2\nexit 64\n')
    const err = await ComputerConnection.start({ bin, dataDir: dataDir(), log: () => undefined }).catch((e) => e)
    expect(err).toBeInstanceOf(ComputerStartError)
    expect(err.exit.kind).toBe('bad-command')
    expect(err.message).toContain('usage: tc-computer serve')
  })

  it('rejects every pending request service_restarted when the process dies', async () => {
    const c = await start()
    await c.request('session.open', { session: 's1' })
    const err = await c.request('action.run', { ...target('Crashy'), action: { action: 'key', text: 'a' }, tiers: ['process'] }).catch((e) => e)
    expect(err).toBeInstanceOf(ComputerHostError)
    expect(err.kind).toBe('service_restarted')
    const exit = await c.exited
    expect(exit.kind).toBe('crash')
    expect(exit.stderrTail).toContain('fake crash')
    expect(await c.request('permissions.get', {}).catch((e) => e.kind)).toBe('service_restarted')
  })

  it('routes notifications, logs the log ones and ignores unknown ones', async () => {
    const seen: ComputerNotification[] = []
    const lines: string[] = []
    const c = await start({ FAKE_UNKNOWN_NOTIFY: '1', FAKE_LOG_NOTIFY: '1', FAKE_PERMISSIONS_CHANGE_MS: '20' }, { log: (l) => lines.push(l) })
    c.onNotification((n) => seen.push(n))
    await new Promise((r) => setTimeout(r, 120))
    expect(seen.map((n) => n.method)).toContain('permissions/changed')
    expect(seen.map((n) => n.method as string)).not.toContain('future/thing')
    expect(lines).toContain('[computer] info fake log line')
  })

  it('traces frames both ways with data elided and long lines cut', async () => {
    const lines: string[] = []
    const c = await start({}, { trace: true, log: (l) => lines.push(l) })
    await c.request('permissions.get', {})
    expect(lines.some((l) => / → \{"jsonrpc":"2\.0","id":\d+,"method":"permissions\.get"/.test(l))).toBe(true)
    expect(lines.some((l) => / ← \{"jsonrpc":"2\.0","id":\d+,"result"/.test(l))).toBe(true)
    expect(traceFrame(JSON.stringify({ params: { data: 'A'.repeat(4_000) } }))).toBe('{"params":{"data":"<base64 3000 bytes>"}}')
    const long = traceFrame(JSON.stringify({ text: 'x'.repeat(3_000) }))
    expect(long).toMatch(/…\(\+\d+\)$/)
    expect(long.length).toBeLessThan(2_020)
    expect(traceFrame('not json')).toBe('not json')
  })

  it('reads video off the bytes pipe by stream, and its acks reach the service', async () => {
    const c = await start({ FAKE_VIDEO_FPS: '200' })
    expect(c.video).toBe(true)
    await c.request('session.open', { session: 's1' })
    const got: { stream: number; sequence: number }[] = []
    const off = c.onBytes((stream, message) => void got.push({ stream, sequence: parseFrame(message).sequence }))
    const { stream } = await c.request('capture.video.start', { ...target('TextEdit'), maxEdge: 1280, mode: 'budget' })
    await vi.waitFor(() => expect(got).toHaveLength(8))
    await new Promise((r) => setTimeout(r, 60))
    // the fake sends eight ahead of the acks and no more
    expect(got.map((g) => g.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(got.every((g) => g.stream === stream)).toBe(true)
    c.sendBytes(stream, encodeAck(stream, 8, 0))
    await vi.waitFor(() => expect(got.length).toBe(16))
    off()
    c.sendBytes(stream, encodeAck(stream, 16, 0))
    await new Promise((r) => setTimeout(r, 60))
    expect(got).toHaveLength(16)
    await c.request('capture.video.stop', { stream })
  })

  it('a service started with no pipe, or one that does not list video, is one the host never asks', async () => {
    const bare = await start({ FAKE_NO_VIDEO_PIPE: '1' })
    expect(bare.video).toBe(false)
    const old = await start({ FAKE_NO_FEATURES: '1' })
    expect(old.video).toBe(false)
    // an in-process service has three pipes and no fourth: the connection works as it did
    const three = await start({}, { spawn: ((bin: string, args: string[], options: { env: NodeJS.ProcessEnv }) => spawn(bin, args, { env: options.env, stdio: ['pipe', 'pipe', 'pipe'] })) as never })
    expect(three.video).toBe(false)
    expect(await three.request('permissions.get', {})).toEqual({ accessibility: true, screenRecording: true })
    three.sendBytes(1, encodeAck(1, 1))
    expect(three.alive).toBe(true)
  })

  it('a host with no fourth descriptor names a pipe the service dials: video flows the same, and only the service that says the token is taken', async () => {
    const name = (): string => join(tmpdir(), `tc-video-pipe-${process.pid}-${Math.random().toString(36).slice(2)}.sock`)
    const c = await start({ FAKE_VIDEO_FPS: '200' }, { videoPipe: 'named', videoPipeName: name() })
    expect(c.video).toBe(true)
    await c.request('session.open', { session: 's1' })
    const got: number[] = []
    c.onBytes((_stream, message) => void got.push(parseFrame(message).sequence))
    const { stream } = await c.request('capture.video.start', { ...target('TextEdit'), maxEdge: 1280, mode: 'budget' })
    await vi.waitFor(() => expect(got).toHaveLength(8))
    c.sendBytes(stream, encodeAck(stream, 8, 0))
    await vi.waitFor(() => expect(got.length).toBe(16))
    await c.request('capture.video.stop', { stream })
    // a process that dials the name without the token is not the pipe: the service is one with no video
    const wrong = await start({ FAKE_VIDEO_BAD_TOKEN: '1' }, { videoPipe: 'named', videoPipeName: name() })
    expect(wrong.video).toBe(false)
    expect(await wrong.request('permissions.get', {})).toEqual({ accessibility: true, screenRecording: true })
    // and a service that never dials (an older build) is one too, with no wait at start worth the name
    const old = await start({ FAKE_NO_FEATURES: '1' }, { videoPipe: 'named', videoPipeName: name() })
    expect(old.video).toBe(false)
  })

  it('bytes on the pipe that are no record kill the service as bad-output', async () => {
    const c = await start({ FAKE_VIDEO_GARBAGE: '1' })
    await c.request('session.open', { session: 's1' })
    await c.request('capture.video.start', { ...target('TextEdit'), maxEdge: 1280, mode: 'budget' })
    expect((await c.exited).kind).toBe('bad-output')
  })

  it('shuts down within two seconds', async () => {
    const c = await start()
    const t0 = Date.now()
    await c.shutdown()
    expect((await c.exited).kind).toBe('clean')
    expect(Date.now() - t0).toBeLessThan(2_000)
  })

  it('gives an action its durations on top of the deadline, a batch at most ten minutes', () => {
    expect(deadlineFor('action.run', { action: { action: 'wait', duration: 20 } })).toBe(80_000)
    expect(deadlineFor('action.batch', { actions: [{ action: 'hold_key', duration: 300 }, { action: 'wait', duration: 300 }] })).toBe(600_000)
    expect(deadlineFor('state.get', {})).toBe(30_000)
  })
})
