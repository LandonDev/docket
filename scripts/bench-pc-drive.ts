#!/usr/bin/env bun
/**
 * How slow a PC's mapped network drive is in TempCode's Files, measured in the Windows rig: J: is an SMB share on
 * the box reached through a slow link (scripts/lib/slowLink.ts: a fixed delay and a rate cap each way), the bench
 * tree on it (scripts/make-pc-drive-bench.ts), and the same steps timed in two windows: the PC's own (the drive is
 * local to that app) and the Mac's through the box (`work.files.across`, a file opened as a copy on the box).
 *
 *   bun scripts/bench-pc-drive.ts --installer <temp-code-1.0.N-setup.exe> --tree <built checkout> --label before|after
 *       [--rate 8] [--delay 20] [--runs 3] [--keep] [--reuse] [--only pc|mac] [--no-rpc]
 *
 * --tree: the checkout whose built out/ the stand-in box and Mac run (the same commit as the installer's).
 * --keep: leave the rig, the share, the link, the stand-ins and the PC as they are at the end (the next run with
 * --reuse skips the install and setup; without --reuse it installs again over the kept rig).
 * Run it through .temp-code/bin/heavy with HEAVY_MAX_MIN raised: a run of 3 takes over an hour at 40 ms.
 *
 * Every step starts cold: the PC's TempCode restarted (its held work and caches gone), 12 s for Windows' SMB caches
 * (10 s by default) to lapse, the window reloaded. A step that needs a folder listed first gets there with the link
 * fast (no delay, no cap), then the link is slowed and the step alone is timed. Per step: the time on screen, every
 * request the window sent (method, params' shape, time, answer size), the slow link's bytes and round trips, the
 * longest frame gap in the window, and the hosts' own slow-request and event-loop lines (logs/stalls.log).
 * Results: .temp-code/plans/landed/pc-drive-speed/<label>.json and <label>.md.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { callLine, PROBE_JS, type WindowTake } from './lib/pcDriveProbe'
import { findRow, look, openRow, back, scrollOn, waitFor } from './lib/pcDriveSteps'

const arg = (name: string): string | undefined => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined)
const flag = (name: string): boolean => process.argv.includes(name)
const installer = resolve(arg('--installer') ?? '')
const tree = resolve(arg('--tree') ?? '')
const label = arg('--label') ?? ''
const RATE = Number(arg('--rate') ?? 8)
const DELAY = Number(arg('--delay') ?? 20)
const RUNS = Number(arg('--runs') ?? 3)
const ONLY = arg('--only')
/** Only the steps whose name matches (a window step, or a direct call). */
/** Environment for the PC's TempCode, as tcuser's own (a flag the app honours only under TEMP_CODE_USER_DATA). */
const PC_ENV = process.argv.flatMap((a, i) => (process.argv[i - 1] === '--pc-env' && /^TEMP_CODE_[A-Z_]+=/.test(a) ? [a.split('=') as [string, string]] : []))
const STEPS = arg('--steps') ? new RegExp(arg('--steps')!, 'i') : null
const wanted = (step: string): boolean => !STEPS || STEPS.test(step)
if (!existsSync(installer) || !existsSync(`${tree}/out/main`) || !/^[a-z0-9-]+$/.test(label)) {
  console.error('usage: bun scripts/bench-pc-drive.ts --installer temp-code-1.0.N-setup.exe --tree <built checkout> --label before|after [--rate 8] [--delay 20] [--runs 3] [--keep] [--reuse] [--only pc|mac] [--no-rpc]')
  process.exit(64)
}
process.env.RIG_REPO = tree
const R = await import('./lib/pcDriveRig')
const P = await import('./lib/pcRig')
type Window = InstanceType<typeof P.Window>

