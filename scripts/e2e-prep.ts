import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PrepPage, PrepUpcoming } from '../src/shared/contract-work-prep'
import type { OutboxItem } from '../src/shared/contract-work-outbox'
import { ownMailbox, PREFIX, Run, sleep, textOf } from './e2e-work-lib'

/**
 * Meeting prep and follow-up, one whole job (docs/agents/work-prep.md; the
 * house pattern of docs/agents/work-proofs.md).
 *
 * A dummy event is made in his Life calendar, three days out, with a made-up
 * word for a subject so no task of his own matches it. In the window: Agenda's
 * Prepare opens its page, which shows the facts and has written nothing; two
 * dummy people are added by name; Brief me starts a thread the host names and
 * links to the event, and the page stays. The thread's side is called as its
 * bridge calls it (no model runs): `prep_write` puts the brief on the page.
 * He types notes and presses Follow up; the follow-up thread writes the
 * outcome with two suggested tasks through `prep_follow_up` and drafts one
 * mail to his own address. He ticks one task and adds it: LifeOS holds it in
 * Life, saying which meeting it came from, and the other is filed nowhere.
 * The draft waits in the Outbox and is never sent. Everything made is taken
 * away at the end.
 *
 *   env -u ELECTRON_RUN_AS_NODE bun scripts/e2e-prep.ts --out .temp-code/plans/landed/R3-prep/e2e
 */
const TITLE = `${PREFIX} Quorvex sync`
const MAYA = `${PREFIX} Maya Chen`
const TOM = `${PREFIX} Tom Beck`
const BRIEF = 'Maya still waits on the seat list, and the van to Illinois has no driver.'
const NOTES = 'Dana drives the van, leaving 3:30 Friday. Seat list goes to Maya on Wednesday. The venue form is still not signed.'
const KEEP = `${PREFIX} Send Maya the final seat list`
const DROP = `${PREFIX} A task he will not tick`

