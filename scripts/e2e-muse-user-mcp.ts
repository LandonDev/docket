/**
 * A Muse thread gets the person's own MCP servers: an in-process registry on
 * the real `muse` binary runs one auto thread in a workspace Muse does not
 * trust and asks it to call a tool of a server that lives only in the
 * person's Muse settings.json. Not in the gate (it spends a real turn).
 *
 *   XDG_CONFIG_HOME=<a config dir holding muse/settings.json and a login> \
 *   bun --preload scripts/lib/electron-stub.ts scripts/e2e-muse-user-mcp.ts <cwd> <server> <tool> <expected text>
 *
 * e.g. in the lifeos checkout: lifeos get_settings America/Chicago.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, Store } from '../src/main/server/db'
import { SessionRegistry } from '../src/main/server/sessions'
import { setOrchestrationRegistry } from '../src/main/server/orchestration'
import { setAppToolsRegistry } from '../src/main/server/apptools'
import type { EventRow } from '../src/shared/events'

process.env.TBH_CREDENTIAL_BACKEND ??= 'file'
process.env.MUSE_CONTRIBUTOR_MODE ??= '0'
const [cwd, server, tool, expected] = process.argv.slice(2)
if (!cwd || !server || !tool || !expected) throw new Error('usage: e2e-muse-user-mcp.ts <cwd> <server> <tool> <expected text>')

const store = new Store(openDb(join(mkdtempSync(join(tmpdir(), 'tc-muse-mcp-')), 'app.db')))
const registry = new SessionRegistry(store)
setOrchestrationRegistry(registry)
setAppToolsRegistry(registry)
registry.hostName = () => 'e2e-host'

const thread = await registry.create({ provider: 'muse', model: process.env.MUSE_MODEL ?? 'muse-ember-1.0', reasoning: 'low', agentType: 'implementer', permission: 'auto', cwd, threadType: 'chat', parentId: null })
const done = new Promise<EventRow>((resolve) => {
  const off = registry.subscribe(thread.id, (r) => {
    if (r.event.type === 'turn-complete' || (r.event.type === 'status' && (r.event.status === 'waiting' || r.event.status === 'error'))) {
      off()
      resolve(r)
    }
  })
})
await registry.send(thread.id, `Call the ${tool} tool of the ${server} MCP server once and reply with only the value of its timezone field. If you have no such tool, reply NONE.`)
const end = await Promise.race([done, new Promise<null>((r) => setTimeout(() => r(null), 240_000))])
const events = registry.eventsAfter(thread.id, 0).map((r) => r.event)
const call = events.find((e) => e.type === 'tool-call' && !e.partial && JSON.stringify(e).includes(tool))
const answer = events.filter((e) => e.type === 'assistant-text' && !e.delta).map((e) => (e as { text: string }).text).join(' ')
if (process.env.E2E_DUMP) for (const e of events) console.log(JSON.stringify(e).slice(0, 300))
let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
check('the turn settled', end?.event.type === 'turn-complete', end?.event.type ?? 'timeout')
check(`a ${server} ${tool} call ran`, !!call, call ? (call as { name: string }).name : 'none')
check(`the answer says ${expected}`, answer.includes(expected), answer.slice(-120))
await registry.close()
process.exit(failures ? 1 : 0)
