/**
 * The mail chat's narrowing, in process (docs/agents/work-mail.md "The chat beside the mail"):
 *
 *   bun --preload scripts/lib/electron-stub.ts src/main/server/work/mail/chat/proof/narrowing.ts
 *
 * A real app database and every real pillar (loadWorkModules). His window's adopt goes through the mail
 * module's own handler; then the real add-on catch (outbox/catch.ts `makeAddonGate`) judges the chat's LifeOS
 * calls, and the real Claude CLI starts under the options the driver builds for it (drivers/claude.ts
 * `fenceWorkOptions` with `harnessDeniedOf`), and says which tools it has. Its API host is nobody's, so no
 * model is called and nothing leaves the machine. Dummy data only: one made-up mail in the `life` sector.
 * An ordinary Work thread of the same workspace is the control for each step.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { query, type Options } from '@anthropic-ai/claude-agent-sdk'
import type { AddonRow } from '@shared/contract-addons'
import type { SessionMeta } from '@shared/events'
import type { WorkScope } from '@shared/work'
import { openDb } from '../../../../db'
import { resolveClaude } from '../../../../drivers/binaries'
import { fenceWorkOptions } from '../../../../drivers/claude'
import { loadWorkModules, WORK_MODULES, type Caller, type WorkCtx } from '../../../modules'
import { harnessDeniedOf } from '../../../narrowing'
import { makeAddonGate, type CatchDeps } from '../../../outbox/catch'
import type { RuleAddons } from '../../../outbox/rules'

const lines: string[] = []
const say = (line: string): void => {
  lines.push(line)
  console.log(line)
}
let failed = 0
const check = (ok: boolean, what: string): void => {
  if (!ok) failed++
  say(`${ok ? 'PASS' : 'FAIL'}  ${what}`)
}

const dir = mkdtempSync(join(tmpdir(), 'tc-mail-chat-proof-'))
try {
  const faults = await loadWorkModules()
  const mail = WORK_MODULES.find((m) => m.id === 'mail')
  if (!mail) throw new Error(`the mail pillar did not load: ${faults.get('mail') ?? 'not listed'}`)
  const db = openDb(join(dir, 'app.db'))
  for (const m of WORK_MODULES) m.ensure(db)
  const now = Date.now()
  db.prepare("INSERT INTO workspaces (id, name, path, git, created_at, kind, sector) VALUES ('ws-life', 'Life', ?, 0, ?, 'work', 'life')").run(dir, now)
  const thread = db.prepare("INSERT INTO sessions (id, provider, model, reasoning, agent_type, title, cwd, status, created_at, updated_at, scope, workspace_id) VALUES (?, 'claude', 'claude-opus-5-5', 'high', 'default', 'New chat', ?, 'idle', ?, ?, 'work', 'ws-life')")
  thread.run('mail-chat', dir, now, now)
  thread.run('plain-thread', dir, now, now)

  // What his window's host answers: the threads of this database, and LifeOS with one dummy mail.
  const row = (id: string) => db.prepare('SELECT id, parent_id, workspace_id FROM sessions WHERE id = ?').get(id) as { id: string; parent_id: string | null; workspace_id: string } | undefined
  const ctx = {
    db,
    host: 'box',
    log: (line: string) => say(`  log: ${line}`),
    scopeOf: (id: string): WorkScope | null => (row(id) ? { sessionId: id, workspaceId: row(id)!.workspace_id, sector: 'life', host: 'box', away: false, routineRunId: null, shared: () => false } : null),
    canvas: { paneOf: (id: string) => row(id)?.parent_id ?? id },
    threads: { fresh: (id: string) => !!row(id) && !db.prepare('SELECT 1 FROM events WHERE session_id = ? LIMIT 1').get(id), rearm: async () => undefined },
    lifeos: {
      connected: () => true,
      owner: () => ({ query: async (fn: string, args: { id?: string }) => (fn === 'mail:thread' && args.id === 'mt-dummy' ? { thread: { _id: 'mt-dummy', subject: 'Dummy: the bike shop quote', sector: 'life' } } : null) })
    }
  } as unknown as WorkCtx
  const owner: Caller = { kind: 'local', caps: ['read', 'operate', 'approve', 'admin'] }

  say('# adopt')
  const adopted = await mail.handle!({ id: '1', method: 'work.mail.chat.adopt', params: { workspaceId: 'ws-life', sessionId: 'mail-chat', kind: 'mail', mailThreadId: 'mt-dummy' } } as never, ctx, owner)
  check(adopted.handled && JSON.stringify(adopted.result) === '{"ok":true}', 'his window marks the fresh thread as a chat about the dummy mail')

  say('# the add-on catch')
  const url = 'https://lifeos.invalid/mcp'
  const lifeos = { id: 'row-lifeos', name: 'LifeOS', enabled: true, workspaceId: null, spec: { transport: 'http', url, auth: 'fields', headers: ['Authorization'] } } as unknown as AddonRow
  const metas = new Map<string, SessionMeta>(['mail-chat', 'plain-thread'].map((id) => [id, { id, scope: 'work', parentId: null } as SessionMeta]))
  const gate = makeAddonGate({
    addons: { workMarks: (id: string) => (id === lifeos.id ? { role: 'lifeos', forWork: true } : null), tools: () => ({ tools: [] }), toolHints: () => ({}) } as unknown as RuleAddons,
    sessions: { get: (id: string) => metas.get(id) },
    mcpUrl: () => url,
    isWorkScope: () => true,
    originOf: (threadId: string) => ({ app: 'tempcode', threadId, host: 'box', workspaceId: 'ws-life' }),
    modules: () => WORK_MODULES,
    ctx,
    log: (line: string) => say(`  log: ${line}`)
  } as unknown as CatchDeps)
  const call = (sessionId: string, tool: string, args: Record<string, unknown> = {}) => gate.decide({ row: lifeos, tool, args, sessionId, work: true })
  const archived = await call('mail-chat', 'archive_mail', { ids: ['mt-dummy'], reason: 'proof' })
  say(`  mail chat, archive_mail → ${JSON.stringify(archived)}`)
  check(!archived.run && /not available in a mail chat/.test(JSON.stringify(archived)), "the mail chat's archive_mail is refused, with words that send it to mail_offer")
  const drafted = await call('mail-chat', 'draft_mail', { threadId: 'mt-dummy', body: 'Thanks, that works.', origin: { threadId: 'forged' } })
  say(`  mail chat, draft_mail → ${JSON.stringify(drafted)}`)
  check(drafted.run === true && (drafted as { args?: { origin?: { threadId?: string } } }).args?.origin?.threadId === 'mail-chat', "the mail chat's draft_mail passes the gate, stamped with the chat as its origin")
  const plain = await call('plain-thread', 'archive_mail', { ids: ['mt-dummy'] })
  say(`  ordinary Work thread, archive_mail → ${JSON.stringify(plain)}`)
  check(plain.run === true, "an ordinary Work thread's archive_mail still passes the gate (the control)")

  say('# the harness')
  const denied = harnessDeniedOf('mail-chat')
  say(`  denied to the mail chat: ${denied.join(', ')}; to the ordinary thread: ${harnessDeniedOf('plain-thread').join(', ') || 'nothing'}`)
  const cli = (await resolveClaude()).path
  if (!cli) {
    say('NOT RUN  the Claude CLI is not on this host')
    failed++
  } else {
    const home = join(dir, 'home')
    mkdirSync(home, { recursive: true })
    const toolsOf = async (sessionId: string): Promise<string[]> => {
      const base: Options = {
        cwd: dir,
        pathToClaudeCodeExecutable: cli,
        // no model is reachable: the CLI says its tools at start and its first request fails on the loopback
        env: { PATH: process.env.PATH ?? '', HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_API_KEY: 'sk-ant-proof-none', DISABLE_AUTOUPDATER: '1' },
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true
      }
      const options = fenceWorkOptions(base, { scope: 'work' }, null, () => null, harnessDeniedOf(sessionId))
      const q = query({ prompt: 'Run `echo hi` with Bash.', options })
      try {
        for await (const message of q) if (message.type === 'system' && message.subtype === 'init') return message.tools
      } finally {
        ;(q as { close?: () => void }).close?.()
      }
      return []
    }
    const chatTools = await toolsOf('mail-chat')
    const plainTools = await toolsOf('plain-thread')
    say(`  the mail chat's CLI has: ${chatTools.join(', ')}`)
    say(`  the ordinary thread's CLI has: ${plainTools.join(', ')}`)
    check(plainTools.includes('Bash'), "the ordinary Work thread's CLI has Bash (the control)")
    check(chatTools.length > 0 && !chatTools.includes('Bash'), "the mail chat's CLI has no Bash")
    check(['Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch'].every((t) => !chatTools.includes(t)), "the mail chat's CLI has no Write, Edit, NotebookEdit, WebFetch or WebSearch")
  }
  db.close()
} finally {
  rmSync(dir, { recursive: true, force: true })
}
say(failed ? `\n${failed} FAILED` : '\nALL PASSED')
process.exit(failed ? 1 : 0)
