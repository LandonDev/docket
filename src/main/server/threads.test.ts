import { expect, it } from 'vitest'
import type { SessionMeta } from '@shared/events'
import { setAppBridge } from './apptools'
import { threadPreamble } from './threads'

const session = (threadType: SessionMeta['threadType']): SessionMeta =>
  ({
    id: 'thread-1',
    provider: 'claude',
    model: 'claude-fable-5-1',
    threadType,
    planPath: '/tmp/plan.md',
    projectId: null,
    cwd: '/tmp/not-a-repo',
    permission: 'ask'
  }) as unknown as SessionMeta

it('a chat asks only for what it cannot find out, and one handoff question at most', () => {
  const text = threadPreamble(session('chat')) ?? ''
  expect(text).toContain('names no thread type (and you did not just name research), ask exactly one question — which thread type')
  expect(text).toContain('NEVER ask whether to start a thread')
  expect(text).toContain('seedThreadIds: ["thread-1"]')
  expect(text).not.toContain('liberally')
  expect(text).not.toContain('offer to start a planning thread')
  // The batching nudge is what made chats bolt a handoff onto a real question.
  expect(text).not.toContain('gathering every decision')
  expect(text).toContain('AskUserQuestion')
})

it('a chat names a research-shaped ask as a research job without asking, and a following "go" means research', () => {
  const text = threadPreamble(session('chat')) ?? ''
  expect(text).toContain("this is a research thread's job")
  expect(text).toContain('A statement, never a question')
  expect(text).toContain('A "go" right after you said the ask is a research job names research')
  expect(text).toContain('research runs on claude')
  expect(text).toContain('NEVER ask whether to start a thread')
})

it("an implementation thread's spawn table marks Fable orchestrators-only and points at app_start_thread; an orchestration thread sees it plain", () => {
  const impl = threadPreamble(session('implementation')) ?? ''
  expect(impl).toContain('claude-fable-5-1 (low|medium|high|xhigh|max) +1m (orchestrators only)')
  expect(impl).toContain('Models marked orchestrators-only cannot be spawned as subagents from here; app_start_thread may still start them as threads')
  expect(impl).toContain('claude-opus-5-5 (low|medium|high|xhigh|max) +1m\n')
  // An orchestration thread on a non-claude harness reads the same table as a preamble, unmarked.
  const orch = threadPreamble({ ...session('orchestration'), provider: 'codex' } as SessionMeta) ?? ''
  expect(orch).toContain('claude-fable-5-1 (low|medium|high|xhigh|max) +1m\n')
  expect(orch).not.toContain('orchestrators only')
})

it('a planning thread still batches every ready decision into one call', () => {
  const text = threadPreamble(session('planning')) ?? ''
  expect(text).toContain('gathering every decision that is ready into one call')
})

it('a research thread synthesizes from files, never stops an explorer, and has a numeric done floor', () => {
  const text = threadPreamble(session('research')) ?? ''
  expect(text).toContain('at least 3 finished angles')
  expect(text).toContain('15 distinct cited sources')
  expect(text).toContain('file paths count as sources')
  expect(text).toContain('NEVER interrupt_agent an explorer')
  expect(text).toContain('SYNTHESIZE FROM THE FILES')
  expect(text).toContain('never name output paths yourself')
  expect(text).toContain('ONE Limits section')
  expect(text).toContain('call cite_source')
  expect(text).toContain('read the report and the findings files first')
  // Research is web, codebase, or both — the web-only framing is gone.
  expect(text).not.toContain('Your sources are the web')
  expect(text).not.toContain('not this codebase')
  expect(text).not.toContain('cannot fetch pages')
  const codex = threadPreamble({ ...session('research'), provider: 'codex' }) ?? ''
  expect(codex).toContain('cannot fetch pages')
  expect(codex).toContain('spawn claude explorers')
})

// ── project context: reports at the workspace root ─────────────────

