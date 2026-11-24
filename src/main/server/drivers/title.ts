import { tmpdir } from 'node:os'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { harnessEnv, resolveClaude } from './binaries'
import { oneShotBudget } from '../spawnBudget'

/**
 * One-shot, tool-less text from the Claude SDK: thread titles, commit
 * messages, PR bodies, branch names. Returns null when the call fails —
 * callers keep their fallback, nothing breaks. `cwd` lets the model see
 * the project's CLAUDE.md conventions; default is a scratch directory.
 * No MCP servers: the user's configured servers would each boot for a
 * call that uses no tools. Two of these run at a time (`oneShotBudget`).
 */
export function generateText(
  prompt: string,
  opts: { cwd?: string; model?: string } = {}
): Promise<string | null> {
  return oneShotBudget.run(() => generateNow(prompt, opts))
}

async function generateNow(
  prompt: string,
  opts: { cwd?: string; model?: string }
): Promise<string | null> {
  try {
    const cli = await resolveClaude()
    const q = query({
      prompt,
      options: {
        ...(cli.path ? { pathToClaudeCodeExecutable: cli.path } : {}),
        env: await harnessEnv(),
        model: opts.model ?? 'claude-sonnet-5-5',
        maxTurns: 1,
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        cwd: opts.cwd ?? tmpdir()
      }
    })
    for await (const m of q) {
      if (m.type === 'result' && m.subtype === 'success') return oneShotText(m)
    }
  } catch {
    // cosmetic features — the caller's fallback stays
  }
  return null
}

/**
 * The CLI's own words for a call it could not make: no login, a spent limit, a refused key. It hands them back as
 * the result of a "success", so a lapsed login once named every new thread "Not logged in · Please run /login".
 */
const CLI_REFUSAL = /^(not logged in|please run \/login|invalid api key|credit balance is too low|claude (ai )?usage limit reached|you've hit your|api error:)/i

/** A one-shot result's text, or null when the result is an error or the CLI's refusal in a result's place. */
export function oneShotText(m: { result: string; is_error?: boolean }): string | null {
  const t = m.result.trim()
  return !t || m.is_error || CLI_REFUSAL.test(t) ? null : t
}

/**
 * Title for a thread that fell back to its sliced first message. Null
 * when the model wanders (too long, multi-line).
 */
export async function generateTitle(firstMessage: string): Promise<string | null> {
  const raw = await generateText(
    'Title this coding-assistant thread in 3 to 6 plain words. ' +
      'Reply with the title only — no quotes, no trailing punctuation.\n\n' +
      `First message:\n${firstMessage.slice(0, 600)}`
  )
  if (!raw) return null
  const t = raw.replace(/^["'`]+|["'`.]+$/g, '').trim()
  return t && t.length <= 60 && !t.includes('\n') ? t : null
}
