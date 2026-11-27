// The loading bones in the built window (docs/agents/loading-bones.md "Proving a conversion"): a window paired to a
// slow host (TEMP_CODE_PEER_DELAY_MS: every request the window makes of it waits), so every read takes long enough to see. Each scene is filmed frame by frame from the
// press that starts its wait until its content has landed, in dark and in light, and checked on the way: bones
// showed, their sweep ran, and none was left once the read had answered. Then the same bundle at /ui in the box's
// Chromium at a phone's size, and once more in a tab that is hidden while its read lands.
//
//   bun scripts/journeys/bones-walk.ts [--out <dir>] [--theme dark|light|both] [--delay 400] [--no-ui]
//
// Build first (electron-vite build). Nothing here touches the installed app or its data.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { findChromium } from '../../src/main/server/work/browser/box/chromium'
import type { EventRow } from '../../src/shared/events'
import { freePort } from '../lib/devInstance'
import { startWalkProvider } from './lib/docketWalkProvider'
import { instancePids, Pair, words } from './lib/shape'
import { Window } from './lib/window'

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { out: { type: 'string' }, theme: { type: 'string', default: 'both' }, delay: { type: 'string', default: '400' }, 'no-ui': { type: 'boolean', default: false } }
})
const THEMES = values.theme === 'both' ? (['dark', 'light'] as const) : ([values.theme as 'dark' | 'light'] as const)
const DELAY = Number(values.delay)
const PROOF = 'Bones proof'
/** `BONES.leaveCapMs` (src/renderer/src/lib/ease.ts): the longest a leaving pane is kept where no frame comes. */
const BONES_LEAVE_CAP_MS = 1500
/** `BONES.sweepCapMs`: how long bones sweep before they go still. */
const BONES_SWEEP_CAP_MS = 20_000
const PANEL = 'aside[aria-label="Thread panel"]'
const TRANSCRIPT = '.agent-transcript'

const repo = resolve(import.meta.dir, '../..')
const out = resolve(values.out ?? join(repo, '.temp-code', 'findings', 'skullet', 'walk'))
mkdirSync(out, { recursive: true })
const logPath = join(out, 'walk.log')
writeFileSync(logPath, '')
const log = (line: string): void => {
  appendFileSync(logPath, line + '\n')
  console.log(line)
}
if (!existsSync(join(repo, 'out', 'renderer', 'index.html'))) throw new Error('Build the desktop app before starting the walk')

const runs = join(repo, '.temp-code', 'journeys')
mkdirSync(runs, { recursive: true })
const root = mkdtempSync(join(runs, 'bones-walk-'))
const pair = new Pair(repo, root)
const js = JSON.stringify
let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed++
}

/** What the window shows of bones right now: regions waiting and shown, bars drawn, bars in the sweep, panes and copies on
 *  their way out. Only what is drawn counts: a tab parked behind the one on screen may hold a skeleton of its own. */
const BONES_NOW = `(() => {
  const seen = (selector) => [...document.querySelectorAll(selector)].filter((el) => el.checkVisibility());
  const bars = seen('[skullet-layer]').flatMap((layer) => [...(layer.shadowRoot?.children ?? [])]);
  return {
    held: seen('[data-region][data-bones="held"]').length,
    shown: seen('[data-region][data-bones="shown"]').length,
    leaving: seen('[data-bones="leaving"], [skullet-exiting], [data-bones="copy"]').length,
    bars: bars.length,
    sweeping: bars.filter((bar) => bar.getAnimations().some((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations === Infinity)).length,
    hidden: document.hidden,
  };
})()`
type Bones = { held: number; shown: number; leaving: number; bars: number; sweeping: number; hidden: boolean }

/** Films `page` from now until `landed` has been true for `settle` ms, reading the bones beside each frame. */
async function film(page: Window, name: string, landed: () => Promise<boolean>, { settle = 900, most = 12_000 } = {}): Promise<{ at: number; bones: Bones; landed: boolean }[]> {
  const start = Date.now()
  const frames: { at: number; bones: Bones; landed: boolean }[] = []
  let landedAt = 0
  while (Date.now() - start < most) {
    const at = Date.now() - start
    const [bones, done] = await Promise.all([page.eval<Bones>(BONES_NOW), landed().catch(() => false)])
    await page.shot(join(out, `${name}-${String(at).padStart(5, '0')}.png`))
    frames.push({ at, bones, landed: done })
    if (done && !landedAt) landedAt = Date.now()
    if (landedAt && Date.now() - landedAt > settle) break
  }
  return frames
}

/** The checks every filmed wait must pass. `mayBeQuick`: a page whose read may answer inside the hold, and then rightly
 *  shows no bones. `others`: the screen holds other regions with reads of their own, so bones may still stand once this one has landed. */
