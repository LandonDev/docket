/**
 * Away by kind, end to end on one isolated windowed instance (src/shared/away.ts,
 * src/main/server/away.ts, sessions.ts `awayFor`/`requestApproval`/`interceptAway`,
 * src/renderer/src/chrome/AwayRow.tsx). A scripted fake Anthropic provider behind
 * the loopback gateway makes each thread's first turn call Bash (`touch …`) in a
 * `safe` thread, so the harness asks. Proves:
 *   A. Away for Code only, switched on by a press on the rail foot's row: the Code
 *      thread's ask is allowed with one quiet `allowed` notice, no card, never
 *      `waiting`, the file written; the Work thread's ask at the same time is a
 *      card (approval-request row, status `waiting`), the file not written.
 *   B. Away for Work only, set through the row's context menu: the reverse.
 *   C. Pictures of the rail foot's row in the four states, dark and light, taken
 *      from the real window over CDP (Page.captureScreenshot), and the menu open.
 * Run: heavy bun scripts/e2e-away-by-kind.ts   (needs a built out/)
 * Env: AWAY_SHOTS=<dir> where the PNGs go (default .temp-code/plans/landed/F-away-by-kind).
 * Nothing touches the real data: its own userData, HOME, Aliax vault and WINVM_DIR
 * under /tmp, its own debug port, TEMP_CODE_REMOTE_PORT=0; it ends only its own pids.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Database } from 'bun:sqlite'
import { freePort, sleep } from './e2e-work-lib'
import { fakeMessage, seedFakeAccount } from './journeys/lib/fakeProvider'
import { Window, until } from './journeys/lib/window'
import type { AgentEvent } from '../src/shared/events'

const repo = resolve(import.meta.dirname, '..')
const shots = resolve(process.env.AWAY_SHOTS ?? join(repo, '..', '..', '..', '.temp-code/plans/landed/F-away-by-kind'))
const started = Date.now()
let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// ── the isolated instance's folders ─────────────────────────────────────
const root = mkdtempSync('/tmp/tc-awk-')
const home = join(root, 'home')
const data = join(root, 'data')
const tmp = join(root, 'tmp')
const work = join(home, 'work')
const noVm = join(root, 'no-vm')
for (const dir of [home, data, tmp, work, noVm, join(home, '.claude'), join(home, '.codex')]) mkdirSync(dir, { recursive: true })
const log = join(root, 'instance.log')
const providerLog = join(root, 'provider.log')
seedFakeAccount(join(data, 'aliax'))

// ── the fake provider: a marked first turn calls Bash, everything else is text ──
type Block = { type: string; text?: string; tool_use_id?: string }
type FakeRequest = { model?: string; messages?: { role: string; content: string | Block[] }[]; tools?: { name: string }[] }
const MARK = /AWAY-PROOF:([a-z0-9-]+)/
let replies = 0
const provider = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const { pathname } = new URL(request.url)
    if (pathname === '/api/oauth/profile') return Response.json({ account: { uuid: 'journey-practice', email: 'practice@example.test' }, organization: { uuid: 'journeys', name: 'Practice' } })
    if (pathname === '/api/oauth/usage') return Response.json({ limits: [] })
    if (pathname === '/v1/messages/count_tokens') return Response.json({ input_tokens: 10 })
    if (pathname !== '/v1/messages' || request.method !== 'POST') return Response.json({ error: 'No such dummy endpoint' }, { status: 404 })
    const body = (await request.json()) as FakeRequest
    const blocks = (body.messages ?? []).filter((m) => m.role === 'user').flatMap((m) => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content))
    const tag = blocks.map((b) => (b.type === 'text' ? MARK.exec(b.text ?? '')?.[1] : undefined)).find(Boolean)
    const id = tag ? `toolu_away_${tag.replaceAll('-', '_')}` : ''
    const answered = blocks.some((b) => b.tool_use_id === id)
    const tool = tag && !answered && body.tools?.some((t) => t.name === 'Bash') ? { id, name: 'Bash', input: { command: `touch away-${tag}.txt`, description: 'Write the proof file' } } : undefined
    appendFileSync(providerLog, `${new Date().toISOString()} model=${body.model} tag=${tag ?? '-'} answered=${answered} tool=${tool?.name ?? '-'} tools=${(body.tools ?? []).length}\n`)
    return new Response(fakeMessage(body.model ?? 'claude-haiku-5-5', tool, `msg_away_${++replies}`), { headers: { 'content-type': 'text/event-stream' } })
  }
})

// ── the instance: one window, its own host, as the journeys' `win` seat ──
const debug = await freePort()
const env: Record<string, string> = {
  PATH: ['/srv/agents/home/.local/bin', '/srv/agents/home/.bun/bin', process.env.PATH ?? '/usr/bin:/bin'].join(':'),
  LANG: process.env.LANG ?? 'C.UTF-8',
  HOME: home,
  TMPDIR: tmp,
  WINVM_DIR: noVm,
  CLAUDE_CONFIG_DIR: join(home, '.claude'),
  CODEX_HOME: join(home, '.codex'),
  TEMP_CODE_USER_DATA: data,
  TEMP_CODE_HEADLESS: '0',
  TEMP_CODE_REMOTE_PORT: '0',
  TEMP_CODE_DEBUG_PORT: String(debug),
  TEMP_CODE_ALIAX_DATA_DIR: join(data, 'aliax'),
  TEMP_CODE_CLAIM_SHIM: '0',
  TEMP_CODE_WARM_HARNESS: '0',
  TEMP_CODE_FAKE_PROVIDERS: provider.url.origin,
  TEMP_CODE_LIFEOS_URL: 'http://127.0.0.1:0',
  TEMP_CODE_LIFEOS_MCP_URL: 'http://127.0.0.1:0/mcp',
  TEMP_CODE_WORK_ROOT: work,
  TEMP_CODE_WORK_PORT: String(await freePort()),
  AGENT_CLI_CREDENTIAL_STORE: 'file',
  NODE_ENV: 'production',
  SHELL: '/bin/bash'
}
const argv = ['xvfb-run', '-a', '-s', '-screen 0 1440x900x24 -nolisten tcp', 'dbus-run-session', '--', join(repo, 'node_modules', '.bin', 'electron'), '.']
let proc: ChildProcess | null = null
const abort = new AbortController()

/** This run's own processes: every pid whose environment names this run's folder. */
function ownPids(): number[] {
  return readdirSync('/proc').filter((e) => /^\d+$/.test(e)).map(Number).filter((pid) => {
    if (pid === process.pid) return false
    try {
      return readFileSync(`/proc/${pid}/environ`, 'utf8').includes(root + '/')
    } catch {
      return false
    }
  })
}
async function stop(): Promise<void> {
  const group = proc?.pid
  if (group) try { process.kill(-group, 'SIGTERM') } catch { /* gone */ }
  for (let i = 0; i < 20 && ownPids().length; i++) await sleep(250)
  for (const pid of ownPids()) try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  if (group) try { process.kill(-group, 'SIGKILL') } catch { /* gone */ }
  provider.stop(true)
}

