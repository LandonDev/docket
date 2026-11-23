import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, EventRow, SessionMeta } from '@shared/events'
import { approvalLine, batchBody, isThreadNotice, Notifier, WORK_TOLD_MS, type Notice, type NoticeGate, type NotifierRegistry } from './notifier'

/** A registry of metas and rows the test drives by hand. */
class FakeRegistry implements NotifierRegistry {
  metas = new Map<string, SessionMeta>()
  activity = new Map<string, number>()
  private metaListeners = new Set<(meta: SessionMeta) => void>()
  private eventListeners = new Set<(row: EventRow) => void>()
  private seqs = new Map<string, number>()

  onMeta(l: (meta: SessionMeta) => void): () => void {
    this.metaListeners.add(l)
    return () => this.metaListeners.delete(l)
  }
  onEvent(l: (row: EventRow) => void): () => void {
    this.eventListeners.add(l)
    return () => this.eventListeners.delete(l)
  }
  list(opts: { archived?: boolean } = {}): SessionMeta[] {
    return [...this.metas.values()].filter((m) => m.archived === (opts.archived ?? false))
  }
  get(id: string): SessionMeta | null {
    return this.metas.get(id) ?? null
  }
  rootSessionOf(id: string): string {
    return this.metas.get(id)?.parentId ?? id
  }
  lastActivityAt(id: string): number {
    return this.activity.get(id) ?? 0
  }

  add(id: string, patch: Partial<SessionMeta> = {}): SessionMeta {
    const meta: SessionMeta = {
      id,
      parentId: null,
      projectId: null,
      workspaceId: null,
      threadType: 'implementation',
      planPath: null,
      provider: 'claude',
      model: 'claude-sonnet-5-5',
      reasoning: 'low',
      agentType: 'implementer',
      title: `thread ${id}`,
      cwd: '/tmp',
      status: 'idle',
      pinned: false,
      archived: false,
      permission: 'edits',
      fast: false,
      ultrafast: false,
      context1m: false,
      busySince: null,
      pausedAt: null,
      frozenActiveElapsed: null,
      nativeId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...patch
    }
    this.metas.set(id, meta)
    return meta
  }
  status(id: string, status: SessionMeta['status']): void {
    this.push(id, { status })
  }
  push(id: string, patch: Partial<SessionMeta>): void {
    const meta = { ...this.metas.get(id)!, ...patch, updatedAt: Date.now() }
    this.metas.set(id, meta)
    for (const l of this.metaListeners) l(meta)
  }
  row(id: string, event: AgentEvent): EventRow {
    const seq = (this.seqs.get(id) ?? 0) + 1
    this.seqs.set(id, seq)
    const row: EventRow = { sessionId: id, seq, ts: Date.now(), event }
    this.activity.set(id, row.ts)
    for (const l of this.eventListeners) l(row)
    return row
  }
}

let reg: FakeRegistry
let notifier: Notifier
let notices: Notice[]
let stuckMinutes = 10
const lines: string[] = []

const settle = (): void => {
  vi.advanceTimersByTime(1500)
}
const minutes = (n: number): void => {
  vi.advanceTimersByTime(n * 60_000)
}
const seen = (): string[] => notices.map((n) => `${n.event}:${n.threadId}`)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-19T12:00:00Z'))
  reg = new FakeRegistry()
  notices = []
  stuckMinutes = 10
  lines.length = 0
  notifier = new Notifier({
    registry: reg,
    stuckMinutes: () => stuckMinutes,
    origin: () => 'https://tc.example',
    now: () => Date.now(),
    log: (l) => lines.push(l)
  })
  notifier.onNotice((n) => {
    notices.push(n)
  })
})
afterEach(() => {
  notifier.stop()
  vi.useRealTimers()
})

describe('a held act', () => {
  it("is one notice on the thread's root, said in the owner's words, with no approval a lock screen could answer", () => {
    reg.add('t1', { title: 'Reply to Dana about the budget' })
    reg.add('c1', { parentId: 't1' })
    notifier.start()
    notifier.held('c1', 'Held: Send to Dana Lee: Re: budget', { at: 'lifeos', table: 'outbox', id: 'ob_1' })
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      event: 'needs_you',
      kind: 'waiting',
      threadId: 't1',
      title: 'Reply to Dana about the budget',
      body: 'Held: Send to Dana Lee: Re: budget',
      held: { at: 'lifeos', table: 'outbox', id: 'ob_1' }
    })
    // not an approval: nothing to Allow from a notification
    expect(notices[0]!.requestId).toBeUndefined()
    expect(notices[0]!.choices).toBeUndefined()
    // never a raw tool name
    expect(notices[0]!.body).not.toMatch(/send_mail|compose|mcp__|__/)
  })

  it('for a thread this host no longer has says nothing', () => {
    notifier.start()
    notifier.held('gone', 'Held: Send', { at: 'host', id: 'ha_1' })
    expect(notices).toEqual([])
  })
})