const OUT = '/srv/agents/work/temp-code/.temp-code/plans/landed/pc-drive-speed'
mkdirSync(OUT, { recursive: true })
const t00 = Date.now()
const lines: string[] = []
const log = (m: string): void => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${m}`
  console.log(line)
  lines.push(line)
}

// ── setup ─────────────────────────────────────────────────────────────────

await R.startShare(log)
await R.link.shape(0, 0)
await R.rigUp(log)
let state = flag('--reuse') ? R.loadState() : null
if (state && (state.installer !== installer || state.tree !== tree)) state = null
let stand: { box: P.StandIn; mac: P.StandIn }
if (state) {
  stand = R.standinsNow()
  log(`reusing the set-up PC (${state.version}) and stand-ins`)
} else {
  const s = await R.startStandins(log)
  stand = s
  const version = await R.installPc(installer, log)
  await R.mapJ()
  log('J: mapped, Bench holds 300 entries')
  await R.startPc()
  // The first screen offers the setup link; this PC is paired by hand instead.
  const ids = await R.setUpPc(s, log)
  state = { workspace: s.workspace, ...ids, installer, tree, version }
  R.saveState(state)
}
const setPcEnv = (on: boolean): Promise<unknown> => (PC_ENV.length ? P.ps(PC_ENV.map(([k, v]) => `[Environment]::SetEnvironmentVariable('${k}', ${on ? `'${v}'` : '$null'}, 'User')`).join('; ')) : Promise.resolve())
await setPcEnv(true)
if (PC_ENV.length) log(`the PC's TempCode starts with ${PC_ENV.map(([k, v]) => `${k}=${v}`).join(' ')}`)
const ws = state.workspace
const box = <T = any>(method: string, params: unknown = {}, ms = 120_000): Promise<T> => P.rpc<T>(stand.box, method, params, ms)
const benchRef = (path: string): { at: 'file'; host: string; path: string } => ({ at: 'file', host: state!.pcHost, path: `J:\\Bench${path ? `\\${path}` : ''}` })

// ── the windows ───────────────────────────────────────────────────────────

let pc: Window | null = null
let mac: Window | null = null

/** Every Files tab closed (the box keeps them; one left open would load again, and read again, at each reload). */
async function closeTabs(): Promise<void> {
  const { tabs } = await box<{ tabs: { id: string }[] }>('work.files.tabs', { workspaceId: ws })
  for (const t of tabs) await box('work.files.tabClose', { workspaceId: ws, tabId: t.id, discard: true }).catch(() => undefined)
}

/** The PC's TempCode restarted, the box's link to it back, 12 s for Windows' SMB caches to lapse. */
async function coldPc(): Promise<void> {
  await closeTabs()
  pc?.close()
  await R.stopPc()
  pc = await R.startPc()
  const back = await P.until('the box reaching the PC again', 120_000, () => box('work.files.across', { workspaceId: ws, host: state!.pcHost, method: 'work.files.places', params: {} }, 10_000).then(() => true), 1000)
  if (!back) log('the box did not reach the PC again within 2 minutes')
  await P.sleep(12_000)
}

const windowOf = (which: 'pc' | 'mac'): Window => (which === 'pc' ? pc! : mac!)

/** The window reloaded and on the workspace's Files, its Home page; the probe installed. */
async function toFiles(w: Window): Promise<void> {
  await w.eval('location.reload()')
  await P.sleep(5000)
  await P.until('the window', 30_000, () => w.has('Purdue (rig)'))
  // A first screen that offers the setup link stands in front of everything.
  if (await w.has('Paste the link from your Mac')) await w.click('Skip')
  await w.click(/^Purdue \(rig\)$/)
  await P.sleep(1500)
  for (let k = 0; k < 4 && !(await w.has('Places')); k++) {
    await w.click('Files')
    await P.sleep(2500)
  }
  await P.until('the Bench place', 60_000, async () => (await w.eval<boolean>(`!!document.querySelector('[data-files-place="Bench"]')`)) || false, 500)
  await w.click('Home', '[data-files-place]')
  await P.sleep(1500)
  await w.eval(PROBE_JS)
}

