/**
 * His own edit to an .xlsx opened from the Files place is saved into the file (the Files build's open item 1,
 * .temp-code/plans/landed/F-files.md; the report .temp-code/plans/landed/E-sheets/sheets-files-save-report.md).
 *
 * One isolated windowed instance of the BUILT tree (`electron-vite preview --skipBuild`) under xvfb, with its own
 * HOME, userData, TMPDIR, Work root and ports; Work on; one Work workspace "Art". Dummy files only:
 *  a. `Roster.xlsx` in the workspace's own folder;
 *  b. `Team roster.xlsx` in a dummy Teams library under the instance's own HOME
 *     (`Library/CloudStorage/OneDrive-SharedLibraries-Dummy U/Esports Staff - Documents/General`), a place others
 *     can open on the workspace's own host.
 * For each, by hand in the window, with real key and mouse events over CDP (no store call):
 *  1. the rail's workspace, its Files view, the place, a double-click on the file: a Files tab in the sheet editor
 *  2. a click on A1, a value typed key by key, Return: no "not saved" toast, the header's line says saved, and the
 *     file's bytes on disk hold the value in A1 (read from the sheet's XML and the shared strings)
 *  3. Ctrl+B (⌘B on a Mac) on A1: the file's bytes hold A1 in a bold font
 *  4. the tab closed and the file opened again from its row: A1 shows the value
 *  5. nothing was written beside the file; for the library, nothing of it is left in the sheets pillar's scratch
 *     once its tab is closed (the university rule)
 * Pictures of the window before and after each edit go to the out folder.
 *
 * Run (repo root, after `bunx electron-vite build`; on the box through the heavy queue):
 *   env -u ELECTRON_RUN_AS_NODE bun scripts/e2e-sheet-files-save.ts [--out <dir>]
 * TC_E2E_KEEP=1 leaves the instance's folder for inspection. Nothing here touches /Applications, a real HOME, a
 * sign-in or the box's live service; it stops only the process group it started.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { attach, type Cdp } from './lib/packagedApp'

const REPO = resolve(import.meta.dir, '..')
const KEEP = process.env.TC_E2E_KEEP === '1'
const outArg = process.argv.indexOf('--out')
let failures = 0
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const log = (m: string): void => console.log(`      ${m}`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
if (!existsSync(join(REPO, 'out', 'renderer', 'index.html'))) {
  console.error('out/ is missing: run electron-vite build first')
  process.exit(2)
}
const freePort = (): Promise<number> =>
  new Promise((ok) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => ok(port))
    })
  })

// ── the instance's dirs and the dummy files ─────────────────────────────
const root = realpathSync(mkdtempSync(join(tmpdir(), 'tc-sheet-files-save-')))
const out = outArg > 0 ? resolve(process.argv[outArg + 1]!) : join(root, 'shots')
const home = join(root, 'home')
const data = join(root, 'data')
const work = join(home, 'work')
for (const d of [home, data, join(root, 'tmp'), work, out]) mkdirSync(d, { recursive: true })
const corpus = join(REPO, 'src/main/server/work/sheets/harness/corpus/formulas.xlsx')
const cloud = join(home, 'Library', 'CloudStorage')
const library = join(cloud, 'OneDrive-SharedLibraries-Dummy U', 'Esports Staff - Documents', 'General')
mkdirSync(library, { recursive: true })
mkdirSync(join(cloud, 'OneDrive-Dummy U'), { recursive: true })
copyFileSync(corpus, join(library, 'Team roster.xlsx'))

let proc: ChildProcess | undefined
const debug = await freePort()
function launch(): void {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: home,
    TMPDIR: join(root, 'tmp'),
    TEMP_CODE_USER_DATA: data,
    TEMP_CODE_HEADLESS: '0',
    TEMP_CODE_DEBUG_PORT: String(debug),
    TEMP_CODE_REMOTE_PORT: '0',
    TEMP_CODE_ALIAX_DATA_DIR: join(data, 'aliax'),
    TEMP_CODE_CLAIM_SHIM: '0',
    TEMP_CODE_FAKE_PROVIDERS: 'http://127.0.0.1:9',
    TEMP_CODE_WORK_ROOT: work,
    AGENT_CLI_CREDENTIAL_STORE: 'file',
    NODE_ENV: 'production',
    SHELL: '/bin/bash'
  }
  // The agent shell carries the box service's env: none of it may reach the proof's instance.
  for (const key of Object.keys(env)) if (/^TEMP_CODE_(HUB|APNS)_/.test(key)) delete env[key]
  delete env.ELECTRON_RUN_AS_NODE
  const vite = join(REPO, 'node_modules', '.bin', 'electron-vite')
  const argv = process.platform === 'linux' ? ['xvfb-run', '-a', '-s', '-screen 0 1440x900x24 -nolisten tcp', 'dbus-run-session', '--', vite, 'preview', '--skipBuild'] : [vite, 'preview', '--skipBuild']
  proc = spawn(argv[0]!, argv.slice(1), { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  proc.stdout?.on('data', (c: Buffer) => appendFileSync(join(root, 'app.log'), c))
  proc.stderr?.on('data', (c: Buffer) => appendFileSync(join(root, 'app.log'), c))
}
const cleanup = async (): Promise<void> => {
  cdp?.close()
  for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
    try {
      if (proc?.pid) process.kill(-proc.pid, sig)
    } catch {
      /* gone */
    }
    await sleep(1500)
  }
  if (!KEEP && failures === 0) rmSync(root, { recursive: true, force: true })
  else log(`left for inspection: ${root}`)
}
process.on('SIGINT', () => void cleanup().then(() => process.exit(130)))