describe('needs_you', () => {
  it('a computer step held for the Mac carries its Run now and Skip choices; any other approval none', () => {
    reg.add('t1', { title: 'Save the draft in TextEdit' })
    notifier.start()
    reg.status('t1', 'running')
    reg.row('t1', { type: 'user-text', text: 'save it' })
    reg.row('t1', {
      type: 'approval-request',
      requestId: 'h1',
      toolName: 'computer_session',
      input: { app: 'TextEdit', window: 'Untitled', actions: ['click button "Save"'] },
      title: 'Use your pointer and keyboard to click button "Save" in TextEdit, window "Untitled"',
      choices: 'run-skip'
    })
    reg.status('t1', 'waiting')
    settle()
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      kind: 'approval',
      requestId: 'h1',
      choices: 'run-skip',
      body: 'Use your pointer and keyboard to click button "Save" in TextEdit, window "Untitled"?'
    })
    reg.row('t1', { type: 'approval-resolved', requestId: 'h1', allow: true })
    reg.status('t1', 'running')
    reg.row('t1', { type: 'approval-request', requestId: 'h2', toolName: 'Bash', input: { command: 'ls' }, choices: 'allow-deny' })
    reg.status('t1', 'waiting')
    settle()
    expect(notices).toHaveLength(2)
    expect(notices[1]).not.toHaveProperty('choices')
  })

  it('fires once for a permission prompt, never for the same prompt twice, then finished once', () => {
    reg.add('t1', { title: 'Ship it' })
    notifier.start()
    reg.status('t1', 'running')
    reg.row('t1', { type: 'user-text', text: 'go' })
    reg.row('t1', {
      type: 'approval-request',
      requestId: 'a1',
      toolName: 'Bash',
      input: { command: 'git push --force' }
    })
    reg.status('t1', 'waiting')
    expect(notices).toEqual([])
    settle()
    expect(notices).toEqual([
      {
        event: 'needs_you',
        kind: 'approval',
        threadId: 't1',
        title: 'Ship it',
        body: 'Run git push --force?',
        url: 'https://tc.example/ui#thread=t1',
        ts: Date.now(),
        seq: 2,
        requestId: 'a1'
      }
    ])
    reg.push('t1', { activity: 'thinking' })
    reg.status('t1', 'waiting')
    settle()
    expect(seen()).toEqual(['needs_you:t1'])
    reg.row('t1', { type: 'approval-resolved', requestId: 'a1', allow: true })
    reg.status('t1', 'running')
    settle()
    expect(seen()).toEqual(['needs_you:t1'])
    reg.row('t1', { type: 'turn-complete' })
    reg.status('t1', 'idle')
    settle()
    expect(seen()).toEqual(['needs_you:t1', 'finished:t1'])
    expect(notices[1].body).toBe('Done in 6s')
    reg.status('t1', 'idle')
    reg.push('t1', { tasks: { done: 1, total: 3 } })
    settle()
    expect(seen()).toEqual(['needs_you:t1', 'finished:t1'])
    // The next turn is a new state: it finishes again.
    reg.status('t1', 'running')
    reg.row('t1', { type: 'user-text', text: 'again' })
    reg.status('t1', 'idle')
    settle()
    expect(seen()).toEqual(['needs_you:t1', 'finished:t1', 'finished:t1'])
  })
  it('names questions and plan prompts, and a prompt answered inside the window makes no notice', () => {
    reg.add('q', { status: 'running' })
    reg.add('p', { status: 'running' })
    reg.add('fast', { status: 'running' })
    notifier.start()
    reg.row('q', {
      type: 'question-request',
      requestId: 'q1',
      questions: [
        { question: 'Tabs or spaces?', options: [{ label: 'Tabs' }] },
        { question: 'Keep the old API?', options: [{ label: 'Yes' }] }
      ]
    })
    reg.status('q', 'waiting')
    reg.row('p', { type: 'approval-request', requestId: 'p1', toolName: 'ExitPlanMode', input: {} })
    reg.status('p', 'waiting')
    reg.row('fast', { type: 'approval-request', requestId: 'f1', toolName: 'Bash', input: {} })
    reg.status('fast', 'waiting')
    vi.advanceTimersByTime(500)
    reg.row('fast', { type: 'approval-resolved', requestId: 'f1', allow: true, auto: true })
    reg.status('fast', 'running')
    reg.row('fast', { type: 'turn-complete' })
    reg.status('fast', 'idle')
    settle()
    expect(notices.map((n) => [n.event, n.threadId, n.body])).toEqual([
      ['needs_you', 'q', 'Tabs or spaces?'],
      ['needs_you', 'p', 'Plan ready to approve'],
      ['finished', 'fast', 'Done in 2s']
    ])
  })
  it('reports a subagent prompt on its root, without naming the subagent', () => {
    reg.add('root', { title: 'Fleet', status: 'running' })
    reg.add('kid', { title: 'review-auth', parentId: 'root', status: 'running' })
    notifier.start()
    reg.row('kid', {
      type: 'approval-request',
      requestId: 'k1',
      toolName: 'Bash',
      input: { command: 'rm -rf dist' }
    })
    reg.status('kid', 'waiting')
    settle()
    expect(notices.map((n) => [n.event, n.threadId, n.title, n.body])).toEqual([
      ['needs_you', 'root', 'Fleet', 'Run rm -rf dist?']
    ])
    reg.row('kid', { type: 'approval-resolved', requestId: 'k1', allow: false })
    reg.status('kid', 'running')
    settle()
    expect(seen()).toEqual(['needs_you:root'])
  })
})

