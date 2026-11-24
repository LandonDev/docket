import { DEFAULT_THREAD_DEFAULTS } from '../../src/shared/defaults'
import { ZONE } from './lib/lifeosSeed'
import { journey, step, type Context } from './lib/record'
import { hostRows } from './lib/thread'
import { field, json, shown } from './lib/tierThree'

const NAME = 'Practice morning check'
const DEFAULTS = { ...DEFAULT_THREAD_DEFAULTS, provider: 'claude', model: 'claude-haiku-5-5', reasoning: 'high', permission: 'auto' } as const
type Routine = { id: string; enabled: number; trigger_spec: string; next_at: number | null }
type Thread = { id: string; workspace_id: string; permission: string; model: string; provider: string; reasoning: string; scope: string }
const routine = async ({ pair, workspace }: Context) => (await hostRows<Routine>(pair,
  'SELECT id, enabled, trigger_spec, next_at FROM work_routines WHERE workspace_id = ? AND name = ?', workspace.id, NAME))[0]

export function routineThreadMatches(thread: Thread, workspaceId: string, defaults: Pick<Thread, 'permission' | 'model' | 'provider' | 'reasoning'>): boolean {
  return thread.workspace_id === workspaceId && thread.scope === 'work' && thread.permission === defaults.permission &&
    thread.model === defaults.model && thread.provider === defaults.provider && thread.reasoning === defaults.reasoning
}

export default journey({
  id: 'J47',
  title: 'Run a weekday routine with the box’s Thread defaults and pause it',
  tier: 3,
  shapes: ['A'],
  steps: [
    step('Make a weekday 7 AM routine in America/New_York', async (context) => {
      const { pair, workspace } = context
      const { page } = pair
      await page.eval(`document.addEventListener('click', (event) => {
        const button = event.target?.closest?.('button');
        if (button?.textContent.trim() !== 'New routine') return;
        const view = button.closest('[role="region"][aria-label="Routines"]');
        window.__journeyRoutinePress = {
          trusted: event.isTrusted,
          shellLoading: !!view?.querySelector('[data-surface-skeleton]'),
          listLoading: !!view?.querySelector('[aria-label="Loading routines"]'),
          empty: view?.innerText.includes('No routines yet')
        };
      }, { capture: true })`)
      await pair.showWork(workspace, 'Routines')
      await page.press('button', 'New routine')
      try {
        await field(page, 'Name', NAME)
      } catch (error) {
        const press = await page.eval('window.__journeyRoutinePress ?? null').catch(() => null)
        json(context, 'routine-press', press)
        throw error
      }
      await field(page, 'What to do', 'Read the dummy practice list.')
      await page.clickOn('[role="dialog"] button', 'Create')
      await page.until('the saved schedule on screen and on box', 18_000, async () =>
        await shown(page, '[data-routine-detail]', 'Weekdays at 7:00') && !!(await routine(context))?.next_at)
      const row = (await routine(context))!
      json(context, 'routine', row)
      const spec = JSON.parse(row.trigger_spec) as { on: string; tz: string; rrule: string }
      if (spec.on !== 'schedule' || spec.tz !== ZONE || !spec.rrule.includes('BYDAY=MO,TU,WE,TH,FR') ||
        !spec.rrule.includes('BYHOUR=7') || !spec.rrule.includes('BYMINUTE=0')) throw new Error('The host kept a different schedule')
    }),
    step('Set and read back the box’s Thread defaults before Run now', async (context) => {
      const { pair } = context
      await pair.rpc(pair.box, 'defaults.set', { workspaceId: null, defaults: DEFAULTS })
      const stored = await pair.rpc(pair.box, 'defaults.get', { workspaceId: null })
      json(context, 'thread-defaults', stored)
      if (!JSON.stringify(stored).includes(DEFAULTS.model)) throw new Error('Box did not keep the chosen Thread defaults')
      await pair.page.until('Run now still available in the routine', 12_000, () => pair.page.centre('button', 'Run now'))
    }),
    step('Run now and read the new run in Routines', async (context) => {
      const { pair } = context
      const id = (await routine(context))!.id
      await pair.page.press('button', 'Run now')
      await pair.page.until('a manual run with a box thread and a visible Runs row', 30_000, async () =>
        !!(await hostRows<{ session_id: string }>(pair,
          "SELECT session_id FROM work_routine_runs WHERE routine_id = ? AND cause = 'Run now' AND session_id IS NOT NULL", id))[0] &&
        !!await pair.page.centre('[aria-label="Runs"] button'))
    }),
    step('end: pause the routine and compare the box thread with the chosen defaults', async (context) => {
      const { pair, workspace } = context
      const id = (await routine(context))!.id
      const threads = await hostRows<Thread>(pair, `SELECT s.id, s.workspace_id, s.permission, s.model, s.provider, s.reasoning, s.scope
        FROM work_routine_runs r JOIN sessions s ON s.id = r.session_id WHERE r.routine_id = ? AND r.cause = 'Run now'`, id)
      await pair.page.press('button', 'Pause')
      await pair.page.until('Paused on screen and the schedule off on box', 15_000, async () =>
        await shown(pair.page, '[data-routine-detail]', 'paused') && (await routine(context))?.enabled === 0)
      json(context, 'run-and-pause', { expected: DEFAULTS, threads, paused: await routine(context) })
      if (threads.length !== 1 || !routineThreadMatches(threads[0]!, workspace.id, DEFAULTS)) {
        throw new Error('Run now Thread defaults differ: ' + JSON.stringify(threads))
      }
    })
  ]
})