const PLANNED = (await import('./make-pc-drive-bench')).planTree()
/** The names directly in a bench folder ('' for Bench). */
function namesIn(folder: string): Set<string> {
  const depth = folder ? folder.split('/').length + 1 : 1
  const under = (p: string): boolean => (folder ? p.startsWith(`${folder}/`) : true) && p.split('/').length === depth
  return new Set([...PLANNED.dirs.filter(under), ...PLANNED.files.map((f) => f.path).filter(under)].map((p) => p.split('/').pop()!))
}
const NAMES = { '': namesIn(''), A: namesIn('A'), 'A/B': namesIn('A/B'), 'A/B/C': namesIn('A/B/C') }
/** Rows of this folder (and of no folder above it) on screen. */
const rowsOf = (w: Window, folder: keyof typeof NAMES) => async (): Promise<boolean> => {
  const l = await look(w)
  return l.names.length >= Math.min(8, NAMES[folder].size) && l.names.every((n) => NAMES[folder].has(n))
}
const errorLine = (w: Window) => async (): Promise<string | null> => (await look(w)).error

interface Take {
  window: 'pc' | 'mac'
  step: string
  run: number
  /** the step's main time on screen, ms; null when it never came */
  ms: number | null
  marks: Record<string, number | null>
  failed: string | null
  link: R.LinkCount
  take: WindowTake
  stalls: { pc: string[]; box: string[] }
  note?: string
}
const takes: Take[] = []

async function stallsSince(iso: string): Promise<{ pc: string[]; box: string[] }> {
  const read = (text: string): string[] => text.split(/\r?\n/).filter((l) => l.slice(0, 24) >= iso && /slow-request|loop max/.test(l)).map((l) => l.replace(/ inflight=.*$/, '').slice(0, 200))
  const boxFile = join(stand.box.data, 'logs', 'stalls.log')
  const pcText = await P.ps(`Get-Content -Tail 400 '${R.USER_DATA}\\logs\\stalls.log' -EA 0`).then((r) => r.out, () => '')
  return { pc: read(pcText), box: read(existsSync(boxFile) ? readFileSync(boxFile, 'utf8') : '') }
}

/** One timed step: the link slowed and counted, the window's probe bracketing `act`. */
async function timed(which: 'pc' | 'mac', step: string, run: number, act: (w: Window) => Promise<{ ms: number | null; marks: Record<string, number | null>; failed: string | null; note?: string }>): Promise<Take> {
  const w = windowOf(which)
  await R.link.shape(DELAY, RATE)
  await P.sleep(500)
  const iso = new Date().toISOString()
  await R.link.reset()
  await w.eval('__bench.begin()')
  const got = await act(w).catch((err) => ({ ms: null, marks: {}, failed: `the step broke: ${err instanceof Error ? err.message : String(err)}` }))
  const take = await w.eval<WindowTake>('__bench.end()')
  const link = await R.link.reset()
  await R.link.shape(0, 0)
  const t: Take = { window: which, step, run, ...got, link, take, stalls: await stallsSince(iso) }
  takes.push(t)
  const s = (ms: number | null | undefined): string => (ms == null ? '—' : `${(ms / 1000).toFixed(1)} s`)
  log(`${which} ${step} #${run}: ${s(t.ms)}${t.failed ? ` (${t.failed})` : ''} · marks ${Object.entries(t.marks).map(([k, v]) => `${k} ${s(v)}`).join(', ')} · ${t.take.calls.length} calls · link ${(link.down / 2 ** 20).toFixed(1)} MB down, ${(link.up / 2 ** 20).toFixed(1)} MB up, ${link.turns} turns · gap ${t.take.gap} ms`)
  log(`    ${callLine(t.take.calls, 5)}`)
  if (t.stalls.pc.length) log(`    PC: ${t.stalls.pc.slice(0, 4).join(' | ')}`)
  return t
}