describe('failed', () => {
  it('fires once when an error ends the turn, and at once for a lapsed sign-in', () => {
    reg.add('e', { status: 'running' })
    reg.add('s', { status: 'running' })
    notifier.start()
    reg.row('e', { type: 'error', message: 'harness died: exit 1' })
    reg.status('e', 'error')
    settle()
    expect(notices.map((n) => [n.event, n.threadId, n.body])).toEqual([
      ['failed', 'e', 'Failed: harness died: exit 1']
    ])
    reg.status('e', 'error')
    reg.push('e', { canContinue: true })
    settle()
    expect(seen()).toEqual(['failed:e'])
    reg.row('s', { type: 'error', message: 'Aliax account work needs sign-in' })
    settle()
    expect(notices.map((n) => [n.event, n.threadId, n.body])).toContainEqual([
      'failed',
      's',
      'Failed: Aliax account work needs sign-in'
    ])
    reg.status('s', 'error')
    settle()
    expect(seen().filter((s) => s === 'failed:s').length).toBe(1)
  })
  it('a stop by the user is not a finish and not a failure', () => {
    reg.add('x', { status: 'running' })
    notifier.start()
    reg.row('x', { type: 'error', message: 'turn ended: interrupted', stopped: true })
    reg.status('x', 'idle')
    settle()
    expect(notices).toEqual([])
  })
})

describe('stuck', () => {
  it('fires after the silent limit, once per silence, and follows the setting', () => {
    reg.add('w', { status: 'running' })
    notifier.start()
    reg.row('w', { type: 'user-text', text: 'go' })
    minutes(9)
    expect(notices).toEqual([])
    minutes(1.5)
    expect(notices.map((n) => [n.event, n.threadId, n.body])).toEqual([
      ['stuck', 'w', 'No output for 10m']
    ])
    minutes(10)
    expect(seen()).toEqual(['stuck:w'])
    reg.row('w', { type: 'tool-call', callId: 'c1', name: 'Bash', input: {} })
    minutes(5)
    expect(seen()).toEqual(['stuck:w'])
    minutes(5.5)
    expect(seen()).toEqual(['stuck:w', 'stuck:w'])
    reg.row('w', { type: 'tool-result', callId: 'c1', output: 'ok', isError: false })
    stuckMinutes = 1
    minutes(1.5)
    expect(seen()).toEqual(['stuck:w', 'stuck:w', 'stuck:w'])
    // Settled threads are never stuck.
    reg.status('w', 'idle')
    minutes(30)
    expect(seen().filter((s) => s === 'stuck:w').length).toBe(3)
  })
  it('a subagent row counts as activity of its root', () => {
    reg.add('r', { status: 'running' })
    reg.add('c', { parentId: 'r', status: 'running' })
    notifier.start()
    reg.row('r', { type: 'user-text', text: 'go' })
    minutes(9.9)
    reg.row('c', { type: 'tool-call', callId: 'k', name: 'Read', input: {} })
    minutes(9.9)
    expect(notices).toEqual([])
    minutes(0.6)
    expect(notices.map((n) => [n.event, n.threadId, n.body])).toEqual([['stuck', 'r', 'No output for 10m']])
  })
})

describe('plumbing', () => {
  it('seeds without notices, drops archived threads, and keeps going when a sink throws', () => {
    reg.add('seed-idle', { status: 'idle' })
    reg.add('seed-run', { status: 'running' })
    reg.activity.set('seed-run', Date.now())
    notifier.start()
    settle()
    expect(notices).toEqual([])
    const off = notifier.onNotice(() => {
      throw new Error('bad sink')
    })
    notifier.onNotice(async () => {
      throw new Error('bad async sink')
    })
    reg.row('seed-run', { type: 'error', message: 'boom' })
    reg.status('seed-run', 'error')
    settle()
    expect(seen()).toEqual(['failed:seed-run'])
    expect(lines.filter((l) => l.startsWith('sink failed: bad sink')).length).toBe(1)
    off()
    reg.push('seed-idle', { archived: true, status: 'running' })
    reg.row('seed-idle', { type: 'approval-request', requestId: 'z', toolName: 'Bash', input: {} })
    settle()
    expect(seen()).toEqual(['failed:seed-run'])
    notifier.stop()
    reg.status('seed-run', 'idle')
    settle()
    expect(seen()).toEqual(['failed:seed-run'])
  })
})

