// A camera for the built desktop window. Each pose can fail without ending the walk.
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { CreateSessionInput } from '../../src/shared/contract'
import type { AgentEvent, EventRow } from '../../src/shared/events'
import { transcriptTurn } from './lib/docketWalkFixtures'
import { pictureName, SIZES, walkOptions, type Pass, type Size, type Theme } from './lib/docketWalkOptions'
import { APPROVAL, QUESTION, STREAM, STREAM_START, startWalkProvider } from './lib/docketWalkProvider'
import { sendPrompt } from './lib/lifeosJourney'
import { instancePids, KEY_CAPS, Pair, words } from './lib/shape'
import type { Window } from './lib/window'

const SCENES = [
  '01-start', '02-new-thread', '03-thread-empty', '04-thread-real-turn', '05-transcript-full',
  '06-approval', '07-question', '08-failure', '09-plan-thread', '10-right-panel',
  '11-terminal-dock', '12-message-list', '13-search', '14-go-to-file', '15-model-picker',
  '16-slash-menu', '17-at-menu', '18-rail-thread-menu', '19-rail-workspace-menu',
  '20-sidebar-hidden', '21-split-right', '22-inbox', '23-notes', '24-chats', '25-accounts',
  '26-stats', '27-search-page', '28-update-check', '29-link-cut', '30-link-cut-new-thread',
  '31-link-back', '32-master-board', '33-agents', '34-image-composer', '35-image-sent',
  '36-long-middle', '37-long-end', '38-link-cut-changes', '39-link-cut-draft',
  '40-desk-files', '41-desk-changes', '42-desk-go-to-file', '43-stream',
  '44-composer', '45-changes', '46-files', '47-thread-menu', '48-live-row'
] as const
type Scene = typeof SCENES[number]
const KEY_SCENES: readonly Scene[] = [
  '06-approval', '07-question', '18-rail-thread-menu', '19-rail-workspace-menu',
  '32-master-board', '44-composer', '45-changes', '46-files', '47-thread-menu'
]
const COMPOSER = '[data-composer] [contenteditable], [data-composer] textarea'
const PANEL = 'aside[aria-label="Thread panel"]'
const TRANSCRIPT = '.agent-transcript'
const PROOF = 'TempCode proof'
const PLAN = '# Move the gateway listener\n\n## Overview\nGive each test its own listener.\n\n## Approach\nWait for the listener before the first probe.\n\n## Tasks\n- [ ] Ask the operating system for a free port.\n- [ ] Close both listeners when the test ends.\n\n## Risks\nA restart could race the first probe.\n'
const NOOP = async (): Promise<void> => {}

const repo = resolve(import.meta.dir, '../..')
const options = walkOptions(process.argv.slice(2), SCENES)
const outputParent = '/tmp/docket-walk'
if (!options.out) mkdirSync(outputParent, { recursive: true })
const out = options.out ? resolve(options.out) : mkdtempSync(join(outputParent, 'run-'))
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
const root = mkdtempSync(join(runs, 'docket-walk-'))
const pair = new Pair(repo, root)
let camera: Window | undefined
const stopOn = (signal: NodeJS.Signals, exitCode: number) => (): void => {
  process.exitCode = exitCode
  pair.abort.abort(new Error(signal))
  try { (camera ?? pair.page).close() } catch { /* the window is still starting */ }
}
const interrupt = stopOn('SIGINT', 130)
const terminate = stopOn('SIGTERM', 143)
process.on('SIGINT', interrupt)
process.on('SIGTERM', terminate)

const pause = (ms: number) => delay(ms, undefined, { signal: pair.abort.signal })
const js = JSON.stringify
let shot = 0
let failed = 0

function wanted(pass: Pass, scene: Scene): boolean {
  return (pass === 'owner' || KEY_SCENES.includes(scene)) && (!options.only.size || options.only.has(scene))
}