it('the project context lists reports from the reports root by absolute path', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { projectContext } = await import('./threads')
  const root = await mkdtemp(join(tmpdir(), 'tc-ctx-'))
  try {
    const wsPath = join(root, 'repo')
    const dir = join(wsPath, '.temp-code', 'reports')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'r1.md'),
      '---\ntitle: Leagues v2\ndate: 2026-10-06\nstatus: complete\n---\n# Leagues\n'
    )
    const s = { ...session('implementation'), cwd: join(root, 'worktree') }
    const project = {
      id: 'p1',
      workspaceId: 'ws1',
      name: 'feature',
      mode: 'worktree' as const,
      branch: 'tc/feature',
      cwd: s.cwd,
      archived: false,
      createdAt: 1
    }
    const text = projectContext(s, project, 'repo', [], wsPath)
    expect(text).toContain(`"Leagues v2" (2026-10-06, complete) — ${join(dir, 'r1.md')}`)
    expect(text).toContain(`- ${dir}/ — research reports`)
    // Without a reports root the cwd is searched, and this one has none.
    expect(projectContext(s, project, 'repo', [])).not.toContain('research reports')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('a project-plan thread surveys the whole project, keeps the five sections, and never starts a build', () => {
  const text = threadPreamble(session('project-plan')) ?? ''
  expect(text).toContain('PROJECT PLAN thread')
  expect(text).toContain('survey the WHOLE project')
  expect(text).toContain('spawn explorers')
  for (const section of ['## Goals', '## Current state', '## Milestones', '## Risks', '## Open questions']) {
    expect(text).toContain(section)
  }
  expect(text).toContain('### [ ] 1. <title>')
  expect(text).toContain('- Done when:')
  expect(text).toContain('Never tick a milestone yourself')
  expect(text).toContain('call plan_complete once')
  expect(text).toContain('never start an implementation, planning or orchestration thread from here')
  expect(text).toContain('AskUserQuestion')
})

it('a Muse thread with the bridge gets the app tools note, never the "do not reach" sentence', () => {
  const muse = { ...session('implementation'), provider: 'muse', model: 'muse-spark-1.3' } as SessionMeta
  setAppBridge({ port: 1, scriptPath: '/x.mjs', command: 'node', env: {} })
  try {
    const text = threadPreamble(muse) ?? ''
    expect(text).toContain('You run inside the temp-code app and can operate it')
    expect(text).not.toContain('do not reach this harness')
  } finally {
    setAppBridge(null)
  }
  // With no bridge the sentence stands, as for codex.
  expect(threadPreamble(muse) ?? '').toContain('do not reach this harness')
})

// ── a Work thread's words: no branches, commits, merges, codebase or code-only thread types ──

const work = (threadType: SessionMeta['threadType']): SessionMeta => ({ ...session(threadType), scope: 'work' }) as SessionMeta
const CODE_WORDS = /\b(branch(es)?|commit(s|ted)?|merge[sd]?|codebase|planPath|planning|implementation|prod changes)\b/i

const CODE_HANDOFFS = `Handoffs: when the user says to go ahead and names a thread type (plan / implement / research), start that thread NOW with app_start_thread (threadType 'planning' / 'implementation' / 'research'; research runs on claude) with seedThreadIds: ["thread-1"] so it starts from this conversation — no confirmation, no summary of what you are about to do. A "go" right after you said the ask is a research job names research.
When the user says to go ahead and names no thread type (and you did not just name research), ask exactly one question — which thread type — and start it on their answer. That is the only handoff question allowed.
Confirm only destructive or outward-facing actions: prod changes, deletes, sending things.`
const CODE_APP_NOTE = `app_start_thread creates a new thread and sends its first message (threadType, provider/model/reasoning, optional planPath and seedThreadIds — this thread's id is thread-1). Start a thread ONLY when the user asked for it or agreed to the handoff; every new thread appears in the UI immediately. A planning thread you start reports back to you here when its plan is complete (and whether a build started), the way a subagent's settle does.`