describe('a completed plan', () => {
  it('says Ready to build while the plan waits for the person, and nothing once its build started', () => {
    reg.add('p', { threadType: 'planning', planPath: '/p.md', title: 'Plan: widget' })
    notifier.start()
    reg.status('p', 'running')
    reg.row('p', { type: 'user-text', text: 'plan it' })
    reg.row('p', { type: 'assistant-text', text: 'done', delta: false } as AgentEvent)
    reg.push('p', { status: 'idle', planCompletedAt: 7 })
    settle()
    expect(notices.at(-1)).toMatchObject({ event: 'finished', kind: 'plan', threadId: 'p', body: 'Ready to build' })
    reg.add('b', { threadType: 'implementation', title: 'Ship it' })
    reg.status('p', 'running')
    reg.row('p', { type: 'assistant-text', text: 'more', delta: false } as AgentEvent)
    reg.push('p', { status: 'idle', planCompletedAt: 7, implementationId: 'b' })
    settle()
    expect(notices).toHaveLength(1)
  })
  it('a plan whose build started at once says nothing at all', () => {
    reg.add('p', { threadType: 'planning', planPath: '/p.md', status: 'running' })
    reg.add('b', { threadType: 'implementation', title: 'Ship it' })
    notifier.start()
    reg.row('p', { type: 'user-text', text: 'plan it' })
    reg.push('p', { status: 'idle', planCompletedAt: 7, implementationId: 'b' })
    settle()
    expect(notices).toEqual([])
  })
})

describe("the host's verdict, a gone harness, a queued thread", () => {
  it('a failure summary beats the raw error line', () => {
    reg.add('f', { status: 'running' })
    notifier.start()
    reg.row('f', {
      type: 'error',
      message: 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}',
      failure: { kind: 'rate_limited', account: 'work', summary: 'Usage limit reached for the 5h window on work', cause: 'The window resets at 14:00.' }
    })
    reg.status('f', 'error')
    settle()
    expect(notices.map((n) => [n.event, n.kind, n.body])).toEqual([['failed', 'failed', 'Failed: Usage limit reached for the 5h window on work']])
  })
  it('a stopped thread says the harness is gone, once', () => {
    reg.add('g', { status: 'running' })
    notifier.start()
    reg.row('g', { type: 'user-text', text: 'go' })
    reg.status('g', 'stopped')
    settle()
    expect(notices.map((n) => [n.event, n.kind, n.body, n.seq])).toEqual([['failed', 'stopped', 'Stopped unexpectedly', 1]])
    reg.status('g', 'stopped')
    settle()
    expect(seen()).toEqual(['failed:g'])
    // Resumed and finished: a new state.
    reg.status('g', 'running')
    reg.row('g', { type: 'turn-complete' })
    reg.status('g', 'idle')
    settle()
    expect(seen()).toEqual(['failed:g', 'finished:g'])
  })
  it('a queued thread emits nothing until it runs', () => {
    reg.add('q', { status: 'queued' })
    notifier.start()
    reg.status('q', 'queued')
    reg.push('q', { activity: 'Queued · waiting for t0' })
    settle()
    minutes(30)
    expect(notices).toEqual([])
    reg.status('q', 'running')
    reg.row('q', { type: 'user-text', text: 'go' })
    reg.status('q', 'idle')
    settle()
    expect(notices.map((n) => [n.event, n.kind])).toEqual([['finished', 'finished']])
  })
  it('every notice names the host and the plan body carries its kind', () => {
    notifier.stop()
    notifier = new Notifier({ registry: reg, stuckMinutes: () => 10, hostName: () => 'box', now: () => Date.now(), log: () => {} })
    notifier.onNotice((n) => {
      notices.push(n)
    })
    reg.add('p', { threadType: 'planning', planPath: '/p.md', status: 'running' })
    notifier.start()
    reg.row('p', { type: 'user-text', text: 'plan it' })
    reg.push('p', { status: 'idle', planCompletedAt: 7 })
    settle()
    expect(notices).toEqual([expect.objectContaining({ event: 'finished', kind: 'plan', hostName: 'box', body: 'Ready to build' })])
  })
})

