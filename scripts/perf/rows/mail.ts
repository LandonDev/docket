import { MAIL_LIST, MAIL_PANE } from '../../journeys/lib/lifeosJourney'
import { FIRST_MAIL, SECOND_MAIL } from '../../journeys/lib/lifeosSeed'
import { COMPOSE } from '../../journeys/lib/mailJourney'
import { thrice, type PerfCtx, type Row } from '../lib/row'

const option = (subject: string): string => `${MAIL_LIST} [role="option"][aria-label*=${JSON.stringify(subject)}]`
const openIs = (subject: string): string => `document.querySelector(${JSON.stringify(MAIL_PANE + ' h2')})?.textContent.trim() === ${JSON.stringify(subject)}`

async function select(ctx: PerfCtx, subject: string): Promise<void> {
  await ctx.pair.showWork(ctx.workspace, 'Mail')
  await ctx.page.clickOn(option(subject))
  await ctx.page.until(subject + ' open', 20_000, () => ctx.page.eval(openIs(subject)))
}

const mailOpen: Row = {
  id: 'mail-open',
  title: 'Open a mail from the list: to its subject and body in the pane',
  needs: { sandbox: true },
  run: (ctx) => thrice(ctx, () => ({
    region: MAIL_PANE,
    usable: `${openIs(FIRST_MAIL)} && document.querySelector(${JSON.stringify(MAIL_PANE)}).innerText.includes(${JSON.stringify('Here are the notes for ' + FIRST_MAIL)})`,
    press: () => ctx.page.clickOn(option(FIRST_MAIL))
  }), () => select(ctx, SECOND_MAIL))
}

const composer: Row = {
  id: 'mail-composer',
  title: 'Press Reply on an open mail: to a composer he can type in',
  needs: { sandbox: true },
  run: (ctx) => thrice(ctx, () => ({
    region: MAIL_PANE,
    usable: `!!document.querySelector(${JSON.stringify(COMPOSE + ' .tiptap[contenteditable]')})?.getClientRects().length`,
    press: () => ctx.page.clickOn(MAIL_PANE + ' button.mail-reply-row')
  }), async (i) => {
    // An open composer is left by Escape; an unwritten reply keeps nothing.
    if (i > 0) await ctx.page.key('Escape')
    await select(ctx, i % 2 ? SECOND_MAIL : FIRST_MAIL)
  }).finally(() => ctx.page.key('Escape').catch(() => undefined))
}

export const MAIL_ROWS: Row[] = [mailOpen, composer]
