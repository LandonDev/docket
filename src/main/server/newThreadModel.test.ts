import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import { CATALOG, clampReasoning } from '@shared/catalog'
import type { ThreadDefaults } from '@shared/defaults'

/**
 * A new thread's provider, model and effort on the host, the twin of
 * newThreadAccess.test.ts: a create that names none (a window draft he did not
 * pick, renderer commands.ts `modelParams`) takes his Thread defaults for the
 * thread's own workspace; a research thread still runs on Claude; an effort
 * always fits the model it resolved to. Nothing is sent: no harness boots.
 */
const D = (d: Partial<ThreadDefaults>): ThreadDefaults => ({ provider: 'claude', model: '', reasoning: 'medium', permission: 'edits', ...d })

let root: string
let registry: SessionRegistry
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tc-model-'))
  registry = new SessionRegistry(new Store(openDb(join(root, 'app.db'))))
  registry.setThreadDefaults(null, D({ provider: 'codex', model: 'gpt-5.5', reasoning: 'high' }))
})
afterEach(async () => {
  await registry.close()
  rmSync(root, { recursive: true, force: true })
})

const base = { threadType: 'chat' as const, agentType: 'implementer' as const }

describe('session.create on the host, his default on Codex', () => {
  it('a create that names nothing takes his provider, model and effort, at the 200k window', async () => {
    expect(await registry.createSession({ ...base, cwd: root })).toMatchObject({ provider: 'codex', model: 'gpt-5.5', reasoning: 'high', context1m: false })
  })

  it("reads the thread's own workspace, and an empty model is the provider's default", async () => {
    const path = join(root, 'ws')
    mkdirSync(path)
    const ws = await registry.createWorkspace(path, 'ws')
    registry.setThreadDefaults(ws.id, D({ provider: 'claude', reasoning: 'low' }))
    expect(await registry.createSession({ ...base, workspaceId: ws.id })).toMatchObject({ provider: 'claude', model: CATALOG.claude.defaultModel, reasoning: 'low' })
  })

  it('a research thread runs on Claude whatever the default', async () => {
    const research = await registry.createSession({ ...base, threadType: 'research', cwd: root })
    expect(research).toMatchObject({ provider: 'claude', model: CATALOG.claude.defaultModel })
  })

  it('his pick stays; an effort the resolved model does not serve becomes its own default', async () => {
    expect(await registry.createSession({ ...base, cwd: root, provider: 'claude', model: 'claude-fable-5-2', reasoning: 'max' })).toMatchObject({ provider: 'claude', reasoning: 'max' })
    // His default effort, ultra, on another provider's model whose ladder stops at max.
    registry.setThreadDefaults(null, D({ provider: 'codex', model: 'gpt-6.2-sol', reasoning: 'ultra' }))
    expect(await registry.createSession({ ...base, cwd: root, model: 'claude-fable-5-2' })).toMatchObject({ provider: 'claude', reasoning: 'high' })
  })
})

describe('the 1M window on the host', () => {
  it('is stored only for a model that offers it; one the catalog does not know keeps what was asked', async () => {
    // Asked with no model named: his Codex default has no 1M window.
    expect((await registry.createSession({ ...base, cwd: root, context1m: true })).context1m).toBe(false)
    expect((await registry.createSession({ ...base, cwd: root, model: 'claude-fable-5-2', context1m: true })).context1m).toBe(true)
    expect((await registry.createSession({ ...base, cwd: root, provider: 'claude', model: 'claude-not-yet-listed', context1m: true })).context1m).toBe(true)
  })
})

describe('clampReasoning', () => {
  it.each([
    ['claude', 'claude-fable-5-2', 'max', 'max'],
    ['claude', 'claude-fable-5-2', 'ultra', 'high'],
    ['codex', 'gpt-5.5', 'max', 'medium'],
    ['claude', 'a-model-the-catalog-does-not-know', 'ultra', 'ultra'],
  ] as const)('%s %s %s → %s', (provider, model, wanted, want) => {
    expect(clampReasoning(provider, model, wanted)).toBe(want)
  })
})