describe("a master's batch", () => {
  const gate = (ok: boolean, step: 'gate' | 'release' = 'gate') => ({ step, branch: 'master', ok, log: ok ? '✓ vitest 12s' : '✗ vitest 12s failed', at: 1 })
  it('says the batch is done once the master is between turns, and stays quiet on a thread that is not a master', () => {
    reg.add('m', { threadType: 'chat', isMaster: true, status: 'running' })
    reg.add('c', { status: 'running' })
    notifier.start()
    reg.row('m', { type: 'user-text', text: 'run the batch' })
    reg.row('m', { type: 'notice', kind: 'batch', message: 'Batch done: 3 landed · gate passed in 4m 12s · release-281 tagged' })
    settle()
    expect(notices).toEqual([])
    reg.status('m', 'watching')
    settle()
    expect(notices.map((n) => [n.event, n.kind, n.body, n.seq])).toEqual([['finished', 'batch', 'Batch done: 3 landed, gate passed in 4m 12s, release-281 tagged', 2]])
    // Told once: the master's idle after it is not a second Done.
    reg.status('m', 'running')
    reg.row('m', { type: 'assistant-text', text: 'Landed.', delta: false } as AgentEvent)
    reg.status('m', 'idle')
    settle()
    expect(notices.map((n) => n.kind)).toEqual(['batch'])
    // The person writes again: that turn's end is an ordinary finish.
    reg.status('m', 'running')
    reg.row('m', { type: 'user-text', text: 'and now?' })
    reg.status('m', 'idle')
    settle()
    expect(notices.map((n) => n.kind)).toEqual(['batch', 'finished'])
    // A gate row on a thread that is not a master is merge_branch's own gate: nothing.
    reg.row('c', { type: 'notice', kind: 'gate', message: 'Gate failed on c, at vitest', gate: gate(false) })
    reg.status('c', 'idle')
    settle()
    expect(notices.map((n) => n.threadId)).toEqual(['m', 'm', 'c'])
    expect(notices.at(-1)).toMatchObject({ kind: 'finished', body: 'Done' })
  })
  it('a failing gate or release step stops the batch; a passing one says nothing', () => {
    reg.add('m', { threadType: 'chat', isMaster: true, status: 'watching' })
    notifier.start()
    reg.row('m', { type: 'notice', kind: 'gate', message: 'Gate passed on master', gate: gate(true) })
    settle()
    expect(notices).toEqual([])
    reg.row('m', { type: 'notice', kind: 'gate', message: 'Gate failed on master · at vitest', gate: gate(false) })
    settle()
    expect(notices.map((n) => [n.event, n.kind, n.body])).toEqual([['failed', 'batch', 'Batch stopped: gate failed at vitest']])
    reg.row('m', { type: 'notice', kind: 'gate', message: 'Release failed on master', gate: gate(false, 'release') })
    settle()
    expect(notices.at(-1)).toMatchObject({ event: 'failed', kind: 'batch', body: 'Batch stopped: release failed' })
  })
  it('batchBody reads the engine rows and nothing else', () => {
    expect(batchBody({ kind: 'batch', message: 'Batch done: 2 landed\nmore' })).toEqual({ body: 'Batch done: 2 landed', failed: false })
    expect(batchBody({ kind: 'batch', message: 'Batch done' })).toEqual({ body: 'Batch done', failed: false })
    expect(batchBody({ kind: 'batch', message: 'Merged by the batch: b → master at abc' })).toBeNull()
    expect(batchBody({ kind: 'gate', message: 'Gate passed on master', gate: { step: 'gate', ok: true } })).toBeNull()
    expect(batchBody({ kind: 'gate', message: 'Typecheck failed on b · 3 errors', gate: { step: 'typecheck', ok: false } })).toEqual({ body: 'Batch stopped: typecheck failed, 3 errors', failed: true })
    expect(batchBody({ kind: 'account-gone', message: 'Account work is gone' })).toBeNull()
  })
})

describe('approvalLine', () => {
  it('asks the action as a question, from the harness sentence when it gives one', () => {
    expect(approvalLine('Read', { file_path: '/a/b/types.ts' }, 'Claude wants to read types.ts')).toBe('Read types.ts?')
    expect(approvalLine('Bash', { command: 'bun test' }, 'Claude wants to run `bun test`.')).toBe('Run bun test?')
    // OpenCode's title carries the command; a Pi extension's title is its whole question.
    expect(approvalLine('bash', { path: 'rm -rf build' }, 'Run rm -rf build')).toBe('Run rm -rf build?')
    expect(approvalLine('Pi extension', {}, 'Delete the build folder? This cannot be undone.')).toBe('Delete the build folder? This cannot be undone')
  })
  it('names each tool family by its verb', () => {
    expect(approvalLine('Bash', { command: 'bun test' })).toBe('Run bun test?')
    expect(approvalLine('shell', { command: ['git', 'status'] })).toBe('Run git status?')
    expect(approvalLine('exec_command', { cmd: 'ls' })).toBe('Run ls?')
    expect(approvalLine('Read', { file_path: '/repo/src/types.ts' })).toBe('Read types.ts?')
    expect(approvalLine('Write', { file_path: '/repo/diag.ts' })).toBe('Create diag.ts?')
    expect(approvalLine('Edit', { file_path: '/repo/src/main/server/remote/notifier.ts' })).toBe('Edit notifier.ts?')
    expect(approvalLine('MultiEdit', { file_path: 'a/b.ts' })).toBe('Edit b.ts?')
    expect(approvalLine('NotebookEdit', { notebook_path: '/n/x.ipynb' })).toBe('Edit x.ipynb?')
    expect(approvalLine('apply_patch', { fileChanges: { '/repo/a.ts': {} } })).toBe('Edit a.ts?')
    expect(approvalLine('apply_patch', { itemId: 'i' })).toBe('Edit files?')
    expect(approvalLine('WebFetch', { url: 'https://example.com/docs/x' })).toBe('Fetch example.com?')
    expect(approvalLine('WebSearch', { query: 'vitest fake timers' })).toBe('Search the web for vitest fake timers?')
    expect(approvalLine('mcp__linear__create_issue', { title: 'x' })).toBe('Use linear?')
    expect(approvalLine('MCP server "github"', {})).toBe('Use github?')
    expect(approvalLine('Glob', { pattern: '*.ts' })).toBe('Use Glob?')
    expect(approvalLine('Bash', {})).toBe('Run a command?')
  })
  it('cuts the detail at 90 characters before the question mark', () => {
    const line = approvalLine('Bash', { command: 'x'.repeat(200) })
    expect(line).toBe(`Run ${'x'.repeat(89)}…?`)
  })
})