/** After the listing: the who-saved stat answered, or the cap. */
async function whoAfter(w: Window, t0: number, capMs: number): Promise<number | null> {
  const done = await waitFor(capMs, async () => {
    const calls = await w.eval<{ method: string; ms: number | null; at: number; inner?: string }[]>('__bench.calls.map(c => ({ method: c.method, inner: c.inner, ms: c.ms, at: c.at }))')
    const stat = calls.filter((c) => c.method === 'work.files.stat' || c.inner === 'work.files.stat')
    return stat.length > 0 && stat.every((c) => c.ms !== null) ? Math.max(...stat.map((c) => c.at + c.ms!)) : null
  })
  void t0
  return done.value ?? null
}

/** A folder's listing: the press, the rows, every drawn row's time to the end of the list, the who-saved stat. */
async function listStep(w: Window, press: () => Promise<unknown>, folder: keyof typeof NAMES, capMs: number): Promise<{ ms: number | null; marks: Record<string, number | null>; failed: string | null }> {
  const t0 = performance.now()
  await press()
  const rows = await waitFor(capMs, rowsOf(w, folder), errorLine(w))
  if (rows.ms === null) return { ms: null, marks: { rows: null }, failed: rows.failed }
  const end = await waitFor(Math.max(5000, capMs - rows.ms), async () => {
    const l = await look(w)
    if (!l.atEnd) await scrollOn(w)
    return l.atEnd && l.timed && !l.loading
  })
  await w.eval(`(() => { const l = document.querySelector('[data-files-list]'); if (l) l.scrollTop = 0 })()`)
  const who = await whoAfter(w, t0, 60_000)
  return { ms: rows.ms, marks: { rows: rows.ms, lastTime: end.ms === null ? null : rows.ms + end.ms, who }, failed: null }
}

/** With the link fast: Bench listed (and the folders below it, for `path`), the who-saved stats done or 60 s. */
async function goFast(w: Window, path: string[]): Promise<boolean> {
  await R.link.shape(0, 0)
  await w.click('Bench', '[data-files-place]')
  if (!(await waitFor(120_000, rowsOf(w, ''), errorLine(w))).ms) return false
  let at = ''
  for (const p of path) {
    await findRow(w, p)
    await openRow(w, p)
    at = at ? `${at}/${p}` : p
    if (!(await waitFor(120_000, rowsOf(w, at as keyof typeof NAMES), errorLine(w))).ms) return false
  }
  await P.sleep(1500)
  return true
}

const OPEN_DONE: Record<string, (w: Window) => Promise<string | false>> = {
  // The PDF's own text layer draws the first page's words.
  'Report.pdf': async (w) => ((await w.text()).includes('BENCH Report.pdf first page') ? 'text' : false),
  // The document's editor drawn in its tab (in the rig its body stayed empty: see the report).
  'Big.docx': async (w) => ((await w.eval<boolean>(`(() => { const t = document.querySelector('[role=tab][aria-selected=true]'); return !!t && /^Big/.test(t.textContent.trim()) && !!document.querySelector('[contenteditable=true]') })()`)) ? 'editor' : false),
  // A slide drawn, or the deck's own failure line (the stand-in box has no python-pptx to read a deck).
  'Deck.pptx': async (w) => {
    const t = await w.text()
    if (/Couldn.t open this deck/.test(t)) return 'deck-failed'
    return (await w.eval<boolean>(`[...document.querySelectorAll('img')].some((i) => i.naturalWidth > 200 && /slide|deck/i.test(i.closest('[class]')?.className ?? '') )`)) ? 'slide' : false
  }
}

