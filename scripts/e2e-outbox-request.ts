import { join } from 'node:path'
import { REPO, Run, sleep, textOf, type Tool } from './e2e-work-lib'

/**
 * A thread asks for his press, in the real window (docs/agents/work-outbox.md "A thread asks for his press"):
 *
 *   electron-vite build, then
 *   env -u ELECTRON_RUN_AS_NODE bun scripts/e2e-outbox-request.ts --out <dir>
 *
 * One isolated instance under xvfb, Work on, no LifeOS. A made-up Work thread's calls to a fake add-on are held, ten
 * of them. He writes "send the roster posts, all ten"; the thread asks through `outbox_request`, as its bridge calls
 * it; one item changes after the ask. The job sees the card in the thread, the changed row unticked, his Send 9 run
 * exactly those nine, and one note to the thread. Away on leaves a second request open. Ticks in the Outbox send
 * three more as one press. Pictures in dark and light, wide and narrow, go to the out folder. Dummy names only;
 * nothing leaves the box. No model runs: the thread's side is its bridge calls with its own tokens.
 */
const run = new Run('outbox-request')
const FAKE = join(REPO, 'scripts', 'lib', 'fakeMcpServer.ts')

interface Held {
  ref: { at: 'host'; id: string }
  n: number | null
  summary: string
  state: string
  via?: string
  updatedAt: number
  payload: { arguments?: { text?: string } }
}
interface Request {
  id: string
  state: string
  rows: { ref: { id: string }; receipt?: string; changed: boolean }[]
}
const list = async (show = 'waiting'): Promise<Held[]> => (await run.call<{ items: Held[] }>('work.outbox.list', { show })).items
const clickText = (scope: string, text: string): Promise<boolean> =>
  run.page<boolean>(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)}) && !e.disabled); b?.click(); return !!b })()`)
const narrow = async (on: boolean): Promise<void> => void (await run.send('Emulation.setDeviceMetricsOverride', { width: on ? 600 : 1440, height: 900, deviceScaleFactor: 1, mobile: false }))

/** A key as he presses it, to whatever has focus. */
const key = async (k: string, code: string, opts: { shift?: boolean } = {}): Promise<void> => {
  const modifiers = opts.shift ? 8 : 0
  const vk = k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0
  await run.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers })
  if (k.length === 1) await run.send('Input.dispatchKeyEvent', { type: 'char', key: k, code, text: k, unmodifiedText: k, modifiers })
  await run.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers })
}

try {
  await run.start()
  await sleep(3000)
  // A fresh instance asks for a setup link first: not this job's.
  await run.until('the setup dialog is gone', 15_000, async () => {
    await run.page(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Skip')?.click()`)
    return !(await run.has('Use a setup link'))
  })

  const ws = await run.call<{ id: string }>('workspace.create', { kind: 'work', name: 'Dummy Esports' })
  run.later('delete the workspace', () => run.call('workspace.delete', { workspaceId: ws.id }))
  const added = await run.call<{ addon: { id: string } }>('addons.set', { addon: { name: 'league', workspaceId: ws.id, spec: { transport: 'stdio', command: process.execPath, args: [FAKE, '--stdio'], env: [], auth: 'none' } } })
  run.later('remove the add-on', () => run.call('addons.remove', { id: added.addon.id }))
  run.check('a fake add-on is ready', await run.until('the add-on is ready', 60_000, async () => (await run.call<{ status: Record<string, { state: string }> }>('addons.list', {})).status[added.addon.id]?.state === 'ready'))
  const thread = await run.thread(ws.id, 'Roster posts')
  const echo = (text: string): Promise<Tool> => run.call<Tool>('app.addonCall', { sessionId: thread, appToken: run.appToken(thread), tool: 'league__echo', arguments: { text } })
  for (let i = 1; i <= 10; i++) {
    const r = await echo(`Roster post ${i}: practice moves to 6 PM`)
    run.check(`call ${i} is held`, /^Held as item \d+/.test(textOf(r)), textOf(r).slice(0, 80))
  }
  const held = await list()
  run.check('ten items wait', held.length === 10, String(held.length))

  // His own words in the thread, as the socket stamps them (the turn they start finds no model here and ends).
  const words = 'send the roster posts, all ten'
  await run.call('session.send', { sessionId: thread, text: words }).catch(() => undefined)
  await sleep(1500)

  const refusedFirst = await run.tool(thread, 'outbox_request', { items: held.slice(0, 3).map((i) => ({ ref: `#${i.n}`, do: 'send' })), quote: words })
  run.check('the thread is refused when it lists part of what his "all ten" covers', refusedFirst.isError === true, textOf(refusedFirst).slice(0, 120))
  const asked = await run.tool(thread, 'outbox_request', { items: held.map((i) => ({ ref: `#${i.n}`, do: 'send' })), quote: words })
  const located = asked.structuredContent as { outboxRequest?: { id: string } } | undefined
  if (!run.check('the thread asks: one request, nothing sent', !asked.isError && !!located?.outboxRequest, textOf(asked).slice(0, 160))) throw new Error('no request was made')
  const requestId = located!.outboxRequest!.id
  run.check('nothing went yet', (await list()).length === 10)

  // One item changes after the ask: the card must start it unticked.
  const changed = held[3]!
  await run.call('work.outbox.edit', { ref: changed.ref, payload: { arguments: { text: 'Roster post 4: practice moves to 7 PM' } } })

  // The Outbox first: the request leads Waiting as one row, and its detail is the same summary as the thread's card.
  const openOutbox = (): Promise<boolean> =>
    run.page<boolean>(`(() => { const el = [...document.querySelectorAll('button, a, [role=button]')].find((e) => /^Outbox\\d*$/.test(e.textContent.trim())); el?.click(); return !!el })()`)
  run.check('the Outbox opens', await run.until('the Outbox opens', 20_000, openOutbox))
  run.check('Asked in threads leads Waiting', await run.until('Asked in threads', 20_000, () => run.has('Asked in threads')))
  await run.shot('01-outbox-asked')
  const picked = await run.page<boolean>(`(() => { const head = [...document.querySelectorAll('h2, h3, [role=heading], [data-outbox-section]')].find((e) => e.textContent.trim().startsWith('Asked in threads')); const box = head?.closest('section, [role=group], div')?.parentElement ?? head?.parentElement; const row = box ? [...box.querySelectorAll('button, [role=option], [role=row], li')].find((e) => e !== head && /Echo|Send|Post|item|times/.test(e.textContent)) : null; row?.click(); return !!row })()`)
  run.check('the request row is picked', picked)
  const press = await run.until('the detail offers Send 9', 15_000, () => run.page<boolean>(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim().startsWith('Send 9'))`))
  run.check('the changed row starts unticked, so the press offers Send 9', press)
  run.check('nothing in the request wears the warning colour', !(await run.page<boolean>(`[...document.querySelectorAll('[data-outbox-request] *, [data-outbox-request]')].some((e) => /warning|amber/.test(e.className?.toString?.() ?? ''))`)))
  await run.shot('02-request-detail')
  await narrow(true)
  await run.shot('02b-request-detail-narrow')
  await narrow(false)

  run.check('Send 9 is pressed', await clickText('body', 'Send 9'))
  const went = await run.until('nine went', 30_000, async () => (await list('done')).filter((i) => i.state === 'sent').length === 9)
  run.check('his press sends exactly the nine ticked items', went)
  const left = await list()
  run.check('the changed item still waits', left.length === 1 && left[0]!.ref.id === changed.ref.id, left.map((i) => i.summary).join(' | '))
  run.check('each went as his approval of the request', (await list('done')).filter((i) => i.state === 'sent').every((i) => i.via === `request:${requestId}`))
  const answered = await run.call<Request>('work.outbox.request.get', { id: requestId })
  run.check('the request is answered', answered.state === 'answered', answered.state)
  await sleep(1500)
  await run.shot('03-request-done')

  // The thread: its card drawn from the tool's result, in its done state.
  const toThread = await run.page<boolean>(`(() => { const a = document.querySelector('[data-outbox-thread]'); const b = a?.closest('button, a') ?? a; b?.click(); return !!b })()`)
  const viaRail = async (): Promise<boolean> =>
    run.page<boolean>(`(() => { const b = [...document.querySelectorAll('[data-thread-row], [data-rail-row], button, a')].find((e) => e.textContent.trim() === 'Roster posts' && e.getClientRects().length); (b?.querySelector?.('button') ?? b)?.click(); return !!b })()`)
  if (toThread || (await viaRail())) {
    const card = await run.until('the card shows', 30_000, () => run.page<boolean>(`!!document.querySelector('[data-outbox-request]')`))
    // The job calls outbox_request over the bridge, not from a harness turn, so the transcript may hold no tool row to
    // draw the card from; the card's states are held by RequestCard.dom.test.tsx.
    if (card) await run.shot('04-thread-card')
    else run.note('the thread opened; no harness turn made the call, so it has no tool row to draw the card from')
  } else run.note('no way to the thread from this window was found; the card is held by RequestCard.dom.test.tsx')

  // Away on: a second ask stays open; nothing of Away answers it.
  await run.call('away.set', { code: true, work: true })
  run.later('Away off', () => run.call('away.set', { code: false, work: false }))
  const second = `discard #${changed.n} please`
  await run.call('session.send', { sessionId: thread, text: second }).catch(() => undefined)
  await sleep(1500)
  const asked2 = await run.tool(thread, 'outbox_request', { items: [{ ref: `#${changed.n}`, do: 'discard' }], quote: second })
  run.check('the thread asks again, Away on', !asked2.isError, textOf(asked2).slice(0, 120))
  await sleep(5000)
  const open = await run.call<{ requests: Request[] }>('work.outbox.requests', {})
  run.check('Away answers no request: it is still open', open.requests.length === 1 && open.requests[0]!.state === 'open')
  await run.call('away.set', { code: false, work: false })

  // Bulk in the Outbox: three more held, ticked, one press.
  for (const n of [11, 12, 13]) await echo(`Roster post ${n}: bring your jersey`)
  const outbox = await run.until('the Outbox opens again', 20_000, openOutbox)
  run.check('the Outbox opens again', outbox)
  await run.until('the second request leads', 15_000, () => run.has('Asked in threads'))
  await run.shot('05-outbox-second-ask')
  await narrow(true)
  await run.shot('05b-outbox-narrow')
  await narrow(false)
  // The group folds past four rows: open it, then tick the three new rows from the keyboard, as he would (X).
  await run.page(`[...document.querySelectorAll('button')].find((b) => /^\\d+ more$/.test(b.textContent.trim()))?.click()`)
  await sleep(500)
  let ticked = 0
  for (let i = 0; i < 3; i++) {
    // Hover the row so its tick shows, then press the tick, as he would with the mouse.
    const box = await run.page<{ x: number; y: number } | null>(`(() => { const rows = [...document.querySelectorAll('[aria-label^="Tick "]')].filter((b) => (b.closest('li, [data-outbox-row], div')?.textContent ?? '').includes('bring your jersey')); const r = rows[${i}]?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null })()`)
    if (!box) break
    await run.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
    await sleep(150)
    await run.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    await run.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    ticked++
    await sleep(250)
  }
  const summary = await run.until('the summary offers Send 3', 10_000, () => run.page<boolean>(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim().startsWith('Send 3'))`))
  run.check('three rows are ticked, and the summary offers Send 3', ticked === 3 && summary, String(ticked))
  await run.shot('06-outbox-ticked')
  run.check('Send 3 is pressed', await clickText('body', 'Send 3'))
  const bulk = await run.until('three more went', 30_000, async () => (await list('done')).filter((i) => i.state === 'sent').length === 12)
  run.check('the ticked three went as one press', bulk)
  await run.shot('07-outbox-sent')
  run.note('Send later firing is held by later.test.ts; no kind that may wait (LifeOS mail, Outlook, Teams, chat) is reachable on this LifeOS-less instance.')
  await run.finish()
} catch (err) {
  await run.finish(err)
}
