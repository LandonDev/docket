import { join } from 'node:path'
import { FIRST_MAIL, SECOND_MAIL } from './lib/lifeosSeed'
import { draftReply, evidence, HELD_ACT, heldMail, mailbox, MAIL_LIST, MAIL_PANE, openMail, see, wordsIn } from './lib/lifeosJourney'
import { COMPOSE, composeRow, mailToast, readReply, startReply, type MailRow } from './lib/mailJourney'
import { journey, step, type Context } from './lib/record'
import { createThread } from './lib/thread'

const REPLY = 'I will bring a spare sign-in sheet.'
const HELD = 'I will leave the room map at the desk.'
const ZONE = 'America/Chicago'
type TimedRow = MailRow & { suggestedSend?: { at: number; zone?: string } }
const state = new WeakMap<Context, TimedRow>()

export function scheduledWords(line: string, at?: number): boolean {
  if (!/Scheduled for [^\n]*\bCentral(?=\b|Undo)/.test(line) || /\bSending\b/.test(line)) return false
  if (at === undefined) return true
  const clock = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hour: 'numeric', minute: '2-digit' }).format(at)
  return line.includes(clock + ' Central')
}

export function keptSchedule(queued: TimedRow, draft: TimedRow): boolean {
  return draft._id === queued._id && draft.status === 'draft' && !draft.scheduled &&
    draft.sendAt === undefined && draft.suggestedSend?.at === queued.sendAt && draft.suggestedSend?.zone === ZONE
}

async function schedule(context: Context): Promise<void> {
  const { page } = context.pair
  await page.clickOn(`${COMPOSE} button[aria-label="More ways to send"]`)
  await page.press('menuitem', 'Pick date and time…')
  await page.clickOn('[aria-label="Time zone"]')
  await page.clickOn('[role="option"]', 'Central')
  await page.watchToasts()
  await page.clickOn('[data-slot="popover-content"] button', 'Schedule')
  await mailToast(context, 'Scheduled for ')
  if (!(await page.toasts(true)).some((line) => scheduledWords(line))) throw new Error('The schedule toast omitted Central time or claimed Sending')
}

async function listed(context: Context, view: 'scheduled' | 'drafts', id: string, subject: string) {
  const { pair } = context
  const label = view === 'scheduled' ? 'Scheduled' : 'Drafts'
  await mailbox(pair.page, label)
  await see(pair.page, `${MAIL_LIST} ul[aria-label="${label}"]`, subject)
  const rows = await pair.sandbox!.query<TimedRow[]>('compose:list', { view })
  const row = rows.find((row) => row._id === id && row.message.subject === subject)
  if (!row) throw new Error('The same reply was absent from LifeOS ' + label)
  return row
}