// ── reading the host's rows ─────────────────────────────────────────────
function rows(sessionId: string): AgentEvent[] {
  const db = new Database(join(data, 'temp-code.db'), { readonly: true })
  try {
    return db.query<{ payload: string }, [string]>('SELECT payload FROM events WHERE session_id = ? ORDER BY seq').all(sessionId).map((r) => JSON.parse(r.payload) as AgentEvent)
  } finally {
    db.close()
  }
}
const awayNotices = (evs: AgentEvent[]) => evs.filter((e): e is Extract<AgentEvent, { type: 'notice' }> => e.type === 'notice' && e.kind === 'away')
const cards = (evs: AgentEvent[]) => evs.filter((e): e is Extract<AgentEvent, { type: 'approval-request' }> => e.type === 'approval-request')
const waited = (evs: AgentEvent[]) => evs.some((e) => e.type === 'status' && e.status === 'waiting')
const finished = (evs: AgentEvent[]) => evs.some((e) => e.type === 'turn-complete')

type Snapshot = { state: { enabled: boolean; code?: boolean; work?: boolean; at: number; by: string }; decided: { threads: { sessionId: string; count: number }[] } }

async function main(): Promise<void> {
  proc = spawn(argv[0]!, argv.slice(1), { cwd: repo, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  proc.stdout?.on('data', (b: Buffer) => appendFileSync(log, b))
  proc.stderr?.on('data', (b: Buffer) => appendFileSync(log, b))
  proc.once('exit', (code, signal) => abort.abort(new Error(`the instance exited early (${signal ?? code}); see ${log}`)))

  const page = await Window.attach(debug, abort.signal, undefined, 1280, 800, 180_000)
  const cdp = (page as unknown as { cdp: { send(method: string, params?: object): Promise<unknown> } }).cdp
  const wait = (label: string, ms: number, test: () => unknown | Promise<unknown>) => until(label, ms, test, abort.signal)
  const rpc = async <T>(method: string, params: object = {}): Promise<T> => {
    const r = await page.eval<{ ok: boolean; value?: T; error?: string }>(`(async () => {
      try { return { ok: true, value: await window.__docket.registry.primary().request(${JSON.stringify(method)}, ${JSON.stringify(params)}) } }
      catch (e) { return { ok: false, error: String(e?.message ?? e) } }
    })()`)
    if (!r.ok) throw new Error(`${method}: ${r.error}`)
    return r.value as T
  }
  const ready = async (): Promise<void> => {
    await wait('the window connected to its host', 120_000, () => page.eval<boolean>('!!window.__docket?.registry?.primary()?.connected').catch(() => false))
    await wait('onboarding passed or the rail', 60_000, async () => {
      const skip = await page.centre('[role="dialog"] button', 'Skip')
      if (skip) await page.click(skip)
      return !skip && (await page.centre('button', 'Settings'))
    })
  }
  await ready()
  check('the isolated instance started and its window connected', true, `debug ${debug}, userData ${data}`)

  await rpc('work.set', { enabled: true })
  const codePath = join(home, 'code-practice')
  mkdirSync(codePath, { recursive: true })
  const codeWs = await rpc<{ id: string; path: string }>('workspace.create', { path: codePath, name: 'Code practice' })
  const workWs = await rpc<{ id: string; path: string }>('workspace.create', { kind: 'work', name: 'Away Work', sector: 'away-work' })
  const ROW = '[data-menu-id="away"]'
  const SWITCH = `${ROW} [role="switch"]`
  await wait('the Away row with its kind menu (Work on)', 30_000, () => page.eval<boolean>(`!!document.querySelector(${JSON.stringify(SWITCH)})`))
  const label = (): Promise<string> => page.eval<string>(`document.querySelector(${JSON.stringify(ROW)})?.textContent?.trim() ?? ''`)
  const kinds = async (): Promise<{ code: boolean; work: boolean }> => {
    const { state } = await rpc<Snapshot>('away.get')
    return { code: state.code ?? state.enabled, work: state.work ?? state.enabled }
  }
  const off = (): Promise<void> => page.hover({ x: 900, y: 400 })
  const menuPick = async (text: string): Promise<void> => {
    const at = await page.steadyPoint('the Away row', () => page.centre(SWITCH))
    await page.click(at, 1, 'right')
    await page.clickOn('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]', text)
    await wait('the menu to close', 5_000, () => page.eval<boolean>(`![...document.querySelectorAll('[role="menu"]')].some((m) => m.getClientRects().length && !m.hasAttribute('data-ending-style'))`))
  }
  check('Away starts off for both kinds', JSON.stringify(await kinds()) === '{"code":false,"work":false}', await label())

  /** One round: start a Code and a Work thread, send both their marked turn together, and read what came of each. */
  const round = async (tag: string, awayKind: 'code' | 'work'): Promise<void> => {
    const create = (ws: { id: string }, title: string, scope?: 'work') =>
      rpc<{ id: string }>('session.create', { workspaceId: ws.id, title, provider: 'claude', model: 'claude-haiku-5-5', reasoning: 'low', permission: 'safe', threadType: 'chat', ...(scope ? { scope } : {}) })
    const code = await create(codeWs, `Code ${tag}`)
    const workT = await create(workWs, `Work ${tag}`, 'work')
    const scopes = new Database(join(data, 'temp-code.db'), { readonly: true })
    const scopeOf = (id: string) => scopes.query<{ scope: string | null }, [string]>('SELECT scope FROM sessions WHERE id = ?').get(id)?.scope ?? null
    check(`[${tag}] the threads' kinds: Code thread scope not 'work', Work thread scope 'work'`, scopeOf(code.id) !== 'work' && scopeOf(workT.id) === 'work', `${scopeOf(code.id)} / ${scopeOf(workT.id)}`)
    scopes.close()
    const t0 = Date.now()
    await Promise.all([
      rpc('session.send', { sessionId: code.id, text: `This is a test of the app. AWAY-PROOF:${tag}-code` }),
      rpc('session.send', { sessionId: workT.id, text: `This is a test of the app. AWAY-PROOF:${tag}-work` })
    ])
    const away = awayKind === 'code' ? code : workT
    const asks = awayKind === 'code' ? workT : code
    const awayFile = join(awayKind === 'code' ? codeWs.path : workWs.path, `away-${tag}-${awayKind}.txt`)
    const askKind = awayKind === 'code' ? 'work' : 'code'
    const askFile = join(askKind === 'code' ? codeWs.path : workWs.path, `away-${tag}-${askKind}.txt`)
    try {
      await wait(`[${tag}] the away thread's turn and the other thread's card`, 120_000, () => finished(rows(away.id)) && cards(rows(asks.id)).length > 0 && waited(rows(asks.id)))
    } catch (e) {
      check(`[${tag}] both threads settled`, false, String(e))
    }
    const a = rows(away.id)
    const b = rows(asks.id)
    const allowed = awayNotices(a).filter((n) => n.away?.kind === 'allowed')
    const K = awayKind === 'code' ? 'Code' : 'Work'
    const O = awayKind === 'code' ? 'Work' : 'Code'
    check(`[${tag}] ${K} thread: its ask was allowed with one quiet 'allowed' notice`, allowed.length === 1, allowed.map((n) => n.message).join(' | ') || JSON.stringify(awayNotices(a)))
    check(`[${tag}] ${K} thread: no approval-request row`, cards(a).length === 0)
    check(`[${tag}] ${K} thread: never 'waiting'`, !waited(a), a.filter((e) => e.type === 'status').map((e) => (e as { status: string }).status).join(','))
    check(`[${tag}] ${K} thread: the turn finished and the Bash call ran (file written)`, finished(a) && existsSync(awayFile), awayFile)
    check(`[${tag}] ${O} thread: its ask is a card (approval-request row for Bash)`, cards(b).length === 1 && cards(b)[0]!.toolName === 'Bash', cards(b).map((c) => c.toolName).join(','))
    check(`[${tag}] ${O} thread: status 'waiting'`, waited(b))
    check(`[${tag}] ${O} thread: no away notice, no file while it waits`, awayNotices(b).length === 0 && !existsSync(askFile))
    const tally = (await rpc<Snapshot>('away.get')).decided.threads
    check(`[${tag}] the tally counts the ${K} thread alone`, tally.some((t) => t.sessionId === away.id && t.count >= 1) && !tally.some((t) => t.sessionId === asks.id), JSON.stringify(tally))
    // Settle the waiting thread so nothing is left hanging: deny its card.
    const card = cards(b)[0]
    if (card) {
      await rpc('session.approve', { sessionId: asks.id, requestId: card.requestId, allow: false })
      await wait(`[${tag}] the ${O} thread to finish after the deny`, 60_000, () => finished(rows(asks.id))).catch(() => {})
    }
    console.log(`      round ${tag} took ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  }

  // ── A. Code only, flipped by a press on the row (this place is code) ──
  console.log('\n[A] Away for Code only, by a press on the rail row')
  const placeKind = await page.eval<string>(`localStorage.getItem('docket.placeKind') ?? 'code'`)
  check('the window is in a code place', placeKind === 'code', placeKind)
  await page.clickOn(SWITCH)
  await wait('the host to hold Code only', 10_000, async () => JSON.stringify(await kinds()) === '{"code":true,"work":false}')
  check('the press set Away for Code only on the host', JSON.stringify(await kinds()) === '{"code":true,"work":false}')
  check('the row reads "Away for Code" and its switch is on', (await label()) === 'Away for Code' && (await page.eval<string>(`document.querySelector(${JSON.stringify(SWITCH)}).getAttribute('aria-checked')`)) === 'true', await label())
  await round('a', 'code')

  // ── B. Work only, through the row's context menu ──
  console.log('\n[B] Away for Work only, through the row\'s context menu')
  await menuPick('Work threads')
  await menuPick('Code threads')
  await wait('the host to hold Work only', 10_000, async () => JSON.stringify(await kinds()) === '{"code":false,"work":true}')
  check('the menu set Away for Work only on the host', JSON.stringify(await kinds()) === '{"code":false,"work":true}')
  check('the row reads "Away for Work"; this code place\'s switch is off', (await label()) === 'Away for Work' && (await page.eval<string>(`document.querySelector(${JSON.stringify(SWITCH)}).getAttribute('aria-checked')`)) === 'false', await label())
  await round('b', 'work')

  // ── C. pictures of the foot, in the real window ──
  console.log('\n[C] the rail foot in each state, dark and light')
  mkdirSync(shots, { recursive: true })
  const clip = () => page.eval<{ x: number; y: number; width: number; height: number }>(`(() => {
    const row = document.querySelector(${JSON.stringify(ROW)});
    const foot = row.parentElement;
    const r = foot.getBoundingClientRect();
    const pad = 8;
    return { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.width + pad * 2, height: r.height + pad * 2 };
  })()`)
  const shoot = async (name: string): Promise<void> => {
    const c = await clip()
    const { data: png } = (await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...c, scale: 2 } })) as { data: string }
    writeFileSync(join(shots, name), Buffer.from(png, 'base64'))
  }
  const STATES = [
    { name: 'off', set: { code: false, work: false }, text: 'Away' },
    { name: 'code-only', set: { code: true, work: false }, text: 'Away for Code' },
    { name: 'work-only', set: { code: false, work: true }, text: 'Away for Work' },
    { name: 'both', set: { code: true, work: true }, text: 'Away for both' }
  ] as const
  for (const theme of ['dark', 'light'] as const) {
    if (theme === 'light') {
      await page.eval(`localStorage.setItem('docket.colorScheme', 'light')`)
      await page.reload()
      await ready()
      await wait('the Away row after the reload', 30_000, () => page.eval<boolean>(`!!document.querySelector(${JSON.stringify(SWITCH)})`))
    }
    const isLight = await page.eval<boolean>(`document.documentElement.classList.contains('theme-light')`)
    check(`the window is in ${theme}`, isLight === (theme === 'light'))
    for (const s of STATES) {
      if (theme === 'dark' && s.name === 'both') await menuPick('Both')
      else await rpc('away.set', s.set)
      await wait(`the row to read "${s.text}"`, 10_000, async () => (await label()) === s.text)
      await off()
      await sleep(400)
      await shoot(`away-${s.name}-${theme}.png`)
      check(`picture: ${s.name} ${theme}`, (await label()) === s.text, `away-${s.name}-${theme}.png`)
    }
    // The kind menu open, both kinds away.
    const at = await page.steadyPoint('the Away row', () => page.centre(SWITCH))
    await page.click(at, 1, 'right')
    await wait('the kind menu', 5_000, () => page.centre('[role="menuitemcheckbox"], [role="menuitem"]', 'Code threads'))
    await sleep(400)
    const menu = await page.eval<{ x: number; y: number; width: number; height: number }>(`(() => {
      const m = [...document.querySelectorAll('[role="menu"]')].find((e) => e.getClientRects().length).getBoundingClientRect();
      const f = document.querySelector(${JSON.stringify(ROW)}).parentElement.getBoundingClientRect();
      const x = Math.min(m.x, f.x) - 8, y = Math.min(m.y, f.y) - 8;
      return { x: Math.max(0, x), y: Math.max(0, y), width: Math.max(m.right, f.right) - x + 8, height: Math.max(m.bottom, f.bottom) - y + 8 };
    })()`)
    const { data: png } = (await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...menu, scale: 2 } })) as { data: string }
    writeFileSync(join(shots, `away-menu-${theme}.png`), Buffer.from(png, 'base64'))
    await page.key('Escape')
  }
  await page.eval(`localStorage.removeItem('docket.colorScheme')`)
  await rpc('away.set', { code: false, work: false })
  page.close()
}

try {
  await main()
} catch (e) {
  check('the proof ran to its end', false, e instanceof Error ? (e.stack ?? e.message) : String(e))
} finally {
  await stop()
  const left = ownPids()
  check('no process of this run is left', left.length === 0, left.join(','))
  if (!failures && process.env.AWAY_KEEP !== '1') rmSync(root, { recursive: true, force: true })
  else console.log(`kept ${root} (instance.log, provider.log)`)
}
console.log(`\n${failures ? `${failures} FAILED` : 'all passed'} in ${((Date.now() - started) / 1000).toFixed(0)} s; pictures in ${shots}`)
process.exit(failures ? 1 : 0)
