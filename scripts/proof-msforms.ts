/**
 * The live proofs of Microsoft Forms in Work, P1 (a form made, collected, answered once, its workbook made) and P2
 * (answers timed from submit to Work's Responses, a renamed question, the tell, a routine's task), as the plan
 * `.temp-code/plan-0OohUT4FyDgY.md` asks them, by the trial's method (.temp-code/plans/ms-forms/trial.md "How it was
 * run"):
 *
 *   bun --preload ./scripts/lib/electron-stub.ts scripts/proof-msforms.ts <dir> [port]
 *
 * through `.temp-code/bin/heavy`, as a tracked background command. `<dir>` is a 0700 folder holding a copy of the
 * box's Work browser profile at `work-browser/box/profile` (Local State and Default, caches left out) and a link to
 * the host's `work-tools`, so the box browser runs headed on its own display as on the host. The live profile and the
 * host's database are only read.
 *
 * It boots the box browser as the host wires it (`wireBoxBrowser`), the Work frame with the outbox and msforms
 * pillars on a database of its own (the VM's cached RecWell library record copied in, so `librariesFor` reaches the
 * library), and the real carrier (`wireMsCarrier`: `opsCarrier` over `formsComputerOn` on carrier sessions). Then it
 * answers on 127.0.0.1:<port> (9381) until `/quit`: each stage is one POST, so a stage that meets a page Forms has
 * since changed stops there, says what it saw, and can be run again once the carrier is fixed.
 *
 *   /work {method, params, thread?}     a wire call: his own (owner), or a thread's (`thread`: a model caller)
 *   /svc {method, params}              the box browser's service on a carrier session (state.get, action.batch, …)
 *   /threadOpen {url}                  a thread's box_browser_open of an address (a non-carrier session)
 *   /shot {window, file}               a picture of a carrier window, saved to `file`
 *   /fetch {window, url, method?, headers?, bytes?}   a request from inside a page, as the page makes it
 *   /write {formId, changes}           his accepted change run through the carrier's `write`
 *   /poll {at}                         one tick of the answers poller at time `at`
 *   /tasks {formId, fromId, toId}      the routine's job "File a task for each answer", LifeOS stood in
 *   /isWorkbook {libraryId, path}      whether msforms names that file its workbook
 *   /state                              the tells, pushes and log lines so far, and the form rows
 *   /quit                               stops the browser and the frame
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LOCAL_PRINCIPAL } from '../src/shared/capabilities'
import { ClientRequestSchema, type ClientRequest } from '../src/shared/contract'
import type { SessionMeta } from '../src/shared/events'
import { setAttachmentDirContext } from '../src/main/server/attachmentDir'
import { openDb, Store } from '../src/main/server/db'
import { setBoxBrowser, wireBoxBrowser } from '../src/main/server/work/browser/box'
import { carrierSession } from '../src/main/server/work/browser/box/service'
import { startWork } from '../src/main/server/work/ctx'
import { ensureDigestTables } from '../src/main/server/work/digest/store'
import { msforms } from '../src/main/server/work/msforms/index'
import { outbox } from '../src/main/server/work/outbox/index'
import { pollAnswers } from '../src/main/server/work/msforms/answers/read'
import { wireMsCarrier } from '../src/main/server/work/msforms/carrier/wire'
import { writeChanges } from '../src/main/server/work/msforms/forms'
import { fileAnswerTasks } from '../src/main/server/work/msforms/routine'
import { MsformsStore } from '../src/main/server/work/msforms/store'
import { isFormsWorkbook } from '../src/main/server/work/msforms/workbook'
import { WORK_MODULES } from '../src/main/server/work/modules'

const dir = process.argv[2]
const port = Number(process.argv[3] ?? 9381)
if (!dir) throw new Error('usage: proof-msforms.ts <dir> [port]')
const HOST = 'env_proof'
const WORKSPACE = 'wproof'
const LIVE_DB = '/srv/agents/temp-code-data/temp-code.db'

const logs: string[] = []
const log = (line: string): void => {
  logs.push(`${new Date().toISOString()} ${line}`)
  console.log(line)
}

mkdirSync(join(dir, 'attachments'), { recursive: true })
mkdirSync(join(dir, 'ws'), { recursive: true })
setAttachmentDirContext({ dataDir: dir, session: () => null, projectCwd: () => null, workspacePath: () => null })

const db = openDb(join(dir, 'proof.db'))
// The VM's last record of his libraries, read only from the host's database: RecWell's library is in it.
{
  const live = new DatabaseSync(LIVE_DB, { readOnly: true })
  db.exec('CREATE TABLE IF NOT EXISTS work_office_files (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  for (const r of live.prepare("SELECT key, value FROM work_office_files WHERE key IN ('vm:status', 'vm:wanted')").all() as { key: string; value: string }[])
    db.prepare('INSERT OR REPLACE INTO work_office_files (key, value) VALUES (?, ?)').run(r.key, r.value)
  live.close()
}
db.prepare("INSERT OR IGNORE INTO workspaces (id, name, path, created_at, kind, sector) VALUES (?, 'TempCode proof', ?, 0, 'work', 'purdue')").run(WORKSPACE, join(dir, 'ws'))
ensureDigestTables(db)
const store = new Store(db)

const registry = {
  // No thread has a carrier session's id: as on the host, the registry knows none of them (run.ts would otherwise take
  // the carrier for a Work thread and refuse it Forms, as it refuses a thread). The proof's one thread is a code thread.
  get: (_id: string) => null as unknown as SessionMeta,
  requestApproval: async () => false,
  awayOn: () => false,
  rootSessionOf: (id: string) => id,
  onMeta: () => {},
  onRemoved: () => () => {},
  onWorkspaceDeleted: () => () => {}
}

setBoxBrowser(null)
const host = wireBoxBrowser({ registry: registry as never, store: store as never, dataDir: dir, log, videoOn: () => true })
if (!host) throw new Error('no Chromium on this host')
// The box browser's 2 GB cap (chromium.ts MEMORY_CAP_MB, the sum of each process's VmRSS, shared pages counted again in
// each) stops the browser with a Forms page, a SharePoint page and a third open (P1: 2053 and 2784 MB, the PSS about
// half). The proof raises it for itself alone (TC_PROOF_CAP_MB, 6 GB) so the stages can run; the finding is reported.
;(host.browser as unknown as { opts: { capMb?: number } }).opts.capMb = Number(process.env.TC_PROOF_CAP_MB ?? 6144)
// the outbox finds an act's kind among the loaded pillars, as the host's own load fills them (msforms.test.ts does the same)
for (const m of [outbox, msforms]) if (!WORK_MODULES.includes(m)) WORK_MODULES.push(m)
const pushes: unknown[] = []
const work = startWork({ db, store, registry: registry as never, environmentId: HOST, dataDir: dir, log, remoteFence: { roots: () => [dir], denied: () => [] } } as never, [outbox, msforms])
work.pushes.onPush((p) => void pushes.push(p))
wireMsCarrier(db, HOST)

const request = (method: string, params: unknown): ClientRequest => ClientRequestSchema.parse({ id: 'proof', method, params } as ClientRequest)
async function call(method: string, params: unknown, thread?: string): Promise<unknown> {
  const out = thread ? await msforms.handle!(request(method, params), work.ctx, { kind: 'model', caps: [], sessionId: thread }) : await work.handle(request(method, params), LOCAL_PRINCIPAL)
  return out.handled ? out.result : { notHandled: method }
}
await call('work.set', { enabled: true })

// The session the proof's own looks drive the pages on: marked as the carrier's, so Forms opens to it.
const looks = carrierSession()
await host.service.request('session.open', { session: looks } as never)

const routes: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
  work: async (b) => call(String(b.method), b.params ?? {}, b.thread as string | undefined),
  svc: async (b) => host.service.request(String(b.method) as never, { ...(b.params as object), session: looks } as never, { timeoutMs: 120_000 } as never),
  threadOpen: async (b) => host.sessions.run({ threadId: 't-proof-thread', permission: () => 'auto', approve: async () => true }, 'computer_apps', { launch: 'Chromium', open: [String(b.url)] }),
  shot: async (b) => {
    // The proof's own pictures, straight from Chromium's DevTools by the page's address: the carrier's sessions take
    // none (review 21). `region` [x0, y0, x1, y1] in the page's pixels crops out what must not be kept.
    const port = Number(readFileSync(join(dir, 'work-browser/box/profile/DevToolsActivePort'), 'utf8').split('\n')[0])
    const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[]
    const target = list.filter((t) => t.type === 'page' && t.url.includes(String(b.match))).at(-1)
    if (!target) throw new Error('no page with that address')
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)))
    const r = b.region as number[] | undefined
    const clip = r ? { x: r[0], y: r[1], width: r[2]! - r[0]!, height: r[3]! - r[1]!, scale: 1 } : undefined
    const data = await new Promise<string>((res, rej) => {
      ws.onmessage = (m) => {
        const msg = JSON.parse(String(m.data)) as { id?: number; result?: { data: string }; error?: { message: string } }
        if (msg.id === 1) (msg.result ? res(msg.result.data) : rej(new Error(msg.error?.message)))
      }
      ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png', ...(clip ? { clip } : {}) } }))
    })
    ws.close()
    writeFileSync(String(b.file), Buffer.from(data, 'base64'))
    return { file: b.file }
  },
  fetch: async (b) => {
    const { carrierComputer } = await import('../src/main/server/work/browser/box')
    const c = carrierComputer()!
    try {
      const got = await c.fetch(Number(b.window), String(b.url), { ...(b.method ? { method: b.method as 'GET' | 'POST' } : {}), ...(b.headers ? { headers: b.headers as Record<string, string> } : {}), ...(b.bytes ? { bytes: true } : {}) })
      return { status: got.status, json: got.json, bytes: got.bytes ? got.bytes.length : undefined }
    } finally {
      await c.end()
    }
  },
  write: async (b) => {
    const row = new MsformsStore(db).get(WORKSPACE, String(b.formId))
    if (!row) throw new Error('no such form row')
    const after = await writeChanges(work.ctx, row, b.changes as never, 'owner', 'owner')
    return { rev: after.rev, questions: after.questions }
  },
  carrier: async (b) => {
    // One carrier operation on a form the proof made, his own grant: what a stage needs to see a step's real failure.
    const { msCarrier } = await import('../src/main/server/work/msforms/carrier/types')
    const { authFor } = await import('../src/main/server/work/msforms/forms')
    const row = new MsformsStore(db).get(WORKSPACE, String(b.formId))
    if (!row) throw new Error('no such form row')
    const c = msCarrier()!
    try {
      if (b.op === 'read') return await c.read(authFor(work.ctx, row, 'count', 'owner', { formId: row.formId }), row.formId)
      if (b.op === 'sync') {
        // the page as it stands into the row, as any fresh read of the carrier's would (forms.ts storeRead)
        const { storeRead } = await import('../src/main/server/work/msforms/forms')
        const read = await c.read(authFor(work.ctx, row, 'count', 'owner', { formId: row.formId }), row.formId)
        const after = storeRead(work.ctx, row, read, { by: 'page' })
        return { rev: after.rev, title: after.title, questions: after.questions, settings: after.settings }
      }
      if (b.op === 'settings') return await c.settings(authFor(work.ctx, row, 'settings', 'owner', b.patch), row.formId, b.patch as never)
      throw new Error('op: read or settings')
    } catch (err) {
      return { failed: err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err), cause: (err as { cause?: unknown }).cause instanceof Error ? String((err as { cause: Error }).cause.message) : undefined }
    }
  },
  poll: async (b) => {
    const started = Date.now()
    await pollAnswers(work.ctx, Number(b.at ?? Date.now()))
    return { ms: Date.now() - started }
  },
  tasks: async (b) => {
    const made: unknown[] = []
    // LifeOS stood in: no test session of his LifeOS exists on the box, so the task's write is recorded, not made.
    const lifeos = { connected: () => true, owner: () => ({ mutation: async (name: string, args: unknown) => (made.push({ name, args }), `task-${made.length}`) }) }
    const out = await fileAnswerTasks({ ...work.ctx, lifeos } as never, { workspaceId: WORKSPACE, trigger: { on: 'file', source: { at: 'msform', workspaceId: WORKSPACE, formId: String(b.formId) }, by: 'someone-else' }, range: { formId: String(b.formId), fromId: Number(b.fromId), toId: Number(b.toId) } } as never)
    return { out, made }
  },
  isWorkbook: async (b) => ({ named: isFormsWorkbook(work.ctx, { libraryId: String(b.libraryId), path: String(b.path) } as never) }),
  state: async () => ({
    tells: db.prepare("SELECT key, kind, title, open FROM work_digest_tells WHERE kind LIKE 'msforms.%'").all(),
    pushes: pushes.length,
    logs,
    forms: new MsformsStore(db).list(WORKSPACE)
  }),
  quit: async () => {
    setTimeout(() => {
      work.close()
      host.browser.stop()
      setTimeout(() => process.exit(0), 3_000)
    }, 100)
    return { quitting: true }
  }
}

Bun.serve({
  hostname: '127.0.0.1',
  port,
  idleTimeout: 255,
  async fetch(req) {
    const name = new URL(req.url).pathname.slice(1)
    const route = routes[name]
    if (!route) return new Response('no such route', { status: 404 })
    try {
      const body = req.method === 'POST' ? ((await req.json()) as Record<string, unknown>) : {}
      return Response.json(await route(body))
    } catch (err) {
      return Response.json({ error: err instanceof Error ? err.message : String(err), kind: err instanceof Error ? err.constructor.name : typeof err }, { status: 500 })
    }
  }
})
log(`proof bridge on 127.0.0.1:${port}, data in ${dir}`)