function judge(name: string, frames: { at: number; bones: Bones; landed: boolean }[], { mayBeQuick = false, others = false } = {}): void {
  // With other regions on the screen, bones are looked for in every frame: theirs stand after this one has landed.
  const waiting = others ? frames : frames.filter((frame) => !frame.landed)
  const most = waiting.reduce((best, frame) => (frame.bones.bars > best.bones.bars ? frame : best), waiting[0] ?? frames[0])
  const showed = waiting.some((frame) => frame.bones.shown > 0 && frame.bones.bars > 0)
  if (showed || !mayBeQuick) {
    check(`${name}: bones showed while the read was out`, showed, `${most?.bones.bars ?? 0} bars at ${most?.at ?? 0} ms`)
    check(`${name}: every bone was in the sweep`, waiting.some((frame) => frame.bones.bars > 0 && frame.bones.sweeping === frame.bones.bars), `${most?.bones.sweeping ?? 0} of ${most?.bones.bars ?? 0}`)
  } else log(`      ${name}: its read answered inside the hold, so no bones showed`)
  const last = frames.at(-1)!
  check(`${name}: the content landed`, last.landed, `after ${frames.find((frame) => frame.landed)?.at ?? -1} ms`)
  if (others) check(`${name}: no bones were left on their way out`, last.bones.leaving === 0, js(last.bones))
  else check(`${name}: no bone outlived it`, last.bones.shown === 0 && last.bones.leaving === 0 && last.bones.bars === 0, js(last.bones))
}

function practiceRepo(path: string): void {
  mkdirSync(join(path, 'src'), { recursive: true })
  writeFileSync(join(path, 'README.md'), '# Practice gateway\n\nA small test site.\n')
  writeFileSync(join(path, 'src', 'gateway.ts'), 'export function listen(port: number) {\n  return port\n}\n')
  const git = (...args: string[]) => execFileSync('git', ['-C', path, '-c', 'user.name=Walk', '-c', 'user.email=walk@example.test', ...args], {
    stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  })
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git('commit', '-qm', 'Start the practice site')
  writeFileSync(join(path, 'src', 'gateway.ts'), 'export async function listen(port: number) {\n  await ready(port)\n  return port\n}\n')
  writeFileSync(join(path, 'src', 'ready.ts'), 'export const ready = async (_port: number): Promise<void> => {}\n')
  writeFileSync(join(path, 'src', 'ports.ts'), 'export const PORTS = [7670, 7671, 7672]\n')
  writeFileSync(join(path, 'NOTES.md'), 'Ask about the tunnel.\n')
}

