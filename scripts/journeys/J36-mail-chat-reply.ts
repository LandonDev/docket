import type { MailChatFound } from '../../src/shared/contract-work-mail'
import { COMPOSE, composeRow, type MailRow } from './lib/mailJourney'
import { evidence, MAIL_PANE, newThread, openMail, see, sendPrompt } from './lib/lifeosJourney'
import { journey, step, type Context } from './lib/record'
import { hostRows } from './lib/thread'

const SUBJECT = 'Spring LAN cables'
const PROMPT = 'Draft a reply about the spare cables'
const REPLY = 'I will bring two spare cables to the east room.'
const DOCK = '[data-mail-dock-seat]'
const CARD = DOCK + ' [data-mail-offer="draft"]'
const state = new WeakMap<Context, { id: string; sessionId: string }>()

export default journey({
  id: 'J36', title: 'Ask beside a mail, hold the draft, and approve it', tier: 2, shapes: ['S'],
  steps: [
    step('Ask from the mail dock and hold the reply through the thread’s tools', async (context) => {
      const { pair, workspace } = context
      await pair.page.resize(1680)
      pair.later(() => pair.page.resize(1280))
      const mail = await openMail(context, SUBJECT)
      pair.fakeMailReply = { prompt: PROMPT, threadId: mail._id, body: REPLY }
      try {
        await pair.page.clickOn(MAIL_PANE + ' button', 'Ask')
        const sessionId = await newThread(context, () => sendPrompt(pair.page, PROMPT, DOCK))
        await see(pair.page, DOCK, PROMPT)
        const found = await pair.rpc<MailChatFound>(pair.box, 'work.mail.chat.find', { workspaceId: workspace.id, mailThreadId: mail._id })
        if (!found.sessionIds.includes(sessionId)) throw new Error('The thread was not adopted by the mail dock')
        let row: MailRow | undefined
        await pair.page.until('the held reply from the mail chat’s draft tool', 25_000, async () => {
          const drafts = await pair.sandbox!.query<MailRow[]>('outboxHeld:held', { host: pair.box.host })
          row = drafts.find((draft) => draft.message.text === REPLY && draft.status === 'draft')
          return row
        })
        await see(pair.page, CARD, REPLY)
        await see(pair.page, CARD + ' [data-draft-state]', 'Draft')
        state.set(context, { id: row!._id, sessionId })
        await pair.page.shot(context.folder + '/offered-draft.png')
        evidence(context, 'offered-draft', { sessionId, row })
      } finally {
        pair.fakeMailReply = undefined
      }
    }),
    step('end: put the offered draft in reply and approve that same row', async (context) => {
      const { pair } = context
      const { id, sessionId } = state.get(context)!
      try {
        await pair.page.clickOn(CARD + ' button', 'Put in reply')
      } catch (error) {
        const [dock, host, draft] = await Promise.allSettled([
          pair.page.eval(`(() => {
            const seat = document.querySelector(${JSON.stringify(DOCK)});
            const thread = window.__monocode.sessionStore.get(${JSON.stringify(sessionId)});
            return {
              id: seat?.querySelector('[data-mail-dock]')?.getAttribute('data-mail-dock'),
              loading: seat?.querySelector('[data-transcript-loading]')?.getAttribute('data-transcript-loading'),
              loaded: thread?.loaded, phase: thread?.load?.phase, blocks: thread?.blocks.length
            };
          })()`),
          hostRows(pair, 'SELECT status, (SELECT count(*) FROM events WHERE session_id = sessions.id) AS events FROM sessions WHERE id = ?', sessionId),
          composeRow(context, id)
        ])
        evidence(context, 'unavailable-draft-control', { sessionId, dock, host, draft })
        throw error
      }
      await see(pair.page, COMPOSE, REPLY)
      if ((await composeRow(context, id)).status !== 'draft') throw new Error('Putting the reply in Mail changed the held row')
      await pair.page.clickOn(COMPOSE + ' button', 'Send')
      await pair.page.until('the same reply queued in LifeOS', 20_000, async () => (await composeRow(context, id)).status === 'queued')
      await see(pair.page, MAIL_PANE, 'Sending')
      await pair.page.until('the approved reply shown in its mail frame', 12_000, () => pair.page.eval(`
        [...document.querySelectorAll(${JSON.stringify(MAIL_PANE + ' iframe[data-mail]')})].some((frame) =>
          frame.srcdoc.includes(${JSON.stringify(REPLY)}) && frame.getBoundingClientRect().height > 0 && getComputedStyle(frame).opacity === '1')
      `))
      await pair.page.shot(context.folder + '/approved.png')
      evidence(context, 'approved', { row: await composeRow(context, id), threadFoot: 'Sending', toasts: await pair.page.toasts() })
    })
  ]
})