describe('the title', () => {
  it('names an untitled thread by its place and drops the subtitle', () => {
    notifier.stop()
    notifier = new Notifier({ registry: reg, stuckMinutes: () => 10, place: () => 'Alpha', now: () => Date.now(), log: () => {} })
    notifier.onNotice((n) => {
      notices.push(n)
    })
    reg.add('u', { title: '', status: 'running' })
    reg.add('n', { title: 'Ship it', status: 'running' })
    notifier.start()
    for (const id of ['u', 'n']) {
      reg.row(id, { type: 'user-text', text: 'go' })
      reg.status(id, 'idle')
    }
    settle()
    expect(notices.map((n) => [n.threadId, n.title, n.subtitle])).toEqual([
      ['u', 'Alpha', undefined],
      ['n', 'Ship it', 'Alpha']
    ])
  })
})

describe('the finished body', () => {
  it('counts the tasks left, and says nothing of a finished list', () => {
    reg.add('a', { status: 'running', busySince: Date.now(), tasks: { done: 5, total: 7 } })
    reg.add('b', { status: 'running', busySince: Date.now(), tasks: { done: 7, total: 7 } })
    stuckMinutes = 60
    notifier.start()
    minutes(12)
    for (const id of ['a', 'b']) {
      reg.row(id, { type: 'turn-complete' })
      reg.status(id, 'idle')
    }
    settle()
    expect(notices.map((n) => [n.threadId, n.body])).toEqual([
      ['a', 'Done in 12m, 2 tasks left'],
      ['b', 'Done in 12m']
    ])
  })
})

describe('a batch thread', () => {
  it("finishes quietly under a live master, but still asks and fails out loud", () => {
    reg.add('m', { threadType: 'chat', isMaster: true, status: 'watching' })
    reg.add('k', { status: 'running', masterId: 'm' })
    reg.add('j', { status: 'running', masterId: 'm' })
    notifier.start()
    reg.row('k', { type: 'user-text', text: 'go' })
    reg.status('k', 'idle')
    settle()
    expect(notices).toEqual([])
    reg.status('k', 'running')
    reg.row('k', { type: 'approval-request', requestId: 'a', toolName: 'Bash', input: { command: 'bun test' } })
    reg.status('k', 'waiting')
    reg.row('j', { type: 'error', message: 'harness died' })
    reg.status('j', 'error')
    settle()
    expect(notices.map((n) => [n.threadId, n.event, n.body])).toEqual([
      ['k', 'needs_you', 'Run bun test?'],
      ['j', 'failed', 'Failed: harness died']
    ])
  })
  it('finishes out loud when its master is archived or no longer a master', () => {
    reg.add('m', { threadType: 'chat', isMaster: false, status: 'idle' })
    reg.add('k', { status: 'running', masterId: 'm' })
    reg.add('gone', { status: 'running', masterId: 'nobody' })
    notifier.start()
    for (const id of ['k', 'gone']) {
      reg.row(id, { type: 'user-text', text: 'go' })
      reg.status(id, 'idle')
    }
    settle()
    expect(notices.map((n) => [n.threadId, n.event])).toEqual([
      ['k', 'finished'],
      ['gone', 'finished']
    ])
  })
})

describe('a thread on screen', () => {
  it('stamps the notice for the root a window names, counts it as sent, and leaves a focused subagent or master out', () => {
    const named = new Set<string>()
    notifier.stop()
    notifier = new Notifier({ registry: reg, stuckMinutes: () => 10, onScreen: (id) => named.has(id), now: () => Date.now(), log: () => {} })
    notifier.onNotice((n) => {
      notices.push(n)
    })
    reg.add('r', { status: 'running' })
    reg.add('sub', { parentId: 'r', status: 'running' })
    reg.add('m', { threadType: 'chat', isMaster: true, status: 'watching' })
    reg.add('k', { status: 'running', masterId: 'm' })
    notifier.start()
    named.add('r')
    reg.row('r', { type: 'approval-request', requestId: 'a', toolName: 'Bash', input: { command: 'bun test' } })
    reg.status('r', 'waiting')
    settle()
    expect(notices.map((n) => [n.threadId, n.body, n.onScreen])).toEqual([['r', 'Run bun test?', true]])
    // Leaving the thread does not replay the prompt.
    named.delete('r')
    reg.push('r', { activity: 'waiting' })
    reg.status('r', 'waiting')
    settle()
    expect(notices).toHaveLength(1)
    // A focused subagent does not stamp its root, nor a focused master its batch.
    named.add('sub')
    named.add('m')
    reg.row('r', { type: 'approval-resolved', requestId: 'a', allow: true })
    reg.status('r', 'running')
    reg.row('sub', { type: 'approval-request', requestId: 'b', toolName: 'Read', input: { file_path: '/x/y.ts' } })
    reg.status('sub', 'waiting')
    reg.row('k', { type: 'approval-request', requestId: 'c', toolName: 'Bash', input: { command: 'ls' } })
    reg.status('k', 'waiting')
    settle()
    expect(notices.slice(1).map((n) => [n.threadId, n.body, n.onScreen])).toEqual([
      ['r', 'Read y.ts?', undefined],
      ['k', 'Run ls?', undefined]
    ])
  })
})