async function openStep(w: Window, name: string): Promise<{ ms: number | null; marks: Record<string, number | null>; failed: string | null; note?: string }> {
  const stem = name.replace(/\.[^.]+$/, '')
  // The row is found again right before the press: a list drawn again in between drops the row found before.
  let pressed = false
  for (let k = 0; k < 3 && !pressed; k++) pressed = (await findRow(w, name)) && (await openRow(w, name))
  if (!pressed) return { ms: null, marks: {}, failed: `${name} is not in the list to press` }
  const t0 = performance.now()
  // The first sign: the spinner and its word on its row ("Opening…"), a tab of its name, or a toast naming it.
  const progress = waitFor(600_000, async () =>
    w.eval<boolean>(`(() => {
      const row = [...document.querySelectorAll('[data-files-row]')].find((r) => r.querySelector('[data-files-name]')?.textContent.trim() === ${JSON.stringify(name)})
      if (row && row.querySelector('[data-slot=spinner], svg.animate-spin')) return true
      if ([...document.querySelectorAll('[role=tab]')].some((t) => t.textContent.trim().startsWith(${JSON.stringify(stem)}))) return true
      return [...document.querySelectorAll('[data-sonner-toast]')].some((t) => t.textContent.includes(${JSON.stringify(stem)}))
    })()`)
  )
  // The row's own word once the copy says how far it has got: "Opening… 3.0 of 20 MB".
  const word = waitFor(600_000, async () =>
    w.eval<boolean>(`[...document.querySelectorAll('[data-files-row]')].some((r) => r.querySelector('[data-files-name]')?.textContent.trim() === ${JSON.stringify(name)} && /[0-9.]+ of [0-9.]+ MB/.test(r.textContent))`)
  )
  let how: string | false = false
  const usable = await waitFor(600_000, async () => (how = await OPEN_DONE[name]!(w)), async () => {
    const toast = await w.eval<string>(`[...document.querySelectorAll('[data-sonner-toast]')].map((e) => e.innerText).join(' ')`)
    return /did not open|could not|not reachable/i.test(toast) ? toast.replace(/\n/g, ' ').slice(0, 200) : null
  })
  const first = await progress
  // The word comes while the copy runs; once the step is over it is not waited for.
  const said = await Promise.race([word, P.sleep(1000).then(() => ({ ms: null }))])
  const ms = usable.ms
  const marks = { progress: first.ms, word: said.ms, usable: how === 'deck-failed' ? null : ms, answered: how === 'deck-failed' ? ms : null }
  void t0
  return { ms: how === 'deck-failed' ? null : ms, marks, failed: usable.failed ?? (how === 'deck-failed' ? "Couldn't open this deck (the stand-in box lacks python-pptx)" : null), ...(how ? { note: String(how) } : {}) }
}

/** Closes every file tab but Bench's. */
async function closeFileTabs(w: Window): Promise<void> {
  await w.eval(`(() => { for (const t of [...document.querySelectorAll('[role=tab]')]) { if (!/^Bench$/.test(t.textContent.trim())) t.querySelector('button[aria-label^=Close], [aria-label*=lose]')?.click() } })()`)
}

/** What the PC says of its folder reader (doctor.get), read once its TempCode runs as the steps will. */
let folderReader: unknown = null
async function readDoctor(): Promise<void> {
  const d = await R.pcRpc<{ folderReader?: unknown }>('doctor.get', {}, 60_000).catch((err) => ({ folderReader: `doctor.get failed: ${err instanceof Error ? err.message : String(err)}` }))
  folderReader = d.folderReader ?? 'not in doctor.get on this build'
  log(`the PC's folderReader: ${JSON.stringify(folderReader)}`)
}

const WINDOWS: ('pc' | 'mac')[] = ONLY === 'pc' ? ['pc'] : ONLY === 'mac' ? ['mac'] : ['pc', 'mac']
mac = await P.Window.attach(R.PORT.macDebug, 60_000)
await coldPc()
await readDoctor()

