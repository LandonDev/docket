/**
 * The Microsoft Forms proofs' rig, shared by scripts/proof-msforms.ts (the live bridge of P1 and P2) and
 * scripts/proof-msforms-canary.ts (the by-hand canary): the box browser as the host wires it, on a COPY of the box's
 * Work browser profile in a 0700 folder; the Work frame with the outbox and msforms pillars on a database of its own,
 * the VM's cached library record copied in read only; the real carrier on carrier sessions. Run under
 * `bun --preload ./scripts/lib/electron-stub.ts`, through `.temp-code/bin/heavy`.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LOCAL_PRINCIPAL } from '../../src/shared/capabilities'
import { ClientRequestSchema, type ClientRequest } from '../../src/shared/contract'
import type { SessionMeta } from '../../src/shared/events'
import { setAttachmentDirContext } from '../../src/main/server/attachmentDir'
import { openDb, Store } from '../../src/main/server/db'
import { setBoxBrowser, wireBoxBrowser } from '../../src/main/server/work/browser/box'
import { carrierSession } from '../../src/main/server/work/browser/box/service'
import { startWork } from '../../src/main/server/work/ctx'
import { ensureDigestTables } from '../../src/main/server/work/digest/store'
import { msforms } from '../../src/main/server/work/msforms/index'
import { outbox } from '../../src/main/server/work/outbox/index'
import { wireMsCarrier } from '../../src/main/server/work/msforms/carrier/wire'
import { WORK_MODULES } from '../../src/main/server/work/modules'

export const LIVE_DATA = '/srv/agents/temp-code-data'
const LIVE_DB = `${LIVE_DATA}/temp-code.db`
const LIVE_PROFILE = `${LIVE_DATA}/work-browser/box/profile`
/** What a copy of the profile leaves out: caches, which hold nothing of his sign-in. */
const CACHES = ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GrShaderCache', 'ShaderCache']

/**
 * A 0700 folder under /tmp holding a copy of the box's Work browser profile (Local State and Default, caches left out)
 * and a link to the host's work-tools, so the box browser runs headed as on the host. Refused while the live Work
 * browser runs: its profile is only ever read when no one writes it.
 */
export function copyProfile(): string {
  const running = (() => {
    try {
      return execFileSync('pgrep', ['-f', `[u]ser-data-dir=${LIVE_PROFILE}`]).toString().trim()
    } catch {
      return ''
    }
  })()
  if (running) throw new Error('the live Work browser is running: its profile is not copied while it runs')
  const dir = mkdtempSync('/tmp/tc-msforms-proof-')
  const profile = join(dir, 'work-browser/box/profile')
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  cpSync(join(LIVE_PROFILE, 'Local State'), join(profile, 'Local State'))
  cpSync(join(LIVE_PROFILE, 'Default'), join(profile, 'Default'), {
    recursive: true,
    filter: (src) => !CACHES.some((c) => src.includes(`/Default/${c}`)) && !src.includes('/Service Worker/CacheStorage')
  })
  symlinkSync(join(LIVE_DATA, 'work-tools'), join(dir, 'work-tools'))
  return dir
}