// ── reading a workbook's bytes: one cell of the first sheet ─────────────
const unzip = (file: string, part: string): string => Bun.spawnSync(['unzip', '-p', file, part]).stdout.toString()
const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16)
function cellOf(file: string, ref: string): { value: string | undefined; bold: boolean; sha: string } {
  const sheet = unzip(file, 'xl/worksheets/sheet1.xml')
  const strings = [...unzip(file, 'xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => [...m[1]!.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((t) => t[1]).join(''))
  const cell = new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>([\\s\\S]*?)</c>)`).exec(sheet)
  const attrs = cell?.[1] ?? ''
  const inner = cell?.[2] ?? ''
  const t = /t="([^"]+)"/.exec(attrs)?.[1]
  const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1]
  const value = t === 's' ? strings[Number(v)] : t === 'inlineStr' ? /<t[^>]*>([^<]*)<\/t>/.exec(inner)?.[1] : v
  const styles = unzip(file, 'xl/styles.xml')
  const fontOf = [.../<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)![1]!.matchAll(/<xf [^>]*?fontId="(\d+)"/g)].map((m) => Number(m[1]))
  const fonts = [.../<fonts[^>]*>([\s\S]*?)<\/fonts>/.exec(styles)![1]!.matchAll(/<font(?:\s[^>]*)?>([\s\S]*?)<\/font>|<font\s*\/>/g)].map((m) => m[1] ?? '')
  const bold = /<b\s*\/>|<b val="(1|true)"\s*\/>/.test(fonts[fontOf[Number(/ s="(\d+)"/.exec(attrs)?.[1] ?? 0)] ?? 0] ?? '')
  return { value, bold, sha: sha(file) }
}

// ── the window, by hand ──────────────────────────────────────────────────
let cdp: Cdp | null = null
const ev = <T>(js: string): Promise<T> => cdp!.eval<T>(js)
const request = <T>(method: string, params: unknown): Promise<T> => ev<T>(`window.__monocode.registry.primary().request(${JSON.stringify(method)}, ${JSON.stringify(params)})`)
const until = async (label: string, ms: number, test: () => Promise<boolean> | boolean): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await Promise.resolve(test()).catch(() => false)) return true
    await sleep(250)
  }
  log(`timed out: ${label}`)
  return false
}
async function shot(name: string): Promise<void> {
  const r = (await cdp!.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
  writeFileSync(join(out, `${name}.png`), Buffer.from(r.data, 'base64'))
}
async function click(x: number, y: number, count = 1): Promise<void> {
  await cdp!.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  for (let c = 1; c <= count; c++) {
    await cdp!.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: c })
    await cdp!.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: c })
  }
}
/** The centre of the first element the selector finds whose own text is `text` (any text when none is given). */
const centre = (selector: string, text?: string): Promise<{ x: number; y: number } | null> =>
  ev(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${text === undefined ? 'true' : `e.textContent.trim() === ${JSON.stringify(text)}`} && e.getClientRects().length); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`)
async function press(selector: string, text: string | undefined, count = 1): Promise<boolean> {
  let at: { x: number; y: number } | null = null
  await until(`${selector} ${text ?? ''}`, 20_000, async () => !!(at = await centre(selector, text)))
  if (!at) return false
  await click(at.x, at.y, count)
  return true
}
async function typeKeys(text: string): Promise<void> {
  for (const ch of text) {
    const code = /[a-z]/i.test(ch) ? `Key${ch.toUpperCase()}` : /\d/.test(ch) ? `Digit${ch}` : ''
    await cdp!.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) })
    await cdp!.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) })
  }
}
async function key(k: 'Enter' | 'b', modifiers = 0): Promise<void> {
  const def = k === 'Enter' ? { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(modifiers ? {} : { text: '\r' }) } : { key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66 }
  await cdp!.send('Input.dispatchKeyEvent', { type: modifiers || k !== 'Enter' ? 'rawKeyDown' : 'keyDown', modifiers, ...def })
  await cdp!.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...def })
}
/** Ctrl on Linux and Windows, ⌘ on a Mac: the app's own key map (lib/keys.ts `modKey`). */
const MOD = process.platform === 'darwin' ? 4 : 2
const saveLine = (): Promise<string> => ev(`(() => { const p = document.querySelector('[data-files-save-line]'); return p ? p.dataset.filesSaveLine + ' | ' + p.textContent : '(none)' })()`)
const toasts = (): Promise<string[]> => ev(`[...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim())`)
/** A1 on the grid: Univer draws it on its canvas, a row header and a column header in from the canvas's corner. */
const cellA1 = async (): Promise<{ x: number; y: number } | null> =>
  ev(`(() => { const c = [...document.querySelectorAll('[data-sheet-item] canvas')].find((e) => e.getBoundingClientRect().width > 100); if (!c) return null; const r = c.getBoundingClientRect(); return { x: Math.round(r.x + 78), y: Math.round(r.y + 30) }; })()`)
