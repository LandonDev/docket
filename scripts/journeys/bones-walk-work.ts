// Work's loading bones in the built window (docs/agents/loading-bones.md "Proving a conversion"), as bones-walk.ts films
// the shell's: a window paired to a slow host with Work on and one Work workspace, each read 400 ms late. Each scene is
// filmed frame by frame from the press that starts its wait until its content has landed, in dark and in light: Today,
// a workbook, a PDF and a Word document opened from the Files place.
//
//   bun scripts/journeys/bones-walk-work.ts [--out <dir>] [--theme dark|light|both] [--delay 400]
//
// Build first (electron-vite build). Nothing here touches the installed app or its data.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { film as filmWait, judge as judgeWait, type Frame } from './lib/bonesFilm'
import { startWalkProvider } from './lib/docketWalkProvider'
import { openRow } from './lib/files'
import { showPlace } from './lib/place'
import { instancePids, Pair, words } from './lib/shape'
import type { Window } from './lib/window'

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { out: { type: 'string' }, theme: { type: 'string', default: 'both' }, delay: { type: 'string', default: '400' } }
})
const THEMES = values.theme === 'both' ? (['dark', 'light'] as const) : ([values.theme as 'dark' | 'light'] as const)
const DELAY = Number(values.delay)
const PROOF = 'Bones proof'

const repo = resolve(import.meta.dir, '../..')
const out = resolve(values.out ?? join(repo, '.temp-code', 'findings', 'skullet', 'work'))
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
const root = mkdtempSync(join(runs, 'bones-walk-work-'))
const pair = new Pair(repo, root)
const js = JSON.stringify
let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed++
}
const film = (page: Window, name: string, landed: () => Promise<boolean>, options?: { settle?: number; most?: number }) => filmWait(page, out, name, landed, options)
const judge = (name: string, frames: Frame[], options?: { mayBeQuick?: boolean; others?: boolean }) => judgeWait(check, log, name, frames, options)

/** The files the walk opens, in the workspace's own folder, one set a theme so neither is a file the window has read. */
const FILES = (theme: string) => ({ sheet: `Budget ${theme}.xlsx`, pdf: `W-9 ${theme}.pdf`, doc: `Notes ${theme}.docx` })

async function main(): Promise<void> {
  const workspace = await pair.open(false, PROOF, { fake: true, provider: startWalkProvider, withoutTools: true, sector: 'purdue', link: { delayMs: 0, rateMbit: 0 }, peerDelayMs: DELAY })
  const { box } = pair
  const page = pair.page
  const context = { pair, shape: 'A' as const, workspace, folder: out }
  log(`window and host open, Work on; the host answers the window ${DELAY} ms late`)
  for (const theme of THEMES) {
    const files = FILES(theme)
    copyFileSync(join(repo, 'src/main/server/work/sheets/harness/corpus/formulas.xlsx'), join(workspace.path, files.sheet))
    copyFileSync(join(repo, 'src/main/server/work/pdf/fixtures/fw9.pdf'), join(workspace.path, files.pdf))
    copyFileSync(join(repo, 'src/main/server/work/meetings/fixtures/teams.docx'), join(workspace.path, files.doc))
  }
  /** Something matching `selector` is drawn and is no bone. */
  const shown = (selector: string) => page.eval<boolean>(`[...document.querySelectorAll(${js(selector)})].some(el => el.getClientRects().length && !el.closest('[skullet-loading]'))`)
  const linkOpen = () => page.eval<boolean>(`window.__docket?.registry.has(${js(box.host)}) && window.__docket.registry.statusOf(${js(box.host)}).transport === 'open'`)

  for (const theme of THEMES) {
    const files = FILES(theme)
    await page.eval(`localStorage.setItem('docket.colorScheme', ${js(theme)})`)
    // A reload empties the window's memory: every read below is asked of the host again.
    await page.reload()
    await page.until('the reloaded window and its link', 90_000, () => linkOpen().catch(() => false))
    await page.resize(1280, 800)

    // Today: each section is a region of its own, drawn as its own rows from a sample until its source answers. The
    // held section reads the Outbox of the host, 400 ms late, and lands on its empty line; the sections LifeOS feeds
    // say once that LifeOS is not signed in.
    await page.clickOn('nav button', 'Today')
    judge(`${theme} Today`, await film(page, `${theme}-1-today`, async () =>
      (await shown('[data-today-section="held"]')) && !(await page.eval<boolean>(`!!document.querySelector('[data-today-section="held"] [data-region][aria-busy]')`))), { others: true })

    // A workbook: the sheet's own frame (the hairlines, the letters and row numbers) with its words in bones, then the grid.
    await showPlace(context)
    void openRow(page, files.sheet)
    judge(`${theme} workbook`, await film(page, `${theme}-2-sheet`, () => shown('[data-sheet-item]'), { most: 30_000 }), { others: true })

    // A PDF: a page of sample words on the page's card, then the page itself.
    void openRow(page, files.pdf)
    judge(`${theme} PDF`, await film(page, `${theme}-3-pdf`, () => shown('[data-pdf-page] canvas, [data-pdf-page] img'), { most: 30_000 }), { others: true })

    // A Word document: its title and paragraph in its own type, then the document.
    void openRow(page, files.doc)
    judge(`${theme} document`, await film(page, `${theme}-4-doc`, () => shown('[data-canvas-pane] .ProseMirror, [data-canvas-pane] [contenteditable]'), { most: 30_000 }), { others: true })
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