/** Removes a folder `copyProfile` made, and nothing else. */
export function removeCopy(dir: string): void {
  if (/^\/tmp\/tc-msforms-proof-[A-Za-z0-9]+$/.test(dir) && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}

export interface Rig {
  dir: string
  host: NonNullable<ReturnType<typeof wireBoxBrowser>>
  work: ReturnType<typeof startWork>
  db: ReturnType<typeof openDb>
  workspaceId: string
  logs: string[]
  pushes: unknown[]
  /** a wire call: his own, or a thread's (a model caller) */
  call(method: string, params: unknown, thread?: string): Promise<unknown>
  /** a carrier-marked session of the rig's own, for looks the proof takes at pages */
  looks: string
  /** the box service on the `looks` session */
  svc<T = Record<string, unknown>>(method: string, params: Record<string, unknown>): Promise<T>
  stop(): Promise<void>
}

/**
 * Boots the rig on `dir`. `host` is the environment id the rig takes (the box's own makes the library ids the box
 * uses: `<host>~<hash>`); `workspaceId` and `sector` name the job's row.
 */
export async function bootRig(dir: string, o: { host?: string; workspaceId?: string; sector?: string; log?: (line: string) => void } = {}): Promise<Rig> {
  const HOST = o.host ?? 'env_proof'
  const workspaceId = o.workspaceId ?? 'wproof'
  const logs: string[] = []
  const log = (line: string): void => {
    logs.push(`${new Date().toISOString()} ${line}`)
    ;(o.log ?? console.log)(line)
  }
  mkdirSync(join(dir, 'attachments'), { recursive: true })
  mkdirSync(join(dir, 'ws'), { recursive: true })
  setAttachmentDirContext({ dataDir: dir, session: () => null, projectCwd: () => null, workspacePath: () => null })
  const db = openDb(join(dir, 'proof.db'))
  // The VM's last record of his libraries, read only from the host's database.
  {
    const live = new DatabaseSync(LIVE_DB, { readOnly: true })
    db.exec('CREATE TABLE IF NOT EXISTS work_office_files (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    for (const r of live.prepare("SELECT key, value FROM work_office_files WHERE key IN ('vm:status', 'vm:wanted')").all() as { key: string; value: string }[])
      db.prepare('INSERT OR REPLACE INTO work_office_files (key, value) VALUES (?, ?)').run(r.key, r.value)
    live.close()
  }
  db.prepare("INSERT OR IGNORE INTO workspaces (id, name, path, created_at, kind, sector) VALUES (?, 'TempCode proof', ?, 0, 'work', ?)").run(workspaceId, join(dir, 'ws'), o.sector ?? 'purdue')
  ensureDigestTables(db)
  const store = new Store(db)
  const registry = {
    // No thread has a carrier session's id: as on the host, the registry knows none of them (run.ts would otherwise
    // take the carrier for a Work thread and refuse it Forms, as it refuses a thread).
    get: (_id: string) => null as unknown as SessionMeta,
    requestApproval: async () => false,
    awayFor: () => false,
    rootSessionOf: (id: string) => id,
    onMeta: () => {},
    onRemoved: () => () => {},
    onWorkspaceDeleted: () => () => {}
  }
  setBoxBrowser(null)
  const host = wireBoxBrowser({ registry: registry as never, store: store as never, dataDir: dir, log, videoOn: () => true })
  if (!host) throw new Error('no Chromium on this host')
  // The box browser's 2 GB cap (chromium.ts MEMORY_CAP_MB, the sum of each process's VmRSS) stops it with a Forms page,
  // a SharePoint page and a third open (P1). The rig raises it for itself alone (TC_PROOF_CAP_MB, 6 GB).
  ;(host.browser as unknown as { opts: { capMb?: number } }).opts.capMb = Number(process.env.TC_PROOF_CAP_MB ?? 6144)
  // the outbox finds an act's kind among the loaded pillars, as the host's own load fills them
  for (const m of [outbox, msforms]) if (!WORK_MODULES.includes(m)) WORK_MODULES.push(m)
  const pushes: unknown[] = []
  const work = startWork({ db, store, registry: registry as never, environmentId: HOST, dataDir: dir, log, remoteFence: { roots: () => [dir], denied: () => [] } } as never, [outbox, msforms])
  work.pushes.onPush((p) => void pushes.push(p))
  wireMsCarrier(db, HOST)
  const request = (method: string, params: unknown): ClientRequest => ClientRequestSchema.parse({ id: 'proof', method, params } as ClientRequest)
  const call = async (method: string, params: unknown, thread?: string): Promise<unknown> => {
    const out = thread ? await msforms.handle!(request(method, params), work.ctx, { kind: 'model', caps: [], sessionId: thread }) : await work.handle(request(method, params), LOCAL_PRINCIPAL)
    return out.handled ? out.result : { notHandled: method }
  }
  await call('work.set', { enabled: true })
  const looks = carrierSession()
  await host.service.request('session.open', { session: looks } as never)
  return {
    dir,
    host,
    work,
    db,
    workspaceId,
    logs,
    pushes,
    call,
    looks,
    svc: (method, params) => host.service.request(method as never, { ...params, session: looks } as never, { timeoutMs: 120_000 } as never) as never,
    async stop() {
      work.close()
      await host.browser.stop()
    }
  }
}

// ── the pages, driven the way the proofs drove them by hand ─────────────

export interface Read {
  text: string
  epoch: string
}

/** The first element whose line (after its index) matches: its index and line. */
export function find(text: string, line: RegExp): number | null {
  for (const l of text.split('\n')) {
    const m = /^\s*\[(\d+)\] (.*)$/.exec(l)
    if (m && line.test(m[2]!)) return Number(m[1])
  }
  return null
}

export async function readPage(rig: Rig, window: number): Promise<Read> {
  const o = await rig.svc<{ text: string; epoch: string }>('state.get', { app: { app: 'Chromium' }, window: { id: window }, screenshot: 'never', wait: { minMs: 500, quietMs: 1200, maxMs: 20_000, busyMaxMs: 20_000 } })
  return { text: o.text, epoch: o.epoch }
}

export async function press(rig: Rig, window: number, read: Read, element: number): Promise<boolean> {
  const r = await rig.svc<{ steps?: { status: string }[] }>('action.batch', {
    app: { app: 'Chromium' },
    window: { id: window },
    epoch: read.epoch,
    tiers: ['ax', 'process'],
    actions: [{ action: 'left_click', element }],
    wait: { minMs: 800, quietMs: 1000, maxMs: 10_000, busyMaxMs: 10_000 }
  })
  return r.steps?.[0]?.status === 'ok'
}

export async function openPage(rig: Rig, url: string): Promise<number> {
  const r = await rig.svc<{ window: { id: number } }>('apps.launch', { app: 'Chromium', open: [url] })
  return r.window.id
}

/** Reads until `line` shows, up to `ms`. */
export async function waitFor(rig: Rig, window: number, line: RegExp, ms = 45_000): Promise<Read | null> {
  for (let waited = 0; waited <= ms; waited += 2_000) {
    const r = await readPage(rig, window)
    if (find(r.text, line) !== null) return r
    await new Promise((res) => setTimeout(res, 2_000))
  }
  return null
}

/**
 * A button pressed by its own `click()` in the page, through DevTools, picked by its exact accessible name: for a
 * control Forms draws under another (the Recycle bin button under the Feedback button, P1). Only ever used for a
 * named control whose press only shows something.
 */
export async function clickInPage(rig: Rig, urlPart: string, name: string): Promise<boolean> {
  const port = Number(readFileSync(join(rig.dir, 'work-browser/box/profile/DevToolsActivePort'), 'utf8').split('\n')[0])
  const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[]
  const target = list.filter((t) => t.type === 'page' && t.url.includes(urlPart)).at(-1)
  if (!target) return false
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)))
  const expression = `(() => { const b = [...document.querySelectorAll('button, [role=tab], a')].filter((e) => (e.getAttribute('aria-label') || e.textContent || '').trim() === ${JSON.stringify(name)}); if (b.length !== 1) return false; b[0].click(); return true })()`
  const out = await new Promise<boolean>((res) => {
    ws.onmessage = (m) => {
      const d = JSON.parse(String(m.data)) as { id?: number; result?: { result?: { value?: boolean } } }
      if (d.id === 1) res(d.result?.result?.value === true)
    }
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
  })
  ws.close()
  return out
}
