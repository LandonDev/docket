import { join } from 'node:path'
import { REPO, Run, sleep, textOf, type Tool } from './e2e-work-lib'

/**
 * The digest, in the real window (docs/agents/work-digest.md "Proofs"):
 *
 *   electron-vite build, then
 *   env -u ELECTRON_RUN_AS_NODE bun scripts/e2e-work-digest.ts --out <dir>
 *
 * One isolated instance under xvfb with Work on and no LifeOS at all. A
 * made-up Work thread calls a fake add-on three times; each call is held.
 * The digest's time is set to the next minute. The job then sees, in the
 * window: the day's one toast, the list it opens, a row's press landing on
 * that held item in the Outbox, a send that fails interrupting at once, and
 * the Digest section of Settings → Work. Pictures of each in dark and light
 * go to the out folder. Dummy names only; nothing leaves the box.
 */
const run = new Run('digest')
const BUN = process.execPath
const FAKE = join(REPO, 'scripts', 'lib', 'fakeMcpServer.ts')

interface Held {
  ref: { at: 'host'; id: string }
  summary: string
  state: string
}
interface Row {
  title: string
  how: string
  day: string | null
  group: string
  open?: unknown
}
const waiting = async (): Promise<Held[]> => (await run.call<{ items: Held[] }>('work.outbox.list', { show: 'waiting' })).items
const ledger = async (): Promise<{ rows: Row[]; days: { day: string; count: number; seenAt: number | null }[] }> => run.call('work.digest.list', {})

/** "HH:mm" on the wall clock of `zone`, `ms` from now. */
const clockIn = (zone: string, ms: number): string => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(Date.now() + ms).map((x) => [x.type, x.value]))
  return `${p.hour}:${p.minute}`
}

