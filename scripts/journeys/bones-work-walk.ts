// The loading bones of Work's views in the built window (docs/agents/loading-bones.md "Proving a conversion"): a pair
// of isolated instances with Work on, reading a LifeOS sandbox through a hop that holds every request (`--delay`), so
// each view's reads take long enough to see; the host answers the window as late (`TEMP_CODE_PEER_DELAY_MS`). Each view
// of the workspace and each place above the workspaces (Today, Projects, Review, the Outbox) is opened cold (the window
// reloaded on it), and each file kind is opened from the Files place for the first time; each is filmed frame by frame
// until its content has landed, in dark and in light, and checked on the way: bones showed, their sweep ran, and none
// was left once the reads had answered.
//
//   bun scripts/journeys/bones-work-walk.ts [--out <dir>] [--theme dark|light|both] [--delay 400] [--views Mail,Agenda]
//     [--places Today,Outbox] [--files sheet,pdf,deck]
//
// Besides a view's name, --views takes the scenes in SCENES: Projects board, Project.
//
// Build first (electron-vite build). Nothing here touches the installed app or its data.
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fixtures, openRow } from './lib/files'
import { requireBuild } from './run'
import { startSandbox } from './lib/lifeos'
import { FIRST_MAIL, SECTOR } from './lib/lifeosSeed'
import { mainCheckout } from './lib/record'
import { Pair, type Workspace } from './lib/shape'
import type { Window } from './lib/window'

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { out: { type: 'string' }, theme: { type: 'string', default: 'both' }, delay: { type: 'string', default: '400' }, views: { type: 'string', default: 'Mail,Agenda,Messages,Routines,Tasks,People,Money,Files,Projects,Projects board,Project' }, places: { type: 'string', default: 'Today,Projects,Review,Outbox' }, files: { type: 'string', default: 'sheet,pdf,deck' } }
})
const THEMES = values.theme === 'both' ? (['dark', 'light'] as const) : ([values.theme as 'dark' | 'light'] as const)
const DELAY = Number(values.delay)
const list = (words: string) => words.split(',').map((word) => word.trim()).filter(Boolean)
const VIEWS = list(values.views!)
const PLACES = list(values.places!)
const FILES = list(values.files!) as ('sheet' | 'pdf' | 'deck')[]
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
/** No region the window draws waits, and work-kit draws none of its own bars. Only what is drawn counts: a tab parked
 *  behind the one on screen may hold a wait of its own. */
const NOTHING_WAITS = `![...document.querySelectorAll('[data-region][data-bones="held"], [data-region][data-bones="shown"], [data-bones="leaving"], [data-slot="skeleton"]')].some((el) => el.checkVisibility())`

const LANDED: Record<string, string> = {
  Mail: `${shows('[data-mail-list]', FIRST_MAIL)} && ${NOTHING_WAITS}`,
  Agenda: `(${shows('[role="listitem"]')} || ${shows('[data-week]')} || ${shows('[data-slot="empty"]')}) && ${NOTHING_WAITS}`,
  Messages: `(${shows('[role="option"]')} || ${shows('[data-slot="empty"]')}) && ${NOTHING_WAITS}`,
  Routines: `(${shows('[data-routine-row]')} || ${shows('[data-slot="empty"]')}) && ${NOTHING_WAITS}`,
  Files: `${shows('[data-files-view]')} && ${NOTHING_WAITS}`,
}
/** A place above the workspaces, landed: its page drawn with nothing waiting. */
const placeLanded = (place: string): string =>
  place === 'Outbox'
    ? `(${shows('[data-outbox-empty]')} || ${shows('[data-outbox-detail]')} || ${shows('[role="listitem"]')}) && ${NOTHING_WAITS}`
    : // The Projects place lands on its rows: a link not open yet is a wait, never a landing on its line.
      place === 'Projects'
      ? `${shows('[data-work-place="projects"] [data-project]')} && ${NOTHING_WAITS}`
      : `${shows(`[data-work-place="${place.toLowerCase()}"]`)} && ${NOTHING_WAITS}`
/** A file opened in a Files tab, landed: its kind's own content drawn with nothing waiting. */
const FILE_LANDED: Record<'sheet' | 'pdf' | 'deck', string> = {
  sheet: `${shows('[data-sheet-item]')} && ${NOTHING_WAITS}`,
  pdf: `${shows('[data-pdf-pager]')} && ${NOTHING_WAITS}`,
  // A box without the conversion tools (a pair started without them) says it cannot open the deck: an error is content.
  deck: `(${shows('[data-slides-main]')} || ${shows('[data-canvas-failed]')}) && ${NOTHING_WAITS}`,
}
const PROJECTS_PLACE = 'work.projects.place.v1'
/** work-kit's Projects as a list and a board, and a project's page: each opened, then the window reloaded on it. */
type Scene = { open: (pair: Pair, workspace: Workspace) => Promise<void>; landed: string }
const placeAs = (pair: Pair, workspace: Workspace, place: object) =>
  pair.page.eval(`localStorage.setItem(${js(PROJECTS_PLACE)}, JSON.stringify({ ...JSON.parse(localStorage.getItem(${js(PROJECTS_PLACE)}) ?? '{}'), [${js(workspace.id)}]: ${js(place)} }))`)