for (let run = 1; run <= (flag('--rpc-only') ? 0 : RUNS); run++) {
  for (const which of WINDOWS) {
    // 1. Bench, cold.
    if (wanted('list Bench (cold)')) {
    await coldPc()
    await toFiles(windowOf(which))
    await timed(which, 'list Bench (cold)', run, (w) => listStep(w, () => w.click('Bench', '[data-files-place]'), '', 150_000))
    }

    // 2. Into A, then back to Bench.
    if (wanted('into A (100 entries)')) {
    await coldPc()
    await toFiles(windowOf(which))
    if (await goFast(windowOf(which), [])) {
      await P.sleep(12_000)
      await timed(which, 'into A (100 entries)', run, (w) => listStep(w, async () => (await findRow(w, 'A'), openRow(w, 'A')), 'A', 150_000))
      await timed(which, 'back to Bench (revisit)', run, (w) => listStep(w, () => back(w), '', 150_000))
    } else log(`${which}: Bench did not list even with the link fast; into A and back not run`)
    }

    // 3. Three levels down, A → B → C.
    if (wanted('three levels down (A, B, C)')) {
    await coldPc()
    await toFiles(windowOf(which))
    if (await goFast(windowOf(which), [])) {
      await P.sleep(12_000)
      await timed(which, 'three levels down (A, B, C)', run, async (w) => {
        const marks: Record<string, number | null> = {}
        const t0 = performance.now()
        let at = ''
        for (const p of ['A', 'B', 'C']) {
          await findRow(w, p)
          await openRow(w, p)
          at = at ? `${at}/${p}` : p
          const got = await waitFor(150_000, rowsOf(w, at as keyof typeof NAMES), errorLine(w))
          marks[p] = got.ms === null ? null : Math.round(performance.now() - t0)
          if (got.ms === null) return { ms: null, marks, failed: `${at}: ${got.failed}` }
        }
        return { ms: marks.C!, marks, failed: null }
      })
    }
    }

    // 4. The three files.
    for (const name of ['Big.docx', 'Report.pdf', 'Deck.pptx']) {
      if (!wanted(`open ${name}`)) continue
      await coldPc()
      await toFiles(windowOf(which))
      if (!(await goFast(windowOf(which), []))) {
        log(`${which}: Bench did not list with the link fast; ${name} not opened`)
        continue
      }
      await P.sleep(12_000)
      await timed(which, `open ${name}`, run, (w) => openStep(w, name))
      await closeFileTabs(windowOf(which))
    }
  }
}

// ── the calls alone, straight to each host ───────────────────────────────

