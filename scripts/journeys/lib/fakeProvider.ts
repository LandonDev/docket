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

const REPLY = 'I have the practice list.'

export function fakeMessage(model: string) {
  return [
    { type: 'message_start', message: { id: 'msg_journey', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: REPLY } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' }
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

export function startFakeProvider(onMessage: () => void) {
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
      const { model } = await request.json() as { model?: string }
      onMessage()
      return new Response(fakeMessage(model ?? 'claude-haiku-5-5'), { headers: { 'content-type': 'text/event-stream' } })
    }
  })
}