/** The workspace's own Projects view: the column's Projects heading, pressed only when its view is not the one open. */
async function openProjects(pair: Pair, workspace: Workspace): Promise<void> {
  await pair.showWork(workspace, 'Mail')
  // From a project's page the heading goes back to the list, and from the list it closes the view: press until it stands.
  await pair.page.until('the Projects view', 30_000, async () => {
    if (await pair.page.eval<boolean>(`!!document.querySelector('[data-work-projects] > button[aria-current="true"]') && !!document.querySelector('.tc-projects')`)) return true
    await pair.page.clickOn('[data-work-projects] > button', 'Projects')
    await Bun.sleep(1500)
    return false
  })
}
const SCENES: Record<string, Scene> = {
  Projects: {
    open: async (pair, workspace) => {
      await placeAs(pair, workspace, { at: 'list', layout: 'list', tab: 'all' })
      await openProjects(pair, workspace)
    },
    landed: `${shows('.tc-projects [data-part="row"]')} && ${NOTHING_WAITS}`,
  },
  'Projects board': {
    open: async (pair, workspace) => {
      await placeAs(pair, workspace, { at: 'list', layout: 'board', tab: 'all' })
      await openProjects(pair, workspace)
    },
    landed: `${shows('.tc-projects [data-card]')} && ${NOTHING_WAITS}`,
  },
  Project: {
    open: async (pair, workspace) => {
      await placeAs(pair, workspace, { at: 'list', layout: 'list', tab: 'all' })
      await openProjects(pair, workspace)
      // The list as the place says (a board scene before it leaves the board standing until a reload).
      await pair.page.reload()
      await pair.page.until('the projects list', 30_000, () => pair.page.eval(`!!document.querySelector('.tc-projects [data-part="row"] button')`))
      await pair.page.clickOn('.tc-projects [data-part="row"] button', 'Spring LAN')
      await pair.page.until('the project page', 15_000, () => pair.page.eval(`!!document.querySelector('.tc-projects section[aria-label="Plan"]')`))
    },
    landed: `${shows('.tc-projects section[aria-label="Plan"]')} && ${NOTHING_WAITS}`,
  },
}

/** A view with no landing of its own: its heading drawn, with nothing waiting. */
const landedOf = (view: string): string => SCENES[view]?.landed ?? LANDED[view] ?? `${shows('[data-view-heading]', view)} && ${NOTHING_WAITS}`

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
    const workspace: Workspace = await pair.open(false, `Bones ${root.slice(-6)}`, { fake: true, sector: SECTOR, peerDelayMs: DELAY })
    const page = pair.page
    log(`window and host open; LifeOS answers ${DELAY} ms late each way, and the host answers the window ${DELAY} ms late`)
    await pair.checkSeededMail(workspace)
    for (const theme of THEMES) {
      await page.eval(`localStorage.setItem('docket.colorScheme', ${js(theme)})`)
      for (const [i, view] of VIEWS.entries()) {
        // Opened, then the window reloaded on it: the chunk, the session and every read come cold.
        await (SCENES[view] ? SCENES[view].open(pair, workspace) : pair.showWork(workspace, view))
        await page.reload()
        await page.resize(1280, 800)
        judge(`${theme} ${view}`, await film(page, `${theme}-${i + 1}-${view.toLowerCase().replaceAll(' ', '-')}`, () => page.eval<boolean>(landedOf(view))))
      }
      for (const [i, place] of PLACES.entries()) {
        // The window reloads on the workspace's own view (a Work workspace reopens where it was): the place is pressed
        // after the reload, and its chunk and every read come cold from that press.
        await page.reload()
        await page.resize(1280, 800)
        await page.until('the window back on the host', 60_000, () => page.eval(`!!document.querySelector('nav button')`))
        void page.clickOn('nav button', place)
        judge(`${theme} ${place}`, await film(page, `${theme}-p${i + 1}-${place.toLowerCase()}`, () => page.eval<boolean>(placeLanded(place))))
      }
      if (FILES.length) {
        // Each kind opened for the first time, from the workspace's folder: a file of its own a theme, so none is read already.
        const made = fixtures(repo, workspace.path, `Bones ${theme}`)
        await pair.showWork(workspace, 'Files')
        await page.reload()
        await page.resize(1280, 800)
        const folderShown = () => page.eval<boolean>(`document.querySelector('[data-files-bar] [aria-current]')?.textContent.trim() === ${js(workspace.name)}`)
        for (const [i, kind] of FILES.entries()) {
          // Back to the folder: its own tab where one stands (an opened file's tab hides it), else the sidebar's place.
          await page.until('the workspace folder', 30_000, async () => {
            if (await folderShown()) return true
            const tab = await page.centre('[data-files-tab][data-tab-kind="page"]', workspace.name)
            const place = tab ?? (await page.centre('[data-files-sidebar] button', workspace.name))
            if (place) await page.click(place)
            return false
          })
          void openRow(page, made[kind].split('/').at(-1)!)
          judge(`${theme} ${kind}`, await film(page, `${theme}-f${i + 1}-${kind}`, () => page.eval<boolean>(FILE_LANDED[kind]), { most: 30_000 }))
        }
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
