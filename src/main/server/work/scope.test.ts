import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ProjectMeta, WorkspaceMeta } from '@shared/domain'
import type { SessionMeta } from '@shared/events'
import { WORK_HOME } from '@shared/work'
import {
  sameScope,
  stampScope,
  WORK_OFF,
  WORK_ORPHAN,
  WORK_PROVIDERS,
  workAddonScope,
  workFolderName,
  workHomeOf,
  workHomeOfSession,
  workProviderRefusal,
  WorkRefused,
  workScopeOf,
  withinFence,
  type ScopeFacts,
  type StampInput
} from './scope'

/**
 * The scope rule alone, over rows: what makes a thread a Work thread, where
 * a Work thread's children may land, and what a thread with no Work home is
 * left with.
 */

const ws = (id: string, over: Partial<WorkspaceMeta> = {}): WorkspaceMeta => ({ id, name: id, path: `/w/${id}`, git: false, createdAt: 1, ...over }) as WorkspaceMeta
const purdue = ws('purdue', { kind: 'work', sector: 'purdue', linkId: 'link-purdue' })
const cosmic = ws('cosmic', { kind: 'work', sector: 'cosmic' })
const repo = ws('repo', { git: true })
const project = (id: string, workspaceId: string): ProjectMeta => ({ id, name: id, workspaceId, cwd: `/w/${workspaceId}/${id}` }) as ProjectMeta
const projects = [project('p-purdue', 'purdue'), project('p-cosmic', 'cosmic'), project('p-repo', 'repo')]
const session = (id: string, over: Partial<SessionMeta> = {}): SessionMeta => ({ id, parentId: null, projectId: null, workspaceId: null, threadType: 'chat', ...over }) as SessionMeta
const sessions = [
  session('work-purdue', { scope: 'work', workspaceId: 'purdue' }),
  session('work-purdue-project', { scope: 'work', projectId: 'p-purdue' }),
  session('work-cosmic', { scope: 'work', workspaceId: 'cosmic' }),
  session('work-chat', { scope: 'work' }),
  session('work-chat-2', { scope: 'work' }),
  session('orphan', { scope: 'work', workspaceId: 'repo' }),
  session('gone', { scope: 'work', workspaceId: 'deleted' }),
  session('code', { projectId: 'p-repo' }),
  session('code-chat')
]
const facts: ScopeFacts = {
  workspaces: () => [purdue, cosmic, repo],
  project: (id) => projects.find((p) => p.id === id) ?? null,
  session: (id) => sessions.find((s) => s.id === id) ?? null
}
const by = (id: string): SessionMeta => facts.session(id)!
const stamp = (asked: StampInput['asked'], at: { project?: string; workspace?: string } = {}, enabled = true) =>
  stampScope(facts, {
    asked: { threadType: 'chat', ...asked },
    project: at.project ? facts.project(at.project) : null,
    workspace: at.workspace ? (facts.workspaces().find((w) => w.id === at.workspace) ?? null) : null,
    enabled
  })

describe('what makes a thread a Work thread', () => {
  it('a code create is not stamped, switch on or off', () => {
    for (const enabled of [true, false]) {
      expect(stamp({}, {}, enabled)).toBeNull()
      expect(stamp({ workspaceId: 'repo' }, { workspace: 'repo' }, enabled)).toBeNull()
      expect(stamp({ parentId: 'code' }, { project: 'p-repo' }, enabled)).toBeNull()
      expect(stamp({ startedBy: 'code-chat', scope: 'code' }, {}, enabled)).toBeNull()
    }
  })

  it('a thread of a Work workspace is one, asked or not, by workspace or by project', () => {
    expect(stamp({ workspaceId: 'purdue' }, { workspace: 'purdue' })).toMatchObject({ scope: 'work', workspace: purdue, from: null })
    expect(stamp({ scope: 'work' }, { project: 'p-purdue' })).toMatchObject({ scope: 'work', workspace: purdue })
    // found by its folder, the create naming no workspace
    expect(stamp({}, { workspace: 'purdue' })).toMatchObject({ scope: 'work', workspace: purdue })
    expect(() => stamp({ workspaceId: 'purdue', scope: 'code' }, { workspace: 'purdue' })).toThrow(/its threads are Work threads/)
  })

  it('a Work Chat is a Work thread with no workspace', () => {
    expect(stamp({ scope: 'work', workspaceId: null })).toMatchObject({ scope: 'work', workspace: null, from: null })
    // a client's cwd that happens to be a code workspace's folder does not put a Work thread in it
    expect(stamp({ scope: 'work' }, { workspace: 'repo' })).toMatchObject({ scope: 'work', workspace: null })
  })

  it('asking for Work inside a code workspace or project is refused', () => {
    expect(() => stamp({ scope: 'work', workspaceId: 'repo' }, { workspace: 'repo' })).toThrow(/not a Work workspace/)
    expect(() => stamp({ scope: 'work' }, { project: 'p-repo' })).toThrow(WorkRefused)
  })

  it('with the switch off nothing of Work is made, by any of the three ways', () => {
    expect(() => stamp({ workspaceId: 'purdue' }, { workspace: 'purdue' }, false)).toThrow(WORK_OFF)
    expect(() => stamp({ scope: 'work', workspaceId: null }, {}, false)).toThrow(WORK_OFF)
    expect(() => stamp({ parentId: 'work-purdue' }, {}, false)).toThrow(WORK_OFF)
  })

  it('a root Work thread is a chat or a research thread; a subagent has no type', () => {
    expect(stamp({ scope: 'work', workspaceId: null, threadType: 'research' })).not.toBeNull()
    for (const threadType of ['planning', 'project-plan', 'implementation', 'orchestration', null] as const) expect(() => stamp({ scope: 'work', workspaceId: null, threadType })).toThrow(/chat or a research thread/)
    expect(stamp({ parentId: 'work-chat', threadType: null })).toMatchObject({ scope: 'work' })
  })
})

