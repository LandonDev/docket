/**
 * The load of his shape, inside the isolated `box` and nowhere else: stand-in Work threads that stream from the
 * run's own loopback provider for as long as the run measures. Each is a real thread of the instance (a real
 * harness, the gateway, the transcript's writes and pushes), so the host answers the window's asks the way a busy
 * box does. Every process of it sits on the run's cores (`taskset`, through the pair's launch).
 */
import { appendFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { PRACTICE_ACCOUNTS, sendAnswer, startFakeProvider } from '../../journeys/lib/fakeProvider'

export const LOAD_PROMPT = 'PERF-LOAD: count the practice cones aloud, slowly.'
/** Text deltas a second from each stand-in thread: the soak's streaming children send 5 (scripts/lib/soakLoad.ts). */
export const LOAD_DELTAS_A_SECOND = 5

const sse = (event: object): string => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`

/** One long answer: a delta every 1000/rate ms until `seconds` have passed or the reader goes. */
export function loadStream(model: string, seconds: number, rate = LOAD_DELTAS_A_SECOND, finish?: AbortSignal): ReadableStream<Uint8Array> {
  const text = new TextEncoder()
  let timer: ReturnType<typeof setInterval> | undefined
  let end: (() => void) | undefined
  const clear = (): void => {
    clearInterval(timer)
    if (end) finish?.removeEventListener('abort', end)
  }
  return new ReadableStream({
    start(controller) {
      const send = (event: object): void => controller.enqueue(text.encode(sse(event)))
      send({ type: 'message_start', message: { id: 'msg_perf_load', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
      send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      end = () => {
        clear()
        send({ type: 'content_block_stop', index: 0 })
        send({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
        send({ type: 'message_stop' })
        controller.close()
      }
      if (finish?.aborted) return end()
      finish?.addEventListener('abort', end, { once: true })
      let left = Math.max(1, Math.round(seconds * rate))
      timer = setInterval(() => {
        send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `cone ${left} ` } })
        if (--left === 0) end?.()
      }, 1000 / rate)
    },
    cancel: clear
  })
}

/** A stand-in's turn: the load's prompt, asked with the harness's tools. Pure: rows.test.ts drives it. */
export const isLoadTurn = (body: { messages?: unknown[]; tools?: unknown[] }): boolean =>
  !!body.tools?.length && JSON.stringify(body.messages ?? []).includes(LOAD_PROMPT)

/**
 * The journeys' loopback provider, with a slow stream for the load's prompt: the same signature, so the pair takes it.
 * Every other prompt gets `sendAnswer`: its first byte exactly FIRST_BYTE_MS (100 ms) after the request, so a send
 * row's time to the first token less that delay is our side's own (G05).
 */
export function perfProvider(seconds: number, options: {
  finish?: AbortSignal
  onStream?: () => void
  resume?: boolean
} = {}): typeof startFakeProvider {
  // A line a request when PERF_PROVIDER_LOG names a file: what the harnesses asked and when it was answered.
  const log = process.env.PERF_PROVIDER_LOG
  return (onMessage) => {
    let messages = 0
    return Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 0,
      async fetch(request) {
        const { pathname } = new URL(request.url)
        const note = (words: string): void => { if (log) appendFileSync(log, `${new Date().toISOString()} ${pathname} ${words}\n`) }
        note('in')
        if (pathname === '/api/oauth/profile') return Response.json({ account: { uuid: 'journey-practice', email: 'practice@example.test' }, organization: { uuid: 'journeys', name: 'Practice' } })
        if (pathname === '/api/oauth/usage') return Response.json({ limits: [] })
        if (pathname === '/v1/messages/count_tokens') return Response.json({ input_tokens: 10 })
        if (pathname !== '/v1/messages' || request.method !== 'POST') return Response.json({ error: 'No such dummy endpoint' }, { status: 404 })
        const body = await request.json() as { model?: string; messages?: unknown[]; stream?: boolean; tools?: unknown[] }
        note(`body model=${body.model} stream=${body.stream} messages=${body.messages?.length} tools=${body.tools?.length ?? 0}`)
        onMessage()
        const model = body.model ?? 'claude-haiku-5-5'
        const headers = { 'content-type': 'text/event-stream' }
        // The turn's own request streams for the run; the harness's side asks about it (a title: no tools) answer short,
        // or each stand-in would hold two of the gateway's upstream sockets.
        if (isLoadTurn(body) || (options.resume && JSON.stringify(body.messages ?? []).includes('<host-restarted>'))) {
          options.onStream?.()
          return new Response(loadStream(model, seconds, LOAD_DELTAS_A_SECOND, options.finish), { headers })
        }
        const answer = await sendAnswer(model, body.messages, 'msg_perf_' + ++messages)
        note('answered')
        return answer
      }
    })
  }
}

/**
 * Starts `count` stand-in threads streaming in a workspace of box; resolves once each send is accepted.
 * `scope` is the kind of thread: Work's (the default) or a plain code thread. With `room`, the isolated instance's
 * running cap is raised first to hold them all with that many slots to spare, on that instance alone, so no row
 * is timed behind the cap by accident (the cap's own row lowers it on purpose).
 */
export async function startLoad<Host>(
  pair: { box: Host; rpc<T>(host: Host, method: string, params: unknown, ms?: number): Promise<T> },
  workspaceId: string,
  count: number,
  options: { scope?: 'code' | 'work'; signal?: AbortSignal; room?: number } = {}
): Promise<string[]> {
  if (options.room !== undefined) await pair.rpc(pair.box, 'admission.set', { cap: count + options.room })
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const { id } = await pair.rpc<{ id: string }>(pair.box, 'session.create', {
      workspaceId, title: `Stand-in ${i + 1}`, provider: 'claude', permission: 'auto', threadType: 'chat', ...((options.scope ?? 'work') === 'work' ? { scope: 'work' } : {})
    })
    ids.push(id)
    // Four at a time: a start is the heaviest thing a thread does, and his box starts them a few at once.
    if (i % 4 === 3) await sleep(1500, undefined, { signal: options.signal })
    await pair.rpc(pair.box, 'session.send', { sessionId: id, text: LOAD_PROMPT }, 60_000)
  }
  return ids
}

/**
 * The load split over box's two dummy accounts (the pair opened with `twoAccounts`), as scripts/perf/host.ts does:
 * box's gateway keeps 32 sockets to one origin for one account (src/main/server/upstream.ts `maxSockets`), the
 * loopback provider speaks HTTP/1.1, and each streaming stand-in holds one socket for its hour, so one account cannot
 * stream 40 and still answer a row's send. Each half streams in its own workspace, pinned to one account
 * (`workspace.setAccounts`). The cap is raised once, for all of them with `room` to spare.
 */
export async function startSplitLoad<Host>(
  pair: { box: Host; rpc<T>(host: Host, method: string, params: unknown, ms?: number): Promise<T> },
  workspaceIds: readonly [string, string],
  count: number,
  options: { scope?: 'code' | 'work'; signal?: AbortSignal; room?: number } = {}
): Promise<string[]> {
  for (const [i, workspaceId] of workspaceIds.entries()) await pair.rpc(pair.box, 'workspace.setAccounts', { workspaceId, pins: { claude: PRACTICE_ACCOUNTS[i] } })
  const [first, second] = splitLoad(count)
  const group = { scope: options.scope, signal: options.signal }
  return [
    ...await startLoad(pair, workspaceIds[0], first, { ...group, room: second + (options.room ?? 0) }),
    ...await startLoad(pair, workspaceIds[1], second, group)
  ]
}

/** How many stand-ins each account takes: the first the larger half. Pure: rows.test.ts drives it. */
export const splitLoad = (count: number): [number, number] => [Math.ceil(count / 2), Math.floor(count / 2)]
