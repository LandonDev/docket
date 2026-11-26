import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromiumEncrypt, deriveChromiumKey } from 'aliax-core/vault'

export const PRACTICE_ACCOUNTS = ['practice@example.test', 'practice-two@example.test'] as const
const ACCOUNT = PRACTICE_ACCOUNTS[0]
const ACCOUNT_ID = 'journey-practice'

/** Give only this run's box accounts that the loopback gateway can route. */
export function seedFakeAccount(dir: string, twoAccounts = false): void {
  const secrets = join(dir, 'secrets')
  mkdirSync(secrets, { recursive: true, mode: 0o700 })
  const password = randomBytes(32).toString('hex')
  const profiles = PRACTICE_ACCOUNTS.slice(0, twoAccounts ? 2 : 1).map((name, i) => ({
    name, email: name, accountId: i === 0 ? ACCOUNT_ID : ACCOUNT_ID + '-two', createdAt: Date.now()
  }))
  writeFileSync(join(dir, 'vault.key'), password + '\n', { mode: 0o600 })
  writeFileSync(join(dir, 'profiles.json'), JSON.stringify({ 'claude-code': profiles }))
  const key = deriveChromiumKey(password)
  for (const [i, { name, accountId }] of profiles.entries()) {
    const accessToken = i === 0 ? 'JOURNEY-LOOPBACK' : 'JOURNEY-LOOPBACK-TWO'
    const keychain = JSON.stringify({ claudeAiOauth: { accessToken, expiresAt: Date.now() + 86_400_000, scopes: ['user:inference', 'user:profile'] } })
    const blob = JSON.stringify({ keychain, oauthAccount: { accountUuid: accountId, emailAddress: name } })
    writeFileSync(join(secrets, 'claude-code__' + encodeURIComponent(name) + '.bin'), chromiumEncrypt(key, blob), { mode: 0o600 })
  }
}

export const BROWSER_PROMPT = 'Keep this practice chat open while I count cones.'
export const REPLY = 'I have the practice list.'

export type FakeTool = { id: string; name: string; input: object }
type Block = { type: string; text?: string; tool_use_id?: string; content?: string | { text?: string }[] }
export type FakeRequest = { model?: string; messages?: { role: string; content: string | Block[] }[]; tools?: { name: string }[] }
export type MailReplyFixture = { prompt: string; threadId: string; body: string }
const SEARCH_CALL = 'toolu_journey_search'
const DRAFT_TOOL = 'mcp__app__lifeos__draft_mail'
const OFFER_TOOL = 'mcp__work__mail_offer'
const DRAFT_CALL = 'toolu_journey_draft'
const OFFER_CALL = 'toolu_journey_offer'

/** Script one known prompt. The CLI, its real MCP tools, and the transcript handle both calls. */
export function mailReplyTool(request: FakeRequest, fixture?: MailReplyFixture): FakeTool | undefined {
  if (!fixture) return
  const messages = (request.messages ?? []).filter(({ role }) => role === 'user')
  const blocks = messages.flatMap(({ content }) => typeof content === 'string' ? [{ type: 'text', text: content } as Block] : content)
  if (!blocks.some(({ type, text }) => type === 'text' && text?.includes(fixture.prompt))) return
  if (blocks.some(({ tool_use_id }) => tool_use_id === OFFER_CALL)) return
  const draft = blocks.find(({ tool_use_id }) => tool_use_id === DRAFT_CALL)
  if (!draft) {
    const name = request.tools?.find(({ name }) => name === DRAFT_TOOL)?.name
    if (name) return { id: DRAFT_CALL, name, input: { thread_id: fixture.threadId, body: fixture.body, reason: 'The owner asked for a reply' } }
    if (!blocks.some(({ tool_use_id }) => tool_use_id === SEARCH_CALL) && request.tools?.some(({ name }) => name === 'ToolSearch')) {
      return { id: SEARCH_CALL, name: 'ToolSearch', input: { query: `select:${DRAFT_TOOL},${OFFER_TOOL}` } }
    }
    return
  }
  const text = typeof draft.content === 'string' ? draft.content : draft.content?.map((part) => part.text ?? '').join('')
  const name = request.tools?.find(({ name }) => name.startsWith('mcp__') && name.endsWith('__mail_offer'))?.name
  if (!text || !name) return
  try {
    const { id } = JSON.parse(text) as { id?: string }
    if (id && /^[a-z0-9]{1,64}$/.test(id)) return { id: OFFER_CALL, name, input: { draft: { draftId: id } } }
  } catch {
    // A refused draft leaves the expected card missing.
  }
}