describe('scope follows the parent', () => {
  it("a thread a Work thread spawns or starts is a Work thread of the parent's workspace", () => {
    expect(stamp({ parentId: 'work-purdue', threadType: null })).toMatchObject({ scope: 'work', workspace: purdue, from: by('work-purdue') })
    expect(stamp({ startedBy: 'work-purdue-project' })).toMatchObject({ scope: 'work', workspace: purdue })
    expect(stamp({ startedBy: 'work-purdue' }, { project: 'p-purdue' })).toMatchObject({ scope: 'work', workspace: purdue })
    expect(stamp({ parentId: 'work-chat', threadType: null })).toMatchObject({ scope: 'work', workspace: null, from: by('work-chat') })
  })

  it('it is refused a code project, a code workspace, another job, and the word "code"', () => {
    expect(() => stamp({ startedBy: 'work-purdue' }, { project: 'p-repo' })).toThrow(/project "p-repo" is outside it/)
    expect(() => stamp({ parentId: 'work-purdue', threadType: null }, { project: 'p-repo' })).toThrow(WorkRefused)
    expect(() => stamp({ startedBy: 'work-purdue' }, { project: 'p-cosmic' })).toThrow(/its own workspace \(purdue\)/)
    expect(() => stamp({ startedBy: 'work-purdue', workspaceId: 'repo' }, { workspace: 'repo' })).toThrow(WorkRefused)
    expect(() => stamp({ startedBy: 'work-chat' }, { project: 'p-purdue' })).toThrow(/Work Chats/)
    expect(() => stamp({ startedBy: 'work-purdue', scope: 'code' })).toThrow(/is a Work thread/)
  })

  it('a child found by a code folder still lands in the parent, never in that folder', () => {
    // the spawn names the parent's cwd; were it a code workspace's folder, the registry's by-folder guess must not win
    expect(stamp({ parentId: 'work-purdue', threadType: null }, { workspace: 'repo' })).toMatchObject({ workspace: purdue })
  })

  it('a Work thread with no Work home starts nothing', () => {
    expect(() => stamp({ parentId: 'orphan', threadType: null })).toThrow(/no Work workspace on this host/)
    expect(() => stamp({ startedBy: 'gone' })).toThrow(WorkRefused)
  })
})

describe('a thread\'s scope from its row', () => {
  const here = { host: 'env_box', away: () => true }
  it('is null for a code thread and names workspace, sector, host and Away for a Work thread', () => {
    expect(workScopeOf(facts, by('code'), here)).toBeNull()
    expect(workScopeOf(facts, null, here)).toBeNull()
    expect(workScopeOf(facts, by('work-purdue-project'), here)).toMatchObject({ sessionId: 'work-purdue-project', workspaceId: 'purdue', sector: 'purdue', host: 'env_box', away: true, routineRunId: null })
    expect(workScopeOf(facts, by('work-chat'), here)).toMatchObject({ workspaceId: null, sector: null })
    expect(workScopeOf(facts, session('r', { scope: 'work', routineRunId: 'run-1' }), here)?.routineRunId).toBe('run-1')
  })

  it('a file in Microsoft or Google is shared; what only a pillar knows is not guessed', () => {
    const scope = workScopeOf(facts, by('work-purdue'), here)!
    expect(scope.shared({ at: 'google', account: 'a', fileId: 'f', mime: 'm' })).toBe(true)
    expect(scope.shared({ at: 'microsoft', host: 'h', app: 'excel', name: 'n', ref: { kind: 'url', url: 'https://x' } })).toBe(true)
    expect(scope.shared({ at: 'file', host: 'h', path: '/x' })).toBe(false)
    expect(scope.shared({ at: 'lifeos', table: 'docs', id: '1' })).toBe(false)
  })

  it('a Work thread in a workspace that is not Work keeps its fence and loses its job', () => {
    expect(workHomeOfSession(facts, by('orphan'))).toBe('orphan')
    expect(workHomeOfSession(facts, by('gone'))).toBe('orphan')
    expect(workScopeOf(facts, by('orphan'), here)).toMatchObject({ workspaceId: null, sector: null })
    expect(workAddonScope(facts, by('orphan'))).toBe(WORK_ORPHAN)
  })

  it('the add-on scope key: the workspace, the Work home, and nothing for a code thread', () => {
    expect(workAddonScope(facts, by('work-purdue-project'))).toBe('purdue')
    expect(workAddonScope(facts, by('work-chat'))).toBe(WORK_HOME)
    expect(workAddonScope(facts, by('code'))).toBeNull()
  })
})

