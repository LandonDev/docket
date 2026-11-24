import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import { newThreadPermission, type ThreadDefaults } from '@shared/defaults'
import { accessCeiling, requiredCapability } from '@shared/capabilities'

/**
 * A new thread's access on the host, with his Thread defaults at Full access:
 * one rule (`newThreadPermission`) behind `session.create`, every host start
 * and the remote key's ceiling. Nothing is sent: no harness boots.
 */
const D = (permission: ThreadDefaults['permission']): ThreadDefaults => ({ provider: 'claude', model: '', reasoning: 'medium', permission })

describe('newThreadPermission', () => {
  it.each([
    [{ defaults: D('auto') }, 'auto'],
    [{ defaults: D('safe') }, 'safe'],
    [{ asked: 'safe' as const, defaults: D('auto') }, 'safe'],
    [{ asked: 'auto' as const, defaults: D('safe') }, 'auto'],
    [{ defaults: D('auto'), ceiling: 'edits' as const }, 'edits'],
    [{ asked: 'safe' as const, defaults: D('auto'), ceiling: 'edits' as const }, 'safe'],
  ])('%o → %s', (input, want) => {
    expect(newThreadPermission(input)).toBe(want)
  })
})

let root: string
let store: Store
let registry: SessionRegistry
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tc-access-'))
  store = new Store(openDb(join(root, 'app.db')))
  registry = new SessionRegistry(store)
  registry.setThreadDefaults(null, D('auto'))
})
afterEach(async () => {
  await registry.close()
  rmSync(root, { recursive: true, force: true })
})

const base = { provider: 'claude' as const, threadType: 'chat' as const, agentType: 'implementer' as const }

describe('session.create on the host, his default at Full access', () => {
  it('a create that asks for nothing (a window draft he did not pick, the phone, a screenshot drop, Add thread) takes it', async () => {
    expect((await registry.createSession({ ...base, cwd: root })).permission).toBe('auto')
  })

  it("reads the thread's own workspace", async () => {
    const path = join(root, 'ws')
    mkdirSync(path)
    const ws = await registry.createWorkspace(path, 'ws')
    registry.setThreadDefaults(ws.id, D('edits'))
    expect((await registry.createSession({ ...base, workspaceId: ws.id })).permission).toBe('edits')
  })

  it('his own pick stays, lower or not', async () => {
    expect((await registry.createSession({ ...base, cwd: root, permission: 'safe' })).permission).toBe('safe')
  })

  it("a paired key without approve holds no more than Auto-accept edits, even by default; asking for more needs approve", async () => {
    expect((await registry.createSession({ ...base, cwd: root }, undefined, { ceiling: 'edits' })).permission).toBe('edits')
    expect(requiredCapability({ method: 'session.create', params: { permission: 'auto' } })).toBe('approve')
  })

  it('judges the ceiling as the door does: approve lifts it, a device key\'s admin does not', () => {
    expect(accessCeiling(['read', 'operate'])).toBe('edits')
    expect(accessCeiling(['read', 'operate', 'approve'])).toBeUndefined()
    expect(accessCeiling(['read', 'operate', 'approve', 'admin'])).toBeUndefined()
    expect(accessCeiling(['read', 'operate', 'admin', 'device'])).toBe('edits')
  })
})
