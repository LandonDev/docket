import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromiumEncrypt, deriveChromiumKey } from 'aliax-core/vault'

const ACCOUNT = 'practice@example.test'
const ACCOUNT_ID = 'journey-practice'

/** Give only this run's box an account that the loopback gateway can route. */
export function seedFakeAccount(dir: string): void {
  const secrets = join(dir, 'secrets')
  mkdirSync(secrets, { recursive: true, mode: 0o700 })
  const password = randomBytes(32).toString('hex')
  const profile = { name: ACCOUNT, email: ACCOUNT, accountId: ACCOUNT_ID, createdAt: Date.now() }
  writeFileSync(join(dir, 'vault.key'), password + '\n', { mode: 0o600 })
  writeFileSync(join(dir, 'profiles.json'), JSON.stringify({ 'claude-code': [profile] }))
  const keychain = JSON.stringify({ claudeAiOauth: { accessToken: 'JOURNEY-LOOPBACK', expiresAt: Date.now() + 86_400_000, scopes: ['user:inference', 'user:profile'] } })
  const blob = JSON.stringify({ keychain, oauthAccount: { accountUuid: ACCOUNT_ID, emailAddress: ACCOUNT } })
  writeFileSync(join(secrets, 'claude-code__' + encodeURIComponent(ACCOUNT) + '.bin'), chromiumEncrypt(deriveChromiumKey(password), blob), { mode: 0o600 })
}

export const BROWSER_PROMPT = 'Keep this practice chat open while I count cones.'
const REPLY = 'I have the practice list.'

type FakeTool = { id: string; name: string; input: object }
type Block = { type: string; text?: string; tool_use_id?: string; content?: string | { text?: string }[] }
type FakeRequest = { model?: string; messages?: { role: string; content: string | Block[] }[]; tools?: { name: string }[] }
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

export function startFakeProvider(onMessage: () => void, browserTurn?: Promise<void>, mailReply?: () => MailReplyFixture | undefined) {
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
      return new Response(fakeMessage(body.model ?? 'claude-haiku-5-5', mailReplyTool(body, mailReply?.()), 'msg_journey_' + ++messages), { headers: { 'content-type': 'text/event-stream' } })
    }
  })
}
