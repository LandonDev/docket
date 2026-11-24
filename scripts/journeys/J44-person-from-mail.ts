import { evidence, MAIL_PANE, newThread, openMail, see, sendPrompt } from './lib/lifeosJourney'
import { FIRST_MAIL, SECTOR } from './lib/lifeosSeed'
import { journey, step, type Context } from './lib/record'
import { hostRows } from './lib/thread'

const NAME = 'Dana Lee'
const EMAIL = 'dana@example.com'
const PEOPLE = '[role="region"][aria-label="People"]'
const state = new WeakMap<Context, string>()

export default journey({
  id: 'J44', title: 'Open the sender’s People page and start a thread about them', tier: 2, shapes: ['S'],
  steps: [
    step('Open Dana from the mail’s sender and read her People page', async (context) => {
      const { pair } = context
      const mail = await openMail(context, FIRST_MAIL)
      const people = await pair.sandbox!.query<{ _id: string; name: string }[]>('people:directory', { sector: SECTOR })
      const person = people.find(({ name }) => name === NAME)
      if (!person) throw new Error('LifeOS has no Dana Lee for this workspace')
      const info = await pair.sandbox!.query('people:page', { id: person._id, sector: SECTOR })
      if (!JSON.stringify(info).includes(EMAIL)) throw new Error('The People page does not match the sender')
      evidence(context, 'known-sender', { mail, info })
      await pair.page.clickOn(MAIL_PANE + ' button[aria-label=' + JSON.stringify('Open ' + NAME) + ']')
      await see(pair.page, PEOPLE, EMAIL)
      state.set(context, person._id)
    }),
    step('end: the new Work thread keeps the sender’s person chip', async (context) => {
      const { pair } = context
      await pair.page.clickOn(PEOPLE + ' button', 'New thread')
      await see(pair.page, '[data-composer]', NAME)
      const id = await newThread(context, () => sendPrompt(pair.page, 'Check with Dana about the room'))
      await see(pair.page, '[data-sent-chips]', NAME)
      let rows: { payload: string }[] = []
      await pair.page.until('the person chip in the host thread transcript', 5000, async () => {
        rows = await hostRows(pair, 'SELECT payload FROM events WHERE session_id=? AND payload LIKE ?', id, '%' + state.get(context) + '%')
        return rows.length > 0
      })
      evidence(context, 'thread', { id, personId: state.get(context) })
    })
  ]
})