async function photograph(page: Window, pass: Pass, theme: Theme, scene: Scene, pose: () => Promise<void>, atSize?: () => Promise<void>): Promise<void> {
  if (!wanted(pass, scene)) return
  pair.abort.signal.throwIfAborted()
  let size: Size = 'wide'
  try {
    await page.resize(1440, 900)
    await pose()
    for (const { width, height, name } of SIZES) {
      size = name
      await page.resize(width, height)
      await pause(270)
      await atSize?.()
      await page.shot(join(out, pictureName(pass, theme, scene, size)))
    }
    shot++
    log(`ok ${theme} ${scene} (${pass})`)
  } catch (error) {
    pair.abort.signal.throwIfAborted()
    failed++
    log(`FAIL ${theme} ${scene}: ${words(error)} (${pass})`)
    await page.shot(join(out, pictureName(pass, theme, scene, size, true))).catch(() => undefined)
  } finally {
    if (!pair.abort.signal.aborted) {
      await page.dismissPopups().catch(() => undefined)
      await page.resize(1440, 900).catch(() => undefined)
    }
  }
}

function practiceRepo(path: string, prefix: string): void {
  mkdirSync(join(path, 'src'), { recursive: true })
  writeFileSync(join(path, prefix + 'README.md'), '# Practice gateway\n\nA small test site.\n')
  writeFileSync(join(path, 'src', prefix + 'gateway.ts'), 'export function listen(port: number) {\n  return port\n}\n')
  const git = (...args: string[]) => execFileSync('git', ['-C', path, '-c', 'user.name=Walk', '-c', 'user.email=walk@example.test', ...args], {
    stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  })
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git('commit', '-qm', 'Start the practice site')
  writeFileSync(join(path, 'src', prefix + 'gateway.ts'), 'export async function listen(port: number) {\n  await ready(port)\n  return port\n}\n')
  writeFileSync(join(path, 'src/ready.ts'), 'export const ready = async (_port: number): Promise<void> => {}\n')
}

async function fixtures() {
  await pair.open(true, PROOF + ' shell', { fake: true, fakeDesk: true, provider: startWalkProvider, withoutTools: true, link: { delayMs: 0, rateMbit: 0 } })
  const { box, desk, win } = pair
  log('window and hosts open')
  if (!desk) throw new Error('The desk seat did not start')
  const workspace = async (host: typeof box, suffix: string) => {
    const path = join(host.work, 'practice-' + suffix)
    practiceRepo(path, suffix === 'desk' ? 'desk-' : '')
    return pair.rpc<{ id: string; path: string; name: string }>(host, 'workspace.create', { path, name: PROOF + ' ' + suffix })
  }
  const code = await workspace(box, 'gateway')
  const local = await workspace(win, 'terminal')
  const far = await workspace(desk, 'desk')
  // Use a project checkout so the renderer routes the nested plan path to box.
  const plans = await workspace(box, 'plans')
  const planProject = await pair.rpc<{ id: string }>(box, 'project.create', {
    workspaceId: plans.id, name: PROOF + ' listener project', mode: 'local'
  })
  const deskKey = await pair.rpc<{ token: string }>(desk, 'remote.keys.create', {
    name: PROOF + ' desk link', audience: 'client', caps: KEY_CAPS.owner
  })
  await pair.rpc(win, 'remote.environments.add', {
    url: `http://127.0.0.1:${desk.remote}`, key: deskKey.token, name: PROOF + ' desk host'
  })
  const make = (title: string, patch: Partial<CreateSessionInput> = {}, host = box, workspaceId = code.id) =>
    pair.rpc<{ id: string; planPath: string | null; title: string }>(host, 'session.create', {
      workspaceId, provider: 'claude', permission: 'auto', threadType: 'chat', title: PROOF + ' ' + title, ...patch
    })
  const empty = await make('first chat')
  const real = await make('practice turn')
  const full = await make('gateway transcript')
  const approval = await make('approval', { permission: 'safe' })
  const question = await make('question')
  const error = await make('failed turn')
  const plan = await make('gateway plan', { threadType: 'planning', projectId: planProject.id }, box, plans.id)
  if (plan.planPath) {
    mkdirSync(dirname(plan.planPath), { recursive: true })
    writeFileSync(plan.planPath, PLAN)
  }
  const board = await make('master board', { master: true })
  await make('listener task', { masterId: board.id, startedBy: board.id })
  await make('port research', { masterId: board.id, startedBy: board.id, threadType: 'research' })
  await make('read the listener', { parentId: full.id })
  await make('check the test', { parentId: full.id })
  const long = await make('long transcript')
  const desktop = await make('local terminal', {}, win, local.id)
  const deskProject = await pair.rpc<{ id: string }>(desk, 'project.create', {
    workspaceId: far.id, name: PROOF + ' desk checkout', mode: 'local'
  })
  const remote = await make('desk thread', {
    projectId: deskProject.id, firstMessage: 'Look through the practice checkout on desk.'
  }, desk, far.id)
  const image = { dark: await make('image dark'), light: await make('image light') }
  const stream = { dark: await make('stream dark'), light: await make('stream light') }
  log('practice workspaces and threads ready')
  return { code, local, empty, real, full, approval, question, error, plan, board, long, desktop, remote, image, stream, far, desk }
}

