import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO, Run, sleep } from './e2e-work-lib'

/**
 * A Work workspace comes back where he left it (docs/agents/work-return.md), live: one isolated windowed instance of the
 * built tree under xvfb, two made-up jobs with made-up threads and dummy folders, no LifeOS sign-in and no row of his.
 * In job A he opens an older thread, then Files with two tabs (the second in a folder) and the first shown; in job B,
 * Tasks. Leave A for B and back; reload the window; quit and launch again on the same data. Each time A shows Files,
 * its tabs, the tab and the folder, and closing Files shows the thread he was on, not the newest one.
 *
 * Run from the repo root after `electron-vite build`:
 *   env -u ELECTRON_RUN_AS_NODE bun scripts/e2e-work-return.ts [--out <dir>]
 */
if (!process.argv.includes('--out')) process.argv.push('--out', join(REPO, '.temp-code/plans/landed/F-workspace-return'))
const run = new Run('return')

/** What the window shows: the Work view's region by its name, and every selected tab (the thread strip's and Files'). */
const SHOWN = `(() => ({
  view: document.querySelector('[role=region][data-file-opens]')?.getAttribute('aria-label') ?? null,
  tabs: [...document.querySelectorAll('[role=tab][aria-selected=true]')].map((t) => t.textContent.trim()),
}))()`
type Shown = { view: string | null; tabs: string[] }

/** A real press on the visible control whose own text is `text`; `rail` keeps to the rail and the column (left of 560px). */
async function press(text: string, where: 'rail' | 'any' = 'any'): Promise<boolean> {
  const at = await run.page<{ x: number; y: number } | null>(`(() => {
    const els = [...document.querySelectorAll('button, a, [role=button], [role=link], [role=treeitem], [role=option], [role=tab]')]
      .filter((e) => e.offsetParent && e.textContent.trim() === ${JSON.stringify(text)} && (${where === 'rail'} ? e.getBoundingClientRect().left < 560 : true));
    const el = els[0]; if (!el) return null; el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  if (!at) return false
  await run.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y })
  for (const type of ['mousePressed', 'mouseReleased']) await run.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 })
  await sleep(1200)
  return true
}

async function expectA(label: string, older: string): Promise<void> {
  const ok = await run.until(`${label}: A on Files`, 30_000, async () => {
    const s = await run.page<Shown>(SHOWN)
    return s.view === 'Files' && s.tabs.some((t) => t.includes('Contracts'))
  })
  const s = await run.page<Shown>(SHOWN)
  run.check(`${label}: job A shows Files, its Contracts tab in the Contracts folder`, ok, JSON.stringify(s))
  await run.shot(`${label}-files`)
  // Files closed (its row again), the thread under it is the one he was on.
  await press('Files', 'rail')
  const back = await run.until(`${label}: the thread`, 20_000, async () => (await run.page<Shown>(SHOWN)).tabs.some((t) => t.includes(older)))
  run.check(`${label}: under Files, the thread he was on ("${older}"), not the newest`, back, JSON.stringify(await run.page<Shown>(SHOWN)))
  await press('Files', 'rail')
  await run.until(`${label}: Files again`, 20_000, async () => (await run.page<Shown>(SHOWN)).view === 'Files')
}

async function main(): Promise<void> {
  await run.start({})
  const a = await run.call<{ id: string; path: string }>('workspace.create', { kind: 'work', sector: 'purdue', name: 'Job A' })
  run.later('delete Job A', () => run.call('workspace.delete', { workspaceId: a.id }))
  const b = await run.call<{ id: string; path: string }>('workspace.create', { kind: 'work', sector: 'ref', name: 'Job B' })
  run.later('delete Job B', () => run.call('workspace.delete', { workspaceId: b.id }))
  // Dummy files only.
  mkdirSync(join(a.path, 'Contracts'), { recursive: true })
  writeFileSync(join(a.path, 'Contracts', 'Venue draft.md'), '# Venue draft\n\nA dummy file for the proof.\n')
  const older = 'Plan the spring LAN'
  const olderId = await run.thread(a.id, older)
  await sleep(1500)
  await run.thread(a.id, 'Order the jerseys')
  await run.thread(b.id, 'Ref schedule')

  // In A: the older thread, then Files with a second tab in the Contracts folder, shown.
  await press('Job A', 'rail')
  await run.show(olderId)
  run.check('job A opens on the older thread', (await run.page<Shown>(SHOWN)).tabs.some((t) => t.includes(older)), JSON.stringify(await run.page<Shown>(SHOWN)))
  await press('Files', 'rail')
  await run.until('Files opens', 30_000, async () => (await run.page<Shown>(SHOWN)).view === 'Files')
  const page = { at: { at: 'file', host: run.host, path: join(a.path, 'Contracts') }, name: 'Contracts' }
  await run.call('work.files.tabOpen', { workspaceId: a.id, page })
  await sleep(1500)
  await press('Contracts')
  await run.until('the Contracts tab shows', 20_000, async () => (await run.page<Shown>(SHOWN)).tabs.some((t) => t.includes('Contracts')))
  await run.shot('0-left-files')

  // In B: Tasks (no LifeOS here, so its frame asks for the sign-in under the Tasks header).
  await press('Job B', 'rail')
  await press('Tasks', 'rail')
  const bTasks = await run.until('B on Tasks', 20_000, async () => (await run.page<Shown>(SHOWN)).view === 'Tasks')
  run.check('job B shows Tasks', bTasks, JSON.stringify(await run.page<Shown>(SHOWN)))
  await run.shot('0-left-b-tasks')

  // (a) leave and come back.
  await press('Job A', 'rail')
  await expectA('1-switch', older)
  await press('Job B', 'rail')
  run.check('1-switch: job B comes back on Tasks', await run.until('B on Tasks', 20_000, async () => (await run.page<Shown>(SHOWN)).view === 'Tasks'))
  await press('Job A', 'rail')
  await run.until('A again', 20_000, async () => (await run.page<Shown>(SHOWN)).view === 'Files')

  // (b) reload the window.
  await run.send('Page.reload', {})
  await sleep(8000)
  await expectA('2-reload', older)

  // (c) quit and launch again on the same data.
  await sleep(2000)
  await run.page('(window.api.app.confirmQuit(), true)').catch(() => undefined)
  await sleep(8000)
  run.check('the first instance quit', !(await fetch(`http://127.0.0.1:${run.port}/json/version`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false)))
  // The same data folder; the harness links its tools folder again at each start (links only: the tools stay).
  const tools = join(run.data, 'work-tools')
  for (const name of existsSync(tools) ? readdirSync(tools) : []) {
    const at = join(tools, name)
    if (lstatSync(at).isSymbolicLink() || lstatSync(at).isFile()) unlinkSync(at)
    else rmSync(at, { recursive: true, force: true }) // the run's own jobs, run and downloads folders, never a link
  }
  await run.start({})
  await expectA('3-relaunch', older)
}

main().then(
  () => run.finish(),
  (err: unknown) => run.finish(err)
)
