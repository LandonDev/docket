import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mailThread, type MailRow } from './mailJourney'
import type { Context } from './record'
import { hostRows } from './thread'
import type { Window } from './window'

export const PAGE = { numItems: 30, cursor: null }
export const MAIL_PANE = '[data-mail-pane]'
export const MAIL_LIST = '[data-mail-list]'
export const MAIL_MENU = MAIL_LIST + ' button[aria-haspopup="menu"]'
export const OUTBOX = 'nav [data-rail-row] > button > span.truncate'
export const INPUT = '[data-composer-input]'

export function evidence(context: Context, name: string, value: unknown): void {
  writeFileSync(join(context.folder, name + '.json'), JSON.stringify(value, null, 2) + '\n')
}

export function wordsIn(page: Window, selector: string): Promise<string> {
  return page.eval(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`)
}

export async function see(page: Window, selector: string, words: string): Promise<void> {
  await page.until(words, 12_000, async () => (await wordsIn(page, selector)).includes(words))
}

export async function mailbox(page: Window, box: string): Promise<void> {
  await page.clickOn(MAIL_MENU)
  await mailMenuItem(page, box)
}

export async function mailMenuItem(page: Window, label: string): Promise<void> {
  let point: { x: number; y: number } | null = null
  await page.until(label + ' in the mail menu', 5000, async () => {
    point = await page.eval(`(() => {
      const item = [...document.querySelectorAll('[role="menuitem"]')].find((row) => [...row.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim() === ${JSON.stringify(label)}
      ));
      const r = item?.getBoundingClientRect();
      if (!r?.width) return null;
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      return item.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
    })()`)
    return point
  })
  await page.click(point!)
}

export async function openMail(context: Context, subject: string) {
  const { pair, workspace } = context
  const { page } = pair
  await pair.showWork(workspace, 'Mail')
  await page.until('the Mail list', 10_000, () => page.centre(MAIL_MENU))
  const current = await wordsIn(page, MAIL_MENU)
  if (!current.trim().startsWith('Inbox')) await mailbox(page, 'Inbox')
  await page.clickOn(`${MAIL_LIST} [role="option"][aria-label*=${JSON.stringify(subject)}]`)
  await see(page, MAIL_PANE + ' h2', subject)
  return mailThread(context, subject)
}

export async function storedText(context: Context, url: string | null | undefined): Promise<string> {
  if (!url || new URL(url).origin !== context.pair.sandbox!.url) throw new Error('The attachment URL is outside the sandbox')
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error('The sandbox did not return the attachment bytes')
  return response.text()
}

export function sessions(context: Context): Promise<{ id: string; title: string; scope: string; workspace_id: string }[]> {
  return hostRows(context.pair, 'SELECT id,title,scope,workspace_id FROM sessions WHERE workspace_id=? ORDER BY created_at DESC', context.workspace.id)
}

export async function newThread(context: Context, press: () => Promise<void>, check = (_: Awaited<ReturnType<typeof sessions>>[number]) => true): Promise<string> {
  const before = new Set((await sessions(context)).map(({ id }) => id))
  await press()
  let found: Awaited<ReturnType<typeof sessions>>[number] | undefined
  await context.pair.page.until('the new Work thread on box', 15_000, async () =>
    (found = (await sessions(context)).find((row) => row.scope === 'work' && !before.has(row.id) && check(row))))
  return found!.id
}

export async function sendPrompt(page: Window, words: string, scope = '[data-composer]'): Promise<void> {
  await page.clickOn(scope + ' ' + INPUT)
  await page.typeKeys(words)
  await page.clickOn(scope + ' button', 'Send')
}

export async function addon<T>(context: Context, sessionId: string, tool: string, args: object): Promise<T> {
  const { pair, workspace } = context
  await pair.page.until('the sandbox LifeOS add-on to be ready', 20_000, async () => {
    const { keys } = await pair.rpc<{ keys: { workspaceId: string; addonId?: string }[] }>(pair.box, 'work.lifeos.status')
    const id = keys.find((key) => key.workspaceId === workspace.id)?.addonId
    if (!id) return false
    const { status } = await pair.rpc<{ status: Record<string, { state: string }> }>(pair.box, 'addons.list')
    return status[id]?.state === 'ready'
  })
  const result = await pair.rpc<{ isError?: boolean; content: { text?: string }[] }>(pair.box, 'app.addonCall', {
    sessionId, tool: 'lifeos__' + tool, arguments: args
  }, 20_000)
  const text = result.content.map((part) => part.text ?? '').join('\n')
  if (result.isError) throw new Error(tool + ': ' + text)
  return JSON.parse(text) as T
}

export async function draftReply(context: Context, sessionId: string, threadId: string, body: string): Promise<string> {
  const { id } = await addon<{ id: string }>(context, sessionId, 'draft_mail', {
    thread_id: threadId, body, reason: 'Follow up on the Spring LAN arrangements'
  })
  if (!id) throw new Error('The sandbox draft tool returned no id')
  return id
}

export async function heldMail(context: Context, id: string, recipient: string): Promise<void> {
  const { pair } = context
  await pair.page.clickOn(OUTBOX, 'Outbox')
  await pair.page.press('tab', 'Waiting')
  const rows = '[data-outbox-list] section[aria-label=' + JSON.stringify(context.workspace.name) + '] [data-row-title]'
  await pair.page.clickOn(rows, 'Send to ' + recipient)
  await pair.page.until('the matching draft in the host Outbox feed', 8000, async () =>
    (await pair.sandbox!.query<MailRow[]>('outboxHeld:held', { host: pair.box.host })).some((row) => row._id === id && row.status === 'draft'))
}

export async function checkLink(context: Context, table: string, id: string, sessionId: string) {
  let rows: { threadId: string }[] = []
  await context.pair.page.until('the LifeOS link to the Work thread', 8000, async () => {
    rows = await context.pair.sandbox!.query('workLinks:byEntity', { entity: { table, id } })
    return rows.some((row) => row.threadId === sessionId)
  })
  return rows
}