async function main(): Promise<void> {
  await pair.open(false, PROOF, { fake: true, provider: startWalkProvider, withoutTools: true, link: { delayMs: 0, rateMbit: 0 }, peerDelayMs: DELAY })
  const { box, win } = pair
  const page = pair.page
  log(`window and host open; the host answers the window ${DELAY} ms late`)
  const linkOpen = () => page.eval<boolean>(`window.__docket?.registry.has(${js(box.host)}) && window.__docket.registry.statusOf(${js(box.host)}).transport === 'open'`)
  const rows = (selector: string) => page.eval<boolean>(`[...document.querySelectorAll(${js(selector)})].some(el => el.getClientRects().length && !el.closest('[skullet-loading]'))`)
  await page.until('the window to reach the host', 90_000, linkOpen)

  /** A workspace with uncommitted changes and a thread with one turn, made on the host: nothing of it is in the window's hands yet. */
  const fresh = async (name: string) => {
    const path = join(box.work, 'practice-' + name)
    practiceRepo(path)
    const workspace = await pair.rpc<{ id: string; path: string }>(box, 'workspace.create', { path, name: `${PROOF} ${name}` })
    const thread = await pair.rpc<{ id: string }>(box, 'session.create', {
      workspaceId: workspace.id, provider: 'claude', permission: 'auto', threadType: 'chat', title: `${PROOF} ${name}`, firstMessage: 'Count the cones for practice.'
    })
    await page.until('the host to finish the turn', 90_000, async () =>
      (await pair.rpc<EventRow[]>(box, 'session.events', { sessionId: thread.id })).some(({ event }) => event.type === 'turn-complete'))
    return thread
  }
  const phoneThreads = values['no-ui'] ? [] : [await fresh('first'), await fresh('phone'), await fresh('hidden')]

  for (const theme of THEMES) {
    const thread = await fresh(theme)
    // The thread's panel opens on Changes with it, so one film holds the shell's wait and a list's.
    await page.eval(`(() => {
      localStorage.setItem('docket.colorScheme', ${js(theme)})
      const panels = JSON.parse(localStorage.getItem('docket.rightPanel') ?? '{"width":320,"threads":{}}')
      panels.threads[${js(thread.id)}] = { open: true, section: 'changes' }
      localStorage.setItem('docket.rightPanel', JSON.stringify(panels))
    })()`)
    await page.reload()
    await page.until('the reloaded window and its link', 90_000, () => linkOpen().catch(() => false))
    await page.resize(1280, 800)

    // The shell and a list at once. The thread stands as its transcript's bones (SurfaceSkeleton, a `Bones`), which
    // give way whole to the transcript when its tail lands. Beside it the Changes section: its head is a `Region`
    // (the branch's name, then the head itself) and its rows are the real file rows drawn from a sample until the
    // index lands.
    void page.eval(`void window.__docket.open(${js(thread.id)})`)
    judge(`${theme} thread and changes`, await film(page, `${theme}-1-thread`, async () =>
      (await rows(TRANSCRIPT + ' [data-row]')) && (await rows(`${PANEL} [data-slot="changes-section"] [data-row-open]`)), { most: 20_000 }))

    // Settings: New threads has two sections, each with a read of its own, each in bones (PageRowsSkeleton) until
    // its host answers. The first lands while the second still waits: nothing waits for the slowest read.
    await page.press('button', 'Settings')
    await page.clickOn('[aria-label="Settings"] button > span.truncate, [aria-label="Settings"] a', 'New threads')
    const opened = Date.now()
    judge(`${theme} settings`, await film(page, `${theme}-2-settings`, () => rows('[data-slot="page"] [data-slot="page-row"]'), { most: 20_000 }), { others: true, mayBeQuick: true })
    // The second section's read is asked of the host through this computer, and in this pair it stays out: bones that
    // have stood 20 s go still, so a window left on a host that does not answer costs no frames.
    if ((await page.eval<Bones>(BONES_NOW)).shown > 0) {
      await delay(Math.max(0, opened + BONES_SWEEP_CAP_MS + 1500 - Date.now()))
      const after = await page.eval<Bones>(BONES_NOW)
      await page.shot(join(out, `${theme}-3-settings-still.png`))
      check(`${theme} settings: bones that stood 20 s are still`, after.shown === 0 || (after.bars > 0 && after.sweeping === 0), js(after))
    }

    // Settings' page for the box, which asks the box through this computer: its lines and Update… wait as their own
    // words and button (surfaces/settings/computers/ComputerPage.tsx).
    await regions(page, `${theme}-settings-box`, () => page.clickOn('[aria-label="Settings"] button > span.truncate, [aria-label="Settings"] a', 'box'))

    // The rail's pages, each with reads of its own (surfaces/ and aliax/): Stats' sections, the Inbox's list, Accounts'
    // rows and their usage. Landed once a region has shown itself and none is left waiting.
    await page.key('Escape')
    for (const row of ['Stats', 'Inbox', 'Accounts'] as const) await regions(page, `${theme}-${row.toLowerCase()}`, () => page.press('button', row))
  }

  if (values['no-ui']) return
  await phone(phoneThreads.map((thread) => thread.id))
  void win
}

/** Films a screen with regions of its own from `start` until a region has shown itself and none is left waiting. */
async function regions(page: Window, name: string, start: () => Promise<void>): Promise<void> {
  await page.eval(`window.__bonesSeen = false; window.__bonesSpy?.disconnect(); window.__bonesSpy = new MutationObserver(() => { if (document.querySelector('[data-region][data-bones]')) window.__bonesSeen = true }); window.__bonesSpy.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-bones'] })`)
  void start()
  judge(name, await film(page, name, () => page.eval<boolean>(`window.__bonesSeen && ![...document.querySelectorAll('[data-region][data-bones="held"], [data-region][data-bones="shown"]')].some((el) => el.checkVisibility())`), { most: 20_000 }), { mayBeQuick: true })
}