it('a Work chat hands off only to a research thread or another chat and names no prod changes; a code chat reads as before', () => {
  const code = threadPreamble(session('chat')) ?? ''
  expect(code).toContain(CODE_HANDOFFS)
  const text = threadPreamble(work('chat')) ?? ''
  expect(text).not.toMatch(CODE_WORDS)
  expect(text).toContain("start a research thread NOW with app_start_thread (threadType 'research'; research runs on claude) with seedThreadIds: [\"thread-1\"]")
  expect(text).toContain("(threadType 'chat')")
  expect(text).toContain('Confirm only destructive or outward-facing actions: deletes, sending things.')
  expect(text).not.toContain('ask exactly one question — which thread type')
})

it("a Work research thread draws on the web and the job's own files; a code research thread reads as before", () => {
  const code = threadPreamble(session('research')) ?? ''
  expect(code).toContain('a durable, cited report: the live web, this codebase, or both, whatever the question needs.')
  expect(code).toContain('15 distinct cited sources — for codebase questions, file paths count as sources.')
  const text = threadPreamble(work('research')) ?? ''
  expect(text).not.toMatch(CODE_WORDS)
  expect(text).toContain("a durable, cited report: the live web, the job's own files (mail, documents, the files in its workspace folder), or both, whatever the question needs.")
  expect(text).toContain("15 distinct cited sources — file paths of the job's own files count as sources.")
})

it("a Work thread's app tools note names no plan file and no planning thread; a code thread's reads as before", () => {
  expect(threadPreamble(session('chat'))).toContain(CODE_APP_NOTE)
  const text = threadPreamble(work('chat')) ?? ''
  expect(text).toContain("(threadType, provider/model/reasoning, optional seedThreadIds — this thread's id is thread-1). Start a thread ONLY when the user asked for it or agreed to the handoff; every new thread appears in the UI immediately.\n")
  expect(text).not.toContain('planPath')
  expect(text).not.toContain('reports back to you here')
})

it('a Work chat bridged to codex reads the Work notes mechanics; a code one the code mechanics', async () => {
  const { NOTES_MECHANICS, WORK_NOTES_MECHANICS } = await import('./notesPrompts')
  setAppBridge({ port: 1, scriptPath: '/x', command: 'node', env: {} })
  try {
    const codex = (s: SessionMeta): string => threadPreamble({ ...s, provider: 'codex' } as SessionMeta) ?? ''
    expect(codex(session('chat'))).toContain(NOTES_MECHANICS)
    const text = codex(work('chat'))
    expect(text).toContain(WORK_NOTES_MECHANICS)
    expect(text).not.toContain(NOTES_MECHANICS)
    expect(text).not.toMatch(CODE_WORDS)
  } finally {
    setAppBridge(null)
  }
})

it("a Work chat's spawn example is a job's mail and documents; a code chat's is mapping code", async () => {
  const { chatSpawnPrompt } = await import('./orchestration')
  expect(chatSpawnPrompt(session('chat'))).toContain('sharpen the discussion — mapping\nexisting code, an experiment, an independent second opinion — and\n')
  const text = chatSpawnPrompt(work('chat'))
  expect(text).toContain('sharpen the discussion — reading through a long mail thread or a folder of documents, an experiment')
  expect(text).not.toContain('existing code')
})

it("a Work thread's project context names no branch, plan files or merges; a code thread's reads as before", async () => {
  const { projectContext } = await import('./threads')
  const project = { id: 'p1', workspaceId: 'ws1', name: 'app', mode: 'local' as const, branch: 'master', cwd: '/tmp/not-a-repo', archived: false, createdAt: 1 }
  const code = projectContext(session('chat'), project, 'repo', [])
  expect(code).toContain('This thread belongs to project "app" (workspace "repo", branch master).')
  expect(code).toContain('- plan-*.md — plan documents.\n')
  expect(code).toContain('(a decision, a plan written, work merged, an approach abandoned)')
  const text = projectContext(work('chat'), project, 'repo', [])
  expect(text).toContain('This thread belongs to project "app" (workspace "repo").')
  expect(text).toContain('(a decision, a document or file finished, an approach abandoned)')
  expect(text).not.toContain('plan-*.md')
  expect(text).not.toMatch(CODE_WORDS)
})
