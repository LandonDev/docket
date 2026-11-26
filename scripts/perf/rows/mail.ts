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

/** A reply's editor in the pane: the one Reply opens (Compose) or a kept draft's, labelled otherwise. */
const COMPOSER = MAIL_PANE + ' .tiptap[contenteditable]'
const MAIL_MENU = '[data-mail-menu]'
/** A press on an element found by its words, in the page. */
const pointAt = (selector: string, starts: string): string => `(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.getClientRects().length && e.textContent.trim().startsWith(${JSON.stringify(starts)}));
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
})()`
const scheduled = `document.querySelector(${JSON.stringify(MAIL_PANE)})?.innerText.includes('Cancel send') && !document.querySelector(${JSON.stringify(COMPOSER)})`

/** A reply scheduled by the last press taken back: the toast's Undo, else the pane's Cancel send; the composer back with his words. */
async function undoLater(ctx: PerfCtx): Promise<void> {
  if (!await ctx.page.eval(scheduled)) return
  await ctx.page.until('Undo, or Cancel send', 15_000, async () => {
    const at = await ctx.page.eval<{ x: number; y: number } | null>(pointAt('[data-sonner-toast] button', 'Undo')) ?? await ctx.page.eval<{ x: number; y: number } | null>(pointAt(MAIL_PANE + ' button', 'Cancel send'))
    if (at) await ctx.page.click(at)
    return !!at
  })
  await ctx.page.until('the scheduled reply taken back', 15_000, async () => !await ctx.page.eval(scheduled))
}

/**
 * Send later on the sandbox (B19): a reply's "Tomorrow morning" in the send menu, pressed to its line in the thread
 * (Send now, Edit, Cancel send). Each press is taken back with Undo before the next and after the last, so nothing is
 * left scheduled; the sandbox LifeOS alone, and his press alone, as the hold asks.
 */
const sendLater: Row = {
  id: 'mail-send-later',
  title: 'Send later on a reply (Tomorrow morning): the menu item pressed to its scheduled line',
  needs: { sandbox: true },
  run: async (ctx) => {
    await select(ctx, FIRST_MAIL)
    try {
      return await thrice(ctx, async () => {
        await undoLater(ctx)
        // A reply left open by the row before counts: its editor's middle may sit under "Show quoted text", so it is
        // found and focused, not clicked.
        const open = `!!document.querySelector(${JSON.stringify(COMPOSER)})?.getClientRects().length`
        // After Undo the reply comes back as a kept draft, its editor drawn once LifeOS hands the draft back.
        const reply = `!!document.querySelector(${JSON.stringify(MAIL_PANE + ' button.mail-reply-row')})`
        await ctx.page.until('a reply open, or Reply', 20_000, async () => await ctx.page.eval(open) || await ctx.page.eval(reply))
        if (!await ctx.page.eval(open)) {
          await ctx.page.clickOn(MAIL_PANE + ' button.mail-reply-row')
          await ctx.page.until('the composer', 20_000, () => ctx.page.eval(open))
        }
        if (!(await ctx.page.eval<string>(`document.querySelector(${JSON.stringify(COMPOSER)})?.innerText ?? ''`)).trim()) {
          await ctx.page.eval(`document.querySelector(${JSON.stringify(COMPOSER)}).focus()`)
          await ctx.page.typeKeys('Thanks')
        }
        await ctx.page.clickOn('button', 'More ways to send')
        const at = await ctx.page.steadyPoint('Tomorrow morning', () => ctx.page.eval(pointAt(MAIL_MENU + ' [role="menuitem"]', 'Tomorrow morning')), 10_000)
        return { region: MAIL_PANE, usable: scheduled, press: () => ctx.page.click(at), wait: 20_000 }
      })
    } finally {
      await undoLater(ctx).catch(() => undefined)
      await ctx.page.dismissPopups().catch(() => undefined)
    }
  }
}

export const MAIL_ROWS: Row[] = [mailOpen, composer, sendLater]
