import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from './record'

export async function composeRow(context: Context, id: string): Promise<MailRow> {
  const found = await context.pair.sandbox!.query<{ row: MailRow } | null>('compose:get', { id })
  if (!found) throw new Error('The LifeOS mail row is gone')
  return found.row
}

export const COMPOSE = '[aria-label="Compose"]'
const EDITOR = `${COMPOSE} .tiptap[contenteditable]`
const MAIL_TOAST = '[data-sonner-toast]'

type Thread = { _id: string; subject: string; unread: boolean }
export type MailRow = {
  _id: string
  status: string
  scheduled?: boolean
  sendAt?: number
  sendZone?: string
  message: { text: string; subject: string }
}

export async function mailThread(context: Context, subject: string): Promise<Thread> {
  const { page } = await context.pair.sandbox!.query<{ page: Thread[] }>('mail:threads', {
    paginationOpts: { numItems: 30, cursor: null }
  })
  const thread = page.find((row) => row.subject === subject)
  if (!thread) throw new Error('The sandbox has no mail titled ' + subject)
  return thread
}

export async function startReply(context: Context, subject: string, reply: string): Promise<void> {
  const { pair, workspace } = context
  const { page } = pair
  await pair.showWork(workspace, 'Mail')
  await page.clickOn(`[data-mail-list] [role="option"][aria-label*=${JSON.stringify(subject)}]`)
  await page.until('the open mail and its body', 10_000, () => page.eval(`(() => {
    const pane = document.querySelector('[data-mail-pane]');
    return pane?.querySelector('h2')?.textContent.trim() === ${JSON.stringify(subject)} &&
      pane.innerText.includes(${JSON.stringify('Here are the notes for ' + subject + '.')});
  })()`))
  await page.until('the message marked read in LifeOS', 5000, async () => !(await mailThread(context, subject)).unread)
  await page.clickOn('[data-mail-pane] button.mail-reply-row')
  await page.clickOn(EDITOR)
  await page.typeKeys(reply)
}

export async function readReply(context: Context, subject: string, reply: string, phase: string, status: string): Promise<MailRow> {
  const { pair, folder } = context
  const { _id } = await mailThread(context, subject)
  let row: MailRow | undefined
  await pair.page.until(`the LifeOS reply row in ${status}`, 5000, async () => {
    const rows = await pair.sandbox!.query<MailRow[]>('compose:forThread', { threadId: _id })
    row = rows.find(({ message }) => message.text.trim() === reply)
    return row?.status === status
  })
  appendFileSync(join(folder, 'mail-rows.jsonl'), JSON.stringify({ phase, ...row }) + '\n')
  return row!
}

export async function mailToast(context: Context, prefix: string): Promise<void> {
  const { page } = context.pair
  await page.until('the ' + prefix + ' toast', 5000, async () => (await page.toasts(true)).some((toast) => toast.startsWith(prefix)))
}

export async function undoMail({ pair, folder }: Context, sendAt: number): Promise<void> {
  const { page } = pair
  const selector = `${MAIL_TOAST}[data-visible="true"] button[data-action]`
  let previous: { x: number; y: number } | null = null
  await page.until('the Undo button to finish moving', Math.min(4000, sendAt - Date.now()), async () => {
    const point = await page.centre(selector, 'Undo')
    const stable = point && previous && Math.abs(point.x - previous.x) < 1 && Math.abs(point.y - previous.y) < 1
    previous = point
    return stable
  })
  await page.eval(`(() => {
    window.__journeyUndoClick = null;
    const button = [...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => el.textContent.trim() === 'Undo');
    button?.addEventListener('click', () => window.__journeyUndoClick = Date.now(), { once: true });
  })()`)
  await page.click(previous!)
  const clicked = await page.eval<number | null>('window.__journeyUndoClick')
  appendFileSync(join(folder, 'undo.jsonl'), JSON.stringify({ clicked, sendAt }) + '\n')
  if (clicked === null || clicked >= sendAt) throw new Error('The Undo click did not reach the button inside the countdown')
}
