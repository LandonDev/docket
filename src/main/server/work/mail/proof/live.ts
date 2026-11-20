import { execFileSync } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import { check, failed, note, Proof, sleep, textOf, until, type Inst } from '../../lifeos/proof/harness'

/**
 * Milestone 23's done-when against real LifeOS: one mail, from the owner's
 * own account to his own address, subject "TempCode test, please ignore".
 * One isolated windowed instance under xvfb, signed in with a token minted
 * for this proof (read from a 0600 file, never printed). No model turn: the
 * thread's draft, its task and its rewrite are made through the thread's own
 * LifeOS add-on (`app.addonCall`), as milestone 7 did; the owner's part
 * (take the rewrite, edit, Send) is pressed in the window over CDP.
 *
 * The design pass added two things. The held draft's Send now waits in the
 * window: the proof presses Send, presses Undo inside the wait and sees that
 * nothing went, then presses Send again, lets the wait run out, and reads
 * from LifeOS that the mail went on his press and waited once, not twice.
 * Then a second mail, designed (a white page on a tinted ground, a picture
 * from the web), goes from his own account to his own address by his own
 * `compose:send`, comes back through Gmail, and is opened in the Mail view:
 * its picture must paint from the bytes LifeOS's worker fetched, in a frame
 * that asked the network for nothing.
 *
 * Shots of the test mails go to `OUT` (the reader's pane alone for the
 * second); the Mail view's list, which shows real mail, is looked at and
 * never written to disk.
 *
 * Run from the worktree after `electron-vite build`:
 *   env -u ELECTRON_RUN_AS_NODE bun src/main/server/work/mail/proof/live.ts /tmp/m23-live/box.token <out dir>
 */

const REAL = 'https://lifeos.landonhale.com'
const TOKEN = readFileSync(process.argv[2] ?? '/tmp/m23-live/box.token', 'utf8').trim()
const OUT = process.argv[3] ?? '/tmp/m23-live/shots'
const SUBJECT = 'TempCode test, please ignore'
const FIRST = 'A test from TempCode milestone 23, sent to myself. Please ignore it.'
const REWRITE = 'A test from TempCode milestone 23, sent from my own account to my own address. Please ignore it.'
const EDIT = ' Edited in the test.'
/** The designed mail: its subject, a picture any browser may fetch, and a stamp that finds it again. */
const DESIGNED = 'TempCode picture test, please ignore'
const PICTURE = 'https://www.gstatic.com/images/branding/googlelogo/2x/googlelogo_color_92x30dp.png'
const STAMP = `proof-${Date.now()}`
const PORT = 9283
/** Only with M23_SEND=1 is Send pressed: a dry run stops before it and discards the draft. */
const SEND = process.env.M23_SEND === '1'
class DryRun extends Error {}
mkdirSync(OUT, { recursive: true })