/** The same bundle at /ui, in the box's own Chromium at a phone's size: bones, sweep and landing; then a tab hidden while its read lands. */
async function phone([firstId, threadId, hiddenId]: string[]): Promise<void> {
  const chromium = findChromium()
  if (!chromium) {
    check('/ui: a Chromium to open it in', false, 'none found (bunx playwright install chromium)')
    return
  }
  const port = await freePort()
  const profile = mkdtempSync('/tmp/tc-bones-ui-')
  const browser: ChildProcess = spawn(chromium, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--window-size=390,844', 'about:blank'], { stdio: 'ignore' })
  try {
    const page = await Window.attach(port, pair.abort.signal, () => true, 390, 844)
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
    await page.send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' })
    const base = `http://127.0.0.1:${pair.box.remote}`
    const pairing = await pair.rpc<{ code: string }>(pair.box, 'remote.pairings.create', { name: PROOF + ' phone', audience: 'client', caps: ['operate'] })
    await page.navigate(`${base}/pair#${pairing.code}`)
    await page.until('the pair page', 30_000, () => page.eval(`document.getElementById('code')?.textContent === ${js(pairing.code)}`).catch(() => false))
    await page.eval(`document.getElementById('go').click()`)
    await page.until('landing on /ui/', 30_000, () => page.eval(`location.pathname === '/ui/'`).catch(() => false))
    await page.until('the phone’s socket', 60_000, () => page.eval(`!!window.__docket?.registry?.primary()?.connected`).catch(() => false))
    check('/ui: the bundle opens in a phone-sized browser with the engine in hand', await page.eval<boolean>(`performance.getEntriesByType('resource').some((entry) => /bonesEngine/.test(entry.name))`))
    const rows = (selector: string) => page.eval<boolean>(`[...document.querySelectorAll(${js(selector)})].some(el => el.getClientRects().length && !el.closest('[skullet-loading]'))`)
    // The phone's own list of threads first: a thread it has not heard of opens as a draft.
    const known = (id: string) => page.until('the phone to know the thread', 60_000, () => page.eval(`!!window.__docket.sessionStore.metaOf(${js(id)})`))
    for (const id of [firstId, threadId, hiddenId]) await known(id)
    // The first thread a cold page opens waits on the pane's own chunk, and its rows may be in hand by then: opened
    // and let land, so the filmed one waits on its read alone.
    await page.eval(`void window.__docket.open(${js(firstId)})`)
    await page.until('the first thread on the phone', 60_000, () => rows(TRANSCRIPT + ' [data-row]'))
    await delay(1000)
    void page.eval(`void window.__docket.open(${js(threadId)})`)
    // The first thread's rows give way to the second's: landed once the pane has been through its wait.
    await page.eval(`window.__bonesWaited = false; new MutationObserver(() => { if (document.querySelector('[data-transcript-loading]')) window.__bonesWaited = true }).observe(document.body, { childList: true, subtree: true })`)
    void page.eval(`void window.__docket.open(${js(threadId)})`)
    judge('/ui thread', await film(page, 'ui-1-thread', () => page.eval<boolean>(`window.__bonesWaited && [...document.querySelectorAll(${js(TRANSCRIPT + ' [data-row]')})].some((el) => el.checkVisibility() && !el.closest('[skullet-loading]'))`), { most: 20_000 }), { mayBeQuick: true })

    // Settings on the phone: the same page, its second section in bones.
    await page.press('button', 'Settings')
    await page.clickOn('[aria-label="Settings"] button > span.truncate, [aria-label="Settings"] a', 'New threads')
    judge('/ui settings', await film(page, 'ui-2-settings', () => rows('[data-slot="page"] [data-slot="page-row"]'), { most: 20_000 }), { others: true })
    await page.key('Escape')

    // A hidden tab draws no frames: its read must still land, with nothing of the bones left waiting on one.
    const { targetId } = await page.send('Target.createTarget', { url: 'about:blank' }) as { targetId: string }
    await page.send('Target.activateTarget', { targetId })
    await page.until('the first tab to be hidden', 10_000, () => page.eval('document.hidden'))
    await page.eval(`void window.__docket.open(${js(hiddenId)})`)
    await page.until('the hidden tab’s transcript', 30_000, () => page.eval(`[...document.querySelectorAll(${js(TRANSCRIPT + ' [data-row]')})].some((el) => !el.closest('[skullet-loading]'))`))
    await delay(BONES_LEAVE_CAP_MS + 1000)
    const after = await page.eval<Bones>(BONES_NOW)
    check('hidden tab: the read landed and nothing of the bones waits on a frame', after.hidden && after.shown === 0 && after.leaving === 0 && after.bars === 0, js(after))
  } finally {
    browser.kill('SIGTERM')
    await delay(3000)
    rmSync(profile, { recursive: true, force: true })
  }
}

try {
  log('run ' + root)
  log('pictures ' + out)
  await main()
} catch (error) {
  log('WALK FAILED ' + words(error))
  if (!pair.abort.signal.aborted) {
    try { await pair.page.shot(join(out, 'walk-FAILED.png')) } catch { /* the window did not open */ }
  }
  process.exitCode ||= 1
} finally {
  try {
    const stopped = await pair.stop()
    log('stopped ' + JSON.stringify(stopped))
  } catch (error) {
    log('CLEANUP FAILED ' + words(error))
    process.exitCode ||= 1
  } finally {
    rmSync(root, { recursive: true, force: true })
    log('leftovers ' + JSON.stringify({ pids: instancePids(root), runFolder: existsSync(root) }))
    log(`Checks failed: ${failed}`)
    if (failed) process.exitCode ||= 1
  }
}
