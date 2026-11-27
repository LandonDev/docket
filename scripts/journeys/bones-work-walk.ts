// The loading bones of Work's views in the built window (docs/agents/loading-bones.md "Proving a conversion"): a pair
// of isolated instances with Work on, reading a LifeOS sandbox through a hop that holds every request (`--delay`), so
// each view's reads take long enough to see. Each view is opened cold (the window reloaded on it) and filmed frame by
// frame until its content has landed, in dark and in light, and checked on the way: bones showed, their sweep ran,
// and none was left once the reads had answered.
//
//   bun scripts/journeys/bones-work-walk.ts [--out <dir>] [--theme dark|light|both] [--delay 400] [--views Mail,Agenda]
//
// Build first (electron-vite build). Nothing here touches the installed app or its data.
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { requireBuild } from './run'
import { startSandbox } from './lib/lifeos'
import { FIRST_MAIL, SECTOR } from './lib/lifeosSeed'
import { mainCheckout } from './lib/record'
import { Pair, type Workspace } from './lib/shape'
import type { Window } from './lib/window'

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { out: { type: 'string' }, theme: { type: 'string', default: 'both' }, delay: { type: 'string', default: '400' }, views: { type: 'string', default: 'Mail,Agenda,Messages,Routines' } }
})
const THEMES = values.theme === 'both' ? (['dark', 'light'] as const) : ([values.theme as 'dark' | 'light'] as const)
const DELAY = Number(values.delay)
const VIEWS = values.views!.split(',').map((view) => view.trim()).filter(Boolean)
const js = JSON.stringify

const repo = resolve(import.meta.dir, '../..')
const out = resolve(values.out ?? join(repo, '.temp-code', 'findings', 'skullet', 'work'))
mkdirSync(out, { recursive: true })
const logPath = join(out, 'walk.log')
writeFileSync(logPath, '')
const log = (line: string): void => {
  appendFileSync(logPath, line + '\n')
  console.log(line)
}
let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed++
}

/** What the window shows of bones right now (bones-walk.ts's count), and any bar of work-kit's drawn as itself (one a drawing holds is unseen). */
const BONES_NOW = `(() => {
  const seen = (selector) => [...document.querySelectorAll(selector)].filter((el) => el.checkVisibility());
  const bars = seen('[skullet-layer]').flatMap((layer) => [...(layer.shadowRoot?.children ?? [])]);
  return {
    held: seen('[data-region][data-bones="held"]').length,
    shown: seen('[data-region][data-bones="shown"]').length,
    leaving: seen('[data-bones="leaving"], [skullet-exiting], [data-bones="copy"]').length,
    bars: bars.length,
    sweeping: bars.filter((bar) => bar.getAnimations().some((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations === Infinity)).length,
    kit: seen('[data-slot="skeleton"], .animate-pulse').filter((el) => !el.closest('[skullet-loading]')).length,
  };
})()`
type Bones = { held: number; shown: number; leaving: number; bars: number; sweeping: number; kit: number }
type Frame = { at: number; bones: Bones; landed: boolean }

/** Words of the view's own outside any drawing: what says a view has landed. */
const shows = (selector: string, words?: string) =>
  `[...document.querySelectorAll(${js(selector)})].some((el) => el.getClientRects().length && !el.closest('[skullet-loading]')${words ? ` && el.innerText.includes(${js(words)})` : ''})`
/** No region of the window waits, and work-kit draws none of its own bars. */
const NOTHING_WAITS = `!document.querySelector('[data-region][data-bones="held"], [data-region][data-bones="shown"], [data-bones="leaving"], [data-slot="skeleton"]')`

const LANDED: Record<string, string> = {
  Mail: `${shows('[data-mail-list]', FIRST_MAIL)} && ${NOTHING_WAITS}`,
  Agenda: `(${shows('[role="listitem"]')} || ${shows('[data-week]')} || ${shows('[data-slot="empty"]')}) && ${NOTHING_WAITS}`,
  Messages: `(${shows('[role="option"]')} || ${shows('[data-slot="empty"]')}) && ${NOTHING_WAITS}`,
  Routines: `(${shows('[data-routine-row]')} || ${shows('[data-slot="empty"]')}) && ${NOTHING_WAITS}`,
}
/** A view with no landing of its own: its heading drawn, with nothing waiting. */
const landedOf = (view: string): string => LANDED[view] ?? `${shows('[data-view-heading]', view)} && ${NOTHING_WAITS}`