interface RpcTake {
  host: 'pc' | 'box'
  call: string
  ms: number | null
  failed: string | null
  answer: string
  link: R.LinkCount
  stalls: string[]
}
const rpcs: RpcTake[] = []
async function rpcStep(host: 'pc' | 'box', call: string, fn: () => Promise<string>): Promise<void> {
  if (!wanted(call)) return
  await coldPc()
  await R.link.shape(DELAY, RATE)
  await P.sleep(500)
  const iso = new Date().toISOString()
  await R.link.reset()
  const t0 = performance.now()
  let answer = ''
  let failed: string | null = null
  try {
    answer = await fn()
  } catch (err) {
    failed = err instanceof Error ? err.message.slice(0, 200) : String(err)
  }
  const ms = failed ? null : Math.round(performance.now() - t0)
  const link = await R.link.reset()
  await R.link.shape(0, 0)
  const st = await stallsSince(iso)
  rpcs.push({ host, call, ms, failed, answer, link, stalls: host === 'pc' ? st.pc : st.box })
  log(`rpc ${host} ${call}: ${ms === null ? `failed after ${Math.round(performance.now() - t0)} ms (${failed})` : `${(ms / 1000).toFixed(1)} s`} · ${answer} · link ${(link.down / 2 ** 20).toFixed(1)} MB down, ${link.turns} turns`)
}
const CAP = 300_000
const list = (path: string) => async (): Promise<string> => `${(await R.pcRpc<{ entries: unknown[] }>('work.files.list', { workspaceId: ws, at: benchRef(path), sort: { by: 'name', dir: 'asc' } }, CAP)).entries.length} entries`
const across = (path: string) => async (): Promise<string> => `${(await box<{ entries: unknown[] }>('work.files.across', { workspaceId: ws, host: state!.pcHost, method: 'work.files.list', params: { at: benchRef(path), sort: { by: 'name', dir: 'asc' } } }, CAP)).entries.length} entries`
const office = (n: number) => PLANNED.files.filter((f) => !f.path.includes('/') && /\.(docx|xlsx|pptx)$/.test(f.path)).map((f) => f.path).sort().slice(0, n)
const stat = (names: string[]) => async (): Promise<string> => `${(await R.pcRpc<{ entries: ({ by?: string } | null)[] }>('work.files.stat', { workspaceId: ws, refs: names.map((n) => benchRef(n)) }, CAP)).entries.filter((e) => e?.by).length} with who`
const txt = PLANNED.files.filter((f) => !f.path.includes('/') && f.path.endsWith('.txt')).map((f) => f.path).sort()[0]!
/** `work.files.read` pieces of 4 MB from the start: what the window asks to show a file of its own host. */
const readPieces = (name: string, pieces: number) => async (): Promise<string> => {
  let got = 0
  for (let i = 0; i < pieces; i++) got += ((await R.pcRpc<{ data: string }>('work.files.read', { workspaceId: ws, ref: benchRef(name), offset: i * 4 * 2 ** 20, length: 4 * 2 ** 20 }, CAP)).data.length * 3) / 4
  return `${(got / 2 ** 20).toFixed(1)} MB in ${pieces} pieces`
}
const boxOpen = (name: string) => async (): Promise<string> => {
  const got = await box<{ tab?: { id: string } }>('work.files.open', { workspaceId: ws, ref: benchRef(name), name }, CAP)
  return `a tab ${got.tab ? 'made' : 'answered'}`
}
if (!flag('--no-rpc')) {
  await rpcStep('pc', 'work.files.list J:\\Bench (300)', list(''))
  await rpcStep('pc', 'work.files.list J:\\Bench\\A (100)', list('A'))
  await rpcStep('pc', 'work.files.list J:\\Bench\\A\\B\\C (100)', list('A\\B\\C'))
  await rpcStep('pc', 'work.files.list J:\\Bench\\Folder 01 (2 entries)', list('Folder 01'))
  await rpcStep('pc', 'work.files.stat 1 .txt file (the path checks alone)', stat([txt]))
  await rpcStep('pc', 'work.files.stat 1 Office file (who saved)', stat(office(1)))
  await rpcStep('pc', 'work.files.stat 20 Office files (who saved)', stat(office(20)))
  await rpcStep('box', 'work.files.across → work.files.list J:\\Bench (300)', across(''))
  await rpcStep('pc', 'work.files.read Deck.pptx, 2 pieces of 4 MB', readPieces('Deck.pptx', 2))
  for (const name of ['Big.docx', 'Report.pdf', 'Deck.pptx']) {
    await rpcStep('box', `work.files.open ${name} (the copy on the box)`, boxOpen(name))
  }
}

// ── the record ────────────────────────────────────────────────────────────

await readDoctor()
await setPcEnv(false)
const result = { label, version: state.version, installer, tree, pcEnv: Object.fromEntries(PC_ENV), folderReader, shape: { delayMs: DELAY, rateMbit: RATE }, runs: RUNS, startedAt: new Date(t00).toISOString(), minutes: Math.round((Date.now() - t00) / 60_000), takes, rpcs }
writeFileSync(join(OUT, `${label}.json`), JSON.stringify(result, null, 1))
writeFileSync(join(OUT, `${label}.log`), lines.join('\n') + '\n')
const { report } = await import('./lib/pcDriveReport')
writeFileSync(join(OUT, `${label}.md`), report(result))
log(`wrote ${join(OUT, `${label}.json`)} and ${label}.md`)

pc?.close()
mac?.close()
R.closeTunnels()
if (!flag('--keep')) {
  await R.stopPc().catch(() => undefined)
  await R.stopStandins()
  R.stopShare()
  await P.vm('down', [], 300_000)
  log('the rig, the stand-ins, the share and the link are down')
}
process.exit(0)
