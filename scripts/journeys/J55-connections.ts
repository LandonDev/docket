import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HealthReport, HealthRow, HealthState } from '../../src/shared/work/health'
import { journey, step, type Context } from './lib/record'

const SETTINGS = '[data-app-settings]'
const PAGE_ROW = `${SETTINGS} [data-slot="page-row"]`
const VIEWS = ['Mail', 'Messages', 'Tasks', 'Projects', 'Agenda', 'People'] as const
const MARK: Record<HealthState, string> = { working: 'done', broken: 'failed', 'needs-you': 'waiting' }
const PREP_EVENT = 'Open the equipment cupboard'

async function connections({ pair }: Context): Promise<void> {
  if (!await pair.page.centre(SETTINGS)) await pair.page.clickOn('nav button', 'Settings')
  await pair.page.clickOn('nav [data-rail-row] > button > span.truncate', 'Connections')
}

async function status({ pair }: Context): Promise<string> {
  return (await pair.rpc<{ lifeos: { state: string } }>(pair.box, 'work.lifeos.status')).lifeos.state
}

async function signedOutView({ pair }: Context, view: string): Promise<void> {
  const region = `[role="region"][aria-label=${JSON.stringify(view)}]`
  await pair.page.until(view + ' to say how to sign in', 7000, async () => {
    const words = await pair.page.eval<string>(`document.querySelector(${JSON.stringify(region)})?.innerText ?? ''`)
    return words.includes('Sign in to LifeOS') && await pair.page.centre(region + ' button', 'Sign in')
  })
}

export function withheldWords(line: string): boolean {
  return line.includes('This computer cannot read LifeOS here') && !/did not answer/i.test(line)
}

type DrawnRow = { title: string; state?: string; detail?: string; words: string }

export function connectionMatches(row: HealthRow, seen: DrawnRow): boolean {
  if (seen.title !== row.title && !seen.title.startsWith(row.title + ' on ')) return false
  if (row.id === 'office.addin') return seen.words.includes('Pair')
  return seen.state === MARK[row.state] && (!row.line || seen.detail?.includes(row.line) === true)
}

export default journey({
  id: 'J55',
  title: 'Check Connections, sign out and back in, and read from a given computer',
  tier: 2,
  shapes: ['S', 'K'],
  steps: [
    step('Check every Connections row against the two hosts and LifeOS', async (context) => {
      const { pair, folder } = context
      await connections(context)
      if (await status(context) !== 'connected' || !(await pair.sandbox!.query<unknown>('health:ping'))) throw new Error('The sandbox is not connected')
      const reports = await Promise.all([pair.win, pair.box].map((inst) => pair.rpc<HealthReport>(inst, 'work.health', {}, 27_000)))
      const expected = reports.flatMap(({ rows }) => rows)
      let drawn: DrawnRow[] = []
      try {
        await pair.page.until('Connections to show the hosts’ rows', 28_000, async () => {
          drawn = await pair.page.eval<DrawnRow[]>(`[...document.querySelectorAll(${JSON.stringify(PAGE_ROW)})].map((row) => ({
            title: row.querySelector('[data-slot="item-title"]')?.innerText ?? '',
            state: row.querySelector('[data-slot="status-mark"]')?.dataset.state,
            detail: row.querySelector('[data-slot="status-detail"]')?.innerText,
            words: row.innerText
          }))`)
          return expected.every(row => drawn.some(seen => connectionMatches(row, seen))) &&
            drawn.every(seen => expected.some(row => connectionMatches(row, seen)))
        })
      } finally {
        writeFileSync(join(folder, 'connections.json'), JSON.stringify({ reports, drawn }, null, 2))
      }
    }, ['S']),
    step('Sign box out and check the row and each LifeOS view', async (context) => {
      const { pair, workspace } = context
      const { page } = pair
      await page.key('Escape')
      await pair.showWork(workspace, 'Agenda')
      let event: { x: number; y: number } | null = null
      await page.until('the equipment cupboard event', 8000, async () =>
        (event = await page.centre('[role="region"][aria-label="Agenda"] [role="listitem"] span', PREP_EVENT)))
      await page.click(event!, 1, 'right')
      const prepare = await page.centre('[role="menuitem"]', 'Prepare') ?? await page.centre('[role="menuitem"]', 'Follow up')
      if (!prepare) throw new Error('The Agenda event has no way to open Prep')
      await page.click(prepare)
      await connections(context)
      await page.clickOn(PAGE_ROW + ' button', 'Sign out')
      await page.until('box signed out', 8000, async () => await status(context) === 'signed-out')
      await page.until('the Connections sign-in row', 8000, () => page.eval(`[...document.querySelectorAll(${JSON.stringify(PAGE_ROW)})]
        .some((row) => row.querySelector('[data-slot="item-title"]')?.innerText === 'LifeOS on box' && row.innerText.includes('Not signed in on this host') && [...row.querySelectorAll('button')].some((button) => button.innerText === 'Sign in…'))`))
      await page.key('Escape')
      await signedOutView(context, 'Meeting')
      for (const view of VIEWS) {
        await pair.showWork(workspace, view)
        await signedOutView(context, view)
      }
      await page.clickOn('nav button', 'Today')
      await page.until('Today says to sign in to LifeOS', 8000, async () =>
        (await page.eval<string>(`document.querySelector('[data-today]')?.innerText ?? ''`)).includes('Not signed in to LifeOS') &&
        await page.centre('[data-today] button', 'Sign in'))
    }, ['S']),
    step('end: sign box back in and see the sandbox mail again', async (context) => {
      const { pair, workspace } = context
      await pair.rpc(pair.box, 'work.lifeos.setToken', { token: await pair.sandbox!.mintDevice() })
      await pair.page.until('box signed back in', 10_000, async () => await status(context) === 'connected')
      await pair.checkSeededMail(workspace)
    }, ['S']),
    step('end: a given computer sees the LifeOS refusal', async (context) => {
      const { pair, workspace } = context
      const page = await pair.deviceWindow()
      context.evidencePage = page
      await pair.showWork(workspace, 'Mail', page)
      const read = await pair.fromWindow('work.lifeos.jwt', { sector: 'purdue' }, page)
      if (read.ok) throw new Error('The given-computer key could obtain a LifeOS JWT')
      await page.until('Mail’s given-computer wording', 8000, async () =>
        withheldWords(await page.eval<string>(`document.querySelector('[role="region"][aria-label="Mail"]')?.innerText ?? ''`)))
    }, ['K'])
  ]
})