export default journey({
  id: 'J34', title: 'Schedule an owner reply and a held reply in Central time', tier: 2, shapes: ['S'],
  steps: [
    step('Schedule an owner reply in Central time and read its thread foot', async (context) => {
      const { page } = context.pair
      await startReply(context, SECOND_MAIL, REPLY)
      await readReply(context, SECOND_MAIL, REPLY, 'draft', 'draft')
      await schedule(context)
      const row = await readReply(context, SECOND_MAIL, REPLY, 'scheduled', 'queued')
      if (!row.scheduled || row.sendZone !== ZONE || !row.sendAt || row.sendAt <= Date.now()) throw new Error('LifeOS did not schedule the reply in Central time')
      state.set(context, row)
      await page.until('the Central time in the scheduled thread foot', 8000, async () => {
        const time = await page.eval<string>(`document.querySelector('[data-mail-pane] button[aria-label^="Scheduled for "]')?.getAttribute('aria-label') ?? ''`)
        return scheduledWords(time, row.sendAt) && !/\bSending\b/.test(await wordsIn(page, MAIL_PANE)) &&
          !!await page.centre(MAIL_PANE + ' button', 'Send now') &&
          !!await page.centre(MAIL_PANE + ' button', 'Edit') &&
          !!await page.centre(MAIL_PANE + ' button', 'Cancel send')
      })
      await page.shot(join(context.folder, 'scheduled-thread-foot.png'))
    }),
    step('Find the owner reply in Scheduled and cancel it into Drafts with its time kept', async (context) => {
      const { pair, folder } = context
      const queued = state.get(context)!
      const subject = 'Re: ' + SECOND_MAIL
      await listed(context, 'scheduled', queued._id, subject)
      await pair.page.shot(join(folder, 'scheduled-mail.png'))
      await pair.page.clickOn(`${MAIL_LIST} ul[aria-label="Scheduled"] button span`, subject)
      await pair.page.clickOn(MAIL_PANE + ' button', 'Cancel send')
      const draft = await readReply(context, SECOND_MAIL, REPLY, 'cancelled', 'draft') as TimedRow
      if (!keptSchedule(queued, draft)) throw new Error('Cancel did not keep the same draft and its Central time')
      await listed(context, 'drafts', draft._id, subject)
      evidence(context, 'owner-cancel', { queued, draft })
    }),
    step('Schedule a thread’s held reply from the open draft', async (context) => {
      const { pair, workspace } = context
      const mail = await openMail(context, FIRST_MAIL)
      const thread = await createThread(pair, workspace.id, 'Spring LAN held schedule')
      const id = await draftReply(context, thread.id, mail._id, HELD)
      await heldMail(context, id, 'Dana Lee')
      await pair.showWork(workspace, 'Mail')
      await listed(context, 'drafts', id, 'Re: ' + FIRST_MAIL)
      await pair.page.clickOn(`${MAIL_LIST} ul[aria-label="Drafts"] button span`, 'Re: ' + FIRST_MAIL)
      await schedule(context)
      const queued = await readReply(context, FIRST_MAIL, HELD, 'held scheduled', 'queued')
      if (queued._id !== id || !queued.scheduled || queued.sendZone !== ZONE) throw new Error('The held draft lost its identity or scheduled time')
      state.set(context, queued)
    }),
    step('end: the scheduled held reply offers Cancel and refuses Send and Discard', async (context) => {
      const { pair, folder } = context
      const queued = state.get(context)!
      const ref = { at: 'lifeos', table: 'outbox', id: queued._id }
      await pair.page.clickOn('nav [data-rail-row] > button > span.truncate', 'Outbox')
      await pair.page.press('tab', 'Waiting')
      await pair.page.clickOn(HELD_ACT, 'Send to Dana Lee')
      const pane = '[data-outbox-detail]'
      await pair.page.until('the scheduled held row with Cancel send', 8000, async () =>
        scheduledWords(await wordsIn(pair.page, pane), queued.sendAt) && !!await pair.page.centre(pane + ' button', 'Cancel send'))
      if (await pair.page.centre(pane + ' button', 'Send') || await pair.page.centre(pane + ' button', 'Discard')) throw new Error('Outbox offered Send or Discard for a scheduled row')
      const item = await pair.rpc<{ updatedAt: number }>(pair.box, 'work.outbox.get', { ref })
      const send = await pair.fromWindow('work.outbox.send', { ref, rev: item.updatedAt })
      const discard = await pair.fromWindow('work.outbox.discard', { ref })
      for (const reply of [send, discard]) if (reply.ok || !reply.error.includes('You scheduled this')) throw new Error('An Outbox press did not refuse the scheduled row')
      const row = await composeRow(context, queued._id)
      if (!row.scheduled || row.sendAt !== queued.sendAt) throw new Error('A refused press changed the scheduled row')
      await pair.page.shot(join(folder, 'scheduled-held.png'))
      evidence(context, 'scheduled-held', { row, send, discard })
      await pair.page.clickOn(pane + ' button', 'Cancel send')
      const draft = await readReply(context, FIRST_MAIL, HELD, 'held cancelled', 'draft') as TimedRow
      if (!keptSchedule(queued, draft)) throw new Error('Outbox Cancel lost the draft or its time')
    })
  ]
})
