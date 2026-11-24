/**
 * Full access everywhere, on a host of its own: a fresh database in a temp
 * folder, his global Thread defaults set to Full access (`auto`), and each new
 * thread made the way its path makes it: the window's draft built by the
 * window's own helpers and sent as `ensureCreated` sends it, or the host's own
 * call. Every row expects his default. No harness boots: nothing is sent.
 *
 *   bun --preload scripts/lib/electron-stub.ts scripts/proof-full-access.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, Store } from '../src/main/server/db'
import { SessionRegistry } from '../src/main/server/sessions'
import { requiredCapability, allows } from '../src/shared/capabilities'
import { accessParams, newDefaultSession, newSession } from '../src/renderer/src/lib/session'

const dataDir = mkdtempSync(join(tmpdir(), 'tc-full-access-'))
const store = new Store(openDb(join(dataDir, 'app.db')))
const registry = new SessionRegistry(store)
registry.setThreadDefaults(null, { provider: 'claude', model: '', reasoning: 'medium', permission: 'auto' })

let failures = 0
const check = (name: string, got: string, want: string): void => {
  const ok = got === want
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${got}${ok ? '' : ` (want ${want})`}`)
  if (!ok) failures++
}

/** What `ensureCreated` sends for a draft, then the host's answer. */
async function viaWindow(name: string, draft: ReturnType<typeof newSession>): Promise<void> {
  const made = await registry.createSession({ id: draft.id, provider: draft.harness, threadType: 'chat', agentType: 'implementer', cwd: dataDir, ...accessParams(draft) })
  check(name, made.permission, 'auto')
}

// A thread he set to Supervised himself: the one on screen when a path copied "the active thread".
const picked = await registry.createSession({ provider: 'claude', threadType: 'chat', agentType: 'implementer', cwd: dataDir, permission: 'safe' })
check('his own Supervised pick on a thread stays', picked.permission, 'safe')

await viaWindow('1 the draft a window boots with', newDefaultSession('local', dataDir))
await viaWindow('9/10/11/12 inbox item, note, host switch, empty window', newDefaultSession('local', dataDir))
await viaWindow('14/15 second opinion and hand-off', newSession('local', 'codex', dataDir))
await viaWindow('13 a new tab from another workspace', newSession('local', 'claude', dataDir))
const pickedDraft = { ...newDefaultSession('local', dataDir), runtimeMode: 'supervised' as const, accessPicked: true as const }
const keptPick = await registry.createSession({ provider: 'claude', threadType: 'chat', agentType: 'implementer', cwd: dataDir, ...accessParams(pickedDraft) })
check('a draft he set to Supervised before sending stays', keptPick.permission, 'safe')

// H2: a paired key without approve that leaves the mode to the host.
const operateOnly = new Set(['read', 'operate'] as const)
const need = requiredCapability({ method: 'session.create', params: {} })
check('H2 the key may send it', String(allows(operateOnly, need)), 'true')
const capped = await registry.createSession({ provider: 'claude', threadType: 'chat', agentType: 'implementer', cwd: dataDir }, undefined, { ceiling: 'edits' })
check('H2 a key without approve gets no more than Auto-accept edits', capped.permission, 'edits')

await registry.close?.()
rmSync(dataDir, { recursive: true, force: true })
console.log(failures ? `${failures} FAILED` : 'ALL PASS')
process.exit(failures ? 1 : 0)