export function fakeMessage(model: string, tool?: FakeTool, id = 'msg_journey') {
  return [
    { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: tool.id, name: tool.name, input: {} } : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } : { type: 'text_delta', text: REPLY } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' }
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

export function startFakeProvider(onMessage: () => void, browserTurn?: Promise<void>, mailReply?: () => MailReplyFixture | undefined, reply?: (body: FakeRequest, id: string) => Response | undefined) {
  let messages = 0
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url)
      if (pathname === '/api/oauth/profile') return Response.json({
        account: { uuid: ACCOUNT_ID, email: ACCOUNT }, organization: { uuid: 'journeys', name: 'Practice' }
      })
      if (pathname === '/api/oauth/usage') return Response.json({ limits: [] })
      if (pathname === '/v1/messages/count_tokens') return Response.json({ input_tokens: 10 })
      if (pathname !== '/v1/messages' || request.method !== 'POST') return Response.json({ error: 'No such dummy endpoint' }, { status: 404 })
      const body = await request.json() as FakeRequest
      onMessage()
      if (browserTurn && JSON.stringify(body.messages ?? []).includes(BROWSER_PROMPT)) await browserTurn
      const id = 'msg_journey_' + ++messages
      return reply?.(body, id) ?? new Response(fakeMessage(body.model ?? 'claude-haiku-5-5', mailReplyTool(body, mailReply?.()), id), { headers: { 'content-type': 'text/event-stream' } })
    }
  })
}

/** The perf run's provider answers a send's prompt with its first byte exactly this late: "our side" is the rest. */
export const FIRST_BYTE_MS = 100
/** The words a timed send carries, and the word its answer opens with: `PERF-SEND <nonce>` → `Answer-<nonce>`. */
export const SEND_MARK = 'PERF-SEND'
export const answerWord = (nonce: string): string => `Answer-${nonce}`
/** The answer after its first word: a few deltas this far apart, as a real model's first words come; with it, REPLY. */
export const SEND_DELTAS = [' have', ' the practice', ' list.']
export const SEND_DELTA_MS = 20

/** The newest send mark in a request's messages (the history carries the earlier ones first). */
export function sendNonce(messages: unknown): string | undefined {
  return [...JSON.stringify(messages ?? []).matchAll(new RegExp(`${SEND_MARK} ([A-Za-z0-9]+)`, 'g'))].at(-1)?.[1]
}

/**
 * A short answer: message_start with the first delta in one chunk at once, the rest `SEND_DELTA_MS` apart. The words
 * are REPLY (the rows of Work wait for them), led by a word naming the send's nonce when it has one, so a row can tell
 * this answer from the thread's earlier ones. `sendAnswer` holds it back FIRST_BYTE_MS.
 */
export function sendStream(model: string, nonce: string | undefined, id = 'msg_perf_send'): ReadableStream<Uint8Array> {
  const text = new TextEncoder()
  const sse = (event: { type: string; [key: string]: unknown }): string => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
  const delta = (words: string): string => sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: words } })
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const later = (fn: () => void, ms: number): void => {
    const timer = setTimeout(() => { timers.delete(timer); fn() }, ms)
    timers.add(timer)
  }
  return new ReadableStream({
    start(controller) {
      controller.enqueue(text.encode(
        sse({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }) +
        sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
        delta((nonce ? answerWord(nonce) + ' ' : '') + 'I')))
      SEND_DELTAS.forEach((words, i) => later(() => {
        controller.enqueue(text.encode(delta(words)))
        if (i < SEND_DELTAS.length - 1) return
        controller.enqueue(text.encode(
          sse({ type: 'content_block_stop', index: 0 }) +
          sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }) +
          sse({ type: 'message_stop' })))
        controller.close()
      }, SEND_DELTA_MS * (i + 1)))
    },
    cancel() {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    }
  })
}

/**
 * The send's answer, its first byte (headers and the first chunk together) exactly FIRST_BYTE_MS after the request.
 * The wait is before the response: Bun sends no headers for a stream whose first chunk comes from a timer, and the
 * gateway's upstream then times out on them (box's logs/gateway-limits.jsonl, 2026-11-26).
 */
export async function sendAnswer(model: string, messages: unknown, id?: string): Promise<Response> {
  await new Promise((resolve) => setTimeout(resolve, FIRST_BYTE_MS))
  return new Response(sendStream(model, sendNonce(messages), id), { headers: { 'content-type': 'text/event-stream' } })
}