describe("a notice of Work's with no thread", () => {
  const digest = { title: 'Work', body: 'Digest: 9 things in Cosmic, Purdue and Ref', urgent: false, work: { key: 'digest:2026-11-24', digest: '2026-11-24' } }
  const meeting = { title: 'Purdue', body: 'Budget review starts at 2:00 PM', urgent: true, work: { key: 'now', tell: 'prep:ev1', by: 1_000, open: { view: 'agenda', workspaceId: 'w1', at: 'ev1' } } }

  it('the digest goes out as finished with no thread, and never waits on who is at a desktop', () => {
    let present = true
    notifier.stop()
    notifier = new Notifier({ registry: reg, stuckMinutes: () => 10, hostName: () => 'The box', present: () => present, now: () => Date.now(), log: () => {} })
    notifier.onNotice((n) => void notices.push(n))
    notifier.work(digest)
    expect(notices).toEqual([{ event: 'finished', kind: 'finished', title: 'Work', body: 'Digest: 9 things in Cosmic, Purdue and Ref', ts: Date.now(), seq: 0, hostName: 'The box', work: { key: 'digest:2026-11-24', digest: '2026-11-24' } }])
    expect(isThreadNotice(notices[0]!)).toBe(false)
    // a second digest of the same day is the host's to prevent, not the notifier's: it is not held back here
    present = false
    notifier.work(digest)
    expect(notices).toHaveLength(2)
  })
  it('an interrupt goes out as needs_you with kind waiting, which no client turns into buttons', () => {
    notifier.work(meeting)
    expect(notices).toEqual([{ event: 'needs_you', kind: 'waiting', title: 'Purdue', body: 'Budget review starts at 2:00 PM', ts: Date.now(), seq: 0, work: meeting.work }])
    expect(notices[0]).not.toHaveProperty('threadId')
    expect(notices[0]).not.toHaveProperty('requestId')
    expect(notices[0]).not.toHaveProperty('onScreen')
  })
  it('an interrupt is stamped on screen while a person is at a desktop of this host; unknown, it is sent', () => {
    let present: boolean | 'throws' = true
    notifier.stop()
    notifier = new Notifier({
      registry: reg,
      stuckMinutes: () => 10,
      present: () => {
        if (present === 'throws') throw new Error('no focus signal')
        return present
      },
      now: () => Date.now(),
      log: () => {}
    })
    notifier.onNotice((n) => void notices.push(n))
    notifier.work({ ...meeting, work: { ...meeting.work, tell: 'a' } })
    present = false
    notifier.work({ ...meeting, work: { ...meeting.work, tell: 'b' } })
    present = 'throws'
    notifier.work({ ...meeting, work: { ...meeting.work, tell: 'c' } })
    expect(notices.map((n) => n.onScreen)).toEqual([true, undefined, undefined])
  })
  it('one thing told under one key is sent once in an hour, whichever host said it first; a clock that moved is news', () => {
    notifier.work(meeting)
    notifier.work(meeting)
    expect(notices).toHaveLength(1)
    // the same key carried for a host this one relays: already told
    expect(notifier.toldWork(meeting.work)).toBe(true)
    // its clock moved: told again
    notifier.work({ ...meeting, work: { ...meeting.work, by: 500 } })
    expect(notices).toHaveLength(2)
    // a relayed interrupt this host has not told is recorded, and the host's own tell of it then is not sent
    expect(notifier.toldWork({ key: 'now', tell: 'clash:7' })).toBe(false)
    notifier.work({ ...meeting, work: { key: 'now', tell: 'clash:7' } })
    expect(notices).toHaveLength(2)
    vi.advanceTimersByTime(WORK_TOLD_MS + 1)
    notifier.work(meeting)
    expect(notices).toHaveLength(3)
    // a digest is never held back
    expect(notifier.toldWork(digest.work)).toBe(false)
    expect(notifier.toldWork(digest.work)).toBe(false)
  })
  it("keeps a thing's title and its detail on a line each, cut as every notice is", () => {
    notifier.work({ title: '', body: `Line  one\n\n  line two\nline three ${'x'.repeat(300)}`, urgent: false, work: digest.work })
    expect(notices[0]!.title).toBe('Work')
    expect(notices[0]!.body).toBe('Line one\nline two')
    notifier.work({ title: 'Ref', body: `Not sent: Send to League\n${'x'.repeat(300)}`, urgent: false, work: digest.work })
    expect(notices[1]!.body).toHaveLength(200)
    expect(notices[1]!.body.startsWith('Not sent: Send to League\nxxx')).toBe(true)
  })
})