try {
  await run.start()
  await sleep(3000)

  // ── a job with no LifeOS behind it, a thread in it, and an add-on whose every call is held ──
  const ws = await run.call<{ id: string }>('workspace.create', { kind: 'work', name: 'Dummy Officials' })
  run.later('delete the workspace', () => run.call('workspace.delete', { workspaceId: ws.id }))
  const added = await run.call<{ addon: { id: string } }>('addons.set', { addon: { name: 'league', workspaceId: ws.id, spec: { transport: 'stdio', command: BUN, args: [FAKE, '--stdio'], env: [], auth: 'fields' } } })
  run.later('remove the add-on', () => run.call('addons.remove', { id: added.addon.id }))
  const ready = await run.until('the add-on is ready', 60_000, async () => (await run.call<{ status: Record<string, { state: string }> }>('addons.list', {})).status[added.addon.id]?.state === 'ready')
  run.check('a fake add-on is ready in the job', ready)
  const thread = await run.thread(ws.id, 'Assign the Saturday crews')
  const call = (tool: string, args: Record<string, unknown>): Promise<Tool> => run.call<Tool>('app.addonCall', { sessionId: thread, appToken: run.appToken(thread), tool: `league__${tool}`, arguments: args })
  for (const text of ['Varsity at North: crew of five', 'JV at East: crew of three']) {
    const answer = await call('echo', { text })
    run.check(`a call is held, not run: ${text}`, /^Held as item \d+/.test(textOf(answer)), textOf(answer).slice(0, 120))
  }
  const failing = await call('fail', {})
  run.check('a third call is held: one whose send will fail', /^Held as item \d+/.test(textOf(failing)), textOf(failing).slice(0, 120))
  const items = await waiting()
  run.check('three items wait in the Outbox', items.length === 3, items.map((i) => i.summary).join(' | '))

  // ── held items wait: three rows in the ledger, no toast ──
  await run.until('the ledger has them', 10_000, async () => (await ledger()).rows.length === 3)
  const before = await ledger()
  run.check('each held item is a row that waits for the digest', before.rows.length === 3 && before.rows.every((r) => r.how === 'waiting' && r.group === 'held' && r.title.startsWith('Held: ')), JSON.stringify(before.rows.map((r) => [r.title, r.how])))
  await sleep(1500)
  run.check('nothing interrupts for a held item with no clock', !(await run.has('Held: Echo')) || (await run.page<number>(`document.querySelectorAll('[data-sonner-toast]').length`)) === 0)

  // ── the digest, set one minute ahead ──
  const settings = await run.call<{ at: string; zone: string }>('work.digest.get', {})
  const at = clockIn(settings.zone, 65_000)
  await run.call('work.digest.set', { at })
  run.note(`the digest is set to ${at} in ${settings.zone}`)
  const made = await run.until('the day is made', 150_000, async () => (await ledger()).days.length === 1)
  const after = await ledger()
  run.check('at its time the day is made once, counted by what waited', made && after.days.length === 1 && after.days[0]!.count === 3 && after.days[0]!.seenAt === null, JSON.stringify(after.days))
  const toast = await run.until("the day's toast", 20_000, () => run.has('Digest: 3 things'))
  run.check("the window shows the day's one toast, with Open", toast && (await run.page<boolean>(`[...document.querySelectorAll('[data-sonner-toast] button')].some((b) => b.textContent.trim() === 'Open')`)))
  run.check('it is one toast', (await run.page<number>(`[...document.querySelectorAll('[data-sonner-toast]')].filter((t) => t.textContent.includes('Digest:')).length`)) === 1)
  await run.shot('01-digest-toast')

  // ── Open: the list ──
  run.check('Open is pressed', await run.press('Open'))
  const sheet = await run.until('the list opens', 10_000, () => run.page<boolean>(`!!document.querySelector('[data-slot=sheet-content]') && document.querySelector('[data-slot=sheet-title]')?.textContent === 'Digest'`))
  run.check('the press opens the list, a sheet titled Digest', sheet)
  await sleep(600)
  const sections = await run.page<string[]>(`[...document.querySelectorAll('[data-slot=sheet-content] h3')].map((h) => h.textContent.trim())`)
  run.check("its one section is today's digest", sections.length === 1 && /^Today, /.test(sections[0] ?? ''), sections.join(' | '))
  const rows = await run.page<string[]>(`[...document.querySelectorAll('[data-slot=sheet-content] li')].map((li) => li.textContent.trim())`)
  run.check('it lists the three held items', rows.length === 3 && rows.every((r) => r.startsWith('Held: ')), rows.join(' | '))
  run.check('opening it marks the day seen, and the toast is gone', await run.until('seen', 10_000, async () => (await ledger()).days[0]!.seenAt !== null && !(await run.page<boolean>(`[...document.querySelectorAll('[data-sonner-toast]')].some((t) => t.textContent.includes('Digest:'))`))))
  await run.shot('02-digest-list')

  // ── a row's press lands on that item in the Outbox ──
  const wanted = 'JV at East'
  const pressed = await run.page<boolean>(`(() => { const b = [...document.querySelectorAll('[data-slot=sheet-content] li button')].find((e) => e.textContent.includes(${JSON.stringify(wanted)})); if (!b) return false; b.click(); return true })()`)
  run.check('a row is pressed', pressed)
  const landed = await run.until('the Outbox shows the item', 15_000, async () => !(await run.page<boolean>(`!!document.querySelector('[data-slot=sheet-content]')`)) && (await run.has('Outbox')) && (await run.has(wanted)))
  run.check('the sheet closes and the Outbox opens', landed)
  const selected = await run.until('that item is the one picked', 10_000, () =>
    run.page<boolean>(`(() => { const picked = [...document.querySelectorAll('[aria-current=true], [aria-selected=true], [data-selected=true]')].map((e) => e.textContent).join(' '); return picked.includes(${JSON.stringify(wanted)}) })()`)
  )
  run.check('it lands on that item: the one the row named is the one picked, not the first', selected)
  await run.shot('03-outbox-item')

  // ── a send that fails interrupts at once ──
  const fail = (await waiting()).find((i) => /fail/i.test(i.summary))!
  await run.call('work.outbox.send', { ref: fail.ref }).catch(() => null)
  const told = await run.until('the failed send is told', 15_000, async () => (await ledger()).rows.some((r) => r.title.startsWith('Not sent: ') && r.how === 'now'))
  run.check('a send that failed is told at once, not kept for tomorrow', told, JSON.stringify((await ledger()).rows.map((r) => [r.title, r.how])))
  const interrupt = await run.until("the interrupt's toast", 15_000, () => run.has('Not sent: '))
  run.check('the window shows it as its own toast, with Open', interrupt && (await run.page<boolean>(`[...document.querySelectorAll('[data-sonner-toast]')].some((t) => t.textContent.includes('Not sent: ') && [...t.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Open'))`)))
  await run.shot('04-interrupt-toast')

  // ── he sends one: its row leaves the ledger ──
  const echo = (await waiting()).find((i) => i.summary.includes('Varsity'))!
  await run.call('work.outbox.send', { ref: echo.ref })
  run.check('a held item he sent leaves the ledger', await run.until('its row goes', 15_000, async () => !(await ledger()).rows.some((r) => r.title.includes('Varsity'))))

  // ── Settings → Work → Digest ──
  await run.page(`window.dispatchEvent(new CustomEvent('monocode:open-settings', { detail: 'work' }))`)
  const section = await run.until('the Digest section', 20_000, () => run.page<boolean>(`[...document.querySelectorAll('[data-slot=page-section] h2')].some((h) => h.textContent.trim() === 'Digest')`))
  run.check('Settings → Work has a Digest section', section)
  await run.page(`[...document.querySelectorAll('[data-slot=page-section] h2')].find((h) => h.textContent.trim() === 'Digest')?.scrollIntoView({ block: 'start' })`)
  await sleep(800)
  const labels = await run.page<string[]>(`(() => { const s = [...document.querySelectorAll('[data-slot=page-section]')].find((x) => x.querySelector('h2')?.textContent.trim() === 'Digest'); return s ? [...s.querySelectorAll('[data-slot=item-title]')].map((t) => t.textContent.trim()) : [] })()`)
  run.check('its rows are the time and the four groups', labels.join('|') === 'Time|Held items|Routine results|Messages and mail|Meetings', labels.join('|'))
  run.check('the time field reads what was set', (await run.page<string>(`document.querySelector('input[type=time]')?.value ?? ''`)) === at)
  await run.shot('05-settings')

  await run.finish()
} catch (err) {
  await run.finish(err)
}
