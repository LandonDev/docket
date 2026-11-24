import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_THREAD_DEFAULTS } from '../../src/shared/defaults'
import { openRow, rowAt } from './lib/files'
import { fileAt, showPlace } from './lib/place'
import { journey, step, type Context } from './lib/record'
import { hostRows } from './lib/thread'

const NAME = 'Practice search agenda.txt'
const SECOND = 'Practice times.txt'
const INPUT = '[data-composer-input]'
const NAV = 'button, a, [role="link"]'
const MODEL = 'claude-haiku-5-5'
const EFFORT = 'high'
type Session = { id: string; scope: string; permission: string; model: string; provider: string; reasoning: string; workspace_id: string | null }

const failures = new WeakMap<Context, string[]>()

const sessions = ({ pair }: Context) => hostRows<Session>(pair, 'SELECT id, scope, permission, model, provider, reasoning, workspace_id FROM sessions')

async function checkStart(context: Context, label: string, open: () => Promise<void>, dock = false, loose = false) {
  const { pair, workspace, folder } = context
  const { page } = pair
  const before = new Set((await sessions(context)).map(({ id }) => id))
  await open()
  const scope = dock ? '[data-files-dock] ' : ''
  const input = scope + INPUT
  await page.clickOn(input)
  const controls = await page.eval<string[]>(`[...document.querySelectorAll('[data-branch-picker], button[aria-label^="Project "], button[aria-label*="Terminal"]')]
    .filter(el => el.getClientRects().length && !el.closest('[inert], [aria-hidden="true"]')).map(el => el.getAttribute('aria-label') ?? el.textContent)`)
  await page.typeKeys('Practice chat from ' + label)
  await page.clickOn(scope + 'button', 'Send')
  let created: Session | undefined
  await page.until(label + ' to create a thread row on box', 22_000, async () => (created = (await sessions(context)).find(({ id }) => !before.has(id))))
  writeFileSync(join(folder, label + '.json'), JSON.stringify({ row: created, controls }, null, 2))
  if (controls.length) throw new Error(label + ' draws code-only controls: ' + controls.join(', '))
  const row = created!
  if (row.scope !== 'work' || row.permission !== 'auto' || row.model !== MODEL || row.provider !== 'claude' ||
    row.reasoning !== EFFORT || row.workspace_id !== (loose ? null : workspace.id)) {
    throw new Error(label + ' has the wrong host row: ' + JSON.stringify(row))
  }
}

async function start(context: Context, label: string, open: () => Promise<void>, dock = false, loose = false) {
  try {
    await checkStart(context, label, open, dock, loose)
  } catch (error) {
    const { pair, folder } = context
    const { page } = pair
    const list = failures.get(context) ?? []
    list.push(label + ': ' + String(error))
    failures.set(context, list)
    writeFileSync(join(folder, label + '-failure.json'), JSON.stringify({
      error: String(error), toasts: await page.toasts(), saveLine: await page.saveLine(), hostErrors: pair.hostErrors
    }, null, 2))
    await page.shot(join(folder, label + '.png'))
    await page.dismissPopups()
  }
}

export default journey({
  id: 'J58',
  title: 'Check Work chat defaults and scope from each start surface',
  tier: 1,
  shapes: ['A'],
  steps: [
    step('Set Full access and a non-built-in model on box; open a dummy workspace', async (context) => {
      const { pair, folder } = context
      await pair.rpc(pair.box, 'defaults.set', { workspaceId: null, defaults: {
        ...DEFAULT_THREAD_DEFAULTS, permission: 'auto', provider: 'claude', model: MODEL, reasoning: EFFORT
      } })
      await pair.page.reload()
      writeFileSync(fileAt(context, NAME), 'A dummy agenda for the park')
      writeFileSync(fileAt(context, SECOND), 'Practice at noon')
      await showPlace(context)
      writeFileSync(join(folder, 'skipped.txt'), 'Task, Mail and Messages need LifeOS. Their Start thread controls were skipped.\n')
    }),
    step('Start from the rail’s New thread', (context) => start(context, 'rail', async () => {
      const { page } = context.pair
      await page.clickOn(NAV, 'Files')
      await page.press('button', 'New thread')
    })),
    step('Start from Work Chats', (context) => start(context, 'work-chats', async () => {
      const { page } = context.pair
      await page.clickOn(NAV, 'Work Chats')
      await page.press('button', 'New thread')
    }, false, true)),
    step('Start a thread about a selection from the Files view', (context) => start(context, 'view-selection', async () => {
      const { page } = context.pair
      await showPlace(context)
      let point: Awaited<ReturnType<typeof rowAt>> = null
      await page.until('the dummy file row', 12_000, async () => (point = await rowAt(page, NAME)))
      await page.click(point!)
      const second = await rowAt(page, SECOND)
      if (!second) throw new Error('The second dummy file row is missing')
      await page.click(second, 1, 'left', 8)
      await page.clickOn('[data-files-bulk-ask]', 'Ask')
    })),
    step('Start from Files → Ask', (context) => start(context, 'files-ask', async () => {
      const { page } = context.pair
      await showPlace(context)
      await openRow(page, NAME)
      await page.clickOn('[data-files-header] button', 'Ask')
    }, true)),
    step('Start from a Work search hit’s New thread about this', (context) => start(context, 'search-hit', async () => {
      const { page } = context.pair
      await page.press('button', 'Search Work')
      await page.clickOn('input[aria-label="Search Work"]')
      await page.typeKeys(NAME)
      const selector = '[data-work-search] [role="option"][data-kind="file"]'
      await page.until('the matching file hit', 20_000, () => page.centre(selector))
      const hit = await page.centre(selector)
      await page.click(hit!, 1, 'right')
      await page.until('New thread about this in the hit menu', 10_000, () => page.eval(
        `[...document.querySelectorAll('[role="menuitem"]')].some(e => e.innerText.includes('New thread about this'))`
      ))
      await page.key('Control+Enter')
    })),
    step('end: all five host rows still have Work scope, Full access and the chosen defaults', async (context) => {
      if (failures.get(context)?.length) throw new Error(failures.get(context)!.join(' | '))
      const rows = (await sessions(context)).filter((row) => row.scope === 'work' && row.permission === 'auto' &&
        row.provider === 'claude' && row.model === MODEL && row.reasoning === EFFORT)
      if (rows.filter(({ workspace_id }) => workspace_id === context.workspace.id).length !== 4 ||
        rows.filter(({ workspace_id }) => workspace_id === null).length !== 1) throw new Error('The five expected chats are absent from box')
    })
  ]
})