describe('the gate', () => {
  /** One morning of threads: a prompt, an answer, a finish, a failure, a held act, a stall. */
  function morning(n: Notifier, r: FakeRegistry): void {
    r.add('a', { status: 'running', title: 'Morning summary' })
    r.add('b', { status: 'running', title: 'Reply to Dana' })
    n.start()
    r.row('a', { type: 'approval-request', requestId: 'q1', toolName: 'Bash', input: { command: 'bun test' } })
    r.status('a', 'waiting')
    vi.advanceTimersByTime(1500)
    r.row('a', { type: 'approval-resolved', requestId: 'q1', allow: true })
    r.status('a', 'running')
    r.row('a', { type: 'assistant-text', id: 'm1', text: 'done' } as never)
    r.status('a', 'idle')
    vi.advanceTimersByTime(1500)
    r.row('b', { type: 'error', message: 'The model refused' })
    r.status('b', 'error')
    vi.advanceTimersByTime(1500)
    n.held('a', 'Held: Send to Dana Reyes: Re: budget', { at: 'host', id: 'h1' })
    r.status('b', 'running')
    vi.advanceTimersByTime(12 * 60_000)
  }
  function run(gate?: NoticeGate | 'none'): { notices: Notice[]; lines: string[] } {
    vi.setSystemTime(new Date('2026-10-19T12:00:00Z'))
    const r = new FakeRegistry()
    const out: Notice[] = []
    const log: string[] = []
    const n = new Notifier({ registry: r, stuckMinutes: () => 10, origin: () => 'https://tc.example', now: () => Date.now(), log: (l) => log.push(l) })
    n.onNotice((x) => void out.push(x))
    if (gate && gate !== 'none') n.setGate(gate)
    morning(n, r)
    n.stop()
    return { notices: out, lines: log }
  }

  it("with no gate, with one that keeps nothing, and with one that throws, every notice is today's, field for field", () => {
    const plain = run('none')
    expect(plain.notices.map((n) => `${n.event}:${n.threadId}:${n.body}`)).toEqual([
      'needs_you:a:Run bun test?',
      'finished:a:Done in 2s',
      'failed:b:Failed: The model refused',
      'needs_you:a:Held: Send to Dana Reyes: Re: budget',
      'stuck:b:No output for 10m'
    ])
    for (const n of plain.notices) expect(n).not.toHaveProperty('work')
    expect(JSON.stringify(run(() => false).notices)).toBe(JSON.stringify(plain.notices))
    const thrown = run(() => {
      throw new Error('the ledger is gone')
    })
    expect(JSON.stringify(thrown.notices)).toBe(JSON.stringify(plain.notices))
    expect(thrown.lines.some((l) => l.includes('gate failed: the ledger is gone'))).toBe(true)
    // taken away again, the notifier is today's
    const cleared = run('none')
    expect(JSON.stringify(cleared.notices)).toBe(JSON.stringify(plain.notices))
  })
  it('a gate may answer later: the notice goes, or is kept, once it has, and one that rejects lets it through', async () => {
    vi.useRealTimers()
    const r = new FakeRegistry()
    const out: Notice[] = []
    const log: string[] = []
    const n = new Notifier({ registry: r, stuckMinutes: () => 10, now: () => Date.now(), debounceMs: 1, log: (l) => log.push(l) })
    n.onNotice((x) => void out.push(x))
    let answer: (kept: boolean) => void = () => {}
    let fail: (err: Error) => void = () => {}
    n.setGate(
      () =>
        new Promise<boolean>((resolve, reject) => {
          answer = resolve
          fail = reject
        })
    )
    r.add('a', { status: 'running', title: 'Morning summary' })
    n.start()
    const finish = async (): Promise<void> => {
      r.status('a', 'running')
      r.row('a', { type: 'assistant-text', id: 'm', text: 'x' } as never)
      r.status('a', 'idle')
      await new Promise((done) => setTimeout(done, 20))
    }
    await finish()
    // asked, not yet answered: nothing has gone
    expect(out).toEqual([])
    answer(true)
    await new Promise((done) => setTimeout(done, 5))
    expect(out).toEqual([])
    await finish()
    answer(false)
    await new Promise((done) => setTimeout(done, 5))
    expect(out.map((x) => x.event)).toEqual(['finished'])
    await finish()
    fail(new Error('routines did not answer'))
    await new Promise((done) => setTimeout(done, 5))
    expect(out.map((x) => x.event)).toEqual(['finished', 'finished'])
    expect(log.some((l) => l.includes('gate failed: routines did not answer'))).toBe(true)
    n.stop()
    vi.useFakeTimers()
  })
  it('keeps back what the gate takes, hands it the notice and the thread, and sends the rest', () => {
    const asked: string[] = []
    const kept = run((notice, session) => {
      asked.push(`${notice.event}:${session.title}`)
      return session.title === 'Morning summary' && notice.event !== 'needs_you'
    })
    expect(asked).toEqual(['needs_you:Morning summary', 'finished:Morning summary', 'failed:Reply to Dana', 'needs_you:Morning summary', 'stuck:Reply to Dana'])
    expect(kept.notices.map((n) => `${n.event}:${n.threadId}`)).toEqual(['needs_you:a', 'failed:b', 'needs_you:a', 'stuck:b'])
    expect(kept.lines.some((l) => l.includes('(waits for the digest)'))).toBe(true)
  })
})
