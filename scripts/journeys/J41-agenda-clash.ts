import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FIRST_CLASH, MOVED_EVENT, NEXT_CLASH, SECTOR, seedDay } from './lib/lifeosSeed'
import { journey, step, type Context } from './lib/record'
import { labelled } from './lib/tierThree'

const TITLE = 'Sort the spare adapters'
const AGENDA = '[role="region"][aria-label="Agenda"]'

type Event = { _id: string; title: string; startsAt: number; endsAt: number }

async function events({ pair }: Context): Promise<Event[]> {
  const now = new Date()
  return pair.sandbox!.query<Event[]>('events:range', { sector: SECTOR, from: seedDay(now, 0, 0), to: seedDay(now, 7, 0) })
}

export function honestAdding(toasts: string[], status: string): boolean {
  const line = toasts.find((toast) => toast.includes(TITLE)) ?? ''
  return status === 'done' ? line.startsWith('Added ') :
    status === 'queued' && (line.startsWith('Adding ') || line.includes('queued in LifeOS'))
}

export default journey({
  id: 'J41',
  title: 'Queue a new event and see the clash after a local move',
  tier: 2,
  shapes: ['S'],
  steps: [
    step('Add a calendar event and read the toast alongside the LifeOS operation', async (context) => {
      const { pair, workspace, folder } = context
      const { page } = pair
      await pair.showWork(workspace, 'Agenda')
      await page.clickOn(`${AGENDA} button`, 'New event')
      await page.clickOn(await labelled(page, 'Event'))
      await page.typeKeys(TITLE)
      await page.watchToasts()
      await page.clickOn('[role="dialog"] button', 'Add')
      await page.until('the calendar operation and its truthful toast', 12_000, async () => {
        const toasts = await page.toasts(true)
        const rows = await pair.sandbox!.query<{ status: string; payload: { title?: string } }[]>('calendarOps:list', { sector: SECTOR })
        const row = rows.find(({ payload }) => payload.title === TITLE)
        if (!row || !honestAdding(toasts, row.status)) return false
        writeFileSync(join(folder, 'calendar-op.json'), JSON.stringify({ row, toasts }, null, 2))
        return row.status === 'done' || !(await events(context)).some(({ title }) => title === TITLE)
      })
    }),
    step('Move the projectors event onto the cupboard event from its clash dialog', async (context) => {
      const { pair } = context
      const { page } = pair
      const rows = await events(context)
      const target = rows.find(({ title }) => title === NEXT_CLASH)
      if (!target) throw new Error('LifeOS has no cupboard event')
      await page.until('the original clash beside the projector event', 12_000, () => page.eval(`[...document.querySelectorAll(${JSON.stringify(AGENDA + ' [role="listitem"]')})]
        .some((row) => row.innerText.includes(${JSON.stringify(MOVED_EVENT)}) && row.innerText.includes(${JSON.stringify(FIRST_CLASH)}))`))
      const at = await page.steadyPoint('the projector event in Agenda', () =>
        page.centre(`${AGENDA} [role="listitem"] span`, MOVED_EVENT))
      await page.click(at, 1, 'right')
      await page.press('menuitem', 'Show clash')
      await page.clickOn('[data-clash-dialog] [data-way$=":move"]', 'Move…')
      const values = await page.eval<{ day: string; from: string; to: string }>(`(() => {
        const date = new Date(${target.startsAt});
        return { day: new Intl.DateTimeFormat('en-CA').format(date), from: '21:00', to: '22:00' };
      })()`)
      // Click each time's first segment. Tab within a native date or time field moves between its segments.
      for (const [index, time] of ['0900p', '1000p'].entries()) {
        const hour = await page.eval<{ x: number; y: number }>(`(() => {
          const box = document.querySelectorAll('[data-clash-step] input[type="time"]')[${index}].getBoundingClientRect();
          return { x: box.left + 16, y: box.top + box.height / 2 };
        })()`)
        await page.click(hour)
        await page.typeKeys(time)
      }
      await page.until('the move form to hold the cupboard event’s time', 2000, () => page.eval(`(() => {
        const form = document.querySelector('[data-clash-step]');
        const times = [...(form?.querySelectorAll('input[type="time"]') ?? [])].map((input) => input.value);
        return form?.querySelector('input[type="date"]')?.value === ${JSON.stringify(values.day)} && JSON.stringify(times) === ${JSON.stringify(JSON.stringify([values.from, values.to]))};
      })()`))
      await page.clickOn('[data-clash-step] button', 'Move')
    }),
    step('end: LifeOS moved the event and Agenda names the new clash', async (context) => {
      const { pair, folder } = context
      let moved: Event | undefined
      let target: Event | undefined
      await pair.page.until('the local event to move onto the cupboard event', 7000, async () => {
        const rows = await events(context)
        moved = rows.find(({ title }) => title === MOVED_EVENT)
        target = rows.find(({ title }) => title === NEXT_CLASH)
        return moved && target && moved.startsAt === target.startsAt && moved.endsAt === target.endsAt
      })
      await pair.page.until('the new clash beside the moved event', 8000, () => pair.page.eval(`[...document.querySelectorAll(${JSON.stringify(AGENDA + ' [role="listitem"]')})]
        .some((row) => row.innerText.includes(${JSON.stringify(MOVED_EVENT)}) && row.innerText.includes(${JSON.stringify(NEXT_CLASH)}) &&
          !row.innerText.includes(${JSON.stringify(FIRST_CLASH)}))`))
      writeFileSync(join(folder, 'clash.json'), JSON.stringify({ moved, target }, null, 2))
    })
  ]
})
