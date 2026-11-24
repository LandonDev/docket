import { beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ text: '', isError: false }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(() =>
    (async function* () {
      yield { type: 'result', subtype: 'success', result: state.text, is_error: state.isError }
    })()
  )
}))
vi.mock('./binaries', () => ({
  resolveClaude: vi.fn(async () => ({ path: '/test/claude', version: null })),
  harnessEnv: vi.fn(async () => ({}))
}))
import { query } from '@anthropic-ai/claude-agent-sdk'
import { generateText, generateTitle, oneShotText } from './title'

beforeEach(() => {
  vi.clearAllMocks()
})
function success(text: string, isError = false): void {
  state.text = text
  state.isError = isError
}
it('generates general text without title caps, tools, or a session', async () => {
  const text = 'A long body\n'.repeat(15)
  success(text)
  expect(await generateText('Write a body', { cwd: '/tmp/project' })).toBe(text.trim())
  expect(query).toHaveBeenCalledWith(
    expect.objectContaining({
      prompt: 'Write a body',
      options: expect.objectContaining({
        pathToClaudeCodeExecutable: '/test/claude',
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        maxTurns: 1,
        cwd: '/tmp/project'
      })
    })
  )
})
it('keeps title limits and returns null on failures', async () => {
  success('"Small title."')
  expect(await generateTitle('message')).toBe('Small title')
  success('a'.repeat(61))
  expect(await generateTitle('message')).toBeNull()
  vi.mocked(query).mockImplementation(() => {
    throw new Error('unavailable')
  })
  expect(await generateText('prompt')).toBeNull()
})
it("never hands back the CLI's own refusal as text: a lapsed login must not name a thread", async () => {
  // What the CLI answers with no login: a result marked success, flagged an error, holding its own words.
  success('Not logged in · Please run /login', true)
  expect(await generateTitle('Plan the spring LAN')).toBeNull()
  // The same words with the flag missing (older CLIs), and a spent limit.
  success('Not logged in · Please run /login')
  expect(await generateTitle('Plan the spring LAN')).toBeNull()
  expect(oneShotText({ result: 'Claude AI usage limit reached|1764000000' })).toBeNull()
  expect(oneShotText({ result: 'API Error: 401 {"type":"error"}' })).toBeNull()
  expect(oneShotText({ result: 'Anything at all', is_error: true })).toBeNull()
  // A title that only speaks of logging in is a title.
  expect(oneShotText({ result: 'Fix the login page' })).toBe('Fix the login page')
})