const run = new Run('prep')
/** A real press (pointer down and up) on the element a page expression answers. */
async function pressOn(what: string, element: string): Promise<boolean> {
  // Brought into view first, then measured once the page has settled: a press aimed at where the control was lands on nothing.
  const there = await run.page<boolean>(`(() => { const el = ${element}; if (!el) return false; el.scrollIntoView({ block: 'center', behavior: 'instant' }); return true })()`)
  if (!run.check(`${what} is there to press`, there)) return false
  await sleep(300)
  const at = await run.page<{ x: number; y: number } | null>(`(() => { const el = ${element}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  if (!at) return false
  await run.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at!.x, y: at!.y })
  for (const type of ['mousePressed', 'mouseReleased']) await run.send('Input.dispatchMouseEvent', { type, x: at!.x, y: at!.y, button: 'left', clickCount: 1 })
  return true
}
/** A picture of one element alone, in both themes, with the pointer over it (a row's verb shows on hover). */
async function pictureOf(name: string, element: string): Promise<void> {
  for (const light of [false, true]) {
    await run.page(`document.documentElement.classList.toggle('theme-light', ${light})`)
    const r = await run.page<{ x: number; y: number; width: number; height: number } | null>(`(() => { const el = ${element}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height } })()`)
    if (!r) return void run.check(`picture ${name}: its element is on screen`, false)
    await run.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x + r.width / 2, y: r.y + r.height / 2 })
    await sleep(500)
    const { data } = (await run.send('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8), width: r.width + 16, height: r.height + 16, scale: 2 } })) as { data: string }
    writeFileSync(join(run.out, `${name}.${light ? 'light' : 'dark'}.png`), Buffer.from(data, 'base64'))
  }
  await run.page(`document.documentElement.classList.toggle('theme-light', false)`)
}
const button = (text: string, within = 'document'): string => `[...${within}.querySelectorAll('button, [role=menuitem], [role=menuitemcheckbox]')].find((e) => e.textContent.trim() === ${JSON.stringify(text)} && !e.disabled)`
const row = (text: string): string => `[...document.querySelectorAll('[role=listitem]')].find((e) => e.textContent.includes(${JSON.stringify(text)}))`

try {
  console.log('[prep] starting the instance')
  await run.start()
  console.log('[prep] signing in')
  await run.signIn('prep')
  const box = await ownMailbox(run)
  const ws = await run.workspace('life', `${PREFIX} prep`)
  const where = { workspaceId: ws }
  const page = async (eventId: string): Promise<PrepPage> => (await run.call<{ page: PrepPage }>('work.prep.page', { ...where, eventId })).page

  // A dummy event of his own calendar, three days out at two in the afternoon; removed at the end.
  const day = new Date(Date.now() + 3 * 86_400_000)
  const startsAt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 14, 0).getTime()
  const eventId = await run.mutation<string>('events:create', { sector: 'life', title: TITLE, startsAt, endsAt: startsAt + 45 * 60_000, location: 'Room 204', notes: 'Made by TempCode’s end-to-end proof of meeting prep; removed when it ends.' })
  run.later('remove the dummy event', () => run.mutation('events:remove', { id: eventId }))
  run.check('a dummy event is in his Life calendar', !!eventId)

  // The page of facts, read with no model; reading it writes nothing.
  const facts = await page(eventId)
  run.check('the page reads the event with no model and has kept nothing', facts.event.title === TITLE && facts.rev === 0 && facts.state === 'none' && facts.briefSessionId === null, JSON.stringify({ rev: facts.rev, state: facts.state, people: facts.people.length, tasks: facts.tasks.length }))
  run.check('no task of his own is on it (the subject is a made-up word)', facts.tasks.every((t) => t.title.startsWith(PREFIX)), String(facts.tasks.length))
  const far = await run.call<unknown>('work.prep.page', { ...where, eventId: 'not-an-event' }).then(() => 'answered', (e: Error) => e.message)
  run.check('an event that is not there is refused in words', far !== 'answered', String(far).slice(0, 120))

  // The window: a thread of the workspace brings its column up; Agenda's row verb opens the page.
  const seat = await run.thread(ws, `${PREFIX} prep seat`)
  await run.show(seat)
  await pressOn('Agenda in the column', `[...document.querySelectorAll('button, [role=button], a')].find((e) => /^Agenda/.test(e.textContent.trim()) && e.getBoundingClientRect().left < 460)`)
  run.check('Agenda lists the dummy event', await run.until('agenda row', 60_000, () => run.has(TITLE)))
  await run.page(`(() => { const r = ${row(TITLE)}; r?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return !!r })()`)
  // The row with its verb, cut to the row alone: the list around it is his real calendar.
  await pictureOf('00-agenda-row', row(TITLE))
  await pressOn('the row’s Prepare', `${row(TITLE)}?.querySelector('button')`)
  run.check('Prepare opens the meeting’s page, and starts no thread', await run.until('the page', 30_000, () => run.has('No one is listed on this meeting')))
  const threadsBefore = (await page(eventId)).briefSessionId
  run.check('opening the page started nothing', threadsBefore === null)
  await sleep(800)
  await run.shot('01-facts-nobody', { clipLeft: 460 })

  // Two dummy people, added by name (a calendar that lists no attendees), kept with the page.
  const added = (await run.call<{ page: PrepPage }>('work.prep.people', { ...where, eventId, people: [{ name: MAYA }, { name: TOM }] })).page
  run.check('the people he adds are kept with the page', added.rev === 1 && added.people.map((p) => p.name).join() === [MAYA, TOM].join(), JSON.stringify(added.people))
  run.check('the page shows them when the host says it changed', await run.until('people', 20_000, () => run.has(MAYA)))

  // Brief me: his press in the window. The host starts the thread, names it and links it to the event.
  await pressOn('Brief me', button('Brief me'))
  const briefed = await run.until('brief thread', 60_000, async () => (await page(eventId)).briefSessionId !== null)
  const briefThread = (await page(eventId)).briefSessionId ?? ''
  run.check('Brief me starts one thread for the page', briefed && !!briefThread)
  // Deleted by the job itself at its end; a second delete of a thread already gone is no failure.
  if (briefThread) run.later('delete the brief thread', () => run.call('session.delete', { sessionId: briefThread }).catch(() => null))
  const metaOf = (): Promise<{ title?: string; scope?: string } | null> => run.page(`(() => { const m = window.__monocode.sessionStore.metaOf(${JSON.stringify(briefThread)}); return m ? { title: m.title, scope: m.scope } : null })()`)
  await run.until('the window knows the thread', 20_000, async () => (await metaOf()) !== null)
  const meta = await metaOf()
  run.check('the host named it and made it a Work thread', meta?.title === `Prepare: ${TITLE}` && meta.scope === 'work', JSON.stringify(meta))
  const again = await run.call<{ sessionId: string }>('work.prep.brief', { ...where, eventId })
  run.check('a second press answers the same thread', again.sessionId === briefThread)
  run.check('he is still on the page', await run.has(MAYA))

  // The thread's side, as its bridge calls it: it reads the page as words and writes the brief.
  const read = await run.tool(briefThread, 'prep_read', { event: eventId })
  run.check('prep_read answers the page as words', !read.isError && textOf(read).includes(TITLE) && textOf(read).includes(MAYA), textOf(read).slice(0, 200))
  const wrote = await run.tool(briefThread, 'prep_write', { event: eventId, matters: [{ text: BRIEF }, { text: 'Decide who carries the venue form.' }] })
  run.check('prep_write keeps the brief', !wrote.isError, textOf(wrote).slice(0, 200))
  run.check('the brief is on the page', await run.until('brief', 20_000, () => run.has(BRIEF)))
  const afterBrief = await page(eventId)
  run.check('the page is briefed', afterBrief.state === 'briefed' && afterBrief.doc.brief?.matters.length === 2 && afterBrief.doc.brief.by === briefThread)
  const other = await run.tool(seat, 'prep_write', { event: 'not-an-event', matters: [{ text: 'x' }] })
  run.check('a thread cannot write a page for an event that is not its sector’s', other.isError === true, textOf(other).slice(0, 120))
  await sleep(800)
  await run.shot('02-briefed', { clipLeft: 460 })

  // What is coming, as Today and the digest read it.
  const { meetings } = await run.call<{ meetings: PrepUpcoming[] }>('work.prep.upcoming', { from: startsAt - 3_600_000, to: startsAt + 3_600_000 })
  const mine = meetings.find((m) => m.eventId === eventId)
  run.check('work.prep.upcoming lists it as briefed, with who is on it', mine?.state === 'briefed' && mine.workspaceId === ws && mine.with.join() === [MAYA, TOM].join(), JSON.stringify(mine))

  // Notes, typed in the window, and Follow up.
  await pressOn('More', `document.querySelector('[data-view-heading]')?.closest('div')?.querySelector('button[aria-label="More"]')`)
  await run.until('menu', 10_000, () => run.page<boolean>(`!!${button('Add notes…')}`))
  await pressOn('Add notes…', button('Add notes…'))
  run.check('the Notes dialog opens', await run.until('dialog', 15_000, () => run.page<boolean>(`!!document.querySelector('[data-prep-dialog="notes"] textarea')`)))
  await pressOn('the notes field', `document.querySelector('[data-prep-dialog="notes"] textarea')`)
  await run.send('Input.insertText', { text: NOTES })
  await sleep(400)
  // The dialog alone: it stands over the column, whose rows say facts of his real lists.
  await pictureOf('03-notes-dialog', `document.querySelector('[data-prep-dialog="notes"]')`)
  await pressOn('Follow up', button('Follow up', `document.querySelector('[data-prep-dialog="notes"]')`))
  const followed = await run.until('follow thread', 60_000, async () => (await page(eventId)).followSessionId !== null)
  const followThread = (await page(eventId)).followSessionId ?? ''
  run.check('Follow up keeps his notes and starts the follow-up thread', followed && (await page(eventId)).doc.notes?.text === NOTES)
  if (followThread) run.later('delete the follow-up thread', () => run.call('session.delete', { sessionId: followThread }))

  // The follow-up thread's side: the outcome with two suggested tasks, and one mail drafted to his own address.
  const outcome = await run.tool(followThread, 'prep_follow_up', {
    event: eventId,
    summary: [{ text: 'The van and the seat list are settled; the venue form is still open.' }],
    decisions: [{ text: 'Dana drives the van to Illinois on Friday' }],
    questions: [{ text: 'When the venue form is signed' }],
    tasks: [{ title: KEEP, quote: 'Seat list goes to Maya on Wednesday.' }, { title: DROP }]
  })
  run.check('prep_follow_up keeps the outcome', !outcome.isError, textOf(outcome).slice(0, 200))
  const drafts: string[] = []
  run.later('discard the unsent draft', async () => {
    for (const id of drafts) await run.mutation('compose:discard', { id }).catch(() => null)
  })
  const drafted = await run.addon(followThread, 'draft_mail', {
    account_id: box._id,
    to: [{ address: box.address }],
    subject: `${PREFIX} prep follow-up`,
    body: 'A test follow-up from TempCode’s end-to-end proof of meeting prep, to myself. Please ignore it.',
    reason: 'E2E-49 prep proof: a draft to himself, discarded at the end'
  })
  if (run.check('the thread drafted the follow-up mail', !drafted.isError, textOf(drafted).slice(0, 200))) {
    const parsed = JSON.parse(textOf(drafted)) as { id?: string; draftId?: string }
    drafts.push((parsed.id ?? parsed.draftId)!)
  }
  const waits = await run.until('the draft on the page', 60_000, async () => (await page(eventId)).drafts.some((d) => d.outboxId === drafts[0]))
  run.check('the page lists the mail as waiting for his press', waits)
  const held = (): Promise<OutboxItem[]> => run.call<{ items: OutboxItem[] }>('work.outbox.list', {}).then((l) => l.items.filter((i) => i.kind === 'mail.send' && drafts.includes(String((i.ref as { id?: string }).id))))
  run.check('it waits in the Outbox, with the thread as its origin', await run.until('held', 60_000, async () => (await held()).some((i) => i.sessionId === followThread)))

  // His ticks: one task ticked and added, in the window.
  run.check('the page shows both suggestions, unticked', await run.until('to do', 20_000, async () => (await run.has(KEEP)) && (await run.has(DROP))))
  const ticks = await run.page<string[]>(`[...document.querySelectorAll('section[aria-label="To do"] [role=checkbox]')].map((c) => c.getAttribute('aria-checked'))`)
  run.check('suggested tasks start unticked', ticks.length === 2 && ticks.every((t) => t === 'false'), JSON.stringify(ticks))
  await sleep(600)
  await run.shot('04-after-waiting', { clipLeft: 460 })
  await pressOn('the first task’s tick', `document.querySelector('section[aria-label="To do"] [role=checkbox][aria-label=${JSON.stringify(KEEP)}]')`)
  run.check('the one button counts his tick', await run.until('Add 1 task', 10_000, () => run.page<boolean>(`!!${button('Add 1 task')}`)))
  await pressOn('Add 1 task', button('Add 1 task'))
  const filedOk = await run.until('filed', 60_000, async () => (await page(eventId)).doc.after?.tasks.find((t) => t.title === KEEP)?.state === 'filed')
  // What the window says of the filing, whichever way it went: a failure is the view's own line, in LifeOS's words.
  const said = await run.page<string | null>(`document.querySelector('[data-view-state]')?.textContent ?? null`)
  if (!filedOk) run.note(`the window after Add: ${said ?? 'no state line; the button reads ' + (await run.page<string>(`[...document.querySelectorAll('section[aria-label="To do"] button')].map((b) => b.textContent.trim() + (b.disabled ? ' (off)' : '')).join(', ')`))}`)
  const tasks = (await page(eventId)).doc.after?.tasks ?? []
  const filed = tasks.find((t) => t.title === KEEP)
  if (filed?.lifeosTaskId) run.later('drop the filed task', () => run.addon(followThread, 'drop_tasks', { ids: [filed.lifeosTaskId], reason: 'E2E-49 prep proof: cleanup' }))
  run.check('Add files the ticked task and leaves the other proposed', filedOk && !!filed?.lifeosTaskId && tasks.find((t) => t.title === DROP)?.state === 'proposed', JSON.stringify(tasks.map((t) => [t.title, t.state])))
  if (filed?.lifeosTaskId) {
    const task = (await run.query<{ task: { title: string; sector: string; description?: string } } | null>('tasks:get', { id: filed.lifeosTaskId }))?.task
    run.check('LifeOS holds it in Life, saying which meeting it came from', task?.sector === 'life' && task.title === KEEP && (task.description ?? '').includes(`From “${TITLE}”`) && (task.description ?? '').includes('Seat list goes to Maya'), JSON.stringify(task).slice(0, 300))
  }
  const unticked = await run.addon(followThread, 'search_tasks', { query: 'A task he will not tick' })
  run.check('the one he did not tick is nowhere in LifeOS', !unticked.isError && !textOf(unticked).includes('will not tick'), textOf(unticked).slice(0, 160))
  await sleep(1200)
  await run.shot('05-after-filed', { clipLeft: 460 })

  // Nothing was sent: the draft is still a draft, and the page's state is what Today will read.
  const still = await run.query<{ row: { status?: string; origin?: { threadId?: string } } } | null>('compose:get', { id: drafts[0] })
  run.check('the follow-up mail was never sent: it is still a draft', still?.row.status === 'draft' && still.row.origin?.threadId === followThread, JSON.stringify(still?.row.status))
  const later = (await run.call<{ meetings: PrepUpcoming[] }>('work.prep.upcoming', { from: startsAt - 3_600_000, to: startsAt + 3_600_000 })).meetings.find((m) => m.eventId === eventId)
  run.check('the page reads as after', later?.state === 'after')

  // A page stays when its thread is deleted.
  await run.call('session.delete', { sessionId: briefThread })
  const kept = await page(eventId)
  run.check('the page stays when its brief thread is deleted', kept.briefSessionId === null && kept.doc.brief?.matters.length === 2)
} catch (err) {
  await run.finish(err)
}
await run.finish()