/** A1 of the drawn grid's active sheet: the handle the format row is given, found through React's fiber of the sheet's body. */
const gridA1 = (): Promise<{ v: unknown; bold: boolean } | null> =>
  ev(`(() => { const root = document.querySelector('[data-sheet-item]'); if (!root) return null; for (const el of [root, ...root.querySelectorAll('*')]) { const k = Object.keys(el).find((n) => n.startsWith('__reactFiber$')); for (let f = k && el[k]; f; f = f.return) { const h = f.memoizedProps && f.memoizedProps.sheet; if (h && h.api) { const r = h.api.getActiveWorkbook().getActiveSheet().getRange(0, 0); return { v: r.getValue(), bold: (r.getCellStyleData() || {}).bl === 1 }; } } } return null; })()`)
const sheetUp = (): Promise<boolean> => until('the sheet is drawn', 30_000, async () => !!(await cellA1()) && (await saveLine()).startsWith('saved'))
const rowOf = (name: string): string => `[data-files-row$=${JSON.stringify(`/${name}`)}], [data-files-row$=${JSON.stringify(`:${name}`)}]`

/** One file, by hand: open from its row, type into A1, bold it, close and open again. */
async function oneCase(tag: string, file: string, name: string, place: () => Promise<boolean>): Promise<void> {
  const before = cellOf(file, 'A1')
  const beside = readdirSync(resolve(file, '..')).sort()
  check(`${tag}: the place shows the file`, await place())
  check(`${tag}: a double-click on its row opens it in a Files tab`, await press(rowOf(name), undefined, 2))
  if (!check(`${tag}: the sheet editor draws it and says it is saved`, await sheetUp(), await saveLine())) return
  const lineBefore = await saveLine()
  await shot(`${tag}-1-opened`)
  const value = `Hand ${tag} ${Date.now() % 100000}`
  const a1 = (await cellA1())!
  await click(a1.x, a1.y)
  await sleep(300)
  await typeKeys(value)
  await sleep(300)
  await shot(`${tag}-2-typing`)
  const said = await toasts()
  check(`${tag}: no toast while he types`, said.length === 0, said.join(' / '))
  await key('Enter')
  const saved = await until('the file holds the value', 15_000, () => cellOf(file, 'A1').value === value)
  const typed = cellOf(file, 'A1')
  check(`${tag}: the typed value is in the file's bytes`, saved, `A1 ${JSON.stringify(before.value)} (${before.sha}) → ${JSON.stringify(typed.value)} (${typed.sha})`)
  await until('the line says saved', 10_000, async () => (await saveLine()).startsWith('saved'))
  const lineAfter = await saveLine()
  check(`${tag}: the header's line says saved, with the time`, /^saved \| Saved \d/.test(lineAfter), `before "${lineBefore}", after "${lineAfter}"`)
  await shot(`${tag}-3-typed`)
  await click(a1.x, a1.y)
  await sleep(300)
  await key('b', MOD)
  const bolded = await until('the file holds A1 bold', 15_000, () => cellOf(file, 'A1').bold)
  const bold = cellOf(file, 'A1')
  check(`${tag}: ${MOD === 4 ? '⌘B' : 'Ctrl+B'} on A1 is in the file's bytes`, bolded && bold.value === value, `A1 ${JSON.stringify(bold.value)} bold ${bold.bold} (${bold.sha})`)
  await shot(`${tag}-4-bold`)
  check(`${tag}: nothing was written beside the file`, JSON.stringify(readdirSync(resolve(file, '..')).sort()) === JSON.stringify(beside), readdirSync(resolve(file, '..')).join(', '))
  // Cold: the tab closed, the file opened again from its row.
  await ev(`document.querySelector('[data-files-tab-close][aria-label=${JSON.stringify(`Close ${name}`)}]').click()`)
  await until('the tab goes', 10_000, async () => !(await ev<boolean>('!!document.querySelector("[data-sheet-item]")')))
  check(`${tag}: the file opens again from its row`, await press(rowOf(name), undefined, 2))
  if (check(`${tag}: and draws`, await sheetUp())) {
    const again = (await cellA1())!
    await click(again.x, again.y)
    // Univer draws the cells and the formula bar on canvases: A1 is read from the grid the tab drew, through its handle.
    let held: { v: unknown; bold: boolean } | null = null
    const shown = await until('the grid holds the value', 10_000, async () => (held = await gridA1())?.v === value && held.bold)
    check(`${tag}: opened cold, the grid shows A1 with the value, bold`, shown, JSON.stringify(held))
    await shot(`${tag}-5-reopened`)
  }
}