async function film(page: Window, name: string, landed: () => Promise<boolean>, { settle = 900, most = 20_000 } = {}): Promise<Frame[]> {
  const start = Date.now()
  const frames: Frame[] = []
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

function judge(name: string, frames: Frame[]): void {
  const waiting = frames.filter((frame) => !frame.landed)
  const most = waiting.reduce((best, frame) => (frame.bones.bars > best.bones.bars ? frame : best), waiting[0] ?? frames[0]!)
  check(`${name}: bones showed while the reads were out`, waiting.some((frame) => frame.bones.shown > 0 && frame.bones.bars > 0), `${most.bones.bars} bars at ${most.at} ms`)
  check(`${name}: every bone was in the sweep`, waiting.some((frame) => frame.bones.bars > 0 && frame.bones.sweeping === frame.bones.bars), `${most.bones.sweeping} of ${most.bones.bars}`)
  const last = frames.at(-1)!
  check(`${name}: the content landed`, last.landed, `after ${frames.find((frame) => frame.landed)?.at ?? -1} ms`)
  check(`${name}: no bone outlived it`, last.bones.shown === 0 && last.bones.leaving === 0 && last.bones.bars === 0, js(last.bones))
  // From the first bones to the landing, every frame shows bones: one wait hands to the next with nothing bare between.
  const first = waiting.findIndex((frame) => frame.bones.bars > 0)
  const bare = first < 0 ? [] : waiting.slice(first).filter((frame) => frame.bones.bars === 0 && frame.bones.leaving === 0)
  check(`${name}: bones in every waiting frame`, first >= 0 && bare.length === 0, bare.length ? `bare at ${bare.map((frame) => frame.at).join(', ')} ms` : '')
  // work-kit's screens wait through Docket's bones (work/kitWaits.tsx): a bar of its own on screen is a wait that missed the seam.
  const kit = frames.filter((frame) => frame.bones.kit > 0)
  check(`${name}: no bar of work-kit's own`, kit.length === 0, kit.length ? `in ${kit.length} of ${frames.length} frames, from ${kit[0]!.at} ms` : '')
}

async function main(): Promise<void> {
  requireBuild(repo)
  const base = join(mainCheckout(repo), '.temp-code')
  mkdirSync(join(base, 'journeys'), { recursive: true })
  // The LifeOS sandbox takes only a walk folder two levels under the journeys' runs.
  const root = realpathSync(mkdtempSync(join(base, 'journeys', new Date().toISOString().slice(0, 10) + '-bones-work')))
  const folder = join(root, 'pair')
  mkdirSync(folder)
  const pair = new Pair(repo, folder)
  try {
    pair.sandbox = await startSandbox(folder, pair.abort.signal, false, { delayMs: DELAY })
    for (const url of [pair.sandbox.url, pair.sandbox.siteUrl, pair.sandbox.mcpUrl]) pair.trackPort(Number(new URL(url).port))
    const workspace: Workspace = await pair.open(false, `Bones ${root.slice(-6)}`, { fake: true, sector: SECTOR })
    const page = pair.page
    log(`window and host open; LifeOS answers ${DELAY} ms late each way`)
    await pair.checkSeededMail(workspace)
    for (const theme of THEMES) {
      await page.eval(`localStorage.setItem('docket.colorScheme', ${js(theme)})`)
      for (const [i, view] of VIEWS.entries()) {
        // Opened, then the window reloaded on it: the chunk, the session and every read come cold.
        await pair.showWork(workspace, view)
        await page.reload()
        await page.resize(1280, 800)
        judge(`${theme} ${view}`, await film(page, `${theme}-${i + 1}-${view.toLowerCase()}`, () => page.eval<boolean>(landedOf(view))))
      }
    }
  } finally {
    const stopped = await pair.stop()
    if (stopped.errors.length || stopped.remainingPids.length) log(`cleanup: ${js(stopped)}`)
  }
}

await main().catch((error: unknown) => {
  log(`FAIL  the walk: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  failed++
})
log(failed ? `${failed} checks failed` : 'every check passed')
process.exit(failed ? 1 : 0)
