import { DEFAULT_LEVEL } from '../../src/shared/work/digest'
import type { DigestList, DigestSettings } from '../../src/shared/contract-work-digest'
import { composeRow } from './lib/mailJourney'
import { addon, evidence, see } from './lib/lifeosJourney'
import { SECTOR } from './lib/lifeosSeed'
import { journey, step, type Context } from './lib/record'
import { createThread } from './lib/thread'

const state = new WeakMap<Context, { id: string; title: string; start: number }>()
const list = ({ pair }: Context) => pair.rpc<DigestList>(pair.box, 'work.digest.list')

export function toldOnce(rows: DigestList['rows'], kind: string, match: (row: DigestList['rows'][number]) => boolean): boolean {
  const found = rows.filter((row) => row.kind === kind && match(row))
  return found.length === 1 && found[0]?.toldAt != null
}

async function openToast(context: Context, title: string): Promise<void> {
  const { page } = context.pair
  let selected: { x: number; y: number } | null = null
  await page.until('Open in the toast for ' + title, 8000, async () => {
    selected = await page.eval(`(() => {
      const toast = [...document.querySelectorAll('[data-sonner-toast]')].find((item) => item.innerText.includes(${JSON.stringify(title)}));
      const button = toast?.querySelector('button[data-action]');
      const r = button?.getBoundingClientRect();
      if (!r?.width) return null;
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      return button.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
    })()`)
    return selected
  })
  await page.click(selected!)
}

export default journey({
  id: 'J50', title: 'Hear a held item and a deadline once and open the deadline', tier: 2, shapes: ['S', 'A'],
  steps: [
    step('Hold a draft and seed a meeting inside the digest’s reminder window', async (context) => {
      const { pair, workspace } = context
      const cloud = pair.sandbox!
      const { levels } = await pair.rpc<DigestSettings>(pair.box, 'work.digest.get')
      await pair.rpc(pair.box, 'work.digest.set', { levels: { held: 'now', meetings: 'now' } })
      pair.later(async () => {
        if (pair.abort.signal.aborted) return
        await pair.rpc(pair.box, 'work.digest.set', { levels: { held: levels.held ?? DEFAULT_LEVEL, meetings: levels.meetings ?? DEFAULT_LEVEL } })
      })
      const accounts = await cloud.query<{ _id: string; address: string }[]>('mail:accounts')
      const account = accounts.find(({ address }) => address === 'spring-lan@example.org')
      if (!account) throw new Error('The sandbox has no Spring LAN mailbox')
      const heldTitle = 'Spare power for ' + workspace.name
      const session = await createThread(pair, workspace.id, 'Spring LAN digest draft')
      const { id } = await addon<{ id: string }>(context, session.id, 'draft_mail', {
        account_id: account._id, to: [{ name: 'Dana Lee', address: 'dana@example.com' }],
        subject: heldTitle, body: 'The spare power strip is ready.', reason: 'A sandbox draft for the owner'
      })
      pair.later(async () => {
        if (pair.abort.signal.aborted) return
        await pair.rpc(pair.box, 'work.outbox.discard', { ref: { at: 'lifeos', table: 'outbox', id } })
      })
      const row = await composeRow(context, id)
      if (row.status !== 'draft') throw new Error('The digest draft was not held')
      const start = Date.now() + 8 * 60_000
      const title = 'Spring LAN check ' + workspace.name
      const retire = await cloud.seedDeadline(title, start)
      pair.later(async () => {
        if (!pair.abort.signal.aborted) await retire()
      })
      state.set(context, { id, title, start })
      await pair.page.until('the held item’s single digest toast', 15_000, async () =>
        (await pair.page.toasts()).filter((line) => line.includes(heldTitle) && line.includes('Open')).length === 1)
      const rows = (await list(context)).rows
      if (!toldOnce(rows, 'outbox.held', (row) => row.workspaceId === workspace.id && row.title.includes(heldTitle))) throw new Error('The digest did not keep one telling for the held draft')
      evidence(context, 'held-notice', { row, notice: rows.filter((row) => row.title.includes(heldTitle)) })
      await pair.page.shot(context.folder + '/held-notice.png')
    }),
    step('end: the deadline has one notice, and Open goes to its meeting', async (context) => {
      const { pair, workspace } = context
      const { id, title, start } = state.get(context)!
      const { page } = pair
      await page.until('the meeting’s single deadline toast', 375_000, async () =>
        (await page.toasts()).filter((line) => line.includes(title + ' starts at') && line.includes('Open')).length === 1)
      const before = await list(context)
      const event = (await pair.sandbox!.query<{ _id: string; title: string; startsAt: number }[]>('events:range', { sector: SECTOR, from: Date.now(), to: start + 3_600_000 })).find((row) => row.title === title)
      if (!event || event.startsAt !== start) throw new Error('LifeOS has no meeting that matches the deadline')
      const key = 'prep:' + event._id + ':' + start
      const deadline = (row: DigestList['rows'][number]) => row.key === key && row.by === start && row.workspaceId === workspace.id
      if (!toldOnce(before.rows, 'prep.starting', deadline)) throw new Error('The digest did not keep one telling for the deadline')
      await page.shot(context.folder + '/deadline-notice.png')
      await openToast(context, title + ' starts at')
      await see(page, '[role="region"][aria-label="Meeting"]', title)
      await page.until('the opened deadline toast to leave', 6000, async () => !(await page.toasts()).some((line) => line.includes(title + ' starts at')))
      const after = await list(context)
      const first = before.rows.find(deadline)
      const last = after.rows.find(deadline)
      if (first?.id !== last?.id || first?.toldAt !== last?.toldAt || (await composeRow(context, id)).status !== 'draft') {
        throw new Error('Opening the deadline retold it or changed the held draft')
      }
      evidence(context, 'opened-deadline', { event, first, last })
    })
  ]
})
