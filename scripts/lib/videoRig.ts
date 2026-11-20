/**
 * The host side of live video on the Mac, in this process, for the video proofs (scripts/e2e-computer-video.ts,
 * scripts/e2e-video-viewer.ts): the real tc-computer under `ComputerService` and `ComputerSessions` with TC Probe
 * pinned by pid, `ComputerVideo` as the source of a `VideoRpc` over a `VideoRelay`, and a `VideoSockets` upgrade on
 * a loopback HTTP server, as index.ts wires them. TC Probe runs `--busy`: a 1280×800-point window at the normal
 * level, ordered back, that redraws all of itself every refresh. The stream tickets are a map here (RemoteAuth's
 * rule: single use, bound to the stream, its scope and its holder) so no database is opened.
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { LOCAL_PRINCIPAL } from '../../src/shared/capabilities'
import { parseAck } from '../../src/shared/video/nsl1'
import { ComputerService } from '../../src/main/server/computer/service'
import { ComputerSessions } from '../../src/main/server/computer/sessions'
import { ComputerVideo } from '../../src/main/server/computer/videoFeed'
import { setSessionTierGate, REFUSE_SESSION_TIER } from '../../src/main/server/computer/tierGate'
import { VideoRelay } from '../../src/main/server/video/relay'
import { VideoRpc } from '../../src/main/server/video/rpc'
import { VideoSockets, refuseVideoUpgrade } from '../../src/main/server/video/sockets'
import type { StreamClaim } from '../../src/main/server/remote/auth'
import { buildTcComputer } from './tcComputerBuild'
import { computerProofPolicy } from './computerProofGate'
import { COMPUTER_PROOF_ENV } from './computerProofProcesses'
import { buildProbeApp, cleanupProbeApp, launchProbe, PROBE_APP_NAME, type ProbeAppBuild } from './tcProbeApp'

export const VIDEO_THREAD = 'proof-video'

export interface VideoRig {
  port: number
  service: ComputerService
  servicePid: number
  probePid: number
  /** opens a stream of TC Probe's window as `video.open` on the local socket does; `published` asks as the publish leg does (budget, 1280) */
  open(maxEdge: number, published?: boolean): Promise<{ stream: string; ticket: string; width: number; height: number; url: string }>
  /** the viewer's wait each ack carried to the service, µs, with when it passed (epoch ms) */
  waits: { at: number; micros: number }[]
  /** each `video <n> encode us:` line of the service's trace: when it came and its numbers */
  encodes: { at: number; micros: number[] }[]
  /** a page served at `/page/<name>` */
  serve(name: string, type: string, body: string | Buffer): void
  close(): Promise<string[]>
}