describe('the fence between threads', () => {
  it('a Work thread reaches the threads of its own workspace only', () => {
    expect(sameScope(facts, by('work-purdue'), by('work-purdue-project'))).toBe(true)
    expect(sameScope(facts, by('work-chat'), by('work-chat-2'))).toBe(true)
    expect(sameScope(facts, by('work-purdue'), by('work-cosmic'))).toBe(false)
    expect(sameScope(facts, by('work-purdue'), by('work-chat'))).toBe(false)
    expect(sameScope(facts, by('work-purdue'), by('code'))).toBe(false)
    expect(sameScope(facts, by('code'), by('code-chat'))).toBe(true)
    expect(sameScope(facts, by('orphan'), by('orphan'))).toBe(false)
  })

  it('a code thread is not fenced here', () => {
    expect(withinFence(facts, by('code'), by('work-purdue'))).toBe(true)
    expect(withinFence(facts, by('work-purdue'), by('code'))).toBe(false)
  })
})

describe('the harnesses offered for Work', () => {
  it('Claude Code, Codex and Muse Code, each fenced at the harness and bound to its own thread on the app side; no other', () => {
    expect([...WORK_PROVIDERS]).toEqual(['claude', 'codex', 'muse'])
    for (const provider of WORK_PROVIDERS) expect(workProviderRefusal(provider)).toBeNull()
    for (const provider of ['cursor', 'grok', 'opencode', 'pi', 'omp', 'fx'] as const) expect(workProviderRefusal(provider)).toMatch(/^refused: Work threads run on Claude, Codex or Muse Code\. .+ is not offered for Work/)
  })
  it('the bridge sends its own thread and token after whatever a tool was given: no tool argument names another thread', async () => {
    const bridge = (await import(resolve(import.meta.dirname, '..', '..', '..', '..', 'scripts', 'app-mcp-bridge.mjs'))) as {
      callParams: (params: Record<string, unknown>, session: string, token: string) => Record<string, unknown>
      argumentRefusal: (name: string, args: unknown) => string | null
    }
    expect(bridge.callParams({ threadId: 't', sessionId: 'another', appToken: 'another' }, 'mine', 'my-token')).toEqual({ threadId: 't', sessionId: 'mine', appToken: 'my-token' })
    expect(bridge.argumentRefusal('app_start_thread', { threadType: 'chat', sessionId: 'another' })).toMatch(/^refused: app_start_thread has no argument "sessionId"/)
  })
})

describe('names', () => {
  it('a workspace folder name has no separators and is never empty', () => {
    expect(workFolderName('Purdue RecWell')).toBe('Purdue RecWell')
    expect(workFolderName('a/b\\c:d')).toBe('a b c d')
    expect(workFolderName('../..')).toBe('Work')
    expect(workFolderName('   ')).toBe('Work')
    expect(workFolderName('x'.repeat(200))).toHaveLength(80)
  })

  it('a workspace as another host matches it; all null for a Work Chat', () => {
    expect(workHomeOf(purdue)).toEqual({ sector: 'purdue', workspaceLinkId: 'link-purdue', workspaceName: 'purdue', workspacePath: '/w/purdue' })
    expect(workHomeOf(null)).toEqual({ sector: null, workspaceLinkId: null, workspaceName: null, workspacePath: null })
  })
})

describe('the rule is the host\'s own, not a pillar', () => {
  // The registry, the drivers and the app tools load these two files when the host boots, so they may load
  // nothing that can fail the way a pillar can: no pillar, not the registry, not the mount, not the other parts.
  const eager = (file: string): string[] =>
    [...readFileSync(resolve(import.meta.dirname, file), 'utf8').matchAll(/^import (type )?[^\n]*? from '([^']+)'/gm)].filter((m) => !m[1]).map((m) => m[2])
  it('scope.ts and preamble.ts load only node, the shared types and two host files', () => {
    expect(eager('scope.ts').sort()).toEqual(['../addons/scope', '../workRoot', '@shared/catalog', '@shared/work', 'node:fs', 'node:path'])
    expect(eager('preamble.ts')).toEqual([])
  })
  it('the app tools reach it through orchestration.ts and load nothing else under work/', () => {
    const apptools = readFileSync(resolve(import.meta.dirname, '..', 'apptools.ts'), 'utf8')
    expect([...apptools.matchAll(/^import (?!type )[^\n]*? from '(\.\/work\/[^']+)'/gm)].map((m) => m[1])).toEqual(['./work/toolInput'])
  })
})
