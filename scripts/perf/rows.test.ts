import { afterEach, describe, expect, it, vi } from 'vitest'
import { MacThreadTokens } from '../../src/main/server/macTools'
import { FIRST_BYTE_MS, REPLY, SEND_DELTAS, SEND_DELTA_MS, SEND_MARK, answerWord, sendAnswer, sendNonce, sendStream } from '../journeys/lib/fakeProvider'
import { frameFacts, gaps, methodsUntil, percentile, spread, tally, type WireEvent } from './lib/frames'
import { asksByPlace, bulkWindow, openParts } from './rows/link'
import { bridgeToken } from './rows/links'
import { nextSend, parseSendLine, sendLineAfter } from './rows/send'
import { LOAD_PROMPT, isLoadTurn, splitLoad } from './lib/load'

const LINE = '2026-11-26T09:00:01.500Z send session=perf-short-3 accepted=0 prepared=3 handle=41(warm) delivered=388 init=902 first-message=903 model=1010(hit) first-content=1104 queue=0 handle-wait=12 mcp=377 gateway-dispatch=920 first-byte=1021 first-row=1131 mcp.source=claude-init mcp.servers=app:377 loop=4ms'

describe('the send span line', () => {
  it('reads every numeric part and the handle, and skips the missing ones', () => {
    const parsed = parseSendLine(LINE)!
    expect(parsed.session).toBe('perf-short-3')
    expect(parsed.handle).toBe('warm')
    expect(parsed.at).toBe(Date.parse('2026-11-26T09:00:01.500Z'))
    expect(parsed.parts).toMatchObject({ accepted: 0, handle: 41, delivered: 388, 'first-content': 1104, queue: 0, 'handle-wait': 12, mcp: 377, 'gateway-dispatch': 920, 'first-byte': 1021, 'first-row': 1131, model: 1010 })
    // `mcp.servers` and `loop=4ms` are not plain numbers of the span.
    expect(Object.keys(parsed.parts)).not.toContain('loop')
    const missing = parseSendLine('2026-11-26T09:00:01.500Z send session=a accepted=0 prepared=- handle=- first-row=-')!
    expect(missing.parts).toEqual({ accepted: 0 })
    expect(missing.handle).toBeUndefined()
    // A live handle says how it came: `handle=1(live boot=focus)`.
    expect(parseSendLine(LINE.replace('handle=41(warm)', 'handle=1(live boot=focus)'))?.handle).toBe('live')
  })

  it('is no send line for any other kind', () => {
    expect(parseSendLine('2026-11-26T09:00:01.500Z loop max=420ms')).toBeUndefined()
    expect(parseSendLine('not a stamp send session=a accepted=0')).toBeUndefined()
  })

  it('finds the thread’s first line written at or after the press', () => {
    const early = LINE.replace('09:00:01.500Z', '08:59:00.000Z').replace('first-row=1131', 'first-row=9')
    const other = LINE.replace('perf-short-3', 'perf-short-4')
    const text = [early, other, LINE, 'garbage'].join('\n')
    expect(sendLineAfter(text, 'perf-short-3', Date.parse('2026-11-26T09:00:00Z'))?.parts['first-row']).toBe(1131)
    expect(sendLineAfter(text, 'perf-short-3', Date.parse('2026-11-26T09:00:02Z'))).toBeUndefined()
  })

  it('marks each send with its own nonce, which the provider reads back from the newest message', () => {
    const a = nextSend()
    const b = nextSend()
    expect(a.nonce).not.toBe(b.nonce)
    expect(a.words.startsWith(`${SEND_MARK} ${a.nonce} `)).toBe(true)
    expect(a.answer).toBe(answerWord(a.nonce))
    const messages = [{ role: 'user', content: a.words }, { role: 'assistant', content: 'x' }, { role: 'user', content: [{ type: 'text', text: b.words }] }]
    expect(sendNonce(messages)).toBe(b.nonce)
    expect(sendNonce([{ role: 'user', content: 'PERF-LOAD: count' }])).toBeUndefined()
  })
})