launch()
try {
  cdp = await attach(debug, 180_000)
  const up = await until('the window is connected', 60_000, () => ev<boolean>('!!window.__monocode?.registry?.primary()?.connected'))
  if (!check('the instance is up and its window connected', up)) throw new Error(`no window; log ${join(root, 'app.log')}`)
  await cdp.send('Page.enable')
  await request('work.set', { enabled: true })
  const ws = await request<{ id: string; path: string }>('workspace.create', { kind: 'work', sector: 'purdue', name: 'Art' })
  const own = join(ws.path, 'Roster.xlsx')
  copyFileSync(corpus, own)
  log(`workspace ${ws.id} at ${ws.path}; pictures in ${out}`)

  // The rail's workspace, then its Files view.
  check("the rail's workspace opens", await press('button, a, [role="button"], [role="treeitem"], [role="link"], div', 'Art'))
  check('its Files view opens', await press('button, a, [role="button"], [role="link"], div', 'Files'))

  await oneCase('folder', own, 'Roster.xlsx', () => until('the row', 20_000, async () => !!(await centre(rowOf('Roster.xlsx')))))
  await oneCase('library', join(library, 'Team roster.xlsx'), 'Team roster.xlsx', async () => {
    if (!(await press('button, a, [role="button"], [role="link"], div', 'Esports Staff'))) return false
    // The team's place lists its channels: General holds the file.
    if (!(await until('the channel', 20_000, async () => !!(await centre('[data-files-row]'))))) return false
    if (!(await centre(rowOf('Team roster.xlsx')))) await press('[data-files-row]', undefined, 2)
    return until('the row', 20_000, async () => !!(await centre(rowOf('Team roster.xlsx'))))
  })
  // The university rule: once the library's tab is closed, nothing made from its workbook is left in the scratch.
  await ev(`document.querySelector('[data-files-tab-close][aria-label="Close Team roster.xlsx"]')?.click()`)
  const scratch = join(data, 'work-files', 'preview-scratch', 'sheets', 'files')
  const left = (): string[] => (existsSync(scratch) ? readdirSync(scratch, { recursive: true }).map(String).filter((n) => /\.xlsx$/.test(n)) : [])
  check("nothing of the library's workbook is left in the scratch once its tab is closed", await until('the copies go', 15_000, () => left().length === 0), left().join(', '))
} catch (err) {
  check('the run finished', false, String((err as Error).stack ?? err))
} finally {
  await cleanup()
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