type Tool = { content: { type: string; text?: string }[]; isError?: boolean }
const proof = new Proof()
/** The server's local socket, as the window learns it (`window.api.getServerPort`): a windowed instance writes no server.json. */
let serverPort = 0
/** One request on the local socket (the implicit admin), its params sent as given: the window's link would drop an undeclared `appToken`. */
function call<T>(method: string, params: unknown = {}, timeoutMs = 120_000): Promise<T> {
  const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/`)
  const id = `m23-${Math.random().toString(36).slice(2)}`
  return new Promise<T>((ok, fail) => {
    const timer = setTimeout(() => (ws.close(), fail(new Error(`no answer to ${method}`))), timeoutMs)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id, method, params })))
    ws.addEventListener('message', (ev) => {
      const frame = JSON.parse(String(ev.data)) as { id?: string; ok?: boolean; result?: T; error?: string }
      if (frame.id !== id) return
      clearTimeout(timer)
      ws.close()
      if (frame.ok) ok(frame.result as T)
      else fail(new Error(frame.error))
    })
    ws.addEventListener('error', () => (clearTimeout(timer), fail(new Error(`socket error on ${method}`))))
  })
}
/** The owner's client with a JWT asked for now: a LifeOS deploy in the middle of a run can leave an older one refused. */
async function fresh(client: ConvexHttpClient): Promise<ConvexHttpClient> {
  const answer = await call<{ ok: boolean; jwt?: string }>('work.lifeos.jwt', {})
  if (answer.jwt) client.setAuth(answer.jwt)
  return client
}
/** The app bridge's key for this instance (TEMP_CODE_APP_TOKEN_SEED), so the proof can speak as a thread with that thread's own token. */
const SEED = randomBytes(32).toString('hex')
const appToken = (sessionId: string): string => createHmac('sha256', Buffer.from(SEED, 'hex')).update(`app-bridge:${sessionId}`).digest('base64url')
const tool = (sessionId: string, name: string, args: Record<string, unknown> = {}) => call<Tool>('app.addonCall', { sessionId, appToken: appToken(sessionId), tool: `lifeos__${name}`, arguments: args })
const json = <T>(r: Tool): T => JSON.parse(textOf(r)) as T
interface Status {
  lifeos: { state: string; ownerId?: string }
  keys: { workspaceId: string; sectors: string[]; state: string; addonId?: string }[]
}

type Cdp = { eval<T>(e: string): Promise<T>; send(m: string, p?: Record<string, unknown>): Promise<unknown>; close(): void }
let cdp: Cdp | null = null

/** The window's page over the debug port (the global WebSocket). */
async function attach(port: number, ms: number): Promise<Cdp> {
  const end = Date.now() + ms
  let url: string | undefined
  while (!url && Date.now() < end) {
    const list = (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => [])) as { type: string; url: string; webSocketDebuggerUrl?: string }[]
    url = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools:'))?.webSocketDebuggerUrl
    if (!url) await sleep(500)
  }
  if (!url) throw new Error('no page on the debug port')
  const ws = new WebSocket(url)
  await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = fail)))
  let n = 0
  const waiting = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>()
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } }
    const w = m.id !== undefined ? waiting.get(m.id) : undefined
    if (!w) return
    waiting.delete(m.id!)
    if (m.error) w.fail(new Error(m.error.message))
    else w.ok(m.result)
  }
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<unknown>((ok, fail) => {
      const id = ++n
      waiting.set(id, { ok, fail })
      ws.send(JSON.stringify({ id, method, params }))
    })
  return {
    send,
    async eval<T>(expression: string): Promise<T> {
      const r = (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })) as { result: { value?: T }; exceptionDetails?: { text: string } }
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
      return r.result.value as T
    },
    close: () => ws.close()
  }
}
const page = <T>(e: string): Promise<T> => cdp!.eval<T>(e)
const has = (text: string) => page<boolean>(`document.body.textContent.includes(${JSON.stringify(text)})`)
/** Opens a thread in the window: by id, then its row and its tab in the strip, whichever the window takes. */
async function showThread(id: string, title: string): Promise<void> {
  await page(`window.__monocode.open(${JSON.stringify(id)})`)
  await sleep(1500)
  // Its row in the column, pressed as a pointer does.
  await press(`[...document.querySelectorAll('aside button, aside [role=button], aside a')].find((e) => e.textContent.trim() === ${JSON.stringify(title)})`)
  await sleep(2000)
  note(`tabs: ${await page<string>(`JSON.stringify([...document.querySelectorAll('[role=tab]')].map((t) => [t.textContent.trim().slice(0, 30), t.getAttribute('aria-selected')]))`)}`)
}
/** A real press (pointer down and up) at the middle of what `find` names, a JS expression for one element. */
async function press(find: string): Promise<boolean> {
  const at = await page<{ x: number; y: number } | null>(`(() => { const el = ${find}; if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  if (!at) return false
  await cdp!.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y })
  for (const type of ['mousePressed', 'mouseReleased'] as const) await cdp!.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 })
  return true
}
const byText = (text: string, last = false) => `(() => { const all = [...document.querySelectorAll('button')].filter((e) => e.textContent.trim() === ${JSON.stringify(text)} && !e.disabled); return ${last ? 'all.at(-1)' : 'all[0]'} })()`
async function shot(name: string): Promise<void> {
  for (const light of [false, true]) {
    await page(`document.documentElement.classList.toggle('theme-light', ${light})`)
    await sleep(400)
    const { data } = (await cdp!.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
    writeFileSync(join(OUT, `${name}.${light ? 'light' : 'dark'}.png`), Buffer.from(data, 'base64'))
  }
  await page(`document.documentElement.classList.toggle('theme-light', false)`)
  note(`shot ${name}`)
}

let draftId: string | null = null
let sent = false
let box: Inst | null = null
let owner: ConvexHttpClient | null = null
let taskId: string | null = null
let helperId: string | null = null
let designedId: string | null = null
let designedThread: string | null = null
const workspaces: string[] = []
try {
  const inst = await proof.instance('box')
  box = inst
  proof.launch(inst, { platform: 'linux', env: { TEMP_CODE_HEADLESS: '0', TEMP_CODE_DEBUG_PORT: String(PORT), TEMP_CODE_APP_TOKEN_SEED: SEED } })
  cdp = await attach(PORT, 120_000)
  const up = await until('window connected', 120_000, () => page<boolean>(`window.__monocode?.registry?.statusOf?.(window.__monocode.registry.primaryEnvironmentId)?.transport === 'open'`))
  if (!check('the instance is up', up)) throw new Error(proof.logOf(inst).slice(-2000))
  serverPort = (await page<number | null>('window.api.getServerPort()')) ?? 0
  await cdp.send('Page.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await call('work.set', { enabled: true })

  const signed = await call<Status>('work.lifeos.setToken', { token: TOKEN })
  check('signed in with the minted token', signed.lifeos.state === 'connected', JSON.stringify(signed.lifeos))
  const all = await call<{ ok: boolean; jwt?: string }>('work.lifeos.jwt', {})
  const own = new ConvexHttpClient(REAL, { logger: false })
  own.setAuth(all.jwt!)
  owner = own

  // His own mailbox, never Purdue's, preferring Life.
  const accounts = (await (await fresh(own)).query(makeFunctionReference<'query'>('mail:accounts'), {})) as { _id: string; address: string; provider: string; defaultSector?: string }[]
  const usable = accounts.filter((a) => a.provider !== 'outlook-forwarded' && a.defaultSector && a.defaultSector !== 'purdue')
  const mine = usable.find((a) => a.defaultSector === 'life') ?? usable[0]
  if (!check('a mailbox of his own outside Purdue', !!mine)) throw new Error('no mailbox')
  const sector = mine!.defaultSector!
  const other = sector === 'ref' ? 'unify' : 'ref'
  note(`mailbox in ${sector}; the fence is checked from ${other}`)

  const ws = await call<{ id: string; name: string }>('workspace.create', { kind: 'work', sector, name: 'm23 proof' })
  workspaces.push(ws.id)
  const ws2 = await call<{ id: string }>('workspace.create', { kind: 'work', sector: other, name: 'm23 proof fence' })
  workspaces.push(ws2.id)
  const ready = await until('keys ready', 120_000, async () => {
    const s = await call<Status>('work.lifeos.status', {})
    const ids = [ws.id, ws2.id].map((id) => s.keys.find((k) => k.workspaceId === id)?.addonId)
    if (ids.some((id) => !id)) return false
    const l = await call<{ status: Record<string, { state: string }> }>('addons.list', {})
    return ids.every((id) => l.status[id!]?.state === 'ready')
  })
  check("both workspaces' keys and add-ons are ready", ready)

  held: {
  // `M23_ONLY=designed` runs the designed mail's part alone, so a rerun of it sends no second held mail.
  if (process.env.M23_ONLY === 'designed') break held
  // The task the thread is about, made by a Work thread of the workspace, and the thread started from it.
  const helper = await call<{ id: string }>('session.create', { provider: 'claude', workspaceId: ws.id, threadType: 'chat', permission: 'auto', title: 'm23 proof helper' })
  const task = json<{ id: string }>(await tool(helper.id, 'add_task', { sector, title: 'Answer the TempCode test mail', reason: 'm23 proof: completed by the send', key: `m23-${Date.now()}` }))
  helperId = helper.id
  taskId = task.id
  const thread = await call<{ id: string; scope?: string }>('session.create', {
    provider: 'claude',
    workspaceId: ws.id,
    threadType: 'chat',
    permission: 'auto',
    title: 'TempCode test mail',
    // A thread with no message draws the new-thread layout, which has no canvas; this one's turn fails at
    // once (the instance has no model sign-in), so no model runs and the mail is made through its key.
    firstMessage: 'Draft the TempCode test mail to me.',
    about: { kind: 'task', label: 'Answer the TempCode test mail', ref: { at: 'lifeos', table: 'tasks', id: task.id } }
  })
  check('the thread is a Work thread started from the task', thread.scope === 'work')
  // The helper's part is done; the thread itself reads the task from here on.
  await call('session.delete', { sessionId: helper.id }).catch((e: Error) => note(`helper: ${e.message.slice(0, 120)}`))
  helperId = thread.id

  // The thread drafts.
  const drafted = await tool(thread.id, 'draft_mail', { account_id: mine!._id, to: [{ address: mine!.address }], subject: SUBJECT, body: FIRST, reason: 'm23 proof: the one test mail, to himself' })
  if (!check('the thread drafted the mail', !drafted.isError, drafted.isError ? textOf(drafted).slice(0, 200) : '')) throw new Error('no draft')
  draftId = (json<{ id?: string; draftId?: string }>(drafted).id ?? json<{ draftId?: string }>(drafted).draftId)!
  const row0 = (await (await fresh(own)).query(makeFunctionReference<'query'>('compose:get'), { id: draftId })) as { row: { origin?: { threadId?: string; host?: string }; sector?: string } }
  check("the host stamped the thread's origin on it", row0.row.origin?.threadId === thread.id, JSON.stringify(row0.row.origin))

  const item = await until('canvas item', 30_000, async () => {
    const list = await call<{ items: { kind: string; source: { id?: string } }[] }>('work.canvas.list', { sessionId: thread.id })
    return list.items.some((i) => i.kind === 'mail' && i.source.id === draftId)
  })
  check('the draft opened as a mail item beside the thread', item)
  const held = await until('held', 30_000, async () => {
    const list = await call<{ items: { kind: string; ref: { id?: string } }[] }>('work.outbox.list', {})
    return list.items.some((i) => i.kind === 'mail.send' && i.ref.id === draftId)
  })
  check('the draft is held in the Outbox', held)

  // The fence, and the key that cannot send.
  const fence = await call<{ id: string }>('session.create', { provider: 'claude', workspaceId: ws2.id, threadType: 'chat', permission: 'auto', title: 'm23 proof fence' })
  const theirs = await tool(fence.id, 'list_mail_drafts')
  check(`a thread in ${other} does not see the draft`, !textOf(theirs).includes(draftId), theirs.isError ? 'refused' : 'listed without it')
  const poke = await tool(fence.id, 'update_mail_draft', { id: draftId, body: 'not yours', reason: 'm23 proof: must be refused' })
  check(`a thread in ${other} cannot rewrite it`, poke.isError === true, textOf(poke).slice(0, 160))
  const send = await tool(thread.id, 'send_mail', { draft_id: draftId, reason: 'm23 proof: must be refused' })
  check("the thread's key cannot send it", send.isError === true, textOf(send).slice(0, 160))

  // The window: the thread with its mail beside it.
  await showThread(thread.id, 'TempCode test mail')
  check('the window shows the draft in the composer beside the thread', await until('composer', 45_000, () => page<boolean>(`!!document.querySelector('.mail-editor .tiptap') && document.querySelector('.mail-editor .tiptap').textContent.includes(${JSON.stringify(FIRST.slice(0, 30))})`)))
  await sleep(1500)
  await shot('01-draft-beside-thread')

  // The Outbox shows it as it goes.
  if (await page<boolean>(`(() => { const el = [...document.querySelectorAll('button, a, [role=button], [role=link]')].find((e) => /^Outbox\\d*$/.test(e.textContent.trim())); if (!el) return false; el.click(); return true })()`)) {
    await until('outbox row', 15_000, () => has(SUBJECT))
    await sleep(1500)
    check("the Outbox shows mail's own view", await until('act view', 15_000, () => page<boolean>(`[...document.querySelectorAll('dt')].some((d) => d.textContent === 'Subject')`)))
    await shot('02-outbox-held')
    // Back to the thread: the workspace's row in the rail, else the Outbox row again, else a reload.
    const leave = [
      () => press(`[...document.querySelectorAll('nav button, nav a, aside button, [role=button]')].find((e) => e.textContent.trim() === 'm23 proof' && e.getBoundingClientRect().left < 200)`),
      () => press(`[...document.querySelectorAll('button, a, [role=button], [role=link]')].find((e) => /^Outbox\\d*$/.test(e.textContent.trim()))`),
      () => page('location.reload()').then(() => sleep(6000))
    ]
    let back = false
    for (const step of leave) {
      await step().catch(() => null)
      await sleep(1500)
      await showThread(thread.id, 'TempCode test mail')
      back = await until('composer again', 15_000, () => page<boolean>(`(() => { const el = document.querySelector('.mail-editor .tiptap'); if (!el) return false; const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.left + 10, r.top + 10); return !!top && el.contains(top) })()`))
      if (back) break
    }
    if (!check('back on the thread with its draft', back)) throw new Error('could not leave the Outbox')
  } else note('no Outbox row to click; the Outbox shot is not taken')

  // The agent's rewrite waits in the draft; he takes it.
  const proposed = await tool(thread.id, 'update_mail_draft', { id: draftId, body: REWRITE, reason: 'm23 proof: a rewrite to take' })
  check('the thread proposed a rewrite', !proposed.isError, textOf(proposed).slice(0, 160))
  check('the rewrite shows as words taken and put in, with the stepper', await until('rewrite', 30_000, async () => (await has('sent from my own account')) && (await page<boolean>(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Accept')`))))
  await sleep(800)
  await shot('03-rewrite-waiting')
  await press(byText('Accept', true))
  const taken = await until('taken', 30_000, () => page<boolean>(`document.querySelector('.mail-editor .tiptap')?.textContent.includes('sent from my own account') ?? false`))
  check('Accept took it into the draft and the composer came back with it', taken)

  // He edits, then presses Send.
  await page(`(() => { const el = document.querySelector('.mail-editor .tiptap'); el.focus(); const r = document.createRange(); const p = el.querySelector('p') ?? el; r.selectNodeContents(p); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r) })()`)
  await cdp.send('Input.insertText', { text: EDIT })
  await sleep(1500)
  await shot('04-edited')
  if (!SEND) throw new DryRun()
  const settings = (await (await fresh(own)).query(makeFunctionReference<'query'>('settings:get'), {})) as { mail?: { undoSeconds?: number } }
  const undoMs = (settings.mail?.undoSeconds ?? 10) * 1000
  const statusNow = async () => ((await (await fresh(own)).query(makeFunctionReference<'query'>('compose:get'), { id: draftId })) as { row: { status: string } } | null)?.row.status

  // Send, then Undo inside the wait: nothing has gone, and nothing goes.
  check('Send pressed in the composer', await press(byText('Send', true)))
  check('the window says it is sending, with Undo', await until('sending toast', 8_000, async () => (await has('Sending to')) && (await page<boolean>(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Undo')`))))
  await shot('05-sending-with-undo')
  check('while it waits LifeOS still holds a draft', (await statusNow()) === 'draft', String(await statusNow()))
  check('Undo pressed', await press(byText('Undo', true)))
  await sleep(undoMs + 4000)
  check('after Undo, and past the undo time, nothing was sent', (await statusNow()) === 'draft', String(await statusNow()))
  check('the draft is back in the composer with his words', await until('composer back', 20_000, () => page<boolean>(`document.querySelector('.mail-editor .tiptap')?.textContent.includes(${JSON.stringify(EDIT.trim())}) ?? false`)))
  const heldStill = await call<{ items: { ref: { id?: string }; state: string }[] }>('work.outbox.list', {})
  check('the Outbox still holds it', heldStill.items.some((i) => i.ref.id === draftId && i.state === 'held'))

  // Send again, and let the wait run out.
  const pressedAt = Date.now()
  check('Send pressed again', await press(byText('Send', true)))
  await sleep(Math.max(0, undoMs - 3000))
  check('three seconds before the wait ends, still a draft', (await statusNow()) === 'draft', String(await statusNow()))
  const gone = await until('sent', 180_000, async () => {
    const r = (await (await fresh(own)).query(makeFunctionReference<'query'>('compose:get'), { id: draftId })) as { row: { status: string } } | null
    return r?.row.status === 'sent'
  })
  const after = (await (await fresh(own)).query(makeFunctionReference<'query'>('compose:get'), { id: draftId })) as { row: { status: string; sentFrom?: string; cause?: string; sendAt?: number; message: { text: string; to: { address: string }[] } } }
  sent = ['queued', 'sending', 'sent'].includes(after.row.status)
  check('LifeOS sent it', gone, after.row.status)
  check('LifeOS records the press as the owner\'s, from this host\'s session', after.row.cause === 'press' && !!after.row.sentFrom, JSON.stringify({ sentFrom: after.row.sentFrom, cause: after.row.cause }))
  // Due once the window's wait ended, not a second undo time after it: LifeOS did not queue it again.
  check('the mail waited once: due when the window\'s wait ended', after.row.sendAt !== undefined && after.row.sendAt - pressedAt < undoMs + 7000, `${(after.row.sendAt ?? 0) - pressedAt} ms after the press, undo ${undoMs} ms`)
  check('what went is his edit of the rewrite, to his own address only', after.row.message.text.includes('sent from my own account') && after.row.message.text.includes(EDIT.trim()) && after.row.message.to.every((a) => a.address === mine!.address))
  const decided = await call<{ items: { ref: { id?: string }; state: string; decidedBy: string | null }[] }>('work.outbox.list', { show: 'all' })
  const rowHere = decided.items.find((i) => i.ref.id === draftId)
  check('the hold recorded it Sent, decided by the owner', rowHere?.state === 'sent' && rowHere.decidedBy === 'owner', JSON.stringify(rowHere && { state: rowHere.state, decidedBy: rowHere.decidedBy }))
  const done = await until('task', 30_000, async () => {
    const t = await tool(thread.id, 'get_task', { id: task.id })
    const text = textOf(t)
    return /"state":\s*"done"/.test(text)
  })
  // get_task does not print the completion's thread link; LifeOS's activity log names the send as the reason.
  check('the linked task completed at the send', done, done ? '' : textOf(await tool(thread.id, 'get_task', { id: task.id })).slice(0, 300))
  await sleep(2000)
  await shot('06-sent')
  }

  // A designed mail to himself, by his own send: a white page on a tinted ground, with a picture from the web.
  const designed =
    `<table width="100%" cellpadding="0" cellspacing="0" bgcolor="#f1f5f9" style="background:#f1f5f9"><tr><td align="center" style="padding:24px">` +
    `<table width="480" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="background:#ffffff;font-family:Helvetica,Arial,sans-serif;color:#0f172a"><tr><td style="padding:24px">` +
    `<img src="${PICTURE}" width="92" height="30" alt="A logo"><h1 style="font-size:20px;margin:16px 0 8px">A designed test mail</h1>` +
    `<p style="margin:0">Sent by the TempCode mail proof to myself. Please ignore it. ${STAMP}</p></td></tr></table></td></tr></table>`
  designedId = (await (await fresh(own)).mutation(makeFunctionReference<'mutation'>('compose:send'), {
    message: { kind: 'mail', accountId: mine!._id, to: [{ address: mine!.address }], cc: [], bcc: [], subject: DESIGNED, html: designed, text: `A designed test mail. Sent by the TempCode mail proof to myself. Please ignore it. ${STAMP}`, mode: 'new', attachments: [], forwardParts: [] },
    cause: 'press'
  })) as string
  type Found = { _id: string; subject: string }
  const search = async () => ((await (await fresh(own)).query(makeFunctionReference<'query'>('mail:search'), { text: STAMP })) as Found[]).filter((t) => t.subject === DESIGNED)
  const arrived = await until('the designed mail back from Gmail', 240_000, async () => (await search()).length > 0)
  if (!check('the designed mail came back through Gmail into LifeOS', arrived)) throw new Error('the designed mail did not arrive')
  designedThread = (await search())[0]!._id

  // The Mail view, in the window: found by its stamp, opened, its picture painted from bytes.
  const named = await page<boolean>(`(() => { const el = [...document.querySelectorAll('aside button, nav button')].find((b) => b.textContent.trim() === 'm23 proof'); if (!el) return false; el.click(); return true })()`)
  // The row reads "Mail" with its unread count after it.
  const mailRow = `[...document.querySelectorAll('aside button, aside [role=button], aside a')].find((e) => /^Mail(\\s|\\d|$)/.test(e.textContent.trim()))`
  if (!check('the workspace opened from the rail', named) || !check('its Mail view opened', await until('Mail row', 20_000, () => press(mailRow)))) {
    note(`rail rows: ${await page<string>(`JSON.stringify([...document.querySelectorAll('aside button, aside [role=button], aside a')].map((e) => e.textContent.trim().slice(0, 24)).filter(Boolean).slice(0, 40))`)}`)
    throw new Error('could not open the Mail view')
  }
  check('the Mail view lists the sector\'s mail', await until('mail list', 45_000, () => page<boolean>(`document.querySelectorAll('.tc-mail [role=option]').length > 0`)))
  await sleep(500)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: '/', text: '/', windowsVirtualKeyCode: 191 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '/', windowsVirtualKeyCode: 191 })
  check('the / key put the caret in the search field', await until('search field', 10_000, () => page<boolean>(`document.activeElement?.getAttribute('aria-label') === 'Search mail'`)))
  await cdp.send('Input.insertText', { text: STAMP })
  const ROW = `[...document.querySelectorAll('.tc-mail [role=listbox][aria-label="Search results"] [role=option]')].find((r) => r.getAttribute('aria-label')?.includes(${JSON.stringify(DESIGNED)}))`
  check('search finds it by its stamp', await until('search result', 30_000, () => page<boolean>(`!!(${ROW})`)))
  check('its row opened it', await press(ROW))
  const FRAME = `document.querySelector('.tc-mail [data-mail-pane] iframe[data-mail]')`
  check('the reader drew it on its own white page', await until('frame', 30_000, () => page<boolean>(`!!${FRAME}?.contentDocument?.documentElement?.hasAttribute('data-designed')`)))
  const painted = await until('picture', 90_000, () => page<boolean>(`(() => { const img = ${FRAME}?.contentDocument?.querySelector('img[data-pic]'); return !!img && img.src.startsWith('blob:') && img.complete && img.naturalWidth > 0 })()`))
  check('its picture painted from bytes LifeOS fetched: a blob, never the sender\'s address', painted, await page<string>(`(() => { const img = ${FRAME}?.contentDocument?.querySelector('img[data-pic]'); return img ? img.src.slice(0, 40) + ' ' + img.naturalWidth : 'no picture' })()`))
  check('the frame holds no address of the web', await page<boolean>(`!/https?:\\/\\/(?!www\\.w3\\.org)/.test(${FRAME}.srcdoc.replace(/<a [^>]*>/g, ''))`))
  check('the frame may run nothing and open nothing', (await page<string>(`${FRAME}.getAttribute('sandbox')`)) === 'allow-same-origin')
  await sleep(800)
  // The pane alone: the list beside it shows real mail.
  const pane = await page<{ x: number; y: number; width: number; height: number }>(`(() => { const r = document.querySelector('.tc-mail [data-mail-pane]').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`)
  const { data } = (await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...pane, scale: 1 } })) as { data: string }
  writeFileSync(join(OUT, '07-designed-read-back.png'), Buffer.from(data, 'base64'))
  note('shot 07-designed-read-back (the reader\'s pane alone)')

} catch (err) {
  if (err instanceof DryRun) note('dry run: Send was not pressed')
  else check('the proof ran to its end', false, err instanceof Error ? err.message.slice(0, 400) : String(err))
} finally {
  // Cleanup, in order: what did not go, the run's workspaces (the host revokes their keys), the keys
  // still live, then the sign-out (which revokes the device session).
  const names = box ? keyNames(box) : []
  if (box && !names.length) note(`no key names found; data dir holds ${readdirSync(box.data).join(', ')}`)
  if (box && owner) {
    await fresh(owner).catch(() => null)
    if (draftId && !sent) await owner.mutation(makeFunctionReference<'mutation'>('compose:discard'), { id: draftId }).then(() => note('the unsent draft was discarded'), (e: Error) => note(`discard: ${e.message.slice(0, 160)}`))
    if (taskId && helperId && !sent) await tool(helperId, 'drop_tasks', { ids: [taskId], reason: 'm23 proof: cleanup' }).catch(() => null)
    // The designed test mail has done its work: out of his inbox, into Trash (30 days there; Gmail's copy is left archived).
    if (designedThread) await owner.mutation(makeFunctionReference<'mutation'>('mail:trash'), { id: designedThread }).then(() => note('the designed test mail went to Trash'), (e: Error) => note(`mail:trash: ${e.message.slice(0, 160)}`))
    else if (designedId) note(`the designed mail ${designedId} was sent but never seen back; it is in his own mailbox`)
    for (const id of workspaces) await call('workspace.delete', { workspaceId: id }).catch((e: Error) => note(`workspace.delete: ${e.message.slice(0, 160)}`))
    const live = async () => ((await (await fresh(owner!)).query(makeFunctionReference<'query'>('bots:list'), {})) as { _id: string; name: string; revokedAt?: number }[]).filter((b) => b.revokedAt === undefined && names.includes(b.name))
    await until('keys revoked', 60_000, async () => (await live()).length === 0).catch(() => false)
    for (const bot of await live().catch(() => [])) await owner.mutation(makeFunctionReference<'mutation'>('bots:revoke'), { id: bot._id }).catch((e: Error) => note(`bots:revoke: ${e.message.slice(0, 160)}`))
    // Keys of earlier runs of this proof that their own cleanup missed: named for its workspaces.
    const all = ((await owner.query(makeFunctionReference<'query'>('bots:list'), {}).catch(() => [])) as { _id: string; name: string; revokedAt?: number; _creationTime?: number }[]).filter((b) => b.revokedAt === undefined)
    for (const bot of all.filter((b) => /^TempCode [^:]+: m23 proo/.test(b.name))) await owner.mutation(makeFunctionReference<'mutation'>('bots:revoke'), { id: bot._id }).then(() => note(`revoked an earlier run's ${bot.name.replace(/[0-9a-f]{6,}$/, '<hex>')}`), () => {})
    const since = Number(process.env.M23_SINCE ?? 0)
    for (const bot of all.filter((b) => b.name.includes('Work Cha') && (b._creationTime ?? 0) >= since && !names.includes(b.name))) note(`live Work Chats key made since the first run: ${bot._id} at ${new Date(bot._creationTime ?? 0).toISOString()}`)
    const left = await live().catch(() => null)
    check(`every key this run minted is retired (${names.length})`, left !== null && left.length === 0, JSON.stringify(left?.map((b) => b.name)))
    writeFileSync('/tmp/m23-live/key-names.txt', names.join('\n'))
    await call('work.lifeos.signOut', {}).catch((e: Error) => note(`signOut: ${e.message.slice(0, 160)}`))
  }
  cdp?.close()
  await proof.close()
  note(draftId ? `draft ${draftId}, ${sent ? 'sent' : 'not sent (discarded)'}` : 'no draft made')
  console.log(failed() ? `${failed()} FAILED` : 'ALL PASS')
  process.exit(failed() ? 1 : 0)
}

/** The LifeOS keys this instance minted, by name, from its own database. */
function keyNames(inst: Inst): string[] {
  const names = new Set<string>()
  for (const file of readdirSync(inst.data).filter((f) => f.endsWith('.db'))) {
    try {
      for (const line of execFileSync('sqlite3', [join(inst.data, file), 'SELECT bot_name FROM work_lifeos_keys'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')) if (line.trim()) names.add(line.trim())
    } catch {
      /* not the app's database */
    }
  }
  return [...names]
}