describe('the provider’s known delay', () => {
  afterEach(() => vi.useRealTimers())

  it('answers nothing before FIRST_BYTE_MS, then the first word at once, then the rest SEND_DELTA_MS apart', async () => {
    vi.useFakeTimers()
    let response: Response | undefined
    void sendAnswer('m', [{ role: 'user', content: `${SEND_MARK} abc hi` }]).then((r) => (response = r))
    await vi.advanceTimersByTimeAsync(FIRST_BYTE_MS - 1)
    expect(response).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(response?.headers.get('content-type')).toBe('text/event-stream')
    const chunks: string[] = []
    const reader = response!.body!.getReader()
    const decoder = new TextDecoder()
    const first = await reader.read()
    chunks.push(decoder.decode(first.value))
    expect(chunks[0]).toContain('message_start')
    expect(chunks[0]).toContain(`${answerWord('abc')} I`)
    const pump = (async () => {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        chunks.push(decoder.decode(next.value))
      }
    })()
    await vi.advanceTimersByTimeAsync(SEND_DELTA_MS * SEND_DELTAS.length)
    await pump
    // Each delta is its own chunk, and the stop one more after the last.
    expect(chunks).toHaveLength(2 + SEND_DELTAS.length)
    expect(chunks.at(-1)).toContain('message_stop')
    const words = chunks.join('').match(/"text":"[^"]*"/g)!.map((m) => JSON.parse(m.slice(7)) as string).join('')
    expect(words).toBe(`${answerWord('abc')} ${REPLY}`)
  })

  it('answers a prompt with no mark with the journeys’ words alone', async () => {
    const reader = sendStream('m', undefined).getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain('"text":"I"')
    expect(first).not.toContain('Answer-')
    await reader.cancel()
  })
})

describe('the load’s streams', () => {
  it('stream long only for a stand-in’s turn, never for the harness’s side asks about it', () => {
    const asked = [{ role: 'user', content: [{ type: 'text', text: LOAD_PROMPT }] }]
    expect(isLoadTurn({ messages: asked, tools: [{ name: 'Bash' }] })).toBe(true)
    expect(isLoadTurn({ messages: asked })).toBe(false)
    expect(isLoadTurn({ messages: asked, tools: [] })).toBe(false)
    expect(isLoadTurn({ messages: [{ role: 'user', content: 'PERF-SEND n1 hi' }], tools: [{ name: 'Bash' }] })).toBe(false)
  })

  it('splits forty stand-ins twenty an account, under each account’s 32 upstream sockets', () => {
    expect(splitLoad(40)).toEqual([20, 20])
    expect(splitLoad(41)).toEqual([21, 20])
    expect(splitLoad(1)).toEqual([1, 0])
    expect(Math.max(...splitLoad(40))).toBeLessThan(32)
  })
})