export async function startVideoRig(opts: { root: string; work: string; trace: string; probe: string; frontmost: () => { pid: number; bundleId: string | null } }): Promise<VideoRig> {
  const { root, work, trace } = opts
  const log = (line: string): void => appendFileSync(trace, `${new Date().toISOString()} ${line}\n`)
  const build = buildTcComputer({ root, require: true })
  log(`tc-computer: ${build.built ? `built in ${build.ms} ms` : build.skipped}`)
  const bin = join(root, 'resources/native/tc-computer')
  const grants = JSON.parse(execFileSync(bin, ['permissions'], { encoding: 'utf8' })) as { accessibility: boolean; screenRecording: boolean }
  if (!grants.accessibility || !grants.screenRecording) throw new Error(`the video proof needs Accessibility and Screen Recording for the session holder (${JSON.stringify(grants)}); it asks for neither`)
  const policy = computerProofPolicy(false, grants)

  let probeBuild: ProbeAppBuild | null = buildProbeApp(root, work, 'dev.landon.tempcode.computer-video-probe')
  const launched = await launchProbe(probeBuild, ['--busy'], opts.frontmost)
  const probePid = launched.pid
  if (launched.bounced) log(`TC Probe: ${launched.bounced}`)

  const encodes: { at: number; micros: number[] }[] = []
  const service = new ComputerService({
    dataDir: join(work, 'data'),
    env: { ...process.env, ...COMPUTER_PROOF_ENV, TEMP_CODE_COMPUTER_TRACE: '1' },
    trace: true,
    bin: () => bin,
    log: (line) => {
      const m = /video \d+ encode us: ([\d ]*)$/.exec(line)
      if (m) encodes.push({ at: Date.now(), micros: m[1].trim() ? m[1].trim().split(' ').map(Number) : [] })
      // the trace's every JSON line stays out of the file at 120 frames a second; the rest is kept
      else if (!/ [→←] /.test(line)) log(line)
    }
  })
  setSessionTierGate(REFUSE_SESSION_TIER)
  const settings = new Map<string, string>(policy.settings)
  const sessions = new ComputerSessions({
    service,
    registry: { get: () => null, requestApproval: async () => true, awayOn: () => false },
    store: { getSetting: (k) => settings.get(k) ?? null, setSetting: (k, v) => (v === null ? settings.delete(k) : settings.set(k, v)) },
    dataDir: join(work, 'data'),
    landing: (id) => join(work, 'landing', id),
    resolveApp: (q) => (q.toLowerCase() === PROBE_APP_NAME.toLowerCase() ? { pid: probePid } : null),
    log
  })
  const video = new ComputerVideo({ service, sessions, remote: () => true, log })
  const relay = new VideoRelay()
  const tickets = new Map<string, StreamClaim & { expiresAt: number }>()
  const auth = {
    mintStreamTicket: (claim: StreamClaim) => {
      const ticket = randomBytes(32).toString('base64url')
      tickets.set(ticket, { ...claim, expiresAt: Date.now() + 30_000 })
      return { ticket, expiresIn: 30 }
    },
    consumeStreamTicket: (ticket: string, stream: string): StreamClaim | null => {
      const entry = tickets.get(ticket)
      tickets.delete(ticket)
      if (!entry || entry.expiresAt <= Date.now() || entry.stream !== stream) return null
      return { stream: entry.stream, scope: entry.scope, holder: entry.holder }
    }
  }
  const rpc = new VideoRpc(relay, auth, () => true)
  rpc.addSource(video)
  const sockets = new VideoSockets(relay, auth)
  const pages = new Map<string, { type: string; body: string | Buffer }>()
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const page = pages.get((req.url ?? '').split('?')[0].replace(/^\/page\//, ''))
    if (!page) return void res.writeHead(404).end()
    res.writeHead(200, { 'Content-Type': page.type, 'Cache-Control': 'no-store' }).end(page.body)
  })
  server.on('upgrade', (req, socket, head) => {
    const refused = sockets.upgrade(req, socket, head, 'local')
    if (refused) refuseVideoUpgrade(socket, refused)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  // the window lists a moment after the app starts; then one read makes it the thread's target
  for (const until = Date.now() + 15_000; ; ) {
    const { apps } = await service.request('apps.list', { windows: true })
    if (apps.some((a) => a.pid === probePid && (a.windows ?? []).some((w) => w.title === PROBE_APP_NAME))) break
    if (Date.now() > until) throw new Error("TC Probe's window did not show in apps.list within 15 s")
    await new Promise((r) => setTimeout(r, 250))
  }
  const ctx = { threadId: VIDEO_THREAD, permission: () => 'auto' as const }
  const read = await sessions.run(ctx, 'computer_observe', policy.observeArgs({ app: PROBE_APP_NAME, window: PROBE_APP_NAME }))
  if (read.isError || !sessions.previewTarget(VIDEO_THREAD)) throw new Error(`the read did not make TC Probe the target: ${(read.body ?? '').split('\n')[0]}`)

  // the viewer's waits, as the acks carry them to the service
  const conn = await service.connection()
  if (!conn.video) throw new Error('the service has no video: no bytes pipe, or it did not name the feature')
  const waits: { at: number; micros: number }[] = []
  const send = conn.sendBytes.bind(conn)
  conn.sendBytes = (stream: number, message: Uint8Array): void => {
    try {
      waits.push({ at: Date.now(), micros: parseAck(message).waitMicros })
    } catch {
      /* not an ack */
    }
    send(stream, message)
  }

  const caller = { principal: LOCAL_PRINCIPAL, connection: {}, connectionId: 'proof-video' }
  return {
    port,
    service,
    servicePid: service.state().pid ?? 0,
    probePid,
    waits,
    encodes,
    serve: (name, type, body) => void pages.set(name, { type, body }),
    async open(maxEdge, published = false) {
      const answer = await rpc.open({ threadId: VIDEO_THREAD, maxEdge }, caller, published ? (ask) => video.open({ ...ask, local: false, published: true }) : undefined)
      if (!answer.ok) throw new Error(`video.open refused: ${answer.reason}`)
      return { stream: answer.stream, ticket: answer.ticket, width: answer.width, height: answer.height, url: `ws://127.0.0.1:${port}/video/${answer.stream}?ticket=${answer.ticket}` }
    },
    async close() {
      sockets.close()
      for (const s of relay.list()) relay.close(s.id, caller.connection)
      await new Promise((r) => server.close(() => r(null)))
      await service.close().catch(() => undefined)
      const cleaned = cleanupProbeApp(probeBuild, probePid)
      probeBuild = null
      return cleaned
    }
  }
}