type Fixtures = Awaited<ReturnType<typeof fixtures>>
type Thread = Fixtures['empty']

async function walk(page: Window, pass: Pass, theme: Theme, f: Fixtures, keyId?: string): Promise<void> {
  const { box } = pair
  const scene = (name: Scene, pose = NOOP, atSize?: () => Promise<void>) => photograph(page, pass, theme, name, pose, atSize)
  const linkOpen = (host: string) => page.eval(`window.__docket?.registry.has(${js(host)}) && window.__docket.registry.statusOf(${js(host)}).transport === 'open'`)
  const open = async (thread: Thread) => {
    await page.eval(`window.__docket.open(${js(thread.id)})`)
    await visible('button[aria-label="Thread menu"], [data-board-scroller]', 'thread controls')
  }
  const visible = (selector: string, label: string, timeout = 8000) => page.until(label, timeout, () =>
    page.eval(`[...document.querySelectorAll(${js(selector)})].some(el => el.getClientRects().length && !el.closest('[inert],[aria-hidden="true"]'))`)
  )
  const see = (text: string, selector = 'body', timeout = 8000) => page.until(text, timeout, () =>
    page.eval(`[...document.querySelectorAll(${js(selector)})].some(el => el.getClientRects().length && el.innerText?.includes(${js(text)}))`)
  )
  const click = async (selector: string, label?: string) =>
    page.click(await page.steadyPoint(label ?? selector, () => page.centre(selector, label), 8000))
  const railPlace = (label: string) => label === 'Inbox' || label === 'Chats'
    ? click(`nav button[aria-label^=${js(label)}]`)
    : click('nav button', label)
  const panel = async (tab?: string) => {
    // The toggle says whether the panel is open: a panel kept open across the reload may still be loading its
    // chunk, and a click then would close it.
    const pressed = `[...document.querySelectorAll('button[aria-label="Panel"]')].some(b => b.getClientRects().length && b.getAttribute('aria-pressed') === 'true')`
    if (!await page.eval(pressed)) await click('button', 'Panel')
    await visible(PANEL, 'the right panel')
    if (!tab) return
    const trigger = `${PANEL} [role="tab"]`
    const point = await page.steadyPoint(tab, () => page.centre(trigger, tab), 8000)
    const already = await page.eval(`document.elementFromPoint(${point.x},${point.y})?.closest('[role="tab"]')?.getAttribute('aria-selected') === 'true'`)
    if (!already) await page.click(point)
  }
  const rightClick = async (selector: string) => {
    const point = await page.steadyPoint(selector, () => page.centre(selector), 8000)
    await page.click(point, 1, 'right')
    await visible('[role="menu"]', 'the context menu')
  }
  const workspace = `nav [data-rail-path=${js(f.code.path)}]`
  const selectWorkspace = async () => {
    const row = workspace + ' > button'
    if (!await page.centre(row + '[aria-current="true"]')) await click(row)
  }
  const clearComposer = async () => {
    await page.key('Escape')
    if (!await page.centre(COMPOSER)) return
    await click(COMPOSER)
    await page.key('Control+a')
    await page.key('Backspace')
  }
  const waitForLink = async (online: boolean) =>
    page.until(online ? 'the window to reconnect to box' : 'the window to lose the link to box', 22000,
      async () => (await linkOpen(box.host)) === online)
  const cut = async () => {
    pair.cutWindowLink(true)
    await waitForLink(false)
  }
  const restore = () => pair.cutWindowLink(false)
  const inject = async (thread: Thread, events: AgentEvent[]) => {
    const rowsOnHost = await pair.rpc<EventRow[]>(box, 'session.events', { sessionId: thread.id })
    const first = (rowsOnHost.at(-1)?.seq ?? 0) + 1
    const rows = events.map((event, index) => ({
      push: 'event', row: { sessionId: thread.id, seq: first + index, ts: Date.now() - (events.length - index) * 4000, event }
    }))
    await page.eval(`(() => { for (const push of ${js(rows)}) window.__docket.sessionStore.injectPush(push, ${js(box.host)}); })()`)
  }
  let longReady = false
  const seedLong = async () => {
    await open(f.long)
    if (longReady) return
    await inject(f.long, Array.from({ length: 38 }, (_, i) => [
      ...transcriptTurn(`long-${i}`).map(event => event.type === 'user-text' ? { ...event, text: `Practice pass ${i + 1} of 38. Check the gateway listener.` } : event),
      { type: 'turn-complete' } as const
    ]).flat())
    await visible(TRANSCRIPT + ' [data-row]', 'the long transcript')
    longReady = true
  }
  const ask = async (thread: Thread, text: string, kind: AgentEvent['type']) => {
    await open(thread)
    const rows = () => pair.rpc<EventRow[]>(box, 'session.events', { sessionId: thread.id })
    if (!(await rows()).some(({ event }) => event.type === kind) && pass === 'owner') {
      await pair.rpc(box, 'session.send', { sessionId: thread.id, text })
    }
    await page.until('the host to record ' + kind, 45000, async () =>
      (await rows()).some(({ event }) => event.type === kind))
    await visible(TRANSCRIPT + (kind === 'question-request' ? ' [data-slot="question-card"]' : ' [data-slot="approval"]'), kind, 10000)
  }

  const keepDeskPanel = wanted(pass, '40-desk-files') || wanted(pass, '41-desk-changes')
  await page.eval(`(() => {
    localStorage.setItem('docket.colorScheme', ${js(theme)})
    if (${keepDeskPanel}) {
      // Start the desk scene with the panel already open, as on reopening
      // a thread whose last view was its files.
      const panels = JSON.parse(localStorage.getItem('docket.rightPanel') ?? '{"width":320,"threads":{}}')
      panels.threads[${js(f.remote.id)}] = { open: true, section: 'files' }
      localStorage.setItem('docket.rightPanel', JSON.stringify(panels))
    }
  })()`)
  await page.reload()
  await page.until('the built window and its box link', 30000, async () => {
    if (!await linkOpen(box.host).catch(() => false)) return false
    return !keyId || page.eval(`window.__docket.registry.linkOf(${js(box.host)}).transport?.hello?.key?.id === ${js(keyId)}`)
  })

  await scene('01-start', async () => {
    await railPlace('Chats')
    await page.key('Control+n')
    await visible('[data-composer-draft-row]', 'the start draft')
  })
  await scene('02-new-thread', async () => { await selectWorkspace(); await page.key('Control+n'); await visible('[data-composer-draft-row]', 'new thread') })
  await scene('03-thread-empty', () => open(f.empty))
  await scene('04-thread-real-turn', async () => {
    await open(f.real)
    if (!await page.eval(`document.body.innerText.includes('I have the practice list')`)) {
      await sendPrompt(page, 'Count the cones for practice.')
    }
    await see('I have the practice list', TRANSCRIPT, 45000)
  })
  await scene('05-transcript-full', async () => {
    await open(f.full)
    await inject(f.full, [...transcriptTurn(theme), { type: 'turn-complete', inputTokens: 18200, outputTokens: 2400 }])
    await see('What I found', TRANSCRIPT)
  })
  await scene('06-approval', () => ask(f.approval, APPROVAL, 'approval-request'))
  await scene('07-question', () => ask(f.question, QUESTION, 'question-request'))
  await scene('08-failure', async () => {
    await open(f.error)
    await inject(f.error, [
      { type: 'user-text', text: 'Check the practice site.' },
      { type: 'error', message: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' }
    ])
    await see('Check the practice site.', TRANSCRIPT)
  })
  await scene('09-plan-thread', async () => {
    await open(f.plan)
    const events = await pair.rpc<EventRow[]>(box, 'session.events', { sessionId: f.plan.id })
    if (!events.some(({ event }) => event.type === 'user-text')) {
      await pair.rpc(box, 'session.send', { sessionId: f.plan.id, text: 'Review the written practice plan.' })
    }
    await see('Give each test its own listener.', 'body', 30000)
  })
  await scene('10-right-panel', async () => { await open(f.full); await panel() })
  await scene('11-terminal-dock', async () => {
    await open(f.desktop)
    if (!await page.centre('[data-project-terminal-dock] .xterm')) await page.key('Control+j')
    await visible('[data-project-terminal-dock] .xterm-screen', 'the terminal')
    await click('[data-project-terminal-dock] .xterm-screen')
    const mark = '.walk-terminal-' + theme
    const command = "printf '\\033[32mReady\\033[0m\\n\\033[36mPractice gateway\\033[0m\\n\\033[33mTwo tests queued\\033[0m\\n'; ls; printf '' > " + mark
    await page.eval(`(() => {
      const clipboardData = new DataTransfer()
      clipboardData.setData('text/plain', ${js(command)})
      document.querySelector('[data-project-terminal-dock] .xterm-helper-textarea').dispatchEvent(
        new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true })
      )
    })()`)
    await page.key('Enter')
    await page.until('the terminal command to finish', 8000, () => existsSync(join(f.local.path, mark)))
  })
  if (wanted(pass, '11-terminal-dock')) {
    const hide = await page.centre('[data-project-terminal-dock] button', 'Hide dock')
    if (hide) await page.click(hide)
  }
  await scene('12-message-list', async () => {
    await seedLong()
    await visible('[data-transcript-outline]', 'the message list')
    if (await page.centre('[data-transcript-outline] button', 'Show message list')) await page.key('Control+Shift+m')
    await visible('[data-transcript-outline] button[aria-label="Hide message list"]', 'the open message list')
  })
  await scene('13-search', async () => {
    await page.key('Control+k')
    await visible('[data-app-search] input', 'search')
    await page.typeKeys('gateway')
  })
  if (wanted(pass, '13-search')) await page.key('Escape')
  const filePicker = async (thread: Thread, file = 'gateway.ts') => {
    await open(thread)
    await page.key('Control+p')
    await visible('[data-file-picker] input', 'Go to File')
    await page.typeKeys('gate')
    await see(file, '[data-file-picker]')
  }
  await scene('14-go-to-file', () => filePicker(f.full))
  await scene('15-model-picker', async () => {
    await open(f.full)
    await clearComposer()
    await page.key('Control+.')
    await visible('[data-model-picker]', 'the model picker')
  })
  await scene('16-slash-menu', async () => {
    await open(f.full)
    await clearComposer()
    await page.typeKeys('/')
    await visible('[data-command-popover]', 'the slash menu')
  })
  await scene('17-at-menu', async () => {
    await open(f.full)
    await clearComposer()
    await page.typeKeys('@ga')
    await see('gateway.ts', '[data-command-popover]')
  })
  if (wanted(pass, '17-at-menu')) await clearComposer()
  await scene('18-rail-thread-menu', async () => {
    await open(f.full)
    await selectWorkspace()
    await rightClick(`[data-thread-row][data-menu-id=${js(f.full.id)}] [data-row-open]`)
  })
  await scene('19-rail-workspace-menu', () => rightClick(workspace + ' > button'))
  await scene('20-sidebar-hidden', () => page.key('Control+b'))
  if (wanted(pass, '20-sidebar-hidden')) await page.key('Control+b')
  await scene('21-split-right', async () => {
    await open(f.full)
    await page.eval(`window.__docket.open(${js(f.empty.id)}, { split: true })`)
  })
  if (wanted(pass, '21-split-right')) await page.key('Control+w')
  const places = [['22-inbox', 'Inbox'], ['23-notes', 'Notes'], ['24-chats', 'Chats'], ['25-accounts', 'Accounts'], ['26-stats', 'Stats'], ['27-search-page', 'Search']] as const
  for (const [name, label] of places) {
    await scene(name, () => railPlace(label))
    if (wanted(pass, name)) await page.key('Escape')
  }
  await scene('28-update-check', async () => {
    const update = 'nav button[aria-label^="Check for updates"]'
    await click(update)
    await visible(update, 'the update row')
  })
  await scene('29-link-cut', async () => { await open(f.full); await cut() })
  await scene('30-link-cut-new-thread', async () => {
    await cut()
    await page.key('Control+n')
    await visible('[data-composer-draft-row]', 'the offline draft')
  })
  if (wanted(pass, '29-link-cut') || wanted(pass, '30-link-cut-new-thread')) restore()
  await scene('31-link-back', async () => { await waitForLink(true); await open(f.full) })
  await scene('32-master-board', async () => {
    await open(f.board)
    await visible('[data-board-scroller]', 'the master board')
    await see(PROOF + ' listener task', '[data-board-scroller]')
  })
  await scene('33-agents', async () => { await open(f.full); await panel('Agents'); await visible('[data-agent-row]', 'subagents') })
  const addImage = async () => {
    await open(f.image[theme])
    await click(COMPOSER)
    await page.eval(`(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 480
      canvas.height = 270
      const draw = canvas.getContext('2d')
      draw.fillStyle = '#164754'
      draw.fillRect(0, 0, 480, 270)
      draw.fillStyle = '#d8eee0'
      draw.fillRect(44, 44, 392, 182)
      draw.fillStyle = '#164754'
      draw.font = '26px sans-serif'
      draw.fillText('Practice gateway', 82, 118)
      draw.font = '18px sans-serif'
      draw.fillText('Two tests ready', 82, 160)
      const field = document.activeElement
      canvas.toBlob(blob => {
        const data = new DataTransfer()
        data.items.add(new File([blob], 'practice-gateway.png', { type: 'image/png' }))
        field.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
      })
    })()`)
    await visible('[data-composer] [data-slot="attachment"]', 'the image in the composer')
  }
  await scene('34-image-composer', addImage)
  await scene('35-image-sent', async () => {
    if (!await page.eval(`!!document.querySelector('[data-composer] [data-slot="attachment"]')`)) await addImage()
    await sendPrompt(page, 'Here is the practice gateway image.')
    await visible('[data-user-bubble] img', 'the sent image', 12000)
  })
  for (const [name, ratio] of [['36-long-middle', 0.5], ['37-long-end', 1]] as const) {
    await scene(name, async () => {
      await seedLong()
    }, async () => {
      // Release the transcript's follow mode before moving. A viewport
      // resize can re-anchor the virtual rows, so wait for the new position.
      const scroller = `[...document.querySelectorAll(${js(TRANSCRIPT)})].find(el => el.getClientRects().length)`
      await page.until(name + ' scroll position', 8000, async () => {
        await page.eval(`(() => {
          const view = ${scroller}
          const end = view.scrollHeight - view.clientHeight
          const target = end * ${ratio}
          view.dispatchEvent(new WheelEvent('wheel', { deltaY: target < view.scrollTop ? -1 : 1 }))
          view.scrollTop = target
        })()`)
        await pause(160)
        return page.eval(`(() => {
          const view = ${scroller}
          const end = view.scrollHeight - view.clientHeight
          return end > view.clientHeight && Math.abs(view.scrollTop - end * ${ratio}) <= end * 0.04
        })()`)
      })
    })
  }
  await scene('38-link-cut-changes', async () => { await waitForLink(true); await open(f.full); await panel('Changes'); await cut() })
  if (wanted(pass, '38-link-cut-changes')) restore()
  await scene('39-link-cut-draft', async () => {
    await waitForLink(true)
    await open(f.full)
    await page.key('Control+n')
    await visible('[data-composer-draft-row]', 'the unsent draft')
    await clearComposer()
    await page.typeKeys('Keep this practice draft while box is away.')
    await cut()
  })
  if (wanted(pass, '39-link-cut-draft')) {
    restore()
    await clearComposer()
  }
  const deskThread = async () => {
    await waitForLink(true)
    await page.until('the desk link', 15000, () => linkOpen(f.desk.host))
    await open(f.remote)
    await see('Look through the practice checkout on desk.', TRANSCRIPT)
  }
  await scene('40-desk-files', async () => { await deskThread(); await panel('Files'); await see('desk-README.md', PANEL) })
  await scene('41-desk-changes', async () => { await deskThread(); await panel('Changes'); await see('desk-gateway.ts', PANEL) })
  await scene('42-desk-go-to-file', () => filePicker(f.remote, 'desk-gateway.ts'))
  await scene('43-stream', async () => {
    await open(f.stream[theme])
    const frames = join(out, 'stream')
    mkdirSync(frames, { recursive: true })
    await page.resize(1000, 700)
    await sendPrompt(page, STREAM)
    await see(STREAM_START, TRANSCRIPT, 45000)
    await Promise.all(Array.from({ length: 30 }, async (_, index) => {
      await pause(index * 100)
      await page.shot(join(frames, `${pass}-${theme}-43-stream-${String(index + 1).padStart(2, '0')}.png`))
    }))
    await see('The next test can then use either port', TRANSCRIPT, 12000)
  })
  await scene('44-composer', async () => { await waitForLink(true); await open(f.full) })
  await scene('45-changes', async () => { await open(f.full); await panel('Changes'); await see('gateway.ts', PANEL) })
  await scene('46-files', async () => { await open(f.full); await panel('Files'); await see('README.md', PANEL) })
  await scene('47-thread-menu', async () => { await open(f.full); await click('button', 'Thread menu'); await visible('[role="menu"]', 'the thread menu') })
  await scene('48-live-row', async () => {
    await ask(f.question, QUESTION, 'question-request')
    await visible(`[data-strip="live"] [data-menu-id=${js(f.question.id)}]`, 'the waiting thread on the live row')
  })
}

async function main(): Promise<void> {
  const f = await fixtures()
  // Coax the initial waits from the real host even for a restricted-only walk.
  if (!options.passes.includes('owner')) {
    if (options.passes.some(pass => wanted(pass, '06-approval'))) {
      await pair.rpc(pair.box, 'session.send', { sessionId: f.approval.id, text: APPROVAL })
    }
    if (options.passes.some(pass => wanted(pass, '07-question'))) {
      await pair.rpc(pair.box, 'session.send', { sessionId: f.question.id, text: QUESTION })
    }
  }
  for (const pass of options.passes) {
    let keyId: string | undefined
    // A device key must prove the socket. Use the harness's paired window,
    // with its signed identity and saved key, for the entire device pass.
    camera = pass === 'device' ? await pair.deviceWindow() : pair.page
    if (pass === 'read') {
      const key = await pair.mint(pass, PROOF + ' ' + pass)
      keyId = key.id
      await pair.rpc(pair.win, 'remote.environments.add', {
        url: `http://127.0.0.1:${pair.windowLink!.port}`, key: key.token, name: 'box'
      })
    }
    for (const theme of options.themes) await walk(camera, pass, theme, f, keyId)
  }
}

try {
  log('run ' + root)
  log('pictures ' + out)
  await main()
} catch (error) {
  log('WALK FAILED ' + words(error))
  if (!pair.abort.signal.aborted) {
    try { await (camera ?? pair.page).shot(join(out, 'walk-FAILED.png')) } catch { /* the window did not open */ }
  }
  process.exitCode ||= 1
} finally {
  try {
    const stopped = await pair.stop()
    log('stopped ' + JSON.stringify(stopped))
    if (stopped.remainingPids.length || stopped.remainingPorts.length || stopped.errors.length) process.exitCode ||= 1
  } catch (error) {
    log('CLEANUP FAILED ' + words(error))
    process.exitCode ||= 1
  } finally {
    rmSync(root, { recursive: true, force: true })
    log('leftovers ' + JSON.stringify({ pids: instancePids(root), runFolder: existsSync(root) }))
    log(`Scenes shot: ${shot}, failed: ${failed}`)
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
  }
}