describe('the wire log’s arithmetic', () => {
  it('reads a frame by its head: a request’s method and thread, a push’s name and thread, a reply’s id', () => {
    expect(frameFacts('{"id":"7","method":"session.events","params":{"sessionId":"s1","limit":300}}', true)).toEqual({ method: 'session.events', id: '7', session: 's1' })
    expect(frameFacts('{"push":"events","sessionId":"s2","rows":[]}', false)).toEqual({ push: 'events', session: 's2' })
    expect(frameFacts('{"push":"event","row":{"sessionId":"s3","seq":4}}', false)).toEqual({ push: 'event', session: 's3' })
    expect(frameFacts('{"id":"7","ok":true,"result":{"workspaceId":"w"}}', false)).toEqual({ id: '7' })
    expect(frameFacts('{"push":"hello","environmentId":"e"}', false)).toEqual({ push: 'hello' })
    expect(frameFacts('ping', false)).toEqual({})
    // A big frame is read by its first 4 KiB alone.
    expect(frameFacts(`{"id":"8","ok":true,"result":{"content":"${'x'.repeat(10_000)}","sessionId":"late"}}`, false)).toEqual({ id: '8' })
  })

  it('counts the methods up to and including the turn, on the box socket alone', () => {
    const e = (socket: string, method: string): WireEvent => ({ at: 0, socket, kind: 'sent', method })
    const events = [e('box', 'session.preconnect'), e('own', 'remote.environments.ticket'), e('box', 'session.create'), e('box', 'session.send'), e('box', 'session.focus')]
    const before = methodsUntil(events, 'session.send', (x) => x.socket === 'box')
    expect(before).toEqual(['session.preconnect', 'session.create', 'session.send'])
    expect(tally([...before, 'session.create'])).toEqual({ 'session.preconnect': 1, 'session.create': 2, 'session.send': 1 })
    expect(methodsUntil(events, 'never', () => true)).toHaveLength(5)
  })

  it('takes nearest-rank percentiles and the gaps between frames', () => {
    expect(gaps([100, 300, 350, 1350])).toEqual([200, 50, 1000])
    expect(percentile([], 50)).toBeNull()
    const values = Array.from({ length: 20 }, (_, i) => i + 1)
    expect(percentile(values, 50)).toBe(10)
    expect(percentile(values, 95)).toBe(19)
    expect(percentile(values, 100)).toBe(20)
    expect(percentile([5], 95)).toBe(5)
    expect(spread([200, 50, 1000.4])).toEqual({ n: 3, p50: 200, p95: 1000, max: 1000 })
    expect(spread([])).toEqual({ n: 0, p50: null, p95: null, max: null })
  })

  it('splits the link’s open into its parts from the page’s time origin', () => {
    const events: WireEvent[] = [
      { at: 1000 + 40, socket: 'own', kind: 'sent', method: 'remote.environments.ticket', id: '3' },
      { at: 1000 + 90, socket: 'own', kind: 'received', id: '2' },
      { at: 1000 + 160, socket: 'own', kind: 'received', id: '3' },
      { at: 1000 + 170, socket: 'box', kind: 'handshake' },
      { at: 1000 + 240, socket: 'box', kind: 'open' },
      { at: 1000 + 300, socket: 'box', kind: 'received', push: 'hello' }
    ]
    expect(openParts(events, 1000, (e) => e.socket === 'box', 1000 + 310)).toEqual({ ticketAsked: 40, ticketBack: 160, socketAsked: 170, socketOpen: 240, hello: 300, open: 310 })
    expect(openParts([], 1000, () => true, null)).toEqual({ ticketAsked: null, ticketBack: null, socketAsked: null, socketOpen: null, hello: null, open: null })
  })

  it('sorts the catch-up’s transcript asks by where each thread sits', () => {
    const ask = (method: string, session: string, socket = 'box'): WireEvent => ({ at: 0, socket, kind: 'sent', method, session })
    const events = [ask('session.events', 'a'), ask('session.events', 'a'), ask('queue.list', 'b'), ask('session.events', 'r'), ask('session.focus', 'a'), ask('session.events', 'a', 'own')]
    const place = (id: string): string => ({ a: 'mounted', b: 'tab', r: 'rail' })[id] ?? 'other'
    expect(asksByPlace(events, (e) => e.socket === 'box', place)).toEqual({ mounted: { 'session.events': 2 }, tab: { 'queue.list': 1 }, rail: { 'session.events': 1 } })
  })

  it('sets the frames on each side of a bulk read around it, so a read that held them all shows as one gap', () => {
    expect(gaps(bulkWindow([0, 200, 400], [3800, 4000], 3700))).toEqual([3400])
    expect(gaps(bulkWindow([0, 200], [300, 500, 3900], 3700))).toEqual([100, 200, 3400])
    expect(bulkWindow([], [], 100)).toEqual([])
  })

  it('makes the Mac bridge’s thread token as the box checks it', () => {
    const seed = 'ab'.repeat(32)
    const box = new MacThreadTokens(seed)
    expect(box.check('s1', bridgeToken(seed, 's1'))).toBe(true)
    expect(box.check('s2', bridgeToken(seed, 's1'))).toBe(false)
  })
})
